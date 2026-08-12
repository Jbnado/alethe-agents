import { beforeEach, describe, expect, it } from 'vitest'

import { orchestratorJobSink, useOrchestratorStore } from '../../stores/orchestratorStore'
import {
  killTerminal,
  listAgents,
  listTerminals,
  openShell,
  readOutput,
  sendPrompt,
  spawnAgent,
  terminalStatus,
  waitForDone,
  PROVIDER_PROBE_TIMEOUT_MS,
  QUEUE_RECHECK_MS,
  SHELL_START_TIMEOUT_MS,
  SHELL_WATCHDOG_POLL_MS,
  WAIT_POLL_MS,
  WAIT_START_GRACE_MS,
  WAIT_TIMEOUT_DEFAULT_MS,
  WAIT_TIMEOUT_MAX_MS,
  WAIT_TIMEOUT_MIN_MS,
  APPROVAL_TIMEOUT_MS,
  MAX_COMMAND_LENGTH,
  type AgentUsageReport,
  type ApprovalRequest,
  type ControlSubTabView,
  type ControlTerminalView,
  type CreateAgentInput,
  type CreateShellInput,
  type CreateShellSubTabInput,
  type MemoryCeilingView,
  type OrchestratorDeps,
  type PromptDeliveryRequest,
} from './ops'
import type { OrchestratorApprovalAction } from '../types'
import { capabilitiesFor, type ControlContext } from './scope'
import { antigravityUsageReport, codexUsageReport } from './usageReport'

const ESC = '\u001b'

const GROUPS: Record<string, string | null> = {
  'proj-api': 'grp-backend',
  'proj-web': 'grp-backend',
  'proj-other': 'grp-marketing',
}

function contextFor(projectId: string, terminalId = 'term-lead'): ControlContext {
  return {
    terminalId,
    projectId,
    groupId: GROUPS[projectId] ?? null,
    capabilities: capabilitiesFor(false),
  }
}

/** A terminal opened with the Orchestrator toggle on. */
function leadContext(projectId = 'proj-api', terminalId = 'term-lead'): ControlContext {
  return { ...contextFor(projectId, terminalId), capabilities: capabilitiesFor(true) }
}

function makeView(
  overrides: Partial<ControlTerminalView> & { id: string; projectId: string },
): ControlTerminalView {
  return {
    name: overrides.id,
    agent: 'claude',
    cwd: 'C:/repo/api',
    disabled: false,
    ptyId: `pty-${overrides.id}`,
    alive: false,
    // A PTY is registered as `waiting`; only the activity tracker ever flips it
    // to `working`. No runtime at all until something spawns.
    ptyStatus: overrides.alive ? ('waiting' as const) : null,
    ...overrides,
  }
}

/** The sub-tab a pane already shows before any agent asks for a shell. */
function agentTabOf(terminal: ControlTerminalView): ControlSubTabView {
  return {
    ...makeView({ id: `${terminal.id}~agent`, projectId: terminal.projectId }),
    name: `${terminal.name} agent`,
    agent: terminal.agent,
    cwd: terminal.cwd,
    ptyId: terminal.ptyId,
    alive: terminal.alive,
    ptyStatus: terminal.ptyStatus,
    disabled: terminal.disabled,
    terminalId: terminal.id,
    active: true,
    pendingInput: false,
  }
}

/** Manual clock: every timer the ops layer arms goes through `deps.schedule`. */
function makeClock() {
  let now = 0
  let tasks: { at: number; seq: number; run: () => void }[] = []
  let seq = 0
  return {
    now: () => now,
    schedule: (run: () => void, ms: number) => {
      tasks.push({ at: now + ms, seq: seq++, run })
    },
    pending: () => tasks.length,
    async advance(ms: number) {
      const target = now + ms
      for (;;) {
        const due = tasks
          .filter((task) => task.at <= target)
          .sort((a, b) => a.at - b.at || a.seq - b.seq)[0]
        if (!due) break
        tasks = tasks.filter((task) => task !== due)
        now = Math.max(now, due.at)
        due.run()
        // Queue re-checks are async; let their microtasks settle before the
        // next timer fires, so ordering matches real time.
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      now = target
    },
  }
}

function makeHarness(options?: {
  terminals?: ControlTerminalView[]
  scrollback?: string
  /** False models a pane with no sub-tab lane, or a requester already gone. */
  hostsSubTabs?: boolean
}) {
  const clock = makeClock()
  const terminals = options?.terminals ?? [
    makeView({ id: 'term-lead', projectId: 'proj-api', alive: true }),
  ]
  const subTabs = terminals.map(agentTabOf)
  const hostsSubTabs = options?.hostsSubTabs ?? true
  const created: CreateShellInput[] = []
  const createdSubTabs: CreateShellSubTabInput[] = []
  const createdAgents: CreateAgentInput[] = []
  const killed: [string, string][] = []
  const prompts: PromptDeliveryRequest[] = []
  const recordedInput: [string, string][] = []
  const focused: [string, string][] = []
  const activated: [string, string, string][] = []
  const queue = {
    active: 0,
    capacity: 3,
    queued: 0,
    pressureBlocked: false,
    pressureReason: null as string | null,
  }
  const memory: MemoryCeilingView = {
    usedMb: 1763,
    budgetMb: 1536,
    systemTotalMb: 16_384,
    settingsLabel: 'Preferências',
    categoryLabel: 'Terminal e agentes',
    budgetFieldLabel: 'Limite rígido (MB)',
    liveAgentsFieldLabel: 'Agentes vivos por orquestrador',
  }
  const counters = { acquire: 0, release: 0 }
  /**
   * The approval gate as the tests drive it. `answer` defaults to 'allow' so
   * every test that is about something else keeps running without a human in
   * the loop — the same escape hatch the global preference gives a real run.
   */
  const approvals = {
    answer: 'allow' as 'allow' | 'deny' | 'silence',
    auto: new Set<OrchestratorApprovalAction>(),
    /** `${terminalId} ${action}` grants, as the session store keys them. */
    session: new Set<string>(),
    asked: [] as ApprovalRequest[],
    /** Signals handed to `ask`, so a test can prove the dead card is dropped. */
    signals: [] as AbortSignal[],
  }
  const agentControls = {
    maxLiveAgents: 3,
    /** Resolved by `deliverPrompt`; false models a PTY that stopped listening. */
    promptDelivered: true,
    promptError: null as Error | null,
    createError: null as Error | null,
    installed: new Set<string>(['claude', 'codex', 'shell']),
    usage: new Map<string, AgentUsageReport | null>(),
    /** Agents whose probes reject, to prove one failure cannot sink the list. */
    brokenProbes: new Set<string>(),
    /** Agents whose usage probe never settles, to prove the deadline works. */
    hangingProbes: new Set<string>(),
  }
  let scrollback = options?.scrollback ?? ''
  let scrollbackError: Error | null = null
  let nextId = 1

  const deps: OrchestratorDeps = {
    workspaceTerminals: () => terminals,
    workspaceSubTabs: () => subTabs,
    resolveGroup: (projectId) => GROUPS[projectId] ?? null,
    createShellSubTab: (input) => {
      if (!hostsSubTabs || !terminals.some((item) => item.id === input.terminalId)) return null
      createdSubTabs.push(input)
      const previous = subTabs.find((tab) => tab.terminalId === input.terminalId && tab.active)
      for (const tab of subTabs) {
        if (tab.terminalId === input.terminalId) tab.active = false
      }
      const id = `tab-shell-${nextId++}`
      subTabs.push({
        id,
        terminalId: input.terminalId,
        name: input.name,
        projectId: input.projectId,
        agent: 'shell',
        cwd: input.cwd,
        disabled: false,
        ptyId: `pty-${id}`,
        alive: false,
        ptyStatus: null,
        active: true,
        // The command rides in as the sub-tab's initial input and is only
        // cleared once it has actually been typed into the PTY.
        pendingInput: true,
      })
      return { terminalId: input.terminalId, tabId: id, previousTabId: previous?.id ?? null }
    },
    createShell: (input) => {
      created.push(input)
      const id = `term-shell-${nextId++}`
      const terminal = makeView({
        id,
        projectId: input.projectId,
        name: input.name,
        agent: 'shell',
        cwd: input.cwd,
      })
      terminals.push(terminal)
      return { terminalId: id }
    },
    createAgentTerminal: async (input) => {
      if (agentControls.createError) throw agentControls.createError
      createdAgents.push(input)
      const id = `term-agent-${nextId++}`
      const terminal = makeView({
        id,
        projectId: input.projectId,
        name: input.name,
        agent: input.agent,
        cwd: input.cwd,
      })
      terminals.push(terminal)
      subTabs.push(agentTabOf(terminal))
      return { terminalId: id }
    },
    killTerminal: (projectId, terminalId) => {
      killed.push([projectId, terminalId])
      const terminal = terminals.find((item) => item.id === terminalId)
      if (terminal) {
        terminal.alive = false
        terminal.ptyStatus = 'stopped'
      }
      for (const tab of subTabs) {
        if (tab.terminalId !== terminalId) continue
        tab.alive = false
        tab.ptyStatus = 'stopped'
      }
    },
    deliverPrompt: async (input) => {
      if (agentControls.promptError) throw agentControls.promptError
      prompts.push(input)
      return agentControls.promptDelivered
    },
    recordAgentInput: (ptyId, data) => {
      recordedInput.push([ptyId, data])
    },
    maxLiveAgents: () => agentControls.maxLiveAgents,
    agentProbe: {
      isInstalled: async (agent) => {
        if (agentControls.brokenProbes.has(agent)) throw new Error(`${agent} probe exploded`)
        return agentControls.installed.has(agent)
      },
      usage: async (agent) => {
        if (agentControls.brokenProbes.has(agent)) throw new Error(`${agent} usage exploded`)
        if (agentControls.hangingProbes.has(agent)) return new Promise(() => {})
        return agentControls.usage.get(agent) ?? null
      },
    },
    activateSubTab: (projectId, terminalId, tabId) => {
      activated.push([projectId, terminalId, tabId])
      for (const tab of subTabs) {
        if (tab.terminalId === terminalId) tab.active = tab.id === tabId
      }
    },
    focusTerminal: (projectId, terminalId) => {
      focused.push([projectId, terminalId])
    },
    readScrollback: async (ptyId) => {
      if (scrollbackError) throw scrollbackError
      return `${scrollback}[${ptyId}]`
    },
    spawnQueue: {
      snapshot: () => ({
        active: queue.active,
        queued: queue.queued,
        pressureBlocked: queue.pressureBlocked,
        pressureReason: queue.pressureReason,
      }),
      acquire: async () => {
        counters.acquire++
        if (queue.pressureBlocked || queue.active >= queue.capacity) return false
        queue.active++
        return true
      },
      release: () => {
        counters.release++
        queue.active = Math.max(0, queue.active - 1)
      },
    },
    memoryCeiling: () => memory,
    approvals: {
      autoApproved: (action) => approvals.auto.has(action),
      sessionApproved: (terminalId, action) => approvals.session.has(`${terminalId} ${action}`),
      ask: (request, signal) => {
        approvals.asked.push(request)
        approvals.signals.push(signal)
        if (approvals.answer === 'silence') return new Promise<boolean>(() => {})
        return Promise.resolve(approvals.answer === 'allow')
      },
    },
    jobs: orchestratorJobSink,
    now: clock.now,
    schedule: clock.schedule,
  }

  /** A pane plus the sub-tabs it renders, or a sub-tab addressed on its own. */
  function viewsById(id: string): (ControlTerminalView | ControlSubTabView)[] {
    const pane = terminals.find((item) => item.id === id)
    if (pane) return [pane, ...subTabs.filter((tab) => tab.terminalId === id)]
    const tab = subTabs.find((item) => item.id === id)
    return tab ? [tab] : []
  }

  return {
    deps,
    clock,
    terminals,
    subTabs,
    created,
    createdSubTabs,
    createdAgents,
    killed,
    prompts,
    recordedInput,
    focused,
    activated,
    queue,
    memory,
    counters,
    approvals,
    agentControls,
    setScrollback: (value: string) => {
      scrollback = value
    },
    failScrollback: (error: Error) => {
      scrollbackError = error
    },
    findTerminal: (id: string) => terminals.find((item) => item.id === id),
    findSubTab: (id: string) => subTabs.find((item) => item.id === id),
    /** The PTY booted: registered and alive, with the tracker still silent. */
    bootPty: (id: string) => {
      for (const view of viewsById(id)) {
        view.alive = true
        view.ptyStatus = 'waiting'
      }
    },
    /** The process ended, the way `markExited` records it in the store. */
    exitPty: (id: string) => {
      for (const view of viewsById(id)) {
        view.alive = false
        view.ptyStatus = 'stopped'
      }
    },
    /** What the activity tracker last said about a live PTY. */
    setActivity: (id: string, status: 'working' | 'waiting') => {
      for (const view of viewsById(id)) view.ptyStatus = status
    },
    /** Removes a terminal from the workspace, as closing its pane would. */
    removeTerminal: (id: string) => {
      const index = terminals.findIndex((item) => item.id === id)
      if (index >= 0) terminals.splice(index, 1)
      for (let i = subTabs.length - 1; i >= 0; i--) {
        if (subTabs[i].id === id || subTabs[i].terminalId === id) subTabs.splice(i, 1)
      }
    },
    /** The PTY booted and the command already went in — the pane can go back. */
    bootShell: (id: string) => {
      const tab = subTabs.find((item) => item.id === id)
      if (!tab) throw new Error(`no sub-tab ${id}`)
      tab.alive = true
      tab.pendingInput = false
    },
  }
}

function jobState(jobId: string) {
  return useOrchestratorStore.getState().jobs[jobId]
}

beforeEach(() => {
  useOrchestratorStore.getState().reset()
})

describe('listTerminals', () => {
  it('shows the caller its own project and the siblings of its group', () => {
    const harness = makeHarness({
      terminals: [
        makeView({ id: 'term-lead', projectId: 'proj-api', alive: true }),
        makeView({ id: 'term-web', projectId: 'proj-web' }),
      ],
    })
    const result = listTerminals(contextFor('proj-api'), harness.deps)
    if (!result.ok) throw new Error(result.error)
    expect(result.terminals.map((item) => item.id)).toEqual(['term-lead', 'term-web'])
  })

  it('hides a terminal that belongs to another group', () => {
    const harness = makeHarness({
      terminals: [
        makeView({ id: 'term-lead', projectId: 'proj-api', alive: true }),
        makeView({ id: 'term-stranger', projectId: 'proj-other' }),
      ],
    })
    const result = listTerminals(contextFor('proj-api'), harness.deps)
    if (!result.ok) throw new Error(result.error)
    expect(result.terminals.map((item) => item.id)).toEqual(['term-lead'])
  })

  it('reports a live terminal as running and an unspawned one as idle', () => {
    const harness = makeHarness({
      terminals: [
        makeView({ id: 'term-lead', projectId: 'proj-api', alive: true }),
        makeView({ id: 'term-cold', projectId: 'proj-api', alive: false }),
        makeView({ id: 'term-off', projectId: 'proj-api', disabled: true }),
      ],
    })
    const result = listTerminals(contextFor('proj-api'), harness.deps)
    if (!result.ok) throw new Error(result.error)
    expect(result.terminals.map((item) => item.status)).toEqual(['running', 'idle', 'disabled'])
  })

  it('lists panes only — a sub-tab is addressable but is not a pane', () => {
    const harness = makeHarness()
    const result = listTerminals(contextFor('proj-api'), harness.deps)
    if (!result.ok) throw new Error(result.error)
    expect(result.terminals.map((item) => item.id)).toEqual(['term-lead'])
  })
})

describe('scope enforcement', () => {
  it('denies reading a terminal from another group', async () => {
    const harness = makeHarness({
      terminals: [
        makeView({ id: 'term-lead', projectId: 'proj-api', alive: true }),
        makeView({ id: 'term-stranger', projectId: 'proj-other', alive: true }),
      ],
    })
    const result = await readOutput(contextFor('proj-api'), 'term-stranger', 200, harness.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('denied')
    expect(result.denial).toEqual({ kind: 'out-of-scope', targetProjectId: 'proj-other' })
  })

  it('denies status of a terminal from another group', () => {
    const harness = makeHarness({
      terminals: [
        makeView({ id: 'term-lead', projectId: 'proj-api', alive: true }),
        makeView({ id: 'term-stranger', projectId: 'proj-other' }),
      ],
    })
    const result = terminalStatus(contextFor('proj-api'), 'term-stranger', harness.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('denied')
  })

  it('denies a sub-tab of a terminal from another group', () => {
    const harness = makeHarness({
      terminals: [
        makeView({ id: 'term-lead', projectId: 'proj-api', alive: true }),
        makeView({ id: 'term-stranger', projectId: 'proj-other' }),
      ],
    })
    const result = terminalStatus(contextFor('proj-api'), 'term-stranger~agent', harness.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('denied')
  })

  it('allows a sibling project in the same group', () => {
    const harness = makeHarness({
      terminals: [
        makeView({ id: 'term-lead', projectId: 'proj-api', alive: true }),
        makeView({ id: 'term-web', projectId: 'proj-web', alive: true }),
      ],
    })
    const result = terminalStatus(contextFor('proj-api'), 'term-web', harness.deps)
    expect(result.ok).toBe(true)
  })

  it('refuses shell.run for a terminal without the capability', async () => {
    const harness = makeHarness()
    const ctx: ControlContext = { ...contextFor('proj-api'), capabilities: ['terminal.list'] }
    const result = await openShell(ctx, { command: 'npm test' }, harness.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.denial).toEqual({ kind: 'missing-capability', capability: 'shell.run' })
    expect(harness.createdSubTabs).toHaveLength(0)
    expect(harness.created).toHaveLength(0)
  })
})

describe('readOutput', () => {
  it('strips ANSI control sequences from the scrollback', async () => {
    const harness = makeHarness()
    harness.setScrollback(
      `${ESC}[2J${ESC}[31mbuild failed${ESC}[0m\n${ESC}]0;title\u0007exit code 1 `,
    )
    const result = await readOutput(contextFor('proj-api'), 'term-lead', 500, harness.deps)
    if (!result.ok) throw new Error(result.error)
    expect(result.output).toBe('build failed\nexit code 1 [pty-term-lead]')
    expect(result.output).not.toContain(ESC)
    expect(result.truncated).toBe(false)
  })

  it('marks a cut tail as truncated', async () => {
    const harness = makeHarness()
    harness.setScrollback('x'.repeat(500))
    const result = await readOutput(contextFor('proj-api'), 'term-lead', 20, harness.deps)
    if (!result.ok) throw new Error(result.error)
    expect(result.truncated).toBe(true)
    expect(result.output.startsWith('…')).toBe(true)
  })

  it('returns empty output for a terminal that never spawned', async () => {
    const harness = makeHarness({
      terminals: [makeView({ id: 'term-lead', projectId: 'proj-api', ptyId: null })],
    })
    const result = await readOutput(contextFor('proj-api'), 'term-lead', undefined, harness.deps)
    if (!result.ok) throw new Error(result.error)
    expect(result.output).toBe('')
  })

  it('reports an unknown terminal instead of throwing', async () => {
    const harness = makeHarness()
    const result = await readOutput(contextFor('proj-api'), 'term-ghost', 100, harness.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('not-found')
  })

  it('surfaces a scrollback failure as an io error', async () => {
    const harness = makeHarness()
    harness.failScrollback(new Error('pty gone'))
    const result = await readOutput(contextFor('proj-api'), 'term-lead', 100, harness.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('io')
  })

  it('still reads a shell sub-tab after the pane went back to the agent', async () => {
    const harness = makeHarness()
    const shell = await openShell(contextFor('proj-api'), { command: 'npm test' }, harness.deps)
    if (!shell.ok || shell.state !== 'starting') throw new Error('expected a starting result')

    harness.bootShell(shell.terminalId)
    await harness.clock.advance(SHELL_WATCHDOG_POLL_MS)
    expect(harness.activated).toHaveLength(1)

    // Reading the pane would hand back the agent's own conversation; the shell
    // keeps answering on its own id.
    const result = await readOutput(contextFor('proj-api'), shell.terminalId, 200, harness.deps)
    if (!result.ok) throw new Error(result.error)
    expect(result.output).toContain(`pty-${shell.terminalId}`)
  })
})

describe('openShell', () => {
  it('opens the shell inside the requester pane, focuses it, and never claims success', async () => {
    const harness = makeHarness()
    const result = await openShell(
      contextFor('proj-api'),
      { command: 'npm run build' },
      harness.deps,
    )
    if (!result.ok) throw new Error(result.error)
    expect(result.state).toBe('starting')
    if (result.state !== 'starting') return

    // Accessory work of the agent, so it lands next to the conversation.
    expect(harness.createdSubTabs).toEqual([
      {
        projectId: 'proj-api',
        terminalId: 'term-lead',
        name: 'npm',
        cwd: 'C:/repo/api',
        command: 'npm run build',
      },
    ])
    expect(harness.created).toHaveLength(0)
    // Focus is what makes the pane render, which is what starts the process.
    expect(harness.focused).toEqual([['proj-api', 'term-lead']])
    expect(harness.findSubTab(result.terminalId)).toMatchObject({
      terminalId: 'term-lead',
      agent: 'shell',
      active: true,
    })
    expect(jobState(result.jobId)).toMatchObject({
      state: 'starting',
      kind: 'shell',
      requesterTerminalId: 'term-lead',
      targetTerminalId: result.terminalId,
    })
    expect(result.message).toMatch(/Do not send this request again/i)
  })

  it('delivers the command as the sub-tab initial input, not as spawn arguments', async () => {
    const harness = makeHarness()
    const result = await openShell(contextFor('proj-api'), { command: 'pytest -q' }, harness.deps)
    if (!result.ok || result.state !== 'starting') throw new Error('expected a starting result')

    expect(harness.createdSubTabs[0].command).toBe('pytest -q')
    // Still pending: the PTY has not booted, so nothing was typed in yet.
    expect(harness.findSubTab(result.terminalId)?.pendingInput).toBe(true)
  })

  it('takes and gives back a spawn slot instead of holding it across creation', async () => {
    const harness = makeHarness()
    const result = await openShell(contextFor('proj-api'), { command: 'ls' }, harness.deps)
    expect(result.ok).toBe(true)
    // Holding the admission slot would deadlock XTermView, which takes its own.
    expect(harness.counters.acquire).toBe(1)
    expect(harness.counters.release).toBe(1)
  })

  it('honours an explicit cwd and name', async () => {
    const harness = makeHarness()
    await openShell(
      contextFor('proj-api'),
      { command: 'pytest', cwd: 'D:/work/svc', name: 'suite' },
      harness.deps,
    )
    expect(harness.createdSubTabs[0]).toMatchObject({ cwd: 'D:/work/svc', name: 'suite' })
  })

  it('falls back to a pane of its own when the requester pane is gone', async () => {
    const harness = makeHarness()
    harness.terminals.splice(0, harness.terminals.length)

    const result = await openShell(contextFor('proj-api'), { command: 'ls' }, harness.deps)
    if (!result.ok || result.state !== 'starting') throw new Error('expected a starting result')

    expect(harness.createdSubTabs).toHaveLength(0)
    expect(harness.created).toEqual([
      { projectId: 'proj-api', name: 'ls', cwd: '', command: 'ls' },
    ])
    expect(result.terminalId).toBe('term-shell-1')
    expect(harness.focused).toEqual([['proj-api', 'term-shell-1']])
  })

  it('falls back to a pane of its own when the requester cannot host sub-tabs', async () => {
    const harness = makeHarness({ hostsSubTabs: false })
    const result = await openShell(contextFor('proj-api'), { command: 'ls' }, harness.deps)
    if (!result.ok || result.state !== 'starting') throw new Error('expected a starting result')

    expect(harness.createdSubTabs).toHaveLength(0)
    expect(harness.created).toHaveLength(1)
    expect(result.terminalId).toBe('term-shell-1')
  })

  it('rejects a multi-line command', async () => {
    const harness = makeHarness()
    const result = await openShell(
      contextFor('proj-api'),
      { command: 'rm -rf /\nshutdown' },
      harness.deps,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('invalid')
    expect(harness.createdSubTabs).toHaveLength(0)
    expect(harness.created).toHaveLength(0)
  })

  it('rejects an empty command', async () => {
    const harness = makeHarness()
    const result = await openShell(contextFor('proj-api'), { command: '   ' }, harness.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('invalid')
  })
})

describe('openShell pane hand-back', () => {
  it('waits for the command to be typed in before giving the pane back', async () => {
    const harness = makeHarness()
    const result = await openShell(contextFor('proj-api'), { command: 'npm test' }, harness.deps)
    if (!result.ok || result.state !== 'starting') throw new Error('expected a starting result')

    // Alive is not enough: switching away now unmounts XTermView, whose
    // disposal aborts the pending delivery and loses the command.
    const shell = harness.findSubTab(result.terminalId)
    if (!shell) throw new Error('sub-tab was not created')
    shell.alive = true
    await harness.clock.advance(SHELL_WATCHDOG_POLL_MS)
    expect(jobState(result.jobId).state).toBe('running')
    expect(harness.activated).toHaveLength(0)
    expect(shell.active).toBe(true)

    shell.pendingInput = false
    await harness.clock.advance(SHELL_WATCHDOG_POLL_MS)
    expect(harness.activated).toEqual([['proj-api', 'term-lead', 'term-lead~agent']])
    expect(harness.findSubTab('term-lead~agent')?.active).toBe(true)
    // The shell is still there, still alive, just not drawn.
    expect(shell.alive).toBe(true)
  })

  it('gives the pane back at the deadline even when the shell never booted', async () => {
    const harness = makeHarness()
    const result = await openShell(contextFor('proj-api'), { command: 'npm test' }, harness.deps)
    if (!result.ok || result.state !== 'starting') throw new Error('expected a starting result')

    await harness.clock.advance(SHELL_START_TIMEOUT_MS + SHELL_WATCHDOG_POLL_MS)
    expect(jobState(result.jobId)).toMatchObject({ state: 'failed', failure: 'failed_to_start' })
    expect(harness.activated).toEqual([['proj-api', 'term-lead', 'term-lead~agent']])
  })

  it('leaves the pane alone when the person moved to another sub-tab meanwhile', async () => {
    const harness = makeHarness()
    const result = await openShell(contextFor('proj-api'), { command: 'npm test' }, harness.deps)
    if (!result.ok || result.state !== 'starting') throw new Error('expected a starting result')

    harness.bootShell(result.terminalId)
    // The person clicked back on their conversation themselves.
    harness.deps.activateSubTab('proj-api', 'term-lead', 'term-lead~agent')
    harness.activated.length = 0

    await harness.clock.advance(SHELL_START_TIMEOUT_MS)
    expect(harness.activated).toHaveLength(0)
  })

  it('never touches sub-tabs when the shell got a pane of its own', async () => {
    const harness = makeHarness({ hostsSubTabs: false })
    const result = await openShell(contextFor('proj-api'), { command: 'npm test' }, harness.deps)
    if (!result.ok || result.state !== 'starting') throw new Error('expected a starting result')

    const created = harness.findTerminal(result.terminalId)
    if (!created) throw new Error('terminal was not created')
    created.alive = true

    await harness.clock.advance(SHELL_START_TIMEOUT_MS)
    expect(jobState(result.jobId).state).toBe('running')
    expect(harness.activated).toHaveLength(0)
  })
})

describe('openShell under spawn pressure', () => {
  it('returns queued immediately, without creating anything or blocking', async () => {
    const harness = makeHarness()
    harness.queue.pressureBlocked = true
    harness.queue.pressureReason = 'memory-pressure'
    harness.queue.queued = 2

    const result = await openShell(contextFor('proj-api'), { command: 'npm test' }, harness.deps)
    if (!result.ok) throw new Error(result.error)
    expect(result.state).toBe('queued')
    if (result.state !== 'queued') return

    expect(result.queuePosition).toBe(3)
    expect(harness.createdSubTabs).toHaveLength(0)
    expect(harness.created).toHaveLength(0)
    // Not even the admission handshake runs under pressure — nothing can block.
    expect(harness.counters.acquire).toBe(0)
    expect(jobState(result.jobId)).toMatchObject({ state: 'queued', queuePosition: 3 })
    expect(result.message).toMatch(/Do NOT send this request again/i)
    expect(result.message).toContain(result.jobId)
  })

  it('starts on its own once the pressure clears, with no second request', async () => {
    const harness = makeHarness()
    harness.queue.pressureBlocked = true
    const result = await openShell(contextFor('proj-api'), { command: 'npm test' }, harness.deps)
    if (!result.ok || result.state !== 'queued') throw new Error('expected a queued result')

    await harness.clock.advance(QUEUE_RECHECK_MS)
    expect(harness.createdSubTabs).toHaveLength(0)
    expect(jobState(result.jobId).state).toBe('queued')

    harness.queue.pressureBlocked = false
    await harness.clock.advance(QUEUE_RECHECK_MS)
    expect(harness.createdSubTabs).toHaveLength(1)
    expect(harness.focused).toHaveLength(1)
    expect(jobState(result.jobId).state).toBe('starting')
  })

  it('starts right away when the queue has a waiter but a slot is still free', async () => {
    const harness = makeHarness()
    harness.queue.queued = 1
    const result = await openShell(contextFor('proj-api'), { command: 'npm test' }, harness.deps)
    if (!result.ok) throw new Error(result.error)
    expect(result.state).toBe('starting')
    expect(harness.createdSubTabs).toHaveLength(1)
  })

  it('queues when every spawn slot is taken', async () => {
    const harness = makeHarness()
    harness.queue.active = harness.queue.capacity
    const result = await openShell(contextFor('proj-api'), { command: 'npm test' }, harness.deps)
    if (!result.ok) throw new Error(result.error)
    expect(result.state).toBe('queued')
    expect(harness.createdSubTabs).toHaveLength(0)
    // Not a memory ceiling: no budget advice to give.
    expect(result.message).not.toMatch(/hard budget/)
  })

  it('does not let two queued jobs hold each other down', async () => {
    const harness = makeHarness()
    harness.queue.pressureBlocked = true
    const first = await openShell(contextFor('proj-api'), { command: 'npm test' }, harness.deps)
    const second = await openShell(contextFor('proj-api'), { command: 'npm run lint' }, harness.deps)
    if (!first.ok || first.state !== 'queued') throw new Error('expected a queued result')
    if (!second.ok || second.state !== 'queued') throw new Error('expected a queued result')

    harness.queue.pressureBlocked = false
    // Somebody is parked in the spawn queue right now — including each job's own
    // admission attempt. That is not a capacity signal: reading it as one made
    // every re-check of one job re-queue the other, forever.
    harness.queue.queued = 1

    await harness.clock.advance(QUEUE_RECHECK_MS)
    expect(jobState(first.jobId).state).toBe('starting')
    expect(jobState(second.jobId).state).toBe('starting')
    expect(harness.createdSubTabs).toHaveLength(2)
  })
})

describe('queued message under a memory ceiling', () => {
  async function queueUnderPressure(harness: ReturnType<typeof makeHarness>) {
    harness.queue.pressureBlocked = true
    harness.queue.pressureReason = 'memory-pressure'
    const result = await openShell(contextFor('proj-api'), { command: 'npm test' }, harness.deps)
    if (!result.ok || result.state !== 'queued') throw new Error('expected a queued result')
    return result
  }

  it('names the setting in the language the person actually sees', async () => {
    const harness = makeHarness()
    const result = await queueUnderPressure(harness)
    expect(result.message).toContain('Preferências')
    expect(result.message).toContain('Terminal e agentes')
    expect(result.message).toContain('Limite rígido (MB)')
    // The numbers behind the block, so the agent can explain the cause.
    expect(result.message).toContain('1763 MB')
    expect(result.message).toContain('1536 MB')
  })

  it('suggests a budget that clears the recovery target, not just current use', async () => {
    const harness = makeHarness()
    const result = await queueUnderPressure(harness)
    // (1763 + 256) / 0.75 = 2692 → next 512 step.
    expect(result.message).toContain('3072 MB would clear this request')
  })

  it('never suggests more than half of the machine RAM', async () => {
    const harness = makeHarness()
    harness.memory.systemTotalMb = 8_192
    harness.memory.usedMb = 3_800
    const result = await queueUnderPressure(harness)
    expect(result.message).toContain('4096 MB would clear this request')
  })

  it('omits the suggestion when the machine RAM cannot be read', async () => {
    const harness = makeHarness()
    harness.memory.systemTotalMb = null
    const result = await queueUnderPressure(harness)
    expect(result.message).not.toMatch(/would clear this request/)
    // The path to the setting is still worth saying.
    expect(result.message).toContain('Limite rígido (MB)')
  })

  it('omits the suggestion when the budget is already high enough', async () => {
    const harness = makeHarness()
    harness.memory.budgetMb = 8_192
    const result = await queueUnderPressure(harness)
    expect(result.message).not.toMatch(/would clear this request/)
  })
})

describe('openShell watchdog', () => {
  it('marks the job failed_to_start when the PTY never shows a sign of life', async () => {
    const harness = makeHarness()
    const result = await openShell(contextFor('proj-api'), { command: 'npm test' }, harness.deps)
    if (!result.ok || result.state !== 'starting') throw new Error('expected a starting result')

    await harness.clock.advance(SHELL_START_TIMEOUT_MS - SHELL_WATCHDOG_POLL_MS)
    expect(jobState(result.jobId).state).toBe('starting')

    await harness.clock.advance(SHELL_WATCHDOG_POLL_MS * 2)
    expect(jobState(result.jobId)).toMatchObject({
      state: 'failed',
      failure: 'failed_to_start',
    })
  })

  it('flips the job to running on the first sign of life', async () => {
    const harness = makeHarness()
    const result = await openShell(contextFor('proj-api'), { command: 'npm test' }, harness.deps)
    if (!result.ok || result.state !== 'starting') throw new Error('expected a starting result')

    harness.bootShell(result.terminalId)

    await harness.clock.advance(SHELL_WATCHDOG_POLL_MS)
    expect(jobState(result.jobId).state).toBe('running')
    // A settled job stops the watchdog instead of polling for 15s.
    await harness.clock.advance(SHELL_START_TIMEOUT_MS)
    expect(jobState(result.jobId).state).toBe('running')
  })

  it('fails the job when the shell disappears before it ever booted', async () => {
    const harness = makeHarness()
    const result = await openShell(contextFor('proj-api'), { command: 'npm test' }, harness.deps)
    if (!result.ok || result.state !== 'starting') throw new Error('expected a starting result')

    const index = harness.subTabs.findIndex((item) => item.id === result.terminalId)
    harness.subTabs.splice(index, 1)

    await harness.clock.advance(SHELL_WATCHDOG_POLL_MS)
    expect(jobState(result.jobId)).toMatchObject({
      state: 'failed',
      failure: 'failed_to_start',
    })
  })
})

/* ---------------------------------------------------------------------------
 * spawnAgent
 * ------------------------------------------------------------------------- */

describe('spawnAgent', () => {
  it('creates a pane of its own, not a sub-tab of the requester', async () => {
    const harness = makeHarness()
    const result = await spawnAgent(
      leadContext(),
      { agent: 'codex', task: 'port the parser to TS' },
      harness.deps,
    )
    if (!result.ok) throw new Error(result.error)
    if (result.state !== 'starting') throw new Error('expected a starting result')

    // A shell is accessory work of the requester and shares its pane; another
    // LLM is a participant and gets a pane you can watch side by side.
    expect(harness.createdSubTabs).toHaveLength(0)
    expect(harness.createdAgents).toHaveLength(1)
    expect(harness.createdAgents[0]).toMatchObject({
      projectId: 'proj-api',
      agent: 'codex',
      cwd: 'C:/repo/api',
    })
    // Focus is what makes the pane render, which is what starts the process.
    expect(harness.focused).toEqual([['proj-api', result.terminalId]])
    expect(jobState(result.jobId)).toMatchObject({
      state: 'starting',
      kind: 'agent',
      requesterTerminalId: 'term-lead',
      targetTerminalId: result.terminalId,
    })
    expect(result.message).toMatch(/Do not send this request again/i)
  })

  it('defaults to oneshot and delivers the task through execArgsFor', async () => {
    const harness = makeHarness()
    const result = await spawnAgent(
      leadContext(),
      { agent: 'claude', task: 'fix the flaky test' },
      harness.deps,
    )
    if (!result.ok || result.state !== 'starting') throw new Error('expected a starting result')

    expect(result.mode).toBe('oneshot')
    // The exit of the process becomes the completion signal, which is the whole
    // reason oneshot is the default.
    expect(harness.createdAgents[0].extraArgs).toEqual([
      '-p',
      'fix the flaky test',
      '--dangerously-skip-permissions',
    ])
    expect(harness.createdAgents[0].initialInput).toBeUndefined()
    expect(result.message).toMatch(/exits/)
  })

  it('delivers the task as initial input in interactive mode', async () => {
    const harness = makeHarness()
    const result = await spawnAgent(
      leadContext(),
      { agent: 'claude', task: 'review this diff', mode: 'interactive' },
      harness.deps,
    )
    if (!result.ok || result.state !== 'starting') throw new Error('expected a starting result')

    expect(result.mode).toBe('interactive')
    expect(harness.createdAgents[0].initialInput).toBe('review this diff')
    // Interactive is exactly where approval prompts block, and nobody is
    // watching the pane to answer one.
    expect(harness.createdAgents[0].extraArgs).toEqual(['--dangerously-skip-permissions'])
  })

  it('starts an agent with no one-shot form unrestricted too', async () => {
    // antigravity has no exec form, so it always lands in interactive. Without
    // the flag it stops at every read/write approval and waits for a human who
    // is not looking.
    const harness = makeHarness()
    const result = await spawnAgent(
      leadContext(),
      { agent: 'antigravity', task: 'polish the settings screen' },
      harness.deps,
    )
    if (!result.ok || result.state !== 'starting') throw new Error('expected a starting result')

    expect(result.mode).toBe('interactive')
    expect(harness.createdAgents[0].initialInput).toBe('polish the settings screen')
    expect(harness.createdAgents[0].extraArgs).toEqual(['--dangerously-skip-permissions'])
  })

  it('accepts `exec` as a spelling of oneshot, since that is what the MCP schema says', async () => {
    const harness = makeHarness()
    const result = await spawnAgent(
      leadContext(),
      { agent: 'codex', task: 'run the migration', mode: 'exec' },
      harness.deps,
    )
    if (!result.ok || result.state !== 'starting') throw new Error('expected a starting result')
    expect(result.mode).toBe('oneshot')
    // The bypass sits BEFORE the positional prompt: `codex exec [OPTIONS] PROMPT`
    // stops reading options once the prompt is consumed. It is also what lets
    // codex run at all inside a freshly provisioned worktree, which it does not
    // trust — without it the process exits before it starts.
    expect(harness.createdAgents[0].extraArgs).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      'run the migration',
    ])
  })

  it('falls back to interactive, and says so, for an agent with no one-shot form', async () => {
    const harness = makeHarness()
    const result = await spawnAgent(
      leadContext(),
      { agent: 'antigravity', task: 'draft the migration plan' },
      harness.deps,
    )
    if (!result.ok || result.state !== 'starting') throw new Error('expected a starting result')

    expect(result.mode).toBe('interactive')
    expect(harness.createdAgents[0].initialInput).toBe('draft the migration plan')
    // The caller asked for a signal it is not going to get; saying nothing would
    // leave it waiting for an exit that never comes.
    expect(result.message).toMatch(/no one-shot form/)
  })

  it('refuses a terminal without the orchestrator capability', async () => {
    const harness = makeHarness()
    const result = await spawnAgent(
      contextFor('proj-api'),
      { agent: 'claude', task: 'do the thing' },
      harness.deps,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.denial).toEqual({ kind: 'missing-capability', capability: 'agent.spawn' })
    expect(harness.createdAgents).toHaveLength(0)
  })

  it('refuses `shell`, which has no task to hand a prompt to', async () => {
    const harness = makeHarness()
    const result = await spawnAgent(
      leadContext(),
      { agent: 'shell', task: 'rm -rf /' },
      harness.deps,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('invalid')
    expect(result.error).toMatch(/alethe_run_shell/)
    expect(harness.createdAgents).toHaveLength(0)
  })

  it('rejects an unknown agent, an empty task and an unknown mode', async () => {
    const harness = makeHarness()
    for (const input of [
      { agent: 'gpt5', task: 'x' },
      { agent: 'claude', task: '   ' },
      { agent: 'claude', task: 'x', mode: 'daemon' },
      { agent: 'claude', task: `bad\u001b[2Jtask` },
    ]) {
      const result = await spawnAgent(leadContext(), input, harness.deps)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('invalid')
    }
    expect(harness.createdAgents).toHaveLength(0)
  })
})

describe('spawnAgent live-agent ceiling', () => {
  /** The lead's own conversation plus `workers` delegated agents, all alive. */
  function crowdedHarness(workers: number) {
    const ids = ['term-a', 'term-b', 'term-c', 'term-d'].slice(0, workers)
    return makeHarness({
      terminals: [
        makeView({ id: 'term-lead', projectId: 'proj-api', alive: true }),
        ...ids.map((id, index) =>
          makeView({
            id,
            // Workspace-wide: a sibling project of the group counts too.
            projectId: index % 2 === 0 ? 'proj-api' : 'proj-web',
            alive: true,
            agent: 'codex',
          }),
        ),
      ],
    })
  }

  it('refuses the next agent once the workers reach the ceiling', async () => {
    const harness = crowdedHarness(3)
    harness.agentControls.maxLiveAgents = 3
    const result = await spawnAgent(
      leadContext(),
      { agent: 'claude', task: 'one more thing' },
      harness.deps,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('denied')
    // Not a capability problem: the token is fine, the workspace is full.
    expect(result.denial).toBeUndefined()
    expect(result.error).toContain('3 other agent processes are already running')
    expect(result.error).toContain('at most 3')
    // The message has to say what is counted, or the number reads as wrong.
    expect(result.error).toMatch(/not part of that count/)
    expect(result.error).toMatch(/alethe_kill_terminal/)
    // The ceiling is a setting, quoted in the language the person actually sees.
    expect(result.error).toContain('Preferências')
    expect(result.error).toContain('Agentes vivos por orquestrador')
    expect(harness.createdAgents).toHaveLength(0)
  })

  it('does not count the terminal asking against its own ceiling', async () => {
    // The bug this replaces: 1 orchestrator + 2 workers with the ceiling at 3
    // refused the third worker, so "at most 3 agents" behaved like "at most 2".
    const harness = crowdedHarness(2)
    harness.agentControls.maxLiveAgents = 3
    const result = await spawnAgent(
      leadContext(),
      { agent: 'claude', task: 'the third worker' },
      harness.deps,
    )
    expect(result.ok).toBe(true)
    expect(harness.createdAgents).toHaveLength(1)
  })

  it('leaves the whole requester pane out, not only the tab it is showing', async () => {
    // Delegated agents always land in a pane of their own, so a second tab
    // inside the orchestrator's pane is the person's own work, not fan-out.
    const harness = crowdedHarness(2)
    harness.agentControls.maxLiveAgents = 3
    harness.subTabs.push({
      ...harness.subTabs[0],
      id: 'tab-lead-second',
      ptyId: 'pty-tab-lead-second',
      agent: 'claude',
      alive: true,
      active: false,
    })

    const result = await spawnAgent(
      leadContext(),
      { agent: 'claude', task: 'the third worker' },
      harness.deps,
    )
    expect(result.ok).toBe(true)
  })

  it('allows the spawn again once the ceiling is raised', async () => {
    const harness = crowdedHarness(3)
    harness.agentControls.maxLiveAgents = 4
    const result = await spawnAgent(
      leadContext(),
      { agent: 'claude', task: 'one more thing' },
      harness.deps,
    )
    expect(result.ok).toBe(true)
    expect(harness.createdAgents).toHaveLength(1)
  })

  it('ignores shells and dead terminals when counting', async () => {
    const harness = makeHarness({
      terminals: [
        makeView({ id: 'term-lead', projectId: 'proj-api', alive: true }),
        makeView({ id: 'term-shell', projectId: 'proj-api', alive: true, agent: 'shell' }),
        makeView({ id: 'term-dead', projectId: 'proj-api', alive: false, agent: 'codex' }),
        makeView({ id: 'term-live', projectId: 'proj-api', alive: true, agent: 'codex' }),
      ],
    })
    harness.agentControls.maxLiveAgents = 2
    const result = await spawnAgent(leadContext(), { agent: 'codex', task: 'go' }, harness.deps)
    expect(result.ok).toBe(true)
  })
})

describe('spawnAgent with a multi-line task', () => {
  /** The shape that broke in practice: a briefing of several paragraphs. */
  const BRIEFING =
    'First paragraph of the briefing.\n\nSecond paragraph with the constraints.\nThird line.'

  it('goes through argv even when interactive was asked for', async () => {
    const harness = makeHarness()
    const result = await spawnAgent(
      leadContext(),
      { agent: 'codex', task: BRIEFING, mode: 'interactive' },
      harness.deps,
    )
    if (!result.ok || result.state !== 'starting') throw new Error('expected a starting result')

    // argv carries the paragraphs verbatim; typing them into a TUI submits the
    // first one alone whenever the CLI ignores bracketed paste.
    expect(result.mode).toBe('oneshot')
    expect(harness.createdAgents[0].extraArgs).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      BRIEFING,
    ])
    expect(harness.createdAgents[0].initialInput).toBeUndefined()
    // The caller named a mode and got another one; saying nothing would leave it
    // waiting for a prompt instead of an exit.
    expect(result.message).toMatch(/You asked for "interactive"/)
    expect(result.message).toMatch(/bracketed paste/)
  })

  it('flattens the task for an agent with no one-shot form, and says so', async () => {
    const harness = makeHarness()
    const result = await spawnAgent(
      leadContext(),
      { agent: 'antigravity', task: BRIEFING, mode: 'interactive' },
      harness.deps,
    )
    if (!result.ok || result.state !== 'starting') throw new Error('expected a starting result')

    expect(result.mode).toBe('interactive')
    const initialInput = harness.createdAgents[0].initialInput ?? ''
    expect(initialInput).toBe(
      'First paragraph of the briefing. Second paragraph with the constraints. Third line.',
    )
    // Everything on one line beats the first paragraph on several.
    expect(initialInput).not.toMatch(/[\r\n]/)
    for (const word of BRIEFING.split(/\s+/)) expect(initialInput).toContain(word)
    expect(result.message).toMatch(/collapsed into single spaces/)
  })

  it('leaves a single-line interactive task exactly as it was', async () => {
    const harness = makeHarness()
    const result = await spawnAgent(
      leadContext(),
      { agent: 'codex', task: 'review this diff', mode: 'interactive' },
      harness.deps,
    )
    if (!result.ok || result.state !== 'starting') throw new Error('expected a starting result')

    expect(result.mode).toBe('interactive')
    expect(harness.createdAgents[0].initialInput).toBe('review this diff')
    expect(harness.createdAgents[0].extraArgs).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
    ])
    expect(result.message).not.toMatch(/collapsed/)
    expect(result.message).not.toMatch(/You asked for/)
  })
})

describe('spawnAgent under spawn pressure', () => {
  it('queues instead of blocking, and explains the memory ceiling', async () => {
    const harness = makeHarness()
    harness.queue.pressureBlocked = true
    harness.queue.pressureReason = 'memory-pressure'

    const result = await spawnAgent(leadContext(), { agent: 'codex', task: 'build' }, harness.deps)
    if (!result.ok) throw new Error(result.error)
    expect(result.state).toBe('queued')
    if (result.state !== 'queued') return

    expect(result.queuePosition).toBe(1)
    expect(harness.createdAgents).toHaveLength(0)
    expect(result.message).toMatch(/Do NOT send this request again/i)
    // Same advice `run_shell` gives: the budget is a setting, and this value
    // would clear the request.
    expect(result.message).toContain('Limite rígido (MB)')
    expect(result.message).toContain('3072 MB would clear this request')
  })

  it('starts on its own once the pressure clears, with no second request', async () => {
    const harness = makeHarness()
    harness.queue.pressureBlocked = true
    const result = await spawnAgent(leadContext(), { agent: 'codex', task: 'build' }, harness.deps)
    if (!result.ok || result.state !== 'queued') throw new Error('expected a queued result')

    harness.queue.pressureBlocked = false
    await harness.clock.advance(QUEUE_RECHECK_MS)
    expect(harness.createdAgents).toHaveLength(1)
    expect(jobState(result.jobId).state).toBe('starting')
  })
})

describe('spawnAgent watchdog', () => {
  it('flips the job to running on the first sign of life', async () => {
    const harness = makeHarness()
    const result = await spawnAgent(leadContext(), { agent: 'codex', task: 'build' }, harness.deps)
    if (!result.ok || result.state !== 'starting') throw new Error('expected a starting result')

    const created = harness.findTerminal(result.terminalId)
    if (!created) throw new Error('agent terminal was not created')
    created.alive = true

    await harness.clock.advance(SHELL_WATCHDOG_POLL_MS)
    expect(jobState(result.jobId).state).toBe('running')
    // A pane of its own has nothing to hand back.
    expect(harness.activated).toHaveLength(0)
  })

  it('marks the job failed_to_start when the PTY never shows a sign of life', async () => {
    const harness = makeHarness()
    const result = await spawnAgent(leadContext(), { agent: 'codex', task: 'build' }, harness.deps)
    if (!result.ok || result.state !== 'starting') throw new Error('expected a starting result')

    await harness.clock.advance(SHELL_START_TIMEOUT_MS + SHELL_WATCHDOG_POLL_MS)
    expect(jobState(result.jobId)).toMatchObject({ state: 'failed', failure: 'failed_to_start' })
  })

  it('reports a creation failure instead of leaving a job hanging', async () => {
    const harness = makeHarness()
    harness.agentControls.createError = new Error('worktree provisioning died')
    const result = await spawnAgent(leadContext(), { agent: 'codex', task: 'build' }, harness.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('io')
    expect(result.error).toContain('worktree provisioning died')
  })
})

/* ---------------------------------------------------------------------------
 * sendPrompt
 * ------------------------------------------------------------------------- */

describe('sendPrompt', () => {
  function harnessWithWorker() {
    const harness = makeHarness({
      terminals: [
        makeView({ id: 'term-lead', projectId: 'proj-api', alive: true }),
        makeView({ id: 'term-worker', projectId: 'proj-api', alive: true, agent: 'codex' }),
        makeView({ id: 'term-stranger', projectId: 'proj-other', alive: true }),
      ],
    })
    return harness
  }

  it('delivers the text and arms the completion monitor', async () => {
    const harness = harnessWithWorker()
    const result = await sendPrompt(
      leadContext(),
      { terminalId: 'term-worker', text: 'now run the tests' },
      harness.deps,
    )
    if (!result.ok) throw new Error(result.error)

    expect(harness.prompts).toEqual([
      { ptyId: 'pty-term-worker', text: 'now run the tests', bracketed: true },
    ])
    // The monitor only ever arms from xterm's onData, which an injected prompt
    // never passes through. Without this call the terminal reports idle for the
    // whole turn and completion is never detected.
    expect(harness.recordedInput).toEqual([['pty-term-worker', 'now run the tests\r']])
    expect(result.message).toMatch(/alethe_read_output/)
  })

  it('does not arm the monitor when the delivery failed', async () => {
    const harness = harnessWithWorker()
    harness.agentControls.promptDelivered = false
    const result = await sendPrompt(
      leadContext(),
      { terminalId: 'term-worker', text: 'hello' },
      harness.deps,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('io')
    expect(harness.recordedInput).toHaveLength(0)
  })

  it('skips bracketed paste for a plain shell, which does not enable it', async () => {
    const harness = makeHarness({
      terminals: [
        makeView({ id: 'term-lead', projectId: 'proj-api', alive: true }),
        makeView({ id: 'term-sh', projectId: 'proj-api', alive: true, agent: 'shell' }),
      ],
    })
    await sendPrompt(leadContext(), { terminalId: 'term-sh', text: 'ls' }, harness.deps)
    expect(harness.prompts[0].bracketed).toBe(false)
  })

  it('denies a target in another group', async () => {
    const harness = harnessWithWorker()
    const result = await sendPrompt(
      leadContext(),
      { terminalId: 'term-stranger', text: 'hello' },
      harness.deps,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.denial).toEqual({ kind: 'out-of-scope', targetProjectId: 'proj-other' })
    expect(harness.prompts).toHaveLength(0)
  })

  it('denies a terminal without the prompt capability', async () => {
    const harness = harnessWithWorker()
    const result = await sendPrompt(
      contextFor('proj-api'),
      { terminalId: 'term-worker', text: 'hello' },
      harness.deps,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.denial).toEqual({ kind: 'missing-capability', capability: 'agent.prompt' })
    expect(harness.prompts).toHaveLength(0)
  })

  it('refuses a terminal with no running process', async () => {
    const harness = makeHarness({
      terminals: [
        makeView({ id: 'term-lead', projectId: 'proj-api', alive: true }),
        makeView({ id: 'term-cold', projectId: 'proj-api', alive: false }),
      ],
    })
    const result = await sendPrompt(
      leadContext(),
      { terminalId: 'term-cold', text: 'hello' },
      harness.deps,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('invalid')
    expect(harness.prompts).toHaveLength(0)
  })

  it('reports an unknown terminal and rejects empty or unsafe text', async () => {
    const harness = harnessWithWorker()
    const ghost = await sendPrompt(leadContext(), { terminalId: 'nope', text: 'x' }, harness.deps)
    expect(ghost.ok).toBe(false)
    if (!ghost.ok) expect(ghost.code).toBe('not-found')

    for (const text of ['   ', `smuggled\u001b[2J`]) {
      const result = await sendPrompt(
        leadContext(),
        { terminalId: 'term-worker', text },
        harness.deps,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('invalid')
    }
    expect(harness.prompts).toHaveLength(0)
  })

  it('flattens a multi-line prompt onto one line, and says so', async () => {
    const harness = harnessWithWorker()
    const result = await sendPrompt(
      leadContext(),
      { terminalId: 'term-worker', text: 'first line\n\nsecond line\nthird line' },
      harness.deps,
    )
    if (!result.ok) throw new Error(result.error)

    // Bracketed paste is only a promise a CLI may not keep: a newline it does
    // not recognize as part of a paste is an Enter, which submits the first
    // line alone and drops the rest.
    expect(harness.prompts[0].text).toBe('first line second line third line')
    expect(harness.prompts[0].text).not.toMatch(/[\r\n]/)
    // What the monitor is armed with has to be what actually went in.
    expect(harness.recordedInput).toEqual([
      ['pty-term-worker', 'first line second line third line\r'],
    ])
    expect(result.message).toMatch(/collapsed into single spaces/)
  })

  it('leaves a single-line prompt untouched and says nothing about flattening', async () => {
    const harness = harnessWithWorker()
    const result = await sendPrompt(
      leadContext(),
      { terminalId: 'term-worker', text: 'now run the tests' },
      harness.deps,
    )
    if (!result.ok) throw new Error(result.error)
    expect(harness.prompts[0].text).toBe('now run the tests')
    expect(result.message).not.toMatch(/collapsed/)
  })

  it('reaches a shell sub-tab by its own id', async () => {
    const harness = makeHarness()
    const shell = await openShell(contextFor('proj-api'), { command: 'python' }, harness.deps)
    if (!shell.ok || shell.state !== 'starting') throw new Error('expected a starting result')
    harness.bootShell(shell.terminalId)

    const result = await sendPrompt(
      leadContext(),
      { terminalId: shell.terminalId, text: 'print(1)' },
      harness.deps,
    )
    expect(result.ok).toBe(true)
    expect(harness.prompts[0].ptyId).toBe(`pty-${shell.terminalId}`)
  })
})

/* ---------------------------------------------------------------------------
 * killTerminal
 * ------------------------------------------------------------------------- */

describe('killTerminal', () => {
  function harnessWithWorker() {
    return makeHarness({
      terminals: [
        makeView({ id: 'term-lead', projectId: 'proj-api', alive: true }),
        makeView({ id: 'term-worker', projectId: 'proj-api', alive: true, agent: 'codex' }),
        makeView({ id: 'term-sibling', projectId: 'proj-web', alive: true, agent: 'codex' }),
        makeView({ id: 'term-stranger', projectId: 'proj-other', alive: true }),
      ],
    })
  }

  it('stops the process tree and keeps the terminal in the workspace', async () => {
    const harness = harnessWithWorker()
    const result = await killTerminal(leadContext(), 'term-worker', harness.deps)
    if (!result.ok) throw new Error(result.error)

    expect(result.wasAlive).toBe(true)
    expect(harness.killed).toEqual([['proj-api', 'term-worker']])
    // The entity survives: an isolated agent keeps its worktree, so the work it
    // did is still there to review.
    expect(harness.findTerminal('term-worker')).toBeDefined()
    expect(harness.findTerminal('term-worker')?.alive).toBe(false)
  })

  it('reaches a sibling project in the same group', async () => {
    const harness = harnessWithWorker()
    expect((await killTerminal(leadContext(), 'term-sibling', harness.deps)).ok).toBe(true)
  })

  it('never reaches another group', async () => {
    const harness = harnessWithWorker()
    const result = await killTerminal(leadContext(), 'term-stranger', harness.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.denial).toEqual({ kind: 'out-of-scope', targetProjectId: 'proj-other' })
    expect(harness.killed).toHaveLength(0)
  })

  it('denies a terminal without the kill capability', async () => {
    const harness = harnessWithWorker()
    const result = await killTerminal(contextFor('proj-api'), 'term-worker', harness.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.denial).toEqual({ kind: 'missing-capability', capability: 'agent.kill' })
    expect(harness.killed).toHaveLength(0)
  })

  it('refuses to kill the caller itself', async () => {
    const harness = harnessWithWorker()
    const result = await killTerminal(leadContext(), 'term-lead', harness.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('invalid')
    expect(harness.killed).toHaveLength(0)
  })

  it('refuses a sub-tab id, which would take down the whole pane', async () => {
    const harness = makeHarness()
    const shell = await openShell(contextFor('proj-api'), { command: 'sleep 100' }, harness.deps)
    if (!shell.ok || shell.state !== 'starting') throw new Error('expected a starting result')

    const result = await killTerminal(leadContext(), shell.terminalId, harness.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('invalid')
    expect(result.error).toContain('term-lead')
    expect(harness.killed).toHaveLength(0)
  })

  it('succeeds on a terminal that had already exited', async () => {
    const harness = makeHarness({
      terminals: [
        makeView({ id: 'term-lead', projectId: 'proj-api', alive: true }),
        makeView({ id: 'term-done', projectId: 'proj-api', alive: false }),
      ],
    })
    const result = await killTerminal(leadContext(), 'term-done', harness.deps)
    if (!result.ok) throw new Error(result.error)
    expect(result.wasAlive).toBe(false)
  })

  it('reports an unknown terminal', async () => {
    const harness = harnessWithWorker()
    const result = await killTerminal(leadContext(), 'term-ghost', harness.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('not-found')
  })
})

/* ---------------------------------------------------------------------------
 * waitForDone
 * ------------------------------------------------------------------------- */

function waitHarness() {
  return makeHarness({
    terminals: [
      makeView({ id: 'term-lead', projectId: 'proj-api', alive: true }),
      makeView({ id: 'term-worker', projectId: 'proj-api', alive: true, agent: 'codex' }),
      makeView({ id: 'term-cold', projectId: 'proj-api', alive: false }),
      makeView({ id: 'term-off', projectId: 'proj-api', alive: false, disabled: true }),
      makeView({ id: 'term-stranger', projectId: 'proj-other', alive: true }),
    ],
  })
}

/** Starts a wait without awaiting it, so the fake clock can drive it. */
function startWait(
  harness: ReturnType<typeof makeHarness>,
  terminalId: string,
  timeoutMs?: number,
) {
  let settled: Awaited<ReturnType<typeof waitForDone>> | null = null
  const promise = waitForDone(leadContext(), { terminalId, timeoutMs }, harness.deps).then(
    (result) => {
      settled = result
      return result
    },
  )
  return {
    promise,
    settled: () => settled,
    async outcome() {
      const result = await promise
      if (!result.ok) throw new Error(result.error)
      return result
    },
  }
}

describe('waitForDone', () => {
  it('answers on the spot when the process has already exited', async () => {
    const harness = waitHarness()
    harness.exitPty('term-worker')

    const result = await waitForDone(leadContext(), { terminalId: 'term-worker' }, harness.deps)
    if (!result.ok) throw new Error(result.error)

    expect(result).toMatchObject({
      done: true,
      source: 'exit',
      confidence: 'high',
      state: 'exited',
      alive: false,
      timedOut: false,
      waitedMs: 0,
    })
    // Nothing was armed: a terminal that is already stopped must not cost the
    // caller a single poll, let alone the whole timeout.
    expect(harness.clock.pending()).toBe(0)
  })

  it('never returns the output, which the tool description promises it will not', async () => {
    const harness = waitHarness()
    harness.exitPty('term-worker')
    const result = await waitForDone(leadContext(), { terminalId: 'term-worker' }, harness.deps)
    expect(result).not.toHaveProperty('output')
  })

  it('detects a process that exits in the middle of the wait', async () => {
    const harness = waitHarness()
    const wait = startWait(harness, 'term-worker')

    await harness.clock.advance(2_000)
    expect(wait.settled()).toBeNull()

    harness.exitPty('term-worker')
    await harness.clock.advance(WAIT_POLL_MS)

    const result = await wait.outcome()
    expect(result).toMatchObject({ done: true, source: 'exit', confidence: 'high' })
    expect(result.waitedMs).toBe(2_000 + WAIT_POLL_MS)
  })

  it('reports a terminal that goes quiet with medium confidence and an honest source', async () => {
    const harness = waitHarness()
    harness.setActivity('term-worker', 'working')
    const wait = startWait(harness, 'term-worker')

    await harness.clock.advance(3_000)
    expect(wait.settled()).toBeNull()

    harness.setActivity('term-worker', 'waiting')
    await harness.clock.advance(WAIT_POLL_MS)

    const result = await wait.outcome()
    expect(result).toMatchObject({
      done: true,
      source: 'idle',
      confidence: 'medium',
      state: 'quiet',
      alive: true,
    })
    // The signal is worth what it is worth, and the answer says so rather than
    // dressing a heuristic up as a fact.
    expect(result.message).toMatch(/medium confidence/i)
    expect(result.message).toMatch(/still alive/i)
  })

  it('does not call a one-shot agent finished just because the tracker is silent', async () => {
    // Nothing types into a spawned one-shot agent, so the completion heuristic
    // never arms and the store reads `waiting` for the whole run. Taking that as
    // completion would declare every delegated agent done the moment it boots.
    const harness = waitHarness()
    const wait = startWait(harness, 'term-worker', 10_000)

    await harness.clock.advance(9_000)
    expect(wait.settled()).toBeNull()

    harness.exitPty('term-worker')
    await harness.clock.advance(WAIT_POLL_MS)

    expect(await wait.outcome()).toMatchObject({ done: true, source: 'exit' })
  })

  it('answers ok when it runs out of time, never an error', async () => {
    const harness = waitHarness()
    harness.setActivity('term-worker', 'working')
    const wait = startWait(harness, 'term-worker', 5_000)

    await harness.clock.advance(5_000)

    const result = await wait.outcome()
    expect(result).toMatchObject({
      done: false,
      source: null,
      confidence: null,
      state: 'working',
      alive: true,
      timedOut: true,
      waitedMs: 5_000,
      timeoutMs: 5_000,
    })
    expect(result.message).toMatch(/not a failure/i)
    expect(result.message).toMatch(/again/i)
    // Nothing is left running: a wait that answered must not keep polling.
    expect(harness.clock.pending()).toBe(0)
  })

  it('says the activity signal proves nothing when it never saw the terminal active', async () => {
    const harness = waitHarness()
    const wait = startWait(harness, 'term-worker', 5_000)
    await harness.clock.advance(5_000)

    const result = await wait.outcome()
    expect(result).toMatchObject({ done: false, timedOut: true, state: 'quiet', alive: true })
    expect(result.message).toMatch(/one-shot/i)
  })

  it('clamps a timeout above the ceiling instead of refusing it', async () => {
    const harness = waitHarness()
    const wait = startWait(harness, 'term-worker', 600_000)

    await harness.clock.advance(WAIT_TIMEOUT_MAX_MS)

    const result = await wait.outcome()
    expect(result.timeoutMs).toBe(WAIT_TIMEOUT_MAX_MS)
    expect(result.waitedMs).toBe(WAIT_TIMEOUT_MAX_MS)
    expect(result.timedOut).toBe(true)
    expect(result.message).toContain('clamped')
  })

  it('clamps a timeout below the floor', async () => {
    const harness = waitHarness()
    const wait = startWait(harness, 'term-worker', 5)

    await harness.clock.advance(WAIT_TIMEOUT_MIN_MS)

    const result = await wait.outcome()
    expect(result.timeoutMs).toBe(WAIT_TIMEOUT_MIN_MS)
    expect(result.timedOut).toBe(true)
  })

  it('falls back to the default timeout when none is given', async () => {
    const harness = waitHarness()
    const wait = startWait(harness, 'term-worker')

    await harness.clock.advance(WAIT_TIMEOUT_DEFAULT_MS)

    const result = await wait.outcome()
    expect(result.timeoutMs).toBe(WAIT_TIMEOUT_DEFAULT_MS)
    expect(result.message).not.toContain('clamped')
  })

  it('waits for a pane whose process has not booted yet, then says it never started', async () => {
    const harness = waitHarness()
    const wait = startWait(harness, 'term-cold')

    // Created is not running: answering "exited" here would turn every
    // spawn-then-wait into an instant, false completion.
    await harness.clock.advance(WAIT_START_GRACE_MS - WAIT_POLL_MS)
    expect(wait.settled()).toBeNull()

    await harness.clock.advance(WAIT_POLL_MS)
    const result = await wait.outcome()
    expect(result).toMatchObject({
      done: false,
      source: null,
      state: 'not-started',
      alive: false,
      timedOut: false,
      waitedMs: WAIT_START_GRACE_MS,
    })
  })

  it('picks up a process that boots inside the start grace', async () => {
    const harness = waitHarness()
    const wait = startWait(harness, 'term-cold')

    await harness.clock.advance(1_000)
    harness.bootPty('term-cold')
    await harness.clock.advance(WAIT_START_GRACE_MS)
    expect(wait.settled()).toBeNull()

    harness.exitPty('term-cold')
    await harness.clock.advance(WAIT_POLL_MS)
    expect(await wait.outcome()).toMatchObject({ done: true, source: 'exit' })
  })

  it('does not sit on the start grace for a disabled terminal', async () => {
    const harness = waitHarness()
    const result = await waitForDone(leadContext(), { terminalId: 'term-off' }, harness.deps)
    if (!result.ok) throw new Error(result.error)

    expect(result).toMatchObject({ done: false, state: 'not-started', waitedMs: 0 })
    expect(result.message).toMatch(/disabled/i)
    expect(harness.clock.pending()).toBe(0)
  })

  it('stops waiting when the terminal leaves the workspace', async () => {
    const harness = waitHarness()
    const wait = startWait(harness, 'term-worker')

    harness.removeTerminal('term-worker')
    await harness.clock.advance(WAIT_POLL_MS)

    const result = await wait.outcome()
    expect(result).toMatchObject({ done: true, source: 'gone', state: 'gone' })
    expect(result.message).toMatch(/no longer in this workspace/i)
  })

  it('waits on a sub-tab exactly as it waits on a pane', async () => {
    const harness = waitHarness()
    const wait = startWait(harness, 'term-worker~agent')

    await harness.clock.advance(1_000)
    expect(wait.settled()).toBeNull()

    harness.exitPty('term-worker~agent')
    await harness.clock.advance(WAIT_POLL_MS)

    const result = await wait.outcome()
    expect(result).toMatchObject({ terminalId: 'term-worker~agent', done: true, source: 'exit' })
  })
})

describe('waitForDone scope', () => {
  it('denies a terminal without the orchestration capability', async () => {
    const harness = waitHarness()
    const result = await waitForDone(
      contextFor('proj-api'),
      { terminalId: 'term-worker' },
      harness.deps,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.denial).toEqual({ kind: 'missing-capability', capability: 'agent.spawn' })
    expect(harness.clock.pending()).toBe(0)
  })

  it('denies a target in another group', async () => {
    const harness = waitHarness()
    const result = await waitForDone(leadContext(), { terminalId: 'term-stranger' }, harness.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.denial).toEqual({ kind: 'out-of-scope', targetProjectId: 'proj-other' })
    expect(harness.clock.pending()).toBe(0)
  })

  it('reports an unknown terminal', async () => {
    const harness = waitHarness()
    const result = await waitForDone(leadContext(), { terminalId: 'term-ghost' }, harness.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('not-found')
  })

  it('refuses to wait for the caller itself, which could never finish', async () => {
    const harness = waitHarness()
    const result = await waitForDone(leadContext(), { terminalId: 'term-lead' }, harness.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('invalid')
    expect(harness.clock.pending()).toBe(0)
  })
})

/* ---------------------------------------------------------------------------
 * listAgents
 * ------------------------------------------------------------------------- */

describe('listAgents', () => {
  it('reports installation and orchestration separately', async () => {
    const harness = makeHarness()
    const result = await listAgents(leadContext(), harness.deps)
    if (!result.ok) throw new Error(result.error)

    const byAgent = Object.fromEntries(result.agents.map((item) => [item.agent, item]))
    expect(byAgent.claude).toMatchObject({ installed: true, canOrchestrate: true })
    expect(byAgent.codex).toMatchObject({ installed: true, canOrchestrate: true })
    // Spawnable is not the same as able to drive this control plane: OpenCode
    // and Antigravity have no verified MCP path.
    expect(byAgent.opencode).toMatchObject({ installed: false, canOrchestrate: false })
    expect(byAgent.antigravity).toMatchObject({ installed: false, canOrchestrate: false })
  })

  it('says usage: null rather than estimating for a provider that exposes none', async () => {
    const harness = makeHarness()
    const result = await listAgents(leadContext(), harness.deps)
    if (!result.ok) throw new Error(result.error)
    expect(result.agents.find((item) => item.agent === 'opencode')?.usage).toBeNull()
  })

  it('survives a provider that fails, without losing the rest of the list', async () => {
    const harness = makeHarness()
    harness.agentControls.brokenProbes.add('codex')
    harness.agentControls.usage.set('claude', {
      windows: [{ window: '5h', usedPercent: 42, resetsAt: '2026-08-10T18:00:00Z' }],
      rateLimited: false,
    })

    const result = await listAgents(leadContext(), harness.deps)
    if (!result.ok) throw new Error(result.error)

    expect(result.agents).toHaveLength(7)
    const codex = result.agents.find((item) => item.agent === 'codex')
    // A failed probe costs its own field and nothing else.
    expect(codex).toMatchObject({ installed: false, usage: null, canOrchestrate: true })
    expect(result.agents.find((item) => item.agent === 'claude')?.usage).toEqual({
      windows: [{ window: '5h', usedPercent: 42, resetsAt: '2026-08-10T18:00:00Z' }],
      rateLimited: false,
    })
  })

  it('gives up on a hanging provider instead of holding the whole read', async () => {
    const harness = makeHarness()
    harness.agentControls.hangingProbes.add('claude')
    const pending = listAgents(leadContext(), harness.deps)
    await harness.clock.advance(PROVIDER_PROBE_TIMEOUT_MS)

    const result = await pending
    if (!result.ok) throw new Error(result.error)
    expect(result.agents.find((item) => item.agent === 'claude')?.usage).toBeNull()
  })

  it('never reports a plan name, even when the provider sends one', async () => {
    const harness = makeHarness()
    // The real mapping is what has to drop it, so feed it the raw payload.
    harness.agentControls.usage.set(
      'codex',
      codexUsageReport({
        primary: { used_percent: 12, window_minutes: 300, resets_at_ms: 1_760_000_000_000 },
        secondary: { used_percent: 4, window_minutes: 10_080, resets_at_ms: 0 },
        plan: 'Pro',
        rate_limited: false,
        reset_credits: 0,
      }),
    )

    const result = await listAgents(leadContext(), harness.deps)
    if (!result.ok) throw new Error(result.error)

    const serialized = JSON.stringify(result)
    for (const planName of ['Pro', 'plan', 'Max', 'Plus', 'Team']) {
      expect(serialized).not.toContain(planName)
    }
    expect(result.agents.find((item) => item.agent === 'codex')?.usage).toEqual({
      windows: [
        { window: '5h', usedPercent: 12, resetsAt: new Date(1_760_000_000_000).toISOString() },
        // A reset the provider did not state is null, not the epoch.
        { window: '7d', usedPercent: 4, resetsAt: null },
      ],
      rateLimited: false,
    })
  })

  it('reports nothing for an antigravity install that is not ready', () => {
    // Zeros from an unauthenticated CLI would read as "plenty of quota left".
    expect(
      antigravityUsageReport({
        status: 'no_auth',
        cli_path: '',
        used_percent: 0,
        rate_limited: false,
        buckets: [],
      }),
    ).toBeNull()
  })

  it('is reserved for orchestrator terminals', async () => {
    const harness = makeHarness()
    const result = await listAgents(contextFor('proj-api'), harness.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.denial).toEqual({ kind: 'missing-capability', capability: 'agent.spawn' })
  })
})

/* ---------------------------------------------------------------------------
 * Human approval
 * ------------------------------------------------------------------------- */

describe('approval gate', () => {
  function approvalHarness() {
    return makeHarness({
      terminals: [
        makeView({ id: 'term-lead', projectId: 'proj-api', alive: true }),
        makeView({ id: 'term-worker', projectId: 'proj-api', alive: true, agent: 'codex' }),
      ],
    })
  }

  /** The four writes, each in its ready-to-run form. */
  function writes(harness: ReturnType<typeof approvalHarness>) {
    return [
      {
        action: 'shell.run' as const,
        run: () => openShell(contextFor('proj-api'), { command: 'npm run build' }, harness.deps),
      },
      {
        action: 'agent.spawn' as const,
        run: () =>
          spawnAgent(leadContext(), { agent: 'codex', task: 'write the tests' }, harness.deps),
      },
      {
        action: 'agent.prompt' as const,
        run: () =>
          sendPrompt(leadContext(), { terminalId: 'term-worker', text: 'carry on' }, harness.deps),
      },
      {
        action: 'agent.kill' as const,
        run: () => killTerminal(leadContext(), 'term-worker', harness.deps),
      },
    ]
  }

  const ACTIONS = ['shell.run', 'agent.spawn', 'agent.prompt', 'agent.kill'] as const

  it('never asks for a read — looking at the workspace changes nothing', async () => {
    const harness = approvalHarness()
    harness.approvals.answer = 'deny'

    expect(listTerminals(leadContext(), harness.deps).ok).toBe(true)
    expect(terminalStatus(leadContext(), 'term-worker', harness.deps).ok).toBe(true)
    expect((await readOutput(leadContext(), 'term-worker', undefined, harness.deps)).ok).toBe(true)
    expect((await listAgents(leadContext(), harness.deps)).ok).toBe(true)
    harness.exitPty('term-worker')
    expect((await waitForDone(leadContext(), { terminalId: 'term-worker' }, harness.deps)).ok).toBe(
      true,
    )

    expect(harness.approvals.asked).toHaveLength(0)
  })

  it('asks before every write', async () => {
    for (const action of ACTIONS) {
      const harness = approvalHarness()
      const result = await writes(harness).find((item) => item.action === action)!.run()
      expect(result.ok).toBe(true)
      expect(harness.approvals.asked.map((item) => item.action)).toEqual([action])
    }
  })

  it('runs the operation once the person allows it', async () => {
    const harness = approvalHarness()
    const result = await openShell(contextFor('proj-api'), { command: 'npm test' }, harness.deps)
    expect(result.ok).toBe(true)
    expect(harness.createdSubTabs[0].command).toBe('npm test')
  })

  it('shows the payload whole — the decision is made on it, so it is never cut', async () => {
    const harness = approvalHarness()
    const command = 'echo ' + 'x'.repeat(MAX_COMMAND_LENGTH - 10)
    await openShell(contextFor('proj-api'), { command }, harness.deps)
    expect(harness.approvals.asked[0].payload).toBe(command)
  })

  it('names who asked, in which project, and what is being acted upon', async () => {
    const harness = approvalHarness()
    await sendPrompt(leadContext(), { terminalId: 'term-worker', text: 'carry on' }, harness.deps)
    expect(harness.approvals.asked[0]).toMatchObject({
      action: 'agent.prompt',
      requesterTerminalId: 'term-lead',
      projectId: 'proj-api',
      targetTerminalId: 'term-worker',
      payload: 'carry on',
    })
  })

  it('reports a refusal as a human decision, not as a missing permission', async () => {
    for (const action of ACTIONS) {
      const harness = approvalHarness()
      harness.approvals.answer = 'deny'
      const result = await writes(harness).find((item) => item.action === action)!.run()

      expect(result.ok).toBe(false)
      if (result.ok) return
      // Its own code: `denied` is the token lacking a capability or reaching out
      // of scope, which retrying never fixes. This one is about this moment.
      expect(result.code).toBe('refused')
      expect(result.denial).toBeUndefined()
      expect(result.error).toMatch(/a person refused/i)
      expect(result.error).toMatch(/do NOT retry/i)
    }
  })

  it('changes nothing when the person refuses', async () => {
    const harness = approvalHarness()
    harness.approvals.answer = 'deny'

    await openShell(contextFor('proj-api'), { command: 'rm -rf .' }, harness.deps)
    await spawnAgent(leadContext(), { agent: 'codex', task: 'go' }, harness.deps)
    await sendPrompt(leadContext(), { terminalId: 'term-worker', text: 'go' }, harness.deps)
    await killTerminal(leadContext(), 'term-worker', harness.deps)

    expect(harness.createdSubTabs).toHaveLength(0)
    expect(harness.created).toHaveLength(0)
    expect(harness.createdAgents).toHaveLength(0)
    expect(harness.prompts).toHaveLength(0)
    expect(harness.killed).toHaveLength(0)
    // No job either: a job says something is being worked on, and nothing is.
    expect(useOrchestratorStore.getState().jobIds).toHaveLength(0)
  })

  it('refuses a request nobody answers, in time for the reply to still cross the bridge', async () => {
    const harness = approvalHarness()
    harness.approvals.answer = 'silence'

    const pending = openShell(contextFor('proj-api'), { command: 'npm run build' }, harness.deps)
    await harness.clock.advance(APPROVAL_TIMEOUT_MS)
    const result = await pending

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('refused')
    expect(result.error).toMatch(/nobody answered/i)
    expect(harness.createdSubTabs).toHaveLength(0)
    // 30s below the 150s the Rust bridge blocks a thread for, so the refusal
    // reaches the model as a refusal instead of as the bridge's own timeout.
    expect(APPROVAL_TIMEOUT_MS).toBe(120_000)
  })

  it('drops the dead card once the deadline passed', async () => {
    const harness = approvalHarness()
    harness.approvals.answer = 'silence'

    const pending = openShell(contextFor('proj-api'), { command: 'npm run build' }, harness.deps)
    expect(harness.approvals.signals[0].aborted).toBe(false)
    await harness.clock.advance(APPROVAL_TIMEOUT_MS)
    await pending

    expect(harness.approvals.signals[0].aborted).toBe(true)
  })

  it('stops asking once the session grant covers this action and this terminal', async () => {
    const harness = approvalHarness()
    harness.approvals.answer = 'deny'
    harness.approvals.session.add('term-lead shell.run')

    const result = await openShell(contextFor('proj-api'), { command: 'npm test' }, harness.deps)

    expect(result.ok).toBe(true)
    expect(harness.approvals.asked).toHaveLength(0)
  })

  it('keeps asking for a different action of the same terminal', async () => {
    const harness = approvalHarness()
    harness.approvals.session.add('term-lead shell.run')

    await spawnAgent(leadContext(), { agent: 'codex', task: 'write the tests' }, harness.deps)

    expect(harness.approvals.asked.map((item) => item.action)).toEqual(['agent.spawn'])
  })

  it('keeps asking for the same action from a different terminal', async () => {
    const harness = approvalHarness()
    harness.approvals.session.add('term-worker shell.run')

    await openShell(contextFor('proj-api'), { command: 'npm test' }, harness.deps)

    expect(harness.approvals.asked.map((item) => item.action)).toEqual(['shell.run'])
  })

  it('never asks for an action the person auto-approved, whichever terminal asks', async () => {
    const harness = approvalHarness()
    harness.approvals.answer = 'deny'
    harness.approvals.auto.add('agent.prompt')

    const result = await sendPrompt(
      leadContext('proj-api', 'term-worker'),
      { terminalId: 'term-lead', text: 'carry on' },
      harness.deps,
    )

    expect(result.ok).toBe(true)
    expect(harness.approvals.asked).toHaveLength(0)
    expect(harness.prompts).toHaveLength(1)
  })

  it('reads the auto-approve preference on every request, never once at startup', async () => {
    const harness = approvalHarness()
    harness.approvals.answer = 'deny'

    const before = await openShell(contextFor('proj-api'), { command: 'npm test' }, harness.deps)
    expect(before.ok).toBe(false)

    harness.approvals.auto.add('shell.run')
    const after = await openShell(contextFor('proj-api'), { command: 'npm test' }, harness.deps)

    expect(after.ok).toBe(true)
    expect(harness.approvals.asked).toHaveLength(1)
  })

  it('does not ask for a spawn the workspace is going to refuse anyway', async () => {
    const harness = approvalHarness()
    harness.agentControls.maxLiveAgents = 1

    const result = await spawnAgent(leadContext(), { agent: 'codex', task: 'go' }, harness.deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('denied')
    expect(harness.approvals.asked).toHaveLength(0)
  })

  it('does not ask for a request that was malformed or out of scope to begin with', async () => {
    const harness = approvalHarness()

    expect((await openShell(contextFor('proj-api'), { command: '   ' }, harness.deps)).ok).toBe(
      false,
    )
    expect((await spawnAgent(leadContext(), { agent: 'nope', task: 'go' }, harness.deps)).ok).toBe(
      false,
    )
    expect(
      (await sendPrompt(leadContext(), { terminalId: 'term-ghost', text: 'x' }, harness.deps)).ok,
    ).toBe(false)
    expect((await killTerminal(leadContext(), 'term-lead', harness.deps)).ok).toBe(false)

    expect(harness.approvals.asked).toHaveLength(0)
  })
})

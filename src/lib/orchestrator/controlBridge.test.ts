import { beforeEach, describe, expect, it, vi } from 'vitest'

import { orchestratorJobSink, useOrchestratorStore } from '../../stores/orchestratorStore'
import {
  routeControlRequest,
  startControlBridge,
  type ControlBridgeDeps,
  type ControlBridgeTransport,
  type ControlReply,
  type ControlRequest,
} from './controlBridge'
import type {
  ControlSubTabView,
  ControlTerminalView,
  CreateAgentInput,
  OrchestratorDeps,
  PromptDeliveryRequest,
} from './ops'
import { capabilitiesFor, type ControlCapability, type ControlContext } from './scope'

const GROUPS: Record<string, string | null> = {
  'proj-api': 'grp-backend',
  'proj-web': 'grp-backend',
  'proj-other': 'grp-marketing',
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
    alive: true,
    ptyStatus: overrides.alive === false ? null : ('waiting' as const),
    ...overrides,
  }
}

function makeBridge(options?: {
  terminals?: ControlTerminalView[]
  scrollback?: string
  scrollbackError?: Error
  resolveContext?: (terminalId: string) => ControlContext | null
}) {
  const terminals = options?.terminals ?? [
    makeView({ id: 'term-lead', projectId: 'proj-api' }),
    makeView({ id: 'term-web', projectId: 'proj-web' }),
    makeView({ id: 'term-stranger', projectId: 'proj-other' }),
  ]
  const created: { projectId: string; name: string; cwd: string; command: string }[] = []
  const createdAgents: CreateAgentInput[] = []
  const killed: [string, string][] = []
  const prompts: PromptDeliveryRequest[] = []
  const recordedInput: [string, string][] = []
  const subTabs: ControlSubTabView[] = terminals.map((terminal) => ({
    ...terminal,
    id: `${terminal.id}~agent`,
    terminalId: terminal.id,
    active: true,
    pendingInput: false,
  }))
  let nextId = 1

  const ops: OrchestratorDeps = {
    workspaceTerminals: () => terminals,
    workspaceSubTabs: () => subTabs,
    resolveGroup: (projectId) => GROUPS[projectId] ?? null,
    createShellSubTab: ({ terminalId, ...input }) => {
      created.push(input)
      const id = `tab-shell-${nextId++}`
      subTabs.push({
        ...makeView({ id, projectId: input.projectId, agent: 'shell', alive: false }),
        terminalId,
        active: true,
        pendingInput: true,
      })
      return { terminalId, tabId: id, previousTabId: `${terminalId}~agent` }
    },
    createShell: (input) => {
      created.push(input)
      const id = `term-shell-${nextId++}`
      terminals.push(makeView({ id, projectId: input.projectId, agent: 'shell', alive: false }))
      return { terminalId: id }
    },
    createAgentTerminal: async (input) => {
      createdAgents.push(input)
      const id = `term-agent-${nextId++}`
      terminals.push(
        makeView({ id, projectId: input.projectId, agent: input.agent, alive: false }),
      )
      return { terminalId: id }
    },
    killTerminal: (projectId, terminalId) => {
      killed.push([projectId, terminalId])
    },
    deliverPrompt: async (input) => {
      prompts.push(input)
      return true
    },
    recordAgentInput: (ptyId, data) => {
      recordedInput.push([ptyId, data])
    },
    // Generous on purpose: this file tests routing, and the live-agent ceiling
    // has its own coverage in `ops.test.ts`.
    maxLiveAgents: () => 8,
    agentProbe: {
      isInstalled: async (agent) => agent === 'claude',
      usage: async () => null,
    },
    activateSubTab: () => {},
    focusTerminal: () => {},
    readScrollback: async () => {
      if (options?.scrollbackError) throw options.scrollbackError
      return options?.scrollback ?? 'hello from the pty'
    },
    spawnQueue: {
      snapshot: () => ({ active: 0, queued: 0, pressureBlocked: false, pressureReason: null }),
      acquire: async () => true,
      release: () => {},
    },
    memoryCeiling: () => ({
      usedMb: 900,
      budgetMb: 1536,
      systemTotalMb: 16_384,
      settingsLabel: 'Preferences',
      categoryLabel: 'Terminal and agents',
      budgetFieldLabel: 'Hard budget (MB)',
      liveAgentsFieldLabel: 'Agents an orchestrator may keep alive',
    }),
    // Routing is what this file tests, so nothing stops for a human here; the
    // gate itself is covered in `ops.test.ts`.
    approvals: {
      autoApproved: () => true,
      sessionApproved: () => false,
      ask: async () => true,
    },
    jobs: orchestratorJobSink,
    now: () => 0,
    schedule: () => {},
  }

  const bridge: ControlBridgeDeps = {
    ops,
    resolveContext:
      options?.resolveContext ??
      ((terminalId) => {
        const view = terminals.find((item) => item.id === terminalId)
        if (!view) return null
        return {
          terminalId,
          projectId: view.projectId,
          groupId: GROUPS[view.projectId] ?? null,
          capabilities: capabilitiesFor(false),
        }
      }),
  }

  return { bridge, terminals, created, createdAgents, killed, prompts, recordedInput }
}

/** Token of a terminal opened with the Orchestrator toggle on. */
const LEAD = { capabilities: capabilitiesFor(true) as ControlCapability[] }

function makeRequest(
  op: string,
  params: Record<string, unknown> = {},
  overrides?: { terminalId?: string; capabilities?: unknown },
): ControlRequest {
  return {
    requestId: `ctl-${op}`,
    ctx: {
      terminalId: overrides?.terminalId ?? 'term-lead',
      projectId: 'proj-api',
      groupId: 'grp-backend',
      capabilities: overrides?.capabilities ?? (capabilitiesFor(false) as ControlCapability[]),
    },
    op,
    params,
  }
}

function expectOk(reply: ControlReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(`expected ok, got ${reply.error.code}: ${reply.error.message}`)
  return reply.data as Record<string, unknown>
}

function expectError(reply: ControlReply) {
  if (reply.ok) throw new Error('expected an error reply')
  return reply.error
}

beforeEach(() => {
  useOrchestratorStore.getState().reset()
})

describe('routeControlRequest', () => {
  it('routes list_terminals and answers only what is in scope', async () => {
    const { bridge } = makeBridge()
    const data = expectOk(await routeControlRequest(makeRequest('list_terminals'), bridge))
    const terminals = data.terminals as { id: string }[]
    expect(terminals.map((item) => item.id)).toEqual(['term-lead', 'term-web'])
  })

  it('routes terminal_status', async () => {
    const { bridge } = makeBridge()
    const data = expectOk(
      await routeControlRequest(makeRequest('terminal_status', { terminalId: 'term-web' }), bridge),
    )
    expect(data.terminal).toMatchObject({ id: 'term-web', status: 'running' })
  })

  it('routes read_output and honours maxChars', async () => {
    const { bridge } = makeBridge({ scrollback: 'x'.repeat(200) })
    const data = expectOk(
      await routeControlRequest(
        makeRequest('read_output', { terminalId: 'term-lead', maxChars: 20 }),
        bridge,
      ),
    )
    expect(data.truncated).toBe(true)
    expect(String(data.output)).toHaveLength(21) // 20 chars plus the cut marker
  })

  it('routes run_shell and creates a real shell', async () => {
    const { bridge, created } = makeBridge()
    const data = expectOk(
      await routeControlRequest(
        makeRequest('run_shell', { command: 'npm test', name: 'suite' }),
        bridge,
      ),
    )
    expect(data.state).toBe('starting')
    expect(created).toEqual([
      { projectId: 'proj-api', name: 'suite', cwd: 'C:/repo/api', command: 'npm test' },
    ])
  })

  it('propagates a scope denial with its reason', async () => {
    const { bridge } = makeBridge()
    const error = expectError(
      await routeControlRequest(
        makeRequest('read_output', { terminalId: 'term-stranger' }),
        bridge,
      ),
    )
    expect(error.code).toBe('denied')
    expect(error.denial).toEqual({ kind: 'out-of-scope', targetProjectId: 'proj-other' })
  })

  it('propagates a capability denial from the token, not from the store', async () => {
    // The store knows nothing about the orchestrator flag: capabilities are the
    // backend's word, so a token without `shell.run` is refused even though
    // `resolveContext` would have granted it.
    const { bridge, created } = makeBridge()
    const error = expectError(
      await routeControlRequest(
        makeRequest('run_shell', { command: 'npm test' }, { capabilities: ['terminal.list'] }),
        bridge,
      ),
    )
    expect(error.denial).toEqual({ kind: 'missing-capability', capability: 'shell.run' })
    expect(created).toHaveLength(0)
  })

  it('denies everything when the capability list is malformed', async () => {
    const { bridge } = makeBridge()
    const error = expectError(
      await routeControlRequest(makeRequest('list_terminals', {}, { capabilities: 'all' }), bridge),
    )
    expect(error.denial).toEqual({ kind: 'missing-capability', capability: 'terminal.list' })
  })

  it('answers not-found when the terminal is gone from the workspace', async () => {
    const { bridge } = makeBridge()
    const error = expectError(
      await routeControlRequest(
        makeRequest('list_terminals', {}, { terminalId: 'term-ghost' }),
        bridge,
      ),
    )
    expect(error.code).toBe('not-found')
  })

  it('rejects a missing or malformed argument instead of guessing', async () => {
    const { bridge } = makeBridge()
    for (const request of [
      makeRequest('read_output', {}),
      makeRequest('read_output', { terminalId: 42 }),
      makeRequest('read_output', { terminalId: 'term-lead', maxChars: 'lots' }),
      makeRequest('terminal_status', { terminalId: '  ' }),
      makeRequest('run_shell', {}),
      makeRequest('run_shell', { command: 'ls', cwd: 3 }),
      makeRequest('spawn_agent', { task: 'x' }, LEAD),
      makeRequest('spawn_agent', { agent: 'claude' }, LEAD),
      makeRequest('spawn_agent', { agent: 'claude', task: 'x', mode: 7 }, LEAD),
      makeRequest('send_prompt', { terminalId: 'term-web' }, LEAD),
      makeRequest('kill_terminal', {}, LEAD),
      makeRequest('wait_for_done', {}, LEAD),
      makeRequest('wait_for_done', { terminalId: 'term-web', timeoutMs: 'soon' }, LEAD),
    ]) {
      expect(expectError(await routeControlRequest(request, bridge)).code).toBe('invalid')
    }
  })

  it('answers unknown-op instead of staying silent', async () => {
    const { bridge } = makeBridge()
    const error = expectError(await routeControlRequest(makeRequest('not_a_real_op'), bridge))
    expect(error.code).toBe('unknown-op')
  })

  it('answers a declared-but-unimplemented op immediately, never a pending promise', async () => {
    // The backend parks a thread on every request it emits, so an op it routes
    // here without an executor on this side has to come back as an error rather
    // than as silence — `events` is exactly that today.
    const { bridge } = makeBridge()
    for (const op of ['events']) {
      const error = expectError(
        await routeControlRequest(makeRequest(op, { terminalId: 'term-web' }, LEAD), bridge),
      )
      expect(error.code).toBe('unknown-op')
      expect(error.message).toContain(op)
      expect(error.message).toMatch(/retrying will not help/i)
    }
  })
})

describe('routeControlRequest orchestration tier', () => {
  it('routes spawn_agent and creates a pane of its own', async () => {
    const { bridge, createdAgents } = makeBridge()
    const data = expectOk(
      await routeControlRequest(
        makeRequest('spawn_agent', { agent: 'codex', task: 'ship it', name: 'worker' }, LEAD),
        bridge,
      ),
    )
    expect(data.state).toBe('starting')
    expect(data.mode).toBe('oneshot')
    expect(createdAgents).toHaveLength(1)
    expect(createdAgents[0]).toMatchObject({ projectId: 'proj-api', agent: 'codex', name: 'worker' })
  })

  it('routes send_prompt and arms the completion monitor', async () => {
    const { bridge, prompts, recordedInput } = makeBridge()
    expectOk(
      await routeControlRequest(
        makeRequest('send_prompt', { terminalId: 'term-web', text: 'go on' }, LEAD),
        bridge,
      ),
    )
    expect(prompts).toEqual([{ ptyId: 'pty-term-web', text: 'go on', bracketed: true }])
    expect(recordedInput).toEqual([['pty-term-web', 'go on\r']])
  })

  it('accepts `prompt` as well as `text`, since the MCP schema uses the former', async () => {
    const { bridge, prompts } = makeBridge()
    expectOk(
      await routeControlRequest(
        makeRequest('send_prompt', { terminalId: 'term-web', prompt: 'from the schema' }, LEAD),
        bridge,
      ),
    )
    expect(prompts[0].text).toBe('from the schema')
  })

  it('routes kill_terminal', async () => {
    const { bridge, killed } = makeBridge()
    const data = expectOk(
      await routeControlRequest(
        makeRequest('kill_terminal', { terminalId: 'term-web' }, LEAD),
        bridge,
      ),
    )
    expect(data.wasAlive).toBe(true)
    expect(killed).toEqual([['proj-web', 'term-web']])
  })

  /**
   * This harness has no clock (`schedule` is a no-op), so every wait routed here
   * has to answer on its first look — hence a terminal that already exited.
   * The polling paths are driven by the manual clock in `ops.test.ts`.
   */
  function bridgeWithFinishedWorker() {
    return makeBridge({
      terminals: [
        makeView({ id: 'term-lead', projectId: 'proj-api' }),
        makeView({ id: 'term-done', projectId: 'proj-api', alive: false, ptyStatus: 'stopped' }),
      ],
    })
  }

  it('routes wait_for_done and reports the signal it actually has', async () => {
    const { bridge } = bridgeWithFinishedWorker()
    const data = expectOk(
      await routeControlRequest(
        makeRequest('wait_for_done', { terminalId: 'term-done' }, LEAD),
        bridge,
      ),
    )
    expect(data).toMatchObject({
      terminalId: 'term-done',
      done: true,
      source: 'exit',
      confidence: 'high',
      timedOut: false,
    })
    // The tool description promises no output; the reply must not carry any.
    expect(data).not.toHaveProperty('output')
  })

  it('clamps the wait_for_done ceiling here, since the backend does not', async () => {
    const { bridge } = bridgeWithFinishedWorker()
    const data = expectOk(
      await routeControlRequest(
        makeRequest('wait_for_done', { terminalId: 'term-done', timeoutMs: 999_999 }, LEAD),
        bridge,
      ),
    )
    expect(data.timeoutMs).toBe(120_000)
    expect(String(data.message)).toContain('clamped')
  })

  it('routes list_agents and keeps installation apart from orchestration', async () => {
    const { bridge } = makeBridge()
    const data = expectOk(await routeControlRequest(makeRequest('list_agents', {}, LEAD), bridge))
    const agents = data.agents as { agent: string; installed: boolean; canOrchestrate: boolean }[]
    expect(agents.find((item) => item.agent === 'claude')).toMatchObject({
      installed: true,
      canOrchestrate: true,
    })
    expect(agents.find((item) => item.agent === 'codex')).toMatchObject({
      installed: false,
      canOrchestrate: true,
    })
  })

  it('denies the whole tier to a token without the orchestrator capabilities', async () => {
    const { bridge, createdAgents, killed, prompts } = makeBridge()
    for (const [request, capability] of [
      [makeRequest('spawn_agent', { agent: 'codex', task: 'x' }), 'agent.spawn'],
      [makeRequest('send_prompt', { terminalId: 'term-web', text: 'x' }), 'agent.prompt'],
      [makeRequest('kill_terminal', { terminalId: 'term-web' }), 'agent.kill'],
      [makeRequest('list_agents'), 'agent.spawn'],
      [makeRequest('wait_for_done', { terminalId: 'term-web' }), 'agent.spawn'],
    ] as const) {
      const error = expectError(await routeControlRequest(request, bridge))
      expect(error.denial).toEqual({ kind: 'missing-capability', capability })
    }
    expect(createdAgents).toHaveLength(0)
    expect(prompts).toHaveLength(0)
    expect(killed).toHaveLength(0)
  })

  it('keeps the tier inside the caller scope', async () => {
    const { bridge, killed, prompts } = makeBridge()
    for (const request of [
      makeRequest('send_prompt', { terminalId: 'term-stranger', text: 'x' }, LEAD),
      makeRequest('kill_terminal', { terminalId: 'term-stranger' }, LEAD),
    ]) {
      const error = expectError(await routeControlRequest(request, bridge))
      expect(error.denial).toEqual({ kind: 'out-of-scope', targetProjectId: 'proj-other' })
    }
    expect(prompts).toHaveLength(0)
    expect(killed).toHaveLength(0)
  })

  it('turns a thrown error into an error reply', async () => {
    const { bridge } = makeBridge()
    bridge.ops.workspaceTerminals = () => {
      throw new Error('store exploded')
    }
    const error = expectError(await routeControlRequest(makeRequest('list_terminals'), bridge))
    expect(error.code).toBe('error')
    expect(error.message).toContain('store exploded')
  })

  it('turns a rejected async op into an error reply', async () => {
    const { bridge } = makeBridge()
    bridge.ops.spawnQueue.acquire = () => Promise.reject(new Error('queue exploded'))
    const error = expectError(
      await routeControlRequest(makeRequest('run_shell', { command: 'ls' }), bridge),
    )
    expect(error.code).toBe('error')
    expect(error.message).toContain('queue exploded')
  })

  it('reports an io failure of the scrollback without throwing', async () => {
    const { bridge } = makeBridge({ scrollbackError: new Error('pty gone') })
    const error = expectError(
      await routeControlRequest(makeRequest('read_output', { terminalId: 'term-lead' }), bridge),
    )
    expect(error.code).toBe('io')
  })
})

describe('startControlBridge', () => {
  function makeTransport() {
    const replies: { requestId: string; reply: ControlReply }[] = []
    let deliver: ((request: ControlRequest) => void) | null = null
    const unlisten = vi.fn()
    const transport: ControlBridgeTransport = {
      listen: async (handler) => {
        deliver = handler
        return unlisten
      },
      reply: async (requestId, reply) => {
        replies.push({ requestId, reply })
      },
    }
    return {
      transport,
      replies,
      unlisten,
      emit: (request: ControlRequest) => {
        if (!deliver) throw new Error('bridge is not listening')
        deliver(request)
      },
    }
  }

  /** Lets the listener's detached async work settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('answers every request it receives, exactly once', async () => {
    const { bridge } = makeBridge()
    const harness = makeTransport()
    await startControlBridge(bridge, harness.transport)

    harness.emit(makeRequest('list_terminals'))
    harness.emit({ ...makeRequest('terminal_status', { terminalId: 'term-web' }), requestId: 'ctl-2' })
    await settle()

    expect(harness.replies.map((item) => item.requestId)).toEqual(['ctl-list_terminals', 'ctl-2'])
    expect(harness.replies.every((item) => item.reply.ok)).toBe(true)
  })

  it('answers with an error rather than leaving the caller parked', async () => {
    const { bridge } = makeBridge()
    const harness = makeTransport()
    await startControlBridge(bridge, harness.transport)

    harness.emit(makeRequest('not_a_real_op'))
    await settle()

    expect(harness.replies).toHaveLength(1)
    expect(expectError(harness.replies[0].reply).code).toBe('unknown-op')
  })

  it('survives a failed reply delivery', async () => {
    const { bridge } = makeBridge()
    const harness = makeTransport()
    harness.transport.reply = () => Promise.reject(new Error('ipc down'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await startControlBridge(bridge, harness.transport)

    harness.emit(makeRequest('list_terminals'))
    await settle()

    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })

  it('hands back the listener teardown', async () => {
    const { bridge } = makeBridge()
    const harness = makeTransport()
    const stop = await startControlBridge(bridge, harness.transport)
    stop()
    expect(harness.unlisten).toHaveBeenCalledTimes(1)
  })
})

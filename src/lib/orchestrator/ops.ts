/**
 * Control-plane operations available to EVERY agent terminal: look at the
 * workspace, read what a terminal printed, and open a real shell in it.
 *
 * Two rules shape this module:
 *
 * 1. All IO is injected. Nothing here imports the Tauri bridge or a store, so
 *    the whole layer runs under plain Node with a controlled clock. The live
 *    wiring lives in `./deps.ts`.
 * 2. The frontend is the authority. The backend reads `projects.json` from disk
 *    with a debounced write, so a terminal created two seconds ago does not
 *    exist for it yet — scope and existence are decided here, against the
 *    Zustand state, not there.
 */

import { execArgsFor, tailSummary } from '../agentExec'
import { PROMPT_SUBMIT_KEY } from '../promptDelivery'
import { maxMemoryBudgetMb, RECOVERY_TARGET_RATIO } from '../resourcePolicy'
import {
  ALL_AGENT_TYPES,
  UNRESTRICTED_FLAG,
  type AgentType,
  type OrchestratorApprovalAction,
  type PtyStatus,
} from '../types'
import type { OrchestratorJobSink } from '../../stores/orchestratorStore'
import { supportsOrchestrator } from './launch'
import {
  denyReason,
  isInScope,
  type ControlContext,
  type DenialReason,
  type GroupResolver,
} from './scope'

/** Silence this long after creation and the shell is declared dead on arrival. */
export const SHELL_START_TIMEOUT_MS = 15_000
/** How often the watchdog re-checks for a sign of life. */
export const SHELL_WATCHDOG_POLL_MS = 1_000
/** How often a queued request re-checks whether the spawn queue relaxed. */
export const QUEUE_RECHECK_MS = 1_500
/** A queued request that never gets its turn fails instead of waiting forever. */
export const QUEUE_MAX_WAIT_MS = 120_000
/** How long the admission handshake waits for a spawn slot before giving up. */
export const ADMISSION_TIMEOUT_MS = 250

export const DEFAULT_OUTPUT_TAIL = 2_000
export const MAX_OUTPUT_TAIL = 20_000
export const MAX_COMMAND_LENGTH = 4_000
/** Cap on the task handed to a spawned agent. */
export const MAX_TASK_LENGTH = 8_000
/** Cap on a prompt injected into an existing terminal. */
export const MAX_PROMPT_LENGTH = 20_000
/**
 * Deadline on a single provider probe in `listAgents`. The bridge gives a read
 * operation ten seconds in total, so a provider that hangs must cost its own
 * field and nothing else.
 */
export const PROVIDER_PROBE_TIMEOUT_MS = 4_000

/**
 * A request parked in front of a person refuses itself after this long.
 *
 * The number is bound to `ACTION_TIMEOUT` in `src-tauri/src/control_bridge.rs`:
 * that side blocks one thread per request for 150s waiting for this answer, so
 * the refusal has to be produced early enough to still travel back. 120s leaves
 * 30s of margin for the reply to cross the bridge. The two numbers move
 * together — raise this to 150s and a human refusal would reach the model as the
 * bridge's own `timeout` code instead, which it cannot tell apart from a wedged
 * UI, and lowering the Rust side below this would cut off answers people did
 * give.
 */
export const APPROVAL_TIMEOUT_MS = 120_000

/** Room reserved on top of current use for the shell that was just asked for. */
export const SHELL_HEADROOM_MB = 256
/** Budget suggestions are rounded up to a multiple of this, so they read as a decision. */
export const BUDGET_STEP_MB = 512

/* ---------------------------------------------------------------------------
 * Injected IO
 * ------------------------------------------------------------------------- */

/**
 * A terminal as the frontend store knows it right now. The adapter is expected
 * to hand over only real terminals — file/diff/web viewer panes have no process
 * and no agent, and read-only GSD Sync viewers are not addressable.
 */
export type ControlTerminalView = {
  id: string
  name: string
  projectId: string
  /** Agent of the active sub-tab; `shell` for a plain shell. */
  agent: AgentType
  cwd: string
  disabled: boolean
  /** PTY id of the active sub-tab, or the id it will be spawned under. */
  ptyId: string | null
  /** True while a PTY is registered for this terminal and has not exited. */
  alive: boolean
  /**
   * Last thing the activity tracker said about this PTY, or null when no
   * process has ever been registered under `ptyId` — which is what separates a
   * terminal that has not booted yet from one that already exited.
   *
   * `working` is the only value that means "producing". The tracker sets it
   * from OpenCode's own bridge signal and from a silence heuristic over the PTY
   * output, and the store keeps no record of which of the two spoke, so nothing
   * downstream may claim to know either.
   */
  ptyStatus: PtyStatus | null
}

/**
 * One sub-tab of a pane. A shell an agent opens for itself lives here rather
 * than in a pane of its own, so its id has to be addressable on its own: after
 * the pane goes back to showing the agent, reading the *pane* would return the
 * agent's own conversation instead of the shell.
 */
export type ControlSubTabView = ControlTerminalView & {
  /** Pane this sub-tab belongs to. */
  terminalId: string
  /** True while this is the sub-tab the pane renders. */
  active: boolean
  /** True while an initial input is still waiting to be typed into the PTY. */
  pendingInput: boolean
}

export type SpawnQueueSnapshotView = {
  active: number
  queued: number
  pressureBlocked: boolean
  pressureReason: string | null
}

export type SpawnQueueGate = {
  snapshot: () => SpawnQueueSnapshotView
  acquire: (signal?: AbortSignal) => Promise<boolean>
  release: () => void
}

/**
 * Live numbers behind the memory ceiling, plus the settings labels in the
 * user's own language. The labels are injected instead of translated here so
 * this module stays free of stores, and so the path an agent recites matches
 * what the person actually sees on screen.
 */
export type MemoryCeilingView = {
  /** Effective consumption right now, or null when it could not be read. */
  usedMb: number | null
  /** Hard budget currently configured. */
  budgetMb: number
  /** Physical RAM of the machine, or null when it could not be read. */
  systemTotalMb: number | null
  /** Preferences window, localized. */
  settingsLabel: string
  /** Preferences category holding the budget field, localized. */
  categoryLabel: string
  /** The budget field itself, localized. */
  budgetFieldLabel: string
  /**
   * The live-agent ceiling field, localized. It sits in the same category as
   * the budget because it exists for the same reason: agents cost RAM.
   */
  liveAgentsFieldLabel: string
}

/**
 * A new agent pane. Note what is missing: no env, no launcher, no free-form
 * argv. `extraArgs` is built here from `execArgsFor`, never from the caller —
 * a control-plane client names the agent, it never shapes the command line.
 */
export type CreateAgentInput = {
  projectId: string
  name: string
  cwd: string
  agent: AgentType
  /** One-shot argv for the CLI, when the agent has a one-shot form. */
  extraArgs?: string[]
  /** Typed into the PTY once it settles. Interactive mode delivers the task here. */
  initialInput?: string
}

export type PromptDeliveryRequest = {
  ptyId: string
  text: string
  /** Wrap the block in bracketed paste. False for a plain shell, which has none. */
  bracketed: boolean
}

/**
 * One usage window of a provider. Deliberately has no field for a plan name:
 * Alethe reads windows and limits, never which subscription pays for them, and
 * a shape with nowhere to put a plan name cannot leak one by accident.
 */
export type AgentUsageWindow = {
  /** The provider's own window, e.g. `5h`, `7d`, `weekly`. */
  window: string
  usedPercent: number
  /** ISO-8601 instant, or null when the provider does not say. */
  resetsAt: string | null
}

export type AgentUsageReport = {
  windows: AgentUsageWindow[]
  rateLimited: boolean
}

export type AgentCatalogEntry = {
  agent: AgentType
  /** Whether the CLI resolves on this machine. */
  installed: boolean
  /** Whether it can drive this control plane, not merely be started by it. */
  canOrchestrate: boolean
  /** Null when the provider exposes nothing, or did not answer in time. */
  usage: AgentUsageReport | null
}

export type CreateShellInput = {
  projectId: string
  name: string
  cwd: string
  command: string
}

export type CreateShellSubTabInput = CreateShellInput & {
  /** Pane that asked for the shell; the sub-tab is added to it. */
  terminalId: string
}

export type ShellSubTabHandle = {
  terminalId: string
  tabId: string
  /** Sub-tab that was in front before, to hand the pane back to. */
  previousTabId: string | null
}

/**
 * What a person is being asked to allow. Carries the literal payload rather
 * than a summary of it: the whole command, the whole task, the whole prompt.
 * Shortening the one thing the decision is about turns a confirmation into
 * theatre, so the trimming — if any — is the UI's problem, not this layer's.
 */
export type ApprovalRequest = {
  action: OrchestratorApprovalAction
  /** Terminal whose control token asked for this. */
  requesterTerminalId: string
  projectId: string
  /** Terminal the action acts upon, when it names one. */
  targetTerminalId?: string
  /** Agent that would be started. Only set for `agent.spawn`. */
  agent?: AgentType
  payload: string
}

/**
 * How a write reaches a person before it happens.
 *
 * Both predicates are read on EVERY request instead of captured once: the
 * global preference is a live setting the person can flip mid-session, and a
 * session grant is usually made from inside the very dialog this gate opened.
 */
export type ApprovalGate = {
  /** Persisted per-action auto-approval, from `Preferences`. */
  autoApproved: (action: OrchestratorApprovalAction) => boolean
  /** Session-only "always allow this action for this terminal". */
  sessionApproved: (terminalId: string, action: OrchestratorApprovalAction) => boolean
  /**
   * Parks the request in front of the person; resolves true when they allow it.
   * `signal` aborts once the deadline expires, so the UI drops a card nobody is
   * waiting on anymore instead of leaving a dead decision on screen.
   */
  ask: (request: ApprovalRequest, signal: AbortSignal) => Promise<boolean>
}

export type OrchestratorDeps = {
  /** Every addressable terminal in the workspace, unfiltered by scope. */
  workspaceTerminals: () => ControlTerminalView[]
  /** Every sub-tab of those terminals, unfiltered by scope. */
  workspaceSubTabs: () => ControlSubTabView[]
  resolveGroup: GroupResolver
  /**
   * Adds a shell sub-tab to an existing pane and brings it to the front. Null
   * when that pane is gone or has no sub-tab lane (viewer panes), which is what
   * makes the caller fall back to a pane of its own.
   */
  createShellSubTab: (input: CreateShellSubTabInput) => ShellSubTabHandle | null
  /**
   * Creates a real, visible shell in a pane of its own. The command must be
   * delivered as the first tab's `initialInput` — never as `extraArgs` of
   * `spawn_pty`.
   */
  createShell: (input: CreateShellInput) => { terminalId: string }
  /**
   * Creates an agent in a pane of its own, provisioning a worktree when the
   * project asks for one. Async for exactly that reason.
   *
   * A pane rather than a sub-tab is the point: a shell is accessory work of the
   * agent that asked for it, but another LLM is a participant in the workspace
   * and belongs side by side with the rest, visible.
   */
  createAgentTerminal: (input: CreateAgentInput) => Promise<{ terminalId: string }>
  /** Ends the process tree of a pane, keeping the pane and its worktree. */
  killTerminal: (projectId: string, terminalId: string) => void
  /**
   * Types a block into a live PTY, waiting for the CLI to settle first.
   * Resolves false when nothing went out.
   */
  deliverPrompt: (input: PromptDeliveryRequest) => Promise<boolean>
  /**
   * Feeds an injected prompt to the completion monitor of a terminal, which
   * otherwise only ever sees what a human typed.
   */
  recordAgentInput: (ptyId: string, data: string) => void
  /** Current ceiling on live agent processes. Read only; never written here. */
  maxLiveAgents: () => number
  /** Best-effort provider probes for `listAgents`. Either one may hang or reject. */
  agentProbe: {
    isInstalled: (agent: AgentType) => Promise<boolean>
    usage: (agent: AgentType) => Promise<AgentUsageReport | null>
  }
  /** Brings a sub-tab of an existing pane to the front. */
  activateSubTab: (projectId: string, terminalId: string, tabId: string) => void
  /**
   * Applies the workspace focus sequence. Not cosmetic: only the active sub-tab
   * of a rendered pane mounts `XTermView`, and only `XTermView` starts a PTY.
   */
  focusTerminal: (projectId: string, terminalId: string) => void
  readScrollback: (ptyId: string) => Promise<string>
  spawnQueue: SpawnQueueGate
  /** Read only to explain a queued request; this layer never writes settings. */
  memoryCeiling: () => MemoryCeilingView
  /** Human confirmation for the four write operations. Reads never touch it. */
  approvals: ApprovalGate
  jobs: OrchestratorJobSink
  now: () => number
  /** Injected so watchdog and queue polling are testable without real timers. */
  schedule: (run: () => void, ms: number) => void
}

/* ---------------------------------------------------------------------------
 * Results
 * ------------------------------------------------------------------------- */

/**
 * `denied` and `refused` are deliberately different words for different things.
 * `denied` is the token: a capability it does not hold, or a target outside its
 * scope — retrying never fixes it. `refused` is a person: the request was
 * legitimate, it was shown to them, and they said no (or said nothing until it
 * expired). One is about what the caller may do, the other about what someone
 * wanted right now, and a model that cannot tell them apart either gives up on
 * work it is allowed to do or hammers a request a human is actively declining.
 */
export type ControlErrorCode = 'denied' | 'not-found' | 'invalid' | 'io' | 'refused'

export type ControlFailure = {
  ok: false
  code: ControlErrorCode
  error: string
  denial?: DenialReason
}

export type ControlResult<T> = ({ ok: true } & T) | ControlFailure

export type ControlTerminalStatus = 'running' | 'idle' | 'disabled'

export type ControlTerminalSummary = {
  id: string
  name: string
  agent: AgentType
  cwd: string
  projectId: string
  status: ControlTerminalStatus
  alive: boolean
}

export type OpenShellInput = {
  command: string
  cwd?: string
  name?: string
}

/** Shared shape of an accepted request that is waiting behind the spawn queue. */
export type QueuedOutcome = {
  state: 'queued'
  jobId: string
  queuePosition: number
  message: string
}

export type OpenShellOutcome =
  | { state: 'starting'; jobId: string; terminalId: string; message: string }
  | QueuedOutcome

export function denialMessage(reason: DenialReason): string {
  return reason.kind === 'missing-capability'
    ? `This terminal does not hold the "${reason.capability}" capability.`
    : `Target is outside this terminal's scope (project ${reason.targetProjectId}). ` +
        'A terminal only reaches its own project, or a sibling project in the same group.'
}

function denied(reason: DenialReason): ControlFailure {
  return { ok: false, code: 'denied', error: denialMessage(reason), denial: reason }
}

function notFound(terminalId: string): ControlFailure {
  return {
    ok: false,
    code: 'not-found',
    error: `No terminal ${terminalId} in this workspace.`,
  }
}

function invalid(error: string): ControlFailure {
  return { ok: false, code: 'invalid', error }
}

/* ---------------------------------------------------------------------------
 * Human approval
 *
 * Reads run straight through — listing terminals or tailing a scrollback costs
 * nothing and undoes nothing. The four operations that change the machine go in
 * front of the person first, unless they have already said otherwise for this
 * action, either for the session or for good.
 * ------------------------------------------------------------------------- */

/** Answer to a parked request. */
type ApprovalOutcome = 'approved' | 'refused' | 'expired'

/** How each action reads in a refusal message, in the caller's own terms. */
const APPROVAL_SUBJECTS: Record<OrchestratorApprovalAction, string> = {
  'shell.run': 'shell command',
  'agent.spawn': 'agent spawn',
  'agent.prompt': 'prompt delivery',
  'agent.kill': 'request to stop a terminal',
}

/**
 * Runs the request past the person, or past the standing permissions they left
 * behind. Never rejects and never hangs past `APPROVAL_TIMEOUT_MS`: on the far
 * side of this call is a blocked backend thread.
 */
async function requestApproval(
  request: ApprovalRequest,
  deps: OrchestratorDeps,
): Promise<ApprovalOutcome> {
  // Read in this order, and read them now rather than from anything captured
  // earlier: the persisted preference is the documented way to run an automated
  // suite without a human in the loop, and it has to take effect on the very
  // next request after it is flipped.
  if (deps.approvals.autoApproved(request.action)) return 'approved'
  if (deps.approvals.sessionApproved(request.requesterTerminalId, request.action)) return 'approved'

  const controller = new AbortController()
  const answer = await Promise.race([
    deps.approvals
      .ask(request, controller.signal)
      .then((approved): ApprovalOutcome => (approved ? 'approved' : 'refused'))
      // A gate that throws is a UI that cannot ask. That is not consent.
      .catch((): ApprovalOutcome => 'refused'),
    new Promise<ApprovalOutcome>((resolve) => {
      deps.schedule(() => resolve('expired'), APPROVAL_TIMEOUT_MS)
    }),
  ])
  // The deadline is owned here, not by the gate: `Promise.race` guarantees an
  // answer even if the UI never settles its side, and the abort is what tells
  // that UI to stop showing a decision nobody is waiting for anymore.
  controller.abort()
  return answer
}

function refusedByHuman(action: OrchestratorApprovalAction, outcome: ApprovalOutcome): ControlFailure {
  const subject = APPROVAL_SUBJECTS[action]
  const error =
    outcome === 'expired'
      ? `Nobody answered this ${subject} within ${Math.round(APPROVAL_TIMEOUT_MS / 1000)}s, so Alethe ` +
        'refused it on the person\'s behalf. The request was shown to them and expired unanswered — ' +
        'they are probably away from the machine. This is NOT a missing permission and NOT a bug: ' +
        'your token and scope were both fine. Say plainly that the confirmation went unanswered ' +
        'instead of quietly trying again.'
      : `A person refused this ${subject} in Alethe. You were allowed to ask — the capability and the ` +
        'scope were both fine — and a human looked at exactly what you sent and said no. This is a ' +
        'decision about this moment, not a limit on what you may do, so do NOT retry the same ' +
        'request: tell them it was refused and ask what they want instead.'
  return { ok: false, code: 'refused', error }
}

/**
 * Resolves anything an agent can address by id. Panes win; a shell opened
 * inline is a sub-tab of the pane that asked for it, so its own id has to
 * resolve too — that is the id `openShell` hands back.
 */
function resolveTarget(id: string, deps: OrchestratorDeps): ControlTerminalView | null {
  return (
    deps.workspaceTerminals().find((item) => item.id === id) ??
    deps.workspaceSubTabs().find((item) => item.id === id) ??
    null
  )
}

function summarize(view: ControlTerminalView): ControlTerminalSummary {
  return {
    id: view.id,
    name: view.name,
    agent: view.agent,
    cwd: view.cwd,
    projectId: view.projectId,
    // `idle` covers both "never spawned" and "process already exited": from the
    // caller's side both mean the same thing — nothing is running there.
    status: view.disabled ? 'disabled' : view.alive ? 'running' : 'idle',
    alive: view.alive,
  }
}

/* ---------------------------------------------------------------------------
 * Read operations
 * ------------------------------------------------------------------------- */

export function listTerminals(
  ctx: ControlContext,
  deps: OrchestratorDeps,
): ControlResult<{ terminals: ControlTerminalSummary[] }> {
  const denial = denyReason(ctx, 'terminal.list', null, deps.resolveGroup)
  if (denial) return denied(denial)
  const terminals = deps
    .workspaceTerminals()
    .filter((view) =>
      isInScope(ctx, { terminalId: view.id, projectId: view.projectId }, deps.resolveGroup),
    )
    .map(summarize)
  return { ok: true, terminals }
}

export function terminalStatus(
  ctx: ControlContext,
  terminalId: string,
  deps: OrchestratorDeps,
): ControlResult<{ terminal: ControlTerminalSummary }> {
  const view = resolveTarget(terminalId, deps)
  if (!view) return notFound(terminalId)
  const denial = denyReason(
    ctx,
    'terminal.read',
    { terminalId, projectId: view.projectId },
    deps.resolveGroup,
  )
  if (denial) return denied(denial)
  return { ok: true, terminal: summarize(view) }
}

/**
 * Tail of a terminal's scrollback with terminal control sequences stripped.
 * A leading `…` in `output` means the tail was cut — that is what `truncated`
 * reports, since `tailSummary` marks the cut that way and nothing else does.
 */
export async function readOutput(
  ctx: ControlContext,
  terminalId: string,
  tail: number | undefined,
  deps: OrchestratorDeps,
): Promise<ControlResult<{ terminalId: string; output: string; truncated: boolean }>> {
  const view = resolveTarget(terminalId, deps)
  if (!view) return notFound(terminalId)
  const denial = denyReason(
    ctx,
    'terminal.read',
    { terminalId, projectId: view.projectId },
    deps.resolveGroup,
  )
  if (denial) return denied(denial)

  if (!view.ptyId) {
    return { ok: true, terminalId, output: '', truncated: false }
  }

  const max = clampTail(tail)
  try {
    const raw = await deps.readScrollback(view.ptyId)
    const output = tailSummary(raw ?? '', max)
    return { ok: true, terminalId, output, truncated: output.startsWith('…') }
  } catch (error) {
    return {
      ok: false,
      code: 'io',
      error: `Could not read the scrollback of ${terminalId}: ${String(error)}`,
    }
  }
}

function clampTail(tail: number | undefined): number {
  if (typeof tail !== 'number' || !Number.isFinite(tail)) return DEFAULT_OUTPUT_TAIL
  return Math.min(MAX_OUTPUT_TAIL, Math.max(1, Math.floor(tail)))
}

/* ---------------------------------------------------------------------------
 * openShell
 * ------------------------------------------------------------------------- */

type ShellPlan = { command: string; cwd: string; name: string }

/** Where a created terminal landed, and how to give the pane back afterwards. */
type StartTarget = {
  /** Pane that hosts it — the thing that has to render for a PTY to boot. */
  paneId: string
  /** Id the agent addresses to read this terminal back. */
  targetId: string
  /** True when it shares the requester's pane as one more sub-tab. */
  inline: boolean
  /** Sub-tab to hand the pane back to; null when there is nothing to give back. */
  restoreTabId: string | null
}

/**
 * Opens a real, visible shell and types the command into it.
 *
 * A shell an agent opens is accessory work of *that* agent, so it goes into the
 * requester's own pane as one more sub-tab, next to the conversation — not into
 * a pane of its own, which is reserved for sibling agents. Creating the sub-tab
 * brings it to the front (nothing else boots a PTY), and the pane goes back to
 * the conversation as soon as the command has been typed in; the shell keeps
 * running behind it, because the backend owns the process and only the drawing
 * is dropped.
 *
 * Never reports success: a created terminal is not a running process. The PTY
 * only boots when the pane renders and its sub-tab is active, so the result is
 * `starting` plus a job id, and a watchdog flips that job to `running` on the
 * first sign of life or to `failed`/`failed_to_start` after
 * `SHELL_START_TIMEOUT_MS` of silence.
 */
export async function openShell(
  ctx: ControlContext,
  input: OpenShellInput,
  deps: OrchestratorDeps,
): Promise<ControlResult<OpenShellOutcome>> {
  const denial = denyReason(
    ctx,
    'shell.run',
    { terminalId: ctx.terminalId, projectId: ctx.projectId },
    deps.resolveGroup,
  )
  if (denial) return denied(denial)

  const command = (input.command ?? '').trim()
  const invalid = validateCommand(command)
  if (invalid) return { ok: false, code: 'invalid', error: invalid }

  const requester = deps.workspaceTerminals().find((item) => item.id === ctx.terminalId)
  const plan: ShellPlan = {
    command,
    // Empty is fine: the store falls back to the project's own default folder.
    cwd: (input.cwd ?? '').trim() || requester?.cwd || '',
    name: shellName(input.name, command),
  }

  // Asked before the job exists: a job is a promise that something is being
  // worked on, and a request waiting on a person is not that yet.
  const approval = await requestApproval(
    {
      action: 'shell.run',
      requesterTerminalId: ctx.terminalId,
      projectId: ctx.projectId,
      payload: plan.command,
    },
    deps,
  )
  if (approval !== 'approved') return refusedByHuman('shell.run', approval)

  const job = deps.jobs.create({
    kind: 'shell',
    requesterTerminalId: ctx.terminalId,
    state: 'pending',
    label: command.slice(0, 120),
  })

  const pressure = deps.spawnQueue.snapshot()
  const start = () => {
    startShell(job.jobId, plan, ctx, deps)
  }
  if (isUnderPressure(pressure)) return enterQueue(job.jobId, deps, pressure, start)

  // Admission only. The slot is released before anything is created, because
  // `XTermView` takes its own slot when it actually spawns the PTY — holding
  // this one across creation would deadlock that spawn against itself.
  if (!(await admit(deps))) {
    return enterQueue(job.jobId, deps, deps.spawnQueue.snapshot(), start)
  }

  return startShell(job.jobId, plan, ctx, deps)
}

function startShell(
  jobId: string,
  plan: ShellPlan,
  ctx: ControlContext,
  deps: OrchestratorDeps,
): { ok: true } & OpenShellOutcome {
  const target = placeShell(plan, ctx, deps)
  // Focus is what makes the pane render, which is what starts the process.
  deps.focusTerminal(ctx.projectId, target.paneId)
  deps.jobs.patch(jobId, { state: 'starting', targetTerminalId: target.targetId })
  watchStart(jobId, target, ctx, deps, deps.now() + SHELL_START_TIMEOUT_MS)
  const placement = target.inline
    ? `Shell ${target.targetId} was opened as a sub-tab of your own terminal and is in front now; ` +
      'Alethe hands the pane back to this conversation once the command has been typed in, and the ' +
      'shell keeps running there. '
    : `Shell terminal ${target.targetId} was created in a pane of its own and focused. `
  return {
    ok: true,
    state: 'starting',
    jobId,
    terminalId: target.targetId,
    message:
      `${placement}${startedNotRunning(jobId)} ` +
      `Read what it prints with alethe_read_output on ${target.targetId}. ` +
      'Do not send this request again — check the job state instead.',
  }
}

/**
 * The one sentence every creation answer has to carry. Created is not running:
 * the PTY only boots once the pane renders, so the honest answer is a job plus
 * how that job resolves.
 */
function startedNotRunning(jobId: string): string {
  return (
    `Created is not running: job ${jobId} is "starting" and turns "running" on the first sign of ` +
    `life from the PTY, or "failed" (failed_to_start) after ` +
    `${Math.round(SHELL_START_TIMEOUT_MS / 1000)}s of silence.`
  )
}

/**
 * Puts the shell where it belongs: inside the pane that asked for it. Falls
 * back to a pane of its own when that pane is gone (a token outlives its
 * terminal) or cannot host sub-tabs — a shell somewhere beats a failed request.
 */
function placeShell(plan: ShellPlan, ctx: ControlContext, deps: OrchestratorDeps): StartTarget {
  const inline = deps.createShellSubTab({
    projectId: ctx.projectId,
    terminalId: ctx.terminalId,
    name: plan.name,
    cwd: plan.cwd,
    command: plan.command,
  })
  if (inline) {
    return {
      paneId: inline.terminalId,
      targetId: inline.tabId,
      inline: true,
      restoreTabId: inline.previousTabId,
    }
  }
  const created = deps.createShell({
    projectId: ctx.projectId,
    name: plan.name,
    cwd: plan.cwd,
    command: plan.command,
  })
  return {
    paneId: created.terminalId,
    targetId: created.terminalId,
    inline: false,
    restoreTabId: null,
  }
}

/**
 * Parks an already accepted request behind the spawn queue. `start` is whatever
 * actually creates the thing — a shell or an agent — so both paths share one
 * queue, one timeout and one message.
 */
function enterQueue(
  jobId: string,
  deps: OrchestratorDeps,
  pressure: SpawnQueueSnapshotView,
  start: () => void | Promise<void>,
): { ok: true } & QueuedOutcome {
  const queuePosition = pressure.queued + 1
  deps.jobs.patch(jobId, { state: 'queued', queuePosition })
  scheduleQueuedStart(jobId, deps, start, deps.now())
  const reason = pressure.pressureReason
  return {
    ok: true,
    state: 'queued',
    jobId,
    queuePosition,
    message:
      `The workspace is at its spawn/memory ceiling${reason ? ` (${reason})` : ''}, so this request ` +
      `is queued at position ${queuePosition}. It was ACCEPTED and starts on its own once a slot frees up. ` +
      `Do NOT send this request again — a repeated request stacks another process onto the queue. ` +
      `Check the state of job ${jobId} instead.` +
      (pressure.pressureBlocked ? memoryCeilingAdvice(deps.memoryCeiling()) : ''),
  }
}

/**
 * Explains the memory ceiling that parked the request, because it is a setting
 * and not a law: the factory budget can be too small to ever recover on a
 * machine where the app's own webview already eats a large share of it, and an
 * agent that cannot say so leaves the person stuck.
 */
function memoryCeilingAdvice(view: MemoryCeilingView): string {
  const used = view.usedMb === null ? 'unknown' : `${Math.round(view.usedMb)} MB`
  const suggestion = suggestedBudgetMb(view)
  const raise = suggestion === null ? '' : ` ${suggestion} MB would clear this request.`
  return (
    ` Memory now: ${used} in use against a ${Math.round(view.budgetMb)} MB hard budget. ` +
    `That budget is a setting the person can raise — ${view.settingsLabel} > "${view.categoryLabel}" > ` +
    `"${view.budgetFieldLabel}", click the field and press the up arrow.${raise} ` +
    'Tell them this; you cannot change it yourself.'
  )
}

/**
 * Budget that would actually unblock the request, or null when the numbers are
 * unknown or the current budget is already enough.
 *
 * It is not "current use + a bit": the supervisor is hysteretic and only leaves
 * the critical state below `RECOVERY_TARGET_RATIO` of the budget, so a budget
 * just above current use stays blocked. Capped by `maxMemoryBudgetMb`, the same
 * half-of-RAM ceiling the preferences field enforces — a suggestion the UI
 * would refuse is worse than none.
 */
export function suggestedBudgetMb(view: MemoryCeilingView): number | null {
  if (view.usedMb === null || view.systemTotalMb === null) return null
  const needed = (view.usedMb + SHELL_HEADROOM_MB) / RECOVERY_TARGET_RATIO
  const rounded = Math.ceil(needed / BUDGET_STEP_MB) * BUDGET_STEP_MB
  const suggestion = Math.min(rounded, maxMemoryBudgetMb(view.systemTotalMb))
  return suggestion > view.budgetMb ? suggestion : null
}

/**
 * Only a real pressure block means "no capacity". A waiter in the spawn queue
 * does not: `admit` already answers that question by trying to take a slot, and
 * reading `queued` instead made queued jobs feed on each other — every re-check
 * becomes a transient waiter, so two parked jobs each saw the other's attempt
 * and parked again, forever.
 */
function isUnderPressure(snapshot: SpawnQueueSnapshotView): boolean {
  return snapshot.pressureBlocked
}

/**
 * Takes a spawn slot only to prove there is capacity, then gives it straight
 * back. Bounded by `ADMISSION_TIMEOUT_MS` so a request never blocks the caller.
 */
async function admit(deps: OrchestratorDeps): Promise<boolean> {
  const controller = new AbortController()
  let settled = false
  deps.schedule(() => {
    if (!settled) controller.abort()
  }, ADMISSION_TIMEOUT_MS)
  const acquired = await deps.spawnQueue.acquire(controller.signal)
  settled = true
  if (acquired) deps.spawnQueue.release()
  return acquired
}

function scheduleQueuedStart(
  jobId: string,
  deps: OrchestratorDeps,
  start: () => void | Promise<void>,
  enqueuedAt: number,
): void {
  const tick = async () => {
    // Anything that moved the job out of `queued` (cancel, teardown) owns it now.
    if (deps.jobs.get(jobId)?.state !== 'queued') return
    const snapshot = deps.spawnQueue.snapshot()
    if (!isUnderPressure(snapshot) && (await admit(deps))) {
      if (deps.jobs.get(jobId)?.state !== 'queued') return
      await start()
      return
    }
    if (deps.now() - enqueuedAt >= QUEUE_MAX_WAIT_MS) {
      deps.jobs.patch(jobId, { state: 'failed', failure: 'queue_timeout' })
      return
    }
    deps.jobs.patch(jobId, { state: 'queued', queuePosition: snapshot.queued + 1 })
    deps.schedule(() => void tick(), QUEUE_RECHECK_MS)
  }
  deps.schedule(() => void tick(), QUEUE_RECHECK_MS)
}

/**
 * The whole reason a creation cannot answer "created": a terminal that lands
 * in a project nobody is looking at renders nothing and therefore spawns
 * nothing. The watchdog is what turns that silence into an answer.
 *
 * It also owns the second milestone of an inline shell: giving the pane back to
 * the conversation. Two milestones, not one, because they are not the same
 * instant — the PTY is alive long before the command reaches it, and switching
 * away in between unmounts `XTermView`, whose disposal aborts the pending
 * delivery and loses the command outright. An agent lands in a pane of its own,
 * so it has nothing to give back and only the first milestone applies.
 */
function watchStart(
  jobId: string,
  target: StartTarget,
  ctx: ControlContext,
  deps: OrchestratorDeps,
  deadline: number,
): void {
  let jobSettled = false
  let paneReturned = target.restoreTabId === null

  const tick = () => {
    const view = resolveTarget(target.targetId, deps)
    const expired = deps.now() >= deadline

    if (!jobSettled) {
      if (deps.jobs.get(jobId)?.state !== 'starting') {
        // Anything that moved the job (cancel, teardown) owns it now.
        jobSettled = true
      } else if (view?.alive) {
        deps.jobs.patch(jobId, { state: 'running' })
        jobSettled = true
      } else if (!view || expired) {
        // Terminal gone (closed or deleted before it ever booted) is a dead end too.
        deps.jobs.patch(jobId, { state: 'failed', failure: 'failed_to_start' })
        jobSettled = true
      }
    }

    if (!paneReturned) {
      const shell = deps.workspaceSubTabs().find((item) => item.id === target.targetId)
      // On the deadline the pane goes back regardless: a shell that never took
      // its command is not worth keeping in front of the conversation.
      if (!shell || expired || (shell.alive && !shell.pendingInput)) {
        returnPane(target, ctx, deps)
        paneReturned = true
      }
    }

    if (!jobSettled || !paneReturned) deps.schedule(tick, SHELL_WATCHDOG_POLL_MS)
  }
  deps.schedule(tick, SHELL_WATCHDOG_POLL_MS)
}

/**
 * Hands the pane back to whatever it was showing before the shell. The PTY
 * survives untouched — the backend owns the process, an unmounted `XTermView`
 * only stops drawing it — and `alethe_read_output` keeps working on the shell's
 * own id, which reads the scrollback from disk rather than from the screen.
 */
function returnPane(target: StartTarget, ctx: ControlContext, deps: OrchestratorDeps): void {
  if (!target.restoreTabId) return
  const tabs = deps.workspaceSubTabs()
  // Only take the pane from the shell itself: if the person moved to another
  // sub-tab meanwhile, yanking them away would be worse than doing nothing.
  if (!tabs.find((item) => item.id === target.targetId)?.active) return
  const restorable = tabs.some(
    (item) => item.id === target.restoreTabId && item.terminalId === target.paneId,
  )
  if (!restorable) return
  deps.activateSubTab(ctx.projectId, target.paneId, target.restoreTabId)
}

function validateCommand(command: string): string | null {
  if (!command) return 'command is empty.'
  if (command.length > MAX_COMMAND_LENGTH) {
    return `command is longer than ${MAX_COMMAND_LENGTH} characters.`
  }
  // The command is typed into a live PTY, so a newline would submit more than
  // the single command that was described, and other control bytes are how an
  // escape sequence gets smuggled into the terminal.
  if (/[\r\n]/.test(command)) return 'command must be a single line.'
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(command)) {
    return 'command contains control characters.'
  }
  return null
}

/** Falls back to the executable name, which reads better in a tab than a URL-long line. */
function shellName(name: string | undefined, command: string): string {
  const explicit = (name ?? '').trim()
  if (explicit) return explicit.slice(0, 40)
  const head = command.split(/\s+/)[0] ?? 'shell'
  return head.slice(0, 24) || 'shell'
}

/* ---------------------------------------------------------------------------
 * spawnAgent
 * ------------------------------------------------------------------------- */

/**
 * `oneshot` runs the task from the command line and exits; `interactive` keeps
 * the CLI open and types the task into it.
 */
export type SpawnAgentMode = 'oneshot' | 'interactive'

export type SpawnAgentInput = {
  agent: string
  task: string
  cwd?: string
  mode?: string
  name?: string
}

export type SpawnAgentOutcome =
  | {
      state: 'starting'
      jobId: string
      terminalId: string
      agent: AgentType
      mode: SpawnAgentMode
      message: string
    }
  | QueuedOutcome

type AgentPlan = {
  agent: AgentType
  task: string
  cwd: string
  name: string
  mode: SpawnAgentMode
  /** Set for one-shot; the task rides in argv. */
  extraArgs?: string[]
  /** Set for interactive; the task is typed in after the CLI settles. */
  initialInput?: string
  /**
   * True when one-shot was asked for but this agent has no one-shot form, so
   * the task had to be delivered interactively. Said out loud in the answer:
   * the caller was promised an exit signal it is not going to get.
   */
  degraded: boolean
  /**
   * True when interactive was asked for but the task spans lines, so argv was
   * used instead. Said out loud too: the caller gets a different mode than the
   * one it named, and an exit signal it did not ask for.
   */
  forcedOneShot: boolean
  /** True when a multi-line task had to be flattened to be typed into a TUI. */
  flattened: boolean
}

/**
 * Starts another agent in a pane of its own and hands it a task.
 *
 * Three things are load-bearing here:
 *
 * 1. **A pane, not a sub-tab.** A shell is accessory work of the agent that
 *    asked for it and belongs beside its conversation; another LLM is a
 *    participant in the workspace and gets a pane you can watch.
 * 2. **One-shot by default.** With `execArgsFor` the CLI runs the task and
 *    exits, so `pty://exit` becomes an unambiguous completion signal — including
 *    for agents that report no telemetry of their own. Interactive is opt-in,
 *    and is overruled for a task that spans lines: argv carries it verbatim,
 *    typing it into a TUI does not.
 * 3. **No recursion by construction.** The created terminal is born without the
 *    orchestrator flag, so its token never carries `agent.spawn`. There is no
 *    depth counter to get wrong; there is simply nothing to spawn with.
 */
export async function spawnAgent(
  ctx: ControlContext,
  input: SpawnAgentInput,
  deps: OrchestratorDeps,
): Promise<ControlResult<SpawnAgentOutcome>> {
  const denial = denyReason(
    ctx,
    'agent.spawn',
    { terminalId: ctx.terminalId, projectId: ctx.projectId },
    deps.resolveGroup,
  )
  if (denial) return denied(denial)

  const requester = deps.workspaceTerminals().find((item) => item.id === ctx.terminalId)
  const planned = planAgent(input, requester?.cwd ?? '')
  if ('error' in planned) return invalid(planned.error)
  const plan = planned.plan

  const live = liveAgentCount(deps, ctx.terminalId)
  const ceiling = deps.maxLiveAgents()
  if (live >= ceiling) {
    // `denied` rather than `invalid`: the request was well formed and the caller
    // holds the capability — the workspace is refusing on policy grounds. No
    // `denial` reason, because it is neither a missing capability nor a scope
    // violation, and inventing a third kind would lie to the backend.
    return { ok: false, code: 'denied', error: liveAgentCeilingMessage(live, ceiling, deps) }
  }

  // After the ceiling, before the job: there is no point asking a person to
  // allow something the workspace is going to refuse anyway.
  const approval = await requestApproval(
    {
      action: 'agent.spawn',
      requesterTerminalId: ctx.terminalId,
      projectId: ctx.projectId,
      agent: plan.agent,
      payload: plan.task,
    },
    deps,
  )
  if (approval !== 'approved') return refusedByHuman('agent.spawn', approval)

  const job = deps.jobs.create({
    kind: 'agent',
    requesterTerminalId: ctx.terminalId,
    state: 'pending',
    label: `${plan.agent}: ${plan.task.slice(0, 100)}`,
  })

  const pressure = deps.spawnQueue.snapshot()
  const start = async () => {
    await startAgent(job.jobId, plan, ctx, deps)
  }
  if (isUnderPressure(pressure)) return enterQueue(job.jobId, deps, pressure, start)
  if (!(await admit(deps))) {
    return enterQueue(job.jobId, deps, deps.spawnQueue.snapshot(), start)
  }

  return startAgent(job.jobId, plan, ctx, deps)
}

async function startAgent(
  jobId: string,
  plan: AgentPlan,
  ctx: ControlContext,
  deps: OrchestratorDeps,
): Promise<ControlResult<SpawnAgentOutcome>> {
  let created: { terminalId: string }
  try {
    created = await deps.createAgentTerminal({
      projectId: ctx.projectId,
      name: plan.name,
      cwd: plan.cwd,
      agent: plan.agent,
      extraArgs: plan.extraArgs,
      initialInput: plan.initialInput,
    })
  } catch (error) {
    deps.jobs.patch(jobId, { state: 'failed', failure: 'error' })
    return {
      ok: false,
      code: 'io',
      error: `Could not create a ${plan.agent} terminal: ${String(error)}`,
    }
  }

  const target: StartTarget = {
    paneId: created.terminalId,
    targetId: created.terminalId,
    inline: false,
    restoreTabId: null,
  }
  // Focus is what makes the pane render, which is what starts the process.
  deps.focusTerminal(ctx.projectId, target.paneId)
  deps.jobs.patch(jobId, { state: 'starting', targetTerminalId: target.targetId })
  watchStart(jobId, target, ctx, deps, deps.now() + SHELL_START_TIMEOUT_MS)

  return {
    ok: true,
    state: 'starting',
    jobId,
    terminalId: target.targetId,
    agent: plan.agent,
    mode: plan.mode,
    message:
      `Agent terminal ${target.targetId} was created in a pane of its own, running ${plan.agent}, ` +
      `and focused. ${describeMode(plan, target.targetId)} ${startedNotRunning(jobId)} ` +
      `Read what it produced with alethe_read_output on ${target.targetId}. ` +
      'Do not send this request again — check the job state instead.',
  }
}

function describeMode(plan: AgentPlan, terminalId: string): string {
  if (plan.mode === 'oneshot') {
    const forced = plan.forcedOneShot
      ? 'You asked for "interactive", but the task spans several lines, so it was sent through the ' +
        `command line instead. Interactive types the task into ${plan.agent}'s own interface, where a ` +
        'line break acts as Enter unless that CLI honours bracketed paste — which would submit the ' +
        'first paragraph alone and drop the rest. The command line carries the whole task verbatim. '
      : ''
    return (
      `${forced}Mode "oneshot": ${plan.agent} runs the task from its command line and then exits, so the ` +
      'process ending IS the completion signal — do not wait for a prompt to come back.'
    )
  }
  const fallback = plan.degraded
    ? `You asked for "oneshot", but ${plan.agent} has no one-shot form in Alethe, so the task was ` +
      'delivered interactively instead. There will be no exit to read as completion. '
    : ''
  const flattened = plan.flattened
    ? `The task spanned several lines and ${plan.agent} has no command-line form to carry them, so its ` +
      'line breaks were collapsed into single spaces before it was typed in: a line break acts as ' +
      'Enter in a CLI that does not honour bracketed paste, which would submit the first paragraph ' +
      'alone and drop the rest. Every word was delivered; only the line breaks are gone. '
    : ''
  return (
    `${fallback}Mode "interactive": ${plan.agent} stays open and the task is typed in once the CLI ` +
    `settles. ${flattened}Follow up with alethe_send_prompt on ${terminalId}.`
  )
}

function planAgent(
  input: SpawnAgentInput,
  requesterCwd: string,
): { plan: AgentPlan } | { error: string } {
  const requested = (input.agent ?? '').trim().toLowerCase()
  const agent = ALL_AGENT_TYPES.find((known) => known === requested)
  if (!agent) {
    return { error: `Unknown agent "${input.agent}". Known agents: ${ALL_AGENT_TYPES.join(', ')}.` }
  }
  if (agent === 'shell') {
    // A shell is not an agent: one-shot would leave it sitting there with no
    // task, and interactive would type arbitrary text straight into a live
    // shell — a command execution path that bypasses `run_shell`'s validation
    // entirely. There is already a tool for running a command.
    return {
      error:
        '`shell` is not an agent — it has no task to hand a prompt to. Use alethe_run_shell to run ' +
        'a command, or name a real agent here.',
    }
  }

  const task = (input.task ?? '').trim()
  if (!task) return { error: 'task is empty.' }
  if (task.length > MAX_TASK_LENGTH) {
    return { error: `task is longer than ${MAX_TASK_LENGTH} characters.` }
  }
  // The task ends up either in argv or typed into a live PTY; an escape byte is
  // how a control sequence gets smuggled into a terminal either way. Newlines
  // survive validation because argv carries them verbatim — interactive
  // delivery is what cannot, and that is handled below rather than refused.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(task)) {
    return { error: 'task contains control characters.' }
  }

  const mode = normalizeMode(input.mode)
  if (!mode) {
    return { error: `Unknown mode "${input.mode}". Use "oneshot" (default) or "interactive".` }
  }

  // A task with line breaks goes through argv whenever the agent has a one-shot
  // form, even when interactive was asked for. Interactive types the task into
  // the CLI's own interface wrapped in bracketed paste, and a CLI that does not
  // honour those sequences reads every newline as Enter — submitting the first
  // paragraph alone and dropping the rest. There is no way to find out from here
  // which CLIs honour them, so the safe path wins whenever there is one.
  const multiline = /[\r\n]/.test(task)
  const oneShotArgs =
    mode === 'oneshot' || multiline ? execArgsFor(agent, task, { unrestricted: true }) : undefined
  // No one-shot form for this agent: deliver the task interactively rather than
  // creating a terminal that silently never receives it.
  const degraded = mode === 'oneshot' && !oneShotArgs
  const forcedOneShot = mode === 'interactive' && Boolean(oneShotArgs)
  const effectiveMode: SpawnAgentMode = oneShotArgs ? 'oneshot' : 'interactive'
  // Interactive needs the flag just as much — it is where approval prompts
  // actually block, and it is the mode agents without a one-shot form (such as
  // antigravity) always land in.
  const extraArgs = oneShotArgs ?? unrestrictedArgs(agent)
  // Interactive is unavoidable here, so the whole task goes in on one line:
  // everything delivered beats the first paragraph delivered.
  const initialInput = effectiveMode === 'interactive' ? flattenForTyping(task) : undefined

  return {
    plan: {
      agent,
      task,
      // Empty is fine: the store falls back to the project's own folder.
      cwd: (input.cwd ?? '').trim() || requesterCwd,
      name: agentName(input.name, agent),
      mode: effectiveMode,
      extraArgs,
      initialInput,
      degraded,
      forcedOneShot,
      flattened: initialInput !== undefined && initialInput !== task,
    },
  }
}

/**
 * Collapses line breaks into single spaces so a block can be typed into a TUI.
 *
 * Delivery wraps the text in bracketed paste, which is supposed to make a
 * multi-line block arrive as one paste rather than as several submits — but a
 * CLI that ignores those markers treats each newline as Enter, so the first
 * paragraph is submitted on its own and everything after it is lost. Alethe
 * cannot know which CLIs honour bracketed paste, so a text that has to be typed
 * is flattened first: the words all survive, only the line breaks do not.
 */
export function flattenForTyping(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim()
}

/**
 * `exec` is the spelling the MCP schema exposes and `oneshot` the one this layer
 * is specified in; both mean "run the task from argv and exit", so both are
 * accepted rather than turned into a validation error the model cannot debug.
 */
function normalizeMode(raw: string | undefined): SpawnAgentMode | null {
  const mode = (raw ?? '').trim().toLowerCase()
  if (!mode || mode === 'oneshot' || mode === 'exec') return 'oneshot'
  if (mode === 'interactive') return 'interactive'
  return null
}

/**
 * Orchestrated agents always start unrestricted.
 *
 * They were handed a task by another agent, not by a person: nobody is watching
 * the pane to answer an approval prompt, so the gate protects no one — it just
 * parks the agent forever waiting on a human who never looks. Turning a terminal
 * into an orchestrator is where the user opts into this.
 */
function unrestrictedArgs(agent: AgentType): string[] | undefined {
  const flag = UNRESTRICTED_FLAG[agent]
  return flag ? [flag] : undefined
}

function agentName(name: string | undefined, agent: AgentType): string {
  const explicit = (name ?? '').trim()
  return explicit ? explicit.slice(0, 40) : agent
}

/**
 * Agent processes alive right now, workspace-wide, minus the one asking.
 *
 * Counted over sub-tabs, not panes: a pane only reports the tab it is currently
 * showing, so an agent working behind another tab would not be counted — and it
 * is delegated work all the same. Workspace-wide rather than in-scope because a
 * delegation run reaches every project of the group.
 *
 * The requester is left out on purpose. This ceiling caps delegation fan-out,
 * not memory — the memory budget does that, counts every process, and works.
 * The orchestrator is the terminal the person opened themselves, so counting it
 * turned "at most 3 agents" into "at most 2 workers", which is not what the
 * setting says. The whole requesting pane drops out, not just its front tab: a
 * delegated agent always lands in a pane of its own, so nothing inside the
 * requester's pane is delegated work.
 */
export function liveAgentCount(deps: OrchestratorDeps, requesterTerminalId?: string): number {
  const ptyIds = new Set<string>()
  for (const tab of deps.workspaceSubTabs()) {
    if (!tab.alive || tab.agent === 'shell' || !tab.ptyId) continue
    if (requesterTerminalId && tab.terminalId === requesterTerminalId) continue
    ptyIds.add(tab.ptyId)
  }
  return ptyIds.size
}

/**
 * Says how many agents are alive, what is counted, how to free one, and where
 * the ceiling lives — because it is a setting, not a law, and an agent that
 * cannot say so leaves the person stuck exactly like the memory budget did.
 */
function liveAgentCeilingMessage(live: number, ceiling: number, deps: OrchestratorDeps): string {
  const view = deps.memoryCeiling()
  return (
    `Refused: ${live} other agent process${live === 1 ? ' is' : 'es are'} already running and this ` +
    `workspace allows at most ${ceiling} at once. Your own terminal is not part of that count — the ` +
    'ceiling limits how many agents you may keep working for you, not the terminal the person ' +
    'opened. Each agent costs a few hundred MB of RAM, so this ceiling is what keeps a delegation ' +
    'run from taking the whole app down. ' +
    'Free a slot first: let one finish, or stop one with alethe_kill_terminal, then ask again. ' +
    `The ceiling is a setting the person can raise — ${view.settingsLabel} > ` +
    `"${view.categoryLabel}" > "${view.liveAgentsFieldLabel}". ` +
    'Tell them this; you cannot change it yourself.'
  )
}

/* ---------------------------------------------------------------------------
 * sendPrompt
 * ------------------------------------------------------------------------- */

export type SendPromptOutcome = {
  terminalId: string
  message: string
}

/**
 * Hands text to a terminal that is already running.
 *
 * The delivery itself is `promptDelivery`'s job — readiness, bracketed paste and
 * the separate submit key all live there. What this adds is the part that only
 * matters for an *injected* prompt: `AgentCompletionMonitor` arms from
 * `handleInput`, which is fed by xterm's `onData`, and a programmatic write
 * never passes through xterm at all. Without the explicit `recordAgentInput`
 * below, the monitor stays idle for the whole turn and nothing ever detects that
 * the answer finished.
 *
 * The other addition is `flattenForTyping`: this is the same typing path a
 * spawned agent's initial input takes, and it carries the same risk of a CLI
 * that ignores bracketed paste submitting the first paragraph on its own.
 */
export async function sendPrompt(
  ctx: ControlContext,
  input: { terminalId: string; text: string },
  deps: OrchestratorDeps,
): Promise<ControlResult<SendPromptOutcome>> {
  const view = resolveTarget(input.terminalId, deps)
  if (!view) return notFound(input.terminalId)
  const denial = denyReason(
    ctx,
    'agent.prompt',
    { terminalId: view.id, projectId: view.projectId },
    deps.resolveGroup,
  )
  if (denial) return denied(denial)

  const text = (input.text ?? '').trim()
  const invalidText = validatePromptText(text)
  if (invalidText) return invalid(invalidText)

  if (!view.ptyId || !view.alive) {
    return invalid(
      `Terminal ${view.id} has no running process, so there is nothing to prompt. Check ` +
        'alethe_terminal_status first, or start an agent with alethe_spawn_agent.',
    )
  }

  // The person sees `text`, not the flattened form below: they are approving
  // what the caller asked to send, and the delivery detail is Alethe's.
  const approval = await requestApproval(
    {
      action: 'agent.prompt',
      requesterTerminalId: ctx.terminalId,
      projectId: ctx.projectId,
      targetTerminalId: view.id,
      agent: view.agent,
      payload: text,
    },
    deps,
  )
  if (approval !== 'approved') return refusedByHuman('agent.prompt', approval)

  const ptyId = view.ptyId
  // Bracketed paste is meant to keep a multi-line prompt from being submitted
  // line by line, but only a CLI that honours it behaves that way — so the text
  // goes in on a single line and the answer says so.
  const typed = flattenForTyping(text)
  let delivered = false
  try {
    // A plain shell does not enable bracketed paste at all, and the markers
    // would then be typed in literally.
    delivered = await deps.deliverPrompt({ ptyId, text: typed, bracketed: view.agent !== 'shell' })
  } catch (error) {
    return { ok: false, code: 'io', error: `Could not write to ${view.id}: ${String(error)}` }
  }
  if (!delivered) {
    return {
      ok: false,
      code: 'io',
      error: `The prompt was not delivered to ${view.id}: it stopped accepting input while it was being sent.`,
    }
  }

  // Only after a real delivery, and only here: this is the one call that arms
  // the completion monitor for a turn nobody typed.
  deps.recordAgentInput(ptyId, `${typed}${PROMPT_SUBMIT_KEY}`)

  const flattened =
    typed === text
      ? ''
      : 'Its line breaks were collapsed into single spaces first: the prompt is typed into a live ' +
        'CLI, where a line break acts as Enter unless that CLI honours bracketed paste — which would ' +
        'submit the first paragraph alone and drop the rest. Every word was delivered; only the line ' +
        'breaks are gone. '
  return {
    ok: true,
    terminalId: view.id,
    message:
      `The prompt was typed into ${view.id} and submitted. ${flattened}This is an acknowledgement ` +
      `only — the answer is not here. Read it with alethe_read_output on ${view.id} once the ` +
      'terminal stops working.',
  }
}

function validatePromptText(text: string): string | null {
  if (!text) return 'text is empty.'
  if (text.length > MAX_PROMPT_LENGTH) {
    return `text is longer than ${MAX_PROMPT_LENGTH} characters.`
  }
  // Written straight into a live PTY. Newlines and tabs are accepted — the
  // newlines are flattened before delivery rather than refused — but an escape
  // byte is how a control sequence gets smuggled into another agent's terminal.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return 'text contains control characters.'
  return null
}

/* ---------------------------------------------------------------------------
 * killTerminal
 * ------------------------------------------------------------------------- */

export type KillTerminalOutcome = {
  terminalId: string
  /** False when the process had already exited; the request still succeeds. */
  wasAlive: boolean
  message: string
}

/**
 * Ends the process tree of a terminal in scope.
 *
 * Uses the store's `killTerminal` rather than `deleteTerminalWithWorktreeCleanup`
 * on purpose: "stop it" must not mean "destroy what it did". `killTerminal`
 * kills the processes and resets the runtime while keeping the terminal entity
 * and — for an isolated agent — its worktree on disk, so the work survives and
 * the person can still review or integrate it. Deleting would remove the
 * worktree, which is unrecoverable and was never asked for.
 */
export async function killTerminal(
  ctx: ControlContext,
  terminalId: string,
  deps: OrchestratorDeps,
): Promise<ControlResult<KillTerminalOutcome>> {
  const pane = deps.workspaceTerminals().find((item) => item.id === terminalId)
  if (!pane) {
    const subTab = deps.workspaceSubTabs().find((item) => item.id === terminalId)
    if (subTab) {
      // Killing a sub-tab means killing its pane, which would take down every
      // other tab in it — including, for a shell an agent opened for itself,
      // the conversation that is making this very request.
      return invalid(
        `${terminalId} is a sub-tab of terminal ${subTab.terminalId}, not a terminal of its own. ` +
          'Stopping it would end every process in that pane, so only a terminal id from ' +
          'alethe_list_terminals is accepted here.',
      )
    }
    return notFound(terminalId)
  }

  const denial = denyReason(
    ctx,
    'agent.kill',
    { terminalId, projectId: pane.projectId },
    deps.resolveGroup,
  )
  if (denial) return denied(denial)

  if (terminalId === ctx.terminalId) {
    return invalid(
      'A terminal cannot stop itself — that would kill the process making this request before it ' +
        'could answer. Ask the person to close it instead.',
    )
  }

  const approval = await requestApproval(
    {
      action: 'agent.kill',
      requesterTerminalId: ctx.terminalId,
      projectId: ctx.projectId,
      targetTerminalId: terminalId,
      agent: pane.agent,
      // The name, not the id: the person is deciding about a pane they can see,
      // and `term-a1b2c3` is not what they see on it.
      payload: pane.name,
    },
    deps,
  )
  if (approval !== 'approved') return refusedByHuman('agent.kill', approval)

  const wasAlive = pane.alive
  deps.killTerminal(pane.projectId, terminalId)
  return {
    ok: true,
    terminalId,
    wasAlive,
    message: wasAlive
      ? `Terminal ${terminalId} and its process tree were stopped. The terminal itself stays in the ` +
        'workspace, and an isolated agent keeps its worktree on disk, so nothing it produced is lost.'
      : `Terminal ${terminalId} had no running process; nothing was stopped.`,
  }
}

/* ---------------------------------------------------------------------------
 * waitForDone
 * ------------------------------------------------------------------------- */

/** Shortest wait the MCP schema accepts. */
export const WAIT_TIMEOUT_MIN_MS = 1_000
/**
 * Longest wait the MCP schema advertises. Enforced HERE and nowhere else: the
 * backend publishes the ceiling as documentation and does not validate it, so
 * that a single gate owns the rule. A value above it is clamped, never refused —
 * the caller asked for a longer wait, not for an error.
 */
export const WAIT_TIMEOUT_MAX_MS = 120_000
export const WAIT_TIMEOUT_DEFAULT_MS = 60_000
/** How often the wait re-reads the injected workspace state. */
export const WAIT_POLL_MS = 500
/**
 * How long a wait tolerates a terminal with no process at all before answering.
 * Same window the start watchdog uses, for the same reason: a pane only boots
 * its PTY once it renders, and silence past this point is not a slow start.
 */
export const WAIT_START_GRACE_MS = SHELL_START_TIMEOUT_MS

/** Which signal ended the wait. Reported as-is, never upgraded. */
export type WaitForDoneSource = 'exit' | 'idle' | 'gone'

export type WaitForDoneConfidence = 'high' | 'medium'

export type WaitForDoneState =
  /** The process is gone — it ran and ended. */
  | 'exited'
  /** Alive and the activity tracker says it is producing. */
  | 'working'
  /** Alive, with no activity the tracker can see. */
  | 'quiet'
  /** No process has ever been registered for this terminal. */
  | 'not-started'
  /** The terminal left the workspace while the wait was running. */
  | 'gone'

export type WaitForDoneOutcome = {
  terminalId: string
  /** True only when something actually ended the wait. A timeout is not done. */
  done: boolean
  /** Null when the wait ran out of time instead of being ended by a signal. */
  source: WaitForDoneSource | null
  /** How much that signal is worth. Null for the same reason as `source`. */
  confidence: WaitForDoneConfidence | null
  state: WaitForDoneState
  alive: boolean
  waitedMs: number
  /** Wait that was actually applied, after clamping. */
  timeoutMs: number
  timedOut: boolean
  message: string
}

/**
 * Waits until a terminal stops working, so an orchestrator does not poll
 * `terminal_status` in a loop.
 *
 * Two signals end the wait, and the answer always says which one did:
 *
 * 1. **The process exited** (`alive` went false). Unambiguous, and the normal
 *    ending for a delegated agent — one-shot is the default, so the CLI runs the
 *    task and leaves. High confidence.
 * 2. **The activity tracker went quiet** after this wait had seen it working.
 *    Medium confidence: the store mixes OpenCode's real bridge signal with a
 *    silence heuristic and does not record which one spoke, so this layer must
 *    not pretend to know.
 *
 * The "after this wait had seen it working" part is load-bearing. The tracker's
 * heuristic only arms when input is typed into the terminal — by a person, or by
 * `sendPrompt` — so a one-shot agent nobody typed into reads `waiting` for the
 * entire time it works. Accepting quiet on its own would declare every spawned
 * agent finished the instant its PTY boots.
 *
 * Running out of time is an ordinary answer with `ok: true` and `done: false`,
 * never an error: the caller may simply wait again. Nothing here reads the
 * scrollback — the tool's own description promises it returns no output.
 */
export function waitForDone(
  ctx: ControlContext,
  input: { terminalId: string; timeoutMs?: number },
  deps: OrchestratorDeps,
): Promise<ControlResult<WaitForDoneOutcome>> {
  const view = resolveTarget(input.terminalId, deps)
  if (!view) return Promise.resolve(notFound(input.terminalId))
  const denial = denyReason(
    ctx,
    'agent.spawn',
    { terminalId: view.id, projectId: view.projectId },
    deps.resolveGroup,
  )
  if (denial) return Promise.resolve(denied(denial))

  if (view.id === ctx.terminalId) {
    return Promise.resolve(
      invalid(
        'A terminal cannot wait for itself: this request is what your own process is currently ' +
          'blocked on, so it cannot stop working until the wait is over. Wait for a terminal you ' +
          'started, from alethe_list_terminals.',
      ),
    )
  }

  const timeoutMs = clampWaitTimeout(input.timeoutMs)
  const clampNote = waitClampNote(input.timeoutMs, timeoutMs)
  const startedAt = deps.now()
  const deadline = startedAt + timeoutMs
  // A terminal with no process yet gets the start window rather than the whole
  // wait: it either boots within it or it was never going to.
  const startDeadline = startedAt + Math.min(timeoutMs, WAIT_START_GRACE_MS)

  return new Promise((resolve) => {
    let sawWorking = false
    let everAlive = false

    const answer = (outcome: Omit<WaitForDoneOutcome, 'terminalId' | 'waitedMs' | 'timeoutMs'>) => {
      resolve({
        ok: true,
        terminalId: view.id,
        waitedMs: deps.now() - startedAt,
        timeoutMs,
        ...outcome,
        message: `${outcome.message}${clampNote}`,
      })
    }

    const tick = () => {
      const current = resolveTarget(view.id, deps)
      if (!current) {
        answer({
          done: true,
          source: 'gone',
          confidence: 'high',
          state: 'gone',
          alive: false,
          timedOut: false,
          message:
            `Terminal ${view.id} is no longer in this workspace: it was closed or deleted while you ` +
            'were waiting, and whatever it printed went with it. Do not wait for it again.',
        })
        return
      }

      if (current.alive) everAlive = true
      if (current.ptyStatus === 'working') sawWorking = true
      // A registered runtime is proof a process once existed, even one that has
      // already exited — that is what tells "finished" apart from "never ran".
      const started = everAlive || current.ptyStatus !== null

      if (started && !current.alive) {
        answer({
          done: true,
          source: 'exit',
          confidence: 'high',
          state: 'exited',
          alive: false,
          timedOut: false,
          message:
            `Terminal ${view.id} is done: its process exited, which is an unambiguous completion ` +
            'signal and the normal ending for an agent spawned in one-shot mode. Nothing was read ' +
            `here — get what it produced with alethe_read_output on ${view.id}.`,
        })
        return
      }

      if (current.alive && sawWorking && current.ptyStatus !== 'working') {
        answer({
          done: true,
          source: 'idle',
          confidence: 'medium',
          state: 'quiet',
          alive: true,
          timedOut: false,
          message:
            `Terminal ${view.id} went quiet: it was active during this wait and then stopped ` +
            'producing, so it has most likely finished its turn. Medium confidence — the process is ' +
            "still alive and this comes from Alethe's activity tracker rather than from the agent " +
            'itself, so a long pause inside a turn looks the same. Read what it produced with ' +
            `alethe_read_output on ${view.id}, and wait again if it turns out to still be going.`,
        })
        return
      }

      const now = deps.now()
      // A disabled terminal will not boot at all, so its start window is pointless.
      if (!started && (current.disabled || now >= startDeadline)) {
        answer({
          done: false,
          source: null,
          confidence: null,
          state: 'not-started',
          alive: false,
          timedOut: now >= deadline,
          message: notStartedMessage(view.id, current.disabled),
        })
        return
      }

      if (now >= deadline) {
        answer({
          done: false,
          source: null,
          confidence: null,
          state: current.ptyStatus === 'working' ? 'working' : 'quiet',
          alive: current.alive,
          timedOut: true,
          message: waitTimeoutMessage(view.id, timeoutMs, sawWorking),
        })
        return
      }

      deps.schedule(tick, WAIT_POLL_MS)
    }

    tick()
  })
}

function notStartedMessage(terminalId: string, disabled: boolean): string {
  if (disabled) {
    return (
      `Terminal ${terminalId} has no process and is disabled in this workspace, so none will start ` +
      'for it. It never ran; it did not finish. Only the person can enable it again.'
    )
  }
  return (
    `Terminal ${terminalId} still has no process after ${Math.round(WAIT_START_GRACE_MS / 1000)}s of ` +
    'waiting, so it never started rather than finished. A pane only boots its process once it ' +
    'renders, and a spawn parked behind the workspace queue takes longer than that — check the state ' +
    'of the job from the reply that created it before waiting again.'
  )
}

function waitTimeoutMessage(terminalId: string, timeoutMs: number, sawWorking: boolean): string {
  const quiet = sawWorking
    ? ''
    : ' Alethe never saw it turn active during this wait, which proves nothing for a one-shot agent: ' +
      'the activity signal only exists for a terminal prompted through Alethe (alethe_send_prompt, or ' +
      'a person typing) and for OpenCode, so the process exiting is the signal to rely on here.'
  return (
    `Waited ${Math.round(timeoutMs / 1000)}s for ${terminalId} and it has not finished: its process ` +
    'is still alive. Running out of time is a normal answer, not a failure — call ' +
    `alethe_wait_for_done on ${terminalId} again to keep waiting.${quiet}`
  )
}

function clampWaitTimeout(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return WAIT_TIMEOUT_DEFAULT_MS
  return Math.min(WAIT_TIMEOUT_MAX_MS, Math.max(WAIT_TIMEOUT_MIN_MS, Math.floor(raw)))
}

/** Said out loud: a silently shortened wait reads as a wait that ended early. */
function waitClampNote(raw: number | undefined, applied: number): string {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.floor(raw) === applied) return ''
  return (
    ` The ${Math.floor(raw)} ms you asked for was clamped to ${applied} ms: a single wait may take ` +
    `between ${WAIT_TIMEOUT_MIN_MS} and ${WAIT_TIMEOUT_MAX_MS} ms. Wait again if that is not enough.`
  )
}

/* ---------------------------------------------------------------------------
 * listAgents
 * ------------------------------------------------------------------------- */

/**
 * What this machine can actually run, so an orchestrator routes by cost and
 * availability instead of always reaching for the most expensive agent.
 *
 * Every probe is best-effort and runs in parallel under its own deadline: a
 * provider that is down, unauthenticated or simply slow costs its own field and
 * nothing else. `list_agents` is a read on the bridge's short timeout, so a
 * single hung provider must never take the whole list with it.
 */
export async function listAgents(
  ctx: ControlContext,
  deps: OrchestratorDeps,
): Promise<ControlResult<{ agents: AgentCatalogEntry[] }>> {
  const denial = denyReason(ctx, 'agent.spawn', null, deps.resolveGroup)
  if (denial) return denied(denial)

  const agents = await Promise.all(
    ALL_AGENT_TYPES.map(async (agent): Promise<AgentCatalogEntry> => {
      const [installed, usage] = await Promise.all([
        probeProvider(() => deps.agentProbe.isInstalled(agent), false, deps),
        probeProvider(() => deps.agentProbe.usage(agent), null, deps),
      ])
      return {
        agent,
        installed,
        // Being spawnable and being able to orchestrate are separate questions:
        // every agent here can be started, only the ones with a verified MCP
        // path can drive this control plane.
        canOrchestrate: supportsOrchestrator(agent),
        usage,
      }
    }),
  )
  return { ok: true, agents }
}

/** Runs one provider probe with a deadline and a fallback; never rejects. */
async function probeProvider<T>(
  run: () => Promise<T>,
  fallback: T,
  deps: OrchestratorDeps,
): Promise<T> {
  try {
    return await Promise.race([
      run(),
      new Promise<T>((resolve) => {
        deps.schedule(() => resolve(fallback), PROVIDER_PROBE_TIMEOUT_MS)
      }),
    ])
  } catch {
    return fallback
  }
}

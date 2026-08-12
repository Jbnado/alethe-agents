/**
 * Live wiring of the control-plane operations to the running app.
 *
 * Everything that touches a store, the Tauri bridge or the global spawn queue
 * lives here, so `./ops.ts` stays pure and testable under plain Node.
 */

// The app's single PTY-write helper. Reached for rather than reimplemented:
// duplicating the bracketed-paste framing is how the two copies drift, and a
// prompt that lands with stray `200~` markers is unrecoverable at this layer.
import { writePtyChunked } from '../../components/XTermView/terminalWrite'
import { orchestratorJobSink } from '../../stores/orchestratorStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { recordAgentActivityInput } from '../activityTracker'
import { getCachedAntigravityUsage } from '../antigravityUsageCache'
import { getCachedClaudeUsage } from '../claudeUsageCache'
import { getCachedCodexUsage } from '../codexUsageCache'
import { getLocale, translate } from '../i18n'
import { deliverPrompt } from '../promptDelivery'
import { acquireSpawnSlot, getSpawnQueueSnapshot, releaseSpawnSlot } from '../spawnQueue'
import { attachPty, findCliLauncher, writePty } from '../tauri'
import { resolveTerminalCwd } from '../terminalFactory'
import { agentCliCommand, type AgentType } from '../types'
import { askForApproval, autoApprovedAction, sessionApprovedAction } from './approvalGate'
import type {
  AgentUsageReport,
  ControlSubTabView,
  ControlTerminalView,
  CreateAgentInput,
  CreateShellSubTabInput,
  MemoryCeilingView,
  OrchestratorDeps,
  PromptDeliveryRequest,
  ShellSubTabHandle,
} from './ops'
import { capabilitiesFor, type ControlContext } from './scope'
import {
  antigravityUsageReport,
  claudeUsageReport,
  codexUsageReport,
} from './usageReport'

/**
 * Mints the context for a terminal that is calling the control plane. Returns
 * null when the terminal is unknown to the frontend — which is the whole reason
 * scope is decided here: `projects.json` on disk lags the store by a debounce,
 * so a terminal created seconds ago exists only in Zustand.
 *
 * `orchestrator` stays a parameter instead of a stored flag: the toggle that
 * marks a terminal as an orchestrator is not built yet, and every capability it
 * would unlock is out of this layer's reach anyway.
 */
export function resolveControlContext(
  terminalId: string,
  orchestrator = false,
): ControlContext | null {
  const project = useProjectsStore
    .getState()
    .projects.find((item) => item.terminals.some((terminal) => terminal.id === terminalId))
  if (!project) return null
  return {
    terminalId,
    projectId: project.id,
    groupId: project.groupId ?? null,
    capabilities: capabilitiesFor(orchestrator),
  }
}

export function resolveGroup(projectId: string): string | null {
  return useProjectsStore.getState().projects.find((item) => item.id === projectId)?.groupId ?? null
}

/**
 * Every terminal an agent can address. Viewer panes (file, diff, web, graphify)
 * carry no process and no agent, and the read-only GSD Sync viewer is not
 * addressable at all — none of them belong in a control-plane listing.
 */
export function workspaceTerminals(): ControlTerminalView[] {
  const runtimes = useTerminalsStore.getState().byPtyId
  const views: ControlTerminalView[] = []
  for (const project of useProjectsStore.getState().projects) {
    for (const terminal of project.terminals) {
      if (!isAddressableTerminal(terminal)) continue
      const tab = terminal.tabs.find((item) => item.id === terminal.activeTabId) ?? terminal.tabs[0]
      if (!tab) continue
      // Before the first spawn the sub-tab has no `ptyId` and `XTermView` boots
      // the PTY under the sub-tab id, so that is the id the runtime is keyed by.
      const ptyId = tab.ptyId ?? tab.id
      const runtime = runtimes[ptyId]
      views.push({
        id: terminal.id,
        name: terminal.name,
        projectId: project.id,
        agent: tab.type,
        cwd: resolveTerminalCwd(terminal),
        disabled: terminal.disabled,
        ptyId,
        alive: Boolean(runtime?.alive),
        // Absent runtime means no process was ever registered here — a distinct
        // state from one that exited, which keeps its entry.
        ptyStatus: runtime?.status ?? null,
      })
    }
  }
  return views
}

/** True for panes that actually host sub-tabs and are addressable by an agent. */
function isAddressableTerminal(terminal: {
  kind?: string
  gsdSyncViewer?: boolean
}): boolean {
  if (terminal.kind && terminal.kind !== 'terminal') return false
  return !terminal.gsdSyncViewer
}

/**
 * Every sub-tab of every addressable pane. A shell an agent opens lands here,
 * inside the requester's own pane, so it needs an entry of its own — the pane
 * entry above only ever describes the sub-tab currently in front.
 */
export function workspaceSubTabs(): ControlSubTabView[] {
  const runtimes = useTerminalsStore.getState().byPtyId
  const views: ControlSubTabView[] = []
  for (const project of useProjectsStore.getState().projects) {
    for (const terminal of project.terminals) {
      if (!isAddressableTerminal(terminal)) continue
      for (const tab of terminal.tabs) {
        const ptyId = tab.ptyId ?? tab.id
        const runtime = runtimes[ptyId]
        views.push({
          id: tab.id,
          terminalId: terminal.id,
          name: tab.name,
          projectId: project.id,
          agent: tab.type,
          cwd: tab.cwd?.trim() || resolveTerminalCwd(terminal),
          disabled: terminal.disabled,
          ptyId,
          alive: Boolean(runtime?.alive),
          ptyStatus: runtime?.status ?? null,
          active: terminal.activeTabId === tab.id,
          pendingInput: Boolean(tab.initialInput),
        })
      }
    }
  }
  return views
}

/**
 * Adds a shell sub-tab to an existing pane. `createSubTab` brings it to the
 * front by itself, which is what makes `XTermView` mount and spawn the PTY.
 *
 * Nothing here touches `project.defaultCwd`: a sub-tab carries its own folder,
 * so the guard `createShell` needs (`suppressDefaultCwd`) has no equivalent to
 * bypass on this path.
 */
export function createShellSubTab(input: CreateShellSubTabInput): ShellSubTabHandle | null {
  const store = useProjectsStore.getState()
  const project = store.projects.find((item) => item.id === input.projectId)
  const terminal = project?.terminals.find((item) => item.id === input.terminalId)
  if (!terminal || !isAddressableTerminal(terminal)) return null
  const previousTabId = terminal.activeTabId || null
  const tab = store.createSubTab(input.projectId, input.terminalId, {
    type: 'shell',
    cwd: input.cwd,
    name: input.name,
    initialInput: input.command,
  })
  return { terminalId: input.terminalId, tabId: tab.id, previousTabId }
}

export function activateSubTab(projectId: string, terminalId: string, tabId: string): void {
  useProjectsStore.getState().setActiveTab(projectId, terminalId, tabId)
}

/**
 * Numbers and localized labels behind the memory ceiling. The labels come from
 * the user's own locale on purpose: an agent reciting an English settings path
 * to someone running the UI in Portuguese sends them looking for a field that
 * is not on their screen.
 */
export function memoryCeiling(): MemoryCeilingView {
  const ui = useUiStore.getState()
  const locale = getLocale()
  const snapshot = ui.runtimeSnapshot
  return {
    usedMb: snapshot?.effectiveTotalMb ?? ui.memoryStats?.total_mb ?? ui.ramMb ?? null,
    budgetMb: useProjectsStore.getState().preferences.resourcePolicy.memoryBudgetMb,
    systemTotalMb: snapshot?.memory.system_total_mb ?? ui.memoryStats?.system_total_mb ?? null,
    settingsLabel: translate(locale, 'prefs.title'),
    categoryLabel: translate(locale, 'prefs.categoryTerminal'),
    budgetFieldLabel: translate(locale, 'prefs.resourceBudget'),
    liveAgentsFieldLabel: translate(locale, 'prefs.orchestratorMaxLiveAgents'),
  }
}

/** Creates a real shell in a pane of its own; the command is typed in, never argv. */
export function createShell(input: {
  projectId: string
  name: string
  cwd: string
  command: string
}): { terminalId: string } {
  const terminal = useProjectsStore.getState().createTerminal(input.projectId, {
    name: input.name,
    cwd: input.cwd,
    firstTab: { type: 'shell', cwd: input.cwd, initialInput: input.command },
    // An agent opening a shell in a subfolder must not repoint the project's
    // default folder — that setting belongs to the person, not to the agent.
    suppressDefaultCwd: true,
  })
  return { terminalId: terminal.id }
}

/**
 * Creates a sibling agent in a pane of its own.
 *
 * `createAgentTerminal` rather than `createTerminal`: it provisions a worktree
 * when the project asks for isolation, and falls back to a plain terminal when
 * that fails, so a delegated agent gets the same treatment as one a person
 * opened from the dialog.
 *
 * `orchestrator: false` is the anti-recursion guarantee, spelled out rather than
 * left to the field's default: the token minted for this terminal at spawn time
 * carries the base capabilities only, so it has no `agent.spawn` to delegate
 * with. The delegation tree is one level deep by construction, not by a runtime
 * depth check that could be miscounted.
 */
export async function createAgentTerminal(input: CreateAgentInput): Promise<{ terminalId: string }> {
  const terminal = await useProjectsStore.getState().createAgentTerminal(input.projectId, {
    name: input.name,
    cwd: input.cwd,
    firstTab: {
      type: input.agent,
      cwd: input.cwd,
      extraArgs: input.extraArgs,
      initialInput: input.initialInput,
      orchestrator: false,
    },
    // An agent spawned into a subfolder must not repoint the project's default
    // folder — that setting belongs to the person.
    suppressDefaultCwd: true,
  })
  return { terminalId: terminal.id }
}

export function killTerminal(projectId: string, terminalId: string): void {
  useProjectsStore.getState().killTerminal(projectId, terminalId)
}

/**
 * Types a block into a live PTY. Same delivery the initial prompt of a fresh
 * terminal uses, so readiness, chunking and the separate submit key behave
 * identically whether a person or an agent asked for it.
 */
export function deliverControlPrompt(input: PromptDeliveryRequest): Promise<boolean> {
  return deliverPrompt(input.text, {
    getRuntime: () => useTerminalsStore.getState().byPtyId[input.ptyId],
    writeChunked: (text, bracketed) => writePtyChunked(input.ptyId, text, bracketed && input.bracketed),
    write: (text) => writePty(input.ptyId, text),
  })
}

/** True when the agent's CLI resolves on this machine. */
async function isAgentInstalled(agent: AgentType): Promise<boolean> {
  const command = agentCliCommand(agent)
  // A shell always exists; there is no launcher to resolve for it.
  if (!command) return true
  return Boolean(await findCliLauncher(command))
}

/**
 * Usage of a provider that exposes it. The normalization — and the rule that no
 * plan name ever crosses it — lives in `./usageReport.ts`.
 */
async function agentUsage(agent: AgentType): Promise<AgentUsageReport | null> {
  switch (agent) {
    case 'claude':
      return claudeUsageReport(await getCachedClaudeUsage())
    case 'codex':
      return codexUsageReport(await getCachedCodexUsage())
    case 'antigravity':
      return antigravityUsageReport(await getCachedAntigravityUsage())
    default:
      // No usage endpoint for this provider. Null, never an estimate.
      return null
  }
}

/**
 * The focus sequence from `HomeView`, plus two guards it does not need but an
 * agent-triggered creation does: a collapsed container renders no panes, and a
 * fullscreen on another container hides ours. In both cases the pane never
 * mounts `XTermView`, so no process would ever start.
 */
export function focusTerminal(projectId: string, terminalId: string): void {
  const projects = useProjectsStore.getState()
  const { fullscreenContainerId, isolatedPaneId } = projects.preferences
  if (
    fullscreenContainerId &&
    (fullscreenContainerId !== projectId || (isolatedPaneId && isolatedPaneId !== terminalId))
  ) {
    projects.setFullscreenContainer(null)
  }
  if (projects.workspace.containers.find((c) => c.projectId === projectId)?.collapsed) {
    projects.setContainerCollapsed(projectId, false)
  }
  projects.setActiveProjectOnly(projectId)
  useProjectsStore.getState().focusWorkspaceTerminal(projectId, terminalId)
  const ui = useUiStore.getState()
  ui.setActiveTerminal(projectId, terminalId)
  ui.requestPaneFocus(terminalId)
  ui.setActiveView('workspace')
}

export const liveOrchestratorDeps: OrchestratorDeps = {
  workspaceTerminals,
  workspaceSubTabs,
  resolveGroup,
  createShellSubTab,
  createShell,
  createAgentTerminal,
  killTerminal,
  deliverPrompt: deliverControlPrompt,
  recordAgentInput: recordAgentActivityInput,
  maxLiveAgents: () => useProjectsStore.getState().preferences.orchestratorMaxLiveAgents,
  agentProbe: { isInstalled: isAgentInstalled, usage: agentUsage },
  activateSubTab,
  focusTerminal,
  readScrollback: (ptyId) => attachPty(ptyId),
  spawnQueue: {
    snapshot: getSpawnQueueSnapshot,
    acquire: acquireSpawnSlot,
    release: releaseSpawnSlot,
  },
  memoryCeiling,
  approvals: {
    autoApproved: autoApprovedAction,
    sessionApproved: sessionApprovedAction,
    ask: askForApproval,
  },
  jobs: orchestratorJobSink,
  now: () => Date.now(),
  schedule: (run, ms) => {
    setTimeout(run, ms)
  },
}

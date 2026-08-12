/**
 * Live wiring of the approval gate: parks a control-plane write in front of the
 * person and settles it when they answer.
 *
 * The resolvers live in this module rather than in `orchestratorStore` so the
 * store stays plain data, and so every parked request has exactly one owner
 * that can settle it — including one whose dialog never mounts, or whose
 * deadline expires while the person is away from the machine.
 */

import { useOrchestratorStore, type OrchestratorApproval } from '../../stores/orchestratorStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import type { OrchestratorApprovalAction } from '../types'
import type { ApprovalRequest } from './ops'

/** Requests waiting for an answer, by request id. */
const waiting = new Map<string, (approved: boolean) => void>()

/**
 * Whether this action runs without asking. Read straight from the live store on
 * every call — this is the switch an automated run flips to take the human out
 * of the loop, and it has to bite on the very next request.
 */
export function autoApprovedAction(action: OrchestratorApprovalAction): boolean {
  return useProjectsStore.getState().preferences.orchestratorAutoApprove?.[action] === true
}

/**
 * Whether the person already said "always allow this action for this terminal"
 * during this session. Session-scoped and never persisted: the key is a
 * `terminalId`, which is minted fresh per terminal, so a stored grant would
 * either dangle or silently apply to whatever reuses the id.
 */
export function sessionApprovedAction(
  terminalId: string,
  action: OrchestratorApprovalAction,
): boolean {
  return useOrchestratorStore.getState().isSessionApproved(terminalId, action)
}

/** Capability the dialog grants when "always allow" is ticked. */
const KIND_OF: Record<OrchestratorApprovalAction, OrchestratorApproval['kind']> = {
  'shell.run': 'shell',
  'agent.spawn': 'agent',
  'agent.prompt': 'agent',
  'agent.kill': 'agent',
}

/** Name a terminal shows in the workspace, pane or sub-tab, or its raw id. */
function terminalName(terminalId: string): string {
  for (const project of useProjectsStore.getState().projects) {
    for (const terminal of project.terminals) {
      if (terminal.id === terminalId) return terminal.name
      const tab = terminal.tabs.find((item) => item.id === terminalId)
      if (tab) return tab.name
    }
  }
  return terminalId
}

function projectName(projectId: string): string {
  return (
    useProjectsStore.getState().projects.find((item) => item.id === projectId)?.name ?? projectId
  )
}

/**
 * Shows the request and resolves with the person's answer.
 *
 * Opening the dialog is a request, not a takeover: if another modal is already
 * up, the card queues behind it and the topbar carries the count. Nothing is
 * ever stacked on top of an open dialog.
 */
export function askForApproval(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
  const approval = useOrchestratorStore.getState().enqueueApproval({
    requesterTerminalId: request.requesterTerminalId,
    requesterName: terminalName(request.requesterTerminalId),
    projectId: request.projectId,
    projectName: projectName(request.projectId),
    capability: request.action,
    kind: KIND_OF[request.action],
    summary: request.payload,
    targetTerminalId: request.targetTerminalId,
    targetName: request.targetTerminalId ? terminalName(request.targetTerminalId) : undefined,
    agent: request.agent,
  })

  return new Promise<boolean>((resolve) => {
    waiting.set(approval.requestId, resolve)

    // The deadline belongs to the caller in `ops.ts`, which has already answered
    // the agent by the time this fires. All that is left here is to take the
    // dead card off the screen so nobody answers a question nobody is listening
    // to anymore.
    signal.addEventListener(
      'abort',
      () => {
        if (!waiting.delete(approval.requestId)) return
        useOrchestratorStore.getState().takeApproval(approval.requestId)
        closeWhenDrained()
        resolve(false)
      },
      { once: true },
    )

    const ui = useUiStore.getState()
    if (ui.openModal === null) ui.openModal_('orchestratorApproval')
  })
}

/**
 * Settles a parked request with the person's answer. A request id that is no
 * longer waiting — already answered, or expired — is a no-op: the dialog and
 * the deadline race, and whichever loses must not care.
 */
export function resolveApproval(requestId: string, approved: boolean): void {
  const resolve = waiting.get(requestId)
  waiting.delete(requestId)
  useOrchestratorStore.getState().takeApproval(requestId)
  resolve?.(approved)
  closeWhenDrained()
}

/** Gives the modal slot back once nothing is left to decide. */
function closeWhenDrained(): void {
  const ui = useUiStore.getState()
  if (ui.openModal !== 'orchestratorApproval') return
  if (useOrchestratorStore.getState().approvals.length === 0) ui.closeModal()
}

/**
 * Capability and scope rules for the orchestrator control plane.
 *
 * Pure by design: no imports from `./tauri` or any store, so the rules that
 * decide what an agent terminal may see and touch can be tested in isolation.
 * The caller injects how a project resolves to its group.
 */

/** A single permission carried by a control token. */
export type ControlCapability =
  | 'terminal.list'
  | 'terminal.read'
  | 'shell.run'
  | 'events.read'
  | 'agent.spawn'
  | 'agent.prompt'
  | 'agent.kill'

/** Granted to every agent terminal: read the workspace, open and read shells. */
export const BASE_CAPABILITIES: readonly ControlCapability[] = [
  'terminal.list',
  'terminal.read',
  'shell.run',
  'events.read',
]

/** Granted only to a terminal created with the orchestrator toggle on. */
export const ORCHESTRATOR_CAPABILITIES: readonly ControlCapability[] = [
  'agent.spawn',
  'agent.prompt',
  'agent.kill',
]

/**
 * Capabilities minted for a terminal.
 *
 * Agents spawned BY an orchestrator are created with `orchestrator: false`, so
 * they never receive `agent.spawn`. That keeps the delegation tree one level
 * deep by construction rather than by a runtime depth check.
 */
export function capabilitiesFor(orchestrator: boolean): ControlCapability[] {
  return orchestrator
    ? [...BASE_CAPABILITIES, ...ORCHESTRATOR_CAPABILITIES]
    : [...BASE_CAPABILITIES]
}

/** Who is calling: the terminal a control token was minted for. */
export type ControlContext = {
  terminalId: string
  projectId: string
  /** Null when the project sits outside any group. */
  groupId: string | null
  capabilities: readonly ControlCapability[]
}

/** What is being acted upon. */
export type ScopeTarget = {
  terminalId: string
  projectId: string
}

/** Resolves a project to its group id, or null when ungrouped. */
export type GroupResolver = (projectId: string) => string | null

export function hasCapability(
  context: ControlContext,
  capability: ControlCapability,
): boolean {
  return context.capabilities.includes(capability)
}

/**
 * Whether `target` is reachable from `context`: same project, or same group.
 *
 * An ungrouped caller (`groupId === null`) is confined to its own project — two
 * unrelated ungrouped projects must never see each other just because both lack
 * a group.
 */
export function isInScope(
  context: ControlContext,
  target: ScopeTarget,
  resolveGroup: GroupResolver,
): boolean {
  if (target.projectId === context.projectId) return true
  if (context.groupId === null) return false
  return resolveGroup(target.projectId) === context.groupId
}

/** Reason a control request was rejected, for an actionable error message. */
export type DenialReason =
  | { kind: 'missing-capability'; capability: ControlCapability }
  | { kind: 'out-of-scope'; targetProjectId: string }

/**
 * Single gate for every control request that names a target terminal.
 * Returns null when the request is allowed.
 */
export function denyReason(
  context: ControlContext,
  capability: ControlCapability,
  target: ScopeTarget | null,
  resolveGroup: GroupResolver,
): DenialReason | null {
  if (!hasCapability(context, capability)) {
    return { kind: 'missing-capability', capability }
  }
  if (target && !isInScope(context, target, resolveGroup)) {
    return { kind: 'out-of-scope', targetProjectId: target.projectId }
  }
  return null
}

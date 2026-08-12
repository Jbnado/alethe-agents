/**
 * Wiring that turns an agent terminal into a control-plane client at spawn time.
 *
 * Pure by design, like `./scope.ts`: everything that talks to Tauri is injected,
 * so the rules that decide which agent gets what can be tested under plain Node.
 *
 * Two separate decisions live here and must not be conflated:
 *
 * 1. **Every** agent terminal is minted a control token and told where to spend
 *    it. That is what makes a terminal addressable and lets it identify itself.
 * 2. Which terminals get Alethe's MCP server injected depends on what the
 *    injection costs for that CLI, not on the capability tier — the server
 *    already filters `tools/list` by the token. See `wantsMcpInjection`.
 */

import type { AgentType } from '../types'
import type { ControlCapability } from './scope'

/** Env var pointing the agent at Alethe's local control listener. */
export const CONTROL_ENDPOINT_ENV = 'ALETHE_ENDPOINT'
/**
 * Env var carrying the terminal's control token. Mirrors `TOKEN_ENV_VAR` in
 * `src-tauri/src/orchestrator_config.rs`: Codex accepts no arbitrary MCP
 * headers and reads its bearer token from an env var by name, so the two sides
 * have to agree on this exact string.
 */
export const CONTROL_TOKEN_ENV = 'ALETHE_TOKEN'

/**
 * Agents whose MCP-over-HTTP path was verified end to end (claude 2.1.226,
 * codex 0.147.0). OpenCode and Antigravity are deliberately absent: their path
 * is unverified, and an option that silently does nothing is worse than no
 * option at all.
 */
export const ORCHESTRATOR_CAPABLE_AGENTS = ['claude', 'codex'] as const

export type OrchestratorCapableAgent = (typeof ORCHESTRATOR_CAPABLE_AGENTS)[number]

export function supportsOrchestrator(
  agent: AgentType | null | undefined,
): agent is OrchestratorCapableAgent {
  return agent === 'claude' || agent === 'codex'
}

/** True for anything that runs a CLI agent — a plain shell holds no token. */
export function isAgentCommand(agent: AgentType | null | undefined): boolean {
  return Boolean(agent) && agent !== 'shell'
}

/** What `control_token_mint` hands back. */
export type ControlSession = {
  token: string
  /** Base listener endpoint, e.g. `http://127.0.0.1:9123`. */
  endpoint: string
  capabilities: ControlCapability[]
}

export type MintControlToken = (input: {
  terminalId: string
  projectId: string
  groupId: string | null
  orchestrator: boolean
}) => Promise<ControlSession>

/**
 * Mints the control token for a terminal about to spawn.
 *
 * Best-effort by contract, like every other pre-spawn integration in this
 * codebase (Graphify, ai-memory, GSD, the OpenCode bridge): a control plane
 * that is not up yet must never keep a terminal from starting, so any failure
 * resolves to `null` and the spawn continues without control access.
 *
 * `orchestrator` is intersected with `supportsOrchestrator` on purpose. A
 * sub-tab could carry the flag from an older state (agent changed, data edited
 * by hand) and would otherwise be minted elevated capabilities it has no way to
 * use — capabilities are granted against a verified path, never against intent.
 */
export async function openControlSession(input: {
  agent: AgentType | null | undefined
  terminalId: string
  projectId: string
  groupId: string | null
  orchestrator: boolean
  mint: MintControlToken
}): Promise<ControlSession | null> {
  if (!isAgentCommand(input.agent)) return null
  if (!input.terminalId || !input.projectId) return null
  try {
    const session = await input.mint({
      terminalId: input.terminalId,
      projectId: input.projectId,
      groupId: input.groupId,
      orchestrator: input.orchestrator && supportsOrchestrator(input.agent),
    })
    // Half a credential is worth nothing: the agent would either not know where
    // to call or be rejected on arrival.
    if (!session?.token || !session.endpoint) return null
    return session
  } catch {
    return null
  }
}

/**
 * Returns the spawn env carrying the control credentials. Leaves the env it was
 * given untouched (including `undefined`) when there is no session, so a failed
 * mint is indistinguishable from the integration being off.
 */
export function withControlEnv(
  env: Record<string, string> | undefined,
  session: ControlSession | null,
): Record<string, string> | undefined {
  if (!session) return env
  return {
    ...(env ?? {}),
    [CONTROL_ENDPOINT_ENV]: session.endpoint,
    [CONTROL_TOKEN_ENV]: session.token,
  }
}

/**
 * Drops the token a terminal held. Best-effort: a token whose revocation failed
 * still dies with the app, and nothing useful can be done about it at the call
 * site.
 */
export async function closeControlSession(
  terminalId: string,
  revoke: (terminalId: string) => Promise<unknown>,
): Promise<void> {
  if (!terminalId) return
  try {
    await revoke(terminalId)
  } catch {
    /* the registry lives in memory; a stale entry cannot outlive the process */
  }
}

/**
 * Whether this terminal should have Alethe's MCP server injected into its CLI.
 *
 * The answer differs per agent because the injection mechanisms differ in cost,
 * not because the tiers differ — the server already filters `tools/list` by the
 * token's capabilities, so a non-orchestrator sees only the shell-tier tools:
 *
 * - **claude**: `--mcp-config` is additive and repeatable; it adds a server
 *   without discarding anything the user configured. Cheap enough to give every
 *   agent terminal, which is what lets any agent open a real, visible shell
 *   instead of a hidden internal one.
 * - **codex**: the only verified route needs `--ignore-user-config`, which drops
 *   the user's own model, provider and MCP settings. That is far too destructive
 *   for an ordinary terminal, so codex pays it only when the user explicitly
 *   asked for an orchestrator. Revisit if a non-destructive `-c`-only route is
 *   ever verified.
 */
export function wantsMcpInjection(
  agent: AgentType | null | undefined,
  orchestrator: boolean,
  session: ControlSession | null,
): session is ControlSession {
  if (session === null || !supportsOrchestrator(agent)) return false
  return agent === 'claude' ? true : Boolean(orchestrator)
}

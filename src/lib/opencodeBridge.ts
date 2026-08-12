/**
 * Wiring for the global OpenCode plugin installed by `opencode_bridge.rs`.
 *
 * That plugin is what turns OpenCode's `session.idle` into a real
 * working/idle signal for Alethe — the PTY silence heuristic used elsewhere is
 * unreliable against OpenCode's full-screen TUI, which redraws constantly. The
 * plugin only reports back when it finds the local hooks endpoint and its token
 * in the environment; without them it returns early and does nothing at all, so
 * both have to be injected into every OpenCode PTY we spawn.
 */
import type { AgentType } from './types'

/** Env var the plugin reads to find Alethe's local hooks listener. */
export const BRIDGE_ENDPOINT_ENV = 'ALETHE_BRIDGE_ENDPOINT'
/** Env var carrying the shared secret; the listener 401s requests without it. */
export const BRIDGE_TOKEN_ENV = 'ALETHE_BRIDGE_TOKEN'

/**
 * Return the spawn env for `agent`, carrying the bridge credentials when the
 * agent is OpenCode. Best-effort by design, like the other pre-spawn
 * integrations: an unreachable listener leaves the env untouched and the
 * terminal still starts, falling back to the PTY heuristic.
 */
export async function withOpenCodeBridgeEnv(
  agent: AgentType | null | undefined,
  env: Record<string, string> | undefined,
  resolveEndpoint: () => Promise<string>,
  resolveToken: () => Promise<string>,
): Promise<Record<string, string> | undefined> {
  if (agent !== 'opencode') return env
  const [endpoint, token] = await Promise.all([
    resolveEndpoint().catch(() => ''),
    resolveToken().catch(() => ''),
  ])
  // Half the pair is worth nothing: the plugin would either not know where to
  // report or get rejected by the listener.
  if (!endpoint || !token) return env
  return { ...(env ?? {}), [BRIDGE_ENDPOINT_ENV]: endpoint, [BRIDGE_TOKEN_ENV]: token }
}

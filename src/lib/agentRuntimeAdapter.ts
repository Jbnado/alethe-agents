import type { AgentRuntimeProfile, AgentType } from './types'

export type AgentRuntimeBackend = 'pty' | 'codex-app-server' | 'claude-agent-sdk'

export type AgentRuntimeAdapter = {
  id: AgentRuntimeBackend
  label: string
  experimental: boolean
  available: boolean
  agents: AgentType[]
}

/**
 * Contrato preparado para trocar transporte sem acoplar a UI ao PTY. Os dois
 * adapters nativos ficam explicitamente indisponíveis até terem lifecycle,
 * autenticação e streaming equivalentes ao caminho atual.
 */
export const AGENT_RUNTIME_ADAPTERS: AgentRuntimeAdapter[] = [
  {
    id: 'pty',
    label: 'PTY / ConPTY',
    experimental: false,
    available: true,
    agents: ['shell', 'claude', 'codex', 'opencode', 'freebuff', 'mimo'],
  },
  {
    id: 'codex-app-server',
    label: 'Codex app-server',
    experimental: true,
    available: false,
    agents: ['codex'],
  },
  {
    id: 'claude-agent-sdk',
    label: 'Claude Agent SDK',
    experimental: true,
    available: false,
    agents: ['claude'],
  },
]

export type PreparedRuntimeLaunch = {
  args: string[]
  env: Record<string, string> | undefined
}

function addArg(args: string[], value: string): void {
  if (!args.includes(value)) args.push(value)
}

export function preparePtyRuntimeLaunch(
  agent: AgentType,
  profile: AgentRuntimeProfile = 'full',
  baseArgs: readonly string[] = [],
  baseEnv?: Record<string, string>,
): PreparedRuntimeLaunch {
  const args = [...baseArgs]
  const env = { ...(baseEnv ?? {}) }

  if (profile === 'full' || agent === 'shell') {
    return { args, env: Object.keys(env).length > 0 ? env : undefined }
  }

  if (agent === 'claude') {
    env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = '4'
    env.MCP_SERVER_CONNECTION_BATCH_SIZE = '1'
    env.ENABLE_TOOL_SEARCH = 'true'
    if (profile === 'diagnostic') addArg(args, '--safe-mode')
  }

  // `args[0] === 'exec'` is the one-shot form: run the task from argv and exit.
  if (agent === 'codex' && args[0] !== 'exec') {
    // Evita o buffer alternativo pesado e mantém o histórico no host. O Codex
    // ainda não oferece um safe-mode genérico equivalente ao do Claude.
    //
    // Interactive TUI only. `codex exec` rejects it outright ("unexpected
    // argument '--no-alt-screen'") and exits before printing anything, which
    // reads as a spawned agent that never opened at all.
    addArg(args, '--no-alt-screen')
  }

  return { args, env: Object.keys(env).length > 0 ? env : undefined }
}

import { invoke } from '@tauri-apps/api/core'

import type { ControlCapability } from '../orchestrator/scope'

// --- Control plane (control_api.rs) ---

/**
 * What a terminal needs to reach the control plane. The scope is deliberately
 * absent: the terminal learns its own identity from the server (`alethe_whoami`)
 * instead of being told twice.
 */
export type ControlTokenInfo = {
  token: string
  /** Base listener endpoint, e.g. `http://127.0.0.1:9123`. */
  endpoint: string
  capabilities: ControlCapability[]
}

/** Issues the control token of a terminal, replacing any previous one it held. */
export async function controlTokenMint(input: {
  terminalId: string
  projectId: string
  groupId: string | null
  orchestrator: boolean
}): Promise<ControlTokenInfo> {
  return invoke<ControlTokenInfo>('control_token_mint', {
    terminalId: input.terminalId,
    projectId: input.projectId,
    groupId: input.groupId,
    orchestrator: input.orchestrator,
  })
}

/** Drops every token a terminal held. Returns how many were dropped. */
export async function controlTokenRevoke(terminalId: string): Promise<number> {
  return invoke<number>('control_token_revoke', { terminalId })
}

// --- MCP injection per CLI (orchestrator_config.rs) ---

/**
 * Writes the temporary MCP config registering Alethe for one Claude terminal
 * and returns its path, for `--mcp-config <path>`. One file per terminal: each
 * one carries its own token.
 */
export async function orchestratorClaudeMcpConfigPath(input: {
  terminalId: string
  endpoint: string
  token: string
}): Promise<string> {
  return invoke<string>('orchestrator_claude_mcp_config_path', input)
}

export type CodexOrchestratorLaunch = {
  /** Leading CLI arguments; must precede any subcommand (`resume`). */
  args: string[]
  /** Env var the token has to be exported under for Codex to read it. */
  tokenEnvVar: string
}

/**
 * Codex accepts no arbitrary MCP headers, so it is configured entirely through
 * `-c` overrides plus a bearer token read from the environment — nothing is
 * written to disk for this CLI.
 */
export async function orchestratorCodexLaunch(
  endpoint: string,
): Promise<CodexOrchestratorLaunch> {
  return invoke<CodexOrchestratorLaunch>('orchestrator_codex_launch', { endpoint })
}

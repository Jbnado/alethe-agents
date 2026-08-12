import type { AgentType } from './types'

export type AgentLaunch = {
  args: string[]
  sessionId?: string
  createdSession: boolean
}

function stripFlagWithValue(args: string[], flags: ReadonlySet<string>): string[] {
  const clean: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (flags.has(args[index])) {
      index++
      continue
    }
    clean.push(args[index])
  }
  return clean
}

function stripClaudeSessionArgs(args: string[]): string[] {
  return stripFlagWithValue(args, new Set(['--resume', '-r', '--session-id'])).filter(
    (arg) => arg !== '--continue' && arg !== '-c',
  )
}

function stripCodexSessionArgs(args: string[]): string[] {
  if (args[0] !== 'resume') return [...args]
  const rest = args.slice(1)
  if (rest[0] === '--last' || (rest[0] && !rest[0].startsWith('-'))) rest.shift()
  return rest
}

function stripOpenCodeSessionArgs(args: string[]): string[] {
  return stripFlagWithValue(args, new Set(['--session', '-s'])).filter(
    (arg) => arg !== '--continue' && arg !== '-c' && arg !== '--resume',
  )
}

function stripAntigravitySessionArgs(args: string[]): string[] {
  return stripFlagWithValue(args, new Set(['--conversation'])).filter(
    (arg) => arg !== '--continue' && arg !== '-c',
  )
}

/**
 * Produz os argumentos de sessão sem depender de "a conversa mais recente".
 * Claude permite escolher o UUID no nascimento; Codex/OpenCode só recebem um
 * argumento de resume quando o pane já possui um ID conhecido.
 */
export function buildAgentLaunch(
  agent: AgentType,
  baseArgs: readonly string[] = [],
  sessionId?: string,
  createUuid: () => string = () => crypto.randomUUID(),
  // Quando um servidor MCP gerenciado pelo Alethe está habilitado (Graphify e/ou
  // ai-memory), geramos um arquivo `.mcp` por servidor (ver *McpConfigPath) e o
  // injetamos aqui. Só o Claude Code usa flag de spawn (`--mcp-config`, aceita
  // repetida — por isso é uma LISTA, para os servers coexistirem sem um
  // sobrescrever o outro) — Codex e OpenCode leem MCP de um arquivo de config
  // AMBIENTE no próprio projeto (`.codex/config.toml` / `opencode.json`), escrito
  // ANTES do spawn (XTermView), não por flag aqui. Arquitetura correta dos 3 CLIs.
  mcpConfigPaths?: readonly string[],
  // Global CLI flags that must come BEFORE any subcommand. Only Codex needs
  // them: it has no `--mcp-config` equivalent, so the Alethe MCP server is
  // registered through `-c` overrides (see `orchestrator_config.rs`), and `-c`
  // belongs to the root command — placing it after `resume` would not parse.
  leadingArgs?: readonly string[],
): AgentLaunch {
  if (agent === 'shell') {
    return { args: [...baseArgs], sessionId: undefined, createdSession: false }
  }

  if (agent === 'claude') {
    const clean = stripClaudeSessionArgs([...baseArgs])
    const mcp = (mcpConfigPaths ?? []).flatMap((path) => ['--mcp-config', path])
    if (sessionId) {
      return {
        args: ['--resume', sessionId, ...mcp, ...clean],
        sessionId,
        createdSession: false,
      }
    }
    const createdId = createUuid()
    return {
      args: ['--session-id', createdId, ...mcp, ...clean],
      sessionId: createdId,
      createdSession: true,
    }
  }

  if (agent === 'codex') {
    const clean = stripCodexSessionArgs([...baseArgs])
    const leading = [...(leadingArgs ?? [])]
    return {
      args: sessionId ? [...leading, 'resume', sessionId, ...clean] : [...leading, ...clean],
      sessionId,
      createdSession: false,
    }
  }

  if (agent === 'opencode') {
    const clean = stripOpenCodeSessionArgs([...baseArgs])
    // --session <id> explícito sempre — nunca --continue, que não é por
    // terminal (pega "a última sessão do OpenCode" pro cwd inteiro e colide
    // entre panes). O ID vem de sessionDiscovery.claimMostRecentSession,
    // reivindicado antes do spawn.
    return {
      args: sessionId ? ['--session', sessionId, ...clean] : clean,
      sessionId,
      createdSession: false,
    }
  }

  if (agent === 'antigravity') {
    const clean = stripAntigravitySessionArgs([...baseArgs])
    return {
      args: sessionId ? ['--conversation', sessionId, ...clean] : clean,
      sessionId,
      createdSession: false,
    }
  }

  // freebuff/mimo (e qualquer agente sem sintaxe própria de resume): só executa o
  // binário com os args base. freebuff não documenta flag de resume; o Mimo Code
  // retoma a sessão automaticamente via memória persistente, sem flag.
  return { args: [...baseArgs], sessionId: undefined, createdSession: false }
}

/**
 * Neutral, dependency-free helpers for running an agent CLI in one-shot mode
 * and for reading back what it printed. Kept out of any POC module so any
 * feature that drives an agent process can rely on them.
 */
import { UNRESTRICTED_FLAG, type AgentType } from './types'

/** Strip terminal control sequences and return the tail of a worker's output. */
export function tailSummary(raw: string, max = 320): string {
  const clean = raw
    // CSI: ESC [ ... letra final
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    // OSC: ESC ] ... (BEL ou ESC backslash)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // outros escapes ESC de 1 char
    .replace(/\x1b[@-Z\\-_]/g, '')
    // bytes de controle restantes (preserva \n e \t)
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
  return clean.length > max ? `…${clean.slice(-max)}` : clean
}

export type ExecArgsOptions = {
  /**
   * Append the agent's skip-permissions flag.
   *
   * Off by default so existing callers keep their behaviour. Placement is
   * per-agent and deliberate: the flag has to precede the positional prompt,
   * because `codex exec [OPTIONS] PROMPT` stops reading options once it has
   * consumed the prompt.
   */
  unrestricted?: boolean
}

/**
 * One-shot `extraArgs` per agent: run a task from argv and exit, without
 * depending on the TUI.
 */
export function execArgsFor(
  agent: AgentType,
  task: string,
  options: ExecArgsOptions = {},
): string[] | undefined {
  const skip = options.unrestricted ? UNRESTRICTED_FLAG[agent] : null
  const unrestricted = skip ? [skip] : []
  switch (agent) {
    case 'codex':
      // `--skip-git-repo-check` alone is not enough: `codex exec` also refuses to
      // run inside a directory it does not trust, and a freshly provisioned
      // worktree never is — without the bypass the process exits before it
      // starts, looking exactly like "the terminal never opened".
      return ['exec', '--skip-git-repo-check', ...unrestricted, task]
    case 'claude':
      // headless: -p roda a task e sai; sem permissões pra não travar no prompt.
      // Unconditional here: a `-p` run has no TUI to answer an approval prompt,
      // so gating it would hang forever rather than protect anyone.
      return ['-p', task, '--dangerously-skip-permissions']
    case 'opencode':
      return ['run', ...unrestricted, task]
    default:
      return undefined
  }
}

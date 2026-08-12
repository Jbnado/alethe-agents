/**
 * Delivery of an initial prompt to an agent CLI that has just booted.
 *
 * A freshly spawned CLI is not ready the moment its PTY exists: it is still
 * printing its banner, mounting its TUI and moving the cursor around. Text
 * written into that window gets eaten or lands in the wrong widget. There is no
 * portable "ready" signal across Claude/Codex/OpenCode, so readiness is inferred
 * from PTY quietness, with a floor, a time-based fallback and a hard deadline so
 * a CLI that never stops redrawing still gets its prompt.
 *
 * Every IO dependency is injected: this module never imports the Tauri bridge,
 * so it runs unchanged under Node with controlled timers.
 */

/** Poll interval while watching the PTY for a quiet stretch. */
export const PROMPT_POLL_MS = 250
/** Quiet stretch (no PTY output) that counts as "the CLI settled". */
export const PROMPT_QUIET_MS = 700
/** Floor: never send before this, even if the CLI printed nothing at all. */
export const PROMPT_EARLIEST_SEND_MS = 1_500
/** Fallback: send anyway once this elapses, for CLIs that redraw forever. */
export const PROMPT_TIMED_SEND_MS = 4_000
/** Hard cap on the readiness wait; past it the prompt goes out regardless. */
export const PROMPT_DEADLINE_MS = 10_000
/** Gap between the pasted block and the Enter that submits it. */
export const PROMPT_SUBMIT_DELAY_MS = 150
/** Enter is repeated once: some TUIs swallow the first one while mounting. */
export const PROMPT_SUBMIT_RETRY_MS = 1_200
/** Key written to submit the prompt. */
export const PROMPT_SUBMIT_KEY = '\r'

/** What the caller knows about the PTY at a given instant. */
export type PromptDeliveryRuntime = {
  /** False once the PTY died; a dead PTY is never worth writing to. */
  alive: boolean
  /** Timestamp of the last byte seen on the PTY. */
  lastIoAt: number
}

export type PromptDeliveryDeps = {
  /** Current PTY runtime, or undefined while it is not registered yet. */
  getRuntime: () => PromptDeliveryRuntime | undefined
  /** Write a whole block, wrapped in bracketed paste when requested. */
  writeChunked: (text: string, bracketed: boolean) => Promise<void>
  /** Write raw bytes; used for the submit key, which must stay out of the block. */
  write: (text: string) => Promise<void>
  /** True once the caller no longer wants the prompt delivered. */
  isDisposed?: () => boolean
  /** Called once, only after the prompt actually went out. */
  onSent?: () => void
  /** Called instead of `onSent` when a write failed. */
  onError?: (error: unknown) => void
  now?: () => number
  delay?: (ms: number) => Promise<void>
  schedule?: (run: () => void, ms: number) => void
}

const defaultNow = () => Date.now()
const defaultDelay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const defaultSchedule = (run: () => void, ms: number) => {
  setTimeout(run, ms)
}

/**
 * Block until the CLI looks ready for input, or until the hard deadline.
 * Resolves `false` when the caller disposed while waiting.
 */
export async function waitForPromptWindow(deps: PromptDeliveryDeps): Promise<boolean> {
  const now = deps.now ?? defaultNow
  const delay = deps.delay ?? defaultDelay
  const isDisposed = deps.isDisposed ?? (() => false)

  const startedAt = now()
  const earliestSendAt = startedAt + PROMPT_EARLIEST_SEND_MS
  const timedSendAt = startedAt + PROMPT_TIMED_SEND_MS
  const deadline = startedAt + PROMPT_DEADLINE_MS

  while (!isDisposed() && now() < deadline) {
    await delay(PROMPT_POLL_MS)
    const runtime = deps.getRuntime()
    const at = now()
    const quietFor = runtime ? at - runtime.lastIoAt : 0
    if (
      at >= earliestSendAt &&
      runtime?.alive &&
      (quietFor >= PROMPT_QUIET_MS || at >= timedSendAt)
    ) {
      break
    }
  }
  return !isDisposed()
}

/**
 * Wait for the CLI to settle, paste `prompt` as a single bracketed block, then
 * submit it with a separate Enter. Keeping Enter out of the block matters:
 * inside it, a TUI treats the newline as part of the pasted text instead of a
 * submit. Resolves `true` once the prompt was handed over — `onSent` fires
 * exactly once in that case, which is what makes the caller's "clear the
 * pending initial input" step idempotent.
 */
export async function deliverPrompt(prompt: string, deps: PromptDeliveryDeps): Promise<boolean> {
  const delay = deps.delay ?? defaultDelay
  const schedule = deps.schedule ?? defaultSchedule

  if (!(await waitForPromptWindow(deps))) return false

  try {
    await deps.writeChunked(prompt, true)
    await delay(PROMPT_SUBMIT_DELAY_MS)
    await deps.write(PROMPT_SUBMIT_KEY)
    schedule(() => {
      void deps.write(PROMPT_SUBMIT_KEY).catch(() => {})
    }, PROMPT_SUBMIT_RETRY_MS)
    deps.onSent?.()
    return true
  } catch (error) {
    deps.onError?.(error)
    return false
  }
}

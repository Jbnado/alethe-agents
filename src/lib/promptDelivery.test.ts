import { describe, expect, it, vi } from 'vitest'

import {
  deliverPrompt,
  PROMPT_DEADLINE_MS,
  PROMPT_EARLIEST_SEND_MS,
  PROMPT_POLL_MS,
  PROMPT_SUBMIT_DELAY_MS,
  PROMPT_SUBMIT_RETRY_MS,
  PROMPT_TIMED_SEND_MS,
  type PromptDeliveryDeps,
  type PromptDeliveryRuntime,
} from './promptDelivery'

type Harness = {
  deps: PromptDeliveryDeps
  /** Ordered log of every IO the module performed. */
  writes: Array<{ at: number; kind: 'block' | 'raw'; text: string; bracketed?: boolean }>
  /** Virtual clock, advanced only by the injected `delay`/`schedule`. */
  clock: () => number
  runScheduled: () => void
  sent: () => number
  errors: unknown[]
}

/**
 * Deterministic clock: time only moves when the module awaits a delay, so every
 * assertion below is about the algorithm, never about wall-clock timing.
 */
function harness(
  options: {
    /** Runtime seen on each poll, as a function of the virtual clock. */
    runtime?: (at: number) => PromptDeliveryRuntime | undefined
    disposeAt?: number
    writeChunked?: (text: string, bracketed: boolean) => Promise<void>
    write?: (text: string) => Promise<void>
  } = {},
): Harness {
  let now = 0
  const writes: Harness['writes'] = []
  const errors: unknown[] = []
  const scheduled: Array<{ at: number; run: () => void }> = []
  let sent = 0
  const runtime = options.runtime ?? (() => ({ alive: true, lastIoAt: 0 }))

  const deps: PromptDeliveryDeps = {
    getRuntime: () => runtime(now),
    writeChunked:
      options.writeChunked ??
      (async (text, bracketed) => {
        writes.push({ at: now, kind: 'block', text, bracketed })
      }),
    write:
      options.write ??
      (async (text) => {
        writes.push({ at: now, kind: 'raw', text })
      }),
    isDisposed: () => options.disposeAt !== undefined && now >= options.disposeAt,
    onSent: () => {
      sent += 1
    },
    onError: (error) => errors.push(error),
    now: () => now,
    delay: async (ms) => {
      now += ms
    },
    schedule: (run, ms) => scheduled.push({ at: now + ms, run }),
  }

  return {
    deps,
    writes,
    clock: () => now,
    runScheduled: () => {
      for (const task of scheduled.splice(0)) {
        now = task.at
        task.run()
      }
    },
    sent: () => sent,
    errors,
  }
}

describe('deliverPrompt', () => {
  it('sends once the PTY has been quiet long enough', async () => {
    // Boots noisily for 1s, then goes silent: the first poll past the floor
    // that also sees PROMPT_QUIET_MS of silence releases the prompt.
    const h = harness({ runtime: (at) => ({ alive: true, lastIoAt: Math.min(at, 1_000) }) })

    await expect(deliverPrompt('hello', h.deps)).resolves.toBe(true)

    expect(h.writes[0]).toMatchObject({ at: 1_750, kind: 'block', text: 'hello' })
    expect(h.sent()).toBe(1)
  })

  it('does not send before the floor even when the PTY was silent from the start', async () => {
    const h = harness({ runtime: () => ({ alive: true, lastIoAt: -10_000 }) })

    await deliverPrompt('hello', h.deps)

    expect(h.writes[0]?.at).toBeGreaterThanOrEqual(PROMPT_EARLIEST_SEND_MS)
    // First poll at or past the floor, not the poll before it.
    expect(h.writes[0]?.at).toBeLessThan(PROMPT_EARLIEST_SEND_MS + PROMPT_POLL_MS)
  })

  it('falls back to the time-based send when the output never stops', async () => {
    // A CLI that redraws on every frame never produces a quiet window.
    const h = harness({ runtime: (at) => ({ alive: true, lastIoAt: at }) })

    await expect(deliverPrompt('hello', h.deps)).resolves.toBe(true)

    expect(h.writes[0]?.at).toBe(PROMPT_TIMED_SEND_MS)
    expect(h.sent()).toBe(1)
  })

  it('sends anyway at the hard deadline when the PTY never reports alive', async () => {
    // `alive` false blocks every readiness branch, so only the deadline ends
    // the wait — and the prompt still goes out.
    const h = harness({ runtime: (at) => ({ alive: false, lastIoAt: at }) })

    await expect(deliverPrompt('hello', h.deps)).resolves.toBe(true)

    expect(h.writes[0]?.at).toBe(PROMPT_DEADLINE_MS)
  })

  it('keeps waiting while the runtime is not registered yet', async () => {
    // Undefined runtime must not read as "quiet": the prompt only goes out
    // after the PTY is registered and then stays silent.
    const h = harness({
      runtime: (at) => (at < 2_000 ? undefined : { alive: true, lastIoAt: 2_000 }),
    })

    await deliverPrompt('hello', h.deps)

    // Quiet since 2000, so the first poll at or past 2700 wins: 2750.
    expect(h.writes[0]?.at).toBe(2_750)
  })

  it('aborts without writing anything when disposed while waiting', async () => {
    const h = harness({
      runtime: (at) => ({ alive: true, lastIoAt: at }),
      disposeAt: 2_000,
    })

    await expect(deliverPrompt('hello', h.deps)).resolves.toBe(false)

    expect(h.writes).toEqual([])
    expect(h.sent()).toBe(0)
  })

  it('never sends when disposed before the first poll', async () => {
    const h = harness({ disposeAt: 0 })

    await expect(deliverPrompt('hello', h.deps)).resolves.toBe(false)

    expect(h.writes).toEqual([])
    expect(h.clock()).toBe(0)
  })

  it('pastes the prompt as one bracketed block and submits with a separate Enter', async () => {
    const h = harness({ runtime: () => ({ alive: true, lastIoAt: 0 }) })

    await deliverPrompt('line one\nline two', h.deps)

    const blockAt = h.writes[0].at
    expect(h.writes[0]).toMatchObject({
      kind: 'block',
      text: 'line one\nline two',
      bracketed: true,
    })
    expect(h.writes[1]).toEqual({ at: blockAt + PROMPT_SUBMIT_DELAY_MS, kind: 'raw', text: '\r' })
    expect(h.writes).toHaveLength(2)
  })

  it('retries Enter after the block, without repeating the prompt or onSent', async () => {
    const h = harness({ runtime: () => ({ alive: true, lastIoAt: 0 }) })

    await deliverPrompt('hello', h.deps)
    const enterAt = h.writes[1].at
    h.runScheduled()

    expect(h.writes[2]).toEqual({ at: enterAt + PROMPT_SUBMIT_RETRY_MS, kind: 'raw', text: '\r' })
    expect(h.writes.filter((w) => w.kind === 'block')).toHaveLength(1)
    expect(h.sent()).toBe(1)
  })

  it('reports the error and skips onSent when the block write fails', async () => {
    const failure = new Error('pty gone')
    const h = harness({
      runtime: () => ({ alive: true, lastIoAt: 0 }),
      writeChunked: () => Promise.reject(failure),
    })

    await expect(deliverPrompt('hello', h.deps)).resolves.toBe(false)

    expect(h.errors).toEqual([failure])
    expect(h.sent()).toBe(0)
  })

  it('swallows a failing Enter retry', async () => {
    const write = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('pty gone'))
    const h = harness({ runtime: () => ({ alive: true, lastIoAt: 0 }), write })

    await deliverPrompt('hello', h.deps)
    expect(() => h.runScheduled()).not.toThrow()

    expect(write).toHaveBeenCalledTimes(2)
    expect(h.errors).toEqual([])
  })
})

/**
 * Pure rules behind the memory-protection settings (Preferences > Terminal).
 *
 * The supervisor is hysteretic: once the PTY tree crosses `memoryBudgetMb` it
 * only leaves the critical state after dropping below `recoveryTargetMb`, and
 * every spawn stays queued in between. That makes the three numbers a single
 * coupled setting — clamping them independently is what let a machine sit at
 * 1166 MB with a 1536 MB budget and a 1152 MB recovery target, permanently
 * critical and 14 MB away from ever recovering. Raising the budget alone made
 * it worse, because the recovery target stayed where it was.
 *
 * So the budget is the only number the user really has to pick, the other two
 * follow it by ratio, and the ceiling is a share of the machine's own RAM
 * instead of a constant that is reckless on 8 GB and pointlessly strict on 64.
 */

/** Lowest hard budget the UI accepts, in MB. */
export const MEMORY_BUDGET_MIN_MB = 768

/** Budget ceiling used when the machine's physical RAM cannot be read. */
export const MEMORY_BUDGET_FALLBACK_MAX_MB = 8192

/** Share of physical RAM the hard budget may never exceed. */
export const MEMORY_BUDGET_SYSTEM_SHARE = 0.5

/** Budgets strictly above this need an explicit confirmation before applying. */
export const MEMORY_BUDGET_CONFIRM_ABOVE_MB = 4096

/** Warning threshold as a share of the hard budget. */
export const WARNING_THRESHOLD_RATIO = 0.8

/** Recovery target as a share of the hard budget. */
export const RECOVERY_TARGET_RATIO = 0.75

/** Minimum distance between budget > warning > recovery, in MB. */
export const THRESHOLD_GAP_MB = 64

const WARNING_MIN_MB = 512
const RECOVERY_MIN_MB = 384
const AGENT_IDLE_MIN_MINUTES = 5
const AGENT_IDLE_MAX_MINUTES = 240
const SHELL_IDLE_MIN_MINUTES = 5
const SHELL_IDLE_MAX_MINUTES = 480

/**
 * Rounds and clamps. `max` deliberately wins over `min` when the range is
 * inverted (a budget near the floor leaves no room for the 64 MB gaps), which
 * keeps the ordering invariant budget > warning > recovery true at all times.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

/** The tunable numbers of `ResourcePolicyPreferences` this module governs. */
export type ResourcePolicyTunables = {
  memoryBudgetMb: number
  warningThresholdMb: number
  recoveryTargetMb: number
  hiddenAgentIdleMinutes: number
  hiddenShellIdleMinutes: number
}

/**
 * Highest budget the UI offers: half of the machine's physical RAM, never
 * below the floor. Falls back to a fixed ceiling when `systemTotalMb` is
 * missing, so a failed metrics read degrades the limit instead of the UI.
 */
export function maxMemoryBudgetMb(systemTotalMb: number | null | undefined): number {
  if (typeof systemTotalMb !== 'number' || !Number.isFinite(systemTotalMb) || systemTotalMb <= 0) {
    return MEMORY_BUDGET_FALLBACK_MAX_MB
  }
  return Math.max(MEMORY_BUDGET_MIN_MB, Math.floor(systemTotalMb * MEMORY_BUDGET_SYSTEM_SHARE))
}

/** Clamps a candidate budget into `[floor, maxBudgetMb]`. */
export function clampMemoryBudgetMb(
  budgetMb: number,
  maxBudgetMb: number = MEMORY_BUDGET_FALLBACK_MAX_MB,
): number {
  const ceiling = Math.max(MEMORY_BUDGET_MIN_MB, Math.round(maxBudgetMb))
  return clamp(budgetMb, MEMORY_BUDGET_MIN_MB, ceiling)
}

/** Warning and recovery values implied by a budget, before any clamping. */
export function deriveThresholds(budgetMb: number): {
  warningThresholdMb: number
  recoveryTargetMb: number
} {
  return {
    warningThresholdMb: Math.round(budgetMb * WARNING_THRESHOLD_RATIO),
    recoveryTargetMb: Math.round(budgetMb * RECOVERY_TARGET_RATIO),
  }
}

/**
 * Applies a settings edit and returns the whole policy, normalized.
 *
 * Changing the budget re-derives warning and recovery, so the critical band
 * always scales with the ceiling; every other field is left where the user put
 * it. Values named explicitly in `patch` always win, which is what keeps the
 * two derived fields hand-editable.
 */
export function applyResourcePolicyPatch<T extends ResourcePolicyTunables>(
  current: T,
  patch: Partial<T>,
  maxBudgetMb: number = MEMORY_BUDGET_FALLBACK_MAX_MB,
): T {
  const next = { ...current, ...patch }

  next.memoryBudgetMb = clampMemoryBudgetMb(
    finiteOr(next.memoryBudgetMb, current.memoryBudgetMb),
    maxBudgetMb,
  )

  if (next.memoryBudgetMb !== current.memoryBudgetMb) {
    const derived = deriveThresholds(next.memoryBudgetMb)
    if (patch.warningThresholdMb === undefined) {
      next.warningThresholdMb = derived.warningThresholdMb
    }
    if (patch.recoveryTargetMb === undefined) {
      next.recoveryTargetMb = derived.recoveryTargetMb
    }
  }

  next.warningThresholdMb = clamp(
    finiteOr(next.warningThresholdMb, current.warningThresholdMb),
    WARNING_MIN_MB,
    next.memoryBudgetMb - THRESHOLD_GAP_MB,
  )
  next.recoveryTargetMb = clamp(
    finiteOr(next.recoveryTargetMb, current.recoveryTargetMb),
    RECOVERY_MIN_MB,
    next.warningThresholdMb - THRESHOLD_GAP_MB,
  )
  next.hiddenAgentIdleMinutes = clamp(
    finiteOr(next.hiddenAgentIdleMinutes, current.hiddenAgentIdleMinutes),
    AGENT_IDLE_MIN_MINUTES,
    AGENT_IDLE_MAX_MINUTES,
  )
  next.hiddenShellIdleMinutes = clamp(
    finiteOr(next.hiddenShellIdleMinutes, current.hiddenShellIdleMinutes),
    SHELL_IDLE_MIN_MINUTES,
    SHELL_IDLE_MAX_MINUTES,
  )

  return next
}

/**
 * True when a budget change is large enough to deserve an explicit decision.
 * A budget that does not actually move never asks.
 */
export function needsBudgetConfirmation(nextBudgetMb: number, currentBudgetMb: number): boolean {
  return nextBudgetMb !== currentBudgetMb && nextBudgetMb > MEMORY_BUDGET_CONFIRM_ABOVE_MB
}

export type BudgetShare = {
  budgetGb: number
  /** null when physical RAM could not be read. */
  totalGb: number | null
  /** Whole percent of physical RAM, or null when it could not be read. */
  percentOfSystem: number | null
}

/** MB restated as GB with a single decimal, for display copy. */
export function mbToGb(mb: number): number {
  return Math.round((mb / 1024) * 10) / 10
}

/** Restates a budget as GB and as a share of the machine, for the confirmation copy. */
export function describeBudgetShare(
  budgetMb: number,
  systemTotalMb: number | null | undefined,
): BudgetShare {
  const budgetGb = mbToGb(budgetMb)
  if (typeof systemTotalMb !== 'number' || !Number.isFinite(systemTotalMb) || systemTotalMb <= 0) {
    return { budgetGb, totalGb: null, percentOfSystem: null }
  }
  return {
    budgetGb,
    totalGb: mbToGb(systemTotalMb),
    percentOfSystem: Math.round((budgetMb / systemTotalMb) * 100),
  }
}

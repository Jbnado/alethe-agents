import { describe, expect, it } from 'vitest'

import {
  applyResourcePolicyPatch,
  clampMemoryBudgetMb,
  deriveThresholds,
  describeBudgetShare,
  maxMemoryBudgetMb,
  MEMORY_BUDGET_FALLBACK_MAX_MB,
  MEMORY_BUDGET_MIN_MB,
  needsBudgetConfirmation,
  type ResourcePolicyTunables,
} from './resourcePolicy'

/** The shipped defaults, which are also the values the reported bug ran with. */
const DEFAULTS: ResourcePolicyTunables = {
  memoryBudgetMb: 1536,
  warningThresholdMb: 1229,
  recoveryTargetMb: 1152,
  hiddenAgentIdleMinutes: 15,
  hiddenShellIdleMinutes: 30,
}

describe('maxMemoryBudgetMb', () => {
  it('is half of the machine physical RAM', () => {
    expect(maxMemoryBudgetMb(32768)).toBe(16384)
    expect(maxMemoryBudgetMb(8192)).toBe(4096)
  })

  it('rounds a fractional half down, never up', () => {
    expect(maxMemoryBudgetMb(15693)).toBe(7846)
  })

  it('falls back to the fixed ceiling when the total is unavailable', () => {
    expect(maxMemoryBudgetMb(null)).toBe(MEMORY_BUDGET_FALLBACK_MAX_MB)
    expect(maxMemoryBudgetMb(undefined)).toBe(MEMORY_BUDGET_FALLBACK_MAX_MB)
    expect(maxMemoryBudgetMb(0)).toBe(MEMORY_BUDGET_FALLBACK_MAX_MB)
    expect(maxMemoryBudgetMb(Number.NaN)).toBe(MEMORY_BUDGET_FALLBACK_MAX_MB)
  })

  it('never drops below the budget floor on a tiny machine', () => {
    expect(maxMemoryBudgetMb(1024)).toBe(MEMORY_BUDGET_MIN_MB)
  })
})

describe('clampMemoryBudgetMb', () => {
  it('respects the 768 MB floor', () => {
    expect(clampMemoryBudgetMb(0, 8192)).toBe(MEMORY_BUDGET_MIN_MB)
    expect(clampMemoryBudgetMb(-4096, 8192)).toBe(MEMORY_BUDGET_MIN_MB)
  })

  it('caps at the machine-derived ceiling', () => {
    expect(clampMemoryBudgetMb(60000, maxMemoryBudgetMb(16384))).toBe(8192)
  })

  it('keeps the floor even when the ceiling would be lower', () => {
    expect(clampMemoryBudgetMb(4096, 512)).toBe(MEMORY_BUDGET_MIN_MB)
  })
})

describe('deriveThresholds', () => {
  it('is 80% warning and 75% recovery of the budget', () => {
    expect(deriveThresholds(1536)).toEqual({ warningThresholdMb: 1229, recoveryTargetMb: 1152 })
    expect(deriveThresholds(4096)).toEqual({ warningThresholdMb: 3277, recoveryTargetMb: 3072 })
  })
})

describe('applyResourcePolicyPatch', () => {
  it('re-derives warning and recovery when the budget changes', () => {
    const next = applyResourcePolicyPatch(DEFAULTS, { memoryBudgetMb: 3072 }, 16384)
    expect(next.memoryBudgetMb).toBe(3072)
    expect(next.warningThresholdMb).toBe(2458)
    expect(next.recoveryTargetMb).toBe(2304)
  })

  it('fixes the reported dead zone: 1536 -> 4096 moves recovery off 1152', () => {
    const next = applyResourcePolicyPatch(DEFAULTS, { memoryBudgetMb: 4096 }, 16384)
    expect(next.memoryBudgetMb).toBe(4096)
    expect(next.recoveryTargetMb).toBe(3072)
    expect(next.recoveryTargetMb).not.toBe(DEFAULTS.recoveryTargetMb)
    // A 1166 MB PTY tree used to sit above the old 1152 target forever; with the
    // raised budget it is now comfortably inside the recovery band.
    expect(1166).toBeLessThan(next.recoveryTargetMb)
  })

  it('re-derives downwards too, so lowering the budget cannot strand the thresholds', () => {
    const raised = applyResourcePolicyPatch(DEFAULTS, { memoryBudgetMb: 8192 }, 16384)
    const lowered = applyResourcePolicyPatch(raised, { memoryBudgetMb: 2048 }, 16384)
    expect(lowered.warningThresholdMb).toBe(1638)
    expect(lowered.recoveryTargetMb).toBe(1536)
  })

  it('does not re-derive when the budget is re-submitted unchanged', () => {
    const tuned = { ...DEFAULTS, warningThresholdMb: 1100, recoveryTargetMb: 900 }
    const next = applyResourcePolicyPatch(tuned, { memoryBudgetMb: 1536 }, 16384)
    expect(next.warningThresholdMb).toBe(1100)
    expect(next.recoveryTargetMb).toBe(900)
  })

  it('leaves the other fields alone when the warning is edited by hand', () => {
    const next = applyResourcePolicyPatch(DEFAULTS, { warningThresholdMb: 1000 }, 16384)
    expect(next.memoryBudgetMb).toBe(DEFAULTS.memoryBudgetMb)
    expect(next.warningThresholdMb).toBe(1000)
    expect(next.recoveryTargetMb).toBe(936) // only clamped to warning - 64
  })

  it('leaves the other fields alone when the recovery target is edited by hand', () => {
    const next = applyResourcePolicyPatch(DEFAULTS, { recoveryTargetMb: 900 }, 16384)
    expect(next.memoryBudgetMb).toBe(DEFAULTS.memoryBudgetMb)
    expect(next.warningThresholdMb).toBe(DEFAULTS.warningThresholdMb)
    expect(next.recoveryTargetMb).toBe(900)
  })

  it('lets an explicit threshold in the same patch win over the derived one', () => {
    const next = applyResourcePolicyPatch(
      DEFAULTS,
      { memoryBudgetMb: 4096, warningThresholdMb: 2000 },
      16384,
    )
    expect(next.warningThresholdMb).toBe(2000)
    expect(next.recoveryTargetMb).toBe(1936) // derived 3072, clamped to warning - 64
  })

  it('keeps the 64 MB gaps between budget, warning and recovery', () => {
    const next = applyResourcePolicyPatch(DEFAULTS, { warningThresholdMb: 99999 }, 16384)
    expect(next.warningThresholdMb).toBe(next.memoryBudgetMb - 64)
    expect(next.recoveryTargetMb).toBeLessThanOrEqual(next.warningThresholdMb - 64)
  })

  it('keeps the gaps after a derived change too', () => {
    for (const budget of [768, 1024, 1536, 4096, 8192]) {
      const next = applyResourcePolicyPatch(DEFAULTS, { memoryBudgetMb: budget }, 16384)
      expect(next.warningThresholdMb).toBeLessThanOrEqual(next.memoryBudgetMb - 64)
      expect(next.recoveryTargetMb).toBeLessThanOrEqual(next.warningThresholdMb - 64)
    }
  })

  it('caps the budget at the machine ceiling and derives from the capped value', () => {
    const next = applyResourcePolicyPatch(
      DEFAULTS,
      { memoryBudgetMb: 60000 },
      maxMemoryBudgetMb(8192),
    )
    expect(next.memoryBudgetMb).toBe(4096)
    expect(next.recoveryTargetMb).toBe(3072)
  })

  it('clamps the idle windows', () => {
    const next = applyResourcePolicyPatch(
      DEFAULTS,
      { hiddenAgentIdleMinutes: 9999, hiddenShellIdleMinutes: 0 },
      16384,
    )
    expect(next.hiddenAgentIdleMinutes).toBe(240)
    expect(next.hiddenShellIdleMinutes).toBe(5)
  })

  it('ignores a non-numeric edit instead of persisting NaN', () => {
    const next = applyResourcePolicyPatch(DEFAULTS, { memoryBudgetMb: Number.NaN }, 16384)
    expect(next).toEqual(DEFAULTS)
  })

  it('preserves fields it does not own', () => {
    const policy = { ...DEFAULTS, mode: 'smart-lru' as const, spawnGraceSeconds: 120 }
    const next = applyResourcePolicyPatch(policy, { memoryBudgetMb: 2048 }, 16384)
    expect(next.mode).toBe('smart-lru')
    expect(next.spawnGraceSeconds).toBe(120)
  })
})

describe('needsBudgetConfirmation', () => {
  it('asks above 4096 MB', () => {
    expect(needsBudgetConfirmation(4224, 1536)).toBe(true)
  })

  it('does not ask at or below 4096 MB', () => {
    expect(needsBudgetConfirmation(4096, 1536)).toBe(false)
    expect(needsBudgetConfirmation(2048, 1536)).toBe(false)
  })

  it('does not ask when the budget did not actually move', () => {
    expect(needsBudgetConfirmation(6144, 6144)).toBe(false)
  })
})

describe('describeBudgetShare', () => {
  it('reports the budget as GB and as a share of the machine', () => {
    expect(describeBudgetShare(4608, 15794)).toEqual({
      budgetGb: 4.5,
      totalGb: 15.4,
      percentOfSystem: 29,
    })
  })

  it('omits the share when physical RAM is unknown', () => {
    expect(describeBudgetShare(6144, null)).toEqual({
      budgetGb: 6,
      totalGb: null,
      percentOfSystem: null,
    })
  })
})

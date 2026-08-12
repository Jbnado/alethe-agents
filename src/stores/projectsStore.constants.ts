/** Shared projects-store constants and clamps. */

import {
  ORCHESTRATOR_APPROVAL_ACTIONS,
  type OrchestratorAutoApprove,
} from '../lib/types'

const MIN_UI_ZOOM = 0.8
const MAX_UI_ZOOM = 1.4
const UI_ZOOM_STEP = 0.1

export const MAX_RECENT_PROJECT_TABS = 10

export function clampUiZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  const stepped = Math.round(zoom / UI_ZOOM_STEP) * UI_ZOOM_STEP
  const clamped = Math.min(MAX_UI_ZOOM, Math.max(MIN_UI_ZOOM, stepped))
  return Number(clamped.toFixed(2))
}

export const UI_ZOOM_LIMITS = {
  min: MIN_UI_ZOOM,
  max: MAX_UI_ZOOM,
  step: UI_ZOOM_STEP,
} as const

export const SPAWN_CONCURRENCY_LIMITS = { min: 1, max: 8, step: 1 } as const

export function clampSpawnConcurrency(n: number): number {
  if (!Number.isFinite(n)) return 3
  return Math.min(
    SPAWN_CONCURRENCY_LIMITS.max,
    Math.max(SPAWN_CONCURRENCY_LIMITS.min, Math.round(n)),
  )
}

export const ORCHESTRATOR_LIVE_AGENT_LIMITS = { min: 1, max: 8, step: 1, default: 3 } as const

export function clampOrchestratorMaxLiveAgents(n: number): number {
  if (!Number.isFinite(n)) return ORCHESTRATOR_LIVE_AGENT_LIMITS.default
  return Math.min(
    ORCHESTRATOR_LIVE_AGENT_LIMITS.max,
    Math.max(ORCHESTRATOR_LIVE_AGENT_LIMITS.min, Math.round(n)),
  )
}

/**
 * Every approval key present and boolean, defaulting to false.
 *
 * Rebuilt key by key rather than spread over the stored object on purpose: this
 * record decides whether an agent may act on the machine without asking, so a
 * value the file happens to carry — a string, a number, a key added by a later
 * version — must never be able to read as "yes".
 */
export function normalizeOrchestratorAutoApprove(raw: unknown): OrchestratorAutoApprove {
  const stored = (raw ?? {}) as Record<string, unknown>
  const result = {} as OrchestratorAutoApprove
  for (const action of ORCHESTRATOR_APPROVAL_ACTIONS) {
    result[action] = stored[action] === true
  }
  return result
}

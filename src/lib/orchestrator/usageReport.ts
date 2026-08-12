/**
 * Provider usage payloads, normalized to the windows the control plane reports.
 *
 * Pure and free of IO on purpose: the invariant that matters here is what does
 * NOT come out. Alethe reads usage windows and limits, never which subscription
 * pays for them, so a commercial plan name must never reach a caller — an agent
 * that repeated one would be stating a fact about the person's account that the
 * app has no standing to assert. Codex is the only provider that reports one,
 * and it is dropped here.
 */

import type { AntigravityUsage, ClaudeUsage, CodexUsage } from '../tauri/usage'
import type { AgentUsageReport, AgentUsageWindow } from './ops'

function claudeWindow(
  window: { utilization: number; resets_at: string },
  label: string,
): AgentUsageWindow {
  return { window: label, usedPercent: window.utilization, resetsAt: window.resets_at || null }
}

export function claudeUsageReport(usage: ClaudeUsage): AgentUsageReport {
  return {
    windows: [
      claudeWindow(usage.five_hour, '5h'),
      claudeWindow(usage.seven_day, '7d'),
      claudeWindow(usage.seven_day_opus, '7d-opus'),
    ],
    // Claude reports utilization only; a percentage near 100 is the signal.
    rateLimited: false,
  }
}

/** Codex reports a window as a duration in minutes; name it the way a human would. */
export function codexWindowLabel(minutes: number): string {
  if (!minutes || !Number.isFinite(minutes)) return 'window'
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

function codexWindow(window: {
  used_percent: number
  window_minutes: number
  resets_at_ms: number
}): AgentUsageWindow {
  return {
    window: codexWindowLabel(window.window_minutes),
    usedPercent: window.used_percent,
    // 0 means "the provider did not say", which is not the epoch.
    resetsAt: window.resets_at_ms > 0 ? new Date(window.resets_at_ms).toISOString() : null,
  }
}

/** Note what is not read: `usage.plan`. See the module comment. */
export function codexUsageReport(usage: CodexUsage): AgentUsageReport {
  return {
    windows: [codexWindow(usage.primary), codexWindow(usage.secondary)],
    rateLimited: usage.rate_limited,
  }
}

/**
 * Null for anything but `ready`: no CLI, no auth or no answer all leave the
 * numbers at zero, and reporting those would read as "plenty of quota left".
 */
export function antigravityUsageReport(usage: AntigravityUsage): AgentUsageReport | null {
  if (usage.status !== 'ready') return null
  const windows: AgentUsageWindow[] =
    usage.buckets.length > 0
      ? usage.buckets.map((bucket) => ({
          window: bucket.label,
          usedPercent: bucket.used_percent,
          resetsAt: bucket.resets_at || null,
        }))
      : [{ window: 'quota', usedPercent: usage.used_percent, resetsAt: null }]
  return { windows, rateLimited: usage.rate_limited }
}

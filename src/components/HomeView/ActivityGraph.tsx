import { useEffect, useMemo, useState } from 'react'

import { intlLocale, useT } from '../../lib/i18n'
import { getCachedClaudeActivity } from '../../lib/claudeActivityCache'
import { useProjectsStore } from '../../stores/projectsStore'
import type { ActivityDay } from '../../lib/tauri'
import styles from './HomeView.module.css'

const DAYS_TOTAL = 91 // 13 semanas × 7 dias

/** Gera matriz semanas[col][weekday] alinhada por dia da semana. */
function buildGrid(days: ActivityDay[]): (ActivityDay | null)[][] {
  if (days.length === 0) return []
  // Calcula o weekday do primeiro dia (0 = domingo)
  const firstDate = new Date(`${days[0].date}T00:00:00Z`)
  const firstWeekday = firstDate.getUTCDay()

  const cells: (ActivityDay | null)[] = []
  // Padding inicial pra alinhar a primeira semana
  for (let i = 0; i < firstWeekday; i++) cells.push(null)
  cells.push(...days)

  const cols: (ActivityDay | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) {
    cols.push(cells.slice(i, i + 7))
  }
  return cols
}

function intensityClass(count: number, max: number): string {
  if (count === 0) return styles.cell0
  if (max === 0) return styles.cell0
  const ratio = count / max
  if (ratio < 0.25) return styles.cell1
  if (ratio < 0.5) return styles.cell2
  if (ratio < 0.75) return styles.cell3
  return styles.cell4
}

function formatDateBR(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${d}/${m}`
}

function totalAndDelta(days: ActivityDay[]): { total: number; deltaPct: number | null } {
  if (days.length < 14) return { total: days.reduce((s, d) => s + d.count, 0), deltaPct: null }
  const halfPoint = days.length - 7
  const recent = days.slice(halfPoint).reduce((s, d) => s + d.count, 0)
  const prev = days.slice(halfPoint - 7, halfPoint).reduce((s, d) => s + d.count, 0)
  const total = days.reduce((s, d) => s + d.count, 0)
  if (prev === 0) return { total, deltaPct: recent > 0 ? 100 : 0 }
  return { total, deltaPct: ((recent - prev) / prev) * 100 }
}

export function ActivityGraph() {
  const t = useT()
  const language = useProjectsStore((s) => s.preferences.language)
  const weekdayLabels = ['', t('activity.weekdayMon'), '', t('activity.weekdayWed'), '', t('activity.weekdayFri'), '']
  const [days, setDays] = useState<ActivityDay[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const data = await getCachedClaudeActivity(DAYS_TOTAL)
        if (!cancelled) setDays(data)
      } catch {
        if (!cancelled) setDays([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    // Adiado para não competir com a primeira pintura e boot dos PTYs.
    const timer = window.setTimeout(() => void load(), 1500)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])

  const cols = useMemo(() => buildGrid(days), [days])
  const max = useMemo(() => days.reduce((m, d) => Math.max(m, d.count), 0), [days])
  const { total, deltaPct } = useMemo(() => totalAndDelta(days), [days])

  const totalFormatted = total.toLocaleString(intlLocale(language))
  const deltaSign = deltaPct === null ? '' : deltaPct >= 0 ? '▲' : '▼'
  const deltaAbs = deltaPct === null ? null : Math.abs(deltaPct).toFixed(0)
  const deltaClass =
    deltaPct === null || deltaPct >= 0 ? styles.usageDelta : `${styles.usageDelta} ${styles.usageDeltaNeg}`

  return (
    <div className={styles.usageCard}>
      <div className={styles.usageHead}>
        <div className={`${styles.usageIcon} ${styles.usageIconActivity}`}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <polyline points="2,12 5,8 8,10 11,4 14,6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <span className={styles.usageName}>{t('activity.title')}</span>
        <span className={styles.usageTier}>90d</span>
      </div>

      <div className={styles.usageMain}>
        <div className={styles.usageMainValue}>{loading ? '—' : totalFormatted}</div>
        <div className={styles.usageMainLabel}>
          <span>{t('activity.messages')}</span>
          <span>·</span>
          <span>{t('activity.lastDays')}</span>
          {deltaAbs !== null && (
            <>
              <span>·</span>
              <span className={deltaClass}>
                {deltaSign} {deltaAbs}%
              </span>
            </>
          )}
        </div>
      </div>

      <div className={`${styles.usageBody} ${styles.usageBodyActivity}`}>
        {loading ? (
          <div className={styles.activityHeatmapLoading}>{t('activity.loading')}</div>
        ) : days.length === 0 ? (
          <div className={styles.activityHeatmapLoading}>{t('activity.noData')}</div>
        ) : (
          <div className={styles.activityHeatmap}>
            <div className={styles.activityWeekdays}>
              {weekdayLabels.map((label, i) => (
                <span key={i}>{label}</span>
              ))}
            </div>
            <div className={styles.activityCols}>
              {cols.map((col, ci) => (
                <div key={ci} className={styles.activityCol}>
                  {col.map((day, ri) =>
                    day ? (
                      <div
                        key={ri}
                        className={`${styles.activityCell} ${intensityClass(day.count, max)}`}
                        title={t(day.count === 1 ? 'activity.tooltipOne' : 'activity.tooltipMany', {
                          count: day.count,
                          date: formatDateBR(day.date),
                        })}
                      />
                    ) : (
                      <div key={ri} className={`${styles.activityCell} ${styles.cellEmpty}`} />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className={styles.usageFooter}>
        <span>{loading ? '—' : t('activity.msgsShort', { total: totalFormatted })}</span>
        <span className={styles.activityLegendGroup}>
          <span className={styles.activityLegend}>{t('activity.less')}</span>
          <span className={`${styles.activityLegendCell} ${styles.cell0}`} />
          <span className={`${styles.activityLegendCell} ${styles.cell1}`} />
          <span className={`${styles.activityLegendCell} ${styles.cell2}`} />
          <span className={`${styles.activityLegendCell} ${styles.cell3}`} />
          <span className={`${styles.activityLegendCell} ${styles.cell4}`} />
          <span className={styles.activityLegend}>{t('activity.more')}</span>
        </span>
      </div>
    </div>
  )
}

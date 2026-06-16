import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { getCachedClaudeUsage } from '../../lib/claudeUsageCache'
import { translate, getLocale, useT } from '../../lib/i18n'
import type { ClaudeUsage } from '../../lib/tauri'
import { useUiStore } from '../../stores/uiStore'
import { ClaudeIcon, CodexIcon } from '../icons/AgentIcons'
import { ActivityGraph } from './ActivityGraph'
import styles from './HomeView.module.css'

function formatResetTime(resetsAt: string): string {
  if (!resetsAt) return '—'
  try {
    const diff = new Date(resetsAt).getTime() - Date.now()
    if (Number.isNaN(diff)) return '—'
    if (diff <= 0) return translate(getLocale(), 'widget.resetting')
    const h = Math.floor(diff / 3_600_000)
    const m = Math.floor((diff % 3_600_000) / 60_000)
    return h > 0 ? `${h}h ${m}m` : `${m}m`
  } catch {
    return resetsAt
  }
}

function meterFillClass(util: number): string {
  if (util >= 80) return styles.meterFillCrit
  if (util >= 50) return styles.meterFillWarn
  return styles.meterFillOk
}

function pct(v: number): string {
  return `${v.toFixed(0)}%`
}

function ClaudeCard({ usage }: { usage: ClaudeUsage | null }) {
  const t = useT()
  const setClaudeUsage = useUiStore((s) => s.setClaudeUsage)
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      const data = await getCachedClaudeUsage(true)
      setClaudeUsage(data)
    } catch {
      setClaudeUsage(null)
    } finally {
      setRefreshing(false)
    }
  }

  const header = (
    <div className={styles.usageHead}>
      <div className={`${styles.usageIcon} ${styles.usageIconClaude}`}>
        <ClaudeIcon size={22} />
      </div>
      <span className={styles.usageName}>claude code</span>
      <span className={styles.usageTier}>{usage ? 'max · 5x' : '—'}</span>
      <button
        type="button"
        className={styles.usageRefreshBtn}
        onClick={handleRefresh}
        disabled={refreshing}
        title={usage ? t('widget.refreshUsage') : t('widget.tryAgain')}
      >
        <RefreshCw size={12} className={refreshing ? styles.usageRefreshSpin : undefined} />
      </button>
    </div>
  )

  if (!usage) {
    return (
      <div className={styles.usageCard}>
        {header}
        <div className={styles.usageMain}>
          <div className={styles.usageMainValue}>—</div>
          <div className={styles.usageMainLabel}>{t('widget.noTokenConfigured')}</div>
        </div>
        <div className={styles.usageBody}>
          <div className={styles.usageEmpty}>{t('widget.connectToSeeUsage')}</div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.usageCard}>
      {header}

      <div className={styles.usageMain}>
        <div className={styles.usageMainValue}>{pct(usage.five_hour.utilization)}</div>
        <div className={styles.usageMainLabel}>
          <span>{t('widget.usage5h')}</span>
          <span>·</span>
          <span>{t('widget.resetIn', { time: formatResetTime(usage.five_hour.resets_at) })}</span>
        </div>
      </div>

      <div className={styles.usageBody}>
        <Meter
          label="5h"
          resetLabel={t('widget.resetsIn', { time: formatResetTime(usage.five_hour.resets_at) })}
          value={pct(usage.five_hour.utilization)}
          util={usage.five_hour.utilization}
        />
        <Meter
          label={t('widget.week')}
          resetLabel={t('widget.resetsIn', { time: formatResetTime(usage.seven_day.resets_at) })}
          value={pct(usage.seven_day.utilization)}
          util={usage.seven_day.utilization}
        />
        <Meter
          label="opus"
          resetLabel={t('widget.resetsIn', { time: formatResetTime(usage.seven_day_opus.resets_at) })}
          value={pct(usage.seven_day_opus.utilization)}
          util={usage.seven_day_opus.utilization}
        />
      </div>
    </div>
  )
}

function CodexCard() {
  const t = useT()
  return (
    <div className={styles.usageCard}>
      <div className={styles.usageHead}>
        <div className={`${styles.usageIcon} ${styles.usageIconCodex}`}>
          <CodexIcon size={22} />
        </div>
        <span className={styles.usageName}>codex</span>
        <span className={styles.usageTier}>plus</span>
      </div>

      <div className={styles.usageMain}>
        <div className={styles.usageMainValue}>2.4M / 5M</div>
        <div className={styles.usageMainLabel}>
          <span>{t('widget.tokensToday')}</span>
          <span>·</span>
          <span>48%</span>
        </div>
      </div>

      <div className={styles.usageBody}>
        <Meter label={t('widget.today')} resetLabel={t('widget.reset0000')} value="2.4M / 5M" util={48} fillClass={styles.meterFillCodex} />
        <Meter label={t('widget.week')} resetLabel={t('widget.sevenDays')} value="11.2M / 30M" util={37} fillClass={styles.meterFillCodex} />
        <Meter label="requests" resetLabel={t('widget.perMinute')} value="3 / 60" util={5} fillClass={styles.meterFillCodex} />
      </div>
    </div>
  )
}

function Meter({
  label,
  resetLabel,
  value,
  util,
  fillClass,
}: {
  label: string
  resetLabel: string
  value: string
  util: number
  fillClass?: string
}) {
  return (
    <div className={styles.meter}>
      <div className={styles.meterRow}>
        <span className={styles.meterLabel}>
          {label}
          <span className={styles.meterReset}>{resetLabel}</span>
        </span>
        <span className={styles.meterValue}>{value}</span>
      </div>
      <div className={styles.meterBar}>
        <div
          className={`${styles.meterFill} ${fillClass ?? meterFillClass(util)}`}
          style={{ width: `${Math.min(util, 100)}%` }}
        />
      </div>
    </div>
  )
}

export function UsageStrip() {
  const claudeUsage = useUiStore((s) => s.claudeUsage)

  return (
    <div className={styles.usageStrip}>
      <ClaudeCard usage={claudeUsage} />
      <CodexCard />
      <ActivityGraph />
    </div>
  )
}

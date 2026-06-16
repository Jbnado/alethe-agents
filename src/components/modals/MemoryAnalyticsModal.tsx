import { Activity, AlertTriangle, Cpu, Layers, Monitor, TerminalSquare, Trash2 } from 'lucide-react'

import { intlLocale, useT, type Locale, type TFunction } from '../../lib/i18n'
import { useProjectsStore } from '../../stores/projectsStore'
import type { MemorySample } from '../../stores/uiStore'
import { useUiStore } from '../../stores/uiStore'
import { Modal } from './Modal'
import controls from './controls.module.css'
import styles from './MemoryAnalyticsModal.module.css'

type Bucket = 'app_mb' | 'webview_mb' | 'ptys_mb'

const BUCKETS: Array<{ key: Bucket; labelKey: 'mod.bucketApp' | 'mod.bucketWebview' | 'mod.bucketPtys'; short: string }> = [
  { key: 'app_mb', labelKey: 'mod.bucketApp', short: 'App' },
  { key: 'webview_mb', labelKey: 'mod.bucketWebview', short: 'Web' },
  { key: 'ptys_mb', labelKey: 'mod.bucketPtys', short: 'PTY' },
]

function formatMb(value: number): string {
  if (!Number.isFinite(value)) return '-'
  return `${value.toFixed(value >= 100 ? 0 : 1)} MB`
}

function formatTime(ts: number, language: Locale): string {
  return new Date(ts).toLocaleTimeString(intlLocale(language), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function average(samples: MemorySample[], key: keyof Pick<MemorySample, 'total_mb' | Bucket>): number {
  if (samples.length === 0) return 0
  return samples.reduce((sum, sample) => sum + Number(sample[key]), 0) / samples.length
}

function getGrowth(samples: MemorySample[], key: keyof Pick<MemorySample, 'total_mb' | Bucket>): number {
  if (samples.length < 2) return 0
  return Number(samples[samples.length - 1][key]) - Number(samples[0][key])
}

function dominantBucket(sample: MemorySample | null, t: TFunction): { label: string; value: number; share: number } | null {
  if (!sample || sample.total_mb <= 0) return null
  const top = BUCKETS.map((bucket) => ({
    label: t(bucket.labelKey),
    value: sample[bucket.key],
    share: sample[bucket.key] / sample.total_mb,
  })).sort((a, b) => b.value - a.value)[0]
  return top ?? null
}

function buildDiagnostics(history: MemorySample[], t: TFunction): string[] {
  if (history.length === 0) return [t('mod.noDataYet')]

  const latest = history[history.length - 1]
  const recent = history.filter((sample) => latest.ts - sample.ts <= 10 * 60_000)
  const windowed = recent.length >= 2 ? recent : history
  const totalGrowth = getGrowth(windowed, 'total_mb')
  const bucketGrowth = BUCKETS.map((bucket) => ({
    label: t(bucket.labelKey),
    value: getGrowth(windowed, bucket.key),
  })).sort((a, b) => b.value - a.value)[0]
  const top = dominantBucket(latest, t)
  const diagnostics: string[] = []

  if (latest.total_mb >= 2048) {
    diagnostics.push(t('mod.diagOver2gb'))
  } else if (latest.total_mb >= 1024) {
    diagnostics.push(t('mod.diagOver1gb'))
  }

  if (totalGrowth >= 250) {
    diagnostics.push(t('mod.diagHighGrowth', { value: formatMb(totalGrowth) }))
  } else if (totalGrowth >= 120) {
    diagnostics.push(t('mod.diagModerateGrowth', { value: formatMb(totalGrowth) }))
  }

  if (bucketGrowth && bucketGrowth.value >= 80) {
    diagnostics.push(t('mod.diagBucketGrowth', { label: bucketGrowth.label, value: formatMb(bucketGrowth.value) }))
  }

  if (top && top.share >= 0.6) {
    diagnostics.push(t('mod.diagDominant', { label: top.label, pct: (top.share * 100).toFixed(0) }))
  }

  if (latest.process_count >= 20) {
    diagnostics.push(t('mod.diagManyProcesses', { count: latest.process_count }))
  }

  if (diagnostics.length === 0) {
    diagnostics.push(t('mod.diagStable'))
  }

  return diagnostics
}

function Sparkline({ samples }: { samples: MemorySample[] }) {
  const t = useT()
  const chartSamples = samples.slice(-90)
  if (chartSamples.length < 2) {
    return <div className={styles.emptyChart}>{t('mod.waitingMoreSamples')}</div>
  }

  const values = chartSamples.map((sample) => sample.total_mb)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = Math.max(max - min, 1)
  const points = chartSamples
    .map((sample, index) => {
      const x = (index / (chartSamples.length - 1)) * 100
      const y = 100 - ((sample.total_mb - min) / range) * 84 - 8
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')

  return (
    <div className={styles.chartWrap}>
      <svg className={styles.chart} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <polyline className={styles.chartLine} points={points} />
      </svg>
      <div className={styles.chartScale}>
        <span>{formatMb(max)}</span>
        <span>{formatMb(min)}</span>
      </div>
    </div>
  )
}

function CategoryBars({ latest }: { latest: MemorySample | null }) {
  const t = useT()
  if (!latest || latest.total_mb <= 0) return null

  return (
    <div className={styles.categoryList}>
      {BUCKETS.map((bucket) => {
        const value = latest[bucket.key]
        const pct = Math.max(2, (value / latest.total_mb) * 100)
        return (
          <div key={bucket.key} className={styles.categoryRow}>
            <div className={styles.categoryMeta}>
              <span>{t(bucket.labelKey)}</span>
              <span>{formatMb(value)}</span>
            </div>
            <div className={styles.barTrack}>
              <div className={styles.barFill} style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function MemoryAnalyticsModal() {
  const t = useT()
  const language = useProjectsStore((s) => s.preferences.language)
  const open = useUiStore((s) => s.openModal === 'memoryAnalytics')
  const onClose = useUiStore((s) => s.closeModal)
  const history = useUiStore((s) => s.memoryHistory)
  const clearMemoryHistory = useUiStore((s) => s.clearMemoryHistory)

  const latest = history[history.length - 1] ?? null
  const peak = history.reduce<MemorySample | null>(
    (current, sample) => (!current || sample.total_mb > current.total_mb ? sample : current),
    null,
  )
  const recent = latest ? history.filter((sample) => latest.ts - sample.ts <= 10 * 60_000) : []
  const windowed = recent.length >= 2 ? recent : history
  const avg = average(windowed, 'total_mb')
  const growth = getGrowth(windowed, 'total_mb')
  const diagnostics = buildDiagnostics(history, t)
  const top = dominantBucket(latest, t)
  const latestRows = history.slice(-12).reverse()

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('mod.memoryAnalyticsTitle')}
      width={760}
      footer={
        <button type="button" className={controls.btn} onClick={clearMemoryHistory} disabled={history.length === 0}>
          <Trash2 size={14} />
          {t('mod.clearHistory')}
        </button>
      }
    >
      <div className={styles.layout}>
        <section className={styles.summaryGrid}>
          <div className={styles.metric}>
            <Activity size={16} />
            <span className={styles.metricLabel}>{t('mod.now')}</span>
            <strong>{latest ? formatMb(latest.total_mb) : '-'}</strong>
          </div>
          <div className={styles.metric}>
            <Monitor size={16} />
            <span className={styles.metricLabel}>{t('mod.peak')}</span>
            <strong>{peak ? formatMb(peak.total_mb) : '-'}</strong>
          </div>
          <div className={styles.metric}>
            <Cpu size={16} />
            <span className={styles.metricLabel}>{t('mod.recentAvg')}</span>
            <strong>{history.length ? formatMb(avg) : '-'}</strong>
          </div>
          <div className={styles.metric}>
            <Layers size={16} />
            <span className={styles.metricLabel}>{t('mod.trend')}</span>
            <strong className={growth >= 120 ? styles.hot : growth <= -80 ? styles.cool : undefined}>
              {growth >= 0 ? '+' : ''}
              {formatMb(growth)}
            </strong>
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h3>{t('mod.history')}</h3>
              <p>{t('mod.historySubtitle', { count: history.length })}</p>
            </div>
            {latest ? <span>{formatTime(latest.ts, language)}</span> : null}
          </div>
          <Sparkline samples={history} />
        </section>

        <div className={styles.columns}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <h3>{t('mod.bottlenecks')}</h3>
                <p>{top ? t('mod.bottleneckLead', { label: top.label, value: formatMb(top.value) }) : t('mod.noCurrentReading')}</p>
              </div>
              <AlertTriangle size={16} />
            </div>
            <div className={styles.diagnostics}>
              {diagnostics.map((item) => (
                <div key={item} className={styles.diagnosticItem}>
                  {item}
                </div>
              ))}
            </div>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <h3>{t('mod.currentComposition')}</h3>
                <p>{latest ? t('mod.processesTracked', { count: latest.process_count }) : t('mod.waitingData')}</p>
              </div>
              <TerminalSquare size={16} />
            </div>
            <CategoryBars latest={latest} />
          </section>
        </div>

        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h3>{t('mod.latestSamples')}</h3>
              <p>{t('mod.latestSamplesSubtitle')}</p>
            </div>
          </div>
          <div className={styles.table}>
            <div className={`${styles.tableRow} ${styles.tableHead}`}>
              <span>{t('mod.colTime')}</span>
              <span>{t('mod.colTotal')}</span>
              <span>App</span>
              <span>WebView</span>
              <span>PTY</span>
              <span>{t('mod.colProc')}</span>
            </div>
            {latestRows.length === 0 ? (
              <div className={styles.emptyRows}>{t('mod.waitingFirstReading')}</div>
            ) : (
              latestRows.map((sample) => (
                <div key={sample.ts} className={styles.tableRow}>
                  <span>{formatTime(sample.ts, language)}</span>
                  <strong>{formatMb(sample.total_mb)}</strong>
                  <span>{formatMb(sample.app_mb)}</span>
                  <span>{formatMb(sample.webview_mb)}</span>
                  <span>{formatMb(sample.ptys_mb)}</span>
                  <span>{sample.process_count}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </Modal>
  )
}

import { X } from 'lucide-react'
import { useEffect } from 'react'

import { useT, intlLocale } from '../../lib/i18n'
import { useAgentCanvasStore } from '../../stores/agentCanvasStore'
import { useProjectsStore } from '../../stores/projectsStore'
import styles from './AgentCanvasPOC.module.css'

/** Modal central com o feed completo do subagent selecionado no canvas. */
export function AgentModal() {
  const t = useT()
  const language = useProjectsStore((s) => s.preferences.language)
  const node = useAgentCanvasStore((s) =>
    s.selectedId ? s.nodes.find((n) => n.id === s.selectedId) ?? null : null,
  )
  const select = useAgentCanvasStore((s) => s.select)

  useEffect(() => {
    if (!node) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') select(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [node, select])

  if (!node) return null

  return (
    <div className={styles.modalBackdrop} onClick={() => select(null)}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <header className={styles.modalHeader}>
          <span className={styles.cardType}>{node.agentType}</span>
          <span
            className={
              node.status === 'running'
                ? styles.statusRunning
                : node.status === 'idle'
                  ? styles.statusIdle
                  : styles.statusDone
            }
          >
            {node.status}
          </span>
          {node.kind === 'teammate' ? (
            <span className={styles.teammateMeta}>
              {node.team} · {t('ws.turns', { count: node.turns })}
            </span>
          ) : null}
          <span className={styles.modalId}>{node.id}</span>
          <button type="button" className={styles.clearButton} onClick={() => select(null)}>
            <X size={14} />
          </button>
        </header>

        {node.prompt ? (
          <div className={styles.modalSection}>
            <div className={styles.modalSectionTitle}>{t('ws.task')}</div>
            <div className={styles.modalPrompt}>{node.prompt}</div>
          </div>
        ) : null}

        <div className={`${styles.modalSection} ${styles.modalFeedSection}`}>
          <div className={styles.modalSectionTitle}>
            {t('ws.feedToolCalls', { count: node.feed.length })}
          </div>
          <div className={styles.modalFeed}>
            {node.feed.length === 0 ? (
              <div className={styles.empty}>{t('ws.noToolCallYet')}</div>
            ) : (
              node.feed.map((ev) => (
                <div key={ev.toolUseId} className={styles.feedRow}>
                  <span className={styles.feedTime}>
                    {new Date(ev.ts).toLocaleTimeString(intlLocale(language))}
                  </span>
                  <span className={styles.feedTool}>{ev.toolName}</span>
                  <span className={styles.feedSummary}>{ev.summary}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {node.result ? (
          <div className={styles.modalSection}>
            <div className={styles.modalSectionTitle}>{t('ws.result')}</div>
            <div className={styles.modalResult}>{node.result}</div>
          </div>
        ) : null}

        {node.transcriptPath ? (
          <div className={styles.modalTranscript}>{node.transcriptPath}</div>
        ) : null}
      </div>
    </div>
  )
}

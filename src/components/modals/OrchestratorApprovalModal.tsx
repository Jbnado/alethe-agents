import { Power, Send, Sparkles, TerminalSquare } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import { resolveApproval } from '../../lib/orchestrator/approvalGate'
import { APPROVAL_TIMEOUT_MS } from '../../lib/orchestrator/ops'
import type { OrchestratorApprovalAction } from '../../lib/types'
import { selectApprovals, useOrchestratorStore } from '../../stores/orchestratorStore'
import { useUiStore } from '../../stores/uiStore'
import controls from './controls.module.css'
import { Modal } from './Modal'
import styles from './OrchestratorApprovalModal.module.css'

const ICONS = {
  'shell.run': TerminalSquare,
  'agent.spawn': Sparkles,
  'agent.prompt': Send,
  'agent.kill': Power,
} as const

/**
 * Confirmation for a control-plane write an agent terminal asked for.
 *
 * Shows the payload verbatim — the whole command, the whole task, the whole
 * prompt — because that is the thing being decided on; a dialog that summarizes
 * away what it is confirming is theatre. Only one request is ever on screen: the
 * rest queue behind it, counted in the footer and in the topbar.
 */
export function OrchestratorApprovalModal() {
  const t = useT()
  const approvals = useOrchestratorStore(selectApprovals)
  const grantSessionApproval = useOrchestratorStore((state) => state.grantSessionApproval)
  const openModal = useUiStore((state) => state.openModal)
  const [remember, setRemember] = useState(false)

  const head = approvals[0] ?? null
  const requestId = head?.requestId ?? null

  // A standing permission is granted for the request the person was looking at,
  // never carried over to whatever comes up next in the queue.
  useEffect(() => {
    setRemember(false)
  }, [requestId])

  // Takes the modal slot back as soon as it frees. Something parked with no way
  // back on screen would sit there until its deadline refused it — and the
  // person who opened Preferences over the dialog never meant to answer "no".
  useEffect(() => {
    if (requestId !== null && openModal === null) {
      useUiStore.getState().openModal_('orchestratorApproval')
    }
  }, [requestId, openModal])

  if (!head) return null

  const action = head.capability as OrchestratorApprovalAction
  const Icon = ICONS[action] ?? TerminalSquare
  const danger = action === 'agent.kill'

  const decide = (approved: boolean) => {
    if (approved && remember) grantSessionApproval(head.requesterTerminalId, head.capability)
    resolveApproval(head.requestId, approved)
  }

  return (
    <Modal
      open={openModal === 'orchestratorApproval'}
      // Dismissing IS the answer: leaving the request parked would strand the
      // agent until the deadline, and refusing is the safe reading of a person
      // who closed the question.
      onClose={() => decide(false)}
      title={t('orchApproval.title')}
      width={520}
      footer={
        <>
          {approvals.length > 1 ? (
            <span className={styles.queued}>
              {t('orchApproval.queued', { count: approvals.length - 1 })}
            </span>
          ) : null}
          <button type="button" className={controls.btn} onClick={() => decide(false)}>
            {t('orchApproval.deny')}
          </button>
          <button
            type="button"
            data-autofocus
            className={`${controls.btn} ${danger ? controls.btnDanger : controls.btnPrimary}`}
            onClick={() => decide(true)}
          >
            {t('orchApproval.allow')}
          </button>
        </>
      }
    >
      <div className={styles.head}>
        <span className={`${styles.headIcon} ${danger ? styles.headIconDanger : ''}`}>
          <Icon size={16} />
        </span>
        <span className={styles.headCopy}>
          <strong>{t(`orchApproval.action.${action}`)}</strong>
          <span>{t(`orchApproval.actionDesc.${action}`)}</span>
        </span>
      </div>

      <div className={styles.meta}>
        <span className={styles.metaLabel}>{t('orchApproval.requester')}</span>
        <span className={styles.metaValue} title={head.requesterName}>
          {head.requesterName}
        </span>
        <span className={styles.metaLabel}>{t('orchApproval.project')}</span>
        <span className={styles.metaValue} title={head.projectName}>
          {head.projectName}
        </span>
        {head.targetName ? (
          <>
            <span className={styles.metaLabel}>{t('orchApproval.target')}</span>
            <span className={styles.metaValue} title={head.targetName}>
              {head.targetName}
            </span>
          </>
        ) : null}
        {action === 'agent.spawn' && head.agent ? (
          <>
            <span className={styles.metaLabel}>{t('orchApproval.agent')}</span>
            <span className={styles.metaValue}>{head.agent}</span>
          </>
        ) : null}
      </div>

      <span className={styles.payloadLabel}>{t(`orchApproval.payload.${action}`)}</span>
      {/*
        Focused on open, and focusable for its own sake: the block scrolls, so a
        long command has to be readable from the keyboard. It also keeps the
        focus off the checkbox below, which `Modal` would otherwise pick as the
        first input — one stray space bar away from a standing permission.
      */}
      <pre className={styles.payload} tabIndex={0} data-autofocus>
        {head.summary}
      </pre>

      <label className={styles.remember}>
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
        />
        <span className={styles.rememberCopy}>
          <strong>{t('orchApproval.remember', { terminal: head.requesterName })}</strong>
          <span>{t('orchApproval.rememberHint')}</span>
        </span>
      </label>

      <p className={styles.footnote}>
        {t('orchApproval.expiry', { seconds: Math.round(APPROVAL_TIMEOUT_MS / 1000) })}
      </p>
    </Modal>
  )
}

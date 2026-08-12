import { Minus, Plus, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { intlLocale, useT } from '../../../lib/i18n'
import { isMacOS } from '../../../lib/platform'
import { countLiveResumablePanes, resetLastSession } from '../../../lib/resetLastSession'
import {
  applyResourcePolicyPatch,
  clampMemoryBudgetMb,
  describeBudgetShare,
  maxMemoryBudgetMb,
  mbToGb,
  MEMORY_BUDGET_MIN_MB,
  needsBudgetConfirmation,
  THRESHOLD_GAP_MB,
} from '../../../lib/resourcePolicy'
import { getMemoryStats } from '../../../lib/tauri'
import {
  ORCHESTRATOR_APPROVAL_ACTIONS,
  type AgentType,
  type OrchestratorApprovalAction,
} from '../../../lib/types'
import {
  ORCHESTRATOR_LIVE_AGENT_LIMITS,
  SPAWN_CONCURRENCY_LIMITS,
  useProjectsStore,
} from '../../../stores/projectsStore'
import { useUiStore } from '../../../stores/uiStore'
import { AgentIcon } from '../../icons/AgentIcons'
import controls from '../controls.module.css'
import { Modal } from '../Modal'
import styles from '../PreferencesModal.module.css'
import { SettingsSection } from './primitives'

const AGENTS: { id: AgentType; label: string }[] = [
  { id: 'shell', label: 'Shell' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'freebuff', label: 'Freebuff' },
  { id: 'mimo', label: 'Mimo Code' },
]

export function TerminalPage({ enabledCount }: { enabledCount: number }) {
  const t = useT()
  const preferences = useProjectsStore((state) => state.preferences)
  const setAgentEnabled = useProjectsStore((state) => state.setAgentEnabled)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const pushToast = useUiStore((state) => state.pushToast)
  const [resetting, setResetting] = useState(false)
  const [systemTotalMb, setSystemTotalMb] = useState<number | null>(null)
  const [pendingBudgetMb, setPendingBudgetMb] = useState<number | null>(null)
  const concurrency = preferences.spawnConcurrency
  const maxLiveAgents = preferences.orchestratorMaxLiveAgents
  const resourcePolicy = preferences.resourcePolicy
  const effectiveResourceMode =
    resourcePolicy.automaticParkingOptIn === true && resourcePolicy.mode === 'smart-lru'
      ? 'smart-lru'
      : 'manual'

  // Physical RAM decides the budget ceiling. A failed read only costs the
  // machine-aware limit — the fixed fallback keeps the fields usable.
  useEffect(() => {
    let cancelled = false
    void getMemoryStats()
      .then((stats) => {
        if (!cancelled) setSystemTotalMb(stats.system_total_mb)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const maxBudgetMb = useMemo(() => maxMemoryBudgetMb(systemTotalMb), [systemTotalMb])
  const numberFormat = useMemo(
    () => new Intl.NumberFormat(intlLocale(preferences.language), { maximumFractionDigits: 1 }),
    [preferences.language],
  )
  const pendingShare = describeBudgetShare(pendingBudgetMb ?? 0, systemTotalMb)

  const applyResourcePolicy = (patch: Partial<typeof resourcePolicy>) => {
    setPreferences({
      resourcePolicy: applyResourcePolicyPatch(resourcePolicy, patch, maxBudgetMb),
    })
  }

  const setResourcePolicy = (patch: Partial<typeof resourcePolicy>) => {
    if (patch.memoryBudgetMb !== undefined) {
      const budgetMb = clampMemoryBudgetMb(patch.memoryBudgetMb, maxBudgetMb)
      if (needsBudgetConfirmation(budgetMb, resourcePolicy.memoryBudgetMb)) {
        setPendingBudgetMb(budgetMb)
        return
      }
    }
    applyResourcePolicy(patch)
  }

  const confirmPendingBudget = () => {
    if (pendingBudgetMb !== null) applyResourcePolicy({ memoryBudgetMb: pendingBudgetMb })
    setPendingBudgetMb(null)
  }

  const setConcurrency = (n: number) =>
    setPreferences({
      spawnConcurrency: Math.min(
        SPAWN_CONCURRENCY_LIMITS.max,
        Math.max(SPAWN_CONCURRENCY_LIMITS.min, n),
      ),
    })

  const setMaxLiveAgents = (n: number) =>
    setPreferences({
      orchestratorMaxLiveAgents: Math.min(
        ORCHESTRATOR_LIVE_AGENT_LIMITS.max,
        Math.max(ORCHESTRATOR_LIVE_AGENT_LIMITS.min, n),
      ),
    })

  const autoApprove = preferences.orchestratorAutoApprove
  const setAutoApprove = (action: OrchestratorApprovalAction, value: boolean) =>
    setPreferences({
      // Rebuilt from every key, not patched: the field is optional on disk, so
      // a partial object here would leave the missing actions undefined.
      orchestratorAutoApprove: ORCHESTRATOR_APPROVAL_ACTIONS.reduce(
        (acc, key) => {
          acc[key] = key === action ? value : autoApprove?.[key] === true
          return acc
        },
        {} as Record<OrchestratorApprovalAction, boolean>,
      ),
    })

  const onResetLastSession = async () => {
    if (resetting) return
    const count = countLiveResumablePanes()
    if (count === 0) {
      pushToast({ title: t('prefs.resetSessionEmpty'), body: t('prefs.resetSessionEmptyBody') })
      return
    }
    // Abrange TODOS os projetos/grupos com agente vivo em background, não só
    // o visível — com vários acumulados isso reinicia muitos processos de
    // uma vez, então confirma explicitamente mostrando a contagem real.
    if (count > 1 && !window.confirm(t('prefs.resetSessionConfirm', { count }))) return
    setResetting(true)
    try {
      const { resumed, total } = await resetLastSession()
      if (total === 0) {
        pushToast({ title: t('prefs.resetSessionEmpty'), body: t('prefs.resetSessionEmptyBody') })
      } else {
        pushToast({
          title: t('prefs.resetSessionDone'),
          body: t('prefs.resetSessionDoneBody', { count: resumed }),
        })
      }
    } catch (err) {
      pushToast({ title: t('prefs.resetSessionFailed'), body: String(err) })
    } finally {
      setResetting(false)
    }
  }

  return (
    <>
      <SettingsSection
        id="resource-policy"
        title={t('prefs.resourcePolicy')}
        description={t('prefs.resourcePolicyDesc')}
      >
        <div className={styles.resourceControls}>
          <div className={styles.segmented}>
            <button
              type="button"
              className={effectiveResourceMode === 'smart-lru' ? styles.segmentActive : undefined}
              onClick={() => setResourcePolicy({ mode: 'smart-lru', automaticParkingOptIn: true })}
            >
              {t('prefs.resourcePolicySmart')}
            </button>
            <button
              type="button"
              className={effectiveResourceMode === 'manual' ? styles.segmentActive : undefined}
              onClick={() => setResourcePolicy({ mode: 'manual', automaticParkingOptIn: false })}
            >
              {t('prefs.resourcePolicyManual')}
            </button>
          </div>
          <div className={styles.resourceGrid}>
            <label>
              <span>{t('prefs.resourceBudget')}</span>
              <input
                type="number"
                min={MEMORY_BUDGET_MIN_MB}
                max={maxBudgetMb}
                step={128}
                value={resourcePolicy.memoryBudgetMb}
                onChange={(event) =>
                  setResourcePolicy({ memoryBudgetMb: Number(event.target.value) })
                }
              />
            </label>
            <label>
              <span>{t('prefs.resourceWarning')}</span>
              <input
                type="number"
                min={512}
                max={resourcePolicy.memoryBudgetMb - THRESHOLD_GAP_MB}
                step={64}
                value={resourcePolicy.warningThresholdMb}
                onChange={(event) =>
                  setResourcePolicy({ warningThresholdMb: Number(event.target.value) })
                }
              />
            </label>
            <label>
              <span>{t('prefs.resourceRecovery')}</span>
              <input
                type="number"
                min={384}
                max={resourcePolicy.warningThresholdMb - THRESHOLD_GAP_MB}
                step={64}
                value={resourcePolicy.recoveryTargetMb}
                onChange={(event) =>
                  setResourcePolicy({ recoveryTargetMb: Number(event.target.value) })
                }
              />
            </label>
            <label>
              <span>{t('prefs.resourceAgentIdle')}</span>
              <input
                type="number"
                min={5}
                max={240}
                step={5}
                value={resourcePolicy.hiddenAgentIdleMinutes}
                onChange={(event) =>
                  setResourcePolicy({ hiddenAgentIdleMinutes: Number(event.target.value) })
                }
              />
            </label>
            <label>
              <span>{t('prefs.resourceShellIdle')}</span>
              <input
                type="number"
                min={5}
                max={480}
                step={5}
                value={resourcePolicy.hiddenShellIdleMinutes}
                onChange={(event) =>
                  setResourcePolicy({ hiddenShellIdleMinutes: Number(event.target.value) })
                }
              />
            </label>
          </div>
          <p className={styles.resourceHint}>
            {t('prefs.resourceDerivedHint')}{' '}
            {systemTotalMb
              ? t('prefs.resourceBudgetMax', {
                  max: numberFormat.format(maxBudgetMb),
                  total: numberFormat.format(mbToGb(systemTotalMb)),
                })
              : t('prefs.resourceBudgetMaxUnknown', { max: numberFormat.format(maxBudgetMb) })}
          </p>
          <p className={styles.resourceHint}>
            {effectiveResourceMode === 'smart-lru'
              ? t('prefs.resourcePolicySmartHint')
              : t('prefs.resourcePolicyManualHint')}
          </p>
        </div>
      </SettingsSection>

      <Modal
        open={pendingBudgetMb !== null}
        onClose={() => setPendingBudgetMb(null)}
        title={t('prefs.resourceBudgetConfirmTitle')}
        footer={
          <>
            <button type="button" className={controls.btn} onClick={() => setPendingBudgetMb(null)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              data-autofocus
              className={`${controls.btn} ${controls.btnPrimary}`}
              onClick={confirmPendingBudget}
            >
              {t('prefs.resourceBudgetConfirmApply', {
                budget: numberFormat.format(pendingShare.budgetGb),
              })}
            </button>
          </>
        }
      >
        <p style={{ fontSize: 13, color: 'var(--fg)', lineHeight: 1.5, margin: '0 0 12px' }}>
          {pendingShare.totalGb !== null && pendingShare.percentOfSystem !== null
            ? t('prefs.resourceBudgetConfirmBody', {
                budget: numberFormat.format(pendingShare.budgetGb),
                total: numberFormat.format(pendingShare.totalGb),
                percent: pendingShare.percentOfSystem,
              })
            : t('prefs.resourceBudgetConfirmBodyUnknown', {
                budget: numberFormat.format(pendingShare.budgetGb),
              })}
        </p>
        <p style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.5, margin: 0 }}>
          {t('prefs.resourceBudgetConfirmDetail')}
        </p>
      </Modal>

      <SettingsSection
        id="spawn-concurrency"
        title={t('prefs.spawnConcurrency')}
        description={t('prefs.spawnConcurrencyDesc')}
      >
        <div className={styles.zoomControl}>
          <button
            type="button"
            onClick={() => setConcurrency(concurrency - SPAWN_CONCURRENCY_LIMITS.step)}
            disabled={concurrency <= SPAWN_CONCURRENCY_LIMITS.min}
            aria-label={t('prefs.spawnConcurrencyDecrease')}
          >
            <Minus size={15} />
          </button>
          <strong>{concurrency}</strong>
          <button
            type="button"
            onClick={() => setConcurrency(concurrency + SPAWN_CONCURRENCY_LIMITS.step)}
            disabled={concurrency >= SPAWN_CONCURRENCY_LIMITS.max}
            aria-label={t('prefs.spawnConcurrencyIncrease')}
          >
            <Plus size={15} />
          </button>
          <button
            type="button"
            onClick={() => setConcurrency(3)}
            disabled={concurrency === 3}
            aria-label={t('prefs.spawnConcurrencyReset')}
          >
            <RotateCcw size={15} />
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        id="orchestrator-live-agents"
        title={t('prefs.orchestratorMaxLiveAgents')}
        description={t('prefs.orchestratorMaxLiveAgentsDesc')}
      >
        <div className={styles.zoomControl}>
          <button
            type="button"
            onClick={() => setMaxLiveAgents(maxLiveAgents - ORCHESTRATOR_LIVE_AGENT_LIMITS.step)}
            disabled={maxLiveAgents <= ORCHESTRATOR_LIVE_AGENT_LIMITS.min}
            aria-label={t('prefs.orchestratorMaxLiveAgentsDecrease')}
          >
            <Minus size={15} />
          </button>
          <strong>{maxLiveAgents}</strong>
          <button
            type="button"
            onClick={() => setMaxLiveAgents(maxLiveAgents + ORCHESTRATOR_LIVE_AGENT_LIMITS.step)}
            disabled={maxLiveAgents >= ORCHESTRATOR_LIVE_AGENT_LIMITS.max}
            aria-label={t('prefs.orchestratorMaxLiveAgentsIncrease')}
          >
            <Plus size={15} />
          </button>
          <button
            type="button"
            onClick={() => setMaxLiveAgents(ORCHESTRATOR_LIVE_AGENT_LIMITS.default)}
            disabled={maxLiveAgents === ORCHESTRATOR_LIVE_AGENT_LIMITS.default}
            aria-label={t('prefs.orchestratorMaxLiveAgentsReset')}
          >
            <RotateCcw size={15} />
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        id="orchestrator-auto-approve"
        title={t('prefs.orchestratorAutoApprove')}
        description={t('prefs.orchestratorAutoApproveDesc')}
      >
        <div className={styles.optionList}>
          {ORCHESTRATOR_APPROVAL_ACTIONS.map((action) => (
            <label key={action} className={`${styles.optionRow} ${styles.optionToggleRow}`}>
              <span className={styles.optionCopy}>
                <strong>{t(`orchApproval.action.${action}`)}</strong>
                <span>{t(`orchApproval.actionDesc.${action}`)}</span>
              </span>
              <input
                type="checkbox"
                checked={autoApprove?.[action] === true}
                onChange={(event) => setAutoApprove(action, event.target.checked)}
              />
            </label>
          ))}
        </div>
        <p className={styles.resourceHint}>{t('prefs.orchestratorAutoApproveHint')}</p>
      </SettingsSection>

      <SettingsSection
        id="agents"
        title={t('prefs.enabledAgents', { count: enabledCount })}
        description={t('prefs.agentsDesc')}
      >
        <div className={styles.agentList}>
          {AGENTS.map((agent) => {
            const checked = preferences.enabledAgents[agent.id]
            const disabled = checked && enabledCount === 1
            return (
              <label key={agent.id} className={disabled ? styles.agentDisabled : undefined}>
                <span className={styles.agentIcon}>
                  <AgentIcon
                    type={agent.id}
                    size={20}
                    theme={preferences.terminalTheme ?? preferences.uiTheme}
                  />
                </span>
                <span className={styles.agentCopy}>
                  <strong>{agent.label}</strong>
                  <span>{t(`agent.${agent.id}.desc`)}</span>
                </span>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={(event) => setAgentEnabled(agent.id, event.target.checked)}
                />
              </label>
            )
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        id="limit-reset-notify"
        title={t('prefs.limitResetNotify')}
        description={t('prefs.limitResetNotifyDesc')}
      >
        <div className={styles.segmented}>
          <button
            type="button"
            className={preferences.notifyOnLimitReset ? styles.segmentActive : undefined}
            onClick={() => setPreferences({ notifyOnLimitReset: true })}
          >
            {t('prefs.limitResetNotifyOn')}
          </button>
          <button
            type="button"
            className={!preferences.notifyOnLimitReset ? styles.segmentActive : undefined}
            onClick={() => setPreferences({ notifyOnLimitReset: false })}
          >
            {t('prefs.limitResetNotifyOff')}
          </button>
        </div>
      </SettingsSection>

      {isMacOS() ? (
        <SettingsSection
          id="native-terminal-macos"
          title={t('prefs.nativeTerminalMacos')}
          description={t('prefs.nativeTerminalMacosDesc')}
        >
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '8px 12px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border)',
              background: 'var(--bg-sunken)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={preferences.nativeTerminalMacos ?? false}
              onChange={(e) => setPreferences({ nativeTerminalMacos: e.target.checked })}
            />
            <span style={{ flex: 1, fontSize: 13 }}>{t('prefs.nativeTerminalMacosEnable')}</span>
          </label>
        </SettingsSection>
      ) : null}

      <SettingsSection
        id="reset-session"
        title={t('prefs.resetSession')}
        description={t('prefs.resetSessionDesc')}
      >
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => void onResetLastSession()}
          disabled={resetting}
        >
          <RotateCcw size={15} />
          {resetting ? t('prefs.resetSessionBusy') : t('prefs.resetSessionButton')}
        </button>
      </SettingsSection>
    </>
  )
}

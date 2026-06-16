import { Check } from 'lucide-react'
import { useEffect, useState } from 'react'

import { LOCALES, useT } from '../../lib/i18n'
import { getProfileInitial } from '../../lib/profile'
import { THEME_OPTIONS, themeLabel } from '../../lib/themes'
import { useProjectsStore } from '../../stores/projectsStore'
import type { AgentType } from '../../lib/types'
import { AgentIcon } from '../icons/AgentIcons'
import { ImageInput } from './ImageInput'
import { Modal } from './Modal'
import controls from './controls.module.css'

const AGENTS: { id: AgentType; label: string }[] = [
  { id: 'shell', label: 'Shell' },
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
]

const STEP_COUNT = 4

export function OnboardingModal() {
  const t = useT()
  const preferences = useProjectsStore((s) => s.preferences)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const setLanguage = useProjectsStore((s) => s.setLanguage)
  const setAgentEnabled = useProjectsStore((s) => s.setAgentEnabled)
  const setUiTheme = useProjectsStore((s) => s.setUiTheme)
  const terminalTheme = preferences.terminalTheme ?? preferences.uiTheme
  const [step, setStep] = useState(0)
  const [name, setName] = useState(preferences.displayName)
  const [photoUrl, setPhotoUrl] = useState(preferences.profileImageUrl)
  const [imgFailed, setImgFailed] = useState(false)

  useEffect(() => {
    if (preferences.accountCreated) return
    setName(preferences.displayName)
    setPhotoUrl(preferences.profileImageUrl)
  }, [preferences.accountCreated, preferences.displayName, preferences.profileImageUrl])

  if (preferences.accountCreated) return null

  const enabledCount = Object.values(preferences.enabledAgents).filter(Boolean).length
  const trimmedName = name.trim()
  const trimmedPhotoUrl = photoUrl.trim()
  const initial = getProfileInitial(trimmedName)

  const canProceed =
    step === 1 ? trimmedName.length > 0 : step === 3 ? enabledCount > 0 : true
  const isLast = step === STEP_COUNT - 1

  const finish = () => {
    if (enabledCount === 0 || trimmedName.length === 0) return
    setPreferences({
      accountCreated: true,
      onboardingDone: true,
      displayName: trimmedName,
      profileImageUrl: trimmedPhotoUrl,
    })
  }

  const next = () => {
    if (!canProceed) return
    if (isLast) finish()
    else setStep((s) => s + 1)
  }

  return (
    <Modal
      open
      onClose={() => {
        /* onboarding não fecha por fora — só conclui no último passo */
      }}
      title={t('onboarding.title')}
      width={500}
      footer={
        <>
          <span style={{ flex: 1, fontSize: 11, color: 'var(--fg-faint)' }}>
            {t('onboarding.step', { current: step + 1, total: STEP_COUNT })}
          </span>
          {step > 0 ? (
            <button type="button" className={controls.btn} onClick={() => setStep((s) => s - 1)}>
              {t('common.back')}
            </button>
          ) : null}
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            onClick={next}
            disabled={!canProceed}
          >
            {isLast ? t('onboarding.finish') : t('common.next')}
          </button>
        </>
      }
    >
      {step === 0 ? (
        <div className={controls.field}>
          <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 0 }}>
            {t('language.subtitle')}
          </p>
          <label className={controls.label}>{t('language.title')}</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {LOCALES.map((loc) => {
              const active = preferences.language === loc.id
              return (
                <button
                  key={loc.id}
                  type="button"
                  onClick={() => setLanguage(loc.id)}
                  className={`${controls.pill} ${active ? controls.pillActive : ''}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', textAlign: 'left' }}
                >
                  <span style={{ flex: 1, fontSize: 13 }}>{loc.nativeName}</span>
                  {active ? <Check size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} /> : null}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}

      {step === 1 ? (
        <>
          <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 0 }}>
            {t('onboarding.identitySubtitle')}
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '64px 1fr',
              gap: 14,
              alignItems: 'center',
            }}
          >
            {trimmedPhotoUrl && !imgFailed ? (
              <img
                src={trimmedPhotoUrl}
                alt=""
                draggable={false}
                onError={() => setImgFailed(true)}
                onLoad={() => setImgFailed(false)}
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: '50%',
                  objectFit: 'cover',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-sunken)',
                }}
              />
            ) : (
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: '50%',
                  display: 'grid',
                  placeItems: 'center',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-sunken)',
                  color: 'var(--fg)',
                  fontSize: 24,
                  fontWeight: 700,
                }}
              >
                {initial}
              </div>
            )}
            <div>
              <div className={controls.field} style={{ marginBottom: 8 }}>
                <label className={controls.label}>{t('onboarding.name')}</label>
                <input
                  className={controls.input}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('onboarding.namePlaceholder')}
                  maxLength={60}
                  data-autofocus
                />
              </div>
              <ImageInput
                label={t('prefs.photoPlaceholder')}
                value={photoUrl}
                onChange={(value) => {
                  setPhotoUrl(value)
                  setImgFailed(false)
                }}
                placeholder="https://..."
                hint={t('image.urlOrUpload')}
              />
            </div>
          </div>
        </>
      ) : null}

      {step === 2 ? (
        <div className={controls.field}>
          <label className={controls.label}>{t('onboarding.themeTitle')}</label>
          <div className={controls.pillRow}>
            {THEME_OPTIONS.map((theme) => (
              <button
                key={theme.id}
                type="button"
                className={`${controls.pill} ${preferences.uiTheme === theme.id ? controls.pillActive : ''}`}
                onClick={() => setUiTheme(theme.id)}
              >
                {themeLabel(t, theme.id)}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {step === 3 ? (
        <div className={controls.field}>
          <label className={controls.label}>{t('onboarding.agentsTitle')}</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {AGENTS.map((a) => {
              const enabled = preferences.enabledAgents[a.id]
              const lockedSingle = enabled && enabledCount === 1
              return (
                <button
                  key={a.id}
                  type="button"
                  disabled={lockedSingle}
                  onClick={() => setAgentEnabled(a.id, !enabled)}
                  className={`${controls.pill} ${enabled ? controls.pillActive : ''}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 14px',
                    textAlign: 'left',
                  }}
                >
                  <span
                    style={{
                      width: 22,
                      height: 22,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <AgentIcon type={a.id} size={20} theme={terminalTheme} />
                  </span>
                  <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                    <strong style={{ fontSize: 13 }}>{a.label}</strong>
                    <span style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 400 }}>
                      {t(`agent.${a.id}.desc`)}
                    </span>
                  </span>
                  {enabled ? (
                    <Check size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                  ) : null}
                </button>
              )
            })}
          </div>
          <span style={{ fontSize: 11, color: 'var(--fg-faint)', marginTop: 4 }}>
            {t('onboarding.localNote')}
          </span>
        </div>
      ) : null}
    </Modal>
  )
}

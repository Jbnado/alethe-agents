import { Minus, Plus, RotateCcw } from 'lucide-react'

import { LOCALES, useT } from '../../lib/i18n'
import { getProfileImageUrl, getProfileInitial } from '../../lib/profile'
import { THEME_OPTIONS, themeLabel } from '../../lib/themes'
import { UI_ZOOM_LIMITS, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import type { AgentType } from '../../lib/types'
import { ImageInput } from './ImageInput'
import { Modal } from './Modal'
import controls from './controls.module.css'

const AGENTS: { id: AgentType; label: string }[] = [
  { id: 'shell', label: 'Shell' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
]

export function PreferencesModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'preferences')
  const closeModal = useUiStore((s) => s.closeModal)
  const preferences = useProjectsStore((s) => s.preferences)
  const setLanguage = useProjectsStore((s) => s.setLanguage)
  const setUiTheme = useProjectsStore((s) => s.setUiTheme)
  const setUiZoom = useProjectsStore((s) => s.setUiZoom)
  const setTerminalTheme = useProjectsStore((s) => s.setTerminalTheme)
  const setAgentEnabled = useProjectsStore((s) => s.setAgentEnabled)
  const setPreferences = useProjectsStore((s) => s.setPreferences)

  const enabledCount = Object.values(preferences.enabledAgents).filter(Boolean).length
  const avatarUrl = getProfileImageUrl(preferences)
  const initial = getProfileInitial(preferences.displayName)

  return (
    <Modal open={open} onClose={closeModal} title={t('prefs.title')} width={520}>
      <Section title={t('prefs.profile')}>
        <div style={{ display: 'grid', gridTemplateColumns: '48px 1fr', gap: 12, alignItems: 'center' }}>
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt=""
              draggable={false}
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                objectFit: 'cover',
                border: '1px solid var(--border)',
              }}
            />
          ) : (
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                display: 'grid',
                placeItems: 'center',
                border: '1px solid var(--border)',
                background: 'var(--bg-sunken)',
                color: 'var(--fg)',
                fontWeight: 700,
              }}
            >
              {initial}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input
              className={controls.input}
              value={preferences.displayName}
              onChange={(e) => setPreferences({ displayName: e.target.value })}
              placeholder={t('prefs.namePlaceholder')}
              maxLength={60}
            />
            <ImageInput
              label={t('prefs.photoPlaceholder')}
              value={preferences.profileImageUrl}
              onChange={(profileImageUrl) => setPreferences({ profileImageUrl })}
              placeholder={t('prefs.photoPlaceholder')}
              hint={t('image.urlOrUpload')}
            />
          </div>
        </div>
      </Section>

      <Section title={t('prefs.language')}>
        <div className={controls.pillRow}>
          {LOCALES.map((loc) => (
            <button
              key={loc.id}
              type="button"
              className={`${controls.pill} ${preferences.language === loc.id ? controls.pillActive : ''}`}
              onClick={() => setLanguage(loc.id)}
            >
              {loc.nativeName}
            </button>
          ))}
        </div>
      </Section>

      <Section title={t('prefs.uiTheme')}>
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
      </Section>

      <Section title={t('prefs.uiZoom')}>
        <div className={controls.stepperRow}>
          <button
            type="button"
            className={controls.iconBtn}
            onClick={() => setUiZoom(preferences.uiZoom - UI_ZOOM_LIMITS.step)}
            disabled={preferences.uiZoom <= UI_ZOOM_LIMITS.min}
            title={t('prefs.zoomDecrease')}
            aria-label={t('prefs.zoomDecrease')}
          >
            <Minus size={14} />
          </button>
          <div className={controls.stepperValue}>
            {Math.round(preferences.uiZoom * 100)}%
          </div>
          <button
            type="button"
            className={controls.iconBtn}
            onClick={() => setUiZoom(preferences.uiZoom + UI_ZOOM_LIMITS.step)}
            disabled={preferences.uiZoom >= UI_ZOOM_LIMITS.max}
            title={t('prefs.zoomIncrease')}
            aria-label={t('prefs.zoomIncrease')}
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            className={controls.iconBtn}
            onClick={() => setUiZoom(1)}
            disabled={preferences.uiZoom === 1}
            title={t('prefs.zoomReset')}
            aria-label={t('prefs.zoomReset')}
          >
            <RotateCcw size={14} />
          </button>
        </div>
      </Section>

      <Section title={t('prefs.terminalTheme')}>
        <div className={controls.pillRow}>
          <button
            type="button"
            className={`${controls.pill} ${preferences.terminalTheme === null ? controls.pillActive : ''}`}
            onClick={() => setTerminalTheme(null)}
          >
            {t('common.followUi')}
          </button>
          {THEME_OPTIONS.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className={`${controls.pill} ${preferences.terminalTheme === theme.id ? controls.pillActive : ''}`}
              onClick={() => setTerminalTheme(theme.id)}
            >
              {themeLabel(t, theme.id)}
            </button>
          ))}
        </div>
      </Section>

      <Section title={t('prefs.enabledAgents', { count: enabledCount })}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {AGENTS.map((a) => {
            const checked = preferences.enabledAgents[a.id]
            const disabled = checked && enabledCount === 1
            return (
              <label
                key={a.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-sunken)',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.6 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={(e) => setAgentEnabled(a.id, e.target.checked)}
                />
                <span style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{a.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{t(`agent.${a.id}.desc`)}</div>
                </span>
              </label>
            )
          })}
        </div>
      </Section>

      <Section title={t('prefs.spotify')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            className={controls.input}
            value={preferences.spotifyClientId}
            onChange={(e) => setPreferences({ spotifyClientId: e.target.value })}
            placeholder="Client ID"
            spellCheck={false}
          />
          <input
            className={controls.input}
            type="password"
            value={preferences.spotifyClientSecret}
            onChange={(e) => setPreferences({ spotifyClientSecret: e.target.value })}
            placeholder="Client Secret"
            spellCheck={false}
          />
          <div style={{ fontSize: 11, color: 'var(--fg-faint)', lineHeight: 1.45 }}>
            {t('prefs.spotifyHint', {
              redirect: 'http://127.0.0.1:8888/callback',
              idEnv: 'SPOTIFY_CLIENT_ID',
              secretEnv: 'SPOTIFY_CLIENT_SECRET',
            })}
          </div>
        </div>
      </Section>
    </Modal>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={controls.field}>
      <label className={controls.label}>{title}</label>
      {children}
    </div>
  )
}

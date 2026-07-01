import * as Dialog from '@radix-ui/react-dialog'
import {
  Check,
  ChevronRight,
  Minus,
  Palette,
  Plug,
  Plus,
  RotateCcw,
  Search,
  TerminalSquare,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { AgentIcon } from '../icons/AgentIcons'
import { LOCALES, useT } from '../../lib/i18n'
import { getProfileImageUrl, getProfileInitial } from '../../lib/profile'
import { THEME_OPTIONS, themeDescription, themeLabel } from '../../lib/themes'
import {
  SPAWN_CONCURRENCY_LIMITS,
  UI_ZOOM_LIMITS,
  useProjectsStore,
} from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { resetLastSession } from '../../lib/resetLastSession'
import type { AgentType } from '../../lib/types'
import { ImageInput } from './ImageInput'
import controls from './controls.module.css'
import styles from './PreferencesModal.module.css'

type CategoryId = 'account' | 'appearance' | 'terminal' | 'integrations'

type Category = {
  id: CategoryId
  label: string
  description: string
  Icon: LucideIcon
}

type SearchItem = {
  category: CategoryId
  target: string
  label: string
  description: string
  keywords: string
}

const AGENTS: { id: AgentType; label: string }[] = [
  { id: 'shell', label: 'Shell' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'freebuff', label: 'Freebuff' },
  { id: 'mimo', label: 'Mimo Code' },
]

export function PreferencesModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'preferences')
  const closeModal = useUiStore((state) => state.closeModal)
  const openModal = useUiStore((state) => state.openModal_)
  const preferences = useProjectsStore((state) => state.preferences)
  const [category, setCategory] = useState<CategoryId>('account')
  const [query, setQuery] = useState('')
  const [resultCursor, setResultCursor] = useState(0)
  const [pendingTarget, setPendingTarget] = useState<string | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  const categories = useMemo<Category[]>(
    () => [
      { id: 'account', label: t('prefs.categoryAccount'), description: t('prefs.categoryAccountDesc'), Icon: UserRound },
      { id: 'appearance', label: t('prefs.categoryAppearance'), description: t('prefs.categoryAppearanceDesc'), Icon: Palette },
      { id: 'terminal', label: t('prefs.categoryTerminal'), description: t('prefs.categoryTerminalDesc'), Icon: TerminalSquare },
      { id: 'integrations', label: t('prefs.categoryIntegrations'), description: t('prefs.categoryIntegrationsDesc'), Icon: Plug },
    ],
    [t],
  )

  const searchItems = useMemo<SearchItem[]>(
    () => [
      { category: 'account', target: 'profile', label: t('prefs.profile'), description: t('prefs.profileDesc'), keywords: 'avatar photo name nome perfil account conta' },
      { category: 'account', target: 'language', label: t('prefs.language'), description: t('prefs.languageDesc'), keywords: 'language idioma português english' },
      { category: 'account', target: 'local-accounts', label: t('prefs.localAccounts'), description: t('prefs.localAccountsDesc'), keywords: 'account profile conta perfil local switch trocar' },
      { category: 'appearance', target: 'ui-theme', label: t('prefs.uiTheme'), description: t('prefs.uiThemeDesc'), keywords: 'theme tema colors cores light dark claro escuro' },
      { category: 'appearance', target: 'ui-zoom', label: t('prefs.uiZoom'), description: t('prefs.uiZoomDesc'), keywords: 'zoom scale escala tamanho interface' },
      { category: 'appearance', target: 'git-control', label: t('prefs.gitControl'), description: t('prefs.gitControlDesc'), keywords: 'git source control sidebar version controle versao' },
      { category: 'terminal', target: 'terminal-theme', label: t('prefs.terminalTheme'), description: t('prefs.terminalThemeDesc'), keywords: 'terminal theme tema colors cores' },
      { category: 'terminal', target: 'spawn-concurrency', label: t('prefs.spawnConcurrency'), description: t('prefs.spawnConcurrencyDesc'), keywords: 'spawn concurrency parallel paralelo fila queue performance pty' },
      { category: 'terminal', target: 'agents', label: t('prefs.agentsTitle'), description: t('prefs.agentsDesc'), keywords: 'agents agentes claude codex opencode shell' },
      { category: 'terminal', target: 'reset-session', label: t('prefs.resetSession'), description: t('prefs.resetSessionDesc'), keywords: 'reset session resume retomar resetar sessão última last recover recuperar resume crash boot' },
      { category: 'integrations', target: 'spotify', label: t('prefs.spotify'), description: t('prefs.spotifyDesc'), keywords: 'spotify music música client id secret' },
      { category: 'integrations', target: 'discord', label: t('prefs.discordPresence'), description: t('prefs.discordPresenceHint'), keywords: 'discord rich presence status integração' },
    ],
    [t],
  )

  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(preferences.language)
    if (!normalized) return []
    return searchItems.filter((item) =>
      `${item.label} ${item.description} ${item.keywords}`
        .toLocaleLowerCase(preferences.language)
        .includes(normalized),
    )
  }, [preferences.language, query, searchItems])

  const activeCategory = categories.find((item) => item.id === category) ?? categories[0]
  const avatarUrl = getProfileImageUrl(preferences)
  const displayName = preferences.displayName || t('profile.fallbackName')
  const initial = getProfileInitial(displayName)
  const enabledCount = Object.values(preferences.enabledAgents).filter(Boolean).length

  useEffect(() => {
    if (!open) return
    setCategory('account')
    setQuery('')
    setResultCursor(0)
    setPendingTarget(null)
  }, [open])

  useEffect(() => {
    setResultCursor(0)
  }, [query])

  useEffect(() => {
    if (!pendingTarget) return
    const frame = window.requestAnimationFrame(() => {
      const target = contentRef.current?.querySelector<HTMLElement>(
        `[data-setting-id="${pendingTarget}"]`,
      )
      target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      target?.focus({ preventScroll: true })
      setPendingTarget(null)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [category, pendingTarget])

  const openSearchResult = (item: SearchItem) => {
    setCategory(item.category)
    setPendingTarget(item.target)
    setQuery('')
  }

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault()
      setResultCursor((cursor) => (cursor + 1) % results.length)
    } else if (event.key === 'ArrowUp' && results.length > 0) {
      event.preventDefault()
      setResultCursor((cursor) => (cursor - 1 + results.length) % results.length)
    } else if (event.key === 'Enter' && results[resultCursor]) {
      event.preventDefault()
      openSearchResult(results[resultCursor])
    } else if (event.key === 'Escape' && query) {
      event.preventDefault()
      event.stopPropagation()
      setQuery('')
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => !nextOpen && closeModal()}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          ref={dialogRef}
          className={styles.dialog}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            const input = dialogRef.current?.querySelector<HTMLInputElement>('[data-settings-search]')
            input?.focus()
          }}
        >
          <Dialog.Title className={styles.srOnly}>{t('prefs.title')}</Dialog.Title>

          <aside className={styles.sidebar}>
            <button type="button" className={styles.profileButton} onClick={() => setCategory('account')}>
              <Avatar url={avatarUrl} initial={initial} />
              <span className={styles.profileCopy}>
                <strong>{displayName}</strong>
                <span>{t('prefs.editProfile')}</span>
              </span>
              <ChevronRight size={14} />
            </button>

            <div className={styles.searchWrap}>
              <Search size={15} aria-hidden />
              <input
                data-settings-search
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder={t('prefs.searchPlaceholder')}
                aria-label={t('prefs.searchPlaceholder')}
                aria-expanded={Boolean(query)}
              />
              {query ? (
                <button type="button" onClick={() => setQuery('')} aria-label={t('prefs.clearSearch')}>
                  <X size={13} />
                </button>
              ) : null}
            </div>

            {query ? (
              <div className={styles.searchResults} role="listbox">
                {results.length > 0 ? results.map((item, index) => (
                  <button
                    key={`${item.category}:${item.target}`}
                    type="button"
                    role="option"
                    aria-selected={index === resultCursor}
                    className={index === resultCursor ? styles.searchResultActive : undefined}
                    onMouseEnter={() => setResultCursor(index)}
                    onClick={() => openSearchResult(item)}
                  >
                    <strong>{item.label}</strong>
                    <span>{categories.find((entry) => entry.id === item.category)?.label}</span>
                  </button>
                )) : <div className={styles.searchEmpty}>{t('prefs.noSearchResults')}</div>}
              </div>
            ) : (
              <nav className={styles.nav} aria-label={t('prefs.title')}>
                <span className={styles.navLabel}>{t('prefs.settingsLabel')}</span>
                {categories.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    type="button"
                    className={category === id ? styles.navActive : undefined}
                    aria-current={category === id ? 'page' : undefined}
                    onClick={() => {
                      setCategory(id)
                      contentRef.current?.scrollTo({ top: 0 })
                    }}
                  >
                    <Icon size={16} />
                    <span>{label}</span>
                  </button>
                ))}
              </nav>
            )}
          </aside>

          <main className={styles.main}>
            <header className={styles.header}>
              <div>
                <h1>{activeCategory.label}</h1>
                <p>{activeCategory.description}</p>
              </div>
              <Dialog.Close asChild>
                <button type="button" className={styles.close} aria-label={t('common.close')}>
                  <X size={18} />
                </button>
              </Dialog.Close>
            </header>

            <div ref={contentRef} className={styles.content}>
              <div className={styles.contentInner}>
                {category === 'account' ? (
                  <AccountPage
                    avatarUrl={avatarUrl}
                    initial={initial}
                    onManageAccounts={() => openModal('profiles')}
                  />
                ) : null}
                {category === 'appearance' ? <AppearancePage /> : null}
                {category === 'terminal' ? <TerminalPage enabledCount={enabledCount} /> : null}
                {category === 'integrations' ? <IntegrationsPage /> : null}
              </div>
            </div>
          </main>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function AccountPage({
  avatarUrl,
  initial,
  onManageAccounts,
}: {
  avatarUrl: string | null
  initial: string
  onManageAccounts: () => void
}) {
  const t = useT()
  const preferences = useProjectsStore((state) => state.preferences)
  const setLanguage = useProjectsStore((state) => state.setLanguage)
  const setPreferences = useProjectsStore((state) => state.setPreferences)

  return (
    <>
      <SettingsSection id="profile" title={t('prefs.profile')} description={t('prefs.profileDesc')}>
        <div className={styles.profileEditor}>
          <Avatar url={avatarUrl} initial={initial} large />
          <div className={styles.profileFields}>
            <label>
              <span>{t('prefs.displayName')}</span>
              <input
                className={controls.input}
                value={preferences.displayName}
                onChange={(event) => setPreferences({ displayName: event.target.value })}
                placeholder={t('prefs.namePlaceholder')}
                maxLength={60}
              />
            </label>
            <ImageInput
              label={t('prefs.profilePhoto')}
              value={preferences.profileImageUrl}
              onChange={(profileImageUrl) => setPreferences({ profileImageUrl })}
              placeholder={t('prefs.photoPlaceholder')}
              hint={t('image.urlOrUpload')}
            />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection id="language" title={t('prefs.language')} description={t('prefs.languageDesc')}>
        <div className={styles.choiceGrid}>
          {LOCALES.map((locale) => (
            <button
              key={locale.id}
              type="button"
              className={preferences.language === locale.id ? styles.choiceActive : undefined}
              onClick={() => setLanguage(locale.id)}
            >
              <span>{locale.nativeName}</span>
              {preferences.language === locale.id ? <Check size={16} /> : null}
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection id="local-accounts" title={t('prefs.localAccounts')} description={t('prefs.localAccountsDesc')}>
        <button type="button" className={styles.secondaryButton} onClick={onManageAccounts}>
          <UserRound size={15} />
          {t('profile.manageAccounts')}
          <ChevronRight size={15} />
        </button>
      </SettingsSection>
    </>
  )
}

function AppearancePage() {
  const t = useT()
  const preferences = useProjectsStore((state) => state.preferences)
  const setUiTheme = useProjectsStore((state) => state.setUiTheme)
  const setUiZoom = useProjectsStore((state) => state.setUiZoom)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  return (
    <>
      <SettingsSection id="ui-theme" title={t('prefs.uiTheme')} description={t('prefs.uiThemeDesc')}>
        <div className={styles.themeGrid}>
          {THEME_OPTIONS.map((theme) => {
            const active = preferences.uiTheme === theme.id
            return (
              <button
                key={theme.id}
                type="button"
                className={active ? styles.themeActive : undefined}
                onClick={() => setUiTheme(theme.id)}
              >
                <span className={styles.swatches} aria-hidden>
                  {theme.colors.map((color) => <span key={color} style={{ background: color }} />)}
                </span>
                <span className={styles.themeName}>
                  <strong>{themeLabel(t, theme.id)}</strong>
                  {active ? <Check size={15} /> : null}
                </span>
                <span>{themeDescription(t, theme.id)}</span>
              </button>
            )
          })}
        </div>
      </SettingsSection>

      <SettingsSection id="ui-zoom" title={t('prefs.uiZoom')} description={t('prefs.uiZoomDesc')}>
        <div className={styles.zoomControl}>
          <button
            type="button"
            onClick={() => setUiZoom(preferences.uiZoom - UI_ZOOM_LIMITS.step)}
            disabled={preferences.uiZoom <= UI_ZOOM_LIMITS.min}
            aria-label={t('prefs.zoomDecrease')}
          ><Minus size={15} /></button>
          <strong>{Math.round(preferences.uiZoom * 100)}%</strong>
          <button
            type="button"
            onClick={() => setUiZoom(preferences.uiZoom + UI_ZOOM_LIMITS.step)}
            disabled={preferences.uiZoom >= UI_ZOOM_LIMITS.max}
            aria-label={t('prefs.zoomIncrease')}
          ><Plus size={15} /></button>
          <button
            type="button"
            onClick={() => setUiZoom(1)}
            disabled={preferences.uiZoom === 1}
            aria-label={t('prefs.zoomReset')}
          ><RotateCcw size={15} /></button>
        </div>
      </SettingsSection>

      <SettingsSection id="git-control" title={t('prefs.gitControl')} description={t('prefs.gitControlDesc')}>
        <div className={styles.segmented}>
          <button type="button" className={preferences.showGitControl ? styles.segmentActive : undefined} onClick={() => setPreferences({ showGitControl: true })}>{t('prefs.gitControlShow')}</button>
          <button type="button" className={!preferences.showGitControl ? styles.segmentActive : undefined} onClick={() => setPreferences({ showGitControl: false })}>{t('prefs.gitControlHide')}</button>
        </div>
      </SettingsSection>
    </>
  )
}

function TerminalPage({ enabledCount }: { enabledCount: number }) {
  const t = useT()
  const preferences = useProjectsStore((state) => state.preferences)
  const setTerminalTheme = useProjectsStore((state) => state.setTerminalTheme)
  const setAgentEnabled = useProjectsStore((state) => state.setAgentEnabled)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const pushToast = useUiStore((state) => state.pushToast)
  const [resetting, setResetting] = useState(false)
  const concurrency = preferences.spawnConcurrency
  const setConcurrency = (n: number) =>
    setPreferences({
      spawnConcurrency: Math.min(
        SPAWN_CONCURRENCY_LIMITS.max,
        Math.max(SPAWN_CONCURRENCY_LIMITS.min, n),
      ),
    })

  const onResetLastSession = async () => {
    if (resetting) return
    setResetting(true)
    try {
      const { resumed, total } = await resetLastSession()
      if (total === 0) {
        pushToast({ title: t('prefs.resetSessionEmpty'), body: t('prefs.resetSessionEmptyBody') })
      } else {
        pushToast({ title: t('prefs.resetSessionDone'), body: t('prefs.resetSessionDoneBody', { count: resumed }) })
      }
    } catch (err) {
      pushToast({ title: t('prefs.resetSessionFailed'), body: String(err) })
    } finally {
      setResetting(false)
    }
  }

  return (
    <>
      <SettingsSection id="spawn-concurrency" title={t('prefs.spawnConcurrency')} description={t('prefs.spawnConcurrencyDesc')}>
        <div className={styles.zoomControl}>
          <button
            type="button"
            onClick={() => setConcurrency(concurrency - SPAWN_CONCURRENCY_LIMITS.step)}
            disabled={concurrency <= SPAWN_CONCURRENCY_LIMITS.min}
            aria-label={t('prefs.spawnConcurrencyDecrease')}
          ><Minus size={15} /></button>
          <strong>{concurrency}</strong>
          <button
            type="button"
            onClick={() => setConcurrency(concurrency + SPAWN_CONCURRENCY_LIMITS.step)}
            disabled={concurrency >= SPAWN_CONCURRENCY_LIMITS.max}
            aria-label={t('prefs.spawnConcurrencyIncrease')}
          ><Plus size={15} /></button>
          <button
            type="button"
            onClick={() => setConcurrency(3)}
            disabled={concurrency === 3}
            aria-label={t('prefs.spawnConcurrencyReset')}
          ><RotateCcw size={15} /></button>
        </div>
      </SettingsSection>

      <SettingsSection id="terminal-theme" title={t('prefs.terminalTheme')} description={t('prefs.terminalThemeDesc')}>
        <select
          className={styles.select}
          value={preferences.terminalTheme ?? ''}
          onChange={(event) => setTerminalTheme(event.target.value ? event.target.value as typeof preferences.uiTheme : null)}
        >
          <option value="">{t('common.followUi')}</option>
          {THEME_OPTIONS.map((theme) => <option key={theme.id} value={theme.id}>{themeLabel(t, theme.id)}</option>)}
        </select>
      </SettingsSection>

      <SettingsSection id="agents" title={t('prefs.enabledAgents', { count: enabledCount })} description={t('prefs.agentsDesc')}>
        <div className={styles.agentList}>
          {AGENTS.map((agent) => {
            const checked = preferences.enabledAgents[agent.id]
            const disabled = checked && enabledCount === 1
            return (
              <label key={agent.id} className={disabled ? styles.agentDisabled : undefined}>
                <span className={styles.agentIcon}><AgentIcon type={agent.id} size={20} theme={preferences.terminalTheme ?? preferences.uiTheme} /></span>
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

      <SettingsSection id="reset-session" title={t('prefs.resetSession')} description={t('prefs.resetSessionDesc')}>
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

function IntegrationsPage() {
  const t = useT()
  const preferences = useProjectsStore((state) => state.preferences)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  return (
    <>
      <SettingsSection id="spotify" title={t('prefs.spotify')} description={t('prefs.spotifyDesc')}>
        <div className={styles.integrationFields}>
          <label><span>Client ID</span><input className={controls.input} value={preferences.spotifyClientId} onChange={(event) => setPreferences({ spotifyClientId: event.target.value })} spellCheck={false} /></label>
          <label><span>Client Secret</span><input className={controls.input} type="password" value={preferences.spotifyClientSecret} onChange={(event) => setPreferences({ spotifyClientSecret: event.target.value })} spellCheck={false} /></label>
          <p>{t('prefs.spotifyHint', { redirect: 'http://127.0.0.1:8888/callback', idEnv: 'SPOTIFY_CLIENT_ID', secretEnv: 'SPOTIFY_CLIENT_SECRET' })}</p>
        </div>
      </SettingsSection>

      <SettingsSection id="discord" title={t('prefs.discordPresence')} description={t('prefs.discordPresenceHint')}>
        <div className={styles.segmented}>
          <button type="button" className={preferences.discordRichPresenceEnabled ? styles.segmentActive : undefined} onClick={() => setPreferences({ discordRichPresenceEnabled: true })}>{t('prefs.discordPresenceEnabled')}</button>
          <button type="button" className={!preferences.discordRichPresenceEnabled ? styles.segmentActive : undefined} onClick={() => setPreferences({ discordRichPresenceEnabled: false })}>{t('prefs.discordPresenceDisabled')}</button>
        </div>
      </SettingsSection>
    </>
  )
}

function SettingsSection({ id, title, description, children }: { id: string; title: string; description: string; children: React.ReactNode }) {
  return (
    <section className={styles.section} data-setting-id={id} tabIndex={-1}>
      <div className={styles.sectionHeading}><h2>{title}</h2><p>{description}</p></div>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  )
}

function Avatar({ url, initial, large = false }: { url: string | null; initial: string; large?: boolean }) {
  return url ? (
    <img src={url} alt="" draggable={false} className={`${styles.avatar} ${large ? styles.avatarLarge : ''}`} />
  ) : (
    <span className={`${styles.avatar} ${styles.avatarFallback} ${large ? styles.avatarLarge : ''}`}>{initial}</span>
  )
}

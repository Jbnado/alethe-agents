import { getCurrentWebview } from '@tauri-apps/api/webview'
import { Bell, X } from 'lucide-react'
import { lazy, Suspense, type CSSProperties, useEffect } from 'react'

import { AgentIcon } from './components/icons/AgentIcons'
import { ErrorBoundary } from './components/ErrorBoundary'
import { FocusOverlay } from './components/FocusOverlay'
import { MainMenu } from './components/MainMenu'
import { ProjectSidebar } from './components/ProjectSidebar'
import { TitleBar } from './components/TitleBar'
import { TokenHud } from './components/TokenHud'
import { WorkspaceView } from './components/WorkspaceView'
import { FindJumpModal } from './components/modals/FindJumpModal'
import { EditGroupModal } from './components/modals/EditGroupModal'
import { EditProjectModal } from './components/modals/EditProjectModal'
import { NewGroupModal } from './components/modals/NewGroupModal'
import { NewProjectModal } from './components/modals/NewProjectModal'
import { NewSubTabModal } from './components/modals/NewSubTabModal'
import { NewTerminalModal } from './components/modals/NewTerminalModal'
import { OnboardingModal } from './components/modals/OnboardingModal'
import { ProfilesModal } from './components/modals/ProfilesModal'
import { PreferencesModal } from './components/modals/PreferencesModal'
import { SyncModal } from './components/modals/SyncModal'
import { SuspendGroupModal } from './components/modals/SuspendGroupModal'
import { ThemePickerModal } from './components/modals/ThemePickerModal'
import { TopbarSettingsModal } from './components/modals/TopbarSettingsModal'
import { UpdateModal } from './components/modals/UpdateModal'
import { WelcomeModal } from './components/modals/WelcomeModal'
import { useKeybindings } from './hooks/useKeybindings'
import { useDiscordPresence } from './hooks/useDiscordPresence'
import { startActivityTracker } from './lib/activityTracker'
import { intlLocale, translate } from './lib/i18n'
import { setMaxConcurrentSpawns } from './lib/spawnQueue'
import { getLastCrashReport } from './lib/tauri'
import { checkForUpdate } from './lib/updater'
import { useProjectsStore } from './stores/projectsStore'
import { type InAppToast, useUiStore } from './stores/uiStore'
import styles from './App.module.css'
import logoLoading from './assets/logo-loading.png'

const AgentCanvasPOC = lazy(() =>
  import('./components/AgentCanvasPOC').then((module) => ({ default: module.AgentCanvasPOC })),
)
const HomeView = lazy(() =>
  import('./components/HomeView').then((module) => ({ default: module.HomeView })),
)
const LayoutDesignerModal = lazy(() =>
  import('./components/modals/LayoutDesignerModal').then((module) => ({
    default: module.LayoutDesignerModal,
  })),
)
const MemoryAnalyticsModal = lazy(() =>
  import('./components/modals/MemoryAnalyticsModal').then((module) => ({
    default: module.MemoryAnalyticsModal,
  })),
)

function LoadingScreen() {
  return (
    <div className={styles.loadingScreen}>
      <img className={styles.loadingMark} src={logoLoading} alt="Alethe" />
    </div>
  )
}

function ToastItem({ toast }: { toast: InAppToast }) {
  const dismissToast = useUiStore((s) => s.dismissToast)
  const uiTheme = useProjectsStore((s) => s.preferences.uiTheme)

  useEffect(() => {
    const timer = window.setTimeout(() => dismissToast(toast.id), 6500)
    return () => window.clearTimeout(timer)
  }, [dismissToast, toast.id])

  const accentStyle = {
    '--toast-accent': toast.agent ? `var(--agent-${toast.agent})` : 'var(--accent)',
  } as CSSProperties

  return (
    <div className={styles.toast} role="status" style={accentStyle}>
      <div className={styles.toastIcon} aria-hidden>
        {toast.agent ? (
          <AgentIcon type={toast.agent} size={16} theme={uiTheme} />
        ) : (
          <Bell size={14} />
        )}
      </div>
      <div className={styles.toastText}>
        <strong>{toast.title}</strong>
        <span>{toast.body}</span>
      </div>
      <button
        type="button"
        className={styles.toastClose}
        onClick={() => dismissToast(toast.id)}
        aria-label="Fechar notificação"
        title="Fechar"
      >
        <X size={14} />
      </button>
    </div>
  )
}

function InAppNotifications() {
  const toasts = useUiStore((s) => s.toasts)
  if (toasts.length === 0) return null

  return (
    <div className={styles.toastStack} aria-live="polite" aria-relevant="additions">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}

export default function App() {
  const hydrate = useProjectsStore((s) => s.hydrate)
  const hydrated = useProjectsStore((s) => s.hydrated)
  const uiTheme = useProjectsStore((s) => s.preferences.uiTheme)
  const uiZoom = useProjectsStore((s) => s.preferences.uiZoom)
  const language = useProjectsStore((s) => s.preferences.language)
  const spawnConcurrency = useProjectsStore((s) => s.preferences.spawnConcurrency)
  const activeView = useUiStore((s) => s.activeView)
  const openModal = useUiStore((s) => s.openModal)
  const sidebarVisible = useUiStore((s) => s.sidebarVisible)

  useKeybindings()
  useDiscordPresence()

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  useEffect(() => {
    document.documentElement.dataset.theme = uiTheme
  }, [uiTheme])

  useEffect(() => {
    document.documentElement.lang = language === 'pt-BR' ? 'pt-BR' : 'en'
  }, [language])

  useEffect(() => {
    setMaxConcurrentSpawns(spawnConcurrency)
  }, [spawnConcurrency])

  useEffect(() => {
    if (!hydrated) return
    document.documentElement.dataset.zoom = String(uiZoom)
    void getCurrentWebview()
      .setZoom(uiZoom)
      .catch(() => {
        /* setZoom exige permissão Tauri em runtime; em testes/browser puro pode falhar. */
      })
      .finally(() => {
        window.dispatchEvent(new CustomEvent('alethe:zoom-changed', { detail: { zoom: uiZoom } }))
      })
  }, [hydrated, uiZoom])

  useEffect(() => {
    if (!hydrated) return
    const { preferences, setPreferences } = useProjectsStore.getState()
    if (preferences.firstLaunchAt === null) {
      setPreferences({ firstLaunchAt: Date.now() })
    }
    if (preferences.accountCreated && preferences.onboardingDone) {
      useUiStore.getState().openModal_('welcome')
    }
    useUiStore.getState().setActiveView(preferences.alwaysStartOnHome ? 'home' : 'workspace')
  }, [hydrated])

  useEffect(() => {
    if (!hydrated) return
    return startActivityTracker()
  }, [hydrated])

  // Checa atualização em silêncio no boot. Se houver, o chip discreto na sidebar
  // aparece (SidebarUpdate); nada de popup. Erros (dev sem assinatura, offline,
  // endpoint fora) são engolidos — updater indisponível = "sem update".
  useEffect(() => {
    if (!hydrated) return
    let cancelled = false
    void checkForUpdate()
      .then((info) => {
        if (!cancelled) useUiStore.getState().setUpdateInfo(info)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [hydrated])

  // Se a sessão anterior não saiu limpa (crash/OOM/kill), avisa com o estado de
  // memória de quando caiu — diagnóstico de "o que matou o app".
  useEffect(() => {
    if (!hydrated) return
    void getLastCrashReport()
      .then((report) => {
        if (!report) return
        const lang = useProjectsStore.getState().preferences.language
        const when = new Date(report.last_heartbeat_ms || report.started_at_ms)
        useUiStore.getState().pushToast({
          title: translate(lang, 'crash.uncleanTitle'),
          body: translate(lang, 'crash.uncleanBody', {
            total: Math.round(report.total_mb),
            procs: report.process_count,
            time: when.toLocaleTimeString(intlLocale(lang)),
          }),
        })
      })
      .catch(() => {})
  }, [hydrated])

  if (!hydrated) {
    return <LoadingScreen />
  }

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg)' }}>
        <TitleBar />
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {sidebarVisible ? <ProjectSidebar /> : null}
          <ErrorBoundary label="view">
            <Suspense fallback={<LoadingScreen />}>
              {activeView === 'home' ? (
                <HomeView />
              ) : activeView === 'agentCanvas' ? (
                <AgentCanvasPOC />
              ) : (
                <WorkspaceView />
              )}
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>
      <FocusOverlay />
      <MainMenu />
      <ErrorBoundary label="modals">
      <NewProjectModal />
      <NewGroupModal />
      <EditGroupModal />
      <EditProjectModal />
      <NewTerminalModal />
      <NewSubTabModal />
      <PreferencesModal />
      <ProfilesModal />
      <SyncModal />
      <FindJumpModal />
      <OnboardingModal />
      <WelcomeModal />
      {openModal === 'layoutDesigner' ? (
        <Suspense fallback={null}>
          <LayoutDesignerModal />
        </Suspense>
      ) : null}
      <SuspendGroupModal />
      {openModal === 'memoryAnalytics' ? (
        <Suspense fallback={null}>
          <MemoryAnalyticsModal />
        </Suspense>
      ) : null}
      <ThemePickerModal />
      <TopbarSettingsModal />
      <UpdateModal />
      </ErrorBoundary>
      <InAppNotifications />
      {activeView === 'agentCanvas' ? <TokenHud /> : null}
    </>
  )
}

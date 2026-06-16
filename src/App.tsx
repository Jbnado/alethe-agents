import { getCurrentWebview } from '@tauri-apps/api/webview'
import { Bell, X } from 'lucide-react'
import { type CSSProperties, useEffect } from 'react'

import { AgentCanvasPOC } from './components/AgentCanvasPOC'
import { AgentIcon } from './components/icons/AgentIcons'
import { FocusOverlay } from './components/FocusOverlay'
import { HomeView } from './components/HomeView'
import { MainMenu } from './components/MainMenu'
import { ProjectSidebar } from './components/ProjectSidebar'
import { TitleBar } from './components/TitleBar'
import { WorkspaceView } from './components/WorkspaceView'
import { FindJumpModal } from './components/modals/FindJumpModal'
import { EditGroupModal } from './components/modals/EditGroupModal'
import { EditProjectModal } from './components/modals/EditProjectModal'
import { LayoutDesignerModal } from './components/modals/LayoutDesignerModal'
import { MemoryAnalyticsModal } from './components/modals/MemoryAnalyticsModal'
import { NewGroupModal } from './components/modals/NewGroupModal'
import { NewProjectModal } from './components/modals/NewProjectModal'
import { NewSubTabModal } from './components/modals/NewSubTabModal'
import { NewTerminalModal } from './components/modals/NewTerminalModal'
import { OnboardingModal } from './components/modals/OnboardingModal'
import { ProfilesModal } from './components/modals/ProfilesModal'
import { PreferencesModal } from './components/modals/PreferencesModal'
import { SuspendGroupModal } from './components/modals/SuspendGroupModal'
import { ThemePickerModal } from './components/modals/ThemePickerModal'
import { WelcomeModal } from './components/modals/WelcomeModal'
import { useKeybindings } from './hooks/useKeybindings'
import { useProjectsStore } from './stores/projectsStore'
import { type InAppToast, useUiStore } from './stores/uiStore'
import styles from './App.module.css'

function LoadingScreen() {
  return (
    <div className={styles.loadingScreen}>
      <div className={styles.loadingMarkWrap} aria-hidden>
        {/* figura "vazia" (contorno fraco) */}
        <div className={styles.markGhost} />
        {/* preenchimento que sobe de baixo pra cima + respira luz */}
        <div className={styles.markFill} />
      </div>
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
  const activeView = useUiStore((s) => s.activeView)
  const sidebarVisible = useUiStore((s) => s.sidebarVisible)

  useKeybindings()

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

  if (!hydrated) {
    return <LoadingScreen />
  }

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg)' }}>
        <TitleBar />
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {sidebarVisible ? <ProjectSidebar /> : null}
          {activeView === 'home' ? (
            <HomeView />
          ) : activeView === 'agentCanvas' ? (
            <AgentCanvasPOC />
          ) : (
            <WorkspaceView />
          )}
        </div>
      </div>
      <FocusOverlay />
      <MainMenu />
      <NewProjectModal />
      <NewGroupModal />
      <EditGroupModal />
      <EditProjectModal />
      <NewTerminalModal />
      <NewSubTabModal />
      <PreferencesModal />
      <ProfilesModal />
      <FindJumpModal />
      <OnboardingModal />
      <WelcomeModal />
      <LayoutDesignerModal />
      <SuspendGroupModal />
      <MemoryAnalyticsModal />
      <ThemePickerModal />
      <InAppNotifications />
    </>
  )
}

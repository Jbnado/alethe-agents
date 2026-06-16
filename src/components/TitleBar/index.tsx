import { getCurrentWindow } from '@tauri-apps/api/window'
import { Maximize2, Menu, Minus, PanelLeftClose, PanelLeftOpen, Users, Workflow, X } from 'lucide-react'
import { useEffect } from 'react'

import { getCachedClaudeUsage } from '../../lib/claudeUsageCache'
import { useT } from '../../lib/i18n'
import { getMemoryStats, killPty } from '../../lib/tauri'
import type { ClaudeUsage } from '../../lib/tauri'
import { MAX_RECENT_PROJECT_TABS, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './TitleBar.module.css'

const RAM_POLL_INTERVAL_MS = 5000
const CLAUDE_POLL_INTERVAL_MS = 5 * 60_000
const APP_TITLE = import.meta.env.DEV ? '(DEV) Alethe' : 'Alethe'

function claudePillColor(utilization: number): string {
  if (utilization >= 80) return '#e53935'
  if (utilization >= 50) return '#f9a825'
  return '#43a047'
}

function formatResetTime(resetsAt: string): string {
  try {
    const diff = new Date(resetsAt).getTime() - Date.now()
    if (diff <= 0) return 'resetting...'
    const h = Math.floor(diff / 3_600_000)
    const m = Math.floor((diff % 3_600_000) / 60_000)
    return h > 0 ? `${h}h ${m}m` : `${m}m`
  } catch {
    return resetsAt
  }
}

function buildClaudeTooltip(usage: ClaudeUsage): string {
  const pct = (v: number) => `${v.toFixed(0)}%`
  return [
    `5h session: ${pct(usage.five_hour.utilization)} (resets in ${formatResetTime(usage.five_hour.resets_at)})`,
    `7d total: ${pct(usage.seven_day.utilization)} (resets in ${formatResetTime(usage.seven_day.resets_at)})`,
    `7d opus: ${pct(usage.seven_day_opus.utilization)} (resets in ${formatResetTime(usage.seven_day_opus.resets_at)})`,
  ].join('\n')
}

function collectGroupProjectIds(groupId: string, groups: { id: string; parentGroupId: string | null; projectIds: string[] }[]): Set<string> {
  const result = new Set<string>()
  const queue = [groupId]
  while (queue.length > 0) {
    const current = queue.shift()!
    const group = groups.find((g) => g.id === current)
    if (!group) continue
    for (const projectId of group.projectIds) result.add(projectId)
    for (const child of groups) {
      if (child.parentGroupId === current) queue.push(child.id)
    }
  }
  return result
}

export function TitleBar() {
  const t = useT()
  const toggleMainMenu = useUiStore((s) => s.toggleMainMenu)
  const sidebarVisible = useUiStore((s) => s.sidebarVisible)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const activeGroupTabId = useUiStore((s) => s.activeGroupTabId)
  const activeView = useUiStore((s) => s.activeView)
  const agentCanvasSession = useUiStore((s) => s.agentCanvasSession)
  const setActiveGroupTab = useUiStore((s) => s.setActiveGroupTab)
  const setAgentCanvasSession = useUiStore((s) => s.setAgentCanvasSession)
  const setActiveView = useUiStore((s) => s.setActiveView)
  const ramMb = useUiStore((s) => s.ramMb)
  const addMemorySample = useUiStore((s) => s.addMemorySample)
  const claudeUsage = useUiStore((s) => s.claudeUsage)
  const setClaudeUsage = useUiStore((s) => s.setClaudeUsage)
  const openModal = useUiStore((s) => s.openModal_)
  const containers = useProjectsStore((s) => s.workspace.containers)
  const recentProjectIds = useProjectsStore((s) => s.workspace.recentProjectIds)
  const recentTabs = useProjectsStore((s) => s.workspace.recentTabs)
  const profiles = useProjectsStore((s) => s.profiles)
  const activeProfileId = useProjectsStore((s) => s.activeProfileId)
  const projects = useProjectsStore((s) => s.projects)
  const groups = useProjectsStore((s) => s.groups)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const setActiveProject = useProjectsStore((s) => s.setActiveProject)
  const openGroupScope = useProjectsStore((s) => s.openGroupScope)
  const closeWorkspaceTab = useProjectsStore((s) => s.closeWorkspaceTab)
  const closeOtherContainers = useProjectsStore((s) => s.closeOtherContainers)
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null

  const closeAgentPlanning = () => {
    if (!agentCanvasSession) return
    if (activeView === 'agentCanvas') {
      window.dispatchEvent(new CustomEvent('alethe:agent-canvas-exit'))
      return
    }
    void killPty(agentCanvasSession.ptyId).catch(() => {
      /* PTY pode já ter morrido */
    })
    setAgentCanvasSession(null)
  }

  const recentWorkspaceTabs = (() => {
    const projectsById = new Map(projects.map((p) => [p.id, p]))
    const groupsById = new Map(groups.map((g) => [g.id, g]))
    const containersByProjectId = new Map(containers.map((c) => [c.projectId, c]))
    const tabs =
      recentTabs.length > 0
        ? recentTabs
        : (recentProjectIds.length > 0
            ? recentProjectIds
            : [...containers]
                .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
                .map((c) => c.projectId)
          ).map((id) => ({ kind: 'project' as const, id }))

    return tabs
      .map((tab) => {
        if (tab.kind === 'group') {
          const group = groupsById.get(tab.id)
          if (!group) return null
          const projectCount = collectGroupProjectIds(tab.id, groups).size
          return { kind: 'group' as const, group, projectCount }
        }
        const project = projectsById.get(tab.id)
        if (!project) return null
        return {
          kind: 'project' as const,
          project,
          container: containersByProjectId.get(tab.id) ?? null,
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .slice(0, MAX_RECENT_PROJECT_TABS)
  })()

  // RAM polling — adiado pra não competir com boot/render inicial.
  useEffect(() => {
    let cancelled = false
    let interval: number | null = null
    const tick = async () => {
      try {
        const stats = await getMemoryStats()
        if (!cancelled) addMemorySample(stats)
      } catch {
        /* ignora — backend ainda subindo */
      }
    }
    const startupDelay = window.setTimeout(() => {
      void tick()
      interval = window.setInterval(tick, RAM_POLL_INTERVAL_MS)
    }, 3000)
    return () => {
      cancelled = true
      window.clearTimeout(startupDelay)
      if (interval !== null) window.clearInterval(interval)
    }
  }, [addMemorySample])

  // Claude usage polling — adiado 1.5s (HTTP call externa, não trava boot).
  useEffect(() => {
    let cancelled = false
    let interval: number | null = null
    let consecutiveFailures = 0
    const tick = async () => {
      try {
        const usage = await getCachedClaudeUsage()
        if (!cancelled) {
          setClaudeUsage(usage)
          consecutiveFailures = 0
        }
      } catch {
        // Só limpa após 3 falhas consecutivas — evita "sem token" intermitente
        // quando o credentials.json está sendo escrito pelo Claude ou rede flaky.
        consecutiveFailures += 1
        if (consecutiveFailures >= 3 && !cancelled) {
          setClaudeUsage(null)
        }
      }
    }
    const startupDelay = window.setTimeout(() => {
      void tick()
      interval = window.setInterval(tick, CLAUDE_POLL_INTERVAL_MS)
    }, 1500)
    return () => {
      cancelled = true
      window.clearTimeout(startupDelay)
      if (interval !== null) window.clearInterval(interval)
    }
  }, [setClaudeUsage])

  const win = getCurrentWindow()

  useEffect(() => {
    document.title = APP_TITLE
    void win.setTitle(APP_TITLE)
  }, [win])

  return (
    <div className={styles.bar} data-tauri-drag-region>
      <button
        type="button"
        className={styles.iconBtn}
        onClick={toggleMainMenu}
        title={t('ui.titlebar.menu')}
        aria-label={t('ui.titlebar.menu')}
      >
        <Menu size={14} />
      </button>
      <button
        type="button"
        className={`${styles.iconBtn} ${sidebarVisible ? styles.iconBtnActive : ''}`}
        onClick={toggleSidebar}
        title={sidebarVisible ? t('ui.titlebar.closeSidebar') : t('ui.titlebar.openSidebar')}
        aria-label={sidebarVisible ? t('ui.titlebar.closeSidebar') : t('ui.titlebar.openSidebar')}
        aria-pressed={sidebarVisible}
      >
        {sidebarVisible ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
      </button>
      <span className={styles.title} data-tauri-drag-region>
        {APP_TITLE}
      </span>
      {recentWorkspaceTabs.length > 0 || agentCanvasSession ? (
        <div
          className={styles.groupTabs}
          role="tablist"
          aria-label={t('ui.titlebar.recentTabs')}
          data-tauri-drag-region
        >
          {recentWorkspaceTabs.map((tab) => {
            if (tab.kind === 'group') {
              const { group, projectCount } = tab
              return (
                <div
                  key={`group:${group.id}`}
                  className={`${styles.groupTab} ${
                    activeGroupTabId === group.id ? styles.groupTabActive : ''
                  }`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeGroupTabId === group.id}
                    className={styles.groupTabMain}
                    onClick={() => {
                      openGroupScope(group.id)
                      setActiveGroupTab(group.id)
                      setActiveView('workspace')
                    }}
                    onDoubleClick={() => {
                      openGroupScope(group.id, 'only')
                      setActiveGroupTab(group.id)
                      setActiveView('workspace')
                    }}
                    title={group.name}
                  >
                    {group.iconUrl ? (
                      <img src={group.iconUrl} alt="" className={styles.groupTabIcon} />
                    ) : (
                      <span className={styles.groupTabDot} style={{ background: group.color }} />
                    )}
                    <span className={styles.groupTabName}>{group.name}</span>
                    <span className={styles.groupTabCount}>{projectCount}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.groupTabClose}
                    onClick={(event) => {
                      event.stopPropagation()
                      closeWorkspaceTab({ kind: 'group', id: group.id })
                    }}
                    title={t('ui.titlebar.removeFromTopbar')}
                    aria-label={t('ui.titlebar.removeNameFromTopbar', { name: group.name })}
                  >
                    <X size={11} />
                  </button>
                </div>
              )
            }
            const { project, container } = tab
            return (
              <div
                key={`project:${project.id}`}
                className={`${styles.groupTab} ${
                  activeGroupTabId === null && activeProjectId === project.id
                    ? styles.groupTabActive
                    : ''
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeGroupTabId === null && activeProjectId === project.id}
                  className={styles.groupTabMain}
                  onClick={() => {
                    setActiveProject(project.id)
                    setActiveGroupTab(null)
                    setActiveView('workspace')
                  }}
                  onDoubleClick={() => {
                    closeOtherContainers(project.id)
                    setActiveProject(project.id)
                    setActiveGroupTab(null)
                    setActiveView('workspace')
                  }}
                  title={project.name}
                >
                  {project.iconUrl ? (
                    <img src={project.iconUrl} alt="" className={styles.groupTabIcon} />
                  ) : (
                    <span className={styles.groupTabDot} style={{ background: project.color ?? '#6ea8ff' }} />
                  )}
                  <span className={styles.groupTabName}>{project.name}</span>
                  <span className={styles.groupTabCount}>
                    {container?.paneIds.length ?? project.terminals.length}
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.groupTabClose}
                  onClick={(event) => {
                    event.stopPropagation()
                    closeWorkspaceTab({ kind: 'project', id: project.id })
                  }}
                  title={t('ui.titlebar.removeFromTopbar')}
                  aria-label={t('ui.titlebar.removeNameFromTopbar', { name: project.name })}
                >
                  <X size={11} />
                </button>
              </div>
            )
          })}
          {agentCanvasSession ? (
            <div
              className={`${styles.groupTab} ${activeView === 'agentCanvas' ? styles.groupTabActive : ''}`}
              title={agentCanvasSession.folder}
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeView === 'agentCanvas'}
                className={styles.groupTabMain}
                onClick={() => setActiveView('agentCanvas')}
                title={agentCanvasSession.folder}
              >
                <Workflow size={14} className={styles.groupTabIconSvg} />
                <span className={styles.groupTabName}>Agent Planning</span>
              </button>
              <button
                type="button"
                className={styles.groupTabClose}
                onClick={(event) => {
                  event.stopPropagation()
                  closeAgentPlanning()
                }}
                title={t('ui.titlebar.closeAgentPlanning')}
                aria-label={t('ui.titlebar.closeAgentPlanning')}
              >
                <X size={11} />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className={styles.spacer} data-tauri-drag-region />
      <button
        type="button"
        className={styles.profilePill}
        title={t('profile.manageAccounts')}
        onClick={() => openModal('profiles')}
      >
        <Users size={12} />
        <span className={styles.profilePillLabel}>
          {activeProfile?.name ?? t('profile.localAccount')}
        </span>
      </button>
      {claudeUsage !== null ? (
        <span
          className={styles.claudePill}
          style={{ '--pill-color': claudePillColor(claudeUsage.five_hour.utilization) } as React.CSSProperties}
          title={buildClaudeTooltip(claudeUsage)}
        >
          {claudeUsage.five_hour.utilization.toFixed(0)}%
        </span>
      ) : null}
      {ramMb !== null ? (
        <button
          type="button"
          className={styles.ramPill}
          title={t('ui.titlebar.openMemoryAnalytics')}
          onClick={() => openModal('memoryAnalytics')}
        >
          {ramMb.toFixed(0)} MB
        </button>
      ) : null}
      <button
        type="button"
        className={styles.windowBtn}
        onClick={() => void win.minimize()}
        title={t('ui.titlebar.minimize')}
        aria-label={t('ui.titlebar.minimize')}
      >
        <Minus size={14} />
      </button>
      <button
        type="button"
        className={styles.windowBtn}
        onClick={() => void win.toggleMaximize()}
        title={t('ui.titlebar.maximize')}
        aria-label={t('ui.titlebar.maximize')}
      >
        <Maximize2 size={12} />
      </button>
      <button
        type="button"
        className={`${styles.windowBtn} ${styles.close}`}
        onClick={() => void win.close()}
        title={t('ui.titlebar.close')}
        aria-label={t('ui.titlebar.close')}
      >
        <X size={14} />
      </button>
    </div>
  )
}

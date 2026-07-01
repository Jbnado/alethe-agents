import {
  ArrowRight,
  Bell,
  Bot,
  CheckCircle2,
  FolderPlus,
  Layers,
  Clock3,
  TerminalSquare,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { pickDirectory } from '../../lib/dialog'
import { formatHomeDate, formatRelativeTimestamp, getGreeting } from '../../lib/greeting'
import { useT, type TFunction } from '../../lib/i18n'
import { getFirstName, getProfileImageUrl, getProfileInitial } from '../../lib/profile'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import type { AgentType, Project } from '../../lib/types'
import { AgentIcon } from '../icons/AgentIcons'
import { EmptyState } from '../EmptyState/EmptyState'
import { NowPlayingWidget } from './NowPlayingWidget'
import { UsageStrip } from './UsageStrip'
import { TimeAnalytics } from './TimeAnalytics'
import styles from './HomeView.module.css'

const RECENT_PROJECTS_LIMIT = 6
const NOTIFICATIONS_LIMIT = 5

const NOTIF_AGENT_CLASS: Record<AgentType, string> = {
  claude: styles.notifClaude,
  codex: styles.notifCodex,
  shell: styles.notifShell,
  opencode: styles.notifOpencode,
  freebuff: styles.notifFreebuff,
  mimo: styles.notifMimo,
}

export function HomeView() {
  const t = useT()
  const language = useProjectsStore((s) => s.preferences.language)
  const preferences = useProjectsStore((s) => s.preferences)
  const projects = useProjectsStore((s) => s.projects)
  const recentProjectIds = useProjectsStore((s) => s.workspace.recentProjectIds)
  const containers = useProjectsStore((s) => s.workspace.containers)
  const openContainerWithAllPanes = useProjectsStore((s) => s.openContainerWithAllPanes)
  const setActiveProjectOnly = useProjectsStore((s) => s.setActiveProjectOnly)
  const openModal = useUiStore((s) => s.openModal_)
  const setActiveView = useUiStore((s) => s.setActiveView)
  const notifications = useUiStore((s) => s.notifications)
  const clearNotifications = useUiStore((s) => s.clearNotifications)

  // último uso de cada projeto: container aberto ou maior lastUsedAt dos terminais
  const lastUsedByProject = useMemo(() => {
    const map = new Map<string, number>()
    for (const c of containers) {
      if (c.lastUsedAt) map.set(c.projectId, c.lastUsedAt)
    }
    for (const p of projects) {
      const fromTerminals = p.terminals.reduce((max, t) => Math.max(max, t.lastUsedAt ?? 0), 0)
      const prev = map.get(p.id) ?? 0
      if (fromTerminals > prev) map.set(p.id, fromTerminals)
    }
    return map
  }, [containers, projects])

  const recentProjects = useMemo<Project[]>(() => {
    const byId = new Map(projects.map((p) => [p.id, p]))
    const ordered: Project[] = []
    const seen = new Set<string>()
    for (const id of recentProjectIds) {
      const p = byId.get(id)
      if (p && !seen.has(id)) {
        ordered.push(p)
        seen.add(id)
      }
    }
    // completa com os demais projetos (mais recentes por uso) se faltar
    if (ordered.length < RECENT_PROJECTS_LIMIT) {
      const rest = projects
        .filter((p) => !seen.has(p.id))
        .sort((a, b) => (lastUsedByProject.get(b.id) ?? 0) - (lastUsedByProject.get(a.id) ?? 0))
      ordered.push(...rest)
    }
    return ordered.slice(0, RECENT_PROJECTS_LIMIT)
  }, [projects, recentProjectIds, lastUsedByProject])

  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(interval)
  }, [])

  const greeting = useMemo(() => getGreeting(now, language), [now, language])
  const dateStr = useMemo(() => formatHomeDate(now, language), [now, language])
  const displayName = preferences.displayName
  const firstName = getFirstName(displayName)
  const firstNameLower = firstName.toLowerCase()
  const avatarUrl = getProfileImageUrl(preferences)
  const initial = getProfileInitial(displayName)

  const startAgentSession = () => {
    void (async () => {
      const folder = await pickDirectory()
      if (!folder) return
      useUiStore.getState().setAgentCanvasSession({
        folder,
        ptyId: `agent-canvas-${Date.now()}`,
      })
      setActiveView('agentCanvas')
    })()
  }

  const handleNewTerminal = () => {
    const target = recentProjects[0] ?? projects[0]
    if (target) {
      openModal('newTerminal', { projectId: target.id })
    } else {
      openModal('newProject')
    }
  }

  const openProject = (project: Project) => {
    setActiveProjectOnly(project.id)
    openContainerWithAllPanes(project.id)
    setActiveView('workspace')
  }

  return (
    <section className={styles.home}>
      <header className={styles.header}>
        <div className={styles.identity}>
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className={styles.avatar} draggable={false} />
          ) : (
            <div className={styles.avatar}>{initial}</div>
          )}
          <div>
            <h1 className={styles.greeting}>
              {greeting}, {firstNameLower}.
            </h1>
            <div className={styles.date}>{dateStr}</div>
          </div>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.timeJumpButton}
            onClick={() => document.getElementById('time-analytics')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            <Clock3 size={14} />
            {t('time.open')}
          </button>
          <NowPlayingWidget enabled />
        </div>
      </header>

      <button type="button" className={styles.agentHero} onClick={startAgentSession}>
        <span className={styles.agentHeroIcon}>
          <Bot size={20} />
        </span>
        <span className={styles.agentHeroBody}>
          <span className={styles.agentHeroTitle}>{t('home.agentHeroTitle')}</span>
          <span className={styles.agentHeroSub}>
            {t('home.agentHeroSub')}
          </span>
        </span>
        <span className={styles.agentHeroCta}>
          {t('home.agentHeroCta')}
          <ArrowRight size={15} />
        </span>
      </button>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          {t('home.recentProjects')}
          {recentProjects.length > 0 ? (
            <span className={styles.sectionCount}>{recentProjects.length}</span>
          ) : null}
        </div>
        {recentProjects.length > 0 ? (
          <div className={styles.projectGrid}>
            {recentProjects.map((project) => (
              <RecentProjectCard
                key={project.id}
                project={project}
                lastUsedAt={lastUsedByProject.get(project.id) ?? 0}
                now={now.getTime()}
                onOpen={() => openProject(project)}
                t={t}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<FolderPlus size={22} />}
            title={t('home.projectsEmptyTitle')}
            description={t('home.projectsEmptyDesc')}
            primaryAction={{
              label: t('home.projectsEmptyAction'),
              onClick: () => openModal('newProject'),
            }}
          />
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>{t('home.usageActivity')}</div>
        <UsageStrip />
      </section>

      <section id="time-analytics" className={`${styles.section} ${styles.timeAnalyticsSection}`}>
        <TimeAnalytics />
      </section>

      <div className={styles.bottomGrid}>
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            {t('home.notifications')}
            {notifications.length > 0 ? (
              <>
                <span className={styles.sectionCount}>{notifications.length}</span>
                <button
                  type="button"
                  className={styles.sectionAction}
                  onClick={() => clearNotifications()}
                >
                  {t('home.clear')}
                </button>
              </>
            ) : null}
          </div>
          {notifications.length > 0 ? (
            <ul className={styles.notifList}>
              {notifications.slice(0, NOTIFICATIONS_LIMIT).map((n) => (
                <li key={n.id} className={styles.notifItem}>
                  <span
                    className={`${styles.notifIcon} ${
                      n.agent ? NOTIF_AGENT_CLASS[n.agent] : styles.notifNeutral
                    }`}
                  >
                    {n.agent ? (
                      <AgentIcon type={n.agent} size={14} theme={preferences.uiTheme} />
                    ) : (
                      <Bell size={13} />
                    )}
                  </span>
                  <span className={styles.notifBody}>
                    <span className={styles.notifTitle}>{n.title}</span>
                    <span className={styles.notifText}>{n.body}</span>
                  </span>
                  <span className={styles.notifTime}>
                    {formatRelativeTimestamp(n.createdAt, now.getTime(), language)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              compact
              tone="positive"
              icon={<CheckCircle2 size={18} />}
              title={t('home.notificationsEmptyTitle')}
              description={t('home.notificationsEmptyDesc')}
            />
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>{t('home.startSomething')}</div>
          <div className={styles.actionList}>
            <ActionCard
              icon={<TerminalSquare size={14} />}
              label={t('home.newTerminal')}
              shortcut="⌘T"
              onClick={handleNewTerminal}
            />
            <ActionCard
              icon={<FolderPlus size={14} />}
              label={t('home.newProject')}
              shortcut="⌘⇧P"
              onClick={() => openModal('newProject')}
            />
            <ActionCard
              icon={<Layers size={14} />}
              label={t('home.newGroup')}
              shortcut="⌘⇧G"
              onClick={() => openModal('newGroup')}
            />
          </div>
        </section>
      </div>

      <footer className={styles.footer}>
        <FooterShortcut keys="⌘P" label={t('home.searchShortcut')} onClick={() => openModal('findJump')} />
        <FooterShortcut keys="⌘K" label={t('home.commandShortcut')} />
        <FooterShortcut keys="?" label={t('home.helpShortcut')} />
      </footer>
    </section>
  )
}

function RecentProjectCard({
  project,
  lastUsedAt,
  now,
  onOpen,
  t,
}: {
  project: Project
  lastUsedAt: number
  now: number
  onOpen: () => void
  t: TFunction
}) {
  const terminalCount = project.terminals.length
  return (
    <button type="button" className={styles.projectCard} onClick={onOpen}>
      <ProjectBadge project={project} />
      <span className={styles.projectInfo}>
        <span className={styles.projectName} title={project.name}>
          {project.name}
        </span>
        <span className={styles.projectMeta}>
          {terminalCount === 1
            ? t('home.terminalsOne', { n: terminalCount })
            : t('home.terminalsMany', { n: terminalCount })}
          {lastUsedAt ? ` · ${formatRelativeTimestamp(lastUsedAt, now)}` : ''}
        </span>
      </span>
      <ArrowRight size={15} className={styles.projectArrow} />
    </button>
  )
}

function ProjectBadge({ project }: { project: Project }) {
  if (project.iconUrl) {
    return <img src={project.iconUrl} alt="" className={styles.projectLogo} draggable={false} />
  }
  const letter = project.name.trim().charAt(0).toUpperCase() || '·'
  return (
    <span
      className={styles.projectLogoFallback}
      style={project.color ? { background: project.color } : undefined}
    >
      {letter}
    </span>
  )
}

function ActionCard({
  icon,
  label,
  shortcut,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  shortcut: string
  onClick: () => void
}) {
  return (
    <button type="button" className={styles.actionCard} onClick={onClick}>
      <span className={styles.actionIcon}>{icon}</span>
      <span className={styles.actionLabel}>{label}</span>
      <span className={styles.actionSpacer} />
      <kbd className={styles.kbd}>{shortcut}</kbd>
    </button>
  )
}

function FooterShortcut({
  keys,
  label,
  onClick,
}: {
  keys: string
  label: string
  onClick?: () => void
}) {
  return (
    <button type="button" className={styles.footerShortcut} onClick={onClick}>
      <kbd className={styles.kbd}>{keys}</kbd>
      <span>{label}</span>
    </button>
  )
}

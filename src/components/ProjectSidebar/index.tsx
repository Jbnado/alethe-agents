import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Grid3x3,
  GitBranch,
  Home,
  Layout,
  LayoutGrid,
  MoreHorizontal,
  FileText,
  Pause,
  Plus,
  Sidebar as SidebarIcon,
  type LucideIcon,
} from 'lucide-react'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import {
  selectActiveContainer,
  selectActiveProject,
  useProjectsStore,
} from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { useT } from '../../lib/i18n'
import type { AgentType, Group, LayoutMode, Project, Terminal } from '../../lib/types'
import { EmptyState } from '../EmptyState/EmptyState'
import { FileExplorer } from './FileExplorer'
import { GitControl } from './GitControl'
import { AgentIcon } from '../icons/AgentIcons'
import { SidebarNowPlaying } from '../SidebarNowPlaying'
import { UserProfile } from '../UserProfile'
import { ContextMenu, type MenuItem } from './ContextMenu'
import styles from './ProjectSidebar.module.css'

const LAYOUTS: { id: LayoutMode; label: string; Icon: LucideIcon }[] = [
  { id: 'auto', label: 'Auto', Icon: LayoutGrid },
  { id: 'spotlight', label: 'Spotlight', Icon: Layout },
  { id: 'sidebar', label: 'Sidebar', Icon: SidebarIcon },
  { id: 'grid', label: 'Grid', Icon: Grid3x3 },
]

type ContextMenuState = { x: number; y: number; items: MenuItem[] } | null

export function ProjectSidebar() {
  const t = useT()
  // --- data selectors (reactive) ---
  const projects = useProjectsStore((s) => s.projects)
  const groups = useProjectsStore((s) => s.groups)
  const ungroupedOrder = useProjectsStore((s) => s.ungroupedOrder)
  const containers = useProjectsStore((s) => s.workspace.containers)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const showGitControl = useProjectsStore((s) => s.preferences.showGitControl)

  // --- action selectors (stable refs, grouped for readability) ---
  const actions = useProjectsStore(useShallow((s) => ({
    setActiveProject: s.setActiveProject,
    openGroupScope: s.openGroupScope,
    openProjectWorkspace: s.openProjectWorkspace,
    addProjectToWorkspace: s.addProjectToWorkspace,
    openGroupWorkspace: s.openGroupWorkspace,
    openTerminalWorkspace: s.openTerminalWorkspace,
    addTerminalToWorkspace: s.addTerminalToWorkspace,
    focusWorkspaceTerminal: s.focusWorkspaceTerminal,
    toggleProjectCollapsed: s.toggleProjectCollapsed,
    toggleGroupCollapsed: s.toggleGroupCollapsed,
    renameProject: s.renameProject,
    deleteProject: s.deleteProject,
    renameGroup: s.renameGroup,
    deleteGroup: s.deleteGroup,
    resumeGroup: s.resumeGroup,
    setProjectDisabled: s.setProjectDisabled,
    renameTerminal: s.renameTerminal,
    killTerminal: s.killTerminal,
    deleteTerminal: s.deleteTerminal,
    setTerminalDisabled: s.setTerminalDisabled,
    moveTerminal: s.moveTerminal,
    moveProjectToGroup: s.moveProjectToGroup,
    moveGroupToParent: s.moveGroupToParent,
    reorderProjectInGroup: s.reorderProjectInGroup,
    reorderUngrouped: s.reorderUngrouped,
    reorderGroups: s.reorderGroups,
    togglePane: s.togglePane,
    setSubTabCompletionUnread: s.setSubTabCompletionUnread,
    createMarkdownPane: s.createMarkdownPane,
  })))

  const requestPaneFocus = useUiStore((s) => s.requestPaneFocus)
  const openModal = useUiStore((s) => s.openModal_)
  const activeView = useUiStore((s) => s.activeView)
  const setActiveView = useUiStore((s) => s.setActiveView)
  const activeTerminalRef = useUiStore((s) => s.activeTerminal)
  const setActiveTerminal = useUiStore((s) => s.setActiveTerminal)
  const [menu, setMenu] = useState<ContextMenuState>(null)
  const [sidebarTab, setSidebarTab] = useState<'files' | 'git' | 'projects'>('projects')
  const keepHome = activeView === 'home'

  useEffect(() => {
    if (!showGitControl && sidebarTab === 'git') setSidebarTab('projects')
  }, [showGitControl, sidebarTab])

  const onAddMarkdownViewer = async () => {
    if (!activeProjectId) {
      useUiStore.getState().pushToast({
        title: t('ui.markdown.title'),
        body: t('ui.markdown.noActiveProject'),
      })
      return
    }
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    })
    if (typeof selected !== 'string') return
    actions.createMarkdownPane(activeProjectId, { filePath: selected })
  }

  // map projectId → Set<paneIds> pra checar se cada terminal está aberto
  const openPaneSets = useMemo(() => {
    const map: Record<string, Set<string>> = {}
    for (const c of containers) map[c.projectId] = new Set(c.paneIds)
    return map
  }, [containers])

  const projectsById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  )
  const activeProject = useMemo(
    () => projectsById.get(activeProjectId ?? '') ?? projects[0] ?? null,
    [activeProjectId, projects, projectsById],
  )
  const selectedTerminal = useMemo(() => {
    if (!activeProject) return null
    if (activeTerminalRef?.projectId === activeProject.id) {
      const selected = activeProject.terminals.find((terminal) => terminal.id === activeTerminalRef.terminalId)
      if (selected) return selected
    }
    const activeContainer = containers.find((container) => container.projectId === activeProject.id)
    const visible = new Set(activeContainer?.paneIds ?? [])
    return [...activeProject.terminals]
      .filter((terminal) => visible.size === 0 || visible.has(terminal.id))
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0] ?? null
  }, [activeProject, activeTerminalRef, containers])
  const selectedSubTab = selectedTerminal?.tabs.find((tab) => tab.id === selectedTerminal.activeTabId)
    ?? selectedTerminal?.tabs[0]

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over) return
    const dragged = String(active.id)
    const target = String(over.id)
    if (dragged === target) return

    // term:<projectId>:<terminalId>  →  proj:<projectId> = move terminal entre projetos
    if (dragged.startsWith('term:') && target.startsWith('proj:')) {
      const [, fromProject, terminalId] = dragged.split(':')
      const [, toProject] = target.split(':')
      if (fromProject !== toProject) actions.moveTerminal(fromProject, terminalId, toProject)
      return
    }

    // proj:<id>  →  proj:<id>  = REORDENA dentro do mesmo pai (grupo OU Solto).
    // Se o destino tá em outro grupo, move pra esse grupo na posição do alvo.
    if (dragged.startsWith('proj:') && target.startsWith('proj:')) {
      const fromId = dragged.slice('proj:'.length)
      const toId = target.slice('proj:'.length)
      const from = projectsById.get(fromId)
      const to = projectsById.get(toId)
      if (!from || !to) return

      if (from.groupId === to.groupId) {
        // mesmo pai → reorder
        if (from.groupId === null) {
          const ord = useProjectsStore.getState().ungroupedOrder
          const fi = ord.indexOf(fromId)
          const ti = ord.indexOf(toId)
          if (fi !== -1 && ti !== -1) actions.reorderUngrouped(fromId, fi, ti)
        } else {
          const grp = useProjectsStore.getState().groups.find((g) => g.id === from.groupId)
          if (!grp) return
          const fi = grp.projectIds.indexOf(fromId)
          const ti = grp.projectIds.indexOf(toId)
          if (fi !== -1 && ti !== -1) actions.reorderProjectInGroup(fromId, fi, ti)
        }
      } else {
        // pais diferentes → move pra o pai do alvo na posição do alvo
        const targetParent = to.groupId
        let atIdx: number | undefined
        if (targetParent === null) {
          atIdx = useProjectsStore.getState().ungroupedOrder.indexOf(toId)
        } else {
          const grp = useProjectsStore.getState().groups.find((g) => g.id === targetParent)
          atIdx = grp?.projectIds.indexOf(toId)
        }
        actions.moveProjectToGroup(fromId, targetParent, atIdx === -1 ? undefined : atIdx)
      }
      return
    }

    // proj:<projectId>  →  group:<groupId>  (groupId pode ser "ungrouped")
    if (dragged.startsWith('proj:') && target.startsWith('group:')) {
      const [, projectId] = dragged.split(':')
      const [, groupId] = target.split(':')
      actions.moveProjectToGroup(projectId, groupId === 'ungrouped' ? null : groupId)
      return
    }

    // grp:<id>  →  grp:<id>  = REORDENA grupos (mesmo nível raiz)
    if (dragged.startsWith('grp:') && target.startsWith('grp:')) {
      const fromId = dragged.slice('grp:'.length)
      const toId = target.slice('grp:'.length)
      const all = useProjectsStore.getState().groups
      const fi = all.findIndex((g) => g.id === fromId)
      const ti = all.findIndex((g) => g.id === toId)
      if (fi !== -1 && ti !== -1) actions.reorderGroups(fi, ti)
      return
    }

    // grp:<groupId>  →  group:<groupId>|"ungrouped" = nest/unnest grupo
    if (dragged.startsWith('grp:') && target.startsWith('group:')) {
      const [, srcGroupId] = dragged.split(':')
      const [, parentId] = target.split(':')
      actions.moveGroupToParent(srcGroupId, parentId === 'ungrouped' ? null : parentId)
      return
    }
  }

  const projectMenu = (project: Project): MenuItem[] => [
    {
      kind: 'item',
      label: t('ui.workspace.openIndividually'),
      onClick: () => {
        actions.openProjectWorkspace(project.id)
        setActiveView('workspace')
      },
    },
    {
      kind: 'item',
      label: t('ui.workspace.addToCurrent'),
      onClick: () => {
        actions.addProjectToWorkspace(project.id)
        setActiveView('workspace')
      },
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: t('ui.sidebar.editNameColor'),
      onClick: () => openModal('editProject', { projectId: project.id }),
    },
    {
      kind: 'item',
      label: t('ui.sidebar.quickRename'),
      onClick: () => {
        const name = window.prompt(t('ui.sidebar.newNamePrompt'), project.name)?.trim()
        if (name) actions.renameProject(project.id, name)
      },
    },
    {
      kind: 'item',
      label: t('ui.sidebar.newTerminalHere'),
      onClick: () => openModal('newTerminal', { projectId: project.id }),
    },
    {
      kind: 'item',
      label: t('ui.sidebar.designLayout'),
      onClick: () => openModal('layoutDesigner', { kind: 'project', id: project.id }),
    },
    {
      kind: 'item',
      label: project.groupId ? t('ui.sidebar.removeFromGroup') : t('ui.sidebar.moveToGroup'),
      onClick: () => {
        if (project.groupId) {
          actions.moveProjectToGroup(project.id, null)
        } else if (groups.length === 0) {
          window.alert(t('ui.sidebar.createGroupFirst'))
        } else {
          const list = groups.map((g, i) => `${i + 1}. ${g.name}`).join('\n')
          const pick = window.prompt(t('ui.sidebar.moveProjectToWhichGroup', { name: project.name, list }), '1')
          const idx = pick ? Number(pick) - 1 : -1
          if (idx >= 0 && idx < groups.length) {
            actions.moveProjectToGroup(project.id, groups[idx].id)
          }
        }
      },
    },
    {
      kind: 'item',
      label: project.terminals.length > 0 && project.terminals.every((term) => term.disabled)
        ? t('ui.sidebar.reactivateProject')
        : t('ui.sidebar.disableProject'),
      onClick: () => {
        const allDisabled = project.terminals.length > 0 && project.terminals.every((term) => term.disabled)
        actions.setProjectDisabled(project.id, !allDisabled)
      },
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: t('ui.sidebar.deleteProject'),
      danger: true,
      onClick: () => {
        if (
          window.confirm(
            t('ui.sidebar.confirmDeleteProject', { name: project.name, count: project.terminals.length }),
          )
        ) {
          actions.deleteProject(project.id)
        }
      },
    },
  ]

  const groupMenu = (group: Group): MenuItem[] => [
    {
      kind: 'item',
      label: t('ui.workspace.openIndividually'),
      onClick: () => {
        actions.openGroupWorkspace(group.id, 'only')
        setActiveView('workspace')
      },
    },
    {
      kind: 'item',
      label: t('ui.workspace.addToCurrent'),
      onClick: () => {
        actions.openGroupWorkspace(group.id, 'append')
        setActiveView('workspace')
      },
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: t('ui.sidebar.editNameColor'),
      onClick: () => openModal('editGroup', { groupId: group.id }),
    },
    {
      kind: 'item',
      label: t('ui.sidebar.quickRename'),
      onClick: () => {
        const name = window.prompt(t('ui.sidebar.newNamePrompt'), group.name)?.trim()
        if (name) actions.renameGroup(group.id, name)
      },
    },
    {
      kind: 'item',
      label: t('ui.sidebar.createSubgroupHere'),
      onClick: () => openModal('newGroup', { parentGroupId: group.id }),
    },
    {
      kind: 'item',
      label: t('ui.sidebar.designLayout'),
      onClick: () => openModal('layoutDesigner', { kind: 'group', id: group.id }),
    },
    {
      kind: 'item',
      label: group.parentGroupId ? t('ui.sidebar.makeRootGroup') : t('ui.sidebar.moveToOtherGroup'),
      onClick: () => {
        if (group.parentGroupId) {
          actions.moveGroupToParent(group.id, null)
        } else {
          // pick parent — exclude self and descendants
          const allGroups = useProjectsStore.getState().groups
          const descendants = collectDescendants(group.id, allGroups)
          const candidates = allGroups.filter(
            (g) => g.id !== group.id && !descendants.has(g.id),
          )
          if (candidates.length === 0) {
            window.alert(t('ui.sidebar.noEligibleParentGroups'))
            return
          }
          const list = candidates.map((g, i) => `${i + 1}. ${g.name}`).join('\n')
          const pick = window.prompt(t('ui.sidebar.moveGroupAsSubgroupOf', { name: group.name, list }), '1')
          const idx = pick ? Number(pick) - 1 : -1
          if (idx >= 0 && idx < candidates.length) {
            actions.moveGroupToParent(group.id, candidates[idx].id)
          }
        }
      },
    },
    {
      kind: 'item',
      label: group.collapsed ? t('ui.sidebar.expand') : t('ui.sidebar.collapse'),
      onClick: () => actions.toggleGroupCollapsed(group.id),
    },
    {
      kind: 'item',
      label: group.suspended ? t('ui.sidebar.reactivateGroup') : t('ui.sidebar.suspendGroup'),
      onClick: () => {
        if (group.suspended) {
          actions.resumeGroup(group.id)
        } else {
          openModal('suspendGroup', { groupId: group.id })
        }
      },
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: t('ui.sidebar.deleteGroupKeepProjects'),
      onClick: () => actions.deleteGroup(group.id, 'unassign'),
    },
    {
      kind: 'item',
      label: t('ui.sidebar.deleteGroupAndProjects'),
      danger: true,
      onClick: () => {
        if (
          window.confirm(
            t('ui.sidebar.confirmDeleteGroupCascade', { name: group.name, count: group.projectIds.length }),
          )
        ) {
          actions.deleteGroup(group.id, 'cascade')
        }
      },
    },
  ]

  const terminalMenu = (projectId: string, term: Terminal): MenuItem[] => {
    const inSplit = openPaneSets[projectId]?.has(term.id) ?? false
    return [
      {
        kind: 'item',
        label: t('ui.workspace.openIndividually'),
        onClick: () => {
          actions.openTerminalWorkspace(projectId, term.id)
          setActiveView('workspace')
        },
      },
      {
        kind: 'item',
        label: t('ui.workspace.addToCurrent'),
        onClick: () => {
          actions.addTerminalToWorkspace(projectId, term.id)
          setActiveView('workspace')
        },
      },
      { kind: 'separator' },
      {
        kind: 'item',
        label: t('ui.sidebar.rename'),
        onClick: () => {
          const name = window.prompt(t('ui.sidebar.newNamePrompt'), term.name)?.trim()
          if (name) actions.renameTerminal(projectId, term.id, name)
        },
      },
      {
        kind: 'item',
        label: inSplit ? t('ui.sidebar.hideFromSplit') : t('ui.sidebar.showInSplit'),
        onClick: () => actions.togglePane(projectId, term.id),
      },
      {
        kind: 'item',
        label: term.disabled ? t('ui.sidebar.reactivate') : t('ui.sidebar.disable'),
        onClick: () => actions.setTerminalDisabled(projectId, term.id, !term.disabled),
      },
      {
        kind: 'item',
        label: t('ui.sidebar.killTerminal'),
        onClick: () => actions.killTerminal(projectId, term.id),
      },
      { kind: 'separator' },
      {
        kind: 'item',
        label: t('ui.sidebar.deleteTerminal'),
        danger: true,
        onClick: () => {
          if (window.confirm(t('ui.sidebar.confirmDeleteTerminal', { name: term.name }))) {
            actions.deleteTerminal(projectId, term.id)
          }
        },
      },
    ]
  }

  const activateProject = (project: Project, mode: 'open' | 'focus' = 'focus') => {
    void mode
    actions.openProjectWorkspace(project.id)
    setActiveView('workspace')
  }

  const renderProject = (p: Project) => (
    <ProjectNode
      key={p.id}
      project={p}
      isActive={p.id === activeProjectId}
      openPanes={openPaneSets[p.id]}
      onActivate={() => {
        activateProject(p)
      }}
      onToggleCollapsed={() => actions.toggleProjectCollapsed(p.id)}
      onTerminalClick={(t) => {
        actions.focusWorkspaceTerminal(p.id, t.id)
        setActiveTerminal(p.id, t.id)
        const activeTab = t.tabs.find((tab) => tab.id === t.activeTabId) ?? t.tabs[0]
        if (activeTab?.completionUnread) {
          actions.setSubTabCompletionUnread(p.id, t.id, activeTab.id, false)
        }
        requestPaneFocus(t.id)
        setActiveView('workspace')
      }}
      onTerminalDoubleClick={(t) => {
        actions.openTerminalWorkspace(p.id, t.id)
        setActiveTerminal(p.id, t.id)
        requestPaneFocus(t.id)
        setActiveView('workspace')
      }}
      onProjectMenu={(e) =>
        setMenu({ x: e.clientX, y: e.clientY, items: projectMenu(p) })
      }
      onTerminalMenu={(t, e) =>
        setMenu({ x: e.clientX, y: e.clientY, items: terminalMenu(p.id, t) })
      }
      onAddTerminal={() => openModal('newTerminal', { projectId: p.id })}
    />
  )

  const ungroupedProjects = ungroupedOrder
    .map((id) => projectsById.get(id))
    .filter((p): p is Project => Boolean(p))

  const groupsByParent = useMemo(() => {
    const map = new Map<string | null, Group[]>()
    for (const g of groups) {
      const key = g.parentGroupId
      const arr = map.get(key) ?? []
      arr.push(g)
      map.set(key, arr)
    }
    return map
  }, [groups])

  const onGroupOpenAll = (g: Group, mode: 'append' | 'only' = 'append') => {
    actions.openGroupWorkspace(g.id, mode)
    setActiveView('workspace')
  }

  const renderGroup = (g: Group): React.ReactNode => {
    const projectsInGroup = g.projectIds
      .map((id) => projectsById.get(id))
      .filter((p): p is Project => Boolean(p))
    const childGroups = groupsByParent.get(g.id) ?? []
    return (
      <GroupNode
        key={g.id}
        group={g}
        projects={projectsInGroup}
        childGroups={childGroups}
        renderProject={renderProject}
        renderChildGroup={renderGroup}
        onMenu={(e) => setMenu({ x: e.clientX, y: e.clientY, items: groupMenu(g) })}
        onAddProject={() => openModal('newProject', { groupId: g.id })}
        onToggle={() => actions.toggleGroupCollapsed(g.id)}
        onOpenAll={() => onGroupOpenAll(g)}
        onOpenOnly={() => onGroupOpenAll(g, 'only')}
      />
    )
  }

  return (
    <aside className={styles.sidebar}>
      <div className={styles.homeRow}>
        <button
          type="button"
          className={`${styles.homeBtn} ${activeView === 'home' ? styles.homeBtnActive : ''}`}
          onClick={() => {
            if (activeView !== 'home') {
              setActiveView('home')
            }
          }}
          title={t('ui.sidebar.homeTitle', { shortcut: 'Ctrl+Shift+H' })}
          aria-label={t('ui.sidebar.home')}
        >
          <Home size={14} />
          <span>{t('ui.sidebar.home')}</span>
        </button>
      </div>

      <div className={styles.sidebarTabs} role="tablist" aria-label={t('ui.sidebar.navigation')}>
        <button
          type="button"
          role="tab"
          aria-selected={sidebarTab === 'projects'}
          aria-label={t('ui.sidebar.projects')}
          title={t('ui.sidebar.projects')}
          className={`${styles.sidebarTab} ${sidebarTab === 'projects' ? styles.sidebarTabActive : ''}`}
          onClick={() => {
            setSidebarTab('projects')
            if (!keepHome) setActiveView('workspace')
          }}
        >
          <Grid3x3 size={14} />
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={sidebarTab === 'files'}
          aria-label={t('ui.sidebar.files')}
          title={t('ui.sidebar.files')}
          className={`${styles.sidebarTab} ${sidebarTab === 'files' ? styles.sidebarTabActive : ''}`}
          onClick={() => {
            setSidebarTab('files')
            if (!keepHome) setActiveView('workspace')
          }}
        >
          <Folder size={14} />
        </button>
        {showGitControl ? (
          <button
            type="button"
            role="tab"
            aria-selected={sidebarTab === 'git'}
            aria-label={t('ui.sidebar.git')}
            title={t('ui.sidebar.git')}
            className={`${styles.sidebarTab} ${sidebarTab === 'git' ? styles.sidebarTabActive : ''}`}
            onClick={() => {
              setSidebarTab('git')
              if (!keepHome) setActiveView('workspace')
            }}
          >
            <GitBranch size={14} />
          </button>
        ) : null}
      </div>

      {sidebarTab === 'projects' ? <header className={styles.header}>
        <span className={styles.title}>{t('ui.sidebar.projects')}</span>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => void onAddMarkdownViewer()}
            disabled={!activeProjectId}
            title={t('ui.markdown.addViewerTitle')}
            aria-label={t('ui.markdown.addViewer')}
          >
            <FileText size={14} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => openModal('newGroup')}
            title={t('ui.sidebar.newGroupTitle', { shortcut: 'Ctrl+Shift+G' })}
            aria-label={t('ui.sidebar.newGroup')}
          >
            <FolderPlus size={14} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => openModal('newProject')}
            title={t('ui.sidebar.newProjectTitle', { shortcut: 'Ctrl+Shift+P' })}
            aria-label={t('ui.sidebar.newProject')}
          >
            <Plus size={14} />
          </button>
        </div>
      </header> : null}

      {sidebarTab === 'files' ? <section className={styles.explorerPanel}>
        <div className={styles.explorerHeader}>
          <span className={styles.explorerLabel}>{t('ui.sidebar.explorer')}</span>
          <MoreHorizontal size={14} />
        </div>
        {selectedTerminal && selectedSubTab ? (
          <FileExplorer
            cwd={selectedSubTab.cwd || selectedTerminal.cwd}
            ptyId={selectedSubTab.ptyId}
            terminalName={selectedTerminal.name}
          />
        ) : (
          <div className={styles.explorerEmpty}>
            <EmptyState
              compact
              icon={<FolderPlus size={18} />}
              title={t('ui.sidebar.emptyTitle')}
              description={t('ui.sidebar.emptyDesc')}
              primaryAction={{
                label: t('ui.sidebar.emptyAction'),
                onClick: () => openModal('newProject'),
              }}
            />
          </div>
        )}
      </section> : null}

      {sidebarTab === 'git' ? <section className={styles.explorerPanel}>
        <div className={styles.explorerHeader}>
          <span className={styles.explorerLabel}>{t('ui.sidebar.sourceControl')}</span>
        </div>
        {selectedTerminal && selectedSubTab ? (
          <GitControl
            cwd={selectedSubTab.cwd || selectedTerminal.cwd}
            ptyId={selectedSubTab.ptyId}
            terminalName={selectedTerminal.name}
          />
        ) : (
          <div className={styles.explorerEmpty}>
            <EmptyState
              compact
              icon={<GitBranch size={18} />}
              title={t('git.empty.noTerminal')}
              description={t('git.empty.noTerminalDesc')}
              primaryAction={{ label: t('ui.sidebar.emptyAction'), onClick: () => openModal('newProject') }}
            />
          </div>
        )}
      </section> : null}

      {sidebarTab === 'projects' ? (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <div className={styles.list}>
            {projects.length === 0 && groups.length === 0 ? (
              <div className={styles.emptyWrap}>
                <EmptyState
                  compact
                  icon={<FolderPlus size={18} />}
                  title={t('ui.sidebar.emptyTitle')}
                  description={t('ui.sidebar.emptyDesc')}
                  primaryAction={{
                    label: t('ui.sidebar.emptyAction'),
                    onClick: () => openModal('newProject'),
                  }}
                />
              </div>
            ) : (
              <>
                {(groupsByParent.get(null) ?? []).map(renderGroup)}

                {ungroupedProjects.length > 0 ? (
                  <UngroupedSection projects={ungroupedProjects} renderProject={renderProject} />
                ) : null}
              </>
            )}
          </div>
        </DndContext>
      ) : null}

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      ) : null}

      <WorkspaceLayoutFooter />
      <LayoutFooter />
      <SidebarNowPlaying />
      <UserProfile />
    </aside>
  )
}

function WorkspaceLayoutFooter({ forceVisible = false }: { forceVisible?: boolean }) {
  const t = useT()
  const containerCount = useProjectsStore((s) => s.workspace.containers.length)
  const hasCustom = useProjectsStore((s) => Boolean(s.preferences.workspaceGridLayout))
  const openModal = useUiStore((s) => s.openModal_)
  if (!forceVisible && containerCount < 2) return null
  return (
    <div className={styles.layoutFooter}>
      <span className={styles.layoutLabel}>Workspace</span>
      <button
        type="button"
        className={`${styles.layoutBtn} ${hasCustom ? styles.layoutBtnActive : ''}`}
        onClick={() => openModal('layoutDesigner', { kind: 'workspace' })}
        title={t('ui.sidebar.designWorkspaceLayout')}
        aria-label={t('ui.sidebar.designLayoutShort')}
        style={{ width: 'auto', padding: '0 10px', fontSize: 11, gap: 6 }}
      >
        <Grid3x3 size={12} />
        <span>{hasCustom ? t('ui.sidebar.editGrid') : t('ui.sidebar.drawGrid')}</span>
      </button>
    </div>
  )
}

function LayoutFooter() {
  const t = useT()
  const project = useProjectsStore(selectActiveProject)
  const container = useProjectsStore(selectActiveContainer)
  const setLayoutMode = useProjectsStore((s) => s.setLayoutMode)
  if (!project || !container || container.paneIds.length < 2) return null
  return (
    <div className={styles.layoutFooter}>
      <span className={styles.layoutLabel}>{t('ui.sidebar.organization')}</span>
      <div className={styles.layoutSwitch}>
        {LAYOUTS.map((opt) => {
          const Icon = opt.Icon
          const active = container.internalLayout === opt.id
          return (
            <button
              key={opt.id}
              type="button"
              className={`${styles.layoutBtn} ${active ? styles.layoutBtnActive : ''}`}
              onClick={() => setLayoutMode(project.id, opt.id)}
              title={opt.label}
              aria-label={opt.label}
            >
              <Icon size={14} />
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ------------ Shared ------------ */

function GroupBadge({ iconUrl, color }: { iconUrl?: string; color: string }) {
  return iconUrl ? (
    <img src={iconUrl} alt="" className={styles.groupIcon} />
  ) : (
    <span className={styles.groupBullet} style={{ background: color }} />
  )
}

function ProjectBadge({ iconUrl, color }: { iconUrl?: string; color?: string }) {
  return iconUrl ? (
    <img src={iconUrl} alt="" className={styles.projectIcon} />
  ) : (
    <span
      className={styles.projectChip}
      style={color ? { background: color } : undefined}
    />
  )
}

/* ------------ Group ------------ */

type GroupNodeProps = {
  group: Group
  projects: Project[]
  childGroups: Group[]
  renderProject: (p: Project) => React.ReactNode
  renderChildGroup: (g: Group) => React.ReactNode
  onMenu: (e: React.MouseEvent) => void
  onAddProject: () => void
  onToggle: () => void
  onOpenAll: () => void
  onOpenOnly: () => void
}

function GroupNode({
  group,
  projects,
  childGroups,
  renderProject,
  renderChildGroup,
  onMenu,
  onAddProject,
  onToggle,
  onOpenAll,
  onOpenOnly,
}: GroupNodeProps) {
  const t = useT()
  const dropZone = useDroppable({ id: `group:${group.id}` })
  const draggable = useDraggable({ id: `grp:${group.id}` })
  const setRefs = (node: HTMLDivElement | null) => {
    dropZone.setNodeRef(node)
    draggable.setNodeRef(node)
  }
  const isOver = dropZone.isOver

  // Click no nome do grupo (ou bullet) → onOpenAll. Não dispara em chevron/+.
  const onTagClick = (e: React.MouseEvent) => {
    const tgt = e.target as HTMLElement
    if (tgt.closest('button')) return // chevron/+ tratam o próprio click
    onOpenAll()
  }

  if (group.collapsed) {
    return (
      <div
        ref={setRefs}
        {...draggable.attributes}
        {...draggable.listeners}
        className={`${styles.groupCollapsed} ${isOver ? styles.groupDropTarget : ''}`}
        onClick={() => {
          onToggle()
          onOpenAll()
        }}
        onDoubleClick={(e) => {
          e.stopPropagation()
          onOpenOnly()
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          onMenu(e)
        }}
        title={t('ui.sidebar.openAllGroupProjects')}
      >
        <ChevronRight size={12} className={styles.groupChevron} />
        <GroupBadge iconUrl={group.iconUrl} color={group.color} />
        <span className={styles.groupName}>{group.name}</span>
        {group.suspended && <Pause size={10} className={styles.groupSuspendedIcon} />}
        <span className={styles.groupCount}>
          {group.projectIds.length === 1
            ? t('ui.sidebar.projectCountOne', { count: group.projectIds.length })
            : t('ui.sidebar.projectCountOther', { count: group.projectIds.length })}
        </span>
      </div>
    )
  }

  return (
    <div
      ref={setRefs}
      className={`${styles.groupBox} ${isOver ? styles.groupDropTarget : ''} ${group.suspended ? styles.groupSuspended : ''}`}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e)
      }}
      style={{ ['--group-color' as string]: group.color }}
    >
      <div
        className={styles.groupTag}
        onClick={onTagClick}
        onDoubleClick={(e) => {
          e.stopPropagation()
          onOpenOnly()
        }}
        title={group.suspended ? t('ui.sidebar.groupSuspendedHint') : t('ui.sidebar.openAllGroupProjects')}
        {...draggable.attributes}
        {...draggable.listeners}
      >
        <button
          type="button"
          className={styles.groupChevronBtn}
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          aria-label={t('ui.sidebar.collapse')}
        >
          <ChevronDown size={11} />
        </button>
        <GroupBadge iconUrl={group.iconUrl} color={group.color} />
        <span className={styles.groupTagName}>{group.name}</span>
        {group.suspended && <Pause size={10} className={styles.groupSuspendedIcon} />}
        <button
          type="button"
          className={styles.iconBtn}
          onClick={(e) => {
            e.stopPropagation()
            onAddProject()
          }}
          title={t('ui.sidebar.newProjectInGroup')}
          aria-label={t('ui.sidebar.newProjectInGroup')}
        >
          <Plus size={11} />
        </button>
      </div>
      <div className={styles.groupBody}>
        {childGroups.map((cg) => renderChildGroup(cg))}
        {projects.length === 0 && childGroups.length === 0 ? (
          <div className={styles.groupEmpty}>{t('ui.sidebar.groupEmpty')}</div>
        ) : (
          projects.map((p) => renderProject(p))
        )}
      </div>
    </div>
  )
}

/** Coleta IDs de todos os grupos descendantes de `rootId` (recursivo). */
function collectDescendants(rootId: string, allGroups: Group[]): Set<string> {
  const result = new Set<string>()
  const queue = [rootId]
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const g of allGroups) {
      if (g.parentGroupId === cur && !result.has(g.id)) {
        result.add(g.id)
        queue.push(g.id)
      }
    }
  }
  return result
}

function UngroupedSection({
  projects,
  renderProject,
}: {
  projects: Project[]
  renderProject: (p: Project) => React.ReactNode
}) {
  const t = useT()
  const { setNodeRef, isOver } = useDroppable({ id: 'group:ungrouped' })
  return (
    <div
      ref={setNodeRef}
      className={`${styles.ungroupedSection} ${isOver ? styles.groupDropTarget : ''}`}
    >
      <div className={styles.ungroupedHeader}>{t('ui.sidebar.ungrouped')}</div>
      <div className={styles.ungroupedBody}>{projects.map((p) => renderProject(p))}</div>
    </div>
  )
}

/* ------------ Project ------------ */

type ProjectNodeProps = {
  project: Project
  isActive: boolean
  openPanes: Set<string> | undefined
  onActivate: () => void
  onToggleCollapsed: () => void
  onTerminalClick: (t: Terminal) => void
  onTerminalDoubleClick: (t: Terminal) => void
  onProjectMenu: (e: React.MouseEvent) => void
  onTerminalMenu: (t: Terminal, e: React.MouseEvent) => void
  onAddTerminal: () => void
}

function ProjectNode({
  project,
  isActive,
  openPanes,
  onActivate,
  onToggleCollapsed,
  onTerminalClick,
  onTerminalDoubleClick,
  onProjectMenu,
  onTerminalMenu,
  onAddTerminal,
}: ProjectNodeProps) {
  const t = useT()
  const { setNodeRef: dropRef, isOver } = useDroppable({ id: `proj:${project.id}` })
  const draggable = useDraggable({ id: `proj:${project.id}` })
  const setRefs = (node: HTMLDivElement | null) => {
    dropRef(node)
    draggable.setNodeRef(node)
  }

  const allDisabled = project.terminals.length > 0 && project.terminals.every((term) => term.disabled)

  return (
    <div className={`${styles.projectNode} ${allDisabled ? styles.projectDisabled : ''}`} ref={setRefs}>
      <div
        className={`${styles.projectRow} ${isActive ? styles.projectActive : ''} ${
          isOver ? styles.projectDropTarget : ''
        }`}
        onClick={onActivate}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onProjectMenu(e)
        }}
        {...draggable.attributes}
        {...draggable.listeners}
      >
        <button
          type="button"
          className={styles.chevron}
          onClick={(e) => {
            e.stopPropagation()
            onToggleCollapsed()
          }}
          aria-label={project.collapsed ? t('ui.sidebar.expand') : t('ui.sidebar.collapse')}
        >
          {project.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
        <ProjectBadge iconUrl={project.iconUrl} color={project.color} />
        <span className={styles.projectName} title={project.name}>
          {project.name}
        </span>
        {allDisabled && <Pause size={10} className={styles.projectPauseIcon} />}
        <span className={styles.count}>{project.terminals.length}</span>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={(e) => {
            e.stopPropagation()
            onAddTerminal()
          }}
          title={t('ui.sidebar.newTerminal')}
          aria-label={t('ui.sidebar.newTerminal')}
        >
          <Plus size={12} />
        </button>
      </div>

      {!project.collapsed && project.terminals.length > 0 ? (
        <div className={styles.terminals}>
          {project.terminals.map((term) => (
            <TerminalNode
              key={term.id}
              project={project}
              terminal={term}
              selected={openPanes?.has(term.id) ?? false}
              onClick={() => onTerminalClick(term)}
              onDoubleClick={() => onTerminalDoubleClick(term)}
              onMenu={(e) => onTerminalMenu(term, e)}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/* ------------ Terminal ------------ */

type TerminalNodeProps = {
  project: Project
  terminal: Terminal
  selected: boolean
  onClick: () => void
  onDoubleClick: () => void
  onMenu: (e: React.MouseEvent) => void
}

function TerminalNode({ project, terminal, selected, onClick, onDoubleClick, onMenu }: TerminalNodeProps) {
  const t = useT()
  const terminalTheme = useProjectsStore(
    (s) => s.preferences.terminalTheme ?? s.preferences.uiTheme,
  )
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `term:${project.id}:${terminal.id}`,
  })

  const activeTab = terminal.tabs.find((tab) => tab.id === terminal.activeTabId) ?? terminal.tabs[0]
  const uniqueTypes = Array.from(new Set(terminal.tabs.map((tab) => tab.type))) as AgentType[]
  const orderedTypes =
    activeTab && uniqueTypes.length > 1
      ? [activeTab.type, ...uniqueTypes.filter((type) => type !== activeTab.type)]
      : uniqueTypes
  const hasUnreadCompletion = terminal.tabs.some((tab) => tab.completionUnread)

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`${styles.terminalRow} ${!selected ? styles.terminalHidden : ''} ${
        terminal.disabled ? styles.terminalDisabled : ''
      } ${isDragging ? styles.dragging : ''}`}
      onClick={() => onClick()}
      onDoubleClick={(event) => {
        event.stopPropagation()
        onDoubleClick()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onMenu(e)
      }}
      title={terminal.filePath || terminal.cwd || terminal.name}
    >
      <span className={styles.agentStack}>
        {terminal.kind === 'markdown' ? (
          <span className={styles.agentIcon}>
            <FileText size={14} />
          </span>
        ) : (
          orderedTypes.map((type, i) => (
            <span
              key={type}
              className={styles.agentIcon}
              style={{ marginLeft: i === 0 ? 0 : 2, zIndex: orderedTypes.length - i }}
            >
              <AgentIcon type={type} size={14} theme={terminalTheme} />
            </span>
          ))
        )}
      </span>
      <span className={styles.terminalName}>{terminal.name}</span>
      {hasUnreadCompletion ? (
        <span className={styles.doneBadge} title={t('ui.terminal.responseReady')}>
          !
        </span>
      ) : null}
      {terminal.tabs.length > 1 ? (
        <span className={styles.tabCount}>{terminal.tabs.length}</span>
      ) : null}
    </div>
  )
}

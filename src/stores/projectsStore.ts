import { create } from 'zustand'
import { nanoid } from 'nanoid'

import {
  DEFAULT_PREFERENCES,
  EMPTY_PROJECTS_FILE,
  GROUP_COLORS,
  type AgentType,
  type GridLayout,
  type Group,
  type LayoutMode,
  type Locale,
  type Preferences,
  type Project,
  type ProjectsFile,
  type SubTab,
  type Terminal,
  type Theme,
  type WorkspaceContainer,
  type WorkspaceRecentTab,
} from '../lib/types'
import {
  listProfiles,
  loadProjectsFile,
  saveProjectsFile,
  type ProfileMeta,
  type ProfilesState,
} from '../lib/tauri'
import { setStorageNamespace } from '../lib/storageNamespace'

const SAVE_DEBOUNCE_MS = 500
const MIN_UI_ZOOM = 0.8
const MAX_UI_ZOOM = 1.4
const UI_ZOOM_STEP = 0.1
export const MAX_RECENT_PROJECT_TABS = 10

type ProjectsState = ProjectsFile & {
  activeProfileId: string
  profiles: ProfileMeta[]
  hydrated: boolean
  hydrate: () => Promise<void>

  // groups
  createGroup: (name: string, color?: string, parentGroupId?: string | null) => Group
  moveGroupToParent: (groupId: string, parentGroupId: string | null) => void
  renameGroup: (id: string, name: string) => void
  setGroupColor: (id: string, color: string) => void
  setGroupIconUrl: (id: string, iconUrl: string | undefined) => void
  toggleGroupCollapsed: (id: string) => void
  /** Suspende grupo: desabilita todos os terminais e fecha containers pra liberar RAM. */
  suspendGroup: (groupId: string) => void
  /** Reativa grupo suspenso: reabilita terminais (PTYs são respawnados pelo XTermView). */
  resumeGroup: (groupId: string) => void
  /** mode 'unassign' = projetos viram Solto; mode 'cascade' = apaga grupo + projetos. */
  deleteGroup: (id: string, mode: 'unassign' | 'cascade') => void
  reorderGroups: (fromIndex: number, toIndex: number) => void
  moveProjectToGroup: (projectId: string, groupId: string | null, atIndex?: number) => void
  reorderProjectInGroup: (projectId: string, fromIndex: number, toIndex: number) => void
  reorderUngrouped: (projectId: string, fromIndex: number, toIndex: number) => void

  // projects
  createProject: (args: {
    name: string
    color?: string
    iconUrl?: string
    groupId?: string | null
  }) => Project
  renameProject: (id: string, name: string) => void
  setProjectColor: (id: string, color: string | undefined) => void
  setProjectIconUrl: (id: string, iconUrl: string | undefined) => void
  deleteProject: (id: string) => void
  setActiveProject: (id: string | null) => void
  setActiveProjectOnly: (id: string | null) => void
  rememberWorkspaceGroupTab: (groupId: string) => void
  closeWorkspaceTab: (tab: WorkspaceRecentTab) => void
  openGroupScope: (groupId: string, mode?: 'append' | 'only') => void
  toggleProjectCollapsed: (id: string) => void
  setLayoutMode: (projectId: string, layout: LayoutMode) => void
  setProjectGridLayout: (projectId: string, layout: GridLayout) => void
  setGroupLayoutMode: (groupId: string, mode: LayoutMode) => void
  setGroupGridLayout: (groupId: string, layout: GridLayout) => void
  setWorkspaceGridLayout: (layout: GridLayout | null) => void

  // terminals
  createTerminal: (
    projectId: string,
    args: {
      name: string
      cwd: string
      firstTab: { type: AgentType; cwd: string; extraArgs?: string[] }
    },
  ) => Terminal
  renameTerminal: (projectId: string, terminalId: string, name: string) => void
  deleteTerminal: (projectId: string, terminalId: string) => void
  moveTerminal: (
    fromProjectId: string,
    terminalId: string,
    toProjectId: string,
  ) => void
  setTerminalDisabled: (projectId: string, terminalId: string, disabled: boolean) => void
  /** Desabilita/reabilita todos os terminais de um projeto e fecha/reabre o container. */
  setProjectDisabled: (projectId: string, disabled: boolean) => void
  setLaneVisible: (projectId: string, terminalId: string, visible: boolean | null) => void
  /** Marca um terminal como recentemente usado (atualiza lastUsedAt). */
  markTerminalUsed: (projectId: string, terminalId: string) => void

  // workspace containers (substituem activeTerminalIds)
  /** Abre o container do projeto (cria se não existir) e adiciona pane se não estiver lá. */
  openPane: (projectId: string, terminalId: string) => void
  /** Remove pane do container; se vazio, fecha o container inteiro. */
  closePane: (projectId: string, terminalId: string) => void
  /** Toggle: adiciona se não tem, remove se tem. */
  togglePane: (projectId: string, terminalId: string) => void
  /** Garante que o container do projeto exista com TODOS os panes do projeto. */
  openContainerWithAllPanes: (projectId: string) => void
  /** Remove container inteiro da workspace. */
  closeContainer: (projectId: string) => void
  /** Fecha todos os containers que NÃO são o projectId fornecido. */
  closeOtherContainers: (keepProjectId: string) => void
  reorderContainers: (fromIndex: number, toIndex: number) => void
  reorderPaneInContainer: (
    projectId: string,
    fromIndex: number,
    toIndex: number,
  ) => void
  setContainerCollapsed: (projectId: string, collapsed: boolean) => void
  setContainerInternalLayout: (projectId: string, layout: LayoutMode) => void
  setFullscreenContainer: (projectId: string | null) => void
  setWorkspaceFlat: (flat: boolean) => void

  // sub-tabs
  createSubTab: (
    projectId: string,
    terminalId: string,
    args: { type: AgentType; cwd: string; name?: string; extraArgs?: string[] },
  ) => SubTab
  closeSubTab: (projectId: string, terminalId: string, tabId: string) => void
  setActiveTab: (projectId: string, terminalId: string, tabId: string) => void
  setSubTabPtyId: (
    projectId: string,
    terminalId: string,
    tabId: string,
    ptyId: string | null,
  ) => void
  setSubTabCwd: (projectId: string, terminalId: string, tabId: string, cwd: string) => void
  setSubTabCompletionUnread: (
    projectId: string,
    terminalId: string,
    tabId: string,
    unread: boolean,
  ) => void
  setSubTabSessionId: (
    projectId: string,
    terminalId: string,
    tabId: string,
    sessionId: string | undefined,
  ) => void

  // preferences / cli
  setLanguage: (language: Locale) => void
  setUiTheme: (theme: Theme) => void
  setUiZoom: (zoom: number) => void
  setTerminalTheme: (theme: Theme | null) => void
  setAgentEnabled: (agent: AgentType, enabled: boolean) => void
  setOnboardingDone: (done: boolean) => void
  setPreferences: (patch: Partial<Preferences>) => void
  setCliPath: (agent: AgentType, path: string | null) => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingSave = false

function scheduleSave(getState: () => ProjectsState) {
  if (!getState().hydrated) return
  pendingSave = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (!pendingSave) return
    pendingSave = false
    const state = getState()
    const payload: ProjectsFile = {
      version: 2,
      groups: state.groups,
      ungroupedOrder: state.ungroupedOrder,
      projects: state.projects,
      activeProjectId: state.activeProjectId,
      workspace: state.workspace,
      preferences: state.preferences,
      cliPaths: state.cliPaths,
    }
    void saveProjectsFile(JSON.stringify(payload, null, 2))
  }, SAVE_DEBOUNCE_MS)
}

function rememberProjectTab(recentProjectIds: string[] | undefined, projectId: string): string[] {
  const current = (recentProjectIds ?? []).slice(0, MAX_RECENT_PROJECT_TABS)
  if (current.includes(projectId)) return current
  if (current.length < MAX_RECENT_PROJECT_TABS) return [...current, projectId]
  return [...current.slice(0, MAX_RECENT_PROJECT_TABS - 1), projectId]
}

function rememberWorkspaceTab(
  recentTabs: WorkspaceRecentTab[] | undefined,
  tab: WorkspaceRecentTab,
): WorkspaceRecentTab[] {
  const current = (recentTabs ?? []).slice(0, MAX_RECENT_PROJECT_TABS)
  if (current.some((item) => item.kind === tab.kind && item.id === tab.id)) return current
  if (current.length < MAX_RECENT_PROJECT_TABS) return [...current, tab]
  return [...current.slice(0, MAX_RECENT_PROJECT_TABS - 1), tab]
}

function makeDefaultTerminal(args: {
  name: string
  cwd: string
  firstTab: { type: AgentType; cwd: string; extraArgs?: string[] }
}): Terminal {
  const tabId = nanoid()
  return {
    id: nanoid(),
    name: args.name,
    cwd: args.cwd,
    activeTabId: tabId,
    disabled: false,
    laneVisible: null,
    lastUsedAt: Date.now(),
    tabs: [
      {
        id: tabId,
        type: args.firstTab.type,
        name: args.firstTab.type,
        cwd: args.firstTab.cwd,
        ptyId: null,
        extraArgs: args.firstTab.extraArgs,
      },
    ],
  }
}

function resolveTerminalCwd(terminal: Terminal | null | undefined): string {
  if (!terminal) return ''
  const activeTab = terminal.tabs.find((t) => t.id === terminal.activeTabId) ?? terminal.tabs[0]
  return activeTab?.cwd?.trim() || terminal.cwd?.trim() || ''
}

export function getProjectDefaultCwd(
  project: Project | null | undefined,
  projects: Project[] = [],
): string {
  if (!project) return ''
  const candidates = [project]
  if (project.groupId) {
    candidates.push(
      ...projects.filter((p) => p.id !== project.id && p.groupId === project.groupId),
    )
  }

  for (const candidate of candidates) {
    const terminals = [...candidate.terminals].sort(
      (a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0),
    )
    for (const terminal of terminals) {
      const cwd = resolveTerminalCwd(terminal)
      if (cwd) return cwd
    }
  }
  return ''
}

export function clampUiZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  const stepped = Math.round(zoom / UI_ZOOM_STEP) * UI_ZOOM_STEP
  const clamped = Math.min(MAX_UI_ZOOM, Math.max(MIN_UI_ZOOM, stepped))
  return Number(clamped.toFixed(2))
}

export const UI_ZOOM_LIMITS = {
  min: MIN_UI_ZOOM,
  max: MAX_UI_ZOOM,
  step: UI_ZOOM_STEP,
} as const

function normalizePreferences(raw: Partial<Preferences> | undefined): Preferences {
  const preferences = { ...DEFAULT_PREFERENCES, ...(raw ?? {}) }
  const legacyAccountCreated =
    raw?.accountCreated ??
    Boolean(raw?.onboardingDone && raw?.displayName && raw.displayName.trim().length > 0)
  return {
    ...preferences,
    language: preferences.language === 'pt-BR' ? 'pt-BR' : 'en',
    accountCreated: legacyAccountCreated,
    displayName: preferences.displayName.trim(),
    profileImageUrl: preferences.profileImageUrl.trim(),
    spotifyClientId: preferences.spotifyClientId.trim(),
    spotifyClientSecret: preferences.spotifyClientSecret.trim(),
    uiZoom: clampUiZoom(preferences.uiZoom),
  }
}

/** Migra v1 → v2. Trata também v1 sem version (raws antigos). */
function migrate(parsed: any): ProjectsFile {
  if (parsed.version === 2) {
    // backfill parentGroupId (v2.1) — grupos antigos viram raiz.
    const groups = (parsed.groups ?? []).map((g: any) => ({
      ...g,
      parentGroupId: g.parentGroupId ?? null,
    }))
    return {
      ...EMPTY_PROJECTS_FILE,
      ...parsed,
      preferences: normalizePreferences(parsed.preferences),
      workspace: {
        containers: parsed.workspace?.containers ?? [],
        recentProjectIds: (parsed.workspace?.recentProjectIds ?? []).slice(
          0,
          MAX_RECENT_PROJECT_TABS,
        ),
        recentTabs: (
          parsed.workspace?.recentTabs ??
          (parsed.workspace?.recentProjectIds ?? []).map((id: string) => ({
            kind: 'project',
            id,
          }))
        ).slice(0, MAX_RECENT_PROJECT_TABS),
      },
      groups,
      ungroupedOrder: parsed.ungroupedOrder ?? [],
    }
  }

  // v1 → v2
  const oldProjects: any[] = parsed.projects ?? []
  const projects: Project[] = oldProjects.map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    groupId: null, // tudo vira Solto na migração
    terminals: p.terminals ?? [],
    layoutMode: p.layoutMode ?? 'auto',
    collapsed: p.collapsed ?? false,
    createdAt: p.createdAt ?? Date.now(),
  }))

  const containers: WorkspaceContainer[] = oldProjects
    .filter((p) => Array.isArray(p.activeTerminalIds) && p.activeTerminalIds.length > 0)
    .map((p) => ({
      projectId: p.id,
      paneIds: p.activeTerminalIds,
      size: 0,
      internalLayout: p.layoutMode ?? 'auto',
      collapsed: false,
    }))

  return {
    version: 2,
    groups: [],
    ungroupedOrder: projects.map((p) => p.id),
    projects,
    activeProjectId: parsed.activeProjectId ?? projects[0]?.id ?? null,
    workspace: {
      containers,
      recentProjectIds: containers.map((c) => c.projectId).slice(0, MAX_RECENT_PROJECT_TABS),
      recentTabs: containers
        .map((c) => ({ kind: 'project' as const, id: c.projectId }))
        .slice(0, MAX_RECENT_PROJECT_TABS),
    },
    preferences: normalizePreferences(parsed.preferences),
    cliPaths: parsed.cliPaths ?? {},
  }
}

/** Coleta todos os projectIds de um grupo e seus subgrupos recursivamente. */
function collectGroupProjectIds(groupId: string, groups: Group[]): Set<string> {
  const result = new Set<string>()
  const queue = [groupId]
  while (queue.length > 0) {
    const cur = queue.shift()!
    const g = groups.find((gr) => gr.id === cur)
    if (!g) continue
    for (const pid of g.projectIds) result.add(pid)
    for (const sg of groups) {
      if (sg.parentGroupId === cur) queue.push(sg.id)
    }
  }
  return result
}

export const useProjectsStore = create<ProjectsState>((set, get) => {
  const update = (mutator: (state: ProjectsState) => Partial<ProjectsState> | void) => {
    let changed = false
    set((state) => {
      const result = mutator(state)
      if (!result || Object.keys(result).length === 0) return state
      changed = true
      return result
    })
    if (changed) scheduleSave(get)
  }

  const updateProject = (projectId: string, fn: (p: Project) => Project) =>
    update((state) => ({
      projects: state.projects.map((p) => (p.id === projectId ? fn(p) : p)),
    }))

  const updateTerminal = (
    projectId: string,
    terminalId: string,
    fn: (t: Terminal) => Terminal,
  ) =>
    updateProject(projectId, (p) => ({
      ...p,
      terminals: p.terminals.map((t) => (t.id === terminalId ? fn(t) : t)),
    }))

  const updateSubTab = (
    projectId: string,
    terminalId: string,
    tabId: string,
    fn: (s: SubTab) => SubTab,
  ) =>
    updateTerminal(projectId, terminalId, (t) => ({
      ...t,
      tabs: t.tabs.map((s) => (s.id === tabId ? fn(s) : s)),
    }))

  const updateContainer = (
    projectId: string,
    fn: (c: WorkspaceContainer) => WorkspaceContainer,
  ) =>
    update((state) => ({
      workspace: {
        ...state.workspace,
        containers: state.workspace.containers.map((c) =>
          c.projectId === projectId ? fn(c) : c,
        ),
      },
    }))

  /** Cria um container default pra um projeto. */
  const newContainer = (projectId: string, paneIds: string[], layout: LayoutMode): WorkspaceContainer => ({
    projectId,
    paneIds,
    lastUsedAt: Date.now(),
    size: 0,
    internalLayout: layout,
    collapsed: false,
  })

  return {
    ...EMPTY_PROJECTS_FILE,
    activeProfileId: 'default',
    profiles: [],
    hydrated: false,

    hydrate: async () => {
      let profileState: ProfilesState = {
        active_profile_id: 'default',
        profiles: [],
      }
      try {
        profileState = await listProfiles()
        setStorageNamespace(profileState.active_profile_id)
      } catch (err) {
        console.error('Falha ao carregar profiles.json — usando default', err)
        setStorageNamespace('default')
      }

      try {
        const raw = await loadProjectsFile()
        if (!raw) {
          set({
            hydrated: true,
            activeProfileId: profileState.active_profile_id,
            profiles: profileState.profiles,
          })
          return
        }
        const parsed = JSON.parse(raw)
        const migrated = migrate(parsed)
        set({
          ...migrated,
          hydrated: true,
          activeProfileId: profileState.active_profile_id,
          profiles: profileState.profiles,
        })
      } catch (err) {
        console.error('Falha ao carregar projects.json — usando estado vazio', err)
        set({
          hydrated: true,
          activeProfileId: profileState.active_profile_id,
          profiles: profileState.profiles,
        })
      }
    },

    /* ------------ groups ------------ */

    createGroup: (name, color, parentGroupId = null) => {
      const group: Group = {
        id: nanoid(),
        name,
        color: color ?? GROUP_COLORS[0],
        collapsed: false,
        projectIds: [],
        parentGroupId,
        createdAt: Date.now(),
      }
      update((state) => ({ groups: [...state.groups, group] }))
      return group
    },

    moveGroupToParent: (groupId, parentGroupId) =>
      update((state) => {
        if (groupId === parentGroupId) return
        // Bloqueia ciclos: não pode virar filho de um descendente.
        if (parentGroupId !== null) {
          let cur: string | null = parentGroupId
          while (cur !== null) {
            if (cur === groupId) return // ciclo detectado
            const next: Group | undefined = state.groups.find((g) => g.id === cur)
            cur = next?.parentGroupId ?? null
          }
        }
        return {
          groups: state.groups.map((g) =>
            g.id === groupId ? { ...g, parentGroupId } : g,
          ),
        }
      }),

    renameGroup: (id, name) =>
      update((state) => ({
        groups: state.groups.map((g) => (g.id === id ? { ...g, name } : g)),
      })),

    setGroupColor: (id, color) =>
      update((state) => ({
        groups: state.groups.map((g) => (g.id === id ? { ...g, color } : g)),
      })),

    setGroupIconUrl: (id, iconUrl) =>
      update((state) => ({
        groups: state.groups.map((g) => (g.id === id ? { ...g, iconUrl } : g)),
      })),

    toggleGroupCollapsed: (id) =>
      update((state) => ({
        groups: state.groups.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)),
      })),

    suspendGroup: (groupId) =>
      update((state) => {
        const group = state.groups.find((g) => g.id === groupId)
        if (!group || group.suspended) return

        const allProjectIds = collectGroupProjectIds(groupId, state.groups)

        // Desabilita todos os terminais dos projetos do grupo
        const projects = state.projects.map((p) => {
          if (!allProjectIds.has(p.id)) return p
          return {
            ...p,
            terminals: p.terminals.map((t) => ({ ...t, disabled: true })),
          }
        })

        // Fecha os containers desses projetos
        const containers = state.workspace.containers.filter(
          (c) => !allProjectIds.has(c.projectId),
        )

        // Marca o grupo (e subgrupos) como suspenso
        const groups = state.groups.map((g) => {
          if (g.id === groupId) return { ...g, suspended: true }
          return g
        })

        return { groups, projects, workspace: { ...state.workspace, containers } }
      }),

    resumeGroup: (groupId) =>
      update((state) => {
        const group = state.groups.find((g) => g.id === groupId)
        if (!group || !group.suspended) return

        const allProjectIds = collectGroupProjectIds(groupId, state.groups)

        // Reabilita todos os terminais
        const projects = state.projects.map((p) => {
          if (!allProjectIds.has(p.id)) return p
          return {
            ...p,
            terminals: p.terminals.map((t) => ({ ...t, disabled: false })),
          }
        })

        const groups = state.groups.map((g) => {
          if (g.id === groupId) return { ...g, suspended: false }
          return g
        })

        return { groups, projects }
      }),

    deleteGroup: (id, mode) =>
      update((state) => {
        const group = state.groups.find((g) => g.id === id)
        if (!group) return
        if (mode === 'cascade') {
          // Coleta TODOS os descendantes (BFS) — subgrupos + seus projetos.
          const groupQueue = [id]
          const groupsToRemove = new Set<string>()
          while (groupQueue.length > 0) {
            const cur = groupQueue.shift()!
            if (groupsToRemove.has(cur)) continue
            groupsToRemove.add(cur)
            for (const g of state.groups) {
              if (g.parentGroupId === cur) groupQueue.push(g.id)
            }
          }
          const projectsToRemove = new Set<string>()
          for (const p of state.projects) {
            if (p.groupId && groupsToRemove.has(p.groupId)) projectsToRemove.add(p.id)
          }
          const remainingProjects = state.projects.filter((p) => !projectsToRemove.has(p.id))
          return {
            groups: state.groups.filter((g) => !groupsToRemove.has(g.id)),
            projects: remainingProjects,
            workspace: {
              ...state.workspace,
              containers: state.workspace.containers.filter(
                (c) => !projectsToRemove.has(c.projectId),
              ),
              recentProjectIds: (state.workspace.recentProjectIds ?? []).filter(
                (pid) => !projectsToRemove.has(pid),
              ),
              recentTabs: (state.workspace.recentTabs ?? []).filter((tab) =>
                tab.kind === 'group'
                  ? !groupsToRemove.has(tab.id)
                  : !projectsToRemove.has(tab.id),
              ),
            },
            activeProjectId: projectsToRemove.has(state.activeProjectId ?? '')
              ? (remainingProjects[0]?.id ?? null)
              : state.activeProjectId,
          }
        }
        // unassign:
        // - Projetos do grupo viram Solto
        // - Subgrupos diretos viram root (parentGroupId: null)
        return {
          groups: state.groups
            .filter((g) => g.id !== id)
            .map((g) => (g.parentGroupId === id ? { ...g, parentGroupId: null } : g)),
          projects: state.projects.map((p) =>
            p.groupId === id ? { ...p, groupId: null } : p,
          ),
          ungroupedOrder: [
            ...state.ungroupedOrder,
            ...group.projectIds.filter((pid) => !state.ungroupedOrder.includes(pid)),
          ],
          workspace: {
            ...state.workspace,
            recentTabs: (state.workspace.recentTabs ?? []).filter(
              (tab) => !(tab.kind === 'group' && tab.id === id),
            ),
          },
        }
      }),

    reorderGroups: (fromIndex, toIndex) =>
      update((state) => {
        const next = [...state.groups]
        const [moved] = next.splice(fromIndex, 1)
        next.splice(toIndex, 0, moved)
        return { groups: next }
      }),

    moveProjectToGroup: (projectId, groupId, atIndex) =>
      update((state) => {
        const project = state.projects.find((p) => p.id === projectId)
        if (!project || project.groupId === groupId) return
        const oldGroupId = project.groupId
        // remove do grupo antigo (ou do ungrouped)
        let groups = state.groups.map((g) => {
          if (g.id === oldGroupId) {
            return { ...g, projectIds: g.projectIds.filter((id) => id !== projectId) }
          }
          return g
        })
        let ungroupedOrder = state.ungroupedOrder
        if (oldGroupId === null) {
          ungroupedOrder = ungroupedOrder.filter((id) => id !== projectId)
        }
        // adiciona no destino
        if (groupId === null) {
          const next = [...ungroupedOrder]
          if (atIndex === undefined || atIndex < 0 || atIndex > next.length) {
            next.push(projectId)
          } else {
            next.splice(atIndex, 0, projectId)
          }
          ungroupedOrder = next
        } else {
          groups = groups.map((g) => {
            if (g.id !== groupId) return g
            const next = [...g.projectIds]
            if (atIndex === undefined || atIndex < 0 || atIndex > next.length) {
              next.push(projectId)
            } else {
              next.splice(atIndex, 0, projectId)
            }
            return { ...g, projectIds: next }
          })
        }
        return {
          groups,
          ungroupedOrder,
          projects: state.projects.map((p) => (p.id === projectId ? { ...p, groupId } : p)),
        }
      }),

    reorderProjectInGroup: (projectId, fromIndex, toIndex) =>
      update((state) => {
        const project = state.projects.find((p) => p.id === projectId)
        if (!project || project.groupId === null) return
        return {
          groups: state.groups.map((g) => {
            if (g.id !== project.groupId) return g
            const next = [...g.projectIds]
            const [moved] = next.splice(fromIndex, 1)
            next.splice(toIndex, 0, moved)
            return { ...g, projectIds: next }
          }),
        }
      }),

    reorderUngrouped: (_projectId, fromIndex, toIndex) =>
      update((state) => {
        const next = [...state.ungroupedOrder]
        const [moved] = next.splice(fromIndex, 1)
        next.splice(toIndex, 0, moved)
        return { ungroupedOrder: next }
      }),

    /* ------------ projects ------------ */

    createProject: ({ name, color, iconUrl, groupId = null }) => {
      const project: Project = {
        id: nanoid(),
        name,
        color,
        iconUrl,
        groupId,
        terminals: [],
        layoutMode: 'auto',
        collapsed: false,
        createdAt: Date.now(),
      }
      update((state) => {
        const groups =
          groupId === null
            ? state.groups
            : state.groups.map((g) =>
                g.id === groupId ? { ...g, projectIds: [...g.projectIds, project.id] } : g,
              )
        const ungroupedOrder =
          groupId === null ? [...state.ungroupedOrder, project.id] : state.ungroupedOrder
        return {
          projects: [...state.projects, project],
          groups,
          ungroupedOrder,
          activeProjectId: state.activeProjectId ?? project.id,
        }
      })
      return project
    },

    renameProject: (id, name) => updateProject(id, (p) => ({ ...p, name })),

    setProjectColor: (id, color) => updateProject(id, (p) => ({ ...p, color })),

    setProjectIconUrl: (id, iconUrl) => updateProject(id, (p) => ({ ...p, iconUrl })),

    deleteProject: (id) =>
      update((state) => {
        const project = state.projects.find((p) => p.id === id)
        if (!project) return
        const projects = state.projects.filter((p) => p.id !== id)
        const groups = state.groups.map((g) =>
          g.id === project.groupId
            ? { ...g, projectIds: g.projectIds.filter((pid) => pid !== id) }
            : g,
        )
        const ungroupedOrder = state.ungroupedOrder.filter((pid) => pid !== id)
        const containers = state.workspace.containers.filter((c) => c.projectId !== id)
        const recentProjectIds = (state.workspace.recentProjectIds ?? []).filter(
          (pid) => pid !== id,
        )
        const recentTabs = (state.workspace.recentTabs ?? []).filter(
          (tab) => !(tab.kind === 'project' && tab.id === id),
        )
        const activeProjectId =
          state.activeProjectId === id ? (projects[0]?.id ?? null) : state.activeProjectId
        return {
          projects,
          groups,
          ungroupedOrder,
          workspace: { ...state.workspace, containers, recentProjectIds, recentTabs },
          activeProjectId,
        }
      }),

    setActiveProject: (id) =>
      update((state) => {
        if (!id) return { activeProjectId: null }
        const target = state.projects.find((p) => p.id === id)
        if (!target) return { activeProjectId: id }
        const now = Date.now()
        // Se o container já existe, preserva panes/ordem/layout e só marca como usado.
        const existing = state.workspace.containers.find((c) => c.projectId === id)
        if (target.terminals.length === 0) {
          return {
            activeProjectId: id,
            workspace: {
              ...state.workspace,
              recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, id),
              recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
                kind: 'project',
                id,
              }),
            },
          }
        }
        const containers = existing
          ? state.workspace.containers.map((c) =>
              c.projectId === id ? { ...c, lastUsedAt: now, collapsed: false } : c,
            )
          : [
              ...state.workspace.containers,
              newContainer(id, target.terminals.map((t) => t.id), target.layoutMode),
            ]
        return {
          activeProjectId: id,
          workspace: {
            ...state.workspace,
            containers,
            recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, id),
            recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
              kind: 'project',
              id,
            }),
          },
        }
      }),

    setActiveProjectOnly: (id) =>
      update((state) => {
        if (state.activeProjectId === id) return
        return {
          activeProjectId: id,
          workspace: id
            ? {
                ...state.workspace,
                recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, id),
                recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
                  kind: 'project',
                  id,
                }),
              }
            : state.workspace,
        }
      }),

    rememberWorkspaceGroupTab: (groupId) =>
      update((state) => ({
        workspace: {
          ...state.workspace,
          recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
            kind: 'group',
            id: groupId,
          }),
        },
      })),

    closeWorkspaceTab: (tab) =>
      update((state) => ({
        workspace: {
          ...state.workspace,
          recentProjectIds:
            tab.kind === 'project'
              ? (state.workspace.recentProjectIds ?? []).filter((id) => id !== tab.id)
              : state.workspace.recentProjectIds,
          recentTabs: (state.workspace.recentTabs ?? []).filter(
            (item) => !(item.kind === tab.kind && item.id === tab.id),
          ),
        },
      })),

    openGroupScope: (groupId, mode = 'append') =>
      update((state) => {
        const projectIds = collectGroupProjectIds(groupId, state.groups)
        const projectsInScope = state.projects.filter((p) => projectIds.has(p.id))
        const openableProjects = projectsInScope.filter((p) => p.terminals.length > 0)
        if (openableProjects.length === 0) {
          return {
            activeProjectId: projectsInScope[0]?.id ?? state.activeProjectId,
            workspace: {
              ...state.workspace,
              recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
                kind: 'group',
                id: groupId,
              }),
            },
          }
        }

        const containers = [...state.workspace.containers]
        for (const project of openableProjects) {
          const existingIndex = containers.findIndex((c) => c.projectId === project.id)
          if (existingIndex === -1) {
            containers.push(
              newContainer(project.id, project.terminals.map((t) => t.id), project.layoutMode),
            )
          }
        }
        const nextContainers =
          mode === 'only' ? containers.filter((c) => projectIds.has(c.projectId)) : containers

        return {
          activeProjectId: openableProjects[0].id,
          workspace: {
            ...state.workspace,
            containers: nextContainers,
            recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
              kind: 'group',
              id: groupId,
            }),
          },
        }
      }),

    toggleProjectCollapsed: (id) =>
      updateProject(id, (p) => ({ ...p, collapsed: !p.collapsed })),

    setLayoutMode: (projectId, layout) => {
      updateProject(projectId, (p) => ({ ...p, layoutMode: layout }))
      updateContainer(projectId, (c) => ({ ...c, internalLayout: layout }))
    },

    setProjectGridLayout: (projectId, layout) =>
      update((state) => ({
        projects: state.projects.map((p) =>
          p.id === projectId ? { ...p, gridLayout: layout, layoutMode: 'grid' } : p,
        ),
        // sincroniza o container aberto na workspace pra que o novo grid
        // entre em vigor imediatamente (sem precisar reabrir o projeto)
        workspace: {
          ...state.workspace,
          containers: state.workspace.containers.map((c) =>
            c.projectId === projectId ? { ...c, internalLayout: 'grid' } : c,
          ),
        },
      })),

    setGroupLayoutMode: (groupId, mode) =>
      update((state) => ({
        groups: state.groups.map((g) =>
          g.id === groupId ? { ...g, layoutMode: mode } : g,
        ),
      })),

    setGroupGridLayout: (groupId, layout) =>
      update((state) => ({
        groups: state.groups.map((g) =>
          g.id === groupId ? { ...g, gridLayout: layout, layoutMode: 'grid' } : g,
        ),
      })),

    setWorkspaceGridLayout: (layout) =>
      update((state) => ({
        preferences: {
          ...state.preferences,
          workspaceFlat: false,
          workspaceGridLayout: layout ?? undefined,
        },
      })),

    /* ------------ terminals ------------ */

    createTerminal: (projectId, args) => {
      let terminal = makeDefaultTerminal(args)
      update((state) => {
        const sourceProject = state.projects.find((p) => p.id === projectId)
        const inheritedCwd = getProjectDefaultCwd(sourceProject)
        const finalCwd = args.cwd.trim() || inheritedCwd
        terminal = makeDefaultTerminal({
          ...args,
          cwd: finalCwd,
          firstTab: {
            ...args.firstTab,
            cwd: args.firstTab.cwd.trim() || finalCwd,
          },
        })
        const projects = state.projects.map((p) =>
          p.id === projectId ? { ...p, terminals: [...p.terminals, terminal] } : p,
        )
        const project = projects.find((p) => p.id === projectId)
        const layout = project?.layoutMode ?? 'auto'
        const existing = state.workspace.containers.find((c) => c.projectId === projectId)
        const containers = existing
          ? state.workspace.containers.map((c) =>
              c.projectId === projectId
                ? { ...c, paneIds: [...c.paneIds, terminal.id], lastUsedAt: Date.now() }
                : c,
            )
          : [...state.workspace.containers, newContainer(projectId, [terminal.id], layout)]
        return {
          projects,
          workspace: {
            ...state.workspace,
            containers,
            recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, projectId),
            recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
              kind: 'project',
              id: projectId,
            }),
          },
        }
      })
      return terminal
    },

    renameTerminal: (projectId, terminalId, name) =>
      updateTerminal(projectId, terminalId, (t) => ({ ...t, name })),

    deleteTerminal: (projectId, terminalId) =>
      update((state) => {
        const projects = state.projects.map((p) => {
          if (p.id !== projectId) return p
          return { ...p, terminals: p.terminals.filter((t) => t.id !== terminalId) }
        })
        // remove pane do container; se container ficou vazio, remove container
        const containers = state.workspace.containers
          .map((c) => {
            if (c.projectId !== projectId) return c
            return { ...c, paneIds: c.paneIds.filter((id) => id !== terminalId) }
          })
          .filter((c) => c.paneIds.length > 0)
        return { projects, workspace: { ...state.workspace, containers } }
      }),

    moveTerminal: (fromProjectId, terminalId, toProjectId) => {
      if (fromProjectId === toProjectId) return
      update((state) => {
        const from = state.projects.find((p) => p.id === fromProjectId)
        if (!from) return
        const terminal = from.terminals.find((t) => t.id === terminalId)
        if (!terminal) return
        const projects = state.projects.map((p) => {
          if (p.id === fromProjectId) {
            return { ...p, terminals: p.terminals.filter((t) => t.id !== terminalId) }
          }
          if (p.id === toProjectId) {
            return { ...p, terminals: [...p.terminals, terminal] }
          }
          return p
        })
        const containers = state.workspace.containers
          .map((c) =>
            c.projectId === fromProjectId
              ? { ...c, paneIds: c.paneIds.filter((id) => id !== terminalId) }
              : c,
          )
          .filter((c) => c.paneIds.length > 0)
        return { projects, workspace: { ...state.workspace, containers } }
      })
    },

    setTerminalDisabled: (projectId, terminalId, disabled) =>
      updateTerminal(projectId, terminalId, (t) => ({ ...t, disabled })),

    setProjectDisabled: (projectId, disabled) =>
      update((state) => {
        const projects = state.projects.map((p) => {
          if (p.id !== projectId) return p
          return {
            ...p,
            terminals: p.terminals.map((t) => ({ ...t, disabled })),
          }
        })
        if (disabled) {
          // Fecha o container pra liberar RAM
          const containers = state.workspace.containers.filter(
            (c) => c.projectId !== projectId,
          )
          return { projects, workspace: { ...state.workspace, containers } }
        }
        return { projects }
      }),

    setLaneVisible: (projectId, terminalId, visible) =>
      updateTerminal(projectId, terminalId, (t) => ({ ...t, laneVisible: visible })),

    markTerminalUsed: (projectId, terminalId) =>
      updateTerminal(projectId, terminalId, (t) => ({ ...t, lastUsedAt: Date.now() })),

    /* ------------ workspace containers ------------ */

    openPane: (projectId, terminalId) =>
      update((state) => {
        const project = state.projects.find((p) => p.id === projectId)
        if (!project) return
        const now = Date.now()
        const projects = state.projects.map((p) =>
          p.id !== projectId
            ? p
            : {
                ...p,
                terminals: p.terminals.map((t) =>
                  t.id === terminalId ? { ...t, lastUsedAt: now } : t,
                ),
              },
        )
        const existing = state.workspace.containers.find((c) => c.projectId === projectId)
        if (existing) {
          if (existing.paneIds.includes(terminalId)) {
            return {
              projects,
              workspace: {
                ...state.workspace,
                containers: state.workspace.containers.map((c) =>
                  c.projectId === projectId ? { ...c, lastUsedAt: now } : c,
                ),
                recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, projectId),
                recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
                  kind: 'project',
                  id: projectId,
                }),
              },
            }
          }
          return {
            projects,
            workspace: {
              ...state.workspace,
              containers: state.workspace.containers.map((c) =>
                c.projectId === projectId
                  ? { ...c, paneIds: [...c.paneIds, terminalId], lastUsedAt: now }
                  : c,
              ),
              recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, projectId),
              recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
                kind: 'project',
                id: projectId,
              }),
            },
          }
        }
        return {
          projects,
          workspace: {
            ...state.workspace,
            containers: [
              ...state.workspace.containers,
              newContainer(projectId, [terminalId], project.layoutMode),
            ],
            recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, projectId),
            recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
              kind: 'project',
              id: projectId,
            }),
          },
        }
      }),

    closePane: (projectId, terminalId) =>
      update((state) => {
        const containers = state.workspace.containers
          .map((c) =>
            c.projectId === projectId
              ? { ...c, paneIds: c.paneIds.filter((id) => id !== terminalId) }
              : c,
          )
          .filter((c) => c.paneIds.length > 0)
        return { workspace: { ...state.workspace, containers } }
      }),

    togglePane: (projectId, terminalId) => {
      const state = get()
      const c = state.workspace.containers.find((x) => x.projectId === projectId)
      if (c?.paneIds.includes(terminalId)) {
        get().closePane(projectId, terminalId)
      } else {
        get().openPane(projectId, terminalId)
      }
    },

    openContainerWithAllPanes: (projectId) =>
      update((state) => {
        const project = state.projects.find((p) => p.id === projectId)
        if (!project || project.terminals.length === 0) return
        const allPanes = project.terminals.map((t) => t.id)
        const existing = state.workspace.containers.find((c) => c.projectId === projectId)
        // Sai do fullscreen se outro container estava bloqueando a vista
        const fsId = state.preferences.fullscreenContainerId
        const preferences =
          fsId && fsId !== projectId
            ? { ...state.preferences, fullscreenContainerId: null }
            : state.preferences
        if (existing) {
          return {
            preferences,
            workspace: {
              ...state.workspace,
              containers: state.workspace.containers.map((c) =>
                c.projectId === projectId
                  ? { ...c, paneIds: allPanes, collapsed: false, lastUsedAt: Date.now() }
                  : c,
              ),
              recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, projectId),
              recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
                kind: 'project',
                id: projectId,
              }),
            },
          }
        }
        return {
          preferences,
          workspace: {
            ...state.workspace,
            containers: [
              ...state.workspace.containers,
              newContainer(projectId, allPanes, project.layoutMode),
            ],
            recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, projectId),
            recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
              kind: 'project',
              id: projectId,
            }),
          },
        }
      }),

    closeContainer: (projectId) =>
      update((state) => ({
        workspace: {
          ...state.workspace,
          containers: state.workspace.containers.filter((c) => c.projectId !== projectId),
        },
      })),

    closeOtherContainers: (keepProjectId) =>
      update((state) => ({
        workspace: {
          ...state.workspace,
          containers: state.workspace.containers.filter((c) => c.projectId === keepProjectId),
        },
      })),

    reorderContainers: (fromIndex, toIndex) =>
      update((state) => {
        const next = [...state.workspace.containers]
        const [moved] = next.splice(fromIndex, 1)
        next.splice(toIndex, 0, moved)
        return { workspace: { ...state.workspace, containers: next } }
      }),

    reorderPaneInContainer: (projectId, fromIndex, toIndex) =>
      updateContainer(projectId, (c) => {
        const next = [...c.paneIds]
        const [moved] = next.splice(fromIndex, 1)
        next.splice(toIndex, 0, moved)
        return { ...c, paneIds: next }
      }),

    setContainerCollapsed: (projectId, collapsed) =>
      updateContainer(projectId, (c) => ({ ...c, collapsed })),

    setContainerInternalLayout: (projectId, layout) =>
      updateContainer(projectId, (c) => ({ ...c, internalLayout: layout })),

    setFullscreenContainer: (projectId) =>
      update((state) => ({
        preferences: { ...state.preferences, fullscreenContainerId: projectId },
      })),

    setWorkspaceFlat: (flat) =>
      update((state) => ({
        preferences: { ...state.preferences, workspaceFlat: flat },
      })),

    /* ------------ sub-tabs ------------ */

    createSubTab: (projectId, terminalId, args) => {
      let tab: SubTab = {
        id: nanoid(),
        type: args.type,
        name: args.name ?? args.type,
        cwd: args.cwd,
        ptyId: null,
        extraArgs: args.extraArgs,
      }
      updateTerminal(projectId, terminalId, (t) => ({
        ...t,
        tabs: [
          ...t.tabs,
          (tab = {
            ...tab,
            cwd: args.cwd.trim() || resolveTerminalCwd(t),
          }),
        ],
        activeTabId: tab.id,
      }))
      return tab
    },

    closeSubTab: (projectId, terminalId, tabId) =>
      updateTerminal(projectId, terminalId, (t) => {
        const remaining = t.tabs.filter((s) => s.id !== tabId)
        if (remaining.length === 0) return t
        const activeTabId = t.activeTabId === tabId ? remaining[0].id : t.activeTabId
        return { ...t, tabs: remaining, activeTabId }
      }),

    setActiveTab: (projectId, terminalId, tabId) =>
      updateTerminal(projectId, terminalId, (t) => ({
        ...t,
        activeTabId: tabId,
        tabs: t.tabs.map((tab) =>
          tab.id === tabId ? { ...tab, completionUnread: false } : tab,
        ),
      })),

    setSubTabPtyId: (projectId, terminalId, tabId, ptyId) =>
      updateSubTab(projectId, terminalId, tabId, (s) => ({ ...s, ptyId })),

    setSubTabCwd: (projectId, terminalId, tabId, cwd) =>
      updateSubTab(projectId, terminalId, tabId, (s) => ({ ...s, cwd })),

    setSubTabCompletionUnread: (projectId, terminalId, tabId, unread) =>
      updateSubTab(projectId, terminalId, tabId, (s) => ({
        ...s,
        completionUnread: unread,
      })),

    setSubTabSessionId: (projectId, terminalId, tabId, sessionId) =>
      updateSubTab(projectId, terminalId, tabId, (s) => ({ ...s, sessionId })),

    /* ------------ preferences / cli ------------ */

    setLanguage: (language) =>
      update((state) => ({ preferences: { ...state.preferences, language } })),

    setUiTheme: (theme) =>
      update((state) => ({ preferences: { ...state.preferences, uiTheme: theme } })),

    setUiZoom: (zoom) =>
      update((state) => {
        const uiZoom = clampUiZoom(zoom)
        if (state.preferences.uiZoom === uiZoom) return
        return { preferences: { ...state.preferences, uiZoom } }
      }),

    setTerminalTheme: (theme) =>
      update((state) => ({ preferences: { ...state.preferences, terminalTheme: theme } })),

    setAgentEnabled: (agent, enabled) =>
      update((state) => ({
        preferences: {
          ...state.preferences,
          enabledAgents: { ...state.preferences.enabledAgents, [agent]: enabled },
        },
      })),

    setOnboardingDone: (done) =>
      update((state) => ({ preferences: { ...state.preferences, onboardingDone: done } })),

    setPreferences: (patch) =>
      update((state) => ({ preferences: { ...state.preferences, ...patch } })),

    setCliPath: (agent, path) =>
      update((state) => {
        const cliPaths = { ...state.cliPaths }
        if (path === null) delete cliPaths[agent]
        else cliPaths[agent] = path
        return { cliPaths }
      }),
  }
})

/* ------------ selectors ------------ */

/** Map de project.id → Project. Ideal pra usar com useMemo ou como selector. */
export function selectProjectsById(state: ProjectsState): Map<string, Project> {
  return new Map(state.projects.map((p) => [p.id, p]))
}

/** Map de group.id → Group. */
export function selectGroupsById(state: ProjectsState): Map<string, Group> {
  return new Map(state.groups.map((g) => [g.id, g]))
}

export function selectActiveProject(state: ProjectsState): Project | null {
  if (!state.activeProjectId) return null
  return state.projects.find((p) => p.id === state.activeProjectId) ?? null
}

/** Container do projeto ativo, se existir. */
export function selectActiveContainer(state: ProjectsState): WorkspaceContainer | null {
  if (!state.activeProjectId) return null
  return state.workspace.containers.find((c) => c.projectId === state.activeProjectId) ?? null
}

export type RecentTerminalEntry = {
  projectId: string
  projectName: string
  projectColor: string | undefined
  terminal: Terminal
  lastUsedAt: number
}

/**
 * Retorna os N terminais mais recentemente usados (cross-projeto), ordenados
 * por lastUsedAt descendente. Terminais sem lastUsedAt caem pro final.
 */
export function selectRecentTerminals(n: number) {
  return (state: ProjectsState): RecentTerminalEntry[] => {
    const entries: RecentTerminalEntry[] = []
    for (const p of state.projects) {
      for (const t of p.terminals) {
        entries.push({
          projectId: p.id,
          projectName: p.name,
          projectColor: p.color,
          terminal: t,
          lastUsedAt: t.lastUsedAt ?? 0,
        })
      }
    }
    entries.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    return entries.slice(0, n)
  }
}

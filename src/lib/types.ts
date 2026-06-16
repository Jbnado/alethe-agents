export type AgentType = 'shell' | 'claude' | 'codex' | 'opencode'

/** Idiomas suportados pela UI. `en` é o default. */
export type Locale = 'en' | 'pt-BR'

export type LayoutMode = 'auto' | 'spotlight' | 'sidebar' | 'grid'

/** Posição/tamanho de uma Célula no grid. Coordenadas 1-based (CSS Grid style). */
export type GridCell = {
  col: number
  row: number
  colSpan: number
  rowSpan: number
}

/** Layout 'grid' — cols/rows fixas, cada filho colocado por id em uma Cell. */
export type GridLayout = {
  cols: number
  rows: number
  /** childId → posição. childId é Terminal.id (em projeto) ou Project.id (em grupo). */
  cells: Record<string, GridCell>
  /** Largura proporcional de cada coluna em `fr`. Default = todos `1` (iguais). */
  colSizes?: number[]
  /** Altura proporcional de cada linha em `fr`. Default = todos `1` (iguais). */
  rowSizes?: number[]
}

export type Theme =
  | 'dark'
  | 'light'
  | 'dracula'
  | 'nord'
  | 'gruvbox'
  | 'solarized'
  | 'tokyo-night'
  | 'vscode'
  | 'min-dark'
  | 'min-light'
  | 'dark-lemon'

export type SubTab = {
  id: string
  type: AgentType
  name: string
  cwd: string
  /** ID do PTY no backend. null quando o terminal está disabled ou ainda não foi spawnado. */
  ptyId: string | null
  /** Resposta concluída e notificada, ainda não vista pelo usuário. */
  completionUnread?: boolean
  /** ID de sessão pra Claude/Codex/OpenCode (--continue / resume). */
  sessionId?: string
  /** Args extras passados pro launcher (ex: --dangerously-skip-permissions). */
  extraArgs?: string[]
}

/** Flag de "modo irrestrito" por agente (skip permissions / approvals). */
export const UNRESTRICTED_FLAG: Record<AgentType, string | null> = {
  shell: null,
  claude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  opencode: '--dangerously-skip-permissions',
}

export type Terminal = {
  id: string
  name: string
  cwd: string
  tabs: SubTab[]
  activeTabId: string
  disabled: boolean
  laneVisible: boolean | null
  /** Última vez que esse terminal foi aberto/focado. Usado pra ordenar a Home. */
  lastUsedAt?: number
}

export type Project = {
  id: string
  name: string
  color?: string
  /** URL de imagem pequena pra representar o projeto na sidebar/topbar/container. */
  iconUrl?: string
  /** ID do grupo. null = solto (sem grupo). v2. */
  groupId: string | null
  terminals: Terminal[]
  layoutMode: LayoutMode
  /** Definição do grid quando layoutMode === 'grid'. Persistida pra restaurar. */
  gridLayout?: GridLayout
  collapsed: boolean
  createdAt: number
}

export type Group = {
  id: string
  name: string
  color: string
  /** URL de imagem pequena pra usar como ícone do grupo no lugar do bullet colorido. */
  iconUrl?: string
  collapsed: boolean
  /** Ordem manual dos projetos dentro do grupo. */
  projectIds: string[]
  /** v2.1 — null = grupo raiz; senão o ID do grupo pai (subgrupo). */
  parentGroupId: string | null
  /** v2.2 — modo de layout pros projetos quando o grupo é o "ativo" da workspace. */
  layoutMode?: LayoutMode
  /** Definição do grid quando layoutMode === 'grid'. */
  gridLayout?: GridLayout
  /** v2.3 — grupo suspenso: todos os terminais ficam disabled e containers fechados pra liberar RAM. */
  suspended?: boolean
  createdAt: number
}

/** Estado de um projeto aberto na workspace. 1:1 com Project enquanto existe. */
export type WorkspaceContainer = {
  projectId: string
  /** Panes (terminais) visíveis nesse container. Ordem = posição dos panes. */
  paneIds: string[]
  /** Última vez que esse container/projeto foi aberto/focado. Usado nas tabs da topbar. */
  lastUsedAt?: number
  /** Proporção (0..1) entre containers no eixo externo. Defaults serão recalculados se 0. */
  size: number
  internalLayout: LayoutMode
  collapsed: boolean
}

export type WorkspaceRecentTab = {
  kind: 'project' | 'group'
  id: string
}

export type Preferences = {
  /** Idioma da UI. Default 'en'. */
  language: Locale
  uiTheme: Theme
  /** Zoom global da WebView. 1 = 100%. */
  uiZoom: number
  terminalTheme: Theme | null
  enabledAgents: Record<AgentType, boolean>
  onboardingDone: boolean
  /** v2 — modo flat ignora os containers e mostra panes soltos como antes. */
  workspaceFlat: boolean
  /** v2 — projeto-container que está em fullscreen na workspace. */
  fullscreenContainerId: string | null
  /** Timestamp da primeira abertura do app (pra contagem de dias no welcome). */
  firstLaunchAt: number | null
  /** Nome exibido no welcome modal. */
  displayName: string
  /** URL da foto de perfil escolhida no cadastro local. */
  profileImageUrl: string
  /** True quando o cadastro local de perfil foi concluido. */
  accountCreated: boolean
  /** Se true, abre na Home mesmo se havia projeto ativo na última sessão. */
  alwaysStartOnHome: boolean
  /** Credenciais locais do Spotify Developer Dashboard para Now Playing. */
  spotifyClientId: string
  spotifyClientSecret: string
  /** v2.2 — grid layout custom da workspace inteira (cross-grupo). */
  workspaceGridLayout?: GridLayout
}

export type ProjectsFile = {
  version: 2
  groups: Group[]
  /** Ordem manual dos projetos sem grupo (Solto). */
  ungroupedOrder: string[]
  projects: Project[]
  activeProjectId: string | null
  /** Estado da workspace — quais containers estão abertos e em que ordem. */
  workspace: {
    containers: WorkspaceContainer[]
    /** Projetos acessados recentemente, mais recente primeiro, para tabs rápidas da topbar. */
    recentProjectIds: string[]
    /** Tabs recentes da topbar, com escopo de projeto ou grupo/subgrupo. */
    recentTabs: WorkspaceRecentTab[]
  }
  preferences: Preferences
  cliPaths: Partial<Record<AgentType, string>>
}

export const DEFAULT_PREFERENCES: Preferences = {
  language: 'en',
  uiTheme: 'dark',
  uiZoom: 1,
  terminalTheme: null,
  enabledAgents: { shell: true, claude: true, codex: true, opencode: true },
  onboardingDone: false,
  workspaceFlat: false,
  fullscreenContainerId: null,
  firstLaunchAt: null,
  displayName: '',
  profileImageUrl: '',
  accountCreated: false,
  alwaysStartOnHome: false,
  spotifyClientId: '',
  spotifyClientSecret: '',
}

export const EMPTY_PROJECTS_FILE: ProjectsFile = {
  version: 2,
  groups: [],
  ungroupedOrder: [],
  projects: [],
  activeProjectId: null,
  workspace: { containers: [], recentProjectIds: [], recentTabs: [] },
  preferences: DEFAULT_PREFERENCES,
  cliPaths: {},
}

/** Status runtime de um PTY (não persistido). */
export type PtyStatus = 'working' | 'waiting' | 'stopped' | 'disabled' | 'offline'

/** Cores predefinidas pra grupos e projetos. */
export const GROUP_COLORS = [
  '#6ea8ff',
  '#22d3ee',
  '#a78bfa',
  '#34d399',
  '#f59e0b',
  '#ef4444',
  '#ec4899',
  '#10b981',
] as const

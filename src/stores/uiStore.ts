import { create } from 'zustand'
import type { ClaudeUsage, CodexUsage, MemoryStats } from '../lib/tauri'
import type { AgentType } from '../lib/types'
import type { UpdateInfo } from '../lib/updater'

/**
 * Estado de UI ephemeral — modais abertos, query do find/jump, drag em
 * progresso etc. Nada aqui é persistido. Tudo persistente vai pro
 * `projectsStore` (que mapeia 1:1 pro `projects.json`).
 */

type ModalKind =
  | 'newProject'
  | 'newGroup'
  | 'editGroup'
  | 'editProject'
  | 'newTerminal'
  | 'newSubTab'
  | 'preferences'
  | 'findJump'
  | 'onboarding'
  | 'welcome'
  | 'layoutDesigner'
  | 'suspendGroup'
  | 'memoryAnalytics'
  | 'themePicker'
  | 'profiles'
  | 'sync'
  | 'topbarSettings'
  | 'updateAvailable'
  | null

export type ActiveView = 'home' | 'workspace' | 'agentCanvas'

export type MemorySample = MemoryStats & {
  ts: number
}

export type InAppToast = {
  id: string
  title: string
  body: string
  createdAt: number
  /** Agente que originou a notificação — define ícone/cor do toast. */
  agent?: AgentType
}

const MAX_MEMORY_HISTORY = 720
const MAX_TOASTS = 4
const MAX_NOTIFICATIONS = 12

type UiState = {
  openModal: ModalKind
  modalContext: Record<string, unknown> | null
  showMainMenu: boolean
  sidebarVisible: boolean
  ramMb: number | null
  memoryStats: MemoryStats | null
  memoryHistory: MemorySample[]
  claudeUsage: ClaudeUsage | null
  codexUsage: CodexUsage | null
  /** ID do terminal em focus mode (overlay fullscreen blur). null = sem focus. */
  focusedTerminalId: string | null
  /** Pulso pra requisitar foco num pane específico (sidebar click). */
  focusRequest: { terminalId: string; ts: number } | null
  activeTerminal: { projectId: string; terminalId: string } | null
  /** View principal sendo exibida no main. */
  activeView: ActiveView
  /** POC do agent canvas: pasta escolhida + id do PTY do claude embutido. */
  agentCanvasSession: { folder: string; ptyId: string } | null
  /** Teto de gasto (USD) da sessão do canvas. null = sem teto. */
  agentCanvasBudgetUsd: number | null
  /** Notificações in-app efêmeras (banner). */
  toasts: InAppToast[]
  /** Histórico recente de notificações (não some com o banner) — usado na Home. */
  notifications: InAppToast[]
  /** Update disponível (checado em silêncio no boot). null = atualizado/sem info. */
  updateInfo: UpdateInfo | null

  openModal_: (kind: Exclude<ModalKind, null>, context?: Record<string, unknown>) => void
  closeModal: () => void
  toggleMainMenu: () => void
  toggleSidebar: () => void
  setRamMb: (value: number | null) => void
  addMemorySample: (value: MemoryStats) => void
  clearMemoryHistory: () => void
  setClaudeUsage: (value: ClaudeUsage | null) => void
  setCodexUsage: (value: CodexUsage | null) => void
  setFocusedTerminal: (id: string | null) => void
  requestPaneFocus: (terminalId: string) => void
  setActiveTerminal: (projectId: string, terminalId: string) => void
  setActiveView: (v: ActiveView) => void
  toggleHome: () => void
  setAgentCanvasSession: (session: { folder: string; ptyId: string } | null) => void
  setAgentCanvasBudget: (usd: number | null) => void
  pushToast: (toast: {
    title: string
    body: string
    agent?: AgentType
    /** Só registra no histórico (Home), sem mostrar o banner efêmero. */
    silent?: boolean
  }) => void
  dismissToast: (id: string) => void
  clearNotifications: () => void
  setUpdateInfo: (info: UpdateInfo | null) => void
}

export const useUiStore = create<UiState>((set) => ({
  openModal: null,
  modalContext: null,
  showMainMenu: false,
  sidebarVisible: true,
  ramMb: null,
  memoryStats: null,
  memoryHistory: [],
  claudeUsage: null,
  codexUsage: null,
  focusedTerminalId: null,
  focusRequest: null,
  activeTerminal: null,
  activeView: 'workspace',
  agentCanvasSession: null,
  agentCanvasBudgetUsd: null,
  toasts: [],
  notifications: [],
  updateInfo: null,

  openModal_: (kind, context) => set({ openModal: kind, modalContext: context ?? null }),
  closeModal: () => set({ openModal: null, modalContext: null }),
  toggleMainMenu: () => set((s) => ({ showMainMenu: !s.showMainMenu })),
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  setRamMb: (value) => set({ ramMb: value }),
  addMemorySample: (value) =>
    set((s) => ({
      ramMb: value.total_mb,
      memoryStats: value,
      memoryHistory: [...s.memoryHistory, { ...value, ts: Date.now() }].slice(-MAX_MEMORY_HISTORY),
    })),
  clearMemoryHistory: () => set({ memoryHistory: [] }),
  setClaudeUsage: (value) => set({ claudeUsage: value }),
  setCodexUsage: (value) => set({ codexUsage: value }),
  setFocusedTerminal: (id) => set({ focusedTerminalId: id }),
  requestPaneFocus: (terminalId) => set({ focusRequest: { terminalId, ts: Date.now() } }),
  setActiveTerminal: (projectId, terminalId) => set({ activeTerminal: { projectId, terminalId } }),
  setActiveView: (v) =>
    set((s) => (s.activeView === v ? s : { activeView: v })),
  toggleHome: () =>
    set((s) => ({ activeView: s.activeView === 'home' ? 'workspace' : 'home' })),
  setAgentCanvasSession: (session) => set({ agentCanvasSession: session }),
  setAgentCanvasBudget: (usd) => set({ agentCanvasBudgetUsd: usd }),
  pushToast: ({ title, body, agent, silent }) =>
    set((s) => {
      const entry: InAppToast = {
        id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
        title,
        body,
        createdAt: Date.now(),
        agent,
      }
      return {
        toasts: silent ? s.toasts : [entry, ...s.toasts].slice(0, MAX_TOASTS),
        notifications: [entry, ...s.notifications].slice(0, MAX_NOTIFICATIONS),
      }
    }),
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((toast) => toast.id !== id) })),
  clearNotifications: () => set({ notifications: [] }),
  setUpdateInfo: (info) => set({ updateInfo: info }),
}))

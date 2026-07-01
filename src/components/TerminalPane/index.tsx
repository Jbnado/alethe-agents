import { useDraggable, useDroppable } from '@dnd-kit/core'
import {
  ChevronLeft,
  Eye,
  EyeOff,
  FolderOpen,
  GripVertical,
  History,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'

import { useGridResize } from '../../hooks/useGridResize'
import { useT } from '../../lib/i18n'
import { buildAgentLaunch } from '../../lib/sessionLaunch'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import type { Terminal as TerminalEntry, SubTab, Theme, AgentType } from '../../lib/types'
import { getPtyCwd, openInFileExplorer, openInVscode, restartPty } from '../../lib/tauri'
import { AgentIcon, VSCodeIcon } from '../icons/AgentIcons'
import { ClaudeHistoryModal } from '../modals/ClaudeHistoryModal'
import { SubTabsLane } from '../SubTabsLane'
import { XTermView } from '../XTermView'
import styles from './TerminalPane.module.css'

export type TerminalPaneProps = {
  projectId: string
  terminal: TerminalEntry
  /** True quando renderizado dentro do FocusOverlay (mostra Minimize, esconde Focus). */
  inFocusOverlay?: boolean
  /** True quando renderizado na Home — esconde grip, actions, lane, grid resize. */
  preview?: boolean
}

export const TerminalPane = memo(function TerminalPane({
  projectId,
  terminal,
  inFocusOverlay = false,
  preview = false,
}: TerminalPaneProps) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const focusedTerminalId = useUiStore((s) => s.focusedTerminalId)
  const isFocusMode = inFocusOverlay || focusedTerminalId === terminal.id
  // Drag-and-drop pra reordenar entre panes (igual canvas-agents focus mode).
  // Skip dentro do focus overlay — não faz sentido reordenar quando só tem 1.
  const draggable = useDraggable({
    id: `pane:${terminal.id}`,
    disabled: isFocusMode || preview,
  })
  const droppable = useDroppable({
    id: `pane:${terminal.id}`,
    disabled: isFocusMode || preview,
  })
  const paneRef = useRef<HTMLDivElement | null>(null)
  const setRefs = (node: HTMLDivElement | null) => {
    paneRef.current = node
    draggable.setNodeRef(node)
    droppable.setNodeRef(node)
  }

  // Foco vindo da sidebar — scroll into view + foca o textarea do xterm.
  const focusReq = useUiStore((s) => s.focusRequest)
  useEffect(() => {
    if (!focusReq || focusReq.terminalId !== terminal.id) return
    const node = paneRef.current
    if (!node) return
    node.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    const ta = node.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    ta?.focus()
  }, [focusReq, terminal.id])

  const setActiveTab = useProjectsStore((s) => s.setActiveTab)
  const closeSubTab = useProjectsStore((s) => s.closeSubTab)
  const setLaneVisible = useProjectsStore((s) => s.setLaneVisible)
  const setTerminalDisabled = useProjectsStore((s) => s.setTerminalDisabled)
  const deleteTerminal = useProjectsStore((s) => s.deleteTerminal)
  const setSubTabPtyId = useProjectsStore((s) => s.setSubTabPtyId)
  const setSubTabSessionId = useProjectsStore((s) => s.setSubTabSessionId)
  const setSubTabCompletionUnread = useProjectsStore((s) => s.setSubTabCompletionUnread)
  const setProjectGridLayout = useProjectsStore((s) => s.setProjectGridLayout)
  const openModal = useUiStore((s) => s.openModal_)
  const setFocusedTerminal = useUiStore((s) => s.setFocusedTerminal)
  const setActiveTerminal = useUiStore((s) => s.setActiveTerminal)
  const terminalTheme = useProjectsStore(
    (s) => s.preferences.terminalTheme ?? s.preferences.uiTheme,
  )

  // Resize de span no grid do PROJETO (quando project.layoutMode === 'grid').
  const projectGrid = useProjectsStore((s) => {
    const p = s.projects.find((p) => p.id === projectId)
    if (!p || p.layoutMode !== 'grid' || !p.gridLayout) return null
    return p.gridLayout
  })
  const showGridResize = Boolean(projectGrid) && !isFocusMode && !terminal.disabled && !preview
  const startGridResize = useGridResize(terminal.id, projectGrid, (layout) =>
    setProjectGridLayout(projectId, layout),
  )

  const activeTab: SubTab | undefined = useMemo(
    () => terminal.tabs.find((tab) => tab.id === terminal.activeTabId) ?? terminal.tabs[0],
    [terminal.tabs, terminal.activeTabId],
  )

  const effectiveLaneVisible =
    terminal.tabs.length > 1 ? true : terminal.laneVisible === true

  const ptyRuntime = useTerminalsStore((s) =>
    activeTab?.ptyId ? s.byPtyId[activeTab.ptyId] ?? null : null,
  )
  const status = ptyRuntime?.status ?? 'waiting'
  const ptyExited = ptyRuntime !== null && !ptyRuntime.alive

  const onToggleLane = () => {
    if (terminal.tabs.length > 1) return
    setLaneVisible(projectId, terminal.id, effectiveLaneVisible ? false : true)
  }

  const onRestart = async () => {
    if (!activeTab?.ptyId) return
    const ptyId = activeTab.ptyId
    const launch = buildAgentLaunch(
      activeTab.type,
      activeTab.extraArgs ?? [],
      activeTab.sessionId,
    )
    if (launch.sessionId && launch.sessionId !== activeTab.sessionId) {
      setSubTabSessionId(projectId, terminal.id, activeTab.id, launch.sessionId)
    }
    // Marca início do restart pra ignorar o exit event do PTY antigo (chega async).
    useTerminalsStore.getState().beginRestart(ptyId)
    try {
      await restartPty({
        id: ptyId,
        cols: 80,
        rows: 24,
        command: activeTab.type === 'shell' ? undefined : activeTab.type,
        cwd: activeTab.cwd || undefined,
        extraArgs: launch.args,
      })
      window.dispatchEvent(new CustomEvent('alethe:terminal-resize-request', { detail: { ptyId } }))
    } catch (err) {
      console.error('restart pty falhou', err)
    }
  }

  const onDisable = () => setTerminalDisabled(projectId, terminal.id, !terminal.disabled)

  const onDelete = () => {
    if (window.confirm(t('ui.sidebar.confirmDeleteTerminal', { name: terminal.name }))) {
      deleteTerminal(projectId, terminal.id)
      if (isFocusMode) setFocusedTerminal(null)
    }
  }

  const cwd = activeTab?.cwd?.trim() || terminal.cwd?.trim() || ''
  const isAgentWithHistory =
    activeTab && (activeTab.type === 'claude' || activeTab.type === 'codex' || activeTab.type === 'opencode')

  /** Resolve cwd: usa o configurado; senão pergunta ao backend o cwd vivo do PTY. */
  const resolveCwd = async (): Promise<string | null> => {
    if (cwd) return cwd
    if (activeTab?.ptyId) {
      try {
        const live = await getPtyCwd(activeTab.ptyId)
        if (live && live.trim()) return live
      } catch {
        /* ignora */
      }
    }
    return null
  }

  const openWithCwd = async (action: (path: string) => Promise<void>, label: string) => {
    const path = await resolveCwd()
    if (!path) {
      window.alert(t('ui.terminal.noCwdAvailable', { label }))
      return
    }
    try {
      await action(path)
    } catch (err) {
      window.alert(t('ui.terminal.openFailed', { label, error: String(err) }))
    }
  }

  const onShowHistory = () => {
    if (!activeTab) return
    setHistoryOpen(true)
  }

  const dropTarget = droppable.isOver && !isFocusMode
  const dragging = draggable.isDragging

  return (
    <div
      ref={setRefs}
      data-pane-box="1"
      onPointerDown={() => setActiveTerminal(projectId, terminal.id)}
      className={`${styles.pane} ${isFocusMode ? styles.paneFocus : ''} ${terminal.disabled ? styles.disabled : ''} ${dragging ? styles.dragging : ''} ${dropTarget ? styles.dropTarget : ''}`}
    >
      <header className={styles.header}>
        <div className={styles.headLeft}>
          {!isFocusMode && !preview ? (
            <button
              type="button"
              className={`${styles.action} ${styles.gripBtn}`}
              {...draggable.attributes}
              {...draggable.listeners}
              title={t('ui.terminal.dragToReorder')}
              aria-label={t('ui.terminal.dragToReorder')}
            >
              <GripVertical size={12} />
            </button>
          ) : null}
          <span className={styles.iconWrap}>
            {activeTab ? (
              <AgentIcon type={activeTab.type} size={16} theme={terminalTheme} />
            ) : null}
          </span>
          <div className={styles.identity}>
            <span className={styles.name} title={terminal.name}>
              {terminal.name}
            </span>
            {cwd ? (
              <span className={styles.cwdPill} title={cwd}>
                {shortCwd(cwd)}
              </span>
            ) : null}
          </div>
        </div>

        {!preview ? (
        <div className={styles.headRight}>
          <span
            className={`${styles.statusPill} ${styles[`status_${status}`] ?? ''}`}
            title={status}
          />
          <div className={styles.actions}>
            {/* Secundárias: aparecem só com expandido */}
            {expanded ? (
              <>
                <button
                  type="button"
                  className={styles.action}
                  onClick={onToggleLane}
                  title={effectiveLaneVisible ? t('ui.terminal.hideTabsLane') : t('ui.terminal.showTabsLane')}
                  aria-label={t('ui.terminal.toggleLane')}
                  disabled={terminal.tabs.length > 1}
                >
                  {effectiveLaneVisible ? <PanelLeftClose size={12} /> : <PanelLeftOpen size={12} />}
                </button>
                {isAgentWithHistory ? (
                  <button
                    type="button"
                    className={styles.action}
                    onClick={onShowHistory}
                    title={t('ui.terminal.sessionHistory')}
                    aria-label={t('ui.terminal.history')}
                  >
                    <History size={12} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className={styles.action}
                  onClick={() => void onRestart()}
                  title="Restart"
                  aria-label="Restart"
                  disabled={!activeTab?.ptyId || terminal.disabled}
                >
                  <RefreshCw size={12} />
                </button>
                <button
                  type="button"
                  className={styles.action}
                  onClick={onDisable}
                  title={terminal.disabled ? t('ui.sidebar.reactivate') : t('ui.terminal.disableFreesRam')}
                  aria-label={t('ui.terminal.disable')}
                >
                  {terminal.disabled ? <Eye size={12} /> : <EyeOff size={12} />}
                </button>
                <button
                  type="button"
                  className={`${styles.action} ${styles.danger}`}
                  onClick={onDelete}
                  title={t('ui.sidebar.deleteTerminal')}
                  aria-label={t('ui.sidebar.deleteTerminal')}
                >
                  <Trash2 size={12} />
                </button>
                <div className={styles.actionsDivider} aria-hidden />
              </>
            ) : null}

            {/* Principais sempre visíveis */}
            <button
              type="button"
              className={styles.action}
              onClick={() => void openWithCwd(openInFileExplorer, 'Explorer')}
              title={cwd ? t('ui.terminal.openInExplorerCwd', { cwd }) : t('ui.terminal.openLiveCwdInExplorer')}
              aria-label={t('ui.terminal.openInExplorer')}
            >
              <FolderOpen size={12} />
            </button>
            <button
              type="button"
              className={`${styles.action} ${styles.vscode}`}
              onClick={() => void openWithCwd(openInVscode, 'VS Code')}
              title={cwd ? t('ui.terminal.openInVscodeCwd', { cwd }) : t('ui.terminal.openLiveCwdInVscode')}
              aria-label={t('ui.terminal.openInVscode')}
            >
              <VSCodeIcon size={14} />
            </button>
            {isFocusMode ? (
              <button
                type="button"
                className={styles.action}
                onClick={() => setFocusedTerminal(null)}
                title={t('ui.terminal.exitFocusModeEsc')}
                aria-label={t('ui.terminal.exitFocusMode')}
              >
                <Minimize2 size={12} />
              </button>
            ) : (
              <button
                type="button"
                className={styles.action}
                onClick={() => setFocusedTerminal(terminal.id)}
                title={t('ui.terminal.focusModeFullscreen')}
                aria-label={t('ui.terminal.focusMode')}
              >
                <Maximize2 size={12} />
              </button>
            )}

            {/* Toggle expandir/recolher */}
            <button
              type="button"
              className={`${styles.action} ${expanded ? styles.actionActive : ''}`}
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? t('ui.terminal.showLess') : t('ui.terminal.showMoreActions')}
              aria-label={t('ui.terminal.moreActions')}
              aria-expanded={expanded}
            >
              {expanded ? <ChevronLeft size={12} /> : <MoreHorizontal size={12} />}
            </button>
          </div>
        </div>
        ) : null}
      </header>

      <div className={styles.body}>
        {effectiveLaneVisible && !preview ? (
          <SubTabsLane
            tabs={terminal.tabs}
            activeTabId={terminal.activeTabId}
            onActivate={(id) => setActiveTab(projectId, terminal.id, id)}
            onClose={(id) => closeSubTab(projectId, terminal.id, id)}
            onAdd={() => openModal('newSubTab', { projectId, terminalId: terminal.id })}
          />
        ) : null}

        <div className={styles.terminalArea}>
          {terminal.disabled ? (
            <DisabledOverlay
              terminalName={terminal.name}
              cwd={cwd}
              agentType={activeTab?.type ?? 'shell'}
              terminalTheme={terminalTheme}
              onReactivate={onDisable}
            />
          ) : activeTab ? (
            <>
              <XTermView
                key={activeTab.id}
                projectId={projectId}
                ptyId={activeTab.ptyId ?? activeTab.id}
                command={activeTab.type === 'shell' ? null : activeTab.type}
                cwd={activeTab.cwd || null}
                extraArgs={activeTab.extraArgs}
                sessionId={activeTab.sessionId}
                terminalTheme={terminalTheme}
                onSpawned={(id) => {
                  if (activeTab.ptyId !== id) {
                    setSubTabPtyId(projectId, terminal.id, activeTab.id, id)
                  }
                }}
                onSessionId={(sessionId) => {
                  if (activeTab.sessionId !== sessionId) {
                    setSubTabSessionId(projectId, terminal.id, activeTab.id, sessionId)
                  }
                }}
                onAgentComplete={() =>
                  setSubTabCompletionUnread(projectId, terminal.id, activeTab.id, true)
                }
              />
              {ptyExited ? (
                <div className={styles.exitedOverlay}>
                  <RefreshCw size={24} style={{ opacity: 0.5 }} />
                  <span className={styles.exitedLabel}>{t('ui.terminal.processEnded')}</span>
                  <button
                    type="button"
                    className={styles.restartBtn}
                    onClick={() => void onRestart()}
                  >
                    {t('ui.terminal.restart')}
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <div className={styles.empty}>
              <X size={20} />
              <span>{t('ui.terminal.noTab')}</span>
            </div>
          )}
        </div>
      </div>

      {showGridResize ? (
        <div
          className={styles.gridResize}
          onPointerDown={startGridResize}
          title={t('ui.terminal.dragToResizeSpan')}
        />
      ) : null}

      {activeTab && isAgentWithHistory && !preview ? (
        <ClaudeHistoryModal
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          projectId={projectId}
          terminalId={terminal.id}
          tabId={activeTab.id}
          ptyId={activeTab.ptyId}
          cwd={cwd}
          agentType={activeTab.type}
          extraArgs={activeTab.extraArgs}
        />
      ) : null}
    </div>
  )
})

function DisabledOverlay({
  terminalName,
  cwd,
  agentType,
  terminalTheme,
  onReactivate,
}: {
  terminalName: string
  cwd: string
  agentType: AgentType
  terminalTheme: Theme
  onReactivate: () => void
}) {
  const t = useT()
  return (
    <div className={styles.disabledOverlay}>
      <div className={styles.disabledIcon}>
        <AgentIcon type={agentType} size={56} theme={terminalTheme} />
      </div>
      <div className={styles.disabledName}>{terminalName}</div>
      {cwd ? <div className={styles.disabledCwd}>{cwd}</div> : null}
      <button type="button" className={styles.reactivateBtn} onClick={onReactivate}>
        {t('ui.sidebar.reactivate')}
      </button>
    </div>
  )
}

function shortCwd(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  const parts = cleaned.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return cleaned
  return `…/${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

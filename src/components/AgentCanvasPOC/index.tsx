import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDndMonitor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  ArrowLeft,
  Bot,
  ClipboardCopy,
  Grip,
  LayoutTemplate,
  Library,
  Link2,
  ListTodo,
  Maximize2,
  Paintbrush,
  PenLine,
  PiggyBank,
  Plus,
  RotateCcw,
  Server,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  UserPlus,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

import { AGENT_LIBRARY, type AgentTemplate } from '../../lib/agentLibrary'
import { getCachedClaudeUsage } from '../../lib/claudeUsageCache'
import { useT } from '../../lib/i18n'
import {
  killPty,
  listenPtyExit,
  spawnPty,
  writeClipboardText,
  writePty,
  type ClaudeUsage,
} from '../../lib/tauri'
import {
  useAgentCanvasStore,
  type AgentHookPayload,
  type AgentNode,
} from '../../stores/agentCanvasStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { CodexIcon } from '../icons/AgentIcons'
import { XTermView } from '../XTermView'
import { AgentModal } from './AgentModal'
import styles from './AgentCanvasPOC.module.css'

/**
 * Fases 2–4 do agent canvas.
 *
 * Fluxo: o botão na Home pede uma pasta; esta view abre um terminal embutido
 * rodando `claude --dangerously-skip-permissions --settings <hooks.json>`
 * nessa pasta, com CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 injetada SÓ neste
 * PTY. Subagents viram cards com feed ao vivo; teammates de Agent Teams
 * viram cards grandes (in-process: cada turno encarna como subagent com
 * agent_type = nome — o store agrega); a task list do time vira painel.
 * A biblioteca lateral instala agents (.claude/agents/*.md) por drag & drop.
 */

const AGENT_COLORS: Record<string, string> = {
  explore: 'var(--agent-codex)',
  plan: '#a78bfa',
  'general-purpose': 'var(--agent-claude)',
}

const TEST_PROMPT =
  'Analise esta codebase com 3 subagents Explore em paralelo: um pro código-fonte principal, ' +
  'um pra configs/build e um pra docs/testes. Cada um mapeia os arquivos do seu escopo e devolve um resumo curto.'

const MINI_FEED_SIZE = 3

// Agent Teams (experimental) ligado só neste PTY; auto-updater desligado pra o
// claude não se atualizar no meio da sessão (um update interrompido renomeia o
// binário pra claude.exe.old e derruba o control plane — já aconteceu).
const PTY_ENV = {
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  DISABLE_AUTOUPDATER: '1',
}

/** Acima deste % de uso da janela de 5h do Claude, liga o fallback codex. */
const USAGE_FALLBACK_THRESHOLD = 80
/** De quanto em quanto tempo o canvas relê o usage do Claude. */
const USAGE_POLL_MS = 60_000

function formatReset(resetsAt: string, nowLabel = 'agora'): string {
  if (!resetsAt) return '—'
  const diff = new Date(resetsAt).getTime() - Date.now()
  if (Number.isNaN(diff)) return '—'
  if (diff <= 0) return nowLabel
  const h = Math.floor(diff / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  return h > 0 ? `${h}h${m}m` : `${m}m`
}

/**
 * Regras de orquestração injetadas no lead via --append-system-prompt — só
 * nesta sessão, sem tocar em CLAUDE.md do projeto. Em inglês porque adesão
 * de system prompt é mais consistente.
 */
// IMPORTANTE: string de UMA linha, sem aspas duplas, backticks ou apóstrofos.
// Ela é passada como arg via PowerShell -> claude.cmd (batch) no Windows;
// aspas/backticks/newlines quebram o parsing do batch e o launcher falha.
function orchestrationRules(agentEndpoint: string) {
  return (
  'You are the control plane of an Alethe agent canvas session. Orchestration rules: ' +
  '(1) Work solo for small tasks; spawning agents has overhead. ' +
  '(2) Delegate focused self-contained work to subagents when only the result matters; keep your context lean. ' +
  '(3) If cheap workers exist in .claude/agents, route accordingly: haiku-resumidor for bulk reading and summarizing, haiku-mecanico for well-specified mechanical edits, codex-executor for long noisy execution; never route architecture or ambiguous work to cheap workers. ' +
  '(4) Create an agent team only for large multi-front work where workers must coordinate (parallel epics, front plus back); give each teammate distinct paths so two never edit the same file, put full context in the spawn prompt, break work into tasks with dependencies, and wait for your teammates instead of implementing yourself. ' +
  `(5) You control a persistent codex terminal worker in the canvas. To offload heavy or long execution work, send the task to the local endpoint ${agentEndpoint}/codex with an HTTP POST whose body is the task as one self-contained English instruction (use curl -s -X POST with the -d flag). It runs in the codex terminal worker and the user can open it. It is fire and forget: you do not get the output back, so use it for offloadable work, not for results you must read. Prefer this when Claude usage is high.`
  )
}

/** Normaliza paths Windows pra comparar cwd de eventos com a pasta da sessão. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

type InstalledAgent = { name: string; from_alethe: boolean }

function colorFor(agentType: string): string {
  const known = AGENT_COLORS[agentType.toLowerCase()]
  if (known) return known
  // Agent custom / teammate → cor estável por hash do nome.
  let h = 0
  for (const ch of agentType) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `hsl(${h % 360} 55% 62%)`
}

function durationLabel(node: { startedAt: number; endedAt: number | null }): string | null {
  if (node.endedAt === null) return null
  const s = Math.round((node.endedAt - node.startedAt) / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`
}

type Edge = { id: string; x1: number; y1: number; x2: number; y2: number; done: boolean }

/**
 * Codex worker = um PTY REAL rodando `codex` na pasta da sessão, gerenciado
 * pelo Alethe (≠ do subagent Haiku `codex-executor` da Fase 3, que vive dentro
 * do Claude). Tem card próprio no canvas e abre o terminal completo quando
 * expandido. O PTY é spawnado pelo XTermView na 1ª montagem e sobrevive ao
 * colapso (desmontar não mata; só killPty mata) — reabrir re-attacha o
 * scrollback.
 */
type CodexWorker = {
  ptyId: string
  /** Tarefa/origem do worker (ex.: "fallback de usage"). */
  title: string
  cwd: string
  startedAt: number
  exitedCode: number | null
  /** extraArgs do codex: ['exec','--skip-git-repo-check', task] no despacho; undefined no interativo. */
  args?: string[]
}

function statusBadgeClass(status: AgentNode['status']): string {
  if (status === 'running') return styles.statusRunning
  if (status === 'idle') return styles.statusIdle
  return styles.statusDone
}

function personaIconFor(agentName: string): LucideIcon {
  const name = agentName.toLowerCase()
  if (name.includes('frontend')) return Paintbrush
  if (name.includes('backend')) return Server
  if (name.includes('qa') || name.includes('review')) return ShieldCheck
  if (name.includes('docs') || name.includes('writer')) return PenLine
  if (name.includes('codex') || name.includes('executor')) return TerminalSquare
  if (name.includes('plan')) return LayoutTemplate
  return Bot
}

type AgentChipProps = {
  name: string
  cost?: AgentTemplate['cost']
  summary?: string
  installed?: boolean
  foreign?: boolean
  draggable?: boolean
  dragging?: boolean
  ghost?: boolean
  action: ReactNode
}

function AgentChip({
  name,
  cost,
  summary,
  installed = false,
  foreign = false,
  draggable = false,
  dragging = false,
  ghost = false,
  action,
}: AgentChipProps) {
  const t = useT()
  const Icon = personaIconFor(name)
  const costClass = cost === 'barato' ? styles.costCheap : styles.costExpensive
  return (
    <div
      className={[
        styles.agentChip,
        installed ? styles.agentChipInstalled : '',
        draggable ? styles.agentChipDraggable : '',
        ghost ? styles.agentChipGhost : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        ['--agent-color' as string]: colorFor(name),
        opacity: dragging ? 0.35 : undefined,
      }}
      title={summary}
    >
      <span className={styles.personaToken} aria-hidden="true">
        <Icon size={13} />
      </span>
      <span className={styles.agentChipName}>{name}</span>
      {cost ? <span className={costClass}>{cost}</span> : null}
      {foreign ? <span className={styles.chipForeign}>{t('ws.external')}</span> : null}
      <span className={styles.agentChipAction}>{action}</span>
    </div>
  )
}

/**
 * Item da biblioteca — draggable via dnd-kit (HTML5 DnD não funciona dentro
 * da webview Tauri no Windows: o file-drop handler intercepta os eventos).
 * O botão "+ instalar" é o fallback de clique.
 */
function LibraryItem({
  template,
  installed,
  onInstall,
}: {
  template: AgentTemplate
  installed: boolean
  onInstall: () => void
}) {
  const t = useT()
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `lib:${template.name}`,
    disabled: installed,
  })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={styles.libraryChipWrap}
    >
      <AgentChip
        name={template.name}
        cost={template.cost}
        summary={template.summary}
        installed={installed}
        draggable={!installed}
        dragging={isDragging}
        action={
          installed ? (
            <span className={styles.libraryInstalledTag}>{t('ws.installed')}</span>
          ) : (
            <button
              type="button"
              className={styles.chipAction}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onInstall}
              title={t('ws.installAgent')}
              aria-label={t('ws.installAgentName', { name: template.name })}
            >
              <UserPlus size={13} />
            </button>
          )
        }
      />
    </div>
  )
}

export function AgentCanvasPOC() {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const [draggingAgent, setDraggingAgent] = useState<string | null>(null)
  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e) => setDraggingAgent(String(e.active.id).replace(/^lib:/, ''))}
      onDragEnd={() => setDraggingAgent(null)}
      onDragCancel={() => setDraggingAgent(null)}
    >
      <AgentCanvasInner />
      <DragOverlay dropAnimation={null}>
        {draggingAgent ? (
          <AgentChip
            name={draggingAgent}
            cost={AGENT_LIBRARY.find((t) => t.name === draggingAgent)?.cost}
            summary={AGENT_LIBRARY.find((t) => t.name === draggingAgent)?.summary}
            ghost
            action={<Link2 size={13} />}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

function AgentCanvasInner() {
  const t = useT()
  const setActiveView = useUiStore((s) => s.setActiveView)
  const session = useUiStore((s) => s.agentCanvasSession)
  const terminalTheme = useProjectsStore(
    (s) => s.preferences.terminalTheme ?? s.preferences.uiTheme,
  )
  const nodes = useAgentCanvasStore((s) => s.nodes)
  const tasks = useAgentCanvasStore((s) => s.tasks)
  const teamName = useAgentCanvasStore((s) => s.teamName)
  const lastEventAt = useAgentCanvasStore((s) => s.lastEventAt)
  const select = useAgentCanvasStore((s) => s.select)
  const clearStore = useAgentCanvasStore((s) => s.clear)

  const [edges, setEdges] = useState<Edge[]>([])
  const [hooksSettingsPath, setHooksSettingsPath] = useState<string | null>(null)
  const [hooksEndpoint, setHooksEndpoint] = useState<string | null>(null)
  const [claudeExited, setClaudeExited] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const [economyOn, setEconomyOn] = useState(false)
  const [restartHint, setRestartHint] = useState(false)
  const [installed, setInstalled] = useState<InstalledAgent[]>([])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [palettePosition, setPalettePosition] = useState({ x: 16, y: 58 })

  // Codex workers + fallback de usage (terminais codex de verdade).
  const [codexWorkers, setCodexWorkers] = useState<CodexWorker[]>([])
  const [expandedCodexId, setExpandedCodexId] = useState<string | null>(null)
  const [usage, setUsage] = useState<ClaudeUsage | null>(null)
  const [fallbackActive, setFallbackActive] = useState(false)
  const fallbackActiveRef = useRef(false)
  const leadNotifiedRef = useRef(false)
  // Refs pra cleanup matar PTYs sem virar dependência dos effects.
  const codexWorkersRef = useRef<CodexWorker[]>([])
  const sessionRef = useRef(session)
  useEffect(() => {
    codexWorkersRef.current = codexWorkers
  }, [codexWorkers])
  useEffect(() => {
    sessionRef.current = session
  }, [session])

  const { setNodeRef: setDropRef, isOver: dragOver } = useDroppable({ id: 'agent-canvas-drop' })
  const { setNodeRef: setPlaneDropRef, isOver: planeDragOver } = useDroppable({
    id: 'agent-control-plane',
  })

  const containerRef = useRef<HTMLDivElement | null>(null)
  const planeRef = useRef<HTMLDivElement | null>(null)
  const cardRefs = useRef(new Map<string, HTMLDivElement>())

  const startPaletteDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('button') && target !== event.currentTarget) return
    const originX = event.clientX
    const originY = event.clientY
    const start = palettePosition
    event.currentTarget.setPointerCapture(event.pointerId)

    const onMove = (moveEvent: PointerEvent) => {
      setPalettePosition({
        x: Math.max(8, start.x + moveEvent.clientX - originX),
        y: Math.max(48, start.y + moveEvent.clientY - originY),
      })
    }
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
  }

  // Cria um codex worker. O PTY sobe JÁ em background (sem abrir o terminal);
  // o usuário abre quando quiser (opts.open). Se opts.task vier, roda
  // `codex exec "<task>"` — a tarefa vai como ARGUMENTO (determinístico, não
  // depende de digitar na TUI); senão, `codex` interativo pro usuário mexer.
  const spawnCodexWorker = useCallback(
    (title: string, opts: { open?: boolean; task?: string } = {}): string | null => {
      const folder = sessionRef.current?.folder
      if (!folder) return null
      const ptyId = `codex-worker-${Date.now()}`
      const args = opts.task ? ['exec', '--skip-git-repo-check', opts.task] : undefined
      console.log('[AgentCanvasPOC] criando codex worker', ptyId, '· task=', !!opts.task, '·', title)
      setCodexWorkers((prev) => [
        ...prev,
        { ptyId, title, cwd: folder, startedAt: Date.now(), exitedCode: null, args },
      ])
      void spawnPty({ cols: 120, rows: 30, id: ptyId, command: 'codex', cwd: folder, extraArgs: args })
        .then(() => {
          // Captura o término mesmo com o terminal fechado — senão o card de um
          // `codex exec` (one-shot) ficaria "running" pra sempre.
          void listenPtyExit(ptyId, (code) => {
            console.log('[AgentCanvasPOC] codex worker', ptyId, 'saiu, code', code)
            setCodexWorkers((prev) =>
              prev.map((w) => (w.ptyId === ptyId ? { ...w, exitedCode: code ?? 0 } : w)),
            )
          })
        })
        .catch((err) => console.error('[AgentCanvasPOC] falha spawnando codex PTY:', err))
      if (opts.open) setExpandedCodexId(ptyId)
      return ptyId
    },
    [],
  )

  const killCodexWorker = useCallback((ptyId: string) => {
    console.log('[AgentCanvasPOC] matando codex worker', ptyId)
    void killPty(ptyId).catch(() => {})
    setCodexWorkers((prev) => prev.filter((w) => w.ptyId !== ptyId))
    setExpandedCodexId((cur) => (cur === ptyId ? null : cur))
  }, [])

  // Ponte de controle: tarefa despachada pelo control plane (POST /codex) cria
  // um codex worker que roda `codex exec "<task>"` — sempre executa (sem
  // depender de digitar na TUI). Cada despacho = um card. O usuário abre pra
  // acompanhar; o codex sai quando termina (card vira "exit N").
  const dispatchToCodex = useCallback(
    (task: string) => {
      // O task vem do lead (texto cru) e vira arg de `codex exec` via
      // PowerShell -> codex.cmd (batch). Aspas duplas e newlines quebram o
      // batch (mesma causa do bug do control plane) — então sanitiza:
      // aspas duplas viram simples (o command_builder escapa simples com
      // segurança) e quebras de linha viram espaço.
      const safe = task.replace(/"/g, "'").replace(/\s*[\r\n]+\s*/g, ' ').trim()
      if (!safe) return
      console.log('[AgentCanvasPOC] despacho do control plane pro codex:', safe.slice(0, 80))
      spawnCodexWorker(safe.length > 60 ? `${safe.slice(0, 60)}…` : safe, { task: safe })
    },
    [spawnCodexWorker],
  )

  useEffect(() => {
    const unlistenPromise = listen<string>('codex-task', (event) => {
      console.log('[AgentCanvasPOC] codex-task:', String(event.payload).slice(0, 80))
      dispatchToCodex(String(event.payload))
    })
    return () => {
      void unlistenPromise.then((u) => u())
    }
  }, [dispatchToCodex])

  const refreshInstalled = useCallback(() => {
    if (!session) return
    invoke<InstalledAgent[]>('list_installed_agents', { folder: session.folder })
      .then((list) => {
        console.log('[AgentCanvasPOC] agents instalados:', list.map((a) => a.name).join(', ') || '(nenhum)')
        setInstalled(list)
      })
      .catch((err) => console.error('[AgentCanvasPOC] falha listando agents:', err))
  }, [session])

  // Gera o settings com os hooks ANTES de spawnar o claude — o XTermView só
  // monta quando o path existe, senão a sessão nasceria sem hooks.
  useEffect(() => {
    Promise.all([
      invoke<string>('agent_hooks_endpoint'),
      invoke<string>('agent_hooks_settings_path'),
    ])
      .then(([endpoint, path]) => {
        console.log('[AgentCanvasPOC] hooks endpoint:', endpoint)
        console.log('[AgentCanvasPOC] hooks settings pronto em:', path)
        setHooksEndpoint(endpoint)
        setHooksSettingsPath(path)
      })
      .catch((err) => console.error('[AgentCanvasPOC] falha gerando hooks settings:', err))
  }, [])

  // Estado inicial: modo economia + agents instalados na pasta.
  useEffect(() => {
    if (!session) return
    invoke<boolean>('economy_agents_enabled', { folder: session.folder })
      .then(setEconomyOn)
      .catch(() => {})
    refreshInstalled()
  }, [session, refreshInstalled])

  const toggleEconomy = () => {
    if (!session) return
    const next = !economyOn
    invoke<string[]>('set_economy_agents', { folder: session.folder, enabled: next })
      .then((touched) => {
        console.log(`[AgentCanvasPOC] modo economia ${next ? 'ON' : 'OFF'}, arquivos:`, touched)
        setEconomyOn(next)
        setRestartHint(true)
        refreshInstalled()
      })
      .catch((err) => console.error('[AgentCanvasPOC] falha togglando modo economia:', err))
  }

  const restartClaude = () => {
    if (!session) return
    console.log('[AgentCanvasPOC] reiniciando claude — matando PTY', session.ptyId)
    void killPty(session.ptyId).catch(() => {
      /* PTY pode já ter morrido */
    })
    setClaudeExited(null)
    setRestartHint(false)
    // ptyId novo força o XTermView a remontar e spawnar uma sessão fresca
    // (que carrega os agents de .claude/agents/ do zero).
    useUiStore.getState().setAgentCanvasSession({
      folder: session.folder,
      ptyId: `agent-canvas-${Date.now()}`,
    })
  }

  const installAgent = (name: string, force = false) => {
    if (!session) return
    const template = AGENT_LIBRARY.find((item) => item.name === name)
    if (!template) return
    invoke<string>('install_agent', {
      folder: session.folder,
      name: template.name,
      content: template.content,
      force,
    })
      .then((path) => {
        console.log('[AgentCanvasPOC] agent instalado:', path)
        setRestartHint(true)
        refreshInstalled()
      })
      .catch((err) => {
        if (String(err) === 'conflict') {
          if (window.confirm(t('ws.confirmOverwriteForeignAgent', { name }))) {
            installAgent(name, true)
          }
          return
        }
        console.error('[AgentCanvasPOC] falha instalando agent:', err)
      })
  }

  const uninstallAgent = (agent: InstalledAgent) => {
    if (!session) return
    const msg = agent.from_alethe
      ? t('ws.confirmRemoveAgent', { name: agent.name })
      : t('ws.confirmRemoveForeignAgent', { name: agent.name })
    if (!window.confirm(msg)) return
    invoke('uninstall_agent', { folder: session.folder, name: agent.name, force: true })
      .then(() => {
        console.log('[AgentCanvasPOC] agent removido:', agent.name)
        setRestartHint(true)
        refreshInstalled()
      })
      .catch((err) => console.error('[AgentCanvasPOC] falha removendo agent:', err))
  }

  // Drop da biblioteca no canvas → instala.
  useDndMonitor({
    onDragEnd: (e) => {
      const activeId = String(e.active.id)
      if (
        (e.over?.id === 'agent-canvas-drop' || e.over?.id === 'agent-control-plane') &&
        activeId.startsWith('lib:')
      ) {
        const name = activeId.slice(4)
        console.log('[AgentCanvasPOC] drop da biblioteca:', name)
        installAgent(name)
      }
    },
  })

  useEffect(() => {
    const unlistenPromise = listen<AgentHookPayload>('agent-hook', (event) => {
      // Qualquer sessão claude com hooks (outros projetos, testes headless)
      // posta na :9123 — o canvas só ingere eventos da SUA pasta.
      const cwd = (event.payload as { cwd?: string }).cwd
      if (session && cwd && normalizePath(cwd) !== normalizePath(session.folder)) {
        console.log('[AgentCanvasPOC] evento de outra sessão ignorado (cwd):', cwd)
        return
      }
      console.log('[AgentCanvasPOC] agent-hook:', event.payload.hook_event_name, event.payload)
      useAgentCanvasStore.getState().ingest(event.payload)
    })
    return () => {
      void unlistenPromise.then((unlisten) => unlisten())
    }
  }, [session])

  // Liga o fallback codex: avisa o lead pra DESPACHAR trabalho pesado pro
  // terminal codex via a ponte /codex. NÃO cria codex vazio — o worker nasce
  // quando o lead despacha (dispatchToCodex), aí já com tarefa rodando.
  // Idempotente (fallbackActiveRef). Também chamável pelo chip de usage pra
  // testar sem chegar a 80% de verdade.
  const activateFallback = useCallback((u: ClaudeUsage | null, forced = false) => {
    if (fallbackActiveRef.current) return
    fallbackActiveRef.current = true
    setFallbackActive(true)
    const pct = u ? Math.round(u.five_hour.utilization) : 0
    console.log(`[AgentCanvasPOC] FALLBACK codex ON${forced ? ' (forçado)' : ''} — 5h ${pct}%`)
    if (!leadNotifiedRef.current && sessionRef.current) {
      leadNotifiedRef.current = true
      const reset = u ? formatReset(u.five_hour.resets_at) : '—'
      // Instrução acionável e sem ambiguidade: despache via a ponte HTTP. Sem
      // \r — o usuário confirma. (Requer sessão iniciada após esta regra existir.)
      const endpoint = hooksEndpoint ?? 'http://127.0.0.1:9123'
      const note = `[Alethe] Claude 5h usage at ${pct}% (resets in ${reset}). Conserve Claude tokens: from now on, offload heavy/long/mechanical work to the codex terminal by running: curl -s -X POST ${endpoint}/codex -d "<task as one self-contained English instruction>". It runs in the codex terminal worker shown in the canvas. `
      void writePty(sessionRef.current.ptyId, note).catch(() => {})
    }
  }, [hooksEndpoint])

  // Monitor de usage do Claude — lê a janela de 5h e liga/desliga o fallback.
  useEffect(() => {
    if (!session) return
    let cancelled = false

    const check = async () => {
      try {
        const u = await getCachedClaudeUsage()
        if (cancelled) return
        setUsage(u)
        const util = u.five_hour.utilization
        if (util >= USAGE_FALLBACK_THRESHOLD) {
          activateFallback(u)
        } else if (fallbackActiveRef.current) {
          // Reset aconteceu — desliga o fallback (o aviso ao lead não repete).
          fallbackActiveRef.current = false
          setFallbackActive(false)
          console.log('[AgentCanvasPOC] fallback codex OFF — usage voltou a', util)
        }
      } catch (err) {
        console.warn('[AgentCanvasPOC] usage indisponível (sem token?):', err)
      }
    }

    void check()
    const timer = window.setInterval(check, USAGE_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [session, activateFallback])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPaletteOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Ao desmontar a view, mata todos os codex workers (PTYs órfãos senão ficam
  // vivos no backend). exitCanvas já cobre o "voltar"; isto cobre os demais.
  useEffect(() => {
    return () => {
      for (const w of codexWorkersRef.current) {
        void killPty(w.ptyId).catch(() => {})
      }
    }
  }, [])

  // Recalcula as linhas SVG control plane → cards a cada mudança de layout.
  useLayoutEffect(() => {
    const recompute = () => {
      const container = containerRef.current
      const plane = planeRef.current
      if (!container || !plane) return
      const cRect = container.getBoundingClientRect()
      const pRect = plane.getBoundingClientRect()
      const x1 = pRect.left + pRect.width / 2 - cRect.left
      const y1 = pRect.bottom - cRect.top
      // Tudo que pendura do control plane: nodes (subagents/teammates) +
      // codex workers. Codex é controlado pelo control plane, então conecta
      // igual os subagents, com edge.
      const targets = [
        ...nodes.map((n) => ({ id: n.id, done: n.status === 'done' })),
        ...codexWorkers.map((w) => ({ id: w.ptyId, done: w.exitedCode !== null })),
      ]
      setEdges(
        targets.flatMap((target) => {
          const el = cardRefs.current.get(target.id)
          if (!el) return []
          const r = el.getBoundingClientRect()
          return [
            {
              id: target.id,
              x1,
              y1,
              x2: r.left + r.width / 2 - cRect.left,
              y2: r.top - cRect.top,
              done: target.done,
            },
          ]
        }),
      )
    }
    recompute()
    // rAF encadeado garante que o recompute roda após o layout estabilizar
    // (cards nascem com animação de scale → posição final só no frame seguinte).
    const raf = requestAnimationFrame(() => requestAnimationFrame(recompute))
    const observer = new ResizeObserver(recompute)
    const container = containerRef.current
    if (container) {
      observer.observe(container)
      // Observa também cada card — feed crescendo muda a altura sem mexer no
      // array de nodes, e aí os edges ficariam parados.
      cardRefs.current.forEach((el) => observer.observe(el))
      container.addEventListener('scroll', recompute, { passive: true })
    }
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      container?.removeEventListener('scroll', recompute)
    }
  }, [nodes, codexWorkers])

  const exitCanvas = () => {
    if (session) {
      console.log('[AgentCanvasPOC] saindo — matando PTY', session.ptyId)
      void killPty(session.ptyId).catch(() => {
        /* PTY pode já ter morrido */
      })
    }
    // Mata os codex workers junto — são PTYs do Alethe, não do Claude.
    for (const w of codexWorkersRef.current) {
      void killPty(w.ptyId).catch(() => {})
    }
    // Estado do canvas não sobrevive entre sessões — senão time/cards velhos
    // (até de testes headless) reaparecem na próxima pasta.
    clearStore()
    useUiStore.getState().setAgentCanvasSession(null)
    setActiveView('home')
  }

  useEffect(() => {
    window.addEventListener('alethe:agent-canvas-exit', exitCanvas)
    return () => window.removeEventListener('alethe:agent-canvas-exit', exitCanvas)
  })

  const copyTestPrompt = () => {
    void writeClipboardText(TEST_PROMPT).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }).catch(() => navigator.clipboard?.writeText(TEST_PROMPT))
  }

  const teammates = nodes.filter((n) => n.kind === 'teammate')
  const subagents = nodes.filter((n) => n.kind === 'subagent')
  const running = nodes.filter((n) => n.status === 'running').length
  const done = nodes.filter((n) => n.status === 'done').length
  const taskList = Object.values(tasks)

  const renderCard = (node: AgentNode) => (
    <div
      key={node.id}
      ref={(el) => {
        if (el) cardRefs.current.set(node.id, el)
        else cardRefs.current.delete(node.id)
      }}
      className={[
        styles.card,
        node.kind === 'teammate' ? styles.cardTeammate : '',
        node.status === 'done' ? styles.cardDone : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ ['--agent-color' as string]: colorFor(node.agentType) }}
      onClick={() => select(node.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') select(node.id)
      }}
    >
      <div className={styles.cardHeader}>
        <span className={styles.cardType}>
          {node.kind === 'teammate' ? <Users size={12} /> : null}
          {node.agentType}
        </span>
        <span className={statusBadgeClass(node.status)}>
          {node.status === 'done' ? durationLabel(node) ?? 'done' : node.status}
        </span>
      </div>
      {node.kind === 'teammate' ? (
        <div className={styles.teammateMeta}>
          {node.team} · {t('ws.turns', { count: node.turns })}
        </div>
      ) : null}
      {node.prompt ? <div className={styles.cardPrompt}>{node.prompt}</div> : null}
      {node.feed.length > 0 ? (
        <div className={styles.cardFeed}>
          {node.feed.slice(-MINI_FEED_SIZE).map((ev) => (
            <div key={ev.toolUseId} className={styles.feedRow}>
              <span className={styles.feedTool}>{ev.toolName}</span>
              <span className={styles.feedSummary}>{ev.summary}</span>
            </div>
          ))}
          {node.feed.length > MINI_FEED_SIZE ? (
            <div className={styles.feedMore}>
              {t('ws.moreToolCalls', { count: node.feed.length - MINI_FEED_SIZE })}
            </div>
          ) : null}
        </div>
      ) : null}
      {node.status !== 'running' && node.result ? (
        <div className={styles.cardPrompt}>{node.result}</div>
      ) : null}
      <div className={styles.cardId}>{node.id}</div>
    </div>
  )

  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        <div
          className={dragOver ? `${styles.canvas} ${styles.canvasDragOver}` : styles.canvas}
          ref={(el) => {
            containerRef.current = el
            setDropRef(el)
          }}
        >
          <header className={styles.topBar}>
            <button type="button" className={styles.backButton} onClick={exitCanvas}>
              <ArrowLeft size={14} />
              {t('ws.back')}
            </button>
            <span className={styles.title}>{t('ws.agentCanvasPoc')}</span>
            <div className={styles.topRight}>
              {usage ? (
                <button
                  type="button"
                  className={
                    usage.five_hour.utilization >= USAGE_FALLBACK_THRESHOLD || fallbackActive
                      ? `${styles.usagePill} ${styles.usagePillCrit}`
                      : styles.usagePill
                  }
                  title={t('ws.usagePillTitle', {
                    reset: formatReset(usage.five_hour.resets_at, t('ws.now')),
                  })}
                  onClick={() => activateFallback(usage, true)}
                >
                  {t('ws.claude5h', { pct: Math.round(usage.five_hour.utilization) })}
                </button>
              ) : null}
              <span className={styles.counter}>
                {t('ws.runningDone', { running, done })}
                {lastEventAt ? '' : ` · ${t('ws.waitingHooks', { endpoint: hooksEndpoint?.replace('http://127.0.0.1', ':') ?? '...' })}`}
              </span>
              <button
                type="button"
                className={styles.clearButton}
                onClick={() => spawnCodexWorker(t('ws.workerManual'), { open: true })}
                title={t('ws.openNewCodexTerminal')}
              >
                <Plus size={13} />
                <CodexIcon size={14} />
              </button>
              <button
                type="button"
                className={styles.clearButton}
                onClick={clearStore}
                disabled={nodes.length === 0 && taskList.length === 0}
                title={t('ws.clearCanvas')}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </header>

          <div
            className={paletteOpen ? styles.agentPalette : styles.agentPaletteCollapsed}
            style={{
              left: palettePosition.x,
              top: palettePosition.y,
            }}
          >
            {paletteOpen ? (
              <>
                <div className={styles.paletteHeader} onPointerDown={startPaletteDrag}>
                  <span className={styles.libraryTitle}>
                    <Grip size={13} /> {t('ws.library')}
                  </span>
                  <span className={styles.paletteCount}>{AGENT_LIBRARY.length}</span>
                  <button
                    type="button"
                    className={styles.chipAction}
                    onClick={() => setPaletteOpen(false)}
                    title={t('ws.collapseLibrary')}
                    aria-label={t('ws.collapseLibrary')}
                  >
                    <X size={13} />
                  </button>
                </div>
                <div className={styles.libraryHint}>{t('ws.libraryHint')}</div>
                <div className={styles.paletteGrid}>
                  {AGENT_LIBRARY.map((tpl) => (
                    <LibraryItem
                      key={tpl.name}
                      template={tpl}
                      installed={installed.some((a) => a.name === tpl.name)}
                      onInstall={() => installAgent(tpl.name)}
                    />
                  ))}
                </div>
              </>
            ) : (
              <button
                type="button"
                className={styles.paletteLauncher}
                onClick={() => setPaletteOpen(true)}
                onPointerDown={startPaletteDrag}
                title={t('ws.openAgentLibrary')}
              >
                <Library size={14} />
                {t('ws.library')}
                <span className={styles.paletteCount}>{AGENT_LIBRARY.length}</span>
              </button>
            )}
          </div>

          {fallbackActive && usage ? (
            <div className={styles.fallbackBanner}>
              <span className={styles.fallbackDot} />
              <span className={styles.fallbackText}>
                {t('ws.fallbackBanner', {
                  pct: Math.round(usage.five_hour.utilization),
                  reset: formatReset(usage.five_hour.resets_at, t('ws.now')),
                })}
              </span>
              <button
                type="button"
                className={styles.bannerButton}
                onClick={() => spawnCodexWorker(t('ws.workerFallbackManual'), { open: true })}
              >
                <Plus size={12} /> codex
              </button>
            </div>
          ) : null}

          <svg className={styles.edges}>
            {edges.map((e) => (
              <path
                key={e.id}
                d={`M ${e.x1} ${e.y1} C ${e.x1} ${e.y1 + 48}, ${e.x2} ${e.y2 - 48}, ${e.x2} ${e.y2}`}
                className={e.done ? styles.edgeDone : styles.edgeRunning}
              />
            ))}
          </svg>

          <div
            className={planeDragOver ? `${styles.plane} ${styles.planeDropTarget}` : styles.plane}
            ref={(el) => {
              planeRef.current = el
              setPlaneDropRef(el)
            }}
          >
            <Bot size={18} />
            <div>
              <div className={styles.planeTitle}>
                {teamName ? t('ws.leadTeam', { team: teamName }) : t('ws.controlPlane')}
              </div>
              <div className={styles.planeSubtitle}>
                {session ? session.folder : t('ws.claudeMainSession')}
              </div>
            </div>
            <span className={running > 0 ? styles.planeDotActive : styles.planeDot} />
          </div>

          {/* agents instalados no projeto (idle até o claude delegar) */}
          {installed.length > 0 ? (
            <div className={styles.installedRow}>
              {installed.map((agent) => (
                <AgentChip
                  key={agent.name}
                  name={agent.name}
                  installed
                  foreign={!agent.from_alethe}
                  action={
                    <button
                      type="button"
                      className={styles.chipAction}
                      title={t('ws.removeFromProject')}
                      onClick={() => uninstallAgent(agent)}
                      aria-label={t('ws.removeAgent', { name: agent.name })}
                    >
                      <X size={13} />
                    </button>
                  }
                />
              ))}
            </div>
          ) : null}

          {/* codex workers — terminais codex reais, clicar expande */}
          {codexWorkers.length > 0 ? (
            <div className={styles.codexRow}>
              {codexWorkers.map((w) => (
                <div
                  key={w.ptyId}
                  ref={(el) => {
                    if (el) cardRefs.current.set(w.ptyId, el)
                    else cardRefs.current.delete(w.ptyId)
                  }}
                  className={styles.codexCard}
                  role="button"
                  tabIndex={0}
                  onClick={() => setExpandedCodexId(w.ptyId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') setExpandedCodexId(w.ptyId)
                  }}
                >
                  <div className={styles.cardHeader}>
                    <span className={styles.codexType}>
                      <CodexIcon size={15} /> codex
                    </span>
                    <span
                      className={w.exitedCode !== null ? styles.statusDone : styles.statusRunning}
                    >
                      {w.exitedCode !== null ? `exit ${w.exitedCode}` : 'running'}
                    </span>
                  </div>
                  <div className={styles.cardPrompt}>{w.title}</div>
                  <div className={styles.codexCardFooter}>
                    <span className={styles.cardId}>{w.ptyId}</span>
                    <span className={styles.codexExpandHint}>
                      <Maximize2 size={11} /> {t('ws.openTerminal')}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {teammates.length > 0 ? (
            <div className={styles.teammatesArea}>{teammates.map(renderCard)}</div>
          ) : null}

          <div className={styles.cardsArea}>
            {nodes.length === 0 ? (
              <div className={styles.empty}>
                <div>{t('ws.noSubagentYet')}</div>
                <div className={styles.testPrompt}>
                  <code>{TEST_PROMPT}</code>
                  <button type="button" className={styles.clearButton} onClick={copyTestPrompt}>
                    <ClipboardCopy size={13} />
                    {copied ? t('ws.copied') : t('ws.copy')}
                  </button>
                </div>
              </div>
            ) : (
              subagents.map(renderCard)
            )}
          </div>
        </div>

        {/* painel de tasks do time */}
        {taskList.length > 0 ? (
          <aside className={styles.tasksPanel}>
            <div className={styles.libraryTitle}>
              <ListTodo size={13} /> tasks {teamName ? `· ${teamName}` : ''}
            </div>
            {taskList.map((task) => (
              <div key={task.id} className={styles.taskRow}>
                <span
                  className={
                    task.status === 'completed'
                      ? styles.taskDotDone
                      : task.status === 'in_progress'
                        ? styles.taskDotActive
                        : styles.taskDot
                  }
                />
                <div className={styles.taskBody}>
                  <div className={styles.taskSubject}>{task.subject}</div>
                  <div className={styles.taskMeta}>
                    #{task.id}
                    {task.owner ? ` · ${task.owner}` : ''} · {task.status}
                  </div>
                </div>
              </div>
            ))}
          </aside>
        ) : null}
      </div>

      {session ? (
        <div className={styles.terminalDock}>
          <div className={styles.terminalHeader}>
            <span className={styles.terminalLabel}>
              claude --dangerously-skip-permissions · teams on
            </span>
            <span className={styles.terminalCwd}>{session.folder}</span>
            {restartHint ? (
              <span className={styles.economyHint}>{t('ws.agentsChangedRestart')}</span>
            ) : null}
            {claudeExited !== null ? (
              <span className={styles.terminalExited}>{t('ws.exitedCode', { code: claudeExited })}</span>
            ) : null}
            <button
              type="button"
              className={economyOn ? `${styles.clearButton} ${styles.economyOn}` : styles.clearButton}
              onClick={toggleEconomy}
              title={t('ws.economyModeTitle')}
            >
              <PiggyBank size={14} />
              {t('ws.economy')} {economyOn ? t('ws.on') : t('ws.off')}
            </button>
            <button
              type="button"
              className={styles.clearButton}
              onClick={restartClaude}
              title={t('ws.restartClaudeTitle')}
            >
              <RotateCcw size={14} />
            </button>
          </div>
          <div className={styles.terminalHost}>
            {hooksSettingsPath && hooksEndpoint ? (
              <XTermView
                ptyId={session.ptyId}
                command="claude"
                cwd={session.folder}
                extraArgs={[
                  '--dangerously-skip-permissions',
                  '--settings',
                  hooksSettingsPath,
                  '--append-system-prompt',
                  orchestrationRules(hooksEndpoint),
                ]}
                env={PTY_ENV}
                terminalTheme={terminalTheme}
                onSpawned={(id) => console.log('[AgentCanvasPOC] claude spawnado, pty:', id)}
                onExit={(code) => {
                  console.log('[AgentCanvasPOC] claude saiu, code:', code)
                  setClaudeExited(code)
                }}
              />
            ) : (
              <div className={styles.empty}>{t('ws.generatingHooksSettings')}</div>
            )}
          </div>
        </div>
      ) : null}

      {/* terminal codex completo (expandido). Colapsar desmonta o XTermView
          mas o PTY segue vivo no backend — reabrir re-attacha o scrollback. */}
      {(() => {
        const w = codexWorkers.find((x) => x.ptyId === expandedCodexId)
        if (!w) return null
        return (
          <div className={styles.codexOverlay} onClick={() => setExpandedCodexId(null)}>
            <div className={styles.codexModal} onClick={(e) => e.stopPropagation()}>
              <div className={styles.terminalHeader}>
                <span className={styles.codexType}>
                  <CodexIcon size={16} /> {t('ws.codexWorker')}
                </span>
                <span className={styles.terminalCwd}>{w.title}</span>
                {w.exitedCode !== null ? (
                  <span className={styles.terminalExited}>{t('ws.exitedCode', { code: w.exitedCode })}</span>
                ) : null}
                <button
                  type="button"
                  className={styles.clearButton}
                  onClick={() => killCodexWorker(w.ptyId)}
                  title={t('ws.killCodexWorker')}
                >
                  <Trash2 size={14} />
                </button>
                <button
                  type="button"
                  className={styles.clearButton}
                  onClick={() => setExpandedCodexId(null)}
                  title={t('ws.closeKeepCodexRunning')}
                >
                  <X size={14} />
                </button>
              </div>
              <div className={styles.terminalHost}>
                <XTermView
                  ptyId={w.ptyId}
                  command="codex"
                  cwd={w.cwd}
                  extraArgs={w.args}
                  terminalTheme={terminalTheme}
                  onSpawned={(id) => console.log('[AgentCanvasPOC] codex worker spawnado, pty:', id)}
                  onExit={(code) => {
                    console.log('[AgentCanvasPOC] codex worker saiu, code:', code)
                    setCodexWorkers((prev) =>
                      prev.map((x) => (x.ptyId === w.ptyId ? { ...x, exitedCode: code } : x)),
                    )
                  }}
                />
              </div>
            </div>
          </div>
        )
      })()}

      <AgentModal />
    </div>
  )
}

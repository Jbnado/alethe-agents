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
  Coins,
  Frame,
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
  Wallet,
  X,
  ZoomIn,
  ZoomOut,
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
import { getCachedCodexUsage } from '../../lib/codexUsageCache'
import { costLevel, fmtTokens, fmtUsd, shortModel } from '../../lib/costFormat'
import { useT } from '../../lib/i18n'
import {
  attachPty,
  getModelPricing,
  killPty,
  listenPtyExit,
  spawnPty,
  writeClipboardText,
  writePty,
  type ClaudeUsage,
  type CodexUsage,
  type ModelRate,
  type SessionCost,
} from '../../lib/tauri'
import { useAgentCostStore } from '../../stores/agentCostStore'
import {
  useAgentCanvasStore,
  type AgentHookPayload,
  type AgentNode,
} from '../../stores/agentCanvasStore'
import { useNodeCostStore, selectNodeCostTotals } from '../../stores/nodeCostStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import type { AgentType } from '../../lib/types'
import { AgentIcon, CodexIcon } from '../icons/AgentIcons'
import { XTermView } from '../XTermView'
import { AgentModal } from './AgentModal'
import { UsageDropdown, type UsageTab } from './UsageDropdown'
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
/** De quanto em quanto tempo o canvas relê o custo dos nós + do lead. */
const COST_POLL_MS = 4_000

/** Limites de zoom do stage (árvore de agentes). */
const ZOOM_MIN = 0.4
const ZOOM_MAX = 1.4
const ZOOM_STEP = 0.1

/**
 * Teto de workers REAIS vivos ao mesmo tempo. Cada worker é um processo pesado
 * (um `claude -p` come ~400 MB; codex é bem mais leve) — sem teto, um lead
 * autônomo spawna dezenas e estoura a RAM até o app cair. Spawns acima disso
 * são recusados; o lead deve preferir subagents in-process.
 */
const MAX_LIVE_WORKERS = 3

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
function orchestrationRules(agentEndpoint: string, budgetUsd?: number | null) {
  const budget =
    budgetUsd && budgetUsd > 0
      ? ` Budget ceiling for this session is about ${budgetUsd} US dollars; prefer cheap routing and pause to ask the user before exceeding it.`
      : ''
  return (
  'You are the autonomous control plane and brain of an Alethe agent canvas session. The user gives you a high level goal in this terminal and you drive it to done by distributing the work across AIs, watching their results, and deciding each next action yourself. Work autonomously but with checkpoints. Rules: ' +
  '(1) For a small task just do it solo; spawning agents has overhead. ' +
  '(2) For a large goal such as building a feature or a small app, FIRST consult the orchestrator agent if it exists (Agent tool, subagent_type orchestrator) to get a plan: parallel streams for front, back, qa and docs, plus a task list with dependencies and a suggested agent per task; if no orchestrator agent is available, draft that plan yourself. Present the plan to the user and wait for approval before executing. ' +
  '(3) After approval, create a SMALL agent team (2 to 4 teammates, never more) and give each teammate distinct file paths so two never edit the same file; put full context in each spawn prompt; break the work into tasks with dependencies; then coordinate and wait for your teammates instead of implementing everything yourself. ' +
  '(4) Route by cost: if cheap workers exist in .claude/agents, use haiku-resumidor for bulk reading and summarizing, haiku-mecanico for well specified mechanical edits, codex-executor for long noisy execution; keep architecture and ambiguous work on capable models; never route ambiguous work to cheap workers; prefer offloading to a codex worker when Claude usage is high. ' +
  '(5) Checkpoints: pause and ask the user at big milestones such as the end of an epic, before destructive or irreversible steps, and whenever spending approaches the budget ceiling; never exceed the ceiling without asking. Integrate the streams and run qa before declaring done. ' +
  `(6) Real workers are EXPENSIVE: each spawn is a full separate process using hundreds of megabytes of RAM, so prefer in-process subagents and teammates for almost everything, spawn AT MOST two real workers at a time, reuse them instead of respawning, and prefer a codex worker over a claude worker because codex is far lighter. To spawn one, POST JSON to ${agentEndpoint}/spawn with body {agent, task, mode}: agent is claude, codex or opencode; task is one self contained English instruction; mode is exec for one shot fire and forget or interactive. Use curl -s -X POST with the -d flag and single quoted JSON. It is fire and forget: you do not get the output back, so use it only for offloadable work, not results you must read.` +
  budget
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
 * Agent worker = um PTY REAL (claude/codex/opencode) rodando na pasta da sessão,
 * gerenciado pelo Alethe (≠ do subagent in-process do Claude). Tem card próprio
 * no canvas e abre o terminal completo quando expandido. O PTY é spawnado pelo
 * XTermView na 1ª montagem e sobrevive ao colapso (desmontar não mata; só
 * killPty mata) — reabrir re-attacha o scrollback. Despachado pelo control plane
 * via POST /spawn (ou /codex legado).
 */
type CodexWorker = {
  ptyId: string
  /** Agente do processo (claude | codex | opencode). */
  agent: AgentType
  /** Tarefa/origem do worker (ex.: "fallback de usage"). */
  title: string
  cwd: string
  startedAt: number
  exitedCode: number | null
  /** extraArgs one-shot do agente; undefined no modo interativo. */
  args?: string[]
  /** Resumo (cauda do scrollback) do que o worker terminou — fecha o loop fire-and-forget. */
  result?: string
}

/**
 * Cauda limpa do scrollback de um worker, pra resumir o resultado no card.
 * Tira sequências ANSI/OSC e bytes de controle, colapsa espaços e pega o fim.
 */
function tailSummary(raw: string, max = 320): string {
  const clean = raw
    // CSI: ESC [ ... letra final
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    // OSC: ESC ] ... (BEL ou ESC backslash)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // outros escapes ESC de 1 char
    .replace(/\x1b[@-Z\\-_]/g, '')
    // bytes de controle restantes (preserva \n e \t)
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
  return clean.length > max ? `…${clean.slice(-max)}` : clean
}

/** Monta os extraArgs one-shot por agente pra rodar uma task sem depender da TUI. */
function execArgsFor(agent: AgentType, task: string): string[] | undefined {
  switch (agent) {
    case 'codex':
      return ['exec', '--skip-git-repo-check', task]
    case 'claude':
      // headless: -p roda a task e sai; sem permissões pra não travar no prompt.
      return ['-p', task, '--dangerously-skip-permissions']
    case 'opencode':
      return ['run', task]
    default:
      return undefined
  }
}

function statusBadgeClass(status: AgentNode['status']): string {
  if (status === 'running') return styles.statusRunning
  if (status === 'idle') return styles.statusIdle
  return styles.statusDone
}

/** Faixa de gasto (USD) → classe de cor do canvas (tokens do tema). */
function costClassFor(usd: number): string {
  const level = costLevel(usd)
  if (level === 'high') return styles.costHigh
  if (level === 'mid') return styles.costMid
  return styles.costLow
}

/** Ordem de custo das famílias — pra saber quando um nó foi mais barato que o lead. */
const FAMILY_RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3 }

/** Custo hipotético de um nó se tivesse rodado num modelo (rate) diferente. */
function costAtRate(c: SessionCost, rate: ModelRate): number {
  return (
    (c.input * rate.input +
      c.output * rate.output +
      c.cache_read * rate.cache_read +
      c.cache_write_5m * rate.cache_write_5m +
      c.cache_write_1h * rate.cache_write_1h) /
    1_000_000
  )
}

/**
 * Economia estimada (USD) por ter roteado nós pra modelos mais baratos que o
 * lead: para cada nó com custo conhecido e família mais barata, soma
 * (custo no modelo do lead − custo real). Estimativa honesta, baseada em tokens
 * reais — não conta nós sem preço (codex) nem os no mesmo nível do lead.
 */
function estimateRoutingSavings(
  nodeCosts: Record<string, SessionCost>,
  leadModel: string | null,
  pricing: ModelRate[],
): number {
  const leadFamily = shortModel(leadModel)
  if (!leadFamily) return 0
  const leadRate = pricing.find((r) => r.family === leadFamily) ?? null
  const leadRank = FAMILY_RANK[leadFamily] ?? 0
  if (!leadRate || leadRank === 0) return 0
  let saved = 0
  for (const c of Object.values(nodeCosts)) {
    if (c.cost_usd == null) continue
    const fam = shortModel(c.model)
    const rank = fam ? (FAMILY_RANK[fam] ?? 0) : 0
    if (rank === 0 || rank >= leadRank) continue
    const delta = costAtRate(c, leadRate) - c.cost_usd
    if (delta > 0) saved += delta
  }
  return saved
}

function personaIconFor(agentName: string): LucideIcon {
  const name = agentName.toLowerCase()
  if (name.includes('orchestr') || name.includes('tech-lead')) return LayoutTemplate
  if (name.includes('frontend')) return Paintbrush
  if (name.includes('backend')) return Server
  if (name.includes('qa') || name.includes('review')) return ShieldCheck
  if (name.includes('docs') || name.includes('writer')) return PenLine
  if (name.includes('codex') || name.includes('executor')) return TerminalSquare
  if (name.includes('plan')) return LayoutTemplate
  return Bot
}

/**
 * Time-base que o cérebro precisa na pasta pra orquestrar de verdade: o planner
 * (orchestrator) + os papéis front/back/qa/docs. Auto-instalados ao abrir a
 * sessão (best-effort; nunca sobrescreve agent externo de mesmo nome).
 */
const CORE_AGENTS = ['orchestrator', 'frontend-dev', 'backend-dev', 'qa-reviewer', 'docs-writer']

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
  const uiTheme = useProjectsStore((s) => s.preferences.uiTheme)
  const nodes = useAgentCanvasStore((s) => s.nodes)
  const tasks = useAgentCanvasStore((s) => s.tasks)
  const teamName = useAgentCanvasStore((s) => s.teamName)
  const lastEventAt = useAgentCanvasStore((s) => s.lastEventAt)
  const select = useAgentCanvasStore((s) => s.select)
  const clearStore = useAgentCanvasStore((s) => s.clear)

  // Custo por nó (subagents/teammates) + custo do lead (sessão viva no agentCost).
  const nodeCosts = useNodeCostStore((s) => s.byNodeId)
  const leadCost = useAgentCostStore((s) =>
    session ? (s.byPtyId[session.ptyId]?.cost ?? null) : null,
  )
  const budgetUsd = useUiStore((s) => s.agentCanvasBudgetUsd)
  const setBudget = useUiStore((s) => s.setAgentCanvasBudget)
  const [pricing, setPricing] = useState<ModelRate[]>([])

  const [edges, setEdges] = useState<Edge[]>([])
  const [hooksSettingsPath, setHooksSettingsPath] = useState<string | null>(null)
  const [hooksEndpoint, setHooksEndpoint] = useState<string | null>(null)
  const [claudeExited, setClaudeExited] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const [economyOn, setEconomyOn] = useState(false)
  const [restartHint, setRestartHint] = useState(false)
  const [installed, setInstalled] = useState<InstalledAgent[]>([])
  const [coreAgentsReady, setCoreAgentsReady] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [panning, setPanning] = useState(false)
  // Origem do arrasto de pan: posição do mouse + pan no início do gesto.
  const panStartRef = useRef<{ mx: number; my: number; px: number; py: number } | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [palettePosition, setPalettePosition] = useState({ x: 16, y: 58 })

  // Codex workers + fallback de usage (terminais codex de verdade).
  const [codexWorkers, setCodexWorkers] = useState<CodexWorker[]>([])
  const [expandedCodexId, setExpandedCodexId] = useState<string | null>(null)
  const [usage, setUsage] = useState<ClaudeUsage | null>(null)
  const [codexUsage, setCodexUsage] = useState<CodexUsage | null>(null)
  const [usageOpen, setUsageOpen] = useState(false)
  const [usageTab, setUsageTab] = useState<UsageTab>('claude')
  const [fallbackActive, setFallbackActive] = useState(false)
  const fallbackActiveRef = useRef(false)
  const leadNotifiedRef = useRef(false)
  // Refs pra cleanup matar PTYs sem virar dependência dos effects.
  const codexWorkersRef = useRef<CodexWorker[]>([])
  const workerExitUnlistenersRef = useRef(new Map<string, () => void>())
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
  const stageRef = useRef<HTMLDivElement | null>(null)
  const usageAnchorRef = useRef<HTMLDivElement | null>(null)
  const planeRef = useRef<HTMLDivElement | null>(null)
  const cardRefs = useRef(new Map<string, HTMLDivElement>())
  const taskRefs = useRef(new Map<string, HTMLDivElement>())

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

  // Cria um worker REAL de um agente (claude/codex/opencode). O PTY sobe JÁ em
  // background (sem abrir o terminal); o usuário abre quando quiser (opts.open).
  // Se opts.task vier, roda one-shot via execArgsFor (determinístico, não depende
  // da TUI); senão, agente interativo pro usuário mexer.
  const spawnAgentWorker = useCallback(
    (
      agent: AgentType,
      title: string,
      opts: { open?: boolean; task?: string } = {},
    ): string | null => {
      const folder = sessionRef.current?.folder
      if (!folder) return null
      const ptyId = `${agent}-worker-${Date.now()}`
      const args = opts.task ? execArgsFor(agent, opts.task) : undefined
      console.log('[AgentCanvasPOC] criando worker', agent, ptyId, '· task=', !!opts.task, '·', title)
      setCodexWorkers((prev) => [
        ...prev,
        { ptyId, agent, title, cwd: folder, startedAt: Date.now(), exitedCode: null, args },
      ])
      void spawnPty({ cols: 120, rows: 30, id: ptyId, command: agent, cwd: folder, extraArgs: args })
        .then(() => {
          // Captura o término mesmo com o terminal fechado — senão o card de um
          // one-shot ficaria "running" pra sempre.
          let unlistenExit: (() => void) | null = null
          void listenPtyExit(ptyId, (code) => {
            unlistenExit?.()
            workerExitUnlistenersRef.current.delete(ptyId)
            console.log('[AgentCanvasPOC] worker', ptyId, 'saiu, code', code)
            setCodexWorkers((prev) =>
              prev.map((w) => (w.ptyId === ptyId ? { ...w, exitedCode: code ?? 0 } : w)),
            )
            // Fecha o loop fire-and-forget: puxa a cauda do scrollback como
            // resumo do que o worker terminou fazendo, pra aparecer no card.
            void attachPty(ptyId)
              .then((scrollback) => {
                const result = tailSummary(scrollback)
                if (!result) return
                setCodexWorkers((prev) =>
                  prev.map((w) => (w.ptyId === ptyId ? { ...w, result } : w)),
                )
              })
              .catch(() => {})
          }).then((unlisten) => {
            unlistenExit = unlisten
            workerExitUnlistenersRef.current.set(ptyId, unlisten)
          }).catch(() => {})
        })
        .catch((err) => console.error('[AgentCanvasPOC] falha spawnando PTY do worker:', err))
      if (opts.open) setExpandedCodexId(ptyId)
      return ptyId
    },
    [],
  )

  // Atalho legado pros botões manuais (worker codex interativo).
  const spawnCodexWorker = useCallback(
    (title: string, opts: { open?: boolean; task?: string } = {}): string | null =>
      spawnAgentWorker('codex', title, opts),
    [spawnAgentWorker],
  )

  const killCodexWorker = useCallback((ptyId: string) => {
    console.log('[AgentCanvasPOC] matando worker', ptyId)
    workerExitUnlistenersRef.current.get(ptyId)?.()
    workerExitUnlistenersRef.current.delete(ptyId)
    void killPty(ptyId).catch(() => {})
    setCodexWorkers((prev) => prev.filter((w) => w.ptyId !== ptyId))
    setExpandedCodexId((cur) => (cur === ptyId ? null : cur))
  }, [])

  // Ponte de dispatch: o control plane spawna um processo real via POST /spawn
  // (ou /codex legado). Cada despacho = um card. O usuário abre pra acompanhar;
  // o worker sai quando termina (card vira "exit N").
  const dispatchToAgent = useCallback(
    (payload: { agent?: string; task?: string; mode?: string }) => {
      const agent = payload.agent as AgentType | undefined
      if (agent !== 'claude' && agent !== 'codex' && agent !== 'opencode') return
      const rawTask = payload.task ?? ''
      // A task vira arg via PowerShell -> *.cmd (batch). Aspas duplas e newlines
      // quebram o batch — então sanitiza: aspas duplas viram simples (o
      // command_builder escapa simples com segurança) e newlines viram espaço.
      const safe = rawTask.replace(/"/g, "'").replace(/\s*[\r\n]+\s*/g, ' ').trim()
      const interactive = payload.mode === 'interactive' || !safe
      // Teto de workers vivos: cada um é um processo pesado. Acima disso, recusa
      // (lê do ref pra não pegar contagem velha do closure) — evita a IA estourar
      // a RAM spawnando dezenas de claude/codex.
      const liveWorkers = codexWorkersRef.current.filter((w) => w.exitedCode === null).length
      if (liveWorkers >= MAX_LIVE_WORKERS) {
        console.warn('[AgentCanvasPOC] teto de workers vivos atingido, recusando spawn:', agent)
        useUiStore.getState().pushToast({
          title: t('ws.workerCapTitle'),
          body: t('ws.workerCapBody', { max: MAX_LIVE_WORKERS }),
        })
        return
      }
      console.log('[AgentCanvasPOC] dispatch', agent, interactive ? '(interativo)' : safe.slice(0, 80))
      const title = safe ? (safe.length > 60 ? `${safe.slice(0, 60)}…` : safe) : agent
      spawnAgentWorker(agent, title, interactive ? { open: true } : { task: safe })
    },
    [spawnAgentWorker, t],
  )

  useEffect(() => {
    const unlistenPromise = listen('agent-spawn', (event) => {
      const payload = event.payload as { agent?: string; task?: string; mode?: string }
      console.log('[AgentCanvasPOC] agent-spawn:', payload?.agent, String(payload?.task ?? '').slice(0, 60))
      dispatchToAgent(payload)
    })
    return () => {
      void unlistenPromise.then((u) => u())
    }
  }, [dispatchToAgent])

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

  // Tabela de preço (uma vez) pra estimar a economia por roteamento.
  useEffect(() => {
    getModelPricing()
      .then(setPricing)
      .catch(() => {})
  }, [])

  // Estado inicial: modo economia + agents instalados na pasta.
  useEffect(() => {
    if (!session) return
    invoke<boolean>('economy_agents_enabled', { folder: session.folder })
      .then(setEconomyOn)
      .catch(() => {})
    refreshInstalled()
  }, [session, refreshInstalled])

  // Auto-instala o time-base (CORE_AGENTS) ANTES de spawnar o lead, pra ele já
  // poder consultar o orchestrator e delegar pra front/back/qa/docs. Best-effort:
  // conflito com agent externo de mesmo nome é ignorado (allSettled). A sessão do
  // lead só monta quando isto termina (coreAgentsReady), senão nasceria sem time.
  useEffect(() => {
    if (!session) return
    setCoreAgentsReady(false)
    const folder = session.folder
    void Promise.allSettled(
      CORE_AGENTS.map((name) => {
        const tpl = AGENT_LIBRARY.find((a) => a.name === name)
        if (!tpl) return Promise.resolve(null)
        return invoke('install_agent', {
          folder,
          name: tpl.name,
          content: tpl.content,
          force: false,
        })
      }),
    ).then(() => {
      console.log('[AgentCanvasPOC] core agents garantidos na pasta')
      setCoreAgentsReady(true)
      refreshInstalled()
    })
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
      // Codex em separado (pode não estar logado — não derruba o do Claude).
      try {
        const cu = await getCachedCodexUsage()
        if (!cancelled) setCodexUsage(cu)
      } catch {
        if (!cancelled) setCodexUsage(null)
      }
    }

    void check()
    const timer = window.setInterval(check, USAGE_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [session, activateFallback])

  // Fecha o dropdown de uso ao clicar fora ou apertar Esc.
  useEffect(() => {
    if (!usageOpen) return
    const onDown = (e: PointerEvent) => {
      if (usageAnchorRef.current && !usageAnchorRef.current.contains(e.target as Node)) {
        setUsageOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUsageOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [usageOpen])

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
        workerExitUnlistenersRef.current.get(w.ptyId)?.()
        void killPty(w.ptyId).catch(() => {})
      }
      workerExitUnlistenersRef.current.clear()
    }
  }, [])

  // Recalcula as linhas SVG control plane → cards a cada mudança de layout.
  useLayoutEffect(() => {
    const recompute = () => {
      const container = containerRef.current
      const plane = planeRef.current
      const stage = stageRef.current
      if (!container || !plane || !stage) return
      // Coordenadas relativas ao STAGE (não ao viewport): o svg vive DENTRO do
      // stage e escala junto, então as arestas ficam coladas nos cards em
      // qualquer zoom/scroll. Divide por zoom pra voltar ao espaço não-escalado.
      const sRect = stage.getBoundingClientRect()
      const k = zoom || 1
      const pRect = plane.getBoundingClientRect()
      const x1 = (pRect.left + pRect.width / 2 - sRect.left) / k
      const y1 = (pRect.bottom - sRect.top) / k
      // Árvore: o lead ramifica em teammates, workers e UMA área por tipo de
      // subagent (frontend-dev, backend-dev, …). Uma aresta por ramo (grupo),
      // não por card — assim cresce pra baixo sem virar uma teia.
      const subs = nodes.filter((n) => n.kind === 'subagent')
      const groupTypes = [...new Set(subs.map((n) => n.agentType))]
      const targets = [
        ...nodes
          .filter((n) => n.kind === 'teammate')
          .map((n) => ({ id: n.id, done: n.status === 'done' })),
        ...codexWorkers.map((w) => ({ id: w.ptyId, done: w.exitedCode !== null })),
        ...groupTypes.map((type) => ({
          id: `group:${type}`,
          done: !subs.some((n) => n.agentType === type && n.status === 'running'),
        })),
      ]
      // Camada 1: lead → cada teammate/worker/ramo.
      const nodeEdges: Edge[] = targets.flatMap((target) => {
        const el = cardRefs.current.get(target.id)
        if (!el) return []
        const r = el.getBoundingClientRect()
        return [
          {
            id: target.id,
            x1,
            y1,
            x2: (r.left + r.width / 2 - sRect.left) / k,
            y2: (r.top - sRect.top) / k,
            done: target.done,
          },
        ]
      })
      // Camada 2 (DAG): cada task pendura do teammate dono (se existir card dele),
      // senão do lead. É a leitura visual de "distribuiu e está acompanhando".
      const taskEdges: Edge[] = Object.values(tasks).flatMap((task) => {
        const taskEl = taskRefs.current.get(task.id)
        if (!taskEl) return []
        const tr = taskEl.getBoundingClientRect()
        const ownerEl = task.owner ? cardRefs.current.get(`teammate:${task.owner}`) : null
        const srcRect = ownerEl ? ownerEl.getBoundingClientRect() : pRect
        return [
          {
            id: `task:${task.id}`,
            x1: (srcRect.left + srcRect.width / 2 - sRect.left) / k,
            y1: (srcRect.bottom - sRect.top) / k,
            x2: (tr.left + tr.width / 2 - sRect.left) / k,
            y2: (tr.top - sRect.top) / k,
            done: task.status === 'completed',
          },
        ]
      })
      setEdges([...nodeEdges, ...taskEdges])
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
      taskRefs.current.forEach((el) => observer.observe(el))
      container.addEventListener('scroll', recompute, { passive: true })
    }
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      container?.removeEventListener('scroll', recompute)
    }
  }, [nodes, codexWorkers, tasks, zoom])

  // Poll de custo: relê o custo de cada nó (pelo transcript) e o do lead (sessão
  // viva no agentCostStore). Ambos refresh() são adaptativos — pulam sozinhos
  // quando não há o que ler. Lê os nodes direto do store pra não re-assinar o
  // effect a cada mudança de feed.
  useEffect(() => {
    if (!session) return
    const tick = () => {
      void useNodeCostStore.getState().refresh(useAgentCanvasStore.getState().nodes)
      void useAgentCostStore.getState().refresh()
    }
    tick()
    const timer = window.setInterval(tick, COST_POLL_MS)
    return () => window.clearInterval(timer)
  }, [session])

  const exitCanvas = () => {
    if (session) {
      console.log('[AgentCanvasPOC] saindo — matando PTY', session.ptyId)
      void killPty(session.ptyId).catch(() => {
        /* PTY pode já ter morrido */
      })
    }
    // Mata os codex workers junto — são PTYs do Alethe, não do Claude.
    for (const w of codexWorkersRef.current) {
      workerExitUnlistenersRef.current.get(w.ptyId)?.()
      void killPty(w.ptyId).catch(() => {})
    }
    workerExitUnlistenersRef.current.clear()
    // Estado do canvas não sobrevive entre sessões — senão time/cards velhos
    // (até de testes headless) reaparecem na próxima pasta.
    clearStore()
    useNodeCostStore.getState().clear()
    useUiStore.getState().setAgentCanvasBudget(null)
    useUiStore.getState().setAgentCanvasSession(null)
    setActiveView('home')
  }

  useEffect(() => {
    window.addEventListener('alethe:agent-canvas-exit', exitCanvas)
    return () => window.removeEventListener('alethe:agent-canvas-exit', exitCanvas)
  })

  const clearCanvas = () => {
    // Mata os workers reais (PTYs claude/codex = processos pesados) — assim o
    // botão de limpar também é o "parar tudo / liberar RAM".
    for (const w of codexWorkersRef.current) {
      workerExitUnlistenersRef.current.get(w.ptyId)?.()
      void killPty(w.ptyId).catch(() => {})
    }
    workerExitUnlistenersRef.current.clear()
    setCodexWorkers([])
    setExpandedCodexId(null)
    clearStore()
    useNodeCostStore.getState().clear()
  }

  const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100))
  const zoomBy = (delta: number) => setZoom((z) => clampZoom(z + delta))
  // Ajusta o zoom pra árvore inteira caber na área visível e recentra (pan 0).
  const fitZoom = () => {
    const container = containerRef.current
    const stage = stageRef.current
    if (!container || !stage) return
    const naturalH = stage.scrollHeight
    const naturalW = stage.scrollWidth
    if (!naturalH || !naturalW) return
    const availH = container.clientHeight - 16
    const availW = container.clientWidth - 16
    setPan({ x: 0, y: 0 })
    setZoom(clampZoom(Math.min(1, availH / naturalH, availW / naturalW)))
  }

  // Zoom com a roda do mouse (canvas de verdade). Listener nativo non-passive
  // porque o onWheel do React é passive e não deixa dar preventDefault.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Pan: arrasta o fundo vazio do canvas (ou botão do meio) pra mover a árvore.
  const onCanvasPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return
    const target = e.target as HTMLElement
    // Botão esquerdo só inicia pan no fundo (não em card/botão/input/terminal).
    if (
      e.button === 0 &&
      target.closest(
        'button, input, textarea, select, a, [role="button"], [class*="terminal"], [data-no-pan]',
      )
    ) {
      return
    }
    panStartRef.current = { mx: e.clientX, my: e.clientY, px: pan.x, py: pan.y }
    setPanning(true)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* ok */
    }
  }
  const onCanvasPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = panStartRef.current
    if (!start) return
    setPan({ x: start.px + (e.clientX - start.mx), y: start.py + (e.clientY - start.my) })
  }
  const endPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!panStartRef.current) return
    panStartRef.current = null
    setPanning(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ok */
    }
  }

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

  // Agrupa subagents por tipo (frontend-dev, backend-dev, …) — cada tipo vira
  // uma área/ramo, e os cards empilham pra baixo dentro dela (árvore).
  const subagentGroups: Array<[string, AgentNode[]]> = (() => {
    const map = new Map<string, AgentNode[]>()
    for (const n of subagents) {
      const arr = map.get(n.agentType)
      if (arr) arr.push(n)
      else map.set(n.agentType, [n])
    }
    return [...map]
  })()

  // Custo da sessão = lead (sessão viva) + soma dos nós (subagents/teammates).
  const nodeTotals = selectNodeCostTotals(nodeCosts)
  const sessionCostUsd = nodeTotals.costUsd + (leadCost?.cost_usd ?? 0)
  const sessionTokens = nodeTotals.totalTokens + (leadCost?.total_tokens ?? 0)
  const hasCost = sessionTokens > 0

  // Economia estimada por rotear nós pra modelos mais baratos que o lead.
  const routingSavings = estimateRoutingSavings(nodeCosts, leadCost?.model ?? null, pricing)

  // Teto de orçamento: alerta em 80% (aviso) e 100% (crítico).
  const budgetRatio = budgetUsd && budgetUsd > 0 ? sessionCostUsd / budgetUsd : 0
  const budgetWarn = budgetUsd != null && budgetUsd > 0 && budgetRatio >= 0.8
  const budgetCrit = budgetUsd != null && budgetUsd > 0 && sessionCostUsd >= budgetUsd

  const renderCard = (node: AgentNode) => {
    const cost = nodeCosts[node.id]
    const model = cost ? shortModel(cost.model) : null
    return (
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
      {cost ? (
        <div className={styles.cardCost}>
          {model ? <span className={styles.cardCostModel}>{model}</span> : null}
          <span className={styles.cardCostTokens}>
            {fmtTokens(cost.total_tokens)} {t('ws.tokens')}
          </span>
          {cost.cost_usd != null ? (
            <span className={`${styles.cardCostUsd} ${costClassFor(cost.cost_usd)}`}>
              {fmtUsd(cost.cost_usd)}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className={styles.cardId}>{node.id}</div>
    </div>
    )
  }

  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        <div
          className={[
            styles.canvas,
            dragOver ? styles.canvasDragOver : '',
            panning ? styles.canvasPanning : '',
          ]
            .filter(Boolean)
            .join(' ')}
          ref={(el) => {
            containerRef.current = el
            setDropRef(el)
          }}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
        >
          <header className={styles.topBar}>
            <button type="button" className={styles.backButton} onClick={exitCanvas}>
              <ArrowLeft size={14} />
              {t('ws.back')}
            </button>
            <span className={styles.title}>{t('ws.agentCanvasPoc')}</span>
            <div className={styles.topRight}>
              <div className={styles.zoomControls}>
                <button
                  type="button"
                  className={styles.clearButton}
                  onClick={() => zoomBy(-ZOOM_STEP)}
                  disabled={zoom <= ZOOM_MIN}
                  title={t('ws.zoomOut')}
                >
                  <ZoomOut size={14} />
                </button>
                <span className={styles.zoomLabel}>{Math.round(zoom * 100)}%</span>
                <button
                  type="button"
                  className={styles.clearButton}
                  onClick={() => zoomBy(ZOOM_STEP)}
                  disabled={zoom >= ZOOM_MAX}
                  title={t('ws.zoomIn')}
                >
                  <ZoomIn size={14} />
                </button>
                <button
                  type="button"
                  className={styles.clearButton}
                  onClick={fitZoom}
                  title={t('ws.zoomFit')}
                >
                  <Frame size={14} />
                </button>
              </div>
              {usage || codexUsage ? (
                <div className={styles.usageAnchor} data-no-pan ref={usageAnchorRef}>
                  <button
                    type="button"
                    className={
                      (usage && usage.five_hour.utilization >= USAGE_FALLBACK_THRESHOLD) ||
                      fallbackActive
                        ? `${styles.usagePill} ${styles.usagePillCrit}`
                        : styles.usagePill
                    }
                    title={t('ws.usagePanelOpen')}
                    onClick={() => setUsageOpen((o) => !o)}
                    aria-expanded={usageOpen}
                  >
                    {usage
                      ? t('ws.claude5h', { pct: Math.round(usage.five_hour.utilization) })
                      : t('ws.codex5h', { pct: Math.round(codexUsage!.primary.used_percent) })}
                  </button>
                  {usageOpen ? (
                    <UsageDropdown
                      claudeUsage={usage}
                      codexUsage={codexUsage}
                      tab={usageTab}
                      onTab={setUsageTab}
                      onClose={() => setUsageOpen(false)}
                      onForceFallback={() => {
                        activateFallback(usage, true)
                        setUsageOpen(false)
                      }}
                    />
                  ) : null}
                </div>
              ) : null}
              {hasCost ? (
                <span
                  className={styles.costPill}
                  title={t('ws.sessionCostTitle', { tokens: fmtTokens(sessionTokens) })}
                >
                  <Coins size={12} />
                  <span className={costClassFor(sessionCostUsd)}>{fmtUsd(sessionCostUsd)}</span>
                </span>
              ) : null}
              {routingSavings > 0 ? (
                <span className={styles.savingsPill} title={t('ws.savingsTitle')}>
                  <PiggyBank size={12} />
                  {t('ws.savedRouting', { usd: fmtUsd(routingSavings) })}
                </span>
              ) : null}
              <label className={styles.budgetControl} title={t('ws.budgetTitle')}>
                <Wallet size={12} />
                <input
                  type="number"
                  min={0}
                  step={1}
                  inputMode="decimal"
                  className={styles.budgetInput}
                  value={budgetUsd ?? ''}
                  placeholder={t('ws.budgetPlaceholder')}
                  onChange={(e) => {
                    const v = e.target.value
                    setBudget(v === '' ? null : Math.max(0, Number(v)))
                  }}
                />
              </label>
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
                onClick={clearCanvas}
                disabled={nodes.length === 0 && taskList.length === 0}
                title={t('ws.clearCanvas')}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </header>

          <div
            className={paletteOpen ? styles.agentPalette : styles.agentPaletteCollapsed}
            data-no-pan
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

          {budgetWarn && budgetUsd != null ? (
            <div
              className={
                budgetCrit
                  ? `${styles.fallbackBanner} ${styles.budgetBannerCrit}`
                  : styles.fallbackBanner
              }
            >
              <span className={styles.fallbackDot} />
              <span className={styles.fallbackText}>
                {t('ws.budgetBanner', {
                  spent: fmtUsd(sessionCostUsd),
                  cap: fmtUsd(budgetUsd),
                  pct: Math.round(budgetRatio * 100),
                })}
              </span>
            </div>
          ) : null}

          <div
            className={styles.stage}
            ref={stageRef}
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          >
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
              {leadCost ? (
                <div className={styles.cardCost}>
                  {shortModel(leadCost.model) ? (
                    <span className={styles.cardCostModel}>{shortModel(leadCost.model)}</span>
                  ) : null}
                  <span className={styles.cardCostTokens}>
                    {fmtTokens(leadCost.total_tokens)} {t('ws.tokens')}
                  </span>
                  {leadCost.cost_usd != null ? (
                    <span className={`${styles.cardCostUsd} ${costClassFor(leadCost.cost_usd)}`}>
                      {fmtUsd(leadCost.cost_usd)}
                    </span>
                  ) : null}
                </div>
              ) : null}
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
                  {w.result ? <div className={styles.codexResult}>{w.result}</div> : null}
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
              subagentGroups.map(([type, cards]) => {
                const Icon = personaIconFor(type)
                return (
                  <div
                    key={type}
                    className={styles.agentGroup}
                    style={{ ['--agent-color' as string]: colorFor(type) }}
                  >
                    <div
                      className={styles.agentGroupHeader}
                      ref={(el) => {
                        if (el) cardRefs.current.set(`group:${type}`, el)
                        else cardRefs.current.delete(`group:${type}`)
                      }}
                    >
                      <Icon size={13} />
                      <span className={styles.agentGroupName}>{type}</span>
                      <span className={styles.agentGroupCount}>{cards.length}</span>
                    </div>
                    <div className={styles.agentGroupCards}>{cards.map(renderCard)}</div>
                  </div>
                )
              })
            )}
          </div>

          {/* camada de tasks do time como DAG — cada task liga ao teammate dono */}
          {taskList.length > 0 ? (
            <div className={styles.tasksLayer}>
              <div className={styles.tasksLayerTitle}>
                <ListTodo size={13} /> {t('ws.tasksTitle')}
                {teamName ? ` · ${teamName}` : ''}
              </div>
              <div className={styles.tasksLayerGrid}>
                {taskList.map((task) => (
                  <div
                    key={task.id}
                    ref={(el) => {
                      if (el) taskRefs.current.set(task.id, el)
                      else taskRefs.current.delete(task.id)
                    }}
                    className={
                      task.status === 'completed'
                        ? `${styles.taskNode} ${styles.taskNodeDone}`
                        : styles.taskNode
                    }
                  >
                    <div className={styles.taskNodeHead}>
                      <span
                        className={
                          task.status === 'completed'
                            ? styles.taskDotDone
                            : task.status === 'in_progress'
                              ? styles.taskDotActive
                              : styles.taskDot
                        }
                      />
                      <span className={styles.taskNodeSubject}>{task.subject}</span>
                    </div>
                    <div className={styles.taskNodeMeta}>
                      #{task.id}
                      {task.owner ? ` · ${task.owner}` : ''} ·{' '}
                      {task.status === 'completed'
                        ? t('ws.taskCompleted')
                        : task.status === 'in_progress'
                          ? t('ws.taskInProgress')
                          : t('ws.taskPending')}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          </div>
        </div>
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
            {hooksSettingsPath && hooksEndpoint && coreAgentsReady ? (
              <XTermView
                ptyId={session.ptyId}
                command="claude"
                cwd={session.folder}
                extraArgs={[
                  '--dangerously-skip-permissions',
                  '--settings',
                  hooksSettingsPath,
                  '--append-system-prompt',
                  orchestrationRules(hooksEndpoint, budgetUsd),
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
                  <AgentIcon type={w.agent} size={16} theme={uiTheme} /> {t('ws.codexWorker')}
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
                  command={w.agent}
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

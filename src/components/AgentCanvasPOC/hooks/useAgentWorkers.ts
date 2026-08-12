import { listen } from '@tauri-apps/api/event'
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react'

import { MAX_LIVE_WORKERS } from '../../../lib/agentCanvasConfig'
import { type CodexWorker } from '../../../lib/agentCanvasUtils'
import { execArgsFor, tailSummary } from '../../../lib/agentExec'
import { useT } from '../../../lib/i18n'
import { attachPty, killPty, listenPtyExit, spawnPty } from '../../../lib/tauri'
import { agentCliCommand, type AgentType } from '../../../lib/types'
import { useUiStore } from '../../../stores/uiStore'

type Session = { folder: string; ptyId: string }

/**
 * Gerência dos workers REAIS (PTYs claude/codex/opencode) do canvas: spawn,
 * kill, dispatch pelo control plane e limpeza. Owner do estado de workers e dos
 * refs de cleanup (pra matar PTYs sem virar dependência de effects).
 */
export function useAgentWorkers(sessionRef: MutableRefObject<Session | null>) {
  const t = useT()
  const [codexWorkers, setCodexWorkers] = useState<CodexWorker[]>([])
  const [expandedCodexId, setExpandedCodexId] = useState<string | null>(null)
  // Refs pra cleanup matar PTYs sem virar dependência dos effects.
  const codexWorkersRef = useRef<CodexWorker[]>([])
  const workerExitUnlistenersRef = useRef(new Map<string, () => void>())
  useEffect(() => {
    codexWorkersRef.current = codexWorkers
  }, [codexWorkers])

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
      console.log(
        '[AgentCanvasPOC] criando worker',
        agent,
        ptyId,
        '· task=',
        !!opts.task,
        '·',
        title,
      )
      setCodexWorkers((prev) => [
        ...prev,
        { ptyId, agent, title, cwd: folder, startedAt: Date.now(), exitedCode: null, args },
      ])
      void spawnPty({
        cols: 120,
        rows: 30,
        id: ptyId,
        command: agentCliCommand(agent),
        cwd: folder,
        extraArgs: args,
      })
        .then(() => {
          // Captura o término mesmo com o terminal fechado — senão o card de um
          // one-shot ficaria "running" pra sempre.
          let unlistenExit: (() => void) | null = null
          let exited = false
          void listenPtyExit(ptyId, (payload) => {
            const code = payload.code
            exited = true
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
          })
            .then((unlisten) => {
              unlistenExit = unlisten
              // Se o exit já disparou antes do promise resolver, desfaz agora e NÃO
              // guarda (senão ficaria um listener órfão já-disparado no ref).
              if (exited) unlisten()
              else workerExitUnlistenersRef.current.set(ptyId, unlisten)
            })
            .catch(() => {})
        })
        .catch((err) => console.error('[AgentCanvasPOC] falha spawnando PTY do worker:', err))
      if (opts.open) setExpandedCodexId(ptyId)
      return ptyId
    },
    [sessionRef],
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
      const safe = rawTask
        .replace(/"/g, "'")
        .replace(/\s*[\r\n]+\s*/g, ' ')
        .trim()
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
      console.log(
        '[AgentCanvasPOC] dispatch',
        agent,
        interactive ? '(interativo)' : safe.slice(0, 80),
      )
      const title = safe ? (safe.length > 60 ? `${safe.slice(0, 60)}…` : safe) : agent
      spawnAgentWorker(agent, title, interactive ? { open: true } : { task: safe })
    },
    [spawnAgentWorker, t],
  )

  useEffect(() => {
    const unlistenPromise = listen('agent-spawn', (event) => {
      const payload = event.payload as { agent?: string; task?: string; mode?: string }
      console.log(
        '[AgentCanvasPOC] agent-spawn:',
        payload?.agent,
        String(payload?.task ?? '').slice(0, 60),
      )
      dispatchToAgent(payload)
    })
    return () => {
      void unlistenPromise.then((u) => u())
    }
  }, [dispatchToAgent])

  // Mata todos os workers vivos (PTYs) e limpa os listeners de exit. Usado ao
  // sair do canvas e ao "limpar tudo".
  const killAllWorkers = useCallback(() => {
    for (const w of codexWorkersRef.current) {
      workerExitUnlistenersRef.current.get(w.ptyId)?.()
      void killPty(w.ptyId).catch(() => {})
    }
    workerExitUnlistenersRef.current.clear()
  }, [])

  // Ao desmontar a view, mata todos os codex workers (PTYs órfãos senão ficam
  // vivos no backend). exitCanvas já cobre o "voltar"; isto cobre os demais.
  useEffect(() => {
    return () => {
      killAllWorkers()
    }
  }, [killAllWorkers])

  return {
    codexWorkers,
    setCodexWorkers,
    expandedCodexId,
    setExpandedCodexId,
    spawnAgentWorker,
    spawnCodexWorker,
    killCodexWorker,
    dispatchToAgent,
    killAllWorkers,
  }
}

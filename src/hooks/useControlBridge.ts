import { useEffect } from 'react'

import { startControlBridge } from '../lib/orchestrator/controlBridge'
import { liveOrchestratorDeps, resolveControlContext } from '../lib/orchestrator/deps'

/**
 * Answers the control requests an agent terminal makes through the Alethe MCP
 * server (`src-tauri/src/control_bridge.rs`).
 *
 * Mounted only after hydration: before `projects.json` is loaded the store has
 * no terminals, so every request would be answered "this terminal does not
 * exist" — a wrong answer is worse than a late one, and a request that arrives
 * early times out and can be retried.
 */
export function useControlBridge(hydrated: boolean): void {
  useEffect(() => {
    if (!hydrated) return
    let disposed = false
    let stop: (() => void) | null = null

    void startControlBridge({
      ops: liveOrchestratorDeps,
      resolveContext: (terminalId) => resolveControlContext(terminalId),
    })
      .then((unlisten) => {
        if (disposed) unlisten()
        else stop = unlisten
      })
      .catch((error) => {
        // Without the listener every MCP tool call from an agent terminal times
        // out, so this must be visible instead of silent.
        console.error('[control-bridge] listener failed to start:', error)
      })

    return () => {
      disposed = true
      stop?.()
    }
  }, [hydrated])
}

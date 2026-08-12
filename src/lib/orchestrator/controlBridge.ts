/**
 * Frontend end of the control-plane bridge.
 *
 * The backend parks an HTTP thread on every control request it emits (see
 * `src-tauri/src/control_bridge.rs`), so this module has exactly one hard rule:
 * **every request gets a reply**. A thrown error, an unknown operation or a
 * malformed argument all turn into a structured error reply — never into a
 * promise that stays pending, which on the other side is an agent frozen until
 * the timeout expires.
 *
 * Routing only. The rules live in `./scope.ts`, the work lives in `./ops.ts`,
 * and the live wiring lives in `./deps.ts`; all three are injected so this
 * layer runs without a Tauri runtime.
 */

import { controlApiReply, listenControlRequest } from '../tauri'
import {
  killTerminal,
  listAgents,
  listTerminals,
  openShell,
  readOutput,
  sendPrompt,
  spawnAgent,
  terminalStatus,
  waitForDone,
  type ControlFailure,
  type ControlResult,
  type OrchestratorDeps,
} from './ops'
import {
  BASE_CAPABILITIES,
  ORCHESTRATOR_CAPABILITIES,
  type ControlCapability,
  type ControlContext,
  type DenialReason,
} from './scope'

/** Tauri event the backend emits for each control request. */
export const CONTROL_REQUEST_EVENT = 'alethe://control-request'

/**
 * Operations this bridge knows how to run. A subset of `OP_*` in
 * `control_bridge.rs`: the backend routes every op it declares to this bridge,
 * including ones with no executor here yet (`events`). Those fall through to the
 * structured `unknown-op` reply below, which is the whole point — the backend
 * parks a thread for up to 150s on each request, so an op this layer does not
 * implement must still be *answered*, immediately.
 */
export const CONTROL_OPS = [
  'list_terminals',
  'read_output',
  'terminal_status',
  'run_shell',
  'list_agents',
  'spawn_agent',
  'send_prompt',
  'kill_terminal',
  'wait_for_done',
] as const

export type ControlOp = (typeof CONTROL_OPS)[number]

/** Who is calling, as the backend's token registry knows them. */
export type ControlRequestContext = {
  terminalId: string
  projectId: string
  groupId: string | null
  capabilities: unknown
}

export type ControlRequest = {
  requestId: string
  ctx: ControlRequestContext
  op: string
  params?: Record<string, unknown> | null
}

export type ControlReplyError = {
  code: string
  message: string
  denial?: DenialReason
}

/** Envelope `control_bridge.rs` expects back. Anything else is malformed there. */
export type ControlReply = { ok: true; data: unknown } | { ok: false; error: ControlReplyError }

export type ControlBridgeDeps = {
  ops: OrchestratorDeps
  /**
   * Resolves a terminal against the LIVE store. Null when the frontend has no
   * such terminal — which is authoritative: a terminal can be closed between
   * the moment its token was minted and the moment it calls.
   */
  resolveContext: (terminalId: string) => ControlContext | null
}

/** How the bridge talks to the backend. Injected so tests need no IPC. */
export type ControlBridgeTransport = {
  listen: (handler: (request: ControlRequest) => void) => Promise<() => void>
  reply: (requestId: string, reply: ControlReply) => Promise<unknown>
}

const KNOWN_CAPABILITIES: readonly ControlCapability[] = [
  ...BASE_CAPABILITIES,
  ...ORCHESTRATOR_CAPABILITIES,
]

function failure(code: string, message: string, denial?: DenialReason): ControlReply {
  return { ok: false, error: denial ? { code, message, denial } : { code, message } }
}

function fromFailure(result: ControlFailure): ControlReply {
  return failure(result.code, result.error, result.denial)
}

/** Strips the `ok` discriminant: the envelope already carries that bit. */
function fromResult<T>(result: ControlResult<T>): ControlReply {
  if (!result.ok) return fromFailure(result)
  const { ok: _ok, ...data } = result
  return { ok: true, data }
}

/**
 * Capabilities are the backend's word, not ours: they are minted with the token
 * at spawn time and the store has no record of the orchestrator flag. Anything
 * unrecognised is dropped rather than trusted, so a malformed payload denies
 * instead of granting.
 */
function capabilitiesOf(raw: unknown): ControlCapability[] {
  if (!Array.isArray(raw)) return []
  return KNOWN_CAPABILITIES.filter((capability) => raw.includes(capability))
}

/**
 * Identity and capabilities come from the token; project and group come from
 * the live store, which is the only thing that knows where the terminal is
 * right now — a terminal can be moved between projects after its token exists.
 */
function contextFor(request: ControlRequest, bridge: ControlBridgeDeps): ControlContext | null {
  const resolved = bridge.resolveContext(request.ctx.terminalId)
  if (!resolved) return null
  return { ...resolved, capabilities: capabilitiesOf(request.ctx.capabilities) }
}

function stringParam(
  params: Record<string, unknown>,
  key: string,
): { value: string } | { error: ControlReply } {
  const value = params[key]
  if (typeof value !== 'string' || value.trim() === '') {
    return { error: failure('invalid', `\`${key}\` is required and must be a non-empty string.`) }
  }
  return { value }
}

function optionalString(
  params: Record<string, unknown>,
  key: string,
): { value: string | undefined } | { error: ControlReply } {
  const value = params[key]
  if (value === undefined || value === null) return { value: undefined }
  if (typeof value !== 'string') {
    return { error: failure('invalid', `\`${key}\` must be a string.`) }
  }
  return { value }
}

function optionalNumber(
  params: Record<string, unknown>,
  key: string,
): { value: number | undefined } | { error: ControlReply } {
  const value = params[key]
  if (value === undefined || value === null) return { value: undefined }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { error: failure('invalid', `\`${key}\` must be a number.`) }
  }
  return { value }
}

function isKnownOp(op: string): op is ControlOp {
  return (CONTROL_OPS as readonly string[]).includes(op)
}

/**
 * Resolves one control request. Never rejects and never throws: the caller on
 * the other side is a blocked thread.
 */
export async function routeControlRequest(
  request: ControlRequest,
  bridge: ControlBridgeDeps,
): Promise<ControlReply> {
  try {
    // Structured answer for ANY op without an executor, not just the ones known
    // to be missing today. The alternative — letting the switch fall through —
    // resolves nothing and holds a backend thread until its timeout, which the
    // model reads as a hang instead of an honest "not implemented".
    if (!isKnownOp(request.op)) {
      return failure(
        'unknown-op',
        `The Alethe UI has no executor for \`${request.op}\` yet. Your token and capabilities are ` +
          'valid, so retrying will not help until that executor ships.',
      )
    }

    const context = contextFor(request, bridge)
    if (!context) {
      return failure(
        'not-found',
        `Terminal ${request.ctx.terminalId} no longer exists in this workspace.`,
      )
    }

    const params = request.params ?? {}

    switch (request.op) {
      case 'list_terminals':
        return fromResult(listTerminals(context, bridge.ops))

      case 'terminal_status': {
        const terminalId = stringParam(params, 'terminalId')
        if ('error' in terminalId) return terminalId.error
        return fromResult(terminalStatus(context, terminalId.value, bridge.ops))
      }

      case 'read_output': {
        const terminalId = stringParam(params, 'terminalId')
        if ('error' in terminalId) return terminalId.error
        const maxChars = optionalNumber(params, 'maxChars')
        if ('error' in maxChars) return maxChars.error
        return fromResult(await readOutput(context, terminalId.value, maxChars.value, bridge.ops))
      }

      case 'run_shell': {
        const command = stringParam(params, 'command')
        if ('error' in command) return command.error
        const cwd = optionalString(params, 'cwd')
        if ('error' in cwd) return cwd.error
        const name = optionalString(params, 'name')
        if ('error' in name) return name.error
        return fromResult(
          await openShell(
            context,
            { command: command.value, cwd: cwd.value, name: name.value },
            bridge.ops,
          ),
        )
      }

      case 'list_agents':
        return fromResult(await listAgents(context, bridge.ops))

      case 'spawn_agent': {
        const agent = stringParam(params, 'agent')
        if ('error' in agent) return agent.error
        const task = stringParam(params, 'task')
        if ('error' in task) return task.error
        const cwd = optionalString(params, 'cwd')
        if ('error' in cwd) return cwd.error
        const mode = optionalString(params, 'mode')
        if ('error' in mode) return mode.error
        const name = optionalString(params, 'name')
        if ('error' in name) return name.error
        return fromResult(
          await spawnAgent(
            context,
            {
              agent: agent.value,
              task: task.value,
              cwd: cwd.value,
              mode: mode.value,
              name: name.value,
            },
            bridge.ops,
          ),
        )
      }

      case 'send_prompt': {
        const terminalId = stringParam(params, 'terminalId')
        if ('error' in terminalId) return terminalId.error
        // `prompt` is the name in the MCP schema and `text` the one this layer
        // was specified with. Accepting both costs a line and removes a class of
        // failure the model cannot see the cause of.
        const text = stringParam(params, params.prompt === undefined ? 'text' : 'prompt')
        if ('error' in text) return text.error
        return fromResult(
          await sendPrompt(context, { terminalId: terminalId.value, text: text.value }, bridge.ops),
        )
      }

      case 'kill_terminal': {
        const terminalId = stringParam(params, 'terminalId')
        if ('error' in terminalId) return terminalId.error
        return fromResult(await killTerminal(context, terminalId.value, bridge.ops))
      }

      case 'wait_for_done': {
        const terminalId = stringParam(params, 'terminalId')
        if ('error' in terminalId) return terminalId.error
        // Only the shape is checked here. The 120000 ms ceiling the MCP schema
        // advertises is clamped by the executor and never refused: the Rust side
        // treats that schema as documentation and does not validate it, so a
        // single gate owns the rule instead of two that can drift.
        const timeoutMs = optionalNumber(params, 'timeoutMs')
        if ('error' in timeoutMs) return timeoutMs.error
        return fromResult(
          await waitForDone(
            context,
            { terminalId: terminalId.value, timeoutMs: timeoutMs.value },
            bridge.ops,
          ),
        )
      }

      // No `events` case on purpose: it ships with the completion bus and falls
      // through to the `unknown-op` reply above until then.
    }
  } catch (error) {
    // An unhandled throw here would leave the backend thread waiting for the
    // full timeout, so it is answered like any other failure.
    return failure('error', `The Alethe UI failed to run \`${request.op}\`: ${String(error)}`)
  }
}

const liveTransport: ControlBridgeTransport = {
  listen: (handler) => listenControlRequest(handler),
  reply: (requestId, reply) => controlApiReply(requestId, reply),
}

/**
 * Starts answering control requests. Resolves to the function that stops it.
 */
export function startControlBridge(
  bridge: ControlBridgeDeps,
  transport: ControlBridgeTransport = liveTransport,
): Promise<() => void> {
  return transport.listen((request) => {
    void (async () => {
      const reply = await routeControlRequest(request, bridge)
      try {
        await transport.reply(request.requestId, reply)
      } catch (error) {
        // Nothing left to answer with: the request will time out on its own.
        console.error('[control-bridge] could not deliver the reply:', error)
      }
    })()
  })
}

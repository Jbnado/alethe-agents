import { describe, expect, it, vi } from 'vitest'

import {
  closeControlSession,
  CONTROL_ENDPOINT_ENV,
  CONTROL_TOKEN_ENV,
  type ControlSession,
  isAgentCommand,
  openControlSession,
  supportsOrchestrator,
  wantsMcpInjection,
  withControlEnv,
} from './launch'
import { capabilitiesFor } from './scope'

const SESSION: ControlSession = {
  token: 'tok_123',
  endpoint: 'http://127.0.0.1:9123',
  capabilities: capabilitiesFor(true),
}

function mintOk() {
  return vi.fn(async () => SESSION)
}

const SCOPE = {
  terminalId: 'term-1',
  projectId: 'proj-api',
  groupId: 'grp-backend' as string | null,
}

describe('supportsOrchestrator', () => {
  it('accepts only the agents whose MCP path was verified', () => {
    expect(supportsOrchestrator('claude')).toBe(true)
    expect(supportsOrchestrator('codex')).toBe(true)
  })

  it('rejects the agents whose MCP path was never verified', () => {
    for (const agent of ['opencode', 'antigravity', 'freebuff', 'mimo', 'shell'] as const) {
      expect(supportsOrchestrator(agent)).toBe(false)
    }
    expect(supportsOrchestrator(null)).toBe(false)
    expect(supportsOrchestrator(undefined)).toBe(false)
  })
})

describe('isAgentCommand', () => {
  it('separates CLI agents from plain shells', () => {
    expect(isAgentCommand('claude')).toBe(true)
    expect(isAgentCommand('opencode')).toBe(true)
    expect(isAgentCommand('shell')).toBe(false)
    expect(isAgentCommand(null)).toBe(false)
    expect(isAgentCommand(undefined)).toBe(false)
  })
})

describe('openControlSession', () => {
  it('mints a token for every agent terminal, orchestrator or not', async () => {
    const mint = mintOk()

    await expect(openControlSession({ agent: 'opencode', ...SCOPE, orchestrator: false, mint }))
      .resolves.toEqual(SESSION)

    expect(mint).toHaveBeenCalledWith({ ...SCOPE, orchestrator: false })
  })

  it('carries the orchestrator flag through for a verified agent', async () => {
    const mint = mintOk()

    await openControlSession({ agent: 'codex', ...SCOPE, orchestrator: true, mint })

    expect(mint).toHaveBeenCalledWith({ ...SCOPE, orchestrator: true })
  })

  it('never elevates an agent whose orchestration path is unverified', async () => {
    const mint = mintOk()

    await openControlSession({ agent: 'opencode', ...SCOPE, orchestrator: true, mint })

    expect(mint).toHaveBeenCalledWith({ ...SCOPE, orchestrator: false })
  })

  it('passes an ungrouped project through as a null group', async () => {
    const mint = mintOk()

    await openControlSession({ agent: 'claude', ...SCOPE, groupId: null, orchestrator: false, mint })

    expect(mint).toHaveBeenCalledWith({ ...SCOPE, groupId: null, orchestrator: false })
  })

  it('mints nothing for a plain shell', async () => {
    const mint = mintOk()

    await expect(
      openControlSession({ agent: 'shell', ...SCOPE, orchestrator: false, mint }),
    ).resolves.toBeNull()
    await expect(
      openControlSession({ agent: null, ...SCOPE, orchestrator: false, mint }),
    ).resolves.toBeNull()
    expect(mint).not.toHaveBeenCalled()
  })

  it('mints nothing without a control-plane identity', async () => {
    const mint = mintOk()

    await expect(
      openControlSession({ agent: 'claude', ...SCOPE, terminalId: '', orchestrator: true, mint }),
    ).resolves.toBeNull()
    await expect(
      openControlSession({ agent: 'claude', ...SCOPE, projectId: '', orchestrator: true, mint }),
    ).resolves.toBeNull()
    expect(mint).not.toHaveBeenCalled()
  })

  it('still lets the terminal spawn when the control plane is down', async () => {
    const mint = vi.fn(async () => {
      throw new Error('listener de agents ainda nao esta disponivel')
    })

    await expect(
      openControlSession({ agent: 'claude', ...SCOPE, orchestrator: true, mint }),
    ).resolves.toBeNull()
  })

  it('rejects half a credential', async () => {
    const noToken = vi.fn(async () => ({ ...SESSION, token: '' }))
    const noEndpoint = vi.fn(async () => ({ ...SESSION, endpoint: '' }))

    await expect(
      openControlSession({ agent: 'claude', ...SCOPE, orchestrator: false, mint: noToken }),
    ).resolves.toBeNull()
    await expect(
      openControlSession({ agent: 'claude', ...SCOPE, orchestrator: false, mint: noEndpoint }),
    ).resolves.toBeNull()
  })
})

describe('withControlEnv', () => {
  it('injects the endpoint and the token', () => {
    expect(withControlEnv(undefined, SESSION)).toEqual({
      [CONTROL_ENDPOINT_ENV]: SESSION.endpoint,
      [CONTROL_TOKEN_ENV]: SESSION.token,
    })
  })

  it('keeps the env the runtime profile already built', () => {
    expect(withControlEnv({ FOO: 'bar' }, SESSION)).toEqual({
      FOO: 'bar',
      [CONTROL_ENDPOINT_ENV]: SESSION.endpoint,
      [CONTROL_TOKEN_ENV]: SESSION.token,
    })
  })

  it('does not mutate the env it was given', () => {
    const env = { FOO: 'bar' }

    withControlEnv(env, SESSION)

    expect(env).toEqual({ FOO: 'bar' })
  })

  it('leaves the env untouched when there is no session', () => {
    expect(withControlEnv({ FOO: 'bar' }, null)).toEqual({ FOO: 'bar' })
    expect(withControlEnv(undefined, null)).toBeUndefined()
  })
})

describe('wantsMcpInjection', () => {
  it('injects into an orchestrator terminal of a verified agent', () => {
    expect(wantsMcpInjection('claude', true, SESSION)).toBe(true)
    expect(wantsMcpInjection('codex', true, SESSION)).toBe(true)
  })

  it('still injects into an ordinary claude terminal', () => {
    // This is what lets ANY claude terminal open a real, visible Alethe shell
    // instead of a hidden internal one. `--mcp-config` is additive, so it costs
    // the user nothing. The server filters the tool list by capability, so this
    // terminal sees only the shell tier.
    expect(wantsMcpInjection('claude', false, SESSION)).toBe(true)
  })

  it('spares an ordinary codex terminal, whose injection is destructive', () => {
    // Codex's only verified route needs `--ignore-user-config`, which discards
    // the user's model, provider and MCP settings. Too high a price outside an
    // explicitly requested orchestrator.
    expect(wantsMcpInjection('codex', false, SESSION)).toBe(false)
  })

  it('never injects into an unverified agent, even if the flag is set', () => {
    expect(wantsMcpInjection('opencode', true, SESSION)).toBe(false)
    expect(wantsMcpInjection('antigravity', true, SESSION)).toBe(false)
  })

  it('needs a live session to inject anything', () => {
    expect(wantsMcpInjection('claude', true, null)).toBe(false)
  })
})

describe('closeControlSession', () => {
  it('revokes the token of the terminal that died', async () => {
    const revoke = vi.fn(async () => 1)

    await closeControlSession('term-1', revoke)

    expect(revoke).toHaveBeenCalledWith('term-1')
  })

  it('never throws when revocation fails', async () => {
    const revoke = vi.fn(async () => {
      throw new Error('ipc down')
    })

    await expect(closeControlSession('term-1', revoke)).resolves.toBeUndefined()
  })

  it('does nothing without a terminal identity', async () => {
    const revoke = vi.fn(async () => 1)

    await closeControlSession('', revoke)

    expect(revoke).not.toHaveBeenCalled()
  })
})

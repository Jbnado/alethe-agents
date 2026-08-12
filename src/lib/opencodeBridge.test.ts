import { describe, expect, it, vi } from 'vitest'

import { preparePtyRuntimeLaunch } from './agentRuntimeAdapter'
import { BRIDGE_ENDPOINT_ENV, BRIDGE_TOKEN_ENV, withOpenCodeBridgeEnv } from './opencodeBridge'

const endpoint = () => Promise.resolve('http://127.0.0.1:9123')
const token = () => Promise.resolve('tok_123')
const credentials = {
  [BRIDGE_ENDPOINT_ENV]: 'http://127.0.0.1:9123',
  [BRIDGE_TOKEN_ENV]: 'tok_123',
}

describe('withOpenCodeBridgeEnv', () => {
  it('injects endpoint and token when launching OpenCode', async () => {
    await expect(withOpenCodeBridgeEnv('opencode', undefined, endpoint, token)).resolves.toEqual(
      credentials,
    )
  })

  it('keeps the env the runtime profile already built', async () => {
    const prepared = preparePtyRuntimeLaunch('opencode', 'lean', [], { FOO: 'bar' })

    await expect(withOpenCodeBridgeEnv('opencode', prepared.env, endpoint, token)).resolves.toEqual(
      { FOO: 'bar', ...credentials },
    )
  })

  it('does not mutate the env it was given', async () => {
    const env = { FOO: 'bar' }

    await withOpenCodeBridgeEnv('opencode', env, endpoint, token)

    expect(env).toEqual({ FOO: 'bar' })
  })

  it('leaves other agents and plain shells untouched, without touching the listener', async () => {
    const resolveEndpoint = vi.fn(endpoint)
    const resolveToken = vi.fn(token)

    for (const agent of ['claude', 'codex', 'shell'] as const) {
      await expect(
        withOpenCodeBridgeEnv(agent, { FOO: 'bar' }, resolveEndpoint, resolveToken),
      ).resolves.toEqual({ FOO: 'bar' })
    }
    await expect(
      withOpenCodeBridgeEnv(undefined, undefined, resolveEndpoint, resolveToken),
    ).resolves.toBeUndefined()
    await expect(
      withOpenCodeBridgeEnv(null, undefined, resolveEndpoint, resolveToken),
    ).resolves.toBeUndefined()
    expect(resolveEndpoint).not.toHaveBeenCalled()
    expect(resolveToken).not.toHaveBeenCalled()
  })

  it('still spawns when the hooks listener is unavailable', async () => {
    const rejects = () => Promise.reject(new Error('listener de agents ainda nao esta disponivel'))

    await expect(
      withOpenCodeBridgeEnv('opencode', { FOO: 'bar' }, rejects, token),
    ).resolves.toEqual({ FOO: 'bar' })
    await expect(
      withOpenCodeBridgeEnv('opencode', undefined, rejects, token),
    ).resolves.toBeUndefined()
  })

  it('injects nothing when only half the pair resolves', async () => {
    const empty = () => Promise.resolve('')

    await expect(
      withOpenCodeBridgeEnv('opencode', undefined, endpoint, empty),
    ).resolves.toBeUndefined()
    await expect(
      withOpenCodeBridgeEnv('opencode', undefined, empty, token),
    ).resolves.toBeUndefined()
  })
})

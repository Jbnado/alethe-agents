import { describe, expect, it } from 'vitest'

import {
  capabilitiesFor,
  denyReason,
  hasCapability,
  isInScope,
  type ControlContext,
  type GroupResolver,
} from './scope'

const GROUPS: Record<string, string | null> = {
  'proj-api': 'grp-backend',
  'proj-web': 'grp-backend',
  'proj-other': 'grp-marketing',
  'proj-loose': null,
  'proj-loose-2': null,
}

const resolveGroup: GroupResolver = (projectId) => GROUPS[projectId] ?? null

function contextFor(
  projectId: string,
  orchestrator: boolean,
  terminalId = 'term-1',
): ControlContext {
  return {
    terminalId,
    projectId,
    groupId: resolveGroup(projectId),
    capabilities: capabilitiesFor(orchestrator),
  }
}

describe('capabilitiesFor', () => {
  it('gives every agent terminal the shell tier', () => {
    const caps = capabilitiesFor(false)
    expect(caps).toContain('shell.run')
    expect(caps).toContain('terminal.read')
    expect(caps).toContain('terminal.list')
    expect(caps).toContain('events.read')
  })

  it('withholds orchestration from a plain terminal', () => {
    const caps = capabilitiesFor(false)
    expect(caps).not.toContain('agent.spawn')
    expect(caps).not.toContain('agent.prompt')
    expect(caps).not.toContain('agent.kill')
  })

  it('grants orchestration only when the toggle is on', () => {
    const caps = capabilitiesFor(true)
    expect(caps).toContain('agent.spawn')
    expect(caps).toContain('agent.prompt')
    expect(caps).toContain('agent.kill')
  })

  it('keeps the delegation tree one level deep', () => {
    // An orchestrator spawns agents as plain terminals, so they cannot spawn.
    const spawned = contextFor('proj-api', false, 'term-spawned')
    expect(hasCapability(spawned, 'agent.spawn')).toBe(false)
    expect(hasCapability(spawned, 'shell.run')).toBe(true)
  })
})

describe('isInScope', () => {
  it('allows the caller its own project', () => {
    const ctx = contextFor('proj-api', true)
    expect(isInScope(ctx, { terminalId: 't', projectId: 'proj-api' }, resolveGroup)).toBe(true)
  })

  it('allows a sibling project in the same group', () => {
    const ctx = contextFor('proj-api', true)
    expect(isInScope(ctx, { terminalId: 't', projectId: 'proj-web' }, resolveGroup)).toBe(true)
  })

  it('denies a project in another group', () => {
    const ctx = contextFor('proj-api', true)
    expect(isInScope(ctx, { terminalId: 't', projectId: 'proj-other' }, resolveGroup)).toBe(false)
  })

  it('denies an ungrouped project from outside the group', () => {
    const ctx = contextFor('proj-api', true)
    expect(isInScope(ctx, { terminalId: 't', projectId: 'proj-loose' }, resolveGroup)).toBe(false)
  })

  it('confines an ungrouped caller to its own project', () => {
    // Two ungrouped projects must not see each other just because both lack a group.
    const ctx = contextFor('proj-loose', true)
    expect(isInScope(ctx, { terminalId: 't', projectId: 'proj-loose' }, resolveGroup)).toBe(true)
    expect(isInScope(ctx, { terminalId: 't', projectId: 'proj-loose-2' }, resolveGroup)).toBe(false)
  })
})

describe('denyReason', () => {
  const target = { terminalId: 't', projectId: 'proj-web' }

  it('passes an allowed request', () => {
    const ctx = contextFor('proj-api', true)
    expect(denyReason(ctx, 'agent.prompt', target, resolveGroup)).toBeNull()
  })

  it('reports the missing capability first', () => {
    const ctx = contextFor('proj-api', false)
    expect(denyReason(ctx, 'agent.spawn', target, resolveGroup)).toEqual({
      kind: 'missing-capability',
      capability: 'agent.spawn',
    })
  })

  it('reports an out-of-scope target', () => {
    const ctx = contextFor('proj-api', true)
    expect(
      denyReason(ctx, 'agent.prompt', { terminalId: 't', projectId: 'proj-other' }, resolveGroup),
    ).toEqual({ kind: 'out-of-scope', targetProjectId: 'proj-other' })
  })

  it('checks capability even when no target is named', () => {
    const ctx = contextFor('proj-api', false)
    expect(denyReason(ctx, 'agent.kill', null, resolveGroup)).toEqual({
      kind: 'missing-capability',
      capability: 'agent.kill',
    })
    expect(denyReason(ctx, 'terminal.list', null, resolveGroup)).toBeNull()
  })
})

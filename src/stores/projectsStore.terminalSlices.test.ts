import { describe, expect, it } from 'vitest'

import type { Project } from '../lib/types'
import type { ProjectsState } from './projectsStore'
import type { SliceCtx } from './projectsStore.slices'
import { createTerminalsSlice } from './projectsStore.terminalSlices'

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-api',
    name: 'API',
    terminals: [],
    defaultCwd: 'C:/repo/api',
    ...overrides,
  } as Project
}

/**
 * Minimal harness around the slice factory: `createTerminal` only ever touches
 * `update`, so a plain object standing in for the store is enough to observe
 * exactly what it writes.
 */
function harness(project = makeProject()) {
  let state = {
    projects: [project],
    workspace: { containers: [], recentProjectIds: [], recentTabs: [] },
  } as unknown as ProjectsState

  const ctx = {
    get: () => state,
    update: (mutator: (s: ProjectsState) => Partial<ProjectsState> | void) => {
      const result = mutator(state)
      if (result) state = { ...state, ...result } as ProjectsState
    },
    updateTerminal: () => {},
  } as unknown as SliceCtx

  return {
    slice: createTerminalsSlice(ctx),
    project: () => state.projects[0],
  }
}

const AGENT_TAB = { type: 'claude' as const, cwd: 'C:/repo/api/packages/web' }

describe('createTerminal / project default folder', () => {
  it('adopts the folder the user picked in the modal', () => {
    const { slice, project } = harness()

    slice.createTerminal('proj-api', {
      name: 'Claude',
      cwd: 'C:/repo/api/packages/web',
      firstTab: AGENT_TAB,
    })

    expect(project().defaultCwd).toBe('C:/repo/api/packages/web')
  })

  it('leaves the default folder alone when the caller suppresses it', () => {
    // An orchestrating agent opening a shell in a subfolder must not repoint
    // the default folder of a project it does not own.
    const { slice, project } = harness()

    slice.createTerminal('proj-api', {
      name: 'agent shell',
      cwd: 'C:/repo/api/packages/web',
      firstTab: { type: 'shell', cwd: 'C:/repo/api/packages/web', initialInput: 'npm test' },
      suppressDefaultCwd: true,
    })

    expect(project().defaultCwd).toBe('C:/repo/api')
  })

  it('still creates the terminal it was asked for when suppressed', () => {
    const { slice, project } = harness()

    const terminal = slice.createTerminal('proj-api', {
      name: 'agent shell',
      cwd: 'C:/repo/api/packages/web',
      firstTab: { type: 'shell', cwd: 'C:/repo/api/packages/web' },
      suppressDefaultCwd: true,
    })

    expect(project().terminals).toHaveLength(1)
    expect(project().terminals[0].id).toBe(terminal.id)
    expect(terminal.cwd).toBe('C:/repo/api/packages/web')
  })

  it('keeps ignoring the default folder for isolated worktree terminals', () => {
    const { slice, project } = harness()

    slice.createTerminal('proj-api', {
      name: 'Claude',
      cwd: 'C:/repo/api/.alethe/worktrees/cl-abc',
      firstTab: { ...AGENT_TAB, cwd: 'C:/repo/api/.alethe/worktrees/cl-abc' },
      worktreeAgentId: 'cl-abc',
    })

    expect(project().defaultCwd).toBe('C:/repo/api')
  })

  it('carries the orchestrator flag onto the sub-tab it creates', () => {
    const { slice } = harness()

    const terminal = slice.createTerminal('proj-api', {
      name: 'Claude',
      cwd: 'C:/repo/api',
      firstTab: { ...AGENT_TAB, cwd: 'C:/repo/api', orchestrator: true },
    })

    expect(terminal.tabs[0].orchestrator).toBe(true)
  })

  it('leaves the flag absent for an ordinary terminal', () => {
    const { slice } = harness()

    const terminal = slice.createTerminal('proj-api', {
      name: 'Claude',
      cwd: 'C:/repo/api',
      firstTab: { ...AGENT_TAB, cwd: 'C:/repo/api' },
    })

    expect(terminal.tabs[0].orchestrator).toBeUndefined()
  })
})

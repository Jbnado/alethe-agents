import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AGENT_TYPE_LABELS,
  type AgentType,
  ALL_AGENT_TYPES,
  type Project,
} from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { NewTerminalModal } from './NewTerminalModal'

const PROJECT = {
  id: 'proj-api',
  name: 'API',
  terminals: [],
  defaultCwd: 'C:/repo/api',
} as unknown as Project

function enableAll(): Record<AgentType, boolean> {
  return Object.fromEntries(ALL_AGENT_TYPES.map((agent) => [agent, true])) as Record<
    AgentType,
    boolean
  >
}

/** Clicks the agent card of the open modal, found by its visible label. */
function chooseAgent(agent: AgentType) {
  const label = AGENT_TYPE_LABELS[agent]
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }))
}

function orchestratorToggle() {
  return screen.queryByRole('button', { name: /orchestrator|orquestrador/i })
}

beforeEach(() => {
  useProjectsStore.setState((state) => ({
    projects: [PROJECT],
    preferences: { ...state.preferences, language: 'en', enabledAgents: enableAll() },
  }))
  useUiStore.setState({ openModal: 'newTerminal', modalContext: { projectId: PROJECT.id } })
})

afterEach(() => {
  cleanup()
  useUiStore.setState({ openModal: null, modalContext: null })
})

describe('NewTerminalModal orchestrator toggle', () => {
  it('is offered for the agents whose MCP path is verified', () => {
    render(<NewTerminalModal />)

    for (const agent of ['claude', 'codex'] as const) {
      chooseAgent(agent)
      expect(orchestratorToggle(), `${agent} should offer orchestration`).not.toBeNull()
    }
  })

  it('is absent for the agents whose MCP path was never verified', () => {
    // An option that silently does nothing is worse than no option at all.
    render(<NewTerminalModal />)

    for (const agent of ['opencode', 'antigravity', 'freebuff', 'mimo', 'shell'] as const) {
      chooseAgent(agent)
      expect(orchestratorToggle(), `${agent} must not offer orchestration`).toBeNull()
    }
  })

  it('starts off and flips on click', () => {
    render(<NewTerminalModal />)

    const toggle = orchestratorToggle()
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(toggle as HTMLElement)

    expect(orchestratorToggle()).toHaveAttribute('aria-pressed', 'true')
  })

  it('warns that Codex orchestration drops the user config', () => {
    render(<NewTerminalModal />)

    chooseAgent('codex')
    fireEvent.click(orchestratorToggle() as HTMLElement)

    expect(screen.getByText(/--ignore-user-config/)).toBeInTheDocument()
  })
})

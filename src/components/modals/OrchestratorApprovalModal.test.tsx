import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { askForApproval } from '../../lib/orchestrator/approvalGate'
import type { ApprovalRequest } from '../../lib/orchestrator/ops'
import type { Project } from '../../lib/types'
import { useOrchestratorStore } from '../../stores/orchestratorStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { OrchestratorApprovalModal } from './OrchestratorApprovalModal'

const PROJECT = {
  id: 'proj-api',
  name: 'API',
  terminals: [
    { id: 'term-lead', name: 'Lead', tabs: [], activeTabId: null },
    { id: 'term-worker', name: 'Worker', tabs: [], activeTabId: null },
  ],
} as unknown as Project

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    action: 'shell.run',
    requesterTerminalId: 'term-lead',
    projectId: 'proj-api',
    payload: 'npm run build',
    ...overrides,
  }
}

/** Parks a request the way `ops.ts` does, and hands back its settled answer. */
function park(overrides?: Partial<ApprovalRequest>) {
  const controller = new AbortController()
  let decision!: Promise<boolean>
  // The real caller is a control request, not a React event, so the store write
  // lands outside React's own batching.
  act(() => {
    decision = askForApproval(request(overrides), controller.signal)
  })
  return { decision, controller }
}

beforeEach(() => {
  useProjectsStore.setState({ projects: [PROJECT] })
  useOrchestratorStore.getState().reset()
  useUiStore.setState({ openModal: null, modalContext: null })
})

afterEach(cleanup)

describe('OrchestratorApprovalModal', () => {
  it('shows the payload verbatim, plus who asked and where', async () => {
    const command = `node -e "console.log(${'a'.repeat(400)})"`
    park({ payload: command })
    render(<OrchestratorApprovalModal />)

    expect(await screen.findByText(command)).toBeTruthy()
    expect(screen.getByText('Lead')).toBeTruthy()
    expect(screen.getByText('API')).toBeTruthy()
  })

  it('settles the parked request with the answer the person gave', async () => {
    const allowed = park()
    render(<OrchestratorApprovalModal />)

    fireEvent.click(await screen.findByRole('button', { name: /^allow$/i }))
    expect(await allowed.decision).toBe(true)

    const refused = park()
    fireEvent.click(await screen.findByRole('button', { name: /^deny$/i }))
    expect(await refused.decision).toBe(false)
  })

  it('grants the session permission only when the checkbox was ticked', async () => {
    park()
    render(<OrchestratorApprovalModal />)

    fireEvent.click(await screen.findByRole('button', { name: /^allow$/i }))
    expect(useOrchestratorStore.getState().isSessionApproved('term-lead', 'shell.run')).toBe(false)

    park()
    fireEvent.click(await screen.findByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /^allow$/i }))
    expect(useOrchestratorStore.getState().isSessionApproved('term-lead', 'shell.run')).toBe(true)
  })

  it('never carries the checkbox over to the next request in the queue', async () => {
    park()
    park({ action: 'agent.kill', targetTerminalId: 'term-worker', payload: 'Worker' })
    render(<OrchestratorApprovalModal />)

    fireEvent.click(await screen.findByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /^allow$/i }))

    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })

  it('queues instead of stacking, and says how many are waiting', async () => {
    park()
    park({ payload: 'npm test' })
    park({ payload: 'npm run lint' })
    render(<OrchestratorApprovalModal />)

    // One request on screen, the rest counted.
    expect(await screen.findByText('npm run build')).toBeTruthy()
    expect(screen.queryByText('npm test')).toBeNull()
    expect(screen.getByText(/2 more waiting/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^deny$/i }))
    expect(screen.getByText('npm test')).toBeTruthy()
    expect(screen.getByText(/1 more waiting/i)).toBeTruthy()
  })

  it('reads dismissing the dialog as a refusal, not as a request left parked', async () => {
    const parked = park()
    render(<OrchestratorApprovalModal />)

    fireEvent.click(await screen.findByRole('button', { name: /close/i }))

    expect(await parked.decision).toBe(false)
    expect(useOrchestratorStore.getState().approvals).toHaveLength(0)
    expect(useUiStore.getState().openModal).toBe(null)
  })

  it('drops the card when the deadline in ops.ts aborts it', async () => {
    const parked = park()
    render(<OrchestratorApprovalModal />)
    expect(await screen.findByText('npm run build')).toBeTruthy()

    act(() => parked.controller.abort())

    expect(await parked.decision).toBe(false)
    expect(useOrchestratorStore.getState().approvals).toHaveLength(0)
  })

  it('takes the modal slot back once whatever the person opened over it closes', () => {
    park()
    render(<OrchestratorApprovalModal />)
    expect(useUiStore.getState().openModal).toBe('orchestratorApproval')

    // Something the person opened afterwards owns the slot — nothing is stacked
    // on top of it, and the request stays parked rather than being answered.
    act(() => useUiStore.getState().openModal_('preferences'))
    expect(useUiStore.getState().openModal).toBe('preferences')
    expect(useOrchestratorStore.getState().approvals).toHaveLength(1)

    act(() => useUiStore.getState().closeModal())
    expect(useUiStore.getState().openModal).toBe('orchestratorApproval')
  })
})

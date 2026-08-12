import { describe, expect, it } from 'vitest'

import { buildAgentLaunch } from './sessionLaunch'

describe('buildAgentLaunch', () => {
  it('new Claude panes receive distinct deterministic session ids', () => {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
    const first = buildAgentLaunch(
      'claude',
      ['--dangerously-skip-permissions'],
      undefined,
      () => ids[0],
    )
    const second = buildAgentLaunch(
      'claude',
      ['--dangerously-skip-permissions'],
      undefined,
      () => ids[1],
    )

    expect(first.sessionId).not.toBe(second.sessionId)
    expect(first.args).toEqual(['--session-id', ids[0], '--dangerously-skip-permissions'])
    expect(second.args).toEqual(['--session-id', ids[1], '--dangerously-skip-permissions'])
  })

  it('Claude resumes only the session assigned to its pane', () => {
    const launch = buildAgentLaunch(
      'claude',
      ['--continue', '--resume', 'stale', '--session-id', 'stale-too', '--model', 'sonnet'],
      'pane-session',
    )

    expect(launch.args).toEqual(['--resume', 'pane-session', '--model', 'sonnet'])
    expect(launch.createdSession).toBe(false)
  })

  it('Codex without a known id starts a new chat instead of resuming last', () => {
    const launch = buildAgentLaunch('codex', ['resume', '--last', '--search'])
    expect(launch.args).toEqual(['--search'])
  })

  it('Codex and OpenCode use their pane-specific resume syntax', () => {
    expect(buildAgentLaunch('codex', ['resume', 'old', '--search'], 'codex-pane').args).toEqual([
      'resume',
      'codex-pane',
      '--search',
    ])
    expect(
      buildAgentLaunch('opencode', ['--continue', '--session', 'old', '--model', 'x'], 'open-pane')
        .args,
    ).toEqual(['--session', 'open-pane', '--model', 'x'])
  })

  it('Claude receives one --mcp-config per managed server', () => {
    const launch = buildAgentLaunch('claude', ['--model', 'sonnet'], 'pane-session', undefined, [
      'C:/tmp/graphify.json',
      'C:/tmp/alethe.json',
    ])

    expect(launch.args).toEqual([
      '--resume',
      'pane-session',
      '--mcp-config',
      'C:/tmp/graphify.json',
      '--mcp-config',
      'C:/tmp/alethe.json',
      '--model',
      'sonnet',
    ])
  })

  it('Codex orchestrator flags stay ahead of the resume subcommand', () => {
    // `-c` belongs to the root command: placed after `resume` it would not parse.
    const leading = ['--ignore-user-config', '-c', 'mcp_servers.alethe={"url":"u"}']

    expect(
      buildAgentLaunch('codex', ['--search'], 'codex-pane', undefined, undefined, leading).args,
    ).toEqual([...leading, 'resume', 'codex-pane', '--search'])
    expect(
      buildAgentLaunch('codex', ['--search'], undefined, undefined, undefined, leading).args,
    ).toEqual([...leading, '--search'])
  })

  it('Codex without orchestration keeps the arguments it always had', () => {
    expect(buildAgentLaunch('codex', ['--search'], 'codex-pane', undefined, undefined, []).args)
      .toEqual(['resume', 'codex-pane', '--search'])
  })

  it('Antigravity keeps agy flags and uses its pane-specific conversation', () => {
    expect(
      buildAgentLaunch(
        'antigravity',
        ['--continue', '--conversation', 'old', '--dangerously-skip-permissions'],
        'agy-pane',
      ).args,
    ).toEqual(['--conversation', 'agy-pane', '--dangerously-skip-permissions'])
  })
})

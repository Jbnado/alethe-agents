import { describe, expect, it } from 'vitest'

import { execArgsFor, tailSummary } from './agentExec'

const ESC = '\x1b'

describe('execArgsFor', () => {
  it('runs codex through `exec` without the git repo check', () => {
    expect(execArgsFor('codex', 'ship it')).toEqual(['exec', '--skip-git-repo-check', 'ship it'])
  })

  it('runs claude headless with permissions skipped so it never blocks on a prompt', () => {
    expect(execArgsFor('claude', 'ship it')).toEqual([
      '-p',
      'ship it',
      '--dangerously-skip-permissions',
    ])
  })

  it('runs opencode through `run`', () => {
    expect(execArgsFor('opencode', 'ship it')).toEqual(['run', 'ship it'])
  })

  it('returns undefined for agents without a one-shot mode', () => {
    expect(execArgsFor('shell', 'ship it')).toBeUndefined()
    expect(execArgsFor('freebuff', 'ship it')).toBeUndefined()
  })

  it('keeps the task verbatim as a single argument', () => {
    const task = 'fix the "quoted" thing --now'
    expect(execArgsFor('codex', task)?.at(-1)).toBe(task)
    expect(execArgsFor('claude', task)?.[1]).toBe(task)
    expect(execArgsFor('opencode', task)?.[1]).toBe(task)
  })
})

describe('tailSummary', () => {
  it('strips SGR color sequences', () => {
    expect(tailSummary(`${ESC}[31mred${ESC}[0m text`)).toBe('red text')
  })

  it('strips cursor movement and erase CSI sequences', () => {
    const raw = `${ESC}[2J${ESC}[H${ESC}[1;1Hdone${ESC}[K`
    expect(tailSummary(raw)).toBe('done')
  })

  it('strips private-mode CSI sequences such as alternate screen toggles', () => {
    const raw = `${ESC}[?1049hbuild ok${ESC}[?25l${ESC}[?1049l`
    expect(tailSummary(raw)).toBe('build ok')
  })

  it('strips OSC title sequences terminated by BEL and by ST', () => {
    expect(tailSummary(`${ESC}]0;my title\x07after bel`)).toBe('after bel')
    expect(tailSummary(`${ESC}]2;other${ESC}\\after st`)).toBe('after st')
  })

  it('strips single-character escapes and leftover control bytes', () => {
    expect(tailSummary(`${ESC}Mindex ${ESC}Dscroll\x00\x07 ok`)).toBe('index scroll ok')
  })

  it('collapses horizontal whitespace and blank-line runs but keeps single newlines', () => {
    expect(tailSummary('a   \t  b\n\n\n\nc')).toBe('a b\nc')
  })

  it('trims surrounding whitespace', () => {
    expect(tailSummary(`  \n${ESC}[0m padded \n `)).toBe('padded')
  })

  it('returns an empty string when the input is only control sequences', () => {
    expect(tailSummary(`${ESC}[2J${ESC}[H${ESC}[?25l`)).toBe('')
  })

  it('keeps short output untouched', () => {
    expect(tailSummary('short', 10)).toBe('short')
  })

  it('keeps only the tail once the cleaned text exceeds max, prefixed with an ellipsis', () => {
    const summary = tailSummary('0123456789abcdef', 6)
    expect(summary).toBe('…abcdef')
  })

  it('measures the limit against the cleaned text, not the raw bytes', () => {
    const raw = `${ESC}[31m${ESC}[1m${ESC}[0mabcde`
    expect(tailSummary(raw, 5)).toBe('abcde')
  })
})

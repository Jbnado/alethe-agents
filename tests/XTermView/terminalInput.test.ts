import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getTerminalScrollbackRows,
  getWheelScrollLines,
  normalizePastedText,
} from '../../src/components/XTermView/terminalInput.ts'

test('normalizePastedText converts clipboard newlines to PTY carriage returns', () => {
  assert.equal(normalizePastedText('one\r\ntwo\nthree\r'), 'one\rtwo\rthree\r')
})

test('getWheelScrollLines always scrolls at least one line for pixel wheel events', () => {
  assert.equal(getWheelScrollLines({ deltaMode: 0, deltaY: 1 }, 18), 1)
  assert.equal(getWheelScrollLines({ deltaMode: 0, deltaY: -1 }, 18), -1)
})

test('getWheelScrollLines preserves larger wheel intent across delta modes', () => {
  assert.equal(getWheelScrollLines({ deltaMode: 0, deltaY: 40 }, 20), 2)
  assert.equal(getWheelScrollLines({ deltaMode: 1, deltaY: 3 }, 20), 3)
  assert.equal(getWheelScrollLines({ deltaMode: 2, deltaY: -1 }, 20), -10)
})

test('getTerminalScrollbackRows keeps enough rows for long agent chats', () => {
  assert.ok(getTerminalScrollbackRows() >= 10_000)
})

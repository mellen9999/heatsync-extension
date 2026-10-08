// Cold-load race behind the black YouTube watch page: setupYouTubeResizeHandle
// ran before YT mounted #secondary, returned for good, and so never installed
// the watchers that re-run layout when the panel flips live. --hs-yt-below-top
// stayed unset and #below (position:fixed at the 56px fallback) covered the
// player. It must keep retrying until #secondary exists, then wire the watchers
// exactly once.

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'youtube-host.js'), 'utf8')
const start = SRC.indexOf('function setupYouTubeResizeHandle(')
const end = SRC.indexOf('\n}\n', start) + 2
const FN = SRC.slice(start, end)

function stand() {
  const state = { secondary: null, mc: {}, handle: null, timers: [], calls: [] }
  const doc = {
    getElementById: (id) => (id === 'hs-mc-container' ? state.mc : id === 'hs-yt-resize-handle' ? state.handle : null),
    createElement: () => ({ style: { setProperty() {} }, dataset: {}, addEventListener() {} }),
  }
  const make = new Function(
    'document',
    'hsQuery',
    'cleanup',
    'mcSignal',
    'loadChatWidth',
    'loadChatHeight',
    'applyYouTubeChatWidth',
    'watchYtViewportClamp',
    'watchYtLayoutAttrs',
    'watchYtFlexyMount',
    `${FN}; return setupYouTubeResizeHandle`,
  )
  const fn = make(
    doc,
    () => state.secondary,
    { setTimeout: (f) => state.timers.push(f) },
    {},
    () => Promise.resolve(),
    () => state.calls.push('height'),
    () => {},
    () => state.calls.push('clamp'),
    () => state.calls.push('attrs'),
    () => state.calls.push('mount'),
  )
  state.secondary = null
  return { fn, state }
}

test('no #secondary yet: retries instead of giving up', () => {
  const { fn, state } = stand()
  fn()
  expect(state.timers.length).toBe(1)
  expect(state.calls).toEqual([])
})

test('#secondary mounts later: the retry installs the watchers once', () => {
  const { fn, state } = stand()
  fn()
  state.secondary = {
    style: {},
    insertBefore(h) {
      state.handle = h
    },
    firstChild: null,
  }
  state.timers.shift()()
  expect(state.calls).toEqual(['height', 'clamp', 'attrs', 'mount'])
  expect(state.timers.length).toBe(0)
})

test('gives up after the ceiling, never loops forever', () => {
  const { fn, state } = stand()
  fn()
  for (let i = 0; i < 100 && state.timers.length; i++) state.timers.shift()()
  expect(state.calls).toEqual([])
  expect(state.timers.length).toBe(0)
})

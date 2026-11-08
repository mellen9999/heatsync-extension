/**
 * The emote picker's document-level click + Esc listeners must not pile up.
 *
 * cleanup.addEventListener (bootstrap.js) wraps every handler before it
 * registers it, so the old detachPickerCloseHandlers — which called
 * document.removeEventListener(name, handler) with the UNWRAPPED function —
 * removed nothing. Every open added a click and a keydown listener that lived
 * until the whole overlay was torn down. Opening the picker 50 times left 100
 * extra document listeners, each running on every click and keypress on the
 * host page.
 *
 * Carved from the real sources (the multichat files share one scope and have no
 * exports) and run against a fake document that counts what is registered.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')
const BOOT = read('bootstrap.js')
const NAV = read('picker-nav.js')

function slice(src, from, to) {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  if (a === -1 || b === -1 || b <= a) throw new Error(`carve markers not found: ${from} .. ${to}`)
  return src.slice(a, b)
}

// the real cleanup.addEventListener / setTimeout / clearTimeout, verbatim
const CLEANUP_ADD = slice(
  BOOT,
  '  addEventListener(target, event, handler, opts) {',
  '  // For chrome.runtime.onMessage',
)
// the real attach/detach pair
const PICKER = slice(NAV, '// ── close handlers', '// Exported for the tests')

function harness() {
  const live = new Set() // every (event, fn) currently registered on the document
  const document = {
    addEventListener: (event, fn) => live.add(`${event}:${fns.id(fn)}`),
    removeEventListener: (event, fn) => live.delete(`${event}:${fns.id(fn)}`),
    getElementById: () => ({ classList: { remove() {} } }),
  }
  const ids = new Map()
  const fns = { id: (fn) => ids.get(fn) ?? (ids.set(fn, ids.size + 1), ids.size) }
  const timers = new Map()
  let t = 0
  const mcSignal = { aborted: false }
  const make = new Function(
    'document',
    'mcSignal',
    'timers',
    'nextTimer',
    '_pickerCloseHandlerRef',
    `
    const _hsPerfWrap = (fn) => (...a) => fn(...a)
    const cleanup = {
      ${CLEANUP_ADD}
      setTimeout(fn) { const id = nextTimer(); timers.set(id, fn); return id },
      clearTimeout(id) { timers.delete(id) },
    }
    let _pickerCloseHandler = null
    const hideInputBar = () => {}
    const stopPredictionPoll = () => {}
    ${PICKER}
    return { attachPickerCloseHandler, closeEmotePickerPanel, detachPickerCloseHandlers }
    `,
  )
  const api = make(document, mcSignal, timers, () => ++t)
  const flush = () => {
    for (const [id, fn] of [...timers]) {
      timers.delete(id)
      fn()
    }
  }
  return { api, live, flush, timers }
}

const picker = { contains: () => false }

describe('emote picker document listeners', () => {
  test('opening and closing 50 times leaves no listener behind', () => {
    const { api, live, flush } = harness()
    for (let i = 0; i < 50; i++) {
      api.attachPickerCloseHandler(picker)
      flush()
      expect(live.size).toBe(2) // exactly one click + one keydown while open
      api.closeEmotePickerPanel()
      expect(live.size).toBe(0)
    }
  })

  test('re-opening without closing replaces the pair instead of stacking it', () => {
    const { api, live, flush } = harness()
    for (let i = 0; i < 50; i++) {
      api.attachPickerCloseHandler(picker)
      flush()
    }
    expect(live.size).toBe(2)
    api.detachPickerCloseHandlers()
    expect(live.size).toBe(0)
  })

  test('a close before the deferred attach runs attaches nothing', () => {
    const { api, live, flush, timers } = harness()
    api.attachPickerCloseHandler(picker)
    expect(timers.size).toBe(1)
    api.detachPickerCloseHandlers()
    flush()
    expect(live.size).toBe(0)
  })
})

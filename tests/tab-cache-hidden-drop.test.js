// A browser tab that sits hidden lets go of its tab-switch snapshots; a quick
// alt-tab keeps them.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main-state.js'), 'utf8')
const start = src.indexOf('let _hsCacheDropTimer')
const block = src.slice(start, src.indexOf('\n})\n', start) + 4)

function rig() {
  const listeners = []
  const timers = new Map()
  let id = 0
  const doc = { hidden: false }
  const cache = new Map([
    ['a', {}],
    ['b', {}],
  ])
  const run = new Function(
    'cleanup',
    'document',
    '_tabCache',
    '_dropAllTabCaches',
    'setTimeout',
    'clearTimeout',
    `${block}`,
  )
  run(
    { addEventListener: (_t, _e, fn) => listeners.push(fn) },
    doc,
    cache,
    () => cache.clear(),
    (fn, ms) => (timers.set(++id, { fn, ms }), id),
    (t) => timers.delete(t),
  )
  const flip = (hidden) => {
    doc.hidden = hidden
    for (const fn of listeners) fn()
  }
  const fire = () => {
    for (const [k, t] of [...timers]) {
      timers.delete(k)
      t.fn()
    }
  }
  return { cache, timers, flip, fire }
}

test('hidden for a minute: snapshots dropped', () => {
  const r = rig()
  r.flip(true)
  expect([...r.timers.values()][0].ms).toBe(60_000)
  r.fire()
  expect(r.cache.size).toBe(0)
})

test('back before the minute: snapshots kept', () => {
  const r = rig()
  r.flip(true)
  r.flip(false)
  expect(r.timers.size).toBe(0)
  r.fire()
  expect(r.cache.size).toBe(2)
})

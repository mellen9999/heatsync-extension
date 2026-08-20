import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { diagSnapshot, hsQuery, hsQueryAll, MISS_MS, MISS_STREAK, swallow } from '../src/lib/diag.js'

// Behaviour test, not a source-text contract: it drives the real module against
// a fake DOM and a fake clock. The whole point of diag.js is that it must never
// cry wolf — a false "selector stopped matching" report is worse than none,
// because it burns the one signal a real user hands us.

/** Minimal ParentNode stand-in. `map` is selector → element (or null). */
function fakeRoot(map) {
  return {
    querySelector(sel) {
      return map[sel] || null
    },
    querySelectorAll(sel) {
      const el = map[sel]
      return el ? [el] : []
    },
  }
}

let captured = []
let now = 0
const _realDateNow = Date.now

beforeEach(() => {
  captured = []
  now = 1_000_000
  Date.now = () => now
  globalThis.window = {
    __hsErrorReporter: {
      capture: (rec) => captured.push(rec),
      ver: '9.9.9',
      plat: 'twitch',
    },
  }
  globalThis.location = { pathname: '/somechannel', href: 'https://twitch.tv/somechannel' }
})

afterEach(() => {
  Date.now = _realDateNow
  globalThis.window = undefined
  globalThis.location = undefined
})

/** Drive `name` past both gates: streak AND elapsed time. */
function rot(name, sel, root) {
  now += MISS_MS + 1
  for (let i = 0; i < MISS_STREAK; i++) hsQuery(name, sel, root)
}

describe('hsQuery', () => {
  test('returns the element and reports nothing while the selector matches', () => {
    const el = { tag: 'div' }
    const root = fakeRoot({ '.ok': el })
    for (let i = 0; i < 50; i++) expect(hsQuery('t:ok', '.ok', root)).toBe(el)
    expect(captured).toHaveLength(0)
  })

  test('walks a fallback array and stops at the first match', () => {
    const el = { tag: 'div' }
    const root = fakeRoot({ '.second': el })
    expect(hsQuery('t:fallback', ['.first', '.second', '.third'], root)).toBe(el)
    expect(captured).toHaveLength(0)
  })

  test('a selector that NEVER matched is never reported', () => {
    // A twitch selector on a kick page misses forever — correct, not a defect.
    const root = fakeRoot({})
    rot('t:never', '.nope', root)
    rot('t:never', '.nope', root)
    expect(captured).toHaveLength(0)
    expect(diagSnapshot().selectors['t:never'].reported).toBe(false)
  })

  test('a never-matched selector is not reported even when the path is unreadable', () => {
    // Isolates the `!lastHitAt` guard specifically. With a readable path the
    // navigation guard incidentally covers this case, so it has to be tested
    // where _path() returns the same empty string at hit-time and miss-time.
    globalThis.location = { pathname: '', href: '' }
    const root = fakeRoot({})
    rot('t:nopath', '.nope', root)
    rot('t:nopath', '.nope', root)
    expect(captured).toHaveLength(0)
  })

  test('reports once when a previously-matching selector rots', () => {
    const el = { tag: 'div' }
    const live = fakeRoot({ '.shell': el })
    const dead = fakeRoot({})
    hsQuery('t:shell', '.shell', live)
    rot('t:shell', '.shell', dead)
    expect(captured).toHaveLength(1)
    expect(captured[0].msg).toContain('selector stopped matching: t:shell')
    expect(captured[0].msg).toContain('.shell')
    expect(captured[0].stack).toBe('selector-rot:t:shell')
    expect(captured[0].type).toBe('diag')
    expect(captured[0].ver).toBe('9.9.9')
  })

  test('never reports the same selector twice', () => {
    const live = fakeRoot({ '.shell': {} })
    const dead = fakeRoot({})
    hsQuery('t:once', '.shell', live)
    rot('t:once', '.shell', dead)
    rot('t:once', '.shell', dead)
    rot('t:once', '.shell', dead)
    expect(captured).toHaveLength(1)
  })

  test('a long miss streak inside the time window does not report', () => {
    // A re-render can burn the streak in one frame. Time is the second gate.
    const live = fakeRoot({ '.shell': {} })
    const dead = fakeRoot({})
    hsQuery('t:burst', '.shell', live)
    for (let i = 0; i < MISS_STREAK * 5; i++) hsQuery('t:burst', '.shell', dead)
    expect(captured).toHaveLength(0)
  })

  test('a long elapsed time with a short streak does not report', () => {
    const live = fakeRoot({ '.shell': {} })
    const dead = fakeRoot({})
    hsQuery('t:slow', '.shell', live)
    now += MISS_MS * 10
    for (let i = 0; i < MISS_STREAK - 1; i++) hsQuery('t:slow', '.shell', dead)
    expect(captured).toHaveLength(0)
  })

  test('navigating away resets instead of accumulating', () => {
    // The selector is not gone, the page is. This is the guard that keeps SPA
    // navigation from generating a false rot report on every channel hop.
    const live = fakeRoot({ '.shell': {} })
    const dead = fakeRoot({})
    hsQuery('t:nav', '.shell', live)
    globalThis.location.pathname = '/otherchannel'
    rot('t:nav', '.shell', dead)
    rot('t:nav', '.shell', dead)
    expect(captured).toHaveLength(0)
  })

  test('a hit resets the streak', () => {
    const live = fakeRoot({ '.shell': {} })
    const dead = fakeRoot({})
    hsQuery('t:reset', '.shell', live)
    now += MISS_MS + 1
    for (let i = 0; i < MISS_STREAK - 1; i++) hsQuery('t:reset', '.shell', dead)
    hsQuery('t:reset', '.shell', live)
    rot('t:reset', '.shell', dead)
    // Streak restarted from zero at the hit, so this run reports — but only
    // after a full fresh streak, never on the leftovers from the last one.
    expect(captured).toHaveLength(1)
  })

  test('survives a throwing scope and a missing reporter', () => {
    const bad = {
      querySelector() {
        throw new Error('detached')
      },
    }
    expect(hsQuery('t:throw', '.x', bad)).toBe(null)
    globalThis.window = undefined
    const dead = fakeRoot({})
    const live = fakeRoot({ '.shell': {} })
    hsQuery('t:noreporter', '.shell', live)
    expect(() => rot('t:noreporter', '.shell', dead)).not.toThrow()
  })
})

describe('hsQueryAll', () => {
  test('returns the first selector that matches anything', () => {
    const el = { tag: 'li' }
    const root = fakeRoot({ '.b': el })
    expect(hsQueryAll('t:all', ['.a', '.b'], root)).toEqual([el])
    expect(captured).toHaveLength(0)
  })

  test('an empty result counts as a miss', () => {
    const live = fakeRoot({ '.rows': {} })
    const dead = fakeRoot({})
    hsQueryAll('t:allrot', '.rows', live)
    now += MISS_MS + 1
    for (let i = 0; i < MISS_STREAK; i++) hsQueryAll('t:allrot', '.rows', dead)
    expect(captured).toHaveLength(1)
    expect(captured[0].msg).toContain('t:allrot')
  })

  test('returns an array, never null, when nothing matches', () => {
    expect(hsQueryAll('t:empty', '.gone', fakeRoot({}))).toEqual([])
  })
})

describe('swallow', () => {
  test('counts without reporting when verbose is off', () => {
    swallow(new Error('boom'), 'unit:quiet')
    swallow(new Error('boom'), 'unit:quiet')
    expect(captured).toHaveLength(0)
    expect(diagSnapshot().swallowed['unit:quiet']).toBe(2)
  })

  test('reports when verbose is armed', () => {
    globalThis.window.__hsDiagVerbose = true
    swallow(new Error('boom'), 'unit:loud')
    expect(captured).toHaveLength(1)
    expect(captured[0].msg).toContain('swallowed at unit:loud')
    expect(captured[0].msg).toContain('boom')
  })

  test('never throws on an unreadable error', () => {
    globalThis.window.__hsDiagVerbose = true
    const hostile = {
      get message() {
        throw new Error('nope')
      },
    }
    expect(() => swallow(hostile, 'unit:hostile')).not.toThrow()
    expect(diagSnapshot().swallowed['unit:hostile']).toBe(1)
  })
})

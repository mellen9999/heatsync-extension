/**
 * Unit tests for src/lib/cleanup.js
 *
 * cleanup.js is an IIFE that installs window.heatsyncCleanup.
 * It calls bare globals: setInterval, clearInterval, setTimeout, clearTimeout,
 * requestAnimationFrame, cancelAnimationFrame, document (via _wrap stack
 * trace only — not structurally needed), performance.now (via _wrap, only
 * when window.__hsPerfTrace is set).
 *
 * Strategy: declare local stubs in setupCleanup(), eval the source in that
 * scope (so its bare globals bind to the stubs, not the shared realm), then
 * test the public API surface through window.heatsyncCleanup.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// IMPORTANT: this file must NOT mutate globalThis (setTimeout, window, etc).
// bun runs every test file in one shared realm, concurrently — a stubbed
// non-firing setTimeout left on globalThis would race the debounce/throttle
// tests in utils-extra and hang them to a 5s timeout. Instead, setupCleanup()
// declares the stubs as LOCAL consts and eval()s cleanup.js in that scope:
// direct eval resolves cleanup.js's bare `setTimeout`/`window`/`document`
// references to these locals via the lexical scope chain, so nothing leaks.

// ── stub infrastructure ──────────────────────────────────────────────────────

let nextId = 1

/** Reusable spy factory — records every call. */
function spy(returnFn) {
  const calls = []
  const fn = (...args) => {
    calls.push(args)
    return returnFn ? returnFn(...args) : undefined
  }
  fn.calls = calls
  fn.callCount = () => calls.length
  fn.calledWith = (...args) => calls.some((c) => c.every((a, i) => a === args[i]))
  fn.reset = () => {
    calls.length = 0
  }
  return fn
}

// Read once — cleanup.js is a trusted in-repo source file. It is an IIFE that
// installs window.heatsyncCleanup, so it can't be imported as a module; eval in
// a controlled lexical scope is how we load it. Test-only.
const CLEANUP_SRC = readFileSync(new URL('../src/lib/cleanup.js', import.meta.url), 'utf8')

/**
 * Load a fresh cleanup instance against local stubs and return { c, stubs }.
 *
 * The timer/raf globals, `window`, `document` and `performance` are declared as
 * LOCAL consts below; the direct eval() of cleanup.js resolves its bare-global
 * references to them through the lexical scope chain, so we never touch the
 * shared globalThis (see header note re: concurrent test files).
 */
function setupCleanup({ document: documentStub } = {}) {
  nextId = 1

  const intervalIds = new Map() // id → fn
  const timeoutIds = new Map()
  const rafIds = new Map()

  const setIntervalSpy = spy((fn) => {
    const id = nextId++
    intervalIds.set(id, fn)
    return id
  })
  const clearIntervalSpy = spy((id) => intervalIds.delete(id))
  const setTimeoutSpy = spy((fn) => {
    const id = nextId++
    timeoutIds.set(id, fn)
    return id
  })
  const clearTimeoutSpy = spy((id) => timeoutIds.delete(id))
  const requestAnimationFrameSpy = spy((fn) => {
    const id = nextId++
    rafIds.set(id, fn)
    return id
  })
  const cancelAnimationFrameSpy = spy((id) => rafIds.delete(id))

  // Lexical stubs captured by eval(CLEANUP_SRC). These consts are "unused" only to a static
  // linter — the eval'd code references them.
  // biome-ignore-start lint/correctness/noUnusedVariables: read by name from the eval'd module source
  const setInterval = setIntervalSpy
  const clearInterval = clearIntervalSpy
  const setTimeout = setTimeoutSpy
  const clearTimeout = clearTimeoutSpy
  const requestAnimationFrame = requestAnimationFrameSpy
  const cancelAnimationFrame = cancelAnimationFrameSpy
  const performance = { now: () => 0 } // perf-trace path is off
  const document = documentStub || { hidden: false }
  // fresh fake window each load → heatsyncCleanup guard never short-circuits
  const window = { __hsPerfTrace: false }
  // biome-ignore-end lint/correctness/noUnusedVariables: read by name from the eval'd module source

  // eslint-disable-next-line no-eval
  // biome-ignore lint/security/noGlobalEval: test harness evaluates the module source to assign window.heatsyncCleanup
  eval(CLEANUP_SRC) // assigns window.heatsyncCleanup using the locals above

  const stubs = {
    setIntervalSpy,
    clearIntervalSpy,
    setTimeoutSpy,
    clearTimeoutSpy,
    requestAnimationFrameSpy,
    cancelAnimationFrameSpy,
    intervalIds,
    timeoutIds,
    rafIds,
    /** Fire a registered timeout by id (simulates the OS callback) */
    fireTimeout(id) {
      const fn = timeoutIds.get(id)
      if (!fn) throw new Error(`unknown timeout id ${id}`)
      fn()
    },
    /** Fire a registered rAF by id */
    fireRaf(id) {
      const fn = rafIds.get(id)
      if (!fn) throw new Error(`unknown raf id ${id}`)
      fn()
    },
  }
  return { c: window.heatsyncCleanup, stubs }
}

/** Create a minimal fake EventTarget with spy methods. */
function fakeTarget() {
  const addSpy = spy()
  const removeSpy = spy()
  return {
    addEventListener: addSpy,
    removeEventListener: removeSpy,
    _addSpy: addSpy,
    _removeSpy: removeSpy,
  }
}

/** Create a fake MutationObserver instance with a spy disconnect. */
function fakeObserver() {
  const disconnectSpy = spy()
  return { disconnect: disconnectSpy, _disconnectSpy: disconnectSpy }
}

// ── test suite ───────────────────────────────────────────────────────────────

describe('cleanup — setInterval / clearInterval', () => {
  let stubs, c

  beforeEach(() => {
    ;({ c, stubs } = setupCleanup())
  })

  test('setInterval calls global setInterval and returns the id', () => {
    const fn = () => {}
    const id = c.setInterval(fn, 1000)
    expect(stubs.setIntervalSpy.callCount()).toBe(1)
    expect(typeof id).toBe('number')
  })

  test('clearInterval calls global clearInterval with the tracked id', () => {
    const id = c.setInterval(() => {}, 500)
    c.clearInterval(id)
    expect(stubs.clearIntervalSpy.calledWith(id)).toBe(true)
  })

  test('destroyAll calls clearInterval for every tracked interval', () => {
    const id1 = c.setInterval(() => {}, 100)
    const id2 = c.setInterval(() => {}, 200)
    const id3 = c.setInterval(() => {}, 300)
    c.destroyAll()
    expect(stubs.clearIntervalSpy.calledWith(id1)).toBe(true)
    expect(stubs.clearIntervalSpy.calledWith(id2)).toBe(true)
    expect(stubs.clearIntervalSpy.calledWith(id3)).toBe(true)
  })

  test('destroyAll empties interval tracking (no dangling refs)', () => {
    c.setInterval(() => {}, 100)
    c.setInterval(() => {}, 200)
    c.destroyAll()
    // second destroyAll should call clearInterval 0 additional times
    const countBefore = stubs.clearIntervalSpy.callCount()
    c.destroyAll()
    expect(stubs.clearIntervalSpy.callCount()).toBe(countBefore)
  })

  test('clearInterval removes from tracking so destroyAll skips it', () => {
    const id = c.setInterval(() => {}, 100)
    c.clearInterval(id)
    stubs.clearIntervalSpy.reset()
    c.destroyAll()
    expect(stubs.clearIntervalSpy.callCount()).toBe(0)
  })
})

describe('cleanup — setIntervalIfVisible', () => {
  let stubs, c

  beforeEach(() => {
    // setIntervalIfVisible checks document.hidden
    ;({ c, stubs } = setupCleanup({ document: { hidden: false } }))
  })

  test('setIntervalIfVisible registers a tracked interval', () => {
    const id = c.setIntervalIfVisible(() => {}, 1000)
    expect(stubs.setIntervalSpy.callCount()).toBe(1)
    expect(typeof id).toBe('number')
  })

  test('destroyAll clears visible-only intervals too', () => {
    const id = c.setIntervalIfVisible(() => {}, 500)
    c.destroyAll()
    expect(stubs.clearIntervalSpy.calledWith(id)).toBe(true)
  })
})

describe('cleanup — setTimeout / clearTimeout', () => {
  let stubs, c

  beforeEach(() => {
    ;({ c, stubs } = setupCleanup())
  })

  test('setTimeout calls global setTimeout and returns the id', () => {
    const id = c.setTimeout(() => {}, 1000)
    expect(stubs.setTimeoutSpy.callCount()).toBe(1)
    expect(typeof id).toBe('number')
  })

  test('clearTimeout calls global clearTimeout with the tracked id', () => {
    const id = c.setTimeout(() => {}, 500)
    c.clearTimeout(id)
    expect(stubs.clearTimeoutSpy.calledWith(id)).toBe(true)
  })

  test('destroyAll calls clearTimeout for every pending timeout', () => {
    const id1 = c.setTimeout(() => {}, 100)
    const id2 = c.setTimeout(() => {}, 200)
    c.destroyAll()
    expect(stubs.clearTimeoutSpy.calledWith(id1)).toBe(true)
    expect(stubs.clearTimeoutSpy.calledWith(id2)).toBe(true)
  })

  test('destroyAll empties timeout tracking (no dangling refs)', () => {
    c.setTimeout(() => {}, 100)
    c.destroyAll()
    const countBefore = stubs.clearTimeoutSpy.callCount()
    c.destroyAll()
    expect(stubs.clearTimeoutSpy.callCount()).toBe(countBefore)
  })

  test('auto-untrack: fired timeout is removed — destroyAll does not double-clear it', () => {
    const id = c.setTimeout(() => {}, 50)
    // simulate the timer firing (the inner wrapper calls _timeouts.delete)
    stubs.fireTimeout(id)
    stubs.clearTimeoutSpy.reset()
    c.destroyAll()
    // the fired timeout should NOT appear in destroyAll's clearTimeout calls
    expect(stubs.clearTimeoutSpy.calledWith(id)).toBe(false)
  })

  test('clearTimeout removes from tracking so destroyAll skips it', () => {
    const id = c.setTimeout(() => {}, 100)
    c.clearTimeout(id)
    stubs.clearTimeoutSpy.reset()
    c.destroyAll()
    expect(stubs.clearTimeoutSpy.callCount()).toBe(0)
  })
})

describe('cleanup — MutationObserver (trackObserver / untrackObserver)', () => {
  let c

  beforeEach(() => {
    ;({ c } = setupCleanup())
  })

  test('trackObserver returns the observer and does not call disconnect', () => {
    const obs = fakeObserver()
    const ret = c.trackObserver(obs)
    expect(ret).toBe(obs)
    expect(obs._disconnectSpy.callCount()).toBe(0)
  })

  test('untrackObserver calls disconnect and removes from tracking', () => {
    const obs = fakeObserver()
    c.trackObserver(obs)
    c.untrackObserver(obs)
    expect(obs._disconnectSpy.callCount()).toBe(1)
  })

  test('destroyAll calls disconnect on every tracked observer', () => {
    const obs1 = fakeObserver()
    const obs2 = fakeObserver()
    const obs3 = fakeObserver()
    c.trackObserver(obs1)
    c.trackObserver(obs2)
    c.trackObserver(obs3)
    c.destroyAll()
    expect(obs1._disconnectSpy.callCount()).toBe(1)
    expect(obs2._disconnectSpy.callCount()).toBe(1)
    expect(obs3._disconnectSpy.callCount()).toBe(1)
  })

  test('destroyAll empties observer set (no dangling refs)', () => {
    const obs = fakeObserver()
    c.trackObserver(obs)
    c.destroyAll()
    obs._disconnectSpy.reset()
    c.destroyAll()
    expect(obs._disconnectSpy.callCount()).toBe(0)
  })

  test('untrackObserver before destroyAll prevents double-disconnect', () => {
    const obs = fakeObserver()
    c.trackObserver(obs)
    c.untrackObserver(obs)
    c.destroyAll()
    expect(obs._disconnectSpy.callCount()).toBe(1)
  })

  test('untrackObserver with null/undefined is safe (no throw)', () => {
    expect(() => c.untrackObserver(null)).not.toThrow()
    expect(() => c.untrackObserver(undefined)).not.toThrow()
  })

  test('observer with throwing disconnect does not abort destroyAll', () => {
    const badObs = {
      disconnect() {
        throw new Error('boom')
      },
    }
    const goodObs = fakeObserver()
    c.trackObserver(badObs)
    c.trackObserver(goodObs)
    expect(() => c.destroyAll()).not.toThrow()
    expect(goodObs._disconnectSpy.callCount()).toBe(1)
  })
})

describe('cleanup — addEventListener (trackListener / untrackListener)', () => {
  let c

  beforeEach(() => {
    ;({ c } = setupCleanup())
  })

  test('trackListener calls target.addEventListener with the right args', () => {
    const t = fakeTarget()
    const handler = () => {}
    c.trackListener(t, 'click', handler)
    expect(t._addSpy.callCount()).toBe(1)
    expect(t._addSpy.calls[0][0]).toBe('click')
    expect(t._addSpy.calls[0][1]).toBe(handler)
  })

  test('trackListener passes options through to addEventListener', () => {
    const t = fakeTarget()
    const handler = () => {}
    const opts = { capture: true, passive: true }
    c.trackListener(t, 'scroll', handler, opts)
    expect(t._addSpy.calls[0][2]).toBe(opts)
  })

  test('untrackListener calls removeEventListener with matching target/type/handler/options', () => {
    const t = fakeTarget()
    const handler = () => {}
    const opts = { capture: true }
    c.trackListener(t, 'keydown', handler, opts)
    c.untrackListener(t, 'keydown', handler)
    expect(t._removeSpy.callCount()).toBe(1)
    expect(t._removeSpy.calls[0][0]).toBe('keydown')
    expect(t._removeSpy.calls[0][1]).toBe(handler)
    // options stored at track time should be passed to removeEventListener
    expect(t._removeSpy.calls[0][2]).toBe(opts)
  })

  test('destroyAll calls removeEventListener on every tracked listener', () => {
    const t1 = fakeTarget()
    const t2 = fakeTarget()
    const h1 = () => {}
    const h2 = () => {}
    c.trackListener(t1, 'click', h1)
    c.trackListener(t2, 'resize', h2)
    c.destroyAll()
    expect(t1._removeSpy.callCount()).toBe(1)
    expect(t2._removeSpy.callCount()).toBe(1)
  })

  test('destroyAll empties listener array (no dangling refs)', () => {
    const t = fakeTarget()
    c.trackListener(t, 'click', () => {})
    c.destroyAll()
    t._removeSpy.reset()
    c.destroyAll()
    expect(t._removeSpy.callCount()).toBe(0)
  })

  test('untrackListener removes only the matching entry when multiple are registered', () => {
    const t = fakeTarget()
    const h1 = () => {}
    const h2 = () => {}
    c.trackListener(t, 'click', h1)
    c.trackListener(t, 'click', h2)
    c.untrackListener(t, 'click', h1)
    // h2 should still be cleaned up by destroyAll
    t._removeSpy.reset()
    c.destroyAll()
    expect(t._removeSpy.callCount()).toBe(1)
    expect(t._removeSpy.calls[0][1]).toBe(h2)
  })

  test('trackListener with null target/event/handler is a no-op (no throw)', () => {
    expect(() => c.trackListener(null, 'click', () => {})).not.toThrow()
    expect(() => c.trackListener(fakeTarget(), null, () => {})).not.toThrow()
    expect(() => c.trackListener(fakeTarget(), 'click', null)).not.toThrow()
  })

  test('addEventListener alias works identically to trackListener', () => {
    const t = fakeTarget()
    const h = () => {}
    c.addEventListener(t, 'focus', h)
    expect(t._addSpy.callCount()).toBe(1)
    c.destroyAll()
    expect(t._removeSpy.callCount()).toBe(1)
  })

  test('removeEventListener alias works identically to untrackListener', () => {
    const t = fakeTarget()
    const h = () => {}
    c.trackListener(t, 'blur', h)
    c.removeEventListener(t, 'blur', h)
    expect(t._removeSpy.callCount()).toBe(1)
  })
})

describe('cleanup — raf / cancelRaf', () => {
  let stubs, c

  beforeEach(() => {
    ;({ c, stubs } = setupCleanup())
  })

  test('raf calls requestAnimationFrame and returns an id', () => {
    const id = c.raf(() => {})
    expect(stubs.requestAnimationFrameSpy.callCount()).toBe(1)
    expect(typeof id).toBe('number')
  })

  test('cancelRaf calls cancelAnimationFrame with the id', () => {
    const id = c.raf(() => {})
    c.cancelRaf(id)
    expect(stubs.cancelAnimationFrameSpy.calledWith(id)).toBe(true)
  })

  test('destroyAll calls cancelAnimationFrame for pending rafs', () => {
    const id1 = c.raf(() => {})
    const id2 = c.raf(() => {})
    c.destroyAll()
    expect(stubs.cancelAnimationFrameSpy.calledWith(id1)).toBe(true)
    expect(stubs.cancelAnimationFrameSpy.calledWith(id2)).toBe(true)
  })

  test('auto-untrack: fired rAF is removed — destroyAll does not double-cancel it', () => {
    const id = c.raf(() => {})
    stubs.fireRaf(id)
    stubs.cancelAnimationFrameSpy.reset()
    c.destroyAll()
    expect(stubs.cancelAnimationFrameSpy.calledWith(id)).toBe(false)
  })

  test('destroyAll empties raf set (no dangling refs)', () => {
    c.raf(() => {})
    c.destroyAll()
    const countBefore = stubs.cancelAnimationFrameSpy.callCount()
    c.destroyAll()
    expect(stubs.cancelAnimationFrameSpy.callCount()).toBe(countBefore)
  })
})

describe('cleanup — destroyAll bulk + idempotency', () => {
  let stubs, c

  beforeEach(() => {
    ;({ c, stubs } = setupCleanup({ document: { hidden: false } }))
  })

  test('destroyAll with no tracked resources is safe (no throw)', () => {
    expect(() => c.destroyAll()).not.toThrow()
  })

  test('double destroyAll is idempotent (no throw, no second calls)', () => {
    const t = fakeTarget()
    const obs = fakeObserver()
    c.setInterval(() => {}, 100)
    c.setTimeout(() => {}, 200)
    c.trackObserver(obs)
    c.trackListener(t, 'click', () => {})
    c.raf(() => {})

    c.destroyAll()
    // capture counts after first destroyAll
    const ci = stubs.clearIntervalSpy.callCount()
    const ct = stubs.clearTimeoutSpy.callCount()
    const dc = obs._disconnectSpy.callCount()
    const rv = t._removeSpy.callCount()
    const ca = stubs.cancelAnimationFrameSpy.callCount()

    expect(() => c.destroyAll()).not.toThrow()

    // second call must not trigger additional work
    expect(stubs.clearIntervalSpy.callCount()).toBe(ci)
    expect(stubs.clearTimeoutSpy.callCount()).toBe(ct)
    expect(obs._disconnectSpy.callCount()).toBe(dc)
    expect(t._removeSpy.callCount()).toBe(rv)
    expect(stubs.cancelAnimationFrameSpy.callCount()).toBe(ca)
  })

  test('destroyAll clears ALL resource types in one call', () => {
    const t = fakeTarget()
    const obs1 = fakeObserver()
    const obs2 = fakeObserver()

    c.setInterval(() => {}, 100)
    c.setIntervalIfVisible(() => {}, 200)
    c.setTimeout(() => {}, 300)
    c.raf(() => {})
    c.trackObserver(obs1)
    c.trackObserver(obs2)
    c.trackListener(t, 'click', () => {})
    c.trackListener(t, 'scroll', () => {})

    c.destroyAll()

    expect(stubs.clearIntervalSpy.callCount()).toBe(2)
    expect(stubs.clearTimeoutSpy.callCount()).toBe(1)
    expect(stubs.cancelAnimationFrameSpy.callCount()).toBe(1)
    expect(obs1._disconnectSpy.callCount()).toBe(1)
    expect(obs2._disconnectSpy.callCount()).toBe(1)
    expect(t._removeSpy.callCount()).toBe(2)
  })

  test('listener with throwing removeEventListener does not abort destroyAll', () => {
    const badTarget = {
      addEventListener: () => {},
      removeEventListener() {
        throw new Error('DOM gone')
      },
    }
    const goodTarget = fakeTarget()
    c.trackListener(badTarget, 'click', () => {})
    c.trackListener(goodTarget, 'keyup', () => {})
    expect(() => c.destroyAll()).not.toThrow()
    expect(goodTarget._removeSpy.callCount()).toBe(1)
  })
})

// ── potential leak / bug notes ───────────────────────────────────────────────
//
// POTENTIAL LEAK: _listeners is iterated in reverse and spliced in
// _untrackListener, which is correct for reverse iteration. However
// _trackListener appends duplicates: if the same (target, event, handler)
// is registered twice, _untrackListener removes ALL matching entries (the
// reverse scan splices every match), but _destroyAll iterates the full
// array and calls removeEventListener once per entry including duplicates.
// A caller that tracks the same handler twice will issue two
// removeEventListener calls on destroyAll — harmless to the DOM but
// indicates no de-dup guard exists.
//
// POTENTIAL LEAK: no scope/signal grouping exists. There is a single global
// _intervals/_timeouts/_observers/_listeners/_rafs pool. Any component that
// calls destroyAll() tears down ALL tracked resources across every component
// in the content script, not just its own. There is no per-component cleanup
// scope. This is by design for a nuclear teardown scenario but means partial
// cleanup is not supported.

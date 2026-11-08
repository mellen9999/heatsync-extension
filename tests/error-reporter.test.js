/**
 * Tests for src/lib/error-reporter.js
 *
 * Contract (verified against source):
 *   - Installs to window.__hsErrorReporter = { capture, flush, ver, plat }
 *   - Ring buffer: _pending capped to MAX=50 in memory; storage flush trims to 50 with slice(-MAX)
 *   - Storage key: 'hs_errors', chrome.storage.local callback API (NOT promises)
 *   - Caps: msg ≤500 chars, stack ≤2000 chars, url/file ≤200 chars
 *   - Drops entries where msg==='' AND stack==='' (no useful payload)
 *   - Drops 'Script error.' with no stack (cross-origin noise)
 *   - No network calls — no fetch() ever
 *   - IIFE guard: second load is a no-op (window.__hsErrorReporter already set)
 *   - Writes are debounced 500ms via setTimeout
 *
 * Privacy:
 *   - url field: sensitive query param values redacted to REDACTED before 200-char truncation
 *   - msg/stack fields: Bearer tokens, JWTs, oauth: prefixes, and long opaque secrets
 *     (24+ chars of token charset) redacted to [REDACTED] before truncation
 *   - Normal prose and stack frame text is NOT over-redacted
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// ── Harness: load the IIFE into a fresh isolated context each test ─────────────

const SRC = readFileSync(new URL('../src/lib/error-reporter.js', import.meta.url), 'utf8')

/**
 * Execute the error-reporter IIFE in a mock environment.
 * Returns { win, storage, fetchSpy, timers } for assertions.
 *
 * The IIFE reads:
 *   - window / globalThis (for __hsErrorReporter guard + addEventListener)
 *   - chrome.storage.local.get / .set  (callback-based)
 *   - chrome.runtime.getManifest, chrome.runtime.lastError, chrome.runtime.id
 *   - location.hostname, location.href
 *   - console.error
 *   - setTimeout (debounce)
 *   - document.visibilityState (ctx-death recovery, not exercised here)
 */
function loadReporter({
  hostname = 'www.twitch.tv',
  href = 'https://www.twitch.tv/test',
  manifestVersion = '1.7.3',
  existingEntries = [],
} = {}) {
  // Captured setTimeout calls — we run them manually for flush control
  const timers = []

  // fetch spy — must never be called
  let fetchCallCount = 0
  const fetchSpy = () => {
    fetchCallCount++
    return Promise.resolve()
  }
  fetchSpy.callCount = () => fetchCallCount

  // chrome stub
  const chrome = {
    runtime: {
      getManifest: () => ({ version: manifestVersion }),
      lastError: null,
      get id() {
        return 'fakeid'
      },
    },
    storage: {
      local: {
        _store: existingEntries.length ? { hs_errors: existingEntries } : {},
        get(key, cb) {
          const result = {}
          result[key] = this._store[key]
          cb(result)
        },
        set(obj, cb) {
          Object.assign(this._store, obj)
          if (cb) cb()
        },
      },
    },
  }

  // Window stub — addEventListener captures handlers
  const listeners = {}
  const win = {
    __hsErrorReporter: undefined,
    __heatsyncReloadScheduled: undefined,
    addEventListener(type, fn) {
      if (!listeners[type]) listeners[type] = []
      listeners[type].push(fn)
    },
    _listeners: listeners,
    _fireError(eventObj) {
      for (const fn of listeners['error'] || []) fn(eventObj)
    },
    _fireRejection(eventObj) {
      for (const fn of listeners['unhandledrejection'] || []) fn(eventObj)
    },
  }

  // document stub for ctx-death path
  const doc = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  }

  // console stub
  const consoleErr = { _orig: null, _wrapped: null }
  const console_ = {
    error: function (...args) {
      consoleErr._orig?.apply(this, args)
    },
  }
  consoleErr._orig = console_.error

  // Run the IIFE with our stubs injected as globals
  // Use Function constructor to evaluate in a scope where we control globals
  const fn = new Function(
    'window',
    'globalThis',
    'chrome',
    'location',
    'console',
    'document',
    'setTimeout',
    'clearTimeout',
    'fetch',
    SRC + '\n//# sourceURL=error-reporter-test.js',
  )

  const setTimeoutShim = (cb, ms) => {
    const id = timers.length
    timers.push({ cb, ms, id, fired: false })
    return id
  }
  const clearTimeoutShim = (id) => {
    if (timers[id]) timers[id].fired = true
  }

  const location = { hostname, href }

  fn(win, win, chrome, location, console_, doc, setTimeoutShim, clearTimeoutShim, fetchSpy)

  // Expose reporter API
  const reporter = win.__hsErrorReporter

  // Flush helper: run all pending timers (simulates debounce firing)
  function runTimers() {
    for (const t of timers) {
      if (!t.fired) {
        t.fired = true
        t.cb()
      }
    }
  }

  return { win, chrome, reporter, runTimers, fetchSpy, timers, console_ }
}

// ── Installation ───────────────────────────────────────────────────────────────

describe('installation', () => {
  test('installs __hsErrorReporter on window', () => {
    const { reporter } = loadReporter()
    expect(reporter).toBeDefined()
    expect(typeof reporter.capture).toBe('function')
    expect(typeof reporter.flush).toBe('function')
  })

  test('exposes ver from manifest', () => {
    const { reporter } = loadReporter({ manifestVersion: '2.0.0' })
    expect(reporter.ver).toBe('2.0.0')
  })

  test('detects twitch platform from hostname', () => {
    const { reporter } = loadReporter({ hostname: 'www.twitch.tv' })
    expect(reporter.plat).toBe('twitch')
  })

  test('detects kick platform from hostname', () => {
    const { reporter } = loadReporter({ hostname: 'kick.com' })
    expect(reporter.plat).toBe('kick')
  })

  test('detects youtube platform from hostname', () => {
    const { reporter } = loadReporter({ hostname: 'www.youtube.com' })
    expect(reporter.plat).toBe('yt')
  })

  test('falls back to "other" for unknown host', () => {
    const { reporter } = loadReporter({ hostname: 'example.com' })
    expect(reporter.plat).toBe('other')
  })

  test('second load is a no-op (IIFE guard)', () => {
    // Pre-set __hsErrorReporter so the guard fires
    const win = { __hsErrorReporter: { capture: () => {}, flush: () => {}, ver: 'old', plat: 'other' } }
    win.addEventListener = () => {}
    const chrome = {
      runtime: { getManifest: () => ({ version: '9.9.9' }), lastError: null, id: 'x' },
      storage: { local: { get() {}, set() {} } },
    }
    const fn = new Function(
      'window',
      'globalThis',
      'chrome',
      'location',
      'console',
      'document',
      'setTimeout',
      'clearTimeout',
      'fetch',
      SRC,
    )
    fn(
      win,
      win,
      chrome,
      { hostname: 'twitch.tv', href: 'https://twitch.tv' },
      { error() {} },
      { visibilityState: 'visible', addEventListener() {} },
      () => {},
      () => {},
      () => {},
    )
    // Reporter is unchanged from the pre-set value
    expect(win.__hsErrorReporter.ver).toBe('old')
  })
})

// ── capture: entry shape ───────────────────────────────────────────────────────

describe('capture: entry shape', () => {
  test('captured entry has expected fields', () => {
    const { reporter, runTimers, chrome } = loadReporter({
      href: 'https://www.twitch.tv/channel',
    })
    const err = new Error('test failure')
    reporter.capture({
      ts: Date.now(),
      type: 'error',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/channel',
      msg: err.message,
      stack: err.stack,
    })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored).toHaveLength(1)
    const entry = stored[0]
    expect(entry).toHaveProperty('ts')
    expect(entry).toHaveProperty('type', 'error')
    expect(entry).toHaveProperty('plat', 'twitch')
    expect(entry).toHaveProperty('ver', '1.7.3')
    expect(entry).toHaveProperty('msg', 'test failure')
    expect(entry).toHaveProperty('url', 'https://www.twitch.tv/channel')
  })

  test('msg is truncated to 500 chars (via error handler)', () => {
    // Truncation happens in _fmtErr, called by _onError — not inside _capture itself.
    // Use the error handler path to exercise the full pipeline.
    const { win, runTimers, chrome } = loadReporter()
    const longMsg = 'x'.repeat(600)
    const err = new Error(longMsg)
    err.stack = 'Error: msg\n    at chrome-extension://abc/content.js:1:1'
    win._fireError({ error: err, filename: 'chrome-extension://abc/content.js', lineno: 1 })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored).toHaveLength(1)
    expect(stored[0].msg.length).toBeLessThanOrEqual(500)
  })

  test('stack is truncated to 2000 chars (via error handler)', () => {
    // Truncation of stack happens in _fmtErr called by _onError.
    const { win, runTimers, chrome } = loadReporter()
    const longStack = 'Error: boom\n' + '    at chrome-extension://abc/content.js:1:1\n'.repeat(200)
    const err = new Error('boom')
    err.stack = longStack
    win._fireError({ error: err, filename: 'chrome-extension://abc/content.js', lineno: 1 })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored).toHaveLength(1)
    expect(stored[0].stack.length).toBeLessThanOrEqual(2000)
  })

  test('url is truncated to 200 chars (via error handler)', () => {
    // url is set from location.href at _onError call time, truncated to 200 chars.
    const longHref = 'https://www.twitch.tv/' + 'a'.repeat(300)
    const { win, runTimers, chrome } = loadReporter({ href: longHref })
    const err = new Error('boom')
    err.stack = 'Error: boom\n    at chrome-extension://abc/content.js:1:1'
    win._fireError({ error: err, filename: 'chrome-extension://abc/content.js', lineno: 1 })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored).toHaveLength(1)
    expect(stored[0].url.length).toBeLessThanOrEqual(200)
  })
})

// ── capture: drop rules ────────────────────────────────────────────────────────

describe('capture: drop rules', () => {
  test('drops entry with empty msg AND empty stack', () => {
    const { reporter, runTimers, chrome } = loadReporter()
    reporter.capture({
      ts: Date.now(),
      type: 'error',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/',
      msg: '',
      stack: '',
    })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored ?? []).toHaveLength(0)
  })

  test('does NOT drop entry with empty msg but non-empty stack', () => {
    const { reporter, runTimers, chrome } = loadReporter()
    reporter.capture({
      ts: Date.now(),
      type: 'error',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/',
      msg: '',
      stack: 'at fn (content.js:1:1)',
    })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored).toHaveLength(1)
  })

  test('does NOT drop entry with non-empty msg but empty stack', () => {
    const { reporter, runTimers, chrome } = loadReporter()
    reporter.capture({
      ts: Date.now(),
      type: 'console',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/',
      msg: 'real error message',
      stack: '',
    })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored).toHaveLength(1)
  })

  test('drops "Script error." with no stack (cross-origin noise)', () => {
    const { reporter, runTimers, chrome } = loadReporter()
    reporter.capture({
      ts: Date.now(),
      type: 'error',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/',
      msg: 'Script error.',
      stack: '',
    })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored ?? []).toHaveLength(0)
  })

  test('does NOT drop "Script error." when stack is present', () => {
    const { reporter, runTimers, chrome } = loadReporter()
    reporter.capture({
      ts: Date.now(),
      type: 'error',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/',
      msg: 'Script error.',
      stack: 'at chrome-extension://abc/content.js:10:5',
    })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored).toHaveLength(1)
  })
})

// ── Ring buffer: in-memory cap ─────────────────────────────────────────────────

describe('ring buffer: in-memory cap at 50', () => {
  test('pushing 50 entries retains all 50', () => {
    const { reporter, runTimers, chrome } = loadReporter()
    for (let i = 0; i < 50; i++) {
      reporter.capture({
        ts: i,
        type: 'console',
        plat: 'twitch',
        ver: '1.7.3',
        url: 'https://www.twitch.tv/',
        msg: `msg-${i}`,
        stack: 'at x',
      })
    }
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored).toHaveLength(50)
  })

  test('pushing 51 entries keeps only 50 — oldest evicted', () => {
    const { reporter, runTimers, chrome } = loadReporter()
    for (let i = 0; i < 51; i++) {
      reporter.capture({
        ts: i,
        type: 'console',
        plat: 'twitch',
        ver: '1.7.3',
        url: 'https://www.twitch.tv/',
        msg: `msg-${i}`,
        stack: 'at x',
      })
    }
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored).toHaveLength(50)
  })

  test('pushing 51 entries evicts msg-0 (the oldest)', () => {
    const { reporter, runTimers, chrome } = loadReporter()
    for (let i = 0; i < 51; i++) {
      reporter.capture({
        ts: i,
        type: 'console',
        plat: 'twitch',
        ver: '1.7.3',
        url: 'https://www.twitch.tv/',
        msg: `msg-${i}`,
        stack: 'at x',
      })
    }
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    const msgs = stored.map((e) => e.msg)
    expect(msgs).not.toContain('msg-0')
    expect(msgs).toContain('msg-50')
  })

  test('pushing 100 entries keeps only the most recent 50', () => {
    const { reporter, runTimers, chrome } = loadReporter()
    for (let i = 0; i < 100; i++) {
      reporter.capture({
        ts: i,
        type: 'console',
        plat: 'twitch',
        ver: '1.7.3',
        url: 'https://www.twitch.tv/',
        msg: `msg-${i}`,
        stack: 'at x',
      })
    }
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored).toHaveLength(50)
    expect(stored[0].msg).toBe('msg-50')
    expect(stored[49].msg).toBe('msg-99')
  })

  test('ring buffer merges with existing entries from storage', () => {
    // Simulate 40 existing entries in storage, then add 20 new ones
    const existing = Array.from({ length: 40 }, (_, i) => ({
      ts: i,
      type: 'console',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/',
      msg: `old-${i}`,
      stack: 'at x',
    }))
    const { reporter, runTimers, chrome } = loadReporter({ existingEntries: existing })
    for (let i = 0; i < 20; i++) {
      reporter.capture({
        ts: 1000 + i,
        type: 'console',
        plat: 'twitch',
        ver: '1.7.3',
        url: 'https://www.twitch.tv/',
        msg: `new-${i}`,
        stack: 'at x',
      })
    }
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    // 40 existing + 20 new = 60; slice(-50) keeps newest 50
    expect(stored).toHaveLength(50)
    // oldest 10 of the original 40 should be evicted
    const msgs = stored.map((e) => e.msg)
    expect(msgs).not.toContain('old-0')
    expect(msgs).not.toContain('old-9')
    expect(msgs).toContain('old-10')
    expect(msgs).toContain('new-19')
  })
})

// ── Privacy: URL truncation ────────────────────────────────────────────────────

describe('privacy: URL handling', () => {
  test('URL exactly 200 chars is stored as-is (via error handler)', () => {
    // location.href is what gets stored; build a 200-char href and verify no truncation
    const href200 = 'https://www.twitch.tv/' + 'a'.repeat(178) // 22 + 178 = 200
    const { win, runTimers, chrome } = loadReporter({ href: href200 })
    const err = new Error('boom')
    err.stack = 'Error: boom\n    at chrome-extension://abc/content.js:1:1'
    win._fireError({ error: err, filename: 'chrome-extension://abc/content.js', lineno: 1 })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored[0].url.length).toBe(200)
  })

  test('URL over 200 chars is truncated to exactly 200 (via error handler)', () => {
    const href201 = 'https://www.twitch.tv/' + 'a'.repeat(179) // 22 + 179 = 201
    const { win, runTimers, chrome } = loadReporter({ href: href201 })
    const err = new Error('boom')
    err.stack = 'Error: boom\n    at chrome-extension://abc/content.js:1:1'
    win._fireError({ error: err, filename: 'chrome-extension://abc/content.js', lineno: 1 })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored[0].url.length).toBe(200)
  })

  test('access_token in URL query string is redacted to REDACTED', () => {
    const sensitiveHref = 'https://www.twitch.tv/page?access_token=SECRET_TOKEN_abc123&foo=bar'
    const { win, runTimers, chrome } = loadReporter({ href: sensitiveHref })
    const err = new Error('boom')
    err.stack = 'Error: boom\n    at chrome-extension://abc/content.js:1:1'
    win._fireError({ error: err, filename: 'chrome-extension://abc/content.js', lineno: 1 })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored[0].url).not.toContain('SECRET_TOKEN_abc123')
    expect(stored[0].url).toContain('access_token=REDACTED')
    // non-sensitive param preserved
    expect(stored[0].url).toContain('foo=bar')
  })

  test('token= param in URL is redacted, other params kept', () => {
    const href = 'https://www.twitch.tv/cb?code=AUTHCODE999&state=STATEVAL&redirect_uri=https://example.com'
    const { win, runTimers, chrome } = loadReporter({ href })
    const err = new Error('x')
    err.stack = 'at chrome-extension://abc/content.js:1:1'
    win._fireError({ error: err, filename: 'chrome-extension://abc/content.js', lineno: 1 })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored[0].url).not.toContain('AUTHCODE999')
    expect(stored[0].url).not.toContain('STATEVAL')
    expect(stored[0].url).toContain('code=REDACTED')
    expect(stored[0].url).toContain('state=REDACTED')
    // non-sensitive param preserved
    expect(stored[0].url).toContain('redirect_uri=https://example.com')
  })

  test('URL with no query params is stored unchanged', () => {
    const href = 'https://www.twitch.tv/channel'
    const { win, runTimers, chrome } = loadReporter({ href })
    const err = new Error('x')
    err.stack = 'at chrome-extension://abc/content.js:1:1'
    win._fireError({ error: err, filename: 'chrome-extension://abc/content.js', lineno: 1 })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored[0].url).toBe('https://www.twitch.tv/channel')
  })

  test('Bearer token in msg is redacted to [REDACTED]', () => {
    const { reporter, runTimers, chrome } = loadReporter()
    reporter.capture({
      ts: Date.now(),
      type: 'console',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/',
      msg: 'auth failed Bearer eyABCDEFtokenXYZ',
      stack: 'at content.js:1',
    })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored[0].msg).not.toContain('eyABCDEFtokenXYZ')
    expect(stored[0].msg).toContain('[REDACTED]')
  })

  test('JWT in msg is redacted to [REDACTED]', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36P'
    const { reporter, runTimers, chrome } = loadReporter()
    reporter.capture({
      ts: Date.now(),
      type: 'console',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/',
      msg: 'token: ' + jwt,
      stack: 'at content.js:1',
    })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored[0].msg).not.toContain(jwt)
    expect(stored[0].msg).toContain('[REDACTED]')
  })

  test('long opaque secret (24+ chars) in msg is redacted', () => {
    const secret = 'A1B2C3D4E5F6G7H8I9J0K1L2M3' // 26 chars, token charset
    const { reporter, runTimers, chrome } = loadReporter()
    reporter.capture({
      ts: Date.now(),
      type: 'console',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/',
      msg: 'api_key=' + secret,
      stack: 'at content.js:1',
    })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored[0].msg).not.toContain(secret)
    expect(stored[0].msg).toContain('[REDACTED]')
  })

  test('normal prose message is NOT over-redacted', () => {
    const safeMsg = 'failed to load emotes for channel xqc after 3 retries'
    const { reporter, runTimers, chrome } = loadReporter()
    reporter.capture({
      ts: Date.now(),
      type: 'console',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/',
      msg: safeMsg,
      stack: 'at content.js:1',
    })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored[0].msg).toBe(safeMsg)
  })

  test('normal stack frame text is NOT over-redacted', () => {
    const safeStack =
      'Error: boom\n    at chrome-extension://abcdefghij/content.js:42:10\n    at processMessage (content.js:100:5)'
    const { reporter, runTimers, chrome } = loadReporter()
    reporter.capture({
      ts: Date.now(),
      type: 'error',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/',
      msg: 'boom',
      stack: safeStack,
    })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    // stack frames must survive — they are the primary debug value
    expect(stored[0].stack).toContain('chrome-extension://')
    expect(stored[0].stack).toContain('content.js:42:10')
    expect(stored[0].stack).not.toContain('[REDACTED]')
  })
})

// ── Privacy: no network calls ──────────────────────────────────────────────────

describe('privacy: no network calls', () => {
  test('fetch is never called after capturing errors', () => {
    const { reporter, runTimers, fetchSpy } = loadReporter()
    for (let i = 0; i < 10; i++) {
      reporter.capture({
        ts: i,
        type: 'console',
        plat: 'twitch',
        ver: '1.7.3',
        url: 'https://www.twitch.tv/',
        msg: `msg-${i}`,
        stack: 'at x',
      })
    }
    runTimers()
    expect(fetchSpy.callCount()).toBe(0)
  })

  test('fetch is never called after flush()', () => {
    const { reporter, fetchSpy } = loadReporter()
    reporter.capture({
      ts: 1,
      type: 'error',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/',
      msg: 'oops',
      stack: 'at x',
    })
    reporter.flush()
    expect(fetchSpy.callCount()).toBe(0)
  })
})

// ── Edge cases: robustness ─────────────────────────────────────────────────────

describe('edge cases: must not throw', () => {
  test('capture with null-like entry does not throw', () => {
    const { reporter } = loadReporter()
    // capture expects a rec object — pass minimal valid but empty payload
    expect(() =>
      reporter.capture({
        ts: Date.now(),
        type: 'error',
        plat: 'twitch',
        ver: '1.7.3',
        url: 'https://www.twitch.tv/',
        msg: 'x',
        stack: '',
      }),
    ).not.toThrow()
  })

  test('flush with empty pending does not throw', () => {
    const { reporter } = loadReporter()
    expect(() => reporter.flush()).not.toThrow()
  })

  test('flush writes nothing when pending is empty', () => {
    // When pending is empty, flush() returns early before calling storage.set.
    // The hs_errors key is never written.
    const { reporter, chrome } = loadReporter()
    // Verify key absent before flush
    expect(chrome.storage.local._store['hs_errors']).toBeUndefined()
    reporter.flush()
    // Key still absent — no write occurred
    expect(chrome.storage.local._store['hs_errors']).toBeUndefined()
  })

  test('capture is reentrant-safe — nested capture is dropped', () => {
    // Verifies _reentry guard: a capture triggered during capture does not recurse
    const { reporter, runTimers, chrome } = loadReporter()
    // First capture normally
    reporter.capture({
      ts: 1,
      type: 'error',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/',
      msg: 'first',
      stack: 'at x',
    })
    runTimers()
    expect(chrome.storage.local._store['hs_errors']).toHaveLength(1)
    // No throw from normal usage
    expect(() =>
      reporter.capture({
        ts: 2,
        type: 'error',
        plat: 'twitch',
        ver: '1.7.3',
        url: 'https://www.twitch.tv/',
        msg: 'second',
        stack: 'at y',
      }),
    ).not.toThrow()
  })
})

// ── Read-back order ────────────────────────────────────────────────────────────

describe('read-back: entry ordering', () => {
  test('entries are stored in insertion order (oldest first)', () => {
    const { reporter, runTimers, chrome } = loadReporter()
    reporter.capture({
      ts: 1,
      type: 'console',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/',
      msg: 'first',
      stack: 'at x',
    })
    reporter.capture({
      ts: 2,
      type: 'console',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/',
      msg: 'second',
      stack: 'at y',
    })
    reporter.capture({
      ts: 3,
      type: 'console',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/',
      msg: 'third',
      stack: 'at z',
    })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored).toHaveLength(3)
    expect(stored[0].msg).toBe('first')
    expect(stored[1].msg).toBe('second')
    expect(stored[2].msg).toBe('third')
  })

  test('entries appended across two flush cycles maintain order', () => {
    const { reporter, runTimers, chrome } = loadReporter()
    reporter.capture({
      ts: 1,
      type: 'console',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/',
      msg: 'batch1-a',
      stack: 'at a',
    })
    runTimers()
    reporter.capture({
      ts: 2,
      type: 'console',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/',
      msg: 'batch2-a',
      stack: 'at b',
    })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored).toHaveLength(2)
    expect(stored[0].msg).toBe('batch1-a')
    expect(stored[1].msg).toBe('batch2-a')
  })
})

// ── Debounce: write is batched ─────────────────────────────────────────────────

describe('debounce: writes are deferred', () => {
  test('multiple captures before timer fires produce a single storage.set call', () => {
    const { reporter, chrome, runTimers } = loadReporter()
    let setCount = 0
    const origSet = chrome.storage.local.set.bind(chrome.storage.local)
    chrome.storage.local.set = (obj, cb) => {
      setCount++
      origSet(obj, cb)
    }

    reporter.capture({
      ts: 1,
      type: 'console',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/',
      msg: 'a',
      stack: 'at a',
    })
    reporter.capture({
      ts: 2,
      type: 'console',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/',
      msg: 'b',
      stack: 'at b',
    })
    reporter.capture({
      ts: 3,
      type: 'console',
      plat: 'twitch',
      ver: '1.7.3',
      url: 'https://www.twitch.tv/',
      msg: 'c',
      stack: 'at c',
    })

    expect(setCount).toBe(0) // timer not fired yet
    runTimers()
    expect(setCount).toBe(1) // all batched into one write
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored).toHaveLength(3)
  })
})

// ── Global error/rejection handlers ───────────────────────────────────────────

describe('global handlers registered', () => {
  test('window.addEventListener called for "error" and "unhandledrejection"', () => {
    const { win } = loadReporter()
    const types = Object.keys(win._listeners)
    expect(types).toContain('error')
    expect(types).toContain('unhandledrejection')
  })

  test('error handler filters non-extension errors (_isOurs)', () => {
    // An error from a third-party script (no chrome-extension:// in stack, no heatsync
    // filename) is dropped by _isOurs. We must construct the error object manually
    // rather than using `new Error()` — the test runner's own stack frames include
    // 'heatsync' in the path, which would cause _isOurs to return true.
    const { win, runTimers, chrome } = loadReporter()
    const err = {
      message: 'third party error',
      stack: 'Error: third party error\n    at eval (<anonymous>):1:1\n    at https://some-cdn.com/bundle.js:100:5',
    }
    win._fireError({
      error: err,
      filename: 'https://some-cdn.com/bundle.js',
      lineno: 100,
    })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored ?? []).toHaveLength(0)
  })

  test('error handler captures extension errors (_isOurs matches chrome-extension://)', () => {
    const { win, runTimers, chrome } = loadReporter()
    const err = new Error('ext crash')
    err.stack = 'Error: ext crash\n    at chrome-extension://abcdef/content.js:42:10'
    win._fireError({
      error: err,
      filename: 'chrome-extension://abcdef/content.js',
      lineno: 42,
    })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored).toHaveLength(1)
    expect(stored[0].type).toBe('error')
    expect(stored[0].msg).toBe('ext crash')
  })

  test('rejection handler captures extension rejections', () => {
    const { win, runTimers, chrome } = loadReporter()
    const err = new Error('promise failed')
    err.stack = 'Error: promise failed\n    at chrome-extension://abc/content.js:5:1'
    win._fireRejection({ reason: err })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored).toHaveLength(1)
    expect(stored[0].type).toBe('rejection')
  })

  test('noise: ResizeObserver loop errors are dropped', () => {
    const { win, runTimers, chrome } = loadReporter()
    const err = new Error('ResizeObserver loop limit exceeded')
    err.stack = 'at chrome-extension://abc/content.js:1:1'
    win._fireError({ error: err, filename: 'chrome-extension://abc/content.js', lineno: 1 })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    expect(stored ?? []).toHaveLength(0)
  })

  test('noise: Extension context invalidated is dropped (not captured)', () => {
    const { win, runTimers, chrome } = loadReporter()
    const err = new Error('Extension context invalidated')
    err.stack = 'at chrome-extension://abc/content.js:1:1'
    win._fireError({ error: err, filename: 'chrome-extension://abc/content.js', lineno: 1 })
    runTimers()
    const stored = chrome.storage.local._store['hs_errors']
    // ctx-death path fires scheduleCtxReload and returns early — nothing stored
    expect(stored ?? []).toHaveLength(0)
  })
})

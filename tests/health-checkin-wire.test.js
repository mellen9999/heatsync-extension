/**
 * fetchHealth's outgoing query string (chrome/background.js).
 *
 * The surface buffer is only worth anything if it reaches the wire, and this is
 * the contract with server/routes/extension-health.ts: `s` is validated there
 * against /^[a-z]{2,12}(,[a-z]{2,12}){0,4}$/ and each name counted once per
 * install per day. A drift on either side silently produces a counter that
 * reads zero forever, which is the exact failure this whole path exists to
 * stop — so the shape is asserted here rather than assumed.
 *
 * background.js is not part of the src/ build pipeline and registers listeners
 * at the top level, so it cannot be imported; its real source is sliced out and
 * evaluated against stubs, the same harness pattern tests/background-helpers.js
 * uses.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const BG_SRC = readFileSync(new URL('../chrome/background.js', import.meta.url), 'utf8')

// The server's own regex, copied deliberately: this test's job is to catch the
// two sides drifting apart, which a shared constant would hide.
const SERVER_S_RE = /^[a-z]{2,12}(,[a-z]{2,12}){0,4}$/

function sliceBetween(marker, endMarker) {
  const start = BG_SRC.indexOf(marker)
  if (start === -1) throw new Error(`marker not found: ${marker} — background.js drifted`)
  const end = BG_SRC.indexOf(endMarker, start)
  if (end === -1) throw new Error(`end marker not found: ${endMarker} — background.js drifted`)
  return BG_SRC.slice(start, end)
}

// HEALTH_URL through to fetchHealth covers the constants, getInstallId and the
// surface buffer helpers in one slice.
const PRELUDE_SRC = sliceBetween('const HEALTH_URL =', 'async function fetchHealth()')
const FETCH_HEALTH_SRC = sliceBetween('async function fetchHealth()', '\n// A cached kill/disabled')

function makeHarness({ pending = [], ok = true } = {}) {
  const store = pending.length ? { hs_surfaces_pending: [...pending] } : {}
  const urls = []
  const browser = {
    storage: {
      local: {
        get: async (keys) => {
          const out = {}
          for (const k of keys) if (k in store) out[k] = store[k]
          return out
        },
        set: async (obj) => Object.assign(store, obj),
        remove: async (k) => {
          delete store[k]
        },
      },
    },
    runtime: { getManifest: () => ({ version: '1.7.64' }) },
  }
  const fetchWithTimeout = async (url) => {
    urls.push(url)
    return {
      ok,
      json: async () => ({ v: 1, ext_min: '0.0.0', ext_hard_min: null, kill: false, disabled: [], msg: null }),
    }
  }
  const api = new Function(
    'browser',
    'fetchWithTimeout',
    'crypto',
    `${PRELUDE_SRC}\n${FETCH_HEALTH_SRC}\nreturn { fetchHealth, takePendingSurfaces }`,
  )(browser, fetchWithTimeout, { randomUUID: () => 'install-fixed-id' })
  return { ...api, urls, store }
}

describe('fetchHealth — surface names on the wire', () => {
  test('sends pending surfaces as a comma-joined s=, in the shape the server accepts', async () => {
    const h = makeHarness({ pending: ['feed', 'dm'] })
    await h.fetchHealth()
    const q = new URL(h.urls[0]).searchParams
    expect(q.get('id')).toBe('install-fixed-id')
    expect(q.get('v')).toBe('1.7.64')
    expect(q.get('s')).toBe('feed,dm')
    expect(SERVER_S_RE.test(q.get('s'))).toBe(true)
  })

  test('every allowed name at once still passes the server regex', async () => {
    const h = makeHarness({ pending: ['multichat', 'feed', 'dm', 'mentions'] })
    await h.fetchHealth()
    expect(SERVER_S_RE.test(new URL(h.urls[0]).searchParams.get('s'))).toBe(true)
  })

  test('omits s= entirely when nothing was opened', async () => {
    const h = makeHarness()
    await h.fetchHealth()
    expect(new URL(h.urls[0]).searchParams.has('s')).toBe(false)
  })

  test('a counted surface is not sent twice', async () => {
    const h = makeHarness({ pending: ['feed'] })
    await h.fetchHealth()
    await h.fetchHealth()
    expect(new URL(h.urls[1]).searchParams.has('s')).toBe(false)
  })

  // Undercounting the feed is the one direction that would mislead: it reads
  // as "nobody opened it", which is the conclusion being tested for.
  test('a failed poll keeps the names for the next one', async () => {
    const h = makeHarness({ pending: ['feed'], ok: false })
    await h.fetchHealth()
    expect(await h.takePendingSurfaces()).toEqual(['feed'])
  })
})

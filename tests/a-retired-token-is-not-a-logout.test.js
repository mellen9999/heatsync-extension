/**
 * A rejected token is a logout only when the browser's cookie agrees.
 *
 * heatsync.org reissues the session cookie when an account is unlinked and
 * retires the old token on the server. The background worker kept using its
 * copy; the next `authenticate` (a server restart reconnects every socket)
 * came back `authentication_failed`, and that was read as "logged out": the
 * stored login wiped, the socket pinned in authFailedBlock, every panel on
 * every platform saying "log in at heatsync.org first" for a browser that was
 * logged in — until the next real login (gauntlet youtube+kick row,
 * 2026-11-01). One helper, tokenAfterRejection, now decides for the socket,
 * /api/auth/me, api_fetch and api_upload alike: re-read the cookie; adopt it
 * when it moved on; a logout is only a cookie that is gone or unchanged.
 *
 * background.js is a non-ESM service-worker script (see the note atop
 * tests/background-helpers.test.js): the helper is sliced out of the real
 * source and evaluated with stubs, the call sites are asserted on the source.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'chrome', 'background.js'), 'utf8')

/** The helper's exact source text, start marker to its closing brace. */
function helperSource() {
  const start = SRC.indexOf('async function tokenAfterRejection(')
  if (start < 0) throw new Error('tokenAfterRejection marker missing from chrome/background.js')
  const end = SRC.indexOf('\n}\n', start)
  return SRC.slice(start, end + 2)
}

function harness({ cookie, throws = false } = {}) {
  const stored = []
  const browser = {
    cookies: {
      get: async () => {
        if (throws) throw new Error('no cookies permission')
        return cookie === undefined ? undefined : { value: cookie }
      },
    },
  }
  const make = new Function(
    'browser',
    'storeToken',
    'log',
    `let authToken = 'old'\n${helperSource()}\nreturn { run: tokenAfterRejection, token: () => authToken }`,
  )
  const h = make(
    browser,
    async (t) => {
      stored.push(t)
    },
    () => {},
  )
  return { ...h, stored }
}

test('the cookie moved on: the live token is adopted in memory and storage', async () => {
  const h = harness({ cookie: 'fresh' })
  expect(await h.run('old')).toBe('fresh')
  expect(h.token()).toBe('fresh')
  expect(h.stored).toEqual(['fresh'])
})

test('the cookie is the rejected token: that is a logout, nothing is adopted', async () => {
  const h = harness({ cookie: 'old' })
  expect(await h.run('old')).toBeNull()
  expect(h.token()).toBe('old')
  expect(h.stored).toEqual([])
})

test('no cookie at all, or no way to read it: a logout', async () => {
  expect(await harness({ cookie: undefined }).run('old')).toBeNull()
  expect(await harness({ throws: true }).run('old')).toBeNull()
})

/** The `case 'authentication_failed':` block, up to its break. */
function authFailedBlock() {
  const start = SRC.indexOf("case 'authentication_failed':")
  if (start < 0) throw new Error('authentication_failed case missing')
  return SRC.slice(start, SRC.indexOf('\n        break\n', start))
}

test('the socket asks the cookie before it wipes the login', () => {
  const block = authFailedBlock()
  const ask = block.indexOf('tokenAfterRejection(socketAuthToken)')
  const wipe = block.indexOf("storage.local.remove(['auth_token_encrypted', 'auth_token'])")
  expect(ask).toBeGreaterThan(-1)
  expect(wipe).toBeGreaterThan(ask)
  // the pin is set only on the logout side, and a live cookie reconnects
  expect(block.indexOf('authFailedBlock = true')).toBeGreaterThan(ask)
  expect(block).toContain('authFailedBlock = false')
  expect(block).toContain('return connectWebSocket()')
})

test('/api/auth/me asks the cookie once before it wipes the login', () => {
  const start = SRC.indexOf('async function fetchUserInfo(retried = false)')
  expect(start).toBeGreaterThan(-1)
  const body = SRC.slice(start, SRC.indexOf('\n}\n', start))
  const ask = body.indexOf('tokenAfterRejection(authToken)')
  const wipe = body.indexOf("storage.local.remove(['user_info', 'auth_token_encrypted', 'auth_token'])")
  expect(ask).toBeGreaterThan(-1)
  expect(wipe).toBeGreaterThan(ask)
  expect(body).toContain('return fetchUserInfo(true)')
})

test('every connect reads the cookie fresh, and the cookie is read in exactly two places', () => {
  const connect = SRC.slice(SRC.indexOf('async function connectWebSocket()'))
  expect(connect).toContain('await getAuthCookie({ fresh: true })')
  // getAuthCookie and tokenAfterRejection — the api_fetch / api_upload copies are gone
  const reads = SRC.match(/browser\.cookies\.get\(\{ url: 'https:\/\/heatsync\.org', name: 'auth' \}\)/g) || []
  expect(reads).toHaveLength(2)
  expect(SRC).toContain(
    'const live = await tokenAfterRejection(token)\n          if (live) ({ resp, data } = await doFetch(live))',
  )
  expect(SRC).toContain(
    'const live = await tokenAfterRejection(token)\n          if (live) ({ resp, data } = await doUpload(live))',
  )
})

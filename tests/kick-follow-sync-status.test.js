// syncKickFollows' "already followed" status guard — pinned by source
// extraction, same technique as tests/background-helpers.test.js: background.js
// is a non-ESM service-worker script that can't be safely imported (see that
// file's header comment for why), so the exact guard expression is sliced out
// of the real source by marker and evaluated in isolation. Source drift throws
// loudly instead of silently testing stale logic.
//
// heatsync-322 moved the server's "already following" response from 400 to
// 409. The extension and server deploy independently, so this guard must
// accept BOTH: 409 from a current server, 400 from one that hasn't deployed
// the fix yet (or has rolled back).

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BG_SRC = readFileSync(join(import.meta.dir, '..', 'chrome', 'background.js'), 'utf8')

const MARKER = 'if (res.ok || res.status === 409 || res.status === 400) {'
if (!BG_SRC.includes(MARKER)) {
  throw new Error(
    'kick-follow-sync-status: guard line not found in chrome/background.js — source drifted, update this test',
  )
}

const alreadyFollowedGuard = new Function('res', `return (${MARKER.slice(3, -2)})`)

describe('syncKickFollows — already-followed status guard', () => {
  test('accepts a 2xx response', () => {
    expect(alreadyFollowedGuard({ ok: true, status: 200 })).toBe(true)
  })

  test('accepts 409 (current server: already following)', () => {
    expect(alreadyFollowedGuard({ ok: false, status: 409 })).toBe(true)
  })

  test('accepts 400 (older server, pre-heatsync-322)', () => {
    expect(alreadyFollowedGuard({ ok: false, status: 400 })).toBe(true)
  })

  test('rejects a real failure (500)', () => {
    expect(alreadyFollowedGuard({ ok: false, status: 500 })).toBe(false)
  })

  test('rejects rate limiting (429) so it retries next hour', () => {
    expect(alreadyFollowedGuard({ ok: false, status: 429 })).toBe(false)
  })
})

describe('syncKickFollows — self-declares the import via a request header', () => {
  // The server can't safely infer "this is the kick mirror" from bearer auth
  // alone (the tui and chatterino plugin also authenticate with bearer
  // tokens), so the mirror declares itself explicitly instead.
  test('sends x-hs-follow-source: kick_import on the follow request', () => {
    expect(BG_SRC).toContain("'x-hs-follow-source': 'kick_import'")
  })
})

/**
 * Regression: your IDENTITY must be written the moment it is fetched.
 *
 * The bug (2026-08-07): `fetchUserInfo()` computed a correct userInfo and then
 * only assigned it to a module global, `pendingUserInfoToPersist`. That global
 * reached disk in exactly ONE place — the Promise.all tail of `initialize()`.
 * So the two paths that matter most both dropped it:
 *   - login via cookies.onChanged  → fetched identity, never persisted
 *   - the popup's refresh_all      → fetched identity, never persisted
 * and a service-worker death threw it away.
 *
 * The resulting state is the nastiest kind: `auth_token_encrypted` PRESENT,
 * `user_info` ABSENT. Every signed-out affordance in the overlay tests the
 * token, so all of them stayed hidden; every mention/reply matcher reads
 * `user_info`, so nothing matched. No red mentions, no "replied to you", no
 * mention pings — and not one word on screen explaining why. Recovery was
 * incidental: whenever the service worker next cold-started AND all seven
 * parallel fetches happened to settle.
 *
 * Second half: on 401/403 the old code removed `user_info` but LEFT the token,
 * manufacturing that same silent state on every session expiry.
 *
 * background.js cannot be imported (top-level chrome.* listeners; see
 * tests/background-helpers.test.js), so per house pattern these are
 * marker-based source-text invariants that fail loudly on drift.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { bgSource } from './bg-src.js'

const BG_SRC = bgSource()

function extractFn(name) {
  for (const marker of [`async function ${name}(`, `function ${name}(`]) {
    const start = BG_SRC.indexOf(marker)
    if (start === -1) continue
    const end = BG_SRC.indexOf('\n}', start)
    if (end === -1) break
    return BG_SRC.slice(start, end + 2)
  }
  throw new Error(`marker for ${name} not found in background.js — regression test is stale`)
}

describe('fetchUserInfo persists identity itself', () => {
  const fn = extractFn('fetchUserInfo')

  test('writes user_info to storage inside fetchUserInfo', () => {
    expect(fn).toMatch(/storage\.local\.set\(\s*\{\s*user_info/)
  })

  test('does not defer the write to a module global', () => {
    // The whole bug. Assert on CODE, not on the string: the fix's comment
    // names the old global deliberately, and a bare toContain would both
    // fail on that and dump 580KB of source into the failure output.
    const declared = /^\s*(let|var|const)\s+pendingUserInfoToPersist\b/m.test(BG_SRC)
    const assigned = /^\s*pendingUserInfoToPersist\s*=/m.test(BG_SRC)
    const read = /persist\.user_info\s*=\s*pendingUserInfoToPersist/.test(BG_SRC)
    expect({ declared, assigned, read }).toEqual({ declared: false, assigned: false, read: false })
  })

  test('identity write is awaited, not fire-and-forget', () => {
    // A service worker can be killed the instant the fetch resolves; an
    // un-awaited set is exactly the failure mode we are removing.
    expect(fn).toMatch(/await\s+browser\.storage\.local\.set\(\s*\{\s*user_info/)
  })
})

describe('an auth rejection clears the token, not just the identity', () => {
  const fn = extractFn('fetchUserInfo')

  test('401/403 removes the token alongside user_info', () => {
    const m = fn.match(/status === 401[\s\S]{0,400}?remove\(([^)]*)\)/)
    expect(m, '401/403 branch must call storage.local.remove').toBeTruthy()
    const removed = m[1]
    expect(removed).toContain('user_info')
    expect(removed).toContain('auth_token_encrypted')
  })

  test('tabs are told the session died so the signed-out UI can appear', () => {
    expect(fn).toMatch(/broadcastToTabs\(\{\s*type:\s*'auth_changed'[\s\S]{0,80}loggedIn:\s*false/)
  })

  test('a transient 5xx still keeps stale identity', () => {
    // Deliberate: a gateway blip must not log you out. The removal has to stay
    // gated on an explicit auth rejection.
    expect(fn).toMatch(/status === 401 \|\| response\.status === 403/)
  })
})

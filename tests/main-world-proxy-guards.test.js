// Regression guards for the MAIN-world privileged-proxy security controls in
// chrome/early-inject-main.js and the dev-only diagnostics in bootstrap.js.
//
// early-inject-main.js is a document_start MAIN-world IIFE (COPY_FILES, not
// bundled) that registers page-observable postMessage handlers at top level —
// it cannot be imported without a large window/document/gql stub harness (same
// constraint documented in background-helpers.test.js). So these tests combine:
//   1. a BEHAVIORAL test of the real rate-limiter, extracted from source + run
//      under a fake clock, and
//   2. STRUCTURAL assertions that each control is still wired into its handler —
//      the actual regression risk is "someone deletes the guard", which a source
//      assertion catches where a stubbed unit test can't.

import { afterAll, describe, expect, setSystemTime, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'chrome', 'early-inject-main.js'), 'utf8')
const BOOT = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'bootstrap.js'), 'utf8')

// ── Behavioral: the real _proxyAllowed sliding-window limiter ─────────────────
describe('_proxyAllowed sliding-window limiter (extracted from real source)', () => {
  const m = SRC.match(/function _proxyAllowed\(bucket\) \{[\s\S]*?\n {2}\}/)
  test('the _proxyAllowed function is present in source', () => {
    expect(m).not.toBeNull()
  })
  // Run the ACTUAL shipped function, not a re-implementation, so a semantic
  // regression in the limiter is caught here.
  const _proxyAllowed = new Function(`return (${m[0]})`)()
  afterAll(() => setSystemTime()) // restore real clock

  test('allows exactly `max` calls per window, blocks the rest', () => {
    setSystemTime(new Date(1_000_000))
    const bucket = { ts: [], windowMs: 10000, max: 10 }
    for (let i = 0; i < 10; i++) expect(_proxyAllowed(bucket)).toBe(true)
    expect(_proxyAllowed(bucket)).toBe(false) // 11th blocked
    expect(_proxyAllowed(bucket)).toBe(false)
  })

  test('window slides — calls pass again once windowMs has elapsed', () => {
    setSystemTime(new Date(2_000_000))
    const bucket = { ts: [], windowMs: 10000, max: 3 }
    expect(_proxyAllowed(bucket)).toBe(true)
    expect(_proxyAllowed(bucket)).toBe(true)
    expect(_proxyAllowed(bucket)).toBe(true)
    expect(_proxyAllowed(bucket)).toBe(false)
    setSystemTime(new Date(2_000_000 + 10_001))
    expect(_proxyAllowed(bucket)).toBe(true) // old timestamps aged out
  })
})

// ── gql-request proxy: allowlist + rate limit (matches SECURITY.md guarantee) ──
describe('gql-request proxy mutation rate limit', () => {
  test('_gqlMutateRate bucket exists with a numeric cap', () => {
    expect(SRC).toMatch(/_gqlMutateRate\s*=\s*\{[^}]*max:\s*\d+/)
  })
  test('handler gates mutations through _proxyAllowed(_gqlMutateRate)', () => {
    expect(SRC).toMatch(/isMutatingGql\s*&&\s*!_proxyAllowed\(_gqlMutateRate\)/)
  })
  test('the unthrottled read-bypass set contains no token-spending mutation', () => {
    const m = SRC.match(/GQL_READ_OPS\s*=\s*new Set\(\[([^\]]*)\]\)/)
    expect(m).not.toBeNull()
    const reads = m[1]
    for (const mut of [
      'MakePrediction',
      'VotePoll',
      'FollowButton_FollowUser',
      'FollowButton_UnfollowUser',
      'RedeemCommunityPointsCustomReward',
      'ClaimCommunityPoints',
      'SetFollowersOnlyModeSetting',
      'Chat_ShareResub_UseResubToken',
    ]) {
      expect(reads).not.toContain(mut)
    }
  })
})

// ── C2: MAIN-world nonce frozen after first set ───────────────────────────────
describe('nonce freeze (blocks page-script overwrite → forged mutations)', () => {
  test('init-nonce handler bails if _hsNonce is already set, before re-assigning', () => {
    // anchor on the handler condition, not the earlier comment mention
    const idx = SRC.indexOf("=== 'heatsync-init-nonce'")
    expect(idx).toBeGreaterThan(-1)
    const branch = SRC.slice(idx, idx + 1200)
    const freeze = branch.search(/if\s*\(_hsNonce\)\s*return/)
    const assign = branch.indexOf('_hsNonce = e.data.nonce')
    expect(freeze).toBeGreaterThan(-1)
    expect(assign).toBeGreaterThan(-1)
    expect(freeze).toBeLessThan(assign) // freeze guards the assignment
  })
})

// ── M2: apollo-mutate allowlist is exact-match, not substring ──────────────────
describe('apollo-mutate allowlist exact match', () => {
  test('no substring searchTerm.includes(m) bypass remains', () => {
    expect(SRC).not.toMatch(/searchTerm\.includes\(m\)/)
  })
  test('allowlist check uses ALLOWED_MUTATIONS.includes(searchTerm)', () => {
    expect(SRC).toMatch(/ALLOWED_MUTATIONS\.includes\(e\.data\.searchTerm\)/)
  })
})

// ── C1/H3: page-reachable hs-dbg diagnostics are dev-build gated ───────────────
describe('hs-dbg diagnostics dev-build gate', () => {
  test('the guard precedes the dangerous hs-dbg-test-send listener registration', () => {
    const guard = BOOT.indexOf("typeof __HS_DEV_BUILD__ !== 'undefined' ? __HS_DEV_BUILD__ : true")
    // quoted form matches the addEventListener registration, not the bare-text comment
    const sendListener = BOOT.indexOf("'hs-dbg-test-send'")
    expect(guard).toBeGreaterThan(-1)
    expect(sendListener).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(sendListener)
  })
})

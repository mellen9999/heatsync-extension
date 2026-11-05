import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// the mentions tab survives a restart (rust a5deb0c parity). Pins the contract:
// owner-scoped, bounded, expiring, and gone when the account changes or logs out.
const MAIN = readFileSync(new URL('../src/multichat/main.js', import.meta.url), 'utf8')

describe('mentions persist across restart', () => {
  test('bounded and written to chrome.storage.local under an owner', () => {
    expect(MAIN).toMatch(/const PERSIST_MAX_MENTIONS = \d+/)
    expect(MAIN).toContain('mentionsBuffer.slice(-PERSIST_MAX_MENTIONS)')
    expect(MAIN).toContain(
      'chrome.storage.local.set({ hs_mentions_v2: { msgs, ts: Date.now(), owner: mentionsOwner } })',
    )
  })
  test('restore only for the same account, within a day, as history', () => {
    expect(MAIN).toContain('Date.now() - r.hs_mentions_v2.ts < 86400000')
    expect(MAIN).toContain("(r.hs_mentions_v2.owner || '') === mentionsOwner")
    expect(MAIN).toContain('m.isHistory = true')
  })
  test('an identity change or logout empties and rewrites the saved list', () => {
    const i = MAIN.indexOf('if (_owner !== mentionsOwner)')
    expect(i).toBeGreaterThan(0)
    const body = MAIN.slice(i, i + 200)
    expect(body).toContain('mentionsBuffer.length = 0')
    expect(body).toContain('_writeMentionsNow()')
  })
  test('the cap is at most the live buffer cap', () => {
    const cap = Number(MAIN.match(/const PERSIST_MAX_MENTIONS = (\d+)/)[1])
    expect(cap).toBeLessThanOrEqual(500)
  })
})

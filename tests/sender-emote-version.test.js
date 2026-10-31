/**
 * Regression: a sender's just-added emote rendered, turned to plain text ~1 min
 * later, then came back. The TTL batch refetch has no cache-bust, so CF/the
 * browser could answer with a pre-change snapshot and the panel applied it as
 * authoritative. Batch replies now carry per-key `vers`; a reply older than a
 * version already seen is ignored. A non-OK reply (429/5xx) is an error, never
 * an authoritative empty set.
 *
 * Source-carved (background.js has top-level chrome.* listeners and multichat
 * is a shared block scope): the pure helpers are evaluated from emotes.js, the
 * wiring is marker-checked.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (f) => readFileSync(join(import.meta.dir, '..', f), 'utf8')
const EMOTES = src('src/multichat/emotes.js')
const MAIN = src('src/multichat/main.js')
const BG = src('chrome/background.js')

function helpers() {
  const a = EMOTES.indexOf('const senderEmoteHighVer = new Map()')
  const b = EMOTES.indexOf("// Replace a sender's set with an AUTHORITATIVE", a)
  expect(a).toBeGreaterThan(-1)
  expect(b).toBeGreaterThan(a)
  return new Function(
    'SENDER_EMOTE_LRU_MAX',
    `${EMOTES.slice(a, b)}\nreturn { noteSenderVer, senderSetIsStale, senderEmoteHighVer }`,
  )(500)
}

describe('sender set version gate', () => {
  test('stale reply (lower than seen) is ignored', () => {
    const h = helpers()
    h.noteSenderVer('twitch:1', 5)
    expect(h.senderSetIsStale('twitch:1', 4)).toBe(true)
  })

  test('equal or newer reply applies', () => {
    const h = helpers()
    h.noteSenderVer('twitch:1', 5)
    expect(h.senderSetIsStale('twitch:1', 5)).toBe(false)
    expect(h.senderSetIsStale('twitch:1', 6)).toBe(false)
  })

  test('absent ver or unseen key applies (old server / first fetch)', () => {
    const h = helpers()
    h.noteSenderVer('twitch:1', 5)
    expect(h.senderSetIsStale('twitch:1', undefined)).toBe(false)
    expect(h.senderSetIsStale('twitch:2', 0)).toBe(false)
  })

  test('highest only ratchets up; wall-clock fallback ver is ignored', () => {
    const h = helpers()
    h.noteSenderVer('twitch:1', 5)
    h.noteSenderVer('twitch:1', 3)
    h.noteSenderVer('twitch:1', Date.now())
    expect(h.senderEmoteHighVer.get('twitch:1')).toBe(5)
  })

  test('map is LRU-bounded', () => {
    const h = helpers()
    for (let i = 0; i < 600; i++) h.noteSenderVer(`k${i}`, 1)
    expect(h.senderEmoteHighVer.size).toBe(500)
  })
})

describe('wiring', () => {
  test('flush skips stale keys before replaceSenderEmotes', () => {
    const i = MAIN.indexOf('senderSetIsStale(key, vers[key])')
    expect(i).toBeGreaterThan(-1)
    expect(i).toBeLessThan(MAIN.indexOf('replaceSenderEmotes(key, emotes[key]', i))
  })

  test('push events record the version', () => {
    expect(MAIN.match(/noteSenderVer\(key, msg\.ver\)/g)?.length).toBe(2)
  })

  test('background returns vers and treats non-OK as errored', () => {
    expect(BG).toContain('(r.ok ? r.json() : SENDER_FETCH_ERR)')
    expect(BG).not.toContain('(r.ok ? r.json() : null)\n          .catch(() => SENDER_FETCH_ERR)')
    expect(BG).toContain('!hb?.sets) _hsBatchErrored = true')
    expect(BG).toContain('vers: versOut')
  })
})

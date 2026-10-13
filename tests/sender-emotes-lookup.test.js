/**
 * get_sender_emotes resolves a chatter from heatsync's batch + 7TV personal
 * entitlements only — never a per-chatter 7TV/BTTV/kick.com call
 * (chrome/background.js).
 *
 * 2026-10-13: it fetched each new chatter's CHANNEL set from 7tv.io and
 * api.betterttv.net (and kick.com to map a kick name first) — ~1,500 calls a
 * minute on three busy tabs, mostly 404s, BTTV answering 429 — for emotes 7TV,
 * BTTV and the site all render as text. The site's sender path never did it.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BG = readFileSync(join(import.meta.dir, '..', 'chrome', 'background.js'), 'utf8')
const at = BG.indexOf("message.type === 'get_sender_emotes'")
const handler = BG.slice(at, BG.indexOf("message.type === 'get_bulk_badges'", at))

test('handler carved', () => {
  expect(at).toBeGreaterThan(-1)
  expect(handler).toContain('/api/users/emotes/batch')
})

test('no per-chatter third-party lookups', () => {
  for (const host of ['7tv.io', 'betterttv.net', 'kick.com/api']) expect(handler).not.toContain(host)
})

test('7TV paid personal sets still merge', () => {
  expect(handler).toContain('seventvPersonalSets.get(uid)')
})

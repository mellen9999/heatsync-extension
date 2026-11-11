/**
 * Cross-device simulcast fold — one phone send must render as ONE [H] row in
 * the extension, live and after hydration.
 *
 * Regression anchor (2026-08-03): a phone send to a twitch+kick tab painted
 * [K] + [H]. The kick send relays through THIS extension, so its pusher echo
 * beats the phone's origin_tag round-trip; isSentEcho only folds echoes
 * arriving AFTER the tracked entry exists. Two halves fix it:
 *  - retroFoldOwnEchoes: on origin_broadcast, retag the earliest painted leg
 *    [H] and remove later legs (share-claim `hidden` idiom).
 *  - claimHydratedEcho: BG-buffer replays fold the extra legs by message
 *    timestamp (isSentEcho's 10s window is NOW-anchored, useless for replay).
 * Wiring is embedded in bundle-scope handlers — pinned at source level.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bgSource } from './bg-src.js'

const INPUT_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
const SOCIAL_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'social.js'), 'utf8')
const IRC_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'irc.js'), 'utf8')
const BG_SRC = bgSource()

const foldStart = INPUT_SRC.indexOf('function retroFoldOwnEchoes()')
const foldEnd = INPUT_SRC.indexOf('\nfunction ', foldStart + 10)
const FOLD = INPUT_SRC.slice(foldStart, foldEnd)

const claimStart = INPUT_SRC.indexOf('function claimHydratedEcho(')
const CLAIM = INPUT_SRC.slice(claimStart, INPUT_SRC.indexOf('\nfunction ', claimStart + 10))

describe('live retro-fold', () => {
  test('carve markers found', () => {
    expect(foldStart).toBeGreaterThan(-1)
    expect(claimStart).toBeGreaterThan(-1)
  })

  test('origin_broadcast handler calls it after tracking', () => {
    const h = SOCIAL_SRC.indexOf("trackSentMessage(msg.text, 'heatsync')")
    expect(h).toBeGreaterThan(-1)
    expect(SOCIAL_SRC.slice(h, h + 300)).toContain('retroFoldOwnEchoes()')
  })

  test('twitch leg preferred as survivor, others hidden + removed', () => {
    // Kick echoes paint first (they relay through this ext) but bare and with
    // laggier timestamps — surviving them strands the [H] row rows-up.
    expect(FOLD).toContain("legs.find((l) => (l.m.platform || 'twitch') === 'twitch')")
    expect(FOLD).toContain("m.platform = 'heatsync'")
    expect(FOLD).toContain('hsMarkBadgeHeatsync(pb)')
    expect(FOLD).toContain('leg.m.hidden = true')
    expect(FOLD).toContain('leg.div.remove()')
    expect(FOLD).toContain('_unindexMessageDiv(leg.div)')
  })

  test('claims are per-platform and never re-claim [H]/system rows', () => {
    expect(FOLD).toContain("if (m.platform === 'heatsync' || m.type) continue")
    expect(FOLD).toContain('seen.includes(plat)')
  })
})

describe('hydration fold', () => {
  test('matches on message timestamp, not wall-clock window', () => {
    expect(CLAIM).toContain('Math.abs((entry.time || 0) - msgTime) > SENT_DEDUP_WINDOW')
  })

  test('all four staging sites fold (2 twitch + 2 kick)', () => {
    const t = IRC_SRC.split("claimHydratedEcho(m.text, 'twitch', m.time)").length - 1
    const k = IRC_SRC.split("claimHydratedEcho(m.text, 'kick', m.time)").length - 1
    expect(t).toBe(2)
    expect(k).toBe(2)
  })

  test('per-tab bookkeeping is stripped before persist', () => {
    expect(INPUT_SRC).toContain('hydratedPlatforms, ...rest }')
  })
})

describe('BG relay carries sendId for future exact-keyed folds', () => {
  test('origin_broadcast relay forwards sendId', () => {
    const h = BG_SRC.indexOf("type: 'chat_origin_broadcast'")
    expect(BG_SRC.slice(h, h + 400)).toContain('sendId')
  })
})

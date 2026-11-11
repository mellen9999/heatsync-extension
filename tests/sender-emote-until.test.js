/**
 * A sender's emote from their past (archive pairing) stops at its `until`.
 *
 * /api/users/emotes/batch answers with the sender's live rows plus historical
 * pairings (a name they used with an emote they no longer hold). Those carry
 * `until`: the last time the archive saw them use it. A line sent after that
 * (+ the 120s clock-skew pad) is a bare word again, not the old picture, the
 * same rule the site (sender-emotes.js isGatedOut) and the desktop client use.
 * The ext dropped `until`, so an emote removed long ago drew on every later
 * line where the sender typed the word.
 *
 * Three hops: the BG batch loop carries it (untilAt, epoch ms), the sender-set
 * merge keeps a moved bound, and _sGate in processEmotes withholds past it.
 * Live rows (no `until`) stay open-ended; removedAt tombstones keep no slack.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import * as mods from '../src/lib/modifiers.js'
import { escapeHtml, unescapeHtml } from '../src/lib/utils.js'
import { bgSource } from './bg-src.js'
import './emote-rungs-globals.js'

const BG_SRC = bgSource()
const between = (from, to) => {
  const a = BG_SRC.indexOf(from)
  const b = BG_SRC.indexOf(to, a)
  if (a === -1 || b === -1) throw new Error(`markers not found: ${from} .. ${to}`)
  return BG_SRC.slice(a, b)
}
// Same carve as cw-stub-passthrough.test.js: the real batch loop + normalizer.
const runHsLoop = new Function(
  'hs',
  'collected',
  `${between('function emoteAddedAtMs', '\nfunction fetchEmoteInventory')}\n${between(
    'const hsEmotes = hs?.emotes || []',
    '// Only cache when the result is trustworthy',
  )}\nreturn collected`,
)

globalThis.escapeHtml = escapeHtml
globalThis.unescapeHtml = unescapeHtml
// setTimeout never fires: the merge's 4s persist debounce stays out of this file
globalThis.cleanup = {
  setIntervalIfVisible: () => {},
  persistInterval: () => {},
  setTimeout: () => 0,
  setPageTimeout: () => 0,
}
globalThis.HS_MOD_TOKENS = mods.HS_MOD_TOKENS
globalThis.hsModClassify = mods.hsModClassify
globalThis.hsModBuildStyleAttr = mods.hsModBuildStyleAttr
globalThis.hsModInjectWrapperStyle = mods.hsModInjectWrapperStyle
globalThis.hsModComposeFilter = mods.hsModComposeFilter
globalThis.hsModHexToHue = mods.hsModHexToHue
globalThis.HS_MOD_C_HEX_RE = /^c!#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
globalThis.currentTab = 'chan-a'
globalThis.getCurrentChannel = () => 'chan-a'
globalThis.getLiveChannel = () => 'chan-a'
globalThis.linksEnabled = false
globalThis.getSetting = () => undefined
globalThis.log = () => {}
globalThis.safeUrl = (u) => /^https?:\/\//i.test(u)

const { processEmotes, mergeSenderEmotes, replaceSenderEmotes, senderEmoteSets } = await import(
  '../src/multichat/emotes.js'
)

const SKEW = 120000 // EMOTE_ADDED_SKEW_MS
const T = 1700000000000
const URL = 'https://cdn.7tv.app/emote/01OLDVIBE0000000000000000/2x.webp'
const rendered = (out) => out.includes('<img')
const sender = (extra = {}) => new Map([['OldVibe', { url: URL, source: '7tv', state: 'global', ...extra }]])

describe('the batch loop carries `until`', () => {
  test('a historical pairing becomes untilAt (epoch ms)', () => {
    const out = runHsLoop({ emotes: [{ custom_name: 'OldVibe', url: URL, until: '2023-11-14T22:13:20Z' }] }, {})
    expect(out.OldVibe.untilAt).toBe(T)
  })

  test('a live row (no until) and a garbage until have no upper bound', () => {
    const out = runHsLoop(
      {
        emotes: [
          { custom_name: 'Live', url: URL },
          { custom_name: 'Junk', url: URL, until: 'not a date' },
        ],
      },
      {},
    )
    expect(out.Live.untilAt || 0).toBe(0)
    expect(out.Junk.untilAt || 0).toBe(0)
  })
})

describe('_sGate withholds a pairing past its until', () => {
  test('sent after until + skew: the bare word', () => {
    const out = processEmotes('OldVibe', 'chan-x', null, sender({ untilAt: T }), T + SKEW + 1000)
    expect(rendered(out)).toBe(false)
    expect(out).toContain('OldVibe')
  })

  test('the skew edge itself is already past', () => {
    expect(rendered(processEmotes('OldVibe', 'chan-x', null, sender({ untilAt: T }), T + SKEW))).toBe(false)
  })

  test('inside the skew pad and before until it still draws', () => {
    expect(rendered(processEmotes('OldVibe', 'chan-x', null, sender({ untilAt: T }), T + SKEW - 1000))).toBe(true)
    expect(rendered(processEmotes('OldVibe', 'chan-x', null, sender({ untilAt: T }), T - 86400000))).toBe(true)
  })

  test('no message time fails open, no untilAt is open-ended', () => {
    expect(rendered(processEmotes('OldVibe', 'chan-x', null, sender({ untilAt: T }), null))).toBe(true)
    expect(rendered(processEmotes('OldVibe', 'chan-x', null, sender(), T + 365 * 86400000))).toBe(true)
  })

  test('removedAt keeps its no-slack cut', () => {
    expect(rendered(processEmotes('OldVibe', 'chan-x', null, sender({ removedAt: T }), T + 1))).toBe(false)
  })
})

describe('the sender-set merge keeps the bound current', () => {
  beforeEach(() => senderEmoteSets.clear())
  const E = (extra = {}) => ({ url: URL, source: '7tv', state: 'global', ...extra })

  test('replace: a later until (used again since) moves the bound', () => {
    replaceSenderEmotes('twitch:1', { OldVibe: E({ untilAt: T }) })
    const r = replaceSenderEmotes('twitch:1', { OldVibe: E({ untilAt: T + 3600000 }) })
    expect(r.changed).toBe(true)
    expect(senderEmoteSets.get('twitch:1').get('OldVibe').untilAt).toBe(T + 3600000)
  })

  test('replace: owning it again (a live row) clears the bound', () => {
    replaceSenderEmotes('twitch:1', { OldVibe: E({ untilAt: T }) })
    replaceSenderEmotes('twitch:1', { OldVibe: E() })
    expect(senderEmoteSets.get('twitch:1').get('OldVibe').untilAt || 0).toBe(0)
  })

  test('merge: same, through the additive path', () => {
    mergeSenderEmotes('twitch:1', { OldVibe: E({ untilAt: T }) })
    expect(mergeSenderEmotes('twitch:1', { OldVibe: E({ untilAt: T + 60000 }) })).toBe(true)
    expect(senderEmoteSets.get('twitch:1').get('OldVibe').untilAt).toBe(T + 60000)
  })
})

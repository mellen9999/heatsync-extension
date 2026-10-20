/**
 * Blocking an emote must not change who may use it, and an unblock after a
 * refresh must name the hash the block was filed under.
 *
 * 1. blockedEmoteFallback knows a NAME, not who may use it: another sender who
 *    never had the emote typed plain text, so the block must not render a box
 *    (or the emote) for them. Own messages keep the fallback.
 * 2. After a refresh the emote is in no live cache, so unblock could only send
 *    the bare name as the hash — the server refuses it and the block stuck.
 *    The fallback now carries the hash.
 *
 * Same bundle-global stub pattern as emote-inventory-gate.test.js.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import * as mods from '../src/lib/modifiers.js'
import { escapeHtml, unescapeHtml } from '../src/lib/utils.js'

globalThis.escapeHtml = escapeHtml
globalThis.unescapeHtml = unescapeHtml
globalThis.cleanup = { setIntervalIfVisible: () => {}, persistInterval: () => {}, setTimeout: () => 0 }
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

const {
  blockedEmoteFallback,
  blockedEmoteNames,
  emoteCache,
  processEmotes,
  rememberBlockedEmote,
  viewerPersonalEmotes,
} = await import('../src/multichat/emotes.js')

const URL = 'https://cdn.7tv.app/emote/01J6R1MC200004C8HA5QGJ27J8/1x.webp'
const stranger = () => new Map()

beforeEach(() => {
  blockedEmoteFallback.clear()
  blockedEmoteNames.clear()
  emoteCache.clear()
  viewerPersonalEmotes.clear()
  // a loaded globals cache — processEmotes returns raw text before resolving anything while every cache is empty
  emoteCache.set('Kappa', { url: 'https://cdn.7tv.app/emote/k/1x.webp', source: '7tv', state: 'global' })
})

describe('a blocked name stays plain text for a sender with no access', () => {
  beforeEach(() => {
    rememberBlockedEmote('Lash', URL, 'heatsync', false, 'h'.repeat(64))
    blockedEmoteNames.add('Lash')
  })

  test("another sender's word is not boxed or rendered", () => {
    const out = processEmotes('and another win for the Lash', 'chan-x', null, stranger(), Date.now())
    expect(out).not.toContain('<img')
    expect(out).toContain('Lash')
  })

  test('the viewer’s own message still draws the blocked box', () => {
    const out = processEmotes('Lash', 'chan-x', null, viewerPersonalEmotes, Date.now())
    expect(out).toContain('hs-state-blocked')
  })
})

describe('the fallback carries the hash the block was filed under', () => {
  test('remembered hash survives a re-remember without one', () => {
    rememberBlockedEmote('Lash', URL, 'heatsync', false, 'abc123def456')
    rememberBlockedEmote('Lash', URL, 'heatsync', false)
    expect(blockedEmoteFallback.get('Lash').hash).toBe('abc123def456')
  })

  test('no hash given and none known → empty, never undefined', () => {
    rememberBlockedEmote('Other', URL, 'heatsync', false)
    expect(blockedEmoteFallback.get('Other').hash).toBe('')
  })
})

// ── access × block matrix ────────────────────────────────────────────────────
// who may use the name (viewer/sender/channel/global) × is it blocked × whose
// message. Expected: rendered = the sender (or channel/global) had it; a block
// changes the look to the dashed box, never the access.
describe('access × block matrix', () => {
  const E = { url: URL, source: 'heatsync', state: 'global' }
  const html = (map, { own = false, channel = null } = {}) =>
    processEmotes('Lash', channel || 'chan-x', null, own ? viewerPersonalEmotes : map, Date.now())
  const img = (out) => out.includes('<img')
  const box = (out) => out.includes('hs-state-blocked')

  const cases = [
    // [label, setup, expect {img, box}]
    [
      'sender owns, not blocked → image',
      () => {},
      { own: false, sender: new Map([['Lash', E]]) },
      { img: true, box: false },
    ],
    [
      'sender owns, viewer blocked → dashed box',
      () => blockedEmoteNames.add('Lash'),
      { own: false, sender: new Map([['Lash', E]]) },
      { img: true, box: true },
    ],
    ['sender lacks, not blocked → plain text', () => {}, { own: false, sender: new Map() }, { img: false, box: false }],
    [
      'sender lacks, viewer blocked → still plain text',
      () => {
        rememberBlockedEmote('Lash', URL, 'heatsync', false, 'h'.repeat(64))
        blockedEmoteNames.add('Lash')
      },
      { own: false, sender: new Map() },
      { img: false, box: false },
    ],
    [
      'viewer owns, own message → image',
      () => viewerPersonalEmotes.set('Lash', E),
      { own: true },
      { img: true, box: false },
    ],
    [
      'viewer owns, blocked, own message → dashed box',
      () => {
        viewerPersonalEmotes.set('Lash', E)
        blockedEmoteNames.add('Lash')
      },
      { own: true },
      { img: true, box: true },
    ],
    [
      'viewer owns, stranger without it → plain text (own set never leaks)',
      () => viewerPersonalEmotes.set('Lash', E),
      { own: false, sender: new Map() },
      { img: false, box: false },
    ],
    [
      'global emote, stranger → image',
      () => emoteCache.set('Lash', E),
      { own: false, sender: new Map() },
      { img: true, box: false },
    ],
    [
      'global emote, viewer blocked, stranger → dashed box',
      () => {
        emoteCache.set('Lash', E)
        blockedEmoteNames.add('Lash')
      },
      { own: false, sender: new Map() },
      { img: true, box: true },
    ],
  ]

  for (const [label, setup, args, want] of cases) {
    test(label, () => {
      setup()
      const out = html(args.sender, { own: args.own })
      expect({ img: img(out), box: box(out) }).toEqual(want)
    })
  }
})

// Many emotes share one name (a channel's AYAYA, kick's AYAYA, the 7tv variant a chatter collected).
// The one the sender actually picked rides the message as a server-verified ref, so it is looked up
// BEFORE the channel's same-name emote — otherwise a chosen variant renders as whatever the room
// happens to have. The ref is only a precomputed lookup of the sender's own inventory, so a line with
// no ref (the first one after an add or swap, a cold server cache, history) must resolve the same way:
// the law's READ order (emote-law-read.js): a sender's 7tv/bttv personal set, then the ROOM, then the
// sender's heatsync inventory, then globals. A name-match the server made is the inventory, not a pick.
// _sGate still holds the sender's entries to the window they owned them.

import { describe, expect, test } from 'bun:test'
import * as mods from '../src/lib/modifiers.js'
import { escapeHtml, unescapeHtml } from '../src/lib/utils.js'
import './emote-rungs-globals.js'

// ── behavior ─────────────────────────────────────────────────────────────────
// Same bundle-global stub pattern as emote-inventory-gate.test.js (each file must run on its own).

globalThis.escapeHtml = escapeHtml
globalThis.unescapeHtml = unescapeHtml
globalThis.cleanup = { setIntervalIfVisible: () => {}, persistInterval: () => {} }
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
let _settings = {}
globalThis.getSetting = (k) => _settings[k]

const { processEmotes, channelEmoteCaches, emoteCache, hsAnyChannelEmotes } = await import('../src/multichat/emotes.js')

const T = 1700000000000
const SKEW = 120000 // EMOTE_ADDED_SKEW_MS
const url = (id) => `https://cdn.7tv.app/emote/${id}/2x.webp`
const CHANNEL = '01CHANNELIDK00000000000000'
const MINE = '01SENDERIDK000000000000000'
const REF = '01SERVERREF000000000000000'
const GLOBAL = '01GLOBALIDK0000000000000000'

const channelSet = () => new Map([['IDK', { url: url(CHANNEL), source: '7tv', state: 'channel' }]])
const senderSet = (extra = {}) =>
  new Map([['IDK', { url: url(MINE), source: '7tv', state: 'owned', personal: true, ...extra }]])
const draws = (out, id) => out.includes(id)

function withChannel(fn) {
  channelEmoteCaches['chan-x'] = channelSet()
  try {
    return fn()
  } finally {
    delete channelEmoteCaches['chan-x']
  }
}

describe('same-name emote pick: what a line draws', () => {
  test('no ref: the sender own IDK is drawn, not the channel IDK', () =>
    withChannel(() => {
      const out = processEmotes('IDK', 'chan-x', null, senderSet({ addedAt: T }), T + 5000)
      expect(draws(out, MINE)).toBe(true)
      expect(draws(out, CHANNEL)).toBe(false)
    }))

  test("a sender's inventory copy (not a personal set) loses to the room's", () =>
    withChannel(() => {
      const out = processEmotes('IDK', 'chan-x', null, senderSet({ addedAt: T, personal: undefined }), T + 5000)
      expect(draws(out, CHANNEL)).toBe(true)
      expect(draws(out, MINE)).toBe(false)
    }))

  test('a sender who does not carry the name still gets the channel IDK', () =>
    withChannel(() => {
      const other = new Map([['Other', { url: url(MINE), source: '7tv', state: 'owned' }]])
      expect(draws(processEmotes('IDK', 'chan-x', null, other, T), CHANNEL)).toBe(true)
      expect(draws(processEmotes('IDK', 'chan-x', null, null, T), CHANNEL)).toBe(true)
    }))

  test("the server's per-message ref still beats the sender set", () =>
    withChannel(() => {
      const refs = new Map([['IDK', { url: url(REF), source: '7tv', state: 'global', zeroWidth: false }]])
      const out = processEmotes('IDK', 'chan-x', null, senderSet({ addedAt: T }), T + 5000, true, refs)
      expect(draws(out, REF)).toBe(true)
      expect(draws(out, MINE)).toBe(false)
    }))

  test('the first line after an add (sent just before the add landed) already draws the pick', () =>
    withChannel(() => {
      // sent 5s before addedAt: inside the skew pad, so the collect→send fast path holds
      const out = processEmotes('IDK', 'chan-x', null, senderSet({ addedAt: T }), T - 5000)
      expect(draws(out, MINE)).toBe(true)
    }))

  test('_sGate is unchanged: an entry added long after the line was sent falls back to the channel', () =>
    withChannel(() => {
      const out = processEmotes('IDK', 'chan-x', null, senderSet({ addedAt: T }), T - SKEW - 60000)
      expect(draws(out, CHANNEL)).toBe(true)
      expect(draws(out, MINE)).toBe(false)
    }))

  test('a removed entry is not drawn for lines sent after the removal', () =>
    withChannel(() => {
      const out = processEmotes('IDK', 'chan-x', null, senderSet({ addedAt: T, removedAt: T + 1000 }), T + 2000)
      expect(draws(out, CHANNEL)).toBe(true)
    }))

  test('renderInventoryEmotes off: nothing from any inventory draws, the channel IDK does', () =>
    withChannel(() => {
      _settings = { renderInventoryEmotes: false }
      try {
        const out = processEmotes('IDK', 'chan-x', null, senderSet({ addedAt: T }), T + 5000)
        expect(draws(out, CHANNEL)).toBe(true)
        expect(draws(out, MINE)).toBe(false)
      } finally {
        _settings = {}
      }
    }))

  test('channel IDK still beats a global IDK', () =>
    withChannel(() => {
      emoteCache.set('IDK', { url: url(GLOBAL), source: '7tv', state: 'global' })
      try {
        const out = processEmotes('IDK', 'chan-x', null, null, T)
        expect(draws(out, CHANNEL)).toBe(true)
        expect(draws(out, GLOBAL)).toBe(false)
      } finally {
        emoteCache.delete('IDK')
      }
    }))
})

describe('the law: the row reads its own room', () => {
  test("a row draws its OWN channel's emote, whatever tab is open", () => {
    channelEmoteCaches['chan-x'] = channelSet()
    channelEmoteCaches['chan-open'] = new Map([['IDK', { url: url(GLOBAL), source: '7tv', state: 'channel' }]])
    globalThis.currentTab = 'chan-open'
    try {
      expect(draws(processEmotes('IDK', 'chan-x', null, null, T), CHANNEL)).toBe(true)
    } finally {
      globalThis.currentTab = 'chan-a'
      delete channelEmoteCaches['chan-x']
      delete channelEmoteCaches['chan-open']
    }
  })

  test('a server name-match (named ref) is the sender inventory: below the room, not a pick', () =>
    withChannel(() => {
      const refs = new Map([['IDK', { url: url(REF), source: '7tv', state: 'global', zeroWidth: false, named: true }]])
      expect(draws(processEmotes('IDK', 'chan-x', null, null, T, true, refs), CHANNEL)).toBe(true)
    }))

  test('a name only the inventory has still draws (no room copy)', () => {
    const refs = new Map([['Solo', { url: url(REF), source: '7tv', state: 'global', zeroWidth: false, named: true }]])
    expect(draws(processEmotes('Solo', 'chan-x', null, null, T, true, refs), REF)).toBe(true)
  })
})

describe('the law: a line with no room (a whisper, a dm)', () => {
  const A = '01ROOMAIDK0000000000000000'
  const B = '01ROOMBIDK0000000000000000'
  const set = (id) => new Map([['IDK', { url: url(id), source: '7tv', state: 'channel' }]])
  const roomless = (text) => processEmotes(text, null, null, undefined, undefined, true, null, hsAnyChannelEmotes())
  const clear = () => {
    for (const k of ['room-b', 'room-a']) delete channelEmoteCaches[k]
    emoteCache.delete('IDK')
  }

  test('a word only some loaded channel has still draws: it is the last resort, not text', () => {
    channelEmoteCaches['room-a'] = set(A)
    try {
      expect(draws(roomless('IDK'), A)).toBe(true)
    } finally {
      clear()
    }
  })

  test('a global of that name wins: an unrelated channel never outranks what everyone shares', () => {
    channelEmoteCaches['room-a'] = set(A)
    emoteCache.set('IDK', { url: url(GLOBAL), source: '7tv', state: 'global' })
    try {
      expect(draws(roomless('IDK'), GLOBAL)).toBe(true)
    } finally {
      clear()
    }
  })

  test('which channel supplies the word never depends on which loaded first', () => {
    channelEmoteCaches['room-b'] = set(B)
    channelEmoteCaches['room-a'] = set(A)
    try {
      expect(draws(roomless('IDK'), A)).toBe(true)
    } finally {
      clear()
    }
  })
})

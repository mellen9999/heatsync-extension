// Many emotes share one name (a channel's AYAYA, kick's AYAYA, the 7tv variant a chatter collected).
// The one the sender actually picked rides the message as a server-verified ref, so it is looked up
// BEFORE the channel's same-name emote — otherwise a chosen variant renders as whatever the room
// happens to have. The ref is only a precomputed lookup of the sender's own inventory, so a line with
// no ref (the first one after an add or swap, a cold server cache, history) must resolve the same way:
// the sender's set next, then the channel, then globals. Only the SENDER's set ever fills that slot
// (processEmotes is handed one sender's map), and _sGate still holds it to the window they owned it.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as mods from '../src/lib/modifiers.js'
import { escapeHtml, unescapeHtml } from '../src/lib/utils.js'
import './emote-rungs-globals.js'

// ── source order ─────────────────────────────────────────────────────────────

const emotes = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8')
const lookup = emotes.slice(
  emotes.indexOf('const _lookup = (name) => {'),
  emotes.indexOf('// Kick emote splits gated by indexOf'),
)

describe('same-name emote pick: lookup order', () => {
  test("the message's own ref is looked up first of all", () => {
    const ref = lookup.indexOf('msgRefs?.get(name)')
    const sender = lookup.indexOf('_sGet(raw)')
    expect(ref).toBeGreaterThan(-1)
    expect(ref).toBeLessThan(sender)
  })

  test('with no ref for a name, the sender set wins over the channel; the channel over globals', () => {
    const sender = lookup.indexOf('_sGet(raw)')
    const channel = lookup.indexOf('channelEmoteCaches[channel]?.get(raw)')
    const globals = lookup.indexOf('emoteCache.get(raw)')
    expect(sender).toBeGreaterThan(-1)
    expect(sender).toBeLessThan(channel)
    expect(channel).toBeLessThan(globals)
  })

  test('the sender set is read once, through the gate (no second, ungated read of it)', () => {
    expect(lookup.split('_sGet(raw)').length - 1).toBe(1)
  })
})

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

const { processEmotes, channelEmoteCaches, emoteCache } = await import('../src/multichat/emotes.js')

const T = 1700000000000
const SKEW = 120000 // EMOTE_ADDED_SKEW_MS
const url = (id) => `https://cdn.7tv.app/emote/${id}/2x.webp`
const CHANNEL = '01CHANNELIDK00000000000000'
const MINE = '01SENDERIDK000000000000000'
const REF = '01SERVERREF000000000000000'
const GLOBAL = '01GLOBALIDK0000000000000000'

const channelSet = () => new Map([['IDK', { url: url(CHANNEL), source: '7tv', state: 'channel' }]])
const senderSet = (extra = {}) => new Map([['IDK', { url: url(MINE), source: '7tv', state: 'owned', ...extra }]])
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

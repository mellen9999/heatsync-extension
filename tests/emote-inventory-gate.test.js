/**
 * Inventory-time render gate (_sGate in processEmotes) — a heatsync sender
 * emote renders only in messages sent while the sender owned it:
 * addedAt − skew ≤ msgTime < removedAt. History is frozen at send-time truth:
 * a fresh collect never retro-imagifies older messages, an uncollect never
 * retro-textifies rows rendered while owned.
 *
 * Same bundle-global stub pattern as emote-precedence.test.js.
 */

import { describe, expect, test } from 'bun:test'
import * as mods from '../src/lib/modifiers.js'
import { escapeHtml, unescapeHtml } from '../src/lib/utils.js'

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
// main.js bundle-global read on processEmotes' raw-text path — without it the
// file only passes when another test file happens to have defined it first
// (each test file must be independently runnable).
globalThis.linksEnabled = false
// processEmotes reads the render toggle through the settings bundle-global.
// Mutable so the opt-out case below can flip it; undefined = schema default.
let _settings = {}
globalThis.getSetting = (k) => _settings[k]

const { processEmotes } = await import('../src/multichat/emotes.js')

const SKEW = 120000 // EMOTE_ADDED_SKEW_MS
const T = 1700000000000 // arbitrary fixed epoch ms
const URL = 'https://cdn.heatsync.org/uploads/akdj.webp'

const sender = (extra = {}) => new Map([['AKDJvibe', { url: URL, source: 'heatsync', state: 'global', ...extra }]])

const rendered = (out) => out.includes('<img')

describe('inventory-time render gate', () => {
  test('message BEFORE addedAt stays raw text (no retro-imagify)', () => {
    const out = processEmotes('AKDJvibe', 'chan-x', null, sender({ addedAt: T }), T - 3600000)
    expect(rendered(out)).toBe(false)
    expect(out).toContain('AKDJvibe')
  })

  test('message AFTER addedAt renders', () => {
    expect(rendered(processEmotes('AKDJvibe', 'chan-x', null, sender({ addedAt: T }), T + 5000))).toBe(true)
  })

  test('collect-then-send inside the skew window renders (clock drift)', () => {
    expect(rendered(processEmotes('AKDJvibe', 'chan-x', null, sender({ addedAt: T }), T - SKEW / 2))).toBe(true)
  })

  test('no msgTime → fail-open (old behavior preserved)', () => {
    expect(rendered(processEmotes('AKDJvibe', 'chan-x', null, sender({ addedAt: T }), null))).toBe(true)
  })

  test('no addedAt stamp (7TV/BTTV/pre-stamp cache) → ungated', () => {
    expect(rendered(processEmotes('AKDJvibe', 'chan-x', null, sender(), T - 3600000))).toBe(true)
  })

  test('tombstone: message after removedAt stays text, before it keeps rendering', () => {
    const s = sender({ addedAt: T, removedAt: T + 1000000 })
    expect(rendered(processEmotes('AKDJvibe', 'chan-x', null, s, T + 2000000))).toBe(false)
    expect(rendered(processEmotes('AKDJvibe', 'chan-x', null, s, T + 500000))).toBe(true)
  })

  test('gated sender entry falls through to the global pool if present', async () => {
    const { emoteCache } = await import('../src/multichat/emotes.js')
    emoteCache.set('AKDJvibe', { url: URL, source: 'heatsync', state: 'global' })
    try {
      expect(rendered(processEmotes('AKDJvibe', 'chan-x', null, sender({ addedAt: T }), T - 3600000))).toBe(true)
    } finally {
      emoteCache.delete('AKDJvibe')
    }
  })
})

// Opt-out: renderInventoryEmotes=false leaves every inventory-resolved name as
// the plain word, while channel/global pools keep rendering — turning it off
// must not desync this client from what the rest of the platform sees.
describe('renderInventoryEmotes opt-out', () => {
  test('off: an owned, in-window inventory emote stays plain text', () => {
    _settings = { renderInventoryEmotes: false }
    try {
      const out = processEmotes('AKDJvibe', 'chan-x', null, sender({ addedAt: T }), T + 5000)
      expect(rendered(out)).toBe(false)
      expect(out).toContain('AKDJvibe')
    } finally {
      _settings = {}
    }
  })

  test('off: channel and global emotes still render', async () => {
    const { emoteCache } = await import('../src/multichat/emotes.js')
    _settings = { renderInventoryEmotes: false }
    emoteCache.set('GlobalVibe', { url: URL, source: '7tv', state: 'global' })
    try {
      expect(rendered(processEmotes('GlobalVibe', 'chan-x', null, sender({ addedAt: T }), T + 5000))).toBe(true)
    } finally {
      emoteCache.delete('GlobalVibe')
      _settings = {}
    }
  })

  test('on (default) is unchanged', () => {
    expect(rendered(processEmotes('AKDJvibe', 'chan-x', null, sender({ addedAt: T }), T + 5000))).toBe(true)
  })
})

// Inventory attribution: emotes resolved via a heatsync inventory (sender's
// or own) carry data-inv="1" so the tooltip labels them "inventory" instead
// of the asset's original provider. Channel/global hits stay unstamped —
// those genuinely render via their provider for every viewer.
describe('inventory provenance stamp (data-inv)', () => {
  test('sender-inventory hit stamps data-inv on wrapper and img', () => {
    const out = processEmotes('AKDJvibe', 'chan-x', null, sender({ addedAt: T }), T + 5000)
    expect(out.match(/data-inv="1"/g)?.length).toBe(2)
  })

  test('global-pool hit has no data-inv', async () => {
    const { emoteCache } = await import('../src/multichat/emotes.js')
    emoteCache.set('AKDJvibe', { url: URL, source: '7tv', state: 'global' })
    try {
      const out = processEmotes('AKDJvibe', 'chan-x', null, null, T)
      expect(rendered(out)).toBe(true)
      expect(out).not.toContain('data-inv')
    } finally {
      emoteCache.delete('AKDJvibe')
    }
  })

  test('channel hit has no data-inv when the sender does not carry the name', async () => {
    const { channelEmoteCaches } = await import('../src/multichat/emotes.js')
    channelEmoteCaches['chan-x'] = new Map([['AKDJvibe', { url: URL, source: '7tv', state: 'channel' }]])
    try {
      const out = processEmotes('AKDJvibe', 'chan-x', null, null, T + 5000)
      expect(rendered(out)).toBe(true)
      expect(out).not.toContain('data-inv')
    } finally {
      delete channelEmoteCaches['chan-x']
    }
  })

  test("the sender's own emote beats the channel's of the same name, and is stamped", async () => {
    const { channelEmoteCaches } = await import('../src/multichat/emotes.js')
    channelEmoteCaches['chan-x'] = new Map([['AKDJvibe', { url: `${URL}?channel`, source: '7tv', state: 'channel' }]])
    try {
      const out = processEmotes('AKDJvibe', 'chan-x', null, sender({ addedAt: T }), T + 5000)
      expect(rendered(out)).toBe(true)
      expect(out).not.toContain('?channel')
      expect(out.match(/data-inv="1"/g)?.length).toBe(2)
    } finally {
      delete channelEmoteCaches['chan-x']
    }
  })
})

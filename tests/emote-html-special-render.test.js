/**
 * Regression: emotes whose NAME contains HTML specials (`>:3`, `<3`, `:-&`)
 * must render from the RAW-keyed caches (channel/sender/global/removed).
 *
 * processEmotes receives escapeHtml(m.text), so its per-word tokens arrive
 * HTML-escaped (`>:3` → `&gt;:3`). Those caches are keyed by the RAW emote
 * name, so the lookup must unescape the token before hitting them — otherwise
 * `&gt;:3` never matches key `>:3` and the emote renders as plain text. This is
 * the sibling of native-emote-escape.test.js (which covers the escaped-keyed
 * twitchExtra map on the main.js side); here we cover the emotes.js lookup.
 *
 * Same bundle-global stub pattern as emote-inventory-gate.test.js.
 */

import { describe, expect, test } from 'bun:test'
import * as mods from '../src/lib/modifiers.js'
import { escapeHtml, unescapeHtml } from '../src/lib/utils.js'
import './emote-rungs-globals.js'

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
globalThis.getSetting = () => undefined

const { processEmotes, emoteCache, channelEmoteCaches } = await import('../src/multichat/emotes.js')

const URL = 'https://cdn.heatsync.org/uploads/gr33.webp'
const rendered = (out) => out.includes('<img')
// What processEmotes actually receives: the escaped chat token.
const run = (name, channel, extra, sender) => processEmotes(escapeHtml(name), channel, extra, sender, null)
const senderMap = (name) => new Map([[name, { url: URL, source: 'heatsync', state: 'global' }]])

describe('HTML-special emote names render from raw-keyed caches', () => {
  test('the reported bug: global emote `>:3` renders (token `&gt;:3`)', () => {
    emoteCache.set('>:3', { url: URL, source: '7tv', state: 'global' })
    try {
      const out = run('>:3', 'chan-x', null, null)
      expect(rendered(out)).toBe(true)
      // alt text is the raw name, not the escaped token
      expect(out).toContain('&gt;:3')
    } finally {
      emoteCache.delete('>:3')
    }
  })

  test('channel emote `<3` renders from channel cache', () => {
    channelEmoteCaches['chan-x'] = new Map([['<3', { url: URL, source: '7tv', state: 'channel' }]])
    try {
      expect(rendered(run('<3', 'chan-x', null, null))).toBe(true)
    } finally {
      delete channelEmoteCaches['chan-x']
    }
  })

  test('sender-inventory emote `:-&` renders (and stamps data-inv)', () => {
    const out = run(':-&', 'chan-x', null, senderMap(':-&'))
    expect(rendered(out)).toBe(true)
    expect(out).toContain('data-inv="1"')
  })

  test('extraCache (twitchExtra) is keyed ESCAPED — matched by the raw token verbatim', () => {
    // main.js keys twitchExtra by escapeHtml(name); the token is already escaped.
    const extra = new Map([[escapeHtml('>:3'), { url: URL, source: 'twitch', state: 'global' }]])
    expect(rendered(run('>:3', 'chan-x', extra, null))).toBe(true)
  })

  test('plain name stays on the fast path (no `&`, unchanged behavior)', () => {
    emoteCache.set('Kappa', { url: URL, source: '7tv', state: 'global' })
    try {
      expect(rendered(run('Kappa', 'chan-x', null, null))).toBe(true)
    } finally {
      emoteCache.delete('Kappa')
    }
  })

  test('unknown special-char word still renders as plain text (no false positive)', () => {
    const out = run('>:3', 'chan-x', null, null)
    expect(rendered(out)).toBe(false)
    expect(out).toContain('&gt;:3')
  })

  // Sanity: escapeHtml/unescapeHtml roundtrip is exact for the names we key on.
  test('escape roundtrip is lossless for all covered names', () => {
    for (const n of ['>:3', '<3', ':-&', 'Kappa']) expect(unescapeHtml(escapeHtml(n))).toBe(n)
  })
})

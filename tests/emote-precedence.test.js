/**
 * Unit tests for src/multichat/emotes.js — lookup precedence, zero-width
 * overlay resolution, and source/state detection.
 *
 * emotes.js is written to run concatenated into the multichat bundle, where
 * src/lib/modifiers.js and main.js's per-tab state (currentTab,
 * getCurrentChannel, getLiveChannel) share the same top-level script scope.
 * To import it standalone we stub those bundle-globals on globalThis before
 * import, mirroring the pattern already used in undo-manager.test.js and
 * user-notes.test.js.
 *
 * HS_MOD_C_HEX_RE is intentionally duplicated here (not exported by
 * modifiers.js) — same "duplicated so tests don't depend on bundled output"
 * precedent as the fuzzyScore helper in utils.test.js.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import * as mods from '../src/lib/modifiers.js'

globalThis.cleanup = { setIntervalIfVisible: () => {}, persistInterval: () => {} }
globalThis.HS_MOD_TOKENS = mods.HS_MOD_TOKENS
globalThis.hsModClassify = mods.hsModClassify
globalThis.hsModBuildStyleAttr = mods.hsModBuildStyleAttr
globalThis.hsModInjectWrapperStyle = mods.hsModInjectWrapperStyle
globalThis.hsModComposeFilter = mods.hsModComposeFilter
globalThis.hsModHexToHue = mods.hsModHexToHue
globalThis.HS_MOD_C_HEX_RE = /^c!#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

// currentTab / getCurrentChannel / getLiveChannel live in main.js in the real
// bundle. Tests control them directly via these mutable stubs.
globalThis.currentTab = 'chan-a'
globalThis.getCurrentChannel = () => 'chan-a'
globalThis.getLiveChannel = () => 'chan-a'

const {
  blockedEmoteFallback,
  channelEmoteCaches,
  detectEmoteSource,
  emoteCache,
  getEmoteState,
  inventoryEmotes,
  lookupEmote,
  lookupEmoteRenderOrder,
  lookupEmoteWireOrder,
  lookupEmoteWithOverlay,
  lookupOwnedEmote,
  removedEmoteFallback,
  viewerPersonalEmotes,
  zeroWidthFromAnyCache,
} = await import('../src/multichat/emotes.js')

function resetAll() {
  viewerPersonalEmotes.clear()
  emoteCache.clear()
  for (const k of Object.keys(channelEmoteCaches)) delete channelEmoteCaches[k]
  inventoryEmotes.clear()
  removedEmoteFallback.clear()
  blockedEmoteFallback.clear()
  globalThis.currentTab = 'chan-a'
  globalThis.getCurrentChannel = () => 'chan-a'
  globalThis.getLiveChannel = () => 'chan-a'
}

beforeEach(resetAll)

// ── detectEmoteSource (pure) ────────────────────────────────────────────────

describe('detectEmoteSource', () => {
  test('7tv CDN url', () => expect(detectEmoteSource('https://cdn.7tv.app/emote/x/1x.webp')).toBe('7tv'))
  test('bttv CDN url', () => expect(detectEmoteSource('https://cdn.betterttv.net/emote/x/1x')).toBe('bttv'))
  test('ffz CDN url', () => expect(detectEmoteSource('https://cdn.frankerfacez.com/emote/1/1')).toBe('ffz'))
  test('twitch CDN url', () =>
    expect(detectEmoteSource('https://static-cdn.jtvnw.net/emoticons/v2/1/default/dark/2.0')).toBe('twitch'))
  test('kick url', () => expect(detectEmoteSource('https://files.kick.com/emotes/1/fullsize')).toBe('kick'))
  test('heatsync url', () => expect(detectEmoteSource('https://heatsync.org/uploads/x.png')).toBe('heatsync'))
  test('unknown url with no hint → "unknown"', () =>
    expect(detectEmoteSource('https://evil.example/x.png')).toBe('unknown'))
  test('unknown url WITH hint → hint used', () =>
    expect(detectEmoteSource('https://evil.example/x.png', 'kick')).toBe('kick'))
  test('null url with hint → hint', () => expect(detectEmoteSource(null, '7tv')).toBe('7tv'))
  test('null url no hint → "unknown"', () => expect(detectEmoteSource(null)).toBe('unknown'))
})

// ── getEmoteState ────────────────────────────────────────────────────────────

describe('getEmoteState', () => {
  test('name in inventoryEmotes → "owned" regardless of source', () => {
    inventoryEmotes.add('PogChamp')
    expect(getEmoteState('PogChamp', 'heatsync')).toBe('owned')
    expect(getEmoteState('PogChamp', '7tv')).toBe('owned')
  })
  test('third-party source not owned → "global"', () => {
    for (const src of ['7tv', 'bttv', 'ffz', 'twitch', 'kick']) {
      expect(getEmoteState('Foo', src)).toBe('global')
    }
  })
  test('heatsync source, not owned → "unadded"', () => {
    expect(getEmoteState('Foo', 'heatsync')).toBe('unadded')
  })
  test('unknown source, not owned → "unadded" (falls through)', () => {
    expect(getEmoteState('Foo', 'unknown')).toBe('unadded')
  })
})

// ── lookupEmote precedence: inventory > global > channel(tab/live/current) > removed > blocked ──

describe('lookupEmote precedence', () => {
  test('viewer personal (inventory) wins over everything else', () => {
    viewerPersonalEmotes.set('Foo', { url: 'inventory-url' })
    emoteCache.set('Foo', { url: 'global-url' })
    channelEmoteCaches['chan-a'] = new Map([['Foo', { url: 'channel-url' }]])
    expect(lookupEmote('Foo').url).toBe('inventory-url')
  })

  test('global (emoteCache) wins over channel caches when not in inventory', () => {
    emoteCache.set('Foo', { url: 'global-url' })
    channelEmoteCaches['chan-a'] = new Map([['Foo', { url: 'channel-url' }]])
    expect(lookupEmote('Foo').url).toBe('global-url')
  })

  test('falls through to currentTab channel cache', () => {
    channelEmoteCaches['chan-a'] = new Map([['Foo', { url: 'tab-url' }]])
    expect(lookupEmote('Foo').url).toBe('tab-url')
  })

  test('falls through to getLiveChannel() cache when currentTab cache misses', () => {
    globalThis.currentTab = 'other-tab'
    globalThis.getLiveChannel = () => 'live-chan'
    channelEmoteCaches['live-chan'] = new Map([['Foo', { url: 'live-url' }]])
    expect(lookupEmote('Foo').url).toBe('live-url')
  })

  test('falls through to getCurrentChannel() cache when tab + live both miss', () => {
    globalThis.currentTab = 'other-tab'
    globalThis.getLiveChannel = () => 'other-live'
    globalThis.getCurrentChannel = () => 'current-chan'
    channelEmoteCaches['current-chan'] = new Map([['Foo', { url: 'current-url' }]])
    expect(lookupEmote('Foo').url).toBe('current-url')
  })

  test('falls through to removedEmoteFallback when no live cache has it', () => {
    removedEmoteFallback.set('Foo', { url: 'removed-url', source: 'heatsync', zeroWidth: false })
    expect(lookupEmote('Foo').url).toBe('removed-url')
  })

  test('blockedEmoteFallback is the last resort', () => {
    blockedEmoteFallback.set('Foo', { url: 'blocked-url', source: 'heatsync', zeroWidth: false })
    expect(lookupEmote('Foo').url).toBe('blocked-url')
  })

  test('removedEmoteFallback beats blockedEmoteFallback', () => {
    removedEmoteFallback.set('Foo', { url: 'removed-url' })
    blockedEmoteFallback.set('Foo', { url: 'blocked-url' })
    expect(lookupEmote('Foo').url).toBe('removed-url')
  })

  test('unknown name resolves to undefined', () => {
    expect(lookupEmote('DoesNotExist')).toBeUndefined()
  })
})

// ── lookupOwnedEmote ─────────────────────────────────────────────────────────

test('lookupOwnedEmote only ever returns from viewerPersonalEmotes', () => {
  emoteCache.set('Foo', { url: 'global-url' })
  expect(lookupOwnedEmote('Foo')).toBeUndefined()
  viewerPersonalEmotes.set('Foo', { url: 'owned-url' })
  expect(lookupOwnedEmote('Foo').url).toBe('owned-url')
})

// ── lookupEmoteRenderOrder (composer preview) / lookupEmoteWireOrder (kick wire form) ──

describe('lookupEmoteRenderOrder precedence (inventory-first, like a sent line)', () => {
  test("inventory wins over the channel cache — your own emote over the room's of the same name", () => {
    viewerPersonalEmotes.set('Foo', { url: 'inventory-url' })
    channelEmoteCaches['chan-a'] = new Map([['Foo', { url: 'channel-url' }]])
    expect(lookupEmoteRenderOrder('Foo').url).toBe('inventory-url')
  })

  test('channel wins over global when not owned', () => {
    channelEmoteCaches['chan-a'] = new Map([['Foo', { url: 'channel-url' }]])
    emoteCache.set('Foo', { url: 'global-url' })
    expect(lookupEmoteRenderOrder('Foo').url).toBe('channel-url')
  })

  test('inventory wins over global when no channel hit', () => {
    viewerPersonalEmotes.set('Foo', { url: 'inventory-url' })
    emoteCache.set('Foo', { url: 'global-url' })
    expect(lookupEmoteRenderOrder('Foo').url).toBe('inventory-url')
  })

  test('global wins when neither channel nor inventory has it', () => {
    emoteCache.set('Foo', { url: 'global-url' })
    expect(lookupEmoteRenderOrder('Foo').url).toBe('global-url')
  })

  test('removed/blocked fallbacks still apply last', () => {
    removedEmoteFallback.set('Foo', { url: 'removed-url' })
    expect(lookupEmoteRenderOrder('Foo').url).toBe('removed-url')
  })
})

describe('lookupEmoteWireOrder precedence (channel-first: kick-native stays kick-native)', () => {
  test('a kick channel emote beats an owned emote of the same name', () => {
    viewerPersonalEmotes.set('Foo', { url: 'inventory-url', source: '7tv' })
    channelEmoteCaches['chan-a'] = new Map([['Foo', { url: 'kick-url', source: 'kick' }]])
    expect(lookupEmoteWireOrder('Foo').url).toBe('kick-url')
    expect(lookupEmoteRenderOrder('Foo').url).toBe('inventory-url')
  })

  test('inventory beats global, fallbacks last', () => {
    viewerPersonalEmotes.set('Foo', { url: 'inventory-url' })
    emoteCache.set('Foo', { url: 'global-url' })
    expect(lookupEmoteWireOrder('Foo').url).toBe('inventory-url')
    removedEmoteFallback.set('Bar', { url: 'removed-url' })
    expect(lookupEmoteWireOrder('Bar').url).toBe('removed-url')
  })
})

// ── zeroWidthFromAnyCache ────────────────────────────────────────────────────

describe('zeroWidthFromAnyCache', () => {
  test('false when name is in no cache', () => {
    expect(zeroWidthFromAnyCache('Nope')).toBe(false)
  })
  test('true when global emoteCache entry has zeroWidth', () => {
    emoteCache.set('Wave', { url: 'x', zeroWidth: true })
    expect(zeroWidthFromAnyCache('Wave')).toBe(true)
  })
  test('true when ANY channel cache entry has zeroWidth (scans all channels)', () => {
    channelEmoteCaches['some-other-chan'] = new Map([['Wave', { url: 'x', zeroWidth: true }]])
    expect(zeroWidthFromAnyCache('Wave')).toBe(true)
  })
  test('false when cache entry exists but zeroWidth is falsy', () => {
    emoteCache.set('Wave', { url: 'x', zeroWidth: false })
    expect(zeroWidthFromAnyCache('Wave')).toBe(false)
  })
})

// ── lookupEmoteWithOverlay: name0 overlay convention + zeroWidth stacking ────

describe('lookupEmoteWithOverlay', () => {
  test('literal name hit with zeroWidth flag → isOverlay true, displayName unchanged', () => {
    viewerPersonalEmotes.set('Wave', { url: 'x', zeroWidth: true })
    const r = lookupEmoteWithOverlay('Wave')
    expect(r.isOverlay).toBe(true)
    expect(r.displayName).toBe('Wave')
    expect(r.emote.url).toBe('x')
  })

  test('literal name hit WITHOUT zeroWidth flag but recoverable from another cache → isOverlay true', () => {
    // owned copy shadows the flagged channel/global entry and loses the flag itself
    viewerPersonalEmotes.set('Wave', { url: 'x', zeroWidth: false })
    emoteCache.set('Wave', { url: 'y', zeroWidth: true })
    const r = lookupEmoteWithOverlay('Wave')
    expect(r.isOverlay).toBe(true)
    expect(r.emote.url).toBe('x') // still resolves the owned copy's data
  })

  test('a REAL emote literally named "TriHard0" wins over the trailing-0 overlay heuristic', () => {
    viewerPersonalEmotes.set('TriHard0', { url: 'real-trihard0-url', zeroWidth: false })
    viewerPersonalEmotes.set('TriHard', { url: 'base-trihard-url', zeroWidth: false })
    const r = lookupEmoteWithOverlay('TriHard0')
    expect(r.emote.url).toBe('real-trihard0-url')
    expect(r.isOverlay).toBe(false)
    expect(r.displayName).toBe('TriHard0')
  })

  test('no literal "name0" hit → falls back to base-name overlay convention', () => {
    viewerPersonalEmotes.set('TriHard', { url: 'base-trihard-url' })
    const r = lookupEmoteWithOverlay('TriHard0')
    expect(r).not.toBeNull()
    expect(r.emote.url).toBe('base-trihard-url')
    expect(r.isOverlay).toBe(true)
    expect(r.displayName).toBe('TriHard0')
  })

  test('no hit at all (literal or base) → null', () => {
    expect(lookupEmoteWithOverlay('CompletelyUnknown0')).toBeNull()
  })

  test('name without trailing 0 and no hit → null (no base-name fallback attempted)', () => {
    expect(lookupEmoteWithOverlay('CompletelyUnknown')).toBeNull()
  })

  test('single-char name "0" is never treated as an overlay candidate (length > 1 guard)', () => {
    viewerPersonalEmotes.set('0', { url: 'zero-url' })
    const r = lookupEmoteWithOverlay('0')
    expect(r.emote.url).toBe('zero-url')
    expect(r.isOverlay).toBe(false)
  })

  test('ownedOnly:true restricts resolution to viewerPersonalEmotes only', () => {
    channelEmoteCaches['chan-a'] = new Map([['Foo', { url: 'channel-url' }]])
    expect(lookupEmoteWithOverlay('Foo', { ownedOnly: true })).toBeNull()
    viewerPersonalEmotes.set('Foo', { url: 'owned-url' })
    expect(lookupEmoteWithOverlay('Foo', { ownedOnly: true }).emote.url).toBe('owned-url')
  })

  test('ownedOnly:true also restricts the name0 base-lookup to owned set', () => {
    channelEmoteCaches['chan-a'] = new Map([['TriHard', { url: 'channel-trihard' }]])
    expect(lookupEmoteWithOverlay('TriHard0', { ownedOnly: true })).toBeNull()
    viewerPersonalEmotes.set('TriHard', { url: 'owned-trihard' })
    const r = lookupEmoteWithOverlay('TriHard0', { ownedOnly: true })
    expect(r.emote.url).toBe('owned-trihard')
    expect(r.isOverlay).toBe(true)
  })
})

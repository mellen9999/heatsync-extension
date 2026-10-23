/**
 * Unit tests for the emote provider-priority merge (7tv/bttv/ffz collision
 * winner) — src/lib/utils.js pure helpers, plus an integration check through
 * src/multichat/emotes.js's real channel-tier merge (_buildChannelEmoteCache)
 * to prove the wiring picks the same winner as the pure function.
 *
 * emotes.js runs concatenated into the multichat bundle sharing top-level
 * scope with main.js — stub the bundle-globals it reads, same pattern as
 * emote-precedence.test.js.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import * as mods from '../src/lib/modifiers.js'
import { emoteProviderOrder, resolveEmoteProviderWinner } from '../src/lib/utils.js'

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
// resolveEmoteProviderWinner is concatenated in from src/lib/utils.js by the
// real bundle (build.js) — stub it here, same as the HS_MOD_* bridge above.
globalThis.resolveEmoteProviderWinner = resolveEmoteProviderWinner

const { _buildChannelEmoteCache, channelEmoteCaches, inventoryEmotes } = await import('../src/multichat/emotes.js')

beforeEach(() => {
  for (const k of Object.keys(channelEmoteCaches)) delete channelEmoteCaches[k]
  inventoryEmotes.clear()
})

// ── emoteProviderOrder (pure) ───────────────────────────────────────────────

describe('emoteProviderOrder', () => {
  test('default winner order matches the pre-existing hardcoded merge (7tv > ffz > bttv)', () => {
    expect(emoteProviderOrder('7tv')).toEqual(['7tv', 'ffz', 'bttv'])
  })

  test('bttv preferred → promoted to front, ffz/7tv keep relative order', () => {
    expect(emoteProviderOrder('bttv')).toEqual(['bttv', '7tv', 'ffz'])
  })

  test('ffz preferred → promoted to front', () => {
    expect(emoteProviderOrder('ffz')).toEqual(['ffz', '7tv', 'bttv'])
  })

  test('unknown/missing preference falls back to the original hardcoded order', () => {
    expect(emoteProviderOrder(undefined)).toEqual(['7tv', 'ffz', 'bttv'])
    expect(emoteProviderOrder('nope')).toEqual(['7tv', 'ffz', 'bttv'])
  })
})

// ── resolveEmoteProviderWinner (pure) ───────────────────────────────────────

describe('resolveEmoteProviderWinner', () => {
  test('no existing entry → incoming always wins', () => {
    const incoming = { source: 'bttv' }
    expect(resolveEmoteProviderWinner(null, incoming, '7tv')).toBe(incoming)
    expect(resolveEmoteProviderWinner(undefined, incoming, '7tv')).toBe(incoming)
  })

  test('default priority (7tv): 7tv beats bttv regardless of arrival order', () => {
    const bttv = { source: 'bttv' }
    const sevenTv = { source: '7tv' }
    expect(resolveEmoteProviderWinner(bttv, sevenTv, '7tv')).toBe(sevenTv) // 7tv arrives after → wins
    expect(resolveEmoteProviderWinner(sevenTv, bttv, '7tv')).toBe(sevenTv) // 7tv arrived first → still wins
  })

  test('default priority (7tv): ffz beats bttv', () => {
    const bttv = { source: 'bttv' }
    const ffz = { source: 'ffz' }
    expect(resolveEmoteProviderWinner(bttv, ffz, '7tv')).toBe(ffz)
    expect(resolveEmoteProviderWinner(ffz, bttv, '7tv')).toBe(ffz) // bttv arrives after but is lower priority → ffz stays
  })

  test('non-default priority (bttv): bttv beats 7tv', () => {
    const sevenTv = { source: '7tv' }
    const bttv = { source: 'bttv' }
    expect(resolveEmoteProviderWinner(sevenTv, bttv, 'bttv')).toBe(bttv)
    expect(resolveEmoteProviderWinner(bttv, sevenTv, 'bttv')).toBe(bttv)
  })

  test('3-way collision: sequential merge (as the real pool builders do) picks the priority winner', () => {
    const bttv = { source: 'bttv', url: 'bttv-url' }
    const ffz = { source: 'ffz', url: 'ffz-url' }
    const sevenTv = { source: '7tv', url: '7tv-url' }

    // default order in every real caller: bttv, ffz, sevenTv
    let winner = null
    for (const e of [bttv, ffz, sevenTv]) winner = resolveEmoteProviderWinner(winner, e, '7tv')
    expect(winner).toBe(sevenTv)

    winner = null
    for (const e of [bttv, ffz, sevenTv]) winner = resolveEmoteProviderWinner(winner, e, 'bttv')
    expect(winner).toBe(bttv)

    winner = null
    for (const e of [bttv, ffz, sevenTv]) winner = resolveEmoteProviderWinner(winner, e, 'ffz')
    expect(winner).toBe(ffz)
  })

  test('cross-tier pairing (heatsync/twitch/kick vs third-party) is untouched — default last-write-wins', () => {
    const heatsync = { source: 'heatsync' }
    const sevenTv = { source: '7tv' }
    const twitch = { source: 'twitch' }
    // heatsync then 7tv → 7tv (incoming) wins, same as plain Map.set would
    expect(resolveEmoteProviderWinner(heatsync, sevenTv, 'bttv')).toBe(sevenTv)
    // 7tv then twitch (native, processed last in the real array) → twitch wins
    expect(resolveEmoteProviderWinner(sevenTv, twitch, 'bttv')).toBe(twitch)
  })

  test('same-provider refresh (name update from the same provider) always takes the incoming copy', () => {
    const older = { source: '7tv', url: 'old' }
    const newer = { source: '7tv', url: 'new' }
    expect(resolveEmoteProviderWinner(older, newer, 'bttv')).toBe(newer)
  })
})

// ── _buildChannelEmoteCache integration — default behavior unchanged ───────

describe('_buildChannelEmoteCache: provider-priority wiring', () => {
  test('default priority (ffz, 2026-10-23): same-name bttv/ffz/7tv channel emotes resolve to ffz', () => {
    const emotes = [
      { name: 'Cabge', url: 'https://cdn.betterttv.net/emote/1/1x.webp', source: 'bttv' },
      { name: 'Cabge', url: 'https://cdn.frankerfacez.com/emote/1/1', source: 'ffz' },
      { name: 'Cabge', url: 'https://cdn.7tv.app/emote/1/1x.webp', source: '7tv' },
    ]
    _buildChannelEmoteCache('chan-a', emotes, 'twitch')
    const entry = channelEmoteCaches['chan-a'].get('Cabge')
    expect(entry.source).toBe('ffz')
    expect(entry.url).toBe('https://cdn.frankerfacez.com/emote/1/1')
  })

  test('non-colliding names all survive the merge', () => {
    const emotes = [
      { name: 'bttvOnly', url: 'https://cdn.betterttv.net/emote/2/1x.webp', source: 'bttv' },
      { name: 'ffzOnly', url: 'https://cdn.frankerfacez.com/emote/2/1', source: 'ffz' },
      { name: '7tvOnly', url: 'https://cdn.7tv.app/emote/2/1x.webp', source: '7tv' },
    ]
    _buildChannelEmoteCache('chan-a', emotes, 'twitch')
    const cache = channelEmoteCaches['chan-a']
    expect(cache.get('bttvOnly').source).toBe('bttv')
    expect(cache.get('ffzOnly').source).toBe('ffz')
    expect(cache.get('7tvOnly').source).toBe('7tv')
  })
})

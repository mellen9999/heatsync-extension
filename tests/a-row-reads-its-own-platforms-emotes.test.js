// a twitch channel and a kick channel of one name share a set (every consumer reads the bare
// name). each platform keeps its own list inside it: a kick row draws kick's emote of a name both
// have, a name only kick has is text on a twitch row, and a send to kick ships kick's
// (emote law, read 3 + "a stream on several platforms resolves each row against its own
// platform's emotes"). the set used to be one bare-name map, last writer wins.
import { beforeEach, describe, expect, test } from 'bun:test'
import * as mods from '../src/lib/modifiers.js'
import { EMOTE_TIER_ORDER, escapeHtml, resolveEmoteProviderWinner, unescapeHtml } from '../src/lib/utils.js'
import './emote-rungs-globals.js'
import { lawSendRig } from './helpers/law-send-rig.js'

globalThis.escapeHtml = escapeHtml
globalThis.unescapeHtml = unescapeHtml
globalThis.evictChannelEmoteCaches = () => {}
globalThis.cleanup = { setIntervalIfVisible: () => {}, persistInterval: () => {} }
globalThis.HS_MOD_TOKENS = mods.HS_MOD_TOKENS
globalThis.hsModClassify = mods.hsModClassify
globalThis.hsModBuildStyleAttr = mods.hsModBuildStyleAttr
globalThis.hsModInjectWrapperStyle = mods.hsModInjectWrapperStyle
globalThis.hsModComposeFilter = mods.hsModComposeFilter
globalThis.hsModHexToHue = mods.hsModHexToHue
globalThis.hsModPeelChain = mods.hsModPeelChain
globalThis.HS_MOD_C_HEX_RE = /^c!#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
globalThis.currentTab = 'chan'
globalThis.getCurrentChannel = () => 'chan'
globalThis.getLiveChannel = () => 'chan'
globalThis.linksEnabled = false
globalThis.getSetting = () => undefined
globalThis.resolveEmoteProviderWinner = resolveEmoteProviderWinner
globalThis.EMOTE_TIER_ORDER = EMOTE_TIER_ORDER

const {
  _buildChannelEmoteCache: build,
  channelEmoteCaches,
  emoteCache,
  inventoryEmotes,
  processEmotes,
  viewerPersonalEmotes,
} = await import('../src/multichat/emotes.js')
const { channelRoomNames } = globalThis // emote-rooms.js, preloaded as the bundle global it is
const send = lawSendRig({ viewerPersonalEmotes, emoteCache, channelEmoteCaches })

const stv = (name, id) => ({ name, url: `https://cdn.7tv.app/emote/${id}/2x.webp`, source: '7tv', hash: id })
const kickOwn = (name, id) => ({ name, url: `https://files.kick.com/emotes/${id}/fullsize`, source: 'kick' })
const row = (text, platform) => processEmotes(text, 'chan', null, null, 1, true, null, null, platform)
const TW = '01TWITCHSIDE0000000000000'
const KI = '01KICKSIDE000000000000000'

beforeEach(() => {
  for (const k of Object.keys(channelEmoteCaches)) delete channelEmoteCaches[k]
  inventoryEmotes.clear()
  viewerPersonalEmotes.clear()
  emoteCache.clear()
  send.reset()
})

describe('a name both platforms have', () => {
  for (const order of [
    ['twitch', 'kick'],
    ['kick', 'twitch'],
  ]) {
    test(`each row draws its own platform's, lists loaded ${order.join(' then ')}`, () => {
      for (const p of order) build('chan', [stv('KEKW', p === 'twitch' ? TW : KI)], p)
      expect(row('KEKW', 'twitch')).toContain(TW)
      expect(row('KEKW', 'twitch')).not.toContain(KI)
      expect(row('KEKW', 'kick')).toContain(KI)
      expect(row('KEKW', 'kick')).not.toContain(TW)
      // a reader that names no platform (the picker, the page's own chat) gets twitch's first
      expect(row('KEKW')).toContain(TW)
      expect(channelEmoteCaches.chan.get('KEKW').url).toContain(TW)
    })
  }

  test('a send ships the emote of the platform it goes to', () => {
    build('chan', [stv('KEKW', TW)], 'twitch')
    build('chan', [kickOwn('KEKW', '37226')], 'kick')
    expect(send.lawChip('KEKW', { twitch: 'chan' }).e.url).toContain(TW)
    expect(send.lawChip('KEKW', { kick: 'chan' }).e.url).toContain('37226')
    expect(send.lawShip('hi KEKW', { kick: 'chan' }, send.box).wire.kick).toBe('hi [emote:37226:KEKW]')
    // both at once: one answer, the first platform's (twitch), and kick gets the bare word
    const both = send.lawShip('hi KEKW', { twitch: 'chan', kick: 'chan' }, send.box)
    expect(both.refs.KEKW.id || both.refs.KEKW.url).toContain(TW)
  })
})

describe('a name only one platform has', () => {
  test("is text on the other platform's row", () => {
    build('chan', [stv('TwOnly', TW)], 'twitch')
    build('chan', [stv('KiOnly', KI)], 'kick')
    expect(row('TwOnly KiOnly', 'twitch')).toContain(TW)
    expect(row('TwOnly KiOnly', 'twitch')).not.toContain(KI)
    expect(row('TwOnly KiOnly', 'kick')).toContain(KI)
    expect(row('TwOnly KiOnly', 'kick')).not.toContain(TW)
    expect(send.lawChip('TwOnly', { kick: 'chan' })).toBe(null)
  })

  test('a platform whose list has not landed borrows nothing; its rows draw when it does', () => {
    build('chan', [stv('KEKW', KI)], 'kick')
    expect(row('KEKW', 'twitch')).toBe('KEKW')
    build('chan', [stv('KEKW', TW)], 'twitch')
    expect(row('KEKW', 'twitch')).toContain(TW)
  })
})

describe('the set', () => {
  test("an update replaces its own platform's list and leaves the other whole", () => {
    build('chan', [stv('KEKW', TW), stv('Gone', TW)], 'twitch')
    build('chan', [stv('KEKW', KI)], 'kick')
    const set = channelEmoteCaches.chan
    build('chan', [stv('Other', TW)], 'twitch')
    expect(channelEmoteCaches.chan).toBe(set) // callers hold the Map: refilled in place
    expect(row('KEKW Gone', 'twitch')).toBe('KEKW Gone')
    expect(row('KEKW', 'kick')).toContain(KI)
    expect(set.has('Gone')).toBe(false)
    expect(set.get('KEKW').url).toContain(KI)
  })

  test('what the page scan found before the lists stays, under every platform; a list beats it', () => {
    const scanned = { url: 'https://cdn.example/scan.webp', source: 'unknown', state: 'channel', zeroWidth: false }
    channelEmoteCaches.chan = new Map([
      ['Scanned', scanned],
      ['KEKW', scanned],
    ])
    build('chan', [stv('KEKW', TW)], 'twitch')
    build('chan', [stv('Other', KI)], 'kick')
    expect(channelRoomNames(channelEmoteCaches.chan, 'twitch').get('Scanned')).toBe(scanned)
    expect(channelRoomNames(channelEmoteCaches.chan, 'kick').get('Scanned')).toBe(scanned)
    expect(channelRoomNames(channelEmoteCaches.chan, 'twitch').get('KEKW').url).toContain(TW)
    expect(channelRoomNames(channelEmoteCaches.chan, 'kick').get('KEKW')).toBe(scanned)
    // a refetch never loses it
    build('chan', [], 'twitch')
    expect(channelRoomNames(channelEmoteCaches.chan, 'twitch').get('Scanned')).toBe(scanned)
  })

  test('with no platform lists (the scan alone, a fixture) is one room for any row', () => {
    const set = new Map([['KEKW', { url: 'https://cdn.7tv.app/emote/X/2x.webp', source: '7tv', state: 'channel' }]])
    channelEmoteCaches.chan = set
    expect(channelRoomNames(set, 'kick')).toBe(set)
    expect(channelRoomNames(set, 'twitch')).toBe(set)
    expect(row('KEKW', 'kick')).toContain('/emote/X/')
    expect(channelRoomNames(null, 'kick')).toBe(null)
  })

  test('a row of a platform the set does not split by reads the whole set', () => {
    build('chan', [stv('KEKW', TW)], 'twitch')
    const set = channelEmoteCaches.chan
    expect(channelRoomNames(set, undefined)).toBe(set)
    expect(channelRoomNames(set, 'heatsync')).toBe(set)
    expect(row('KEKW', 'heatsync')).toContain(TW)
  })

  test('youtube is one platform under either spelling, and its alias key is the same room', () => {
    build('@handle', [stv('KEKW', TW)], 'yt')
    channelEmoteCaches.handle = channelEmoteCaches['@handle']
    expect(channelRoomNames(channelEmoteCaches.handle, 'youtube').get('KEKW').url).toContain(TW)
    expect(channelRoomNames(channelEmoteCaches.handle, 'yt')).toBe(
      channelRoomNames(channelEmoteCaches['@handle'], 'youtube'),
    )
    expect(processEmotes('KEKW', 'handle', null, null, 1, true, null, null, 'youtube')).toContain(TW)
  })

  test("a platform's list is capped on its own", () => {
    const many = []
    for (let i = 0; i < 2100; i++) many.push(stv(`E${i}`, `ID${i}`))
    build('chan', many, 'twitch')
    build('chan', [stv('KEKW', KI)], 'kick')
    expect(channelRoomNames(channelEmoteCaches.chan, 'twitch').size).toBe(2000)
    expect(channelRoomNames(channelEmoteCaches.chan, 'kick').size).toBe(1)
  })
})

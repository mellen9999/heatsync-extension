/**
 * whyEmote (console: __hsWhy('gg')) — says which store holds a name and which
 * gate would hold it back, from the same stores processEmotes reads.
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
globalThis.window = globalThis
globalThis.currentTab = 'chan-a'
globalThis.getCurrentChannel = () => 'chan-a'
globalThis.getLiveChannel = () => 'chan-a'

const { blockedEmoteNames, channelEmoteCaches, emoteCache, whyEmote } = await import('../src/multichat/emotes.js')

const gg = { url: 'https://cdn.7tv.app/emote/AAA/1x.avif', source: '7tv', state: 'channel', hash: 'AAA' }

describe('whyEmote', () => {
  beforeEach(() => {
    for (const k of Object.keys(channelEmoteCaches)) delete channelEmoteCaches[k]
    emoteCache.clear()
    blockedEmoteNames.clear()
  })

  test('name in the channel set draws', () => {
    channelEmoteCaches['chan-a'] = new Map([['gg', gg]])
    const r = whyEmote('gg')
    expect(r.verdict).toBe('found and would draw')
    expect(r.channels['chan-a'].entry.source).toBe('7tv')
  })

  test('name missing everywhere says so and reports the channel size', () => {
    channelEmoteCaches['chan-a'] = new Map([['other', gg]])
    const r = whyEmote('gg')
    expect(r.verdict).toContain('no emote store')
    expect(r.verdict).toContain('has 1 emotes')
  })

  test('a blocked name is held back, and says why', () => {
    channelEmoteCaches['chan-a'] = new Map([['gg', gg]])
    blockedEmoteNames.add('gg')
    expect(whyEmote('gg').verdict).toBe('found, but held back by blockedByName')
  })

  test('a name only in another channel is not "found" here', () => {
    channelEmoteCaches['chan-b'] = new Map([['gg', gg]])
    const r = whyEmote('gg')
    expect(r.verdict).toContain('no emote store')
    expect(r.channels['chan-b'].entry.hash).toBe('AAA')
  })
})

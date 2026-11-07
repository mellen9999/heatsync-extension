// the picker grid lists every channel pool the tab covers (merged / yt tabs), like search and Tab
import { expect, test } from 'bun:test'
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
globalThis.currentTab = 'merged-1'
globalThis.getCurrentChannel = () => 'other'
globalThis.getLiveChannel = () => 'other'
globalThis.getChannelById = (id) => (id === 'merged-1' ? { twitch: 'kripp', kick: 'kripp_k' } : null)
globalThis.linksEnabled = false
globalThis.getSetting = () => undefined

const { pickerBaseEmotes, channelEmoteCaches, emoteCache, viewerPersonalEmotes } = await import(
  '../src/multichat/emotes.js'
)

test('a merged tab lists the emotes of every channel it spans, mine first, globals last', () => {
  // bun runs every file on ONE globalThis: set what this reads at call time, not at import
  globalThis.currentTab = 'merged-1'
  globalThis.getCurrentChannel = () => 'other'
  globalThis.getLiveChannel = () => 'other'
  globalThis.getChannelById = (id) => (id === 'merged-1' ? { twitch: 'kripp', kick: 'kripp_k' } : null)
  viewerPersonalEmotes.clear()
  emoteCache.clear()
  channelEmoteCaches.kripp = new Map([['TwitchOnly', { url: 'u1', source: '7tv' }]])
  channelEmoteCaches.kripp_k = new Map([['KickOnly', { url: 'u2', source: '7tv' }]])
  viewerPersonalEmotes.set('Mine', { url: 'u3' })
  emoteCache.set('Glob', { url: 'u4' })
  try {
    expect([...pickerBaseEmotes().keys()]).toEqual(['Mine', 'TwitchOnly', 'KickOnly', 'Glob'])
  } finally {
    delete channelEmoteCaches.kripp
    delete channelEmoteCaches.kripp_k
    viewerPersonalEmotes.delete('Mine')
    emoteCache.delete('Glob')
  }
})

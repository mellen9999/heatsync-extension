// rule 1: a platform token (twitch IRC emotes= tag, kick [emote:id:name]) is exact by position;
// a same-name channel / sender / 7tv / bttv emote never replaces it.
import { expect, test } from 'bun:test'
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

const { processEmotes, channelEmoteCaches } = await import('../src/multichat/emotes.js')

const TAG = 'https://static-cdn.jtvnw.net/emoticons/v2/TAGID/default/dark/2.0'
const CHAN = 'https://cdn.7tv.app/emote/01CHANNELKEKW00000000000/2x.webp'

function withChannel(fn) {
  channelEmoteCaches['chan-x'] = new Map([['KEKW', { url: CHAN, source: '7tv', state: 'channel' }]])
  try {
    return fn()
  } finally {
    delete channelEmoteCaches['chan-x']
  }
}

test('irc-tag emote beats a same-name channel emote', () =>
  withChannel(() => {
    const extra = new Map([['KEKW', { url: TAG, source: 'twitch', state: 'global', zeroWidth: false }]])
    const out = processEmotes('KEKW', 'chan-x', extra, null, 1)
    expect(out).toContain('TAGID')
    expect(out).not.toContain('01CHANNELKEKW')
  }))

test('no tag: the channel emote still draws', () =>
  withChannel(() => {
    expect(processEmotes('KEKW', 'chan-x', null, null, 1)).toContain('01CHANNELKEKW')
  }))

test('kick token beats a same-name channel 7tv emote', () =>
  withChannel(() => {
    const out = processEmotes('[emote:123:KEKW]', 'chan-x', null, null, 1)
    expect(out).toContain('files.kick.com/emotes/123/')
    expect(out).not.toContain('01CHANNELKEKW')
  }))

test('kick token still uses the richer copy of the SAME kick emote', () => {
  channelEmoteCaches['chan-x'] = new Map([
    ['KEKW', { url: 'https://cdn.example/kick-123.webp', source: 'kick', state: 'channel', hash: '123' }],
  ])
  try {
    expect(processEmotes('[emote:123:KEKW]', 'chan-x', null, null, 1)).toContain('kick-123.webp')
  } finally {
    delete channelEmoteCaches['chan-x']
  }
})

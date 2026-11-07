// rule 10: "yours" is the exact emote, not the name. Owning W must not make another chatter's
// channel W read as owned (right-click would remove YOUR W instead of blocking theirs).
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
globalThis.currentTab = 'chan-a'
globalThis.getCurrentChannel = () => 'chan-a'
globalThis.getLiveChannel = () => 'chan-a'
globalThis.linksEnabled = false
globalThis.getSetting = () => undefined

const { processEmotes, channelEmoteCaches, inventoryEmotes, isViewerEmote, isViewerEmoteUrl, viewerPersonalEmotes } =
  await import('../src/multichat/emotes.js')

const MINE = 'https://cdn.7tv.app/emote/01MINEKEKW0000000000000000/2x.webp'
const THEIRS = 'https://cdn.7tv.app/emote/01THEIRSKEKW00000000000000/2x.webp'

test('isViewerEmote: your W is the same picture at any rung; another W is not', () => {
  inventoryEmotes.add('KEKW')
  viewerPersonalEmotes.set('KEKW', { url: MINE, source: '7tv', state: 'owned' })
  try {
    expect(isViewerEmote('KEKW', { url: THEIRS })).toBe(false)
    expect(isViewerEmote('KEKW', { url: MINE.replace('2x', '4x') })).toBe(true)
    expect(isViewerEmoteUrl('KEKW', THEIRS, 'h')).toBe(false)
    expect(isViewerEmote('Other', { url: MINE })).toBe(false)
  } finally {
    inventoryEmotes.delete('KEKW')
    viewerPersonalEmotes.delete('KEKW')
  }
})

test("another chatter's channel W is not stamped owned while you own a different W", () => {
  channelEmoteCaches['chan-x'] = new Map([['KEKW', { url: THEIRS, source: '7tv', state: 'channel' }]])
  inventoryEmotes.add('KEKW')
  viewerPersonalEmotes.set('KEKW', { url: MINE, source: '7tv', state: 'owned' })
  try {
    const out = processEmotes('KEKW', 'chan-x', null, null, 1)
    expect(out).toContain('01THEIRSKEKW')
    expect(out).toContain('data-state="channel"')
    expect(out).not.toContain('data-state="owned"')
  } finally {
    inventoryEmotes.delete('KEKW')
    viewerPersonalEmotes.delete('KEKW')
    delete channelEmoteCaches['chan-x']
  }
})

test('two heatsync-hosted uploads are two emotes (the file name is the identity there)', () => {
  inventoryEmotes.add('KEKW')
  viewerPersonalEmotes.set('KEKW', { url: 'https://cdn.heatsync.org/uploads/aaa.webp' })
  try {
    expect(isViewerEmote('KEKW', { url: 'https://cdn.heatsync.org/uploads/bbb.webp' })).toBe(false)
    expect(isViewerEmote('KEKW', { url: 'https://cdn.heatsync.org/uploads/aaa.webp' })).toBe(true)
  } finally {
    inventoryEmotes.delete('KEKW')
    viewerPersonalEmotes.delete('KEKW')
  }
})

test("a sender-set W stamped 'owned' by name is not yours when your W is a different emote", () => {
  inventoryEmotes.add('KEKW')
  viewerPersonalEmotes.set('KEKW', { url: MINE, source: '7tv', state: 'owned', hash: 'mine' })
  try {
    const sender = new Map([['KEKW', { url: THEIRS, source: 'heatsync', state: 'owned', hash: 'theirs' }]])
    const out = processEmotes('KEKW', 'chan-x', null, sender, undefined, true)
    expect(out).toContain('01THEIRSKEKW')
    expect(out).not.toContain('data-state="owned"')
  } finally {
    inventoryEmotes.delete('KEKW')
    viewerPersonalEmotes.delete('KEKW')
  }
})

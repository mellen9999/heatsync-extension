/**
 * Click-paste auto-add registration — registerClickPasteForAutoAdd
 * (src/multichat/input.js).
 *
 * Regression anchor (GODNO, 2026-07-20): clicking another sender's personal
 * emote in a chat row pasted a chip that rendered locally (optimistic
 * viewerPersonalEmotes seed) but registered nothing for auto-add-on-send —
 * the send committed no slot, so the emote painted as an image for the
 * clicker and raw text for every other viewer. The 2-state contract says
 * "click pastes, auto-add commits the slot at send"; registration is the
 * missing link between those.
 *
 * Carved out of the non-module content-script bundle and evaluated standalone
 * (same rationale as tab-cycle-pagination.test.js).
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const INPUT_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
const start = INPUT_SRC.indexOf('const recentRemoteCompletions = new Map()')
const end = INPUT_SRC.indexOf('// Native twitch chat parity:')
if (start === -1 || end === -1 || end <= start) throw new Error('click-paste carve markers not found')

const ASSET_ID_RE = /(?:cdn\.7tv\.app|cdn\.betterttv\.net|cdn\.frankerfacez\.com)\/emote\/([^/]+)/

function build({ senderSets = new Map(), renderOrder = () => null, sameAsset = () => false } = {}) {
  const fns = new Function(
    'lookupEmoteRenderOrder',
    'senderEmoteSets',
    'zeroWidthForSameAsset',
    '_hsEmoteAssetId',
    `${INPUT_SRC.slice(start, end)}; return { recentRemoteCompletions, registerClickPasteForAutoAdd }`,
  )(renderOrder, senderSets, sameAsset, (url) => ASSET_ID_RE.exec(url || '')?.[1] || null)
  return fns
}

const URL_7TV = 'https://cdn.7tv.app/emote/01FY9WEBXR00077WTWSFD40R6K/1x.avif'

describe('click-paste registers for auto-add-on-send', () => {
  test("another sender's 7tv personal emote registers (the GODNO case)", () => {
    const { recentRemoteCompletions, registerClickPasteForAutoAdd } = build()
    registerClickPasteForAutoAdd('GODNO', URL_7TV, '7tv')
    expect(recentRemoteCompletions.get('GODNO')).toEqual({ url: URL_7TV, source: '7tv', zeroWidth: false })
  })

  test("another user's heatsync emote registers, so it survives a reload", () => {
    const { recentRemoteCompletions, registerClickPasteForAutoAdd } = build()
    const url = 'https://heatsync.org/uploads/abc.webp'
    registerClickPasteForAutoAdd('UploadedEmote', url, 'heatsync')
    expect(recentRemoteCompletions.get('UploadedEmote')).toEqual({ url, source: 'heatsync', zeroWidth: false })
  })

  test('synthetic name0 overlay (no literal entry anywhere) is never registered', () => {
    const { recentRemoteCompletions, registerClickPasteForAutoAdd } = build()
    registerClickPasteForAutoAdd('TriHard0', URL_7TV, '7tv')
    expect(recentRemoteCompletions.size).toBe(0)
  })

  test('a REAL emote literally named name0 in a live sender set registers', () => {
    const senderSets = new Map([['twitch:1', new Map([['giga0', { url: URL_7TV, source: '7tv' }]])]])
    const { recentRemoteCompletions, registerClickPasteForAutoAdd } = build({ senderSets })
    registerClickPasteForAutoAdd('giga0', URL_7TV, '7tv')
    expect(recentRemoteCompletions.has('giga0')).toBe(true)
  })

  test('tombstoned (removed) literal name0 does not count as live', () => {
    const senderSets = new Map([['twitch:1', new Map([['giga0', { url: URL_7TV, source: '7tv', removedAt: 123 }]])]])
    const { recentRemoteCompletions, registerClickPasteForAutoAdd } = build({ senderSets })
    registerClickPasteForAutoAdd('giga0', URL_7TV, '7tv')
    expect(recentRemoteCompletions.size).toBe(0)
  })

  test('zero-width flag recovers from a same-asset sender-set entry', () => {
    const senderSets = new Map([['twitch:1', new Map([['wavE', { url: URL_7TV, source: '7tv', zeroWidth: true }]])]])
    const { recentRemoteCompletions, registerClickPasteForAutoAdd } = build({ senderSets })
    registerClickPasteForAutoAdd('wavE', URL_7TV, '7tv')
    expect(recentRemoteCompletions.get('wavE').zeroWidth).toBe(true)
  })

  test('same NAME different ASSET in a sender set does not leak the flag', () => {
    const other = 'https://cdn.7tv.app/emote/01OTHERASSETID000000000000/1x.avif'
    const senderSets = new Map([['twitch:1', new Map([['wavE', { url: other, source: '7tv', zeroWidth: true }]])]])
    const { recentRemoteCompletions, registerClickPasteForAutoAdd } = build({ senderSets })
    registerClickPasteForAutoAdd('wavE', URL_7TV, '7tv')
    expect(recentRemoteCompletions.get('wavE').zeroWidth).toBe(false)
  })

  test('missing url or name is a no-op', () => {
    const { recentRemoteCompletions, registerClickPasteForAutoAdd } = build()
    registerClickPasteForAutoAdd('', URL_7TV, '7tv')
    registerClickPasteForAutoAdd('Kappa', '', '7tv')
    expect(recentRemoteCompletions.size).toBe(0)
  })
})

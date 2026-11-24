// BTTV and FFZ bind modifiers in OPPOSITE directions — verified against both
// providers' own APIs (BTTV global emotes really do include c! h! l! p! r! s!
// v! w! z!; FFZ flags ffzX/ffzW/ffzY/ffzCursed with modifier:true):
//
//   BTTV  "c! Kappa"    → modifies the FOLLOWING emote
//   FFZ   "Kappa ffzX"  → modifies the PRECEDING emote
//   7TV   zero-width overlays also attach to the PRECEDING emote
//
// We accept the "wrong" order too, but ONLY as a fallback. That ordering is the
// whole design: if the fallback could win, "Kappa c! Keepo" would modify Kappa
// for us and Keepo for every BTTV user — and a multi-emote run is exactly where
// that divergence is visible.
//
// The rule as data is shared/emote-mods.vectors.json (tests/emote-mods-vectors.test.js
// runs every row). Here: every real provider token through the real row renderer,
// and what the vectors cannot say (kick's inline tokens, a tint riding a chain).
import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import * as mods from '../src/lib/modifiers.js'
import { escapeHtml, unescapeHtml } from '../src/lib/utils.js'
import './emote-rungs-globals.js'

Object.assign(globalThis, mods)
globalThis.escapeHtml = escapeHtml
globalThis.unescapeHtml = unescapeHtml
globalThis.cleanup = { setIntervalIfVisible: () => {}, persistInterval: () => {} }
globalThis.HS_MOD_C_HEX_RE = /^c!#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
globalThis.currentTab = 'chan-a'
globalThis.getCurrentChannel = () => 'chan-a'
globalThis.getLiveChannel = () => 'chan-a'
globalThis.linksEnabled = false
globalThis.getSetting = () => undefined
globalThis.t = (k) => k
globalThis.hsXButtonHtml = () => ''

const { processEmotes, channelEmoteCaches } = await import('../src/multichat/emotes.js')
const doc = new Window().document

const ROOM = ['Kappa', 'Keepo']
// each emote the row drew, with the effects stamped on it
function row(line) {
  channelEmoteCaches['chan-x'] = new Map(
    ROOM.map((n) => [n, { url: `https://cdn.7tv.app/emote/${n}/1x.webp`, source: '7tv', state: 'channel' }]),
  )
  try {
    const root = doc.createElement('div')
    root.innerHTML = processEmotes(escapeHtml(line), 'chan-x', null, null, null)
    const emotes = [...root.querySelectorAll('.hs-mc-emote-wrapper[data-emote-name]')].map(
      (el) => `${el.dataset.emoteName}:${el.dataset.hsMods || ''}`,
    )
    for (const el of root.querySelectorAll('.hs-mc-emote-wrapper')) el.remove()
    return { emotes, text: (root.textContent || '').trim() }
  } finally {
    delete channelEmoteCaches['chan-x']
  }
}
const fx = (word) => mods.hsModWordsFromState(mods.hsModClassify(word).mods, null).join(' ')

describe('provider direction', () => {
  // exact set from api.betterttv.net/3/cached/emotes/global
  for (const t of ['c!', 'h!', 'l!', 'p!', 'r!', 's!', 'v!', 'w!']) {
    test(`betterttv ${t} between two emotes changes the one after it`, () => {
      expect(row(`Kappa ${t} Keepo`).emotes).toEqual(['Kappa:', `Keepo:${fx(t)}`])
    })
  }
  for (const t of ['ffzX', 'ffzY', 'ffzW', 'ffzCursed', 'ffzHyper', 'ffzRainbow', 'ffzSpin']) {
    test(`frankerfacez ${t} between two emotes changes the one before it`, () => {
      expect(row(`Kappa ${t} Keepo`).emotes).toEqual([`Kappa:${fx(t)}`, 'Keepo:'])
    })
  }
  test('c!#hex (the colour token) is betterttv-shaped: the emote after it', () => {
    const got = row('Kappa c!#ff0000 Keepo').emotes
    expect(got[0]).toBe('Kappa:')
    expect(got[1]).toMatch(/^Keepo:c!/)
  })
})

describe('the other side is only the fallback', () => {
  test('a betterttv word with no emote after it changes the one before', () => {
    expect(row('Kappa w! hello')).toEqual({ emotes: ['Kappa:w!'], text: 'hello' })
  })
  test('a frankerfacez word with no emote before it changes the one after', () => {
    expect(row('hello ffzX Kappa')).toEqual({ emotes: ['Kappa:h!'], text: 'hello' })
  })
  test('with an emote on neither side the word stays on the line, never swallowed', () => {
    expect(row('hello w! there')).toEqual({ emotes: [], text: 'hello w! there' })
    expect(row('WideBirdge ffzW')).toEqual({ emotes: [], text: 'WideBirdge ffzW' })
  })
  test('the first plain word decides: nothing reaches over it for a distant emote', () => {
    expect(row('omg c! lol Kappa')).toEqual({ emotes: ['Kappa:'], text: 'omg c! lol' })
  })
})

describe('what the shared rows cannot say', () => {
  test("kick's inline token counts as an emote ahead", () => {
    const got = row('w! [emote:37226:KEKW] hello')
    expect(got.emotes).toEqual(['KEKW:w!'])
    expect(got.text).toBe('hello')
  })
  test('a forward chain carries its tint too, not just the effects', () => {
    const [kappa] = row('w!c!#ff0000 Kappa').emotes
    expect(kappa).toMatch(/^Kappa:w! c!/)
  })
  test('an ordinary word that happens to start like a modifier is a word', () => {
    expect(row('Kappa ffzzz w!x')).toEqual({ emotes: ['Kappa:'], text: 'ffzzz w!x' })
  })
})

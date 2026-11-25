// 2026-11-25, the owner's own LICK. Every copy of an animated emote in the panel plays on one shared
// clock (emote-sprite.js), but only a copy the renderer stamps `data-animated`. 7tv's own flag rides
// the room's and the globals' pools; a record built anywhere else carries none: the viewer's
// inventory (the server's inventory rows have no such column), a server ref, a removed copy. So the
// owner's row drew his inventory copy as the raw file on the browser's own clock beside every other
// chatter's LICK on the shared one.
//
// The flag is the PICTURE's, so a record with none of its own asks what the pools know about that
// picture: by picture, not by name (an inventory name is the owner's own rename), and a picture no
// pool has called animated stays unflagged, or a still would ask 7tv for a `_static` file that does
// not exist.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as mods from '../src/lib/modifiers.js'
import { EMOTE_TIER_ORDER, escapeHtml, resolveEmoteProviderWinner, unescapeHtml } from '../src/lib/utils.js'
import './emote-rungs-globals.js'
import { makeRig } from './emote-sprite-rig.js'
import { mainSource } from './main-src.js'

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
globalThis.HS_MOD_C_HEX_RE = /^c!#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
globalThis.currentTab = 'chan-a'
globalThis.getCurrentChannel = () => 'chan-a'
globalThis.getLiveChannel = () => 'chan-a'
globalThis.linksEnabled = false
globalThis.getSetting = () => undefined
globalThis.resolveEmoteProviderWinner = resolveEmoteProviderWinner
globalThis.EMOTE_TIER_ORDER = EMOTE_TIER_ORDER

const { processEmotes, channelEmoteCaches, inventoryEmotes, viewerPersonalEmotes, _buildChannelEmoteCache } =
  await import('../src/multichat/emotes.js')

// What the pools have taught the renderer outlives a test (a picture is forever), so every test
// draws a picture of its own: nothing a sibling saw can answer for it.
let seq = 0
let LICK = ''
const pic = () => `01PIC${String(++seq).padStart(21, '0')}`
const file = (id, rung = '1x') => `https://cdn.7tv.app/emote/${id}/${rung}.webp`

// the pool the picture is known from: a room whose set the real builder reads off 7tv, `animated` and all
const knownFrom = (ch, emotes) => _buildChannelEmoteCache(ch, emotes, 'kick')
const lick = (over = {}) => ({ name: 'LICK', url: file(LICK), source: '7tv', animated: true, hash: LICK, ...over })
/** the viewer's inventory copy, as the inventory load builds it: no `animated` */
function own(name, url, hash = LICK) {
  inventoryEmotes.add(name)
  viewerPersonalEmotes.set(name, { url, source: 'heatsync', state: 'owned', hash, zeroWidth: false })
}
/** one line, drawn in `ch` (a room with no set of its own unless knownFrom made one) */
const draw = (text, { ch = 'quiet', sender = viewerPersonalEmotes, refs = null } = {}) =>
  processEmotes(escapeHtml(text), ch, null, sender, undefined, true, refs, null, 'kick')

beforeEach(() => {
  LICK = pic()
})
afterEach(() => {
  inventoryEmotes.clear()
  viewerPersonalEmotes.clear()
  for (const k of Object.keys(channelEmoteCaches)) delete channelEmoteCaches[k]
})

describe("an owned copy of an animated emote is on the shared clock like everyone's", () => {
  test("the owner's own LICK carries data-animated, as another chatter's does", () => {
    knownFrom('chan-a', [lick()])
    own('LICK', file(LICK))
    // another chatter's, in the room that has it
    expect(draw('LICK', { ch: 'chan-a', sender: new Map() })).toContain('data-animated="1"')
    // the owner's: his inventory copy wins here (the room has no LICK)
    const mine = draw('LICK')
    expect(mine).toContain('hs-state-owned')
    expect(mine).toContain('data-animated="1"')
  })

  test('the picture decides, not the name: an inventory rename still joins', () => {
    knownFrom('chan-a', [lick({ url: file(LICK, '2x') })])
    own('lick', file(LICK, '1x'))
    expect(draw('lick')).toContain('data-animated="1"')
  })

  test('a server ref with no flag of its own reads the same answer', () => {
    knownFrom('chan-a', [lick()])
    const refs = new Map([['LICK', { url: file(LICK), source: '7tv', state: 'global', zeroWidth: false }]])
    expect(draw('LICK', { sender: new Map(), refs })).toContain('data-animated="1"')
  })

  test('a different picture under the same name is not stamped by it', () => {
    const other = pic()
    knownFrom('chan-a', [lick({ url: file(other), hash: other })])
    own('LICK', file(LICK))
    expect(draw('LICK')).not.toContain('data-animated')
  })

  test('a picture no pool calls animated stays unflagged: a still never asks for a _static file', () => {
    knownFrom('chan-a', [lick({ animated: false })])
    own('LICK', file(LICK))
    expect(draw('LICK')).not.toContain('data-animated')
  })

  test('a record that says it is still is not overruled by a look-alike', () => {
    knownFrom('chan-a', [lick()])
    inventoryEmotes.add('LICK')
    viewerPersonalEmotes.set('LICK', { url: file(LICK), source: '7tv', state: 'owned', animated: false })
    expect(draw('LICK')).not.toContain('data-animated')
  })

  test('a kick token that resolves to your inventory copy is stamped too', () => {
    knownFrom('chan-a', [lick()])
    // kick's numeric id IS the stored hash (see the kick-token branch of processEmotes)
    own('LICK', file(LICK), '4242')
    const out = draw('[emote:4242:LICK]')
    expect(out).toContain('hs-state-owned')
    expect(out).toContain('data-animated="1"')
  })
})

describe("the globals' loader teaches the same set", () => {
  // loadEmotes is async over browser.storage and not importable; its global block is carved by name
  // and run with the real helpers beside it
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8')
  const carve = (from, to) => {
    const a = src.indexOf(from)
    const b = src.indexOf(to, a)
    if (a < 0 || b < a) throw new Error(`emotes.js moved: ${from}`)
    return src.slice(a, b)
  }
  const keyFn = carve('function emoteAssetKey(', '// Does this picture move?')
  const helpers = carve('const hsAnimatedPictures', '// Is this resolved emote the one the viewer owns')
  const block = carve('      ;(stored.global_emotes || []).forEach((e) => {', '      // Add inventory emotes')
  const run = new Function(
    'stored',
    'emoteCache',
    'getEmoteState',
    'detectEmoteSource',
    '_hsRegisterOversize',
    'resolveEmoteProviderWinner',
    'EMOTE_TIER_ORDER',
    'registerHash',
    `${keyFn}\n${helpers}\n${block}\nreturn emoteIsAnimated`,
  )

  test('a global 7tv emote teaches its picture: the inventory copy of it then reads as animated', () => {
    const id = pic()
    const isAnimated = run(
      { global_emotes: [{ name: 'GLOB', url: file(id), source: '7tv', animated: true, hash: id }] },
      new Map(),
      () => 'global',
      () => '7tv',
      () => {},
      resolveEmoteProviderWinner,
      EMOTE_TIER_ORDER,
      () => {},
    )
    expect(isAnimated({ url: file(id, '2x'), source: 'heatsync', state: 'owned' })).toBe(true)
    expect(isAnimated({ url: file(pic()), source: 'heatsync', state: 'owned' })).toBe(false)
  })
})

describe("a row's server ref keeps the flag the sender's app shipped", () => {
  // computeMessageText's own loop, carved by name: the ref the renderer reads is built there
  const main = mainSource()
  const from = main.indexOf('let hsMsgRefs = null')
  const to = main.indexOf('let processedText = processEmotes(', from)
  if (from < 0 || to < from) throw new Error('hsMsgRefs builder moved: update owned-emote-joins-clock.test.js')
  const build = new Function('m', 'escapeHtml', `${main.slice(from, to)}\nreturn hsMsgRefs`)

  test('animated rides through, true or false; absent stays absent', () => {
    const refs = build(
      {
        hsEmotes: {
          Yes: { url: file(LICK), provider: '7tv', animated: true },
          No: { url: file(pic()), provider: '7tv', animated: false },
          Unknown: { url: file(pic()), provider: '7tv' },
        },
      },
      escapeHtml,
    )
    expect(refs.get('Yes').animated).toBe(true)
    expect(refs.get('No').animated).toBe(false)
    expect('animated' in refs.get('Unknown')).toBe(false)
  })
})

describe('end to end: the owned row mounts a sprite on the shared strip', () => {
  /** a drawn line into the rig's page, driven the way the idle gate drives a row that is on screen */
  async function show(rig, html) {
    const row = rig.doc.createElement('div')
    row.className = 'hs-mc-msg'
    row.innerHTML = html
    rig.doc.body.appendChild(row)
    rig.swap(row, false)
    await rig.flush()
    rig.swap(row, false)
    return rig.spriteOf(row.querySelector('.hs-mc-emote-wrapper'))
  }

  test("his row and another chatter's both play the strip: one decode between them", async () => {
    const rig = makeRig()
    try {
      knownFrom('chan-a', [lick()])
      own('LICK', file(LICK))
      expect(await show(rig, draw('LICK', { ch: 'chan-a', sender: new Map() }))).toBeTruthy()
      expect(await show(rig, draw('LICK'))).toBeTruthy()
      expect(rig.s.decodeCalls).toHaveLength(1)
    } finally {
      rig.reset()
    }
  })
})

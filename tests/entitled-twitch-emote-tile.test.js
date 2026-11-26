/**
 * A twitch emote the viewer may use (subscriptions, bits, follower, turbo: the server's
 * get-user-emotes rows, carried as `subscription`) is twitch's own: twitch draws it for every
 * twitch viewer, so in a twitch room its picker tile wears T wherever it sits (inventory,
 * favorites, recents, search), and sending it is the plain word. A twitch picture the viewer is
 * not entitled to stays H, and in a kick-only room a twitch emote is never T.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { draftPicks, pinPickedEmote, refOf } from '../src/lib/emote-refs.js'
import { normalizeEmoteRefsForSend } from '../src/lib/emote-refs-normalize.js'
import { t } from './t-stub.js'
import './emote-law-globals.js'

const read = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')
const slice = (src, from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  if (a === -1 || b === -1) throw new Error(`carve markers not found: ${from} .. ${to}`)
  return src.slice(a, b)
}
const PIC = slice(read('input.js'), 'const _AC_PIC_RE =', 'let _acRemoteToken')
const META = slice(read('input.js'), 'function emoteCycleMeta(m)', 'function showCycleTooltip()')
const TILE = slice(
  read('emotes.js'),
  '// the one-letter corner mark of a picker tile',
  '/**\n * Emote picker — DOM is built once',
)

const tw = (id, size = '1.0') => `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/${size}`
const personal = new Map()
const rig = { legs: { twitch: 'chan' } }
const scope = {
  hsEmoteLaw: globalThis.hsEmoteLaw,
  viewerPersonalEmotes: personal,
  emoteCache: new Map(),
  channelEmoteCaches: { chan: new Map(), ks: new Map() },
  channelRoomNames: globalThis.channelRoomNames,
  draftPicks,
  pinPickedEmote,
  refOf,
  normalizeEmoteRefsForSend,
  rig,
}
const names = Object.keys(scope)
const { lawTileSays, lawTileHidden, inventorySourceOf, lawSendCtx } = new Function(
  ...names,
  `${PIC}\n${read('emote-law-send.js')}\nlawOpenLegs = () => rig.legs\nreturn { lawTileSays, lawTileHidden, inventorySourceOf, lawSendCtx }`,
)(...names.map((k) => scope[k]))

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const emoteImgHtml = new Function(
  't',
  'escapeHtml',
  'hsEmoteHiddenForViewer',
  'emoteIsBlocked',
  'hsRungUrl',
  'lawTileSays',
  `${META}\n${TILE}\nreturn emoteImgHtml`,
)(
  t,
  esc,
  () => null,
  () => false,
  (u) => u,
  lawTileSays,
)
const mark = (name, e) => /data-mark="([^"]*)"/.exec(emoteImgHtml([name, e]))?.[1] ?? null

// the rows the server lists (GET /api/user/emotes): subscriptions carry `subscription`, an own
// inventory row (saved from anyone) does not. as the overlay files them, by source
const rows = [
  { name: 'krippPride', url: tw('111', '3.0'), subscription: true },
  { name: 'savedSub', url: tw('222'), subscription: false },
  { name: 'Sameword', url: tw('333'), subscription: true },
  { name: 'Sameword', url: tw('333', '1.0'), subscription: false },
  { name: 'Renamed', url: tw('111'), subscription: false },
]
const sourceOf = inventorySourceOf(rows)
const file = (e) =>
  personal.set(e.name, { url: e.url, source: sourceOf(e), state: 'owned', subscription: !!e.subscription })
const tile = (name, url) => [name, { url, ...personal.get(name), ...(url && { url }) }]

describe('an inventory row is twitch when the viewer may use that twitch emote', () => {
  test('a sub row is twitch; a saved picture they are not entitled to is theirs', () => {
    expect(sourceOf(rows[0])).toBe('twitch')
    expect(sourceOf(rows[1])).toBe('heatsync')
  })
  test('a saved copy at another size under the entitled word is that emote too (picture id, not size)', () => {
    expect(sourceOf({ name: 'krippPride', url: tw('111', '1.0') })).toBe('twitch')
  })
  test('the entitled picture under another word is theirs: twitch would draw only the bare word', () => {
    expect(sourceOf(rows[4])).toBe('heatsync')
  })
})

describe('the tile mark in a twitch room', () => {
  rig.legs = { twitch: 'chan' }
  for (const e of rows) file(e)
  const m = (name, url, extra = {}) => {
    const [n, e] = tile(name, url)
    return mark(n, { ...e, ...extra })
  }
  test('an entitled sub emote in the inventory is T', () => {
    rig.legs = { twitch: 'chan' }
    expect(m('krippPride', tw('111', '3.0'))).toBe('T')
  })
  test('the same picture as a favorite or recent (another size, a variant tile) is T', () => {
    rig.legs = { twitch: 'chan' }
    expect(m('krippPride', tw('111', '1.0'), { variant: 'twitch:111' })).toBe('T')
    expect(m('krippPride', tw('111', '2.0'), { source: 'twitch', state: 'channel' })).toBe('T')
  })
  test('a twitch picture the viewer is not entitled to stays H', () => {
    rig.legs = { twitch: 'chan' }
    expect(m('savedSub', tw('222'))).toBe('H')
  })
})

describe('the tile mark in a kick-only room', () => {
  test('an entitled twitch emote is not T there (a pick ships as your picture: H)', () => {
    rig.legs = { kick: 'ks' }
    file(rows[0])
    expect(mark(...tile('krippPride', tw('111', '3.0')))).not.toBe('T')
    expect(mark(...tile('krippPride', tw('111', '3.0')))).toBe('H')
  })
  test('on the twitch leg of a merged tab it is T again', () => {
    rig.legs = { twitch: 'chan', kick: 'ks' }
    expect(mark(...tile('krippPride', tw('111', '3.0')))).toBe('T')
  })
})

describe('sending an entitled twitch emote', () => {
  test('goes out as the plain word, no ref: twitch draws it natively', () => {
    const ctx = lawSendCtx({
      legs: { twitch: 'chan' },
      mine: personal,
      globals: new Map(),
      caches: { chan: new Map() },
      picks: null,
    })
    const sent = globalThis.hsEmoteLaw.sendLine('hi krippPride', ctx)
    expect(sent.refs).toEqual({})
    expect(sent.wire.twitch).toBe('hi krippPride')
  })
})

// one name = one picture = one tile: the room answers a name with one picture, and every other
// picture under that name is not offered there (inventory, favorites, recents, search, Tab)
describe('one name, one picture, one tile in a room', () => {
  const stv = (id) => ({ source: '7tv', url: `https://cdn.7tv.app/emote/${id}/2x.webp`, hash: id })
  const ffz = { source: 'ffz', url: 'https://cdn.frankerfacez.com/emote/746265/1' }
  const own = (e) => ({ ...e, state: 'owned' })
  const setRoom = (m) => {
    scope.channelEmoteCaches.chan = new Map(m)
    personal.clear()
    emoteCacheReset()
  }
  const emoteCacheReset = () => scope.emoteCache.clear()

  test("your ffz copy under a name the room holds as 7tv is hidden; the room's tile is not", () => {
    rig.legs = { twitch: 'chan' }
    setRoom([['SusgeBinoculars', stv('01GWQ3XHWR0007M1MRN40XNE1A')]])
    expect(lawTileHidden('SusgeBinoculars', own(ffz))).toBe(true)
    expect(lawTileHidden('SusgeBinoculars', stv('01GWQ3XHWR0007M1MRN40XNE1A'))).toBe(false)
    // your copy of the room's own picture (another size) is that picture: still one tile
    expect(lawTileHidden('SusgeBinoculars', own(stv('01GWQ3XHWR0007M1MRN40XNE1A')))).toBe(false)
  })
  test('the same copy is drawn, marked H, in a room without that name', () => {
    rig.legs = { twitch: 'chan' }
    setRoom([['Other', stv('AAA')]])
    expect(lawTileHidden('SusgeBinoculars', own(ffz))).toBe(false)
    expect(mark('SusgeBinoculars', own(ffz))).toBe('H')
  })
  test('a look-alike of a twitch emote you may use is hidden, no cross tile', () => {
    rig.legs = { twitch: 'chan' }
    setRoom([])
    file(rows[0])
    expect(lawTileHidden('krippPride', own(stv('LOOK')))).toBe(true)
    expect(lawTileHidden('krippPride', { url: tw('111', '3.0'), source: 'twitch' })).toBe(false)
  })
  test('a room with no legs (nothing sent anywhere) hides nothing', () => {
    rig.legs = {}
    setRoom([['SusgeBinoculars', stv('ROOM')]])
    expect(lawTileHidden('SusgeBinoculars', own(ffz))).toBe(false)
  })

  const PICKER = slice(read('emotes.js'), 'function groupEmotes() {', '// Chunked lazy render')
  test('every section drops what the room overrides, and its count follows', () => {
    rig.legs = { twitch: 'chan' }
    setRoom([['SusgeBinoculars', stv('ROOM')]])
    const mine = ['SusgeBinoculars', own(ffz)]
    const room = ['SusgeBinoculars', stv('ROOM')]
    const free = ['Solo', own(stv('SOLO'))]
    const stub = {
      lawBrowseSections: () => [
        { key: 'set', label: 'inventory', emotes: [mine, free] },
        { key: 'channel', label: 'channel', emotes: [room] },
      ],
      buildRecentSection: () => ({ key: 'recent', label: 'recent', emotes: [mine, room] }),
      hsFavSection: () => ({ key: 'fav', label: 'favorites', emotes: [mine] }),
    }
    const groupEmotes = new Function(
      'lawBrowseSections',
      'buildRecentSection',
      'hsFavSection',
      'activeTabEmotePools',
      'SECTION_LABELS',
      't',
      'lawTileHidden',
      'viewerPersonalEmotes',
      'emoteCache',
      `${PICKER}\nreturn groupEmotes`,
    )(
      stub.lawBrowseSections,
      stub.buildRecentSection,
      stub.hsFavSection,
      () => [],
      {},
      (k) => k,
      lawTileHidden,
      personal,
      scope.emoteCache,
    )
    const out = groupEmotes()
    expect(out.map((s) => [s.key, s.emotes.length])).toEqual([
      ['recent', 1],
      ['set', 1],
      ['channel', 1],
    ])
    expect(out.find((s) => s.key === 'recent').emotes[0][1].hash).toBe('ROOM')
  })

  test('Tab offers one candidate per name: your override copy is not a second one', () => {
    rig.legs = { twitch: 'chan' }
    setRoom([['SusgeBinoculars', stv('ROOM')]])
    personal.set('SusgeBinoculars', own(ffz))
    personal.set('SusgeOther', own(stv('MINE')))
    const ctx = lawSendCtx({
      legs: rig.legs,
      mine: personal,
      globals: new Map(),
      caches: scope.channelEmoteCaches,
      picks: null,
    })
    const offered = globalThis.hsEmoteLaw.offerSeams('Susge', { ...ctx, usage: () => 0, suggestOwn: true })
    expect(offered.list.filter((c) => c.emote.name === 'SusgeBinoculars').length).toBe(2)
    const oneCopy = new Function(
      'lawTileHidden',
      `${slice(read('emote-law-offer.js'), 'function lawOneCopy(o) {', '/**\n * One Tab cycle')}\nreturn lawOneCopy`,
    )(lawTileHidden)
    const one = oneCopy(offered)
    expect(one.list.map((c) => [c.emote.name, c.emote.raw.hash])).toEqual([
      ['SusgeBinoculars', 'ROOM'],
      ['SusgeOther', 'MINE'],
    ])
    expect(one.exact).toBeLessThanOrEqual(one.list.length)
    expect(one.room).toBeLessThanOrEqual(one.list.length)
  })
})

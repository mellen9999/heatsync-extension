// Twitch's and kick's own boxes (heatsync chat off) ask the law's offer, the one the panel's Tab asks,
// over THE PAGE'S channel (what that box sends to), never another tab's room. multichat-core answers
// (lawNativeMatches); content.js holds the page's sets and hands them over (nativeOfferRows).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hsNativeRows } from '../src/content/native-emote-law.js'
import { lawOfferRig } from './helpers/law-offer-rig.js'

const read = (...p) => readFileSync(join(import.meta.dir, '..', ...p), 'utf8')
const e = (id, source = '7tv', more = {}) => ({ url: `https://cdn.test/${source}/${id}.webp`, source, id, ...more })
const m = (o) => new Map(Object.entries(o))

/** what a native page hands over: its room, yours, the globals, as content.js holds them */
const page = (o = {}) => ({
  platform: 'kick',
  channel: 'pagechan',
  room: m({}),
  own: m({}),
  globals: m({}),
  blocked: () => false,
  suggestOwn: true,
  emojiFirst: false,
  ...o,
})
const rows = (rig, word, src) => hsNativeRows(rig.lawNativeMatches(word, src))
const names = (list) => list.map((r) => r.name)

describe("a native box's list is the law's", () => {
  test('case twins are both offered, the spelling typed first (kekw and KEKW were one name)', () => {
    const rig = lawOfferRig()
    const src = page({ room: m({ KEKW: e('room') }), globals: m({ kekw: e('glob', 'bttv') }) })
    expect(names(rows(rig, 'kekw', src))).toEqual(['kekw', 'KEKW'])
    expect(names(rows(rig, 'KEKW', src))).toEqual(['KEKW', 'kekw'])
  })

  test("the room's emote before yours (catJAM, then your catKISS), not a-z by tier name", () => {
    const rig = lawOfferRig()
    const src = page({
      room: m({ catJAM: e('jam') }),
      own: m({ catKISS: e('kiss', 'heatsync', { hash: 'h1' }) }),
      globals: m({ catAAA: e('a', 'bttv') }),
    })
    const list = rows(rig, 'cat', src)
    expect(names(list)).toEqual(['catJAM', 'catKISS', 'catAAA'])
    expect(list.map((r) => r.tier)).toEqual([0, 1, 2])
  })

  test("the room is the page's channel, never the open multichat tab's", () => {
    const rig = lawOfferRig({ channelEmoteCaches: { 'chan-a': m({ TabRoom: e('t') }) } })
    const src = page({ room: m({ PageRoom: e('p') }) })
    expect(names(rows(rig, 'room', src))).toEqual(['PageRoom'])
    // and the tab's own list is untouched by the page's holdings
    expect(names(rig.findEmoteMatches('room'))).toEqual(['TabRoom'])
  })

  test('a name you use leads, as in the panel', () => {
    const rig = lawOfferRig()
    rig.frecency.set('catKISS', 3)
    const src = page({ room: m({ catJAM: e('jam') }), own: m({ catKISS: e('kiss', 'heatsync', { hash: 'h1' }) }) })
    expect(names(rows(rig, 'cat', src))).toEqual(['catKISS', 'catJAM'])
  })

  test('a blocked emote is never offered', () => {
    const rig = lawOfferRig()
    const src = page({ room: m({ catJAM: e('jam'), catBAD: e('bad') }), blocked: (n) => n === 'catBAD' })
    expect(names(rows(rig, 'cat', src))).toEqual(['catJAM'])
  })

  test('the `:` list: emotes first, or every emoji first when the setting says so; Tab never moves emoji', () => {
    const rig = lawOfferRig()
    rig.emoji.push({ name: 'cat', emoji: '🐱' })
    const room = m({ catJAM: e('jam') })
    expect(names(rows(rig, ':cat', page({ room })))).toEqual(['catJAM', ':cat:'])
    expect(names(rows(rig, ':cat', page({ room, emojiFirst: true })))).toEqual([':cat:', 'catJAM'])
    expect(names(rows(rig, 'cat', page({ room, emojiFirst: true })))).toEqual(['catJAM'])
    expect(rows(rig, ':cat', page({ room }))[1]).toEqual({ name: ':cat:', emoji: '🐱' })
  })

  test('@ is not an emote: a native box keeps its own people', () => {
    expect(rows(lawOfferRig(), '@so', page({ room: m({ soCool: e('s') }) }))).toEqual([])
  })

  test("a twitch emote you can use is offered as twitch's own", () => {
    const rig = lawOfferRig()
    const url = 'https://static-cdn.jtvnw.net/emoticons/v2/99/default/dark/1.0'
    const src = page({ platform: 'twitch', own: m({ KappaX: { name: 'KappaX', url, source: 'twitch', hash: '99' } }) })
    const [r] = rows(rig, 'kappax', src)
    expect([r.name, r.source]).toEqual(['KappaX', 'twitch'])
  })
})

describe('the three native paths have no ranking of their own', () => {
  test("kick's hook asks the offer, with no comparator, binary search or frecency read left", () => {
    const s = read('src', 'content', 'kick-autocomplete-hook.js')
    expect(s).toContain('window.heatsyncNativeOffer')
    expect(s).not.toMatch(/a\.tier|function searchEmotes|function searchEmoji|readEmoteFrecency|lower:/)
  })
  test("kick's Tab cycle (content.js) asks the offer, not a lower-cased name map", () => {
    const s = read('src', 'content', 'content.js')
    const body = s.slice(s.indexOf('function findEmoteMatches(partialWord)'), s.indexOf('function showEmotePreview'))
    expect(body).toContain('nativeOfferRows(partialWord)')
    expect(s).not.toMatch(/\bbuildEmoteMap\b|_tabEmoteMap/)
    expect(body).not.toMatch(/toLowerCase|localeCompare|\.sort\(/)
  })
  test("twitch's hook asks the offer over the bridge for both its dropdown and its Tab cycle", () => {
    const s = read('src', 'content', 'autocomplete-hook.js')
    expect(s.match(/lawRows\(/g).length).toBeGreaterThanOrEqual(3)
    expect(s).not.toMatch(/frecCyc|fuzzyMatch|getAllEmotesForCycling|r\._spelled|_isPrefix/)
    // content.js answers the same event, synchronously, with the page's channel
    expect(read('src', 'content', 'content.js')).toContain("'heatsync-law-offer'")
    expect(s).toContain("'heatsync-law-offer'")
  })
  test('multichat-core publishes the offer for the isolated-world scripts', () => {
    expect(read('src', 'multichat', 'emote-law-offer.js')).toContain('window.heatsyncLawOffer = lawNativeMatches')
  })
})

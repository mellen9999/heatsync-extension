// recents and "names you use" are what you sent (docs/emote-law-map.md R16, site docs/emote-law.md):
// a recent is a picture, so the tile is the emote that shipped and never the name's first emote in
// whatever tab is open; a name you send rises in Tab. Both are written once, as a line leaves: a
// pick never sent and a Tab step cycled past count nothing. The real store and the real ship run.
import { beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lawOfferRig } from './helpers/law-offer-rig.js'

const MC = join(import.meta.dir, '..', 'src', 'multichat')
const e = (source, id, more) => ({ url: `https://cdn.7tv.app/emote/${id}/2x.webp`, source, state: 'global', ...more })

const mine = new Map()
const globals = new Map()
const caches = { 'chan-a': new Map(), 'chan-b': new Map() }
const rig = lawOfferRig({ viewerPersonalEmotes: mine, emoteCache: globals, channelEmoteCaches: caches, usage: true })
const picker = () => [mine, caches[rig.legs.twitch] || new Map(), globals]
const recent = () => rig.lawRecentTiles(picker()).map(([n, x]) => `${n} ${x.url}`)
const tab = (typed) => rig.findEmoteMatches(typed).map((m) => m.name)

beforeEach(() => {
  rig.reset()
  rig.store.clear()
  mine.clear()
  globals.clear()
  caches['chan-a'].clear()
  caches['chan-b'].clear()
})

test('the recent tile is the picture you sent, not the first emote of that name here', () => {
  const room = e('7tv', 'ROOM')
  const own = e('heatsync', 'MINE', { state: 'owned', hash: 'h1' })
  caches['chan-a'].set('Wlol', room)
  mine.set('Wlol', own)
  rig.send('hi Wlol') // typed by hand: the room's ships
  expect(recent()).toEqual([`Wlol ${room.url}`])
  rig.lawPin('Wlol', own)
  rig.send('hi Wlol') // picked: yours ships
  expect(recent()).toEqual([`Wlol ${own.url}`, `Wlol ${room.url}`])
})

test('one picture in two sizes is one recent', () => {
  caches['chan-a'].set('Wlol', e('7tv', 'ROOM'))
  rig.send('Wlol')
  caches['chan-a'].set('Wlol', { ...e('7tv', 'ROOM'), url: 'https://cdn.7tv.app/emote/ROOM/1x.avif' })
  rig.send('Wlol')
  expect(rig.loadRecentEmotes()).toHaveLength(1)
  expect(recent()).toEqual(['Wlol https://cdn.7tv.app/emote/ROOM/1x.avif'])
})

test("newest line first, each picture once, the line's own order kept", () => {
  for (const n of ['Aaa', 'Bbb', 'Ccc']) caches['chan-a'].set(n, e('7tv', n))
  rig.send('Aaa')
  rig.send('Ccc Bbb Ccc')
  rig.send('Aaa')
  expect(recent().map((r) => r.split(' ')[0])).toEqual(['Aaa', 'Ccc', 'Bbb'])
})

test('a picture this tab cannot reach is absent, never swapped for another emote of the name', () => {
  caches['chan-a'].set('Wlol', e('7tv', 'ROOM'))
  caches['chan-b'].set('Wlol', e('7tv', 'OTHER'))
  rig.send('Wlol')
  rig.legs = { twitch: 'chan-b' }
  expect(recent()).toEqual([])
})

test("the list a device already holds (names) still reads, as the name's first emote here", () => {
  const room = e('7tv', 'ROOM')
  caches['chan-a'].set('Wlol', room)
  rig.store.set('hs-mc-recent-emotes', JSON.stringify(['Wlol', 'Gone', 7, '']))
  expect(recent()).toEqual([`Wlol ${room.url}`])
})

test('a line with no emote writes nothing; a store that is not a list reads as none', () => {
  rig.send('just words')
  expect(rig.store.size).toBe(0)
  for (const bad of ['{"a":1}', 'not json', '"x"']) {
    rig.store.set('hs-mc-recent-emotes', bad)
    expect(rig.loadRecentEmotes()).toEqual([])
  }
})

test('a name you send leads Tab over the room once what you typed starts it', () => {
  caches['chan-a'].set('PogU', e('7tv', 'POGU'))
  globals.set('PogChamp', e('bttv', 'PC'))
  expect(tab('pog')).toEqual(['PogU', 'PogChamp'])
  rig.send('PogChamp')
  expect(tab('pog')).toEqual(['PogChamp', 'PogU'])
})

test('cycling past a candidate, or picking one and never sending it, counts nothing', () => {
  caches['chan-a'].set('PogU', e('7tv', 'POGU'))
  globals.set('PogChamp', e('bttv', 'PC'))
  const list = rig.findEmoteMatches('pog')
  rig.lawPin(list[1].name, list[1])
  rig.reset() // the box was cleared without a send
  expect(rig.store.size).toBe(0)
  expect(tab('pog')).toEqual(['PogU', 'PogChamp'])
})

test('one line counts a name once; the record is the one the page composers read', () => {
  caches['chan-a'].set('PogU', e('7tv', 'POGU'))
  rig.send('PogU PogU PogU')
  const rec = JSON.parse(rig.store.get('hs-mc-emote-frecency'))
  expect(Object.keys(rec)).toEqual(['PogU'])
  expect(rec.PogU.n).toBe(1)
  expect(typeof rec.PogU.t).toBe('number')
  expect(rig.loadEmoteFrecency().get('PogU')).toBeCloseTo(1, 3)
})

test('a record written before this (pick-time counts) is read as it is', () => {
  caches['chan-a'].set('PogU', e('7tv', 'POGU'))
  globals.set('PogChamp', e('bttv', 'PC'))
  rig.store.set('hs-mc-emote-frecency', JSON.stringify({ PogChamp: { n: 3, t: Date.now() } }))
  expect(tab('pog')).toEqual(['PogChamp', 'PogU'])
  for (const bad of ['[1]', 'nope', '{"PogChamp":5}']) {
    rig.store.set('hs-mc-emote-frecency', bad)
    expect(tab('pog')).toEqual(['PogU', 'PogChamp'])
  }
})

test('nothing in the overlay records a use at pick time any more', () => {
  for (const f of ['input.js', 'emotes.js']) {
    const src = readFileSync(join(MC, f), 'utf8')
    expect(src).not.toMatch(/recordRecentEmote|bumpEmoteFrecency|unbumpEmoteFrecency|_frecBumped/)
  }
  // and the one place a line ships notes what it carried
  const input = readFileSync(join(MC, 'input.js'), 'utf8')
  const at = input.indexOf('const shipped = lawShip(')
  expect(input.slice(at, at + 700)).toMatch(/lawNoteSent\(shipped\.used\)/)
})

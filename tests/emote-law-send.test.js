// what a chat send ships: refs + the kick wire come from the law (emote-law-send.js), over the
// room of each leg, so a viewer without your sets sees what you saw
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { draftPicks, pinPickedEmote, refOf } from '../src/lib/emote-refs.js'
import { normalizeEmoteRefsForSend } from '../src/lib/emote-refs-normalize.js'
import './emote-law-globals.js'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emote-law-send.js'), 'utf8')
const scope = {
  refOf,
  normalizeEmoteRefsForSend,
  draftPicks,
  hsEmoteLaw: globalThis.hsEmoteLaw,
  viewerPersonalEmotes: new Map(),
  emoteCache: new Map(),
  channelEmoteCaches: {},
}
const { lawSendCtx, lawShip, lawStored, lawYtKey } = new Function(
  ...Object.keys(scope),
  `${SRC}\nreturn { lawSendCtx, lawShip, lawStored, lawYtKey }`,
)(...Object.values(scope))
const law = globalThis.hsEmoteLaw

const kick = { source: 'kick', url: 'https://files.kick.com/emotes/37226/fullsize' }
const stv = (id) => ({ source: '7tv', url: `https://cdn.7tv.app/emote/${id}/2x.webp`, hash: id })
const ctxFor = ({ legs = { twitch: 'chan' }, mine, globals, caches = {}, picks } = {}) =>
  lawSendCtx({ legs, mine: new Map(mine), globals: new Map(globals), caches, picks: picks || null })

test('a kick room emote goes out as its wire token, even over a same-name copy you own', () => {
  const ctx = ctxFor({
    legs: { kick: 'ks' },
    mine: [['KEKW', stv('AAA')]],
    caches: { ks: new Map([['KEKW', kick]]) },
  })
  expect(law.sendLine('hi KEKW', ctx).wire.kick).toBe('hi [emote:37226:KEKW]')
})

test('a 7tv word of the room ships a ref a viewer without it can draw', () => {
  const ctx = ctxFor({ caches: { chan: new Map([['catJAM', stv('BBB')]]) } })
  const refs = law.sendLine('hey catJAM', ctx).refs
  expect(refOf(refs.catJAM)).toMatchObject({ name: 'catJAM', provider: '7tv', id: 'BBB', url: stv('BBB').url })
})

test('your own twitch emote is marked by twitch: no ref', () => {
  const ctx = ctxFor({
    mine: [['Kappa', { source: 'twitch', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0' }]],
  })
  expect(law.sendLine('Kappa', ctx).refs).toEqual({})
})

test('a word only your inventory has ships its ref', () => {
  const ctx = ctxFor({ mine: [['Solo', stv('CCC')]], caches: { chan: new Map() } })
  expect(Object.keys(law.sendLine('Solo', ctx).refs)).toEqual(['Solo'])
})

test("the room's emote ships over your same-name inventory copy; a pick beats both", () => {
  const room = new Map([['IDK', stv('ROOM')]])
  const mine = [['IDK', stv('MINE')]]
  expect(law.sendLine('IDK', ctxFor({ mine, caches: { chan: room } })).refs.IDK.id).toBe('ROOM')
  const picks = { picked: new Map([['IDK', { name: 'IDK', ...stv('PICK') }]]), remote: new Map() }
  expect(law.sendLine('IDK', ctxFor({ mine, caches: { chan: room }, picks })).refs.IDK.id).toBe('PICK')
})

test('a line kick would refuse with tokens goes out as plain words', () => {
  const ctx = ctxFor({ legs: { kick: 'ks' }, caches: { ks: new Map([['KEKW', kick]]) } })
  const text = 'KEKW '.repeat(90).trim()
  expect(law.sendLine(text, ctx).wire.kick).toBe(text)
})

const ID = { ROOM: '60ae958e229664e8667aea38', PICK: '60ae958e229664e8667aea39', MINE: '60ae958e229664e8667aea40' }
test('lawShip: the wire and the refs of one line, a pick held by its own box only', () => {
  scope.channelEmoteCaches.chan = new Map([
    ['IDK', stv(ID.ROOM)],
    ['__proto__', stv('PROTO')],
  ])
  const boxA = {}
  const boxB = {}
  pinPickedEmote({ name: 'IDK', ...stv(ID.PICK) }, boxA)
  const a = lawShip('IDK', { twitch: 'chan' }, boxA)
  expect(a.refs.IDK.url).toBe(stv(ID.PICK).url)
  expect(a.picked).toEqual(['IDK']) // this message's pick: the echo is handed it
  const b = lawShip('IDK', { twitch: 'chan' }, boxB)
  expect(b.refs.IDK.url).toBe(stv(ID.ROOM).url)
  expect(b.picked).toBeUndefined() // the room's word: the row reads it back by itself
  // an emote can be called __proto__: it ships under that name, never lost to the assignment
  const sent = lawShip('__proto__', { twitch: 'chan' }, boxB).refs
  expect(Object.keys(sent)).toEqual(['__proto__'])
  expect(lawShip('no emotes here', { twitch: 'chan' }, boxB).refs).toBeUndefined()
})

test('a ref says only what is true of the picture: a hash for a copy you own, the provider id otherwise', () => {
  // the caches hold a catalog hash on every entry and no provider id: neither may travel as fact
  scope.channelEmoteCaches.chan = new Map([['IDK', { ...stv(ID.ROOM), hash: 'c0ffee0001' }]])
  scope.viewerPersonalEmotes.set('Mine', { ...stv(ID.MINE), hash: 'deadbeef01', state: 'owned' })
  const { refs } = lawShip('IDK Mine', { twitch: 'chan' }, {})
  expect(refs.IDK.hash).toBeUndefined() // the room's emote is not yours: no ownership claim
  expect(refs.IDK.id).toBeUndefined() // and the law's made-up key is not a provider id
  expect(refs.Mine.hash).toBe('deadbeef01')
  expect(lawStored(refs)).toEqual({ IDK: { p: '7tv', id: ID.ROOM }, Mine: { p: 'hs', id: 'deadbeef01' } })
  scope.viewerPersonalEmotes.clear()
})

test('a pick of the very picture you own ships your copy; a same-name pick of another picture does not', () => {
  scope.channelEmoteCaches.chan = new Map()
  scope.viewerPersonalEmotes.set('IDK', { ...stv(ID.MINE), hash: 'deadbeef01', state: 'owned' })
  const same = {}
  pinPickedEmote({ name: 'IDK', url: stv(ID.MINE).url, provider: '7tv' }, same)
  expect(lawStored(lawShip('IDK', { twitch: 'chan' }, same).refs)).toEqual({ IDK: { p: 'hs', id: 'deadbeef01' } })
  const other = {}
  pinPickedEmote({ name: 'IDK', url: stv(ID.PICK).url, provider: '7tv' }, other)
  expect(lawStored(lawShip('IDK', { twitch: 'chan' }, other).refs)).toEqual({ IDK: { p: '7tv', id: ID.PICK } })
  scope.viewerPersonalEmotes.clear()
})

test('a youtube room is keyed by its handle, with the @ when that is how its set is filed', () => {
  expect(lawYtKey('https://www.youtube.com/@SomeOne/live')).toBe('SomeOne')
  scope.channelEmoteCaches['@SomeOne'] = new Map([['yay', stv(ID.ROOM)]])
  expect(lawYtKey('https://www.youtube.com/@SomeOne/live')).toBe('@SomeOne')
  expect(lawYtKey('https://www.youtube.com/watch?v=abc')).toBe('')
  // and a youtube-only line reads that room, so what ships is what the chip showed
  expect(lawShip('yay', { youtube: '@SomeOne' }, {}).refs.yay.url).toBe(stv(ID.ROOM).url)
  delete scope.channelEmoteCaches['@SomeOne']
})

test('the send names the same youtube room the chip is judged against', () => {
  const INPUT = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
  expect(INPUT).toContain("youtube: sendToYoutube ? (ytUrl ? lawYtKey(ytUrl) : targetChannel) : '',")
  expect(SRC).toContain("youtube: ch.youtube && st.youtube ? lawYtKey(ch.youtube) : '',")
  expect(SRC).toContain("youtube: hostPlatform === 'yt' ? live : '',")
})

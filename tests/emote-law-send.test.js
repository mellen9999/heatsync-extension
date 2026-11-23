// what a chat send ships: refs + the kick wire come from the law (emote-law-send.js), over the
// room of each leg, so a viewer without your sets sees what you saw
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { draftPicks, pinPickedEmote, refOf } from '../src/lib/emote-refs.js'
import './emote-law-globals.js'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emote-law-send.js'), 'utf8')
const scope = {
  refOf,
  draftPicks,
  hsEmoteLaw: globalThis.hsEmoteLaw,
  viewerPersonalEmotes: new Map(),
  emoteCache: new Map(),
  channelEmoteCaches: {},
}
const { lawSendCtx, lawShip } = new Function(...Object.keys(scope), `${SRC}\nreturn { lawSendCtx, lawShip }`)(
  ...Object.values(scope),
)
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

test('lawShip: the wire and the refs of one line, a pick held by its own box only', () => {
  scope.channelEmoteCaches.chan = new Map([
    ['IDK', stv('ROOM')],
    ['__proto__', stv('PROTO')],
  ])
  const boxA = {}
  const boxB = {}
  pinPickedEmote({ name: 'IDK', ...stv('PICK') }, boxA)
  expect(lawShip('IDK', { twitch: 'chan' }, boxA).refs.IDK.id).toBe('PICK')
  expect(lawShip('IDK', { twitch: 'chan' }, boxB).refs.IDK.id).toBe('ROOM')
  // an emote can be called __proto__: it ships under that name, never lost to the assignment
  const sent = lawShip('__proto__', { twitch: 'chan' }, boxB).refs
  expect(Object.keys(sent)).toEqual(['__proto__'])
  expect(lawShip('no emotes here', { twitch: 'chan' }, boxB).refs).toBeUndefined()
})

/**
 * A picker tile says who will see the emote if you send it (the emote law's offer: "says who will
 * see it"). The Tab readout always did; a tile's hover text only named its provider, so a picture
 * found in the picker's search (heatsync only) read the same as the channel's own (7tv users).
 * The tile asks the readout's own classifier, so the two can never disagree.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { t } from './t-stub.js'

const read = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')
const slice = (src, from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  if (a === -1 || b === -1) throw new Error(`carve markers not found: ${from} .. ${to}`)
  return src.slice(a, b)
}
const TILE = slice(
  read('emotes.js'),
  '// the one-letter corner mark of a picker tile',
  '/**\n * Emote picker — DOM is built once',
)
const META = slice(read('input.js'), 'function emoteCycleMeta(m)', 'function showCycleTooltip()')

// the overlay's entry as the law's emote, and the law's own tileSays over a room (shared/emote-mark.ts):
// what emote-law-send.js lawTileSays does with the open tab's room
const lawOf = (name, e) => {
  const provider = e.source === 'heatsync' ? 'hs' : e.source
  return { name, key: `${provider}:${e.url}`, provider, id: e.url, pic: e.url }
}
const roomOf = (held) => {
  const names = new Map(Object.entries(held).map(([n, e]) => [n, lawOf(n, e)]))
  const index = { size: names.size, get: (n) => names.get(n), values: () => names.values(), at: () => undefined }
  const empty = { size: 0, get: () => undefined, values: () => [].values(), at: () => undefined }
  const room = { platform: 'twitch', channel: 'c', loaded: true, names: index }
  return {
    room,
    legs: [room],
    own: { inventory: empty, personal: empty, native: { twitch: empty, kick: empty } },
    globals: empty,
    fold: false,
  }
}
const lawTileSaysIn = (held) => (name, e, tier) => hsEmoteLaw.tileSays(roomOf(held), lawOf(name, e), tier)
const lawTileSaysRoomless = (name, e, tier) =>
  hsEmoteLaw.tileSays({ room: null, legs: [], own: roomOf({}).own, globals: roomOf({}).globals }, lawOf(name, e), tier)

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
  (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
  () => null,
  () => false,
  (u) => u,
  lawTileSaysRoomless,
)
const title = (name, emote) => /title="([^"]*)"/.exec(emoteImgHtml([name, { url: 'https://x/e.webp', ...emote }]))[1]

describe('a picker tile says who sees it', () => {
  test("the channel's or a global third-party emote: that provider's users", () => {
    expect(title('KEKW', { source: '7tv', state: 'global' })).toBe('KEKW (7tv · 7tv users)')
    expect(title('Pog', { source: 'ffz' })).toBe('Pog (ffz · ffz users)')
  })
  test("a platform's own emote: everyone there", () => {
    expect(title('Kappa', { source: 'twitch' })).toBe('Kappa (twitch · all twitch)')
    expect(title('kickW', { source: 'kick' })).toBe('kickW (kick · all kick)')
    expect(title('ytW', { source: 'youtube' })).toBe('ytW (youtube · all youtube)')
  })
  test('your own copy, whatever provider it came from: heatsync only', () => {
    expect(title('KEKW', { source: '7tv', state: 'owned' })).toBe('KEKW (7tv · heatsync only)')
    expect(title('Mine', { source: 'heatsync' })).toBe('Mine (heatsync · heatsync only)')
  })
  test('a search answer or an away favorite (a variant tile) is not loaded here: heatsync only', () => {
    expect(title('KEKW', { source: '7tv', variant: '7tv:01X' })).toBe('KEKW (7tv · heatsync only)')
  })
})

describe('a picker tile carries a corner mark for who sees it', () => {
  const mkHtml = new Function(
    't',
    'escapeHtml',
    'hsEmoteHiddenForViewer',
    'emoteIsBlocked',
    'hsRungUrl',
    'lawTileSays',
    `${META}\n${TILE}\nreturn emoteImgHtml`,
  )(
    t,
    (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
    () => null,
    () => false,
    (u) => u,
    lawTileSaysRoomless,
  )
  const html = (name, emote) => mkHtml([name, { url: 'https://x/e.webp', ...emote }])
  const mark = (name, emote) => /data-mark="([^"]*)"/.exec(html(name, emote))?.[1] ?? null
  test("a platform's own emote wears its platform's letter: T twitch, K kick, Y youtube", () => {
    expect(mark('Kappa', { source: 'twitch' })).toBe('T')
    expect(mark('kickW', { source: 'kick' })).toBe('K')
    expect(mark('ytW', { source: 'youtube' })).toBe('Y')
  })
  test('no mark is only for what has no platform letter: an unclassifiable provider', () => {
    expect(mark('x', { source: 'newthing' })).toBeNull()
  })
  test('provider users only: 7, B, F', () => {
    expect(mark('a', { source: '7tv', state: 'global' })).toBe('7')
    expect(mark('b', { source: 'bttv' })).toBe('B')
    expect(mark('c', { source: 'ffz' })).toBe('F')
  })
  test('heatsync users only: H (own copy, heatsync upload, a search hit)', () => {
    expect(mark('a', { source: '7tv', state: 'owned' })).toBe('H')
    expect(mark('b', { source: 'heatsync' })).toBe('H')
    expect(mark('c', { source: 'bttv', variant: 'bttv:01X' })).toBe('H')
  })
  test('the words stay in the label and the title', () => {
    const h = html('KEKW', { source: '7tv', state: 'global' })
    expect(h).toContain('aria-label="KEKW · 7tv users"')
    expect(h).toContain('title="KEKW (7tv · 7tv users)"')
  })
  test('one css rule draws the mark: black cutout, inverted on hover, square', () => {
    const css = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'styles', '10-emotes.css'), 'utf8')
    expect(css).toMatch(
      /\.hs-mc-picker-emote-wrap\[data-mark\]::after\s*\{[^}]*content:\s*attr\(data-mark\)[^}]*background:\s*#000/s,
    )
    expect(css).toMatch(/\[data-mark\]:not\(\.blocked\):hover::after\s*\{[^}]*color:\s*#000[^}]*background:\s*#fff/s)
    expect(css).not.toMatch(/\[data-mark\][^{]*\{[^}]*border-radius:\s*[1-9]/)
  })
})

// the law: a typed word is the room's emote and a click pins the tile's own picture, so a tile's mark
// says what SENDING it from this room ships (emote-law-send.js lawTileSays answers; the tile reads it)
describe('a picker tile says what sending it from this room ships', () => {
  const build = (held) =>
    new Function(
      't',
      'escapeHtml',
      'hsEmoteHiddenForViewer',
      'emoteIsBlocked',
      'hsRungUrl',
      'lawTileSays',
      `${META}\n${TILE}\nreturn emoteImgHtml`,
    )(
      t,
      (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
      () => null,
      () => false,
      (u) => u,
      lawTileSaysIn(held),
    )
  const mark = (held, emote) =>
    /data-mark="([^"]*)"/.exec(build(held)(['BigDog', { url: 'https://x/e.webp', ...emote }]))?.[1] ?? null
  test("your copy of the room's own 7tv picture ships as the room's: 7, never H", () => {
    expect(mark({ BigDog: { source: '7tv', url: 'https://x/e.webp' } }, { source: '7tv', state: 'owned' })).toBe('7')
  })
  test('a picture the room does not hold stays yours alone: H', () => {
    expect(mark({}, { source: '7tv', state: 'owned' })).toBe('H')
  })
  test('a copy the room would override is never drawn (lawTileHidden), so no tile carries a cross', () => {
    expect(emoteImgHtml).toBeDefined()
    expect(mark({ BigDog: { source: '7tv', url: 'https://x/other.webp' } }, { source: '7tv', state: 'owned' })).toBe(
      'H',
    )
  })
})

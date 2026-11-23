/**
 * A scrolled-back twitch line keeps the emote its sender picked. The history answer carries the
 * server's record of what each sender's app shipped (`emote_refs: { line id: { word: ref } }`); the
 * background read only the lines, so an old row drew the room's emote of a name where its live copy
 * drew the pick, and an emote taken down since came back as a look-alike.
 *
 * The REAL bgIrcHistoryRefs / bgIrcAdoptHistoryRefs are carved out of the background parts.
 */

import { describe, expect, test } from 'bun:test'
import { bgSource } from './bg-src.js'

const SRC = bgSource()
function fn(name) {
  const a = SRC.indexOf(`function ${name}(`)
  if (a === -1) throw new Error(`${name} not found in the background parts`)
  return SRC.slice(a, SRC.indexOf('\n}\n', a) + 3)
}
const { bgIrcHistoryRefs, bgIrcAdoptHistoryRefs } = new Function(
  'API_URL',
  `${fn('absUrl')}\n${fn('bgIrcHistoryRefs')}\n${fn('bgIrcAdoptHistoryRefs')}\nreturn { bgIrcHistoryRefs, bgIrcAdoptHistoryRefs }`,
)('https://heatsync.org')

describe("the server's record of a line's emotes, as the row's refs", () => {
  test("each provider is named as its own 1x file, a sender's own by the address the server resolved", () => {
    expect(
      bgIrcHistoryRefs({
        KEKW: { p: '7tv', id: '01ABC', z: true },
        Wide: { p: 'bttv', id: '5f1b0186cf6d2144653d2970' },
        Still: { p: 'ffz', id: '128054' },
        Moving: { p: 'ffz', id: '9', a: true },
        Mine: { p: 'hs', id: 'h1', url: '/uploads/emotes/mine.webp' },
        Far: { p: 'hs', id: 'h2', url: 'https://cdn.7tv.app/emote/01ABD/2x.webp' },
      }),
    ).toEqual({
      KEKW: { url: 'https://cdn.7tv.app/emote/01ABC/1x.webp', provider: '7tv', zeroWidth: true },
      Wide: {
        url: 'https://cdn.betterttv.net/emote/5f1b0186cf6d2144653d2970/1x.webp',
        provider: 'bttv',
        zeroWidth: false,
      },
      Still: { url: 'https://cdn.frankerfacez.com/emote/128054/1', provider: 'ffz', zeroWidth: false },
      Moving: { url: 'https://cdn.frankerfacez.com/emote/9/animated/1', provider: 'ffz', zeroWidth: false },
      Mine: { url: 'https://heatsync.org/uploads/emotes/mine.webp', provider: 'heatsync', zeroWidth: false },
      Far: { url: 'https://cdn.7tv.app/emote/01ABD/2x.webp', provider: 'heatsync', zeroWidth: false },
    })
  })

  test('none is a name-match: what the app shipped reads above the room', () => {
    for (const r of Object.values(
      bgIrcHistoryRefs({ A: { p: '7tv', id: '1' }, B: { p: 'hs', id: 'h', url: '/e/hs/h' } }),
    )) {
      expect(r.nm).toBeUndefined()
    }
  })

  test('one taken down since is a marker with no picture', () => {
    expect(bgIrcHistoryRefs({ Old: { p: 'hs', id: 'h2', gone: true } })).toEqual({ Old: { gone: true } })
  })

  test('nothing malformed is kept, and a record with nothing usable is no refs', () => {
    expect(
      bgIrcHistoryRefs({
        'bad name': { p: '7tv', id: '01ABC' },
        Path: { p: '7tv', id: '../x' },
        Ffz: { p: 'ffz', id: '12a' },
        Plain: { p: 'hs', id: 'h', url: 'http://heatsync.org/x.webp' },
        Script: { p: 'hs', id: 'h', url: 'javascript:alert(1)' },
        Quote: { p: 'hs', id: 'h', url: 'https://x.example/a"b' },
        NoUrl: { p: 'hs', id: 'h' },
        Other: { p: 'twitch', id: '25' },
        Junk: 7,
        Null: null,
      }),
    ).toBeNull()
    for (const junk of [null, undefined, 7, 'x', [], [{ p: '7tv', id: '1' }]]) expect(bgIrcHistoryRefs(junk)).toBeNull()
  })

  test('a word called __proto__ is a name like any other', () => {
    const out = bgIrcHistoryRefs(JSON.parse('{"__proto__":{"p":"7tv","id":"01ABC"}}'))
    expect(Object.keys(out)).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    const m = {}
    expect(bgIrcAdoptHistoryRefs(m, out)).toBe(true)
    expect(Object.keys(m.hsEmotes)).toEqual(['__proto__'])
    expect(bgIrcAdoptHistoryRefs(m, out)).toBe(false)
  })

  test('at most 50 per line', () => {
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`E${i}`, { p: '7tv', id: `a${i}` }]))
    expect(Object.keys(bgIrcHistoryRefs(many))).toHaveLength(50)
  })
})

describe('a row already held takes the record', () => {
  const pick = { url: 'https://cdn.7tv.app/emote/01ABC/1x.webp', provider: '7tv', zeroWidth: false }
  test('a name it has no ref for, and one it only has a name-match for', () => {
    const m = { hsEmotes: { Guess: { url: 'https://x.example/g.webp', nm: 1 } } }
    expect(bgIrcAdoptHistoryRefs(m, { KEKW: pick, Guess: pick })).toBe(true)
    expect(m.hsEmotes).toEqual({ KEKW: pick, Guess: pick })
    const bare = {}
    expect(bgIrcAdoptHistoryRefs(bare, { KEKW: pick })).toBe(true)
    expect(bare.hsEmotes).toEqual({ KEKW: pick })
  })
  test('a pick it already holds stays, until the record says it was taken down', () => {
    const live = { url: 'https://cdn.7tv.app/emote/01LIVE/1x.webp', provider: '7tv' }
    const m = { hsEmotes: { KEKW: live } }
    expect(bgIrcAdoptHistoryRefs(m, { KEKW: pick })).toBe(false)
    expect(m.hsEmotes.KEKW).toBe(live)
    expect(bgIrcAdoptHistoryRefs(m, { KEKW: { gone: true } })).toBe(true)
    expect(m.hsEmotes.KEKW).toEqual({ gone: true })
    expect(bgIrcAdoptHistoryRefs(m, { KEKW: { gone: true } })).toBe(false)
  })
})

describe('the history merge reads the record', () => {
  const body = fn('bgIrcFetchRobotty')
  test('a new line gets its refs, a held one adopts them, and adopted rows reach the open chat', () => {
    expect(body).toContain('Object.hasOwn(shipped, msg.id) ? bgIrcHistoryRefs(shipped[msg.id]) : null')
    expect(body).toContain('if (held) adopted += bgIrcAdoptHistoryRefs(held, hs) ? 1 : 0')
    expect(body).toContain('else msg.hsEmotes = hs')
    expect(body).toMatch(
      /if \(adopted\) \{\n\s+bgIrcPersistChannel\(ch\)\n\s+bgIrcBroadcast\(\{ type: 'bg_irc_history_merged', channel: ch, count: 0 \}\)/,
    )
  })
})

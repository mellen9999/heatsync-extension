/**
 * Big emote-only lines, through the real row renderer.
 *
 * shared/emote-only.vectors.json is the rule (tests/emote-only-vectors.test.ts runs it on the rule
 * itself). Here every case is built into a room, its line drawn by the real processEmotes, and the
 * read processEmotes hands back is judged by the rule: the verdict has to be the vector's, so the
 * row drew exactly what the rule counted.
 *
 * A line that is big is drawn again by the same renderer at the next rung up (1x -> 2x), with no
 * pinned box width (the img's own width/height reserve it); every other line, and a big line with
 * the setting off, is drawn exactly as it was.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

const { processEmotes, channelEmoteCaches, emoteCache, blockedEmoteNames, hydrateEmoteBoxWidths } = await import(
  '../src/multichat/emotes.js'
)

const V = JSON.parse(readFileSync(join(import.meta.dir, '..', 'shared', 'emote-only.vectors.json'), 'utf8'))
const CH = 'chan-big'
const seven = (name, extra = {}) => [
  name,
  {
    url: `https://cdn.7tv.app/emote/${name.replace(/\W/g, '')}/1x.webp`,
    source: '7tv',
    state: 'channel',
    zeroWidth: false,
    width: 32,
    height: 32,
    ...extra,
  },
]
const room = (entries) => {
  channelEmoteCaches[CH] = new Map(entries)
}
const draw = (text, { extra = null, yt = null, big = false, platform = 'twitch' } = {}) => {
  const line = { read: big ? null : [], big, yt }
  const html = processEmotes(escapeHtml(text), CH, extra, null, null, true, null, null, platform, line)
  return { html, read: line.read }
}
const verdict = (read) => hsEmoteLaw.emoteOnly(read)

// every word of a vector line that the vector reads as a picture becomes an emote of the room; a word
// of glued emoji is read as one entry per emoji
const EMOJI_WORD = /^[\p{Extended_Pictographic}\u200D\uFE0F]+$/u
function worldFor(c) {
  const entries = []
  let i = 0
  for (const w of c.line.split(' ').filter(Boolean)) {
    if (EMOJI_WORD.test(w)) {
      i += [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(w)].length
      continue
    }
    const kind = c.read[i++]
    if (kind === 'emote') entries.push(seven(w))
    if (kind === 'overlay') entries.push(seven(w, { zeroWidth: true }))
  }
  expect(i, 'the vector read has one entry per word drawn').toBe(c.read.length)
  return entries
}

describe('every vector line, drawn by the real row renderer, is read the way the rule says', () => {
  // the rows the renderer cannot be asked in this shape: a youtube emoji needs the line's own
  // youtube list (below), a lone "overlay" read is a mislabelled read no renderer produces
  const OWN = new Set([
    'a native youtube emoji is a picture',
    'an overlay with no picture before it counts as one (a mislabelled read does not count short)',
  ])
  for (const c of V.cases.filter((c) => !OWN.has(c.name))) {
    test(`${c.name}: ${JSON.stringify(c.line)}`, () => {
      room(worldFor(c))
      try {
        const { read } = draw(c.line)
        expect(verdict(read)).toEqual({ size: c.want, pictures: c.pictures })
      } finally {
        delete channelEmoteCaches[CH]
      }
    })
  }

  test('a native youtube emoji (the line carries its own list) is a picture', () => {
    room([])
    try {
      const { read } = draw(':hand-pink-waving:', { yt: new Set([':hand-pink-waving:']) })
      expect(verdict(read)).toEqual({ size: 'big', pictures: 1 })
      // without the list it is a word
      expect(verdict(draw(':hand-pink-waving:').read).size).toBe('normal')
    } finally {
      delete channelEmoteCaches[CH]
    }
  })
})

describe('what the row does not count', () => {
  test('a zero-width emote after a word draws inline: the word makes the line normal, the emote is a picture', () => {
    room([seven('Kappa'), seven('RainTime', { zeroWidth: true })])
    try {
      const { read } = draw('hi RainTime')
      expect(read).toEqual(['text', 'emote'])
      expect(verdict(read).size).toBe('normal')
      // after a picture it stacks and is not counted
      expect(draw('Kappa RainTime').read).toEqual(['emote', 'overlay'])
      expect(verdict(draw('Kappa RainTime').read)).toEqual({ size: 'big', pictures: 1 })
    } finally {
      delete channelEmoteCaches[CH]
    }
  })

  test('a name0 stacked on the emote before it is an overlay, not a picture', () => {
    room([seven('Kappa'), seven('Wave')])
    try {
      expect(draw('Kappa Wave0').read).toEqual(['emote', 'overlay'])
    } finally {
      delete channelEmoteCaches[CH]
    }
  })

  test('a modifier word bound to its emote is not counted; one with nothing to change is a word', () => {
    room([seven('Kappa')])
    try {
      expect(draw('w! Kappa').read).toEqual(['mod', 'emote'])
      expect(draw('Kappa ffzX').read).toEqual(['emote', 'mod'])
      expect(verdict(draw('w!').read).size).toBe('normal')
    } finally {
      delete channelEmoteCaches[CH]
    }
  })

  test('an emote the viewer blocked draws a dashed box, not a picture: the line is normal', () => {
    room([seven('Kappa'), seven('Keepo')])
    blockedEmoteNames.add('Kappa')
    try {
      const { read } = draw('Kappa Keepo')
      expect(read).toEqual(['text', 'emote'])
      expect(verdict(read).size).toBe('normal')
    } finally {
      blockedEmoteNames.delete('Kappa')
      delete channelEmoteCaches[CH]
    }
  })

  test('a content-warning stub is a box with a label, not a picture', () => {
    room([seven('Spicy', { cw: 'sexual', url: '' })])
    try {
      expect(draw('Spicy').read).toEqual(['text'])
    } finally {
      delete channelEmoteCaches[CH]
    }
  })

  test('twitch and kick natives are pictures; the line is read word by word', () => {
    room([])
    try {
      const extra = new Map([
        [
          'Kappa',
          {
            url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0',
            source: 'twitch',
            state: 'global',
            zeroWidth: false,
          },
        ],
      ])
      expect(draw('Kappa', { extra }).read).toEqual(['emote'])
      expect(draw('[emote:37226:KEKW] [emote:1:LUL]', { platform: 'kick' }).read).toEqual(['emote', 'emote'])
      expect(draw('hello [emote:37226:KEKW]', { platform: 'kick' }).read).toEqual(['text', 'emote'])
    } finally {
      delete channelEmoteCaches[CH]
    }
  })

  test('glued emoji are a picture each, a word of emoji and a word are not', () => {
    room([])
    try {
      expect(draw('😂😂😂').read).toEqual(['emoji', 'emoji', 'emoji'])
      expect(draw('👨‍👩‍👧').read).toEqual(['emoji'])
      expect(draw('🇺🇸').read).toEqual(['emoji'])
      expect(draw('lol😂').read).toEqual(['text', 'emoji'])
    } finally {
      delete channelEmoteCaches[CH]
    }
  })

  test('a :shortcode: emoji is a picture, its :0 stacks on the one before', () => {
    room([])
    globalThis.EMOJI_BY_NAME = new Map([
      ['smile', { emoji: '😄' }],
      ['hat', { emoji: '🎩' }],
    ])
    try {
      expect(draw(':smile:').read).toEqual(['emoji'])
      expect(draw(':smile: :hat:0').read).toEqual(['emoji', 'overlay'])
    } finally {
      delete globalThis.EMOJI_BY_NAME
      delete channelEmoteCaches[CH]
    }
  })

  test('a line with no emote data at all is left as it was: no read, no work', () => {
    delete channelEmoteCaches[CH]
    const had = emoteCache.size
    emoteCache.clear()
    try {
      const line = { read: [], big: false, yt: null }
      expect(processEmotes('Kappa', CH, null, null, null, true, null, null, 'twitch', line)).toBe('Kappa')
      expect(line.read).toEqual([])
    } finally {
      expect(had).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('what a big line draws', () => {
  test('every picture takes the next rung up (1x -> 2x), with no pinned box width', () => {
    room([seven('Kappa'), seven('Keepo')])
    try {
      const normal = draw('Kappa Keepo').html
      const big = draw('Kappa Keepo', { big: true }).html
      expect(normal).toContain('/Kappa/1x.webp')
      expect(normal).not.toContain('/Kappa/2x.webp')
      expect(big).toContain('/Kappa/2x.webp')
      expect(big).toContain('/Keepo/2x.webp')
      expect(big).not.toContain('/1x.webp')
      // a picture never seen at the normal rung has no width to take twice: the img's own size reserves it
      expect(big).toContain('width="32" height="32"')
      expect(big).not.toMatch(/<span class="hs-mc-emote-wrapper[^>]* style="width:/)
    } finally {
      delete channelEmoteCaches[CH]
    }
  })

  test('on a dense screen the next rung up is the top one; the ladder stops at 4', () => {
    room([seven('Kappa')])
    globalThis.devicePixelRatio = 2
    try {
      expect(draw('Kappa').html).toContain('/Kappa/2x.webp')
      expect(draw('Kappa', { big: true }).html).toContain('/Kappa/4x.webp')
    } finally {
      delete globalThis.devicePixelRatio
      delete channelEmoteCaches[CH]
    }
    expect([1, 2, 4].map(hsBigRung)).toEqual([2, 4, 4])
  })

  test('the same words, drawn with no line object, are byte for byte what the row drew before', () => {
    room([seven('Kappa'), seven('Keepo')])
    try {
      const plain = processEmotes(escapeHtml('Kappa Keepo'), CH, null, null, null, true)
      expect(draw('Kappa Keepo').html).toBe(plain)
      expect(draw('Kappa Keepo', { big: false }).html).toBe(plain)
    } finally {
      delete channelEmoteCaches[CH]
    }
  })
})

describe('the box a big line reserves', () => {
  test('twice the width learned for the picture at the normal rung (the 4px of padding does not scale), nothing from nothing', async () => {
    // what hsSnapEmoteBox learned and saved: Kappa's normal box is 36px wide
    globalThis.browser = {
      storage: {
        local: {
          get: async () => ({
            hs_emote_boxw_v1: { at: Date.now(), items: [['https://cdn.7tv.app/emote/Kappa/1x.webp', 36]] },
          }),
        },
      },
    }
    await hydrateEmoteBoxWidths()
    room([seven('Kappa'), seven('Keepo')])
    try {
      const normal = draw('Kappa Keepo').html
      const big = draw('Kappa Keepo', { big: true }).html
      expect(normal).toContain(
        'data-emote-name="Kappa" data-emote-url="https://cdn.7tv.app/emote/Kappa/1x.webp" data-state="channel" data-source="7tv" style="width:36px"',
      )
      expect(big).toContain(
        'data-emote-name="Kappa" data-emote-url="https://cdn.7tv.app/emote/Kappa/2x.webp" data-state="channel" data-source="7tv" style="width:68px"',
      )
      // Keepo was never seen: no box to take twice
      expect(big.match(/style="width:/g)).toHaveLength(1)
      expect(hsBigBoxW(36)).toBe(68)
      expect(hsBigBoxW(0)).toBe(0)
      expect(hsBigBoxW(undefined)).toBe(0)
    } finally {
      delete globalThis.browser
      delete channelEmoteCaches[CH]
    }
  })
})

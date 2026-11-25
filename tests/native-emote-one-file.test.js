/**
 * TWO PEOPLE POST THE SAME ANIMATED EMOTE AND THE TWO COPIES ANIMATE ON DIFFERENT CLOCKS.
 *
 * Chrome gives two <img> with the SAME src one animation timeline: they stay frame-locked
 * even when mounted 1.3s apart. Two different urls of one picture (…/emote/<id>/1x.webp vs
 * …/2x.webp) each run their own clock. The overlay already pulls every url of a picture to
 * one rung (getChatResUrl). Native chat rows (the extension painting emotes into twitch's
 * and youtube's own chat) used hsNativeRowUrl, which only rewrote our own uploads and passed
 * 7tv/bttv/ffz/twitch urls through raw — and the records store different rungs depending on
 * where they came from (a user's saved copy at 1x, the channel set at 2x). So two copies of
 * one picture drew two files and desynced.
 *
 * The real functions are evaluated out of emote-rungs.js (the file content.js and
 * youtube-content.js embed), so this cannot pass against a copy.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const RUNGS = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emote-rungs.js'), 'utf8')
const rows = (dpr) => new Function('devicePixelRatio', `${RUNGS}\nreturn { hsNativeRowUrl }`)(dpr).hsNativeRowUrl

const CDN = 'https://cdn.heatsync.org/uploads'

// one picture, stored at two different rungs by two different records
const SAME_PICTURE = [
  ['7tv', 'https://cdn.7tv.app/emote/01F6MZ/1x.webp', 'https://cdn.7tv.app/emote/01F6MZ/2x.webp'],
  ['bttv', 'https://cdn.betterttv.net/emote/5f1b/1x', 'https://cdn.betterttv.net/emote/5f1b/2x'],
  ['ffz', 'https://cdn.frankerfacez.com/emote/128054/1', 'https://cdn.frankerfacez.com/emote/128054/2'],
  [
    'twitch',
    'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0',
    'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0',
  ],
]

describe('two records of one picture draw one file in a native row', () => {
  for (const dpr of [1, 2]) {
    for (const [label, atOne, atTwo] of SAME_PICTURE) {
      test(`${label}: a 1x record and a 2x record are one url at dpr ${dpr}`, () => {
        const url = rows(dpr)
        expect(url({ url: atOne })).toBe(url({ url: atTwo }))
      })
    }
  }

  test('the one file is the rung the screen needs', () => {
    expect(rows(1)({ url: 'https://cdn.7tv.app/emote/01F6MZ/2x.webp' })).toBe(
      'https://cdn.7tv.app/emote/01F6MZ/1x.webp',
    )
    expect(rows(2)({ url: 'https://cdn.7tv.app/emote/01F6MZ/1x.webp' })).toBe(
      'https://cdn.7tv.app/emote/01F6MZ/2x.webp',
    )
    expect(rows(2)({ url: 'https://cdn.frankerfacez.com/emote/9/1' })).toBe('https://cdn.frankerfacez.com/emote/9/2')
  })

  test('a 7tv avif record and a webp record of one id are the same webp url', () => {
    for (const dpr of [1, 2]) {
      const url = rows(dpr)
      const want = `https://cdn.7tv.app/emote/01F6MZ/${dpr}x.webp`
      expect(url({ url: 'https://cdn.7tv.app/emote/01F6MZ/1x.avif' })).toBe(want)
      expect(url({ url: 'https://cdn.7tv.app/emote/01F6MZ/2x.avif' })).toBe(want)
      expect(url({ url: 'https://cdn.7tv.app/emote/01F6MZ/4x.webp' })).toBe(want)
    }
  })

  test('the avif rewrite keeps a query string', () => {
    expect(rows(1)({ url: 'https://cdn.7tv.app/emote/01F6MZ/2x.avif?v=3' })).toBe(
      'https://cdn.7tv.app/emote/01F6MZ/1x.webp?v=3',
    )
  })
})

describe('what it leaves alone', () => {
  test('a single-file provider keeps its url', () => {
    const kick = 'https://files.kick.com/emotes/5756668/fullsize'
    expect(rows(2)({ url: kick })).toBe(kick)
  })

  test('no url is no url, not a throw', () => {
    expect(rows(1)({})).toBeUndefined()
    expect(rows(1)(undefined)).toBeUndefined()
  })
})

describe('our own uploads still go by their advertised variants', () => {
  const own = (extra) => ({ url: `${CDN}/abc123.webp`, ...extra })

  test('list shape: the rung the screen needs', () => {
    const v = ['1x', '2x', '3x', '4x']
    expect(rows(1)(own({ variants: v }))).toBe(`${CDN}/abc123-1x.webp`)
    expect(rows(2)(own({ variants: v }))).toBe(`${CDN}/abc123-2x.webp`)
  })

  test('object shape, and only the rungs that exist', () => {
    const v = { '1x': `${CDN}/abc123-1x.webp`, '3x': `${CDN}/abc123-3x.webp` }
    expect(rows(1)(own({ variants: v }))).toBe(`${CDN}/abc123-1x.webp`)
    expect(rows(2)(own({ variants: v }))).toBe(`${CDN}/abc123-3x.webp`)
  })

  test('no variants = the canonical file, never guessed', () => {
    expect(rows(2)(own())).toBe(`${CDN}/abc123.webp`)
  })

  test('variants never retarget a url that is not our upload', () => {
    const other = 'https://evil.example/uploads/abc123.webp'
    expect(rows(2)({ url: other, variants: ['2x'] })).toBe(other)
  })
})

describe('the overlay and the native rows share one rule', () => {
  test('emotes.js asks hsEmoteFileUrl and no longer owns the ladder', () => {
    const emotes = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8')
    expect(emotes).toContain('hsEmoteFileUrl(url, want')
    expect(emotes).not.toContain('function hsRungUrl(')
    expect(RUNGS).toContain('function hsRungUrl(')
    expect(RUNGS).toContain('function hsEmoteFileUrl(')
  })

  test('both native row renderers draw through hsNativeRowUrl, overlay (zero-width) emotes keep their own url', () => {
    const c = readFileSync(join(import.meta.dir, '..', 'src', 'content', 'content.js'), 'utf8')
    const y = readFileSync(join(import.meta.dir, '..', 'src', 'content', 'youtube-content.js'), 'utf8')
    expect(c).toContain('isOverlay ? emote.url : hsNativeRowUrl(emote)')
    expect(y).toContain('hsNativeRowUrl(emote)')
  })
})

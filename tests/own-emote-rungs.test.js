/**
 * Our own uploads in chat: the right-sized copy, and a box that is reserved
 * before the file arrives.
 *
 * A channel owner's emotes come from /api/emotes/user/<channel>. The server
 * sends two optional things per emote on top of {name,url,hash,provider}:
 *
 *   variants      the smaller copies — a list ["1x","2x"] (inventory shape) or
 *                 an object {"1x": url, "2x": url} (channel-owner shape)
 *   width/height  natural size, enough to know the aspect before decode
 *
 * Both are optional. A payload without them must render exactly as before; a
 * payload WITH them must pick the rung the screen needs and reserve the box.
 * The shipped functions run here (emote-rungs.js evaluated, emotes.js carved or
 * imported) — never a copy.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as mods from '../src/lib/modifiers.js'
import { EMOTE_TIER_ORDER, resolveEmoteProviderWinner } from '../src/lib/utils.js'
import { hsEmoteDimAttr, hsOwnCanonicalUrl, hsOwnCopyFallback, hsOwnRungUrl } from './emote-rungs-src.js'
import './emote-rungs-globals.js'

const CDN = 'https://cdn.heatsync.org/uploads'
const ORIGIN = 'https://heatsync.org/uploads'

describe('hsOwnRungUrl — no variants, no guessing', () => {
  test('absent / empty / wrong-typed variants → the url as it came', () => {
    for (const v of [undefined, null, '', 0, false, 'x', 7]) {
      expect(hsOwnRungUrl(`${CDN}/abc.webp`, 1, v)).toBe(`${CDN}/abc.webp`)
    }
  })

  test('an object with no usable rung → the canonical file', () => {
    expect(hsOwnRungUrl(`${CDN}/abc.webp`, 1, {})).toBe(`${CDN}/abc.webp`)
    expect(hsOwnRungUrl(`${CDN}/abc.webp`, 1, { '1x': 5, '2x': null })).toBe(`${CDN}/abc.webp`)
  })
})

describe('hsOwnRungUrl — list shape (inventory)', () => {
  const list = ['1x', '2x', '3x', '4x']

  test('smallest advertised rung that is at least what the screen wants', () => {
    expect(hsOwnRungUrl(`${CDN}/abc.webp`, 1, list)).toBe(`${CDN}/abc-1x.webp`)
    expect(hsOwnRungUrl(`${CDN}/abc.webp`, 2, list)).toBe(`${CDN}/abc-2x.webp`)
    expect(hsOwnRungUrl(`${CDN}/abc.webp`, 4, list)).toBe(`${CDN}/abc.webp`)
  })

  test('skips a rung the list does not advertise', () => {
    expect(hsOwnRungUrl(`${CDN}/abc.webp`, 1, ['2x', '4x'])).toBe(`${CDN}/abc-2x.webp`)
  })

  test('derives only on the cdn host — a url on the origin host is left alone', () => {
    expect(hsOwnRungUrl(`${ORIGIN}/abc.webp`, 1, list)).toBe(`${ORIGIN}/abc.webp`)
  })
})

describe('hsOwnRungUrl — object shape (channel owner)', () => {
  const obj = (host) => ({ '1x': `${host}/abc-1x.webp`, '2x': `${host}/abc-2x.webp`, '3x': `${host}/abc-3x.webp` })

  test('picks the smallest rung at least as big as the screen wants', () => {
    expect(hsOwnRungUrl(`${CDN}/abc.webp`, 1, obj(CDN))).toBe(`${CDN}/abc-1x.webp`)
    expect(hsOwnRungUrl(`${CDN}/abc.webp`, 2, obj(CDN))).toBe(`${CDN}/abc-2x.webp`)
  })

  test('a screen wanting 4x gets the canonical file (it IS the 4x)', () => {
    expect(hsOwnRungUrl(`${CDN}/abc.webp`, 4, obj(CDN))).toBe(`${CDN}/abc.webp`)
  })

  test('takes the url the server gave, on either heatsync host', () => {
    expect(hsOwnRungUrl(`${ORIGIN}/abc.webp`, 2, obj(ORIGIN))).toBe(`${ORIGIN}/abc-2x.webp`)
    // the canonical on the origin host, the rungs on the cdn: same upload, fine
    expect(hsOwnRungUrl(`${ORIGIN}/abc.webp`, 2, obj(CDN))).toBe(`${CDN}/abc-2x.webp`)
  })

  test('a missing rung falls to the next one up, then to the canonical', () => {
    expect(hsOwnRungUrl(`${CDN}/abc.webp`, 1, { '2x': `${CDN}/abc-2x.webp` })).toBe(`${CDN}/abc-2x.webp`)
    expect(hsOwnRungUrl(`${CDN}/abc.webp`, 3, { '1x': `${CDN}/abc-1x.webp` })).toBe(`${CDN}/abc.webp`)
  })

  test('a payload cannot point a chat emote at a different file', () => {
    const evil = [
      { '1x': `${CDN}/other-1x.webp` }, // another upload
      { '1x': `${CDN}/abc-2x.webp` }, // right upload, wrong rung for the key
      { '1x': 'https://evil.example/uploads/abc-1x.webp' }, // not ours
      { '1x': 'http://cdn.heatsync.org/uploads/abc-1x.webp' }, // not https
      { '1x': 'https://cdn.heatsync.org.evil.example/uploads/abc-1x.webp' },
      { '1x': `${CDN}/abc-1x.webp?x=1` },
      { '1x': `${CDN}/../abc-1x.webp` },
      { '1x': `${CDN}/abc-1x.png` },
      { '1x': `${CDN}/abc-4x.webp` },
    ]
    for (const v of evil) expect(hsOwnRungUrl(`${CDN}/abc.webp`, 1, v)).toBe(`${CDN}/abc.webp`)
  })

  test('a canonical that is not one of our uploads is never rewritten', () => {
    const t = 'https://cdn.7tv.app/emote/abc/1x.webp'
    expect(hsOwnRungUrl(t, 1, obj(CDN))).toBe(t)
  })
})

describe('hsEmoteDimAttr', () => {
  test('whole positive numbers become width + height', () => {
    expect(hsEmoteDimAttr({ width: 256, height: 64 })).toBe(' width="256" height="64"')
  })

  test('anything short of a full, sane pair is nothing', () => {
    for (const e of [
      undefined,
      null,
      {},
      { width: 256 },
      { height: 64 },
      { width: 0, height: 64 },
      { width: -1, height: 64 },
      { width: 1.5, height: 64 },
      { width: '256', height: '64' },
      { width: 5000, height: 64 },
      { width: NaN, height: 64 },
    ]) {
      expect(hsEmoteDimAttr(e)).toBe('')
    }
  })
})

describe('hsOwnCanonicalUrl / hsOwnCopyFallback', () => {
  test('a rung url goes back to the original, on either host', () => {
    expect(hsOwnCanonicalUrl(`${CDN}/abc-2x.webp`)).toBe(`${CDN}/abc.webp`)
    expect(hsOwnCanonicalUrl(`${ORIGIN}/abc-1x.webp`)).toBe(`${ORIGIN}/abc.webp`)
  })

  test('everything else comes back untouched', () => {
    for (const u of [`${CDN}/abc.webp`, 'https://cdn.7tv.app/emote/abc/2x.webp', '', undefined]) {
      expect(hsOwnCanonicalUrl(u)).toBe(u)
    }
  })

  test('a copy that failed to load falls back to the original, once', () => {
    const img = { src: `${ORIGIN}/abc-2x.webp` }
    expect(hsOwnCopyFallback(img)).toBe(true)
    expect(img.src).toBe(`${ORIGIN}/abc.webp`)
    expect(hsOwnCopyFallback(img)).toBe(false)
  })
})

// ── the chain emotes.js runs: screen → wanted rung → url ─────────────────────

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8')
function carve(startAnchor, endAnchor) {
  const a = SRC.indexOf(startAnchor)
  const b = SRC.indexOf(endAnchor, a)
  if (a === -1 || b === -1) throw new Error(`carve: ${startAnchor} … ${endAnchor} not found — emotes.js moved`)
  return SRC.slice(a, b + endAnchor.length)
}
const CHAIN = `${carve('function hsRungUrl(url, want) {', '\n}')}
${carve('function hsWantedRung() {', '\n}')}
${carve('let _resCacheSize = 1', '\n  return out\n}')}`
const chatUrlFor = (emoteSize, dpr) =>
  new Function('emoteSize', 'devicePixelRatio', 'hsOwnRungUrl', `${CHAIN}\nreturn getChatResUrl`)(
    emoteSize,
    dpr,
    hsOwnRungUrl,
  )

describe('getChatResUrl — a channel owner emote follows the screen', () => {
  const url = `${CDN}/abc.webp`
  const variants = { '1x': `${CDN}/abc-1x.webp`, '2x': `${CDN}/abc-2x.webp`, '3x': `${CDN}/abc-3x.webp` }

  test('1x screen, small emotes → 1x copy', () => {
    expect(chatUrlFor(1, 1)(url, variants)).toBe(`${CDN}/abc-1x.webp`)
  })

  test('retina screen doubles it', () => {
    expect(chatUrlFor(1, 2)(url, variants)).toBe(`${CDN}/abc-2x.webp`)
  })

  test('big emotes on a retina screen need the original', () => {
    expect(chatUrlFor(2, 2)(url, variants)).toBe(url)
  })

  test('no variants → the url, as before', () => {
    expect(chatUrlFor(1, 2)(url, undefined)).toBe(url)
  })
})

describe('getHighResUrl — a tooltip wants the original of one of our copies', () => {
  const highRes = new Function(
    'hsOwnCanonicalUrl',
    `${carve('function getHighResUrl(url) {', '\n}')}\nreturn getHighResUrl`,
  )(hsOwnCanonicalUrl)

  test('rung → canonical', () => {
    expect(highRes(`${CDN}/abc-1x.webp`)).toBe(`${CDN}/abc.webp`)
    expect(highRes(`${ORIGIN}/abc-2x.webp`)).toBe(`${ORIGIN}/abc.webp`)
  })

  test('the other providers keep their own upgrade', () => {
    expect(highRes('https://cdn.7tv.app/emote/x/1x.webp')).toBe('https://cdn.7tv.app/emote/x/4x.webp')
    expect(highRes(`${CDN}/abc.webp`)).toBe(`${CDN}/abc.webp`)
  })
})

// ── the channel emote cache keeps them ───────────────────────────────────────

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
globalThis.resolveEmoteProviderWinner = resolveEmoteProviderWinner
globalThis.EMOTE_TIER_ORDER = EMOTE_TIER_ORDER

const { _buildChannelEmoteCache, channelEmoteCaches } = await import('../src/multichat/emotes.js')

describe('_buildChannelEmoteCache — own uploads keep variants and size', () => {
  const owner = (extra) => ({ name: 'Wide', url: `${CDN}/abc.webp`, hash: 'abc', provider: 'upload', ...extra })

  test('both shapes of variants and the natural size reach the entry', () => {
    const variants = { '1x': `${CDN}/abc-1x.webp`, '2x': `${CDN}/abc-2x.webp` }
    _buildChannelEmoteCache('chan-a', [owner({ variants, width: 256, height: 64 })], 'twitch')
    const e = channelEmoteCaches['chan-a'].get('Wide')
    expect(e.source).toBe('heatsync')
    expect(e.variants).toEqual(variants)
    expect(e.width).toBe(256)
    expect(e.height).toBe(64)

    _buildChannelEmoteCache('chan-b', [owner({ variants: ['1x', '2x'] })], 'kick')
    expect(channelEmoteCaches['chan-b'].get('Wide').variants).toEqual(['1x', '2x'])
  })

  test('absent fields → the entry it always was', () => {
    _buildChannelEmoteCache('chan-c', [owner()], 'twitch')
    const e = channelEmoteCaches['chan-c'].get('Wide')
    expect(e.url).toBe(`${CDN}/abc.webp`)
    expect(e.variants).toBeUndefined()
    expect(e.width).toBeUndefined()
    expect(e.height).toBeUndefined()
    expect(hsOwnRungUrl(e.url, 1, e.variants)).toBe(e.url)
    expect(hsEmoteDimAttr(e)).toBe('')
  })

  test('a third-party emote never picks up a size or rungs from the payload', () => {
    _buildChannelEmoteCache(
      'chan-d',
      [{ name: 'NaM', url: 'https://cdn.betterttv.net/emote/1/1x.webp', source: 'bttv', width: 38, height: 40 }],
      'twitch',
    )
    const e = channelEmoteCaches['chan-d'].get('NaM')
    expect(e.width).toBeUndefined()
    expect(e.height).toBeUndefined()
    expect(e.variants).toBeUndefined()
  })
})

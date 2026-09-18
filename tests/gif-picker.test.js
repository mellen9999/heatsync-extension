/**
 * The gifs tab: the invariants it is not allowed to lose.
 *
 * 1. THE GRID PAINTS STILLS. Twenty-four animated gifs decoding at once, over a
 *    live video player, is a space heater. The tile markup must carry the still
 *    in `src` and the animated rendition only in a data attribute, and exactly
 *    one tile may ever be swapped to it.
 *
 * 2. RECENTS ARE NOT EMOTE RECENTS. The emote MRU holds NAMES that get resolved
 *    against the emote maps at render; a gif id in that list resolves to
 *    nothing and silently shrinks the row.
 *
 * gifs.js imports cleanly (its module scope is constants only), so these run
 * against the real functions rather than a source slice — the bundle-global
 * calls inside them (escapeHtml, t, normalizeGif) resolve at CALL time, so the
 * test supplies the real ones. t() is the real en catalog, which makes every
 * assertion here also a check that the key exists and takes the substitutions
 * the call site passes.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeGif } from '../src/lib/gif-search-remote.js'
import {
  HS_GIF_EAGER,
  HS_GIF_RECENT_KEY,
  hsGifStatusHtml,
  hsGifTileHtml,
  hsLoadRecentGifs,
  hsRecordRecentGif,
  hsSetGifAnimated,
} from '../src/multichat/gifs.js'

const ROOT = join(import.meta.dir, '..')
const EN = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8'))
const EMOTES_SRC = readFileSync(join(ROOT, 'src', 'multichat', 'emotes.js'), 'utf8')

// The two bundle globals gifs.js leans on, for real.
globalThis.normalizeGif = normalizeGif
globalThis.escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
globalThis.t = (key, subs) => {
  const entry = EN[key]
  if (!entry) throw new Error(`t('${key}') — no such message in en/messages.json`)
  const args = subs == null ? [] : Array.isArray(subs) ? subs : [subs]
  const declared = Object.keys(entry.placeholders || {}).length
  if (declared !== args.length) {
    throw new Error(`t('${key}') passed ${args.length} substitutions, message declares ${declared}`)
  }
  let out = entry.message
  for (const [name, def] of Object.entries(entry.placeholders || {})) {
    const i = Number(String(def.content).slice(1)) - 1
    out = out.replaceAll(`$${name.toUpperCase()}$`, args[i])
  }
  return out
}

const gif = (n) => ({
  id: `id${n}`,
  url: `https://media.giphy.com/media/id${n}/giphy.gif`,
  preview: `https://media.giphy.com/media/id${n}/200_s.gif`,
  animated: `https://media.giphy.com/media/id${n}/200.gif`,
  label: `gif ${n}`,
  uses: n,
})

/** A tile the way hsSetGifAnimated sees one: a node with one <img> child. */
function fakeTile(g) {
  const img = { dataset: { still: g.preview, animated: g.animated }, src: g.preview }
  return { querySelector: () => img, _img: img }
}

function fakeLocalStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  }
}

describe('the grid paints stills', () => {
  test('a tile loads the still and only carries the animated url', () => {
    const html = hsGifTileHtml(gif(1), 0)
    expect(html).toContain('src="https://media.giphy.com/media/id1/200_s.gif"')
    expect(html).toContain('data-animated="https://media.giphy.com/media/id1/200.gif"')
    // The animated rendition must not be what the browser fetches on render.
    expect(html).not.toContain('src="https://media.giphy.com/media/id1/200.gif"')
  })

  test('the first screenful is eager and the tail is lazy', () => {
    expect(hsGifTileHtml(gif(1), 0)).not.toContain('loading="lazy"')
    expect(hsGifTileHtml(gif(1), HS_GIF_EAGER - 1)).not.toContain('loading="lazy"')
    expect(hsGifTileHtml(gif(1), HS_GIF_EAGER)).toContain('loading="lazy"')
  })

  test('a label and a url are escaped, not interpolated', () => {
    const hostile = {
      ...gif(2),
      label: '"><script>alert(1)</script>',
      preview: 'https://x/"onerror="alert(1)',
      animated: 'https://x/a.gif',
    }
    const html = hsGifTileHtml(hostile, 0)
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('onerror="alert')
    expect(html).toContain('&lt;script&gt;')
  })

  test('exactly one tile animates, and the last one goes back to its still', () => {
    const a = fakeTile(gif(1))
    const b = fakeTile(gif(2))
    hsSetGifAnimated(a)
    expect(a._img.src).toBe('https://media.giphy.com/media/id1/200.gif')

    hsSetGifAnimated(b)
    expect(a._img.src).toBe('https://media.giphy.com/media/id1/200_s.gif')
    expect(b._img.src).toBe('https://media.giphy.com/media/id2/200.gif')

    // Pointer leaves the grid entirely.
    hsSetGifAnimated(null)
    expect(b._img.src).toBe('https://media.giphy.com/media/id2/200_s.gif')
  })
})

describe('gif recents are their own list', () => {
  beforeEach(() => {
    globalThis.localStorage = fakeLocalStorage()
  })

  test('they never touch the emote MRU key', () => {
    hsRecordRecentGif(gif(1))
    expect([...globalThis.localStorage._map.keys()]).toEqual([HS_GIF_RECENT_KEY])
    expect(HS_GIF_RECENT_KEY).not.toBe('hs-mc-recent-emotes')
  })

  test('most recent first, deduped by id, capped', () => {
    for (let n = 1; n <= 15; n++) hsRecordRecentGif(gif(n))
    hsRecordRecentGif(gif(3))
    const list = hsLoadRecentGifs()
    expect(list[0].id).toBe('id3')
    expect(list.length).toBeLessThanOrEqual(12)
    expect(list.filter((g) => g.id === 'id3')).toHaveLength(1)
  })

  test('a corrupt or absent list is empty, never a throw', () => {
    expect(hsLoadRecentGifs()).toEqual([])
    globalThis.localStorage.setItem(HS_GIF_RECENT_KEY, '{not json')
    expect(hsLoadRecentGifs()).toEqual([])
    // A record with no url cannot be inserted, so it is not a recent.
    globalThis.localStorage.setItem(HS_GIF_RECENT_KEY, JSON.stringify([{ id: 'x' }]))
    expect(hsLoadRecentGifs()).toEqual([])
  })
})

describe('the status line', () => {
  test('counts what is on screen and names the keys', () => {
    const html = hsGifStatusHtml([gif(1), gif(2)])
    expect(html).toContain('2 gifs')
    expect(html).toContain('enter insert')
  })

  test('says nothing when there is nothing to say', () => {
    expect(hsGifStatusHtml([])).toBe('')
  })
})

/**
 * The tab bar used to be written inside the `showTwitchTab` ternary, so kick
 * and youtube viewers got no tab bar at all — which was invisible while twitch
 * was the only thing behind it, and would have hidden this whole tab from two
 * platforms out of three.
 */
describe('the tab bar belongs to the picker, not to twitch', () => {
  test('the bar is emitted outside the twitch branch', () => {
    const bar = EMOTES_SRC.indexOf('hs-mc-picker-tabs')
    const branch = EMOTES_SRC.indexOf('showTwitchTab\n          ?')
    expect(bar).toBeGreaterThan(-1)
    expect(branch).toBeGreaterThan(-1)
    // The ternary now closes before the bar is written.
    const between = EMOTES_SRC.slice(branch, bar)
    expect(between).toContain(": ''")
  })

  test('every tab in the table has a pane with the id the bar points at', () => {
    const table = EMOTES_SRC.slice(
      EMOTES_SRC.indexOf('const MC_PICKER_TABS'),
      EMOTES_SRC.indexOf('function mcVisiblePickerTabs'),
    )
    const ids = [...table.matchAll(/id: '([a-z]+)'/g)].map((m) => m[1])
    expect(ids).toEqual(['emotes', 'gifs', 'twitch'])
    for (const id of ids) {
      const emitted = id === 'gifs' ? readFileSync(join(ROOT, 'src', 'multichat', 'gifs.js'), 'utf8') : EMOTES_SRC
      expect(emitted).toContain(`id="hs-mc-tab-${id}"`)
    }
  })
})

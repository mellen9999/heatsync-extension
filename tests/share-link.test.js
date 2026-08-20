import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildMultichatLayout,
  buildMultichatShareUrl,
  SHARE_MAX_LAYOUT_LEN,
  SHARE_MAX_TABS,
  shareTabSegment,
  shareYoutubeValue,
} from '../src/multichat/share-link.js'

/**
 * `/m/<layout>` is the only thing the extension produces that a stranger can
 * open. The grammar lives in the SITE repo (server/routes/multichat-permalinks.ts),
 * so no build guard can pin the two sides together — these tests are the pin.
 *
 * Verified against prod on 2026-08-20: `/m/t:xqc,k:xqc+t:asmongold` returns 200
 * with per-layout og:title/og:description, and `/api/og/m/<layout>` returns a
 * real 1200x630 png.
 */

describe('shareTabSegment', () => {
  test('a twitch-only channel is one segment', () => {
    expect(shareTabSegment({ id: 'a', twitch: 'xqc' })).toBe('t:xqc')
  })

  test('twitch + kick on one channel is ONE comma-joined tab, not two', () => {
    // The comma is what makes it a simulcast tab. Splitting it on '+' would
    // render two columns of the same streamer — the opposite of the thing
    // worth showing off.
    expect(shareTabSegment({ id: 'a', twitch: 'xqc', kick: 'xqc' })).toBe('t:xqc,k:xqc')
  })

  test('names are lowercased', () => {
    expect(shareTabSegment({ id: 'a', twitch: 'XQC' })).toBe('t:xqc')
  })

  test('a name the server would reject is dropped, not emitted', () => {
    expect(shareTabSegment({ id: 'a', twitch: 'has spaces' })).toBe('')
    expect(shareTabSegment({ id: 'a', twitch: 'x'.repeat(31) })).toBe('')
    expect(shareTabSegment({ id: 'a', twitch: 'bad/slash' })).toBe('')
  })

  test('a partly-invalid channel still shares the valid half', () => {
    expect(shareTabSegment({ id: 'a', twitch: 'bad name', kick: 'trainwreckstv' })).toBe('k:trainwreckstv')
  })

  test('kick hyphens are allowed (twitch has none, the union is what ships)', () => {
    expect(shareTabSegment({ id: 'a', kick: 'some-streamer' })).toBe('k:some-streamer')
  })

  test('an empty channel yields nothing', () => {
    expect(shareTabSegment({ id: 'a' })).toBe('')
    expect(shareTabSegment(null)).toBe('')
  })
})

describe('shareYoutubeValue', () => {
  test('prefers a resolved handle over the url', () => {
    const ch = { id: 'yt-1', youtube: 'https://www.youtube.com/@fallback/live' }
    expect(shareYoutubeValue(ch, () => '@Resolved')).toBe('resolved')
  })

  test('falls back to the @handle in the url', () => {
    expect(shareYoutubeValue({ id: 'yt-1', youtube: 'https://www.youtube.com/@SomeOne/live' })).toBe('someone')
  })

  test('a UC id is taken from /channel/ and never lowercased', () => {
    // UC ids are case-SENSITIVE and contain hyphens — lowercasing one, or
    // pattern-matching it loose in the path, produces a dead link.
    const id = 'UCabc-DEF_ghiJKLmnoPQrst'
    expect(id).toHaveLength(24)
    const got = shareYoutubeValue({ id: 'yt-1', youtube: `https://www.youtube.com/channel/${id}` })
    expect(got).toBe(id)
  })

  test('a resolved UC id also survives un-lowercased', () => {
    const id = 'UCabc-DEF_ghiJKLmnoPQrst'
    expect(shareYoutubeValue({ id: 'yt-1' }, () => id)).toBe(id)
  })

  test('a watch url with no identity yields nothing', () => {
    expect(shareYoutubeValue({ id: 'yt-1', youtube: 'https://www.youtube.com/watch?v=abc123' })).toBe('')
  })

  test('an unshareable handle is dropped rather than emitted broken', () => {
    expect(shareYoutubeValue({ id: 'yt-1', youtube: 'https://www.youtube.com/@a b c' })).toBe('')
  })
})

describe('buildMultichatLayout', () => {
  test('joins tabs with + in the order the user arranged them', () => {
    const out = buildMultichatLayout([
      { id: '1', twitch: 'xqc', kick: 'xqc' },
      { id: '2', twitch: 'asmongold' },
      { id: '3', kick: 'trainwreckstv' },
    ])
    expect(out).toBe('t:xqc,k:xqc+t:asmongold+k:trainwreckstv')
  })

  test('skips channels with nothing shareable instead of leaving empty segments', () => {
    const out = buildMultichatLayout([{ id: '1', twitch: 'xqc' }, { id: '2' }, { id: '3', kick: 'train' }])
    expect(out).toBe('t:xqc+k:train')
    expect(out).not.toContain('++')
  })

  test('caps at the server tab limit', () => {
    const many = Array.from({ length: SHARE_MAX_TABS + 5 }, (_, i) => ({ id: `${i}`, twitch: `chan${i}` }))
    const out = buildMultichatLayout(many)
    expect(out.split('+')).toHaveLength(SHARE_MAX_TABS)
  })

  test('never exceeds the server length cap', () => {
    const many = Array.from({ length: SHARE_MAX_TABS }, (_, i) => ({ id: `${i}`, twitch: 'x'.repeat(30 - 1) + i }))
    const out = buildMultichatLayout(many)
    expect(out.length).toBeLessThanOrEqual(SHARE_MAX_LAYOUT_LEN)
  })

  test('empty and junk input yield an empty layout, never a broken one', () => {
    expect(buildMultichatLayout([])).toBe('')
    expect(buildMultichatLayout(null)).toBe('')
    expect(buildMultichatLayout([{ id: 'x' }])).toBe('')
  })
})

describe('buildMultichatShareUrl', () => {
  test('builds the prod url, unencoded', () => {
    const url = buildMultichatShareUrl([
      { id: '1', twitch: 'xqc', kick: 'xqc' },
      { id: '2', twitch: 'asmongold' },
    ])
    expect(url).toBe('https://heatsync.org/m/t:xqc,k:xqc+t:asmongold')
    // Every grammar char is a legal path char — percent-encoding any of them
    // breaks a raw paste, which is the whole point of the pretty grammar.
    expect(url).not.toContain('%3A')
    expect(url).not.toContain('%2B')
    expect(url).not.toContain('%2C')
  })

  test('returns empty rather than a link to an empty multichat', () => {
    expect(buildMultichatShareUrl([])).toBe('')
  })
})

describe('wiring', () => {
  const MAIN = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')

  test('the share button survives updateTabBar', () => {
    // updateTabBar removes every .hs-mc-tab[data-tab] it does not explicitly
    // exclude, and it runs on every channel load. A util button missing from
    // that list disappears seconds after it renders — the recorded "⇄ missing
    // on kick" bug.
    const reaper = MAIN.match(/'\.hs-mc-tab\[data-tab\]:not\([^']*'/)
    expect(reaper).toBeTruthy()
    expect(reaper[0]).toContain(':not([data-tab="share"])')
  })

  test('the button exists and is wired to the copy action', () => {
    expect(MAIN).toContain('data-tab="share"')
    expect(MAIN).toMatch(/tabId === 'share'[\s\S]{0,80}copyMultichatShareLink\(\)/)
  })

  test('the copy glue lives with its globals, not in the pure module', () => {
    // share-link.js is // @ts-check'd and importable in a test; reaching for
    // bundle-scope globals from there breaks both.
    const MOD = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'share-link.js'), 'utf8')
    expect(MOD).toContain('// @ts-check')
    for (const g of ['showToast', 'mcCopyFallback', 'youtubeLinks', 'config?.channels']) {
      expect(MOD.includes(g), `share-link.js should not reach for ${g}`).toBe(false)
    }
    expect(MAIN).toContain('async function copyMultichatShareLink(')
  })
})

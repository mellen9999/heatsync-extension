/**
 * Unit tests for the real `sanitizeColor` (src/multichat/main.js ~8398), the
 * hex-or-default color gate every username/color surface in the multichat
 * overlay routes through (irc.js, whispers.js, tooltips.js, social.js,
 * main.js itself — see grep for `sanitizeColor(` across src/multichat).
 * Every OTHER test in this suite stubs it flat, because it's a private
 * closure inside main.js's top-level IIFE — main.js has no `export`s at all
 * (unlike src/lib/*.js), so nothing outside that IIFE can import it directly.
 *
 * Rather than adding an export to a MAIN-world content script (main.js is a
 * plain classic script loaded via manifest content_scripts, not an ES
 * module — `export` there would be a hard SyntaxError at runtime), this file
 * follows the same source-slicing pattern already established in
 * tests/feed-quote-paint.test.js: read the real file text, slice out just
 * the `sanitizeColor` closure (plus the two lines of cache state declared
 * directly above it and the `COLOR_RE` const it references), and rebuild it
 * with `new Function`. `boostReadability` is NOT stubbed — it's imported for
 * real from src/lib/utils.js. `readableNamesEnabled` is the one true external
 * dependency (an outer `let` in main.js, default `true`) — exposed here via a
 * setter so tests can drive both branches and the cache-invalidation path.
 *
 * If sanitizeColor's shape in main.js changes, the marker strings below stop
 * matching and this file throws at import time (loud, not a silent stale
 * test) instead of testing drifted logic.
 */

import { describe, expect, test } from 'bun:test'
import { boostReadability } from '../src/lib/utils.js'
import { mainSource } from './main-src.js'

const MAIN_SRC = mainSource()

function sliceBetween(startMarker, endMarker) {
  const s = MAIN_SRC.indexOf(startMarker)
  if (s === -1) throw new Error(`sliceBetween: start marker not found: ${startMarker}`)
  const e = MAIN_SRC.indexOf(endMarker, s)
  if (e === -1) throw new Error(`sliceBetween: end marker not found: ${endMarker}`)
  return MAIN_SRC.slice(s, e)
}

// `const COLOR_RE = ...` — declared once near the top of main.js's IIFE, well
// outside sanitizeColor's own block.
const colorReDecl = sliceBetween('const COLOR_RE = ', '\n')

// The cache state (`_colorCacheReadable`, `_colorCache`) declared directly
// above sanitizeColor, plus the function body itself.
const sanitizeColorSrc = sliceBetween(
  'let _colorCacheReadable = readableNamesEnabled',
  '\n// Get platform overrides for the current live channel',
)

/** Fresh instance per call — each test gets its own `_colorCache` Map so
 * cache-behavior tests can't bleed into each other. */
function makeSanitizeColor({ readableNamesEnabled = true, boost = boostReadability } = {}) {
  const build = new Function(
    'boostReadability',
    `
    ${colorReDecl}
    let readableNamesEnabled = ${JSON.stringify(readableNamesEnabled)}
    ${sanitizeColorSrc}
    return {
      sanitizeColor,
      setReadableNamesEnabled: (v) => { readableNamesEnabled = v },
      cacheSize: () => _colorCache.size,
    }
    `,
  )
  return build(boost)
}

describe('sanitizeColor — real regex + boost + cache (src/multichat/main.js)', () => {
  test('a valid 6-digit hex that is already readable passes through unchanged', () => {
    const { sanitizeColor } = makeSanitizeColor()
    expect(sanitizeColor('#ff8700')).toBe('#ff8700')
  })

  test('a valid 3-digit hex passes the regex', () => {
    const { sanitizeColor } = makeSanitizeColor()
    expect(sanitizeColor('#fff')).toBe('#fff')
  })

  test('malformed input falls back to the #ffffff default', () => {
    const { sanitizeColor } = makeSanitizeColor()
    expect(sanitizeColor('not-a-color')).toBe('#ffffff')
    expect(sanitizeColor('red')).toBe('#ffffff')
    expect(sanitizeColor('#gg0000')).toBe('#ffffff')
    expect(sanitizeColor('#12')).toBe('#ffffff')
    expect(sanitizeColor('')).toBe('#ffffff')
    expect(sanitizeColor(null)).toBe('#ffffff')
    expect(sanitizeColor(undefined)).toBe('#ffffff')
    expect(sanitizeColor('javascript:alert(1)')).toBe('#ffffff')
  })

  test('readableNamesEnabled=true boosts a low-luminance color (real boostReadability, not stubbed)', () => {
    const { sanitizeColor } = makeSanitizeColor({ readableNamesEnabled: true })
    const out = sanitizeColor('#0000ff')
    expect(out).not.toBe('#0000ff')
    expect(out).toBe(boostReadability('#0000ff'))
  })

  test('readableNamesEnabled=false passes the raw color through with no boost', () => {
    const { sanitizeColor } = makeSanitizeColor({ readableNamesEnabled: false })
    expect(sanitizeColor('#0000ff')).toBe('#0000ff')
  })

  test('caches by input color — boostReadability is not recomputed on a repeat call', () => {
    let calls = 0
    const spy = (c) => {
      calls++
      return boostReadability(c)
    }
    const { sanitizeColor } = makeSanitizeColor({ readableNamesEnabled: true, boost: spy })
    const first = sanitizeColor('#0000ff')
    const second = sanitizeColor('#0000ff')
    const third = sanitizeColor('#0000ff')
    expect(first).toBe(second)
    expect(second).toBe(third)
    expect(calls).toBe(1)
  })

  test('cache-clear behavior: toggling readableNamesEnabled invalidates the cached entry for the same color', () => {
    const { sanitizeColor, setReadableNamesEnabled } = makeSanitizeColor({ readableNamesEnabled: true })
    const boosted = sanitizeColor('#0000ff')
    expect(boosted).not.toBe('#0000ff')

    setReadableNamesEnabled(false)
    const raw = sanitizeColor('#0000ff')
    expect(raw).toBe('#0000ff')

    setReadableNamesEnabled(true)
    const boostedAgain = sanitizeColor('#0000ff')
    expect(boostedAgain).toBe(boosted)
  })

  test('cache is capped at 500 entries (oldest evicted, does not grow unbounded)', () => {
    const { sanitizeColor, cacheSize } = makeSanitizeColor({ readableNamesEnabled: true })
    for (let i = 0; i < 501; i++) {
      sanitizeColor('#' + i.toString(16).padStart(6, '0'))
    }
    expect(cacheSize()).toBe(500)
  })
})

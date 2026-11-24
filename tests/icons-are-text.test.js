import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { trackedFiles } from '../scripts/lib/tracked-files.mjs'

// Icons are unicode text (<span class="hs-glyph">), never an svg. The site
// holds the same rule (tests/unit/icons-are-text.test.ts).
const ROOT = join(import.meta.dir, '..')
const SVG_OK = new Map([
  ['src/multichat/x-glyph.js', 'the one thick close × (.hs-x), shared with the site since 2026-10-02'],
  ['src/lib/paint-spec.js', 'paint art'],
  ['src/lib/scene-spec.js', 'scene art'],
])

describe('icons are text', () => {
  test('no svg icon in src', () => {
    const files = trackedFiles(ROOT, 'src').filter((f) => /\.(js|html)$/.test(f) && !SVG_OK.has(f))
    const bad = files.filter((f) =>
      /<svg\b/.test(readFileSync(join(ROOT, f), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')),
    )
    expect(bad).toEqual([])
  })

  // an svg built node by node never contains "<svg": the picker's three sub-tab icons were
  // drawn that way and the test above read as green over them
  test('no svg built in script either, bar the channel-points coin', () => {
    const NS = /createElementNS|www\.w3\.org\/2000\/svg/
    const files = trackedFiles(ROOT, 'src').filter((f) => /\.(js|html)$/.test(f) && !SVG_OK.has(f))
    const built = files.filter((f) => NS.test(readFileSync(join(ROOT, f), 'utf8')))
    expect(built).toEqual(['src/multichat/twitch-api.js'])
    // twitch's own coin mark (brand art), one builder: makeCoinSvg
    const api = readFileSync(join(ROOT, 'src/multichat/twitch-api.js'), 'utf8')
    expect(api.match(/createElementNS/g)?.length).toBe(2)
    const s = api.indexOf('function makeCoinSvg(')
    expect(api.slice(s, api.indexOf('\n}', s)).match(/createElementNS/g)?.length).toBe(2)
  })
})

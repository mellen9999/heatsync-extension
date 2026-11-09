import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
    const files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((f) => /\.(js|html)$/.test(f) && !SVG_OK.has(f))
    const bad = files.filter((f) =>
      /<svg\b/.test(readFileSync(join(ROOT, f), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')),
    )
    expect(bad).toEqual([])
  })
})

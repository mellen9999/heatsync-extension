import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BRAND } from '../src/lib/brand-tokens.js'
import { HS_PLAT_COLORS } from '../src/lib/palette.js'
import { inlineDoctrineOffenders } from './lib/inline-doctrine.mjs'
import { stripComments } from './lib/strip-comments.mjs'

// Square, flat, no blur — for css our js writes (template stylesheets,
// el.style.x, style objects). design-doctrine.test.js holds the stylesheets.
// The scanner is the site's, byte for byte (site-copy-parity).

const ROOT = join(import.meta.dir, '..')
// paint + scene compilers: somebody's art is the format
const ART_FILES = new Set(['src/lib/paint-spec.js', 'src/lib/scene-spec.js'])

const files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(js|mjs)$/.test(f) && !ART_FILES.has(f))

describe('inline css doctrine', () => {
  test('scans the code that writes style', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain('src/content/content.js')
    expect(files).toContain('src/multichat/main.js')
  })

  test('no radius, blur, gradient or glass outside paint art', () => {
    const bad = []
    for (const rel of files) {
      const raw = readFileSync(join(ROOT, rel), 'utf8')
      for (const o of inlineDoctrineOffenders(stripComments(raw), raw)) bad.push(`${rel}:${o}`)
    }
    expect(bad).toEqual([])
  })

  test('the twitch brand hex is the one shared/brand/tokens.json owns', () => {
    expect(HS_PLAT_COLORS.twitch).toBe(BRAND.brand.twitch)
    expect(HS_PLAT_COLORS.heatsync).toBe(BRAND.brand.hs)
  })
})

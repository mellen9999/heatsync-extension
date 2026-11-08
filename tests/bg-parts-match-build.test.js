import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { BG_PART_FILES } from './bg-src.js'

// build.js owns the concat order; the test helper mirrors it so a slice across
// two parts reads the same bytes the service worker runs.
describe('background parts', () => {
  test('the helper lists exactly build.js BG_PARTS, in order', () => {
    const build = readFileSync(new URL('../build.js', import.meta.url), 'utf8')
    const m = build.match(/const BG_PARTS = \[([\s\S]*?)\]/)
    expect(m).not.toBeNull()
    expect(BG_PART_FILES).toEqual([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))
  })

  test('every file in src/background is a listed part', () => {
    const onDisk = readdirSync(new URL('../src/background/', import.meta.url))
      .filter((f) => f.endsWith('.js'))
      .sort()
    expect(onDisk).toEqual([...BG_PART_FILES].sort())
  })
})

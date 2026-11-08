import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { MAIN_PART_FILES } from './main-src.js'

// build.js owns the bundle order; the test helper mirrors it so a slice across
// two parts reads the same bytes the bundle carries. Drift here would make a
// green test read a different program than the one that ships.
describe('main parts', () => {
  test('the helper lists exactly build.js MAIN_PARTS, in order, then main.js', () => {
    const build = readFileSync(new URL('../build.js', import.meta.url), 'utf8')
    const m = build.match(/const MAIN_PARTS = \[([\s\S]*?)\]/)
    expect(m).not.toBeNull()
    const fromBuild = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
    expect(MAIN_PART_FILES).toEqual([...fromBuild, 'main.js'])
  })

  test('no part carries its own wrapper — the IIFE is the bundle’s', () => {
    for (const f of MAIN_PART_FILES) {
      const src = readFileSync(new URL(`../src/multichat/${f}`, import.meta.url), 'utf8')
      const firstCode = src.replace(/^(\s*(\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*/, '')
      expect(firstCode.startsWith('(() =>') || firstCode.startsWith(';(() =>'), `${f} opens an IIFE`).toBe(false)
      expect(src.trimEnd().endsWith('})()'), `${f} closes an IIFE`).toBe(false)
    }
  })
})

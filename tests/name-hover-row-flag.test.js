import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// On a clickable notice row the name inverts alone. The row learns the pointer
// is on its name from an attribute main.js sets — a :has(:hover) version of
// this restyled ~28k elements per hover (300ms vs 10ms, traced 2026-10-30).
const css = readFileSync(join(import.meta.dir, '../src/multichat/styles/17-platform-position.css'), 'utf8')
const main = readFileSync(join(import.meta.dir, '../src/multichat/main.js'), 'utf8')

test('the universal row hover stands down on the flag, not on a :has()', () => {
  const universal = css.split('\n').filter((l) => l.includes('[data-hs-clickable]):not(:disabled)'))
  expect(universal.length).toBeGreaterThanOrEqual(2)
  for (const l of universal) expect(l).not.toContain(':has(')
  expect(css).toMatch(/:not\(\[data-hs-name-hover\]\):hover,/)
  expect(css).toMatch(/:not\(\[data-hs-name-hover\]\):hover \*,/)
})

test('main.js sets and clears the flag', () => {
  expect(main).toContain("row.dataset.hsNameHover = ''")
  expect(main).toContain('delete row.dataset.hsNameHover')
})

// The youtube home grid is forced to an auto-fill grid. Shelves and promos
// (ytd-rich-section-renderer) are not tiles: one cell squeezed a whole Shorts
// shelf into a single column, 2900px tall, and the tile width clamps flattened
// the shelf's own items. They span the row; the clamps stay on tiles only.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'styles', '17-platform-position.css'), 'utf8')

test('non-tile children of the grid span every column', () => {
  expect(css).toMatch(
    /ytd-rich-grid-renderer > #contents > :not\(ytd-rich-item-renderer\) \{\s*grid-column: 1 \/ -1 !important/,
  )
})

test('tile width clamps never reach items inside a section (shelf)', () => {
  const clamp = css.slice(css.indexOf('Defense-in-depth'), css.indexOf('Older grid'))
  const selectors = clamp
    .split('{')[0]
    .split('*/')
    .pop()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  expect(selectors.length).toBeGreaterThanOrEqual(8)
  for (const s of selectors) expect(s).toContain(':not(ytd-rich-section-renderer *)')
})

test('feed shelves are hidden by default and a setting brings them back', () => {
  expect(css).toMatch(
    /body\.hs-platform-yt:not\(\.hs-yt-shelves\) #page-manager ytd-rich-grid-renderer > #contents > ytd-rich-section-renderer \{\s*display: none !important/,
  )
  const schema = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'settings-schema.js'), 'utf8')
  expect(schema).toMatch(/key: 'ytFeedShelves',\s*type: 'bool',\s*default: false/)
  const main = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
  expect(main).toContain("document.body.classList.toggle('hs-yt-shelves', !!v)")
})

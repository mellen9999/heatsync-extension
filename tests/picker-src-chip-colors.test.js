// An active provider chip is a white fill, so its identity is the border ring.
// FFZ's ring was white-on-white — it read as "not highlighted" next to 7TV
// (cyan) and HS (orange). Every provider keeps its own ring when active.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(
  join(import.meta.dir, '..', 'src', 'multichat', 'styles', '13-platform-filter-picker.css'),
  'utf8',
)

test('every active provider chip has a ring that is not the white fill', () => {
  for (const src of ['7tv', 'bttv', 'ffz', 'hs']) {
    const m = css.match(
      new RegExp(`\\.hs-mc-src-chip\\.active\\[data-src="${src}"\\]\\s*\\{[^}]*border-color:\\s*([^;}]+)`),
    )
    expect(m, src).not.toBeNull()
    expect(m[1].trim().toLowerCase(), src).not.toBe('#ffffff')
  }
})

test('the popout opts out of page-recolouring dark-mode extensions', () => {
  const early = readFileSync(join(import.meta.dir, '..', 'chrome', 'early-layout.js'), 'utf8')
  expect(early).toMatch(
    /if \(isPopout\) \{\s*const lock = document\.createElement\('meta'\)\s*lock\.name = 'darkreader-lock'/,
  )
})

test('picker chunks flow as one section, never one flex box per chunk', () => {
  expect(css).toMatch(/\.hs-mc-picker-section \{\s*display: flex;\s*flex-wrap: wrap;/)
  expect(css).toMatch(/\.hs-mc-picker-chunk\.hs-mc-chunk-ready \{ display: contents; \}/)
  expect(css).not.toMatch(/\.hs-mc-picker-section-grid \{/)
})

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('content.js paints through the kit multichat-core publishes, not its own copy', () => {
  expect(read('src/multichat/paints.js')).toMatch(/window\.__hsPaintKit\s*=\s*\{[^}]*compilePaintCss/)
  const content = read('chrome/content.js')
  expect(content).not.toMatch(/[^.\w]compilePaintCss\(/)
  expect(content).not.toMatch(/[^.\w]hashPaintSpec\(/)
  expect(content).toContain('window.__hsPaintKit')
})

test('the build no longer embeds the paint compiler into content.js', () => {
  expect(read('build.js')).not.toMatch(/file === 'youtube-content\.js' \|\| file === 'content\.js'/)
})

test('content.js reads every compiler name from the kit — a bare NAME_BOX_CLASS threw on each native row', () => {
  expect(read('src/multichat/paints.js')).toMatch(/window\.__hsPaintKit\s*=\s*\{[^}]*NAME_BOX_CLASS/)
  expect(read('chrome/content.js')).not.toMatch(/[^.\w]NAME_BOX_CLASS/)
})

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../chrome/shared-utils.js', import.meta.url), 'utf8')

// the continuity proxy hid a tab-completed emote's placeholder url from the page-world fixer:
// the echo of your own message stayed a broken image
test('the emote continuity fallback leaves __FFZ__ placeholder urls to the page-world fixer', () => {
  const guard = src.indexOf("if (src.includes('__FFZ__')) return")
  expect(guard).toBeGreaterThan(0)
  expect(guard).toBeLessThan(src.indexOf("img.dataset.hsEcFb = '1'"))
})

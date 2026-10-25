import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../chrome/youtube-content.js', import.meta.url), 'utf8')

// youtube replaces the chat input while the page settles; listeners and a dropdown bound to the first
// node died with it, so tab complete "did nothing" until a later re-setup happened to catch the final node
test('yt tab complete listens on the document and builds its dropdown on demand', () => {
  expect(src).not.toMatch(/\binput\.addEventListener\(\s*'(input|keydown)'/)
  expect(src).toMatch(/function ensureDropdown\(input\)/)
  expect(src).toMatch(/document\.addEventListener\(\s*'keydown'/)
})

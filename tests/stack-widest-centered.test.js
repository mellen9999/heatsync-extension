import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../chrome/content.js', import.meta.url), 'utf8')

// a wide overlay (a curtain) used to be absolutely centred on a narrow base and spilled left over the
// username; a collapsed stack is now one grid cell as wide as its widest emote, the rest centred in it
test('a collapsed stack is a one-cell grid sized by its widest emote', () => {
  expect(css).toMatch(/\.heatsync-emote-stack:not\(\.expanded\) \{\s*display: inline-grid !important/)
  expect(css).toMatch(/grid-area: 1 \/ 1 !important/)
  expect(css).not.toMatch(/\.heatsync-emote-stack > \.heatsync-overlay,[^}]*position: absolute/)
})

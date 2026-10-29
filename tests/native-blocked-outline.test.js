import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../chrome/content.js', import.meta.url), 'utf8')

// opacity 0 hid the dashed outline with the picture, leaving a blocked emote nothing to right-click
test('a blocked native emote hides its picture, keeps its dashed outline', () => {
  const rule = (sel) => src.slice(src.indexOf(sel), src.indexOf('}', src.indexOf(sel)))
  for (const sel of [
    'img[data-hs-name-blocked] {',
    '.heatsync-emote-wrapper.emote-overlay-blocked > img.heatsync-emote {',
  ]) {
    expect(rule(sel)).toContain('object-position: 10000px 10000px')
    expect(rule(sel)).not.toContain('opacity: 0')
  }
  expect(rule('img[data-hs-name-blocked] {')).toContain('dashed #ffffff')
  expect(src).not.toMatch(/blocked \? 'opacity: 0;'/)
})

// the row you just sent is twitch's own emote img in a fixed square box; a wide heatsync emote came out squeezed
test('a sent heatsync emote in a twitch row keeps its full width', () => {
  expect(src).toMatch(/\.chat-line__message img\.chat-line__message--emote:not\(\[src\*="jtvnw\.net"\]\)/)
  expect(src).toMatch(/\.chat-image__container:has\(img\.chat-line__message--emote/)
})

// a cosmetic badge lives on the emote cdns; the emote wrapper must leave it alone or it blows up to a 36px block
test('wrapping existing emotes skips cosmetic badges', () => {
  expect(src).toMatch(
    /querySelectorAll\('img:not\(\.heatsync-emote\):not\(\.hs-cosmetic-badge\):not\(\.chat-badge\)'\)/,
  )
})

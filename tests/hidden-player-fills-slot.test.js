import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const css = readFileSync('src/multichat/styles/17-platform-position.css', 'utf8')
const js = readFileSync('src/multichat/chat-position.js', 'utf8')

// collapsed panel = same page layout as chat-right, so the offline player must
// fill its slot instead of keeping the stale px width twitch wrote while open
test('hidden state forces the twitch player to full slot width', () => {
  expect(css).toMatch(
    /hs-chat-hidden:not\(\.hs-mode-theatre\):not\(\.hs-twitch-no-channel\) \.persistent-player\s*\{\s*width: 100% !important/,
  )
})

test('hidden state clears stale player geometry like chat-right', () => {
  expect(js).toContain("} else if (isRight || chatPosition === 'hidden') {")
})

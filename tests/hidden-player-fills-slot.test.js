import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const css = readFileSync('src/multichat/styles/17-platform-position.css', 'utf8')
const js = readFileSync('src/multichat/chat-position.js', 'utf8')

// collapsed panel = same page layout as chat-right, so the offline player must
// fill its slot instead of keeping the stale px width twitch wrote while open
test('hidden state forces the twitch player to full slot width', () => {
  expect(css).toMatch(
    /hs-chat-hidden:not\(\.hs-mode-theatre\):not\(\.hs-twitch-no-channel\):not\(\.hs-offline\) \.persistent-player\s*\{\s*width: 100% !important/,
  )
})

test('hidden state clears stale player geometry like chat-right', () => {
  expect(js).toContain("} else if (isRight || chatPosition === 'hidden') {")
})

// the offline channel page's player is a small hero twitch places itself —
// forcing it to full width threw it off its area and hid its controls
test('the full-width rule leaves the offline hero player to twitch', () => {
  expect(css).toMatch(
    /hs-chat-right:not\(\.hs-mode-theatre\):not\(\.hs-twitch-no-channel\):not\(\.hs-offline\) \.persistent-player/,
  )
  expect(css).toMatch(
    /hs-chat-hidden:not\(\.hs-mode-theatre\):not\(\.hs-twitch-no-channel\):not\(\.hs-offline\) \.persistent-player/,
  )
})

test('the js pin skips an offline page and only takes back its own important insets', () => {
  const i = js.indexOf("classList.contains('hs-offline') && (isRight || chatPosition === 'hidden')")
  expect(i).toBeGreaterThan(-1)
  expect(js.slice(i, i + 700)).toContain("getPropertyPriority(p) === 'important'")
})

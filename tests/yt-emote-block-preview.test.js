import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../chrome/youtube-content.js', import.meta.url), 'utf8')

// a blocked emote must stay in chat as a placeholder, or right-click can never unblock it
test('yt keeps blocked emotes as placeholders and toggles block on right-click', () => {
  expect(src).toMatch(/blockedByName\.get\(word\)/)
  expect(src).toMatch(/dataset\.hsBlocked/)
  expect(src).toMatch(/type: was \? 'unblock_emote' : 'block_emote', hash:/)
  expect(src).not.toMatch(/emoteHash: emote\.hash/)
})

// the native title tooltip doubled the hover preview on twitch and kick; yt uses the preview alone
test('yt emotes carry no native title tooltip and show the hover preview', () => {
  expect(src).not.toMatch(/img\.title = emote\.name/)
  expect(src).toMatch(/function showEmotePreview/)
})

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../chrome/youtube-content.js', import.meta.url), 'utf8')

// a blocked emote must stay in chat as a placeholder, or right-click can never unblock it
test('yt keeps blocked emotes as placeholders and toggles block on right-click', () => {
  expect(src).toMatch(/blockedByName\.get\(word\)/)
  expect(src).toMatch(/dataset\.hsBlocked/)
  expect(src).toMatch(/type: was \? 'unblock_emote' : 'block_emote', hash/)
  // the same emote has a different hash per source: a block covers every version of the name
  expect(src).toMatch(/variantsByName\.get\(emote\.name\)/)
  expect(src).not.toMatch(/emoteHash: emote\.hash/)
})

// the native title tooltip doubled the hover preview on twitch and kick; yt uses the preview alone
test('yt emotes carry no native title tooltip and show the hover preview', () => {
  expect(src).not.toMatch(/img\.title = emote\.name/)
  expect(src).toMatch(/function showEmotePreview/)
})

// rows that rendered before the emote data arrived (a reload) must get their emotes when it does
test('yt re-sweeps existing rows whenever the emote map is rebuilt', () => {
  expect(src).toMatch(/function syncRows\(\)/)
  expect(src).toMatch(/emoteMap = map[\s\S]{0,80}syncRows\(\)/)
  expect(src).not.toMatch(/if \(messageEl && emoteMap\.size > 0\)/)
})

// a re-attach to a swapped chat list skips relaying its rows, which also skipped their emotes
test('yt gives a freshly attached chat list its emotes', () => {
  expect(src).toMatch(/not relayed again[\s\S]{0,80}syncRows\(\)/)
})

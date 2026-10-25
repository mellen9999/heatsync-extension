import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../chrome/youtube-content.js', import.meta.url), 'utf8')

// youtube renders your own message, then rewrites its text once it confirms it: the emote images were wiped
test('a row whose message youtube rewrites gets its emotes swapped in again', () => {
  expect(src).toMatch(/messageRerender = new MutationObserver/)
  expect(src).toMatch(/messageRerender\.observe\(messageEl, \{ childList: true \}\)/)
})

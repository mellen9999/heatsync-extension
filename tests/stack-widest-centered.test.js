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

// a 7tv-hosted twitch badge (Pichu) was wrapped as an emote, and the next emote in the row stacked onto it
test('a chat badge is never wrapped as an emote', () => {
  expect(css).toMatch(/img:not\(\.heatsync-emote\):not\(\.hs-cosmetic-badge\):not\(\.chat-badge\)/)
  expect(css).toMatch(/!n\.classList\.contains\('chat-badge'\)/)
})

// inline top/left/translate on an overlay beat the stack's grid centring and threw the overlay off the base
test('overlay wrappers carry no inline absolute offsets', () => {
  expect(css).not.toMatch(/top: 50%; left: 50%/)
  expect(css).not.toMatch(/translate\(-50%, -50%\)/)
})

// a name tagged in chat carries the person's saved heatsync paint, like their own name does
test("a mention is stamped for the tagged person's heatsync paint", () => {
  expect(css).toMatch(/el\.dataset\.hsCosmeticMention = uid\s*\/\/[^\n]*\n\s*stampHsNativePaint\(el, uid\)/)
})

// the overlay stacker collected the whole row, badges included, so a row whose first emote was an overlay stacked onto a badge
test('the overlay stacker skips chat badges', () => {
  expect(css).toMatch(/!_el\.classList\.contains\('chat-badge'\)/)
})

// a sent heatsync emote is drawn from a placeholder address for a moment; it must not show as a broken image
test('an image still on the placeholder address is hidden', () => {
  expect(css).toMatch(/img\[srcset\*="__FFZ__999999"\]\s*\{\s*visibility: hidden !important/)
})

// a keyword equal to your own name outlined every message you sent (the sender's name was part of the text tested)
test('keyword highlight tests the message without the sender name', () => {
  expect(css).toMatch(/\.chat-line__username-container, \.chat-author__display-name, button\.inline\.font-bold/)
})

// wollip's personal emote is named "wollip": the word was coloured as the chatter instead of drawn as the emote
test('a word that is an emote in the row is not coloured as a chatter', () => {
  expect(css).toMatch(/knownChatters\.has\(cleanWord\) && !emotes\?\.has\(word\.trim\(\)\)/)
  expect(css).toMatch(/colorUsernameMentions\(messageElement, textElements, allEmotes\)/)
})

// backfilled history rows are built from the IRC line and carried no badges at all
test('backfilled rows draw their badges from the badge sets', () => {
  expect(css).toMatch(/div\.dataset\.hsBadges = tags\.badges/)
  expect(css).toMatch(/function fillBackfillBadges\(\)/)
  expect(css).toMatch(/addEventListener\('hs-badges-loaded', fillBackfillBadges\)/)
})

// the badge stamp must sit in the IRC backfill loop (where `tags` exists), not the cache restore
test('the badge stamp is in the backfill loop', () => {
  const at = css.indexOf('div.dataset.hsBadges = tags.badges')
  expect(at).toBeGreaterThan(css.indexOf('async function backfillChatHistory'))
})

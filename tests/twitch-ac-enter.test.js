import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../chrome/autocomplete-hook.js', import.meta.url), 'utf8')

// Twitch accepts its open list on Enter: heatsync matches offered for plain typing made the first Enter
// swap the last word for an emote instead of sending
test('heatsync emote matches are only offered for a Tab press or a colon word', () => {
  expect(src).toMatch(/if \(!pressedTab && !actualInput\.startsWith\(':'\)\) return raw/)
})

// Twitch arms its emote list for every typed word while the provider can be tab-triggered, and the first Enter
// closes that empty list instead of sending: the flag is on only for the Tab press
test('the emote provider is tab-triggerable only while Tab is down', () => {
  expect(src).not.toMatch(/provider\.canBeTriggeredByTab = true/)
  expect(src).toMatch(/function armTabTrigger\(on\)/)
  expect(src).toMatch(/armTabTrigger\(true\)/)
  expect(src).toMatch(/armTabTrigger\(false\)/)
})

// with no list armed while typing, a word with a single match must complete on the first Tab
test('a lone match is inserted by the first Tab', () => {
  expect(src).toMatch(/const shouldCycle = cycleState\.matches\.length > 0 &&/)
})

// an empty array where twitch said "not mine" makes twitch show an empty list for every word
test('the provider hands twitch its own answer back when it adds nothing', () => {
  expect(src).toMatch(/const raw = origGetMatches\.call/)
  expect(src).toMatch(/if \(search\.length < 2\) return raw/)
})

// twitch sends 1x/2x/4x for an inserted emote; all three become one url, and the browser took the 4x entry
// and drew the 1x image at a quarter size (Kappa at 6x7 in the input)
test('a fixed srcset keeps one entry per url', () => {
  expect(src).toMatch(/if \(seen\.has\(f\)\) return ''/)
  expect(src).toMatch(/\.filter\(Boolean\)\s*\.join\(', '\)/)
})

// Kappa came out of the bridge under our fake id: its sent row drew the placeholder url (404) for ~700ms before a swap
test('a twitch emote from the bridge keeps its real id and is left out of the fake set', () => {
  expect(src).toMatch(/static-cdn\\\.jtvnw\\\.net\\\/emoticons\\\/v2/)
  expect(src).toMatch(/\.filter\(\(emote\) => !emote\.native\)/)
})

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../chrome/autocomplete-hook.js', import.meta.url), 'utf8')

// Twitch accepts its open list on Enter: heatsync matches offered for plain typing made the first Enter
// swap the last word for an emote instead of sending
test('heatsync emote matches are only offered for a Tab press or a colon word', () => {
  expect(src).toMatch(/if \(!pressedTab && !actualInput\.startsWith\(':'\)\) return results/)
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

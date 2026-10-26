import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../chrome/autocomplete-hook.js', import.meta.url), 'utf8')

// Twitch accepts its open list on Enter: heatsync matches offered for plain typing made the first Enter
// swap the last word for an emote instead of sending
test('heatsync emote matches are only offered for a Tab press or a colon word', () => {
  expect(src).toMatch(/if \(!pressedTab && !actualInput\.startsWith\(':'\)\) return results/)
})

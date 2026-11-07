import { afterEach, expect, test } from 'bun:test'
import { buildEmoteRefs, setCaseInsensitiveProbe } from '../src/lib/emote-refs.js'

// Rule 5: case is exact; only the user's own setting (injected as a probe) loosens it.
const map = new Map([
  ['kekw', { hash: 'h1', url: 'https://cdn.heatsync.org/e/1.webp', provider: 'inventory', name: 'kekw' }],
])
const keys = (word) => Object.keys(buildEmoteRefs(word, map, new Map()) || {})
afterEach(() => setCaseInsensitiveProbe(null))

test('KEKW does not send the ref of a different emote named kekw by default', () => {
  expect(keys('KEKW')).toEqual([])
})

test('the exact word still resolves', () => {
  expect(keys('kekw')).toEqual(['kekw'])
})

test('the probe (the site wires its setting here) opts back into lowercase matching', () => {
  setCaseInsensitiveProbe(() => true)
  expect(keys('KEKW')).toEqual(['KEKW'])
})

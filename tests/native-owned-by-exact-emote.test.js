import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// content.js is an IIFE (not importable); the browser run (scripts/render-emote-collisions-native.ts)
// is the behavior oracle, these pin the two rules it caught.
const src = readFileSync(new URL('../chrome/content.js', import.meta.url), 'utf8')

test('a native wrapper is "yours" only by the exact emote hash, never by name', () => {
  expect(src).not.toContain('inventoryNameSet')
  expect(src).toContain('const inInventory = inventoryHashSet.has(emote.hash)')
})

test('a late sender set re-opens plain wrappers of names the sender carries', () => {
  const m = src.match(/const reopenSenderWords = [\s\S]*?\n {4}}\n/)
  expect(m).toBeTruthy()
  expect(m[0]).toContain("w.closest('.heatsync-emote-stack')")
  expect(m[0]).toContain('w.dataset.emoteHash === mine.hash')
})

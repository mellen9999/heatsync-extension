import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { emojiPairs, emojiPairsSource } from '../scripts/lib/emoji-pairs.mjs'

const ROOT = new URL('..', import.meta.url).pathname

// EMOJI_DATA load-order + world-dedupe invariants. The multichat bundle builds
// _emojiMap at eval time behind a typeof guard, so if the emoji data hasn't
// run in the same isolated world FIRST, every emoji surface (dropdown, :name
// tab-complete, :name: send-time conversion) dies silently — no error, just
// gone. Two failure modes are locked down here:
//  1. cross-block ordering at the same run_at is NOT guaranteed → the data
//     file must sit BEFORE the bundle in the SAME content_scripts entry.
//  2. Chrome injects a given FILE once per frame across worlds → an ISOLATED
//     entry must never reference plain emoji-data.js (twitch's MAIN-world
//     registration wins the dedupe and the isolated copy is silently skipped;
//     that is exactly how 43f297b broke twitch emoji autocomplete). ISOLATED
//     entries use the build-emitted byte-identical emoji-data.iso.js instead.
for (const name of ['chrome.json', 'firefox.json']) {
  test(`${name}: multichat entries carry emoji-data.iso.js before the bundle`, () => {
    const m = JSON.parse(readFileSync(join(ROOT, 'src', 'manifests', name), 'utf8'))
    const bundleEntries = (m.content_scripts ?? []).filter((e) =>
      (e.js ?? []).some((f) => /^multichat-.*\.js$/.test(f)),
    )
    expect(bundleEntries.length).toBeGreaterThan(0)
    for (const entry of bundleEntries) {
      const emojiIdx = entry.js.indexOf('emoji-data.iso.js')
      const bundleIdx = entry.js.findIndex((f) => /^multichat-.*\.js$/.test(f))
      expect(emojiIdx).toBeGreaterThanOrEqual(0)
      expect(emojiIdx).toBeLessThan(bundleIdx)
    }
  })

  test(`${name}: kick-autocomplete-hook entry carries emoji-data.iso.js first`, () => {
    const m = JSON.parse(readFileSync(join(ROOT, 'src', 'manifests', name), 'utf8'))
    const hookEntries = (m.content_scripts ?? []).filter((e) => (e.js ?? []).includes('kick-autocomplete-hook.js'))
    expect(hookEntries.length).toBeGreaterThan(0)
    for (const entry of hookEntries) {
      const emojiIdx = entry.js.indexOf('emoji-data.iso.js')
      expect(emojiIdx).toBeGreaterThanOrEqual(0)
      expect(emojiIdx).toBeLessThan(entry.js.indexOf('kick-autocomplete-hook.js'))
    }
  })

  test(`${name}: no ISOLATED entry references plain emoji-data.js`, () => {
    const m = JSON.parse(readFileSync(join(ROOT, 'src', 'manifests', name), 'utf8'))
    for (const entry of m.content_scripts ?? []) {
      if (entry.world === 'MAIN') continue
      expect(entry.js ?? []).not.toContain('emoji-data.js')
    }
  })
}

// The page world's copy (twitch only). autocomplete-hook.js is the one script
// there that reads emoji data, and it reads [name, emoji] — so the page world
// loads emoji-data.main.js (generated pairs, about half the bytes) instead of
// parsing the full dataset a second time beside the isolated world's copy.
//  - the MAIN entry must carry the pairs file before the hook, never the full file
//  - an ISOLATED entry must never carry the pairs file (they read category etc.)
//  - the pairs are the dataset's own, row for row (one source, generated)
//  - the hook reads nothing but EMOJI_PAIRS
const DATA_SRC = readFileSync(join(ROOT, 'src', 'data', 'emoji-data.js'), 'utf8')

for (const name of ['chrome.json', 'firefox.json']) {
  test(`${name}: the page-world autocomplete hook loads the slim pairs, before itself`, () => {
    const m = JSON.parse(readFileSync(join(ROOT, 'src', 'manifests', name), 'utf8'))
    const entries = (m.content_scripts ?? []).filter((e) => (e.js ?? []).includes('autocomplete-hook.js'))
    expect(entries.length).toBe(1)
    const [entry] = entries
    expect(entry.world).toBe('MAIN')
    expect(entry.js.indexOf('emoji-data.main.js')).toBeGreaterThanOrEqual(0)
    expect(entry.js.indexOf('emoji-data.main.js')).toBeLessThan(entry.js.indexOf('autocomplete-hook.js'))
    expect(entry.js).not.toContain('emoji-data.js')
    expect(entry.js).not.toContain('emoji-data.iso.js')
  })

  test(`${name}: no ISOLATED entry carries the page-world pairs`, () => {
    const m = JSON.parse(readFileSync(join(ROOT, 'src', 'manifests', name), 'utf8'))
    for (const entry of m.content_scripts ?? []) {
      if (entry.world === 'MAIN') continue
      expect(entry.js ?? []).not.toContain('emoji-data.main.js')
    }
  })

  test(`${name}: the full dataset is only ever loaded once per world that reads it`, () => {
    const m = JSON.parse(readFileSync(join(ROOT, 'src', 'manifests', name), 'utf8'))
    const fullInMain = (m.content_scripts ?? []).filter(
      (e) => e.world === 'MAIN' && (e.js ?? []).some((f) => /^emoji-data(\.iso)?\.js$/.test(f)),
    )
    expect(fullInMain).toEqual([])
  })
}

test('emoji-data.main.js is the dataset, row for row, as [name, emoji]', () => {
  const full = runInNewContext(`${DATA_SRC}\n;EMOJI_DATA`)
  const pairs = runInNewContext(`${emojiPairsSource(DATA_SRC)}\n;EMOJI_PAIRS`)
  expect(pairs.length).toBe(full.length)
  expect(pairs.length).toBeGreaterThan(1000)
  for (let i = 0; i < full.length; i++) {
    expect(pairs[i][0]).toBe(full[i].name)
    expect(pairs[i][1]).toBe(full[i].emoji)
    expect(pairs[i].length).toBe(2)
  }
})

test('the two shipped copies are generated, never tracked — one source in src/data', () => {
  const ignored = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n')
  expect(ignored).toContain('chrome/emoji-data.iso.js')
  expect(ignored).toContain('chrome/emoji-data.main.js')
  const tracked = execFileSync(
    'git',
    ['ls-files', '--', 'chrome/emoji-data.js', 'chrome/emoji-data.iso.js', 'chrome/emoji-data.main.js'],
    { cwd: ROOT, encoding: 'utf8' },
  )
  expect(tracked.trim()).toBe('')
})

test('a malformed dataset fails the build instead of shipping a partial file', () => {
  expect(() => emojiPairs('var EMOJI_DATA = []')).toThrow(/full dataset/)
  const rows = Array.from({ length: 1200 }, (_, i) => ({ name: `n${i}`, emoji: 'x', category: 'c' }))
  rows[700] = { name: 'bad', emoji: '', category: 'c' }
  expect(() => emojiPairs(`var EMOJI_DATA = ${JSON.stringify(rows)}`)).toThrow(/row 700/)
})

test('autocomplete-hook.js reads nothing but EMOJI_PAIRS from the emoji data', () => {
  const hook = readFileSync(join(ROOT, 'src', 'content', 'autocomplete-hook.js'), 'utf8')
  expect(hook).not.toMatch(/EMOJI_DATA/)
  expect(hook).toMatch(/typeof EMOJI_PAIRS !== 'undefined' \? EMOJI_PAIRS : \[\]/)
})

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Rule 5 in search + Tab: KEKW and kekw are two candidates, the twin spelled like the typed word
// leads, dedupe is on the exact name, and only the prefix match stays case-insensitive.
const read = (...p) => readFileSync(join(import.meta.dir, '..', ...p), 'utf8')
const INPUT = read('src', 'multichat', 'input.js')
const a = INPUT.indexOf('function compareAcMatches(')
const b = INPUT.indexOf('function findEmoteMatches(')
const compare = new Function(`${INPUT.slice(a, b)}; return compareAcMatches`)()
const emote = (name, tier, extra = {}) => ({ name, tier, priority: 0, type: 'emote', ...extra })
const rank = (items, typed) =>
  [...items].sort((x, y) => compare(x, y, typed.toLowerCase(), new Map(), typed)).map((m) => m.name)

describe('multichat comparator', () => {
  test('the twin spelled like the typed word leads, whatever the tier', () => {
    expect(rank([emote('KEKW', 0), emote('kekw', 2)], 'kekw')).toEqual(['kekw', 'KEKW'])
    expect(rank([emote('kekw', 0), emote('KEKW', 2)], 'KEKW')).toEqual(['KEKW', 'kekw'])
  })
  test('neither spelled like it: both stay, channel leads', () => {
    expect(rank([emote('kekw', 2), emote('KEKW', 0)], 'KeKw')).toEqual(['KEKW', 'kekw'])
  })
})

describe('multichat catalog dedupe is on the exact name', () => {
  test('no lowercase key in the remote dedupe or the typed-name checks', () => {
    const f = INPUT.slice(
      INPUT.indexOf('const picsByName = new Map()'),
      INPUT.indexOf('function _acMergeRemoteMatches'),
    )
    expect(f).toContain('const l = m.name')
    expect(f).toContain('const lower = it.name')
    expect(f).toContain("(m.name || '') === search")
    expect(f).not.toContain('const lower = it.name.toLowerCase()')
  })
})

describe('native bridges', () => {
  test('twitch hook ranks the spelled twin first, among exacts', () => {
    const s = read('chrome', 'autocomplete-hook.js')
    expect(s).toContain('r._spelled = name === search')
    expect(s).toContain('if (a._exact && a._spelled !== b._spelled) return a._spelled ? -1 : 1')
  })
  test('twitch remote merge orders the typed spelling before a case twin', () => {
    expect(read('chrome', 'autocomplete-hook.js')).toContain("(a.name || '') === search ? 0")
  })
  test('kick hook ranks the spelled twin first and dedupes on the exact name', () => {
    const s = read('chrome', 'kick-autocomplete-hook.js')
    expect(s).toContain('(a.name === query) !== (b.name === query)')
    expect(s).toContain('if (seen.has(e.name)) continue')
  })
})

describe('picker search', () => {
  test('fuzzyScore puts the twin spelled as typed above its case twin', () => {
    const s = read('chrome', 'heatsync-button.js')
    const m = s.match(/function fuzzyScore\(query, name\) \{[\s\S]*?\n {4}\}\n/)
    const score = new Function('searchTyped', `${m[0]}; return fuzzyScore`)('kekw')
    expect(score('kekw', 'kekw')).toBeGreaterThan(score('kekw', 'KEKW'))
    expect(score('kekw', 'KEKW')).toBeGreaterThan(0)
  })
})

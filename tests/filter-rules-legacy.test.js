import { beforeEach, expect, test } from 'bun:test'
import { SETTINGS } from '../src/lib/settings-schema.js'
import { RETIRED_UI_KEYS } from '../src/lib/utils.js'
import { compileFilterRules, evaluateFilterRules } from '../src/multichat/filter-rules.js'
import { legacyFilterRules, mergeFilterRules } from '../src/multichat/filter-rules-legacy.js'
import { mainSource } from './main-src.js'

// Four old text filters (automod patterns, automod all-caps, muted words,
// highlight words) fold into chatFilterRules, once, on load. The engine is
// unchanged: each old filter becomes ordinary rules, and these tests run them
// through the real engine against what the old filter did.
const msg = (text) => ({ text, user: 'someone', badges: '', platform: 'twitch' })
const verdict = (rules, text) => {
  compileFilterRules(rules)
  return evaluateFilterRules(msg(text), null)
}
beforeEach(() => compileFilterRules([]))

test('automod patterns hide, case-insensitively, one rule per line', () => {
  const rules = legacyFilterRules({ automodRegex: 'bad(word)?\n\n  spam  ' })
  expect(rules).toHaveLength(2)
  expect(verdict(rules, 'a BADWORD here').hide).toBe(true)
  expect(verdict(rules, 'SPAM').hide).toBe(true)
  expect(verdict(rules, 'clean').hide).toBe(false)
})

test('automod all-caps hides shouting, never lower case or short caps', () => {
  const rules = legacyFilterRules({ automodAllCaps: true })
  expect(rules).toHaveLength(1)
  expect(verdict(rules, 'THIS IS VERY LOUD').hide).toBe(true)
  expect(verdict(rules, 'WHAT!!! NO WAY 123').hide).toBe(true)
  expect(verdict(rules, 'this is very loud').hide).toBe(false)
  expect(verdict(rules, 'OK LOL').hide).toBe(false)
  expect(verdict(rules, 'LOUD BUT ONE word').hide).toBe(false)
  expect(legacyFilterRules({ automodAllCaps: false })).toEqual([])
})

test('the all-caps rule cannot backtrack — a long near-miss settles at once', () => {
  compileFilterRules(legacyFilterRules({ automodAllCaps: true }))
  const t0 = performance.now()
  evaluateFilterRules(msg(`${'A '.repeat(120)}a`), null)
  expect(performance.now() - t0).toBeLessThan(50)
})

test('muted words hide anywhere in a message, matched literally', () => {
  const rules = legacyFilterRules({ muteKeywords: 'spoiler\na.b' })
  expect(verdict(rules, 'no SPOILERS please').hide).toBe(true)
  expect(verdict(rules, 'a.b').hide).toBe(true)
  expect(verdict(rules, 'axb').hide).toBe(false)
})

test('highlight words highlight whole words in the mention colour', () => {
  const rules = legacyFilterRules({ keywordHighlights: 'pog\nmellen' })
  expect(verdict(rules, 'that was POG').highlight).toBe('#ffff00')
  expect(verdict(rules, 'pogchamp').highlight).toBeNull()
  expect(verdict(rules, 'pogchamp').hide).toBe(false)
})

test('highlight words split on commas too, as the site documented them; patterns and muted words do not', () => {
  const hl = legacyFilterRules({ keywordHighlights: 'foo, bar\nbaz,,' })
  expect(hl.map((r) => r.match.value)).toEqual(['\\bfoo\\b', '\\bbar\\b', '\\bbaz\\b'])
  expect(verdict(hl, 'say bar now').highlight).toBe('#ffff00')
  const rx = legacyFilterRules({ automodRegex: 'a{1,3}b', muteKeywords: 'x, y' })
  expect(rx.map((r) => r.match.value)).toEqual(['a{1,3}b', 'x, y'])
})

test('every rule is well-formed with a unique id', () => {
  const rules = legacyFilterRules({
    automodRegex: 'x',
    automodAllCaps: true,
    muteKeywords: 'y',
    keywordHighlights: 'z',
  })
  expect(rules).toHaveLength(4)
  expect(new Set(rules.map((r) => r.id)).size).toBe(4)
  for (const r of rules) {
    expect(r.enabled).toBe(true)
    expect(r.scope).toBe('all')
  }
  expect(legacyFilterRules({})).toEqual([])
  expect(legacyFilterRules({ automodRegex: 42, muteKeywords: null })).toEqual([])
})

test('merging twice adds nothing the second time', () => {
  const existing = [{ id: 'mine', enabled: true, action: 'hide', scope: 'all', match: { type: 'keyword', value: 'k' } }]
  const added = legacyFilterRules({ muteKeywords: 'spoiler' })
  const once = mergeFilterRules(existing, added)
  expect(once).toHaveLength(2)
  expect(once[0]).toBe(existing[0])
  expect(mergeFilterRules(once, legacyFilterRules({ muteKeywords: 'spoiler' }))).toHaveLength(2)
})

test('the four filters are gone from the registry and retired', () => {
  for (const k of ['automodRegex', 'automodAllCaps', 'keywordHighlights', 'hs_mute_keywords'])
    expect(SETTINGS.some((d) => d.key === k)).toBe(false)
  for (const k of ['automodRegex', 'automodAllCaps', 'keywordHighlights']) expect(RETIRED_UI_KEYS.has(k)).toBe(true)
})

test('the fold runs after the boot seed, writes the rules before it lets go of the old values', () => {
  const main = mainSource()
  const fn = main.slice(main.indexOf('async function retireSettings('), main.indexOf('// Registry-derived reset'))
  const write = fn.indexOf('await browser.storage.local.set({ chat_filter_rules: json })')
  const drop = fn.indexOf("browser.storage.local.remove(['hs_mute_keywords', 'keyword_highlights'")
  expect(write).toBeGreaterThan(-1)
  expect(drop).toBeGreaterThan(write)
  expect(main).not.toMatch(/shouldAutomod|compileAutomod|_muteKeywordsRegex|keywordHighlightsRegex/)
})

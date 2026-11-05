import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const rd = (f) => readFileSync(new URL(`../src/multichat/${f}`, import.meta.url), 'utf8')
const { hsEmojiFilter } = new Function(`${rd('emoji-tab.js')}\nreturn { hsEmojiFilter }`)()
const DATA = [
  { name: 'smile', emoji: '😄', category: 'smileys' },
  { name: 'smirk', emoji: '😏', category: 'smileys' },
  { name: 'cat', emoji: '🐱', category: 'animals' },
]

describe('emoji tab', () => {
  test('filters by name substring and category', () => {
    expect(hsEmojiFilter(DATA, 'smi', '').map((e) => e.name)).toEqual(['smile', 'smirk'])
    expect(hsEmojiFilter(DATA, '', 'animals').map((e) => e.name)).toEqual(['cat'])
    expect(hsEmojiFilter(DATA, 'SMILE', 'smileys').length).toBe(1)
    expect(hsEmojiFilter(DATA, 'zzz', '')).toEqual([])
  })
  test('bad data is empty; results are capped', () => {
    expect(hsEmojiFilter(null, 'a', '')).toEqual([])
    const big = Array.from({ length: 500 }, (_, i) => ({ name: `e${i}`, emoji: 'x', category: 'c' }))
    expect(hsEmojiFilter(big, '', '').length).toBe(200)
  })
  test('wired into the picker: tab entry, markup, show, wire', () => {
    const em = rd('emotes.js')
    expect(em).toContain("{ id: 'emoji', labelKey: 'mc_emo_tab_emoji' }")
    expect(em).toContain('hsEmojiTabHtml()')
    expect(em).toContain('hsWireEmojiTab(picker)')
    expect((em.match(/hsOnEmojiTabShown\(\)/g) || []).length).toBe(3)
  })
  test('built only with escaped markup: no raw data in the html string', () => {
    expect(rd('emoji-tab.js')).not.toMatch(/innerHTML\s*=/)
  })
})

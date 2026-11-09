/**
 * Every name surface that draws the plus mark draws the picked heatsync badge
 * the same way: chat row, feed quote, reply header all go through hsNameMarksHtml
 * (carved from main-messages.js, which has top-level side effects).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../src/multichat/main-messages.js', import.meta.url), 'utf8')
const from = SRC.indexOf('function hsNameMarksHtml(')
const marks = new Function(
  'renderPlusTenureToken',
  'renderHsBadgeToken',
  `${SRC.slice(from, SRC.indexOf('\n}', from) + 2)}\nreturn hsNameMarksHtml`,
)(
  (s) => `<plus ${s}>`,
  (id) => (id ? `<badge ${id}>` : ''),
)

describe('hsNameMarksHtml', () => {
  test('plus then badge', () => expect(marks(5, 'founder')).toBe('<plus 5><badge founder>'))
  test('badge alone when no plus', () => expect(marks(0, 'founder')).toBe('<badge founder>'))
  test('plus alone when no badge', () => expect(marks(5, null)).toBe('<plus 5>'))
  test('nothing for neither', () => expect(marks(null, null)).toBe(''))
})

describe('every plus-mark surface uses it', () => {
  test('chat row, feed quote and reply header', () => {
    expect(SRC.match(/hsNameMarksHtml\(/g).length).toBe(4)
    expect(SRC).toContain('hsNameMarksHtml(feedSince')
    expect(SRC).toContain('hsNameMarksHtml(replySince')
    expect(SRC).toContain('hsNameMarksHtml(since')
  })
})

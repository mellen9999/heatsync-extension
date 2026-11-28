// The one rule, finished: a name with no colour of its own is the palette colour on every surface that
// used to fall back to white: an @mention (emotes.js + mentionColor), a whisper or dm name.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hsRowNameColour, hsUsernameColor } from '../src/multichat/paints.js'
import { mainSource } from './main-src.js'

const read = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')

describe('@mention colour', () => {
  const m = mainSource()
  const a = m.indexOf('function mentionColor(lower) {')
  const body = m.slice(a, m.indexOf('\n}\n', a) + 3)
  const mk = (known, cache) =>
    new Function(
      'knownColors',
      '_hsUserColorCache',
      'sanitizeColor',
      'resolveMentionColor',
      'hsRowNameColour',
      `${body}\nreturn mentionColor`,
    )(
      new Map(known),
      new Map(cache),
      (c) => c,
      () => {},
      hsRowNameColour,
    )
  test('an unknown name is its palette colour while the lookup runs, not white', () => {
    expect(mk([], [])('someone')).toBe(hsUsernameColor('someone'))
  })
  test('a heard colour still wins, and so does a looked-up one', () => {
    expect(mk([['someone', '#123456']], [])('someone')).toBe('#123456')
    expect(mk([], [['someone', '#654321']])('someone')).toBe('#654321')
  })
  test('emotes.js asks mentionColor, never a white of its own', () => {
    expect(read('emotes.js')).not.toContain("knownColors.get(name) || '#fff'")
  })
})

describe('whispers and dms', () => {
  const w = read('whispers.js')
  test('an absent colour is stored as none, not as white', () => {
    expect(w).not.toMatch(/(conv|m)\.color \|\| '#fff'/)
    expect(w).not.toMatch(/data\.from_color \|\| '#fff'/)
    expect(w).not.toContain("dm.user_color || '#fff'")
  })
  test('the row hands the name ladder "unknown", so it reaches the palette', () => {
    expect(w).toContain(
      'const theirColor = (target ? target.color : m.color) ? sanitizeColor(target ? target.color : m.color) : undefined',
    )
  })
})

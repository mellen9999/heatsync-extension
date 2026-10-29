import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (f) => readFileSync(new URL(`../src/multichat/styles/${f}`, import.meta.url), 'utf8')

describe('emote picker section header', () => {
  test('sticks above the emotes it scrolls over', () => {
    const css = read('13-platform-filter-picker.css')
    const hdr = Number(css.match(/\.hs-mc-picker-section-header \{[^}]*?z-index: (\d+)/s)[1])
    // emote wrappers sit at z-index 1 and their imgs at 2
    expect(hdr).toBeGreaterThan(2)
  })
})

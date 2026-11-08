// The attach button is the same "+" text glyph on every heatsync chat surface
// (site tile + popout, heatsync-chat, the extension). It was an svg picture
// here only — icons are unicode text, never svg.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/multichat/input.js', import.meta.url), 'utf8')

describe('attach button', () => {
  it('is a "+" glyph, not an svg', () => {
    const btn = src.match(/<button id="hs-mc-attach-btn"[^>]*>([\s\S]*?)<\/button>/)?.[1]
    expect(btn).toBe('+')
  })
})

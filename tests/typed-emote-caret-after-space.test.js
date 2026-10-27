import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// Typing "bro " converts the word to an emote chip and leaves a space after it.
// Tab completion puts the caret AFTER that space; the typed path used to put it
// before, so the next word was typed flush against the emote.
const src = readFileSync(new URL('../src/multichat/input.js', import.meta.url), 'utf8')

describe('typed emote conversion', () => {
  test('the caret lands after the synthesized space, never before it', () => {
    expect(src).toContain('newRange.setStart(afterNode, afterText ? 0 : afterNode.length)')
    expect(src.match(/newRange\.setStart\(node, afterText \? 0 : node\.textContent\.length\)/g)?.length).toBe(2)
  })

  test('no typed-emote path parks the caret at 0 of a node it just filled with a space', () => {
    expect(src).not.toMatch(
      /node\.textContent = afterText \|\| ' '\s+const newRange = document\.createRange\(\)\s+newRange\.setStart\(node, 0\)/,
    )
  })
})

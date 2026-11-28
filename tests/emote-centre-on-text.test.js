// "the emotes are a bit off center of the line": every picture in a chat row centres on the text,
// at any height (parity with heatsync.org's --hs-eh rule). A bottom-resting box (`text-bottom`,
// which this file used "for crisp text") sat a 36px emote's centre ~11px above the username; `middle`
// is fractional (half an x-height) and smears the bitmap font. The crisp, centred answer is a
// whole-pixel length derived from the box's own height. Measured in a real browser by
// scripts/render-emote-centre.ts; this guard keeps the rule from being reverted.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CSS = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'styles', '10-emotes.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)
const ruleFor = (selector) => {
  const i = CSS.indexOf(`${selector} {`)
  if (i === -1) throw new Error(`rule not found: ${selector}`)
  return CSS.slice(i, CSS.indexOf('}', i))
}
const CENTRED = /vertical-align:\s*round\(nearest,\s*calc\(var\(--hs-ct\)[^;]*,\s*1px\)/

describe('a chat row centres every picture on its text', () => {
  for (const sel of [
    '.hs-mc-msg .hs-mc-emote-wrapper',
    '.hs-mc-msg :not(.hs-mc-emote-wrapper) > img.hs-mc-emote',
    '.hs-mc-msg .hs-mc-emote-stack',
    '.hs-mc-msg .hs-mc-emoji',
  ]) {
    test(`${sel} is a whole-pixel length from the text centre`, () => {
      const rule = ruleFor(sel)
      expect(rule).toMatch(CENTRED)
      expect(rule).not.toMatch(/vertical-align:\s*(text-bottom|middle|bottom|top|baseline)/)
    })
  }

  test('the box height and the text centre are derived, not constants', () => {
    const root = ruleFor('.hs-mc-msg')
    // the picture's own box: the emote size x a big line's scale, plus the img's 2+2px of padding
    expect(root).toMatch(/--hs-eh:\s*calc\(var\(--hs-emote-size, 32px\) \* var\(--hs-big, 1\) \+ 4px\)/)
    // the glyphs' middle tracks the chat font size (a 10..26px setting), not one number
    expect(root).toMatch(/--hs-ct:\s*calc\(var\(--hs-chat-font, 15px\) \* 0\.\d+\)/)
  })

  test('a stack is as tall as the picture under it, so its bottom edge is the baseline', () => {
    expect(ruleFor('.hs-mc-msg .hs-mc-emote-stack:not(.expanded)')).toMatch(/height:\s*var\(--hs-eh\)/)
  })

  test('the wrapper reserves the same box the alignment is computed from', () => {
    expect(ruleFor('.hs-mc-msg .hs-mc-emote-wrapper')).toMatch(/min-height:\s*var\(--hs-eh\)/)
  })
})

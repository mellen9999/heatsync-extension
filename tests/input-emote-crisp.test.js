// "after an emote, text in the input box is blurry and not bitmap."
//
// Cozette is a bitmap font: it only rasterises crisply when glyphs land on
// whole pixels. An inline emote breaks that two ways, and the composer chips
// had BOTH while chat rows had already been fixed for both:
//   vertical  — vertical-align:middle anchors at baseline + xHeight/2, and
//               Cozette's 13px x-height halves to 3.546875px → half-pixel
//               baseline for every adjacent glyph
//   horizontal— a non-square emote scaled to row height has a FRACTIONAL
//               width, so every character after it starts at a fractional x
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const CSS = readFileSync(join(ROOT, 'src', 'multichat', 'styles', '11-input-composer.css'), 'utf8')
const EMOTES = readFileSync(join(ROOT, 'src', 'multichat', 'emotes.js'), 'utf8')

// Comments in this file contain braces (e.g. "img{display:block}"), so slicing
// to the first '}' lands mid-comment and truncates the rule. Strip comments first.
const CSS_NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
function ruleFor(selector) {
  const i = CSS_NO_COMMENTS.indexOf(selector)
  if (i === -1) throw new Error(`selector not found: ${selector}`)
  return CSS_NO_COMMENTS.slice(i, CSS_NO_COMMENTS.indexOf('}', i))
}

describe('vertical: the chip must not sit on a half-pixel baseline', () => {
  const rule = ruleFor('#hs-mc-input .hs-input-emote {')

  test('uses text-bottom', () => {
    expect(rule).toMatch(/vertical-align:\s*text-bottom/)
  })

  // middle is the documented smear cause; bottom anchors to the line box, which
  // sibling badges can place fractionally. Only text-bottom is immune.
  test('is not middle or bottom', () => {
    expect(rule).not.toMatch(/vertical-align:\s*middle/)
    expect(rule).not.toMatch(/vertical-align:\s*bottom\s*;/)
  })
})

describe('horizontal: the chip must occupy a whole number of pixels', () => {
  const INPUT = readFileSync(join(ROOT, 'src', 'multichat', 'input.js'), 'utf8')

  test('the shared helper snaps on load AND when already cached', () => {
    const fn = EMOTES.slice(
      EMOTES.indexOf('function hsAttachInputEmoteSnap'),
      EMOTES.indexOf('\n}', EMOTES.indexOf('function hsAttachInputEmoteSnap')),
    )
    expect(fn).toContain("addEventListener('load'")
    expect(fn).toContain('hsSnapEmoteBox(img)')
    // a cached image fires no load event — that path stayed blurry until covered
    expect(fn).toMatch(/img\.complete && img\.naturalWidth/)
  })

  // Hooking ONE path is exactly how this shipped half-fixed: a chip creator
  // that skips the snap smears while the others come out crisp. createInputEmoteImg
  // is now the SINGLE named builder — the recall/imagify path routes through it
  // too (buildInputEmoteImg, a snap-less duplicate that also stamped "undefined"
  // chips from pool entries with no .name field, was deleted).
  test('EVERY chip-creation site attaches the snap', () => {
    for (const [label, src, fnName] of [['emotes.js createInputEmoteImg', EMOTES, 'createInputEmoteImg']]) {
      const start = src.indexOf(`function ${fnName}`)
      const body = src.slice(start, src.indexOf('\n}', start))
      expect(body, label).toContain('hsAttachInputEmoteSnap')
    }
    // a Tab step's chip has one builder (cyclingImg, inside insertCompletionKeepOpen) and the three
    // places a step lands (over a text span, over a user chip, fresh) all draw through it: the snap is
    // attached once, there. The typing/recall path shares createInputEmoteImg. The counts are the
    // drift guard: a fourth inline creator, or a builder that lost its snap, fails here.
    const builder = INPUT.slice(INPUT.indexOf('const cyclingImg = () => {'))
    expect(builder.slice(0, builder.indexOf('return img'))).toContain('hsAttachInputEmoteSnap(img)')
    expect((INPUT.match(/hs-input-emote hs-cycling-emote/g) || []).length).toBe(1)
    expect((INPUT.match(/hsAttachInputEmoteSnap\(img\)/g) || []).length).toBe(1)
    expect((INPUT.match(/const img = cyclingImg\(\)/g) || []).length).toBe(3)
  })

  test('the snapper accepts a bare input chip', () => {
    const guard = EMOTES.slice(EMOTES.indexOf('function hsSnapEmoteBox'), EMOTES.indexOf('_hsSnapQueue.add'))
    expect(guard).toContain('hs-input-emote')
  })

  test('a chip with no wrapper snaps its own box', () => {
    const body = EMOTES.slice(
      EMOTES.indexOf('function hsSnapEmoteBox'),
      EMOTES.indexOf('function hsSnapEmoteBox') + 3000,
    )
    expect(body).toMatch(/hs-input-emote'\)\s*\?\s*im\s*:\s*null/)
  })

  test('the width pinned is offsetWidth (an integer), not a fractional rect', () => {
    const body = EMOTES.slice(
      EMOTES.indexOf('function hsSnapEmoteBox'),
      EMOTES.indexOf('function hsSnapEmoteBox') + 4000,
    )
    expect(body).toContain('it.box.offsetWidth')
    expect(body).not.toContain('getBoundingClientRect().width')
  })
})

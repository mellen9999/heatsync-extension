/**
 * Stale Tab-cycle + overlay-precedence guards (src/multichat/input.js).
 *
 * Regression anchor: "tab complete on 2nd emote erases the previous word."
 * Two roots, both fixed and pinned here:
 *
 * 1. caretOnActiveCompletion — a mouse click moves the caret without firing
 *    the keydown/input cycle-teardown, so the next Tab still saw
 *    acState.active and rewrote the OLD completion: wysiwyg cycles the
 *    .hs-cycling-* chip found anywhere in the input; plain mode rebuilds the
 *    whole value from stale wordStart/afterText, erasing everything typed
 *    since. The Tab handler now finalizes the cycle when the caret left the
 *    completion. (Plain-mode arm tested here; the wysiwyg arm is DOM-bound.)
 *
 * 2. completionWantsOverlay — the old formula (lookup-by-name OR match flag)
 *    let a name collision across providers mark a non-overlay pick as
 *    zero-width and stack it onto the preceding emote chip, visually
 *    swallowing it. The match's own flag now wins; lookup is only a fallback
 *    for matches that carry no flag.
 *
 * Carved out of the non-module content-script bundle and evaluated standalone
 * (same rationale as tab-complete-order.test.js's compareAcMatches carve).
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const INPUT_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')

const carve = (startMarker, endMarker) => {
  const start = INPUT_SRC.indexOf(startMarker)
  const end = INPUT_SRC.indexOf(endMarker)
  if (start === -1 || end === -1 || end <= start) throw new Error(`carve markers not found: ${startMarker}`)
  return INPUT_SRC.slice(start, end)
}

// --- caretOnActiveCompletion (plain-input arm; wysiwygEnabled stubbed false) ---
const caretSrc = carve('function caretOnActiveCompletion(', 'function mergeChipIntoWordForRecompletion(')
const makeCaretFn = (acState) =>
  new Function('wysiwygEnabled', 'acState', `${caretSrc}; return caretOnActiveCompletion`)(false, acState)

// --- completionWantsOverlay (pure; asset-recovery injectable) ---
const overlaySrc = carve('function completionWantsOverlay(', 'function insertCompletionWysiwyg(')
const makeOverlayFn = (assetRecovery) =>
  new Function('zeroWidthForSameAsset', `${overlaySrc}; return completionWantsOverlay`)(assetRecovery)
const completionWantsOverlay = makeOverlayFn(undefined)

describe('caretOnActiveCompletion — plain input, completion "Kappa" at wordStart 6', () => {
  // "hello Kappa …" → completion occupies [6, 11], auto-space at 11, caret lands at 12
  const acState = { matches: [{ name: 'Kappa', type: 'emote' }], index: 0, wordStart: 6 }
  const fn = makeCaretFn(acState)
  const input = (pos) => ({ isContentEditable: false, selectionStart: pos })

  test('caret right after the auto-space (where insert leaves it) → still cycling', () => {
    expect(fn(input(12))).toBe(true)
  })

  test('caret inside the completed word → still cycling', () => {
    expect(fn(input(8))).toBe(true)
  })

  test('caret at word start → still cycling', () => {
    expect(fn(input(6))).toBe(true)
  })

  test('caret clicked back before the word → abandoned', () => {
    expect(fn(input(3))).toBe(false)
  })

  test('caret clicked past the completion (typing elsewhere) → abandoned', () => {
    expect(fn(input(20))).toBe(false)
  })

  test('no input → not cycling', () => {
    expect(fn(null)).toBe(false)
  })

  test('input without a selection api → not cycling', () => {
    expect(fn({ isContentEditable: false })).toBe(false)
  })
})

describe('completionWantsOverlay — the match flag beats the name lookup', () => {
  test('non-overlay pick + colliding overlay name in lookup → NOT stacked (the bug)', () => {
    expect(completionWantsOverlay({ zeroWidth: false }, { isOverlay: true })).toBe(false)
  })

  test('overlay pick stays overlay even when lookup misses', () => {
    expect(completionWantsOverlay({ zeroWidth: true }, null)).toBe(true)
  })

  test('synth "name0" match is an overlay by construction', () => {
    expect(completionWantsOverlay({ _synthOverlay: true }, null)).toBe(true)
  })

  test('flagless match falls back to lookup', () => {
    expect(completionWantsOverlay({}, { isOverlay: true })).toBe(true)
    expect(completionWantsOverlay({}, { isOverlay: false })).toBe(false)
    expect(completionWantsOverlay({}, null)).toBe(false)
  })

  test('owned copy with STRIPPED flag + same-asset recovery → overlay (regression: owned "microwave")', () => {
    // HS-inventory copies lose 7TV's zeroWidth flag; the flagged channel/global
    // entry shares the same provider asset id → flag recoverable.
    const fn = makeOverlayFn((name, url) => name === 'microwave' && url === 'https://cdn.7tv.app/emote/AB/1x.avif')
    expect(fn({ name: 'microwave', url: 'https://cdn.7tv.app/emote/AB/1x.avif', zeroWidth: false }, null)).toBe(true)
  })

  test('same NAME, different asset (collision) → NOT stacked even with recovery wired', () => {
    const fn = makeOverlayFn((_name, url) => url === 'https://cdn.7tv.app/emote/AB/1x.avif')
    expect(
      fn({ name: 'microwave', url: 'https://cdn.7tv.app/emote/ZZ/1x.avif', zeroWidth: false }, { isOverlay: true }),
    ).toBe(false)
  })
})

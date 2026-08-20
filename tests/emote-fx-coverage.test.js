/**
 * End-to-end coverage for the BTTV/FFZ emote-modifier token set.
 *
 * tests/modifiers.test.js proves the LIBRARY maps each token to an effect name.
 * This file proves every one of those effects actually LANDS: a compose result
 * that isn't a no-op, a keyframes block + img rule for each animated effect, a
 * suffix list derived (not hand-listed) from the token table, and — the
 * regression this file was born from — that animated effects are NOT gated on
 * prefers-reduced-motion.
 *
 * The bug: chromium run with --force-prefers-reduced-motion matched
 * `@media (prefers-reduced-motion: reduce) { img[class*="hs-fx-"] { animation:
 * none !important } }`, so ffzLeave/ffzSpin/ffzJam/p!/s! and every other
 * animated modifier silently did nothing while w!/h!/c! worked fine, with no
 * setting anywhere that could turn them back on. Emote motion belongs to the
 * animateEmotes setting (always | hover | never), same as animated gif emotes.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HS_MOD_CLASS_TO_TOKEN, HS_MOD_TOKENS, hsModClassify, hsModComposeAll } from '../src/lib/modifiers.js'

const ROOT = join(import.meta.dir, '..')
const CSS = readFileSync(join(ROOT, 'src', 'multichat', 'styles', '10-emotes.css'), 'utf8')
const EMOTES_JS = readFileSync(join(ROOT, 'src', 'multichat', 'emotes.js'), 'utf8')
const MAIN_JS = readFileSync(join(ROOT, 'src', 'multichat', 'main.js'), 'utf8')

// The public contract — every token a user can type. Hard-coded on purpose:
// deriving it from HS_MOD_TOKENS would make a deleted token pass silently.
const PUBLIC_TOKENS = [
  'c!',
  'h!',
  'l!',
  'r!',
  'v!',
  'z!',
  'w!',
  'p!',
  's!',
  'x!',
  'y!',
  'ffzHyper',
  'ffzRainbow',
  'ffzBounce',
  'ffzJam',
  'ffzSlide',
  'ffzLeave',
  'ffzArrive',
  'ffzSpin',
  'ffzW',
  'ffzX',
  'ffzY',
  'ffzCursed',
]

describe('every public modifier token resolves to a real effect', () => {
  for (const tok of PUBLIC_TOKENS) {
    test(`${tok} classifies as a modifier`, () => {
      expect(hsModClassify(tok, { allowPrefix: false }).kind).toBe('modifier')
    })
    test(`${tok} composes to something visible`, () => {
      const { mods } = hsModClassify(tok, { allowPrefix: false })
      const c = hsModComposeAll(mods, null)
      const isNoop = c.sx === 1 && c.sy === 1 && !c.rotate && !c.filter && !c.anims.length && !c.zero
      expect(isNoop).toBe(false)
    })
    test(`${tok} round-trips back to a wire token`, () => {
      const { mods } = hsModClassify(tok, { allowPrefix: false })
      for (const m of mods) expect(HS_MOD_CLASS_TO_TOKEN[m]).toBeTruthy()
    })
  }
})

describe('animated effects have CSS', () => {
  const animated = [
    ...new Set(Object.keys(HS_MOD_TOKENS).flatMap((tok) => hsModComposeAll([HS_MOD_TOKENS[tok]], null).anims)),
  ]

  test('every animated FFZ/BTTV effect is represented', () => {
    // hyper/party/shake ride BTTV tokens; the rest are the ffz* effect emotes.
    expect(animated.sort()).toEqual(
      ['arrive', 'bounce', 'hyper', 'jam', 'leave', 'party', 'rainbow', 'shake', 'slide', 'spin'].sort(),
    )
  })

  for (const a of ['arrive', 'bounce', 'hyper', 'jam', 'leave', 'party', 'rainbow', 'shake', 'slide', 'spin']) {
    test(`hs-fx-${a} has a keyframes block`, () => {
      expect(CSS).toContain(`@keyframes hs-fx-${a}`)
    })
    test(`hs-fx-${a} is wired for BOTH an emote img and an emoji span`, () => {
      // An emoji is a <span class="hs-mc-emoji">, not an <img>. These rules were
      // tag-scoped to img, so an emoji could carry the effect class and never
      // match anything: the static half of a modifier applied and the animated
      // half silently did nothing. Both selectors are required, and the img one
      // keeps its specificity rather than being widened away.
      const rule = new RegExp(`([^{}]*)\\bhs-fx-${a}\\s*\\{[^}]*animation:\\s*hs-fx-${a}\\b`)
      const m = CSS.match(rule)
      expect(m, `no rule wires hs-fx-${a} to its keyframes`).toBeTruthy()
      const selector = m[0].split('{')[0]
      expect(selector, 'emote imgs must still match').toContain(`img.hs-fx-${a}`)
      expect(selector, 'a modified emoji span must match too').toContain(`.hs-mc-emoji.hs-fx-${a}`)
    })
  }
})

describe('animated effects are gated on animateEmotes, not the OS motion flag', () => {
  test('no prefers-reduced-motion rule kills hs-fx animations', () => {
    // Anchor for the --force-prefers-reduced-motion blackout. Emote motion is
    // content; the animateEmotes setting is the only control that may stop it.
    const rm = CSS.match(/@media[^{]*prefers-reduced-motion[^{]*\{[\s\S]*?\}\s*\}/g) || []
    for (const block of rm) expect(block).not.toContain('hs-fx-')
  })

  test('never mode stops fx animations', () => {
    expect(CSS).toMatch(/html\[data-hs-emote-anim="never"\][^{]*img\[class\*="hs-fx-"\][^}]*animation:\s*none/)
  })

  test('hover mode pauses fx in rows and runs them under the pointer', () => {
    expect(CSS).toMatch(/html\[data-hs-emote-anim="hover"\] \.hs-mc-msg img[^{]*\{[^}]*paused/)
    expect(CSS).toMatch(/html\[data-hs-emote-anim="hover"\] \.hs-mc-msg:hover img[^{]*\{[^}]*running/)
  })

  test('the schema runs the applier on the boot pass', () => {
    // Without applyOnLoad the attribute only appeared after the user touched the
    // setting, so hover/never silently behaved like always on a fresh load.
    const SCHEMA = readFileSync(join(ROOT, 'src', 'lib', 'settings-schema.js'), 'utf8')
    const entry = SCHEMA.slice(SCHEMA.indexOf("key: 'animateEmotes'"))
    const body = entry.slice(0, entry.indexOf('\n  },'))
    expect(body).toContain("apply: 'emoteAnimation'")
    expect(body).toContain('applyOnLoad: true')
  })

  test('main.js stamps the mode on <html> (including on load)', () => {
    const apply = MAIN_JS.slice(MAIN_JS.indexOf('emoteAnimation: ('))
    const body = apply.slice(0, apply.indexOf('\n    },'))
    expect(body).toContain('documentElement.dataset.hsEmoteAnim')
    // must be set BEFORE the onLoad early-return, or a fresh boot stays unset
    expect(body.indexOf('hsEmoteAnim')).toBeLessThan(body.indexOf('if (onLoad) return'))
  })
})

test('inline modifier suffixes are derived from the token table, never hand-listed', () => {
  // A hand-written copy drifted and lost r!/p!/s!/ffzW and all animated ffz*,
  // so "KappaffzLeave" (space eaten upstream) resolved to nothing.
  expect(EMOTES_JS).toMatch(/const HS_INLINE_MOD_SUFFIXES = Object\.keys\(HS_MOD_TOKENS\)/)
})

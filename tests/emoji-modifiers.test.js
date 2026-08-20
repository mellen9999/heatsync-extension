import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as MODS from '../src/lib/modifiers.js'

/**
 * A modifier must do the same thing to an emoji as it does to an emote.
 *
 * Modifiers come in two halves. The STATIC half (wide/tall/flip/tint) rides an
 * inline style attribute; the ANIMATED half (party/shake/spin/...) rides an
 * `hs-fx-*` CLASS whose keyframes live in the emote CSS.
 *
 * The class merge was guarded on `hasImg`, and an emoji is a
 * `<span class="hs-mc-emoji">` with no <img> inside it. So on an emoji the
 * static half applied and the animated half silently did nothing — `p!` on an
 * emoji rendered as a frozen tint instead of a cycling hue. Nothing threw; it
 * just did half the job, which is why it survived. Found by another session
 * hitting the identical bug on heatsync.org.
 *
 * emotes.js is a bundle FRAGMENT, not a module: it reads siblings like
 * HS_MOD_C_HEX_RE that build.js concatenates into one scope and that nothing
 * exports. So the function is stood up from source against a real scope, the
 * same way tests/player-guard.test.js does — rather than adding exports that
 * exist only for a test.
 */

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8')

/** Lift one top-level function out of the bundle fragment by brace matching. */
function lift(name) {
  const at = SRC.indexOf(`function ${name}(`)
  if (at === -1) throw new Error(`${name} not found in emotes.js`)
  let depth = 0
  for (let i = SRC.indexOf('{', at); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}') {
      depth--
      if (depth === 0) return SRC.slice(at, i + 1)
    }
  }
  throw new Error(`unbalanced braces in ${name}`)
}

// The real helpers, not fakes — a stubbed composer would let a
// modifier-semantics bug through, which is the thing under test.
const SCOPE = {
  ...MODS,
  HS_MOD_C_HEX_RE: /^c!#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/,
  escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
}
const names = Object.keys(SCOPE)
// eslint-disable-next-line no-new-func
const applyMods = new Function(...names, `${lift('_hsMcApplyMods')}; return _hsMcApplyMods`)(
  ...names.map((n) => SCOPE[n]),
)

const EMOJI = '<span class="hs-mc-emoji" title=":fire:">\u{1F525}</span>'
const EMOTE = '<span class="hs-mc-emote-wrapper"><img class="hs-mc-emote" src="x.png"></span>'

describe('modifiers on an emoji base', () => {
  test('an animated modifier puts its class on the emoji span', () => {
    const out = applyMods(EMOJI, ['party'], null)
    expect(out).toContain('hs-fx-party')
    expect(out).toMatch(/^<span\b[^>]*\bclass="[^"]*hs-fx-party/)
  })

  test('the emoji itself survives the merge', () => {
    const out = applyMods(EMOJI, ['party'], null)
    expect(out).toContain('hs-mc-emoji')
    expect(out).toContain('\u{1F525}')
  })

  test('an emote still gets the class on the IMG, not the wrapper', () => {
    expect(applyMods(EMOTE, ['party'], null)).toMatch(/<img\b[^>]*\bclass="[^"]*hs-fx-party/)
  })

  test('a pure-animation modifier applies with no static style to emit', () => {
    // shake contributes no transform and no filter, so the style string is
    // empty; anything that bailed on that would drop the effect entirely.
    expect(applyMods(EMOJI, ['shake'], null)).toContain('hs-fx-shake')
  })

  test('stacked modifiers apply BOTH halves to an emoji', () => {
    const out = applyMods(EMOJI, ['wide', 'party'], null)
    expect(out).toContain('hs-fx-party')
    expect(out).toMatch(/style="[^"]*transform:/)
  })

  test('a static-only modifier adds style and no effect class', () => {
    const out = applyMods(EMOJI, ['wide'], null)
    expect(out).toMatch(/style="[^"]*transform:/)
    expect(out).not.toContain('hs-fx-')
  })

  test('no modifiers leaves the markup untouched', () => {
    expect(applyMods(EMOJI, [], null)).toBe(EMOJI)
  })
})

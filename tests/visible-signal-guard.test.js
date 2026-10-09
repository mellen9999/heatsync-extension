import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A signal has to differ from the surface it sits on.
 *
 * The palette sweep mapped every colour literal onto the nearest of the eight.
 * That is correct for a FILL and wrong for anything whose entire job is to
 * differ from what it sits on, because for those the nearest allowed colour IS
 * the thing it was distinguishing itself from. A saturated dark red mention
 * fill is nearest to #000000, and #000000 is the row background — so the rule
 * survived, read correctly, and painted nothing.
 *
 * The site hit the same class on the same day and moved the signal onto an
 * inset edge; 2026-10-09 it went back to a dark red #5f0000 fill, no edge
 * (--mention-bg, messages.css), and so did this side. This file is the
 * extension half: one explicit table, each signal and what it must differ
 * from. Not a parser — a list, so a new entry is a reviewed line.
 */

const ROOT = join(import.meta.dir, '..')
const STYLES = join(ROOT, 'src', 'multichat', 'styles')
const SURFACE = '#000000'

const css = (f) => readFileSync(join(STYLES, f), 'utf8')
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')

/** The declaration block for an exact selector list, comments removed. */
function block(text, selector) {
  const i = strip(text).indexOf(selector)
  if (i === -1) return null
  const open = strip(text).indexOf('{', i)
  const close = strip(text).indexOf('}', open)
  return open === -1 || close === -1 ? null : strip(text).slice(open + 1, close)
}

describe('a signal must differ from the surface it sits on', () => {
  const rows = css('08-message-rows.css')
  const palette = strip(css('00-palette.css'))

  test('--hs-mention-bg is declared, once, and is not the surface', () => {
    const hits = [...palette.matchAll(/--hs-mention-bg:\s*([^;]+);/g)].map((m) => m[1].trim())
    expect(hits.length, '--hs-mention-bg is declared exactly once, in 00-palette.css').toBe(1)
    expect(hits[0], 'the mention fill is the whole signal — the surface colour is no signal').not.toBe(SURFACE)
  })

  // Both mention renderers (multichat + social feed), and a mention that also
  // matched a keyword — that row once went black with no edge at all.
  for (const sel of ['.hs-mc-msg.mention,', '.hs-mc-msg.mention.hs-kw-match,']) {
    test(`${sel.replace(/,$/, '')} is filled with the mention red`, () => {
      const body = block(rows, sel)
      expect(body, `${sel} is gone — the mention row stopped being styled at all`).toBeTruthy()
      expect(body, 'an @-mention of you is pixel-identical to every other row').toMatch(
        /background:\s*var\(--hs-mention-bg\)/,
      )
    })
  }

  test('a mention on a zebra row is the lighter mention red, never the gray stripe', () => {
    const stripe = palette.match(/--hs-mention-bg-stripe:\s*([^;]+);/)?.[1].trim()
    const fill = palette.match(/--hs-mention-bg:\s*([^;]+);/)?.[1].trim()
    expect(stripe, '--hs-mention-bg-stripe is gone').toBeTruthy()
    expect(stripe, 'a run of mentions would read as one block').not.toBe(fill)
    expect(stripe).not.toBe(SURFACE)
    for (const sel of ['.hs-mc-msg.mention.hs-mc-zebra,', '.hs-mc-msg.mention.hs-kw-match.hs-mc-zebra,']) {
      expect(block(rows, sel), `${sel} must fill with --hs-mention-bg-stripe`).toMatch(
        /background:\s*var\(--hs-mention-bg-stripe\)/,
      )
    }
    expect(strip(rows), 'a gray stripe on .mention erases the signal').not.toMatch(
      /\.mention[^{]*\{[^}]*var\(--hs-zebra\)/,
    )
  })

  test('--hs-zebra is declared and is not the surface', () => {
    const zebra = palette.match(/--hs-zebra:\s*([^;]+);/)?.[1].trim()
    expect(zebra, '--hs-zebra is gone').toBeTruthy()
    expect(zebra, 'the stripe is the same black as the row — there is no stripe').not.toBe(SURFACE)
  })
})

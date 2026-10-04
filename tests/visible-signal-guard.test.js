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
 * The site hit the same class on the same day and fixed it by moving the
 * signal onto an inset EDGE (--mention-edge, messages.css). This file is the
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

  test('--hs-mention-edge is declared, once, and is not the surface', () => {
    const hits = [...palette.matchAll(/--hs-mention-edge:\s*([^;]+);/g)].map((m) => m[1].trim())
    expect(hits.length, '--hs-mention-edge is declared exactly once, in 00-palette.css').toBe(1)
    expect(hits[0], 'the mention edge is the whole signal — the surface colour is no signal').not.toBe(SURFACE)
  })

  // Both mention renderers: the multichat row and the social-feed row. The site
  // shipped the edge to three renderers out of four and the fourth went
  // invisible on /live/new, so this asserts the pair together.
  for (const sel of ['.hs-mc-msg.mention,', '.hs-mc-msg.mention.hs-mc-zebra,']) {
    test(`${sel.replace(/,$/, '')} carries the mention edge, not just a fill`, () => {
      const body = block(rows, sel)
      expect(body, `${sel} is gone — the mention row stopped being styled at all`).toBeTruthy()
      const fill = body.match(/background:\s*([^;]+);/)?.[1].trim()
      const edged = /box-shadow:\s*inset[^;]*var\(--hs-mention-edge\)/.test(body)
      expect(
        fill !== SURFACE || edged,
        'the mention row is filled with the surface colour and carries no edge — an @-mention of you is pixel-identical to every other row',
      ).toBe(true)
    })
  }

  test('the zebra variant still differs from its neighbour', () => {
    const plain = block(rows, '.hs-mc-msg.mention,')
    const zebra = block(rows, '.hs-mc-msg.mention.hs-mc-zebra,')
    const fill = (b) => b.match(/background:\s*([^;]+);/)?.[1].trim()
    expect(
      fill(zebra),
      'the consecutive-mention stripe is the same fill as a plain mention row — the rule paints nothing',
    ).not.toBe(fill(plain))
  })

  test('--hs-zebra is the one off-palette value, and is not the surface', () => {
    const zebra = palette.match(/--hs-zebra:\s*([^;]+);/)?.[1].trim()
    expect(zebra, '--hs-zebra is gone').toBeTruthy()
    expect(zebra, 'the stripe is the same black as the row — there is no stripe').not.toBe(SURFACE)
  })
})

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

  // The mention row is a shared filled row (hs-filled hs-fill-red) from the brand
  // layer: one red, one place, no striping — so a run of mentions is split by the
  // 1px black gap between touching filled rows, not by a lighter stripe red.
  test('the shared mention row is filled with the brand red, never the surface', () => {
    const brand = strip(css('21-brand-rows.css'))
    const tokens = strip(css('01-brand-tokens.css'))
    const red = tokens.match(/--brand-fill-red:\s*([^;]+);/)?.[1].trim()
    expect(red, '--brand-fill-red is gone').toBeTruthy()
    expect(red, 'the mention fill is the whole signal — the surface colour is no signal').not.toBe(SURFACE)
    expect(brand, 'an @-mention of you is pixel-identical to every other row').toMatch(
      /\.hs-row-mention\s*\{\s*background:\s*var\(--brand-fill-red\)/,
    )
    expect(block(brand, '.hs-fill-red'), '.hs-fill-red lost its fill').toMatch(/background:\s*var\(--brand-fill-red\)/)
    expect(
      block(rows, '.hs-mc-msg.mention {'),
      'a per-repo mention fill is back — the brand layer owns it',
    ).not.toMatch(/background/)
  })

  test('event rows are solid fills from the brand set — no ring, no rail', () => {
    const brand = strip(css('21-brand-rows.css'))
    for (const f of ['olive', 'purple', 'navy', 'teal', 'red']) {
      const body = block(brand, `.hs-fill-${f}`)
      expect(body, `.hs-fill-${f} is gone`).toMatch(new RegExp(`background:\\s*var\\(--brand-fill-${f}\\)`))
    }
    expect(strip(rows), 'a ring is back on event rows').not.toContain('--hs-row-ring')
  })

  test('--hs-zebra is declared and is not the surface', () => {
    const zebra = css('01-brand-tokens.css')
      .match(/--brand-zebra:\s*([^;]+);/)?.[1]
      .trim()
    expect(zebra, '--hs-zebra is gone').toBeTruthy()
    expect(zebra, 'the stripe is the same black as the row — there is no stripe').not.toBe(SURFACE)
  })
})

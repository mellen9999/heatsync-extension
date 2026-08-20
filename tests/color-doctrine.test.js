import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Colour is a vocabulary, not a set of literals.
 *
 * The doctrine is settled: every role maps to one ANSI-256 entry, and
 * 00-palette.css is the single source of truth — "new color = use a token,
 * never raw hex". Both halves of that are checkable, so they are checked.
 *
 * When this was written the overlay had 190 raw hexes that re-typed a token
 * that already existed, across 13 files. Converting them changed nothing
 * visually (65 elements compared before/after in a real browser, zero
 * differences) — which is exactly why it was worth doing and worth pinning:
 * a duplicate literal costs nothing today and silently defeats the palette the
 * first time a colour is retuned.
 */

const STYLES = join(import.meta.dir, '..', 'src', 'multichat', 'styles')
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** The real xterm-256 palette: 16 system + 6x6x6 cube + 24 greys. */
function ansi256() {
  const sys = [
    '000000',
    '800000',
    '008000',
    '808000',
    '000080',
    '800080',
    '008080',
    'c0c0c0',
    '808080',
    'ff0000',
    '00ff00',
    'ffff00',
    '0000ff',
    'ff00ff',
    '00ffff',
    'ffffff',
  ]
  const lv = [0, 95, 135, 175, 215, 255]
  const hex = (n) => n.toString(16).padStart(2, '0')
  const cube = []
  for (const r of lv) for (const g of lv) for (const b of lv) cube.push(hex(r) + hex(g) + hex(b))
  const grey = []
  for (let i = 0; i < 24; i++) {
    const v = hex(8 + 10 * i)
    grey.push(v + v + v)
  }
  return new Set([...sys, ...cube, ...grey])
}
const ANSI = ansi256()

const expand = (h) => {
  const s = h.toLowerCase().replace('#', '')
  return s.length === 3
    ? s
        .split('')
        .map((c) => c + c)
        .join('')
    : s
}

/**
 * Hexes the palette deliberately names for MORE THAN ONE ROLE. The literal is
 * the role choice, and no mechanical mapping can make it: a delete button
 * tagged --hs-live would silently flip colour the day live changes.
 *
 * Inferring this from "defined twice" was wrong — #ff8700 is --hs-brand and
 * --hs-heat, which are synonyms for one role, and exempting it let brand orange
 * be re-typed freely. Hand-listed, with the reason.
 */
const AMBIGUOUS = new Map([
  ['ff0000', '--hs-live / --hs-danger / --hs-plat-youtube — three unrelated roles'],
  ['800000', '--hs-live-dim / --hs-danger-dim — same split, dim'],
])

function paletteTokens() {
  const css = stripComments(readFileSync(join(STYLES, '00-palette.css'), 'utf8'))
  const byHex = new Map()
  for (const m of css.matchAll(/(--hs-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\s*;/g)) {
    const h = expand(m[2])
    if (!byHex.has(h)) byHex.set(h, m[1])
  }
  return byHex
}

/**
 * White and black are structural, not themable. hover/active is reverse-video
 * by doctrine, so `#fff`/`#000` there encode a RULE — swapping them for tokens
 * would invite someone to retheme the invert itself.
 */
const STRUCTURAL = new Set(['ffffff', '000000'])

/**
 * Palette entries that are deliberately off the ANSI grid, each for a stated
 * reason. Anything not on this list must be an exact xterm-256 colour.
 */
const ROLE_COLLISION = new Set(['10-emotes.css:008080'])

const OFF_GRID_BY_DESIGN = new Map([
  ['2e2e08', '--hs-warn-bg — mellen-explicit dark-olive zebra for mentioned/quoted rows'],
  ['9146ff', '--hs-plat-twitch — twitch brand hex, only ever beside a platform glyph'],
  ['53fc18', '--hs-plat-kick — kick brand hex, same rule'],
])

describe('colour doctrine', () => {
  const tokens = paletteTokens()

  test('the palette is real ANSI-256, every entry', () => {
    const offGrid = [...tokens.entries()]
      .filter(([hex]) => !ANSI.has(hex) && !OFF_GRID_BY_DESIGN.has(hex))
      .map(([hex, name]) => `${name}: #${hex}`)
    expect(offGrid, 'every palette token must be an exact xterm-256 colour.').toEqual([])
  })

  test('no stylesheet re-types a colour the palette already names', () => {
    const offenders = []
    for (const file of readdirSync(STYLES).filter((f) => f.endsWith('.css') && f !== '00-palette.css')) {
      const css = stripComments(readFileSync(join(STYLES, file), 'utf8'))
      const seen = new Map()
      for (const m of css.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
        const h = expand(m[1])
        // A hex can collide with a token while meaning something else entirely:
        // the NSFW border is teal xterm-30 by design (commented at the site) and
        // merely happens to equal --hs-reply-dim. Converting it would state a
        // relationship that does not exist.
        if (STRUCTURAL.has(h) || AMBIGUOUS.has(h) || ROLE_COLLISION.has(`${file}:${h}`)) continue
        if (tokens.has(h)) seen.set(h, (seen.get(h) || 0) + 1)
      }
      for (const [h, n] of seen) offenders.push(`${file}: #${h} x${n} — use var(${tokens.get(h)})`)
    }
    expect(offenders, 'new color = use a token, never raw hex.').toEqual([])
  })

  test('the palette is actually used', () => {
    let uses = 0
    for (const f of readdirSync(STYLES).filter((x) => x.endsWith('.css'))) {
      uses += (readFileSync(join(STYLES, f), 'utf8').match(/var\(--hs-/g) || []).length
    }
    expect(uses).toBeGreaterThan(600)
  })
})

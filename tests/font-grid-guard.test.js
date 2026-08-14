import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FONT_GRID } from '../src/lib/font-grid.js'

/**
 * The extension's half of the bitmap grid guard (the site has
 * tests/server/font-grid-guard.test.ts; this repo had nothing, so ~20 off-grid
 * hardcoded sizes could drift freely).
 *
 * CozetteVector is a 6x13 cell — crisp only at integer multiples of 13. A
 * declaration off that grid is either a bug, or text that is deliberately NOT
 * rendered as bitmap, in which case it must be covered by the anti-aliasing
 * counter-rule in 01-font-rendering.css. The point of this test is that the
 * second case has to be *stated*, never merely tolerated.
 */

const STYLES = join(import.meta.dir, '..', 'src', 'multichat', 'styles')
const GRID = new Set(FONT_GRID.CozetteVector)

/**
 * Selectors the counter-rule restores AA for — read OUT OF THE CSS rather than
 * hand-listed, so removing a selector from the counter-rule immediately makes
 * every off-grid size under it a failure instead of silently smearing.
 */
function aaExemptSelectors() {
  const css = readFileSync(join(STYLES, '01-font-rendering.css'), 'utf8')
  const block = css.match(
    /((?:\s*body\.hs-font-bitmap[^,{]*,)+[^{]*)\{\s*-webkit-font-smoothing:\s*subpixel-antialiased/,
  )
  if (!block) throw new Error('could not find the AA counter-rule in 01-font-rendering.css')
  return block[1]
    .split(',')
    .map((s) =>
      s
        .replace(/body\.hs-font-bitmap\s*/, '')
        .replace(/\s*\*$/, '')
        .trim(),
    )
    .filter((s) => s.startsWith('.'))
    .map((s) => s.slice(1))
}

/**
 * Every `font-size: Npx` with the selector block it sits in.
 *
 * Comments are stripped FIRST: a prose comment mentioning "font-size: 10px"
 * is not a declaration, and counting it produced a phantom offender (and a
 * bogus entry in the list below) on the first cut of this test.
 * `@media` wrappers are unwrapped so rules nested inside them are seen at all —
 * a guard that silently skips media queries is worse than no guard, because it
 * reads as coverage.
 */
function sizeDeclarations() {
  const out = []
  for (const file of readdirSync(STYLES).filter((f) => f.endsWith('.css'))) {
    const css = readFileSync(join(STYLES, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@media[^{]*\{/g, '') // unwrap one level; the stray `}` parses as an empty rule
    const re = /([^{}]+)\{([^{}]*)\}/g
    let m
    while ((m = re.exec(css))) {
      const selector = m[1].trim().split('\n').pop().trim()
      for (const s of m[2].matchAll(/font-size:\s*([0-9.]+)px/g)) {
        out.push({ file, selector, px: Number.parseFloat(s[1]) })
      }
    }
  }
  return out
}

/**
 * Off-grid sizes that are NOT AA-exempt, accepted for now with a stated reason.
 * Every entry is a glyph/icon character rather than Cozette text — an arrow,
 * a close ✕, a play ▶ — where the cell size is irrelevant because no bitmap
 * glyph is being drawn.
 *
 * This list may only ever SHRINK. Adding to it means shipping smeared text.
 */
const KNOWN_OFF_GRID = new Set([
  'hs-whisper-arrow', // ▸ glyph
  'hs-mc-multi-dismiss', // ✕ glyph
  'hs-mc-chat-banner-icon', // banner icon glyph
  'hs-notif-resub-icon', // icon glyph
  'hs-notif-watchstreak-icon', // icon glyph
  'pinned-callout__icon', // twitch's own icon element, restyled
  'hs-feed-embed-yt-play', // ▶ glyph
  'hs-mc-playable', // ▶/⏸ ::before glyph
  'hs-mc-reply-caret', // ↳ glyph
  'hs-pc-name', // profile-card chrome (vector stack)
  'hs-mc-empty-title', // empty-state heading
  'hs-mc-stack-block-all', // control label
  'hs-mc-emoji-preview', // emoji, not text
  'hs-mc-send', // send-button glyph
  'hs-pcard-close', // ✕ glyph
  'hs-pcard-name', // profile-card chrome (vector stack)
  'hs-pcard-livedot', // ● dot
  'hs-mc-st-arrow', // ▸ glyph
  'hs-mc-cold-start-title', // empty-state heading
])

describe('bitmap font grid guard (extension)', () => {
  const decls = sizeDeclarations()
  const exempt = aaExemptSelectors()

  it('finds the stylesheets at all', () => {
    expect(decls.length).toBeGreaterThan(100)
    expect(exempt).toContain('hs-pcard')
    expect(exempt).toContain('hs-notif')
  })

  it('no NEW off-grid font-size appears in bitmap-rendered css', () => {
    const offenders = decls
      .filter((d) => !GRID.has(d.px))
      .filter((d) => !exempt.some((cls) => d.selector.includes(cls)))
      .filter((d) => ![...KNOWN_OFF_GRID].some((cls) => d.selector.includes(cls)))
      .map((d) => `${d.file}: ${d.px}px  ${d.selector.slice(0, 70)}`)
    expect(
      offenders,
      'CozetteVector is crisp only at 13/26/39. Either use a grid size, add the selector to the AA counter-rule in 01-font-rendering.css (if it is genuinely not bitmap text), or — last resort — justify it in KNOWN_OFF_GRID.',
    ).toEqual([])
  })

  it('the known-off-grid list has not grown', () => {
    // A ratchet: this number may go DOWN as entries get fixed or moved into
    // the AA counter-rule, never up.
    expect(KNOWN_OFF_GRID.size).toBeLessThanOrEqual(19)
  })

  it('every KNOWN_OFF_GRID entry still corresponds to a real declaration', () => {
    // Otherwise the list rots into a set of excuses for selectors that no
    // longer exist, and quietly starts excusing something else.
    const stale = [...KNOWN_OFF_GRID].filter((cls) => !decls.some((d) => d.selector.includes(cls) && !GRID.has(d.px)))
    expect(stale, 'these entries no longer match any off-grid declaration — delete them').toEqual([])
  })
})

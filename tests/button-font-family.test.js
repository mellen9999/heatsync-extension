import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A <button> does not inherit font-family. Every other element in the panel
 * does, so a button rule that sets a font-size but never a family silently
 * renders its label in the UA's Arial — inside an all-Cozette panel, on
 * fractional glyph advances.
 *
 * That is not only the wrong face. .hs-mc-reply-btn is right-anchored and
 * content-sized, so Arial's 10.9063px advance for the reply arrow made the
 * whole chip 20.9063px wide, which put its left edge — and therefore its
 * glyph — on a fractional X. Measured in Chrome, the arrow sat at x%1=0.0938
 * and the thread chevron at 0.7656, which is exactly the smear a bitmap face
 * cannot survive. Pinning the family made both chips 16px and both glyphs
 * land on whole pixels.
 *
 * The rule this guards: if a button rule states a font-size, it states a
 * family too.
 */

const STYLES = join(import.meta.dir, '..', 'src', 'multichat', 'styles')

/**
 * Every button of ours, keyed by the class or id that names it, with what the
 * whole stylesheet says about it. Keyed rather than per-rule because a family
 * declared once on the base rule covers a positional override that only moves
 * the button — reporting that override as an offender would be a false alarm.
 *
 * Attribute selectors are how the CSS reaches NATIVE Twitch/Kick buttons,
 * which are the host page's to style — only class/id selectors are in scope.
 */
function ownButtons() {
  const byName = new Map()
  for (const file of readdirSync(STYLES).filter((f) => f.endsWith('.css'))) {
    const css = readFileSync(join(STYLES, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@media[^{]*\{/g, '') // unwrap one level; the stray `}` parses as an empty rule
    const re = /([^{}]+)\{([^{}]*)\}/g
    let m
    while ((m = re.exec(css))) {
      const selector = m[1].trim().split('\n').pop().trim()
      const body = m[2]
      if (selector.includes('[')) continue // native host-page button
      for (const name of selector.match(/[.#][A-Za-z0-9_-]*(?:btn|button)[A-Za-z0-9_-]*/gi) || []) {
        const e = byName.get(name) || { name, where: `${file}  ${selector}`, sized: false, family: false }
        if (/font-size\s*:/.test(body)) e.sized = true
        if (/font-family\s*:|font\s*:\s/.test(body)) e.family = true
        byName.set(name, e)
      }
    }
  }
  return [...byName.values()]
}

describe('button font-family', () => {
  it('finds the buttons at all (guard against a parser that matches nothing)', () => {
    expect(ownButtons().length).toBeGreaterThan(10)
  })

  it('every text-bearing button of ours states a font-family', () => {
    const offenders = ownButtons()
      .filter((b) => b.sized && !b.family)
      .map((b) => `${b.name} — ${b.where}`)
    expect(offenders).toEqual([])
  })

  it('the reply and thread chips keep the panel font — their pixel alignment depends on it', () => {
    const css = readFileSync(join(STYLES, '08-message-rows.css'), 'utf8')
    for (const cls of ['.hs-mc-reply-btn', '.hs-mc-thread-btn']) {
      const rule = css.match(new RegExp(`\\n\\s*\\${cls}\\s*\\{([^}]*)\\}`))
      expect(rule).not.toBeNull()
      expect(rule[1]).toContain('font-family: var(--hs-mc-font')
    }
  })

  it('a mod-toolbar button centres an even runway, so a monospace cell lands on the grid', () => {
    const css = readFileSync(join(STYLES, '08-message-rows.css'), 'utf8')
    const rule = css.match(/\n\s*\.hs-mod-btn\s*\{([^}]*)\}/)
    expect(rule).not.toBeNull()
    // content-box + an even min-width: border-box would subtract the padding
    // and the 1px divider, leaving an odd runway and a half-pixel glyph.
    expect(rule[1]).toContain('box-sizing: content-box')
    const min = rule[1].match(/min-width:\s*(\d+)px/)
    expect(min).not.toBeNull()
    expect(Number(min[1]) % 2).toBe(0)
    // line-height:1 would centre a 13px line box in the toolbar's 18px content
    // height and split 5px — the same half pixel on the other axis.
    expect(rule[1]).not.toMatch(/line-height:\s*1\s*;/)
  })
})

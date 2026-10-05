import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * No mud: a colour is TEXT and an EDGE on black — never a fill behind text.
 *
 * Every button/chip/badge/tag/toast/banner with a colour gets colored text and a
 * 1px border in that colour on black; hover/focus/active is the house reverse
 * (white bg, black text). A fill with no text in it (dots, bars, toggles, progress)
 * is fine and is not checked.
 *
 * The scan: any declaration group (a css rule body, or one quoted inline style
 * string) that sets a coloured background AND a text colour fails, and so does a
 * JS `{ bg, fg }` badge-table entry whose bg is coloured.
 *
 * "Coloured" = any palette hue; black, white, transparent, and the zebra token
 * are not. Exemptions are explicit below, with the reason.
 */

const ROOT = join(import.meta.dir, '..')
const COLORED_TOK = /^var\(--hs-(plat-[a-z]+|ok|warn|danger|live|reply|thread|info|gold|mention|heat|mod|[a-z]+-dim)\)$/
const COLORED_HEX = /^#(ff0000|00ff00|ffff00|8888ff|ff00ff|00ffff|ff8700|a970ff|00ad03|f00|0f0|ff0|f0f|0ff)$/i

/** [pattern on the group text, reason] */
const EXEMPT = [
  [/var\(--hs-sel\)/, 'the cyan keyboard cursor: cyan bg + black text is the cursor convention (high contrast)'],
]
const SKIP =
  /multichat-core|multichat-twitch|emoji-data|20-card|paint-|scene-spec|fill-layers|glyph-mask|animation-phase|plus-tenure|cosmetics\.js|paints\.js|_locales/

function walk(d, out = []) {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(css|js|html)$/.test(n)) out.push(p)
  }
  return out
}
const FILES = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'chrome'))]
  .map((p) => ({ p, rel: relative(ROOT, p) }))
  .filter((f) => !SKIP.test(f.rel))

const isColored = (v) => {
  const x = v.replace(/\s*!important\s*$/, '').trim()
  return COLORED_TOK.test(x) || COLORED_HEX.test(x)
}

describe('no colour fill behind text', () => {
  test('reads the source tree', () => {
    expect(FILES.length).toBeGreaterThan(40)
  })

  test('a coloured background never carries text — outline it', () => {
    const bad = []
    for (const { p, rel } of FILES) {
      const text = readFileSync(p, 'utf8')
      for (const m of text.matchAll(/\{[^{}]*\}|(['"`])((?:(?!\1)[^\\\n])*)\1/g)) {
        const grp = m[0]
        const bg = grp.match(/(?<![-\w])background(?:-color)?\s*:\s*([^;}'"`]+)/)
        if (!bg || !isColored(bg[1])) continue
        if (!/(?<![-\w])color\s*:/.test(grp)) continue
        if (EXEMPT.some(([re]) => re.test(grp))) continue
        bad.push(`${rel}: ${grp.slice(0, 90).replace(/\s+/g, ' ')}`)
      }
    }
    expect(bad, 'colour = text + 1px border on black; hover = white bg + black text').toEqual([])
  })

  test('JS badge tables ({ bg, fg }) keep a black bg', () => {
    const bad = []
    for (const { p, rel } of FILES.filter((f) => f.rel.endsWith('.js'))) {
      const text = readFileSync(p, 'utf8')
      for (const m of text.matchAll(/\bbg:\s*'(#[0-9a-fA-F]{3,6})'[^}\n]*\bfg:/g)) {
        if (isColored(m[1])) bad.push(`${rel}: ${m[0].slice(0, 70)}`)
      }
    }
    expect(bad).toEqual([])
  })

  test('the exempt list is explicit', () => {
    expect(EXEMPT.length).toBe(1)
  })
})

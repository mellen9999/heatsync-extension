import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * A colour is text or an edge on black. When it IS a fill, the text on it is
 * black (black passes on every palette colour; white on red/magenta/blue-88f
 * does not). White text only ever sits on a white reverse-video fill.
 *
 * Scans every declaration group (a css rule body, or one quoted inline style
 * string) that sets a coloured background AND a white text colour.
 */

const ROOT = join(import.meta.dir, '..')
const COLORED_TOK = /var\(--hs-(plat-[a-z]+|ok|warn|danger|live|reply|thread|info|gold|mention|heat|sel|[a-z]+-dim)\)/
const COLORED_HEX = /^#(ff0000|00ff00|ffff00|8888ff|ff00ff|00ffff|ff8700|f00|0f0|ff0|f0f|0ff)$/i
const WHITE = /^(#fff|#ffffff|white|var\(--hs-fg\))$/i
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

describe('colour fills carry black text', () => {
  test('no white text on a coloured background', () => {
    const bad = []
    for (const p of [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'chrome'))]) {
      const rel = relative(ROOT, p)
      if (SKIP.test(rel)) continue
      const text = readFileSync(p, 'utf8')
      for (const m of text.matchAll(/\{[^{}]*\}|(['"`])((?:(?!\1)[^\\\n])*)\1/g)) {
        const grp = m[0]
        const bg = grp.match(/(?<![-\w])background(?:-color)?\s*:\s*([^;}'"`]+)/)
        const col = grp.match(/(?<![-\w])color\s*:\s*([^;}'"`]+)/)
        if (!bg || !col) continue
        const bv = bg[1].replace(/\s*!important\s*$/, '').trim()
        const cv = col[1].replace(/\s*!important\s*$/, '').trim()
        if ((COLORED_TOK.test(bv) || COLORED_HEX.test(bv)) && WHITE.test(cv))
          bad.push(`${rel}: ${grp.slice(0, 80).replace(/\s+/g, ' ')}`)
      }
    }
    expect(bad, 'text on a coloured fill must be black').toEqual([])
  })
})

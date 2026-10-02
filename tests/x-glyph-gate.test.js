import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every dismiss × is ONE thick svg cross (src/multichat/x-glyph.js, styled once by
 * .hs-x in styles/21-x-glyph.css). A hand-written '×' / '✕' label is how the
 * overlay ended up with eight different close buttons, so no source file may
 * write one as a string/markup glyph. The only exemptions are the builder itself
 * and the byte-mirrored site card renderer (the extension rewrites its × to the
 * glyph at mount — hsXify in profile-card.js).
 */
const ROOT = join(import.meta.dir, '..')
const SRC = join(ROOT, 'src')
const EXEMPT = new Set(['multichat/x-glyph.js', 'lib/card-render.js'])

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.js')) out.push(p)
  }
  return out
}

// a quoted/markup glyph standing alone as a label: '×' "✕" `×` >×< × &times;
const BARE = /(['"`>])\s*(?:×|✕|✖)\s*(?=['"`<])|\\u00d7|\\u2715|\\u2716|&times;|&#215;/

describe('one close glyph', () => {
  test('no src file hand-writes a × / ✕ close label outside the shared builder', () => {
    const offenders = []
    for (const f of walk(SRC)) {
      const rel = f.slice(SRC.length + 1)
      if (EXEMPT.has(rel)) continue
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
          if (BARE.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`)
        })
    }
    expect(offenders).toEqual([])
  })

  test('the gate bites: a hand-written glyph is caught', () => {
    expect(BARE.test(`b.textContent = '×'`)).toBe(true)
    expect(BARE.test('<button>✕</button>')).toBe(true)
    expect(BARE.test(`label: '\\u00d7'`)).toBe(true)
    expect(BARE.test('a ×N counter')).toBe(false)
  })

  test('the shared builder is a thick svg cross', () => {
    const src = readFileSync(join(SRC, 'multichat', 'x-glyph.js'), 'utf8')
    const w = Number(src.match(/stroke-width="([\d.]+)"/)?.[1])
    expect(w).toBeGreaterThanOrEqual(2)
    expect(w).toBeLessThanOrEqual(2.5)
  })

  test('one shared css rule: white on black, reverse on hover/active, >=24px / >=40px coarse', () => {
    const css = readFileSync(join(SRC, 'multichat', 'styles', '21-x-glyph.css'), 'utf8')
    expect(css).toMatch(/\.hs-x \{[^}]*min-width: 24px[^}]*background: #000;[^}]*color: #fff/)
    expect(css).toMatch(/\.hs-x:hover,\s*\.hs-x:active[^{]*\{ background: #fff; color: #000/)
    expect(css).toMatch(/pointer: coarse\)[\s\S]*min-width: 40px/)
  })

  test('the per-× rules are gone from the other stylesheets', () => {
    const dir = join(SRC, 'multichat', 'styles')
    for (const f of readdirSync(dir)) {
      if (f === '21-x-glyph.css') continue
      const css = readFileSync(join(dir, f), 'utf8')
      for (const dead of [
        '.hs-pv-close {',
        '.hs-cl-close {',
        '.hs-mc-player-close {',
        '.hs-mc-dest-close {',
        '.hs-notif-action-dismiss {',
      ])
        expect(css).not.toContain(dead)
    }
  })

  test('every dismiss site builds through the shared helper', () => {
    const at = (f) => readFileSync(join(SRC, 'multichat', f), 'utf8')
    expect(at('chat-logs.js')).toContain("hsXButton('hs-cl-close'")
    expect(at('pred-view.js')).toContain("hsXButton('hs-pv-close'")
    expect(at('feed-embed.js')).toContain("hsXButtonHtml('hs-mc-player-close'")
    expect(at('profile-card.js')).toContain("hsXButton('hs-pcard-close'")
    expect(at('settings-ui.js')).toContain('hsXButtonHtml(')
    expect(at('notifs.js')).toContain('HS_X_SVG')
  })
})

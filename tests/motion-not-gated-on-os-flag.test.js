import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Content motion must never be gated on prefers-reduced-motion.
 *
 * That media query is a BROWSER flag, not a per-site preference, and it is
 * routinely forced on for reasons that have nothing to do with a preference
 * about heatsync. A chromium run with --force-prefers-reduced-motion makes any
 * such rule permanently true, and the result is not "less motion" — it is a
 * feature that is silently, permanently dead with no setting that can revive
 * it. It has happened twice:
 *
 *   1. Emote modifiers (hs-fx-*) — every animated modifier "did nothing" while
 *      the static ones worked. Fixed by gating on animateEmotes instead.
 *   2. Name paints — measured on a live channel, all 50 animated paint layers
 *      on the page were paused. Worse than frozen: each paint's top scene layer
 *      (::after, z-index:1) parked its sprite ON the glyphs, so painted
 *      usernames read as blurry, non-bitmap text. Fixed by gating on
 *      animatePaints.
 *
 * Both are CONTENT someone chose — an animated paint is the same class of
 * motion as an animated gif emote, which heatsync has never gated on the flag.
 * The rule: motion gets a first-party setting, and the setting is the gate.
 *
 * Chrome/UI affordances (toasts, callouts) may still honour the query — those
 * are our own decoration, not someone's content, and they have no setting.
 */

const ROOT = join(import.meta.dir, '..')

/** Surfaces that render user/sender-chosen content motion. */
const CONTENT_MOTION = [
  join('src', 'multichat', 'paints.js'),
  join('src', 'multichat', 'styles', '10-emotes.css'),
  join('chrome', 'youtube-content.js'),
  join('src', 'lib', 'paint-spec.js'),
  join('src', 'lib', 'scene-spec.js'),
]

/** Decoration we own, where honouring the flag is a real choice. */
const ALLOWED_DECORATION = [
  join('src', 'multichat', 'styles', '05-notif-layers.css'),
  join('src', 'multichat', 'styles', '06-statusbar-callouts.css'),
]

function sourceFiles() {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) {
        walk(p)
        continue
      }
      if (!/\.(js|css)$/.test(name)) continue
      // chrome/multichat*.js are build OUTPUT of src/multichat.
      if (/^multichat(-\w+)?\.js$/.test(name)) continue
      out.push(p.slice(ROOT.length + 1))
    }
  }
  walk(join(ROOT, 'src'))
  walk(join(ROOT, 'chrome'))
  return out
}

describe('content motion is not gated on the OS flag', () => {
  test('the walker actually sees the tree', () => {
    expect(sourceFiles().length).toBeGreaterThan(20)
  })

  for (const file of CONTENT_MOTION) {
    test(`${file} does not consult prefers-reduced-motion`, () => {
      const src = readFileSync(join(ROOT, file), 'utf8')
      // Strip comments: this file's own explanation of why the query is gone
      // must not read as a use of it.
      const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
      expect(code).not.toContain('prefers-reduced-motion')
    })
  }

  test('no NEW surface starts gating on it either', () => {
    const known = new Set([...CONTENT_MOTION, ...ALLOWED_DECORATION])
    const offenders = sourceFiles().filter((f) => {
      if (known.has(f)) return false
      const code = readFileSync(join(ROOT, f), 'utf8')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
      return code.includes('prefers-reduced-motion')
    })
    expect(offenders).toEqual([])
  })

  test('paints are gated on the animatePaints setting instead', () => {
    const paints = readFileSync(join(ROOT, 'src', 'multichat', 'paints.js'), 'utf8')
    expect(paints).toContain('data-hs-paint-anim')
    const schema = readFileSync(join(ROOT, 'src', 'lib', 'settings-schema.js'), 'utf8')
    expect(schema).toContain("key: 'animatePaints'")
    // applyOnLoad or the attribute never lands on a fresh page and 'never'
    // silently behaves like 'always' — the exact trap animateEmotes hit.
    const entry = schema.slice(schema.indexOf("key: 'animatePaints'"))
    expect(entry.slice(0, entry.indexOf('},'))).toContain('applyOnLoad: true')
  })

  test('emote modifiers are gated on the animateEmotes setting instead', () => {
    const css = readFileSync(join(ROOT, 'src', 'multichat', 'styles', '10-emotes.css'), 'utf8')
    expect(css).toContain('data-hs-emote-anim')
  })
})

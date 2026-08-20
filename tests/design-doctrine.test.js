import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The look is a specification, not a preference — so it gets a test.
 *
 * heatsync is square, flat, terminal. Every rule below was already followed
 * across the whole overlay when this was written (6 border-radius declarations,
 * 4 of them `0 !important`, 2 on status dots; zero gradients; zero glass). That
 * is exactly when a guard is worth adding: locking in a clean state costs
 * nothing, and the first violation is caught by CI instead of by eye, weeks
 * later, on a surface nobody re-opened.
 *
 * Each rule carries its own escape hatch, because a doctrine with no stated
 * exceptions gets deleted the first time it is inconvenient.
 */

const STYLES = join(import.meta.dir, '..', 'src', 'multichat', 'styles')
const EXTRA = [join(import.meta.dir, '..', 'chrome', 'injected-message.css')]

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

function allRules() {
  const files = readdirSync(STYLES)
    .filter((f) => f.endsWith('.css'))
    .map((f) => join(STYLES, f))
    .concat(EXTRA)
  const out = []
  for (const path of files) {
    const css = stripComments(readFileSync(path, 'utf8')).replace(/@media[^{]*\{/g, '')
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      out.push({ file: path.split('/').pop(), selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] })
    }
  }
  return out
}

const RULES = allRules()

describe('design doctrine', () => {
  test('reads the stylesheets at all', () => {
    expect(RULES.length).toBeGreaterThan(400)
  })

  test('everything is square — round is for status dots only', () => {
    const offenders = RULES.filter((r) => {
      const m = r.body.match(/border-radius:\s*([^;]+)/)
      if (!m) return false
      const v = m[1].replace('!important', '').trim()
      if (v === '0' || v === '0px') return false
      // A dot is round by definition; it is the one documented exception.
      return !/dot|::after|::before/.test(r.selector)
    }).map((r) => `${r.file}: ${r.selector.slice(0, 60)}`)
    expect(offenders, 'heatsync is square. Round is permitted only on small status dots.').toEqual([])
  })

  test('no gradients', () => {
    // Paint cosmetics are user-authored and compiled at runtime by
    // lib/paint-spec.js — they are content, not chrome, and never appear here.
    const offenders = RULES.filter((r) => /(linear|radial|conic)-gradient/.test(r.body)).map(
      (r) => `${r.file}: ${r.selector.slice(0, 60)}`,
    )
    expect(offenders, 'flat terminal surfaces — no gradients in chrome.').toEqual([])
  })

  test('no glassmorphism', () => {
    const offenders = RULES.filter((r) => /backdrop-filter/.test(r.body)).map(
      (r) => `${r.file}: ${r.selector.slice(0, 60)}`,
    )
    expect(offenders, 'no frosted glass — opaque terminal panels.').toEqual([])
  })

  test('no scale or slide MOTION', () => {
    // The ban is on motion, not on transforms. Static transforms are load-
    // bearing here and correct: translate(-50%) is the centring idiom, and
    // scaleX(2)/scaleY(-1) are FFZ emote modifiers — content, not chrome. What
    // is banned is a transform that MOVES: animated via transition, or driven
    // by a keyframe that translates or scales.
    const animatedTransition = RULES.filter((r) => {
      const t = r.body.match(/transition:\s*([^;]+)/)
      return t && /\btransform\b|\ball\b/.test(t[1])
    }).map((r) => `${r.file}: transition ${r.selector.slice(0, 50)}`)

    // Keyframes that move something. hs-fx-* are user-selected emote effects —
    // content the viewer opted into, not interface chrome.
    const files = readdirSync(STYLES).filter((f) => f.endsWith('.css'))
    const movingFrames = []
    for (const f of files) {
      const css = stripComments(readFileSync(join(STYLES, f), 'utf8'))
      for (const m of css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)\s*\{([\s\S]*?)\n\s*\}\n/g)) {
        const [, name, body] = m
        if (name.startsWith('hs-fx-')) continue
        if (/translate|scale/.test(body)) movingFrames.push(`${f}: @keyframes ${name}`)
      }
    }
    expect([...animatedTransition, ...movingFrames], 'no scale-bounce or slide-in on chrome.').toEqual([])
  })

  test('no keyframe is named for motion it does not do', () => {
    // hs-notif-slide-in-right did nothing but fade, and two slide-in siblings
    // were dead entirely. A name that lies is an invitation to re-add the slide.
    const files = readdirSync(STYLES).filter((f) => f.endsWith('.css'))
    const liars = []
    for (const f of files) {
      const css = stripComments(readFileSync(join(STYLES, f), 'utf8'))
      for (const m of css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)\s*\{([\s\S]*?)\n\s*\}\n/g)) {
        const [, name, body] = m
        if (/slide|bounce|zoom/.test(name) && !/translate|scale/.test(body)) {
          liars.push(`${f}: @keyframes ${name} claims motion but only changes opacity`)
        }
      }
    }
    expect(liars).toEqual([])
  })
})

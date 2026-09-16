/**
 * The overlay must dial its own paints down when a crowd is on screen.
 *
 * The compiler emits `body.hs-paint-chunky` / `body.hs-paint-chunkier` timing
 * overrides beside EVERY animation it writes (lib/paint-core.js CROWD_TIERS,
 * lib/scene-spec.js crowdTierRules), and those compiler files are byte-mirrored
 * from the site (scripts/sync-paint-compiler.sh) — so the overlay has always
 * SHIPPED the rules. Nothing ever put either class on <body>. The whole tier
 * system was unreachable CSS here and ext paints ran at full rate at any crowd
 * size, while the site they mirror has coarsened since 8839cd015.
 *
 * What is fenced is the RUNTIME half, because that is the half that was missing
 * and the half a compiled-CSS assertion cannot see:
 *
 *   - the thresholds are a PRODUCT of the compiler's own per-name cap, never
 *     literals — both times the site's dial drifted, a literal had stood in for
 *     the product and the unit moved underneath it;
 *   - what they BUY is a NUMBER OF NAMES, which is the thing a user feels and
 *     the thing every weight assertion stayed green through last time;
 *   - a name is charged by EFFECTS, not animation instances, so a letter-split
 *     paint is not charged by how long the name is;
 *   - a composited `hsq_` transform is not charged at all;
 *   - the viewport gate actually FEEDS the dial. A governor nothing calls is
 *     the exact failure this file exists to end, so the wiring block below runs
 *     the SHIPPING observer source into the SHIPPING visible set and reads the
 *     tier off the SHIPPING dial.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_ANIMATED_LAYERS } from '../src/lib/paint-spec.js'
import { COMPOSITED_ANIM_PREFIX } from '../src/lib/scene-spec.js'
import {
  _hsAnimatingWeightForTests,
  _hsCrowdThresholdsForTests,
  _hsVisiblePaintedForTests,
  _resetHsCrowdDialForTests,
  applyHsCrowdDial,
} from '../src/multichat/paints.js'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'paints.js'), 'utf8')

/** Slice `function ensureHsVisibilityObserver() { … }` out of paints.js, so the
 *  wiring under test is the shipping source and not a re-implementation of it.
 *  Same technique as tests/paint-idle-gate-phase.test.js. */
function sliceObserverFactory() {
  const start = SRC.indexOf('function ensureHsVisibilityObserver()')
  expect(start, 'ensureHsVisibilityObserver vanished from paints.js').toBeGreaterThan(-1)
  let depth = 0
  let i = SRC.indexOf('{', start)
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}' && --depth === 0) break
  }
  expect(i, 'unbalanced braces slicing ensureHsVisibilityObserver').toBeLessThan(SRC.length)
  return SRC.slice(start, i + 1)
}

/** Run the sliced observer over `entries`, writing into the module's REAL
 *  visible set. Returns whether the gate scheduled a dial pass. */
function feedGate(entries) {
  let cb = null
  let dialled = false
  class FakeIO {
    constructor(fn) {
      cb = fn
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const factory = new Function(
    'IntersectionObserver',
    'regateInPhase',
    'hsVisiblePainted',
    'scheduleHsCrowdDial',
    `let hsVisibilityObserver = null
     ${sliceObserverFactory()}
     return ensureHsVisibilityObserver()`,
  )
  factory(
    FakeIO,
    () => {},
    _hsVisiblePaintedForTests(),
    () => {
      dialled = true
    },
  )
  cb(entries)
  return dialled
}

const onScreen = (els) => els.map((target) => ({ target, isIntersecting: true }))
const offScreen = (els) => els.map((target) => ({ target, isIntersecting: false }))

/** A <body> whose classList is real enough to read a tier off. */
function fakeDocument() {
  const set = new Set()
  return {
    body: {
      classList: {
        add: (...c) => c.forEach((x) => set.add(x)),
        remove: (...c) => c.forEach((x) => set.delete(x)),
        contains: (c) => set.has(c),
        toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
      },
    },
  }
}

/** A painted name running `effects` distinct effects across `spans` glyphs —
 *  the shape a letter-split paint actually produces. */
function paintedName(effects, spans = 1, extra = []) {
  const anims = []
  for (let s = 0; s < spans; s++) {
    for (let e = 0; e < effects; e++) anims.push({ animationName: `hsp_deadbeef_e${e}` })
  }
  for (const n of extra) anims.push({ animationName: n })
  return { isConnected: true, getAnimations: () => anims }
}

/** The heaviest one name can be: compilePaintCss caps a paint at
 *  MAX_ANIMATED_LAYERS live animations, and every threshold counts in it. */
const fullWeightName = (spans = 6) => paintedName(MAX_ANIMATED_LAYERS, spans)

let doc
beforeEach(() => {
  // The bundle-scope free variables build.js concatenates ahead of paints.js
  // (readMultichatModules: paint-core → scene-spec → paint-spec → paints).
  // The REAL values, so the product asserted below is the product that ships.
  globalThis.MAX_ANIMATED_LAYERS = MAX_ANIMATED_LAYERS
  globalThis.COMPOSITED_ANIM_PREFIX = COMPOSITED_ANIM_PREFIX
  doc = fakeDocument()
  globalThis.document = doc
  _resetHsCrowdDialForTests()
})
afterEach(() => {
  _resetHsCrowdDialForTests()
  globalThis.MAX_ANIMATED_LAYERS = undefined
  globalThis.COMPOSITED_ANIM_PREFIX = undefined
  globalThis.document = undefined
})

const tier = () =>
  doc.body.classList.contains('hs-paint-chunkier')
    ? 'chunkier'
    : doc.body.classList.contains('hs-paint-chunky')
      ? 'chunky'
      : 'plain'

describe("the thresholds are the compiler's cap, multiplied", () => {
  test('chunky at 3 full names, chunkier at 6 — written as a product', () => {
    expect(_hsCrowdThresholdsForTests()).toEqual({
      chunky: 3 * MAX_ANIMATED_LAYERS,
      chunkier: 6 * MAX_ANIMATED_LAYERS,
    })
  })

  test('the heaviest ONE name can measure is exactly that cap', () => {
    // The unit the thresholds count in. If a name can outweigh the cap, "3 full
    // names" stops meaning three names — which is how this drifted on the site.
    expect(_hsAnimatingWeightForTests(fullWeightName(8))).toBe(MAX_ANIMATED_LAYERS)
  })

  test('no compiler constant in scope — NO dial, rather than a wrong one', () => {
    globalThis.MAX_ANIMATED_LAYERS = undefined
    expect(_hsCrowdThresholdsForTests()).toBeNull()
    expect(() => applyHsCrowdDial()).not.toThrow()
    expect(tier()).toBe('plain')
  })
})

describe('a name is charged by what REPAINTS', () => {
  test('a letter-split paint is charged by effects, not by name length', () => {
    // The same fill animation on one span per glyph is ONE effect. Counting
    // instances charged an 8-letter name more than a 6-letter one for the same
    // paint over the same repainted area.
    expect(_hsAnimatingWeightForTests(paintedName(3, 4))).toBe(3)
    expect(_hsAnimatingWeightForTests(paintedName(3, 12))).toBe(3)
  })

  test('a composited hsq_ transform is free', () => {
    // A GPU quad blit on a promoted layer, not a main-thread repaint. Charging
    // one a unit each puts a scene name at nine instead of three.
    expect(
      _hsAnimatingWeightForTests(
        paintedName(3, 2, [`${COMPOSITED_ANIM_PREFIX}deadbeef_goldfill`, `${COMPOSITED_ANIM_PREFIX}deadbeef_band0`]),
      ),
    ).toBe(3)
  })

  test('zero is a real answer and is never cached as one', () => {
    const el = { isConnected: true, getAnimations: () => [] }
    expect(_hsAnimatingWeightForTests(el)).toBe(0)
    // Zero is also what an element reports before its animations have started,
    // and the dial first runs inside a rAF — caching it would pin a scene paint
    // at "free" for the life of the element.
    el.getAnimations = () => [{ animationName: 'hsp_x_e0' }]
    expect(_hsAnimatingWeightForTests(el)).toBe(1)
  })
})

describe('the dial engages by NAME COUNT', () => {
  test('plain to 3, chunky at 4, chunkier at 7', () => {
    // The load-bearing fact, and the one the site had no test for until the
    // crowd running at full cost had silently doubled: the thresholds are a
    // weight, but what they BUY is a number of names.
    const seen = []
    for (let n = 1; n <= 8; n++) {
      _resetHsCrowdDialForTests()
      feedGate(onScreen(Array.from({ length: n }, () => fullWeightName())))
      applyHsCrowdDial()
      seen.push(tier())
    }
    expect(seen).toEqual(['plain', 'plain', 'plain', 'chunky', 'chunky', 'chunky', 'chunkier', 'chunkier'])
  })

  test('scrolling a crowd away dials back down', () => {
    const names = Array.from({ length: 8 }, () => fullWeightName())
    feedGate(onScreen(names))
    applyHsCrowdDial()
    expect(tier()).toBe('chunkier')
    feedGate(offScreen(names))
    applyHsCrowdDial()
    expect(tier()).toBe('plain')
  })

  test('a name that left the DOM stops counting', () => {
    const names = Array.from({ length: 8 }, () => fullWeightName())
    feedGate(onScreen(names))
    applyHsCrowdDial()
    expect(tier()).toBe('chunkier')
    for (const el of names.slice(2)) el.isConnected = false
    applyHsCrowdDial()
    expect(tier()).toBe('plain')
  })
})

describe('the dial resolves its unit in the SHIPPED bundle', () => {
  // Every test above hands the compiler constants to the module on globalThis.
  // In production they are bundle-scope free variables, and the dial degrades
  // to OFF if they are not there — an honest degradation that is also a silent
  // one. So pin the precondition: build.js must concatenate the files that
  // declare them ahead of paints.js.
  const BUILD = readFileSync(join(import.meta.dir, '..', 'build.js'), 'utf8')

  test('build.js embeds scene-spec and paint-spec ahead of the multichat modules', () => {
    const libLoop = BUILD.indexOf(
      "for (const mod of ['paint-core.js', 'scene-spec.js', 'paint-spec.js', 'animation-phase.js'])",
    )
    expect(libLoop, 'the paint compiler lib loop moved or was renamed in build.js').toBeGreaterThan(-1)
    const mcLoop = BUILD.indexOf('const modules = CORE_MODULES')
    expect(mcLoop, 'the multichat module loop moved in build.js').toBeGreaterThan(-1)
    expect(libLoop).toBeLessThan(mcLoop)
  })

  test('the two constants the dial reads are declared in those files', () => {
    const paintSpec = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'paint-spec.js'), 'utf8')
    const sceneSpec = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'scene-spec.js'), 'utf8')
    // stripExports drops the `export ` prefix and leaves the declaration, so a
    // top-level `export const` becomes a bundle-scope `const`.
    expect(paintSpec).toMatch(/^export const MAX_ANIMATED_LAYERS = /m)
    expect(sceneSpec).toMatch(/^export const COMPOSITED_ANIM_PREFIX = /m)
  })
})

describe('the viewport gate feeds the dial', () => {
  test('intersecting names join the visible set, leaving names drop out', () => {
    const on = fullWeightName()
    const off = fullWeightName()
    feedGate([...onScreen([on, off])])
    feedGate(offScreen([off]))
    const set = _hsVisiblePaintedForTests()
    expect(set.has(on)).toBe(true)
    expect(set.has(off)).toBe(false)
  })

  test('every visibility change schedules a dial pass', () => {
    // A governor nothing calls is the bug. This assertion fails if the call is
    // ever dropped back out of the gate.
    expect(feedGate(onScreen([fullWeightName()]))).toBe(true)
  })
})

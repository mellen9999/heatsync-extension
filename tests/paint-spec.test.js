import { describe, expect, test } from 'bun:test'
import {
  compilePaintCss,
  EFFECTS,
  hashPaintSpec,
  paintNeedsSpans,
  paintPhaseNow,
  validatePaintSpec,
} from '../src/lib/paint-spec.js'

// Smoke-test coverage for the ext's ported copy of the heatsync monorepo's
// client/utils/paint-spec.js — see the provenance header in src/lib/paint-spec.js.
// This mirrors (a representative subset of) tests/client/paint-spec.test.js in
// the monorepo; the two copies must behave identically since the ext renders
// the exact same compiled CSS the site does for the exact same spec.

function baseSpec(overrides = {}) {
  return {
    v: 1,
    base: { type: 'solid', angle: 0, stops: [{ color: '#ff8700', pos: 0 }] },
    effects: [],
    glow: null,
    ...overrides,
  }
}

describe('validatePaintSpec — schema clamps', () => {
  test('accepts a minimal valid spec', () => {
    expect(validatePaintSpec(baseSpec())).toEqual({ ok: true, errors: [] })
  })

  test('rejects non-object input', () => {
    expect(validatePaintSpec(null).ok).toBe(false)
    expect(validatePaintSpec('css string').ok).toBe(false)
    expect(validatePaintSpec(42).ok).toBe(false)
    expect(validatePaintSpec(undefined).ok).toBe(false)
  })

  test('rejects unknown versions (1 and 2 valid — 2 adds the scene block)', () => {
    expect(validatePaintSpec(baseSpec({ v: 2 })).ok).toBe(true)
    expect(validatePaintSpec(baseSpec({ v: 3 })).ok).toBe(false)
    expect(validatePaintSpec(baseSpec({ v: '1' })).ok).toBe(false)
  })

  test('rejects unknown base.type', () => {
    const spec = baseSpec()
    spec.base.type = 'radial'
    expect(validatePaintSpec(spec).ok).toBe(false)
  })

  test('clamps base.angle to integer 0-360', () => {
    // #5fafff, not #000fff: the synced compiler carries the legibility floor
    // (a paint's DIMMEST stop must clear 3:1 against the chat background), and
    // this fixture predated it — the ext copy had drifted behind the site.
    const stops = [
      { color: '#fff000', pos: 0 },
      { color: '#5fafff', pos: 100 },
    ]
    expect(validatePaintSpec(baseSpec({ base: { type: 'linear', angle: -1, stops } })).ok).toBe(false)
    expect(validatePaintSpec(baseSpec({ base: { type: 'linear', angle: 361, stops } })).ok).toBe(false)
    expect(validatePaintSpec(baseSpec({ base: { type: 'linear', angle: 45.5, stops } })).ok).toBe(false)
    expect(validatePaintSpec(baseSpec({ base: { type: 'linear', angle: 0, stops } })).ok).toBe(true)
    expect(validatePaintSpec(baseSpec({ base: { type: 'linear', angle: 360, stops } })).ok).toBe(true)
  })

  test('requires 1-8 stops', () => {
    expect(validatePaintSpec(baseSpec({ base: { type: 'solid', angle: 0, stops: [] } })).ok).toBe(false)
    const nine = Array.from({ length: 9 }, (_, i) => ({ color: '#ff0000', pos: i * 10 }))
    expect(validatePaintSpec(baseSpec({ base: { type: 'linear', angle: 0, stops: nine } })).ok).toBe(false)
    const eight = Array.from({ length: 8 }, (_, i) => ({ color: '#ff0000', pos: i * 10 }))
    expect(validatePaintSpec(baseSpec({ base: { type: 'linear', angle: 0, stops: eight } })).ok).toBe(true)
  })

  test('requires exactly 1 stop for solid type', () => {
    const spec = baseSpec({
      base: {
        type: 'solid',
        angle: 0,
        stops: [
          { color: '#ff0000', pos: 0 },
          { color: '#00ff00', pos: 100 },
        ],
      },
    })
    expect(validatePaintSpec(spec).ok).toBe(false)
  })

  test('rejects stop.pos out of 0-100 range', () => {
    expect(
      validatePaintSpec(baseSpec({ base: { type: 'solid', angle: 0, stops: [{ color: '#ff0000', pos: -1 }] } })).ok,
    ).toBe(false)
    expect(
      validatePaintSpec(baseSpec({ base: { type: 'solid', angle: 0, stops: [{ color: '#ff0000', pos: 101 }] } })).ok,
    ).toBe(false)
  })

  test('strict #rrggbb hex only — rejects shorthand, names, and non-hex', () => {
    const bad = ['#fff', 'red', 'ff8700', '#ff87001', 'rgb(255,0,0)', '#gggggg', '']
    for (const color of bad) {
      const spec = baseSpec({ base: { type: 'solid', angle: 0, stops: [{ color, pos: 0 }] } })
      expect(validatePaintSpec(spec).ok, `expected ${JSON.stringify(color)} to be rejected`).toBe(false)
    }
  })

  test('rejects effects array over 3 entries', () => {
    const spec = baseSpec({
      effects: [
        { id: 'heli', speed: 1 },
        { id: 'float', speed: 1 },
        { id: 'heart', speed: 1 },
        { id: 'wobble', speed: 1 },
      ],
    })
    expect(validatePaintSpec(spec).ok).toBe(false)
  })

  test('rejects unknown effect id', () => {
    expect(validatePaintSpec(baseSpec({ effects: [{ id: 'lightning', speed: 1 }] })).ok).toBe(false)
  })

  test('rejects duplicate effect ids', () => {
    const spec = baseSpec({
      effects: [
        { id: 'wave', speed: 1 },
        { id: 'wave', speed: 2 },
      ],
    })
    expect(validatePaintSpec(spec).ok).toBe(false)
  })

  test('rejects out-of-range speed', () => {
    for (const speed of [0.24, 3.01, 0, 4, -1, NaN, Infinity]) {
      expect(validatePaintSpec(baseSpec({ effects: [{ id: 'heli', speed }] })).ok, String(speed)).toBe(false)
    }
  })

  test('accepts in-range speed', () => {
    for (const speed of [0.25, 1, 1.5, 3]) {
      expect(validatePaintSpec(baseSpec({ effects: [{ id: 'heli', speed }] })).ok, String(speed)).toBe(true)
    }
  })

  test('rejects glow with bad color or strength', () => {
    expect(validatePaintSpec(baseSpec({ glow: { color: 'red', strength: 1 } })).ok).toBe(false)
    expect(validatePaintSpec(baseSpec({ glow: { color: '#ff0000', strength: 3 } })).ok).toBe(false)
    expect(validatePaintSpec(baseSpec({ glow: { color: '#ff0000', strength: 1 } })).ok).toBe(true)
    expect(validatePaintSpec(baseSpec({ glow: { color: '#ff0000', strength: 2 } })).ok).toBe(true)
  })
})

describe('validatePaintSpec — layer/slot compatibility rules', () => {
  test('rejects two paint-slot effects together', () => {
    const spec = baseSpec({
      effects: [
        { id: 'pan', speed: 1 },
        { id: 'glint', speed: 1 },
      ],
    })
    const result = validatePaintSpec(spec)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => /at most 1 paint-slot/.test(e))).toBe(true)
  })

  test('allows exactly 1 paint-slot effect', () => {
    for (const id of ['pan', 'conic', 'hue', 'glint', 'reveal', 'stripes', 'stardust', 'pulse']) {
      expect(validatePaintSpec(baseSpec({ effects: [{ id, speed: 1 }] })).ok, id).toBe(true)
    }
  })

  test('rejects 2 motion effects that animate the same property on the same target', () => {
    const spec = baseSpec({
      effects: [
        { id: 'coin', speed: 1 },
        { id: 'heli', speed: 1 },
      ],
    })
    const result = validatePaintSpec(spec)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => /conflicts/.test(e))).toBe(true)
  })

  test('accepts 2 motion effects with distinct signatures', () => {
    const spec = baseSpec({
      effects: [
        { id: 'wave', speed: 1 },
        { id: 'ripple', speed: 1 },
      ],
    })
    expect(validatePaintSpec(spec).ok).toBe(true)
  })

  test('accepts a paint effect + 2 compatible motion effects (max 3 total)', () => {
    const spec = baseSpec({
      effects: [
        { id: 'pan', speed: 1 },
        { id: 'heli', speed: 1 },
        { id: 'neon', speed: 1 },
      ],
    })
    expect(validatePaintSpec(spec).ok).toBe(true)
  })
})

describe('validatePaintSpec — luminance min-period enforcement (via compiler)', () => {
  test('luminance effects never compile below a 1s animation period', () => {
    for (const id of ['hue', 'ripple', 'neon']) {
      for (const speed of [0.25, 1, 2, 3]) {
        const spec = baseSpec({ effects: [{ id, speed }] })
        const css = compilePaintCss(spec, '.hsp-test', { hash: 'test' })
        // hs[pq]: a letter motion's keyframes carry the composited prefix now.
        const match = css.match(new RegExp(`hs[pq]_test_${id} ([0-9.]+)s`))
        expect(match, css).not.toBeNull()
        expect(Number(match[1])).toBeGreaterThanOrEqual(1)
      }
    }
  })
})

describe('paintNeedsSpans', () => {
  test('true for wave/ripple/tumble', () => {
    for (const id of ['wave', 'ripple', 'tumble']) {
      expect(paintNeedsSpans(baseSpec({ effects: [{ id, speed: 1 }] }))).toBe(true)
    }
  })
  test('false for other effects and no effects', () => {
    expect(paintNeedsSpans(baseSpec())).toBe(false)
    expect(paintNeedsSpans(baseSpec({ effects: [{ id: 'heli', speed: 1 }] }))).toBe(false)
  })
  test('false for null/undefined spec', () => {
    expect(paintNeedsSpans(null)).toBe(false)
    expect(paintNeedsSpans(undefined)).toBe(false)
  })
})

describe('hashPaintSpec — stability', () => {
  test('same spec produces the same hash', () => {
    const a = baseSpec({ effects: [{ id: 'pan', speed: 1.5 }] })
    const b = baseSpec({ effects: [{ id: 'pan', speed: 1.5 }] })
    expect(hashPaintSpec(a)).toBe(hashPaintSpec(b))
  })

  test('different specs produce different hashes', () => {
    const a = baseSpec({ effects: [{ id: 'pan', speed: 1 }] })
    const b = baseSpec({ effects: [{ id: 'pan', speed: 2 }] })
    expect(hashPaintSpec(a)).not.toBe(hashPaintSpec(b))
  })

  test('is insensitive to key insertion order in stop objects', () => {
    const a = {
      v: 1,
      base: { type: 'solid', angle: 0, stops: [{ color: '#ff8700', pos: 0 }] },
      effects: [],
      glow: null,
    }
    const b = {
      v: 1,
      base: { type: 'solid', stops: [{ pos: 0, color: '#ff8700' }], angle: 0 },
      effects: [],
      glow: null,
    }
    expect(hashPaintSpec(a)).toBe(hashPaintSpec(b))
  })

  test('hash is a short class/keyframe-name-safe string', () => {
    const h = hashPaintSpec(baseSpec())
    expect(typeof h).toBe('string')
    expect(h.length).toBeGreaterThan(0)
    expect(h.length).toBeLessThan(16)
    expect(/^[a-z0-9]+$/.test(h)).toBe(true)
  })
})

describe('compilePaintCss — structural checks', () => {
  test('solid base with no effects compiles a plain color rule, no gradient/animation', () => {
    const spec = baseSpec()
    const css = compilePaintCss(spec, '.hsp-abc123', { hash: 'abc123' })
    expect(css).toContain('.hsp-abc123>.hs-name{display:inline-block;color:#ff8700;}')
    expect(css).not.toContain('@keyframes')
    expect(css).not.toContain('background-clip')
  })

  test('linear base + pan effect compiles a background-clip gradient with animation + keyframes', () => {
    const spec = baseSpec({
      base: {
        type: 'linear',
        angle: 90,
        stops: [
          { color: '#ff0000', pos: 0 },
          { color: '#0000ff', pos: 100 },
        ],
      },
      effects: [{ id: 'pan', speed: 1 }],
    })
    const css = compilePaintCss(spec, '.hsp-xyz789', { hash: 'xyz789' })
    expect(css).toContain('background-clip:text')
    // steps(80), not linear: the fill's phase is rate-limited to
    // FILL_STEPS_PER_SECOND redraws a second (paint-core.steppedTiming,
    // raised 8->16 2026-09-16 — synced from the site).
    expect(css).toContain('animation:hsp_xyz789_pan 5s steps(80) infinite')
    expect(css).toContain('@keyframes hsp_xyz789_pan')
    expect(css).toContain('linear-gradient(90deg,')
    expect(css).toContain('#ff0000 100%')
  })

  // The themed presets (chrome/gold/fire/matrix/holo/rainbow/ice/lava) were
  // deleted on 2026-09-16 — a fixed palette that overrode the wearer's own
  // colours is the one way two people ended up identical, and the builder got
  // banded fills and pan's scale/loop/skew controls to rebuild those looks
  // from their own colours instead. There is no longer any effect that ignores
  // base stops, which is why the test that asserted one is gone rather than
  // ported.

  test('motion effect (heli) never touches background/color — layers transform only', () => {
    const spec = baseSpec({ effects: [{ id: 'heli', speed: 1 }] })
    const css = compilePaintCss(spec, '.hsp-heli1', { hash: 'heli1' })
    expect(css).toContain('transform:rotate(360deg)')
    expect(css).toContain('color:#ff8700')
  })

  test('letter-split effect (wave) emits ONE `span` rule, one animation per EFFECT, and no inherited phase', () => {
    const spec = baseSpec({ effects: [{ id: 'wave', speed: 1 }] })
    const css = compilePaintCss(spec, '.hsp-wave1', { hash: 'wave1' })
    expect(css.match(/\.hsp-wave1>\.hs-name>span\{/g)?.length).toBe(1)
    const spanRule = css.match(/\.hsp-wave1>\.hs-name>span\{[^}]*\}/)[0]
    // The glyph animates itself, with literal keyframes the compositor owns —
    // one per EFFECT, never one per property or per stop.
    expect(spanRule.match(/animation:/g)?.length).toBe(1)
    expect(spanRule).toContain('animation:hsq_wave1_wave')
    expect(css).toContain('@keyframes hsq_wave1_wave')
    // The stagger is a time offset now, riding the same delay as the
    // wall-clock phase lock.
    expect(spanRule).toContain('var(--i, 0)')
    // The parent drives nothing: an animated custom property that INHERITS
    // restyles the whole subtree every frame, which is what this replaced.
    expect(css).not.toContain('inherits:true')
    expect(css).not.toContain('--hsp-wave1-wave-ph')
  })

  // Regression (superseded 2026-09-10, then 2026-09-10 again): paint effect
  // (fire/pan/conic/hue/glint/reveal/themed) and per-letter motion (wave/
  // ripple/tumble) used to BOTH target `${selector} span`, so this block
  // originally verified they combined into one comma-listed rule instead of
  // clobbering. Letter motion moved to ONE Animation on the PARENT first
  // (buildLetterMotionCss); the paint slot stayed per-span for a moment
  // (a real device trace found a paint-slot fill combined with a
  // letter-split name still ran one Animation PER GLYPH — enough on its own
  // to blow the whole page's mobile animation budget off one multi-layer
  // name). buildPaintPhaseCss closed that gap the same way: paint is now
  // ALSO a parent-driven phase, so these verify the span carries NO
  // animation at all for either slot — every live Animation for a name
  // lives on the parent, comma-listed, regardless of letter count.
  test('pan (paint) + wave (motion): both animate the SPAN, comma-listed, one each', () => {
    const spec = baseSpec({
      base: {
        type: 'linear',
        angle: 90,
        stops: [
          { color: '#ff8700', pos: 0 },
          { color: '#d70000', pos: 100 },
        ],
      },
      effects: [
        { id: 'pan', speed: 1 },
        { id: 'wave', speed: 1 },
      ],
    })
    const css = compilePaintCss(spec, '.hsp-fw', { hash: 'fw' })
    // Anchored so a crowd-tier rule (`body.hs-paint-x .hsp-fw>.hs-name>span`)
    // is not counted as a second copy of the spec — the span only started
    // carrying tier rules when the fill's animation moved onto it.
    const spanRules = (css.match(/(^|\})[^{}]*\.hsp-fw>\.hs-name>span\{[^}]*\}/g) || []).filter(
      (r) => !r.includes('body.hs-paint-'),
    )
    expect(spanRules.length).toBe(1)
    const rule = spanRules[0]
    // Paint decls (background/clip) must still be present — not clobbered.
    expect(rule).toContain('background:linear-gradient(90deg, #ff8700')
    expect(rule).toContain('background-clip:text')
    expect(rule).toContain('background-position:')
    // ONE comma-listed shorthand, one entry per effect. The fill's animation
    // has to be HERE: `background-position` is declared on the span and
    // nowhere else, so running it on the name box animated nothing at all.
    expect(rule.match(/animation:/g).length).toBe(1)
    expect(rule).toMatch(/animation:hsp_fw_pan[^,]*, hsq_fw_wave[^;]*;/)
    // And the name box is left with nothing of its own to run.
    const parentAnim = (css.match(/\.hsp-fw>\.hs-name\{[^}]*\}/g) || []).find((r) => r.includes('animation:'))
    expect(parentAnim).toBeUndefined()
  })

  test('wave + ripple (two per-letter motions): ONE comma-listed shorthand, two staggers', () => {
    const spec = baseSpec({
      base: {
        type: 'linear',
        angle: 90,
        stops: [
          { color: '#ff8700', pos: 0 },
          { color: '#d70000', pos: 100 },
        ],
      },
      effects: [
        { id: 'wave', speed: 1 },
        { id: 'ripple', speed: 1 },
      ],
    })
    const css = compilePaintCss(spec, '.hsp-wr', { hash: 'wr' })
    const spanRules = css.match(/\.hsp-wr>\.hs-name>span\{[^}]*\}/g) || []
    expect(spanRules.length).toBe(1)
    expect(spanRules[0].match(/animation:/g).length).toBe(1)
    expect(spanRules[0]).toMatch(/animation:hsq_wr_wave[^,]*, hsq_wr_ripple[^;]*;/)
    expect(css).toContain('translateY')
    expect(css).toContain('hue-rotate')
    // ripple's wave travels the other way, so its per-glyph offset is POSITIVE
    // where wave's is negative — the sign the old `mod()` carried.
    expect(spanRules[0]).toContain(
      'animation-delay:calc(calc(-1 * mod(var(--hsp-t, 0s), 1.6s)) + var(--i, 0) * -0.09s),' +
        ' calc(calc(-1 * mod(var(--hsp-t, 0s), 2.4s)) + var(--i, 0) * 0.18s);',
    )
  })

  test('pan (paint) + tumble (motion): both on the span; only the perspective stays on the parent', () => {
    const spec = baseSpec({
      base: {
        type: 'linear',
        angle: 90,
        stops: [
          { color: '#ff8700', pos: 0 },
          { color: '#d70000', pos: 100 },
        ],
      },
      effects: [
        { id: 'pan', speed: 1 },
        { id: 'tumble', speed: 1 },
      ],
    })
    const css = compilePaintCss(spec, '.hsp-pt', { hash: 'pt' })
    const spanRules = (css.match(/(^|\})[^{}]*\.hsp-pt>\.hs-name>span\{[^}]*\}/g) || []).filter(
      (r) => !r.includes('body.hs-paint-'),
    )
    expect(spanRules.length).toBe(1)
    expect(spanRules[0]).toContain('background-position:')
    expect(spanRules[0]).toContain('transform-style:preserve-3d;')
    expect(spanRules[0]).toMatch(/animation:hsp_pt_pan[^,]*, hsq_pt_tumble[^;]*;/)
    // perspective is the one thing that genuinely belongs to the parent: a
    // glyph cannot give itself the vanishing point it rotates about.
    expect(css).toContain('.hsp-pt>.hs-name{perspective:300px;}')
  })

  test('split-without-paint (wave only): the name box runs nothing at all', () => {
    const spec = baseSpec({ effects: [{ id: 'wave', speed: 1 }] })
    const css = compilePaintCss(spec, '.hsp-w', { hash: 'w' })
    const spanRules = css.match(/\.hsp-w>\.hs-name>span\{[^}]*\}/g) || []
    expect(spanRules.length).toBe(1)
    expect(spanRules[0]).toMatch(/animation:hsq_w_wave[^;,]*;/)
    expect((css.match(/\.hsp-w>\.hs-name\{[^}]*\}/g) || []).find((r) => r.includes('animation:'))).toBeUndefined()
  })

  test('non-split paint + whole-name motion (pan + coin): ONE selector rule, both animations comma-listed', () => {
    // Two `.hsp-fc>.hs-name{animation:…}` rules on one selector do not compose — the
    // later won, so gold foil + heartbeat ran only the heartbeat. Self-level
    // animations merge like the spans always did.
    const spec = baseSpec({
      base: {
        type: 'linear',
        angle: 90,
        stops: [
          { color: '#ff8700', pos: 0 },
          { color: '#d70000', pos: 100 },
        ],
      },
      effects: [
        { id: 'pan', speed: 1 },
        { id: 'coin', speed: 1 },
      ],
    })
    const css = compilePaintCss(spec, '.hsp-fc', { hash: 'fc' })
    expect(css).not.toContain('>span{')
    const animRules = css.match(/\.hsp-fc>\.hs-name\{[^}]*animation:[^}]*\}/g) || []
    expect(animRules.length).toBe(1)
    expect(animRules[0]).toMatch(/animation:hsp_fc_pan[^,]*, hsp_fc_coin/)
  })

  test('conic effect namespaces its @property phase var per-hash (no cross-user collision)', () => {
    const specA = baseSpec({ effects: [{ id: 'conic', speed: 1 }] })
    const cssA = compilePaintCss(specA, '.hsp-a1', { hash: 'a1' })
    const cssB = compilePaintCss(specA, '.hsp-b2', { hash: 'b2' })
    expect(cssA).toContain('--hsp-a1-conic-ph')
    expect(cssB).toContain('--hsp-b2-conic-ph')
    expect(cssA).not.toContain('--hsp-b2-conic-ph')
  })

  test('glow with no neon effect emits a static (non-animated) text-shadow', () => {
    const spec = baseSpec({ glow: { color: '#00ff00', strength: 2 } })
    const css = compilePaintCss(spec, '.hsp-glow1', { hash: 'glow1' })
    expect(css).toContain('text-shadow:0 0 10px #00ff00cc, 0 0 26px #00ff0066')
    expect(css).not.toContain('@keyframes hsp_glow1_neon')
  })

  test('returns empty string for invalid inputs rather than throwing', () => {
    expect(compilePaintCss(null, '.hsp-x')).toBe('')
    expect(compilePaintCss({}, '')).toBe('')
    expect(compilePaintCss(undefined, '.hsp-x')).toBe('')
  })
})

describe('compilePaintCss — adversarial injection resistance', () => {
  const injectionColor = '#ffffff; } body { background: url(https://evil.example/x) } .x {color'
  const injectionId = 'pan"; } .evil { color: red } .x {animation-name:"pan'
  const injectionSelector = '.hsp-x{}</style><script>alert(1)</script><style>.y'

  test('rejected color never reaches compiled CSS verbatim — validator blocks it first', () => {
    const spec = baseSpec({ base: { type: 'solid', angle: 0, stops: [{ color: injectionColor, pos: 0 }] } })
    expect(validatePaintSpec(spec).ok).toBe(false)
  })

  test('compiler never emits the raw injected color even without validating first (defense in depth)', () => {
    const spec = baseSpec({ base: { type: 'solid', angle: 0, stops: [{ color: injectionColor, pos: 0 }] } })
    const css = compilePaintCss(spec, '.hsp-inj1', { hash: 'inj1' })
    expect(css).not.toContain(injectionColor)
    expect(css).not.toContain('url(https://evil.example')
    expect(css).not.toContain('</style>')
    expect(css).not.toContain('<script>')
  })

  test('unknown/injected effect id is silently skipped, not interpolated', () => {
    const spec = baseSpec({ effects: [{ id: injectionId, speed: 1 }] })
    expect(validatePaintSpec(spec).ok).toBe(false)
    const css = compilePaintCss(spec, '.hsp-inj2', { hash: 'inj2' })
    expect(css).not.toContain(injectionId)
    expect(css).not.toContain('animation-name:"pan')
  })

  test('selector is echoed verbatim as CSS text, never parsed/executed', () => {
    const spec = baseSpec()
    const css = compilePaintCss(spec, injectionSelector, { hash: 'x' })
    expect(css.startsWith(injectionSelector)).toBe(true)
    expect(css.indexOf(injectionSelector)).toBe(0)
  })
})

describe('EFFECTS enum — the catalog, correctly classified', () => {
  // chrome/fire/gold/holo/ice/lava/matrix/rainbow left on 2026-09-16 — fixed
  // palettes that overrode the wearer's own colours, replaced by banded fills
  // and pan's scale/loop/skew controls in the builder.
  const PAINT = ['conic', 'glint', 'hue', 'pan', 'pulse', 'reveal', 'stardust', 'stripes']
  const MOTION = [
    'coin',
    'flicker',
    'float',
    'glitch',
    'heart',
    'heli',
    'hop',
    'jitter',
    'neon',
    'ripple',
    'swing',
    'tumble',
    'twirl',
    'type',
    'wave',
    'wobble',
  ]

  test('has exactly these ids, no more, no less', () => {
    expect(Object.keys(EFFECTS).sort()).toEqual([...PAINT, ...MOTION].sort())
  })

  test('paint-slot ids', () => {
    const paintIds = Object.entries(EFFECTS)
      .filter(([, m]) => m.slot === 'paint')
      .map(([id]) => id)
      .sort()
    expect(paintIds).toEqual(PAINT)
  })

  test('motion-slot ids, every one carrying a sig', () => {
    const motion = Object.entries(EFFECTS).filter(([, m]) => m.slot === 'motion')
    expect(motion.map(([id]) => id).sort()).toEqual(MOTION)
    for (const [id, m] of motion) expect(m.sig, id).toMatch(/^(self|letter):(transform|filter|shadow|opacity)$/)
  })

  test('luminance-changing effects are exactly the ones that change luminance', () => {
    const lumIds = Object.entries(EFFECTS)
      .filter(([, m]) => m.luminance)
      .map(([id]) => id)
      .sort()
    expect(lumIds).toEqual(['flicker', 'hue', 'neon', 'pulse', 'ripple', 'type'])
  })
})

// Phase-lock: every animated rule folds the element's mount stamp (--hsp-t)
// onto its cycle so all copies of a name animate in the same phase. The fold
// period must be the FULL visual cycle — 2× the duration for
// alternate-direction animations, or odd/even iterations run mirrored.
describe('wall-clock phase sync (--hsp-t)', () => {
  const baseOnly = {
    v: 1,
    base: {
      type: 'linear',
      angle: 90,
      stops: [
        { color: '#ff8700', pos: 0 },
        { color: '#d70000', pos: 100 },
      ],
    },
    glow: null,
  }

  test('alternate-direction paint (pan, loop:bounce) drives its phase over 2x its raw effect duration', () => {
    // fire used to be a CSS `alternate` animation, where the browser did the
    // there-and-back doubling and the fold math had to double the duration
    // separately to match. Now the round trip is baked into ONE linear phase
    // Animation (see paintPhaseDriver's roundTrip branch), so the
    // animation's own declared duration already IS the fold period — and
    // that duration is itself 2x the raw effect duration.
    const css = compilePaintCss({ ...baseOnly, effects: [{ id: 'pan', speed: 1, loop: 'bounce' }] }, '.hsp-f', {
      hash: 'f',
    })
    const dur = Number(css.match(/animation:hsp_f_pan ([\d.]+)s/)[1])
    const period = Number(css.match(/mod\(var\(--hsp-t, 0s\), ([\d.]+)s\)/)[1])
    expect(dur).toBeCloseTo(EFFECTS.pan.basePeriod * 2, 3)
    expect(period).toBeCloseTo(dur, 3)
  })

  test('normal-direction paint (pan) folds over exactly its raw effect duration', () => {
    const css = compilePaintCss({ ...baseOnly, effects: [{ id: 'pan', speed: 1 }] }, '.hsp-p', { hash: 'p' })
    const dur = Number(css.match(/animation:hsp_p_pan ([\d.]+)s/)[1])
    const period = Number(css.match(/mod\(var\(--hsp-t, 0s\), ([\d.]+)s\)/)[1])
    expect(dur).toBeCloseTo(EFFECTS.pan.basePeriod, 3)
    expect(period).toBeCloseTo(dur, 3)
  })

  test('whole-name motion (coin) carries the fold on its own rule', () => {
    const css = compilePaintCss({ ...baseOnly, effects: [{ id: 'coin', speed: 1 }] }, '.hsp-c', { hash: 'c' })
    expect(css).toMatch(
      /animation:hsp_c_coin [\d.]+s[^;]*;animation-delay:calc\(-1 \* mod\(var\(--hsp-t, 0s\), [\d.]+s\)\);/,
    )
  })

  test('paintPhaseNow returns a seconds stamp usable as a CSS time', () => {
    expect(paintPhaseNow()).toMatch(/^\d+\.\d{3}s$/)
  })
})

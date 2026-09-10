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
        { id: 'gold', speed: 1 },
      ],
    })
    const result = validatePaintSpec(spec)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => /at most 1 paint-slot/.test(e))).toBe(true)
  })

  test('allows exactly 1 paint-slot effect', () => {
    for (const id of ['pan', 'conic', 'hue', 'glint', 'chrome', 'gold', 'fire', 'matrix', 'holo', 'reveal']) {
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
        const match = css.match(new RegExp(`hsp_test_${id} ([0-9.]+)s`))
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
    expect(css).toContain('.hsp-abc123{display:inline-block;color:#ff8700;}')
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
    expect(css).toContain('animation:hsp_xyz789_pan 5s linear infinite')
    expect(css).toContain('@keyframes hsp_xyz789_pan')
    expect(css).toContain('linear-gradient(90deg,')
    expect(css).toContain('#ff0000 100%')
  })

  test('themed preset (gold) ignores base stops entirely — fixed palette', () => {
    const spec = baseSpec({
      base: {
        type: 'linear',
        angle: 0,
        stops: [
          { color: '#00ff00', pos: 0 },
          { color: '#0000ff', pos: 100 },
        ],
      },
      effects: [{ id: 'gold', speed: 1 }],
    })
    const css = compilePaintCss(spec, '.hsp-gold1', { hash: 'gold1' })
    expect(css).not.toContain('#00ff00')
    expect(css).toContain('#ffd700')
  })

  test('motion effect (heli) never touches background/color — layers transform only', () => {
    const spec = baseSpec({ effects: [{ id: 'heli', speed: 1 }] })
    const css = compilePaintCss(spec, '.hsp-heli1', { hash: 'heli1' })
    expect(css).toContain('transform:rotate(360deg)')
    expect(css).toContain('color:#ff8700')
  })

  test('letter-split effect (wave) emits ONE `span` rule and ONE parent-level Animation, not one per glyph', () => {
    const spec = baseSpec({ effects: [{ id: 'wave', speed: 1 }] })
    const css = compilePaintCss(spec, '.hsp-wave1', { hash: 'wave1' })
    // Single combined span rule — display:inline-block + the calc() transform
    // live together, not a separate display-only rule.
    expect(css.match(/\.hsp-wave1 span\{/g)?.length).toBe(1)
    // The span itself carries NO `animation:` — one Animation per glyph is
    // exactly the cost this shape replaced (see buildLetterMotionCss).
    const spanRule = css.match(/\.hsp-wave1 span\{[^}]*\}/)[0]
    expect(spanRule).not.toContain('animation:')
    expect(spanRule).toContain('var(--i)')
    expect(spanRule).toContain('translateY')
    // The ONE real Animation lives on the parent, driving a registered
    // (smoothly interpolable) phase property every span reads back.
    const parentRule = css.match(/\.hsp-wave1\{[^}]*\}/g).find((r) => r.includes('animation:')) || ''
    expect(parentRule).toContain('animation:hsp_wave1_wave')
    expect(css).toContain("@property --hsp-wave1-wave-ph{syntax:'<number>'")
  })

  // Regression (superseded 2026-09-10): paint effect (fire/pan/conic/hue/
  // glint/reveal/themed) and per-letter motion (wave/ripple/tumble) used to
  // BOTH target `${selector} span`, so this block originally verified they
  // combined into one comma-listed rule instead of clobbering. Letter motion
  // now drives ONE Animation on the PARENT instead (see
  // buildLetterMotionCss) — a real device trace found the old per-glyph
  // Animation multiplication was the dominant mobile GPU cost. The paint
  // slot is unchanged (still per-span, still phase-locked), so these now
  // verify the two live on DIFFERENT selectors with no clobber, and that a
  // combo of two letter motions still merges via the same comma-list
  // mechanism whole-name motions (coin/heli/etc) already used.
  test('fire (paint) + wave (motion): span keeps ONLY the paint animation; wave is one Animation on the parent', () => {
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
        { id: 'fire', speed: 1 },
        { id: 'wave', speed: 1 },
      ],
    })
    const css = compilePaintCss(spec, '.hsp-fw', { hash: 'fw' })
    const spanRules = css.match(/\.hsp-fw span\{[^}]*\}/g) || []
    expect(spanRules.length).toBe(1)
    const rule = spanRules[0]
    // Only fire's animation — wave no longer touches the span at all.
    expect(rule).toMatch(/animation:hsp_fw_fire[^,;]*;/)
    expect(rule).not.toContain('hsp_fw_wave')
    expect(rule).toMatch(/animation-delay:calc\(-1 \* mod\(var\(--hsp-t, 0s\), [\d.]+s\)\);/)
    // Paint decls (background/clip) must still be present — not clobbered.
    expect(rule).toContain('background:linear-gradient(0deg, #c00000')
    expect(rule).toContain('background-clip:text')
    // wave's transform lives on the span as a static (unanimated) calc().
    expect(rule).toContain('var(--i)')
    expect(rule).toContain('translateY')
    // The ONE wave Animation is on the parent.
    const parentRule = css.match(/\.hsp-fw\{[^}]*\}/g).find((r) => r.includes('animation:')) || ''
    expect(parentRule).toContain('animation:hsp_fw_wave')
  })

  test('wave + ripple (two per-letter motions, no paint): both merge into ONE comma-listed Animation on the parent', () => {
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
    const spanRules = css.match(/\.hsp-wr span\{[^}]*\}/g) || []
    expect(spanRules.length).toBe(1)
    // No Animation on the span at all — both motions are parent-driven.
    expect(spanRules[0]).not.toContain('animation:')
    expect(spanRules[0]).toContain('translateY')
    expect(spanRules[0]).toContain('hue-rotate')
    const parentRule = css.match(/\.hsp-wr\{[^}]*\}/g).find((r) => r.includes('animation:')) || ''
    expect(parentRule).toMatch(/animation:hsp_wr_wave[^,]*, hsp_wr_ripple[^;]*;/)
  })

  test('pan (paint) + tumble (motion): span keeps only pan; tumble is one Animation + perspective on the parent', () => {
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
    const spanRules = css.match(/\.hsp-pt span\{[^}]*\}/g) || []
    expect(spanRules.length).toBe(1)
    expect(spanRules[0]).toMatch(/animation:hsp_pt_pan[^,;]*;/)
    expect(spanRules[0]).not.toContain('hsp_pt_tumble')
    expect(spanRules[0]).toMatch(/animation-delay:calc\(-1 \* mod\(var\(--hsp-t, 0s\), [\d.]+s\)\);/)
    expect(spanRules[0]).toContain('transform-style:preserve-3d;')
    const parentRule = css.match(/\.hsp-pt\{[^}]*\}/g).find((r) => r.includes('animation:')) || ''
    expect(parentRule).toContain('animation:hsp_pt_tumble')
    expect(css).toContain('.hsp-pt{perspective:300px;}')
  })

  test('split-without-paint (wave only): span carries no animation at all, one parent Animation', () => {
    const spec = baseSpec({ effects: [{ id: 'wave', speed: 1 }] })
    const css = compilePaintCss(spec, '.hsp-w', { hash: 'w' })
    const spanRules = css.match(/\.hsp-w span\{[^}]*\}/g) || []
    expect(spanRules.length).toBe(1)
    expect(spanRules[0]).not.toContain('animation:')
    const parentRule = css.match(/\.hsp-w\{[^}]*\}/g).find((r) => r.includes('animation:')) || ''
    expect(parentRule).toMatch(/animation:hsp_w_wave[^;,]*;/)
  })

  test('non-split paint + whole-name motion (fire + coin): ONE selector rule, both animations comma-listed', () => {
    // Two `.hsp-fc{animation:…}` rules on one selector do not compose — the
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
        { id: 'fire', speed: 1 },
        { id: 'coin', speed: 1 },
      ],
    })
    const css = compilePaintCss(spec, '.hsp-fc', { hash: 'fc' })
    expect(css).not.toContain(' span{')
    const animRules = css.match(/\.hsp-fc\{[^}]*animation:[^}]*\}/g) || []
    expect(animRules.length).toBe(1)
    expect(animRules[0]).toMatch(/animation:hsp_fc_fire[^,]*, hsp_fc_coin/)
  })

  test('conic effect namespaces its @property angle var per-hash (no cross-user collision)', () => {
    const specA = baseSpec({ effects: [{ id: 'conic', speed: 1 }] })
    const cssA = compilePaintCss(specA, '.hsp-a1', { hash: 'a1' })
    const cssB = compilePaintCss(specA, '.hsp-b2', { hash: 'b2' })
    expect(cssA).toContain('--hsp-a1-ang')
    expect(cssB).toContain('--hsp-b2-ang')
    expect(cssA).not.toContain('--hsp-b2-ang')
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
  const PAINT = [
    'chrome',
    'conic',
    'fire',
    'glint',
    'gold',
    'holo',
    'hue',
    'ice',
    'lava',
    'matrix',
    'pan',
    'pulse',
    'rainbow',
    'reveal',
    'stardust',
    'stripes',
  ]
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

  test('alternate-direction paint (fire) folds over 2x its duration', () => {
    const css = compilePaintCss({ ...baseOnly, effects: [{ id: 'fire', speed: 1 }] }, '.hsp-f', { hash: 'f' })
    const dur = Number(css.match(/animation:hsp_f_fire ([\d.]+)s/)[1])
    const period = Number(css.match(/mod\(var\(--hsp-t, 0s\), ([\d.]+)s\)/)[1])
    expect(period).toBeCloseTo(dur * 2, 3)
  })

  test('normal-direction paint (pan) folds over exactly its duration', () => {
    const css = compilePaintCss({ ...baseOnly, effects: [{ id: 'pan', speed: 1 }] }, '.hsp-p', { hash: 'p' })
    const dur = Number(css.match(/animation:hsp_p_pan ([\d.]+)s/)[1])
    const period = Number(css.match(/mod\(var\(--hsp-t, 0s\), ([\d.]+)s\)/)[1])
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

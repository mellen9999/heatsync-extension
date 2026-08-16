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

  test('letter-split effect (wave) emits ONE `span` rule with --i delay', () => {
    const spec = baseSpec({ effects: [{ id: 'wave', speed: 1 }] })
    const css = compilePaintCss(spec, '.hsp-wave1', { hash: 'wave1' })
    // Single combined rule — display:inline-block + animation live together,
    // not a separate display-only rule followed by a separate animation rule.
    expect(css.match(/\.hsp-wave1 span\{/g)?.length).toBe(1)
    expect(css).toContain('.hsp-wave1 span{display:inline-block;animation:hsp_wave1_wave')
    expect(css).toContain('var(--i)')
  })

  // Regression: paint effect (fire/pan/conic/hue/glint/reveal/themed) and
  // per-letter motion (wave/ripple/tumble) both target `${selector} span`
  // when the name is split. Two separate rules each setting the `animation`
  // shorthand on that same selector don't compose — the later rule wins
  // outright and blanks the earlier one's animation-name (verified live:
  // the fire gradient rendered fully static, only the wave transform ran).
  // The fix combines every span-targeted animation into ONE rule with
  // comma-listed animation/animation-delay.
  test('fire (paint) + wave (motion): one span rule, two comma-listed animations, paint delay phase-locked', () => {
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
    expect(rule).toMatch(/animation:hsp_fw_fire[^,]*, hsp_fw_wave[^;]*;/)
    // paint slot delay = wall-clock phase fold; motion slot keeps the --i stagger plus the fold
    expect(rule).toMatch(
      /animation-delay:calc\(-1 \* mod\(var\(--hsp-t, 0s\), [\d.]+s\)\), calc\(var\(--i\)[^;]*mod\(var\(--hsp-t, 0s\)[^;]*\);/,
    )
    // Paint decls (background/clip) must still be present — not clobbered.
    expect(rule).toContain('background:linear-gradient(0deg, #870000')
    expect(rule).toContain('background-clip:text')
  })

  test('wave + ripple (two per-letter motions, no paint): both animations combine, no paint slot', () => {
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
    expect(spanRules[0]).toMatch(/animation:hsp_wr_wave[^,]*, hsp_wr_ripple[^;]*;/)
    expect(spanRules[0]).toMatch(
      /animation-delay:calc\(var\(--i\) \* 0\.0900s - mod\(var\(--hsp-t, 0s\), [\d.]+s\)\), calc\(var\(--i\) \* -0\.1800s - mod\(var\(--hsp-t, 0s\), [\d.]+s\)\);/,
    )
  })

  test('pan (paint) + tumble (motion): one span rule; tumble perspective stays a separate parent rule', () => {
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
    expect(spanRules[0]).toMatch(/animation:hsp_pt_pan[^,]*, hsp_pt_tumble[^;]*;/)
    expect(spanRules[0]).toMatch(
      /animation-delay:calc\(-1 \* mod\(var\(--hsp-t, 0s\), [\d.]+s\)\), calc\(var\(--i\)[^;]*mod\(var\(--hsp-t, 0s\)[^;]*\);/,
    )
    expect(spanRules[0]).toContain('transform-style:preserve-3d;')
    expect(css).toContain('.hsp-pt{perspective:300px;}')
  })

  test('split-without-paint (wave only): single animation, still fine, one rule', () => {
    const spec = baseSpec({ effects: [{ id: 'wave', speed: 1 }] })
    const css = compilePaintCss(spec, '.hsp-w', { hash: 'w' })
    const spanRules = css.match(/\.hsp-w span\{[^}]*\}/g) || []
    expect(spanRules.length).toBe(1)
    expect(spanRules[0]).toMatch(/animation:hsp_w_wave[^;,]*;/)
  })

  test('non-split paint + whole-name motion (fire + coin) is untouched — separate rules, out of scope here', () => {
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
    expect(css.match(/\.hsp-fc\{[^}]*animation:/g)?.length).toBe(2)
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

describe('EFFECTS enum — exactly the 20 phase-1 effects, correctly classified', () => {
  const EXPECTED_IDS = [
    'pan',
    'conic',
    'hue',
    'wave',
    'ripple',
    'coin',
    'heli',
    'glint',
    'neon',
    'chrome',
    'gold',
    'fire',
    'matrix',
    'holo',
    'float',
    'heart',
    'reveal',
    'wobble',
    'swing',
    'tumble',
  ]

  test('has exactly the 20 required ids, no more, no less', () => {
    expect(Object.keys(EFFECTS).sort()).toEqual([...EXPECTED_IDS].sort())
  })

  test('paint-slot ids are exactly pan/conic/hue/glint/chrome/gold/fire/matrix/holo/reveal', () => {
    const paintIds = Object.entries(EFFECTS)
      .filter(([, m]) => m.slot === 'paint')
      .map(([id]) => id)
      .sort()
    expect(paintIds).toEqual(['chrome', 'conic', 'fire', 'glint', 'gold', 'holo', 'hue', 'matrix', 'pan', 'reveal'])
  })

  test('only hue/ripple/neon are classified as luminance-changing', () => {
    const lumIds = Object.entries(EFFECTS)
      .filter(([, m]) => m.luminance)
      .map(([id]) => id)
      .sort()
    expect(lumIds).toEqual(['hue', 'neon', 'ripple'])
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

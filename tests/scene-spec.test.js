import { describe, expect, test } from 'bun:test'
import { compilePaintCss, paintNeedsSpans, validatePaintSpec } from '../src/lib/paint-spec.js'

// Smoke-test coverage for the ext's synced copy of scene paints v2 (scene-spec.js
// + paint-core.js) — the full suite lives in the monorepo; this proves the ext
// bundle's copies compile the same diorama CSS and keep the same guard rails.

function v2Spec(scene, overrides = {}) {
  return {
    v: 2,
    base: { type: 'solid', angle: 0, stops: [{ color: '#ff8700', pos: 0 }] },
    effects: [],
    glow: null,
    scene,
    ...overrides,
  }
}

const DAWN_FOG = {
  backdrop: { id: 'dawn', variant: 0, speed: 1 },
  weather: { id: 'fog', variant: 0, density: 2, speed: 1 },
}

describe('scene paints v2 — ext synced copy', () => {
  test('accepts and compiles the dawn+fog scene (plate + weather pseudos)', () => {
    const spec = v2Spec(DAWN_FOG)
    expect(validatePaintSpec(spec).ok).toBe(true)
    const css = compilePaintCss(spec, '.x')
    expect(css).toContain('.x::before{')
    expect(css).toContain('.x::after{')
    expect(css).toContain('position:relative;isolation:isolate;')
  })

  test('weather without backdrop rejected; unknown ids never reach CSS', () => {
    expect(validatePaintSpec(v2Spec({ weather: { id: 'rain' } })).ok).toBe(false)
    const css = compilePaintCss(v2Spec({ backdrop: { id: 'evil"};</style>' } }), '.x')
    expect(css).not.toContain('evil')
  })

  test('scene + clip-text fill forces letter-split (paint-order rule)', () => {
    expect(paintNeedsSpans(v2Spec(DAWN_FOG))).toBe(false)
    expect(
      paintNeedsSpans(
        v2Spec(DAWN_FOG, {
          base: {
            type: 'linear',
            angle: 90,
            stops: [
              { color: '#ffd700', pos: 0 },
              { color: '#ff8700', pos: 100 },
            ],
          },
        }),
      ),
    ).toBe(true)
  })

  test('static mode = hero frame, zero animation', () => {
    const css = compilePaintCss(v2Spec(DAWN_FOG), '.x', { static: true })
    expect(css).toContain('::before')
    expect(css).not.toContain('@keyframes')
  })
})

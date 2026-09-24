import { describe, expect, test } from 'bun:test'
import { validatePaintSpec } from '../src/lib/paint-authoring.js'
import { compilePaintCss, paintNeedsSpans } from '../src/lib/paint-spec.js'
import { sceneBoxCounts } from '../src/lib/scene-spec.js'

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
  // A band is drawn either as one pseudo carrying a comma list of layers, or —
  // once it converted to transform-driven motion — as one `<i><b></b></i>` box
  // per layer. Both must draw SOMETHING; naming only the pseudo would make this
  // pass by finding nothing the moment a scene converts.
  const drawsBothBands = (css) =>
    (css.includes('::before{') && css.includes('::after{')) ||
    (css.match(/>i:nth-of-type\(\d+\)>b\{/g) || []).length >= 2

  test('accepts and compiles the dawn+fog scene (plate + weather planes)', () => {
    const spec = v2Spec(DAWN_FOG)
    expect(validatePaintSpec(spec).ok).toBe(true)
    const css = compilePaintCss(spec, '.x')
    expect(drawsBothBands(css)).toBe(true)
    expect(css).toContain('background:')
    expect(css).toContain('position:relative;isolation:isolate;')
  })

  test('a scene emits exactly as many plane boxes as its markup asks for', () => {
    // The ext builds its markup in its OWN function (hsPaintNameHtml), so the
    // count has to survive a second implementation. It compared `mode ===
    // 'wrap'` exactly until the mode grew a `+N` suffix, at which point every
    // scened name would have rendered as bare text.
    const spec = v2Spec(DAWN_FOG)
    const css = compilePaintCss(spec, '.x')
    const addressed = new Set([...css.matchAll(/\.x>i:nth-of-type\((\d+)\)\{/g)].map((m) => Number(m[1])))
    expect(addressed.size).toBe(sceneBoxCounts(spec.scene).total)
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
    expect(css).toContain('background:')
    expect(css).not.toContain('@keyframes')
  })
})

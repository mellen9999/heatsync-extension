import { describe, expect, test } from 'bun:test'
import { compilePaintCss, paintExtraWeight } from '../src/lib/paint-spec.js'

// An image fill is a 7TV paint picture with fallback stops. The compiler is the
// site's, byte for byte; this pins what the overlay relies on: the url sits in
// the class rule, static mode paints the first frame, a still image never asks
// for one, and an src off the paint cdn never reaches url().
const SRC = 'https://cdn.7tv.app/paint/01ABC/layer/01DEF/1x.webp'
const STILL = 'https://cdn.7tv.app/paint/01ABC/layer/01DEF/1x_static.webp'
const spec = (layer) => ({
  v: 1,
  base: { type: 'solid', angle: 0, stops: [{ color: '#ff0000', pos: 0 }] },
  effects: [],
  glow: null,
  underlay: 'name',
  fill: {
    angle: 90,
    hue: null,
    breathe: null,
    layers: [{ kind: 'image', src: SRC, anim: true, stops: [{ color: '#e4e4e4', pos: 0 }], ...layer }],
  },
})

describe('image fill layer', () => {
  test('animated: url in the class rule, first frame for static mode and the budget rule', () => {
    const css = compilePaintCss(spec(), '.hsp-x')
    expect(css).toContain(
      `background-image:url("${SRC}");background-size:100% 100%;background-position:0% 0%;background-repeat:no-repeat;`,
    )
    expect(css).toContain(`.hs-paint-over-budget.hsp-x>.hs-name{background-image:url("${STILL}");}`)
    const still = compilePaintCss(spec(), '.hsp-x', { static: true })
    expect(still).toContain(`url("${STILL}")`)
    expect(still).not.toContain(SRC)
  })
  test('a still image paints itself and never asks for a 1x_static', () => {
    for (const opts of [{}, { static: true }]) {
      const css = compilePaintCss(spec({ anim: false }), '.hsp-x', opts)
      expect(css).toContain(`url("${SRC}")`)
      expect(css).not.toContain('1x_static')
    }
  })
  test('an src off the paint cdn draws the fallback stops, never a url()', () => {
    expect(compilePaintCss(spec({ src: 'https://example.com/a.png' }), '.hsp-x')).not.toContain('url(')
  })
  test('an animated image weighs 3 on the budget, a still one 0', () => {
    expect(paintExtraWeight(spec())).toBe(3)
    expect(paintExtraWeight(spec({ anim: false }))).toBe(0)
  })
})

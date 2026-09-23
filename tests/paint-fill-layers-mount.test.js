/**
 * paint-spec.test.js (parity) asserts the COMPILED CSS carries a `.hs-masked`
 * selector for a `fill` spec. It says nothing about the RUNTIME half — whether
 * paints.js actually mounts the mask + moving boxes lib/fill-layers.js and
 * lib/glyph-mask.js exist to build. This file runs that pipeline against a
 * hand-built DOM (this repo carries no jsdom/happy-dom — see paints.test.js's
 * own note) and asserts the resulting nodes, mirroring the site's
 * tests/client/the-composited-fill-reaches-a-real-name.test.js.
 *
 * The fake canvas is the same trick that file uses: no real canvas 2d context
 * exists here either, so glyph-mask.js's build() gets a duck-typed one with
 * just enough surface (font/fillStyle/textBaseline/scale/fillText/measureText)
 * to rasterise a fake letterform and hand back a class + advance.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mountFillLayers, unmountFillLayers } from '../src/lib/fill-layers.js'
import { maskFor, maskForText, _resetForTests as resetGlyphMaskCache, supported } from '../src/lib/glyph-mask.js'
import {
  compiledCssHasCompositedFill,
  compilePaintCss,
  compositedFillPlan,
  FILL_LAYER_CLASS,
  FILL_WRAP_CLASS,
  hashPaintSpec,
  MASKED_CLASS,
  NAME_BOX_CLASS,
  paintMarkupMode,
  paintNameHtmlFor,
  paintNeedsSpans,
  paintPhaseNow,
  renderSpecOf,
} from '../src/lib/paint-spec.js'
import { escapeHtml } from '../src/lib/utils.js'
import { _applyHsGlyphMasksForTests, setHsPaintEntry } from '../src/multichat/paints.js'

// ── a duck-typed DOM, just enough for glyph-mask.js + fill-layers.js ────────
// Both are dependency-free leaves synced verbatim from the site (they only
// ever touch classList/style/dataset/appendChild/querySelector(All) and, for
// glyph-mask's rule sheet, a <style> with insertRule/deleteRule) — the same
// small surface paints.test.js's fakeAnchor already covers for the simpler
// (non-composited) paths.
function matchesClause(el, clause) {
  const m = clause.trim().match(/^([a-zA-Z]*)((?:\.[\w-]+)*)$/)
  if (!m) return false
  const [, tag, classes] = m
  if (tag && el.tagName?.toLowerCase() !== tag.toLowerCase()) return false
  for (const c of classes.matchAll(/\.([\w-]+)/g)) {
    if (!el.classList.contains(c[1])) return false
  }
  return true
}

function makeFakeElement(tag) {
  const classes = new Set()
  const styleProps = new Map()
  const attrs = new Map()
  const el = {
    tagName: tag.toUpperCase(),
    dataset: {},
    children: [],
    parentElement: null,
    get parentNode() {
      return el.parentElement
    },
    isConnected: false,
    _text: '',
    get textContent() {
      return el._text
    },
    set textContent(v) {
      el._text = String(v)
      el.children.length = 0
    },
    get className() {
      return [...classes].join(' ')
    },
    set className(v) {
      classes.clear()
      for (const c of String(v).split(/\s+/)) if (c) classes.add(c)
    },
    classList: {
      contains: (c) => classes.has(c),
      add: (...cs) => {
        for (const c of cs) classes.add(c)
      },
      remove: (...cs) => {
        for (const c of cs) classes.delete(c)
      },
      [Symbol.iterator]: () => classes[Symbol.iterator](),
    },
    style: {
      getPropertyValue: (k) => styleProps.get(k) || '',
      setProperty: (k, v) => styleProps.set(k, v),
      removeProperty: (k) => styleProps.delete(k),
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    hasAttribute: (k) => attrs.has(k),
    appendChild(child) {
      child.parentElement = el
      child.isConnected = el.isConnected
      el.children.push(child)
      return child
    },
    removeChild(child) {
      const i = el.children.indexOf(child)
      if (i !== -1) el.children.splice(i, 1)
      child.parentElement = null
      return child
    },
    remove() {
      el.parentElement?.removeChild(el)
    },
    querySelectorAll(sel) {
      const clauses = sel.split(',').map((s) => s.trim())
      const out = []
      const walk = (node) => {
        for (const c of node.children) {
          if (clauses.some((cl) => matchesClause(c, cl))) out.push(c)
          walk(c)
        }
      }
      walk(el)
      return out
    },
    querySelector(sel) {
      return el.querySelectorAll(sel)[0] || null
    },
  }
  return el
}

function makeFakeCanvas() {
  const ctx2d = {
    font: '',
    fillStyle: '',
    textBaseline: '',
    scale() {},
    fillText() {},
    measureText: (t) => ({
      width: [...String(t)].length * 6,
      fontBoundingBoxAscent: 10,
      fontBoundingBoxDescent: 2,
    }),
  }
  return { width: 0, height: 0, getContext: () => ctx2d, toDataURL: () => 'data:image/png;base64,MASK' }
}

function makeFakeDocument() {
  const doc = {
    createElement(tag) {
      const el = tag === 'canvas' ? makeFakeCanvas() : makeFakeElement(tag)
      if (tag === 'style') {
        el.sheet = {
          rules: [],
          insertRule(ruleText, idx) {
            this.rules.splice(idx ?? this.rules.length, 0, ruleText)
          },
          deleteRule(idx) {
            this.rules.splice(idx, 1)
          },
        }
      }
      el.ownerDocument = doc
      return el
    },
    getElementById: () => null,
    head: makeFakeElement('head'),
  }
  doc.head.isConnected = true
  doc.head.ownerDocument = doc
  return doc
}

beforeEach(() => {
  globalThis.document = makeFakeDocument()
  globalThis.CSS = { supports: () => true }
  globalThis.getComputedStyle = () => ({
    font: '13px monospace',
    height: '16px',
    lineHeight: '16px',
    fontSize: '13px',
    fontStyle: 'normal',
    fontWeight: '400',
    fontFamily: 'monospace',
  })
  // paints.js's free-var contract (see build.js's readMultichatModules — these
  // are bundle-scope globals in production; paints.test.js stubs the same set).
  globalThis.escapeHtml = escapeHtml
  globalThis.compilePaintCss = compilePaintCss
  globalThis.hashPaintSpec = hashPaintSpec
  globalThis.paintNeedsSpans = paintNeedsSpans
  globalThis.paintMarkupMode = paintMarkupMode
  globalThis.paintNameHtmlFor = paintNameHtmlFor
  globalThis.NAME_BOX_CLASS = NAME_BOX_CLASS
  globalThis.paintPhaseNow = paintPhaseNow
  globalThis.MASKED_CLASS = MASKED_CLASS
  globalThis.compositedFillPlan = compositedFillPlan
  globalThis.compiledCssHasCompositedFill = compiledCssHasCompositedFill
  globalThis.renderSpecOf = renderSpecOf
  globalThis.maskFor = maskFor
  globalThis.maskForText = maskForText
  globalThis.supported = supported
  globalThis.mountFillLayers = mountFillLayers
  globalThis.unmountFillLayers = unmountFillLayers
  globalThis.FILL_LAYER_CLASS = FILL_LAYER_CLASS
  resetGlyphMaskCache()
})

afterEach(() => {
  for (const k of [
    'document',
    'CSS',
    'getComputedStyle',
    'escapeHtml',
    'compilePaintCss',
    'hashPaintSpec',
    'paintNeedsSpans',
    'paintMarkupMode',
    'paintNameHtmlFor',
    'NAME_BOX_CLASS',
    'paintPhaseNow',
    'MASKED_CLASS',
    'compositedFillPlan',
    'compiledCssHasCompositedFill',
    'renderSpecOf',
    'maskFor',
    'maskForText',
    'supported',
    'mountFillLayers',
    'unmountFillLayers',
    'FILL_LAYER_CLASS',
  ]) {
    delete globalThis[k]
  }
  resetGlyphMaskCache()
})

const GRAD = [
  { color: '#ff8700', pos: 0 },
  { color: '#ffd700', pos: 100 },
]
const flowLayer = () => ({
  kind: 'linear',
  tilt: 0,
  stops: GRAD,
  repeat: true,
  tile: { unit: 'name', size: 2 },
  motion: { type: 'flow', speed: 1 },
})
const FILL_SPEC = {
  base: { type: 'solid', angle: 0, stops: [{ color: '#ffffff', pos: 0 }] },
  effects: [],
  fill: { angle: 30, hue: null, breathe: null, layers: [flowLayer()] },
}

describe('the fill block reaches a real name (extension runtime)', () => {
  test('a whole name is masked once and gets one box per motion, text untouched', () => {
    const host = document.createElement('span')
    const box = document.createElement('span')
    box.className = NAME_BOX_CLASS
    box.textContent = 'mellen'
    host.appendChild(box)

    const plan = compositedFillPlan(FILL_SPEC)
    expect(plan).not.toBeNull()
    _applyHsGlyphMasksForTests(host, plan)

    expect(box.classList.contains(MASKED_CLASS)).toBe(true)
    const wrap = box.querySelector(`i.${FILL_WRAP_CLASS}`)
    expect(wrap).not.toBeNull()
    expect(wrap.getAttribute('aria-hidden')).toBe('true')
    const layers = wrap.querySelectorAll(`i.${FILL_LAYER_CLASS}`)
    expect(layers.length).toBe(1)
    expect(layers[0].classList.contains(`${FILL_LAYER_CLASS}0`)).toBe(true)
    expect(layers[0].getAttribute('aria-hidden')).toBe('true')
    // The text node stays exactly what it was — copy/find-in-page rely on it.
    expect(box.textContent).toBe('mellen')
    expect(box.style.getPropertyValue('--nw')).toBeTruthy()
  })

  test('a saved paint goes through the same plan setHsPaintEntry caches', () => {
    // setHsPaintEntry's renderSpecOf gate only fires when canCompositeHsFills()
    // reads true, which needs CSS.supports (stubbed above) AND glyph-mask's
    // own supported() check (document.createElement, also stubbed).
    setHsPaintEntry('fill-uid', FILL_SPEC)
    const plan = compositedFillPlan(FILL_SPEC)
    const host = document.createElement('span')
    const box = document.createElement('span')
    box.className = NAME_BOX_CLASS
    box.textContent = 'ennortix'
    host.appendChild(box)
    _applyHsGlyphMasksForTests(host, plan)
    expect(box.classList.contains(MASKED_CLASS)).toBe(true)
  })

  test('a still fill (no motion) mounts nothing — compositedFillPlan itself says so', () => {
    const stillSpec = {
      ...FILL_SPEC,
      fill: { ...FILL_SPEC.fill, layers: [{ kind: 'linear', stops: GRAD, motion: null }] },
    }
    expect(compositedFillPlan(stillSpec)).toBeNull()
  })

  test('unmountFillLayers clears the gate and the boxes, leaving the text alone', () => {
    const host = document.createElement('span')
    const box = document.createElement('span')
    box.className = NAME_BOX_CLASS
    box.textContent = 'mellen'
    host.appendChild(box)
    _applyHsGlyphMasksForTests(host, compositedFillPlan(FILL_SPEC))
    expect(box.classList.contains(MASKED_CLASS)).toBe(true)

    unmountFillLayers(box, MASKED_CLASS)
    expect(box.classList.contains(MASKED_CLASS)).toBe(false)
    expect(box.querySelector(`i.${FILL_LAYER_CLASS}`)).toBeNull()
    expect(box.textContent).toBe('mellen')
  })
})

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { mainSource } from './main-src.js'

/** tour arrow: the pure placement, the targets the cards name, and the node's house rules */
const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const SRC = read('src', 'multichat', 'tour.js')
const CSS = read('src', 'multichat', 'styles', '26-tour-card.css')
const MAIN = mainSource()
const win = new Window()
const doc = win.document

const rect = (l, t, w, h) => ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h })
const mod = new Function(
  'document',
  `${SRC}\nreturn { tourArrow, tourTargetRect, tourArrowPaint, TOUR_STEPS, set: (n, s) => { tourNode = n; tourStep = s } }`,
)(doc)
const B = rect(0, 0, 1000, 800)
const S = 32

describe('tourArrow: placement', () => {
  const T = rect(400, 400, 100, 40)
  test('sits on the edge that faces the card, centred, pointing at the target', () => {
    const above = mod.tourArrow(T, rect(0, 100, 1000, 50), B)
    expect(above).toEqual({ glyph: '▼', x: 434, y: 366 })
    const below = mod.tourArrow(T, rect(0, 700, 1000, 50), B)
    expect(below).toEqual({ glyph: '▲', x: 434, y: 442 })
    const left = mod.tourArrow(T, rect(0, 380, 100, 80), B)
    expect(left).toEqual({ glyph: '▶', x: 366, y: 404 })
    const right = mod.tourArrow(T, rect(900, 380, 100, 80), B)
    expect(right).toEqual({ glyph: '◀', x: 502, y: 404 })
  })
  test('never covers the card: falls to the next side with room', () => {
    // card hugs the target's bottom edge, arrow would land on it
    const c = rect(0, 442, 1000, 100)
    const a = mod.tourArrow(T, c, B)
    expect(a.glyph).toBe('▼')
  })
  test('clamps inside the screen', () => {
    const a = mod.tourArrow(rect(-20, 0, 60, 30), rect(0, 300, 1000, 50), B)
    expect(a.x).toBeGreaterThanOrEqual(0)
    expect(a.y).toBeGreaterThanOrEqual(0)
    const e = mod.tourArrow(rect(980, 770, 100, 100), rect(0, 0, 1000, 50), B)
    expect(e.x + S).toBeLessThanOrEqual(1000)
    expect(e.y + S).toBeLessThanOrEqual(800)
  })
  test('null with no target, zero size or off screen', () => {
    const c = rect(0, 0, 100, 50)
    expect(mod.tourArrow(null, c, B)).toBeNull()
    expect(mod.tourArrow(rect(10, 10, 0, 20), c, B)).toBeNull()
    expect(mod.tourArrow(rect(10, 10, 20, 0), c, B)).toBeNull()
    expect(mod.tourArrow(rect(2000, 10, 50, 50), c, B)).toBeNull()
    expect(mod.tourArrow(rect(10, -200, 50, 50), c, B)).toBeNull()
  })
})

describe('tour arrow: targets', () => {
  const cards = mod.TOUR_STEPS.slice(0, -1)
  const SEL = {
    cmd: ['hs-mc-input'],
    find: ['hs-mc-search-bar'],
    tabs: ['hs-mc-tabs-scroll', 'hs-mc-tab'],
    settings: ['hs-mc-tabbar', 'data-tab="settings"'],
    menu: ['hs-mc-messages', 'hs-mc-msg'],
  }
  test('every card but the last names something the overlay really builds', () => {
    for (const id of cards) {
      expect(SEL[id], id).toBeDefined()
      for (const k of SEL[id]) expect(MAIN, `${id}: ${k}`).toContain(k)
    }
    expect(mod.tourTargetRect(mod.TOUR_STEPS.at(-1))).toBeNull()
  })

  const build = () => {
    doc.body.innerHTML =
      '<div id="hs-mc-tabbar"><div class="hs-mc-tabs-scroll"><button class="hs-mc-tab">a</button><button class="hs-mc-tab active">b</button></div>' +
      '<button data-tab="settings"></button></div><div id="hs-mc-overlay"><div id="hs-mc-search-bar"></div><div id="hs-mc-tour"></div>' +
      '<div id="hs-mc-messages"><div class="hs-mc-msg" id="r1"></div><div class="hs-mc-msg" id="r2"></div><div class="hs-mc-msg" id="r3"></div></div></div><div id="hs-mc-input"></div>'
    const at = (sel, r) => {
      doc.querySelector(sel).getBoundingClientRect = () => r
    }
    at('#hs-mc-messages', rect(0, 100, 400, 300))
    at('#r1', rect(0, 100, 400, 20))
    at('#r2', rect(0, 120, 400, 20))
    at('#r3', rect(0, 380, 400, 60)) // runs past the bottom of the pane
    at('#hs-mc-input', rect(0, 760, 400, 30))
    at('#hs-mc-search-bar', rect(0, 60, 400, 30))
    at('.hs-mc-tab.active', rect(50, 0, 40, 30))
    at('.hs-mc-tabs-scroll', rect(0, 0, 300, 30))
    at('[data-tab="settings"]', rect(350, 0, 30, 30))
    at('#hs-mc-tour', rect(0, 90, 400, 10))
  }
  test('each card resolves to a live rect', () => {
    build()
    for (const id of cards) expect(mod.tourTargetRect(id), id).not.toBeNull()
    expect(mod.tourTargetRect('tabs')).toEqual(rect(50, 0, 40, 30))
  })
  test('the row target is the newest visible row, clipped to the pane', () => {
    build()
    const r = mod.tourTargetRect('menu')
    expect(r.top).toBe(380)
    expect(r.bottom).toBe(400)
    expect(r.height).toBe(20)
  })
  test('absent or zero-sized targets give no rect, hidden search bar gives no arrow', () => {
    build()
    doc.querySelector('#hs-mc-search-bar').getBoundingClientRect = () => rect(0, 0, 0, 0)
    mod.set(doc.querySelector('#hs-mc-tour'), mod.TOUR_STEPS.indexOf('find'))
    mod.tourArrowPaint()
    expect(doc.getElementById('hs-mc-tour-arrow')).toBeNull()
    doc.querySelector('#hs-mc-input').remove()
    expect(mod.tourTargetRect('cmd')).toBeNull()
  })
})

describe('tour arrow: the node', () => {
  test('aria-hidden, drawn at the placement, dropped with the card', () => {
    doc.body.innerHTML = '<div id="hs-mc-tour"></div><div id="hs-mc-input"></div>'
    doc.querySelector('#hs-mc-tour').getBoundingClientRect = () => rect(0, 0, 400, 80)
    doc.querySelector('#hs-mc-input').getBoundingClientRect = () => rect(0, 500, 400, 30)
    mod.set(doc.querySelector('#hs-mc-tour'), mod.TOUR_STEPS.indexOf('cmd'))
    mod.tourArrowPaint()
    const a = doc.getElementById('hs-mc-tour-arrow')
    expect(a.getAttribute('aria-hidden')).toBe('true')
    expect(a.textContent).toBe('▼')
    expect(a.style.top).toBe('466px')
    doc.querySelector('#hs-mc-tour').hidden = true
    mod.tourArrowPaint()
    expect(doc.getElementById('hs-mc-tour-arrow')).toBeNull()
  })
  test('css: the yellow token, big, bold, click-through, no motion or shadow', () => {
    const rule = CSS.slice(CSS.indexOf('#hs-mc-tour-arrow {'))
    expect(rule).toContain('color: var(--hs-warn)')
    expect(rule).toContain('pointer-events: none')
    expect(rule).toMatch(/font: 700 32px/)
    expect(rule).not.toMatch(/animation|transition|shadow|#[0-9a-f]{3,6}\b/i)
  })
  test('the glyphs are four Cozette has, and only those', () => {
    expect(SRC).toContain("{ top: '\\u25bc', bottom: '\\u25b2', left: '\\u25b6', right: '\\u25c0' }")
  })
})

/**
 * The emote picker from the keyboard (picker-nav.js).
 *
 * Focus stays in the search box; arrows move a cursor over the tiles, Enter
 * inserts, Escape closes and gives the composer back. The same grid holds the
 * main set and search results, so one handler covers both.
 *
 * The movement rules are a pure function of tile boxes, run here on synthetic
 * geometry: sections wrap on their own, a short last row, wide tiles. The
 * handler, the ARIA it keeps (aria-selected / aria-activedescendant on the
 * combobox) and the close path run for real against a stand-in DOM. The real
 * browser proof is the picker scenario in scripts/render-extension.ts.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const TILE = '.hs-mc-picker-emote-wrap'
const CHUNK = '.hs-mc-picker-chunk'

// ---------------------------------------------------------------- geometry

/** Lay `counts` out as sections wrapping at `cols`, each section below the last (a label row between). */
function layout(counts, cols = 7, w = 40, h = 40) {
  const rects = []
  let y = 0
  for (const n of counts) {
    y += 20 // the section label
    for (let i = 0; i < n; i++) {
      rects.push({ left: (i % cols) * (w + 2), top: y + Math.floor(i / cols) * (h + 2), width: w, height: h })
    }
    y += Math.ceil(n / cols) * (h + 2)
  }
  return rects
}

const target = (rects, cur, key) => hsPickerNavTarget(rects.length, cur, key, (i) => rects[i])

// ------------------------------------------------------------- stand-in DOM

let doc
let calls

function node(extra = {}) {
  const attrs = new Map()
  return {
    id: '',
    isConnected: true,
    dataset: {},
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    hasAttribute: (k) => attrs.has(k),
    removeAttribute: (k) => attrs.delete(k),
    ...extra,
  }
}

/**
 * A picker grid: chunks of tiles, a chunk is empty (a placeholder) until filled.
 * `perChunk` tiles per chunk, `names` for the data-name of each tile in order.
 */
function buildGrid(names, perChunk, rects, filled = [0]) {
  const grid = node({
    scrollTop: 0,
    rectTop: 0,
    rectBottom: 200,
    on: {},
    addEventListener: (type, fn) => {
      grid.on[type] = fn
    },
  })
  const section = { querySelector: () => ({ offsetHeight: 20 }) }
  const chunks = []
  const tiles = names.map((name, i) => {
    const tile = node({
      dataset: { name },
      isTile: true,
      querySelector: (s) => (s === 'img' ? tile.img : null),
      closest: (s) => (s === CHUNK ? chunks[Math.floor(i / perChunk)] : s === '.hs-mc-picker-section' ? section : null),
      getBoundingClientRect: () => {
        const r = rects[i]
        return { ...r, bottom: r.top + r.height - grid.scrollTop, top: r.top - grid.scrollTop }
      },
    })
    tile.img = { click: () => calls.push(`click:${name}`) }
    tile.setAttribute('aria-selected', 'false')
    return tile
  })
  for (let c = 0; c * perChunk < names.length; c++) {
    const ready = new Set(filled.includes(c) ? ['hs-mc-chunk-ready'] : [])
    chunks.push({ n: c, classList: { contains: (k) => ready.has(k), add: (k) => ready.add(k) } })
  }
  const live = () => tiles.filter((_, i) => chunks[Math.floor(i / perChunk)].classList.contains('hs-mc-chunk-ready'))
  Object.assign(grid, {
    tiles,
    chunks,
    querySelectorAll: (s) => (s === TILE ? live() : s === CHUNK ? chunks : []),
    querySelector: (s) => (s === TILE ? live()[0] || null : s === '[role="listbox"]' ? grid.listbox || null : null),
    contains: (el) => live().includes(el),
    getBoundingClientRect: () => ({ top: grid.rectTop, bottom: grid.rectBottom }),
  })
  return grid
}

function buildInput() {
  const listeners = {}
  return node({
    value: '',
    on: listeners,
    addEventListener: (type, fn) => {
      listeners[type] = fn
    },
  })
}

function key(input, k, extra = {}) {
  return {
    key: k,
    currentTarget: input,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    ...extra,
  }
}

const mod = await import(`../src/multichat/picker-nav.js?t=${Date.now()}`)
const { hsPickerNavTarget, hsPickerKey, hsPickerSelect, hsPickerGridChanged, hsWirePickerNav, hsPickerFocusSearch } =
  mod
const { attachPickerCloseHandler, closeEmotePickerPanel, detachPickerCloseHandlers } = mod

let grid
let input

/** 20 tiles in 7 columns, 4 per chunk-of-96 stand-in (chunk size 8 here), only chunk 0 filled. */
function standardGrid(filled = [0]) {
  const names = Array.from({ length: 20 }, (_, i) => `e${i}`)
  grid = buildGrid(names, 8, layout([20]), filled)
  input = buildInput()
  doc.els['hs-mc-emote-grid'] = grid
  doc.els['hs-mc-emote-search'] = input
}

beforeEach(() => {
  calls = []
  doc = { els: {}, activeElement: null, handlers: {} }
  globalThis.document = {
    getElementById: (id) => doc.els[id] || null,
    get activeElement() {
      return doc.activeElement
    },
    addEventListener: () => {},
    removeEventListener: (type, fn) => {
      if (doc.handlers[type] === fn) delete doc.handlers[type]
    },
  }
  globalThis._fillChunk = (c) => {
    calls.push(`fill:${c.n}`)
    c.classList.add('hs-mc-chunk-ready')
    return true
  }
  globalThis._mcSearchRenderedQuery = ''
  globalThis.pickerTab = 'emotes'
  globalThis.mcSignal = { aborted: false }
  globalThis.hideInputBar = () => calls.push('hideInputBar')
  globalThis.stopPredictionPoll = () => calls.push('stopPoll')
  globalThis.cleanup = {
    setTimeout: (fn) => fn(),
    addEventListener: (target, type, fn) => {
      if (target === globalThis.document) doc.handlers[type] = fn
      else target.addEventListener(type, fn)
    },
    trackObserver: (o) => o,
    untrackObserver: () => {},
  }
  globalThis.ResizeObserver = class {
    constructor(cb) {
      globalThis.resizeFired = cb
    }
    observe() {}
    disconnect() {}
  }
  globalThis.MutationObserver = class {
    constructor(cb) {
      this.cb = cb
    }
    observe() {}
    disconnect() {}
  }
  detachPickerCloseHandlers()
  hsPickerSelect(null)
})

// ------------------------------------------------------------ movement rules

describe('hsPickerNavTarget', () => {
  const g = layout([20]) // rows of 7, 7, 6

  test('left and right walk the tile order and clamp at the ends', () => {
    expect(target(g, 3, 'ArrowRight')).toBe(4)
    expect(target(g, 3, 'ArrowLeft')).toBe(2)
    expect(target(g, 0, 'ArrowLeft')).toBe(0)
    expect(target(g, 19, 'ArrowRight')).toBe(19)
  })

  test('right at the end of a row continues on the next row', () => {
    expect(target(g, 6, 'ArrowRight')).toBe(7)
    expect(target(g, 7, 'ArrowLeft')).toBe(6)
  })

  test('home and end jump to the first and last tile', () => {
    expect(target(g, 9, 'Home')).toBe(0)
    expect(target(g, 9, 'End')).toBe(19)
  })

  test('up and down keep the column', () => {
    expect(target(g, 3, 'ArrowDown')).toBe(10)
    expect(target(g, 10, 'ArrowUp')).toBe(3)
  })

  test('up on the first row and down on the last row stay put', () => {
    expect(target(g, 2, 'ArrowUp')).toBe(2)
    expect(target(g, 17, 'ArrowDown')).toBe(17)
  })

  test('down into a shorter last row lands on the nearest column', () => {
    // rows of 7,7,6: tile 13 is column 6 of row 2; row 3 has columns 0-5
    expect(target(g, 13, 'ArrowDown')).toBe(19)
    const short = layout([10]) // 7 then 3
    expect(target(short, 6, 'ArrowDown')).toBe(9)
    expect(target(short, 5, 'ArrowDown')).toBe(9)
    expect(target(short, 1, 'ArrowDown')).toBe(8)
  })

  test('up and down cross a section boundary by column, not by index', () => {
    const two = layout([10, 14]) // A: 7+3, B: 7+7 below A's label row
    // from A's short last row (tile 8, column 1) down into B's first row
    expect(target(two, 8, 'ArrowDown')).toBe(11)
    // from B's first row column 5 (tile 15) up into A's short last row: nearest is column 2
    expect(target(two, 15, 'ArrowUp')).toBe(9)
  })

  test('a wide tile is a column of its own width, not a fixed slot', () => {
    const rects = [
      { left: 0, top: 0, width: 40, height: 40 },
      { left: 42, top: 0, width: 96, height: 40 }, // wide, centre 90
      { left: 140, top: 0, width: 40, height: 40 },
      { left: 0, top: 42, width: 40, height: 40 },
      { left: 42, top: 42, width: 40, height: 40 }, // centre 62
      { left: 84, top: 42, width: 40, height: 40 }, // centre 104
    ]
    expect(target(rects, 1, 'ArrowDown')).toBe(5)
    expect(target(rects, 5, 'ArrowUp')).toBe(1)
  })

  test('tiles of different heights on one row are one row', () => {
    const rects = [
      { left: 0, top: 0, width: 40, height: 40 },
      { left: 42, top: 4, width: 40, height: 32 },
      { left: 0, top: 42, width: 40, height: 40 },
    ]
    expect(target(rects, 0, 'ArrowDown')).toBe(2)
    expect(target(rects, 1, 'ArrowDown')).toBe(2)
  })

  test('with no cursor yet, a move lands on the first tile (end on the last)', () => {
    expect(target(g, -1, 'ArrowDown')).toBe(0)
    expect(target(g, -1, 'ArrowRight')).toBe(0)
    expect(target(g, -1, 'Home')).toBe(0)
    expect(target(g, -1, 'End')).toBe(19)
  })

  test('nothing to move over, or a key that is not a movement, is not handled', () => {
    expect(hsPickerNavTarget(0, -1, 'ArrowDown', () => ({}))).toBeNull()
    expect(target(g, 3, 'a')).toBeNull()
    expect(target(g, 3, 'Enter')).toBeNull()
    expect(target(g, 3, 'PageDown')).toBeNull()
  })

  test('a one-tile grid never leaves the tile', () => {
    const one = layout([1])
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])
      expect(target(one, 0, k)).toBe(0)
  })
})

// ------------------------------------------------------------- the handler

describe('arrow keys in the search box', () => {
  beforeEach(() => standardGrid())

  test('arrow down engages the first tile and names it on the combobox', () => {
    const e = key(input, 'ArrowDown')
    hsPickerKey(e)
    const first = grid.tiles[0]
    expect(e.defaultPrevented).toBe(true)
    expect(first.getAttribute('aria-selected')).toBe('true')
    expect(first.id).toMatch(/^hs-mc-emote-opt-\d+$/)
    expect(input.getAttribute('aria-activedescendant')).toBe(first.id)
  })

  test('moving the cursor un-selects the old tile and re-points the combobox', () => {
    hsPickerKey(key(input, 'ArrowDown'))
    hsPickerKey(key(input, 'ArrowRight'))
    expect(grid.tiles[0].getAttribute('aria-selected')).toBe('false')
    expect(grid.tiles[1].getAttribute('aria-selected')).toBe('true')
    expect(input.getAttribute('aria-activedescendant')).toBe(grid.tiles[1].id)
    expect(grid.tiles.filter((t) => t.getAttribute('aria-selected') === 'true')).toHaveLength(1)
  })

  test('a tile keeps its id for as long as it lives', () => {
    hsPickerKey(key(input, 'ArrowDown'))
    const id = grid.tiles[0].id
    hsPickerKey(key(input, 'ArrowRight'))
    hsPickerKey(key(input, 'ArrowLeft'))
    expect(grid.tiles[0].id).toBe(id)
    expect(new Set(grid.tiles.filter((t) => t.id).map((t) => t.id)).size).toBe(2)
  })

  test('home and end jump', () => {
    hsPickerKey(key(input, 'ArrowDown'))
    hsPickerKey(key(input, 'End'))
    expect(input.getAttribute('aria-activedescendant')).toBe(grid.tiles[19].id)
    hsPickerKey(key(input, 'Home'))
    expect(input.getAttribute('aria-activedescendant')).toBe(grid.tiles[0].id)
  })

  test('end fills the last chunk first, so there is a tile to land on', () => {
    // only chunk 0 (tiles 0-7) is drawn; the last chunk is a placeholder
    expect(grid.querySelectorAll(TILE)).toHaveLength(8)
    hsPickerKey(key(input, 'ArrowDown'))
    hsPickerKey(key(input, 'End'))
    expect(calls).toContain('fill:2')
    expect(input.getAttribute('aria-activedescendant')).toBe(grid.tiles[19].id)
  })

  test('the chunks either side of the cursor are filled before it can run into them', () => {
    hsPickerKey(key(input, 'ArrowDown'))
    expect(calls).toContain('fill:1')
    expect(calls).not.toContain('fill:2')
    // down through the first chunk's last row into the second chunk
    for (let i = 0; i < 2; i++) hsPickerKey(key(input, 'ArrowDown'))
    expect(input.getAttribute('aria-activedescendant')).toBe(grid.tiles[14].id)
    expect(calls).toContain('fill:2')
  })

  test('with text typed, left/right/home/end still edit the text until the cursor is engaged', () => {
    input.value = 'kek'
    for (const k of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'ArrowUp']) {
      const e = key(input, k)
      hsPickerKey(e)
      expect(e.defaultPrevented).toBe(false)
    }
    expect(input.hasAttribute('aria-activedescendant')).toBe(false)
    const down = key(input, 'ArrowDown')
    hsPickerKey(down)
    expect(down.defaultPrevented).toBe(true)
    const left = key(input, 'ArrowRight')
    hsPickerKey(left)
    expect(left.defaultPrevented).toBe(true) // engaged now: it moves the cursor
  })

  test('on an empty box any movement key engages (there is no text to edit)', () => {
    const e = key(input, 'End')
    hsPickerKey(e)
    expect(e.defaultPrevented).toBe(true)
    expect(input.getAttribute('aria-activedescendant')).toBe(grid.tiles[19].id)
  })

  test('chords and IME composition are left alone', () => {
    for (const extra of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { shiftKey: true },
      { isComposing: true },
    ]) {
      const e = key(input, 'ArrowDown', extra)
      hsPickerKey(e)
      expect(e.defaultPrevented).toBe(false)
    }
    expect(input.hasAttribute('aria-activedescendant')).toBe(false)
  })

  test('nothing to land on is not swallowed', () => {
    grid.tiles.length = 0
    grid.chunks.length = 0
    const e = key(input, 'ArrowDown')
    hsPickerKey(e)
    expect(e.defaultPrevented).toBe(false)
  })
})

describe('scrolling the cursor into view', () => {
  beforeEach(() => standardGrid([0, 1, 2]))

  test('a tile below the fold scrolls the grid, not the page', () => {
    // 20 tiles, 7 cols: row 3 starts at y = 20 + 2*42 = 104..144; make the viewport short
    grid.rectBottom = 100
    hsPickerKey(key(input, 'ArrowDown'))
    expect(grid.scrollTop).toBe(0)
    hsPickerKey(key(input, 'ArrowDown'))
    hsPickerKey(key(input, 'ArrowDown'))
    expect(grid.scrollTop).toBeGreaterThan(0)
  })

  test('a tile under the sticky section label scrolls clear of it', () => {
    grid.rectBottom = 100
    hsPickerKey(key(input, 'ArrowDown'))
    hsPickerKey(key(input, 'ArrowDown'))
    hsPickerKey(key(input, 'ArrowDown'))
    const down = grid.scrollTop
    expect(down).toBeGreaterThan(0)
    // up to row 2 (tile 7): it sits under the 20px label until the grid scrolls back
    expect(grid.tiles[7].getBoundingClientRect().top).toBeLessThan(20)
    hsPickerKey(key(input, 'ArrowUp'))
    expect(grid.scrollTop).toBeLessThan(down)
    expect(grid.tiles[7].getBoundingClientRect().top).toBeGreaterThanOrEqual(20)
  })

  test('the first tile scrolls all the way up, label and all', () => {
    grid.scrollTop = 60
    hsPickerKey(key(input, 'ArrowDown')) // engages tile 0
    expect(grid.scrollTop).toBe(0)
  })
})

describe('inserting', () => {
  beforeEach(() => standardGrid())

  test('enter clicks the engaged tile: the click is the whole insert path', () => {
    hsPickerKey(key(input, 'ArrowDown'))
    hsPickerKey(key(input, 'ArrowRight'))
    const e = key(input, 'Enter')
    hsPickerKey(e)
    expect(calls.filter((c) => c.startsWith('click:'))).toEqual(['click:e1'])
    expect(e.defaultPrevented).toBe(true)
  })

  test('enter on a typed query takes the best match, once the grid shows that query', () => {
    input.value = 'E1'
    globalThis._mcSearchRenderedQuery = 'e1'
    hsPickerKey(key(input, 'Enter'))
    expect(calls.filter((c) => c.startsWith('click:'))).toEqual(['click:e0'])
  })

  test('enter inside the search debounce does not insert from the previous results', () => {
    input.value = 'kek'
    globalThis._mcSearchRenderedQuery = 'ke'
    const e = key(input, 'Enter')
    hsPickerKey(e)
    expect(calls.filter((c) => c.startsWith('click:'))).toEqual([])
    expect(e.defaultPrevented).toBe(false)
  })

  test('enter on an empty box with no cursor inserts nothing', () => {
    hsPickerKey(key(input, 'Enter'))
    expect(calls.filter((c) => c.startsWith('click:'))).toEqual([])
  })

  test('shift+enter and IME enter are not an insert', () => {
    hsPickerKey(key(input, 'ArrowDown'))
    hsPickerKey(key(input, 'Enter', { shiftKey: true }))
    hsPickerKey(key(input, 'Enter', { isComposing: true }))
    expect(calls.filter((c) => c.startsWith('click:'))).toEqual([])
  })
})

describe('letting go of the cursor', () => {
  beforeEach(() => standardGrid())

  test('typing releases it', () => {
    hsWirePickerNav({ querySelector: (s) => (s === '#hs-mc-emote-search' ? input : grid) })
    hsPickerKey(key(input, 'ArrowDown'))
    input.on.input()
    expect(grid.tiles[0].getAttribute('aria-selected')).toBe('false')
    expect(input.hasAttribute('aria-activedescendant')).toBe(false)
  })

  test('leaving the box releases it', () => {
    hsWirePickerNav({ querySelector: (s) => (s === '#hs-mc-emote-search' ? input : grid) })
    hsPickerKey(key(input, 'ArrowDown'))
    input.on.blur()
    expect(grid.tiles[0].getAttribute('aria-selected')).toBe('false')
    expect(input.hasAttribute('aria-activedescendant')).toBe(false)
  })
})

describe('the cursor staying in view while the grid reflows', () => {
  beforeEach(() => {
    standardGrid([0, 1, 2])
    grid.rectBottom = 100 // short viewport: the last row is below the fold
  })
  const wire = () => hsWirePickerNav({ querySelector: (s) => (s === '#hs-mc-emote-search' ? input : grid) })

  test('a reflow that carries the cursor out of view scrolls it back', () => {
    wire()
    hsPickerKey(key(input, 'ArrowDown'))
    hsPickerKey(key(input, 'End'))
    const at = grid.scrollTop
    grid.rectBottom -= 30 // images landed and the rows grew: the tile now sits past the bottom edge
    globalThis.resizeFired()
    expect(grid.scrollTop).toBeGreaterThan(at)
  })

  test('once the reader scrolls by hand it stops following', () => {
    wire()
    hsPickerKey(key(input, 'ArrowDown'))
    hsPickerKey(key(input, 'End'))
    const at = grid.scrollTop
    grid.on.wheel()
    grid.rectBottom -= 30
    globalThis.resizeFired()
    expect(grid.scrollTop).toBe(at)
  })

  test('no cursor, no following', () => {
    wire()
    hsPickerKey(key(input, 'ArrowDown'))
    hsPickerKey(key(input, 'End'))
    input.on.input()
    const at = grid.scrollTop
    grid.rectBottom -= 30
    globalThis.resizeFired()
    expect(grid.scrollTop).toBe(at)
  })
})

describe('the grid being replaced under the cursor', () => {
  beforeEach(() => standardGrid())

  test('the combobox is expanded only while there is a list', () => {
    grid.listbox = {}
    hsPickerGridChanged()
    expect(input.getAttribute('aria-expanded')).toBe('true')
    grid.listbox = null
    hsPickerGridChanged()
    expect(input.getAttribute('aria-expanded')).toBe('false')
  })

  test('the cursor follows its emote into the re-rendered grid', () => {
    hsPickerKey(key(input, 'ArrowDown'))
    hsPickerKey(key(input, 'ArrowRight'))
    const old = grid.tiles[1]
    // a provider answered: the grid is rebuilt, e1 is a new element
    const fresh = node({
      dataset: { name: 'e1' },
      closest: () => null,
      getBoundingClientRect: () => ({ top: 0, bottom: 10, height: 10 }),
    })
    fresh.setAttribute('aria-selected', 'false')
    grid.tiles[1] = fresh
    hsPickerGridChanged()
    expect(grid.tiles[1].getAttribute('aria-selected')).toBe('true')
    expect(input.getAttribute('aria-activedescendant')).toBe(fresh.id)
    expect(old.id).not.toBe(fresh.id)
  })

  test('the cursor lets go when its emote is gone, never pointing at a dead id', () => {
    hsPickerKey(key(input, 'ArrowDown'))
    grid.tiles.shift()
    hsPickerGridChanged()
    expect(input.hasAttribute('aria-activedescendant')).toBe(false)
  })
})

// ------------------------------------------------------- opening and closing

describe('opening from the keyboard', () => {
  test('lands in the search box when the emotes tab is showing', () => {
    standardGrid()
    let focused = 0
    input.focus = () => focused++
    input.getClientRects = () => [{}]
    hsPickerFocusSearch()
    expect(focused).toBe(1)
  })

  test('does nothing on another tab, or when the box is not laid out', () => {
    standardGrid()
    let focused = 0
    input.focus = () => focused++
    input.getClientRects = () => [{}]
    globalThis.pickerTab = 'gifs'
    hsPickerFocusSearch()
    globalThis.pickerTab = 'emotes'
    input.getClientRects = () => []
    hsPickerFocusSearch()
    expect(focused).toBe(0)
  })
})

describe('escape', () => {
  let picker
  let composer
  let bar

  beforeEach(() => {
    const inside = node()
    picker = { classList: { remove: (c) => calls.push(`remove:${c}`) }, contains: (el) => el === inside, inside }
    composer = node({ focus: () => calls.push('focus:composer') })
    bar = { classList: { contains: (c) => c === 'hs-hidden' && bar.hidden }, hidden: false }
    doc.els['hs-mc-emote-picker'] = picker
    doc.els['hs-mc-input'] = composer
    doc.els['hs-mc-inputbar'] = bar
    attachPickerCloseHandler(picker)
  })

  test('closes the panel and gives focus back to the composer when the reader was in it', () => {
    doc.activeElement = picker.inside
    doc.handlers.keydown({ key: 'Escape' })
    expect(calls).toEqual(['remove:visible', 'hideInputBar', 'stopPoll', 'focus:composer'])
  })

  test('leaves focus alone when the reader was already in the composer', () => {
    doc.activeElement = composer
    doc.handlers.keydown({ key: 'Escape' })
    expect(calls).toContain('remove:visible')
    expect(calls).not.toContain('focus:composer')
  })

  test('does not focus a composer that is hidden (auto-hide took it down)', () => {
    bar.hidden = true
    doc.activeElement = picker.inside
    doc.handlers.keydown({ key: 'Escape' })
    expect(calls).toContain('remove:visible')
    expect(calls).not.toContain('focus:composer')
  })

  test('other keys do nothing', () => {
    doc.activeElement = picker.inside
    doc.handlers.keydown({ key: 'a' })
    expect(calls).toEqual([])
  })

  test('a torn-down context closes nothing', () => {
    globalThis.mcSignal = { aborted: true }
    doc.activeElement = picker.inside
    doc.handlers.keydown({ key: 'Escape' })
    expect(calls).toEqual([])
  })

  test('a click outside closes it without taking focus', () => {
    doc.handlers.click({ target: { closest: () => null } })
    expect(calls).toContain('remove:visible')
    expect(calls).not.toContain('focus:composer')
  })

  test('closing from code can leave the composer up (a gif pick mid-send)', () => {
    closeEmotePickerPanel({ keepInput: true })
    expect(calls).toEqual(['remove:visible', 'stopPoll'])
  })
})

// --------------------------------------------------------------- the markup

describe('picker markup and wiring', () => {
  const emotes = read('src/multichat/emotes.js')

  test('the search box is a combobox over the very list the grid renders', () => {
    const controls = emotes.match(/id="hs-mc-emote-search"[^>]*aria-controls="([^"]+)"/)?.[1]
    expect(controls).toBeTruthy()
    expect(emotes).toMatch(/id="hs-mc-emote-search"[^>]*role="combobox"/)
    expect(emotes).toMatch(/id="hs-mc-emote-search"[^>]*aria-autocomplete="list"/)
    expect(emotes).toMatch(new RegExp(`<div id="${controls}" role="listbox"`))
  })

  test('every tile is an option, drawn unselected', () => {
    expect(emotes).toMatch(/<span class="\$\{wrapCls\}" role="option" aria-selected="false"/)
  })

  test('the keyboard model is wired at build, and the button hands a keyboard reader the box', () => {
    expect(emotes).toMatch(/hsWirePickerNav\(picker\)/)
    expect(read('src/multichat/input.js')).toMatch(/if \(e\.detail === 0\) hsPickerFocusSearch\(\)/)
  })

  test('the cursor is drawn in the keyboard colour, not the pointer white', () => {
    const css = read('src/multichat/styles/10-emotes.css')
    const rule = css.match(/\.hs-mc-picker-emote-wrap\[aria-selected='true'\]::before\s*\{([^}]*)\}/)?.[1]
    expect(rule).toBeTruthy()
    expect(rule).toContain('var(--hs-sel)')
  })

  test('the module is in the bundle', () => {
    expect(read('build.js')).toMatch(/'picker-nav\.js'/)
  })
})

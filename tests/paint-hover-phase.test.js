/**
 * Leaving a hovered name puts every frozen copy back on the clock.
 *
 * The hover freeze pauses the name (`:hover`) and every visible copy of it
 * (`.hsp-hover`), and deletes their scene plates. Release resumed the paused
 * animations from where they froze and restarted the plates, so after one
 * hover that user's names ran behind every row mounted later — the copies
 * agreed with each other and with nothing else. Measured on the site, same
 * freeze rule: coin 0.497 of a loop off the clock after one hover.
 *
 * paints.js pulls in bundle-only globals at module scope, so the hover sync is
 * extracted by source slicing + `new Function`, same as
 * tests/paint-idle-gate-phase.test.js. No DOM library here (house pattern): a
 * stand-in element with just what the listener touches.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'paints.js'), 'utf8')

function slice(sig) {
  const start = SRC.indexOf(sig)
  expect(start, `${sig} vanished from paints.js`).toBeGreaterThan(-1)
  let depth = 0
  let i = SRC.indexOf('{', start)
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}' && --depth === 0) break
  }
  return SRC.slice(start, i + 1)
}

class El {
  constructor(name, parent = null) {
    this.name = name
    this.parent = parent
    this.dataset = { username: name }
    this.textContent = name
    this.rect = { top: 10, bottom: 30 }
    const set = new Set(['hsp-x'])
    this.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), has: (c) => set.has(c) }
  }
  getBoundingClientRect() {
    return this.rect
  }
  closest() {
    let n = this
    while (n && !n.classList.has('hsp-x')) n = n.parent
    return n
  }
}

function install(names) {
  const listeners = {}
  const frames = []
  const anchored = []
  const document = {
    addEventListener: (type, fn) => {
      listeners[type] = fn
    },
    querySelectorAll: () => names,
  }
  const factory = new Function(
    'document',
    'window',
    'Element',
    'requestAnimationFrame',
    'anchorWhenStarted',
    `let _hsPaintHoverInstalled = false, _hsPaintHoverEls = null, _hsPaintHoverTarget = null
     ${slice('function _hsPaintHoverKey(el)')}
     ${slice('function _hsPaintHoverOn(target, type, fn, opts)')}
     ${slice('function installHsPaintHoverSync()')}
     installHsPaintHoverSync()`,
  )
  factory(
    document,
    { innerHeight: 800 },
    El,
    (cb) => frames.push(cb),
    (els) => anchored.push(els),
  )
  return { listeners, frames, anchored }
}

describe('hover only freezes copies on screen', () => {
  test('a copy scrolled out of view is left running', () => {
    const a = new El('ennortix'),
      seen = new El('ennortix'),
      gone = new El('ennortix')
    gone.rect = { top: 2000, bottom: 2020 }
    const { listeners } = install([a, seen, gone])
    listeners.mouseover({ target: a })
    expect(seen.classList.has('hsp-hover')).toBe(true)
    expect(gone.classList.has('hsp-hover')).toBe(false)
  })
})

describe('hover release re-anchors', () => {
  test('the hovered name and every synced copy, a frame after the freeze drops', () => {
    const a = new El('ennortix'),
      b = new El('ennortix'),
      other = new El('mellen')
    const { listeners, frames, anchored } = install([a, b, other])
    listeners.mouseover({ target: a })
    expect(b.classList.has('hsp-hover')).toBe(true)
    listeners.mouseout({ target: a, relatedTarget: null })
    expect(b.classList.has('hsp-hover')).toBe(false)
    expect(anchored).toHaveLength(0) // not before the freeze has dropped
    for (const f of frames) f()
    expect(anchored).toEqual([[a, b]])
  })

  test('a lone name with no copies is still re-anchored', () => {
    const a = new El('ennortix')
    const { listeners, frames, anchored } = install([a])
    listeners.mouseover({ target: a })
    listeners.mouseout({ target: a, relatedTarget: null })
    for (const f of frames) f()
    expect(anchored).toEqual([[a]])
  })

  test('moving between the glyphs of one name does nothing', () => {
    const a = new El('ennortix'),
      b = new El('ennortix')
    const glyph = new El('e', a)
    glyph.classList.remove('hsp-x')
    const { listeners, frames, anchored } = install([a, b])
    listeners.mouseover({ target: glyph })
    listeners.mouseout({ target: glyph, relatedTarget: a })
    for (const f of frames) f()
    expect(anchored).toHaveLength(0)
    expect(b.classList.has('hsp-hover')).toBe(true)
  })
})

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// glyph masks are rastered at the dpr in force when the box was first read.
// page zoom changes devicePixelRatio; the masks must be redrawn, and new ones
// must not reuse the stale ratio.
const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'paints.js'), 'utf8')
const cut = (from, to) => SRC.slice(SRC.indexOf(from), SRC.indexOf(to, SRC.indexOf(from)))
const DPR_FN = `${cut('function hsGlyphDpr()', '\n}\n')}\n}\n`
const WATCH = cut('// Page zoom changes devicePixelRatio', '// ── the crowd dial')

function rig(startDpr) {
  const win = { devicePixelRatio: startDpr, fire: null }
  let remounts = 0
  const cleanup = {
    addEventListener: (_t, ev, fn) => {
      if (ev === 'resize') win.fire = fn
    },
  }
  new Function('window', 'cleanup', 'remountAllHsFillLayers', `${DPR_FN}\n${WATCH}\nwindow.__dpr = hsGlyphDpr`)(
    win,
    cleanup,
    () => remounts++,
  )
  return {
    zoomTo: (d) => {
      win.devicePixelRatio = d
      win.fire()
    },
    remounts: () => remounts,
    dpr: win.__dpr,
  }
}

describe('painted-name masks under page zoom', () => {
  test('dpr is the exact ratio, floored at 1 and capped at 3', () => {
    const r = rig(1.25)
    expect(r.dpr()).toBe(1.25)
    const lo = rig(0.5)
    expect(lo.dpr()).toBe(1)
    const hi = rig(5)
    expect(hi.dpr()).toBe(3)
  })
  test('a zoom that changes the ratio redraws the masks once', () => {
    const r = rig(1)
    r.zoomTo(2)
    expect(r.remounts()).toBe(1)
  })
  test('a resize that keeps the ratio does nothing', () => {
    const r = rig(1)
    r.zoomTo(1)
    expect(r.remounts()).toBe(0)
  })
  test('zooming past the 3x cap does not redraw what would draw identically', () => {
    const r = rig(3)
    r.zoomTo(4)
    expect(r.remounts()).toBe(0)
  })
  test('the cached box is dropped when its dpr is stale', () => {
    expect(SRC).toContain('if (hsGlyphBox && hsGlyphBox.dpr !== hsGlyphDpr()) hsGlyphBox = null')
  })
})

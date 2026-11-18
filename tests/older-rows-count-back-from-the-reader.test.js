/**
 * Paused above the tail, the reader scrolls to the top and older rows load. The window used to
 * be counted back from the LIVE tail: every line that arrived since the pause pushed it forward.
 * On a fast chat "load older" drew the new lines at the bottom, added nothing above, and past
 * ~250 new lines took the very rows on screen away (real kick, e2e s20, 11-17). It is counted
 * back from the newest row the reader had; the new lines stay behind the "N new" pill.
 *
 * Real code: fairMerge, cutSourcesAsOf, newestOrdOnScreen, resetScrollback and
 * loadOlderScrollback, carved from the source. Only the pane is a model.
 */
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ordOf } from '../src/lib/utils.js'
import { mainSource } from './main-src.js'

const SRC = mainSource()
const MC = join(import.meta.dir, '..', 'src', 'multichat')
const between = (a, b) => {
  const s = SRC.indexOf(a)
  const e = SRC.indexOf(b, s)
  if (s === -1 || e === -1) throw new Error(`marker not found: ${s === -1 ? a : b}`)
  return SRC.slice(s, e)
}
const MERGE = between('function mergeSortedRuns(runs) {', '\nfunction msgKeyOf(m) {')
const STATE = between('let _scrollbackWindow = 0', '/** Rows the pane may hold right now')
const CAP = between('const renderRowCap = () =>', '\n')
const OLDER = between('let _olderMissAt = 0', '\n// Trailing collapse for hydration-class FULL rebuilds')

/** A channel with `total` lines so far; the pane shows what a render at `tailAtPause` drew. */
function room({ total, tailAtPause }) {
  const buf = Array.from({ length: total }, (_, i) => ({ ord: i + 1, id: `m${i + 1}` }))
  const scope = {
    ordOf,
    MC_DEBUG: false,
    log() {},
    DOM_RENDER_CAP: 500,
    __HS_DEV_BUILD__: true,
    isScrolledUp: true,
    currentTab: 'room',
    isProgrammaticScroll: false,
    cleanup: { raf: (fn) => fn() },
    Date,
    pane: null,
    renders: 0,
    document: { getElementById: () => scope.pane },
  }
  const api = new Function(
    'scope',
    `with (scope) {
      ${MERGE}
      ${STATE}
      ${CAP}
      // the render, as main-live.js does it for a channel tab
      function renderMessages() {
        renders++
        const asOf = renderAsOf(pane)
        const srcs = [asOf === null ? buf.slice(-SCROLLBACK_MAX) : buf.slice()]
        let rows = fairMerge(cutSourcesAsOf(srcs, asOf), renderRowCap())
        if (asOf !== null) rows = rows.filter((m) => ordOf(m) <= asOf)
        pane.children = rows.slice(-renderRowCap()).map((m) => ({ _hsMsg: m }))
        pane.scrollHeight = pane.children.length * 20
      }
      ${OLDER}
      return {
        loadOlderScrollback, resetScrollback, newestOrdOnScreen, cutSourcesAsOf, renderMessages, renderAsOf,
        state: () => ({ window: _scrollbackWindow, asOf: _scrollbackAsOf }),
      }
    }`.replace('with (scope) {', 'const buf = scope.buf; with (scope) {'),
  )(Object.assign(scope, { buf }))
  // what the reader had when they paused: the 500 rows ending at tailAtPause
  scope.pane = {
    children: buf.slice(tailAtPause - 500, tailAtPause).map((m) => ({ _hsMsg: m })),
    scrollTop: 0,
    scrollHeight: 500 * 20,
  }
  const ords = () => scope.pane.children.map((r) => r._hsMsg.ord)
  return { ...api, scope, ords }
}

test('400 lines arrived since the pause: older rows load above, every row on screen stays, none of the new ones are drawn', () => {
  const r = room({ total: 1400, tailAtPause: 1000 })
  r.loadOlderScrollback()
  const o = r.ords()
  expect([o[0], o.at(-1), o.length]).toEqual([251, 1000, 750]) // 250 older above, the tail where it was
  expect(r.state()).toEqual({ window: 250, asOf: 1000 })
  expect(r.scope.pane.scrollTop).toBe(250 * 20) // the view moved by exactly the rows added above
})

test('counted from the live tail (the old rule, written out) the same step loses the top 150 rows and adds nothing above', () => {
  const r = room({ total: 1400, tailAtPause: 1000 })
  const old = r.scope.buf.slice(-750).map((m) => m.ord) // the last 500 + 250 of the buffer, wherever the reader is
  expect([old[0], old.at(-1)]).toEqual([651, 1400])
})

test('a second step keeps the same pin and goes 250 further back', () => {
  const r = room({ total: 1400, tailAtPause: 1000 })
  r.loadOlderScrollback()
  r.scope.buf.push({ ord: 1401, id: 'm1401' }) // chat keeps arriving
  r.scope.pane.scrollTop = 0
  r.loadOlderScrollback()
  const o = r.ords()
  expect([o[0], o.at(-1), o.length]).toEqual([1, 1000, 1000])
  expect(r.state()).toEqual({ window: 500, asOf: 1000 })
})

test('nothing older in the buffer: the window and the pin go back to where they were', () => {
  const r = room({ total: 500, tailAtPause: 500 })
  r.loadOlderScrollback()
  expect(r.state()).toEqual({ window: 0, asOf: null })
  expect(r.ords().length).toBe(500)
})

test('paused with no older rows loaded: a redraw (a mute, a block) still ends at the newest row the reader has', () => {
  const r = room({ total: 1400, tailAtPause: 1000 })
  r.renderMessages()
  const o = r.ords()
  expect([o[0], o.at(-1), o.length]).toEqual([501, 1000, 500]) // not 901..1400: their rows stay
  expect(r.state()).toEqual({ window: 0, asOf: null }) // nothing was pinned for later: read off the rows each time
})

test('back at the tail the pin is gone and the next render is the live tail again', () => {
  const r = room({ total: 1400, tailAtPause: 1000 })
  r.loadOlderScrollback()
  r.resetScrollback()
  r.scope.isScrolledUp = false
  expect(r.state()).toEqual({ window: 0, asOf: null })
  r.renderMessages()
  const o = r.ords()
  expect([o[0], o.at(-1)]).toEqual([901, 1400])
})

test('the newest row on screen is read from the rows, whatever order they sit in', () => {
  const r = room({ total: 600, tailAtPause: 600 })
  const rows = [{ _hsMsg: { ord: 5 } }, {}, { _hsMsg: { time: 9 } }, { _hsMsg: { ord: 7 } }]
  expect(r.newestOrdOnScreen({ children: rows })).toBe(9)
  expect(r.newestOrdOnScreen({ children: [{}, {}] })).toBe(null)
})

test('the cut leaves sources alone while nothing older is loaded', () => {
  const r = room({ total: 600, tailAtPause: 600 })
  const srcs = [[{ ord: 1 }, { ord: 2 }], [{ ord: 3 }]]
  expect(r.cutSourcesAsOf(srcs, null)).toBe(srcs)
  expect(r.cutSourcesAsOf(srcs, 2)).toEqual([[{ ord: 1 }, { ord: 2 }], []])
})

test('the render cuts before the fair merge and again before the cap; every way back to the tail clears the pin', () => {
  const cut = SRC.indexOf('mtSrcs = cutSourcesAsOf(srcs, asOf)')
  const merge = SRC.indexOf('msgs = fairMerge(mtSrcs, win.keep)', cut)
  expect(cut).toBeGreaterThan(-1)
  expect(merge - cut).toBeLessThan(120)
  const filter = SRC.indexOf('toRender = toRender.filter((m) => ordOf(m) <= asOf)')
  const slice = SRC.indexOf('toRender = toRender.slice(-_cap)', filter)
  expect(filter).toBeGreaterThan(-1)
  expect(slice - filter).toBeLessThan(120)
  // one bare zeroing only, inside resetScrollback
  const all = readdirSync(MC)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(MC, f), 'utf8'))
    .join('\n')
  expect(all.match(/_scrollbackWindow = 0\b/g)?.length).toBe(2) // the declaration and the reset
  expect(all.match(/resetScrollback\(\) \/\/ /g)?.length).toBe(5) // tab switch, two channel navs, bottom reached, pill/End
})

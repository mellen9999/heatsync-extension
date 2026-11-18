/**
 * Where a row lands when the list is redrawn over rows already on screen.
 *
 * A live line that arrives a beat late goes under the last row, so nothing shown moves. That
 * rule read "the line carries an ord" and nothing else, and every live line carries one for
 * good: so every row the list was GIVEN BACK went to the bottom too. Scroll to the top on a
 * tab open a few minutes and the 250 older lines appeared under the newest one; close a card
 * (the list refills newest hundred first) and the older four hundred followed the newest
 * (real twitch, e2e s20, 11-17: the newest row sat at index 506 of 750).
 *
 * Runs the real newRowSlot / isLateLiveLine / ordSpanOnScreen over a pane model, walked the
 * way the renderer walks it: existing rows never move, a new row takes its slot.
 */
import { describe, expect, test } from 'bun:test'
import { LIVE_WEAVE_SKEW_MS, ordOf } from '../src/lib/utils.js'
import { mainSource } from './main-src.js'

const SRC = mainSource()
const fn = (name) => {
  const a = SRC.indexOf(`function ${name}(`)
  const b = SRC.indexOf('\n}\n', a)
  if (a < 0 || b < 0) throw new Error(`carve: ${name}`)
  return SRC.slice(a, b + 3)
}
const Node = { DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4 }
const { newRowSlot, isLateLiveLine, ordSpanOnScreen } = new Function(
  'ordOf',
  'LIVE_WEAVE_SKEW_MS',
  'Node',
  `${fn('ordSpanOnScreen')}\n${fn('isLateLiveLine')}\n${fn('newRowSlot')}\nreturn { newRowSlot, isLateLiveLine, ordSpanOnScreen }`,
)(ordOf, LIVE_WEAVE_SKEW_MS, Node)

function pane(msgs) {
  const rows = []
  const row = (m) => ({
    _hsMsg: m,
    _hsAt: 1,
    get nextSibling() {
      return rows[rows.indexOf(this) + 1] || null
    },
    get previousElementSibling() {
      return rows[rows.indexOf(this) - 1] || null
    },
    compareDocumentPosition(other) {
      return rows.indexOf(other) > rows.indexOf(this)
        ? Node.DOCUMENT_POSITION_FOLLOWING
        : Node.DOCUMENT_POSITION_PRECEDING
    },
  })
  const el = {
    get children() {
      return rows
    },
    get firstElementChild() {
      return rows[0] || null
    },
    get lastElementChild() {
      return rows.at(-1) || null
    },
    insertBefore(node, before) {
      rows.splice(before ? rows.indexOf(before) : rows.length, 0, node)
    },
  }
  for (const m of msgs) rows.push(row(m))
  /** the renderer's walk over the wanted list: a shown row stays, a new one takes its slot */
  const draw = (wanted) => {
    const shown = new Map(rows.map((r) => [r._hsMsg, r]))
    const settledEnd = el.lastElementChild
    const shownSpan = settledEnd ? ordSpanOnScreen(el) : null
    let prevNode = null
    for (const m of wanted) {
      const had = shown.get(m)
      if (had) {
        if (
          !prevNode ||
          had === prevNode.nextSibling ||
          prevNode.compareDocumentPosition(had) & Node.DOCUMENT_POSITION_FOLLOWING
        )
          prevNode = had
        continue
      }
      let after
      ;[prevNode, after] = newRowSlot(el, prevNode, settledEnd, shownSpan, m)
      const div = row(m)
      el.insertBefore(div, after)
      prevNode = div
    }
    return rows.map((r) => r._hsMsg.id)
  }
  return { draw }
}

// one live line a second, each with the ord it was given on arrival
const T0 = 1_794_000_000_000
const live = (n, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: from + i, time: T0 + (from + i) * 1000, ord: T0 + (from + i) * 1000 }))
const ids = (ms) => ms.map((m) => m.id)

describe('rows the list is given back go to their own place', () => {
  test('older rows loaded at the top land above the rows on screen, not under the newest', () => {
    const all = live(750)
    const p = pane(all.slice(250))
    expect(p.draw(all)).toEqual(ids(all))
  })

  test('a cold list filling in steps stays in order: newest hundred, then each older hundred above', () => {
    const all = live(500)
    const p = pane(all.slice(400))
    p.draw(all.slice(300))
    p.draw(all.slice(200))
    expect(p.draw(all)).toEqual(ids(all))
  })

  test('a very fast chat: the first hundred rows span two seconds, the next hundred still land above them', () => {
    // 50 lines a second: every row handed in is inside the "late" window of the newest row
    const all = Array.from({ length: 300 }, (_, i) => ({ id: i, time: T0 + i * 20, ord: T0 + i * 20 }))
    const p = pane(all.slice(200))
    p.draw(all.slice(100))
    expect(p.draw(all)).toEqual(ids(all))
  })

  test('a line a hide rule had taken out comes back where it was', () => {
    const all = live(60)
    const p = pane(all.filter((m) => m.id !== 20))
    expect(p.draw(all)).toEqual(ids(all))
  })

  test('history (no ord) weaves in as before', () => {
    const all = live(40)
    const old = { id: 'h', time: T0 + 9500 }
    const p = pane(all)
    expect(p.draw([...all.slice(0, 10), old, ...all.slice(10)])).toEqual([
      ...ids(all.slice(0, 10)),
      'h',
      ...ids(all.slice(10)),
    ])
  })
})

describe('a late live line still never moves a shown row', () => {
  test('a line a beat behind the last rows goes under them', () => {
    const all = live(40)
    const late = { id: 'late', time: all[38].time - 300, ord: all[38].time - 300 }
    const p = pane(all)
    const wanted = [...all.slice(0, 38), late, ...all.slice(38)]
    expect(p.draw(wanted)).toEqual([...ids(all), 'late'])
  })

  test('late means newer than the oldest row shown and inside twice the weave window of the newest', () => {
    const newest = T0 + 60_000
    const span = [T0, newest]
    expect(isLateLiveLine({ ord: newest - 2 * LIVE_WEAVE_SKEW_MS }, span)).toBe(true)
    expect(isLateLiveLine({ ord: newest - 2 * LIVE_WEAVE_SKEW_MS - 1 }, span)).toBe(false)
    expect(isLateLiveLine({ time: newest - 10 }, span)).toBe(false) // no ord: history
    expect(isLateLiveLine({ ord: newest - 10 }, null)).toBe(false) // an empty list has nothing to protect
    // older than everything shown is above it all, however close in time
    expect(isLateLiveLine({ ord: newest - 500 }, [newest - 400, newest])).toBe(false)
    expect(isLateLiveLine({ ord: newest - 400 }, [newest - 400, newest])).toBe(false) // a tie sorts above too
  })

  test('the renderer asks newRowSlot, and nothing else decides a slot', () => {
    const impl = SRC.slice(SRC.indexOf('function _renderMessagesImpl('))
    expect(impl).toMatch(/\[prevNode, after\] = newRowSlot\(msgsEl, prevNode, settledEnd, shownSpan, m\)/)
    expect(impl.slice(0, impl.indexOf('\n}\n'))).not.toMatch(/m\.ord != null/)
  })
})

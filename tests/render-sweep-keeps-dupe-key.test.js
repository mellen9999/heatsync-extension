import { expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { mainSource } from './main-src.js'

/**
 * The render's first pass over the rows on screen drops a second copy of a key. Dropping it
 * unindexed the key, which the kept copy still carries: the row on screen read as "not shown",
 * the next live line with that key was appended as a second copy again, and the index watchdog
 * logged index_desync and repainted the pane. The sweep, the index and the removal run for real.
 */
const MAIN = mainSource()
const carve = (from, to) => {
  const s = MAIN.indexOf(from)
  const e = MAIN.indexOf(to, s)
  if (s < 0 || e < 0) throw new Error(`carve: ${from}`)
  return MAIN.slice(s, e)
}
const code = [
  carve('function _indexMessageDiv(div, msgKeyStr) {', '\nfunction _clearMessageIndices() {'),
  carve(
    'function sweepPaneRows(msgsEl, id, desiredSet, existingByKey, detachedExtras) {',
    '\nfunction _renderMessagesImpl(',
  ),
].join('\n')

function rig(keys) {
  const document = new Window().document
  const msgsEl = document.createElement('div')
  document.body.appendChild(msgsEl)
  const api = new Function(
    `const _msgKeyIndex = new Set(), _uidIndex = new Map(), _mentionIndex = new Map()
     ${code}
     return { sweepPaneRows, _indexMessageDiv, _msgKeyIndex, _uidIndex }`,
  )()
  const rows = keys.map((k, i) => {
    const row = document.createElement('div')
    row.className = 'hs-mc-msg'
    row.id = `r${i}`
    row.dataset.uid = 'u1'
    row.dataset.msgKey = k
    msgsEl.appendChild(row)
    api._indexMessageDiv(row, k)
    return row
  })
  const ids = () => [...msgsEl.children].map((r) => r.id)
  return { ...api, msgsEl, rows, ids, document }
}

test('a second copy of a key is dropped and the kept copy stays indexed', () => {
  const r = rig(['a', 'b', 'b', 'c'])
  const byKey = new Map()
  const out = r.sweepPaneRows(r.msgsEl, 'live', new Set(['a', 'b', 'c']), byKey, [])
  expect(r.ids()).toEqual(['r0', 'r1', 'r3'])
  expect(byKey.get('b')).toBe(r.rows[1])
  // the index says what the pane says: every key on screen, once
  expect([...r._msgKeyIndex].sort()).toEqual(['a', 'b', 'c'])
  expect(r._uidIndex.get('u1').size).toBe(3)
  expect(out.zebraGap).toBe(true)
  expect(out.zebraGapBelow).toBe(r.rows[3])
})

test('a row the render no longer wants goes, key and all', () => {
  const r = rig(['a', 'b', 'c'])
  const out = r.sweepPaneRows(r.msgsEl, 'live', new Set(['a', 'c']), new Map(), [])
  expect(r.ids()).toEqual(['r0', 'r2'])
  expect([...r._msgKeyIndex].sort()).toEqual(['a', 'c'])
  expect(out.zebraGapBelow).toBe(r.rows[2])
})

test('nothing to drop: nothing moves, no restripe asked for', () => {
  const r = rig(['a', 'b', 'c'])
  const out = r.sweepPaneRows(r.msgsEl, 'live', new Set(['a', 'b', 'c']), new Map(), [])
  expect(r.ids()).toEqual(['r0', 'r1', 'r2'])
  expect(out).toEqual({ zebraGap: false, zebraGapBelow: null })
})

test("this tab's youtube status pin is set aside, another tab's goes, the docked player stays", () => {
  const r = rig(['a', 'b'])
  const pin = (tab) => {
    const el = r.document.createElement('div')
    el.dataset.hsYtStatus = '1'
    el.dataset.hsYtStatusTab = tab
    r.msgsEl.appendChild(el)
    return el
  }
  const mine = pin('live')
  const other = pin('elsewhere')
  const player = r.document.createElement('div')
  player.id = 'hs-mc-embed-player'
  r.msgsEl.appendChild(player)
  const extras = []
  r.sweepPaneRows(r.msgsEl, 'live', new Set(['a', 'b']), new Map(), extras)
  expect(extras).toEqual([mine])
  expect(mine.isConnected).toBe(false)
  expect(other.isConnected).toBe(false)
  expect(player.isConnected).toBe(true)
  expect(r.ids()).toEqual(['r0', 'r1', 'hs-mc-embed-player'])
})

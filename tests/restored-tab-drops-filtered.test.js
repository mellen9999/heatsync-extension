import { expect, test } from 'bun:test'
import { mainSource } from './main-src.js'

/**
 * A tab's rows are kept in a fragment while it is away and put back as they were; the first
 * render after only appends. A hide (or block, /lclear, a content filter) whose render was that
 * first one never reached the rows already back on screen: /hide left 3 of a chatter's 10 rows
 * (e2e s18, 11-17). Rows the render now leaves out on purpose go; rows the merge merely stopped
 * picking stay, so a restore still never reshuffles. dropRestoredFiltered runs for real.
 */
const SRC = mainSource()
const s = SRC.indexOf('function dropRestoredFiltered(')
const FN = SRC.slice(s, SRC.indexOf('\nfunction restoreTabState', s))

function pane(keys) {
  const unindexed = []
  const el = { children: [] }
  for (const k of keys) {
    const row = { dataset: { msgKey: k }, remove: () => el.children.splice(el.children.indexOf(row), 1) }
    el.children.push(row)
  }
  const drop = new Function('msgKeyOf', '_unindexMessageDiv', `${FN}\nreturn dropRestoredFiltered`)(
    (m) => m.k,
    (row) => unindexed.push(row.dataset.msgKey),
  )
  return { el, drop, unindexed, keys: () => el.children.map((r) => r.dataset.msgKey) }
}

test('a row the render leaves out goes, unindexed; the rest stay in place', () => {
  const p = pane(['a', 'hid1', 'b', 'hid2', 'c'])
  const lines = ['a', 'hid1', 'b', 'hid2', 'c'].map((k) => ({ k }))
  p.drop(p.el, lines, new Set(['a', 'b', 'c']))
  expect(p.keys()).toEqual(['a', 'b', 'c'])
  expect(p.unindexed).toEqual(['hid1', 'hid2'])
})

test('a row no longer among the merged lines (fair-merge shifted) is left alone', () => {
  const p = pane(['old', 'a', 'b'])
  p.drop(p.el, [{ k: 'a' }, { k: 'b' }], new Set(['a', 'b']))
  expect(p.keys()).toEqual(['old', 'a', 'b'])
})

test('nothing filtered: nothing touched', () => {
  const p = pane(['a', 'b'])
  p.drop(p.el, [{ k: 'a' }, { k: 'b' }], new Set(['a', 'b']))
  expect(p.keys()).toEqual(['a', 'b'])
  expect(p.unindexed).toEqual([])
})

test('the restore fast path runs it before appending', () => {
  const fast = SRC.slice(SRC.indexOf('  if (justRestored) {'))
  expect(fast.indexOf('dropRestoredFiltered(msgsEl, msgs, desiredSet)')).toBeGreaterThan(0)
  expect(fast.indexOf('dropRestoredFiltered(')).toBeLessThan(fast.indexOf('msgsEl.appendChild(div)'))
})

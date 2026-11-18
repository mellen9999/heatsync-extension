import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { mainSource } from './main-src.js'

/**
 * A profile card, a prediction view and a full-size picture each take the whole chat pane. They
 * wiped the rows and left every row key in the index, so the index watchdog saw drift each time
 * one opened (index_desync, dom 0 / idx 290-500, on twitch, kick and youtube: e2e s23, 11-17)
 * and "healed" it with a render, which redrew the open card under the reader. They now drop the
 * rows and the index in one step. The watchdog and the takeover run for real.
 */
const MAIN = mainSource()
const carve = (from, to) => {
  const s = MAIN.indexOf(from)
  const e = MAIN.indexOf(to, s)
  if (s < 0 || e < 0) throw new Error(`carve: ${from}`)
  return MAIN.slice(s, e)
}
const src = [
  carve('function _clearMessageIndices() {', '\n// '),
  `${carve('function takePane(msgsEl) {', '\n}\n')}\n}\n`,
  carve('function _reconcileMsgKeyIndex(msgsEl) {', '\nfunction renderStallCheck() {'),
].join('\n')

function rig() {
  const win = new Window()
  const doc = win.document
  const msgsEl = doc.createElement('div')
  doc.body.appendChild(msgsEl)
  const diag = []
  const renders = []
  const api = new Function(
    'window',
    'scheduleRenderMessages',
    `let _heldOlder = null, currentTab = 'live', _desyncLoggedAt = 0, _paneKept = null
     const isScrolledUp = false, hoverHeld = false, newestOrdOnScreen = () => null
     const _msgKeyIndex = new Set(), _uidIndex = new Map(), _mentionIndex = new Map()
     const _noHeal = () => false
     ${src}
     return { takePane, _reconcileMsgKeyIndex, _msgKeyIndex, _uidIndex, _mentionIndex, hold: (h) => (_heldOlder = h), held: () => _heldOlder }`,
  )({ __hsDiag: (kind, data) => diag.push([kind, data]) }, () => renders.push(1))
  for (let i = 0; i < 300; i++) {
    const row = doc.createElement('div')
    row.dataset.msgKey = `k${i}`
    msgsEl.appendChild(row)
    api._msgKeyIndex.add(`k${i}`)
    api._uidIndex.set(`u${i}`, new Set([row]))
    api._mentionIndex.set(`u${i}`, new Set([row]))
  }
  return { ...api, msgsEl, diag, renders, doc }
}

test('the watchdog is quiet on a pane whose rows and index agree', () => {
  const r = rig()
  r._reconcileMsgKeyIndex(r.msgsEl)
  expect(r.diag).toEqual([])
  expect(r.renders).toEqual([])
})

test('the old takeover, rows wiped and keys left behind, is what the watchdog fought', () => {
  const r = rig()
  r.msgsEl.textContent = ''
  r._reconcileMsgKeyIndex(r.msgsEl)
  expect(r.diag).toEqual([['index_desync', { tab: 'live', dom: 0, idx: 300 }]])
  expect(r.renders.length).toBe(1)
})

test('a view that takes the pane leaves nothing for the watchdog: no desync, no render', () => {
  const r = rig()
  r.hold({ id: 'live', frag: r.doc.createDocumentFragment() })
  r.takePane(r.msgsEl)
  expect(r.msgsEl.childElementCount).toBe(0)
  expect(r._msgKeyIndex.size).toBe(0)
  // row refs go with the rows: a mod action never lands on a detached row
  expect(r._uidIndex.size).toBe(0)
  expect(r._mentionIndex.size).toBe(0)
  expect(r.held()).toBe(null)
  r._reconcileMsgKeyIndex(r.msgsEl)
  expect(r.diag).toEqual([])
  expect(r.renders).toEqual([])
})

test('the card, the prediction view and the picture view all take the pane that way', () => {
  const dir = join(import.meta.dir, '..', 'src', 'multichat')
  const card = readFileSync(join(dir, 'profile-card.js'), 'utf8')
  const pred = readFileSync(join(dir, 'pred-view.js'), 'utf8')
  const img = readFileSync(join(dir, 'img-view.js'), 'utf8')
  expect(card).toContain('if (!floating) takePane(msgsEl)')
  expect(pred.slice(pred.indexOf('function renderPredView() {'))).toMatch(/^.*\n.*\n.*\n {2}takePane\(msgsEl\)/)
  expect(img.slice(img.indexOf('function openImgView(src) {'))).toContain('takePane(msgsEl)')
  for (const s of [card, pred, img]) expect(s).not.toContain("msgsEl.textContent = ''")
})

test('a pane rebuilt after the host swapped our container away starts with an empty index', () => {
  expect(MAIN).toMatch(/overlayElement = createOverlay\(\)\n(?:\s*\/\/.*\n)*\s*_clearMessageIndices\(\)/)
})

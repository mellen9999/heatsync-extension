import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { mainSource } from './main-src.js'

/**
 * A row that leaves the pane on its own takes its index entries with it. Five removals took the
 * row and left its key: a deleted or cleared row with dimming off, a resolved held message, a
 * dismissed one, a share notice replaced by its real twin, and the rows an unmute rebuilds. The
 * index watchdog met each stray key within seconds, logged index_desync and repainted the whole
 * pane. The index, the removal, the watchdog, the cleared-row path and the unmute path run for
 * real here.
 */
const MAIN = mainSource()
const INPUT = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
const carve = (src, from, to) => {
  const s = src.indexOf(from)
  const e = src.indexOf(to, s)
  if (s < 0 || e < 0) throw new Error(`carve: ${from}`)
  return src.slice(s, e)
}
const code = [
  carve(MAIN, 'function _indexMessageDiv(div, msgKeyStr) {', '\nfunction _clearMessageIndices() {'),
  carve(MAIN, 'function _reconcileMsgKeyIndex(msgsEl) {', '\nfunction renderStallCheck() {'),
  carve(MAIN, 'function markClearedRow(row, title) {', '\nfunction clearYtSendingRow(id) {'),
  carve(INPUT, 'function restoreMcUnmutedDom(username) {', '\nfunction stripMcMutedMessage(msg) {'),
].join('\n')

function rig({ dim = false } = {}) {
  const win = new Window()
  const document = win.document
  const msgsEl = document.createElement('div')
  document.body.appendChild(msgsEl)
  const diag = []
  const renders = []
  const api = new Function(
    'window',
    'document',
    'scheduleRenderMessages',
    'dimTimeouts',
    't',
    `let _heldOlder = null, currentTab = 'live', _desyncLoggedAt = 0
     const _msgKeyIndex = new Set(), _uidIndex = new Map(), _mentionIndex = new Map()
     const _noHeal = () => false
     ${code}
     return { _indexMessageDiv, removeRow, _reconcileMsgKeyIndex, markClearedRow, restoreMcUnmutedDom, _msgKeyIndex, _uidIndex, _mentionIndex }`,
  )(
    { __hsDiag: (kind, data) => diag.push([kind, data]) },
    document,
    () => renders.push(1),
    dim,
    (k) => k,
  )
  const add = (i, user) => {
    const row = document.createElement('div')
    row.className = 'hs-mc-msg'
    row.dataset.uid = `u-${user}`
    const name = document.createElement('a')
    name.className = 'hs-mc-user'
    name.textContent = user
    const mention = document.createElement('a')
    mention.className = 'hs-mc-mention'
    mention.dataset.uid = 'u-carol'
    row.append(name, ' hi ', mention)
    row.dataset.msgKey = `k${i}`
    msgsEl.appendChild(row)
    api._indexMessageDiv(row, `k${i}`)
    return row
  }
  const rows = [add(0, 'alice'), add(1, 'bob'), add(2, 'alice'), add(3, 'bob')]
  const quiet = () => {
    api._reconcileMsgKeyIndex(msgsEl)
    return diag.length === 0 && renders.length === 0
  }
  return { ...api, msgsEl, rows, diag, renders, quiet }
}

test('a row taken out the old way is what the watchdog repainted the pane for', () => {
  const r = rig()
  r.rows[1].remove()
  expect(r.quiet()).toBe(false)
  expect(r.diag[0]).toEqual(['index_desync', { tab: 'live', dom: 3, idx: 4 }])
  expect(r.renders.length).toBe(1)
})

test('the watchdog heals all three indices from the rows, not the keys alone', () => {
  const r = rig()
  const gone = r.rows[1]
  gone.remove()
  // and a row that reached the pane without being indexed
  const stray = r.rows[0].cloneNode(true)
  stray.dataset.msgKey = 'k9'
  stray.dataset.uid = 'u-dave'
  r.msgsEl.appendChild(stray)
  r._reconcileMsgKeyIndex(r.msgsEl)
  expect([...r._msgKeyIndex].sort()).toEqual(['k0', 'k2', 'k3', 'k9'])
  expect([...r._uidIndex.get('u-bob')]).toEqual([r.rows[3]])
  expect([...r._uidIndex.get('u-dave')]).toEqual([stray])
  const mentions = [...r._mentionIndex.get('u-carol')]
  expect(mentions.length).toBe(4)
  expect(mentions.every((m) => m.isConnected)).toBe(true)
})

test('removeRow takes the key, the row ref and the mention refs with the row', () => {
  const r = rig()
  r.removeRow(r.rows[1])
  r.removeRow(r.rows[3])
  expect(r.msgsEl.childElementCount).toBe(2)
  expect([...r._msgKeyIndex]).toEqual(['k0', 'k2'])
  expect(r._uidIndex.has('u-bob')).toBe(false)
  expect(r._uidIndex.get('u-alice').size).toBe(2)
  expect(r._mentionIndex.get('u-carol').size).toBe(2)
  expect(r.quiet()).toBe(true)
  // nothing to remove is not an error
  r.removeRow(null)
  r.removeRow(undefined)
})

test('a deleted row with dimming off leaves no stray key', () => {
  const r = rig()
  r.markClearedRow(r.rows[2], 'deleted')
  expect(r.rows[2].isConnected).toBe(false)
  expect(r._msgKeyIndex.has('k2')).toBe(false)
  expect(r.quiet()).toBe(true)
})

test('the rows an unmute throws away to rebuild leave no stray key', () => {
  const r = rig()
  for (const row of [r.rows[1], r.rows[3]]) row.classList.add('hs-mc-muted')
  r.restoreMcUnmutedDom('Bob')
  expect(r.msgsEl.childElementCount).toBe(2)
  expect([...r._msgKeyIndex]).toEqual(['k0', 'k2'])
  expect(r.quiet()).toBe(true)
})

test('no single-row removal in the chat code goes around removeRow', () => {
  const main = `${MAIN}\n${INPUT}`
  // the held-message paths and the replaced share notice
  expect(main).toContain('removeRow(msgsEl?.querySelector(`.hs-mc-msg[data-msg-id="${safe}"]`))')
  expect(main).toMatch(/if \(held\) held\.resolved = true\s*removeRow\(row\)/)
  expect(main).toMatch(
    /const row = msgsEl\?\.querySelector\(`\.hs-mc-msg\[data-msg-id="\$\{safe\}"\]`\)\s*removeRow\(row\)/,
  )
  // and the only place a row is unindexed then removed by hand is removeRow itself
  const count = (re) => (main.match(re) || []).length
  expect(count(/_unindexMessageDiv\((\w+(?:\.\w+)?)\)\s*(?:\} catch \(_\) \{\}\s*)?\1\.remove\(\)/g)).toBe(1)
  expect(count(/\b(?:row|msg)\??\.remove\(\)/g)).toBe(1)
})

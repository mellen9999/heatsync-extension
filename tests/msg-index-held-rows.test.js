/**
 * The key index must mirror the tab's rows, and a cache restore holds the older ones back to
 * mount in chunks (holdOlderRows), indexed already. The stall check reconciled against the
 * mounted rows only: between two chunks it read the held rows as strays, logged index_desync and
 * dropped their keys (seen on mellen's laptop 11-16: dom 200, idx 428). Runs the real
 * _reconcileMsgKeyIndex from src/multichat/main-messages.js in happy-dom.
 */
import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main-messages.js'), 'utf8')
const s = SRC.indexOf('function _reconcileMsgKeyIndex(')
const BODY = SRC.slice(s, SRC.indexOf('\n}\n', s) + 3)
// the heal rebuilds every index through the real indexer
const STATE = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main-state.js'), 'utf8')
const i = STATE.indexOf('function _indexMessageDiv(')
const INDEXER = STATE.slice(i, STATE.indexOf('\n}\n', i) + 3)

let win
afterEach(() => win?.happyDOM.close())

function setup({ mounted, held, indexed }) {
  win = new Window()
  const document = win.document
  const rows = (keys) => keys.map((k) => `<div class="hs-mc-msg" data-msg-key="${k}"></div>`).join('')
  document.body.innerHTML = `<div id="msgs">${rows(mounted)}</div><template id="t">${rows(held)}</template>`
  const frag = document.createDocumentFragment()
  for (const el of [...document.getElementById('t').content.children]) frag.appendChild(el.cloneNode(true))
  const index = new Set(indexed)
  const logged = []
  let renders = 0
  const reconcile = new Function(
    '_msgKeyIndex',
    '_heldOlder',
    'currentTab',
    'window',
    '_noHeal',
    'scheduleRenderMessages',
    `let _desyncLoggedAt = 0\nconst _uidIndex = new Map(), _mentionIndex = new Map()\n${INDEXER}\n${BODY}\nreturn _reconcileMsgKeyIndex`,
  )(
    index,
    held.length ? { id: 'kripp', frag } : null,
    'kripp',
    { __hsDiag: (e, x) => logged.push([e, x]) },
    () => false,
    () => renders++,
  )
  reconcile(document.getElementById('msgs'))
  return { index, logged, renders: () => renders }
}

const keys = (n, from = 0) => Array.from({ length: n }, (_, i) => `k${from + i}`)

test('rows held back by a restore are not strays', () => {
  const r = setup({ mounted: keys(200, 228), held: keys(228), indexed: keys(428) })
  expect(r.logged).toEqual([])
  expect(r.index.size).toBe(428)
  expect(r.renders()).toBe(0)
})

test('a key with no row anywhere is still healed', () => {
  const r = setup({ mounted: keys(100, 10), held: keys(10), indexed: [...keys(110), 'gone'] })
  expect(r.logged.map(([e]) => e)).toEqual(['index_desync'])
  expect(r.index.has('gone')).toBe(false)
  expect(r.index.size).toBe(110)
  expect(r.renders()).toBe(1)
})

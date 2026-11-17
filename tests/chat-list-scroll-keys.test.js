import { expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { mainSource } from './main-src.js'

/**
 * End, Home, the page keys and the arrows move the chat list. The list is not focusable and a
 * click on a row focuses nothing, so the key listener that sat on the list never fired: scrolled
 * up, End did not come back to the newest rows on twitch, kick or youtube (e2e s20, 11-17). The
 * keys are now heard on the root element and the list is moved by us. The two rules that decide
 * (what a key does, and whether it is meant for the list) run for real here.
 */
const SRC = mainSource()
const cut = (name) => {
  const s = SRC.indexOf(`function ${name}(`)
  return SRC.slice(s, SRC.indexOf('\n}\n', s) + 3)
}
const { listKeyMove, listKeyWanted } = new Function(
  `${cut('listKeyMove')}\n${cut('listKeyWanted')}\nreturn { listKeyMove, listKeyWanted }`,
)()

test('what each key does: the tail, the top, a page, a few rows, or nothing', () => {
  expect(listKeyMove('End', 600)).toBe('tail')
  expect(listKeyMove('Home', 600)).toBe('top')
  expect(listKeyMove('PageUp', 600)).toBe(-540)
  expect(listKeyMove('PageDown', 600)).toBe(540)
  expect(listKeyMove('ArrowUp', 600)).toBe(-60)
  expect(listKeyMove('ArrowDown', 600)).toBe(60)
  expect(listKeyMove('PageDown', 0)).toBe(40) // a list not laid out yet still moves
  for (const k of ['k', ' ', 'Enter', 'Escape', 'Tab', 'ArrowLeft']) expect([k, listKeyMove(k, 600)]).toEqual([k, null])
})

function page() {
  const doc = new Window().document
  const mk = (tag, parent, id) => {
    const el = doc.createElement(tag)
    if (id) el.id = id
    parent.appendChild(el)
    return el
  }
  const panel = mk('div', doc.body, 'hs-mc-container')
  const list = mk('div', panel, 'hs-mc-messages')
  const row = mk('div', list)
  row.tabIndex = 0
  const tab = mk('button', panel)
  const composer = mk('input', panel, 'hs-mc-input')
  const player = mk('div', doc.body, 'player')
  player.tabIndex = 0
  const hostField = mk('textarea', doc.body)
  return { doc, panel, list, row, tab, composer, player, hostField }
}

test('pointer on the list, focus on nothing (a row was clicked): the key is the list’s', () => {
  const p = page()
  expect(listKeyWanted(p.doc.body, p.list, p.panel, true)).toBe(true)
  expect(listKeyWanted(null, p.list, p.panel, true)).toBe(true)
  expect(listKeyWanted(p.tab, p.list, p.panel, true)).toBe(true) // a tab of ours was clicked last
})

test('focus inside the list is enough, wherever the pointer is', () => {
  const p = page()
  expect(listKeyWanted(p.row, p.list, p.panel, false)).toBe(true)
})

test('pointer elsewhere: the page keeps its keys', () => {
  const p = page()
  expect(listKeyWanted(p.doc.body, p.list, p.panel, false)).toBe(false)
  expect(listKeyWanted(p.tab, p.list, p.panel, false)).toBe(false)
})

test('a field taking text, ours or the host’s, and the host’s focused player keep their keys', () => {
  const p = page()
  expect(listKeyWanted(p.composer, p.list, p.panel, true)).toBe(false)
  expect(listKeyWanted(p.hostField, p.list, p.panel, true)).toBe(false)
  expect(listKeyWanted(p.player, p.list, p.panel, true)).toBe(false)
})

test('the keys are heard on the root element, before the host, and End is the pill’s own jump', () => {
  const at = SRC.indexOf('const move = listKeyMove(e.key, msgsEl.clientHeight)')
  const head = SRC.slice(SRC.lastIndexOf('addEventListener(', at) - 40, at)
  expect(head).toContain('document.documentElement.addEventListener(')
  expect(head).toContain('if (e.defaultPrevented')
  const body = SRC.slice(at, SRC.indexOf('// Mousedown on scrollbar thumb', at))
  expect(body).toContain('e.stopImmediatePropagation()')
  expect(body).toContain('{ signal: mcSignal, capture: true }')
  expect(body).toContain('jumpToTail()')
  expect(SRC).toContain("newBtn.addEventListener('click', jumpToTail, { signal: mcSignal })")
  // the dead listener on the list itself is gone
  expect(SRC).not.toMatch(
    /msgsEl\.addEventListener\(\s*'keydown',\s*\(e\) => \{\s*if \(isStaticTab\(\)\) return\s*if \(e\.key === 'PageUp'/,
  )
})

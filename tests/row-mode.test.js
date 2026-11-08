/**
 * Row mode — a cursor over the chat rows, so every message is reachable without a
 * mouse. Entered on purpose (vi <Space> r, or alt+r); inside it j/k/g/G move,
 * enter opens the row's right-click menu, r replies, esc leaves.
 *
 * row-mode.js + overlay-keys.js run for real against a happy-dom page, with the
 * bundle-scope names they lean on (currentTab, HsNotifs, rowReplyState,
 * setReplyState, t) injected. The leader is driven through the real registry
 * (window.__hsOverlayCommand), the same door vi-mode.js uses.
 *
 * What has to hold: the cursor is real focus (that is what a screen reader
 * reads), it stays on its row while chat appends, bare keys are ONLY ever
 * touched while the mode is on, and typing always wins.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { t } from './en-t.js'

const dir = join(import.meta.dir, '..', 'src', 'multichat')
const SRC = ['overlay-keys.js', 'row-mode.js'].map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')

let win
let doc
let api
let ctl
let calls

const CURSOR = 'hs-mc-row-cursor'
const flush = () => new Promise((r) => setTimeout(r, 5))

function addRow(key, text = key) {
  const row = doc.createElement('div')
  row.className = 'hs-mc-msg'
  row.dataset.msgKey = key
  row.textContent = text
  doc.getElementById('hs-mc-messages').appendChild(row)
  return row
}
const rowEls = () => [...doc.querySelectorAll('#hs-mc-messages > .hs-mc-msg')]
const cursorEls = () => [...doc.querySelectorAll(`.${CURSOR}`)]
const lastStatus = () => calls.status[calls.status.length - 1]

beforeEach(() => {
  win = new Window({ width: 1000, height: 800 })
  doc = win.document
  doc.body.innerHTML =
    '<div id="hs-mc-overlay"><div id="hs-mc-messages"></div><textarea id="hs-mc-input"></textarea></div><a id="elsewhere" href="#">x</a>'
  // happy-dom lays nothing out: say the list is on screen
  doc.getElementById('hs-mc-messages').getClientRects = () => [{}]
  calls = { status: [], dismissed: [], replied: [], detached: [], menu: [] }
  ctl = new AbortController()
  win.__hsViDetachNow = (el) => calls.detached.push(el)
  api = new Function(
    'document',
    'window',
    'MouseEvent',
    'MutationObserver',
    't',
    'HsNotifs',
    'rowReplyState',
    'setReplyState',
    `
    let currentTab = 'chan' // the bundle's live tab name; tests move it through setTab
    ${SRC}
    return { setTab: (v) => { currentTab = v }, enterRowMode, exitRowMode, rowModeActive, toggleRowMode, handleRowModeKey, initRowMode, initOverlayKeys, rowModeRows }
    `,
  )(
    doc,
    win,
    win.MouseEvent,
    win.MutationObserver,
    t,
    {
      emit: (_type, p) => calls.status.push(p.text),
      dismissByKey: (type, key) => calls.dismissed.push([type, key]),
    },
    (row) => (row?.dataset?.noreply ? null : { id: row.dataset.msgKey }),
    (s) => {
      calls.replied.push(s)
      doc.getElementById('hs-mc-input').focus() // what the real one does
    },
  )
  api.initOverlayKeys(ctl.signal)
  api.initRowMode(ctl.signal)
})
afterEach(async () => {
  ctl.abort()
  await win.happyDOM.close()
})

// a keydown on the focused element, bubbling to the capture listener on document
const press = (key, init = {}) => {
  const target = doc.activeElement || doc.body
  const ev = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(ev)
  return ev
}

describe('getting in', () => {
  test('<Space> r (the leader) puts the cursor on the newest row and focuses it', () => {
    const rows = [addRow('a'), addRow('b'), addRow('c')]
    expect(win.__hsOverlayCommand('r')).toBe(true)
    expect(api.rowModeActive()).toBe(true)
    expect(cursorEls()).toEqual([rows[2]])
    expect(doc.activeElement).toBe(rows[2])
    expect(rows[2].getAttribute('tabindex')).toBe('-1')
  })

  test('alt+r path (toggleRowMode) enters, and leaves again', () => {
    addRow('a')
    expect(api.toggleRowMode()).toBe(true)
    expect(api.rowModeActive()).toBe(true)
    expect(api.toggleRowMode()).toBe(true)
    expect(api.rowModeActive()).toBe(false)
  })

  test('with no rows it does not open, and says it did not, so the key falls through', () => {
    expect(win.__hsOverlayCommand('r')).toBe(false)
    expect(api.rowModeActive()).toBe(false)
    expect(api.enterRowMode()).toBe(false)
  })

  test('chat hidden (not laid out): does not open', () => {
    addRow('a')
    doc.getElementById('hs-mc-messages').getClientRects = () => []
    expect(api.enterRowMode()).toBe(false)
  })

  test('only chat lines and feed posts count as rows', () => {
    addRow('a')
    const junk = doc.createElement('div')
    junk.className = 'hs-mc-empty'
    doc.getElementById('hs-mc-messages').appendChild(junk)
    const post = doc.createElement('div')
    post.className = 'hs-feed-msg'
    doc.getElementById('hs-mc-messages').appendChild(post)
    expect(api.rowModeRows().length).toBe(2)
  })

  test('from the composer: it lets go at once (no 150ms gap for a j to fall into) and vi is told', () => {
    addRow('a')
    const composer = doc.getElementById('hs-mc-input')
    composer.focus()
    expect(api.enterRowMode()).toBe(true)
    expect(doc.activeElement).not.toBe(composer)
    expect(calls.detached).toEqual([composer])
  })

  test('the status line names the position and the keys', () => {
    addRow('a')
    addRow('b')
    api.enterRowMode()
    expect(lastStatus()).toBe('2/2 · j k move · enter actions · r reply · esc leave')
  })
})

describe('moving', () => {
  test('j / k and the arrows step one row, clamped at both ends', () => {
    const rows = [addRow('a'), addRow('b'), addRow('c')]
    api.enterRowMode()
    press('k')
    expect(doc.activeElement).toBe(rows[1])
    press('ArrowUp')
    expect(doc.activeElement).toBe(rows[0])
    press('k')
    expect(doc.activeElement).toBe(rows[0])
    press('j')
    press('ArrowDown')
    press('j')
    expect(doc.activeElement).toBe(rows[2])
  })

  test('g / G / home / end jump to the ends', () => {
    const rows = [addRow('a'), addRow('b'), addRow('c')]
    api.enterRowMode()
    press('g')
    expect(doc.activeElement).toBe(rows[0])
    press('G')
    expect(doc.activeElement).toBe(rows[2])
    press('Home')
    expect(doc.activeElement).toBe(rows[0])
    press('End')
    expect(doc.activeElement).toBe(rows[2])
  })

  test('exactly one row wears the cursor, and the one left behind is clean', () => {
    const rows = [addRow('a'), addRow('b')]
    api.enterRowMode()
    press('k')
    expect(cursorEls()).toEqual([rows[0]])
    expect(rows[1].hasAttribute('tabindex')).toBe(false)
  })

  test('every move updates the status line', () => {
    addRow('a')
    addRow('b')
    addRow('c')
    api.enterRowMode()
    press('k')
    expect(lastStatus()).toStartWith('2/3')
  })

  test('handled keys are swallowed', () => {
    addRow('a')
    api.enterRowMode()
    expect(press('j').defaultPrevented).toBe(true)
  })
})

describe('the actions', () => {
  test("enter fires the row's own contextmenu, flagged as from the keyboard", () => {
    const rows = [addRow('a'), addRow('b')]
    doc.getElementById('hs-mc-messages').addEventListener('contextmenu', (e) => {
      calls.menu.push({ row: e.target, kbd: e.hsKeyboard === true })
      e.preventDefault() // a menu opened
    })
    api.enterRowMode()
    press('k')
    press('Enter')
    expect(calls.menu).toEqual([{ row: rows[0], kbd: true }])
    expect(api.rowModeActive()).toBe(true) // the menu hands focus back; the mode stays
  })

  test('enter on a row with no menu says so instead of doing nothing', () => {
    addRow('a')
    api.enterRowMode()
    press('Enter')
    expect(lastStatus()).toBe('nothing to do on this row')
  })

  test('while the menu is open, the menu owns the keys: j does not move the cursor', () => {
    const rows = [addRow('a'), addRow('b')]
    api.enterRowMode()
    const menu = doc.createElement('div')
    menu.id = 'hs-mc-msg-ctx'
    doc.body.appendChild(menu)
    expect(api.handleRowModeKey(new win.KeyboardEvent('keydown', { key: 'k' }))).toBe(false)
    expect(doc.activeElement).toBe(rows[1])
  })

  test('r replies to that row, leaves the mode, and the composer takes over', () => {
    addRow('a')
    addRow('b')
    api.enterRowMode()
    press('k')
    press('r')
    expect(calls.replied).toEqual([{ id: 'a' }])
    expect(api.rowModeActive()).toBe(false)
    expect(cursorEls()).toEqual([])
    expect(doc.activeElement).toBe(doc.getElementById('hs-mc-input'))
  })

  test('r on a row that cannot be replied to says so and stays in the mode', () => {
    const row = addRow('a')
    row.dataset.noreply = '1'
    api.enterRowMode()
    press('r')
    expect(calls.replied).toEqual([])
    expect(api.rowModeActive()).toBe(true)
    expect(lastStatus()).toBe("this row can't be replied to")
  })
})

describe('getting out', () => {
  test('esc leaves, drops the cursor and the status line, returns focus to the composer it came from', () => {
    const rows = [addRow('a')]
    const composer = doc.getElementById('hs-mc-input')
    composer.focus()
    api.enterRowMode()
    expect(press('Escape').defaultPrevented).toBe(true)
    expect(api.rowModeActive()).toBe(false)
    expect(cursorEls()).toEqual([])
    expect(rows[0].hasAttribute('tabindex')).toBe(false)
    expect(calls.dismissed).toEqual([['row-mode', 'row-mode']])
    expect(doc.activeElement).toBe(composer)
  })

  test('esc from a mode entered elsewhere does not drag focus into the composer', () => {
    addRow('a')
    api.enterRowMode()
    press('Escape')
    expect(doc.activeElement).not.toBe(doc.getElementById('hs-mc-input'))
  })

  test('focus landing in the composer ends the mode: typing always types', () => {
    addRow('a')
    api.enterRowMode()
    doc.getElementById('hs-mc-input').focus()
    expect(api.rowModeActive()).toBe(false)
    expect(cursorEls()).toEqual([])
  })

  test('focus wandering to something that is not a row ends it without eating the key', () => {
    addRow('a')
    api.enterRowMode()
    doc.getElementById('elsewhere').focus()
    const ev = press('j')
    expect(api.rowModeActive()).toBe(false)
    expect(ev.defaultPrevented).toBe(false)
  })

  test('switching tab ends it', () => {
    addRow('a')
    api.enterRowMode()
    api.setTab('other')
    press('j')
    expect(api.rowModeActive()).toBe(false)
    expect(cursorEls()).toEqual([])
  })

  test('the rows all going away ends it', () => {
    const rows = [addRow('a')]
    api.enterRowMode()
    rows[0].remove()
    press('j')
    expect(api.rowModeActive()).toBe(false)
  })

  test('tab leaves the mode and is NOT consumed (it goes on to the composer)', () => {
    addRow('a')
    api.enterRowMode()
    expect(press('Tab').defaultPrevented).toBe(false)
    expect(api.rowModeActive()).toBe(false)
  })

  test('the abort signal takes the listeners with it', () => {
    addRow('a')
    api.enterRowMode()
    ctl.abort()
    expect(press('j').defaultPrevented).toBe(false)
  })
})

describe('chat keeps moving', () => {
  test('rows appending do not move the cursor off its row', async () => {
    const rows = [addRow('a'), addRow('b')]
    api.enterRowMode()
    press('k')
    addRow('c')
    addRow('d')
    await flush()
    expect(cursorEls()).toEqual([rows[0]])
    expect(doc.activeElement).toBe(rows[0])
    press('j')
    expect(doc.activeElement).toBe(rows[1])
    press('G')
    expect(doc.activeElement).toBe(rowEls()[3])
  })

  test('a re-render that swaps the row for a new element (same key) puts the cursor back on it', async () => {
    addRow('a')
    addRow('b')
    api.enterRowMode()
    const old = doc.activeElement
    const fresh = doc.createElement('div')
    fresh.className = 'hs-mc-msg'
    fresh.dataset.msgKey = 'b'
    old.replaceWith(fresh)
    await flush()
    expect(api.rowModeActive()).toBe(true)
    expect(cursorEls()).toEqual([fresh])
    expect(doc.activeElement).toBe(fresh)
  })

  test('a row trimmed off the top: the cursor lands on the oldest row left', async () => {
    const rows = [addRow('a'), addRow('b'), addRow('c')]
    api.enterRowMode()
    press('g')
    rows[0].remove()
    await flush()
    expect(api.rowModeActive()).toBe(true)
    expect(cursorEls()).toEqual([rows[1]])
  })
})

describe('inactive means invisible', () => {
  test('no key is consumed while the mode is off', () => {
    addRow('a')
    for (const k of ['j', 'k', 'r', 'g', 'Enter', 'Escape']) expect(press(k).defaultPrevented).toBe(false)
  })

  test("modified keys are never the mode's, even when it is on", () => {
    addRow('a')
    addRow('b')
    api.enterRowMode()
    const before = doc.activeElement
    for (const mod of ['altKey', 'ctrlKey', 'metaKey']) expect(press('k', { [mod]: true }).defaultPrevented).toBe(false)
    expect(doc.activeElement).toBe(before)
  })

  test('a stray printable key is swallowed while on, a function key is not', () => {
    addRow('a')
    api.enterRowMode()
    expect(press('q').defaultPrevented).toBe(true)
    expect(press('F5').defaultPrevented).toBe(false)
    expect(press('Shift').defaultPrevented).toBe(false)
  })

  test('typing in the composer is untouched even while the mode is on', () => {
    addRow('a')
    api.enterRowMode()
    // an editable focused ends the mode on focusin; and if a key arrives from one regardless, it is left alone
    const composer = doc.getElementById('hs-mc-input')
    composer.focus()
    expect(press('j').defaultPrevented).toBe(false)
  })
})

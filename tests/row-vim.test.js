/**
 * K03 / K04: visual mode (v) and hint mode (f / F) inside row mode. Runs the real row-mode.js +
 * row-vim.js on a happy-dom page with the bundle names they lean on stubbed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { t } from './en-t.js'

const dir = join(import.meta.dir, '..', 'src', 'multichat')
const SRC = ['overlay-keys.js', 'row-mode.js', 'row-vim.js'].map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')

let win
let doc
let api
let ctl
let calls

beforeEach(() => {
  win = new Window({ width: 1000, height: 800 })
  doc = win.document
  doc.body.innerHTML = '<div id="hs-mc-messages"></div><textarea id="hs-mc-input"></textarea>'
  const list = doc.getElementById('hs-mc-messages')
  list.getClientRects = () => [{}]
  calls = { status: [], copied: [], muted: [], quoted: [], opened: [], clicked: [] }
  for (const [i, who] of ['ann', 'bob', 'ann', 'cy'].entries()) {
    const row = doc.createElement('div')
    row.className = 'hs-mc-msg'
    row.dataset.msgKey = `k${i}`
    row.dataset.msgId = `m${i}`
    row.innerHTML = `<span class="hs-mc-user" data-username="${who}" data-platform="twitch">${who}</span> <a href="https://x.test/${i}">link${i}</a>`
    row.getBoundingClientRect = () => ({
      top: i * 20,
      bottom: i * 20 + 18,
      left: 0,
      right: 100,
      width: 100,
      height: 18,
    })
    list.appendChild(row)
    for (const el of row.querySelectorAll('a, .hs-mc-user')) {
      el.getBoundingClientRect = () => ({ top: i * 20, bottom: i * 20 + 18, left: 0, right: 50, width: 50, height: 18 })
      el.click = () => calls.clicked.push(el.textContent)
    }
  }
  ctl = new AbortController()
  win.open = (...a) => calls.opened.push(a)
  api = new Function(
    'document',
    'window',
    'MouseEvent',
    'MutationObserver',
    't',
    'HsNotifs',
    'calls',
    `
    let currentTab = 'chan'
    const rowReplyState = () => null, setReplyState = () => {}
    const _extractMcMsgText = (r) => r.querySelector('.hs-mc-user').textContent + ': ' + r.querySelector('a').textContent
    const buildRowPermalink = (r) => 'https://p.test/' + r.dataset.msgId
    const mcCopyToClipboard = (text) => calls.copied.push(text)
    const startQuoteFromRow = (r) => calls.quoted.push(r.dataset.msgId)
    const isUserMuted = () => false
    const _toggleMcMute = (n, p) => calls.muted.push(n + ':' + p)
    ${SRC}
    return { enterRowMode, exitRowMode, rowModeActive, handleRowModeKey, initRowMode, initOverlayKeys, initOwnedKeyups, rowHintLabels }
    `,
  )(
    doc,
    win,
    win.MouseEvent,
    win.MutationObserver,
    t,
    { emit: (_x, p) => calls.status.push(p.text), dismissByKey() {} },
    calls,
  )
  api.initOverlayKeys(ctl.signal)
  api.initOwnedKeyups(ctl.signal)
  api.initRowMode(ctl.signal)
})
afterEach(async () => {
  ctl.abort()
  await win.happyDOM.close()
})

const press = (key) => {
  const ev = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  ;(doc.activeElement || doc.body).dispatchEvent(ev)
  return ev
}
const selected = () => [...doc.querySelectorAll('.hs-mc-row-selected')].map((r) => r.dataset.msgId)
// the cursor starts on the newest row (m3)

describe('visual mode', () => {
  test('v then k k selects three rows, y copies their text in order, mode ends, row mode stays', () => {
    api.enterRowMode()
    press('v')
    press('k')
    press('k')
    expect(selected()).toEqual(['m1', 'm2', 'm3'])
    press('y')
    expect(calls.copied).toEqual(['bob: link1\nann: link2\ncy: link3'])
    expect(selected()).toEqual([])
    expect(api.rowModeActive()).toBe(true)
  })

  test('a counts stretch: 3k', () => {
    api.enterRowMode()
    press('v')
    press('3')
    press('k')
    expect(selected()).toEqual(['m0', 'm1', 'm2', 'm3'])
  })

  test('a copies permalinks, q quotes the first row, m mutes each author once', () => {
    api.enterRowMode()
    press('v')
    press('3')
    press('k')
    press('a')
    expect(calls.copied).toEqual(['https://p.test/m0\nhttps://p.test/m1\nhttps://p.test/m2\nhttps://p.test/m3'])
    press('G')
    press('v')
    press('3')
    press('k')
    press('m')
    press('G')
    expect(calls.muted).toEqual(['ann:twitch', 'bob:twitch', 'cy:twitch'])
    press('v')
    press('k')
    press('q')
    expect(calls.quoted).toEqual(['m2'])
    expect(api.rowModeActive()).toBe(false)
  })

  test('esc leaves visual only; a second esc leaves row mode', () => {
    api.enterRowMode()
    press('v')
    press('Escape')
    expect(selected()).toEqual([])
    expect(api.rowModeActive()).toBe(true)
    press('Escape')
    expect(api.rowModeActive()).toBe(false)
  })

  test('o swaps the ends', () => {
    api.enterRowMode()
    press('v')
    press('k')
    press('o')
    press('j')
    expect(selected()).toEqual(['m2', 'm3'])
  })
})

describe('hint mode', () => {
  test('f puts a label on every link and name; typing one clicks it and ends hints', () => {
    api.enterRowMode()
    press('f')
    const chips = [...doc.querySelectorAll('#hs-hint-layer .hs-hint')]
    expect(chips.length).toBe(8)
    expect(chips[0].textContent).toBe('f')
    press('f')
    expect(calls.clicked).toEqual(['ann'])
    expect(doc.getElementById('hs-hint-layer')).toBeNull()
  })

  test('F opens a link in a new tab', () => {
    api.enterRowMode()
    press('F')
    press('j') // second label = the first row's link
    expect(calls.opened[0].slice(0, 2)).toEqual(['https://x.test/0', '_blank'])
  })

  test('esc and any other key cancel', () => {
    api.enterRowMode()
    press('f')
    press('Escape')
    expect(doc.getElementById('hs-hint-layer')).toBeNull()
    press('f')
    press('1')
    expect(doc.getElementById('hs-hint-layer')).toBeNull()
    expect(calls.clicked).toEqual([])
  })

  test('labels go to two letters past the alphabet', () => {
    const rowLabels = api.rowHintLabels
    const l = rowLabels(30)
    expect(l[0]).toBe('ff')
    expect(rowLabels(10)[0]).toBe('f')
    expect(l[26].length).toBe(2)
    expect(new Set(l).size).toBe(30)
  })
})

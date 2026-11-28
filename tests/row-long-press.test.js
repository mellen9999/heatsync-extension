/**
 * M01: a long-press on a chat row opens its menu on touch. Runs the real initRowLongPress
 * (sliced out of row-mode.js, hold time shortened) on a happy-dom page with real touch events.
 */
import { beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'row-mode.js'), 'utf8')
const SLICE = SRC.slice(SRC.indexOf('const ROW_LONGPRESS_MS'), SRC.indexOf('/** Wire the mode into the page.')).replace(
  'ROW_LONGPRESS_MS = 600',
  'ROW_LONGPRESS_MS = 30',
)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let win
let doc
let row
let menus
let ctl

beforeEach(() => {
  win = new Window()
  doc = win.document
  doc.body.innerHTML = '<div id="hs-mc-messages"><div class="hs-mc-msg"><span class="hs-mc-user">a</span> hi</div></div><p id="x">x</p>'
  row = doc.querySelector('.hs-mc-msg')
  menus = []
  ctl = new AbortController()
  // the menu handler: opens on any contextmenu and says so by preventDefault, like the real one
  doc.addEventListener('contextmenu', (e) => {
    menus.push({ x: e.clientX, y: e.clientY, synth: !!e.hsLongPress })
    e.preventDefault()
  })
})

const run = () =>
  new Function('document', 'MouseEvent', 'Element', 'signal', `${SLICE}; initRowLongPress(signal)`)(
    doc,
    win.MouseEvent,
    win.Element,
    ctl.signal,
  )
const touch = (type, target, x = 50, y = 60) => {
  const e = new win.Event(type, { bubbles: true, cancelable: true })
  const pt = { clientX: x, clientY: y }
  e.touches = type === 'touchend' || type === 'touchcancel' ? [] : [pt]
  target.dispatchEvent(e)
  return e
}

test('holding a row opens its menu at the finger', async () => {
  run()
  touch('touchstart', row.querySelector('.hs-mc-user'))
  await wait(80)
  expect(menus).toEqual([{ x: 50, y: 60, synth: true }])
})

test('the lift after a press that opened the menu does not tap through', async () => {
  run()
  touch('touchstart', row)
  await wait(80)
  expect(touch('touchend', row).defaultPrevented).toBe(true)
})

test('a quick tap opens nothing and the lift is left alone', async () => {
  run()
  touch('touchstart', row)
  expect(touch('touchend', row).defaultPrevented).toBe(false)
  await wait(80)
  expect(menus).toEqual([])
})

test('a drag past the slop is a scroll, not a press', async () => {
  run()
  touch('touchstart', row)
  touch('touchmove', row, 50, 90)
  await wait(80)
  expect(menus).toEqual([])
})

test('a press outside the rows opens nothing', async () => {
  run()
  touch('touchstart', doc.getElementById('x'))
  await wait(80)
  expect(menus).toEqual([])
})

test('a browser that sends its own contextmenu is not doubled', async () => {
  run()
  touch('touchstart', row)
  row.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  await wait(80)
  expect(menus.length).toBe(1)
  expect(menus[0].synth).toBe(false)
})

/**
 * Hover hold stops the feed while you point at an emote, name or badge. It used to engage on any
 * mouseover, and a resting pointer gets those too: a row slides an emote under it, or the window
 * gets the pointer back when you switch back to the browser's workspace. The feed then froze on
 * old rows with no "new messages" button until the mouse happened to move (11-16, reproduced on
 * live twitch with the pointer parked over message text). Runs the real hold block from
 * src/multichat/main-overlay.js in happy-dom.
 */
import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main-overlay.js'), 'utf8')
const a = SRC.indexOf('    const holdTarget = (el) =>')
const endMark = "window.addEventListener('blur', leave, { passive: true, signal: mcSignal })"
const BLOCK = SRC.slice(a, SRC.indexOf(endMark, a) + endMark.length)

let win
afterEach(() => win?.happyDOM.close())

function pane() {
  win = new Window()
  const document = win.document
  document.body.innerHTML = `<div id="msgs">
    <div class="hs-mc-msg"><span class="hs-mc-user">someone</span>: <span id="text">hello</span>
      <span class="hs-mc-emote-wrapper"><img class="hs-mc-emote" id="emote"></span></div></div>
    <div id="new"></div>`
  const renders = []
  const api = new Function(
    'msgsEl',
    'newBtn',
    'window',
    'cleanup',
    'mcSignal',
    'renderMessages',
    'scrollMsgsToBottom',
    'Element',
    `let hoverHeld = false, isScrolledUp = false, newMessageCount = 0, _holdMissedRender = false, _hoverRelease = null
     const isStaticTab = () => false
     let currentTab = 'live'
     ${BLOCK}
     return {
       held: () => hoverHeld && isScrolledUp,
       missRender: () => { if (hoverHeld) _holdMissedRender = true },
     }`,
  )(
    document.getElementById('msgs'),
    document.getElementById('new'),
    win,
    { setTimeout: (f) => f(), clearTimeout: () => {} },
    undefined,
    (tab) => renders.push(tab),
    () => {},
    win.Element,
  )
  const fire = (id, type, x, y) =>
    document.getElementById(id).dispatchEvent(new win.MouseEvent(type, { bubbles: true, clientX: x, clientY: y }))
  return { api, fire, renders, document }
}

test('moving the pointer onto an emote holds the feed', () => {
  const p = pane()
  p.fire('text', 'mousemove', 100, 50)
  p.fire('emote', 'mouseover', 130, 50)
  p.fire('emote', 'mousemove', 130, 50)
  expect(p.api.held()).toBe(true)
})

test('an emote sliding under a resting pointer does not', () => {
  const p = pane()
  p.fire('text', 'mousemove', 100, 50)
  // the row moved, not the pointer: the browser sends the boundary event and a move at the same spot
  p.fire('emote', 'mouseover', 100, 50)
  p.fire('emote', 'mousemove', 100, 50)
  expect(p.api.held()).toBe(false)
})

test('a pointer the window gets back (workspace switch) does not, until it moves', () => {
  const p = pane()
  p.fire('emote', 'mouseover', 130, 50)
  p.fire('emote', 'mousemove', 130, 50)
  expect(p.api.held()).toBe(false)
  p.fire('emote', 'mousemove', 132, 51)
  expect(p.api.held()).toBe(true)
})

test('leaving the window forgets the pointer and lets go, showing what was held back', () => {
  const p = pane()
  p.fire('text', 'mousemove', 100, 50)
  p.fire('emote', 'mousemove', 130, 50)
  p.api.missRender()
  win.dispatchEvent(new win.Event('blur'))
  expect(p.api.held()).toBe(false)
  expect(p.renders).toEqual(['live'])
  // back on the workspace with the pointer still on the emote: no hold
  p.fire('emote', 'mousemove', 130, 50)
  expect(p.api.held()).toBe(false)
})

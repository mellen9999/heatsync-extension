/**
 * A hover hold is only valid while the pointer is really over the held thing. One whose pointer
 * left without a mouseleave on it (the row went away, the panel moved in a soft nav, the window
 * lost the pointer) froze the pane on old rows, with no "N new" pill, until a tab switch (ext
 * report, 11-22). Runs the real hold block, the stale-hold backstop and the render's pause branch.
 */
import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

const read = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')
const OV = read('main-overlay.js')
const a = OV.indexOf('    const holdTarget = (el) =>')
const endMark = "window.addEventListener('blur', leave, { passive: true, signal: mcSignal })"
const BLOCK = OV.slice(a, OV.indexOf(endMark, a) + endMark.length)
const fa = OV.indexOf('function holdStillOver()')
const BACKSTOP = OV.slice(fa, OV.indexOf('// A render asked', fa))
const LIVE = read('main-live.js')
const la = LIVE.indexOf('  // A hold whose pointer is gone paints')
const PAUSE = LIVE.slice(la, LIVE.indexOf('\n    return\n  }\n', la) + 16)

let win
afterEach(() => win?.happyDOM.close())

function pane() {
  win = new Window()
  const document = win.document
  document.body.innerHTML = `<div id="msgs"><div class="hs-mc-msg"><span class="hs-mc-user" id="who">someone</span>
    <span id="text">hello</span></div></div><div id="new"></div>`
  const renders = []
  const doc = {
    getElementById: (i) => document.getElementById(i),
    createElement: (t) => document.createElement(t),
    documentElement: document.documentElement,
    addEventListener: (...x) => document.addEventListener(...x),
    hidden: false,
  }
  const api = new Function(
    'msgsEl',
    'newBtn',
    'window',
    'document',
    'cleanup',
    'mcSignal',
    'renderMessages',
    'scrollMsgsToBottom',
    'Element',
    'listIsChat',
    't',
    `let hoverHeld = false, isScrolledUp = false, newMessageCount = 0, _holdMissedRender = false, _hoverRelease = null
     let _hoverEl = null, _hoverReleaseNow = null
     const isStaticTab = () => false
     let currentTab = 'live'
     ${BACKSTOP}
     ${BLOCK}
     // the render's pause branch, as renderMessages runs it
     const paint = (opts) => {
       ${PAUSE}
       return 'painted'
     }
     return {
       held: () => hoverHeld && isScrolledUp,
       paused: () => isScrolledUp,
       paint,
       pill: () => newBtn.style.display === 'flex' ? newBtn.textContent : '',
       stale: () => dropStaleHold(),
     }`,
  )(
    document.getElementById('msgs'),
    document.getElementById('new'),
    win,
    doc,
    { setTimeout: (f) => f(), clearTimeout: () => {} },
    undefined,
    (tab) => renders.push(tab),
    () => {},
    win.Element,
    () => true,
    (_k, v) => `${v?.[0]} new`,
  )
  const fire = (id, type, x, y) =>
    document.getElementById(id).dispatchEvent(new win.MouseEvent(type, { bubbles: true, clientX: x, clientY: y }))
  const hold = () => {
    fire('text', 'mousemove', 100, 50)
    fire('who', 'mouseover', 130, 50)
    fire('who', 'mousemove', 130, 50)
  }
  // :hover is the browser's; the held element answers for it
  const over = (v) => {
    document.getElementById('who').matches = (sel) => (sel === ':hover' ? v : false)
  }
  return { api, fire, hold, over, renders, document, win }
}

test('a real hover still holds the feed', () => {
  const p = pane()
  p.over(true)
  p.hold()
  expect(p.api.held()).toBe(true)
  expect(p.api.stale()).toBe(false)
  expect(p.api.held()).toBe(true)
})

test('a pointer that left with no mouseleave: the next live row paints', () => {
  const p = pane()
  p.over(true)
  p.hold()
  p.over(false)
  expect(p.api.paint()).toBe('painted')
  expect(p.api.held()).toBe(false)
  expect(p.api.paused()).toBe(false)
})

test('the held element gone from the page: the next live row paints', () => {
  const p = pane()
  p.over(true)
  p.hold()
  p.document.getElementById('who').remove()
  expect(p.api.paint()).toBe('painted')
  expect(p.api.paused()).toBe(false)
})

test('a still-held pointer keeps the pause: no paint, no pill', () => {
  const p = pane()
  p.over(true)
  p.hold()
  expect(p.api.paint()).toBeUndefined()
  expect(p.api.pill()).toBe('')
  expect(p.api.held()).toBe(true)
})

test('the window losing the pointer lets go', () => {
  const p = pane()
  p.over(true)
  p.hold()
  p.win.dispatchEvent(new p.win.Event('blur'))
  expect(p.api.paused()).toBe(false)
})

test('the pointer leaving the document lets go', () => {
  const p = pane()
  p.over(true)
  p.hold()
  p.document.documentElement.dispatchEvent(new p.win.MouseEvent('mouseleave'))
  expect(p.api.paused()).toBe(false)
})

test('the tab going hidden lets go', () => {
  const p = pane()
  p.over(true)
  p.hold()
  p.document.dispatchEvent(new p.win.Event('visibilitychange'))
  // happy-dom's document.hidden is false: the wiring is checked in source below
  expect(OV).toContain("document.addEventListener('visibilitychange', () => document.hidden && leave()")
})

test('the stall check lets a stale hold go and says when a hold is the blocker', () => {
  const M = read('main-messages.js')
  expect(M).toContain('if (dropStaleHold()) return scheduleRenderMessages()')
  expect(M).toContain('hover: !!hoverHeld')
})

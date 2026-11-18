import { expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { mainSource } from './main-src.js'

/**
 * Reaching the top of a paused chat list asks for older rows. The ask rode a frame scheduled by
 * the scroll event, and the scroll-end handler cancelled that frame: a scroll that reached the
 * top and ended inside one frame never asked. At the top no further scroll event comes, so
 * wheeling up again did nothing either, with thousands of rows in the buffer (real twitch +
 * kick, e2e s20, 11-17). The list's own scroll, scrollend and wheel listeners run for real.
 */
const MAIN = mainSource()
const s = MAIN.indexOf('    // Near the top while paused → paint the next chunk of older history.')
const e = MAIN.indexOf('    // Touch: track touchmove direction.', s)
if (s < 0 || e < 0) throw new Error('carve: the list scroll listeners moved')
const WIRING = MAIN.slice(s, e)

function rig({ paused = true, top = 0, atBottom = false, hover = false } = {}) {
  const win = new Window()
  const msgsEl = win.document.createElement('div')
  win.document.body.appendChild(msgsEl)
  let scrollTop = top
  Object.defineProperty(msgsEl, 'scrollTop', { get: () => scrollTop, set: (v) => (scrollTop = v) })
  const frames = []
  const st = new Function(
    'msgsEl',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'mcSignal',
    `let _scrollFrame = null, isProgrammaticScroll = false, _userInputScroll = false, isScrolledUp = ${paused}
     const calls = { older: 0, resume: 0, paused: [], tail: 0 }
     const hoverHeld = ${hover}
     const checkAtBottom = () => ${atBottom}
     const jumpToTail = () => { calls.tail++; isScrolledUp = false }
     const armPaneHold = () => {}
     const isStaticTab = () => false
     const listIsChat = () => true
     const setPaused = (p) => { isScrolledUp = p; calls.paused.push(p) }
     const onScrollMaybeResume = () => calls.resume++
     const loadOlderScrollback = () => calls.older++
     const paneHoldScrolled = () => {}
     ${WIRING}
     return { calls, flag: () => _userInputScroll, programmatic: (v) => (isProgrammaticScroll = v) }`,
  )(
    msgsEl,
    (fn) => frames.push(fn),
    (id) => frames.splice(id - 1, 1, null),
    undefined,
  )
  const fire = (type, init = {}) => {
    const ev = new win.Event(type)
    Object.assign(ev, init)
    msgsEl.dispatchEvent(ev)
  }
  const frame = () => {
    for (const fn of frames.splice(0)) fn?.()
  }
  return { ...st, fire, frame, setTop: (v) => (scrollTop = v) }
}

test('a wheel to the top that ends inside one frame still asks for older rows', () => {
  const r = rig({ paused: false, top: 4000 })
  r.fire('wheel', { deltaY: -5000 })
  r.setTop(0)
  r.fire('scroll')
  r.fire('scrollend') // before the frame the scroll event asked for
  r.frame()
  expect(r.calls.older).toBe(1)
  expect(r.calls.paused).toEqual([true])
  expect(r.flag()).toBe(false)
})

test('a scroll that crosses frames asks once per frame, as before', () => {
  const r = rig({ top: 4000 })
  r.fire('wheel', { deltaY: -100 })
  r.setTop(150)
  r.fire('scroll')
  r.fire('scroll')
  r.frame()
  expect(r.calls.older).toBe(1)
})

test('already at the top, a wheel up moves nothing and still asks', () => {
  const r = rig({ top: 0 })
  r.fire('wheel', { deltaY: -120 })
  expect(r.calls.older).toBe(1)
})

test('a wheel down at the top, or a wheel up far from it, asks for nothing', () => {
  const r = rig({ top: 0 })
  r.fire('wheel', { deltaY: 120 })
  expect(r.calls.older).toBe(0)
  const far = rig({ top: 4000 })
  far.fire('wheel', { deltaY: -120 })
  expect(far.calls.older).toBe(0)
})

test("our own scrolling never asks: a render's scroll, or one with no gesture behind it", () => {
  const r = rig({ top: 0 })
  r.fire('scroll')
  r.fire('scrollend')
  r.frame()
  expect(r.calls.older).toBe(0)
  r.programmatic(true)
  r.fire('wheel', { deltaY: -120 })
  expect(r.calls.older).toBe(0)
})

// The mirror at the other end. A paused reader can end up at the bottom of the rows drawn with
// no scroll of their own: the rows under them shrink (a mod clears someone) and the browser
// clamps the list. A wheel down there moves nothing, no scroll event follows it, and they stayed
// paused with the pill counting up (real twitch, e2e s20, 11-18: 1 in 34 pauses on a fast chat).
test('paused at the bottom of the rows drawn, a wheel down moves nothing and still returns to the tail', () => {
  const r = rig({ top: 17023, atBottom: true })
  r.fire('wheel', { deltaY: 100 })
  expect(r.calls.tail).toBe(1)
  expect(r.calls.paused).toEqual([])
})

test('a wheel down that has rows to scroll through is left to the scroll', () => {
  const r = rig({ top: 4000, atBottom: false })
  r.fire('wheel', { deltaY: 100 })
  expect(r.calls.tail).toBe(0)
})

test('a list that is not paused, one held by the pointer, and a zoom wheel are left alone', () => {
  const live = rig({ paused: false, top: 17023, atBottom: true })
  live.fire('wheel', { deltaY: 100 })
  expect(live.calls.tail).toBe(0)
  const held = rig({ top: 17023, atBottom: true, hover: true })
  held.fire('wheel', { deltaY: 100 })
  expect(held.calls.tail).toBe(0)
  const zoom = rig({ top: 17023, atBottom: true })
  zoom.fire('wheel', { deltaY: 100, ctrlKey: true })
  expect(zoom.calls.tail).toBe(0)
})

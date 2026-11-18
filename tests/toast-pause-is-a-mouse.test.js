import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

/**
 * A toast with a timeout waits while the pointer rests on it. It listened for mouseenter and
 * mouseleave: a finger's tap sends the enter and no leave, so on a touch screen a tapped toast
 * never went away. (Found on the site's phone sweep, 11-18; this is the same code.) The pause is
 * now a mouse's only.
 *
 * Runs the real timeout block of notifs.js on a real element with real pointer events.
 */
const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'notifs.js'), 'utf8')
const a = SRC.indexOf('    if (notif.type.timeout) {')
const b = SRC.indexOf('\n  function _renderInto(notif)', a)
if (a < 0 || b < 0) throw new Error('carve: the toast timeout block')
const BLOCK = SRC.slice(a, SRC.lastIndexOf('}', b - 1))

function toast() {
  const window = new Window()
  const wrapper = window.document.createElement('div')
  window.document.body.appendChild(wrapper)
  const timers = new Map()
  let id = 0
  const cleanup = {
    setPageTimeout: (fn, ms) => {
      timers.set(++id, { fn, ms })
      return id
    },
    clearTimeout: (t) => timers.delete(t),
  }
  const gone = []
  const notif = { id: 'n1', type: { timeout: 5000 } }
  new Function('notif', 'wrapper', 'cleanup', 'dismiss', BLOCK)(notif, wrapper, cleanup, (i) => gone.push(i))
  // old source listened for the mouse events a browser sends with the pointer ones
  const send = (type, pointerType) => {
    wrapper.dispatchEvent(new window.PointerEvent(`pointer${type}`, { pointerType }))
    // a tap sends the compatibility mouseenter too, and never a mouseleave
    if (pointerType === 'mouse' || type === 'enter') wrapper.dispatchEvent(new window.MouseEvent(`mouse${type}`))
  }
  return { notif, timers, gone, send }
}

test('a mouse resting on a toast holds it, and leaving starts the rest of its time', () => {
  const p = toast()
  expect(p.timers.size).toBe(1)
  p.send('enter', 'mouse')
  expect(p.timers.size).toBe(0)
  p.send('leave', 'mouse')
  expect(p.timers.size).toBe(1)
  const t = [...p.timers.values()][0]
  expect(t.ms).toBeGreaterThan(4000)
  t.fn()
  expect(p.gone).toEqual(['n1'])
})

test('a tap does not hold it: its time keeps running', () => {
  for (const kind of ['touch', 'pen']) {
    const p = toast()
    p.send('enter', kind)
    expect(p.timers.size).toBe(1)
    expect([...p.timers.values()][0].ms).toBe(5000)
  }
})

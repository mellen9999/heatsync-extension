import { expect, test } from 'bun:test'
import { mainSource } from './main-src.js'

/**
 * A reader who scrolled up has a pill: "resume", or "N new" once lines arrive. Pinning the list
 * to its tail hid that pill and zeroed its count before it looked at the pause, and then left
 * the list where it was. Pins are asked for from all over (a tour card closing, a badge landing,
 * the pin bar, a resize), so a paused list could stand still with nothing on screen saying so
 * until the next line came: on a slow youtube chat, the whole wait (e2e s20, 11-18).
 *
 * Runs the real scrollMsgsToBottom.
 */
const MAIN = mainSource()
const a = MAIN.indexOf('function scrollMsgsToBottom(msgsEl) {')
const b = MAIN.indexOf('\n}\n', a)
if (a < 0 || b < 0) throw new Error('carve: scrollMsgsToBottom')
const CODE = MAIN.slice(a, b + 3)

function list({ paused, count = 7 }) {
  const pill = { style: { display: 'flex' } }
  const msgsEl = { scrollTop: 1453, scrollHeight: 1893 }
  const scope = {
    isScrolledUp: paused,
    newMessageCount: count,
    isProgrammaticScroll: false,
    _rafStarved: false,
    _pinRanAt: 0,
    document: { hidden: false, getElementById: (id) => (id === 'hs-mc-new-msgs' ? pill : null) },
    rafOrTimeout: (fn) => fn(),
  }
  const pin = new Function('scope', `with (scope) { ${CODE}\n return scrollMsgsToBottom }`)(scope)
  pin(msgsEl)
  return { pill, msgsEl, scope }
}

test('a pin asked for while the reader is paused leaves the pill, its count and the list alone', () => {
  const r = list({ paused: true })
  expect(r.pill.style.display).toBe('flex')
  expect(r.scope.newMessageCount).toBe(7)
  expect(r.msgsEl.scrollTop).toBe(1453)
})

test('a list that follows is pinned, and has no pill', () => {
  const r = list({ paused: false })
  expect(r.pill.style.display).toBe('none')
  expect(r.scope.newMessageCount).toBe(0)
  expect(r.msgsEl.scrollTop).toBeGreaterThan(1893)
})

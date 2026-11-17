/**
 * The unpinned watchdog heals a pane whose pin never runs: rows land below a view that no
 * longer follows them. On a busy merged chat a pin is nearly always in flight, a frame behind
 * the newest rows; sampled twice mid-flight, that read as stuck and filed a false 'unpinned'
 * (s10 on a slow CI runner, 11-16). Runs the real unpinnedCheck from main-messages.js.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main-messages.js'), 'utf8')
const s = SRC.indexOf('function unpinnedCheck(')
const BODY = SRC.slice(s, SRC.indexOf('\n}\n', s) + 3)

function pane({ gap, pinAgoMs, scrolledUp = false }) {
  const logged = []
  let heals = 0
  const el = { scrollHeight: 1000 + gap, scrollTop: 0, clientHeight: 1000, children: { length: 500 } }
  const fns = new Function(
    'hsDiagLog',
    'scrollMsgsToBottom',
    '_noHeal',
    'el',
    `let _unpinnedStreak = 0, _unpinLoggedAt = 0, _scrollPinRaf = 1, isProgrammaticScroll = true
     let isScrolledUp = ${scrolledUp}, currentTab = 'merged', _pinRanAt = Date.now() - ${pinAgoMs}
     ${BODY}
     return { check: () => unpinnedCheck(el), pinNow: () => { _pinRanAt = Date.now() } }`,
  )(
    (e, x) => logged.push([e, x]),
    () => heals++,
    () => false,
    el,
  )
  return { ...fns, logged, heals: () => heals }
}

test('a busy chat whose pins keep running is following, not stuck', () => {
  const p = pane({ gap: 75, pinAgoMs: 100 })
  for (let i = 0; i < 4; i++) {
    p.pinNow()
    p.check()
  }
  expect(p.logged).toEqual([])
  expect(p.heals()).toBe(0)
})

test('a pane whose pin never runs is stuck: logged once and healed', () => {
  const p = pane({ gap: 75, pinAgoMs: 60_000 })
  p.check()
  expect(p.heals()).toBe(0) // one look is not a streak
  p.check()
  expect(p.logged.map(([e]) => e)).toEqual(['unpinned'])
  expect(p.heals()).toBe(1)
})

test('a reader who scrolled up is left alone', () => {
  const p = pane({ gap: 900, pinAgoMs: 60_000, scrolledUp: true })
  p.check()
  p.check()
  expect(p.logged).toEqual([])
  expect(p.heals()).toBe(0)
})

// A network blip soon after a stream was opened lost its lines for good (e2e s29, 11-17: 25s
// dark, 0 of 173 missed lines came back). The worker refetches a channel's recent lines on
// every reconnect, but skipped the fetch when one had run in the last minute, and a fetch from
// before the socket came back cannot hold the lines of the gap. Now the refill waits for the
// cooldown's end instead of being dropped.
import { describe, expect, test } from 'bun:test'
import { bgSource } from './bg-src.js'

const BG_SRC = bgSource()
const fn = (name) => {
  const start = BG_SRC.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`"${name}" not found — source drifted, update this test`)
  return BG_SRC.slice(start, BG_SRC.indexOf('\n}', start) + 2)
}
const COOLDOWN = Number(/const ROBOTTY_COOLDOWN_MS = ([\d_]+)/.exec(BG_SRC)[1].replace(/_/g, ''))

function worker() {
  let now = 1_000_000
  const timers = []
  const fetched = []
  const BG_IRC = {
    channels: new Map([['xqc', {}]]),
    lastRobottyAt: new Map(),
    historyInFlight: new Map(),
    refillTimers: new Map(),
  }
  // the real fetch gate, its network half cut off: what it lets through is what reaches the server
  const gate = fn('bgIrcFetchRobotty')
  const head = gate.slice(0, gate.indexOf('const p = (async'))
  const api = new Function(
    'BG_IRC',
    'Date',
    'setTimeout',
    'clearTimeout',
    'bgIrcPersistRobottyTs',
    'fetched',
    `const ROBOTTY_COOLDOWN_MS = ${COOLDOWN}\n${head}  fetched.push([ch, Date.now()])\n}\n${fn('bgIrcRefillGap')}\nreturn { bgIrcRefillGap, bgIrcFetchRobotty }`,
  )(
    BG_IRC,
    { now: () => now },
    (f, ms) => timers.push({ f, at: now + ms }),
    () => {},
    () => {},
    fetched,
  )
  const advance = (ms) => {
    now += ms
    for (const t of timers.splice(0)) t.at <= now ? t.f() : timers.push(t)
  }
  return { ...api, BG_IRC, fetched, advance, timers, at: () => now }
}

describe('the refill a reconnect owes', () => {
  test('long after the last fetch it runs at once', () => {
    const w = worker()
    w.bgIrcFetchRobotty('xqc') // the join
    w.advance(5 * 60_000)
    w.bgIrcRefillGap('xqc')
    expect(w.fetched.length).toBe(2)
    expect(w.timers.length).toBe(0)
  })

  test('a blip 20s after the join: the refill is put off to the cooldown end, not dropped', () => {
    const w = worker()
    w.bgIrcFetchRobotty('xqc')
    w.advance(20_000)
    w.bgIrcRefillGap('xqc') // the socket is back
    expect(w.fetched.length).toBe(1) // still polite: nothing inside the cooldown
    w.advance(COOLDOWN - 20_000 - 1)
    expect(w.fetched.length).toBe(1)
    w.advance(1)
    expect(w.fetched.length).toBe(2)
    expect(w.fetched[1][1] - w.fetched[0][1]).toBe(COOLDOWN)
  })

  test('a flapping socket owes one refill, not one per flap', () => {
    const w = worker()
    w.bgIrcFetchRobotty('xqc')
    for (let i = 0; i < 6; i++) {
      w.advance(3000)
      w.bgIrcRefillGap('xqc')
    }
    expect(w.timers.length).toBe(1)
    w.advance(COOLDOWN)
    expect(w.fetched.length).toBe(2)
  })

  test('a channel let go while the refill waited is never fetched', () => {
    const w = worker()
    w.bgIrcFetchRobotty('xqc')
    w.advance(1000)
    w.bgIrcRefillGap('xqc')
    w.BG_IRC.channels.delete('xqc')
    w.advance(COOLDOWN)
    expect(w.fetched.length).toBe(1)
  })

  test('the reconnect path asks for it for every joined channel, with no cooldown of its own', () => {
    const at = BG_SRC.indexOf('BG_IRC.ws.onopen = () => {')
    const open = BG_SRC.slice(at, BG_SRC.indexOf('BG_IRC.ws.onmessage = (e)', at))
    expect(open).toContain('for (const ch of BG_IRC.channels.keys()) bgIrcRefillGap(ch)')
    expect(open).not.toContain('lastRobottyAt')
  })

  test('letting a channel go drops its waiting refill', () => {
    const body = fn('bgIrcReleaseChannel')
    expect(body).toContain('clearTimeout(BG_IRC.refillTimers.get(ch))')
    expect(body).toContain('BG_IRC.refillTimers.delete(ch)')
  })
})

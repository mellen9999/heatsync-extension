/**
 * A line twitch shows is shown in the panel, even when the reader never got it.
 *
 * On a twitch page the native tap sees every line twitch's own chat receives.
 * While the background reader looked healthy (3+ lines in the last 10s) the
 * tap DROPPED its copy so the reader's richer one would win — but a reader
 * twitch had throttled to a trickle still counted as healthy, and every line
 * it missed was shown nowhere. The chat then sat minutes behind the stream
 * until a refresh (reported by a viewer, 2026-11-11).
 *
 * Now a native line waits TAP_GRACE_MS for the reader's copy and is shown
 * itself if that never comes; a reader that keeps missing lines is asked to
 * reconnect. Runs the real bootstrap cleanup object and the real native-tap.js
 * against a fake clock.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MC = join(import.meta.dir, '..', 'src', 'multichat')
const BOOT = readFileSync(join(MC, 'bootstrap.js'), 'utf8')
const TAP = readFileSync(join(MC, 'native-tap.js'), 'utf8').replace(/^export .*$/gm, '')

function block(src, head) {
  const start = src.indexOf(head)
  if (start === -1) throw new Error(`"${head}" not found`)
  return src.slice(start, src.indexOf('\n}\n', start) + 3)
}
const TIMERS = BOOT.match(/^const _timers = .*$/m)[0]
const DRAIN = block(BOOT, 'function drainChannelTimers(')
const CLEANUP = block(BOOT, 'const cleanup = {')
const GRACE = Number(TAP.match(/const TAP_GRACE_MS = (\d+)/)[1])

function load() {
  let now = 1_000_000
  let nextId = 1
  const tasks = new Map()
  const add = (fn, ms, every) => {
    const id = nextId++
    tasks.set(id, { fn, at: now + ms, every })
    return id
  }
  const drop = (id) => tasks.delete(id)
  const advance = (ms) => {
    const end = now + ms
    for (;;) {
      let next = null
      for (const [id, t] of tasks) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t]
      if (!next) break
      const [id, t] = next
      now = t.at
      if (t.every) t.at = now + t.every
      else tasks.delete(id)
      t.fn()
    }
    now = end
  }

  const observers = []
  class FakeObserver {
    constructor(cb) {
      this.cb = cb
      observers.push(this)
    }
    observe(target) {
      this.target = target
    }
    disconnect() {
      this.target = null
    }
  }
  const node = { nodeType: 1, getClientRects: () => [] }
  const deliver = (row) => {
    for (const o of observers) if (o.target === node) o.cb([{ addedNodes: [row] }])
  }
  const row = (id, text) => ({
    nodeType: 1,
    classList: { contains: (c) => c === 'chat-line__message' },
    closest: () => null,
    _fiber: {
      memoizedProps: {
        message: { id, user: { userDisplayName: 'Viewer', userLogin: 'viewer' }, messageParts: [{ content: text }] },
      },
      return: null,
    },
  })

  const fed = []
  const sent = []
  // the reader: what it delivered (its dedupe set) and when (its health window)
  const irc = {
    _seenIds: new Set(),
    _lastLiveAt: new Map(),
    _handleMsg(m) {
      const key = `${m.channel}:${m.id}`
      if (m.id && this._seenIds.has(key)) return
      if (m.id) this._seenIds.add(key)
      fed.push(m)
    },
  }
  const readerDelivers = (id) => {
    irc._seenIds.add(`chan:${id}`)
    fed.push({ id, fromReader: true })
  }
  const healthy = () => irc._lastLiveAt.set('chan', [now - 3, now - 2, now - 1])
  const starved = () => irc._lastLiveAt.set('chan', [now - 60_000])

  const api = new Function(
    'setTimeout',
    'setInterval',
    'clearTimeout',
    'clearInterval',
    'MutationObserver',
    'env',
    `const _hsPerfWrap = (fn) => fn
const mcSignal = {}
const log = () => {}
const Date = { now: () => env.now() }
const Node = { ELEMENT_NODE: 1 }
const CONFIG = { SELECTORS: { TWITCH_CHAT_CONTAINER: '.chat' } }
const hsQuery = () => env.node
const getFiber = (el) => el._fiber
const getCurrentChannel = () => 'chan'
const getSetting = () => ({})
const irc = env.irc
const hsDiagLog = () => {}
const safeSendMessage = (m) => { env.sent.push(m); return Promise.resolve() }
const window = { addEventListener() {} }
const document = { hidden: false, body: { dataset: {} }, getElementById: () => ({}), addEventListener() {} }
const localStorage = { setItem() {} }
${TIMERS}
${DRAIN}
${CLEANUP}
${TAP}
return { startNativeTap, drainChannelTimers, stats: () => _tapStats }`,
  )(
    (fn, ms) => add(fn, ms, 0),
    (fn, ms) => add(fn, ms, ms),
    drop,
    drop,
    FakeObserver,
    {
      now: () => now,
      node,
      irc,
      sent,
    },
  )
  api.startNativeTap('chan')
  return { ...api, advance, deliver, row, fed, sent, readerDelivers, healthy, starved }
}

const tapped = (h) => h.fed.filter((m) => m.fromNativeTap).map((m) => m.text)

test('a line the healthy-looking reader never delivers is shown after the wait', () => {
  const h = load()
  h.healthy()
  h.deliver(h.row('a1', 'the reader never got this'))
  expect(tapped(h)).toEqual([]) // waiting for the reader's richer copy
  h.advance(GRACE)
  expect(tapped(h)).toEqual(['the reader never got this'])
  expect(h.stats().filled).toBe(1)
})

test("the reader's copy arriving inside the wait wins, and the line shows once", () => {
  const h = load()
  h.healthy()
  h.deliver(h.row('b1', 'both have it'))
  h.advance(GRACE / 2)
  h.readerDelivers('b1')
  h.advance(GRACE)
  expect(tapped(h)).toEqual([])
  expect(h.fed).toHaveLength(1)
  expect(h.stats().filled).toBe(0)
})

test('a starved reader does not hold anything back', () => {
  const h = load()
  h.starved()
  h.deliver(h.row('c1', 'straight through'))
  expect(tapped(h)).toEqual(['straight through'])
})

test('a reader throttled to a trickle: every line twitch shows reaches the panel, in order', () => {
  const h = load()
  const shown = []
  for (let i = 0; i < 40; i++) {
    h.healthy() // a trickle keeps it "healthy"
    h.deliver(h.row(`d${i}`, `line ${i}`))
    if (i % 10 === 0) h.readerDelivers(`d${i}`) // the reader gets one in ten
    h.advance(250)
  }
  h.advance(GRACE)
  for (const m of h.fed) shown.push(m.fromReader ? `line ${m.id.slice(1)}` : m.text)
  expect(new Set(shown).size).toBe(40)
  expect(h.fed).toHaveLength(40)
})

test('a reader that keeps missing lines is asked to reconnect, once per burst', () => {
  const h = load()
  for (let i = 0; i < 20; i++) {
    h.healthy()
    h.deliver(h.row(`e${i}`, `miss ${i}`))
    h.advance(500)
  }
  h.advance(GRACE)
  const asks = h.sent.filter((m) => m.type === 'bg_irc_reader_missed')
  expect(asks.length).toBe(2) // 20 misses, one ask per 8
  expect(asks[0].channel).toBe('chan')
})

test('the wait survives a channel switch draining the timers', () => {
  const h = load()
  h.healthy()
  h.deliver(h.row('f1', 'held across a reinit'))
  h.drainChannelTimers()
  h.advance(GRACE)
  expect(tapped(h)).toEqual(['held across a reinit'])
})

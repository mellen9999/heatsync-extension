/**
 * The twitch native-chat tap keeps feeding chat across a full SPA reinit.
 *
 * When twitch's own delivery is the only live source (the background reader is
 * starved on a flagged IP), the tap in native-tap.js is what keeps the panel
 * current: it mines each row twitch renders into the multichat buffer. A full
 * reinit (fullSpaReinit: landing on a directory page then clicking into a
 * channel, a popout nav) drains every cleanup timer and disconnects every
 * tracked observer, then runs init(), which calls startNativeTap again.
 *
 * Three things went wrong at once. The remount poll and the bind-retry were
 * plain cleanup timers whose sentinels (`if (!_tapPollTimer)`) kept the dead
 * handle, so they were never armed again. The takeover heartbeat was too, so
 * twitch's page script read it stale and resumed rendering. And the observer
 * was disconnected but still held in _tapObserver, so when twitch handed back
 * the same chat node _tapBind saw "same container, have an observer" and
 * returned. Chat in the panel then went stale the moment the IRC reader
 * starved, with nothing left to notice or recover.
 *
 * Runs the real bootstrap cleanup object and drain, the real native-tap.js, and
 * the real lines of fullSpaReinit that tear the tap's state down, against a fake
 * clock and a fake MutationObserver.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MC = join(import.meta.dir, '..', 'src', 'multichat')
const BOOT = readFileSync(join(MC, 'bootstrap.js'), 'utf8')
const TAP = readFileSync(join(MC, 'native-tap.js'), 'utf8').replace(/^export .*$/gm, '')
const SPA = readFileSync(join(MC, 'spa-nav.js'), 'utf8')

function block(src, head) {
  const start = src.indexOf(head)
  if (start === -1) throw new Error(`"${head}" not found`)
  return src.slice(start, src.indexOf('\n}\n', start) + 3)
}
const TIMERS = BOOT.match(/^const _timers = .*$/m)[0]
const DRAIN = block(BOOT, 'function drainChannelTimers(')
const CLEANUP = block(BOOT, 'const cleanup = {')

// fullSpaReinit's own text, from the observer disconnect through the sentinel
// nulls: the lines that decide what the tap looks like after a channel switch.
// Everything in it that is not the tap is declared as an inert stand-in below.
const REINIT = block(SPA, 'function fullSpaReinit(')
const TEARDOWN = REINIT.slice(
  REINIT.indexOf('// Disconnect all tracked observers'),
  REINIT.indexOf('mcInitialized = false'),
)
if (!TEARDOWN.includes('_timers.observers') || !TEARDOWN.includes('drainChannelTimers()')) {
  throw new Error('fullSpaReinit no longer has the observer/timer teardown this test slices out')
}

function load() {
  let now = 0
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

  // a MutationObserver that delivers only while connected, like the real one
  const observers = []
  class FakeObserver {
    constructor(cb) {
      this.cb = cb
      this.connected = false
      observers.push(this)
    }
    observe() {
      this.connected = true
    }
    disconnect() {
      this.connected = false
    }
  }
  // twitch adds a row to the chat node: every observer still connected to it sees it
  const deliver = (node, row) => {
    for (const o of observers) if (o.connected && o.target === node) o.cb([{ addedNodes: [row] }])
  }
  const origObserve = FakeObserver.prototype.observe
  FakeObserver.prototype.observe = function (target) {
    this.target = target
    origObserve.call(this)
  }

  let container = null
  const writes = []
  const fed = []
  const row = (id, text) => ({
    nodeType: 1,
    classList: { contains: (c) => c === 'chat-line__message' },
    _fiber: {
      memoizedProps: {
        message: { id, user: { userDisplayName: 'Viewer', userLogin: 'viewer' }, messageParts: [{ content: text }] },
      },
      return: null,
    },
  })

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
const Node = { ELEMENT_NODE: 1 }
const CONFIG = { SELECTORS: { TWITCH_CHAT_CONTAINER: '.chat' } }
const hsQuery = () => env.container
const getFiber = (el) => el._fiber
const getCurrentChannel = () => 'chan'
const getSetting = () => ({})
const irc = { _lastLiveAt: new Map(), _handleMsg: (m) => env.fed.push(m) }
const window = { addEventListener() {} }
const document = {
  hidden: false,
  body: { dataset: {} },
  getElementById: () => ({}),
  addEventListener() {},
}
const localStorage = { setItem: (k, v) => env.writes.push([k, v]) }
// stand-ins for what fullSpaReinit's teardown touches besides the tap
let columnObserver, _hsCalloutCloseObs, mcCosmeticsTimer, _persistTabSeenTimer
let liveStatusInterval, _tabCounterTimer, discoverPollTimer, pinnedPollTimer
let mcInitialized
const _persistMentionsState = { timer: null }
const _persistYtTimers = new Map()
${TIMERS}
${DRAIN}
${CLEANUP}
${TAP}
const reinit = () => {
${TEARDOWN}
}
return { startNativeTap, setOverlayRenderOk, reinit, _timers, state: () => ({ observer: _tapObserver, container: _tapContainer }) }`,
  )(
    (fn, ms) => add(fn, ms, 0),
    (fn, ms) => add(fn, ms, ms),
    drop,
    drop,
    FakeObserver,
    {
      get container() {
        return container
      },
      writes,
      fed,
    },
  )
  return {
    ...api,
    advance,
    deliver,
    row,
    fed,
    writes,
    setContainer: (c) => {
      container = c
    },
  }
}

const chatNode = () => ({ nodeType: 1, getClientRects: () => [] })
const texts = (h) => h.fed.map((m) => m.text)

test('the tap still mines chat after a reinit when twitch hands back the same chat node', () => {
  const h = load()
  const node = chatNode()
  h.setContainer(node)
  h.startNativeTap('chan')
  h.deliver(node, h.row('1', 'before'))
  h.reinit()
  h.startNativeTap('chan') // init() runs again
  h.deliver(node, h.row('2', 'after'))
  expect(texts(h)).toEqual(['before', 'after'])
})

test('the remount poll survives the drain and finds a new chat node on its own', () => {
  const h = load()
  const a = chatNode()
  h.setContainer(a)
  h.startNativeTap('chan')
  h.reinit() // init() has not run yet: only the page timers are left
  const b = chatNode()
  h.setContainer(b)
  h.advance(5000)
  h.deliver(b, h.row('1', 'on the new node'))
  expect(texts(h)).toEqual(['on the new node'])
})

test('a bind-retry waiting for a missing chat node survives the drain', () => {
  const h = load()
  h.startNativeTap('chan') // no chat node mounted yet: the retry is armed
  h.reinit()
  const node = chatNode()
  h.setContainer(node)
  h.advance(3000)
  h.deliver(node, h.row('1', 'late'))
  expect(texts(h)).toEqual(['late'])
})

test('the takeover heartbeat keeps beating after the drain', () => {
  const h = load()
  h.setOverlayRenderOk(true)
  h.setContainer(chatNode())
  h.startNativeTap('chan')
  h.reinit()
  const before = h.writes.length
  h.advance(15000)
  expect(h.writes.length).toBeGreaterThan(before)
})

test('repeated reinits leave exactly the tap poll and the heartbeat, not a stack of them', () => {
  const h = load()
  h.setContainer(chatNode())
  for (let i = 0; i < 4; i++) {
    h.startNativeTap('chan')
    h.reinit()
  }
  h.startNativeTap('chan')
  expect(h._timers.persistent.size).toBe(2)
  expect(h._timers.intervals.length).toBe(2)
})

test('the tap rebinds to a fresh observer each reinit, and the old one is gone', () => {
  const h = load()
  const node = chatNode()
  h.setContainer(node)
  h.startNativeTap('chan')
  const first = h.state().observer
  h.reinit()
  expect(h.state().observer).toBe(null)
  h.startNativeTap('chan')
  expect(h.state().observer).not.toBe(first)
  expect(h.state().container).toBe(node)
})

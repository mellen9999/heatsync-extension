// executable service-worker harness.
//
// boots the REAL background bundle (src/background/* joined exactly the way build.js joins it) in a
// node:vm context with a faithful fake chrome, a route-table fetch, a controllable WebSocket and a
// virtual clock, so a test can send the worker a message, move time, and assert what it did.
//
//   import { bootSw, json, status } from './harness/sw.js'
//
//   const sw = await bootSw({ cookies: [{ name: 'auth', value: 'tok', domain: 'heatsync.org' }] })
//   sw.net.on('https://heatsync.org/api/auth/me', { username: 'kripp' })     // value | Response | fn(req)
//   sw.addTab({ id: 7, url: 'https://www.twitch.tv/kripp' })               // a tab with a content script
//   const reply = await sw.send({ type: 'get_auth_state' }, sw.tabSender(7))
//   sw.socket().open()                                                    // the server accepts
//   sw.socket().receive({ type: 'authenticated' })                        // a frame from the server
//   await sw.advance(90_000)                                              // timers + alarms fire in order
//   sw.eval('channelEmotesMap')                                           // read worker state (script scope)
//
// what is real: the worker's own code, its single shared scope, chrome.storage being async and
// JSON-cloned, chrome's onMessage response-channel rules, alarms/timers on one clock, Date.now().
// what is fake and yours to drive: fetch (sw.net), WebSocket (sw.sockets), tabs, cookies, time.
//
//   boot options   { storage: {local,session,sync}, cookies: [...], tabs: [{id,url,reply?}],
//                    routes: [[matcher, handler]...], healthy (default true: empty-but-valid boot
//                    endpoints, see routes.js), sockets ('manual' default | 'open': every socket
//                    finishes its handshake by itself), fresh (a first install: boot migrations run),
//                    now, random, online, from }
//   sw.send(msg, sender?)      -> the reply (undefined when the worker never answers)
//   sw.post(msg, sender?)      -> live handle { claimed, responded, response } for slow paths
//   sw.advance(ms) / settle()  -> move the clock / let promises finish
//   sw.net.on / calls / callsTo / unrouted     fetch routes + what the worker asked for
//   sw.sockets / sw.socket(part)               every WebSocket the worker opened; .open() .receive() .drop() .frames
//   sw.storage.local.snapshot() / .seed()      what chrome.storage holds (JSON), .fail('set', err) injects a fault
//   sw.tabMessages / sw.broadcasts(type)       what the worker told tabs
//   sw.restart()               -> a NEW worker on the same browser state (MV3 eviction): memory gone,
//                                 storage / cookies / tabs / alarms / routes survive
//   sw.eval(code)              read or call worker internals (top-level const/let/function are visible)
//
// determinism: Math.random() is 0 unless you pass `random`, so backoff jitter is exactly 0ms and a test
// can assert exact delays. an unrouted fetch fails like a dead network (and lands in sw.net.unrouted),
// so a worker that starts calling a new endpoint shows up as data, not as a silent hang.
// route handlers must only await promises (no real timers) or the clock cannot know they are working.
// a promise the worker rejects and nobody catches fails the bun test that was running (bun reports it, and
// no handler can soften that). that is the point: in a real worker it is a silent entry in the error ring.
// the usual cause in a test is a socket left CONNECTING past its 10s connect timeout: open it (or boot with
// sockets: 'open'), or stop advancing the clock before the timeout.

import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { BG_HEAD, BG_PART_PATHS } from '../bg-src.js'
import { createClock } from './clock.js'
import { createFakeChrome } from './fake-chrome.js'
import { createNet, createWebSocketClass } from './fake-net.js'
import { healthyRoutes } from './routes.js'

export { json, networkError, never, status } from './fake-net.js'

const EXTENSION_ID = 'hs-test-extension-id'
const HS_WS = 'wss://heatsync.org/ws'
const T0 = Date.UTC(2026, 10, 8, 12, 0, 0)

let bundleCache = null
/** the worker as it ships: head line + every part, build order */
export function bundleSource() {
  if (bundleCache == null) bundleCache = BG_HEAD + BG_PART_PATHS.map((p) => readFileSync(p, 'utf8')).join('\n')
  return bundleCache
}

/** the sender a content script on `url` carries (tab id + origin), as chrome fills it in */
export const tabSender = (id, url) => ({ id: EXTENSION_ID, tab: { id, url } })

/**
 * @param {object} [opts] see the header
 * @returns {Promise<ReturnType<typeof build>>}
 */
export async function bootSw(opts = {}) {
  const sw = build(opts)
  vm.runInContext('0', sw.ctx) // the context exists before the script runs
  const script = new vm.Script(bundleSource(), { filename: 'background.js' })
  script.runInContext(sw.ctx)
  await sw.settle()
  if (sw.eval('self.__hsBootOk') !== true) {
    throw new Error('harness: background.js stopped evaluating before its last statement (__hsBootOk unset)')
  }
  return sw
}

function build(opts) {
  const prev = opts.from?._state() || null
  const startAt = opts.now ?? prev?.now ?? T0
  let net
  const clock = createClock(startAt, { busy: () => net.busy() })
  const sandbox = {}
  const ctx = vm.createContext(sandbox, { name: 'heatsync-sw' })
  const ctxJson = vm.runInContext('JSON', ctx)
  const fake = createFakeChrome({ clock, ctxJson, extensionId: EXTENSION_ID })
  net = createNet(clock)
  const { FakeWebSocket, sockets } = createWebSocketClass(clock, { autoOpen: opts.sockets === 'open' })

  // ---- worker globals ----
  const consoleLog = []
  const echo = process.env.HS_SW_VERBOSE === '1'
  const cons = Object.fromEntries(
    ['log', 'info', 'debug', 'warn', 'error'].map((level) => [
      level,
      (...args) => {
        consoleLog.push({ level, args })
        if (echo) console[level]('[sw]', ...args)
      },
    ]),
  )
  const selfListeners = new Map()
  const navigatorObj = { onLine: opts.online ?? true, userAgent: 'harness' }
  Object.assign(sandbox, {
    console: cons,
    chrome: fake.chrome,
    fetch: (...a) => net.fetch(...a),
    WebSocket: FakeWebSocket,
    setTimeout: (fn, ms, ...args) => clock.schedule(() => fn(...args), ms),
    setInterval: (fn, ms, ...args) => clock.schedule(() => fn(...args), ms, ms),
    clearTimeout: (id) => clock.clear(id),
    clearInterval: (id) => clock.clear(id),
    queueMicrotask,
    navigator: navigatorObj,
    performance: { now: () => clock.now() - startAt, timeOrigin: startAt },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    // AbortSignal.timeout must run on the virtual clock or a test could never see a worker timeout
    AbortSignal: new Proxy(AbortSignal, {
      get(target, prop) {
        if (prop === 'timeout') {
          return (ms) => {
            const c = new AbortController()
            clock.schedule(() => c.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms)
            return c.signal
          }
        }
        return Reflect.get(target, prop)
      },
    }),
    Headers,
    Response,
    Request,
    Blob,
    FormData,
    DOMException,
    Event,
    EventTarget,
    atob,
    btoa,
    crypto,
    addEventListener: (type, fn) => {
      if (!selfListeners.has(type)) selfListeners.set(type, [])
      selfListeners.get(type).push(fn)
    },
    removeEventListener: (type, fn) => {
      const l = selfListeners.get(type) || []
      const i = l.indexOf(fn)
      if (i >= 0) l.splice(i, 1)
    },
  })
  vm.runInContext('globalThis.self = globalThis', ctx)
  // the worker's Date and Math.random, made of the worker's own builtins (not the host's)
  vm.runInContext(
    `(function (now, random) {
      const Real = Date
      class FakeDate extends Real {
        constructor(...a) { if (a.length === 0) super(now()); else super(...a) }
        static now() { return now() }
      }
      globalThis.Date = FakeDate
      Math.random = random
    })`,
    ctx,
  )(clock.now, opts.random ?? (() => 0))

  // ---- browser state: fresh, or carried over from the worker this one replaces ----
  const seed = (area, obj) => fake.areas[area]._seed(obj)
  // a profile that has run the worker before: the one-time boot migrations are already done (the
  // emote-cache one WIPES channel_emotes_map on a first run, which would eat a test's seeded cache).
  // `fresh: true` is a first install.
  const installed = opts.fresh ? {} : { migrated_to_prod_v2: true, migrated_emote_cache_v154: true }
  for (const area of ['local', 'session', 'sync']) {
    seed(area, prev?.storage[area] ?? { ...(area === 'local' ? installed : {}), ...opts.storage?.[area] })
  }
  for (const c of prev?.cookies ?? opts.cookies ?? []) fake.seedCookie({ path: '/', session: true, ...c })
  for (const t of prev?.tabs ?? opts.tabs ?? []) fake.addTab(t)
  if (!prev && opts.healthy !== false) for (const [matcher, handler] of healthyRoutes) net.on(matcher, handler)
  for (const [matcher, handler] of [...(prev?.routes ?? []), ...(opts.routes ?? [])]) net.on(matcher, handler)
  for (const a of prev?.alarms ?? [])
    fake.armAlarm(a.name, { when: a.scheduledTime, periodInMinutes: a.periodInMinutes })

  const sw = {
    ctx,
    clock,
    net,
    chrome: fake.chrome,
    sockets,
    consoleLog,
    tabMessages: fake.tabMessages,
    storage: Object.fromEntries(
      ['local', 'session', 'sync'].map((n) => [
        n,
        {
          snapshot: () => fake.areas[n]._snapshot(),
          seed: (obj) => fake.areas[n]._seed(obj),
          /** make the next `op` ('get' | 'set' | 'remove') reject with `error`; `when(arg)` picks the call
           *  (arg = the items for set, the keys for get/remove), e.g. only the write that carries one key */
          fail: (op, error, when) => fake.areas[n]._fail(op, error, when),
        },
      ]),
    ),
    now: () => clock.now(),
    settle: () => clock.settle(),
    advance: (ms) => clock.advance(ms),

    /** run code in the worker's scope (its top-level const/let/function are visible by name) */
    eval: (code) => vm.runInContext(code, ctx, { filename: 'harness-eval.js' }),

    /** deliver a message; the handle fills in live (see fake-chrome deliver) */
    post: (message, sender) => fake.deliver(message, sender === undefined ? popupSender : sender),
    /** deliver a message, let the worker finish, return its reply (undefined = it never replied) */
    async send(message, sender) {
      const h = sw.post(message, sender)
      await clock.settle()
      return h.response
    },
    /** like send, but says whether the channel was held open with no answer */
    async exchange(message, sender) {
      const h = sw.post(message, sender)
      await clock.settle()
      return { ...h }
    },

    /** the newest socket whose url contains `part` (default: the heatsync server socket) */
    socket: (part = HS_WS) => [...sockets].reverse().find((s) => s.url.includes(part)),
    /** open the newest still-connecting socket (default: the heatsync server socket) and let the worker react */
    async connect(part = HS_WS) {
      const s = [...sockets].reverse().find((x) => x.readyState === 0 && x.url.includes(part))
      if (!s) throw new Error(`harness: no connecting socket${part ? ` for ${part}` : ''}`)
      s.open()
      await clock.advance(0) // the worker's zero-delay follow-ups (the first frame of the connect burst)
      return s
    },

    addTab: (t) => fake.addTab(t),
    removeTab: (id) => fake.removeTab(id),
    navigateTab: (id, url) => fake.navigateTab(id, url),
    tabSender: (id) => tabSender(id, fake.tabUrl?.(id)),
    /** messages the worker pushed to tabs, optionally one type, optionally one tab */
    broadcasts: (type, tabId) =>
      fake.tabMessages.filter((m) => (!type || m.message.type === type) && (tabId == null || m.tabId === tabId)),

    cookies: {
      set: (c) => fake.setCookie({ path: '/', session: true, ...c }),
      remove: (n, d) => fake.removeCookie(n, d),
    },
    alarms: { names: () => fake.alarmNames(), get: (n) => fake.alarm(n) },

    /** a window event on the worker's global (`online`, `offline`, `push` ...) */
    dispatch: (type, event = {}) => {
      for (const fn of [...(selfListeners.get(type) || [])]) fn({ type, ...event })
      return clock.settle()
    },
    setOnline(on) {
      navigatorObj.onLine = on
      return sw.dispatch(on ? 'online' : 'offline')
    },

    _state: () => ({
      now: clock.now(),
      storage: Object.fromEntries(['local', 'session', 'sync'].map((n) => [n, fake.areas[n]._snapshot()])),
      cookies: fake.cookieJar(),
      tabs: fake.tabList(),
      routes: net.routes.map((r) => [r.match, r.handler]).reverse(),
      alarms: fake.alarmList(),
    }),
    /** the browser killed this worker (idle eviction) and woke a fresh one: memory is gone, the rest stays */
    restart: (more = {}) =>
      bootSw({ sockets: opts.sockets, healthy: opts.healthy, random: opts.random, ...more, from: sw }),
  }
  const popupSender = { id: EXTENSION_ID } // an extension page: no tab, always allowed
  return sw
}

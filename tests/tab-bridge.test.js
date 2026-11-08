/**
 * The tab bridge: yt and kick sends ride one implementation.
 *
 * Kick used to answer `no_kick_tab` unless a kick.com tab happened to be open,
 * while youtube quietly opened a hidden bridge tab. Now both go through
 * createTabBridge. The real bridge + relay code is carved out of the background
 * parts and run against a fake browser: tabs that load slowly, answer pings,
 * die, get closed by the user.
 */

import { describe, expect, test } from 'bun:test'
import { bgSource } from './bg-src.js'

const SRC = bgSource()
function carve(from, to) {
  const a = SRC.indexOf(from)
  const b = SRC.indexOf(to, a)
  if (a < 0 || b < a) throw new Error(`carve: ${from} … ${to} not found — a part moved`)
  return SRC.slice(a, b)
}
const BRIDGE = carve('const TAB_BRIDGE_MARK', '// ========== COSMETICS')
const KICK = carve('function rankKickRelayTabs', 'const kickChatroomIdCache')
const PROGRAM = `${BRIDGE}\n${KICK}\nreturn { kickBridge, ytBridge, sendKickMessageViaTab, setKickChatModeViaTab, relayViaKickTab, sendYoutubeChat, sweepBridgeTabs, TAB_BRIDGE_MARK }`

const realSetTimeout = globalThis.setTimeout
const KICK_URL = 'https://kick.com/privacy-policy#hs-bridge'

function matches(pattern, url) {
  const bare = String(url).split('#')[0]
  const re = new RegExp(
    `^${pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace('://*\\.', '://(?:.*\\.)?')
      .replace(/\*/g, '.*')}$`,
  )
  return re.test(bare)
}

/**
 * A fake browser. A tab's `onMessage(msg, tab)` is the page: return a value to
 * answer, undefined for "nothing heard it", or throw. Tabs we create get
 * `bridgePage`: ready after `readyAfter` pings, then answers every relay.
 */
function world({
  loggedIn = true,
  tabs: initial = [],
  bridgePage = { readyAfter: 1 },
  createFails = false,
  slowTimers = false,
} = {}) {
  const clock = { t: 1_700_000_000_000 }
  const tabs = new Map()
  const created = []
  const removed = []
  const sent = []
  const removedListeners = []
  let nextId = 100
  let closesLeft = bridgePage.closeOnPing || 0 // how many bridge tabs the user closes on their first ping

  const answerLikeKick = (tab, msg) => {
    const notYet = () => new Error('Could not establish connection. Receiving end does not exist.')
    if (msg.type === 'kick_bridge_ping') {
      tab.pings = (tab.pings || 0) + 1
      if (bridgePage.neverReady || tab.pings < (bridgePage.readyAfter ?? 1)) throw notYet()
      tab.ready = true
      return { ok: true }
    }
    // a page still loading has no relay listener yet, exactly like the real thing
    if (!tab.ready) throw notYet()
    return { ok: true, via: tab.id }
  }
  const addTab = (t) => {
    const tab = { status: 'complete', active: false, discarded: false, ...t }
    tabs.set(tab.id, tab)
    return tab
  }
  for (const t of initial) addTab(t)

  const browser = {
    cookies: {
      get: async ({ name }) => (name === 'XSRF-TOKEN' ? (loggedIn ? { value: 'xsrf' } : null) : { value: 'sess' }),
    },
    tabs: {
      onRemoved: { addListener: (fn) => removedListeners.push(fn) },
      get: async (id) => {
        const t = tabs.get(id)
        if (!t) throw new Error(`No tab with id: ${id}`)
        return t
      },
      query: async ({ url }) => [...tabs.values()].filter((t) => matches(url, t.url)),
      create: async (opts) => {
        created.push(opts)
        if (createFails) throw new Error('cannot create')
        const tab = addTab({ id: nextId++, url: opts.url, active: opts.active, pinned: opts.pinned, bridge: true })
        return tab
      },
      remove: async (id) => {
        tabs.delete(id)
        removed.push(id)
        for (const f of removedListeners) f(id)
      },
      update: async () => {},
      sendMessage: async (id, msg) => {
        const tab = tabs.get(id)
        if (!tab) throw new Error(`No tab with id: ${id}`)
        sent.push({ id, type: msg.type })
        if (tab.bridge && closesLeft > 0 && msg.type === 'kick_bridge_ping') {
          closesLeft -= 1
          await browser.tabs.remove(id) // the user closes it while we wait
          throw new Error('Could not establish connection. Receiving end does not exist.')
        }
        if (tab.onMessage) return tab.onMessage(msg, tab)
        if (tab.bridge) {
          if (tab.dieOnRelay && msg.type !== 'kick_bridge_ping') {
            tab.dieOnRelay -= 1
            await browser.tabs.remove(id)
            throw new Error(`No tab with id: ${id}`)
          }
          return answerLikeKick(tab, msg)
        }
        return undefined
      },
    },
  }
  // virtual time for the readiness poll; long timers (a relay deadline) run on a short real one
  const fakeSetTimeout = (fn, ms) => {
    if (slowTimers && ms >= 5000) return realSetTimeout(fn, 15)
    clock.t += ms
    return realSetTimeout(fn, 0)
  }
  const FakeDate = { now: () => clock.t }
  const api = new Function('browser', 'log', 'setTimeout', 'Date', PROGRAM)(browser, () => {}, fakeSetTimeout, FakeDate)
  return { ...api, browser, tabs, created, removed, sent, clock, addTab }
}

const relays = (w, type = 'kick_send_relay') => w.sent.filter((s) => s.type === type)

describe('tab bridge: carve markers', () => {
  test('found', () => {
    expect(BRIDGE.length).toBeGreaterThan(500)
    expect(KICK.length).toBeGreaterThan(500)
  })
})

describe('kick send with no kick tab', () => {
  test('opens one hidden bridge tab, waits for it to answer, sends through it', async () => {
    const w = world({ bridgePage: { readyAfter: 3 } })
    const r = await w.sendKickMessageViaTab(555, 'hello')
    expect(r).toEqual({ ok: true, via: 100 })
    expect(w.created).toEqual([{ url: KICK_URL, active: false, pinned: true }])
    // three pings (two refused while the page loaded), then the one send
    expect(w.sent.map((s) => s.type)).toEqual([
      'kick_bridge_ping',
      'kick_bridge_ping',
      'kick_bridge_ping',
      'kick_send_relay',
    ])
  })

  test('the next send reuses the tab', async () => {
    const w = world()
    await w.sendKickMessageViaTab(555, 'one')
    const r = await w.sendKickMessageViaTab(555, 'two')
    expect(r.ok).toBe(true)
    expect(w.created.length).toBe(1)
    expect(relays(w).length).toBe(2)
  })

  test('concurrent sends share ONE tab and every one is answered', async () => {
    const w = world({ bridgePage: { readyAfter: 4 } })
    const out = await Promise.all([1, 2, 3, 4].map((i) => w.sendKickMessageViaTab(555, `m${i}`)))
    expect(out.every((r) => r.ok && r.via === 100)).toBe(true)
    expect(w.created.length).toBe(1)
  })

  test('the relay message carries the login the page needs', async () => {
    const w = world()
    let seen
    w.addTab({
      id: 7,
      url: 'https://kick.com/xqc',
      active: true,
      onMessage: (m) => {
        seen = m
        return { ok: true }
      },
    })
    await w.sendKickMessageViaTab(555, 'yo', { id: 'p1' })
    expect(seen).toMatchObject({
      type: 'kick_send_relay',
      channelId: 555,
      content: 'yo',
      reply: { id: 'p1' },
      xsrfToken: 'xsrf',
      sessionToken: 'sess',
    })
  })

  test('chat-mode relay gets the same bridge', async () => {
    const w = world()
    const r = await w.setKickChatModeViaTab(9, { slow_mode: true })
    expect(r.ok).toBe(true)
    expect(w.created.length).toBe(1)
    expect(relays(w, 'kick_chatmode_relay').length).toBe(1)
  })
})

describe('kick send: when the bridge is NOT used', () => {
  test('an open kick tab answers: no bridge is opened', async () => {
    const w = world()
    w.addTab({ id: 7, url: 'https://kick.com/xqc', active: true, onMessage: () => ({ ok: true, via: 7 }) })
    expect(await w.sendKickMessageViaTab(555, 'hi')).toEqual({ ok: true, via: 7 })
    expect(w.created.length).toBe(0)
  })

  test('a kick page that answers with a refusal is final', async () => {
    const w = world()
    w.addTab({ id: 7, url: 'https://kick.com/xqc', onMessage: () => ({ ok: false, error: 'banned' }) })
    expect(await w.sendKickMessageViaTab(555, 'hi')).toEqual({ ok: false, error: 'banned' })
    expect(w.created.length).toBe(0)
  })

  test('logged out: answered from cookies, no tab is opened', async () => {
    const w = world({ loggedIn: false })
    expect(await w.sendKickMessageViaTab(555, 'hi')).toEqual({ ok: false, error: 'kick_not_logged_in' })
    expect(w.created.length).toBe(0)
  })

  test('a tab that took the message and died mid-way is never re-driven through a bridge', async () => {
    const w = world()
    w.addTab({
      id: 7,
      url: 'https://kick.com/xqc',
      onMessage: () => {
        throw new Error('The message port closed before a response was received.')
      },
    })
    const r = await w.sendKickMessageViaTab(555, 'hi')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/message port closed/)
    expect(w.created.length).toBe(0)
  })
})

describe('kick send: tabs that cannot hear it', () => {
  const dead = () => {
    throw new Error('Could not establish connection. Receiving end does not exist.')
  }

  test('every open kick tab is dead (discarded, pre-reload): the bridge carries it', async () => {
    const w = world()
    w.addTab({ id: 7, url: 'https://kick.com/a', discarded: true, onMessage: dead })
    w.addTab({ id: 8, url: 'https://kick.com/b', onMessage: dead })
    const r = await w.sendKickMessageViaTab(555, 'hi')
    expect(r.ok).toBe(true)
    expect(r.via).toBe(100)
    expect(w.created.length).toBe(1)
  })

  test('a tab no content script is on (kick login page) answers nothing: the bridge carries it', async () => {
    const w = world()
    w.addTab({ id: 7, url: 'https://id.kick.com/login', onMessage: () => undefined })
    expect((await w.sendKickMessageViaTab(555, 'hi')).via).toBe(100)
  })

  test('a live tab behind a dead one still wins; no bridge', async () => {
    const w = world()
    w.addTab({ id: 7, url: 'https://kick.com/a', discarded: true, onMessage: dead })
    w.addTab({ id: 8, url: 'https://kick.com/b', active: true, onMessage: () => ({ ok: true, via: 8 }) })
    expect((await w.sendKickMessageViaTab(555, 'hi')).via).toBe(8)
    expect(w.created.length).toBe(0)
  })
})

describe('kick bridge failures are loud', () => {
  test('a page that never answers: kick_bridge_timeout, nothing sent', async () => {
    const w = world({ bridgePage: { neverReady: true } })
    expect(await w.sendKickMessageViaTab(555, 'hi')).toEqual({ ok: false, error: 'kick_bridge_timeout' })
    expect(relays(w).length).toBe(0)
  })

  test('the user closes the bridge while we wait: one fresh tab, then the send', async () => {
    const w = world({ bridgePage: { readyAfter: 1, closeOnPing: 1 } })
    const r = await w.sendKickMessageViaTab(555, 'hi')
    expect(r.ok).toBe(true)
    expect(w.created.length).toBe(2)
  })

  test('closed every time: no_kick_tab, not an endless loop', async () => {
    const w = world({ bridgePage: { readyAfter: 1, closeOnPing: 99 } })
    expect(await w.sendKickMessageViaTab(555, 'hi')).toEqual({ ok: false, error: 'no_kick_tab' })
    expect(w.created.length).toBe(2)
  })

  test('closed between ready and delivery: the payload never landed, so one fresh tab is safe', async () => {
    const w = world()
    w.browser.tabs.create = ((orig) => async (o) => {
      const t = await orig(o)
      if (t.id === 100) t.dieOnRelay = 1
      return t
    })(w.browser.tabs.create)
    const r = await w.sendKickMessageViaTab(555, 'hi')
    expect(r).toEqual({ ok: true, via: 101 })
    expect(w.created.length).toBe(2)
  })

  test('the browser refuses to open a tab: no_kick_tab', async () => {
    const w = world({ createFails: true })
    expect(await w.sendKickMessageViaTab(555, 'hi')).toEqual({ ok: false, error: 'no_kick_tab' })
  })
})

describe('mod relay: prefers the channel tab, caps a hung one', () => {
  test('the tab on the slug is asked first', async () => {
    const w = world()
    const asked = []
    for (const [id, url] of [
      [7, 'https://kick.com/other'],
      [8, 'https://kick.com/xqc'],
    ])
      w.addTab({
        id,
        url,
        active: id === 7,
        onMessage: () => {
          asked.push(id)
          return { ok: true }
        },
      })
    await w.relayViaKickTab({ type: 'kick_mod_relay' }, { prefer: (t) => t.url.includes('/xqc') })
    expect(asked).toEqual([8])
  })

  test('a hung tab is cut off at the deadline and named; no bridge (it may have taken it)', async () => {
    const w = world({ slowTimers: true })
    w.addTab({ id: 7, url: 'https://kick.com/xqc', onMessage: () => new Promise(() => {}) })
    const r = await w.relayViaKickTab({ type: 'kick_mod_relay' }, { deadlineMs: 12000 })
    expect(r).toEqual({ ok: false, error: 'kick tab unresponsive — reload kick.com' })
    expect(w.created.length).toBe(0)
  })
})

describe('sweep', () => {
  const MIN = 60 * 1000

  test('an idle bridge is closed; a fresh one is kept', async () => {
    const w = world()
    await w.sendKickMessageViaTab(555, 'hi')
    await w.sweepBridgeTabs()
    expect(w.removed).toEqual([])
    w.clock.t += 21 * MIN
    await w.sweepBridgeTabs()
    expect(w.removed).toEqual([100])
  })

  test('using the bridge keeps it alive past the idle window', async () => {
    const w = world()
    await w.sendKickMessageViaTab(555, 'one')
    w.clock.t += 15 * MIN
    await w.sendKickMessageViaTab(555, 'two')
    w.clock.t += 15 * MIN
    await w.sweepBridgeTabs()
    expect(w.removed).toEqual([])
  })

  test('an orphaned bridge (worker restarted) is closed; a user tab never is', async () => {
    const w = world()
    w.addTab({ id: 3, url: 'https://kick.com/xqc', active: true })
    w.addTab({ id: 4, url: KICK_URL })
    w.addTab({ id: 5, url: 'https://www.youtube.com/watch?v=abc' })
    await w.sweepBridgeTabs()
    expect(w.removed).toEqual([4])
  })

  test('a bridge the worker forgot is re-adopted when a send uses it, then survives the sweep', async () => {
    const w = world()
    w.addTab({ id: 4, url: KICK_URL, onMessage: () => ({ ok: true, via: 4 }) })
    expect((await w.sendKickMessageViaTab(555, 'hi')).via).toBe(4)
    await w.sweepBridgeTabs()
    expect(w.removed).toEqual([])
    expect(w.created.length).toBe(0)
  })

  test('a tab the user closes is forgotten at once; the next send opens a new one', async () => {
    const w = world()
    await w.sendKickMessageViaTab(555, 'one')
    await w.browser.tabs.remove(100)
    expect((await w.sendKickMessageViaTab(555, 'two')).via).toBe(101)
    expect(w.created.length).toBe(2)
  })
})

describe('youtube rides the same bridge', () => {
  const VID = '0sfDth4lMLc'
  const ytPage =
    (opts = {}) =>
    (msg, tab) => {
      if (msg.type === 'youtube_bridge_ping') {
        tab.pings = (tab.pings || 0) + 1
        if (tab.pings < (opts.readyAfter ?? 1)) return { ok: true, hasInput: false }
        return { ok: true, hasInput: true, disabled: !!opts.disabled }
      }
      return { ok: true, ytUsername: 'mellen' }
    }
  function ytWorld(opts) {
    const w = world({ bridgePage: { neverReady: true } })
    const orig = w.browser.tabs.create
    w.browser.tabs.create = async (o) => {
      const t = await orig(o)
      t.bridge = false
      t.onMessage = ytPage(opts)
      return t
    }
    return w
  }

  test('no yt tab: a hidden live_chat bridge for that exact stream', async () => {
    const w = ytWorld()
    const r = await w.sendYoutubeChat({ videoId: VID, text: 'hi' })
    expect(r).toEqual({ ok: true, ytUsername: 'mellen' })
    expect(w.created).toEqual([
      { url: `https://www.youtube.com/live_chat?v=${VID}#hs-bridge`, active: false, pinned: true },
    ])
  })

  test('closed while we wait: one fresh tab', async () => {
    const w = ytWorld({ readyAfter: 2 })
    const origSend = w.browser.tabs.sendMessage
    let closedOnce = false
    w.browser.tabs.sendMessage = async (id, msg) => {
      if (!closedOnce && msg.type === 'youtube_bridge_ping') {
        closedOnce = true
        await w.browser.tabs.remove(id)
      }
      return origSend(id, msg)
    }
    const r = await w.sendYoutubeChat({ videoId: VID, text: 'hi' })
    expect(r.ok).toBe(true)
    expect(w.created.length).toBe(2)
  })

  test('logged out: the tab is brought forward and chat_disabled is reported', async () => {
    const w = ytWorld({ disabled: true })
    let activated = null
    w.browser.tabs.update = async (id, props) => {
      activated = { id, ...props }
    }
    const r = await w.sendYoutubeChat({ videoId: VID, text: 'hi' })
    expect(r.error).toBe('chat_disabled')
    expect(activated).toEqual({ id: 100, active: true })
  })

  test('yt sweep goes through the same alarm', async () => {
    const w = ytWorld()
    await w.sendYoutubeChat({ videoId: VID, text: 'hi' })
    w.clock.t += 21 * 60 * 1000
    await w.sweepBridgeTabs()
    expect(w.removed).toEqual([100])
  })
})

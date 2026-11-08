// the service worker's websocket to heatsync.org, executed: connect burst, heartbeat, the reconnect
// backoff ladder, what stops a reconnect, and the queue that holds messages across a gap.
// real worker, fake socket (tests/harness/sw.js). Math.random() is 0 in the harness, so jitter is 0ms
// and every delay below is exact.
//
// a socket left CONNECTING past its 10s connect timeout makes the worker's reconnect timer reject a
// promise nobody catches, which bun reports as a failure. so a test that runs the clock for a while either
// opens/fails every socket it is handed or boots with sockets: 'open'.

import { describe, expect, test } from 'bun:test'
import { bootSw, tabSender } from './harness/sw.js'

const AUTH = { name: 'auth', value: 'tok-1', domain: 'heatsync.org' }
const TAB_URL = 'https://www.twitch.tv/kripp'
const twitchTab = tabSender(7, TAB_URL)

const hsSockets = (sw) => sw.sockets.filter((s) => s.url.startsWith('wss://heatsync.org/ws'))
const sent = (ws, type) => ws.frames.filter((f) => f.type === type)

/** a worker with one platform tab (without one it idle-closes its sockets) and a login cookie */
async function boot(opts = {}) {
  const sw = await bootSw({ cookies: [AUTH], tabs: [{ id: 7, url: TAB_URL }], ...opts })
  // the worker re-checks tab presence 5s after boot and (re)creates its 30s watchdog alarm then. let that
  // pass first, so what a test does to the alarm sticks.
  await sw.advance(5_001)
  return sw
}

/** the 30s watchdog alarm revives a dead socket on its own schedule (tested at the bottom). for the
 *  backoff ladder it would cut a sleep short, so silence it and read the retry timer alone. */
const silenceWatchdog = (sw) => sw.chrome.alarms.clear('hs-ws-watchdog')

/** the socket dies; the worker must wait exactly `ms` before it tries again, no sooner */
async function expectRetryAfter(sw, die, ms) {
  const n = hsSockets(sw).length
  die()
  await sw.settle()
  await sw.advance(ms - 1)
  expect(hsSockets(sw), `a retry came before ${ms}ms`).toHaveLength(n)
  await sw.advance(1)
  expect(hsSockets(sw), `no retry at ${ms}ms`).toHaveLength(n + 1)
  return sw.socket()
}

describe('connect', () => {
  test('dials the heatsync endpoint once, with batching on', async () => {
    const sw = await boot()
    expect(hsSockets(sw).map((s) => s.url)).toEqual(['wss://heatsync.org/ws?b=1'])
  })

  test('on open: heartbeat, then authenticate, then the joins one per 80ms (the server rate-limits bursts)', async () => {
    const sw = await boot()
    const ws = await sw.connect()
    expect(ws.frames).toEqual([{ type: 'presence:heartbeat' }, { type: 'authenticate', token: 'tok-1' }])
    await sw.advance(79)
    expect(ws.frames).toHaveLength(2)
    await sw.advance(1)
    expect(ws.frames.at(-1)).toEqual({ type: 'feed:join', feed: 'new' })
  })

  test('with no cookie it still connects (viewer mode) and never sends a token', async () => {
    const sw = await boot({ cookies: [] })
    const ws = await sw.connect()
    await sw.advance(500)
    expect(sent(ws, 'authenticate')).toEqual([])
    expect(ws.frames[0]).toEqual({ type: 'presence:heartbeat' })
  })

  test('a heartbeat every 20s while it is open', async () => {
    const sw = await boot()
    const ws = await sw.connect()
    const before = sent(ws, 'presence:heartbeat').length
    for (let i = 0; i < 3; i++) {
      ws.receive({ type: 'pong' }) // the server is talking, so the zombie check stays quiet
      await sw.advance(20_000)
    }
    expect(sent(ws, 'presence:heartbeat').length - before).toBeGreaterThanOrEqual(3)
  })

  test('a reconnect rejoins every room the tabs are in', async () => {
    const sw = await boot()
    const first = await sw.connect()
    await sw.send({ type: 'join_channel', platform: 'twitch', channel: 'kripp', channelId: '1' }, twitchTab)
    await sw.advance(200)
    expect(sent(first, 'channel:join')).toHaveLength(1)

    const second = await expectRetryAfter(sw, () => first.drop(1006), 1000)
    second.open()
    await sw.advance(500)
    expect(sent(second, 'channel:join')).toEqual([{ type: 'channel:join', platform: 'twitch', channel: 'kripp' }])
  })
})

describe('reconnect backoff', () => {
  test('doubles each failure (1s, 2s, 4s, 8s) and is capped at 15s', async () => {
    const sw = await boot()
    await silenceWatchdog(sw)
    const ws = await sw.connect()
    let next = await expectRetryAfter(sw, () => ws.drop(1006), 1000) // an open connection dying
    // from here every retry fails before its handshake finishes
    for (const wait of [2000, 4000, 8000, 15000, 15000, 15000]) {
      next = await expectRetryAfter(sw, () => next.fail(), wait)
    }
  })

  test('a successful open resets the ladder to 1s', async () => {
    const sw = await boot()
    await silenceWatchdog(sw)
    let ws = await sw.connect()
    ws = await expectRetryAfter(sw, () => ws.drop(1006), 1000)
    ws = await expectRetryAfter(sw, () => ws.fail(), 2000)
    ws = await expectRetryAfter(sw, () => ws.fail(), 4000)
    ws.open() // it holds this time
    await sw.settle()
    await expectRetryAfter(sw, () => ws.drop(1006), 1000)
  })

  test('three failures in a row tell the tabs the server is down; recovering tells them it is up', async () => {
    const sw = await boot()
    await silenceWatchdog(sw)
    let ws = await sw.connect()
    ws = await expectRetryAfter(sw, () => ws.drop(1006), 1000)
    ws = await expectRetryAfter(sw, () => ws.fail(), 2000)
    expect(sw.broadcasts('api_status')).toEqual([])
    ws = await expectRetryAfter(sw, () => ws.fail(), 4000) // the third scheduled retry
    expect(sw.broadcasts('api_status', 7).map((m) => m.message)).toEqual([
      { type: 'api_status', source: 'heatsync', state: 'down' },
    ])
    ws.open()
    await sw.settle()
    expect(sw.broadcasts('api_status', 7).map((m) => m.message.state)).toEqual(['down', 'up'])
  })

  test('a socket that never answers is abandoned after 10s and retried 1s later', async () => {
    const sw = await boot() // clock is at +5s, the first socket has been connecting since boot
    const first = sw.socket()
    expect(first.readyState).toBe(0)
    await sw.advance(4_998) // 9.999s since it was dialed
    expect(first.readyState).toBe(0)
    await sw.advance(1) // 10s: the connect timeout closes it and backs off
    expect(first.readyState).toBeGreaterThanOrEqual(2)
    await sw.advance(999)
    expect(hsSockets(sw)).toHaveLength(1)
    await sw.advance(1)
    expect(hsSockets(sw)).toHaveLength(2)
    sw.socket().fail() // leave nothing connecting past its timeout
  })

  test('a server that asked clients to spread out gets a randomised, bounded wait (once)', async () => {
    const sw = await boot({ random: () => 0.5 })
    await silenceWatchdog(sw)
    const ws = await sw.connect()
    ws.receive({ type: 'server:shutdown', reconnectSpreadMs: 10_000 })
    await sw.settle()
    // 1000 backoff + 500 jitter (0.5 * 1000) + 5000 spread (0.5 * 10_000)
    const next = await expectRetryAfter(sw, () => ws.drop(1001), 6500)
    // consumed: the next failure is plain backoff again (2000 + 500 jitter)
    await expectRetryAfter(sw, () => next.fail(), 2500)
  })
})

describe('what stops or skips a reconnect', () => {
  test('offline: no retries are burned; back online: it connects at once', async () => {
    const sw = await boot()
    await silenceWatchdog(sw)
    const ws = await sw.connect()
    await sw.setOnline(false)
    ws.drop(1006)
    await sw.advance(60_000)
    expect(hsSockets(sw)).toHaveLength(1) // nothing tried while the network is known dead

    await sw.setOnline(true)
    expect(hsSockets(sw)).toHaveLength(2)
    sw.socket().fail()
  })

  test('a rejected login blocks reconnects until a fresh login clears it', async () => {
    const sw = await boot({ routes: [['https://heatsync.org/api/auth/me', () => new Response('', { status: 401 })]] })
    await silenceWatchdog(sw)
    const ws = await sw.connect()
    sw.cookies.remove('auth', 'heatsync.org') // the browser holds no other token
    ws.receive({ type: 'authentication_failed' })
    await sw.settle()
    await sw.advance(120_000)
    expect(hsSockets(sw)).toHaveLength(1) // not looping authenticate -> authentication_failed
    expect(sw.broadcasts('auth_changed', 7).map((m) => m.message.reason)).toContain('authentication_failed')

    sw.cookies.set({ ...AUTH, value: 'tok-2' }) // the user signs in again
    await sw.settle()
    const again = await sw.connect()
    expect(sent(again, 'authenticate')).toEqual([{ type: 'authenticate', token: 'tok-2' }])
  })

  test('the last platform tab closing shuts the socket for good; a returning tab reopens it', async () => {
    const sw = await boot({ sockets: 'open' })
    const ws = sw.socket()
    expect(ws.readyState).toBe(1)
    sw.removeTab(7)
    await sw.advance(5_000) // the grace window that rides out a reload
    expect(ws.readyState).toBeGreaterThanOrEqual(2)
    await sw.advance(120_000)
    expect(hsSockets(sw)).toHaveLength(1) // an idle close is not a failure: nothing retries

    sw.addTab({ id: 8, url: TAB_URL })
    sw.navigateTab(8, TAB_URL) // a tab arrives at a platform url
    await sw.advance(5_000)
    expect(hsSockets(sw)).toHaveLength(2)
  })
})

describe('watchdog alarm', () => {
  test('a socket the server never speaks on (45s+) is a zombie: closed and replaced', async () => {
    const sw = await boot({ sockets: 'open' })
    const ws = sw.socket()
    await sw.advance(150_000)
    expect(ws.readyState).toBeGreaterThanOrEqual(2)
    expect(hsSockets(sw).length).toBeGreaterThan(1)
  })

  test('a socket that keeps hearing from the server is left alone', async () => {
    const sw = await boot({ sockets: 'open' })
    const ws = sw.socket()
    for (let i = 0; i < 12; i++) {
      ws.receive({ type: 'pong' })
      await sw.advance(20_000)
    }
    expect(hsSockets(sw)).toHaveLength(1)
    expect(ws.readyState).toBe(1)
  })

  test('with the socket down it reconnects at the tick instead of sitting out the backoff', async () => {
    const sw = await boot()
    const ws = await sw.connect()
    const second = await expectRetryAfter(sw, () => ws.drop(1006), 1000)
    second.fail() // the next scheduled retry is 2s out
    await sw.settle()
    const n = hsSockets(sw).length
    sw.chrome.alarms.onAlarm.emit({ name: 'hs-ws-watchdog', scheduledTime: sw.now() })
    await sw.settle()
    expect(hsSockets(sw)).toHaveLength(n + 1)
    sw.socket().fail()
  })
})

describe('messages sent while the socket is down', () => {
  const allowed = { type: 'ws_send', data: { type: 'emote:used', name: 'Kappa' } }
  const emoteFrames = (ws) => sent(ws, 'emote:used').map(({ type, name }) => ({ type, name }))

  test('wait in a queue and go out once, after the server authenticates the new connection', async () => {
    const sw = await boot()
    await silenceWatchdog(sw)
    const first = await sw.connect()
    first.receive({ type: 'authenticated', userId: 1 })
    await sw.advance(2_000)
    first.drop(1006)
    await sw.settle()
    await sw.send(allowed, twitchTab) // while down: queued, and the send itself starts a reconnect
    expect(emoteFrames(first)).toEqual([])

    const second = sw.socket()
    expect(second).not.toBe(first)
    second.open()
    await sw.advance(2_000)
    expect(emoteFrames(second), 'sent before the server authenticated us').toEqual([])
    second.receive({ type: 'authenticated', userId: 1 })
    await sw.advance(2_000)
    expect(emoteFrames(second)).toEqual([{ type: 'emote:used', name: 'Kappa' }])
  })

  test('are dropped if they sat in the queue past 60s (a stale emote count is worse than none)', async () => {
    const sw = await boot({ sockets: 'open' })
    const first = sw.socket()
    first.drop(1006)
    await sw.send(allowed, twitchTab) // queued; the next socket opens by itself but is not authenticated yet
    await sw.advance(61_000)
    const live = sw.socket()
    live.receive({ type: 'authenticated', userId: 1 })
    await sw.advance(2_000)
    expect(hsSockets(sw).flatMap(emoteFrames)).toEqual([])
  })

  test('a fresh one sent just before the server authenticates is delivered', async () => {
    const sw = await boot({ sockets: 'open' })
    sw.socket().drop(1006)
    await sw.send(allowed, twitchTab)
    await sw.advance(2_000)
    sw.socket().receive({ type: 'authenticated', userId: 1 })
    await sw.advance(2_000)
    expect(hsSockets(sw).flatMap(emoteFrames)).toEqual([{ type: 'emote:used', name: 'Kappa' }])
  })
})

/**
 * Whispers over EventSub still work with the twitch token kept in the worker.
 *
 * eventsub-whispers.js used to hold the raw token and call helix itself (own id,
 * then the subscription). Both calls now go through twitchHelixViaBg, so the
 * file needs no token. This runs the real file against a fake background and a
 * fake EventSub socket and proves the legitimate flow — login → own id →
 * socket → welcome → subscribe → whisper delivered — and the give-up paths.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'eventsub-whispers.js'), 'utf8')

function load({ loggedIn = true, helix } = {}) {
  const calls = []
  const sockets = []
  const whispers = []
  class FakeWS {
    static OPEN = 1
    constructor(url) {
      this.url = url
      this.readyState = 1
      sockets.push(this)
    }
    close() {
      this.readyState = 3
    }
  }
  const twitchHelixViaBg = async (op, args) => {
    calls.push({ op, args })
    return helix(op, args)
  }
  const cleanup = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (t) => clearInterval(t),
    setPageTimeout: (fn, ms) => setTimeout(fn, ms),
    setPageInterval: (fn, ms) => setInterval(fn, ms),
  }
  const make = new Function(
    'WebSocket',
    'twitchHelixViaBg',
    'getTwitchLoginAsync',
    'handleIncomingWhisper',
    'cleanup',
    'log',
    `${SRC}\nreturn { eswState, startEventSubWhispers, reconnectEventSubIfDead, eswCleanup }`,
  )
  const api = make(
    FakeWS,
    twitchHelixViaBg,
    async () => ({ loggedIn, username: null }),
    (w) => whispers.push(w),
    cleanup,
    () => {},
  )
  return { ...api, calls, sockets, whispers }
}

const welcome = (id) =>
  JSON.stringify({
    metadata: { message_type: 'session_welcome' },
    payload: { session: { id, keepalive_timeout_seconds: 10 } },
  })
const flush = () => new Promise((r) => setTimeout(r, 5))

test('login → own id → socket → welcome → subscribe → whisper delivered', async () => {
  const h = load({ helix: (op) => (op === 'self_id' ? { ok: true, id: '4242' } : { ok: true, status: 202 }) })
  await h.startEventSubWhispers()
  expect(h.calls).toEqual([{ op: 'self_id', args: undefined }])
  expect(h.sockets).toHaveLength(1)
  expect(h.sockets[0].url).toBe('wss://eventsub.wss.twitch.tv/ws')

  h.sockets[0].onmessage({ data: welcome('AQoQsession-id-1') })
  await flush()
  expect(h.calls[1]).toEqual({ op: 'whisper_subscribe', args: { sessionId: 'AQoQsession-id-1', userId: '4242' } })
  expect(h.eswState.subscribed).toBe(true)

  h.sockets[0].onmessage({
    data: JSON.stringify({
      metadata: { message_type: 'notification', subscription_type: 'user.whisper.message', message_id: 'm1' },
      payload: { event: { from_user_id: '9', from_user_name: 'Friend', whisper_id: 'w1', whisper: { text: 'psst' } } },
    }),
  })
  expect(h.whispers.map((w) => [w.user, w.text, w.src])).toEqual([['Friend', 'psst', 'eventsub']])
  h.eswCleanup(true)
})

test('no twitch login: no socket, no helix call', async () => {
  const h = load({ loggedIn: false, helix: () => ({ ok: true, id: '1' }) })
  await h.startEventSubWhispers()
  expect(h.sockets).toHaveLength(0)
  expect(h.calls).toHaveLength(0)
})

test('own id unknown (helix said no): no socket, nothing scheduled', async () => {
  const h = load({ helix: () => ({ ok: false, status: 401, error: 'helix 401' }) })
  await h.startEventSubWhispers()
  expect(h.sockets).toHaveLength(0)
  expect(h.eswState.reconnectTimer).toBeNull()
})

test('a 403 on the subscription (token lacks the whisper scope) gives up: no reconnect loop', async () => {
  const h = load({ helix: (op) => (op === 'self_id' ? { ok: true, id: '4242' } : { ok: false, status: 403 }) })
  await h.startEventSubWhispers()
  const sock = h.sockets[0]
  sock.onmessage({ data: welcome('AQoQsession-id-2') })
  await flush()
  expect(h.eswState.destroyed).toBe(true)
  expect(h.eswState.subscribed).toBe(false)
  expect(h.eswState.reconnectTimer).toBeNull()
})

test('the login vanishing between welcome and subscribe also gives up', async () => {
  const h = load({ helix: (op) => (op === 'self_id' ? { ok: true, id: '4242' } : { ok: false, error: 'no_token' }) })
  await h.startEventSubWhispers()
  h.sockets[0].onmessage({ data: welcome('AQoQsession-id-3') })
  await flush()
  expect(h.eswState.destroyed).toBe(true)
})

test('a reconnect asks again (the own id is cached) and never needs a token', async () => {
  const h = load({ helix: (op) => (op === 'self_id' ? { ok: true, id: '4242' } : { ok: true, status: 202 }) })
  await h.startEventSubWhispers()
  h.eswCleanup() // socket dropped
  await h.reconnectEventSubIfDead()
  await flush()
  expect(h.calls.filter((c) => c.op === 'self_id')).toHaveLength(1)
  expect(h.sockets).toHaveLength(2)
  h.eswCleanup(true)
})

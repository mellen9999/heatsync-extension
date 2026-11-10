// The BG kick tap speaks centrifugo (kick left pusher, 2026-11). Drives the real
// tap source against a fake WebSocket + fetch, with frames recorded live
// (tests/fixtures/kick-centrifugo-frames.json).
//
// Pinned here, each of which has failed or would fail silently:
//   - every pusher-era handler still gets the same {event, channel, data} and
//     broadcasts the same thing
//   - `{}` is answered with `{}`
//   - the backoff ENDS: 5 refusals in a row and no timer is left
//   - an unpin (PinnedMessageDeletedEvent) does NOT delete a chat line — a
//     substring match once routed it to the MessageDeletedEvent branch
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bgSource } from './bg-src.js'

const BG = bgSource()
const FIX = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'kick-centrifugo-frames.json'), 'utf8'))

const START = BG.indexOf('// ─── Kick chat tap (client-side, anonymous, centrifugo)')
const END = BG.indexOf('function bgYtIngest(')
if (START < 0 || END < START) throw new Error('kick tap region not found — source drifted, update this test')
const TAP = BG.slice(START, END)

function makeTap({ discovery } = {}) {
  const sent = []
  const sockets = []
  const timers = new Map()
  let tid = 0
  const fetches = []
  class FakeWS {
    constructor(url) {
      this.url = url
      this.sent = []
      this.closed = false
      sockets.push(this)
    }
    send(s) {
      this.sent.push(JSON.parse(s))
    }
    close() {
      this.closed = true
    }
    open() {
      this.onopen?.()
    }
    recv(...frames) {
      this.onmessage?.({ data: frames.map((f) => (typeof f === 'string' ? f : JSON.stringify(f))).join('\n') })
    }
  }
  const fakeFetch = async (url, init) => {
    fetches.push({ url, init, body: JSON.parse(init.body) })
    const r = discovery ? discovery(url, init) : defaultDiscovery(url)
    return { ok: r !== null, json: async () => r }
  }
  const api = new Function(
    'WebSocket',
    'fetch',
    'setTimeout',
    'clearTimeout',
    'broadcastToTabs',
    `
    const log = () => {}
    const browser = { storage: { session: { get: async () => ({}), set: async () => {} } } }
    const BG_KICK = { channels: new Map() }
    const RESERVED_PATHS = new Set()
    const bgKickIngest = () => {}
    const bgKickFetchRecentArchive = async () => {}
    ${TAP}
    return {
      _kpFrames, _kpDispatch, _kpConnect, _kpWatchdogCheck, _kpNet, _kpChannels, _kpSubbedChannelIds,
      _kickSrcStats, kickTapJoin, kickTapLeave, _kpChatroomCache, _kpChannelIdCache, _kpEventStats,
      state: () => ({ ws: _kpWs, connected: _kpConnected, timer: _kpReconnectTimer, ttl: _kpTtlTimer }),
    }
  `,
  )(
    FakeWS,
    fakeFetch,
    (fn, ms) => {
      timers.set(++tid, { fn, ms })
      return tid
    },
    (id) => timers.delete(id),
    (m) => sent.push(m),
  )
  return { ...api, sent, sockets, timers, fetches }
}

const defaultDiscovery = (url) =>
  url.endsWith('/chat/connection')
    ? {
        data: {
          mode: 'websocket',
          connections: [
            {
              provider: 'centrifugo',
              credentials: { url: 'wss://realtime.test.platform.kick.com/connection/websocket' },
            },
          ],
        },
      }
    : { data: { token: 'guest-token' } }

const flush = () => new Promise((r) => setImmediate(r))
const pub = (event, data, channel = 'chatrooms.111.v2') => ({
  push: { channel, pub: { data: { event, data: typeof data === 'string' ? data : JSON.stringify(data) } } },
})

// join a channel and bring the connection up to the connect ack
async function up(t, slug = 'chan') {
  t._kpChatroomCache.set(slug, 111)
  t._kpChannelIdCache.set(slug, 222)
  await t.kickTapJoin(slug)
  await flush()
  const ws = t.sockets.at(-1)
  ws.open()
  ws.recv({ id: 1, connect: { client: 'x', version: '6', expires: true, ttl: 2700, ping: 25, pong: true } })
  return ws
}

describe('_kpFrames', () => {
  test('recorded live frames classify', () => {
    for (const f of FIX.frames) {
      const out = t0._kpFrames(f.raw)
      expect(
        out.map((x) => x.kind),
        f.note,
      ).toEqual(f.kinds)
    }
  })
  test('packed replies split on newline', () => {
    const out = t0._kpFrames('{}\n{"id":2,"subscribe":{}}\n\n{"id":3,"error":{"code":103}}')
    expect(out.map((x) => x.kind)).toEqual(['ping', 'subscribed', 'error'])
    expect(out[2].code).toBe(103)
  })
  test('garbage never throws', () => {
    expect(t0._kpFrames('null\n[1]\nnot json\n"x"\n{"push":null}\n{"push":{"channel":"c","pub":{}}}')).toEqual([])
  })
  test('a pub adapts to the pusher-era shape, data string or object', () => {
    const [a] = t0._kpFrames(JSON.stringify(pub('App\\Events\\X', { a: 1 })))
    expect(a).toEqual({ kind: 'pub', event: 'App\\Events\\X', channel: 'chatrooms.111.v2', data: '{"a":1}' })
    const [b] = t0._kpFrames('{"push":{"channel":"c","pub":{"data":{"event":"E","data":{"a":1}}}}}')
    expect(b.data).toEqual({ a: 1 })
  })
})
const t0 = makeTap()

describe('transport', () => {
  test('discovery asks both providers, omits credentials, connects, then subscribes', async () => {
    const t = makeTap()
    const ws = await up(t)
    expect(t.fetches[0].url).toBe('https://web.kick.com/api/v1/realtime/channels/222/chat/connection')
    expect(t.fetches[0].init.credentials).toBe('omit')
    expect(t.fetches[0].body.capabilities.accepted_providers).toEqual([
      { provider: 'pusher' },
      { provider: 'centrifugo' },
    ])
    expect(t.fetches[1].url).toBe('https://web.kick.com/api/v1/realtime/auth/connection')
    expect(t.fetches[1].body.client_id).toBe(t.fetches[0].body.client.id)
    expect(ws.url).toContain('platform.kick.com')
    expect(ws.sent[0]).toEqual({ connect: { token: 'guest-token', name: 'js' }, id: 1 })
    expect(ws.sent.slice(1).map((m) => m.subscribe.channel)).toEqual(['chatrooms.111.v2', 'channel_222'])
    expect(t.state().ttl).not.toBeNull() // reconnect before the token expires
  })

  test('{} is answered with {}', async () => {
    const t = makeTap()
    const ws = await up(t)
    ws.recv('{}')
    expect(ws.sent.at(-1)).toEqual({})
  })

  test('leaving the last channel closes the socket and leaves no timer', async () => {
    const t = makeTap()
    const ws = await up(t)
    t.kickTapLeave('chan')
    expect(ws.closed).toBe(true)
    expect(t.timers.size).toBe(0)
  })

  test('the connection token expiring is not a refusal: recycle with fresh discovery', async () => {
    const t = makeTap()
    const ws = await up(t)
    const [{ fn }] = [...t.timers.values()].filter((x) => x.ms === 2700 * 0.9 * 1000)
    fn()
    await flush()
    expect(ws.closed).toBe(true)
    expect(t.sockets).toHaveLength(2)
    expect(t.fetches).toHaveLength(4)
    expect(t._kpNet.refusals).toBe(0)
  })
})

describe('backoff that ends', () => {
  test('5 refused discoveries in a row stop the retrying and leave no timer', async () => {
    const t = makeTap({ discovery: () => null })
    t._kpChatroomCache.set('chan', 111)
    t._kpChannelIdCache.set('chan', 222)
    await t.kickTapJoin('chan')
    for (let i = 0; i < 5; i++) {
      await flush()
      const next = [...t.timers.values()][0]
      if (next) {
        t.timers.clear()
        next.fn()
      }
    }
    await flush()
    expect(t._kpNet.stopped).toBe(true)
    expect(t._kpNet.refusals).toBe(5)
    expect(t._kpNet.lastReason).toBe('realtime endpoint declined')
    expect(t.timers.size).toBe(0)
    expect(t.fetches).toHaveLength(5)
  })

  test('a close before the connect ack counts; the connect ack resets the streak', async () => {
    const t = makeTap()
    t._kpChatroomCache.set('chan', 111)
    t._kpChannelIdCache.set('chan', 222)
    await t.kickTapJoin('chan')
    await flush()
    const ws = t.sockets[0]
    ws.open()
    ws.onclose()
    expect(t._kpNet.streak).toBe(1)
    expect(t._kpNet.lastReason).toBe('closed before connect ack')
    t.timers.clear()
    await t._kpConnect()
    const ws2 = t.sockets[1]
    ws2.open()
    ws2.recv({ id: 1, connect: { ttl: 0 } })
    expect(t._kpNet.streak).toBe(0)
  })

  test('a refused connect carries its code into the close', async () => {
    const t = makeTap()
    t._kpChatroomCache.set('chan', 111)
    t._kpChannelIdCache.set('chan', 222)
    await t.kickTapJoin('chan')
    await flush()
    const ws = t.sockets[0]
    ws.open()
    ws.recv({ id: 1, error: { code: 3501, message: 'bad token' } })
    expect(ws.closed).toBe(true)
    ws.onclose()
    expect(t._kpNet.lastReason).toBe('connect refused (3501)')
  })

  test('a refused subscribe is counted per channel and never reconnects the transport', async () => {
    const t = makeTap()
    const ws = await up(t)
    ws.recv({ id: 2, error: { code: 103 } })
    expect(t._kpNet.subFails.get('chatrooms.111.v2')).toBe(1)
    expect(t._kpNet.streak).toBe(0)
    expect(ws.closed).toBe(false)
    expect(t.timers.size).toBe(1) // only the ttl recycle
  })

  test('a stood-down tap re-arms on the next join and after 30 min on the watchdog', async () => {
    const t = makeTap({ discovery: () => null })
    t._kpNet.stopped = true
    t._kpNet.stoppedAt = Date.now()
    t._kpChannels.set('a', 1)
    t._kpWatchdogCheck()
    expect(t._kpNet.stopped).toBe(true) // too soon
    t._kpNet.stoppedAt = Date.now() - 31 * 60 * 1000
    t._kpWatchdogCheck()
    expect(t._kpNet.stopped).toBe(false)
    expect(t._kpNet.rearms).toBe(1)
    t._kpNet.stopped = true
    t._kpChatroomCache.set('b', 2)
    await t.kickTapJoin('b')
    expect(t._kpNet.rearms).toBe(2)
  })
})

describe('events keep the broadcasts the pusher era produced', () => {
  const E = (n) => `App\\Events\\${n}`
  async function live() {
    const t = makeTap()
    const ws = await up(t)
    t.sent.length = 0
    return { t, ws }
  }
  test('chat', async () => {
    const { t, ws } = await live()
    ws.recv(
      pub(E('ChatMessageEvent'), {
        id: 'm1',
        content: 'hi',
        sender: { id: 5, username: 'u', identity: { color: '#fff', badges: [] } },
        created_at: '2026-11-10T00:00:00+00:00',
      }),
    )
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0]).toMatchObject({
      type: 'kick_chat_message',
      data: { platform: 'kick', channel: 'chan', username: 'u', content: 'hi', id: 'm1' },
    })
  })
  test('delete / ban / unban', async () => {
    const { t, ws } = await live()
    ws.recv(
      pub(E('MessageDeletedEvent'), { message: { id: 'm1' } }),
      pub(E('UserBannedEvent'), { user: { id: 9, username: 'bad' } }),
      pub(E('UserUnbannedEvent'), { user: { username: 'bad' } }),
    )
    expect(t.sent.map((m) => m.action)).toEqual(['delete', 'ban', 'unban'])
    expect(t.sent[0].targetMsgId).toBe('m1')
    expect(t.sent[1]).toMatchObject({ targetUser: 'bad', targetUserId: '9', banDuration: 0 })
  })
  test('pin and unpin', async () => {
    const { t, ws } = await live()
    ws.recv(pub(E('PinnedMessageCreatedEvent'), { message: { content: 'rules', sender: { username: 'mod' } } }))
    ws.recv(pub(E('PinnedMessageDeletedEvent'), {}))
    expect(t.sent).toEqual([
      { type: 'kick_pin_event', channel: 'chan', pinned: true, sender: 'mod', text: 'rules' },
      { type: 'kick_pin_event', channel: 'chan', pinned: false },
    ])
  })
  test('an unpin does NOT delete a chat line', async () => {
    const { t, ws } = await live()
    ws.recv(pub(E('PinnedMessageDeletedEvent'), { message: { id: 'pinned-line' } }))
    expect(t.sent.some((m) => m.type === 'kick_moderation')).toBe(false)
    expect(t.sent).toEqual([{ type: 'kick_pin_event', channel: 'chan', pinned: false }])
  })
  test('poll and host', async () => {
    const { t, ws } = await live()
    ws.recv(pub(E('PollUpdateEvent'), { poll: { title: 'best?', duration: 60 } }))
    ws.recv(pub(E('StreamHostEvent'), { host_username: 'raider', number_viewers: 40 }))
    expect(t.sent.map((m) => m.eventType)).toEqual(['stream:poll-start', 'stream:raid-in'])
  })
  test('KICKs ride the channel-scoped channel', async () => {
    const { t, ws } = await live()
    ws.recv(pub('KicksGifted', { sender: { username: 'g' }, gift: { name: 'Rage', amount: 100 } }, 'channel_222'))
    expect(t.sent[0]).toMatchObject({ type: 'kick_kicks_event', channel: 'chan', amount: 100 })
  })
  test('sub vs gifted subs are exact, and an unknown event is ignored', async () => {
    const { t, ws } = await live()
    ws.recv(pub(E('SubscriptionEvent'), { username: 's', months: 1 }))
    ws.recv(pub(E('GiftedSubscriptionsEvent'), { gifter_username: 'g', gifted_usernames: ['a', 'b'] }))
    ws.recv(pub(E('LuckyUsersWhoGotGiftSubscriptionsEvent'), { x: 1 }))
    ws.recv(pub(E('XMessageDeletedEventX'), { message: { id: 'm' } }))
    expect(t.sent.map((m) => m.type)).toEqual(['kick_sub_event', 'kick_sub_event'])
    expect(t.sent.some((m) => m.type === 'kick_moderation')).toBe(false)
  })
  test('every recorded pub dispatches without throwing', async () => {
    const { ws } = await live()
    for (const f of FIX.frames) expect(() => ws.recv(f.raw)).not.toThrow()
  })
})

describe('no pusher left', () => {
  const read = (p) => readFileSync(join(import.meta.dir, '..', p), 'utf8')
  test('src/ and the manifests carry neither pusher.com, the old app key, nor pusher:* frames', () => {
    const files = new Bun.Glob('src/**/*.{js,json}').scanSync({ cwd: join(import.meta.dir, '..') })
    for (const f of files) {
      const s = read(f)
      expect(s, f).not.toMatch(/pusher\.com/i)
      expect(s, f).not.toContain('32cbd69e4b950bf97679')
      expect(s, f).not.toMatch(/pusher:(subscribe|unsubscribe|ping|pong|connection_established)/)
    }
  })
  test('the csp allows the realtime host and nothing pusher', () => {
    for (const m of ['src/manifests/chrome.json', 'src/manifests/firefox.json']) {
      expect(read(m)).toContain('wss://*.platform.kick.com')
    }
  })
})

describe('page-level tap (kick-chat-intercept.js)', () => {
  function run() {
    const posts = []
    class WS {
      constructor(url) {
        this.url = url
        this.l = {}
        this.out = []
      }
      addEventListener(t, fn) {
        this.l[t] = fn
      }
      send(d) {
        this.out.push(d)
      }
    }
    const win = { WebSocket: WS, postMessage: (p) => posts.push(p) }
    new Function('window', 'location', read('src/content/kick-chat-intercept.js'))(win, { origin: 'https://kick.com' })
    return { win, posts }
  }
  const read = (p) => readFileSync(join(import.meta.dir, '..', p), 'utf8')
  const chat = JSON.stringify({
    push: { channel: 'chatrooms.5.v2', pub: { data: { event: 'App\\Events\\ChatMessageEvent', data: '{"id":"a"}' } } },
  })

  test('forwards the same postMessage shape as the pusher era, from a packed frame', () => {
    const { win, posts } = run()
    const ws = new win.WebSocket('wss://realtime.us-east-1.platform.kick.com/connection/websocket')
    ws.l.message({ data: `{}\n${chat}` })
    expect(posts).toEqual([
      {
        type: 'heatsync-kick-tap',
        event: 'App\\Events\\ChatMessageEvent',
        channel: 'chatrooms.5.v2',
        data: '{"id":"a"}',
      },
    ])
  })
  test('an outgoing subscribe binds the page channel', () => {
    const { win, posts } = run()
    const ws = new win.WebSocket('wss://realtime.us-east-1.platform.kick.com/connection/websocket')
    ws.send('{"subscribe":{"channel":"chatrooms.5.v2"},"id":2}')
    expect(posts).toEqual([{ type: 'heatsync-kick-tap-sub', channel: 'chatrooms.5.v2' }])
  })
  test('other sockets and non-whitelisted events are ignored', () => {
    const { win, posts } = run()
    new win.WebSocket('wss://example.com/x').l.message?.({ data: chat })
    const ws = new win.WebSocket('wss://realtime.x.platform.kick.com/c')
    ws.l.message({ data: chat.replace('ChatMessageEvent', 'PollUpdateEvent') })
    expect(posts).toEqual([])
  })
})

/**
 * BTTV Pro personal emotes.
 *
 * BTTV has no per-user lookup to call: a Pro user's personal set reaches other
 * clients as a `lookup_user` push on sockets.betterttv.net, sent when that user's
 * own client announces itself in a room we have joined (verified live — the REST
 * side only answers /3/cached/users/<provider>/<id> with the CHANNEL set). So the
 * background captures the push per twitch id and merges it into get_sender_emotes
 * next to the 7tv personal sets, the same cross-user pipeline.
 *
 * The REAL capture, socket handler and get_sender_emotes handler run here against
 * a payload shaped like the one the socket sent.
 */

import { describe, expect, test } from 'bun:test'
import { bgSource } from './bg-src.js'

const SRC = bgSource()
function fn(name) {
  const a = SRC.indexOf(`function ${name}(`)
  if (a === -1) throw new Error(`${name} not found in the background parts`)
  return SRC.slice(a, SRC.indexOf('\n}\n', a) + 3)
}
function between(from, to) {
  const a = SRC.indexOf(from)
  const b = SRC.indexOf(to, a)
  if (a === -1 || b === -1) throw new Error(`carve ${from} … ${to} failed`)
  return SRC.slice(a, b)
}

// the get_sender_emotes body: from its first statement to the reply
const SENDER = between('const senderKeys = (message.senderKeys', '    })()\n    return true')

const PROGRAM = [
  fn('bttvOversize'),
  'const bttvPersonalSets = new Map()',
  between('function captureBTTVPersonalSet(', 'function handleBTTVSocketEvent('),
  fn('handleBTTVSocketEvent'),
  `async function getSenderEmotes(message, sendResponse) {\n${SENDER}\n    })()\n}`,
  'return { bttvPersonalSets, captureBTTVPersonalSet, handleBTTVSocketEvent, getSenderEmotes }',
].join('\n')

function world(extra = {}) {
  const scope = {
    API_URL: 'https://heatsync.org',
    log: () => {},
    // each world gets its own globalThis: the handler keeps its sender cache on it
    globalThis: {},
    bttvRoomToKey: () => null,
    seventvPersonalSets: new Map(),
    bttvRoomIds: new Map(),
    channelEmotesMap: {},
    splitChKey: () => ({}),
    fetchWithTimeout: async () => ({ ok: true, json: async () => ({ sets: {}, vers: {} }) }),
    withNsfwParam: (u) => u,
    sanitizeVer: () => '',
    emoteAddedAtMs: () => 0,
    ...extra,
  }
  const proxy = new Proxy(scope, {
    has: (_t, k) => typeof k === 'string',
    get: (t, k) => (k in t ? t[k] : globalThis[k]),
    set: (t, k, v) => {
      t[k] = v
      return true
    },
  })
  const api = new Function('__scope', `with (__scope) {\n${PROGRAM}\n}`)(proxy)
  return { api, scope }
}

/** one get_sender_emotes round trip */
const senders = (api, keys) =>
  new Promise((resolve) => api.getSenderEmotes({ senderKeys: keys }, (r) => resolve(r.emotes)))

// shaped like the push the socket sent (ids and names invented)
const ID_A = '58493695987aab42df852e0f'
const ID_B = '5f1b0186cf6d2144653d2970'
const push = (over = {}) => ({
  name: 'somechatter',
  providerId: '737809677',
  channel: 'twitch:71092938',
  pro: true,
  subscribed: false,
  emotes: [
    {
      id: ID_A,
      code: 'AYAYA',
      imageType: 'png',
      animated: false,
      width: 28,
      height: 27,
      user: { id: '570ea7f8638b259658327cf0', name: 'zigrin', displayName: 'Zigrin', providerId: '21824378' },
      channel: 'zigrin',
      urlTemplate: 'https://cdn.betterttv.net/emote/58493695987aab42df852e0f/{{image}}',
    },
    { id: ID_B, code: 'ZrehplaR', imageType: 'gif', animated: true, width: 56, height: 56 },
  ],
  ...over,
})

describe('capturing the lookup_user push', () => {
  test('a Pro chatter in a twitch room: their set is kept under their twitch id', () => {
    const { api } = world()
    api.handleBTTVSocketEvent('lookup_user', push())
    const set = api.bttvPersonalSets.get('737809677')
    expect(Object.keys(set)).toEqual(['AYAYA', 'ZrehplaR'])
    expect(set.AYAYA).toEqual({
      url: `https://cdn.betterttv.net/emote/${ID_A}/1x.webp`,
      source: 'bttv',
      state: 'global',
      zeroWidth: false,
      hash: ID_A,
      animated: false,
      os: undefined,
    })
    expect(set.ZrehplaR.animated).toBe(true)
    expect(set.ZrehplaR.os).toBe(2) // 56px tall against the 28px baseline, capped at 2x
  })

  test('the channel-emote events are not mistaken for it, and it is not mistaken for them', () => {
    const { api } = world()
    api.handleBTTVSocketEvent('emote_create', { channel: 'twitch:1', emote: { id: ID_A, code: 'X' } })
    expect(api.bttvPersonalSets.size).toBe(0)
  })

  test('only a twitch room announces a twitch user', () => {
    const { api } = world()
    api.handleBTTVSocketEvent('lookup_user', push({ channel: 'youtube:UC123' }))
    api.handleBTTVSocketEvent('lookup_user', push({ channel: undefined }))
    expect(api.bttvPersonalSets.size).toBe(0)
  })

  test('a malformed push is dropped whole, never half-applied', () => {
    const { api } = world()
    for (const bad of [
      null,
      {},
      push({ providerId: 'not-a-number' }),
      push({ providerId: '' }),
      push({ providerId: '12 or 1=1' }),
      push({ emotes: 'AYAYA' }),
      push({ emotes: null }),
    ])
      api.handleBTTVSocketEvent('lookup_user', bad)
    expect(api.bttvPersonalSets.size).toBe(0)
  })

  test('emotes that do not look like bttv emotes are skipped, the rest kept', () => {
    const { api } = world()
    api.handleBTTVSocketEvent(
      'lookup_user',
      push({
        emotes: [
          { id: 'x'.repeat(24), code: 'NotHex' },
          { id: `${ID_A}0`, code: 'TooLong' },
          { id: ID_A, code: '' },
          { id: ID_A, code: 'c'.repeat(101) },
          { id: ID_A, code: { toString: () => 'obj' } },
          null,
          { id: ID_B, code: 'Fine' },
        ],
      }),
    )
    expect(Object.keys(api.bttvPersonalSets.get('737809677'))).toEqual(['Fine'])
  })

  test('one set is at most 100 emotes', () => {
    const { api } = world()
    const emotes = Array.from({ length: 150 }, (_, i) => ({
      id: i.toString(16).padStart(24, '0'),
      code: `e${i}`,
    }))
    api.handleBTTVSocketEvent('lookup_user', push({ emotes }))
    expect(Object.keys(api.bttvPersonalSets.get('737809677')).length).toBe(100)
  })

  test('the map is bounded; the oldest chatter goes first', () => {
    const { api } = world()
    for (let i = 0; i < 2002; i++) api.handleBTTVSocketEvent('lookup_user', push({ providerId: String(1000 + i) }))
    expect(api.bttvPersonalSets.size).toBe(2000)
    expect(api.bttvPersonalSets.has('1000')).toBe(false)
    expect(api.bttvPersonalSets.has('3001')).toBe(true)
  })

  test('announcing again replaces the set; announcing nothing drops it', () => {
    const { api } = world()
    api.handleBTTVSocketEvent('lookup_user', push())
    api.handleBTTVSocketEvent('lookup_user', push({ emotes: [{ id: ID_B, code: 'Only' }] }))
    expect(Object.keys(api.bttvPersonalSets.get('737809677'))).toEqual(['Only'])
    api.handleBTTVSocketEvent('lookup_user', push({ emotes: [] }))
    expect(api.bttvPersonalSets.has('737809677')).toBe(false)
  })
})

describe('what a viewer sees of it (get_sender_emotes)', () => {
  test("a chatter's BTTV personal emotes come back with the rest of their set", async () => {
    const { api } = world()
    api.handleBTTVSocketEvent('lookup_user', push())
    const out = await senders(api, ['twitch:737809677', 'twitch:42'])
    expect(Object.keys(out['twitch:737809677'])).toEqual(['AYAYA', 'ZrehplaR'])
    expect(out['twitch:737809677'].AYAYA.source).toBe('bttv')
    expect(out['twitch:42']).toEqual({}) // nobody else is touched
  })

  test('the 7tv personal set still merges, and wins a same-name clash', async () => {
    const stv = { url: 'https://cdn.7tv.app/emote/x/1x.avif', source: '7tv', state: 'global', hash: 'x' }
    const { api } = world({ seventvPersonalSets: new Map([['737809677', { AYAYA: stv, Other: stv }]]) })
    api.handleBTTVSocketEvent('lookup_user', push())
    const out = (await senders(api, ['twitch:737809677']))['twitch:737809677']
    expect(out.AYAYA).toEqual(stv)
    expect(Object.keys(out).sort()).toEqual(['AYAYA', 'Other', 'ZrehplaR'])
  })

  test('the heatsync set wins a same-name clash too', async () => {
    const batch = {
      'twitch:737809677': [{ name: 'AYAYA', url: 'https://cdn.heatsync.org/uploads/mine.webp', hash: 'mine' }],
    }
    const { api } = world({
      fetchWithTimeout: async () => ({ ok: true, json: async () => ({ sets: batch, vers: {} }) }),
    })
    api.handleBTTVSocketEvent('lookup_user', push())
    const out = (await senders(api, ['twitch:737809677']))['twitch:737809677']
    expect(out.AYAYA.url).toBe('https://cdn.heatsync.org/uploads/mine.webp')
    expect(out.ZrehplaR.source).toBe('bttv')
  })

  test('a push lands on the next message, not minutes later (the sender cache is busted)', async () => {
    const { api } = world()
    expect(await senders(api, ['twitch:737809677'])).toEqual({ 'twitch:737809677': {} }) // cached as a miss
    api.handleBTTVSocketEvent('lookup_user', push())
    const out = (await senders(api, ['twitch:737809677']))['twitch:737809677']
    expect(Object.keys(out)).toEqual(['AYAYA', 'ZrehplaR'])
    api.handleBTTVSocketEvent('lookup_user', push({ emotes: [] }))
    expect((await senders(api, ['twitch:737809677']))['twitch:737809677']).toEqual({})
  })

  test('kick and youtube senders never read a twitch id', async () => {
    const { api } = world()
    api.handleBTTVSocketEvent('lookup_user', push({ providerId: '777' }))
    const out = await senders(api, ['kick:777', 'yt:777'])
    expect(out['kick:777']).toEqual({})
    expect(out['yt:777']).toEqual({})
  })
})

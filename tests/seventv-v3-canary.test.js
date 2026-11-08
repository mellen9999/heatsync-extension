/**
 * The 7tv v3 canary.
 *
 * We ride 7tv's v3 REST and EventAPI and have chosen not to migrate. What a
 * retiring API sends first is a Sunset/Deprecation header, a 410, or an answer
 * the parsers cannot read; each is recorded ONCE (per 6h) in the error ring the
 * popup exports (the one src/lib/diag.js feeds), under a stable code:
 *
 *   stv-canary:sunset | stv-canary:gone | stv-canary:schema
 *
 * and nothing else changes: the caller still gets the same response, the
 * parsers still fail the soft way they always did.
 *
 * The REAL fetchWithTimeout, parsers and poll are carved out of the background
 * parts and run against fixtures and a fake network.
 */

import { describe, expect, test } from 'bun:test'
import { bgSource } from './bg-src.js'

const SRC = bgSource()
function fn(name) {
  for (const marker of [`async function ${name}(`, `function ${name}(`]) {
    const a = SRC.indexOf(marker)
    if (a === -1) continue
    return SRC.slice(a, SRC.indexOf('\n}\n', a) + 3)
  }
  throw new Error(`${name} not found in the background parts`)
}
function between(from, to) {
  const a = SRC.indexOf(from)
  const b = SRC.indexOf(to, a)
  if (a === -1 || b === -1) throw new Error(`carve ${from} … ${to} failed`)
  return SRC.slice(a, b)
}

const CANARY = between('const STV_CANARY_KEY', 'async function fetchWithTimeout(')
const NET = between('let sevenTVApiBlocked = false', '// ── kick.com token bucket')
const PARSE = [
  CANARY,
  between('const EMOTE_CDN_PATTERN', '// Fetch BTTV channel emotes'),
  fn('resolve7TVEmoteSet'),
  fn('fetch7TVChannelEmotes'),
  fn('extract7TVCosmeticIds'),
  "const GLOBAL_7TV_CACHE_KEY = 'hs_7tv_global_cache'",
  fn('fetch7TVEmotes'),
  fn('splitChKey'),
  fn('poll7TVEmoteSet'),
].join('\n')

/** Run `program` with every free name resolved in `scope`, then globalThis. */
function run(program, scope, exportsList) {
  const proxy = new Proxy(scope, {
    has: (_t, k) => typeof k === 'string',
    get: (t, k) => (k in t ? t[k] : globalThis[k]),
    set: (t, k, v) => {
      t[k] = v
      return true
    },
  })
  return new Function('__scope', `with (__scope) {\n${program}\nreturn { ${exportsList} }\n}`)(proxy)
}

/** A chrome.storage.local that outlives a "service worker" so a restart can be simulated. */
function storage() {
  const data = {}
  return {
    data,
    local: {
      get: async (k) => ({ [k]: data[k] }),
      set: async (o) => {
        Object.assign(data, o)
      },
    },
  }
}

function recorder() {
  const records = []
  return { records, reporter: { ver: 'test', capture: (r) => records.push(r) } }
}

const mk = (store = storage(), rec = recorder()) => ({ store, rec, clock: { t: 1_800_000_000_000 } })
const base = ({ store, rec, clock }, more = {}) => ({
  browser: { storage: store },
  globalThis: { __hsErrorReporterSw: rec.reporter },
  Date: { now: () => clock.t },
  log: () => {},
  ...more,
})
/** [code, kind] of a record: msg reads `<code> <kind>: <why>` */
const codeAndKind = (r) => [r.stack, /^stv-canary:\w+ (\w+):/.exec(r.msg)?.[1]]
const settle = () => new Promise((r) => setTimeout(r, 0))

// ── the network: headers and status ──────────────────────────────────────────

function net(w, answer) {
  const scope = base(w, {
    heatsyncBackoffUntil: 0,
    heatsyncInflightAborts: new Set(),
    _heatsyncBackoffWarnAt: 0,
    fakeBackoffResponse: () => new Response(null, { status: 429 }),
    fetch: async (url) => answer(url),
  })
  return run(NET, scope, 'fetchWithTimeout')
}
const json = (body, init = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })

describe('headers and status', () => {
  test('a Sunset header is recorded under stv-canary:sunset, and the response is untouched', async () => {
    const w = mk()
    const { fetchWithTimeout } = net(w, () =>
      json({ ok: 1 }, { headers: { 'content-type': 'application/json', Sunset: 'Sat, 01 Jan 2028 00:00:00 GMT' } }),
    )
    const r = await fetchWithTimeout('https://7tv.io/v3/users/twitch/123456789')
    await settle()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: 1 })
    expect(w.rec.records.length).toBe(1)
    const rec = w.rec.records[0]
    expect(rec.stack).toBe('stv-canary:sunset')
    expect(rec.type).toBe('diag')
    expect(rec.msg).toContain('user')
    expect(rec.msg).toContain('Sat, 01 Jan 2028')
  })

  test('a Deprecation header counts, Deprecation: false does not', async () => {
    const w = mk()
    const { fetchWithTimeout } = net(w, (url) =>
      json({}, { headers: { 'content-type': 'application/json', Deprecation: url.endsWith('/a') ? 'true' : 'false' } }),
    )
    await fetchWithTimeout('https://7tv.io/v3/emote-sets/b')
    await settle()
    expect(w.rec.records.length).toBe(0)
    await fetchWithTimeout('https://7tv.io/v3/emote-sets/a')
    await settle()
    expect(w.rec.records.map((r) => r.stack)).toEqual(['stv-canary:sunset'])
  })

  test('a 410 is recorded under stv-canary:gone and handed back as the 410 it is', async () => {
    const w = mk()
    const { fetchWithTimeout } = net(w, () => new Response('gone', { status: 410 }))
    const r = await fetchWithTimeout('https://7tv.io/v3/emote-sets/global')
    await settle()
    expect(r.status).toBe(410)
    expect(w.rec.records.map((x) => x.stack)).toEqual(['stv-canary:gone'])
    expect(w.rec.records[0].msg).toContain('global')
  })

  test('a 200 that is not json is recorded under stv-canary:schema', async () => {
    const w = mk()
    const { fetchWithTimeout } = net(
      w,
      () =>
        new Response('<html>moved</html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    )
    await fetchWithTimeout('https://7tv.io/v3/users/twitch/1')
    await settle()
    expect(w.rec.records.map((x) => x.stack)).toEqual(['stv-canary:schema'])
  })

  test('the first-party proxy of 7tv is watched the same way', async () => {
    const w = mk()
    const { fetchWithTimeout } = net(w, () => new Response('gone', { status: 410 }))
    await fetchWithTimeout('https://heatsync.org/api/7tv/v3/users/twitch/1', { noBackoff: true })
    await settle()
    expect(w.rec.records.map((x) => x.stack)).toEqual(['stv-canary:gone'])
  })

  test('the direct 7tv GET path (with its proxy fallback) records the direct answer once', async () => {
    const w = mk()
    const { fetchWithTimeout } = net(w, () => new Response('gone', { status: 410 }))
    const r = await fetchWithTimeout('https://7tv.io/v3/users/twitch/1')
    await settle()
    expect(r.status).toBe(410)
    expect(w.rec.records.length).toBe(1)
  })

  test('everything that is not 7tv v3 is left alone', async () => {
    const w = mk()
    const { fetchWithTimeout } = net(
      w,
      () => new Response('gone', { status: 410, headers: { Sunset: 'soon', 'content-type': 'text/html' } }),
    )
    for (const u of [
      'https://api.betterttv.net/3/cached/emotes/global',
      'https://heatsync.org/api/emotes',
      'https://7tv.io/v2/users/1',
      'https://events.7tv.io/v3',
    ])
      await fetchWithTimeout(u)
    await settle()
    expect(w.rec.records).toEqual([])
  })

  test('a healthy v3 answer says nothing', async () => {
    const w = mk()
    const { fetchWithTimeout } = net(w, () => json({ id: 'x', emotes: [] }))
    await fetchWithTimeout('https://7tv.io/v3/emote-sets/x')
    await fetchWithTimeout('https://7tv.io/v3/gql', { method: 'POST', body: '{}' })
    await settle()
    expect(w.rec.records).toEqual([])
  })

  test('a report never carries the channel id or name from the url', async () => {
    const w = mk()
    const { fetchWithTimeout } = net(w, () => new Response('gone', { status: 410 }))
    await fetchWithTimeout('https://7tv.io/v3/users/twitch/987654321')
    await fetchWithTimeout('https://7tv.io/v3/users/somestreamer')
    await settle()
    const text = JSON.stringify(w.rec.records)
    expect(text).not.toContain('987654321')
    expect(text).not.toContain('somestreamer')
  })
})

describe('once, not on every request', () => {
  test('the same code and kind records once however many calls see it', async () => {
    const w = mk()
    const { fetchWithTimeout } = net(w, () => new Response('gone', { status: 410 }))
    for (let i = 0; i < 6; i++) await fetchWithTimeout(`https://7tv.io/v3/users/twitch/${i}`)
    await settle()
    expect(w.rec.records.length).toBe(1)
  })

  test('concurrent first sightings still record once', async () => {
    const w = mk()
    const { fetchWithTimeout } = net(w, () => new Response('gone', { status: 410 }))
    await Promise.all([1, 2, 3, 4].map((i) => fetchWithTimeout(`https://7tv.io/v3/users/twitch/${i}`)))
    await settle()
    expect(w.rec.records.length).toBe(1)
  })

  test('a different kind of call is a different signal', async () => {
    const w = mk()
    const { fetchWithTimeout } = net(w, () => new Response('gone', { status: 410 }))
    await fetchWithTimeout('https://7tv.io/v3/users/twitch/1')
    await fetchWithTimeout('https://7tv.io/v3/emote-sets/global')
    await fetchWithTimeout('https://7tv.io/v3/emote-sets/abc')
    await settle()
    expect(w.rec.records.length).toBe(3)
  })

  test('a service-worker restart does not repeat it', async () => {
    const w1 = mk()
    await net(w1, () => new Response('gone', { status: 410 })).fetchWithTimeout('https://7tv.io/v3/users/twitch/1')
    await settle()
    expect(w1.rec.records.length).toBe(1)
    const w2 = mk(w1.store)
    await net(w2, () => new Response('gone', { status: 410 })).fetchWithTimeout('https://7tv.io/v3/users/twitch/1')
    await settle()
    expect(w2.rec.records.length).toBe(0)
  })

  test('after six hours it is said again', async () => {
    const w = mk()
    const { fetchWithTimeout } = net(w, () => new Response('gone', { status: 410 }))
    await fetchWithTimeout('https://7tv.io/v3/users/twitch/1')
    await settle()
    w.clock.t += 6 * 60 * 60 * 1000 + 1
    await fetchWithTimeout('https://7tv.io/v3/users/twitch/1')
    await settle()
    expect(w.rec.records.length).toBe(2)
  })
})

describe('recording can never break a request', () => {
  test('a reporter that throws, or storage that fails, changes nothing for the caller', async () => {
    const w = mk()
    w.rec.reporter.capture = () => {
      throw new Error('ring is full')
    }
    w.store.local.get = async () => {
      throw new Error('storage gone')
    }
    w.store.local.set = async () => {
      throw new Error('storage gone')
    }
    const { fetchWithTimeout } = net(w, () => new Response('gone', { status: 410 }))
    const r = await fetchWithTimeout('https://7tv.io/v3/users/twitch/1')
    await settle()
    expect(r.status).toBe(410)
  })
})

// ── the parsers: shapes ──────────────────────────────────────────────────────

const world = (w, more = {}) =>
  run(
    PARSE,
    base(w, {
      DEBUG: false,
      broadcastToTabs: () => {},
      channelOwnerKickId: new Map(),
      ytChannelIdCache: new Map(),
      lookupTwitchUserId: async () => '1',
      resolve7TVCosmeticIds: async () => null,
      setUserCosmetic: () => {},
      subscribe7TVEmoteSet: () => {},
      isSeventvEventApiHealthy: () => true,
      seventvSubscribedSets: new Set(),
      seventvEmoteSetIds: new Map(),
      seventvPolledChannels: new Set(),
      channelEmotesMap: {},
      channelEmotesFetchedAt: {},
      getStorableChannelEmotes: () => ({}),
      seventvUnhealthySince: 0,
      SEVENTV_UNHEALTHY_GRACE_MS: 60000,
      ...more,
    }),
    'stvShapeProblem, stvEnvelopeProblem, fetch7TVChannelEmotes, fetch7TVEmotes, poll7TVEmoteSet',
  )

const SET = {
  id: 'SETID00000000000000000000',
  name: 'main',
  emotes: [
    { id: 'EMOTE0000000000000000AAAA', name: 'Kappa', flags: 0, data: { animated: false, flags: 0 } },
    { id: 'EMOTE0000000000000000BBBB', name: 'Dance', flags: 0, data: { animated: true, flags: 0 } },
  ],
}
// /v3/users/twitch/<id>
const USER = {
  id: 'U',
  platform: 'TWITCH',
  username: 'someone',
  emote_set_id: SET.id,
  emote_set: SET,
  user: { id: 'U' },
}

describe('stvShapeProblem', () => {
  const { stvShapeProblem } = world(mk())

  test('the real v3 shapes are readable', () => {
    expect(stvShapeProblem('user', USER)).toBe('')
    expect(stvShapeProblem('user', { ...USER, emote_set: null })).toBe('') // emote_set_id carries it
    expect(stvShapeProblem('user', { id: 'U', username: 'x', emote_sets: [], connections: [] })).toBe('') // /users/<id>
    expect(stvShapeProblem('set', SET)).toBe('')
    expect(stvShapeProblem('set', { ...SET, emotes: null })).toBe('') // an empty set
    expect(stvShapeProblem('set', { ...SET, emotes: [] })).toBe('')
  })

  test('a field 7tv adds is not a problem', () => {
    expect(stvShapeProblem('user', { ...USER, brand_new: { a: 1 } })).toBe('')
    expect(stvShapeProblem('set', { ...SET, tags: ['x'], capacity: 600 })).toBe('')
  })

  test('a payload that stopped being what the parsers read is', () => {
    for (const bad of [
      null,
      undefined,
      [],
      'x',
      5,
      {},
      { error: 'gone' },
      { data: { user: USER } },
      { emote_set: 'x' },
    ])
      expect(stvShapeProblem('user', bad)).not.toBe('')
    for (const bad of [
      null,
      [],
      { emotes: {} },
      { emotes: 'x' },
      { emotes: [{ name: 'NoId' }] },
      { emotes: [{ id: 'x' }] },
      { emotes: [{ id: 5, name: 'NumericId' }] },
      { emotes: [null] },
    ])
      expect(stvShapeProblem('set', bad)).not.toBe('')
  })
})

describe('stvEnvelopeProblem (EventAPI frames)', () => {
  const { stvEnvelopeProblem } = world(mk())

  test('hello, dispatch, heartbeat and ack as v3 sends them are fine', () => {
    expect(stvEnvelopeProblem({ op: 1, d: { session_id: 'abc', subscription_limit: 500 } })).toBe('')
    expect(stvEnvelopeProblem({ op: 0, d: { type: 'emote_set.update', body: {} } })).toBe('')
    expect(stvEnvelopeProblem({ op: 2, d: { count: 1 } })).toBe('')
    expect(stvEnvelopeProblem({ op: 5, d: { command: 'SUBSCRIBE', data: {} } })).toBe('')
  })

  test('a frame the handlers cannot read is a problem', () => {
    for (const bad of [null, {}, { op: '1' }, { op: 1, d: {} }, { op: 1 }, { op: 0, d: {} }, { op: 0, d: { type: 5 } }])
      expect(stvEnvelopeProblem(bad)).not.toBe('')
  })
})

describe('channel emote loading with a good and a broken v3', () => {
  const answer = (status, body, bodyFails) => ({
    ok: status >= 200 && status < 300,
    status,
    body: { cancel() {} },
    json: async () => {
      if (bodyFails) throw new SyntaxError('Unexpected token < in JSON at position 0')
      return body
    },
  })

  test('good: the emotes load and nothing is recorded', async () => {
    const w = mk()
    const { fetch7TVChannelEmotes } = world(w, { fetchWithTimeout: async () => answer(200, USER) })
    const out = await fetch7TVChannelEmotes('someone', '1', 'twitch')
    await settle()
    expect(out.emotes.map((e) => e.name)).toEqual(['Kappa', 'Dance'])
    expect(w.rec.records).toEqual([])
  })

  test('a user payload in a shape nobody reads: the same soft empty as before, and a record', async () => {
    const w = mk()
    const { fetch7TVChannelEmotes } = world(w, {
      fetchWithTimeout: async () => answer(200, { data: { user: USER } }),
    })
    const out = await fetch7TVChannelEmotes('someone', '1', 'twitch')
    await settle()
    expect(out).toEqual([])
    expect(w.rec.records.map(codeAndKind)).toEqual([['stv-canary:schema', 'user']])
  })

  test('a set whose emotes lost their ids: loads what it can (nothing), and a record', async () => {
    const w = mk()
    const broken = { ...USER, emote_set: { ...SET, emotes: [{ name: 'NoId' }] } }
    const { fetch7TVChannelEmotes } = world(w, { fetchWithTimeout: async () => answer(200, broken) })
    const out = await fetch7TVChannelEmotes('someone', '1', 'twitch')
    await settle()
    expect(Array.isArray(out.emotes)).toBe(true)
    expect(w.rec.records.map((r) => r.stack)).toEqual(['stv-canary:schema'])
  })

  test('a body that is not json: null (transient) exactly as before, and a record', async () => {
    const w = mk()
    const { fetch7TVChannelEmotes } = world(w, { fetchWithTimeout: async () => answer(200, null, true) })
    const out = await fetch7TVChannelEmotes('someone', '1', 'twitch')
    await settle()
    expect(out).toBeNull()
    expect(w.rec.records.map((r) => r.stack)).toEqual(['stv-canary:schema'])
    expect(w.rec.records[0].msg).toContain('not json')
  })

  test('a plain network failure is not the canary — that is just a bad day', async () => {
    const w = mk()
    const { fetch7TVChannelEmotes } = world(w, {
      fetchWithTimeout: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    expect(await fetch7TVChannelEmotes('someone', '1', 'twitch')).toBeNull()
    await settle()
    expect(w.rec.records).toEqual([])
  })

  test('the global set: broken shape recorded, result still the soft empty list', async () => {
    const w = mk()
    const { fetch7TVEmotes } = world(w, {
      fetchWithEtag: async () => ({ ok: true, status: 200, json: async () => ({ emotes: [{ nope: 1 }] }) }),
    })
    const out = await fetch7TVEmotes()
    await settle()
    expect(out).toEqual([])
    expect(w.rec.records.map(codeAndKind)).toEqual([['stv-canary:schema', 'global']])
  })
})

describe('the poll never reads an unreadable answer as "every emote was removed"', () => {
  const existing = [
    { name: 'Kappa', hash: 'EMOTE0000000000000000AAAA', source: '7tv' },
    { name: 'Dance', hash: 'EMOTE0000000000000000BBBB', source: '7tv' },
  ]
  const pollWith = async (userAnswer) => {
    const w = mk()
    const broadcasts = []
    const channelEmotesMap = { 'twitch/someone': [...existing] }
    const { poll7TVEmoteSet } = world(w, {
      seventvEmoteSetIds: new Map([['twitch/someone', SET.id]]),
      channelEmotesMap,
      broadcastToTabs: (m) => broadcasts.push(m),
      seventvPolledChannels: new Set(['twitch/someone']),
      fetchWithTimeout: async () => ({ ok: true, status: 200, body: { cancel() {} }, json: async () => userAnswer }),
    })
    await poll7TVEmoteSet()
    await settle()
    return { w, broadcasts, channelEmotesMap }
  }

  test('control: a readable set that really dropped an emote is applied', async () => {
    const { broadcasts, channelEmotesMap, w } = await pollWith({
      ...USER,
      emote_set: { ...SET, emotes: [SET.emotes[0]] },
    })
    expect(channelEmotesMap['twitch/someone'].map((e) => e.name)).toEqual(['Kappa'])
    expect(broadcasts.some((b) => b.type === 'channel_emote_removed' && b.emoteName === 'Dance')).toBe(true)
    expect(w.rec.records).toEqual([])
  })

  test('emotes that lost their ids: nothing is removed, and it is recorded', async () => {
    const { broadcasts, channelEmotesMap, w } = await pollWith({
      ...USER,
      emote_set: { ...SET, emotes: [{ name: 'Kappa' }, { name: 'Dance' }] },
    })
    expect(channelEmotesMap['twitch/someone'].map((e) => e.name)).toEqual(['Kappa', 'Dance'])
    expect(broadcasts.filter((b) => b.type === 'channel_emote_removed')).toEqual([])
    expect(w.rec.records.map((r) => r.stack)).toEqual(['stv-canary:schema'])
  })

  test('a user answer in a new shape: nothing is removed, and it is recorded', async () => {
    const { broadcasts, channelEmotesMap, w } = await pollWith({ data: { user: USER } })
    expect(channelEmotesMap['twitch/someone'].length).toBe(2)
    expect(broadcasts.filter((b) => b.type === 'channel_emote_removed')).toEqual([])
    expect(w.rec.records.map((r) => r.stack)).toEqual(['stv-canary:schema'])
  })
})

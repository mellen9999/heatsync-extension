/**
 * The channel-owner emote lookup, on the wire.
 *
 *   GET /api/emotes/user/<channel>?platform=twitch|kick|youtube
 *
 * A bare name cannot say whose channel it is — the same login is three people
 * across platforms — so every call names the platform. The response may carry,
 * per emote, `variants` (smaller copies, list or object) and `width`/`height`;
 * they are kept when they are well-formed and dropped when not, and a response
 * without them yields exactly the record this always produced.
 *
 * The REAL fetchChannelOwnerEmotes (and the helpers it calls) is carved out of
 * the background parts and run against a fake network.
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

const PROGRAM = [
  fn('canonPlatform'),
  fn('chKey'),
  fn('absUrl'),
  between('const EMOTE_CDN_PATTERN', 'const MAX_EMOTE_NAME_LEN'),
  fn('withNsfwParam'),
  fn('channelOwnerEmotesUrl'),
  fn('mapChannelOwnerEmote'),
  fn('fetchChannelOwnerEmotes'),
  'return { fetchChannelOwnerEmotes, mapChannelOwnerEmote, channelOwnerEmotesUrl }',
].join('\n')

/** One world: a fake network that answers the owner route with `payload`. */
function world(payload, { status = 200 } = {}) {
  const requests = []
  const broadcasts = []
  const channelEmotesMap = {}
  const scope = {
    API_URL: 'https://heatsync.org',
    viewerShowSexual: false,
    viewerShowGore: false,
    viewerShowWeapon: true,
    viewerShowDrug: true,
    viewerShowHate: true,
    channelEmotesMap,
    channelEmotesFetchedAt: {},
    CHANNEL_EMOTES_TTL: 30 * 60 * 1000,
    CHANNEL_EMOTES_EMPTY_TTL: 5 * 60 * 1000,
    tabChannels: new Map(),
    seventvEmoteSetIds: new Map(),
    seventvPolledChannels: new Set(),
    bttvRoomIds: new Map(),
    DEBUG: false,
    browser: { storage: { local: { set: async () => {} } }, alarms: { create() {} } },
    log: () => {},
    bgT: (k) => k,
    broadcastToTabs: (m) => broadcasts.push(m),
    fetchWithTimeout: async (url) => {
      requests.push(url)
      if (!url.includes('/api/emotes/user/')) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: status === 200, status, json: async () => payload, body: { cancel() {} } }
    },
    lookupTwitchUserId: async () => '123',
    resolveYtChannelId: async () => 'UC0123456789012345678901',
    fetchBTTVChannelEmotes: async () => [],
    fetchFFZChannelEmotes: async () => [],
    fetchTwitchChannelEmotes: async () => [],
    fetchKickChannelEmotes: async () => [],
    fetch7TVChannelEmotes: async () => ({ emotes: [], setId: null }),
    rankEmotePool: (list) => [...list],
    stampThirdPartyFlags: async () => {},
    getStorableChannelEmotes: () => ({}),
    scheduleEmoteRefetch: () => {},
    saveTabChannels: () => {},
    release7TVEmoteSet: () => {},
    partBTTVRoom: () => {},
    subscribe7TVEmoteSet: () => {},
    start7TVPolling: () => {},
    startThirdPartyPolling: () => {},
  }
  // every free name the carved code reads resolves in `scope`, then globalThis
  const proxy = new Proxy(scope, {
    has: (_t, k) => typeof k === 'string',
    get: (t, k) => (k in t ? t[k] : globalThis[k]),
  })
  const api = new Function('__scope', `with (__scope) {\n${PROGRAM}\n}`)(proxy)
  return { api, requests, broadcasts, channelEmotesMap }
}

const ownerCalls = (requests) => requests.filter((u) => u.includes('/api/emotes/user/'))

describe('every owner lookup names its platform', () => {
  for (const [platform, want] of [
    ['twitch', 'twitch'],
    ['kick', 'kick'],
    ['youtube', 'youtube'],
    ['yt', 'youtube'],
  ]) {
    test(`${platform} → ?platform=${want}`, async () => {
      const w = world({ emotes: [] })
      await w.api.fetchChannelOwnerEmotes('somechan', null, platform)
      const calls = ownerCalls(w.requests)
      expect(calls.length).toBe(1)
      const u = new URL(calls[0])
      expect(u.pathname).toBe('/api/emotes/user/somechan')
      expect(u.searchParams.get('platform')).toBe(want)
      // the viewer's content filters still ride along
      expect(u.searchParams.get('include_sexual')).toBe('false')
    })
  }

  test('the channel name is encoded; a platform we have no word for sends no param', () => {
    const w = world({ emotes: [] })
    expect(w.api.channelOwnerEmotesUrl('a b/c', 'kick')).toContain('/api/emotes/user/a%20b%2Fc?platform=kick&')
    const bare = w.api.channelOwnerEmotesUrl('x', 'mixer')
    expect(bare).not.toContain('platform=')
    expect(bare).toContain('/api/emotes/user/x?include_sexual=')
  })
})

describe('what a channel owner emote keeps', () => {
  const run = async (emotes) => {
    const w = world({ emotes })
    await w.api.fetchChannelOwnerEmotes('somechan', null, 'twitch')
    return w.channelEmotesMap['twitch/somechan']
  }

  test('the old payload yields exactly the old record', async () => {
    const out = await run([{ name: 'Wave', url: '/uploads/abc.webp', hash: 'abc', provider: 'upload', slot: 3 }])
    expect(out).toEqual([
      { name: 'Wave', url: 'https://heatsync.org/uploads/abc.webp', hash: 'abc', provider: 'upload' },
    ])
    expect('variants' in out[0]).toBe(false)
    expect('width' in out[0]).toBe(false)
  })

  test('variants (object) and width/height are kept when present', async () => {
    const variants = {
      '1x': 'https://cdn.heatsync.org/uploads/abc-1x.webp',
      '2x': 'https://cdn.heatsync.org/uploads/abc-2x.webp',
      '3x': 'https://cdn.heatsync.org/uploads/abc-3x.webp',
    }
    const [e] = await run([
      { name: 'Wide', url: 'https://cdn.heatsync.org/uploads/abc.webp', hash: 'abc', variants, width: 256, height: 64 },
    ])
    expect(e.variants).toEqual(variants)
    expect(e.width).toBe(256)
    expect(e.height).toBe(64)
  })

  test('variants (list) is kept, junk entries filtered', async () => {
    const [e] = await run([{ name: 'A', url: '/uploads/a.webp', variants: ['1x', 'x', 7, '2x', '9x', '4x'] }])
    expect(e.variants).toEqual(['1x', '2x', '4x'])
  })

  test('a relative rung url resolves against the site like the main url does', async () => {
    const [e] = await run([{ name: 'A', url: '/uploads/a.webp', variants: { '1x': '/uploads/a-1x.webp' } }])
    expect(e.variants).toEqual({ '1x': 'https://heatsync.org/uploads/a-1x.webp' })
  })

  test('a rung url off the emote allowlist is dropped, the rest stays', async () => {
    const [e] = await run([
      {
        name: 'A',
        url: '/uploads/a.webp',
        variants: { '1x': 'https://evil.example/a-1x.webp', '2x': 'https://cdn.heatsync.org/uploads/a-2x.webp' },
      },
    ])
    expect(e.variants).toEqual({ '2x': 'https://cdn.heatsync.org/uploads/a-2x.webp' })
  })

  test('nothing usable in variants → no variants key at all', async () => {
    for (const variants of [{}, [], 'x', 5, { '1x': 3 }, { '5x': 'https://cdn.heatsync.org/uploads/a-1x.webp' }]) {
      const [e] = await run([{ name: 'A', url: '/uploads/a.webp', variants }])
      expect('variants' in e).toBe(false)
    }
  })

  test('size is all-or-nothing and bounded', async () => {
    const sized = await run([
      { name: 'Ok', url: '/uploads/a.webp', width: 128, height: 32 },
      { name: 'OneSided', url: '/uploads/b.webp', width: 128 },
      { name: 'Zero', url: '/uploads/c.webp', width: 0, height: 32 },
      { name: 'Float', url: '/uploads/d.webp', width: 12.5, height: 32 },
      { name: 'Huge', url: '/uploads/e.webp', width: 99999, height: 32 },
      { name: 'Text', url: '/uploads/f.webp', width: 'wide', height: 'tall' },
    ])
    const byName = Object.fromEntries(sized.map((e) => [e.name, e]))
    expect([byName.Ok.width, byName.Ok.height]).toEqual([128, 32])
    for (const n of ['OneSided', 'Zero', 'Float', 'Huge', 'Text']) {
      expect('width' in byName[n]).toBe(false)
      expect('height' in byName[n]).toBe(false)
    }
  })

  test('the broadcast to the tabs carries them too', async () => {
    const w = world({ emotes: [{ name: 'Wide', url: '/uploads/a.webp', width: 256, height: 64 }] })
    await w.api.fetchChannelOwnerEmotes('somechan', null, 'twitch')
    const last = w.broadcasts.filter((m) => m.type === 'channel_emotes_update').pop()
    expect(last.emotes[0].width).toBe(256)
  })
})

describe('a failing lookup still fails soft', () => {
  test('429 → no owner emotes, no throw, the rest of the fetch carries on', async () => {
    const w = world({}, { status: 429 })
    await w.api.fetchChannelOwnerEmotes('somechan', null, 'twitch')
    expect(w.channelEmotesMap['twitch/somechan']).toEqual([])
  })
})

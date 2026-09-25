/**
 * POST /api/card — the one card fetch shared by peek and panel/full,
 * replacing the old pair (GET /api/profile, then GET /api/twitch/followage,
 * with no corpus/recent/note at all). Ported from the site's own
 * `_fetchCardPayload` (client/events/hover-previews.js).
 *
 * This pins:
 *  - fetchCardPayload's 60s LRU + in-flight dedupe (tooltips.js)
 *  - resolveFollowageRows' degraded-only gql fallback (tooltips.js +
 *    twitch-api.js's gqlFollowageDirect)
 *  - pcMergeRecent's server+local dedupe (profile-card.js)
 *
 * All three are extracted as source text and evaluated for real (house
 * pattern — these files have top-level side effects and cannot be
 * imported, see card-tooltip.test.js/card-panel.test.js).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const TIPS = readFileSync(join(ROOT, 'src', 'multichat', 'tooltips.js'), 'utf8')
const CARD = readFileSync(join(ROOT, 'src', 'multichat', 'profile-card.js'), 'utf8')

function slice(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker)
  if (start === -1) throw new Error(`marker not found: ${startMarker}`)
  const end = src.indexOf(endMarker, start)
  if (end === -1) throw new Error(`end marker not found: ${endMarker}`)
  return src.slice(start, end)
}

describe('fetchCardPayload — one POST /api/card, 60s LRU + in-flight dedupe', () => {
  const src = slice(TIPS, 'const _cardCache = new Map()', '\n\n// The shared card model')

  function makeFetch() {
    const calls = []
    let resolvers = []
    const apiFetch = (path, opts) => {
      calls.push({ path, opts })
      return new Promise((resolve) => resolvers.push(resolve))
    }
    return {
      calls,
      apiFetch,
      resolveNext: (data) => resolvers.shift()?.({ ok: true, data }),
    }
  }

  function makeFn(apiFetch, config = { channels: [] }) {
    return new Function('apiFetch', 'config', `${src}\nreturn fetchCardPayload`)(apiFetch, config)
  }

  test('fires exactly one request for a fresh identity, with the right body shape', async () => {
    const { calls, apiFetch, resolveNext } = makeFetch()
    const fetchCardPayload = makeFn(apiFetch, { channels: [{ id: 'x', twitch: 'forsen' }] })
    const p = fetchCardPayload('twitch', 'someone', 'forsen')
    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe('/api/card')
    expect(calls[0].opts).toEqual({
      method: 'POST',
      body: { platform: 'twitch', login: 'someone', channel: 'forsen', openChannels: ['twitch:forsen'] },
    })
    resolveNext({ profile: { id: 1 }, followage: null, corpus: null, note: null, recent: null })
    const payload = await p
    expect(payload.profile).toEqual({ id: 1 })
  })

  test('a second call for the SAME identity while the first is in flight joins it — one request, not two', async () => {
    const { calls, apiFetch, resolveNext } = makeFetch()
    const fetchCardPayload = makeFn(apiFetch)
    const a = fetchCardPayload('twitch', 'someone', null)
    const b = fetchCardPayload('twitch', 'someone', null)
    expect(calls).toHaveLength(1)
    resolveNext({ profile: { id: 1 }, followage: null, corpus: null, note: null, recent: null })
    const [pa, pb] = await Promise.all([a, b])
    expect(pa).toBe(pb) // same resolved object — not two independent fetches merged after the fact
  })

  test('a DIFFERENT identity while one is in flight is its own request, not folded into the first', async () => {
    const { calls, apiFetch, resolveNext } = makeFetch()
    const fetchCardPayload = makeFn(apiFetch)
    const a = fetchCardPayload('twitch', 'one', null)
    const b = fetchCardPayload('twitch', 'two', null)
    expect(calls).toHaveLength(2)
    resolveNext({ profile: { id: 1 }, followage: null, corpus: null, note: null, recent: null })
    resolveNext({ profile: { id: 2 }, followage: null, corpus: null, note: null, recent: null })
    const [pa, pb] = await Promise.all([a, b])
    expect(pa.profile.id).toBe(1)
    expect(pb.profile.id).toBe(2)
  })

  test('twitch and kick logins of the same name are two different cache entries, not a collision', async () => {
    const { calls, apiFetch, resolveNext } = makeFetch()
    const fetchCardPayload = makeFn(apiFetch)
    const a = fetchCardPayload('twitch', 'someone', null)
    const b = fetchCardPayload('kick', 'someone', null)
    expect(calls).toHaveLength(2)
    resolveNext({ profile: { id: 'tw' }, followage: null, corpus: null, note: null, recent: null })
    resolveNext({ profile: { id: 'kk' }, followage: null, corpus: null, note: null, recent: null })
    await Promise.all([a, b])
  })

  test('a repeat call after the first resolved reuses the cached payload — zero more requests', async () => {
    const { calls, apiFetch, resolveNext } = makeFetch()
    const fetchCardPayload = makeFn(apiFetch)
    const first = fetchCardPayload('twitch', 'someone', null)
    resolveNext({ profile: { id: 1 }, followage: null, corpus: null, note: null, recent: null })
    await first
    const second = await fetchCardPayload('twitch', 'someone', null)
    expect(calls).toHaveLength(1) // still just the one from the first call
    expect(second.profile).toEqual({ id: 1 })
  })

  test('a non-ok response resolves to the empty-payload shape, not a throw', async () => {
    const calls = []
    const apiFetch = () => {
      calls.push(1)
      return Promise.resolve({ ok: false, error: 'nope' })
    }
    const fetchCardPayload = makeFn(apiFetch)
    const payload = await fetchCardPayload('twitch', 'someone', null)
    expect(payload).toEqual({ profile: null, followage: null, corpus: null, note: null, recent: null })
  })

  test('openChannels dedupes twitch+kick per channel entry, in `platform:login` form', async () => {
    const { calls, apiFetch } = makeFetch()
    const fetchCardPayload = makeFn(apiFetch, {
      channels: [
        { id: 'a', twitch: 'Forsen', kick: 'forsen' },
        { id: 'b', twitch: 'xQc' },
      ],
    })
    fetchCardPayload('twitch', 'someone', null)
    expect(calls[0].opts.body.openChannels.sort()).toEqual(['kick:forsen', 'twitch:forsen', 'twitch:xqc'])
  })
})

describe('resolveFollowageRows — /api/card followage, gql fallback only when degraded', () => {
  const followageRowsSrc = slice(
    TIPS,
    'function computeFollowageRows(channelLogin, isSelfChannel, result) {',
    "\n\n// `/api/card`'s corpus part",
  )
  const resolveSrc = slice(
    TIPS,
    'function resolveFollowageRows(username, channelLogin, followage, onRows) {',
    '\n\n// No-heatsync-account hover card',
  )
  const src = `${followageRowsSrc}\n${resolveSrc}`

  function makeFn(gqlFollowageDirect, currentUsername = null) {
    return new Function(
      'formatCompact',
      'hsCardRelativeTime',
      'gqlFollowageDirect',
      'currentUsername',
      `${src}\nreturn resolveFollowageRows`,
    )(
      (n) => String(n),
      (iso) => `~${iso}`,
      gqlFollowageDirect,
      currentUsername,
    )
  }

  test('no channel context — a no-op, never calls the gql fallback', () => {
    let called = false
    const resolveFollowageRows = makeFn(async () => {
      called = true
      return null
    })
    resolveFollowageRows('someone', null, null, () => {
      throw new Error('onRows should never fire')
    })
    expect(called).toBe(false)
  })

  test('a clean (non-degraded) payload.followage folds straight in — no gql call at all', async () => {
    let gqlCalled = false
    const resolveFollowageRows = makeFn(async () => {
      gqlCalled = true
      return null
    })
    let rows = null
    resolveFollowageRows(
      'someone',
      'forsen',
      { followedAt: '2020-01-01', followerCount: 5, channelFollowedAt: null },
      (r) => {
        rows = r
      },
    )
    await Promise.resolve() // onRows is deferred one microtask by design
    await Promise.resolve()
    expect(gqlCalled).toBe(false)
    expect(rows.find((r) => r.k === 'ch-follow')).toBeTruthy()
    expect(rows.find((r) => r.k === 'followers')).toBeTruthy()
  })

  test('a degraded payload.followage falls back to the gql lookup, and its result is what lands', async () => {
    const gqlCalls = []
    const resolveFollowageRows = makeFn(async (username, channel) => {
      gqlCalls.push([username, channel])
      return { followedAt: '2021-06-01', followerCount: 9, channelFollowedAt: null }
    })
    let rows = null
    resolveFollowageRows('someone', 'forsen', { degraded: true }, (r) => {
      rows = r
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(gqlCalls).toEqual([['someone', 'forsen']])
    expect(rows.find((r) => r.k === 'ch-follow').value).toContain('forsen')
  })

  test('an absent payload.followage (no part at all) ALSO falls back to gql — absent and degraded are the same signal', async () => {
    let gqlCalled = false
    const resolveFollowageRows = makeFn(async () => {
      gqlCalled = true
      return { followedAt: null, followerCount: null, channelFollowedAt: null }
    })
    resolveFollowageRows('someone', 'forsen', null, () => {})
    await Promise.resolve()
    expect(gqlCalled).toBe(true)
  })

  test('a gql fallback that itself resolves null never calls onRows', async () => {
    let onRowsCalled = false
    const resolveFollowageRows = makeFn(async () => null)
    resolveFollowageRows('someone', 'forsen', { degraded: true }, () => {
      onRowsCalled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(onRowsCalled).toBe(false)
  })
})

describe('pcMergeRecent — server /api/card recent + local buffer, deduped', () => {
  const src = slice(
    CARD,
    'function pcMergeRecent(serverRecent, username) {',
    '\n\n// Scan the same buffers as getRecentMessagesFromUser',
  )

  function makeFn(localMessages) {
    return new Function('getRecentMessagesFromUser', `${src}\nreturn pcMergeRecent`)(() => localMessages)
  }

  test('null when both server and local have nothing', () => {
    const pcMergeRecent = makeFn([])
    expect(pcMergeRecent(null, 'someone')).toBeNull()
    expect(pcMergeRecent([], 'someone')).toBeNull()
  })

  test('server-only: passthrough, capped at 8, newest first', () => {
    const server = Array.from({ length: 10 }, (_, i) => ({
      timestamp: new Date(2024, 0, i + 1).toISOString(),
      channel: 'forsen',
      message: `msg${i}`,
      messageHtml: null,
      permalink: `https://heatsync.org/log/${i}`,
    }))
    const pcMergeRecent = makeFn([])
    const out = pcMergeRecent(server, 'someone')
    expect(out).toHaveLength(8)
    // Newest first (matches getUserHistoryPage's own 'new' default order —
    // see pcMergeRecent's own comment) — the 2 oldest (i=0,1) got dropped.
    expect(out[0].message).toBe('msg9')
    expect(out[out.length - 1].message).toBe('msg2')
  })

  test('a local-only line the archive has not caught up on yet is added, with no permalink', () => {
    const pcMergeRecent = makeFn([{ user: 'someone', text: 'brand new', time: Date.now(), channel: 'forsen' }])
    const out = pcMergeRecent([], 'someone')
    expect(out).toHaveLength(1)
    expect(out[0].message).toBe('brand new')
    expect(out[0].permalink).toBeNull()
    expect(out[0].messageHtml).toBeNull()
  })

  test('a local line already present on the server (same channel+text) is not duplicated', () => {
    const server = [
      { timestamp: new Date().toISOString(), channel: 'forsen', message: 'hey', messageHtml: null, permalink: 'x' },
    ]
    const local = [{ user: 'someone', text: 'hey', time: Date.now(), channel: 'forsen' }]
    const pcMergeRecent = makeFn(local)
    const out = pcMergeRecent(server, 'someone')
    expect(out).toHaveLength(1)
    expect(out[0].permalink).toBe('x') // the server row won the dedupe, not the local stand-in
  })

  test('the same text in a DIFFERENT channel is not deduped — channel is part of the key', () => {
    const server = [
      { timestamp: new Date().toISOString(), channel: 'forsen', message: 'hey', messageHtml: null, permalink: 'x' },
    ]
    const local = [{ user: 'someone', text: 'hey', time: Date.now(), channel: 'xqc' }]
    const pcMergeRecent = makeFn(local)
    const out = pcMergeRecent(server, 'someone')
    expect(out).toHaveLength(2)
  })

  test('local rows with no text or no time are dropped, not passed through as garbage', () => {
    const local = [
      { user: 'someone', text: '', time: Date.now(), channel: 'forsen' },
      { user: 'someone', text: 'real one', time: null, channel: 'forsen' },
    ]
    const pcMergeRecent = makeFn(local)
    expect(pcMergeRecent([], 'someone')).toBeNull()
  })
})

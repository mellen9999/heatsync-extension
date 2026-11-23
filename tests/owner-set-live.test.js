/**
 * A streamer adds, renames or removes an emote: a channel in use that is theirs reads its set
 * again now, not at the 30 minute TTL. The push names the account by its platform tokens
 * (senderKeys); a channel that is not that account's reads nothing.
 *
 * The REAL ownerChannelsOf / refreshOwnerEmotes are carved out of the background parts.
 */

import { describe, expect, test } from 'bun:test'
import { bgSource } from './bg-src.js'

const SRC = bgSource()
function fn(name) {
  const a = SRC.indexOf(`function ${name}(`)
  if (a === -1) throw new Error(`${name} not found in the background parts`)
  return SRC.slice(a, SRC.indexOf('\n}\n', a) + 3)
}

const PROGRAM = [
  fn('chKey'),
  fn('splitChKey'),
  fn('ownerChannelsOf'),
  'const ownerRefreshTimers = new Map()',
  'const OWNER_REFRESH_MS = 1000',
  'const OWNER_REFRESH_TRIES = 4',
  fn('refreshOwnerEmotes'),
  'return { ownerChannelsOf, refreshOwnerEmotes }',
].join('\n')

const UC = 'UCabcdefghijklmnopqrstuv'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function world({ tabs = [], extra = [], ids = {} } = {}) {
  const fetched = []
  const scope = {
    twitchIdCache: new Map(Object.entries(ids)),
    tabChannels: new Map(tabs.map((channel, i) => [i + 1, { channel }])),
    joinedExtraChannels: new Set(extra),
    channelEmotesMap: {},
    channelEmotesFetchedAt: {},
    fetchChannelOwnerEmotes: async (channel, _id, platform) => {
      fetched.push([platform, channel, scope.channelEmotesFetchedAt[`${platform}/${channel.toLowerCase()}`]])
    },
  }
  const proxy = new Proxy(scope, {
    has: (_t, k) => typeof k === 'string',
    get: (t, k) => (k in t ? t[k] : globalThis[k]),
  })
  const api = new Function('__scope', `with (__scope) {\n${PROGRAM}\n}`)(proxy)
  return { ...api, fetched, scope }
}

describe('whose channel an account is', () => {
  const { ownerChannelsOf, scope } = world({ ids: { alice: '111' } })
  const of = (keys, ...chans) => ownerChannelsOf(keys, chans)

  test('twitch: the id resolved for the channel, never a same-named account', () => {
    expect(of(['twitch:111'], 'twitch/alice')).toEqual(['twitch/alice'])
    expect(of(['twitch:999', 'kick:alice'], 'twitch/alice')).toEqual([])
  })
  test('twitch: a channel whose id is not known yet is not guessed at', () => {
    expect(of(['twitch:5'], 'twitch/unknown')).toEqual([])
  })
  test('kick: the account name, and an older account some_name at the address some-name', () => {
    expect(of(['kick:42', 'kick:bob'], 'kick/Bob')).toEqual(['kick/Bob'])
    expect(of(['kick:some_name'], 'kick/some-name')).toEqual(['kick/some-name'])
    expect(of(['kick:some_name'], 'kick/somename')).toEqual([])
  })
  test('youtube: the channel id in its own case, or the handle', () => {
    expect(of([`ytc:${UC}`], `youtube/${UC}`)).toEqual([`youtube/${UC}`])
    expect(of([`ytc:${UC.toLowerCase()}`], `youtube/${UC}`)).toEqual([])
    expect(of(['yt:somehandle'], 'youtube/@SomeHandle')).toEqual(['youtube/@SomeHandle'])
  })
  test('a token of one platform never names a channel of another', () => {
    scope.twitchIdCache.set('bob', '42')
    expect(of(['kick:42', 'kick:bob'], 'twitch/bob', 'youtube/bob')).toEqual([])
    expect(of(['twitch:111'], 'kick/111', 'kick/alice')).toEqual([])
  })
  test('one channel open in two tabs is one channel', () => {
    expect(of(['twitch:111'], 'twitch/alice', 'twitch/alice')).toEqual(['twitch/alice'])
  })
})

describe('a channel in use reads its streamer again', () => {
  test('tab channels and overlay channels both count, with the stale mark set before the read', async () => {
    const w = world({ tabs: ['twitch/alice', 'kick/zed'], extra: [`youtube/${UC}`, 'kick/bob'], ids: { alice: '111' } })
    w.scope.channelEmotesFetchedAt['twitch/alice'] = Date.now()
    w.refreshOwnerEmotes(['twitch:111', 'kick:bob', `ytc:${UC}`], 5)
    await sleep(40)
    expect(w.fetched.map((f) => `${f[0]}/${f[1]}`).sort()).toEqual(['kick/bob', 'twitch/alice', `youtube/${UC}`])
    expect(
      w.fetched.every((f) => f[2] === 0),
      'each read went past the 30 minute TTL',
    ).toBe(true)
  })

  test('a youtube channel id keeps its case on the way to the read', async () => {
    const w = world({ extra: [`youtube/${UC}`] })
    w.refreshOwnerEmotes([`ytc:${UC}`], 5)
    await sleep(40)
    expect(w.fetched[0].slice(0, 2)).toEqual(['youtube', UC])
  })

  test('someone else changing their emotes reads nothing', async () => {
    const w = world({ tabs: ['twitch/alice'], ids: { alice: '111' } })
    w.refreshOwnerEmotes(['twitch:777', 'kick:alice'], 5)
    await sleep(40)
    expect(w.fetched).toEqual([])
  })

  test('a burst is one read, and a change after it is read again', async () => {
    const w = world({ tabs: ['twitch/alice'], ids: { alice: '111' } })
    for (let i = 0; i < 40; i++) w.refreshOwnerEmotes(['twitch:111'], 5)
    await sleep(40)
    expect(w.fetched.length).toBe(1)
    w.refreshOwnerEmotes(['twitch:111'], 5)
    await sleep(40)
    expect(w.fetched.length).toBe(2)
  })

  test('a read already out is waited for, then the channel reads again', async () => {
    const w = world({ tabs: ['twitch/alice'], ids: { alice: '111' } })
    w.scope.channelEmotesMap['twitch/alice'] = 'loading'
    w.refreshOwnerEmotes(['twitch:111'], 10)
    await sleep(25)
    expect(w.fetched.length, 'not while the first read is out: it would be skipped').toBe(0)
    w.scope.channelEmotesMap['twitch/alice'] = []
    await sleep(40)
    expect(w.fetched.length).toBe(1)
  })

  test('a read that never lands does not hold the channel forever', async () => {
    const w = world({ tabs: ['twitch/alice'], ids: { alice: '111' } })
    w.scope.channelEmotesMap['twitch/alice'] = 'loading'
    w.refreshOwnerEmotes(['twitch:111'], 3)
    await sleep(80)
    expect(w.fetched.length).toBe(1)
  })
})

describe('the push reaches it', () => {
  test("both shapes of the push (added, removed) refresh the streamer's channels from the sanitized keys", () => {
    expect(SRC).toMatch(
      /const rmKeys = sanitizeSenderKeys\(msg\.senderKeys\)\n\s+if \(rmKeys\) refreshOwnerEmotes\(rmKeys\)/,
    )
    expect(SRC).toMatch(
      /const addKeys = sanitizeSenderKeys\(msg\.senderKeys\)\n\s+if \(addKeys\) refreshOwnerEmotes\(addKeys\)/,
    )
  })
  test('the background declares the timers and the wait it is carved with here', () => {
    expect(SRC).toContain('const ownerRefreshTimers = new Map()\nconst OWNER_REFRESH_MS = 1000\n')
  })
})

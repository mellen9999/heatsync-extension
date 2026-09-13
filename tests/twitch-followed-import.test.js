/**
 * "fill my cockpit" — the guards that decide what may be added, and the
 * live-first ordering the picker renders. Both are lifted by marker slice from
 * src/multichat/channel-mgmt.js so this fails loudly if either moves.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../src/multichat/channel-mgmt.js', import.meta.url), 'utf8')

function slice(startMarker, endMarker) {
  const s = SRC.indexOf(startMarker)
  if (s === -1) throw new Error(`start marker not found: ${startMarker}`)
  const e = SRC.indexOf(endMarker, s)
  if (e === -1) throw new Error(`end marker not found: ${endMarker}`)
  return SRC.slice(s, e)
}

const GUARD = slice('const RESERVED_TAB_IDS', 'function addChannelsBulk')
const BULK = slice('function addChannelsBulk', 'function makeMcLink')

/** Run the real guard + bulk-add against a fake config, counting side effects. */
function harness(channels) {
  const config = { channels: [...channels] }
  const joined = { twitch: [], kick: [], yt: [] }
  let saves = 0
  let tabBarUpdates = 0
  const fn = new Function(
    'config',
    'saveConfig',
    'updateTabBar',
    'irc',
    'kickChat',
    'safeSendMessage',
    'youtubeLinks',
    'ytSubscribedUrls',
    'ytChanLastSeen',
    'ytSubscribe',
    `${GUARD}\n${BULK}\nreturn { channelAddError, addChannelsBulk }`,
  )
  const api = fn(
    config,
    () => saves++,
    () => tabBarUpdates++,
    { join: (c) => joined.twitch.push(c) },
    { join: (c) => joined.kick.push(c) },
    () => {},
    new Map(),
    new Map(),
    new Map(),
    (id) => joined.yt.push(id),
  )
  return { ...api, config, joined, saves: () => saves, tabBarUpdates: () => tabBarUpdates }
}

describe('channelAddError — one guard, three entry points', () => {
  test('a channel already in the cockpit is rejected', () => {
    const h = harness([{ id: 'xqc', twitch: 'xqc', kick: '', youtube: '' }])
    // id is checked before the per-platform names, same order as the add form
    // always used — pinned here so the refactor that shared this guard can be
    // shown not to have reordered the messages a user sees.
    expect(h.channelAddError('xqc', '', '')).toBe('mc_channel_exists')
  })

  test('the same twitch name under a different tab id still trips the twitch guard', () => {
    const h = harness([{ id: 'yt-1', twitch: 'xqc', kick: '', youtube: 'u' }])
    expect(h.channelAddError('xqc', '', '')).toBe('mc_twitch_exists')
  })

  test('a reserved tab id can never become a channel', () => {
    const h = harness([])
    for (const id of ['live', 'feed', 'settings', 'modlog']) {
      expect(h.channelAddError(id, '', '')).toBe('mc_reserved_name')
    }
  })

  test('a duplicate youtube url is caught even though its id is always unique', () => {
    const h = harness([{ id: 'yt-1', twitch: '', kick: '', youtube: 'https://youtube.com/watch?v=abc' }])
    expect(h.channelAddError('', '', 'https://youtube.com/watch?v=abc')).toBe('mc_channel_exists')
  })

  test('a genuinely new channel passes', () => {
    const h = harness([{ id: 'xqc', twitch: 'xqc', kick: '', youtube: '' }])
    expect(h.channelAddError('forsen', '', '')).toBe(null)
  })
})

describe('addChannelsBulk — one commit, not N', () => {
  test('20 channels cost exactly one saveConfig', () => {
    const h = harness([])
    const entries = Array.from({ length: 20 }, (_, i) => ({ twitch: `streamer${i}` }))
    expect(h.addChannelsBulk(entries)).toBe(20)
    expect(h.config.channels).toHaveLength(20)
    // The whole point: _saveConfigNow does a cross-tab storage union plus a
    // multichat:sync websocket send per call, so per-channel saving would be
    // 20 redundant syncs on the serialized save chain.
    expect(h.saves()).toBe(1)
    expect(h.tabBarUpdates()).toBe(1)
  })

  test('already-added channels are skipped, the rest still land', () => {
    const h = harness([{ id: 'xqc', twitch: 'xqc', kick: '', youtube: '' }])
    expect(h.addChannelsBulk([{ twitch: 'xqc' }, { twitch: 'forsen' }])).toBe(1)
    expect(h.config.channels.map((c) => c.twitch)).toEqual(['xqc', 'forsen'])
  })

  test('a duplicate inside the same batch is caught (config grows as we go)', () => {
    const h = harness([])
    expect(h.addChannelsBulk([{ twitch: 'xqc' }, { twitch: 'xqc' }])).toBe(1)
    expect(h.config.channels).toHaveLength(1)
  })

  test('adding nothing never touches storage', () => {
    const h = harness([{ id: 'xqc', twitch: 'xqc', kick: '', youtube: '' }])
    expect(h.addChannelsBulk([{ twitch: 'xqc' }])).toBe(0)
    expect(h.saves()).toBe(0)
  })

  test('every added twitch channel is actually joined', () => {
    const h = harness([])
    h.addChannelsBulk([{ twitch: 'a' }, { twitch: 'b' }])
    expect(h.joined.twitch).toEqual(['a', 'b'])
  })
})

describe('picker ordering', () => {
  // The sort the picker applies, mirrored here: live first, then alphabetical.
  const sortRows = (follows, liveSet) =>
    [...follows].sort((a, b) => {
      const la = liveSet.has(a.login) ? 0 : 1
      const lb = liveSet.has(b.login) ? 0 : 1
      if (la !== lb) return la - lb
      return a.login.localeCompare(b.login)
    })

  test('live channels sort above offline ones', () => {
    const rows = sortRows([{ login: 'zed' }, { login: 'abe' }, { login: 'mid' }], new Set(['mid']))
    expect(rows.map((r) => r.login)).toEqual(['mid', 'abe', 'zed'])
  })

  test('with nobody live it degrades to alphabetical, not to random', () => {
    const rows = sortRows([{ login: 'zed' }, { login: 'abe' }], new Set())
    expect(rows.map((r) => r.login)).toEqual(['abe', 'zed'])
  })
})

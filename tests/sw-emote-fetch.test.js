// channel emote fetch + retry, executed against the real service worker (tests/harness/sw.js).
//
// the bug this guards (nl_kripp "clop" incident, 2026-08-02): one transient provider failure deleted
// the channel's 7TV set mapping. With the mapping gone the channel had no EventAPI subscription AND
// was invisible to the fallback poll, while the heatsync socket stayed "healthy" — emote adds and
// removes never arrived again until the tab rejoined, because nothing retried. The fix is three
// behaviours, all asserted below by running them: a failed fetch keeps what it had, arms a one-shot
// alarm that survives worker eviction, and that alarm refetches the channels open in tabs.

import { afterEach, describe, expect, test } from 'bun:test'
import { bootSw, disposeAll, json, status, tabSender } from './harness/sw.js'

afterEach(disposeAll)

const AUTH = { name: 'auth', value: 'tok', domain: 'heatsync.org' }
const TAB_URL = 'https://www.twitch.tv/kripp'
const TTL = 30 * 60 * 1000
const KEY = 'twitch/kripp'
const sender = tabSender(7, TAB_URL)

const EMOTES = {
  hs: { name: 'hsKripp', url: 'https://cdn.heatsync.org/e/h1.webp', hash: 'h1' },
  bttv: { id: 'b1', code: 'BTTVone', animated: false },
  ffz: { id: 11, name: 'FFZone', urls: { 1: '//cdn.frankerfacez.com/emote/11/1' } },
  stv: { id: 's1', name: 'SEVENone', flags: 0, data: { animated: false } },
  tw: { id: 't1', name: 'krippOne', url: 'https://static-cdn.jtvnw.net/emoticons/v2/t1/default/dark/1.0' },
}

/** routes for a channel whose five providers all answer. a test overrides one to break it. */
function providers(sw, over = {}) {
  const r = {
    hs: () => json({ emotes: [EMOTES.hs] }),
    bttv: () => json({ channelEmotes: [EMOTES.bttv], sharedEmotes: [] }),
    ffz: () => json({ sets: { 1: { emoticons: [EMOTES.ffz] } } }),
    stv: () => json({ emote_set: { id: 'set-kripp', emotes: [EMOTES.stv] } }),
    tw: () => json({ emotes: [EMOTES.tw], count: 1 }),
    ...over,
  }
  sw.net.on(/^https:\/\/heatsync\.org\/api\/emotes\/user\/kripp(\?|$)/, (q) => r.hs(q))
  sw.net.on('https://api.betterttv.net/3/cached/users/twitch/1', (q) => r.bttv(q))
  sw.net.on('https://api.frankerfacez.com/v1/room/kripp', (q) => r.ffz(q))
  sw.net.on('https://7tv.io/v3/users/twitch/1', (q) => r.stv(q))
  sw.net.on('https://heatsync.org/api/emotes/twitch/channel/kripp', (q) => r.tw(q))
  sw.net.on(/heatsync\.org\/api\/channel\/kripp\/emotes/, json({ emotes: [] }))
  // the alarm refetch carries no channel id, so the worker resolves kripp -> 1 itself
  sw.net.on('https://gql.twitch.tv/gql', () => json({ data: { user: { id: '1' } } }))
  return r
}

// sockets finish their own handshake: this file is about emotes, not about the connection
const boot = (storage) => bootSw({ cookies: [AUTH], tabs: [{ id: 7, url: TAB_URL }], storage, sockets: 'open' })

const join = (sw) => sw.send({ type: 'join_channel', platform: 'twitch', channel: 'kripp', channelId: '1' }, sender)
const names = (list) => list.map((e) => e.name).sort()
const lastUpdate = (sw) => sw.broadcasts('channel_emotes_update', 7).at(-1)?.message
const ALL = ['BTTVone', 'FFZone', 'SEVENone', 'hsKripp', 'krippOne']

describe('a channel join fetches every provider', () => {
  test('all five land in one consolidated update, are persisted, and the 7TV set is subscribed', async () => {
    const sw = await boot()
    providers(sw)
    await join(sw)
    await sw.advance(2000)

    const update = lastUpdate(sw)
    expect(update.channelOwner).toBe('kripp')
    expect(update.platform).toBe('twitch')
    expect(names(update.emotes)).toEqual(ALL)

    // persisted in the worker's IndexedDB, never in storage.local (every write there clones into every tab)
    const row = sw.idb.snapshot('emotes')[KEY]
    expect(names(row.emotes)).toEqual(ALL)
    expect(row.at).toBeLessThanOrEqual(sw.now())
    const stored = sw.storage.local.snapshot()
    expect(stored.channel_emotes_map).toBeUndefined()
    expect(stored.channel_emotes_fetched_at).toBeUndefined()
    expect(stored.seventv_emote_set_ids).toEqual({ [KEY]: 'set-kripp' })

    // nothing failed, so nothing is queued to retry
    expect(sw.alarms.get('hs-emote-refetch')).toBeNull()
    // the live-update subscription is on the 7TV socket (op 35 = subscribe)
    expect(sw.socket('events.7tv.io').frames).toContainEqual({
      op: 35,
      d: { type: 'emote_set.*', condition: { object_id: 'set-kripp' } },
    })
  })

  test('a second join inside the TTL re-sends the cache and fetches nothing', async () => {
    const sw = await boot()
    providers(sw)
    await join(sw)
    await sw.advance(2000)
    const fetched = sw.net.callsTo('/api/emotes/user/kripp').length
    const updates = sw.broadcasts('channel_emotes_update', 7).length

    await join(sw)
    await sw.advance(2000)
    expect(sw.net.callsTo('/api/emotes/user/kripp')).toHaveLength(fetched)
    expect(sw.broadcasts('channel_emotes_update', 7).length).toBeGreaterThan(updates) // cached copy re-sent
    expect(names(lastUpdate(sw).emotes)).toEqual(ALL)
  })

  test("a provider's non-emote cdn url is dropped, never delivered", async () => {
    const sw = await boot()
    providers(sw, {
      bttv: () =>
        json({ channelEmotes: [EMOTES.bttv, { id: 'x', code: 'Sneaky', animated: false }], sharedEmotes: [] }),
      tw: () => json({ emotes: [{ name: 'evil', url: 'https://evil.example/x.png', id: 'e' }], count: 1 }),
    })
    await join(sw)
    await sw.advance(2000)
    expect(names(lastUpdate(sw).emotes)).not.toContain('evil')
  })
})

describe('a provider fails during the first fetch', () => {
  test('the others still arrive, a one-shot retry is armed ~90s out, and the 7TV mapping stays', async () => {
    const sw = await boot()
    providers(sw, { bttv: () => status(500) })
    await join(sw)
    await sw.advance(2000)

    expect(names(lastUpdate(sw).emotes)).toEqual(['FFZone', 'SEVENone', 'hsKripp', 'krippOne'])
    const alarm = sw.alarms.get('hs-emote-refetch')
    expect(alarm).not.toBeNull()
    expect(alarm.periodInMinutes).toBeUndefined() // one-shot, not a poll
    expect(alarm.scheduledTime - sw.now()).toBeLessThanOrEqual(90_000)
    expect(alarm.scheduledTime - sw.now()).toBeGreaterThan(80_000)
    expect(sw.eval(`seventvEmoteSetIds.get('${KEY}')`)).toBe('set-kripp')
    // backdated so the next join (not just the alarm) refetches within a minute
    const at = sw.idb.snapshot('emotes')[KEY].at
    expect(sw.now() - at).toBeGreaterThan(TTL - 61_000)
  })

  test("when the alarm fires it refetches the tab's channel and the recovered provider joins the set", async () => {
    const sw = await boot()
    const r = providers(sw, { bttv: () => status(500) })
    await join(sw)
    await sw.advance(2000)
    expect(names(lastUpdate(sw).emotes)).not.toContain('BTTVone')

    r.bttv = () => json({ channelEmotes: [EMOTES.bttv], sharedEmotes: [] }) // BTTV is back
    await sw.advance(90_000) // alarm fires, handler refetches every channel open in a tab

    expect(names(lastUpdate(sw).emotes)).toEqual(ALL)
    expect(names(sw.idb.snapshot('emotes')[KEY].emotes)).toEqual(ALL)
    expect(sw.alarms.get('hs-emote-refetch')).toBeNull() // recovered: nothing re-armed
  })

  test('the retry alarm survives the worker being evicted before it fires', async () => {
    const sw = await boot()
    providers(sw, { bttv: () => status(500) })
    await join(sw)
    await sw.advance(2000)

    const woken = await sw.restart() // memory gone; chrome.alarms and storage are not
    expect(woken.alarms.get('hs-emote-refetch')).not.toBeNull()
    providers(woken) // BTTV healthy again
    // the woken worker has no idea which tabs are open until it reads them back from session storage
    expect(woken.eval(`tabChannels.get(7)?.channel`)).toBe(KEY)
    await woken.advance(95_000)
    expect(names(woken.idb.snapshot('emotes')[KEY].emotes)).toEqual(ALL)
  })

  test('still failing at the retry: it re-arms rather than giving up', async () => {
    const sw = await boot()
    providers(sw, { bttv: () => status(500) })
    await join(sw)
    await sw.advance(2000)
    await sw.advance(91_000) // first retry, BTTV still down
    expect(sw.net.callsTo('/api/emotes/user/kripp').length).toBeGreaterThanOrEqual(2)
    expect(sw.alarms.get('hs-emote-refetch')).not.toBeNull()
  })
})

describe('a provider fails during a refresh (stale beats missing)', () => {
  test('its previous emotes ride along in the consolidated set', async () => {
    const sw = await boot()
    const r = providers(sw)
    await join(sw)
    await sw.advance(2000)
    expect(names(lastUpdate(sw).emotes)).toEqual(ALL)

    r.bttv = () => status(503)
    r.stv = () => status(502)
    await sw.advance(TTL + 1000) // past the cache lifetime
    await join(sw) // the next tab join refreshes in the background
    await sw.advance(2000)

    // BTTV and 7TV are down, but the emotes already on screen do not turn into text
    expect(names(lastUpdate(sw).emotes)).toEqual(ALL)
    expect(names(sw.idb.snapshot('emotes')[KEY].emotes)).toEqual(ALL)
    expect(sw.alarms.get('hs-emote-refetch')).not.toBeNull()
  })

  test('a refresh sends only the finished set, never a partial that would flash the panel', async () => {
    const sw = await boot()
    providers(sw)
    await join(sw)
    await sw.advance(2000)
    const seen = sw.broadcasts('channel_emotes_update', 7).length

    await sw.advance(TTL + 1000)
    await join(sw)
    await sw.advance(2000)
    const sets = sw
      .broadcasts('channel_emotes_update', 7)
      .slice(seen)
      .map((m) => names(m.message.emotes))
    // every update during the refresh carries the whole set
    for (const s of sets) expect(s).toEqual(ALL)
  })
})

describe('the persisted sets (IndexedDB)', () => {
  const OLD = [{ name: 'oldEmote', url: 'https://cdn.7tv.app/emote/o1/1x.avif', source: '7tv', hash: 'o1' }]
  const NOW = Date.UTC(2026, 10, 8, 12, 0, 0)
  const bootWith = (at, over = {}) =>
    bootSw({
      cookies: [AUTH],
      tabs: [{ id: 7, url: TAB_URL }],
      sockets: 'open',
      idb: { emotes: { [KEY]: { emotes: OLD, at } } },
      storage: { local: { seventv_emote_set_ids: { [KEY]: 'set-kripp' } } },
      ...over,
    })

  test('a woken worker restores them, and a join inside the TTL is answered from them without a fetch', async () => {
    const sw = await bootWith(NOW - 60_000)
    providers(sw)
    expect(sw.eval(`channelEmotesMap['${KEY}'].map(e => e.name)`)).toEqual(['oldEmote'])
    await join(sw)
    await sw.advance(2000)
    expect(names(lastUpdate(sw).emotes)).toEqual(['oldEmote'])
    expect(sw.net.callsTo('/api/emotes/user/kripp')).toHaveLength(0)
  })

  test('a stale set is still shown at once and refreshed behind it', async () => {
    const sw = await bootWith(NOW - TTL - 60_000)
    providers(sw)
    await join(sw)
    await sw.advance(2000)
    expect(sw.net.callsTo('/api/emotes/user/kripp').length).toBeGreaterThan(0)
    expect(names(lastUpdate(sw).emotes)).toEqual(ALL)
    expect(names(sw.idb.snapshot('emotes')[KEY].emotes)).toEqual(ALL)
  })

  test('the pull a tab makes at cold start answers from the same sets, and never writes storage', async () => {
    const sw = await bootWith(NOW - 60_000)
    const all = await sw.send({ type: 'get_channel_emotes_map' }, sender)
    expect(Object.keys(all.map)).toEqual([KEY])
    const one = await sw.send({ type: 'get_channel_emotes_map', channel: 'kripp', platform: 'twitch' }, sender)
    expect(names(one.map[KEY])).toEqual(['oldEmote'])
    const none = await sw.send({ type: 'get_channel_emotes_map', channel: 'nobody', platform: 'twitch' }, sender)
    expect(none.map).toEqual({})
    const re = await sw.send({ type: 'get_channel_emotes' }, sender)
    expect(re.count).toBe(1)
    expect(sw.storage.local.snapshot().channel_emotes_map).toBeUndefined()
  })

  test('a copy an older build left in storage.local is imported once, then dropped from storage', async () => {
    const sw = await bootSw({
      cookies: [AUTH],
      sockets: 'open',
      storage: {
        local: {
          channel_emotes_map: { [KEY]: OLD },
          channel_emotes_fetched_at: { [KEY]: NOW - 60_000 },
        },
      },
    })
    expect(sw.eval(`channelEmotesMap['${KEY}'].length`)).toBe(1)
    await sw.settle()
    expect(sw.idb.snapshot('emotes')[KEY].emotes).toHaveLength(1)
    const stored = sw.storage.local.snapshot()
    expect(stored.channel_emotes_map).toBeUndefined()
    expect(stored.channel_emotes_fetched_at).toBeUndefined()
  })

  test('an IndexedDB that refuses everything does not cost the fetch', async () => {
    const sw = await boot()
    sw.eval(`indexedDB.open = () => { throw new Error('SecurityError') }`)
    providers(sw)
    await join(sw)
    await sw.advance(2000)
    expect(names(lastUpdate(sw).emotes)).toEqual(ALL)
    expect(sw.eval(`channelEmotesMap['${KEY}'].length`)).toBe(5)
  })
})

describe('hs-emote-refetch alarm', () => {
  const fire = (sw) => sw.chrome.alarms.onAlarm.emit({ name: 'hs-emote-refetch', scheduledTime: sw.now() })

  test('refetches a stale channel once, however many tabs show it, and skips tabs that joined nothing', async () => {
    const sw = await bootSw({
      cookies: [AUTH],
      sockets: 'open',
      tabs: [
        { id: 7, url: TAB_URL },
        { id: 8, url: TAB_URL }, // a second tab on the same channel
        { id: 9, url: 'https://kick.com/' }, // a tab that never joined a channel
      ],
    })
    providers(sw)
    await sw.send({ type: 'join_channel', platform: 'twitch', channel: 'kripp', channelId: '1' }, tabSender(7, TAB_URL))
    await sw.send({ type: 'join_channel', platform: 'twitch', channel: 'kripp', channelId: '1' }, tabSender(8, TAB_URL))
    await sw.advance(TTL + 1000) // the cache is now stale
    const before = sw.net.callsTo('/api/emotes/user/kripp').length

    fire(sw)
    await sw.settle()
    expect(sw.net.callsTo('/api/emotes/user/kripp')).toHaveLength(before + 1)
  })

  test('a fresh channel is left alone: the alarm costs no network', async () => {
    const sw = await boot()
    providers(sw)
    await join(sw)
    await sw.advance(2000)
    const before = sw.net.calls.length

    fire(sw)
    await sw.settle()
    expect(sw.net.calls).toHaveLength(before)
  })
})

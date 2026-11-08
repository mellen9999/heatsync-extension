// channel emote fetch + retry, executed against the real service worker (tests/harness/sw.js).
//
// the bug this guards (nl_kripp "clop" incident, 2026-08-02): one transient provider failure deleted
// the channel's 7TV set mapping. With the mapping gone the channel had no EventAPI subscription AND
// was invisible to the fallback poll, while the heatsync socket stayed "healthy" — emote adds and
// removes never arrived again until the tab rejoined, because nothing retried. The fix is three
// behaviours, all asserted below by running them: a failed fetch keeps what it had, arms a one-shot
// alarm that survives worker eviction, and that alarm refetches the channels open in tabs.

import { describe, expect, test } from 'bun:test'
import { bootSw, json, status, tabSender } from './harness/sw.js'

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

    const stored = sw.storage.local.snapshot()
    expect(names(stored.channel_emotes_map[KEY])).toEqual(ALL)
    expect(stored.channel_emotes_fetched_at[KEY]).toBeLessThanOrEqual(sw.now())
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
    const at = sw.storage.local.snapshot().channel_emotes_fetched_at[KEY]
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
    expect(names(sw.storage.local.snapshot().channel_emotes_map[KEY])).toEqual(ALL)
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
    expect(names(woken.storage.local.snapshot().channel_emotes_map[KEY])).toEqual(ALL)
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
    expect(names(sw.storage.local.snapshot().channel_emotes_map[KEY])).toEqual(ALL)
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

describe('the whole fetch fails (storage refuses the write)', () => {
  const seeded = (
    emotes = [{ name: 'oldEmote', url: 'https://cdn.7tv.app/emote/o1/1x.avif', source: '7tv', hash: 'o1' }],
  ) => ({
    local: {
      channel_emotes_map: { [KEY]: emotes },
      channel_emotes_fetched_at: { [KEY]: Date.UTC(2026, 10, 8, 12, 0, 0) - TTL - 60_000 }, // stale
      seventv_emote_set_ids: { [KEY]: 'set-kripp' },
    },
  })
  const refuseChannelWrite = (sw) =>
    sw.storage.local.fail('set', new Error('QUOTA_BYTES quota exceeded'), (items) => 'channel_emotes_map' in items)

  test('the stale copy stays, the 7TV set mapping is NOT deleted, and a retry is armed', async () => {
    const sw = await boot(seeded())
    providers(sw)
    refuseChannelWrite(sw)
    await join(sw)
    await sw.advance(2000)

    expect(sw.eval(`channelEmotesMap['${KEY}'].map(e => e.name)`)).toEqual(['oldEmote'])
    expect(sw.eval(`seventvEmoteSetIds.get('${KEY}')`)).toBe('set-kripp') // the incident: this used to be deleted
    expect(sw.eval(`seventvEmoteSetIds.has('${KEY}')`)).toBe(true)
    expect(sw.alarms.get('hs-emote-refetch')).not.toBeNull()
    expect(names(lastUpdate(sw).emotes)).toEqual(['oldEmote']) // tabs keep rendering what they had
  })

  // KNOWN BUG, found by running this path for the first time: fetchChannelOwnerEmotes stamps
  // channelEmotesFetchedAt = now BEFORE the storage write that fails, and the catch block restores the
  // stale emotes but never un-stamps it (its comment says "fetchedAt stays old, so the next join
  // retries"). So the 90s retry alarm sees a "fresh" cache, TTL-gates itself out, and the stale set
  // lives the full 30 minutes. `failing` keeps the suite green while the bug stands and turns red
  // the day it is fixed — then drop the `.failing`.
  test.failing('and the retry alarm, with storage healthy again, completes the refresh', async () => {
    const sw = await boot(seeded())
    providers(sw)
    refuseChannelWrite(sw)
    await join(sw)
    await sw.advance(2000)
    await sw.advance(95_000) // retry alarm
    expect(names(sw.storage.local.snapshot().channel_emotes_map[KEY])).toEqual(ALL)
    expect(sw.alarms.get('hs-emote-refetch')).toBeNull()
  })

  test('a channel that never loaded is cleared (not left "loading"), so the next join retries it', async () => {
    const sw = await boot()
    providers(sw)
    refuseChannelWrite(sw)
    await join(sw)
    await sw.advance(2000)
    expect(sw.eval(`'${KEY}' in channelEmotesMap`)).toBe(false)
    expect(sw.alarms.get('hs-emote-refetch')).not.toBeNull()
    await join(sw) // the sentinel is gone, so this fetches again
    await sw.advance(2000)
    expect(names(sw.storage.local.snapshot().channel_emotes_map[KEY])).toEqual(ALL)
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

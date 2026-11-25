// a browser restart during a 7tv/bttv/ffz outage must not lose a room's emotes: boot restores each
// stored set (08-diag-push.js), so a refetch that fails keeps it through the refresh salvage. a set
// last written over 30 days ago is dropped at boot, so the store cannot grow forever.

import { afterEach, describe, expect, test } from 'bun:test'
import { bootSw, disposeAll, json, status, tabSender } from './harness/sw.js'

afterEach(disposeAll)

const AUTH = { name: 'auth', value: 'tok', domain: 'heatsync.org' }
const TAB_URL = 'https://www.twitch.tv/kripp'
const KEY = 'twitch/kripp'
const DAY = 24 * 60 * 60 * 1000
const sender = tabSender(7, TAB_URL)

const EMOTES = {
  hs: { name: 'hsKripp', url: 'https://cdn.heatsync.org/e/h1.webp', hash: 'h1' },
  bttv: { id: 'b1', code: 'BTTVone', animated: false },
  ffz: { id: 11, name: 'FFZone', urls: { 1: '//cdn.frankerfacez.com/emote/11/1' } },
  stv: { id: 's1', name: 'SEVENone', flags: 0, data: { animated: false } },
  tw: { id: 't1', name: 'krippOne', url: 'https://static-cdn.jtvnw.net/emoticons/v2/t1/default/dark/1.0' },
}

function providers(sw, down = []) {
  const r = {
    hs: () => json({ emotes: [EMOTES.hs] }),
    bttv: () => json({ channelEmotes: [EMOTES.bttv], sharedEmotes: [] }),
    ffz: () => json({ sets: { 1: { emoticons: [EMOTES.ffz] } } }),
    stv: () => json({ emote_set: { id: 'set-kripp', emotes: [EMOTES.stv] } }),
    tw: () => json({ emotes: [EMOTES.tw], count: 1 }),
  }
  for (const k of down) r[k] = () => status(503)
  sw.net.on(/^https:\/\/heatsync\.org\/api\/emotes\/user\/kripp(\?|$)/, (q) => r.hs(q))
  sw.net.on('https://api.betterttv.net/3/cached/users/twitch/1', (q) => r.bttv(q))
  sw.net.on('https://api.frankerfacez.com/v1/room/kripp', (q) => r.ffz(q))
  sw.net.on('https://7tv.io/v3/users/twitch/1', (q) => r.stv(q))
  sw.net.on('https://heatsync.org/api/emotes/twitch/channel/kripp', (q) => r.tw(q))
  sw.net.on(/heatsync\.org\/api\/channel\/kripp\/emotes/, json({ emotes: [] }))
  sw.net.on('https://gql.twitch.tv/gql', () => json({ data: { user: { id: '1' } } }))
  return r
}

const boot = (more = {}) => bootSw({ cookies: [AUTH], tabs: [{ id: 7, url: TAB_URL }], sockets: 'open', ...more })
const join = (sw) => sw.send({ type: 'join_channel', platform: 'twitch', channel: 'kripp', channelId: '1' }, sender)
const names = (list) => list.map((e) => e.name).sort()
// a restarted worker's broadcast log carries the old one's: only updates after `from` are this boot's
const lastUpdate = (sw, from = 0) => sw.broadcasts('channel_emotes_update', 7).slice(from).at(-1)?.message
const updates = (sw) => sw.broadcasts('channel_emotes_update', 7).length
const TTL = 30 * 60 * 1000
const reboot = (first) => first.restart({ cookies: [AUTH], tabs: [{ id: 7, url: TAB_URL }] })
const ALL = ['BTTVone', 'FFZone', 'SEVENone', 'hsKripp', 'krippOne']
const ALL_DOWN = ['hs', 'bttv', 'ffz', 'stv', 'tw']

async function stored() {
  const sw = await boot()
  providers(sw)
  await join(sw)
  await sw.advance(2000)
  return sw
}

describe("a restart in an outage keeps the room's emotes", () => {
  test('every provider down past the TTL: the stored set still serves the room', async () => {
    const woken = await reboot(await stored())
    providers(woken, ALL_DOWN)
    await woken.advance(TTL + 1000)
    const from = updates(woken)
    await join(woken)
    await woken.advance(2000)
    expect(woken.net.callsTo('betterttv.net/3/cached/users')).not.toHaveLength(0) // it did try
    expect(names(lastUpdate(woken, from).emotes)).toEqual(ALL)
    expect(names(woken.idb.snapshot('emotes')[KEY].emotes)).toEqual(ALL)
    expect(woken.alarms.get('hs-emote-refetch')).not.toBeNull() // and it will try again
  })

  test('one provider down: its stored entries stay, the live ones replace the rest', async () => {
    const woken = await reboot(await stored())
    providers(woken, ['stv'])
    await woken.advance(TTL + 1000)
    const from = updates(woken)
    await join(woken)
    await woken.advance(2000)
    expect(names(lastUpdate(woken, from).emotes)).toEqual(ALL)
  })
})

describe('the store is trimmed by age at boot', () => {
  test('a set older than 30 days is neither restored nor kept; a recent one is', async () => {
    const first = await stored()
    const row = first.idb.snapshot('emotes')[KEY]
    first.idb.seed('emotes', {
      'twitch/ancient': { emotes: row.emotes, at: first.now() - 40 * DAY },
      'twitch/recent': { emotes: row.emotes, at: first.now() - 5 * DAY },
    })
    const woken = await reboot(first)
    await woken.advance(2000)
    expect(Object.keys(woken.idb.snapshot('emotes')).sort()).toEqual(['twitch/kripp', 'twitch/recent'])
  })
})

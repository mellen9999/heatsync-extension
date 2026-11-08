// the service worker's front door, executed: who may talk to it, what a few representative message
// types do, and what happens to a type nobody handles. runs the real background bundle through
// tests/harness/sw.js — nothing here reads source text.

import { afterEach, describe, expect, test } from 'bun:test'
import { bootSw, disposeAll, json, networkError, status, tabSender } from './harness/sw.js'

afterEach(disposeAll)

const AUTH = { name: 'auth', value: 'tok-abc', domain: 'heatsync.org' }
const twitchTab = tabSender(7, 'https://www.twitch.tv/kripp')

async function boot(opts = {}) {
  const sw = await bootSw({ cookies: [AUTH], tabs: [{ id: 7, url: twitchTab.tab.url }], ...opts })
  await sw.connect() // the ws handshake the worker starts at boot
  return sw
}

describe('sender gate', () => {
  test('a content script on a platform page and an extension page are both let in', async () => {
    const sw = await boot()
    expect(await sw.send({ type: 'hs_surface_open', surface: 'popup' }, twitchTab)).toEqual({ ok: true })
    expect(await sw.send({ type: 'hs_surface_open', surface: 'popup' })).toEqual({ ok: true }) // no tab: popup
  })

  test('another extension is refused, with or without a tab', async () => {
    const sw = await boot()
    const refused = { ok: false, error: 'unauthorized sender' }
    expect(await sw.send({ type: 'get_auth_state' }, { id: 'someone-elses-extension' })).toEqual(refused)
    expect(
      await sw.send(
        { type: 'get_auth_state' },
        { id: 'someone-elses-extension', tab: { id: 1, url: twitchTab.tab.url } },
      ),
    ).toEqual(refused)
    expect(await sw.send({ type: 'get_auth_state' }, { tab: { id: 1, url: twitchTab.tab.url } })).toEqual(refused) // no id at all
  })

  test('our own id on a page that is not one of ours is refused (lookalikes, http, other sites)', async () => {
    const sw = await boot()
    for (const url of [
      'https://evil.example/',
      'https://twitch.tv.evil.example/',
      'https://eviltwitch.tv/',
      'http://www.twitch.tv/kripp',
      'https://example.com/?next=https://www.twitch.tv/',
    ]) {
      const reply = await sw.send({ type: 'get_auth_state' }, tabSender(1, url))
      expect(reply, url).toEqual({ ok: false, error: 'unauthorized sender' })
    }
  })

  test('a refused sender changes nothing: no mute, no storage write', async () => {
    const sw = await boot()
    const before = sw.storage.local.snapshot()
    await sw.send({ type: 'mute_user', username: 'someone' }, { id: 'someone-elses-extension' })
    expect(sw.storage.local.snapshot().muted_users).toEqual(before.muted_users)
    expect(sw.eval('mutedUsers.size')).toBe(0)
  })

  test('every host we ship on is accepted (twitch, kick, youtube, heatsync, subdomains)', async () => {
    const sw = await boot()
    for (const url of [
      'https://www.twitch.tv/x',
      'https://kick.com/x',
      'https://www.youtube.com/watch?v=abc',
      'https://heatsync.org/',
      'https://dashboard.twitch.tv/u/x/stream-manager',
    ]) {
      expect(await sw.send({ type: 'hs_surface_open', surface: 'x' }, tabSender(2, url)), url).toEqual({ ok: true })
    }
  })
})

describe('malformed and unknown messages', () => {
  test('a type nobody handles is answered unknown_type, not left hanging', async () => {
    const sw = await boot()
    const out = await sw.exchange({ type: 'definitely_not_a_message_type' }, twitchTab)
    // answered, so a caller awaiting this resolves instead of waiting out its timeout
    expect(out.responded).toBe(true)
    expect(out.response).toEqual({ ok: false, error: 'unknown_type' })
    // and the worker is still fine afterwards
    expect(await sw.send({ type: 'get_auth_state' }, twitchTab)).toEqual({ loggedIn: true })
    expect(sw.consoleLog.filter((l) => l.level === 'error')).toEqual([])
  })

  test('non-objects are dropped without a reply', async () => {
    const sw = await boot()
    for (const junk of [null, 'a string', 42, [], true]) {
      const out = await sw.exchange(junk, twitchTab)
      expect(out.responded, JSON.stringify(junk)).toBe(false)
    }
    expect(await sw.send({ type: 'get_auth_state' }, twitchTab)).toEqual({ loggedIn: true })
  })

  test('a prototype-pollution shaped message is just an unknown type', async () => {
    const sw = await boot()
    const out = await sw.exchange(JSON.parse('{"type":"__proto__","__proto__":{"polluted":true}}'), twitchTab)
    expect(out.response).toEqual({ ok: false, error: 'unknown_type' })
    expect(sw.eval('({}).polluted')).toBeUndefined()
  })
})

describe('get_auth_state', () => {
  test('signed in when the heatsync cookie exists', async () => {
    const sw = await boot()
    expect(await sw.send({ type: 'get_auth_state' }, twitchTab)).toEqual({ loggedIn: true })
  })

  test('signed out with no cookie, and it flips live when the cookie appears', async () => {
    const sw = await bootSw({ tabs: [{ id: 7, url: twitchTab.tab.url }] })
    await sw.connect()
    expect(await sw.send({ type: 'get_auth_state' }, twitchTab)).toEqual({ loggedIn: false })
    sw.cookies.set(AUTH)
    await sw.settle()
    expect(await sw.send({ type: 'get_auth_state' }, twitchTab)).toEqual({ loggedIn: true })
  })
})

describe('mute_user / unmute_user', () => {
  test('a mute is remembered, told to every tab, and synced to the server', async () => {
    const sw = await boot()
    const synced = []
    sw.net.on('https://heatsync.org/api/mutes', (req) => {
      synced.push(req.method === 'POST' ? req.json() : null)
      return json({ ok: true })
    })

    expect(await sw.send({ type: 'mute_user', username: 'annoying', expiresAt: null }, twitchTab)).toEqual({ ok: true })

    expect(sw.storage.local.snapshot().muted_users).toEqual([{ username: 'annoying', expiresAt: null }])
    expect(sw.broadcasts('user_muted', 7).map((m) => m.message.username)).toEqual(['annoying'])
    expect(synced.filter(Boolean)).toHaveLength(1)
    expect(synced.find(Boolean).username).toBe('annoying')

    expect(await sw.send({ type: 'unmute_user', username: 'annoying' }, twitchTab)).toEqual({ ok: true })
    expect(sw.storage.local.snapshot().muted_users).toEqual([])
    expect(sw.broadcasts('user_unmuted', 7)).toHaveLength(1)
  })

  test('a mute survives the worker being evicted and woken again', async () => {
    const sw = await boot()
    await sw.send({ type: 'mute_user', username: 'annoying', expiresAt: null }, twitchTab)
    const woken = await sw.restart()
    expect(woken.eval('[...mutedUsers.keys()]')).toEqual(['annoying'])
  })
})

describe('ws_send (the only way a page talks to the server socket)', () => {
  test('an allowed frame reaches the socket', async () => {
    const sw = await boot()
    const ws = sw.socket()
    ws.receive({ type: 'authenticated', userId: 1 })
    await sw.advance(5000) // the connect burst drains at 80ms a frame
    const before = ws.frames.length
    expect(await sw.send({ type: 'ws_send', data: { type: 'emote:used', name: 'Kappa' } }, twitchTab)).toEqual({
      ok: true,
    })
    expect(ws.frames.slice(before)).toEqual([{ type: 'emote:used', name: 'Kappa' }])
  })

  test('a frame type outside the allow-list is dropped, never sent', async () => {
    const sw = await boot()
    const ws = sw.socket()
    await sw.advance(5000)
    const before = ws.frames.length
    for (const type of ['authenticate', 'presence:heartbeat', 'admin:ban', 'channel:join ']) {
      await sw.send({ type: 'ws_send', data: { type, token: 'forged' } }, twitchTab)
    }
    expect(ws.frames.slice(before)).toEqual([])
    expect(JSON.stringify(ws.frames.slice(before))).not.toContain('forged')
  })

  test('a join for a reserved page name is refused and not remembered', async () => {
    const sw = await boot()
    const reply = await sw.send(
      { type: 'ws_send', data: { type: 'channel:join', platform: 'twitch', channel: 'directory' } },
      twitchTab,
    )
    expect(reply).toEqual({ ok: false, error: 'reserved path' })
    expect(sw.eval('[...joinedExtraChannels]')).toEqual([])
  })

  test('a real extra-channel join is remembered, sent, and kicks off its emote fetch', async () => {
    const sw = await boot()
    sw.net.on(/emotes\/user\/someone/, json({ emotes: [] }))
    sw.net.on(/api\.betterttv\.net\/3\/cached\/users\/twitch\/9/, status(404))
    sw.net.on(/api\.frankerfacez\.com\/v1\/room\/someone/, status(404))
    sw.net.on(/7tv\.io\/v3\/users\/twitch\/9/, status(404))
    sw.net.on(/helix|gql|emotes\/twitch/, json({ emotes: [] }))
    const ws = sw.socket()
    await sw.advance(5000)
    await sw.send(
      { type: 'ws_send', data: { type: 'channel:join', platform: 'twitch', channel: 'Someone' } },
      twitchTab,
    )
    expect(sw.eval('[...joinedExtraChannels]')).toEqual(['twitch/someone'])
    expect(ws.frames.filter((f) => f.type === 'channel:join')).toContainEqual({
      type: 'channel:join',
      platform: 'twitch',
      channel: 'Someone',
    })
    expect(sw.net.callsTo('/api/emotes/user/someone')).toHaveLength(1)
  })
})

describe('join_channel (a tab announcing the room it is in)', () => {
  test('bad platform or empty channel is rejected up front', async () => {
    const sw = await boot()
    const bad = { received: false, error: 'invalid platform/channel' }
    expect(await sw.send({ type: 'join_channel', platform: 'myspace', channel: 'kripp' }, twitchTab)).toEqual(bad)
    expect(await sw.send({ type: 'join_channel', platform: 'twitch', channel: '' }, twitchTab)).toEqual(bad)
    expect(await sw.send({ type: 'join_channel', platform: 'twitch', channel: '!!!' }, twitchTab)).toEqual(bad)
  })

  test('a good join binds the tab to the channel (sanitised) and tells the server', async () => {
    const sw = await boot()
    sw.net.on(/emotes\/user\//, json({ emotes: [] }))
    const ws = sw.socket()
    expect(
      await sw.send({ type: 'join_channel', platform: 'twitch', channel: 'KrIpP!!', channelId: '1' }, twitchTab),
    ).toEqual({
      received: true,
    })
    expect(sw.eval('tabChannels.get(7).channel')).toBe('twitch/kripp')
    await sw.advance(5000)
    expect(ws.frames).toContainEqual({ type: 'channel:join', platform: 'twitch', channel: 'kripp' })
  })
})

describe('blocked_terms (server error -> what the overlay is told)', () => {
  const ask = (sw, over = {}) =>
    sw.send({ type: 'blocked_terms', broadcasterId: '123', op: 'list', ...over }, twitchTab)
  const route = (sw, handler) => sw.net.on(/api\/mod\/blocked-terms/, handler)

  test('list: terms come back, and the request carries the bearer and no cookies', async () => {
    const sw = await boot()
    route(sw, () => json({ terms: [{ id: 'a', text: 'spam' }] }))
    expect(await ask(sw)).toEqual({ ok: true, terms: [{ id: 'a', text: 'spam' }] })
    const call = sw.net.callsTo('/api/mod/blocked-terms')[0]
    expect(call.headers.authorization).toBe('Bearer tok-abc')
    expect(call.url).toContain('broadcaster_id=123')
  })

  test('each failure maps to its own words', async () => {
    const cases = [
      [() => json({ error: 'relink_required' }, 401), 'relink_required'],
      [() => json({ relink_required: true }, 401), 'relink_required'],
      [() => json({}, 401), 'auth_required'],
      [() => json({}, 403), 'not_moderator'],
      [() => json({}, 404), 'gone'],
      [() => json({}, 429), 'rate_limited'],
      [() => json({ error: 'twitch said no' }, 502), 'twitch said no'],
      [() => status(503), 'http 503'],
    ]
    for (const [handler, error] of cases) {
      const sw = await boot()
      route(sw, handler)
      expect(await ask(sw), error).toEqual({ ok: false, error })
    }
  })

  test('a dead network is reported, not thrown', async () => {
    const sw = await boot()
    route(sw, () => networkError('socket hang up'))
    expect(await ask(sw)).toEqual({ ok: false, error: 'socket hang up' })
  })

  test('bad params never leave the worker', async () => {
    const sw = await boot()
    route(sw, () => json({ terms: [] }))
    expect(await ask(sw, { broadcasterId: 'abc' })).toEqual({ ok: false, error: 'missing params' })
    expect(await ask(sw, { op: 'drop-table' })).toEqual({ ok: false, error: 'missing params' })
    expect(sw.net.callsTo('/api/mod/blocked-terms')).toHaveLength(0)
  })

  test('signed out means auth_required without touching the network', async () => {
    const sw = await bootSw({ tabs: [{ id: 7, url: twitchTab.tab.url }] }) // no cookie
    await sw.connect()
    route(sw, () => json({ terms: [] }))
    expect(await ask(sw)).toEqual({ ok: false, error: 'auth_required' })
    expect(sw.net.callsTo('/api/mod/blocked-terms')).toHaveLength(0)
  })

  test('add sends the trimmed term as a POST body', async () => {
    const sw = await boot()
    route(sw, () => json({ term: { id: 'z', text: 'bad word' } }))
    expect(await ask(sw, { op: 'add', text: '  bad word  ' })).toEqual({
      ok: true,
      term: { id: 'z', text: 'bad word' },
    })
    const call = sw.net.callsTo('/api/mod/blocked-terms')[0]
    expect(call.method).toBe('POST')
    expect(call.json()).toEqual({ broadcaster_id: '123', text: 'bad word' })
  })
})

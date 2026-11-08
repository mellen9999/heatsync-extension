/**
 * Who gets the twitch login.
 *
 * `get_twitch_auth_token` used to hand the raw twitch auth cookie to any content
 * script that asked, for four jobs — three of which never needed the value.
 * Now: presence checks ask twitch_auth_status (a yes/no), helix lookups are made
 * by the worker (twitch_helix), and the one job that does need the value (the
 * authed chat socket on a kick / youtube page) gets it only from the overlay's
 * top frame on a twitch / kick / youtube tab.
 *
 * The real source runs here: the helpers are sliced out of 02-auth-live.js, and
 * the three handler branches out of 07-handle-message.js, against a fake
 * cookie jar, a fake fetch, and senders shaped like chrome's.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bgSource } from './bg-src.js'

const SRC = bgSource()
const EXT_ID = 'hsextensionidhsextensionidhsextens'
const SECRET = 'oauth-secret-cookie-value'

const SESSION_START = SRC.indexOf('const TWITCH_WEB_CLIENT_ID')
const SESSION_END = SRC.indexOf("// Fetch user's emote inventory via HTTP")
if (SESSION_START < 0 || SESSION_END < SESSION_START) throw new Error('TWITCH SESSION markers missing')
const SESSION = SRC.slice(SESSION_START, SESSION_END)

// the handler branches, from the first of ours up to get_inventory
const BRANCH_START = SRC.indexOf("} else if (message.type === 'twitch_auth_status') {")
const BRANCH_END = SRC.indexOf("} else if (message.type === 'get_inventory') {")
if (BRANCH_START < 0 || BRANCH_END < BRANCH_START) throw new Error('twitch handler branches missing')
const BRANCHES = SRC.slice(BRANCH_START, BRANCH_END)

const GQL_START = SRC.indexOf("} else if (message.type === 'twitch_gql_authed') {")
const GQL_END = SRC.indexOf("} else if (message.type === 'twitch_relay') {")
if (GQL_START < 0 || GQL_END < GQL_START) throw new Error('twitch_gql_authed branch missing')
const GQL_BRANCH = SRC.slice(GQL_START, GQL_END)

function load({ cookies = { 'auth-token': SECRET, name: 'Streamer' }, userInfo = null, fetchImpl } = {}) {
  const calls = { cookieReads: 0, fetches: [] }
  const browser = {
    runtime: { id: EXT_ID },
    cookies: {
      get: async ({ name }) => {
        calls.cookieReads++
        return cookies[name] == null ? null : { value: cookies[name] }
      },
    },
    storage: { local: { get: async () => (userInfo ? { user_info: userInfo } : {}) } },
  }
  const fetchWithTimeout = async (url, opts) => {
    calls.fetches.push({ url, opts })
    return fetchImpl ? fetchImpl(url, opts) : { ok: true, status: 200, json: async () => ({ data: [{ id: '4242' }] }) }
  }
  const make = new Function(
    'browser',
    'fetchWithTimeout',
    `${SESSION}
    function branch(message, sender, sendResponse) {
      if (message.type === '__none__') {
        // chain anchor
      ${BRANCHES} }
    }
    function gqlBranch(message, sender, sendResponse) {
      if (message.type === '__none__') {
      ${GQL_BRANCH} }
    }
    return { twitchGrantAllowed, twitchSessionSenderOk, readTwitchSession, twitchHelix, branch, gqlBranch }`,
  )
  return { ...make(browser, fetchWithTimeout), calls }
}

const sender = (over = {}) => ({
  id: EXT_ID,
  tab: { id: 7, url: 'https://www.twitch.tv/somechannel' },
  frameId: 0,
  url: 'https://www.twitch.tv/somechannel',
  ...over,
})
const onTab = (url, over = {}) => sender({ tab: { id: 7, url }, url, ...over })

/** run a handler branch, answer what it sent back */
function ask(fn, message, from) {
  return new Promise((resolve) => {
    fn(message, from, resolve)
  })
}

describe('who may use the twitch login', () => {
  const ok = [
    'https://www.twitch.tv/somechannel',
    'https://www.twitch.tv/popout/somechannel/chat?popout=',
    'https://twitch.tv/somechannel',
    'https://dashboard.twitch.tv/u/somechannel/stream-manager',
    'https://kick.com/somechannel',
    'https://www.kick.com/somechannel',
    'https://www.youtube.com/watch?v=abcdefghijk',
  ]
  for (const url of ok) {
    test(`allowed: top frame of ${url}`, () => {
      expect(load().twitchSessionSenderOk(onTab(url))).toBe(true)
    })
  }

  const denied = {
    'heatsync.org (its content script never needs it)': onTab('https://heatsync.org/chat'),
    'a subframe of an allowed tab': sender({ frameId: 3 }),
    'no frame id at all': sender({ frameId: undefined }),
    'the popup (no tab)': { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup.html` },
    'another extension': sender({ id: 'someotherextensionidsomeotherext' }),
    'no sender': undefined,
    'a frame whose url is not the tab origin': sender({ url: 'https://evil.example/' }),
    'lookalike: twitch.tv as a subdomain of another host': onTab('https://twitch.tv.evil.example/'),
    'lookalike: a host that merely ends in twitch.tv': onTab('https://eviltwitch.tv/'),
    'lookalike: a host that merely ends in kick.com': onTab('https://notkick.com/'),
    'http, not https': onTab('http://kick.com/somechannel'),
    'youtube without www': onTab('https://youtube.com/watch?v=abcdefghijk'),
    'youtube mobile': onTab('https://m.youtube.com/watch?v=abcdefghijk'),
    'a file: page': onTab('file:///tmp/x.html'),
    'an unparseable url': sender({ url: 'not a url', tab: { id: 7, url: 'not a url' } }),
    'a tab with no id': sender({ tab: { url: 'https://www.twitch.tv/x' } }),
  }
  for (const [name, from] of Object.entries(denied)) {
    test(`denied: ${name}`, () => {
      expect(load().twitchSessionSenderOk(from)).toBe(false)
    })
  }
})

describe('get_twitch_auth_token', () => {
  test('the overlay in the top frame of a kick tab still gets the token (the chat socket needs it)', async () => {
    const h = load()
    const r = await ask(h.branch, { type: 'get_twitch_auth_token' }, onTab('https://kick.com/somechannel'))
    expect(r.token).toBe(SECRET)
    expect(r.username).toBe('streamer')
  })

  test('the youtube overlay and a twitch popout get it too', async () => {
    const h = load()
    for (const url of ['https://www.youtube.com/watch?v=abcdefghijk', 'https://www.twitch.tv/popout/x/chat']) {
      expect((await ask(h.branch, { type: 'get_twitch_auth_token' }, onTab(url))).token).toBe(SECRET)
    }
  })

  test('falls back to the heatsync-linked twitch name when there is no name cookie', async () => {
    const h = load({ cookies: { 'auth-token': SECRET }, userInfo: { twitch_username: 'linked_name' } })
    expect((await ask(h.branch, { type: 'get_twitch_auth_token' }, sender())).username).toBe('linked_name')
  })

  test('no twitch login at all: token null, no throw', async () => {
    const h = load({ cookies: {} })
    expect(await ask(h.branch, { type: 'get_twitch_auth_token' }, sender())).toEqual({ token: null, username: null })
  })

  const denied = {
    'heatsync.org': onTab('https://heatsync.org/chat'),
    'a subframe': sender({ frameId: 2 }),
    'the popup': { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup.html` },
    'another extension': sender({ id: 'someotherextensionidsomeotherext' }),
  }
  for (const [name, from] of Object.entries(denied)) {
    test(`denied for ${name}: no token in the answer, the cookie is never even read`, async () => {
      const h = load()
      const r = await ask(h.branch, { type: 'get_twitch_auth_token' }, from)
      expect(r.token).toBeNull()
      expect(JSON.stringify(r)).not.toContain(SECRET)
      expect(r.error).toBe('unauthorized sender')
      expect(h.calls.cookieReads).toBe(0)
    })
  }
})

describe('get_twitch_auth_token rate limit', () => {
  test('7th grant in a minute to one tab is refused with no token and no cookie read', async () => {
    const h = load()
    for (let i = 0; i < 6; i++)
      expect((await ask(h.branch, { type: 'get_twitch_auth_token' }, sender())).token).toBe(SECRET)
    const reads = h.calls.cookieReads
    const r = await ask(h.branch, { type: 'get_twitch_auth_token' }, sender())
    expect(r).toEqual({ token: null, username: null, error: 'rate_limited' })
    expect(h.calls.cookieReads).toBe(reads)
  })

  test('another tab is unaffected, and the window expires', () => {
    const h = load()
    const t0 = 1_000_000
    for (let i = 0; i < 6; i++) expect(h.twitchGrantAllowed(sender(), t0)).toBe(true)
    expect(h.twitchGrantAllowed(sender(), t0 + 1)).toBe(false)
    expect(h.twitchGrantAllowed(sender({ tab: { id: 8, url: 'https://kick.com/x' } }), t0)).toBe(true)
    expect(h.twitchGrantAllowed(sender(), t0 + 61_000)).toBe(true)
  })
})

describe('twitch_auth_status — presence without the value', () => {
  test('says yes and who, and the answer carries no token', async () => {
    const h = load()
    const r = await ask(h.branch, { type: 'twitch_auth_status' }, onTab('https://kick.com/x'))
    expect(r).toEqual({ loggedIn: true, username: 'streamer' })
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })

  test('says no when there is no login', async () => {
    const h = load({ cookies: {} })
    expect((await ask(h.branch, { type: 'twitch_auth_status' }, sender())).loggedIn).toBe(false)
  })

  test('refuses heatsync.org and subframes', async () => {
    const h = load()
    expect((await ask(h.branch, { type: 'twitch_auth_status' }, onTab('https://heatsync.org/'))).loggedIn).toBe(false)
    expect((await ask(h.branch, { type: 'twitch_auth_status' }, sender({ frameId: 1 }))).loggedIn).toBe(false)
    expect(h.calls.cookieReads).toBe(0)
  })
})

describe('twitch_helix — the worker makes the call, the token stays', () => {
  test('self_id: asks helix with the cookie, answers the id only', async () => {
    const h = load()
    const r = await ask(h.branch, { type: 'twitch_helix', op: 'self_id' }, onTab('https://kick.com/x'))
    expect(r).toEqual({ ok: true, id: '4242' })
    expect(JSON.stringify(r)).not.toContain(SECRET)
    expect(h.calls.fetches).toHaveLength(1)
    expect(h.calls.fetches[0].url).toBe('https://api.twitch.tv/helix/users')
    expect(h.calls.fetches[0].opts.headers.Authorization).toBe(`Bearer ${SECRET}`)
    expect(h.calls.fetches[0].opts.credentials).toBe('omit')
  })

  test('self_id: a helix error is reported with its status, no token', async () => {
    const h = load({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) })
    const r = await ask(h.branch, { type: 'twitch_helix', op: 'self_id' }, sender())
    expect(r).toEqual({ ok: false, status: 401, error: 'helix 401' })
  })

  test('whisper_subscribe: posts the websocket subscription, answers the status', async () => {
    const h = load({ fetchImpl: async () => ({ ok: true, status: 202, json: async () => ({}) }) })
    const r = await ask(
      h.branch,
      { type: 'twitch_helix', op: 'whisper_subscribe', args: { sessionId: 'AQoQexample-session_id', userId: '4242' } },
      sender(),
    )
    expect(r).toEqual({ ok: true, status: 202 })
    const call = h.calls.fetches[0]
    expect(call.url).toBe('https://api.twitch.tv/helix/eventsub/subscriptions')
    expect(call.opts.method).toBe('POST')
    expect(JSON.parse(call.opts.body)).toEqual({
      type: 'user.whisper.message',
      version: '1',
      condition: { user_id: '4242' },
      transport: { method: 'websocket', session_id: 'AQoQexample-session_id' },
    })
  })

  test('whisper_subscribe: a 403 comes back as 403 (the overlay gives up on it)', async () => {
    const h = load({ fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) })
    const r = await ask(
      h.branch,
      { type: 'twitch_helix', op: 'whisper_subscribe', args: { sessionId: 'AQoQexample-session_id', userId: '4242' } },
      sender(),
    )
    expect(r).toEqual({ ok: false, status: 403 })
  })

  test('whisper_subscribe: malformed ids never reach helix', async () => {
    const h = load()
    for (const args of [
      { sessionId: '', userId: '4242' },
      { sessionId: 'AQoQexample-session_id', userId: 'not-a-number' },
      { sessionId: 'x'.repeat(500), userId: '4242' },
      { sessionId: 'a b/../c', userId: '4242' },
      {},
    ]) {
      const r = await ask(h.branch, { type: 'twitch_helix', op: 'whisper_subscribe', args }, sender())
      expect(r).toEqual({ ok: false, error: 'bad_args' })
    }
    expect(h.calls.fetches).toHaveLength(0)
  })

  test('only the two named ops exist: no caller-chosen url, no generic proxy', async () => {
    const h = load()
    for (const op of ['', 'proxy', 'fetch', '../users', 'self_id/../x']) {
      const r = await ask(
        h.branch,
        { type: 'twitch_helix', op, url: 'https://evil.example/', args: { url: 'https://evil.example/' } },
        sender(),
      )
      expect(r).toEqual({ ok: false, error: 'unknown_op' })
    }
    expect(h.calls.fetches).toHaveLength(0)
  })

  test('no login: nothing is sent to helix', async () => {
    const h = load({ cookies: {} })
    expect(await ask(h.branch, { type: 'twitch_helix', op: 'self_id' }, sender())).toEqual({
      ok: false,
      error: 'no_token',
    })
    expect(h.calls.fetches).toHaveLength(0)
  })

  test('a network failure answers ok:false, never an unhandled rejection', async () => {
    const h = load({
      fetchImpl: async () => {
        throw new Error('offline')
      },
    })
    expect(await ask(h.branch, { type: 'twitch_helix', op: 'self_id' }, sender())).toEqual({
      ok: false,
      error: 'offline',
    })
  })

  test('refused for heatsync.org and subframes: nothing read, nothing sent', async () => {
    const h = load()
    for (const from of [onTab('https://heatsync.org/'), sender({ frameId: 4 })]) {
      expect(await ask(h.branch, { type: 'twitch_helix', op: 'self_id' }, from)).toEqual({
        ok: false,
        error: 'unauthorized sender',
      })
    }
    expect(h.calls.cookieReads).toBe(0)
    expect(h.calls.fetches).toHaveLength(0)
  })
})

describe('twitch_gql_authed (runs a query as the twitch login)', () => {
  test('refused for heatsync.org and subframes before the cookie is read', async () => {
    const h = load()
    for (const from of [onTab('https://heatsync.org/'), sender({ frameId: 4 })]) {
      expect(await ask(h.gqlBranch, { type: 'twitch_gql_authed', query: '{ currentUser { id } }' }, from)).toEqual({
        ok: false,
        error: 'unauthorized sender',
      })
    }
    expect(h.calls.cookieReads).toBe(0)
  })
})

describe('twitch_gql_authed op allowlist (end to end through the handler)', () => {
  test('an unknown query is refused before the cookie is read or anything is sent', async () => {
    const h = load()
    const r = await ask(h.gqlBranch, { type: 'twitch_gql_authed', query: '{ currentUser { email } }' }, sender())
    expect(r).toEqual({ ok: false, error: 'op_not_allowed' })
    expect(h.calls.cookieReads).toBe(0)
    expect(h.calls.fetches).toHaveLength(0)
  })

  test('a known shape goes through as the login', async () => {
    const h = load({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: { currentUser: { login: 'x' } } }) }),
    })
    const r = await ask(h.gqlBranch, { type: 'twitch_gql_authed', query: '{ currentUser { login } }' }, sender())
    expect(r.ok).toBe(true)
    expect(h.calls.fetches[0].opts.headers.Authorization).toBe(`OAuth ${SECRET}`)
  })
})

describe('the content scripts: the value is asked for by the chat socket and nothing else', () => {
  const MC = join(import.meta.dir, '..', 'src', 'multichat')
  const files = readdirSync(MC).filter((f) => f.endsWith('.js'))
  const read = (f) => readFileSync(join(MC, f), 'utf8')

  test('get_twitch_auth_token is sent from exactly one place', () => {
    const hits = files.filter((f) => read(f).includes("type: 'get_twitch_auth_token'"))
    expect(hits).toEqual(['input.js'])
  })

  test('getTwitchAuthTokenAsync is used only where the chat socket is opened (plus the dev hooks)', () => {
    const users = {}
    for (const f of files) {
      const n = (read(f).match(/getTwitchAuthTokenAsync\(/g) || []).length
      if (n) users[f] = n
    }
    // input.js: its definition + the two send paths that open the socket.
    // bootstrap.js: two dev-build-only hooks that never ship (__HS_DEV_BUILD__).
    expect(Object.keys(users).sort()).toEqual(['input.js'])
    expect(users['input.js']).toBe(3)
  })

  test('the eventsub whisper socket holds no token and sends no authorization header', () => {
    const src = read('eventsub-whispers.js')
    expect(src).not.toMatch(/Authorization|Bearer|getTwitchAuthToken/)
    expect(src).not.toMatch(/api\.twitch\.tv/)
  })

  test('presence checks use the status call', () => {
    for (const f of ['whispers.js', 'cross-follow.js']) expect(read(f)).not.toMatch(/getTwitchAuthTokenAsync/)
    expect(read('whispers.js')).toContain('getTwitchLoginAsync')
    expect(read('cross-follow.js')).toContain('getTwitchLoginAsync')
  })
})

/**
 * D5: the shared-chat chip named nothing but 'shared' — the partner
 * channel's numeric room id was captured (irc.js/native-tap.js, see
 * tests/irc-parser.test.js + tests/native-tap-normalize.test.js) but never
 * resolved to a login. resolveTwitchLoginById() in chrome/background.js is
 * that resolver — same public GQL endpoint + in-memory LRU pattern as the
 * existing lookupTwitchUserId() (login → id), just the reverse direction.
 *
 * background.js can't be imported (see tests/background-helpers.test.js's
 * header) — this extracts the exact source via marker slicing, same
 * technique used there for fetchFFZChannelEmotes/fetchKickChannelEmotes.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BG_SRC = readFileSync(new URL('../chrome/background.js', import.meta.url), 'utf8')
const ROOT = join(import.meta.dir, '..')
const MAIN = readFileSync(join(ROOT, 'src', 'multichat', 'main.js'), 'utf8')
const ROWS_CSS = readFileSync(join(ROOT, 'src', 'multichat', 'styles', '08-message-rows.css'), 'utf8')

function sliceBetween(startMarker, endMarker) {
  const s = BG_SRC.indexOf(startMarker)
  if (s === -1) throw new Error(`sliceBetween: start marker not found: ${startMarker}`)
  const e = BG_SRC.indexOf(endMarker, s)
  if (e === -1) throw new Error(`sliceBetween: end marker not found: ${endMarker}`)
  return BG_SRC.slice(s, e)
}

const resolverSrc = sliceBetween('const twitchLoginCache = new Map()', 'async function resolveAvatarUrl')

function makeHarness({ responses = [] } = {}) {
  const calls = []
  const queue = [...responses]
  const fetchWithTimeout = async (url, opts) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null })
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (!next) throw new Error('shared-chat-login test harness: no stub response left')
    return next
  }
  const harness = new Function(
    'fetchWithTimeout',
    'log',
    `${resolverSrc}\nreturn { resolveTwitchLoginById, twitchLoginCache, TWITCH_LOGIN_CACHE_MAX }`,
  )(fetchWithTimeout, () => {})
  return { ...harness, calls }
}

const ok = (login) => ({ ok: true, json: async () => ({ data: { user: login ? { login } : null } }) })
const httpFail = () => ({ ok: false })

describe('resolveTwitchLoginById', () => {
  test('resolves a numeric channel id to its login via the public GQL endpoint', async () => {
    const h = makeHarness({ responses: [ok('asmongold')] })
    expect(await h.resolveTwitchLoginById('123456')).toBe('asmongold')
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].url).toBe('https://gql.twitch.tv/gql')
    expect(h.calls[0].body.query).toContain('id: "123456"')
    expect(h.calls[0].body.query).toContain('login')
  })

  test('strips non-digit characters from the id before querying', async () => {
    const h = makeHarness({ responses: [ok('mellen')] })
    await h.resolveTwitchLoginById('abc123xyz')
    expect(h.calls[0].body.query).toContain('id: "123"')
  })

  test('a second lookup for the same id hits the cache, not the network', async () => {
    const h = makeHarness({ responses: [ok('asmongold')] })
    await h.resolveTwitchLoginById('123456')
    expect(await h.resolveTwitchLoginById('123456')).toBe('asmongold')
    expect(h.calls).toHaveLength(1)
  })

  test('an unresolvable id (empty/non-numeric) returns null without a fetch', async () => {
    const h = makeHarness()
    expect(await h.resolveTwitchLoginById('')).toBeNull()
    expect(await h.resolveTwitchLoginById(null)).toBeNull()
    expect(h.calls).toHaveLength(0)
  })

  test('a failed GQL response returns null, not a throw', async () => {
    const h = makeHarness({ responses: [httpFail()] })
    expect(await h.resolveTwitchLoginById('123456')).toBeNull()
  })

  test('a GQL response with no matching user returns null', async () => {
    const h = makeHarness({ responses: [ok(null)] })
    expect(await h.resolveTwitchLoginById('999999')).toBeNull()
  })

  test('a thrown fetch never surfaces — resolves null', async () => {
    const h = makeHarness()
    h.resolveTwitchLoginById // sanity: harness built
    const throwing = new Function('fetchWithTimeout', 'log', `${resolverSrc}\nreturn { resolveTwitchLoginById }`)(
      async () => {
        throw new Error('network down')
      },
      () => {},
    )
    expect(await throwing.resolveTwitchLoginById('123456')).toBeNull()
  })
})

describe('resolve_twitch_login_by_id message wiring', () => {
  test('background.js registers the handler', () => {
    expect(BG_SRC).toContain("message.type === 'resolve_twitch_login_by_id'")
    expect(BG_SRC).toContain('await resolveTwitchLoginById(message.userId)')
  })
})

describe('shared-chat chip wiring in main.js', () => {
  test('the source room id is stamped on the row for later retroactive resolve', () => {
    expect(MAIN).toContain('div.dataset.hsSharedRoom = m.sourceRoomId')
  })
  test('a resolved login is applied synchronously on a cache hit', () => {
    expect(MAIN).toContain('div.dataset.hsSharedLogin = cachedLogin')
  })
  test('an unresolved room id triggers exactly one background lookup', () => {
    expect(MAIN).toContain("safeSendMessage({ type: 'resolve_twitch_login_by_id', userId: roomId })")
    // pending (null) and failed ('') both skip re-firing — only a true cache
    // miss (undefined) calls the resolver.
    expect(MAIN).toContain('cachedLogin === undefined) resolveSharedChatLogin(m.sourceRoomId)')
  })
})

describe('shared-chat chip CSS', () => {
  test('the base chip still reads plain "shared" (no login resolved yet / non-twitch)', () => {
    expect(ROWS_CSS).toMatch(/\.hs-mc-msg\.hs-mc-shared::before\s*{\s*content: 'shared';/)
  })
  test('a resolved login upgrades the chip via attr(), never inline JS text', () => {
    expect(ROWS_CSS).toContain(
      ".hs-mc-msg.hs-mc-shared[data-hs-shared-login]::before {\n      content: 'shared:' attr(data-hs-shared-login);",
    )
  })
})

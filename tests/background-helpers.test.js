/**
 * Unit tests for pure helpers embedded in chrome/background.js.
 *
 * background.js is NOT part of the src/ build pipeline — build.js copies it
 * into the package byte-for-byte (see build.js ~line 334), and it is a single
 * 10k-line non-ESM script that registers chrome.runtime.onMessage /
 * chrome.alarms listeners at the top level. It cannot be safely imported as a
 * module (doing so would require a large chrome.* stub harness and risks
 * false confidence from partially-stubbed init races), so per the task rules
 * it is not modified and not imported directly.
 *
 * A handful of its ~164 top-level functions are genuinely pure (or
 * near-pure, closing only over sibling constants also defined at top level)
 * and are NOT duplicated anywhere in src/ — unlike userKey/userSetMatches
 * and sanitizeUiSettings, which ARE canonically defined in src/lib/ and
 * already covered by tests/user-key.test.js + tests/sanitize-ui-settings.test.js
 * (background.js's copies are explicitly-commented duplicates for service-
 * worker bundling reasons, kept in sync by hand).
 *
 * For those background.js-only pure helpers (chKey/splitChKey composite key
 * round-trip, absUrl, sanitizeEmote/sanitizeEmoteList's CDN allowlist) this
 * file extracts their exact source text out of the real file via marker-
 * based slicing (never copy-pasted by hand) and evaluates it in an isolated
 * scope with `new Function`, mirroring the eval-harness pattern already used
 * in tests/cleanup.test.js and tests/error-reporter.test.js, and the same
 * marker-extraction technique build.js itself uses for the error-reporter
 * parity check. Every extractor throws loudly if its marker goes missing —
 * source drift fails the test suite instead of silently testing stale logic.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const BG_SRC = readFileSync(new URL('../chrome/background.js', import.meta.url), 'utf8')

/** Extract `function name(...) { ... }` up to its closing brace on its own line. */
function extractFn(name) {
  const marker = `function ${name}(`
  const start = BG_SRC.indexOf(marker)
  if (start === -1) {
    throw new Error(`extractFn: "${name}" not found in chrome/background.js — source drifted, update this test`)
  }
  const end = BG_SRC.indexOf('\n}', start)
  if (end === -1) throw new Error(`extractFn: "${name}" has no closing "\\n}" — source drifted, update this test`)
  return BG_SRC.slice(start, end + 2)
}

/** Extract a single-line `const NAME = ...` declaration. */
function extractConstLine(name) {
  const m = BG_SRC.match(new RegExp(`^const ${name}\\s*=.*$`, 'm'))
  if (!m) throw new Error(`extractConstLine: "${name}" not found in chrome/background.js`)
  return m[0]
}

/** Slice raw source between two literal markers (start inclusive, end exclusive). */
function sliceBetween(startMarker, endMarker) {
  const s = BG_SRC.indexOf(startMarker)
  if (s === -1) throw new Error(`sliceBetween: start marker not found: ${startMarker}`)
  const e = BG_SRC.indexOf(endMarker, s)
  if (e === -1) throw new Error(`sliceBetween: end marker not found: ${endMarker}`)
  return BG_SRC.slice(s, e)
}

// ── chKey / splitChKey ───────────────────────────────────────────────────────

const { chKey, splitChKey } = new Function(
  `${extractFn('chKey')}\n${extractFn('splitChKey')}\nreturn { chKey, splitChKey }`,
)()

describe('chKey (composite channelEmotesMap key)', () => {
  test('joins platform + lowercased channel with /', () => {
    expect(chKey('twitch', 'Alice')).toBe('twitch/alice')
  })
  test('defaults platform to "twitch" when falsy', () => {
    expect(chKey(null, 'Alice')).toBe('twitch/alice')
    expect(chKey('', 'Alice')).toBe('twitch/alice')
    expect(chKey(undefined, 'Alice')).toBe('twitch/alice')
  })
  test('defaults channel to empty string when falsy', () => {
    expect(chKey('kick', null)).toBe('kick/')
  })
  test('kick platform is preserved (not defaulted away)', () => {
    expect(chKey('kick', 'xqc')).toBe('kick/xqc')
  })
})

describe('splitChKey (inverse of chKey)', () => {
  test('splits platform/channel on the first slash', () => {
    expect(splitChKey('kick/xqc')).toEqual({ platform: 'kick', channel: 'xqc' })
  })
  test('round-trips through chKey for every platform', () => {
    for (const [platform, ch] of [
      ['twitch', 'alice'],
      ['kick', 'bob'],
      ['youtube', 'carol'],
    ]) {
      expect(splitChKey(chKey(platform, ch))).toEqual({ platform, channel: ch })
    }
  })
  test('a channel name that itself contains a slash only splits on the FIRST slash', () => {
    // real channel names can't contain slashes, but the split logic should still
    // be defensive: everything after the first slash is the channel, verbatim.
    expect(splitChKey('twitch/foo/bar')).toEqual({ platform: 'twitch', channel: 'foo/bar' })
  })
  test('no slash at all defaults to twitch with the whole string as channel', () => {
    expect(splitChKey('justachannel')).toEqual({ platform: 'twitch', channel: 'justachannel' })
  })
  test('non-string input is coerced to string first', () => {
    expect(splitChKey(123)).toEqual({ platform: 'twitch', channel: '123' })
  })
})

// ── absUrl ───────────────────────────────────────────────────────────────────

const { absUrl } = new Function(`${extractConstLine('API_URL')}\n${extractFn('absUrl')}\nreturn { absUrl }`)()

describe('absUrl (relative → absolute emote URL)', () => {
  test('relative path is prefixed with API_URL', () => {
    expect(absUrl('/uploads/foo.png')).toBe('https://heatsync.org/uploads/foo.png')
  })
  test('already-absolute URL passes through unchanged', () => {
    expect(absUrl('https://cdn.7tv.app/emote/x/1x.webp')).toBe('https://cdn.7tv.app/emote/x/1x.webp')
  })
  test('falsy input passes through unchanged (no crash on null/empty)', () => {
    expect(absUrl(null)).toBeNull()
    expect(absUrl('')).toBe('')
    expect(absUrl(undefined)).toBeUndefined()
  })
})

// ── sanitizeEmote / sanitizeEmoteList (CDN allowlist — security boundary) ───

const sanitizeEmoteSrc =
  sliceBetween('const EMOTE_CDN_PATTERN =', 'function sanitizeEmote(') +
  extractFn('sanitizeEmote') +
  '\n' +
  extractFn('sanitizeEmoteList') +
  '\nreturn { sanitizeEmote, sanitizeEmoteList }'
const { sanitizeEmote, sanitizeEmoteList } = new Function(sanitizeEmoteSrc)()

describe('sanitizeEmote (validates 3rd-party API emote objects before caching)', () => {
  test('valid emote from an allowlisted CDN passes through unchanged', () => {
    const e = { name: 'Kappa', url: 'https://cdn.7tv.app/emote/x/1x.webp' }
    expect(sanitizeEmote(e)).toBe(e)
  })
  test('every allowlisted CDN host is accepted', () => {
    const hosts = [
      'https://cdn.betterttv.net/e/1',
      'https://cdn.7tv.app/e/1',
      'https://cdn.frankerfacez.com/e/1',
      'https://static-cdn.jtvnw.net/e/1',
      'https://heatsync.org/e/1',
      'https://files.kick.com/e/1',
    ]
    for (const url of hosts) {
      expect(sanitizeEmote({ name: 'x', url })).not.toBeNull()
    }
  })
  test('rejects a non-allowlisted host (e.g. an attacker-controlled CDN)', () => {
    expect(sanitizeEmote({ name: 'Evil', url: 'https://evil.example.com/x.png' })).toBeNull()
  })
  test('rejects a host that merely CONTAINS an allowlisted substring (e.g. jtvnw.net.evil.com)', () => {
    expect(sanitizeEmote({ name: 'x', url: 'https://static-cdn.jtvnw.net.evil.com/x.png' })).toBeNull()
  })
  test('rejects non-https (protocol-relative or http downgrade)', () => {
    expect(sanitizeEmote({ name: 'x', url: 'http://cdn.7tv.app/e/1' })).toBeNull()
    expect(sanitizeEmote({ name: 'x', url: '//cdn.7tv.app/e/1' })).toBeNull()
  })
  test('rejects javascript: URLs outright (not an allowlisted host)', () => {
    expect(sanitizeEmote({ name: 'x', url: 'javascript:alert(1)' })).toBeNull()
  })
  test('rejects missing/non-string name or url', () => {
    expect(sanitizeEmote(null)).toBeNull()
    expect(sanitizeEmote({ url: 'https://cdn.7tv.app/e/1' })).toBeNull()
    expect(sanitizeEmote({ name: 'x' })).toBeNull()
    expect(sanitizeEmote({ name: 123, url: 'https://cdn.7tv.app/e/1' })).toBeNull()
  })
  test('rejects empty name', () => {
    expect(sanitizeEmote({ name: '', url: 'https://cdn.7tv.app/e/1' })).toBeNull()
  })
  test('rejects name longer than 100 chars', () => {
    expect(sanitizeEmote({ name: 'x'.repeat(101), url: 'https://cdn.7tv.app/e/1' })).toBeNull()
  })
  test('accepts name exactly 100 chars (boundary)', () => {
    expect(sanitizeEmote({ name: 'x'.repeat(100), url: 'https://cdn.7tv.app/e/1' })).not.toBeNull()
  })
})

describe('sanitizeEmoteList', () => {
  test('filters out invalid entries, keeps valid ones', () => {
    const list = [
      { name: 'Good', url: 'https://cdn.7tv.app/e/1' },
      { name: 'Bad', url: 'https://evil.example.com/x' },
      { name: '', url: 'https://cdn.7tv.app/e/2' },
    ]
    const out = sanitizeEmoteList(list)
    expect(out.length).toBe(1)
    expect(out[0].name).toBe('Good')
  })
  test('caps to MAX_EMOTES_PER_SOURCE (5000) — DoS guard on a malicious/buggy API response', () => {
    const huge = Array.from({ length: 6000 }, (_, i) => ({
      name: `e${i}`,
      url: 'https://cdn.7tv.app/e/1',
    }))
    expect(sanitizeEmoteList(huge).length).toBe(5000)
  })
  test('empty list → empty list', () => {
    expect(sanitizeEmoteList([])).toEqual([])
  })
})

// ── bgIrcParseLine / bgIrcRecordToExt: reply-parent-user-id parity ─────────
//
// background.js runs its OWN duplicate IRC-tag parser (bgIrcParseLine) and its
// own EventSub-record→ext converter (bgIrcRecordToExt) — separate from
// src/multichat/irc.js's parseIrcLine, which already threads
// reply-parent-user-id into replyTo.userId (see tests/irc-parser.test.js).
// These two background.js copies had drifted: both built a replyTo object
// that dropped the uid entirely, so a reply-context chip for a user unknown
// to knownUserIds at render time could never get data-uid, and so could never
// paint (live-verified: a.hs-mc-reply-user[data-uid] absent). Fixed by
// threading tags['reply-parent-user-id'] / rec.replyTo.userId through, same
// as parseIrcLine already does.

const { bgIrcParseLine, bgIrcRecordToExt } = new Function(
  `${extractConstLine('BG_IRC_COLOR_RE')}\n${extractFn('bgIrcTagUnescape')}\n${extractFn('bgIrcParseTags')}\n${extractFn('bgIrcSanitizeColor')}\n${extractFn('bgIrcParseEmotesTag')}\n${extractFn('bgIrcParseLine')}\n${extractFn('bgIrcRecordToExt')}\nreturn { bgIrcParseLine, bgIrcRecordToExt }`,
)()

describe('bgIrcParseLine — reply-parent-user-id threading (background.js live IRC path)', () => {
  test('reply-parent tags build a replyTo object including userId', () => {
    const raw =
      '@display-name=Bob;reply-parent-display-name=Alice;reply-parent-msg-body=hello\\sthere;reply-parent-msg-id=m1;reply-parent-user-id=u1;reply-thread-parent-msg-id=t1 :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :reply text'
    const msg = bgIrcParseLine(raw, 'chan')
    expect(msg.replyTo).toEqual({
      user: 'Alice',
      text: 'hello there',
      id: 'm1',
      userId: 'u1',
      threadId: 't1',
    })
  })
  test('no reply-parent-user-id tag → replyTo.userId is empty string, never undefined', () => {
    const raw =
      '@display-name=Bob;reply-parent-display-name=Alice;reply-parent-msg-id=m1 :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :reply text'
    const msg = bgIrcParseLine(raw, 'chan')
    expect(msg.replyTo.userId).toBe('')
  })
  test('no reply tags at all → replyTo is null', () => {
    const raw = '@display-name=Bob :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :hi'
    expect(bgIrcParseLine(raw, 'chan').replyTo).toBeNull()
  })
})

// ── splitIncomingUiState (server ui-state fanout → sync vs overflow split) ──
//
// background.js's own duplicate of sanitizeUiSettings/UI_SYNC_BLOCKLIST/
// DEVICE_LOCAL_KEYS/OVERFLOW_MIRROR_KEYS/LARGE_KEY_SYNC_MAX (kept in parity
// with src/lib/utils.js by build.js's checkUiSyncBlocklistParity guard) feeds
// this splitter, used by the ui-state:update / settings:patch handlers to
// route large blocklist prefs (keywordHighlights/chatFilterRules) to their
// chrome.storage.local overflow keys instead of chrome.storage.sync.

const splitIncomingUiStateSrc =
  sliceBetween('const UI_SYNC_BLOCKLIST =', 'function splitIncomingUiState(') +
  extractFn('splitIncomingUiState') +
  '\nreturn { splitIncomingUiState }'
const { splitIncomingUiState } = new Function(splitIncomingUiStateSrc)()

describe('splitIncomingUiState', () => {
  test('ordinary sync-scope keys go to `sync`', () => {
    const { sync, overflow } = splitIncomingUiState({ zebra: true, timestamps: false })
    expect(sync).toEqual({ zebra: true, timestamps: false })
    expect(overflow).toEqual({})
  })

  test('keywordHighlights/chatFilterRules go to `overflow` under their mirror key names', () => {
    const { sync, overflow } = splitIncomingUiState({
      zebra: true,
      keywordHighlights: 'foo\nbar',
      chatFilterRules: '[]',
    })
    expect(sync).toEqual({ zebra: true })
    expect(overflow).toEqual({ keyword_highlights: 'foo\nbar', chat_filter_rules: '[]' })
  })

  test('platformFilters (device-local) is dropped entirely — not in sync or overflow', () => {
    const { sync, overflow } = splitIncomingUiState({ zebra: true, platformFilters: { tab1: { twitch: false } } })
    expect(sync).toEqual({ zebra: true })
    expect(overflow).toEqual({})
  })

  test('oversized large-key value is dropped, not adopted', () => {
    const { overflow } = splitIncomingUiState({ keywordHighlights: 'x'.repeat(32769) })
    expect(overflow).toEqual({})
  })

  test('value exactly at the 32768 cap is kept', () => {
    const { overflow } = splitIncomingUiState({ chatFilterRules: 'x'.repeat(32768) })
    expect(overflow).toEqual({ chat_filter_rules: 'x'.repeat(32768) })
  })

  test('non-string large-key values are dropped — overflow bucket is string-only', () => {
    const { overflow } = splitIncomingUiState({
      keywordHighlights: { __proto__: { polluted: true }, sneaky: 'object' },
      chatFilterRules: ['not', 'a', 'string'],
    })
    expect(overflow).toEqual({})
  })

  test('numeric/boolean large-key values are dropped too', () => {
    const { overflow } = splitIncomingUiState({ keywordHighlights: 42, chatFilterRules: true })
    expect(overflow).toEqual({})
  })

  test('non-object input returns empty sync/overflow (no throw)', () => {
    expect(splitIncomingUiState(null)).toEqual({ sync: {}, overflow: {} })
    expect(splitIncomingUiState('nope')).toEqual({ sync: {}, overflow: {} })
  })

  test('sync half is still sanitized (prototype pollution / numeric keys stripped)', () => {
    const { sync } = splitIncomingUiState({ zebra: true, __proto__: { evil: 1 }, 0: 'bad' })
    expect(Object.keys(sync)).toEqual(['zebra'])
  })
})

describe('bgIrcRecordToExt — reply-parent-user-id threading (server EventSub-relay path)', () => {
  test('rec.replyTo.userId is carried through to ext.replyTo.userId', () => {
    const ext = bgIrcRecordToExt(
      {
        type: 'privmsg',
        channel: 'chan',
        displayName: 'Bob',
        userId: '99',
        content: 'hi',
        replyTo: { username: 'Alice', content: 'parent text', messageId: 'm1', userId: 'u1', threadId: 't1' },
      },
      'chan',
    )
    expect(ext.replyTo).toEqual({ user: 'Alice', text: 'parent text', id: 'm1', userId: 'u1', threadId: 't1' })
  })
  test('rec.replyTo with no userId field → ext.replyTo.userId is empty string', () => {
    const ext = bgIrcRecordToExt(
      { type: 'privmsg', channel: 'chan', displayName: 'Bob', content: 'hi', replyTo: { username: 'Alice' } },
      'chan',
    )
    expect(ext.replyTo.userId).toBe('')
  })
  test('no rec.replyTo → ext.replyTo is null', () => {
    const ext = bgIrcRecordToExt({ type: 'privmsg', channel: 'chan', displayName: 'Bob', content: 'hi' }, 'chan')
    expect(ext.replyTo).toBeNull()
  })
})

// ── fetchFFZChannelEmotes — yt-identity skip + room-404 negative cache ───────
//
// Extracted with its two sibling consts + the negative-cache Map so each test
// gets a FRESH cache instance. Dependencies (fetchWithTimeout,
// ytChannelIdCache, sanitizeEmoteList, log) are injected as Function params —
// the real ones are SW-global; stubbing them per-instance keeps the tests
// hermetic and lets us count outbound fetches.
const ffzSrc = sliceBetween('// Negative cache for FFZ room 404s', '// Cache Twitch user IDs')

function makeFfzHarness({ responses = [] } = {}) {
  const calls = []
  const queue = [...responses]
  const fetchWithTimeout = async (url) => {
    calls.push(url)
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (!next) throw new Error('ffz test harness: no stub response left')
    return next
  }
  const ytChannelIdCache = new Map()
  const harness = new Function(
    'fetchWithTimeout',
    'ytChannelIdCache',
    'sanitizeEmoteList',
    'log',
    `${ffzSrc}\nreturn { fetchFFZChannelEmotes, ffzRoom404At, FFZ_ROOM_404_TTL }`,
  )(
    fetchWithTimeout,
    ytChannelIdCache,
    (l) => l,
    () => {},
  )
  return { ...harness, calls, ytChannelIdCache }
}

const ffz404 = () => ({ status: 404, ok: false, body: { cancel() {} } })
const ffz500 = () => ({ status: 500, ok: false, body: { cancel() {} } })
const ffzOk = (sets) => ({ status: 200, ok: true, body: { cancel() {} }, json: async () => ({ sets }) })

describe('fetchFFZChannelEmotes — YouTube identities never hit the FFZ room API', () => {
  test('UC… channel id is skipped without a fetch', async () => {
    const h = makeFfzHarness()
    expect(await h.fetchFFZChannelEmotes('UCq-Fj5jknLsUf-MWSy4_brA')).toEqual([])
    expect(h.calls.length).toBe(0)
  })
  test('@handle is skipped without a fetch', async () => {
    const h = makeFfzHarness()
    expect(await h.fetchFFZChannelEmotes('@mr.beast')).toEqual([])
    expect(h.calls.length).toBe(0)
  })
  test('hyphenated 11-char videoId is skipped without a fetch', async () => {
    const h = makeFfzHarness()
    expect(await h.fetchFFZChannelEmotes('dQw4-9WgXcQ')).toEqual([])
    expect(h.calls.length).toBe(0)
  })
  test('login-shaped key in ytChannelIdCache STILL fetches — linked twitch channels resolve their yt id under the bare login, and gating on the cache killed FFZ for every linked channel', async () => {
    const h = makeFfzHarness({ responses: [ffz404()] })
    h.ytChannelIdCache.set('ludwig', 'UCsomething12345678901234')
    expect(await h.fetchFFZChannelEmotes('ludwig')).toEqual([])
    expect(h.calls.length).toBe(1)
    expect(h.calls[0]).toContain('/v1/room/ludwig')
  })
  test('11-char twitch login (kripparrian shape) still fetches — NOT shape-blocked', async () => {
    const h = makeFfzHarness({ responses: [ffz404()] })
    await h.fetchFFZChannelEmotes('kripparrian')
    expect(h.calls.length).toBe(1)
    expect(h.calls[0]).toContain('/v1/room/kripparrian')
  })
})

describe('fetchFFZChannelEmotes — room 404 negative cache', () => {
  test('404 is fetched once, then served from the negative cache', async () => {
    const h = makeFfzHarness({ responses: [ffz404()] })
    expect(await h.fetchFFZChannelEmotes('deadroom')).toEqual([])
    expect(await h.fetchFFZChannelEmotes('deadroom')).toEqual([])
    expect(await h.fetchFFZChannelEmotes('deadroom')).toEqual([])
    expect(h.calls.length).toBe(1)
  })
  test('negative cache entry expires after FFZ_ROOM_404_TTL', async () => {
    const h = makeFfzHarness({ responses: [ffz404()] })
    await h.fetchFFZChannelEmotes('deadroom')
    h.ffzRoom404At.set('deadroom', Date.now() - h.FFZ_ROOM_404_TTL - 1)
    await h.fetchFFZChannelEmotes('deadroom')
    expect(h.calls.length).toBe(2)
  })
  test('a later 200 clears the expired negative entry', async () => {
    const h = makeFfzHarness({ responses: [ffz404(), ffzOk({})] })
    await h.fetchFFZChannelEmotes('newroom')
    h.ffzRoom404At.set('newroom', Date.now() - h.FFZ_ROOM_404_TTL - 1)
    await h.fetchFFZChannelEmotes('newroom')
    expect(h.ffzRoom404At.has('newroom')).toBe(false)
  })
  test('transient 5xx returns null and is NOT negative-cached', async () => {
    const h = makeFfzHarness({ responses: [ffz500()] })
    expect(await h.fetchFFZChannelEmotes('flakyroom')).toBeNull()
    expect(h.ffzRoom404At.has('flakyroom')).toBe(false)
    await h.fetchFFZChannelEmotes('flakyroom')
    expect(h.calls.length).toBe(2)
  })
  test('mixed-case login is normalized — one cache entry, one fetch', async () => {
    const h = makeFfzHarness({ responses: [ffz404()] })
    await h.fetchFFZChannelEmotes('DeadRoom')
    await h.fetchFFZChannelEmotes('deadroom')
    expect(h.calls.length).toBe(1)
    expect(h.calls[0]).toContain('/v1/room/deadroom')
  })
})

describe('fetchFFZChannelEmotes — success path still parses sets', () => {
  test('emoticons map to name/url/source/hash, modifiers skipped', async () => {
    const sets = {
      1: {
        emoticons: [
          { id: 7, name: 'ffzCool', urls: { 1: '//cdn.frankerfacez.com/emote/7/1' } },
          { id: 8, name: 'ffzW', modifier: true, urls: { 1: '//cdn.frankerfacez.com/emote/8/1' } },
        ],
      },
    }
    const h = makeFfzHarness({ responses: [ffzOk(sets)] })
    const out = await h.fetchFFZChannelEmotes('goodroom')
    expect(out).toEqual([
      { name: 'ffzCool', url: 'https://cdn.frankerfacez.com/emote/7/1', source: 'ffz', hash: 'ffz-7' },
    ])
  })
})

// ── fetchKickChannelEmotes — channel+Global sets merged, Emojis skipped ─────
//
// GET https://kick.com/emotes/{slug} — verified live (2026-07-17, real Chrome
// tab against kick.com/emotes/xqc) to return an array of 3 sets: the
// channel's own (no top-level "name" field — identified by slug/user
// instead), "Global" ({id:"Global", name:"Global", emotes:[...]}), and
// "Emojis" ({id:"Emoji", name:"Emojis", emotes:[...]}). Kick has no separate
// global-emote fetch anywhere in this codebase, so channel + Global both
// join the pool here (same precedent as fetchBTTVChannelEmotes's YouTube
// branch merging channelEmotes + sharedEmotes above). subscribers_only is
// carried through as subscribersOnly — gating on it happens downstream in
// src/multichat/emotes.js's _buildChannelEmoteCache, not here (this function
// just maps/merges, same division of labor as fetchTwitchChannelEmotes's
// tier/emote_type fields).

const kickChannelEmotesSrc = sliceBetween('async function fetchKickChannelEmotes', 'function fetchGlobalEmotes')

function makeKickHarness({ responses = [] } = {}) {
  const calls = []
  const queue = [...responses]
  const fetchWithTimeout = async (url) => {
    calls.push(url)
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (!next) throw new Error('kick test harness: no stub response left')
    return next
  }
  const harness = new Function(
    'fetchWithTimeout',
    'sanitizeEmoteList',
    'log',
    `${kickChannelEmotesSrc}\nreturn { fetchKickChannelEmotes }`,
  )(
    fetchWithTimeout,
    (l) => l,
    () => {},
  )
  return { ...harness, calls }
}

const kick404 = () => ({ status: 404, ok: false, body: { cancel() {} } })
const kick500 = () => ({ status: 500, ok: false, body: { cancel() {} } })
const kickOk = (data) => ({ status: 200, ok: true, body: { cancel() {} }, json: async () => data })

describe('fetchKickChannelEmotes', () => {
  test('fetches the public per-slug endpoint, no credentials', async () => {
    const h = makeKickHarness({ responses: [kick404()] })
    await h.fetchKickChannelEmotes('xqc')
    expect(h.calls).toEqual(['https://kick.com/emotes/xqc'])
  })
  test('404 → genuine empty (channel has no Kick emote sets)', async () => {
    const h = makeKickHarness({ responses: [kick404()] })
    expect(await h.fetchKickChannelEmotes('nobody')).toEqual([])
  })
  test('5xx → null (transient, not empty — caller retries)', async () => {
    const h = makeKickHarness({ responses: [kick500()] })
    expect(await h.fetchKickChannelEmotes('flaky')).toBeNull()
  })
  test('non-array body → empty (defensive against API shape drift)', async () => {
    const h = makeKickHarness({ responses: [kickOk({ not: 'an array' })] })
    expect(await h.fetchKickChannelEmotes('weird')).toEqual([])
  })
  test('channel set (no top-level name) + Global set merge; Emojis set is skipped', async () => {
    const sets = [
      {
        id: 668,
        slug: 'somechan',
        emotes: [{ id: 100, channel_id: 668, name: 'chanPog', subscribers_only: false }],
      },
      {
        id: 'Global',
        name: 'Global',
        emotes: [{ id: 200, channel_id: null, name: 'kickHype', subscribers_only: false }],
      },
      {
        id: 'Emoji',
        name: 'Emojis',
        emotes: [{ id: 300, channel_id: null, name: 'grinning', subscribers_only: false }],
      },
    ]
    const h = makeKickHarness({ responses: [kickOk(sets)] })
    const out = await h.fetchKickChannelEmotes('somechan')
    expect(out).toEqual([
      {
        name: 'chanPog',
        url: 'https://files.kick.com/emotes/100/fullsize',
        source: 'kick',
        hash: '100',
        subscribersOnly: false,
      },
      {
        name: 'kickHype',
        url: 'https://files.kick.com/emotes/200/fullsize',
        source: 'kick',
        hash: '200',
        subscribersOnly: false,
      },
    ])
  })
  test('subscribers_only carries through as subscribersOnly (gating happens downstream, not here)', async () => {
    const sets = [{ id: 1, slug: 'somechan', emotes: [{ id: 101, name: 'subOnly', subscribers_only: true }] }]
    const h = makeKickHarness({ responses: [kickOk(sets)] })
    const out = await h.fetchKickChannelEmotes('somechan')
    expect(out[0].subscribersOnly).toBe(true)
  })
  test('emote missing id or name is skipped', async () => {
    const sets = [
      {
        id: 1,
        slug: 'somechan',
        emotes: [
          { id: null, name: 'noId' },
          { id: 1, name: '' },
          { id: 5, name: 'valid' },
        ],
      },
    ]
    const h = makeKickHarness({ responses: [kickOk(sets)] })
    const out = await h.fetchKickChannelEmotes('somechan')
    expect(out.map((e) => e.name)).toEqual(['valid'])
  })
})

// ── kpNormalizeChatroomModes / kpModeChanges (Kick chat-mode banners) ──────
//
// Kick's Pusher chatroom channel emits ChatroomUpdatedEvent whenever a mod
// changes slow/sub-only/emote-only/followers mode — mirrors Twitch's
// ROOMSTATE→mode_change notice (bgIrcHandleLine, ~line 10571). These two
// pure functions do the parse+diff; _kpHandleChatroomUpdated (not tested
// here — it touches BG_KICK/broadcastToTabs) wires them to the join-replay
// guard and the actual notice emission.

const { kpNormalizeChatroomModes, kpModeChanges } = new Function(
  `${extractFn('kpNormalizeChatroomModes')}\n${extractFn('kpModeChanges')}\nreturn { kpNormalizeChatroomModes, kpModeChanges }`,
)()

describe('kpNormalizeChatroomModes', () => {
  test('maps slow_mode enabled → seconds', () => {
    expect(kpNormalizeChatroomModes({ slow_mode: { enabled: true, message_interval: 5 } })).toEqual({ slow: 5 })
  })
  test('maps slow_mode disabled → 0', () => {
    expect(kpNormalizeChatroomModes({ slow_mode: { enabled: false, message_interval: 5 } })).toEqual({ slow: 0 })
  })
  test('maps subscribers_mode / emotes_mode booleans', () => {
    expect(kpNormalizeChatroomModes({ subscribers_mode: { enabled: true }, emotes_mode: { enabled: false } })).toEqual({
      subsOnly: true,
      emoteOnly: false,
    })
  })
  test('maps followers_mode enabled → min_duration minutes', () => {
    expect(kpNormalizeChatroomModes({ followers_mode: { enabled: true, min_duration: 30 } })).toEqual({
      followersOnly: 30,
    })
  })
  test('maps followers_mode enabled with no min_duration → 0 minutes (on, no wait)', () => {
    expect(kpNormalizeChatroomModes({ followers_mode: { enabled: true } })).toEqual({ followersOnly: 0 })
  })
  test('maps followers_mode disabled → -1 (off, Twitch ROOMSTATE parity)', () => {
    expect(kpNormalizeChatroomModes({ followers_mode: { enabled: false, min_duration: 30 } })).toEqual({
      followersOnly: -1,
    })
  })
  test('account_age / advanced_bot_protection are not mapped (no Twitch equivalent)', () => {
    expect(
      kpNormalizeChatroomModes({
        account_age: { enabled: true, min_duration: 7 },
        advanced_bot_protection: { enabled: true, remaining_time: 60 },
      }),
    ).toEqual({})
  })
  test('nested { chatroom: {...} } variant normalizes identically to the flat shape', () => {
    const flat = kpNormalizeChatroomModes({ slow_mode: { enabled: true, message_interval: 10 } })
    const nested = kpNormalizeChatroomModes({ chatroom: { slow_mode: { enabled: true, message_interval: 10 } } })
    expect(nested).toEqual(flat)
  })
  test('missing/malformed fields are left unset, never crash', () => {
    expect(kpNormalizeChatroomModes(null)).toEqual({})
    expect(kpNormalizeChatroomModes(undefined)).toEqual({})
    expect(kpNormalizeChatroomModes({})).toEqual({})
    expect(kpNormalizeChatroomModes({ slow_mode: 'not an object' })).toEqual({})
  })
  test('partial payload only carries the fields it actually has', () => {
    expect(kpNormalizeChatroomModes({ emotes_mode: { enabled: true } })).toEqual({ emoteOnly: true })
  })
})

describe('kpModeChanges', () => {
  test('all four modes changing produce all four Twitch-parity text lines', () => {
    const prev = { slow: 0, subsOnly: false, emoteOnly: false, followersOnly: -1 }
    const next = { slow: 10, subsOnly: true, emoteOnly: true, followersOnly: 15 }
    expect(kpModeChanges(prev, next)).toEqual([
      'slow mode on (10s)',
      'sub-only mode on',
      'emote-only mode on',
      'follower-only mode on (15m)',
    ])
  })
  test('no changes → empty array', () => {
    const state = { slow: 5, subsOnly: true, emoteOnly: false, followersOnly: 0 }
    expect(kpModeChanges(state, { ...state })).toEqual([])
  })
  test('slow mode off text when slow drops to 0', () => {
    expect(kpModeChanges({ slow: 5 }, { slow: 0 })).toEqual(['slow mode off'])
  })
  test('follower-only 0 minutes renders "on" with no duration suffix', () => {
    expect(kpModeChanges({ followersOnly: -1 }, { followersOnly: 0 })).toEqual(['follower-only mode on'])
  })
  test('follower-only off renders distinct text from on', () => {
    expect(kpModeChanges({ followersOnly: 15 }, { followersOnly: -1 })).toEqual(['follower-only mode off'])
  })
  test('a field absent from `next` produces no change line even if it differs from prev', () => {
    expect(kpModeChanges({ slow: 5 }, { subsOnly: true })).toEqual(['sub-only mode on'])
  })
})

// ── mapRecentArchiveRow / mergeRecentArchiveRows (kick/yt real-history backfill) ──
//
// GET /api/recent/{platform}/{channel} (new, not-yet-deployed endpoint) rows
// → our internal per-platform message shape, then merged/deduped against
// whatever's already in the local buffer. Pure — no fetch, no chrome.* — see
// fetchRecentArchiveRows below for the fail-soft fetch wrapper.

const { mapRecentArchiveRow, mergeRecentArchiveRows } = new Function(
  `${extractConstLine('ARCHIVE_FP_BUCKET_MS')}\n${extractFn('archiveFpAt')}\n${extractFn('mapRecentArchiveRow')}\n${extractFn('mergeRecentArchiveRows')}\nreturn { mapRecentArchiveRow, mergeRecentArchiveRows }`,
)()

describe('mapRecentArchiveRow', () => {
  test('malformed row (null/non-object) → null', () => {
    expect(mapRecentArchiveRow('kick', null)).toBeNull()
    expect(mapRecentArchiveRow('kick', 'nope')).toBeNull()
  })
  test('row with no text → null (an empty chat line is useless, never rendered)', () => {
    expect(mapRecentArchiveRow('kick', { id: '1', sender: 'a' })).toBeNull()
  })
  test('kick: basic mapping — display_name wins over sender, ts→time, platform/color stamped', () => {
    const row = { id: '123', ts: 1700000000000, sender: 'rawuser', display_name: 'RawUser', text: 'hello' }
    const m = mapRecentArchiveRow('kick', row)
    expect(m).toMatchObject({
      id: '123',
      user: 'RawUser',
      text: 'hello',
      time: 1700000000000,
      platform: 'kick',
      color: '#53fc18',
      isHistory: true,
    })
  })
  test('kick: falls back to sender when display_name is absent', () => {
    expect(mapRecentArchiveRow('kick', { sender: 'onlysender', text: 'hi' }).user).toBe('onlysender')
  })
  test('kick: missing id → empty string id (fingerprint-dedup path)', () => {
    expect(mapRecentArchiveRow('kick', { sender: 'x', text: 'hi' }).id).toBe('')
  })
  test('kick: missing ts → time defaults to "now" (a finite timestamp), never crashes', () => {
    const m = mapRecentArchiveRow('kick', { sender: 'x', text: 'hi' })
    expect(typeof m.time).toBe('number')
    expect(Number.isFinite(m.time)).toBe(true)
  })
  test('kick: emote_refs reconstructed into [emote:id:name] tokens at their offsets', () => {
    const row = {
      sender: 'x',
      text: 'gg  nice',
      emote_refs: [{ id: 555, name: 'PogKick', start: 2, end: 2 }],
    }
    expect(mapRecentArchiveRow('kick', row).text).toBe('gg[emote:555:PogKick]  nice')
  })
  test('kick: multiple emote_refs applied back-to-front so earlier offsets stay valid', () => {
    const row = {
      sender: 'x',
      text: 'ab',
      emote_refs: [
        { id: 1, name: 'A', start: 0, end: 0 },
        { id: 2, name: 'B', start: 2, end: 2 },
      ],
    }
    expect(mapRecentArchiveRow('kick', row).text).toBe('[emote:1:A]ab[emote:2:B]')
  })
  test('kick: emote_refs skipped when text already carries [emote: markup', () => {
    const row = { sender: 'x', text: 'already [emote:9:X] here', emote_refs: [{ id: 1, name: 'Y', start: 0, end: 0 }] }
    expect(mapRecentArchiveRow('kick', row).text).toBe('already [emote:9:X] here')
  })
  test('kick: emote_refs without offsets are skipped, not reconstructed (named skip, no crash)', () => {
    const row = { sender: 'x', text: 'plain text', emote_refs: [{ id: 1, name: 'NoOffsets' }] }
    expect(mapRecentArchiveRow('kick', row).text).toBe('plain text')
  })
  test('kick: badges array of {type,version} joins to Twitch/Kick-style string', () => {
    const row = { sender: 'x', text: 'hi', badges: [{ type: 'moderator', version: '1' }] }
    expect(mapRecentArchiveRow('kick', row).badges).toBe('moderator/1')
  })
  test('kick: badges as a raw string pass through unchanged; missing badges → empty string', () => {
    expect(mapRecentArchiveRow('kick', { sender: 'x', text: 'hi', badges: 'mod/1' }).badges).toBe('mod/1')
    expect(mapRecentArchiveRow('kick', { sender: 'x', text: 'hi' }).badges).toBe('')
  })
  test('kick: reply_to object mapped to the same shape kick-chat-backfill uses', () => {
    const row = { sender: 'x', text: 'reply', reply_to: { username: 'Alice', content: 'orig', id: 'm1' } }
    expect(mapRecentArchiveRow('kick', row).replyTo).toEqual({
      user: 'Alice',
      text: 'orig',
      id: 'm1',
      threadId: 'm1',
    })
  })
  test('kick: reply_to absent → replyTo is null', () => {
    expect(mapRecentArchiveRow('kick', { sender: 'x', text: 'hi' }).replyTo).toBeNull()
  })
  test('youtube: badges array passes through as-is ({type,label,url} shape), never joined to a string', () => {
    const badges = [{ type: 'moderator', label: 'Moderator', url: '' }]
    const m = mapRecentArchiveRow('youtube', { sender: 'x', display_name: 'X', text: 'hi', badges })
    expect(m.badges).toEqual(badges)
    expect(m.platform).toBe('youtube')
    expect(m.msgType).toBe('text')
  })
  test('youtube: reply_to is dropped entirely — no replyTo key on the mapped row (named skip)', () => {
    const m = mapRecentArchiveRow('youtube', { sender: 'x', text: 'hi', reply_to: { id: '1' } })
    expect('replyTo' in m).toBe(false)
  })
  test('youtube: missing badges → empty array, not undefined', () => {
    expect(mapRecentArchiveRow('youtube', { sender: 'x', text: 'hi' }).badges).toEqual([])
  })
})

describe('mergeRecentArchiveRows', () => {
  test('dedups by id — existing buffer entry wins, archive dup is dropped', () => {
    const existing = [{ id: 'm1', user: 'a', text: 'orig from live buffer', time: 100 }]
    const rows = [{ id: 'm1', sender: 'a', text: 'stale archive copy', ts: 100 }]
    const { toAdd, merged } = mergeRecentArchiveRows(existing, rows, 'kick')
    expect(toAdd).toEqual([])
    expect(merged).toEqual(existing)
  })
  test('dedups by (user, time, text-prefix) fingerprint when neither row has an id', () => {
    const existing = [{ user: 'a', text: 'hello world', time: 500 }]
    const rows = [{ sender: 'a', text: 'hello world', ts: 500 }]
    const { toAdd } = mergeRecentArchiveRows(existing, rows, 'kick')
    expect(toAdd).toEqual([])
  })
  test('new rows (distinct id) are appended and the merged array is time-sorted', () => {
    const existing = [{ id: 'm2', user: 'a', text: 'second', time: 2000 }]
    const rows = [{ id: 'm1', sender: 'b', text: 'first', ts: 1000 }]
    const { toAdd, merged } = mergeRecentArchiveRows(existing, rows, 'kick')
    expect(toAdd.length).toBe(1)
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2'])
  })
  test('malformed rows in the batch are skipped without breaking the rest', () => {
    const rows = [null, { id: 'm1', sender: 'a', text: 'ok', ts: 1 }, 'garbage']
    const { toAdd } = mergeRecentArchiveRows([], rows, 'kick')
    expect(toAdd.length).toBe(1)
    expect(toAdd[0].id).toBe('m1')
  })
  test('empty existing + empty rows → no-op, merged is the same empty array', () => {
    const existing = []
    const { toAdd, merged } = mergeRecentArchiveRows(existing, [], 'kick')
    expect(toAdd).toEqual([])
    expect(merged).toBe(existing)
  })
  test('cross-id-namespace dup: different ids, same user+text, ts within transport lag → dropped', () => {
    // live-caught row (kick uuid) vs archive row that arrived under a DB row
    // id (legacy row / stale v1 cache) 4s later — same message, id-dedup
    // blind, content fingerprint must catch it
    const existing = [{ id: '8fc26b02-80b1-4db7-a20c-5557846e2ec9', user: 'A', text: 'same message', time: 100000 }]
    const rows = [{ id: '485216420', sender: 'a', display_name: 'A', text: 'same message', ts: 104000 }]
    const { toAdd } = mergeRecentArchiveRows(existing, rows, 'kick')
    expect(toAdd).toEqual([])
  })
  test('fingerprint window respects adjacent buckets (dup lands just across a 10s boundary)', () => {
    const existing = [{ id: 'uuid-1', user: 'a', text: 'boundary msg', time: 9900 }]
    const rows = [{ id: '99', sender: 'a', text: 'boundary msg', ts: 10100 }]
    const { toAdd } = mergeRecentArchiveRows(existing, rows, 'kick')
    expect(toAdd).toEqual([])
  })
  test('genuine repeat of the same text far apart in time is NOT deduped', () => {
    const existing = [{ id: 'uuid-1', user: 'a', text: 'LUL', time: 0 }]
    const rows = [{ id: '99', sender: 'a', text: 'LUL', ts: 60000 }]
    const { toAdd } = mergeRecentArchiveRows(existing, rows, 'kick')
    expect(toAdd.length).toBe(1)
  })
  test('fingerprint is case-insensitive on user (archive stores lowercase login, live may carry display case)', () => {
    const existing = [{ id: 'uuid-1', user: 'BigChatter', text: 'yo', time: 5000 }]
    const rows = [{ id: '77', sender: 'bigchatter', text: 'yo', ts: 5000 }]
    const { toAdd } = mergeRecentArchiveRows(existing, rows, 'kick')
    expect(toAdd).toEqual([])
  })
})

// ── fetchRecentArchiveRows (fail-soft fetch wrapper) ────────────────────────
//
// Every failure mode — 404, 5xx, timeout/network throw, malformed JSON body,
// a non-array `messages` field — must degrade to an empty array, never throw.
// bgKickFetchRecentArchive/bgYtFetchRecentArchive both early-return on an
// empty array, which is exactly "keep current local-buffer behavior."

const fetchRecentArchiveRowsSrc = sliceBetween(
  'async function fetchRecentArchiveRows(',
  'async function bgKickFetchRecentArchive(',
)

function makeRecentArchiveHarness({ responses = [], throwOn } = {}) {
  const calls = []
  const queue = [...responses]
  const fetchWithTimeout = async (url) => {
    calls.push(url)
    if (throwOn?.(url)) throw new Error('network down')
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (!next) throw new Error('recent-archive test harness: no stub response left')
    return next
  }
  const harness = new Function(
    'API_URL',
    'fetchWithTimeout',
    `${fetchRecentArchiveRowsSrc}\nreturn { fetchRecentArchiveRows }`,
  )('https://heatsync.org', fetchWithTimeout)
  return { ...harness, calls }
}

const recent404 = () => ({ status: 404, ok: false })
const recent500 = () => ({ status: 500, ok: false })
const recentOk = (data) => ({ status: 200, ok: true, json: async () => data })
const recentOkBadJson = () => ({
  status: 200,
  ok: true,
  json: async () => {
    throw new Error('invalid json')
  },
})

describe('fetchRecentArchiveRows', () => {
  test('builds the expected URL with platform/channel/limit', async () => {
    const h = makeRecentArchiveHarness({ responses: [recent404()] })
    await h.fetchRecentArchiveRows('kick', 'xqc', 200)
    expect(h.calls).toEqual(['https://heatsync.org/api/recent/kick/xqc?limit=200'])
  })
  test('404 → empty array (endpoint not deployed yet — fail soft)', async () => {
    const h = makeRecentArchiveHarness({ responses: [recent404()] })
    expect(await h.fetchRecentArchiveRows('kick', 'xqc')).toEqual([])
  })
  test('5xx → empty array', async () => {
    const h = makeRecentArchiveHarness({ responses: [recent500()] })
    expect(await h.fetchRecentArchiveRows('youtube', 'UCabc')).toEqual([])
  })
  test('network throw (timeout/abort) → empty array, never rejects', async () => {
    const h = makeRecentArchiveHarness({ responses: [], throwOn: () => true })
    await expect(h.fetchRecentArchiveRows('kick', 'xqc')).resolves.toEqual([])
  })
  test('malformed JSON body → empty array', async () => {
    const h = makeRecentArchiveHarness({ responses: [recentOkBadJson()] })
    expect(await h.fetchRecentArchiveRows('kick', 'xqc')).toEqual([])
  })
  test('non-array messages field → empty array (defensive against API shape drift)', async () => {
    const h = makeRecentArchiveHarness({ responses: [recentOk({ messages: 'not an array' })] })
    expect(await h.fetchRecentArchiveRows('kick', 'xqc')).toEqual([])
  })
  test('ok response with a messages array is returned verbatim', async () => {
    const rows = [{ id: '1', sender: 'a', text: 'hi', ts: 1 }]
    const h = makeRecentArchiveHarness({ responses: [recentOk({ messages: rows })] })
    expect(await h.fetchRecentArchiveRows('kick', 'xqc')).toEqual(rows)
  })
  test('limit is clamped to [1, 800]', async () => {
    const h = makeRecentArchiveHarness({ responses: [recent404(), recent404()] })
    await h.fetchRecentArchiveRows('kick', 'xqc', 5000)
    await h.fetchRecentArchiveRows('kick', 'xqc', 0)
    expect(h.calls[0]).toContain('limit=800')
    expect(h.calls[1]).toContain('limit=1')
  })
})

// ── bgIrcSafeChannel (IRC protocol-line injection guard) ─────────────────────

const { bgIrcSafeChannel } = new Function(`${extractFn('bgIrcSafeChannel')}\nreturn { bgIrcSafeChannel }`)()

describe('bgIrcSafeChannel (JOIN/PART interpolate raw IRC lines)', () => {
  test('passes a normal twitch login through, lowercased', () => {
    expect(bgIrcSafeChannel('NL_Kripp')).toBe('nl_kripp')
  })
  test('strips CRLF so a name cannot inject a second IRC command', () => {
    expect(bgIrcSafeChannel('x\r\nPRIVMSG #victim :hi')).toBe('xprivmsgvictimhi')
  })
  test('drops every character outside [a-z0-9_]', () => {
    expect(bgIrcSafeChannel('a b:c#d,e')).toBe('abcde')
  })
  test('caps at twitch max login length', () => {
    expect(bgIrcSafeChannel('a'.repeat(60))).toHaveLength(25)
  })
  test('nullish / non-string inputs collapse to empty (caller drops the join)', () => {
    expect(bgIrcSafeChannel(null)).toBe('')
    expect(bgIrcSafeChannel(undefined)).toBe('')
    expect(bgIrcSafeChannel({})).toBe('')
  })
  test('a name that is already canonical is a fixed point (storage-restore guard relies on this)', () => {
    for (const ch of ['xqc', 'nl_kripp', 'a1_b2']) expect(bgIrcSafeChannel(ch)).toBe(ch)
  })
})

// ── emote CDN allowlist parity: background.js ↔ early-inject-main.js ─────────

describe('EMOTE_CDN allowlist parity across worlds', () => {
  const EARLY_SRC = readFileSync(new URL('../chrome/early-inject-main.js', import.meta.url), 'utf8')
  const earlyRe = EARLY_SRC.match(/const EMOTE_CDN_RE\s*=\s*\n?\s*(\/\^https[^\n]*\/)/)
  const bgRe = BG_SRC.match(/const EMOTE_CDN_PATTERN\s*=\s*\n?\s*(\/\^https[^\n]*\/)/)

  test('both allowlists are still findable (fails loudly on source drift)', () => {
    expect(earlyRe).not.toBeNull()
    expect(bgRe).not.toBeNull()
  })

  // MAIN-world url-map patching must accept every host the SW accepts, or
  // self-hosted/kick emotes silently fail to patch native img.src.
  const hosts = [
    'https://cdn.heatsync.org/emotes/a.webp',
    'https://heatsync.org/uploads/a.webp',
    'https://files.kick.com/emotes/1/fullsize',
    'https://cdn.7tv.app/emote/1/1x.webp',
    'https://cdn.betterttv.net/emote/1/1x',
    'https://cdn.frankerfacez.com/emote/1/1',
    'https://static-cdn.jtvnw.net/emoticons/v2/1/default/dark/1.0',
  ]
  for (const url of hosts) {
    test(`MAIN-world allowlist accepts ${new URL(url).host}`, () => {
      expect(new Function(`return ${earlyRe[1]}`)().test(url)).toBe(true)
    })
  }
  test('both worlds reject a non-CDN origin', () => {
    for (const m of [earlyRe, bgRe]) {
      expect(new Function(`return ${m[1]}`)().test('https://evil.example/pixel.gif')).toBe(false)
    }
  })
})

// ── getCachedHealth — 24h staleness ages out kill/disabled/ext_hard_min ──────
//
// A bad or deploy-time-cached kill-switch value must not brick an install
// forever once the server that set it has moved on. Extracted with its
// HEALTH_DEFAULT/HEALTH_MAX_AGE_MS deps so the aging math runs against the
// real thresholds, not a hand-copied guess.

const healthSrc = sliceBetween('const HEALTH_URL =', 'async function fetchHealth()')
const healthCacheSrc = sliceBetween('const HEALTH_MAX_AGE_MS =', 'async function getCachedHealth()')
// extractFn's `function ${name}(` marker matches mid-string inside "async
// function ..." and drops the `async` keyword — put it back, or the
// extracted body's `await` throws a syntax error outside an async function.
const getCachedHealthSrc = `async ${extractFn('getCachedHealth')}`
// Real threshold, not a hand-copied guess — used bare (not HEALTH_MAX_AGE_MS)
// so test bodies never read off an unconstructed harness (TDZ).
const HEALTH_MAX_AGE_MS = new Function(`${extractConstLine('HEALTH_MAX_AGE_MS')}\nreturn HEALTH_MAX_AGE_MS`)()

function makeHealthHarness(stored) {
  const browser = { storage: { local: { get: async () => stored } } }
  return new Function(
    'browser',
    `${healthSrc}\n${healthCacheSrc}\n${getCachedHealthSrc}\nreturn { getCachedHealth, HEALTH_DEFAULT, HEALTH_MAX_AGE_MS }`,
  )(browser)
}

describe('getCachedHealth — stale kill-switch fails open', () => {
  test('no cached record → HEALTH_DEFAULT (fail open)', async () => {
    const h = makeHealthHarness({})
    expect(await h.getCachedHealth()).toEqual(h.HEALTH_DEFAULT)
  })
  test('fresh kill:true is honored', async () => {
    const h = makeHealthHarness({
      hs_health: { v: 1, kill: true, disabled: [], ext_hard_min: null, ext_min: '0.0.0', msg: 'down' },
      hs_health_at: Date.now(),
    })
    const health = await h.getCachedHealth()
    expect(health.kill).toBe(true)
    expect(health.msg).toBe('down')
  })
  test('kill:true older than 24h is ignored — fails open', async () => {
    const h = makeHealthHarness({
      hs_health: { v: 1, kill: true, disabled: [], ext_hard_min: null, ext_min: '0.0.0', msg: 'down' },
      hs_health_at: Date.now() - HEALTH_MAX_AGE_MS - 1000,
    })
    const health = await h.getCachedHealth()
    expect(health.kill).toBe(false)
  })
  test('disabled:[...] older than 24h is cleared', async () => {
    const h = makeHealthHarness({
      hs_health: { v: 1, kill: false, disabled: ['multichat'], ext_hard_min: null, ext_min: '0.0.0', msg: null },
      hs_health_at: Date.now() - HEALTH_MAX_AGE_MS - 1000,
    })
    const health = await h.getCachedHealth()
    expect(health.disabled).toEqual([])
  })
  test('ext_hard_min older than 24h is cleared', async () => {
    const h = makeHealthHarness({
      hs_health: { v: 1, kill: false, disabled: [], ext_hard_min: '9.9.9', ext_min: '0.0.0', msg: null },
      hs_health_at: Date.now() - HEALTH_MAX_AGE_MS - 1000,
    })
    const health = await h.getCachedHealth()
    expect(health.ext_hard_min).toBeNull()
  })
  test('missing hs_health_at on an otherwise-killed record is treated as stale — fails open', async () => {
    const h = makeHealthHarness({
      hs_health: { v: 1, kill: true, disabled: [], ext_hard_min: null, ext_min: '0.0.0', msg: null },
    })
    const health = await h.getCachedHealth()
    expect(health.kill).toBe(false)
  })
  test('stale record still keeps non-destructive ext_min/msg', async () => {
    const h = makeHealthHarness({
      hs_health: { v: 1, kill: true, disabled: [], ext_hard_min: null, ext_min: '2.0.0', msg: 'update please' },
      hs_health_at: Date.now() - HEALTH_MAX_AGE_MS - 1000,
    })
    const health = await h.getCachedHealth()
    expect(health.ext_min).toBe('2.0.0')
    expect(health.msg).toBe('update please')
  })
  test('fresh, non-killed record passes through untouched', async () => {
    const stored = {
      hs_health: { v: 1, kill: false, disabled: [], ext_hard_min: null, ext_min: '1.2.3', msg: null },
      hs_health_at: Date.now() - 1000,
    }
    const h = makeHealthHarness(stored)
    expect(await h.getCachedHealth()).toEqual(stored.hs_health)
  })
})

// ── Surface check-in buffer ─────────────────────────────────────────────────
//
// The names that ride the health poll so the server can tell whether a live
// install ever opens the social surface. These live in storage rather than
// memory because an MV3 service worker is evicted freely, and undercounting
// here would understate exactly the surface being measured — so the buffer's
// round-trip is pinned rather than assumed.

const surfaceSrcs = [
  extractConstLine('SURFACE_NAMES'),
  extractConstLine('SURFACE_KEY'),
  `async ${extractFn('noteSurfaceOpen')}`,
  `async ${extractFn('takePendingSurfaces')}`,
  `async ${extractFn('clearPendingSurfaces')}`,
].join('\n')

function makeSurfaceHarness(initial = {}) {
  const store = { ...initial }
  const browser = {
    storage: {
      local: {
        get: async (keys) => {
          const out = {}
          for (const k of keys) if (k in store) out[k] = store[k]
          return out
        },
        set: async (obj) => Object.assign(store, obj),
        remove: async (k) => {
          delete store[k]
        },
      },
    },
  }
  const api = new Function(
    'browser',
    `${surfaceSrcs}\nreturn { noteSurfaceOpen, takePendingSurfaces, clearPendingSurfaces, SURFACE_KEY }`,
  )(browser)
  return { ...api, store }
}

describe('surface check-in buffer', () => {
  test('a noted surface survives to the next poll', async () => {
    const h = makeSurfaceHarness()
    await h.noteSurfaceOpen('feed')
    expect(await h.takePendingSurfaces()).toEqual(['feed'])
  })

  test('the same surface twice is stored once', async () => {
    const h = makeSurfaceHarness()
    await h.noteSurfaceOpen('feed')
    await h.noteSurfaceOpen('feed')
    expect(await h.takePendingSurfaces()).toEqual(['feed'])
  })

  test('a name off the allowlist is never stored', async () => {
    const h = makeSurfaceHarness()
    await h.noteSurfaceOpen('evil')
    await h.noteSurfaceOpen('')
    expect(await h.takePendingSurfaces()).toEqual([])
    expect(h.store[h.SURFACE_KEY]).toBeUndefined()
  })

  test('clearing removes only what was sent', async () => {
    const h = makeSurfaceHarness()
    await h.noteSurfaceOpen('feed')
    const sent = await h.takePendingSurfaces()
    // opened while the request was in flight
    await h.noteSurfaceOpen('dm')
    await h.clearPendingSurfaces(sent)
    expect(await h.takePendingSurfaces()).toEqual(['dm'])
  })

  test('clearing the last name drops the key entirely', async () => {
    const h = makeSurfaceHarness()
    await h.noteSurfaceOpen('feed')
    await h.clearPendingSurfaces(['feed'])
    expect(h.store[h.SURFACE_KEY]).toBeUndefined()
    expect(await h.takePendingSurfaces()).toEqual([])
  })

  test('junk already in storage is filtered on the way out', async () => {
    const h = makeSurfaceHarness({ hs_surfaces_pending: ['feed', 'evil', 42] })
    expect(await h.takePendingSurfaces()).toEqual(['feed'])
  })

  test('a corrupted value reads as empty instead of throwing', async () => {
    const h = makeSurfaceHarness({ hs_surfaces_pending: 'not-an-array' })
    expect(await h.takePendingSurfaces()).toEqual([])
  })
})

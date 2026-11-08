// YouTube innertube fallback tap — pure helpers embedded in chrome/background.js.
//
// This is the last line of yt chat resilience: an on-demand innertube poller
// that opens straight from the service worker once BOTH primaries (server
// relay + DOM tap) have gone silent for YT_TAP_SILENCE_MS, ported from
// heatsync/server/services/youtube-chat.ts. Shape parity with that server
// module is the contract — same renderer id, same field names — so the
// content-script id-dedup (social.js ingestReplayYtMsg) drops overlap with a
// recovering primary silently.
//
// Same extraction technique as tests/background-helpers.test.js and
// tests/kick-native-tap.test.js: slice the exact source text out of
// chrome/background.js by marker (never hand-copied) and eval it in an
// isolated scope with `new Function`. Every extractor throws loudly if its
// marker goes missing — source drift fails the suite instead of silently
// testing stale logic.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bgSource } from './bg-src.js'

const BG_SRC = bgSource()

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

// ── activation / wantedness (pure) ──────────────────────────────────────────

const { ytTapShouldActivate, ytTapWantedExpired } = new Function(
  `${extractConstLine('YT_TAP_SILENCE_MS')}
${extractConstLine('YT_TAP_WANTED_TTL_MS')}
${extractFn('ytTapShouldActivate')}
${extractFn('ytTapWantedExpired')}
return { ytTapShouldActivate, ytTapWantedExpired }`,
)()

describe('ytTapShouldActivate (silence threshold)', () => {
  const now = 1_800_000_000_000
  test('no prior delivery → activate (never observed healthy)', () => {
    expect(ytTapShouldActivate(undefined, now)).toBe(true)
    expect(ytTapShouldActivate(0, now)).toBe(true)
    expect(ytTapShouldActivate(null, now)).toBe(true)
  })
  test('silence just under 5 min → do not activate', () => {
    expect(ytTapShouldActivate(now - 299999, now)).toBe(false)
  })
  test('silence at or over 5 min → activate', () => {
    expect(ytTapShouldActivate(now - 300000, now)).toBe(true)
    expect(ytTapShouldActivate(now - 600000, now)).toBe(true)
  })
  test('fresh delivery → do not activate', () => {
    expect(ytTapShouldActivate(now - 100, now)).toBe(false)
  })
})

describe('ytTapWantedExpired (15 min TTL)', () => {
  const now = 1_800_000_000_000
  test('no wanted timestamp → expired', () => {
    expect(ytTapWantedExpired(undefined, now)).toBe(true)
    expect(ytTapWantedExpired(0, now)).toBe(true)
  })
  test('within TTL → not expired', () => {
    expect(ytTapWantedExpired(now - 899999, now)).toBe(false)
  })
  test('exactly at TTL boundary → not expired (strictly greater-than)', () => {
    expect(ytTapWantedExpired(now - 900000, now)).toBe(false)
  })
  test('past TTL → expired', () => {
    expect(ytTapWantedExpired(now - 900001, now)).toBe(true)
  })
})

// ── continuation / ytInitialData extraction (pure) ──────────────────────────

const { ytTapExtractInitialData, ytTapExtractContinuation } = new Function(
  `${extractFn('ytTapExtractInitialData')}
${extractFn('ytTapExtractContinuation')}
return { ytTapExtractInitialData, ytTapExtractContinuation }`,
)()

describe('ytTapExtractInitialData (both ytInitialData assignment forms)', () => {
  test('window["ytInitialData"] = {...}; form', () => {
    const html = `<script>window["ytInitialData"] = {"foo":"bar"};</script>`
    expect(ytTapExtractInitialData(html)).toEqual({ foo: 'bar' })
  })
  test('var ytInitialData = {...}; form', () => {
    const html = `<script>var ytInitialData = {"foo":"bar"};</script>`
    expect(ytTapExtractInitialData(html)).toEqual({ foo: 'bar' })
  })
  test('neither form present → null', () => {
    expect(ytTapExtractInitialData('<html><body>no data here</body></html>')).toBeNull()
  })
  test('malformed JSON in the matched blob → null (does not throw)', () => {
    const html = `window["ytInitialData"] = {not valid json};`
    expect(ytTapExtractInitialData(html)).toBeNull()
  })
})

describe('ytTapExtractContinuation (all 3 continuation shapes)', () => {
  test('invalidationContinuationData (normal live tick)', () => {
    expect(ytTapExtractContinuation([{ invalidationContinuationData: { continuation: 'INV_TOKEN' } }])).toBe(
      'INV_TOKEN',
    )
  })
  test('timedContinuationData (throttled)', () => {
    expect(ytTapExtractContinuation([{ timedContinuationData: { continuation: 'TIMED_TOKEN' } }])).toBe('TIMED_TOKEN')
  })
  test('reloadContinuationData (hard resync)', () => {
    expect(ytTapExtractContinuation([{ reloadContinuationData: { continuation: 'RELOAD_TOKEN' } }])).toBe(
      'RELOAD_TOKEN',
    )
  })
  test('prefers the first entry when multiple continuations are present', () => {
    expect(
      ytTapExtractContinuation([
        { invalidationContinuationData: { continuation: 'FIRST' } },
        { timedContinuationData: { continuation: 'SECOND' } },
      ]),
    ).toBe('FIRST')
  })
  test('empty or missing continuations → null', () => {
    expect(ytTapExtractContinuation([])).toBeNull()
    expect(ytTapExtractContinuation(undefined)).toBeNull()
    expect(ytTapExtractContinuation([{}])).toBeNull()
  })
})

// ── seenIds dedup + eviction (pure, mutates the passed Set) ─────────────────

const { ytTapSeenIdIsNew } = new Function(`${extractFn('ytTapSeenIdIsNew')}\nreturn { ytTapSeenIdIsNew }`)()

describe('ytTapSeenIdIsNew', () => {
  test('a fresh id is new and gets added', () => {
    const seen = new Set()
    expect(ytTapSeenIdIsNew(seen, 'abc')).toBe(true)
    expect(seen.has('abc')).toBe(true)
  })
  test('a repeated id is a dup', () => {
    const seen = new Set(['abc'])
    expect(ytTapSeenIdIsNew(seen, 'abc')).toBe(false)
  })
  test('an empty/falsy id is always treated as new (never dedup-tracked)', () => {
    const seen = new Set()
    expect(ytTapSeenIdIsNew(seen, '')).toBe(true)
    expect(seen.size).toBe(0)
  })
  test('evicts the oldest 500 once past the 2000 cap', () => {
    const seen = new Set()
    for (let i = 0; i < 2000; i++) seen.add(String(i))
    expect(ytTapSeenIdIsNew(seen, '2000')).toBe(true)
    expect(seen.size).toBe(1501) // 2001 - 500 evicted
    expect(seen.has('0')).toBe(false)
    expect(seen.has('499')).toBe(false)
    expect(seen.has('500')).toBe(true)
    expect(seen.has('2000')).toBe(true)
  })
})

// ── renderer parsers (pure) — full dependency chain for parseActions ────────

const parserSrc = [
  'ytTapSeenIdIsNew',
  'ytTapText',
  'ytTapTimestamp',
  'ytTapParseRuns',
  'ytTapParseTextMessage',
  'ytTapSuperChatColor',
  'ytTapParseSuperChat',
  'ytTapParseSuperSticker',
  'ytTapParseMembership',
  'ytTapParseGiftPurchase',
  'ytTapParseGiftRedemption',
  'ytTapParseActions',
]
  .map(extractFn)
  .join('\n')

const {
  ytTapParseRuns,
  ytTapParseTextMessage,
  ytTapParseSuperChat,
  ytTapParseMembership,
  ytTapParseActions,
  ytTapSuperChatColor,
} = new Function(`${parserSrc}
return {
  ytTapParseRuns, ytTapParseTextMessage, ytTapParseSuperChat, ytTapParseMembership,
  ytTapParseActions, ytTapSuperChatColor,
}`)()

describe('ytTapParseRuns (text + emoji unicode-vs-image)', () => {
  test('plain text runs concatenate', () => {
    expect(ytTapParseRuns([{ text: 'hello ' }, { text: 'world' }])).toEqual({ text: 'hello world', emotes: [] })
  })
  test('unicode emoji rides as its real char, no emotes entry', () => {
    const runs = [{ emoji: { emojiId: '😀', image: { thumbnails: [{ url: 'https://x/e.png' }] } } }]
    const { text, emotes } = ytTapParseRuns(runs)
    expect(text).toBe('😀')
    expect(emotes).toEqual([])
  })
  test('image-only (yt-exclusive/member) emoji falls back to shortcut alt + emotes entry', () => {
    const runs = [
      {
        emoji: {
          emojiId: 'UCabc123456789012345/custom',
          image: { thumbnails: [{ url: 'https://x/custom.png' }] },
          shortcuts: [':custom:'],
        },
      },
    ]
    const { text, emotes } = ytTapParseRuns(runs)
    expect(text).toBe(':custom:')
    expect(emotes).toEqual([{ type: 'emoji', url: 'https://x/custom.png', alt: ':custom:' }])
  })
  test('no runs → empty', () => {
    expect(ytTapParseRuns(undefined)).toEqual({ text: '', emotes: [] })
  })
})

describe('ytTapParseTextMessage', () => {
  const renderer = {
    id: 'msg-1',
    authorName: { simpleText: 'alice' },
    message: { runs: [{ text: 'hi chat' }] },
    authorExternalChannelId: 'UCalice000000000000000',
    timestampUsec: '1700000000000000',
  }
  test('shape parity: type/user/text/timestamp/authorChannelId', () => {
    const m = ytTapParseTextMessage(renderer, 'vid1')
    expect(m).toEqual({
      type: 'text',
      user: 'alice',
      text: 'hi chat',
      emotes: [],
      timestamp: 1700000000000,
      videoId: 'vid1',
      authorChannelId: 'UCalice000000000000000',
    })
  })
  test('no author name → rejected', () => {
    expect(ytTapParseTextMessage({ ...renderer, authorName: undefined }, 'vid1')).toBeNull()
  })
  test('empty/whitespace-only text → rejected', () => {
    expect(ytTapParseTextMessage({ ...renderer, message: { runs: [{ text: '   ' }] } }, 'vid1')).toBeNull()
  })
})

describe('ytTapSuperChatColor (tier bg matches server SC_TIERS)', () => {
  test.each([
    [0.5, '#1565c0'],
    [2, '#00bfa5'],
    [5, '#00c853'],
    [10, '#ffd600'],
    [20, '#ff6d00'],
    [50, '#e91e63'],
    [100, '#e62117'],
  ])('$%s → %s', (amount, color) => {
    expect(ytTapSuperChatColor(amount)).toBe(color)
  })
})

describe('ytTapParseSuperChat', () => {
  test('parses amount + tier color', () => {
    const renderer = {
      id: 'sc-1',
      authorName: { simpleText: 'bob' },
      message: { runs: [{ text: 'take my money' }] },
      purchaseAmountText: { simpleText: '$25.00' },
      authorExternalChannelId: 'UCbob0000000000000000',
      timestampUsec: '1700000000000000',
    }
    const m = ytTapParseSuperChat(renderer, 'vid1')
    expect(m.type).toBe('superchat')
    expect(m.amount).toBe('$25.00')
    expect(m.color).toBe('#ff6d00')
    expect(m.text).toBe('take my money')
  })
})

describe('ytTapParseMembership', () => {
  test('milestone resub includes the headerPrimaryText line', () => {
    const renderer = {
      id: 'mem-1',
      authorName: { simpleText: 'carol' },
      headerPrimaryText: { simpleText: 'Member for 3 months' },
      authorExternalChannelId: 'UCcarol00000000000000',
    }
    const m = ytTapParseMembership(renderer, 'vid1')
    expect(m.systemMsg).toBe('carol: Member for 3 months')
  })
  test('new member (no milestone) gets the generic greeting', () => {
    const renderer = { id: 'mem-2', authorName: { simpleText: 'dave' }, authorExternalChannelId: 'UCdave0000000000000' }
    const m = ytTapParseMembership(renderer, 'vid1')
    expect(m.systemMsg).toBe('dave became a member')
  })
})

describe('ytTapParseActions (renderer dispatch + id attach + dedup)', () => {
  function textAction(id, text, opts = {}) {
    return {
      addChatItemAction: {
        item: {
          liveChatTextMessageRenderer: {
            id,
            authorName: { simpleText: opts.user || 'alice' },
            message: { runs: [{ text }] },
            authorExternalChannelId: 'UCalice000000000000000',
            timestampUsec: '1700000000000000',
          },
        },
      },
    }
  }
  test('parses a text message and attaches the renderer id', () => {
    const [m] = ytTapParseActions([textAction('id-1', 'hello')], 'vid1')
    expect(m.id).toBe('id-1')
    expect(m.type).toBe('text')
    expect(m.text).toBe('hello')
  })
  test('superchat renderer parses through the dispatch table', () => {
    const action = {
      addChatItemAction: {
        item: {
          liveChatPaidMessageRenderer: {
            id: 'sc-1',
            authorName: { simpleText: 'bob' },
            message: { runs: [{ text: 'gg' }] },
            purchaseAmountText: { simpleText: '$5.00' },
          },
        },
      },
    }
    const [m] = ytTapParseActions([action], 'vid1')
    expect(m.type).toBe('superchat')
    expect(m.id).toBe('sc-1')
  })
  test('unknown renderer type is silently skipped, not thrown', () => {
    const action = { addChatItemAction: { item: { liveChatSomeNewRendererType: { id: 'x' } } } }
    expect(ytTapParseActions([action], 'vid1')).toEqual([])
  })
  test('an action with no addChatItemAction.item is skipped', () => {
    expect(ytTapParseActions([{ somethingElseAction: {} }], 'vid1')).toEqual([])
  })
  test('seenIds dedup drops a repeated renderer id', () => {
    const seen = new Set()
    const actions = [textAction('dup-id', 'first'), textAction('dup-id', 'second')]
    const messages = ytTapParseActions(actions, 'vid1', seen)
    expect(messages.length).toBe(1)
    expect(messages[0].text).toBe('first')
    expect(seen.has('dup-id')).toBe(true)
  })
  test('without a seenIds set, no dedup is applied', () => {
    const actions = [textAction('same-id', 'first'), textAction('same-id', 'second')]
    const messages = ytTapParseActions(actions, 'vid1')
    expect(messages.length).toBe(2)
  })
})

/**
 * Regression tests for "every occurrence of the word 'you' renders as a colored
 * mention link in chat" (multichat overlay).
 *
 * highlightMentionsInHtml (src/multichat/main.js) highlights both @mentions and
 * BARE known usernames. The bare branch used to gate on `knownColors.has(lower)`
 * — but knownColors answers "what color do I draw this name in", not "is this
 * name a person". Every @word in chat runs through mentionColor →
 * resolveMentionColor → hsResolveUserColor (src/multichat/input.js), which
 * ALWAYS resolves to some color: heatsync color → twitch chatColor → a
 * deterministic hash-palette fallback that fires even for logins that do not
 * exist. It then writes that color into knownColors via setKnownColor.
 *
 * So a single person typing "@you" anywhere made the literal word "you" a
 * "known user" for the rest of the session — and "you" is not even a
 * registrable twitch login (gql returns null for it). Every plain "you" in
 * every channel then rendered as a bold colored mention anchor.
 *
 * Two gates, both required:
 *   1. the name must be in _ucDisplay — the lowercase mirror of usernameCache,
 *      written only by addUsername from real sender paths, i.e. "we heard this
 *      account actually speak". Color-cache entries never land there.
 *   2. the name must not be an everyday word. "bruh", "what", "yeah", "mods"
 *      and "based" are all REAL twitch accounts, so gate 1 alone still lets a
 *      single chatter turn every use of a common word into a link.
 * @mentions are deliberately unaffected by both gates.
 *
 * highlightMentionsInHtml is a closure-local function inside main.js's IIFE and
 * can't be imported, so this harness evaluates its real source text (plus the
 * real BARE_MENTION_STOPWORDS literal and the real outsideTags from lib/utils)
 * against stubs — a behavioral test, not a source-grep.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { escapeHtml, outsideTags } from '../src/lib/utils.js'

const MAIN_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')

function sliceBetween(marker, endMarker) {
  const start = MAIN_SRC.indexOf(marker)
  if (start === -1) throw new Error(`marker not found: ${marker}`)
  const end = MAIN_SRC.indexOf(endMarker, start)
  if (end === -1) throw new Error(`end marker not found: ${endMarker}`)
  return MAIN_SRC.slice(start, end)
}

// Real source of both the stopword list and the highlighter, evaluated against
// stubs for the surrounding overlay state.
const STOPWORDS_SRC = sliceBetween(
  '  const BARE_MENTION_STOPWORDS = new Set(',
  '  // Highlight @mentions and bare known usernames',
)
const HIGHLIGHT_SRC = sliceBetween(
  '  function highlightMentionsInHtml(html, platform) {',
  '\n  // DOM-node twin of highlightHashtagsInHtml',
)

function makeHighlighter({ colors = [], spoke = [] } = {}) {
  const knownColors = new Map(colors.map((c) => (Array.isArray(c) ? c : [c, '#abcdef'])))
  const _ucDisplay = new Map(spoke.map((u) => [u, u]))
  const resolved = []
  const factory = new Function(
    'outsideTags',
    'escapeHtml',
    'knownColors',
    '_ucDisplay',
    'knownUserIds',
    'userKey',
    'sanitizeColor',
    'mentionColor',
    'resolveMentionColor',
    'mcUserCosmetics',
    'queueMcCosmeticsLookup',
    'hsPaintRender',
    'getMcPaintStyle',
    'paintPhaseNow',
    '_hsUserIdCache',
    `${STOPWORDS_SRC}\n${HIGHLIGHT_SRC}\nreturn highlightMentionsInHtml`,
  )
  const fn = factory(
    outsideTags,
    escapeHtml,
    knownColors,
    _ucDisplay,
    new Map(),
    (u, p) => `${p}:${u}`,
    (c) => c,
    (lower) => {
      resolved.push(lower)
      return knownColors.get(lower) || '#fff'
    },
    (lower) => resolved.push(lower),
    new Map(),
    () => {},
    () => null,
    () => null,
    () => 0,
    new Map(),
  )
  return { fn, resolved, knownColors, _ucDisplay }
}

const anchorsFor = (html, name) =>
  [...html.matchAll(/<a\b[^>]*class="[^"]*hs-mc-mention[^"]*"[^>]*data-username="([^"]*)"/g)]
    .map((m) => m[1])
    .filter((u) => u === name)

describe('bare-word mentions — only names we actually heard speak', () => {
  test('a color-cache-only name (the "@you" poisoning path) never highlights bare', () => {
    // Exactly the reported state: someone typed "@you", hsResolveUserColor's
    // hash-palette fallback wrote a color for it, but "you" never spoke.
    const { fn } = makeHighlighter({ colors: ['you'], spoke: [] })
    const out = fn('do you think you are right', 'twitch')
    expect(anchorsFor(out, 'you')).toHaveLength(0)
    expect(out).toBe('do you think you are right')
  })

  test('a real chatter still highlights bare', () => {
    const { fn } = makeHighlighter({ colors: [['kripp', '#ff8700']], spoke: ['kripp'] })
    const out = fn('kripp is cracked', 'twitch')
    expect(anchorsFor(out, 'kripp')).toHaveLength(1)
    expect(out).toContain('color:#ff8700')
  })

  test('spoke but no color cached — still no bare highlight (would render flat white)', () => {
    const { fn } = makeHighlighter({ colors: [], spoke: ['someguy'] })
    expect(anchorsFor(fn('someguy said so', 'twitch'), 'someguy')).toHaveLength(0)
  })

  test('@mention of a never-seen name is untouched by the spoke gate', () => {
    const { fn } = makeHighlighter({ colors: [], spoke: [] })
    const out = fn('hey @stranger look', 'twitch')
    expect(anchorsFor(out, 'stranger')).toHaveLength(1)
  })
})

describe('bare-word mentions — everyday words are never a mention', () => {
  // Each of these is a REAL twitch login, so gate 1 alone would pass.
  for (const word of ['bruh', 'what', 'yeah', 'mods', 'based']) {
    test(`"${word}" stays plain text even when that account is chatting`, () => {
      const { fn } = makeHighlighter({ colors: [word], spoke: [word] })
      const out = fn(`${word} that was insane`, 'twitch')
      expect(anchorsFor(out, word)).toHaveLength(0)
    })

    test(`"@${word}" still mentions them explicitly`, () => {
      const { fn } = makeHighlighter({ colors: [word], spoke: [word] })
      expect(anchorsFor(fn(`hey @${word} hi`, 'twitch'), word)).toHaveLength(1)
    })
  }

  test('contraction stems are covered — the regex boundary set includes the apostrophe', () => {
    const { fn } = makeHighlighter({ colors: ['don', 'you'], spoke: ['don', 'you'] })
    const out = fn("don't tell me you're wrong", 'twitch')
    expect(anchorsFor(out, 'don')).toHaveLength(0)
    expect(anchorsFor(out, 'you')).toHaveLength(0)
  })

  test('the stopword list is lowercase-only — it is matched against a lowercased name', () => {
    const { fn } = makeHighlighter({ colors: ['what'], spoke: ['what'] })
    expect(anchorsFor(fn('What is that', 'twitch'), 'what')).toHaveLength(0)
  })
})

describe('a tag that drops the underscores is still the person', () => {
  test('@sleepyshaman draws as sleepyshaman___ in his color', () => {
    const { fn } = makeHighlighter({ colors: [['sleepyshaman___', '#f54e00']], spoke: ['sleepyshaman___'] })
    const out = fn('hi @SleepyShaman', 'twitch')
    expect(anchorsFor(out, 'sleepyshaman___')).toHaveLength(1)
    expect(out).toContain('color:#f54e00')
    expect(out).toContain('>@SleepyShaman<')
  })

  test('a tag two chatters could mean stays as typed', () => {
    const { fn } = makeHighlighter({ spoke: ['twin_name', 'twinname_'] })
    expect(anchorsFor(fn('@twinname', 'twitch'), 'twinname')).toHaveLength(1)
  })

  test('a name that spoke exactly as typed is never redirected', () => {
    const { fn } = makeHighlighter({ spoke: ['bob', 'bob_'] })
    expect(anchorsFor(fn('@bob', 'twitch'), 'bob')).toHaveLength(1)
  })
})

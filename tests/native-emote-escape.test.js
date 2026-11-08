/**
 * Regression tests for main.js computeMessageText's twitchExtra map — the
 * per-message Twitch NATIVE emote cache handed to processEmotes.
 *
 * processEmotes receives escapeHtml(m.text), so its per-word lookups see
 * HTML-ESCAPED tokens. Native emote names can contain HTML specials (`<3`,
 * `:-&`-style smilies): keying twitchExtra by the RAW name means `&lt;3`
 * never matches and the emote renders as text. main.js must key the map by
 * escapeHtml(name) — identity for names without specials.
 *
 * The twitchExtra-building block is extracted from main.js source via
 * marker-based slicing and evaluated with injected deps, mirroring the
 * harness pattern in tests/mention-paint-double-anchor.test.js and
 * tests/background-helpers.test.js. Markers going missing fails loudly —
 * source drift breaks the suite instead of silently testing stale logic.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { escapeHtml } from '../src/lib/utils.js'
import { mainSource } from './main-src.js'

const MAIN_SRC = mainSource()

function sliceBetween(startMarker, endMarker) {
  const s = MAIN_SRC.indexOf(startMarker)
  if (s === -1) throw new Error(`sliceBetween: start marker not found: ${startMarker}`)
  const e = MAIN_SRC.indexOf(endMarker, s)
  if (e === -1) throw new Error(`sliceBetween: end marker not found: ${endMarker}`)
  return MAIN_SRC.slice(s, e)
}

const twitchExtraSrc = sliceBetween('let twitchExtra = null', '// Sender-perma emote resolution')

// (m, isOwn, viewerBadgesPerChannel, lookupEmote, escapeHtml) → twitchExtra Map
const buildTwitchExtra = new Function(
  'm',
  'isOwn',
  'viewerBadgesPerChannel',
  'lookupEmote',
  'escapeHtml',
  `${twitchExtraSrc}\nreturn twitchExtra`,
)

const URL25 = 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0'
const URL483 = 'https://static-cdn.jtvnw.net/emoticons/v2/483/default/dark/2.0'

function build(twitchEmotes, { isOwn = true, badges = new Map(), lookup = () => null } = {}) {
  return buildTwitchExtra({ twitchEmotes, channel: 'chan-a' }, isOwn, badges, lookup, escapeHtml)
}

describe('computeMessageText twitchExtra — escape-aware native emote keys', () => {
  test('plain name keys unchanged (escapeHtml is identity)', () => {
    const extra = build({ Kappa: URL25 })
    expect(extra.get('Kappa')).toMatchObject({ url: URL25, source: 'twitch' })
  })

  test('HTML-special name `<3` is keyed by its ESCAPED form — the token processEmotes sees', () => {
    const extra = build({ '<3': URL483 })
    // escapeHtml('<3') === '&lt;3' — the word token inside escapeHtml(m.text)
    expect(extra.get(escapeHtml('<3'))).toMatchObject({ url: URL483, source: 'twitch' })
    expect(extra.get('<3')).toBeUndefined()
  })

  test('name containing & is keyed escaped', () => {
    const extra = build({ ':-&': URL25 })
    expect(extra.get(escapeHtml(':-&'))).toMatchObject({ url: URL25 })
    expect(extra.get(':-&')).toBeUndefined()
  })

  test('lock detection still receives the RAW name (lookupEmote contract unchanged)', () => {
    const seen = []
    build(
      { '<3': URL483 },
      {
        isOwn: false,
        lookup: (name) => {
          seen.push(name)
          return null
        },
      },
    )
    expect(seen).toEqual(['<3'])
  })

  test('no twitchEmotes → twitchExtra stays null', () => {
    expect(build(undefined)).toBeNull()
  })
})

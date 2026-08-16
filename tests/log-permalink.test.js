/**
 * Chat-log permalinks — the citation half of quoting.
 *
 * The `»` thread button used to seed the composer with a retyped copy of the
 * message. heatsync archives the line, so the post can point AT the original
 * instead: /logs/<platform>/<channel>/<utc-day>?m=<message_id> resolves back
 * into the real chat line on heatsync.org AND in the panel.
 *
 * Verified against production while this was written: the Twitch IRC `id` tag
 * is the same value the archive stores as message_id —
 *   id=eca4db81-…-edf805329077 from /api/recent-messages/xqc
 *   resolved through /api/archive/message/twitch/xqc?id=… to that exact line.
 * That equivalence is what makes a live row citable at all.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')

function sliceBetween(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker)
  if (s === -1) throw new Error(`start marker not found: ${startMarker}`)
  const e = src.indexOf(endMarker, s)
  if (e === -1) throw new Error(`end marker not found: ${endMarker}`)
  return src.slice(s, e)
}

// The two pure halves, lifted out of the files they ship in. Both are needed
// together: minting a permalink that the resolver cannot parse back is the one
// failure this pair exists to make impossible.
const builder = sliceBetween(SRC('chat-logs.js'), 'function buildLogPermalink(', '\n// Archive-viewer row')
const parts = sliceBetween(SRC('feed-embed.js'), 'const HS_LOG_PLATFORMS', '\n// First-party quoted chat line')
// Read the origin out of the source too — hardcoding it here would let the
// shipped constant move without a single test noticing.
const origin = sliceBetween(SRC('chat-logs.js'), 'const HS_CL_PUBLIC_ORIGIN', '\n')

const { buildLogPermalink, logPermalinkParts } = new Function(
  `${origin}\n${parts}\n${builder}\nreturn { buildLogPermalink, logPermalinkParts }`,
)()

const MSG = {
  platform: 'twitch',
  channel: 'xqc',
  messageId: 'eca4db81-e5a1-42e3-9173-edf805329077',
  time: 1786906443358, // tmi-sent-ts → 2026-08-16T18:54:03.358Z
}

describe('buildLogPermalink', () => {
  test('mints the URL shape the server serves', () => {
    expect(buildLogPermalink(MSG)).toBe(
      'https://heatsync.org/logs/twitch/xqc/2026-08-16?m=eca4db81-e5a1-42e3-9173-edf805329077',
    )
  })

  test('dates the permalink in UTC, not the reader’s timezone', () => {
    // 23:30 UTC on the 16th. Anyone west of UTC is still on the 15th locally;
    // the archive partitions on the UTC day, so a local date would anchor the
    // link to a page that does not contain the message.
    const url = buildLogPermalink({ ...MSG, time: Date.parse('2026-08-16T23:30:00Z') })
    expect(url).toContain('/2026-08-16?m=')
  })

  test('normalises the channel — a #-prefixed IRC channel is the same channel', () => {
    expect(buildLogPermalink({ ...MSG, channel: '#XQC' })).toContain('/logs/twitch/xqc/')
  })

  test('refuses platforms the archive does not store', () => {
    expect(buildLogPermalink({ ...MSG, platform: 'discord' })).toBeNull()
    expect(buildLogPermalink({ ...MSG, platform: '' })).toBeNull()
  })

  test('refuses a row it cannot date — never guesses "today"', () => {
    expect(buildLogPermalink({ ...MSG, time: 0 })).toBeNull()
    expect(buildLogPermalink({ ...MSG, time: 'not a date' })).toBeNull()
  })

  test('still yields the day page when the message id is missing', () => {
    const url = buildLogPermalink({ ...MSG, messageId: '' })
    expect(url).toBe('https://heatsync.org/logs/twitch/xqc/2026-08-16')
    expect(url).not.toContain('?m=')
  })

  test('escapes a channel that would otherwise break out of the path', () => {
    const url = buildLogPermalink({ ...MSG, channel: 'a/b?c' })
    expect(url).toContain('/logs/twitch/a%2Fb%3Fc/')
  })
})

describe('logPermalinkParts', () => {
  test('round-trips what buildLogPermalink minted', () => {
    expect(logPermalinkParts(buildLogPermalink(MSG))).toEqual({
      platform: 'twitch',
      channel: 'xqc',
      messageId: MSG.messageId,
    })
  })

  test('ignores the date segment — the archive resolves on the id', () => {
    // A message archived a few hundred ms the other side of UTC midnight gets
    // the neighbouring day in its URL. The quote must still resolve; only the
    // click-through lands one page over.
    const wrongDay = 'https://heatsync.org/logs/twitch/xqc/1999-01-01?m=' + MSG.messageId
    expect(logPermalinkParts(wrongDay)?.messageId).toBe(MSG.messageId)
  })

  test('accepts subdomains of heatsync.org, rejects lookalikes', () => {
    expect(logPermalinkParts('https://www.heatsync.org/logs/twitch/xqc/2026-08-16?m=x')).not.toBeNull()
    expect(logPermalinkParts('https://heatsync.org.evil.com/logs/twitch/xqc/2026-08-16?m=x')).toBeNull()
    expect(logPermalinkParts('https://notheatsync.org/logs/twitch/xqc/2026-08-16?m=x')).toBeNull()
  })

  test('rejects a day page with no message to quote', () => {
    expect(logPermalinkParts('https://heatsync.org/logs/twitch/xqc/2026-08-16')).toBeNull()
  })

  test('rejects other heatsync pages and junk', () => {
    expect(logPermalinkParts('https://heatsync.org/moment/123?m=x')).toBeNull()
    expect(logPermalinkParts('https://heatsync.org/logs/discord/x/2026-08-16?m=y')).toBeNull()
    expect(logPermalinkParts('not a url')).toBeNull()
  })
})

/**
 * Row → permalink. buildRowPermalink reads the dataset a live chat row carries.
 *
 * The bug this pins was found by driving a real twitch page: 481 of 494 rows
 * had an EMPTY data-msg-platform, because a twitch IRC message never sets
 * m.platform — only kick and youtube stamp themselves. Every other row reader
 * in the codebase already knew that (`|| 'twitch'` in mod-toolbar.js and
 * input.js); this one did not, so `»` fell back to a retyped quote on all but
 * the handful of rows peekSentHost had retagged.
 */
const rowBuilder = sliceBetween(SRC('chat-logs.js'), 'function buildRowPermalink(', '\nasync function copyChatLogPermalink')

const { buildRowPermalink } = new Function(
  `${origin}\n${parts}\n${builder}\n${rowBuilder}\nreturn { buildRowPermalink }`,
)()

const row = (dataset) => ({ dataset })

describe('buildRowPermalink', () => {
  test('an empty platform is twitch — that is what a twitch row actually looks like', () => {
    const url = buildRowPermalink(
      row({ msgPlatform: '', msgChannel: 'nl_kripp', msgId: MSG.messageId, msgTime: '1786906443358' }),
    )
    expect(url).toBe(`https://heatsync.org/logs/twitch/nl_kripp/2026-08-16?m=${MSG.messageId}`)
  })

  test('a kick row is never mistaken for twitch', () => {
    const url = buildRowPermalink(
      row({ msgPlatform: 'kick', msgChannel: 'nl_kripp', msgId: 'k1', msgTime: '1786906443358' }),
    )
    expect(url).toContain('/logs/kick/nl_kripp/')
  })

  test('a youtube row keeps its own platform too', () => {
    const url = buildRowPermalink(
      row({ msgPlatform: 'youtube', msgChannel: 'somechan', msgId: 'y1', msgTime: '1786906443358' }),
    )
    expect(url).toContain('/logs/youtube/somechan/')
  })

  test('a row with no send time yields nothing rather than a wrong day', () => {
    expect(buildRowPermalink(row({ msgPlatform: '', msgChannel: 'nl_kripp', msgId: 'x' }))).toBeNull()
  })

  test('no row at all is not a crash', () => {
    expect(buildRowPermalink(null)).toBeNull()
  })
})

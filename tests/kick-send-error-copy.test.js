/**
 * D4: the kick send relay used to hand back `${r.status}: ${rawBody}` —
 * kick's raw HTTP status and response body landed straight in the retry
 * toast (e.g. '403: {"status":{"message":"..."}}'). explainKickSendError()
 * maps that to the same plain-english copy twitch's IRC NOTICE handler uses
 * for the equivalent case; kickSendErrorCode() is the separate
 * machine-readable signal kick-send.js's retry logic keys off (never the
 * human text).
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CONTENT = readFileSync(join(import.meta.dir, '..', 'chrome', 'content.js'), 'utf8')

function extractFn(src, name) {
  const marker = `function ${name}(`
  const start = src.indexOf(marker)
  if (start === -1) throw new Error(`extractFn: "${name}" not found — source drifted`)
  const end = src.indexOf('\n  }', start)
  return src.slice(start, end + 4)
}

const { explainKickSendError, kickSendErrorCode } = new Function(
  `${extractFn(CONTENT, 'explainKickSendError')}
   ${extractFn(CONTENT, 'kickSendErrorCode')}
   return { explainKickSendError, kickSendErrorCode }`,
)()

describe('explainKickSendError', () => {
  test('never surfaces the raw body', () => {
    const raw = '{"status":{"message":"You have been banned from this channel."}}'
    expect(explainKickSendError(403, raw)).not.toContain('{')
    expect(explainKickSendError(403, raw)).not.toContain('status')
  })
  test('banned → same copy as twitch mc_irc_notice_banned', () => {
    expect(explainKickSendError(403, '{"message":"You have been banned from this channel"}')).toBe(
      'you are banned from this channel',
    )
  })
  test('followers-only → same copy as twitch mc_irc_notice_followersonly', () => {
    expect(explainKickSendError(403, '{"message":"This chatroom is in followers-only mode"}')).toBe(
      'followers-only mode — follow the channel to chat',
    )
  })
  test('subscribers-only → same copy as twitch mc_irc_notice_subsonly', () => {
    expect(explainKickSendError(403, '{"message":"Subscribers only chatroom"}')).toBe(
      'subscribers-only — sub to chat here',
    )
  })
  test('slow mode → same copy as twitch mc_irc_notice_slowmode', () => {
    expect(explainKickSendError(429, '{"message":"Slow mode is enabled, please wait"}')).toBe(
      'slow mode — please wait a moment',
    )
  })
  test('not authenticated (bearer expired) → session-expired copy', () => {
    expect(explainKickSendError(401, 'User is not authenticated')).toBe(
      "you're not logged into kick (or your session expired)",
    )
    expect(explainKickSendError(403, '')).toBe("you're not logged into kick (or your session expired)")
  })
  test('unrecognized body degrades to a clean generic line, never the raw text', () => {
    expect(explainKickSendError(418, "i'm a teapot, definitely not json")).toBe('kick rejected the message (418)')
  })
  test('5xx → server error line with the status', () => {
    expect(explainKickSendError(503, 'upstream unavailable')).toBe('kick server error (503)')
  })
})

describe('kickSendErrorCode', () => {
  test('flags INVALID_EMOTE_ERROR bodies so the retry logic can strip tokens', () => {
    expect(kickSendErrorCode('{"message":"INVALID_EMOTE_ERROR"}')).toBe('invalid_emote')
  })
  test('everything else is null — never guessed from copy', () => {
    expect(kickSendErrorCode('{"message":"You have been banned"}')).toBeNull()
    expect(kickSendErrorCode('')).toBeNull()
  })
})

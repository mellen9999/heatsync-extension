// Moderation notices must never claim a ban that didn't happen.
//
// Observed in a live kripp tab: a single `!vanish` (a 1-second timeout) rendered
// THREE rows —
//     dongblob timed out for 1s
//     dongblob has been timed out for 1s.      ← twitch's own NOTICE wording
//     dongblob was permanently banned          ← false
//
// Three separate defects produced that, all guarded here at the source level
// (these paths run in the service worker / host page and can't be imported):
//   1. kick ban classification used `expires_at && expires_at > Date.now()`, so
//      any timeout that had already elapsed — guaranteed for 1s, and true of
//      every replayed event — became a "permanent ban".
//   2. the history replay converter treated an ABSENT duration field the same as
//      a live CLEARCHAT with no ban-duration tag. The first means "we never
//      stored it", the second means permanent per twitch's protocol.
//   3. the history merge deduped on id + `user|time|text`, and since the two
//      sources word the same action differently, both rows survived.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bgSource } from './bg-src.js'

const bg = bgSource()

describe('kick ban classification', () => {
  test('permanence is the absence of an expiry, not an elapsed one', () => {
    expect(bg).toContain('const isTimeout = !!expMs')
    // The exact shape that caused the bug must not come back.
    expect(bg).not.toContain('!!expMs && expMs > Date.now()')
  })

  test('an already-elapsed timeout still reports a sane duration', () => {
    expect(bg).toContain('const remainingSec = Math.max(1, Math.round((expMs - Date.now()) / 1000))')
    expect(bg).toContain('banDuration: isTimeout ? remainingSec : 0,')
  })
})

describe('history replay', () => {
  test('an absent duration is unknown, and says so instead of asserting a permaban', () => {
    expect(bg).toContain('const durationKnown = duration != null')
    expect(bg).toContain('`${target} was removed from chat`')
  })

  test('an explicitly recorded permanent ban still reads as permanent', () => {
    const idx = bg.indexOf('const durationKnown = duration != null')
    expect(idx).toBeGreaterThan(-1)
    expect(bg.slice(idx, idx + 400)).toContain('was permanently banned')
  })
})

describe('history merge', () => {
  test('mod notices go through the cross-transport dedupe, not just id + fingerprint', () => {
    const start = bg.indexOf('function bgIrcMergeServerBacklog')
    expect(start).toBeGreaterThan(-1)
    const body = bg.slice(start, start + 1600)
    expect(body).toContain('bgIrcDupModNotice(buf, msg)')
  })

  test('the dedupe it calls still matches on target + type + window', () => {
    const start = bg.indexOf('function bgIrcDupModNotice')
    const body = bg.slice(start, start + 900)
    expect(body).toContain("msg.noticeType !== 'timeout_success'")
    expect(body).toContain('targetUser')
    // a time window, not an id
    expect(body).toContain('Math.abs(')
    expect(body).toContain('10000')
  })
})

import { expect, test } from 'bun:test'
import { bgSource } from './bg-src.js'

// Extracts the SHIPPED `bgIrcDupModNotice` from chrome/background.js by name and
// evals it in isolation, so this guards the real code (not a copy). It collapses
// duplicate timeout/ban mod notices for the same target that arrive across
// transports (direct IRC + server EventSub fanout, etc.) — including EventSub's
// bogus "permanently banned" line when it loses a timeout's duration.
function loadBgIrcDupModNotice() {
  const src = bgSource()
  const start = src.indexOf('function bgIrcDupModNotice')
  if (start < 0) throw new Error('bgIrcDupModNotice not found in background.js')
  // balanced-brace scan to the closing brace
  let i = src.indexOf('{', start)
  let depth = 0
  let end = -1
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  const body = src.slice(start, end)
  return new Function(`${body}; return bgIrcDupModNotice`)()
}

const dup = loadBgIrcDupModNotice()
const buf = (...msgs) => ({ getAll: () => msgs })
const timeout = (target, time, dur = 1) => ({
  type: 'notice',
  noticeType: 'timeout_success',
  targetUser: target,
  time,
  banDuration: dur,
})
const ban = (target, time) => ({
  type: 'notice',
  noticeType: 'ban_success',
  targetUser: target,
  time,
  banDuration: 0,
})

test('mod-dedup: a second identical timeout for the same target is a dup', () => {
  expect(dup(buf(timeout('tshenk', 1000)), timeout('tshenk', 1000))).toBe(true)
})

test('mod-dedup: a bogus ban collapses against an existing timeout (the !vanish bug)', () => {
  // EventSub fanout drops the duration → "permanently banned"; must be dropped.
  expect(dup(buf(timeout('tshenk', 1000)), ban('tshenk', 1200))).toBe(true)
})

test('mod-dedup: case-insensitive target match', () => {
  expect(dup(buf(timeout('TShenk', 1000)), ban('tshenk', 1000))).toBe(true)
})

test('mod-dedup: first notice for a target is not a dup (empty buffer)', () => {
  expect(dup(buf(), timeout('tshenk', 1000))).toBe(false)
})

test('mod-dedup: different target is not a dup', () => {
  expect(dup(buf(timeout('alice', 1000)), timeout('bob', 1000))).toBe(false)
})

test('mod-dedup: outside the 10s window is not a dup', () => {
  expect(dup(buf(timeout('tshenk', 1000)), timeout('tshenk', 1000 + 10001))).toBe(false)
})

test('mod-dedup: a notice without a target is never a dup', () => {
  expect(
    dup(buf(timeout('tshenk', 1000)), { type: 'notice', noticeType: 'ban_success', targetUser: '', time: 1000 }),
  ).toBe(false)
})

test('mod-dedup: non-mod notices are ignored', () => {
  expect(
    dup(buf(timeout('tshenk', 1000)), { type: 'notice', noticeType: 'mode_change', targetUser: 'tshenk', time: 1000 }),
  ).toBe(false)
  expect(
    dup(buf({ type: 'notice', noticeType: 'mode_change', targetUser: 'tshenk', time: 1000 }), timeout('tshenk', 1000)),
  ).toBe(false)
})

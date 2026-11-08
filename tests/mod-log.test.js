import { expect, test } from 'bun:test'
import {
  filterModLog,
  formatDuration,
  isModNotice,
  MOD_NOTICE_TYPES,
  modLogEntryFromNotice,
  modLogLine,
  pushModLogEntry,
} from '../src/multichat/mod-log.js'
import { t } from './en-t.js'

function notice(overrides = {}) {
  return {
    type: 'notice',
    noticeType: 'ban_success',
    targetUser: 'Bob',
    channel: 'AlphaChan',
    banDuration: 0,
    systemMsg: 'mod banned Bob',
    time: 1000,
    id: 'n1',
    ...overrides,
  }
}

// ── isModNotice ───────────────────────────────────────────────────────────
test('isModNotice: true only for notice type + a mod noticeType', () => {
  expect(isModNotice(notice())).toBe(true)
  expect(isModNotice(notice({ noticeType: 'timeout_success' }))).toBe(true)
  expect(isModNotice(notice({ noticeType: 'delete_message_success' }))).toBe(true)
  expect(isModNotice(notice({ type: 'privmsg' }))).toBe(false)
  expect(isModNotice(notice({ noticeType: 'sub' }))).toBe(false)
  expect(isModNotice(null)).toBe(false)
  expect(isModNotice(undefined)).toBe(false)
  expect(isModNotice({})).toBe(false)
})

test('MOD_NOTICE_TYPES covers all four mod actions (+ untimeout)', () => {
  for (const t of ['ban_success', 'timeout_success', 'unban_success', 'untimeout_success', 'delete_message_success']) {
    expect(MOD_NOTICE_TYPES.has(t)).toBe(true)
  }
})

// ── modLogEntryFromNotice ─────────────────────────────────────────────────
test('modLogEntryFromNotice: maps noticeType → action', () => {
  expect(modLogEntryFromNotice(notice({ noticeType: 'ban_success' })).action).toBe('ban')
  expect(modLogEntryFromNotice(notice({ noticeType: 'timeout_success' })).action).toBe('timeout')
  expect(modLogEntryFromNotice(notice({ noticeType: 'unban_success' })).action).toBe('unban')
  expect(modLogEntryFromNotice(notice({ noticeType: 'untimeout_success' })).action).toBe('untimeout')
  expect(modLogEntryFromNotice(notice({ noticeType: 'delete_message_success' })).action).toBe('delete')
})

test('modLogEntryFromNotice: lowercases target + channel, carries fields', () => {
  const e = modLogEntryFromNotice(notice({ noticeType: 'timeout_success', banDuration: 600, platform: 'kick' }))
  expect(e.target).toBe('bob')
  expect(e.channel).toBe('alphachan')
  expect(e.durationSec).toBe(600)
  expect(e.platform).toBe('kick')
  expect(e.text).toBe('mod banned Bob')
  expect(e.time).toBe(1000)
  expect(e.id).toBe('n1')
})

test('modLogEntryFromNotice: synthesizes a stable id when msg.id is absent', () => {
  const e = modLogEntryFromNotice(notice({ id: undefined }))
  expect(e.id).toBe('ban_success:alphachan:bob:1000')
})

test('modLogEntryFromNotice: returns null for non-mod messages', () => {
  expect(modLogEntryFromNotice(notice({ type: 'privmsg' }))).toBeNull()
  expect(modLogEntryFromNotice(notice({ noticeType: 'sub' }))).toBeNull()
  expect(modLogEntryFromNotice(null)).toBeNull()
})

test('modLogEntryFromNotice: defaults platform to twitch, duration to 0', () => {
  const e = modLogEntryFromNotice(notice({ platform: undefined, banDuration: undefined }))
  expect(e.platform).toBe('twitch')
  expect(e.durationSec).toBe(0)
})

// ── pushModLogEntry ───────────────────────────────────────────────────────
test('pushModLogEntry: appends entries', () => {
  const log = []
  pushModLogEntry(log, modLogEntryFromNotice(notice({ id: 'a' })))
  pushModLogEntry(log, modLogEntryFromNotice(notice({ id: 'b' })))
  expect(log.map((e) => e.id)).toEqual(['a', 'b'])
})

test('pushModLogEntry: dedupes by id (last-id short-circuit + scan)', () => {
  const log = []
  pushModLogEntry(log, modLogEntryFromNotice(notice({ id: 'a' })))
  pushModLogEntry(log, modLogEntryFromNotice(notice({ id: 'a' }))) // consecutive dup
  pushModLogEntry(log, modLogEntryFromNotice(notice({ id: 'b' })))
  pushModLogEntry(log, modLogEntryFromNotice(notice({ id: 'a' }))) // non-consecutive dup
  expect(log.map((e) => e.id)).toEqual(['a', 'b'])
})

test('pushModLogEntry: null entry is a no-op', () => {
  const log = []
  pushModLogEntry(log, null)
  pushModLogEntry(log, modLogEntryFromNotice(notice({ type: 'privmsg' }))) // returns null
  expect(log.length).toBe(0)
})

test('pushModLogEntry: caps at max, trimming oldest first', () => {
  const log = []
  for (let i = 0; i < 10; i++) pushModLogEntry(log, modLogEntryFromNotice(notice({ id: `e${i}` })), 5)
  expect(log.length).toBe(5)
  expect(log[0].id).toBe('e5')
  expect(log[4].id).toBe('e9')
})

// ── formatDuration ────────────────────────────────────────────────────────
test('formatDuration: compact human units, empty for 0', () => {
  expect(formatDuration(0, t)).toBe('')
  expect(formatDuration(undefined, t)).toBe('')
  expect(formatDuration(45, t)).toBe('45s')
  expect(formatDuration(600, t)).toBe('10m')
  expect(formatDuration(3600, t)).toBe('1h')
  expect(formatDuration(7200, t)).toBe('2h')
  expect(formatDuration(86400, t)).toBe('1d')
  expect(formatDuration(-5, t)).toBe('')
})

// ── modLogLine ────────────────────────────────────────────────────────────
test('modLogLine: human one-liner per action', () => {
  expect(modLogLine({ action: 'ban', target: 'bob' }, t)).toBe('banned bob')
  expect(modLogLine({ action: 'timeout', target: 'bob', durationSec: 600 }, t)).toBe('timed out bob (10m)')
  expect(modLogLine({ action: 'timeout', target: 'bob', durationSec: 0 }, t)).toBe('timed out bob')
  expect(modLogLine({ action: 'unban', target: 'bob' }, t)).toBe('unbanned bob')
  expect(modLogLine({ action: 'untimeout', target: 'bob' }, t)).toBe('lifted the timeout on bob')
  expect(modLogLine({ action: 'delete', target: 'bob' }, t)).toBe('deleted a message from bob')
  expect(modLogLine({ action: 'delete', target: '' }, t)).toBe('deleted a message')
  expect(modLogLine({ action: 'ban', target: '' }, t)).toBe('banned someone')
  expect(modLogLine(null, t)).toBe('')
})

// ── filterModLog ──────────────────────────────────────────────────────────
test('filterModLog: by action and/or free-text query', () => {
  const log = [
    { action: 'ban', target: 'alice', channel: 'chan1' },
    { action: 'timeout', target: 'bob', channel: 'chan2' },
    { action: 'ban', target: 'bobby', channel: 'chan1' },
  ]
  expect(filterModLog(log, { action: 'ban' }).map((e) => e.target)).toEqual(['alice', 'bobby'])
  expect(filterModLog(log, { query: 'bob' }).map((e) => e.target)).toEqual(['bob', 'bobby'])
  expect(filterModLog(log, { action: 'ban', query: 'bob' }).map((e) => e.target)).toEqual(['bobby'])
  expect(filterModLog(log, { query: 'chan2' }).map((e) => e.target)).toEqual(['bob'])
  expect(filterModLog(log, {}).length).toBe(3)
})

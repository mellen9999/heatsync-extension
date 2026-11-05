import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../src/multichat/chat-lock.js', import.meta.url), 'utf8')
const t = (k, a) => (a ? `${k}:${a.join(',')}` : k)
const L = new Function(
  't',
  `${SRC}\nreturn { chatLockPut, chatLockFor, chatLockClear, chatLockFromNotice, chatLockFromClearchat, chatLockRoomstate, chatLockLabel, chatLockHoldsSend, chatLockIsRule, chatLocks }`,
)(t)

const NOW = 1_000_000

describe('chat lock', () => {
  test('timeout notice gives an end time; other notices give none', () => {
    const l = L.chatLockFromNotice('msg_timedout', ':You are timed out for 90 more seconds.', NOW)
    expect(l).toEqual({ cause: 'timeout', until: NOW + 90000 })
    expect(L.chatLockFromNotice('msg_timedout', 'no number', NOW)).toBeNull()
    expect(L.chatLockFromNotice('msg_slowmode', 'x', NOW)).toBeNull()
    expect(L.chatLockFromNotice('msg_banned', '', NOW)).toEqual({ cause: 'banned', until: null })
    expect(L.chatLockFromNotice('msg_subsonly', '', NOW).cause).toBe('subs')
  })
  test('a lock ends on its own', () => {
    L.chatLockPut('Forsen', 'timeout', NOW + 1000)
    expect(L.chatLockFor('forsen', NOW)?.cause).toBe('timeout')
    expect(L.chatLockFor('forsen', NOW + 1000)).toBeNull()
    expect(L.chatLocks.size).toBe(0)
  })
  test('clearchat only locks when it names us and is fresh', () => {
    const ev = { noticeType: 'timeout_success', targetUser: 'Me', banDuration: 60, time: NOW }
    expect(L.chatLockFromClearchat(ev, ['me'], NOW)).toEqual({ cause: 'timeout', until: NOW + 60000 })
    expect(L.chatLockFromClearchat(ev, ['other'], NOW)).toBeNull()
    expect(L.chatLockFromClearchat({ ...ev, time: NOW - 120000 }, ['me'], NOW)).toBeNull()
    expect(L.chatLockFromClearchat({ noticeType: 'ban_success', targetUser: 'me', time: NOW }, ['me'], NOW)).toEqual({
      cause: 'banned',
      until: null,
    })
    expect(L.chatLockFromClearchat({ ...ev, noticeType: 'mode_change' }, ['me'], NOW)).toBeNull()
  })
  test('roomstate frees the matching rule only', () => {
    L.chatLockPut('c', 'subs', null)
    L.chatLockRoomstate({ channel: 'c', emoteOnly: false })
    expect(L.chatLockFor('c')).not.toBeNull()
    L.chatLockRoomstate({ channel: 'c', subsOnly: false })
    expect(L.chatLockFor('c')).toBeNull()
    L.chatLockPut('c', 'followers', null)
    L.chatLockRoomstate({ channel: 'c', followersOnly: -1 })
    expect(L.chatLockFor('c')).toBeNull()
  })
  test('a ban tells but does not hold the send; timeouts and rules do', () => {
    expect(L.chatLockHoldsSend({ cause: 'banned' })).toBe(false)
    expect(L.chatLockHoldsSend({ cause: 'timeout', until: 1 })).toBe(true)
    expect(L.chatLockHoldsSend({ cause: 'subs' })).toBe(true)
    expect(L.chatLockIsRule({ cause: 'subs' })).toBe(true)
    expect(L.chatLockIsRule({ cause: 'timeout' })).toBe(false)
  })
  test('label counts down m:ss and h:mm:ss', () => {
    expect(L.chatLockLabel({ cause: 'timeout', until: NOW + 299000 }, NOW)).toBe('mc_lock_timed_out:4:59')
    expect(L.chatLockLabel({ cause: 'timeout', until: NOW + 3725000 }, NOW)).toBe('mc_lock_timed_out:1:02:05')
    expect(L.chatLockLabel({ cause: 'banned', until: null })).toBe('mc_lock_banned')
  })
  test('store is bounded', () => {
    for (let i = 0; i < 300; i++) L.chatLockPut(`c${i}`, 'banned', null)
    expect(L.chatLocks.size).toBeLessThanOrEqual(200)
  })
  test('wired: notice, clearchat, roomstate, placeholder and send all call in', () => {
    const rd = (f) => readFileSync(new URL(`../src/multichat/${f}`, import.meta.url), 'utf8')
    expect(rd('auth-irc.js')).toContain('chatLockSet(lockCh')
    expect(rd('irc.js')).toContain('chatLockFromClearchat(')
    expect(rd('irc.js')).toContain('chatLockRoomstate(msg)')
    expect(rd('input.js')).toContain('chatLockLabel(lock)')
    expect(rd('input.js')).toContain('chatLockHoldsSend(lock)')
  })
})

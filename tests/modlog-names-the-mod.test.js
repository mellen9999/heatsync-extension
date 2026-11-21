import { describe, expect, test } from 'bun:test'
import { applyModLogFrame, createModLogStore, mergeModLogs, modLogBy, modLogLine } from '../src/multichat/mod-log.js'
import { t } from './en-t.js'

/**
 * Twitch's chat never says which mod acted. A mod who granted heatsync's
 * modlog pack gets twitch's own record of each action (modlog_action); it
 * names the entry chat made, waits for an echo that has not come yet, and
 * adds the unbans and untimeouts chat never shows.
 */
const now = Date.now()
const notice = (o = {}) => ({
  type: 'notice',
  noticeType: 'ban_success',
  targetUser: 'Troll',
  channel: 'chan',
  banDuration: 0,
  systemMsg: 'x',
  time: now,
  platform: 'twitch',
  ...o,
})
const frame = (o = {}) => ({
  type: 'modlog_action',
  broadcasterLogin: 'chan',
  action: 'ban',
  target: 'troll',
  actor: 'OtherMod',
  at: now + 600,
  ...o,
})

function makeStore() {
  const log = []
  const timers = []
  const store = createModLogStore({ log, storage: () => null, setTimer: (fn) => timers.push(fn), clearTimer: () => {} })
  return { log, store, timers }
}

describe("twitch's record names the mod", () => {
  test('names the ban chat already logged, and schedules the write', () => {
    const { log, store, timers } = makeStore()
    store.record(notice({ id: 'b1' }))
    timers.shift()() // the record's write goes out
    expect(store.applyFrame(frame())).toBe(true)
    expect(log[0].actor).toBe('othermod')
    expect(modLogBy(log[0], t)).toContain('othermod')
    expect(timers.length).toBe(1)
  })

  test('a frame ahead of its echo is held, and the echo takes the name', () => {
    const { log, store } = makeStore()
    expect(store.applyFrame(frame({ target: 'early', action: 'timeout' }))).toBe(false)
    store.record(notice({ id: 't1', noticeType: 'timeout_success', targetUser: 'Early', banDuration: 600 }))
    expect(log[0].actor).toBe('othermod')
  })

  test('an unban chat never showed becomes an entry; one taken here keeps its own name', () => {
    const { log, store } = makeStore()
    store.applyFrame(frame({ action: 'unban', target: 'pardoned' }))
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ action: 'unban', target: 'pardoned', actor: 'othermod', platform: 'twitch' })
    expect(modLogLine(log[0], t)).toBeTruthy()
    store.record(notice({ id: 'u2', noticeType: 'unban_success', targetUser: 'mine', actor: 'me', time: now + 5000 }))
    store.applyFrame(frame({ action: 'unban', target: 'mine', at: now + 5200 }))
    expect(log.find((e) => e.target === 'mine').actor).toBe('me')
    expect(log.filter((e) => e.target === 'mine')).toHaveLength(1)
  })

  test('another channel, another person, or outside the window is never named', () => {
    const log = [
      { id: 'a', action: 'ban', target: 'troll', actor: '', channel: 'elsewhere', platform: 'twitch', time: now },
      { id: 'b', action: 'ban', target: 'someoneelse', actor: '', channel: 'chan', platform: 'twitch', time: now },
      { id: 'c', action: 'ban', target: 'troll', actor: '', channel: 'chan', platform: 'twitch', time: now - 60_000 },
      { id: 'd', action: 'ban', target: 'troll', actor: '', channel: 'chan', platform: 'kick', time: now },
    ]
    expect(applyModLogFrame(log, frame()).named).toBeNull()
    expect(log.every((e) => !e.actor)).toBe(true)
  })

  test('junk is nothing', () => {
    const { store } = makeStore()
    expect(store.applyFrame(null)).toBe(false)
    expect(store.applyFrame(frame({ action: 'slow' }))).toBe(false)
    expect(store.applyFrame(frame({ actor: '' }))).toBe(false)
  })

  test('a stored copy without the name never wipes the name another tab learned', () => {
    const plain = { id: 'x', action: 'ban', target: 'troll', actor: '', channel: 'chan', platform: 'twitch', time: now }
    const named = { ...plain, actor: 'othermod' }
    expect(mergeModLogs([plain], [named])[0].actor).toBe('othermod')
    expect(mergeModLogs([named], [plain])[0].actor).toBe('othermod')
  })
})

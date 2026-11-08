/**
 * One twitch whisper arrives over up to three transports. eventsub and the
 * server's push share the uuid whisper_id, so the id key pairs them; irc's
 * WHISPER line only carries the numeric message-id tag, so nothing paired it
 * and every whisper landed twice while both sockets were up. The twin check
 * pairs by content across transports, live and on the stored timeline.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MC = join(import.meta.dir, '..', 'src', 'multichat')
const SRC = readFileSync(join(MC, 'whispers.js'), 'utf8')

function load() {
  const start = SRC.indexOf('const _whisperSeen = new Set()')
  const end = SRC.indexOf('function loadWhispers() {', start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return new Function(
    `${SRC.slice(start, end)}\nreturn { _whisperDedupKey, _whisperMarkSeen, _whisperTwinSeen, _whisperTimelineHasTwin }`,
  )()
}

const UUID = '3f2a9c1e-7b4d-4e8a-9c21-5d6f7a8b9c0d'
const T = 1_762_000_000_000

describe('live: a whisper over two transports is one whisper', () => {
  test('irc (numeric message-id) after eventsub (uuid) within 15s is a twin', () => {
    const w = load()
    expect(w._whisperMarkSeen(w._whisperDedupKey('twitch', UUID, 'Bob', T, 'psst'))).toBe(false)
    expect(w._whisperTwinSeen('eventsub', 'Bob', 'psst', T)).toBe(false)
    // irc's id is a different string — the id key does NOT catch it
    expect(w._whisperMarkSeen(w._whisperDedupKey('twitch', '306', 'Bob', T + 1200, 'psst'))).toBe(false)
    expect(w._whisperTwinSeen('irc', 'bob', 'psst', T + 1200)).toBe(true)
  })

  test('the server push shares the uuid with eventsub — the id key alone pairs them', () => {
    const w = load()
    expect(w._whisperMarkSeen(w._whisperDedupKey('twitch', UUID, 'Bob', T, 'psst'))).toBe(false)
    expect(w._whisperMarkSeen(w._whisperDedupKey('twitch', UUID, 'Bob', T + 800, 'psst'))).toBe(true)
  })

  test('the same transport repeating the same text is two whispers', () => {
    const w = load()
    expect(w._whisperTwinSeen('eventsub', 'Bob', 'ok', T)).toBe(false)
    expect(w._whisperTwinSeen('eventsub', 'Bob', 'ok', T + 2000)).toBe(false)
  })

  test('a different transport outside the window, or another sender, is not a twin', () => {
    const w = load()
    expect(w._whisperTwinSeen('eventsub', 'Bob', 'ok', T)).toBe(false)
    expect(w._whisperTwinSeen('irc', 'Bob', 'ok', T + 15_001)).toBe(false)
    expect(w._whisperTwinSeen('irc', 'Alice', 'ok', T + 100)).toBe(false)
  })
})

describe('stored timeline: twins from before the pairing are healed on load', () => {
  const kept = { user: 'Bob', text: 'psst', time: T, self: false, platform: 'twitch', key: 'twitch:bob', id: UUID }

  test('the irc copy (numeric id, +1.2s) of a kept uuid entry is dropped', () => {
    const w = load()
    const irc = { ...kept, time: T + 1200, id: '306' }
    expect(w._whisperTimelineHasTwin([kept], irc)).toBe(true)
  })

  test('two ids of the same shape 2s apart are a real repeat and both stay', () => {
    const w = load()
    const again = { ...kept, time: T + 2000, id: '4b1c2d3e-0000-4000-8000-000000000001' }
    expect(w._whisperTimelineHasTwin([kept], again)).toBe(false)
  })

  test('no ids at all (legacy rows) pair by content inside the window', () => {
    const w = load()
    const a = { ...kept, id: '' }
    expect(w._whisperTimelineHasTwin([a], { ...a, time: T + 3000 })).toBe(true)
  })

  test('the exact time+text rule the loader always had still holds, self rows included', () => {
    const w = load()
    const mine = { ...kept, self: true, user: 'you', id: '' }
    expect(w._whisperTimelineHasTwin([mine], { ...mine })).toBe(true)
    expect(w._whisperTimelineHasTwin([mine], { ...mine, time: T + 500 })).toBe(false)
  })

  test('heatsync dms never pair across the window', () => {
    const w = load()
    const dm = { ...kept, platform: 'heatsync', id: '9' }
    expect(w._whisperTimelineHasTwin([dm], { ...dm, time: T + 500, id: '10' })).toBe(false)
  })
})

describe('every producer names its transport', () => {
  test.each([
    ['auth-irc.js', /handleIncomingWhisper\(\{ \.\.\.msg, src: 'irc' \}\)/],
    ['eventsub-whispers.js', /src: 'eventsub',\n\s*\}\)/],
    ['social.js', /if \(msg\.data\.platform === 'twitch'\) handleServerWhisperPush\(msg\.data\)/],
    ['whispers.js', /function handleServerWhisperPush\(data\) \{\n\s*handleIncomingWhisper\(\{[^}]*src: 'server',/],
  ])('%s', (file, re) => {
    expect(readFileSync(join(MC, file), 'utf8')).toMatch(re)
  })

  test('the chokepoint asks the twin check right after the id key', () => {
    const fn = SRC.slice(SRC.indexOf('function handleIncomingWhisper(msg) {'))
    const idKey = fn.indexOf('_whisperMarkSeen(_whisperDedupKey(')
    const twin = fn.indexOf('_whisperTwinSeen(msg.src, msg.user, msg.text, msg.time)')
    expect(idKey).toBeGreaterThan(0)
    expect(twin).toBeGreaterThan(idKey)
    expect(twin - idKey).toBeLessThan(200)
  })
})

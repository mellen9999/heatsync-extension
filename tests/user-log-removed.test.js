// user-log:removed — archived chat lines taken down; the open chat-logs view drops them live.
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootSw, disposeAll } from './harness/sw.js'

afterEach(disposeAll)

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'chat-logs.js'), 'utf8')
const fn = (name) => {
  const a = SRC.indexOf(`function ${name}(`)
  if (a < 0) throw new Error(`${name} not found`)
  return SRC.slice(a, SRC.indexOf('\n}', a) + 2)
}
const pure = new Function(`${fn('clRowsAfterRemoval')}; return clRowsAfterRemoval`)()
const rows = [
  { message_id: 'a', channel: 'x', timestamp: '2026-11-10T10:00:00Z' },
  { message_id: 'b', channel: 'x', timestamp: '2026-11-10T11:00:00Z' },
  { message_id: 'c', channel: 'y', timestamp: '2026-11-10T12:00:00Z' },
]
const ids = (r) => r.map((x) => x.message_id)

describe('clRowsAfterRemoval', () => {
  test('ids drop exactly those rows', () => expect(ids(pure(rows, { ids: ['b'] }))).toEqual(['a', 'c']))
  test('no ids, no window: the whole person', () => expect(pure(rows, {})).toEqual([]))
  test('a channel scopes it', () => expect(ids(pure(rows, { channel: 'Y' }))).toEqual(['a', 'b']))
  test('after / before are exclusive bounds', () => {
    expect(ids(pure(rows, { after: '2026-11-10T10:00:00Z', before: '2026-11-10T12:00:00Z' }))).toEqual(['a', 'c'])
    expect(ids(pure(rows, { after: '2026-11-10T10:30:00Z' }))).toEqual(['a'])
  })
})

describe('applier', () => {
  function rig(st, d) {
    let renders = 0
    new Function(
      'env',
      'renderChatLogsView',
      `let activeChatLogs = env.st; ${fn('clRowsAfterRemoval')}; ${fn('chatLogsServerRemoved')}; chatLogsServerRemoved(env.d)`,
    )({ st, d }, () => renders++)
    return renders
  }
  test('repaints once when rows went, for that person only', () => {
    const st = { platform: 'twitch', username: 'bob', rows: [...rows] }
    expect(rig(st, { platform: 'twitch', username: 'Bob', ids: ['a'] })).toBe(1)
    expect(ids(st.rows)).toEqual(['b', 'c'])
    expect(rig(st, { platform: 'twitch', username: 'bob', ids: ['zzz'] })).toBe(0)
    expect(rig(st, { platform: 'twitch', username: 'alice' })).toBe(0)
    expect(rig(st, { platform: 'kick', username: 'bob' })).toBe(0)
    expect(st.rows).toHaveLength(2)
    expect(rig(null, { platform: 'twitch', username: 'bob' })).toBe(0)
  })
})

test('worker forwards the frame; the panel routes it', async () => {
  const sw = await bootSw({
    cookies: [{ name: 'auth', value: 'tok-1', domain: 'heatsync.org' }],
    tabs: [{ id: 7, url: 'https://www.twitch.tv/kripp' }],
    sockets: 'open',
  })
  const data = { platform: 'twitch', username: 'bob', ids: ['a'] }
  sw.socket().receive({ type: 'user-log:removed', data })
  sw.socket().receive({ type: 'user-log:removed' })
  await sw.settle()
  expect(sw.broadcasts('user-log:removed').map((m) => m.message.data)).toEqual([data])
  expect(readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'social.js'), 'utf8')).toContain(
    "msg.type === 'user-log:removed') return void chatLogsServerRemoved(msg.data)",
  )
})

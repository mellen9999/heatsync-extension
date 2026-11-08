// four service-worker papercuts, each pinned by behavior where the code can
// run bare and by source shape where it leans on the whole worker.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bgSource } from './bg-src.js'

const part = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'background', f), 'utf8')

/** a top-level function's source, brace-matched from its header */
function fn(src, header) {
  const at = src.indexOf(header)
  if (at < 0) throw new Error(`no ${header}`)
  let i = src.indexOf('{', src.indexOf(')', at))
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1)
  }
  throw new Error('unbalanced')
}

test('badges: a refresh that got nothing does not hold the TTL stamp', () => {
  const src = fn(part('03-identity-cosmetics.js'), 'async function fetchBulkBadges')
  // the stamp that dedupes concurrent calls is rolled back when no source answered
  expect(src).toMatch(/const anyOk = .*\.some\(\(r\) => r\.status === 'fulfilled' && r\.value\.ok\)/)
  expect(src).toMatch(/if \(!anyOk\) \{\s*badgesFetchedAt = 0/)
})

test('reconnect timer: connectWebSocket failure is caught and logged', () => {
  const src = fn(part('05-ws.js'), 'function scheduleReconnect(')
  expect(src).toMatch(/connectWebSocket\(\)\.catch\(\(err\) => log\(/)
})

test('ws queue: _queuedAt never reaches the wire and the caller object is untouched', () => {
  const ws = part('05-ws.js')
  const sent = []
  const body = `${fn(ws, 'function flushMessageQueue(')}\n${fn(ws, 'function wsSend(')}\nreturn { wsSend, flushMessageQueue, setOpen: (v) => { open = v } }`
  const make = new Function(
    'log',
    'socket',
    'connectWebSocket',
    'authFailedBlock',
    'MESSAGE_QUEUE_TTL',
    `let open = false\nconst WS_STATE = { DISCONNECTED: 0 }\nlet wsState = 1\nconst messageQueue = []\nconst isSocketOpen = () => open\n${body}`,
  )
  const api = make(
    () => {},
    { send: (s) => sent.push(JSON.parse(s)) },
    () => Promise.resolve(),
    true,
    60000,
  )
  const msg = { type: 'channel:join', channel: 'x' }
  api.wsSend(msg)
  expect('_queuedAt' in msg).toBe(false)
  api.setOpen(true)
  api.flushMessageQueue()
  expect(sent).toEqual([{ type: 'channel:join', channel: 'x' }])
})

test('unknown runtime type is answered, but never one another BG listener owns', async () => {
  const src = part('07-handle-message.js')
  const run = new Function(`${src}\nreturn handleMessage`)()
  const got = []
  await run({ type: 'zz_nonsense' }, {}, (r) => got.push(r))
  expect(got).toEqual([{ ok: false, error: 'unknown_type' }])
  for (const owned of ['bg_irc_join', 'bg_kick_history', 'bg_submit_feedback']) {
    const none = []
    await run({ type: owned }, {}, (r) => none.push(r))
    expect(none).toEqual([])
  }
  // the owners really live in the other listeners
  expect(bgSource()).toContain("message.type === 'bg_kick_history'")
})

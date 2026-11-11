/**
 * The twitch send socket keeps its timers across a channel switch.
 *
 * Twitch changes channel without a page load; fullSpaReinit then drains every
 * timer registered through the multichat cleanup object so init() can start a
 * fresh set. The send socket (auth-irc.js) is deliberately kept open across
 * that switch — but its keepalive, reconnect and handshake timers were plain
 * cleanup timers, so the first channel switch silently killed them. A socket
 * that then died (sleep, wifi change) still read as alive, and every send went
 * into it and vanished until the page was refreshed.
 *
 * Runs the real bootstrap cleanup object + drain and the real auth-irc.js
 * against a fake clock and a fake socket.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MC = join(import.meta.dir, '..', 'src', 'multichat')
const BOOT = readFileSync(join(MC, 'bootstrap.js'), 'utf8')
const AUTH = readFileSync(join(MC, 'auth-irc.js'), 'utf8')

function block(src, head) {
  const start = src.indexOf(head)
  if (start === -1) throw new Error(`"${head}" not found`)
  return src.slice(start, src.indexOf('\n}\n', start) + 3)
}
const TIMERS = BOOT.match(/^const _timers = .*$/m)[0]
const DRAIN = block(BOOT, 'function drainChannelTimers(')
const CLEANUP = block(BOOT, 'const cleanup = {')

function load() {
  let now = 0
  let nextId = 1
  const tasks = new Map()
  const add = (fn, ms, every) => {
    const id = nextId++
    tasks.set(id, { fn, at: now + ms, every })
    return id
  }
  const drop = (id) => tasks.delete(id)
  const advance = async (ms) => {
    const end = now + ms
    for (;;) {
      let next = null
      for (const [id, t] of tasks) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t]
      if (!next) break
      const [id, t] = next
      now = t.at
      if (t.every) t.at = now + t.every
      else tasks.delete(id)
      t.fn()
      await Promise.resolve()
    }
    now = end
  }
  const sockets = []
  class FakeWS {
    static OPEN = 1
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.sent = []
      sockets.push(this)
    }
    send(line) {
      this.sent.push(line)
    }
    close() {
      this.readyState = 3
    }
    welcome() {
      this.readyState = 1
      this.onopen?.()
      this.onmessage?.({ data: ':tmi.twitch.tv 001 viewer :Welcome, GLHF!\r\n' })
    }
  }
  const api = new Function(
    'setTimeout',
    'setInterval',
    'clearTimeout',
    'clearInterval',
    'WebSocket',
    'globalThis',
    `const _hsPerfWrap = (fn) => fn
const log = () => {}
const MC_DEBUG = false
const getCurrentChannel = () => null
const dupBypassWire = (_last, text) => text
${TIMERS}
${DRAIN}
${CLEANUP}
${AUTH}
return { authState, connectAuthIrc, authIrcAlive, drainChannelTimers, recycleAuthIrc, _timers }`,
  )(
    (fn, ms) => add(fn, ms, 0),
    (fn, ms) => add(fn, ms, ms),
    drop,
    drop,
    FakeWS,
    {},
  )
  return { ...api, sockets, advance }
}

async function connected() {
  const h = load()
  const p = h.connectAuthIrc('token', 'viewer')
  h.sockets[0].welcome()
  expect(await p).toBe(true)
  return h
}

const pings = (ws) => ws.sent.filter((l) => l.startsWith('PING')).length

test('the keepalive still pings after a channel switch', async () => {
  const h = await connected()
  h.drainChannelTimers()
  await h.advance(30_000)
  expect(pings(h.sockets[0])).toBe(1)
})

test('a socket that stopped answering is replaced after a channel switch', async () => {
  const h = await connected()
  h.drainChannelTimers()
  await h.advance(30_000) // ping goes out, no pong comes back
  await h.advance(30_000) // the missed pong is noticed
  expect(h.sockets[0].readyState).toBe(3)
  expect(h.authIrcAlive()).toBe(false)
  await h.advance(2_000) // reconnect timer, also armed after the switch
  expect(h.sockets).toHaveLength(2)
})

test('a handshake cut by a channel switch still gives up, so the next send can connect', async () => {
  const h = load()
  const p = h.connectAuthIrc('token', 'viewer')
  h.drainChannelTimers()
  await h.advance(8_000) // twitch never answers
  expect(await p).toBe(false)
  expect(h.authState.connecting).toBe(false)
})

test('the page timers stay out of the drain only while they are live', async () => {
  const h = await connected()
  expect(h._timers.persistent.size).toBe(1) // the keepalive
  h.authState.ws.onclose()
  expect(h._timers.persistent.size).toBe(1) // keepalive gone, reconnect armed
  await h.advance(2_000)
  h.sockets[1].welcome()
  await h.advance(0)
  expect(h._timers.persistent.size).toBe(1) // the new socket's keepalive only
})

test('a send twitch never echoed replaces an older socket, and the next send has a fresh one', async () => {
  const h = await connected()
  h.authState.openedAt -= 60_000 // this socket has been up a minute
  expect(h.recycleAuthIrc('test')).toBe(true)
  expect(h.sockets[0].readyState).toBe(3)
  await h.advance(2_000)
  expect(h.sockets).toHaveLength(2)
  h.sockets[1].welcome()
  await h.advance(0)
  expect(h.authIrcAlive()).toBe(true)
})

test('a socket that only just opened is not blamed for a missing echo', async () => {
  const h = await connected()
  expect(h.recycleAuthIrc('test')).toBe(false)
  expect(h.sockets[0].readyState).toBe(1)
})

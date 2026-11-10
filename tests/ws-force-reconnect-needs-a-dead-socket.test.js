// A quiet channel is not a dead socket. The panel's kick and youtube watchdogs
// ask the background to reconnect when one channel goes silent; an offline
// channel is silent for hours, so obeying them reconnected the whole socket
// every ~2 min (each time replaying follow history, which swallowed a real
// go-live line, and making the server drop and re-join every channel).
import { describe, expect, test } from 'bun:test'
import { bgSource } from './bg-src.js'

const SRC = bgSource()

function block(startMarker) {
  const at = SRC.indexOf(startMarker)
  if (at === -1) throw new Error(`not found: ${startMarker}`)
  let depth = 0
  for (let i = SRC.indexOf('{', at); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(at, i + 1)
  }
  throw new Error('unbalanced')
}

const zombieFn = block('function isSocketZombie(')
const handler = block("if (message.type === 'ws_force_reconnect') {")

function run({ open, lastRx }) {
  const calls = { closed: 0, connected: 0, response: null }
  const socket = { readyState: open ? 1 : 3, close: () => calls.closed++, onclose: () => {} }
  const env = {
    WebSocket: { OPEN: 1 },
    socket,
    lastWsDataReceived: lastRx,
    WS_STATE: { DISCONNECTED: 'd' },
    log: () => {},
    untrackInterval: () => {},
    connectWebSocket: () => {
      calls.connected++
      return Promise.resolve()
    },
    sendResponse: (r) => {
      calls.response = r
    },
    message: { type: 'ws_force_reconnect', source: 'yt_watchdog', channel: 'nl_kripp' },
  }
  const names = Object.keys(env)
  const body = `
    let wsState, isAuthenticated, reconnectAttempts, reconnectTimer = null, heartbeatInterval = null
    const WS_ZOMBIE_MS = 45000
    function isSocketOpen() { return socket && socket.readyState === WebSocket.OPEN }
    ${zombieFn}
    ;(() => { ${handler} })()
  `
  new Function(...names, body)(...names.map((n) => env[n]))
  return calls
}

describe('ws_force_reconnect', () => {
  test('a live socket (traffic in the last 45s) refuses — a quiet channel is not a dead socket', () => {
    const c = run({ open: true, lastRx: Date.now() - 5000 })
    expect(c.closed).toBe(0)
    expect(c.connected).toBe(0)
    expect(c.response).toEqual({ ok: false, reason: 'socket-live' })
  })

  test('an open socket that has said nothing for 45s+ is a zombie and reconnects', () => {
    const c = run({ open: true, lastRx: Date.now() - 60000 })
    expect(c.closed).toBe(1)
    expect(c.connected).toBe(1)
    expect(c.response).toEqual({ ok: true })
  })

  test('a closed socket reconnects', () => {
    const c = run({ open: false, lastRx: Date.now() - 1000 })
    expect(c.connected).toBe(1)
  })

  test('the alarm watchdog and the escalation share one zombie rule', () => {
    expect(SRC).toContain('if (isSocketZombie()) {')
    expect(SRC).not.toMatch(/lastWsDataReceived > 45000/)
  })
})

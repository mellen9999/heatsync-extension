import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Kick's chat socket takes a *.kick.com origin only, so the tap's socket opens in a web.kick.com
 * frame the background owns (chrome: an offscreen document) and a port carries it back. Until
 * 11-17 the worker opened it itself and every connect was refused: the tap never ran. Both
 * halves run for real here: the background's host (10-kick-socket-host.js) and the frame's
 * content script (kick-socket-host.js), joined by a fake port pair.
 */
const read = (p) => readFileSync(join(import.meta.dir, '..', p), 'utf8')
const HOST = read('src/background/10-kick-socket-host.js')
const FRAME = read('src/content/kick-socket-host.js')
const RUNTIME_ID = 'ext-id'

function portPair() {
  const mk = () => ({ msg: [], dis: [], peer: null, dead: false })
  const a = mk()
  const b = mk()
  a.peer = b
  b.peer = a
  const api = (s, sender) => ({
    name: 'hs-kick-socket',
    sender,
    postMessage(m) {
      if (s.dead) throw new Error('disconnected port')
      const copy = JSON.parse(JSON.stringify(m))
      queueMicrotask(() => {
        if (!s.peer.dead) for (const f of s.peer.msg) f(copy)
      })
    },
    disconnect() {
      if (s.dead) return
      s.dead = s.peer.dead = true
      queueMicrotask(() => {
        for (const f of s.peer.dis) f()
      })
    },
    onMessage: { addListener: (f) => s.msg.push(f) },
    onDisconnect: { addListener: (f) => s.dis.push(f) },
  })
  return { a, b, api }
}

/** A kick socket in the frame: records what was sent, driven by the test. */
function fakeSockets() {
  const all = []
  class WS {
    constructor(url) {
      this.url = url
      this.sent = []
      this.closed = false
      all.push(this)
    }
    send(d) {
      this.sent.push(d)
    }
    close() {
      if (this.closed) return
      this.closed = true
      queueMicrotask(() => this.onclose?.({ code: 1000 }))
    }
  }
  return { WS, all }
}

function world({
  sender = { id: RUNTIME_ID, url: 'https://web.kick.com/robots.txt' },
  frameLoads = true,
  slowClose = false,
} = {}) {
  const listeners = []
  const frames = []
  const timers = []
  const sockets = fakeSockets()
  let made = 0
  let hasDoc = false
  let closing = 0
  // the frame: a content script with its own runtime.connect
  const loadFrame = () => {
    const { api, a, b } = portPair()
    const framePort = api(a)
    const bgPort = api(b, sender)
    const runtime = { connect: () => framePort }
    new Function('window', 'globalThis', 'WebSocket', FRAME)({ top: {} }, { browser: { runtime } }, sockets.WS)
    for (const l of listeners) l(bgPort)
    frames.push({ framePort, bgPort })
  }
  const offscreen = {
    hasDocument: async () => hasDoc,
    closeDocument: async () => {
      hasDoc = false
      if (!slowClose) return
      // chrome: the document is gone to hasDocument at once and its slot a moment later
      closing++
      await new Promise((r) => setTimeout(r, 0))
      closing--
    },
    createDocument: async () => {
      if (closing) throw new Error('Only a single offscreen document may be created.')
      hasDoc = true
      made++
      if (frameLoads) queueMicrotask(loadFrame)
    },
  }
  const browser = { runtime: { id: RUNTIME_ID, onConnect: { addListener: (f) => listeners.push(f) } } }
  const host = new Function(
    'browser',
    'globalThis',
    'setTimeout',
    'log',
    `${HOST}\nreturn { _kpOpenSocket, _kpHostRelease, port: () => _kpHostPort, sockets: _kpHostSockets }`,
  )(
    browser,
    { chrome: { offscreen } },
    (f, ms) => timers.push({ f, ms }),
    () => {},
  )
  return { host, sockets, frames, timers, made: () => made, hasDoc: () => hasDoc }
}

const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}

function watch(ws) {
  const ev = []
  ws.onopen = () => ev.push('open')
  ws.onmessage = (e) => ev.push(`msg:${e.data}`)
  ws.onclose = (e) => ev.push(`close:${e.code}`)
  ws.onerror = () => ev.push('error')
  return ev
}

describe('the tap socket, opened in a kick.com frame', () => {
  test('opens through the frame and carries frames both ways', async () => {
    const w = world()
    const ws = w.host._kpOpenSocket('wss://realtime.us-east-1.platform.kick.com/connection/websocket')
    const ev = watch(ws)
    await tick()
    expect(w.made()).toBe(1)
    const real = w.sockets.all[0]
    expect(real.url).toBe('wss://realtime.us-east-1.platform.kick.com/connection/websocket')
    real.onopen()
    await tick()
    expect(ws.readyState).toBe(1)
    ws.send('{"connect":{}}')
    await tick()
    expect(real.sent).toEqual(['{"connect":{}}'])
    real.onmessage({ data: '{"id":1,"connect":{}}' })
    await tick()
    expect(ev).toEqual(['open', 'msg:{"id":1,"connect":{}}'])
    ws.close()
    await tick()
    expect(real.closed).toBe(true)
    expect(ev.at(-1)).toBe('close:1000')
    expect(w.host.sockets.size).toBe(0)
  })

  test('a second socket reuses the frame', async () => {
    const w = world()
    w.host._kpOpenSocket('wss://a.platform.kick.com/x')
    await tick()
    w.host._kpOpenSocket('wss://b.platform.kick.com/x')
    await tick()
    expect(w.made()).toBe(1)
    expect(w.sockets.all.map((s) => s.url)).toEqual(['wss://a.platform.kick.com/x', 'wss://b.platform.kick.com/x'])
  })

  test('no frame within the wait reads as a socket that closed before opening', async () => {
    const w = world({ frameLoads: false })
    const ws = w.host._kpOpenSocket('wss://a.platform.kick.com/x')
    const ev = watch(ws)
    await tick()
    for (const t of w.timers.splice(0)) t.f()
    await tick()
    expect(ev).toEqual(['close:1006'])
  })

  test('the frame lost (its document closed): open sockets close, the next makes a new frame', async () => {
    const w = world()
    const ws = w.host._kpOpenSocket('wss://a.platform.kick.com/x')
    const ev = watch(ws)
    await tick()
    w.sockets.all[0].onopen()
    await tick()
    w.frames[0].framePort.disconnect()
    await tick()
    expect(ev).toEqual(['open', 'close:1006'])
    w.host._kpOpenSocket('wss://a.platform.kick.com/x')
    await tick()
    expect(w.made()).toBe(2)
  })

  test('the worker gone (a restart): the frame closes its kick sockets', async () => {
    const w = world()
    w.host._kpOpenSocket('wss://a.platform.kick.com/x')
    await tick()
    w.frames[0].bgPort.disconnect()
    await tick()
    expect(w.sockets.all[0].closed).toBe(true)
  })

  test('a port from anything but the embedded frame is turned away', async () => {
    for (const sender of [
      { id: 'other-ext', url: 'https://web.kick.com/robots.txt' },
      { id: RUNTIME_ID, url: 'https://web.kick.com/robots.txt', tab: { id: 4 } },
      { id: RUNTIME_ID, url: 'https://kick.com/xqc' },
    ]) {
      const w = world({ sender })
      const ev = watch(w.host._kpOpenSocket('wss://a.platform.kick.com/x'))
      await tick()
      expect(w.host.port()).toBe(null)
      expect(w.sockets.all).toEqual([])
      for (const t of w.timers.splice(0)) t.f()
      await tick()
      expect(ev).toEqual(['close:1006'])
    }
  })

  test('the frame opens kick sockets only', async () => {
    const w = world()
    const ev = watch(w.host._kpOpenSocket('wss://evil.example/x'))
    await tick()
    expect(w.sockets.all).toEqual([])
    expect(ev).toEqual(['close:1008'])
  })

  test('a join right after the frame was let go waits for it to close', async () => {
    const w = world({ slowClose: true })
    w.host._kpOpenSocket('wss://a.platform.kick.com/x')
    await tick()
    w.host._kpHostRelease()
    const ev = watch(w.host._kpOpenSocket('wss://a.platform.kick.com/y'))
    await tick()
    expect(w.made()).toBe(2)
    expect(ev).toEqual([])
    expect(w.sockets.all.at(-1).url).toBe('wss://a.platform.kick.com/y')
  })

  test('idle: the frame goes', async () => {
    const w = world()
    w.host._kpOpenSocket('wss://a.platform.kick.com/x')
    await tick()
    expect(w.hasDoc()).toBe(true)
    w.host._kpHostRelease()
    await tick()
    expect(w.hasDoc()).toBe(false)
    expect(w.host.port()).toBe(null)
  })
})

test('the frame script stays out of pages people open', () => {
  const connects = []
  const port = { postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }
  const run = (win, label) =>
    new Function('window', 'globalThis', 'WebSocket', FRAME)(
      win,
      {
        browser: {
          runtime: {
            connect: () => {
              connects.push(label)
              return port
            },
          },
        },
      },
      class {},
    )
  run({ top: {} }, 'framed')
  const tab = {}
  tab.top = tab // a web.kick.com/robots.txt someone opened in a tab
  run(tab, 'tab')
  expect(connects).toEqual(['framed'])
})

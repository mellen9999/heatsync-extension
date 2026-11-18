// ─── Kick tap socket host ────────────────────────────────────────────────────
// Kick's realtime socket accepts a *.kick.com origin and nothing else. The worker (firefox: the
// background page) connects as the extension and is refused before the handshake, so from the
// move to centrifugo (11-10) until 11-17 the tap never once connected and kick rode the server
// relay alone. The socket opens in a web.kick.com frame the background owns instead: chrome's
// offscreen document, firefox's own background page. kick-socket-host.js is the frame's half;
// a port carries the socket here, and _kpOpenSocket hands the tap something shaped like one.
const KP_HOST_URL = 'https://web.kick.com/robots.txt' // a tiny page kick lets anything frame
const KP_HOST_PORT = 'hs-kick-socket'
const KP_HOST_WAIT_MS = 10000
let _kpHostPort = null
let _kpHostWaiters = []
let _kpHostStarting = null
let _kpHostSid = 0
const _kpHostSockets = new Map() // sid -> socket shim

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== KP_HOST_PORT) return
  // only the frame this file embeds: this extension, no tab, the host page
  const s = port.sender
  if (s?.id !== browser.runtime.id || s.tab || !String(s.url || '').startsWith(KP_HOST_URL)) {
    port.disconnect()
    return
  }
  if (_kpHostPort) _kpHostDrop(_kpHostPort)
  _kpHostPort = port
  port.onMessage.addListener((m) => {
    const ws = _kpHostSockets.get(m?.sid)
    if (ws) ws._ev(m)
  })
  port.onDisconnect.addListener(() => {
    if (_kpHostPort === port) _kpHostDrop(port)
  })
  for (const w of _kpHostWaiters.splice(0)) w(port)
})

// every socket on a lost port is closed, so the tap's own reconnect takes over (one still
// waiting for a frame is not on any port yet, and keeps waiting)
function _kpHostDrop(port) {
  if (_kpHostPort === port) _kpHostPort = null
  for (const ws of [..._kpHostSockets.values()]) if (ws._port === port) ws._ev({ ev: 'close', code: 1006 })
}

function _kpHostWait() {
  return new Promise((res) => {
    _kpHostWaiters.push(res)
    setTimeout(() => {
      _kpHostWaiters = _kpHostWaiters.filter((w) => w !== res)
      res(null)
    }, KP_HOST_WAIT_MS)
  })
}

let _kpHostClosing = null

// The frame, made if it is missing. A frame left over from an earlier worker has lost its port
// and is made again rather than waited on.
async function _kpHostFrame(fresh) {
  const off = globalThis.chrome?.offscreen
  if (off) {
    // a release still closing the last document: chrome holds one at a time, and a
    // join that raced it had its document refused and its socket closed before it opened
    await _kpHostClosing
    if (await off.hasDocument?.()) {
      if (!fresh) return
      await off.closeDocument().catch(() => {})
    }
    await off.createDocument({
      url: 'offscreen.html',
      reasons: ['IFRAME_SCRIPTING'],
      justification: "kick's chat socket opens only from a kick.com page",
    })
    return
  }
  if (typeof document === 'undefined') throw new Error('no frame host')
  document.getElementById('hs-kick-socket-host')?.remove()
  const f = document.createElement('iframe')
  f.id = 'hs-kick-socket-host'
  f.src = KP_HOST_URL
  document.body.appendChild(f)
}

function _kpHostEnsure() {
  if (_kpHostPort) return Promise.resolve(_kpHostPort)
  _kpHostStarting ||= (async () => {
    const ready = _kpHostWait()
    try {
      await _kpHostFrame(true)
    } catch (e) {
      log('KP: socket host frame failed:', e?.message || e)
      return null
    }
    return ready
  })().finally(() => {
    _kpHostStarting = null
  })
  return _kpHostStarting
}

// The tap is idle (no kick channel left): the frame goes too.
function _kpHostRelease() {
  const port = _kpHostPort
  if (port) _kpHostDrop(port)
  try {
    port?.disconnect()
  } catch {}
  const closing = globalThis.chrome?.offscreen?.closeDocument?.().catch(() => {})
  if (closing) _kpHostClosing = closing
  if (typeof document !== 'undefined') document.getElementById('hs-kick-socket-host')?.remove()
}

// A WebSocket, as far as the tap uses one: readyState, send, close, on{open,message,error,close}.
// No host within KP_HOST_WAIT_MS reads as a socket that closed before it opened.
function _kpOpenSocket(url) {
  const sid = ++_kpHostSid
  const ws = {
    _port: null,
    readyState: 0,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(data) {
      if (ws.readyState !== 1 || !ws._port) throw new Error('kick socket not open')
      ws._port.postMessage({ sid, op: 'send', data })
    },
    close() {
      if (ws.readyState >= 2) return
      const was = ws.readyState
      ws.readyState = 2
      if (ws._port) {
        try {
          ws._port.postMessage({ sid, op: 'close' })
        } catch {}
      }
      // an open socket says it closed when the frame's does; one still opening, at once
      if (was !== 1 || !ws._port) ws._ev({ ev: 'close', code: 1000 })
    },
    _ev(m) {
      if (ws.readyState === 3) return
      if (m.ev === 'open' && ws.readyState === 0) {
        ws.readyState = 1
        ws.onopen?.()
      } else if (m.ev === 'message' && ws.readyState === 1) ws.onmessage?.({ data: String(m.data) })
      else if (m.ev === 'error') ws.onerror?.()
      else if (m.ev === 'close') {
        ws.readyState = 3
        _kpHostSockets.delete(sid)
        ws.onclose?.({ code: m.code })
      }
    },
  }
  _kpHostSockets.set(sid, ws)
  _kpHostEnsure().then((p) => {
    if (ws.readyState !== 0) return
    if (!p) return ws._ev({ ev: 'close', code: 1006 })
    ws._port = p
    p.postMessage({ sid, op: 'open', url })
  })
  return ws
}

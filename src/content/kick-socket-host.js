// The socket end of the background's kick tap (src/background/10-kick-socket-host.js). Runs only
// in the web.kick.com frame the background embeds, never in a page someone opened: kick's chat
// socket takes a kick.com origin and nothing else, and this frame has one.
;(() => {
  if (window.top === window) return
  const api = globalThis.browser || globalThis.chrome
  // firefox: a content script's own WebSocket connects as the add-on (refused); the page's
  // connects as web.kick.com. chrome's content scripts already connect as the page.
  const page = window.wrappedJSObject
  const WS = page?.WebSocket || WebSocket
  const fn = (f) => (page && typeof exportFunction === 'function' ? exportFunction(f, window) : f)
  const KICK_WSS = /^wss:\/\/[a-z0-9.-]+\.kick\.com\//
  const socks = new Map()
  const port = api.runtime.connect({ name: 'hs-kick-socket' })
  const tell = (m) => {
    try {
      port.postMessage(m)
    } catch {}
  }
  port.onMessage.addListener((m) => {
    if (m?.op === 'open') {
      if (!KICK_WSS.test(String(m.url))) return tell({ sid: m.sid, ev: 'close', code: 1008 })
      let ws
      try {
        ws = new WS(m.url)
      } catch {
        return tell({ sid: m.sid, ev: 'close', code: 1006 })
      }
      socks.set(m.sid, ws)
      ws.onopen = fn(() => tell({ sid: m.sid, ev: 'open' }))
      ws.onmessage = fn((e) => tell({ sid: m.sid, ev: 'message', data: String(e.data) }))
      ws.onerror = fn(() => tell({ sid: m.sid, ev: 'error' }))
      ws.onclose = fn((e) => {
        socks.delete(m.sid)
        tell({ sid: m.sid, ev: 'close', code: e.code })
      })
    } else if (m?.op === 'send') {
      try {
        socks.get(m.sid)?.send(String(m.data))
      } catch {}
    } else if (m?.op === 'close') {
      try {
        socks.get(m.sid)?.close()
      } catch {}
    }
  })
  // the background went away (a worker restart): its sockets go with it, and it makes a new frame
  port.onDisconnect.addListener(() => {
    for (const ws of socks.values()) {
      try {
        ws.close()
      } catch {}
    }
    socks.clear()
  })
})()

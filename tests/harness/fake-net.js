// fake network for the service-worker harness: a fetch driven by a route table and a
// WebSocket a test can open, feed frames to, and drop. nothing here touches a real socket.

/** build a JSON response for a route handler */
export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
/** an empty response with this status (404, 429, 500 ...) */
export const status = (code, body = '') => new Response(body, { status: code })
/** what a dead network does: fetch rejects, no response at all */
export const networkError = (msg = 'Failed to fetch') => {
  throw new TypeError(msg)
}

const toMatcher = (m) => {
  if (typeof m === 'function') return m
  if (m instanceof RegExp) return (url) => m.test(url)
  if (typeof m === 'string' && m.endsWith('*')) return (url) => url.startsWith(m.slice(0, -1))
  return (url) => url === m
}

export function createNet(clock) {
  /** @type {{match: Function, handler: Function}[]} */
  const routes = []
  const calls = []
  const unrouted = []
  let inflight = 0

  const net = {
    routes,
    /** every fetch the worker made: { url, method, headers, body, signal } */
    calls,
    /** urls the worker asked for that no route answered (they fail like a dead network) */
    unrouted,
    busy: () => inflight > 0,
    /**
     * answer requests matching `matcher` (exact url, 'prefix*', RegExp, or fn(url, req) -> bool).
     * handler is a value (sent as a 200 JSON body), a Response, or fn(req) -> either (may be async,
     * may throw to simulate a network failure). Later routes win, so a test overrides defaults.
     */
    on(matcher, handler) {
      const entry = { match: toMatcher(matcher), handler }
      routes.unshift(entry)
      return () => {
        const i = routes.indexOf(entry)
        if (i >= 0) routes.splice(i, 1)
      }
    },
    /** calls whose url contains `part` */
    callsTo: (part) => calls.filter((c) => c.url.includes(part)),
    reset() {
      routes.length = 0
      calls.length = 0
      unrouted.length = 0
    },
    async fetch(input, init = {}) {
      const url = typeof input === 'string' ? input : input?.url || String(input)
      const req = {
        url,
        method: String(init.method || input?.method || 'GET').toUpperCase(),
        headers: Object.fromEntries(new Headers(init.headers || input?.headers || {}).entries()),
        body: init.body ?? null,
        signal: init.signal || null,
        json() {
          return JSON.parse(typeof this.body === 'string' ? this.body : '')
        },
      }
      calls.push(req)
      clock.touch()
      const route = routes.find((r) => r.match(url, req))
      if (!route) {
        unrouted.push(url)
        throw new TypeError(`Failed to fetch (harness: no route for ${req.method} ${url})`)
      }
      if (req.signal?.aborted) throw req.signal.reason || new DOMException('aborted', 'AbortError')
      inflight++
      try {
        const run = async () => {
          const h = route.handler
          const out = typeof h === 'function' ? await h(req) : h
          // a static Response is answered afresh each time (a body can only be read once)
          return out instanceof Response ? (typeof h === 'function' ? out : out.clone()) : json(out)
        }
        if (!req.signal) return await run()
        // an abort (the worker's own timeout) wins over a handler that is still thinking
        return await Promise.race([
          run(),
          new Promise((_, reject) => {
            req.signal.addEventListener(
              'abort',
              () => reject(req.signal.reason || new DOMException('aborted', 'AbortError')),
              { once: true },
            )
          }),
        ])
      } finally {
        inflight--
        clock.touch()
      }
    },
  }
  return net
}

/** `await never()` in a route handler = a server that accepts the request and never answers */
export const never = () => new Promise(() => {})

/** @param {{ autoOpen?: boolean }} [opts] autoOpen: every socket finishes its handshake by itself, one microtask after `new` */
export function createWebSocketClass(clock, { autoOpen = false } = {}) {
  const sockets = []

  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    CONNECTING = 0
    OPEN = 1
    CLOSING = 2
    CLOSED = 3

    constructor(url, protocols) {
      this.url = String(url)
      this.protocols = protocols
      this.readyState = 0
      this.binaryType = 'blob'
      this.bufferedAmount = 0
      this.extensions = ''
      this.protocol = ''
      this.onopen = null
      this.onmessage = null
      this.onclose = null
      this.onerror = null
      /** raw strings the worker sent */
      this.sent = []
      this._listeners = { open: [], message: [], close: [], error: [] }
      sockets.push(this)
      clock.touch()
      // after the caller has had its chance to assign onopen (it does so synchronously)
      if (autoOpen) queueMicrotask(() => this.readyState === 0 && this.open())
    }

    addEventListener(type, fn) {
      this._listeners[type]?.push(fn)
    }
    removeEventListener(type, fn) {
      const l = this._listeners[type]
      const i = l ? l.indexOf(fn) : -1
      if (i >= 0) l.splice(i, 1)
    }
    _fire(type, event) {
      event.type = type
      event.target = this
      const prop = this[`on${type}`]
      if (typeof prop === 'function') prop.call(this, event)
      for (const fn of [...this._listeners[type]]) fn.call(this, event)
      clock.touch()
    }

    send(data) {
      if (this.readyState === 0)
        throw new DOMException(
          "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
          'InvalidStateError',
        )
      if (this.readyState !== 1) return // closing/closed: the browser drops it silently
      this.sent.push(String(data))
      clock.touch()
    }

    /** the worker closing its own socket: the close event follows asynchronously, like the real thing */
    close(code = 1005, reason = '') {
      if (this.readyState >= 2) return
      this.readyState = 2
      Promise.resolve().then(() => {
        if (this.readyState === 3) return
        this.readyState = 3
        this._fire('close', { code, reason, wasClean: true })
      })
    }

    // ---- test controls (the server / network side) ----

    /** the handshake finished */
    open() {
      if (this.readyState !== 0) throw new Error(`harness: open() on a socket that is ${this.readyState}`)
      this.readyState = 1
      this._fire('open', {})
    }
    /** a frame from the server (object -> JSON, string as-is) */
    receive(frame) {
      this._fire('message', { data: typeof frame === 'string' ? frame : JSON.stringify(frame) })
    }
    /** the connection dying under the worker (1006 = no close frame, the network case) */
    drop(code = 1006, reason = '') {
      if (this.readyState === 3) return
      this.readyState = 3
      this._fire('close', { code, reason, wasClean: false })
    }
    /** a socket error followed by the close the browser always sends after it */
    fail() {
      this._fire('error', { message: 'harness: socket error' })
      this.drop(1006)
    }
    /** frames the worker sent, parsed */
    get frames() {
      return this.sent.map((s) => JSON.parse(s))
    }
  }

  return { FakeWebSocket, sockets }
}

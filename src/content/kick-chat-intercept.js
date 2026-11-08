// Runs in MAIN world at document_start on Kick BEFORE Kick's JS.
//
// Taps Kick's OWN Pusher WebSocket — the page's connection, not ours — and
// forwards chat/moderation frames to the ISOLATED world (kick-native-tap.js)
// via window.postMessage. This is the third transport line for kick chat:
// the BG service worker's anonymous Pusher tap and the server webhook relay
// both live OUTSIDE the page and share failure modes the page connection
// doesn't (stale app key after a Kick rotation, wedged MV3 service worker,
// relay channel-cap). If Kick's own chat renders, this tap has the data.
//
// Deliberately dumb: envelope-parse + event whitelist only. All payload
// parsing, channel binding, health gating, and dedup live ISOLATED-side
// where they're testable and can see kickChat state. Mirrors the
// twitch-chat-intercept.js MAIN/ISOLATED split.
;(() => {
  if (window.__heatsyncKickChatTap) return
  window.__heatsyncKickChatTap = true

  const TAP_EVENTS = new Set([
    'App\\Events\\ChatMessageEvent',
    'App\\Events\\MessageDeletedEvent',
    'App\\Events\\UserBannedEvent',
    'App\\Events\\UserUnbannedEvent',
  ])

  const post = (payload) => {
    try {
      window.postMessage(payload, location.origin)
    } catch {}
  }

  function tapSocket(ws, url) {
    // Kick rides Pusher today; accept a first-party ws host too so a future
    // kick.com-proxied socket keeps the tap alive without a code change.
    if (!/pusher\.com|kick\.com/i.test(url)) return
    ws.addEventListener('message', (e) => {
      const raw = e.data
      if (typeof raw !== 'string' || raw.length > 65536) return
      if (raw.indexOf('chatrooms.') === -1) return // cheap prefilter, no parse
      let frame
      try {
        frame = JSON.parse(raw)
      } catch {
        return
      }
      if (!frame || typeof frame.event !== 'string' || typeof frame.channel !== 'string') return
      if (!TAP_EVENTS.has(frame.event) || !/^chatrooms\.\d+\.v2$/.test(frame.channel)) return
      post({
        type: 'heatsync-kick-tap',
        event: frame.event,
        channel: frame.channel,
        // pusher double-encodes: frame.data is a JSON string. Forward as-is;
        // the ISOLATED side owns parsing (keeps this file logic-free).
        data: typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data ?? null),
      })
    })
    // Outgoing pusher:subscribe tells us WHICH chatroom is the current page's —
    // the ISOLATED side binds tap frames to the page channel through this,
    // with zero dependence on Kick's REST API.
    const origSend = ws.send.bind(ws)
    ws.send = (data) => {
      try {
        if (typeof data === 'string' && data.length < 4096 && data.indexOf('pusher:subscribe') !== -1) {
          const m = /chatrooms\.(\d+)\.v2/.exec(data)
          if (m) post({ type: 'heatsync-kick-tap-sub', channel: `chatrooms.${m[1]}.v2` })
        }
      } catch {}
      return origSend(data)
    }
  }

  const NativeWS = window.WebSocket
  window.WebSocket = new Proxy(NativeWS, {
    construct(target, args) {
      const ws = new target(...args)
      try {
        tapSocket(ws, String(args[0] || ''))
      } catch {}
      return ws
    },
  })
})()

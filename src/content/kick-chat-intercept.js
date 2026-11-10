// Runs in MAIN world at document_start on Kick BEFORE Kick's JS.
//
// Taps Kick's OWN realtime (centrifugo) WebSocket — the page's connection, not ours — and
// forwards chat/moderation frames to the ISOLATED world (kick-native-tap.js)
// via window.postMessage. This is the third transport line for kick chat:
// the BG service worker's anonymous tap and the server webhook relay
// both live OUTSIDE the page and share failure modes the page connection
// doesn't (a transport move on Kick's side, wedged MV3 service worker,
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
    // Kick's realtime is centrifugo (realtime.<region>.platform.kick.com); any
    // first-party ws host is accepted so a region/host move keeps the tap alive.
    if (!/kick\.com/i.test(url)) return
    ws.addEventListener('message', (e) => {
      const raw = e.data
      if (typeof raw !== 'string' || raw.length > 65536) return
      if (raw.indexOf('chatrooms.') === -1) return // cheap prefilter, no parse
      // centrifugo may pack several frames into one message, newline-delimited
      for (const line of raw.split('\n')) {
        if (line.indexOf('chatrooms.') === -1) continue
        let frame
        try {
          frame = JSON.parse(line)
        } catch {
          continue
        }
        // {push:{channel, pub:{data:{event, data}}}} — the pusher-era
        // {event, channel, data}, one envelope deeper.
        const push = frame && frame.push
        const inner = push && push.pub && push.pub.data
        if (!inner || typeof inner.event !== 'string' || typeof push.channel !== 'string') continue
        if (!TAP_EVENTS.has(inner.event) || !/^chatrooms\.\d+\.v2$/.test(push.channel)) continue
        post({
          type: 'heatsync-kick-tap',
          event: inner.event,
          channel: push.channel,
          // inner.data is a JSON string (or, defensively, an object). Forward
          // a string; the ISOLATED side owns parsing (keeps this file logic-free).
          data: typeof inner.data === 'string' ? inner.data : JSON.stringify(inner.data ?? null),
        })
      }
    })
    // Outgoing {subscribe:{channel:"chatrooms.<id>.v2"}} tells us WHICH chatroom
    // is the current page's — the ISOLATED side binds tap frames to the page
    // channel through this, with zero dependence on Kick's REST API.
    const origSend = ws.send.bind(ws)
    ws.send = (data) => {
      try {
        if (typeof data === 'string' && data.length < 4096 && data.indexOf('"subscribe"') !== -1) {
          const m = /"channel"\s*:\s*"chatrooms\.(\d+)\.v2"/.exec(data)
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

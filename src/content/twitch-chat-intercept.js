// twitch-chat-intercept.js — MAIN world, twitch only.
//
// While the heatsync overlay owns the screen, Twitch's own (hidden) chat
// still renders every message through its React pipeline — and because the
// column is display:none'd, Twitch stops trimming it, so hundreds of dead
// React rows pile up (measured: +118MB over vanilla on a busy channel).
//
// This hooks the chat controller's messageHandlerAPI.handleMessage (the same
// interception point 7TV/BTTV use) and, ONLY while the overlay signals
// takeover, swallows plain chat messages before Twitch renders them. Each
// swallowed message is relayed to the isolated world via postMessage — a
// cleaner live source than the DOM-mining native-tap fallback, and one that
// keeps working when Twitch throttles third-party IRC reads.
//
// Fail-open by design, everywhere:
//   - takeover requires BOTH body[data-hs-suppress-native="1"] AND a fresh
//     heartbeat (data-hs-suppress-beat, refreshed by the overlay every 15s,
//     45s TTL). If the overlay dies, hangs, or is torn down, the beat goes
//     stale and Twitch resumes rendering natively — no user ever ends up
//     with zero chat.
//   - only type-0 plain chat messages are swallowed; notices, subs, and
//     moderation events always pass through so Twitch's internal state
//     machines stay intact.
//   - any throw inside the wrapper falls through to Twitch's original
//     handler.
;(() => {
  if (window.__hsChatIntercept) return
  window.__hsChatIntercept = true

  const BEAT_TTL = 45000

  function suppressing() {
    const ds = document.body && document.body.dataset
    if (!ds || ds.hsSuppressNative !== '1') return false
    const beat = +ds.hsSuppressBeat || 0
    return Date.now() - beat < BEAT_TTL
  }

  // Defined in autocomplete-hook.js (same MAIN-world content_scripts entry,
  // loaded first per manifest.json js[] order) — reused here instead of a
  // second copy of the fiber-walk.
  const getFiber = window.__hsGetFiber

  function findHandlerApi() {
    const el = document.querySelector(
      '.chat-scrollable-area__message-container, [data-test-selector="chat-scrollable-area__message-container"]',
    )
    if (!el) return null
    let f = getFiber(el)
    for (let i = 0; f && i < 40; i++, f = f.return) {
      const api = f.memoizedProps && f.memoizedProps.messageHandlerAPI
      if (api && typeof api.handleMessage === 'function') return api
    }
    return null
  }

  // Minimal structured-clonable copy of exactly the fields the overlay's
  // _tapToMsg reads. Twitch's message objects can carry functions/cycles —
  // never postMessage them raw.
  function strip(m) {
    const u = m.user || {}
    const rawParts = Array.isArray(m.messageParts)
      ? m.messageParts
      : m.message && Array.isArray(m.message.messageParts)
        ? m.message.messageParts
        : null
    let parts = null
    if (rawParts) {
      parts = []
      for (const p of rawParts) {
        if (!p) continue
        const c = p.content
        if (typeof c === 'string') {
          parts.push({ content: c })
          continue
        }
        if (c && typeof c === 'object') {
          parts.push({
            text: typeof p.text === 'string' ? p.text : undefined,
            content: {
              alt: typeof c.alt === 'string' ? c.alt : undefined,
              emoteName: typeof c.emoteName === 'string' ? c.emoteName : undefined,
              emoteID: c.emoteID != null ? String(c.emoteID) : c.emoteId != null ? String(c.emoteId) : undefined,
              text: typeof c.text === 'string' ? c.text : undefined,
              url: typeof c.url === 'string' ? c.url : undefined,
              displayName: typeof c.displayName === 'string' ? c.displayName : undefined,
              recipient: typeof c.recipient === 'string' ? c.recipient : undefined,
            },
          })
          continue
        }
        if (typeof p.text === 'string') parts.push({ text: p.text, content: {} })
      }
    }
    let badges
    const rawBadges = m.badges || u.badges || null
    if (Array.isArray(rawBadges)) {
      badges = rawBadges
        .map((b) => (b && b.setID ? { setID: String(b.setID), version: String(b.version || '1') } : null))
        .filter(Boolean)
    } else if (rawBadges && typeof rawBadges === 'object') {
      badges = {}
      for (const k in rawBadges) {
        if (typeof rawBadges[k] === 'string' || typeof rawBadges[k] === 'number') badges[k] = String(rawBadges[k])
      }
    }
    return {
      id: String(m.id),
      timestamp: typeof m.timestamp === 'number' ? m.timestamp : undefined,
      messageType: m.messageType,
      isAction: !!m.isAction,
      messageBody: typeof m.messageBody === 'string' ? m.messageBody : undefined,
      // shared-chat provenance — partner-channel messages carry a source room
      // that differs from the current room (field names drift; pass both)
      roomID: m.roomID != null ? String(m.roomID) : m.roomId != null ? String(m.roomId) : undefined,
      sourceRoomID:
        m.sourceRoomID != null ? String(m.sourceRoomID) : m.sourceRoomId != null ? String(m.sourceRoomId) : undefined,
      badges,
      messageParts: parts,
      user: {
        userDisplayName: u.userDisplayName || u.displayName || '',
        userLogin: u.userLogin || u.login || '',
        userID: u.userID != null ? String(u.userID) : u.userId != null ? String(u.userId) : '',
        color: typeof u.color === 'string' ? u.color : '',
      },
    }
  }

  function hook() {
    const api = findHandlerApi()
    if (!api || api.__hsHooked) return
    const orig = api.handleMessage
    api.handleMessage = function (msg) {
      try {
        // Plain chat message (twitch enum type 0) with a real sender, while
        // the overlay owns the screen → relay + swallow. Shape checks keep a
        // wrong enum guess from ever swallowing the wrong class of event.
        if (
          msg &&
          msg.type === 0 &&
          msg.id &&
          msg.user &&
          (msg.messageParts || msg.messageBody || msg.message) &&
          suppressing()
        ) {
          window.postMessage({ __hsNativeMsg: 1, m: strip(msg) }, location.origin)
          return
        }
      } catch (_) {}
      // biome-ignore lint/complexity/noArguments: transparent monkeypatch forward. `arguments` passes through every argument the host actually called with, including any we don't model, and keeps the wrapper's arity — rest params would change fn.length, which host code can branch on.
      return orig.apply(this, arguments)
    }
    api.__hsHooked = true
  }

  // The api object is recreated on SPA nav / theatre remounts — cheap
  // re-check (one querySelector + ≤40 fiber hops when unhooked, a property
  // read when hooked). First 30s polls fast: the sooner the hook lands after
  // chat mounts, the fewer backlog rows twitch renders before takeover.
  hook()
  const fast = setInterval(hook, 1000)
  setTimeout(() => {
    clearInterval(fast)
    setInterval(hook, 3000)
  }, 30000)
})()

// Kick page-level chat tap — ISOLATED-world half of chrome/kick-chat-intercept.js.
//
// Third transport line for the CURRENT kick page channel. Primary transports
// (BG service-worker Pusher tap + server webhook relay) cover every joined
// channel from outside the page; this tap covers only the channel whose page
// we're on, using the page's own Pusher socket — the one connection that is
// alive by definition whenever Kick's native chat is. It exists for the
// failure modes the primaries share and the page doesn't: Kick rotating the
// Pusher app key out from under BG's constant, a wedged MV3 service worker,
// or a channel outside the relay's subscription cap.
//
// Inert while healthy: frames are dropped before parsing when the primary
// delivered a message for this channel in the last KICK_TAP_QUIET_MS (same
// richness-guard idea as twitch's native-tap). During a flap the overlap is
// harmless — chat dedups by Kick message id in KickChat.ingestChatPayload;
// a moderation notice could rarely double, which is cosmetic.
//
// Channel binding: the MAIN-world hook reports outgoing pusher:subscribe
// frames; the LAST chatrooms.<id>.v2 subscribed by the page IS the current
// page channel's chatroom (SPA nav resubscribes). Binding is cleared on
// heatsync-nav so a straggler frame from the previous channel can't be
// misattributed during the switch window.

const KICK_TAP_QUIET_MS = 10000

// ── pure mappers (unit-tested; mirror BG's _kpHandleChatEvent/_kpHandleModEvent
// payload shapes EXACTLY so the overlay renders identically and dedups by id) ──

function kickTapChatToPayload(ev, slug) {
  if (!ev || typeof ev !== 'object' || !slug) return null
  if (!ev.content && !ev.id) return null
  return {
    platform: 'kick',
    channel: slug,
    username: ev.sender?.username || 'unknown',
    displayName: ev.sender?.username || 'Unknown',
    senderId: ev.sender?.id ?? null,
    content: ev.content || '',
    color: ev.sender?.identity?.color || '#53fc18',
    badges: ev.sender?.identity?.badges || [],
    timestamp: ev.created_at ? Date.parse(ev.created_at) || Date.now() : Date.now(),
    id: ev.id || '',
    replyTo: ev.metadata?.original_message
      ? {
          username: ev.metadata.original_sender?.username || 'unknown',
          content: ev.metadata.original_message.content || '',
          id: ev.metadata.original_message.id || '',
        }
      : null,
  }
}

function kickTapModToMessage(event, ev, slug) {
  if (!ev || typeof ev !== 'object' || !slug) return null
  if (event === 'App\\Events\\MessageDeletedEvent') {
    const targetMsgId = ev.message?.id || ev.id || ''
    if (!targetMsgId) return null
    return { type: 'kick_moderation', action: 'delete', channel: slug, targetMsgId: String(targetMsgId) }
  }
  if (event === 'App\\Events\\UserBannedEvent') {
    const targetUser = ev.user?.username || ''
    if (!targetUser) return null
    const expMs = ev.expires_at ? Date.parse(ev.expires_at) : 0
    const isTimeout = !!expMs && expMs > Date.now()
    return {
      type: 'kick_moderation',
      action: isTimeout ? 'timeout' : 'ban',
      channel: slug,
      targetUser,
      targetUserId: ev.user?.id != null ? String(ev.user.id) : '',
      banDuration: isTimeout ? Math.max(1, Math.round((expMs - Date.now()) / 1000)) : 0,
    }
  }
  if (event === 'App\\Events\\UserUnbannedEvent') {
    const targetUser = ev.user?.username || ''
    if (!targetUser) return null
    return { type: 'kick_moderation', action: 'unban', channel: slug, targetUser }
  }
  return null
}

// ── fallback pusher connection ──────────────────────────────────────────────
// The passive tap above only helps where Kick's own chat client is running
// (popout chat pages). On normal channel pages the overlay REPLACES native
// chat, Kick's client goes dormant, and there is nothing to tap — so when
// the primaries go quiet the page opens its OWN pusher connection for the
// current channel, feeds the same ingest path, and closes the moment a
// primary delivers again. Interval-paced (never a tight reconnect loop),
// one channel, one socket, id-dedup makes primary overlap harmless.

// Mirrors background.js's KICK_PUSHER_APP_KEY — re-check the live pusher URL
// if kick rotates it. (Scraping the key out of kick's bundle at runtime is
// the durable answer; deliberately out of scope for the first cut.)
const KICK_FALLBACK_APP_KEY = '32cbd69e4b950bf97679'
const KICK_FALLBACK_SILENCE_MS = 120000
const KICK_FALLBACK_CHECK_MS = 30000

function kickFallbackShouldActivate(lastSeenMs, nowMs) {
  return !lastSeenMs || nowMs - lastSeenMs >= KICK_FALLBACK_SILENCE_MS
}

function initKickFallbackSocket() {
  let sock = null
  let sockSlug = null
  let resolving = false
  // Our own liveness clock. kickChat._chanLastSeen is NOT usable here: the
  // KickChat watchdog's escalation rungs re-join the channel every ~90s and
  // join() touches that map — so under total transport death it still looks
  // "fresh" forever and a threshold against it never trips. This map only
  // advances on REAL primary chat messages (not tap-fed, not notices).
  const lastMsgAt = new Map()
  let msgHooked = false
  const hookMessages = () => {
    if (msgHooked || typeof kickChat === 'undefined' || !kickChat?.on) return
    msgHooked = true
    kickChat.on('message', (m) => {
      if (!m || m.type || m.fromNativeTap || m.platform !== 'kick' || !m.channel) return
      lastMsgAt.set(m.channel, Date.now())
    })
  }

  const stats = window.__hsKickTapStats || (window.__hsKickTapStats = {})
  stats.fallbackOpens = 0
  stats.fallbackMsgs = 0

  const close = () => {
    if (sock) {
      try {
        sock.close()
      } catch {}
      sock = null
      sockSlug = null
    }
  }

  async function chatroomIdFor(slug) {
    // BG usually knows (its own tap resolved it); page-origin kick API is the
    // BG-is-dead fallback — same-origin fetch, rides the page's cookies.
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'kick_chatroom_id', slug })
      if (resp?.id) return resp.id
    } catch {}
    try {
      const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
        headers: { accept: 'application/json' },
      })
      if (!r.ok) return null
      const data = await r.json().catch(() => null)
      return data?.chatroom?.id ?? null
    } catch {
      return null
    }
  }

  async function open(slug) {
    if (resolving || sock) return
    resolving = true
    const chatroomId = await chatroomIdFor(slug)
    resolving = false
    if (!chatroomId) {
      stats.fbGate = 'no-chatroom-id'
      return
    }
    // re-check the world after the async gap
    if (sock || getCurrentChannel()?.toLowerCase() !== slug) return
    if (!kickFallbackShouldActivate(lastMsgAt.get(slug) || 0, Date.now())) return
    let ws
    try {
      ws = new WebSocket(
        `wss://ws-us2.pusher.com/app/${KICK_FALLBACK_APP_KEY}?protocol=7&client=js&version=8.4.0&flash=false`,
      )
    } catch {
      return
    }
    sock = ws
    sockSlug = slug
    stats.fallbackOpens++
    ws.onopen = () => {
      try {
        ws.send(
          JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${chatroomId}.v2` } }),
        )
      } catch {}
    }
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return
      let frame
      try {
        frame = JSON.parse(e.data)
      } catch {
        return
      }
      if (frame?.event === 'pusher:ping') {
        try {
          ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }))
        } catch {}
        return
      }
      if (typeof frame?.event !== 'string' || !frame.event.startsWith('App\\Events\\')) return
      let ev
      try {
        ev = typeof frame.data === 'string' ? JSON.parse(frame.data) : frame.data
      } catch {
        return
      }
      if (typeof kickChat === 'undefined' || !kickChat?.channels?.has(sockSlug)) return
      if (frame.event === 'App\\Events\\ChatMessageEvent') {
        const payload = kickTapChatToPayload(ev, sockSlug)
        if (!payload) return
        stats.fallbackMsgs++
        kickChat.ingestChatPayload(payload, { fromNativeTap: true })
      } else {
        const mod = kickTapModToMessage(frame.event, ev, sockSlug)
        if (!mod) return
        kickChat.ingestModeration(mod)
      }
    }
    ws.onclose = () => {
      if (sock === ws) {
        sock = null
        sockSlug = null
      }
    }
    ws.onerror = () => {
      try {
        ws.close()
      } catch {}
    }
  }

  // initKickNativeTap (the only caller of this fn) is gated by window.__hsKickTapBound,
  // a window-lifetime flag SPA reinit never clears — so this interval is never
  // re-registered after the first page load and must survive a reinit's partial
  // drain (see bootstrap.js's _timers.persistent) or it dies on the first SPA
  // nav and never comes back.
  const fbInterval = cleanup.setInterval(() => {
    // On an extension reload/update this old content-script context keeps
    // running, but its install-once flag blocks the fresh injection from
    // re-arming — so without this the stale interval polls a dead closure
    // forever. chrome.runtime.id goes undefined once the context is
    // invalidated; clear ourselves then.
    if (!chrome?.runtime?.id) {
      cleanup.clearInterval(fbInterval)
      close()
      return
    }
    stats.fbTicks = (stats.fbTicks || 0) + 1
    if (typeof isEnabled === 'function' && !isEnabled('kick-native-tap')) {
      stats.fbGate = 'toggle-off'
      close()
      return
    }
    if (typeof kickChat === 'undefined' || !kickChat) {
      stats.fbGate = 'no-kickchat'
      return
    }
    const slug = getCurrentChannel()?.toLowerCase()
    if (!slug || !kickChat.channels?.has(slug)) {
      stats.fbGate = `not-joined:${slug || 'no-slug'}`
      close()
      return
    }
    hookMessages()
    if (sock && sockSlug !== slug) close() // SPA nav — stale socket
    // Seed on first sighting so activation requires an OBSERVED 120s of
    // silence, not "no data since a boot we didn't watch".
    if (!lastMsgAt.has(slug)) lastMsgAt.set(slug, Date.now())
    if (kickFallbackShouldActivate(lastMsgAt.get(slug), Date.now())) {
      stats.fbGate = sock ? 'open' : `opening:${slug}`
      open(slug)
    } else if (sock) {
      stats.fbGate = 'primary-recovered'
      close() // primary recovered — fallback stands down
    } else {
      stats.fbGate = 'primary-healthy'
    }
  }, KICK_FALLBACK_CHECK_MS)
  // Registered once at module load (via the window.__hsKickTapBound guard
  // above), NOT inside a per-nav init — must outlive SPA reinit's partial
  // drain, same reasoning as bootstrap.js's context-death timer.
  cleanup.persistInterval(fbInterval)
}

// ── wiring ──────────────────────────────────────────────────────────────────

function initKickNativeTap() {
  if (window.__hsKickTapBound) return
  window.__hsKickTapBound = true

  // chatrooms.<id>.v2 the page most recently subscribed — null until seen,
  // cleared on SPA nav until the new channel's subscribe lands.
  let boundChatroom = null
  // count frames the tap/fallback actually ingested, for field diagnosis
  const stats = window.__hsKickTapStats || (window.__hsKickTapStats = {})
  Object.assign(stats, { ingested: 0, suppressed: 0, unbound: 0 })
  initKickFallbackSocket()

  window.addEventListener('message', (e) => {
    // Origin check, not just source: the MAIN-world tap posts with
    // location.origin as targetOrigin, so anything arriving from another
    // origin is forged. Without this, any script running on kick.com (a
    // malicious ad, an XSS) could inject chat lines — and ban/unban frames,
    // which render as real mod actions. The twitch tap has always checked
    // both (src/multichat/native-tap.js); kick only checked source.
    if (e.source !== window || e.origin !== location.origin) return
    if (!e.data || typeof e.data !== 'object') return
    const t = e.data.type
    if (t === 'heatsync-nav') {
      boundChatroom = null
      return
    }
    if (t === 'heatsync-kick-tap-sub') {
      if (typeof e.data.channel === 'string' && /^chatrooms\.\d+\.v2$/.test(e.data.channel)) {
        boundChatroom = e.data.channel
      }
      return
    }
    if (t !== 'heatsync-kick-tap') return
    if (typeof isEnabled === 'function' && !isEnabled('kick-native-tap')) return
    if (!boundChatroom || e.data.channel !== boundChatroom) {
      stats.unbound++
      return
    }
    const slug = getCurrentChannel()?.toLowerCase()
    if (!slug || typeof kickChat === 'undefined' || !kickChat?.channels?.has(slug)) return
    // Richness guard: primary transport delivered for this channel recently —
    // the tap has nothing to add, skip before parsing.
    const lastSeen = kickChat._chanLastSeen?.get(slug) || 0
    if (Date.now() - lastSeen < KICK_TAP_QUIET_MS) {
      stats.suppressed++
      return
    }
    let ev
    try {
      ev = JSON.parse(e.data.data)
    } catch {
      return
    }
    if (e.data.event === 'App\\Events\\ChatMessageEvent') {
      const payload = kickTapChatToPayload(ev, slug)
      if (!payload) return
      stats.ingested++
      kickChat.ingestChatPayload(payload, { fromNativeTap: true })
    } else {
      const mod = kickTapModToMessage(e.data.event, ev, slug)
      if (!mod) return
      stats.ingested++
      kickChat.ingestModeration(mod)
    }
  })
}

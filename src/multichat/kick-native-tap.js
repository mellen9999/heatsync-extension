// Kick page-level chat tap — ISOLATED-world half of src/content/kick-chat-intercept.js.
//
// Third transport line for the CURRENT kick page channel. Primary transports
// (BG service-worker tap + server webhook relay) cover every joined
// channel from outside the page; this tap covers only the channel whose page
// we're on, using the page's own realtime socket — the one connection that is
// alive by definition whenever Kick's native chat is. It exists for the
// failure modes the primaries share and the page doesn't: a wedged MV3
// service worker, or a channel outside the relay's subscription cap.
//
// Inert while healthy: frames are dropped before parsing when the primary
// delivered a message for this channel in the last KICK_TAP_QUIET_MS (same
// richness-guard idea as twitch's native-tap). During a flap the overlap is
// harmless — chat dedups by Kick message id in KickChat.ingestChatPayload;
// a moderation notice could rarely double, which is cosmetic.
//
// Channel binding: the MAIN-world hook reports outgoing subscribe
// commands; the LAST chatrooms.<id>.v2 subscribed by the page IS the current
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

// ── wiring ──────────────────────────────────────────────────────────────────

function initKickNativeTap() {
  if (window.__hsKickTapBound) return
  window.__hsKickTapBound = true

  // chatrooms.<id>.v2 the page most recently subscribed — null until seen,
  // cleared on SPA nav until the new channel's subscribe lands.
  let boundChatroom = null
  // count frames the tap actually ingested, for field diagnosis
  const stats = window.__hsKickTapStats || (window.__hsKickTapStats = {})
  Object.assign(stats, { ingested: 0, suppressed: 0, unbound: 0 })

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

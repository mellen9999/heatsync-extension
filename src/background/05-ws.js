// background part 5 of 11 — blocks, notifs, mutes, broadcast, the websocket core.
// build.js concatenates src/background/* in BG_PARTS order into background.js (the service worker cannot import);
// one scope, so a later part may read an earlier part's constants, never the reverse.

// Block emote via HTTP - returns success/failure
async function blockEmote(hash) {
  // Server stores blocks by hash only — silently 404s for empty/null hashes.
  // Reject early to prevent corrupting blockedEmotes Set with undefined entries.
  if (!hash || typeof hash !== 'string') return { success: false, error: 'no hash' }
  try {
    const authToken = await getAuthCookie()
    if (!authToken) {
      // Not logged in - use local storage
      localBlockedEmotes.add(hash)
      markBlockToggle(hash, 'blocked')
      await saveLocalBlockedEmotes()

      const allBlocked = new Set([...blockedEmotes, ...localBlockedEmotes])
      broadcastToTabs({ type: 'blocked_update', blocked: Array.from(allBlocked) })
      broadcastToTabs({ type: 'emote_blocked', hash })
      return { success: true, local: true }
    }

    // Optimistically add to blockedEmotes BEFORE HTTP request
    // Prevents race where WS emote:blocked arrives before HTTP response
    // and triggers inventory_update → emoteGeneration++ → stack rebuild
    blockedEmotes.add(hash)
    markBlockToggle(hash, 'blocked')

    const response = await fetchWithTimeout(`${API_URL}/api/user/emotes/block`, {
      method: 'POST',
      credentials: 'omit', // Bearer-only → CSRF-exempt (cookie would trigger CSRF)
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ emote_hash: hash }),
    })

    if (!response.ok) {
      // Rollback optimistic add
      blockedEmotes.delete(hash)
      const error = await response.json().catch(() => ({ error: 'Unknown error' }))
      console.warn('[heatsync] block refused by server:', response.status, hash, error.error)
      return { success: false, error: error.error || `HTTP ${response.status}` }
    }

    // 2-state model: block is a render-preference, not an inventory mutation.
    // Server preserves the user_emotes row now; local emoteInventory stays in
    // lockstep so an immediate unblock restores the slot membership without a
    // round-trip refetch.

    // Persist server-only set under `blocked_emotes`. Local blocks live in
    // `local_blocked_emotes`. Mixing them under the same key poisons the
    // warm-boot rehydrate (line ~5211) — local-era hashes leak into the
    // server-truth Set and get re-broadcast as fake server blocks.
    persistServerBlockedEmotes()
    broadcastToTabs({ type: 'blocked_update', blocked: Array.from(new Set([...blockedEmotes, ...localBlockedEmotes])) })
    broadcastToTabs({ type: 'emote_blocked', hash })
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message || 'Network error' }
  }
}

// Unblock emote via HTTP - returns success/failure
async function unblockEmote(hash) {
  // Same hash-validity guard as blockEmote — silent 404 corrupts state otherwise.
  if (!hash || typeof hash !== 'string') return { success: false, error: 'no hash' }
  try {
    // Always strip local block too — covers the anon→login transition where a
    // hash sits in localBlockedEmotes and the user expects "unblock" to clear
    // both layers. Without this, the picker (which reads merged via blocked_update)
    // shows the emote as blocked forever even after the server-side unblock.
    const hadLocal = localBlockedEmotes.delete(hash)
    if (hadLocal) await saveLocalBlockedEmotes()

    const authToken = await getAuthCookie()
    if (!authToken) {
      markBlockToggle(hash, 'unblocked')

      const allBlocked = new Set([...blockedEmotes, ...localBlockedEmotes])
      broadcastToTabs({ type: 'blocked_update', blocked: Array.from(allBlocked) })
      broadcastToTabs({ type: 'emote_unblocked', hash })

      log(' 🔓 Unblocked emote locally (not logged in):', hash)
      return { success: true, local: true }
    }

    // If the hash was only ever a local block (anon-era), there's nothing to
    // delete on the server. Skip the HTTP call so a 404 doesn't surface as a
    // false failure to the picker.
    const hadServer = blockedEmotes.has(hash)
    if (!hadServer && hadLocal) {
      markBlockToggle(hash, 'unblocked')
      const allBlocked = new Set([...blockedEmotes, ...localBlockedEmotes])
      broadcastToTabs({ type: 'blocked_update', blocked: Array.from(allBlocked) })
      broadcastToTabs({ type: 'emote_unblocked', hash })
      return { success: true, local: true }
    }

    // Optimistically remove from blockedEmotes BEFORE HTTP request
    // Prevents race where WS emote:unblocked arrives before HTTP response
    blockedEmotes.delete(hash)
    markBlockToggle(hash, 'unblocked')

    const response = await fetchWithTimeout(`${API_URL}/api/user/emotes/blocked/${hash}`, {
      method: 'DELETE',
      credentials: 'omit', // Bearer-only → CSRF-exempt (cookie would trigger CSRF)
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    })

    // Treat 404 as success — the hash isn't on the server, so "unblock" is a no-op.
    // Without this, hash-formula mismatches between block/unblock surfaces (24-slice
    // vs 32-slice vs server-supplied) make every cross-surface unblock look like
    // a network failure and the UI rolls back the optimistic local clear.
    if (!response.ok && response.status !== 404) {
      // Rollback optimistic delete
      blockedEmotes.add(hash)
      const error = await response.json().catch(() => ({ error: 'Unknown error' }))
      return { success: false, error: error.error || `HTTP ${response.status}` }
    }

    persistServerBlockedEmotes()
    // Picker subscribes to `blocked_update` (merged set) only — without this
    // broadcast the open picker keeps showing the just-unblocked emote as
    // blocked until its next `get_inventory` round-trip.
    broadcastToTabs({ type: 'blocked_update', blocked: Array.from(new Set([...blockedEmotes, ...localBlockedEmotes])) })
    broadcastToTabs({ type: 'emote_unblocked', hash })
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message || 'Network error' }
  }
}

// Single owner of the `blocked_emotes` storage key — only server-blocked hashes.
// Drops any queued merged-set write from broadcastToTabs so the next debounce
// flush can't clobber this with stale anon-era hashes.
function persistServerBlockedEmotes() {
  const blockedArr = Array.from(blockedEmotes)
  _broadcastStorageQueue.delete('blocked_emotes')
  browser.storage.local.set({ blocked_emotes: blockedArr }).catch(() => {})
}

// Extension badge — combined source: live followed creators (red, priority) +
// unread heatsync notifications (orange, fallback). Whichever is non-zero wins,
// live wins when both. One number on the icon, colour disambiguates the source.
// Firefox MV2 uses browserAction, Chrome MV3 uses action.
const badgeApi = browser.action || browser.browserAction
function recomputeBadge() {
  if (!badgeApi) return
  const live = _liveFollowedCount || 0
  const notifs = unreadNotifCount || 0
  if (live > 0) {
    badgeApi.setBadgeText({ text: String(live) }).catch(() => {})
    badgeApi.setBadgeBackgroundColor({ color: '#ff0000' }).catch(() => {}) // doctrine: --hs-danger
  } else if (notifs > 0) {
    badgeApi.setBadgeText({ text: String(notifs) }).catch(() => {})
    badgeApi.setBadgeBackgroundColor({ color: '#000000' }).catch(() => {})
  } else {
    badgeApi.setBadgeText({ text: '' }).catch(() => {})
  }
}
function updateExtensionBadge() {
  recomputeBadge()
}

// Resync the toolbar badge's notification count from the server. Runs on
// every WS auth — the in-memory counter misses notification:new events that
// arrive while the socket is idle-closed or the SW is evicted, so reconnect
// always adopts server truth instead of trusting stale local state.
// the few fields of a `notification:new` frame a row needs (contract.md): kind,
// the post it is about, a snippet, whose post it answered. Bounded, no control bytes.
function shapeHsNotif(f) {
  const str = (v, n) =>
    typeof v === 'string'
      ? v
          .replace(/[\u0000-\u001f\u007f]/g, ' ')
          .slice(0, n)
          .trim()
      : ''
  const id = str(f?.message_id, 9)
  return {
    kind: str(f?.kind, 24),
    id: /^[a-z0-9]{1,8}$/i.test(id) ? id : '',
    text: str(f?.content, 300),
    op: typeof f?.parent_is_op === 'boolean' ? f.parent_is_op : null,
    anon: f?.from_username === 'Anonymous',
    time: Date.now(),
  }
}

// the mentions tab was looked at: the server's unread heatsync notifications are read everywhere
async function markNotifsRead() {
  try {
    const res = await fetch('https://heatsync.org/api/notifications/mark-read', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'all' }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return
    unreadNotifCount = 0
    browser.storage.session?.set({ unread_notif_count: 0 }).catch(() => {})
    updateExtensionBadge()
  } catch {}
}

async function hydrateUnreadNotifCount() {
  try {
    const res = await fetch('https://heatsync.org/api/notifications', {
      credentials: 'include',
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return // 401 = not logged in, skip silently
    const data = await res.json()
    if (typeof data?.count !== 'number') return
    if (data.count === unreadNotifCount) return
    unreadNotifCount = data.count
    browser.storage.session?.set({ unread_notif_count: unreadNotifCount }).catch(() => {})
    updateExtensionBadge()
  } catch {}
}

// Persist muted users to storage as { username, expiresAt } objects
function persistMutedUsers() {
  const arr = Array.from(mutedUsers.entries()).map(([username, expiresAt]) => ({ username, expiresAt }))
  browser.storage.local.set({ muted_users: arr }).catch(() => {})
}

// Persist blocked users (mirrors persistMutedUsers). The previous bare set had
// no .catch, so a rejected write in the MV3 service worker (quota, SW teardown)
// was an unhandled rejection AND the block was silently lost — the user
// reappeared after the next SW restart even though the UI showed { ok: true }.
function persistBlockedUsers() {
  browser.storage.local.set({ blocked_users: Array.from(blockedUsers) }).catch(() => {})
}

// Pure frame validators for the live-update pushes (every field is hostile):
// each returns a clean value or an empty/null result, never throws.

// user:blocked / user:unblocked carry the other account's id, nothing else
function blockFrameId(msg) {
  const id = String(msg?.blocked_user_id ?? '')
  return /^[\w-]{1,64}$/.test(id) ? id : ''
}

// notifications:read -> the unread count to show, or -1 when the field is junk
function unreadFromFrame(msg) {
  const n = msg?.unread
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 0), 99999) : -1
}

// bookmarks:changed -> { id, on } or null; ids are the feed's base36 post ids
function bookmarkFrame(msg) {
  return typeof msg?.id === 'string' && /^[0-9a-z]{1,12}$/i.test(msg.id) && typeof msg.on === 'boolean'
    ? { id: msg.id, on: msg.on }
    : null
}

// whisper:new -> the dm_new twitch shape the overlay already dedups, or null
function shapeWhisperFrame(f) {
  const s = (k, n) =>
    String(f?.[k] ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .slice(0, n)
  const at = new Date(s('created_at', 40)).getTime()
  const out = {
    platform: 'twitch',
    id: s('id', 40),
    external_message_id: s('external_message_id', 80),
    from_twitch_id: s('from_twitch_id', 20),
    from_twitch_login: s('from_twitch_login', 40),
    from_display_name: s('from_display_name', 60),
    from_color: s('from_color', 7),
    content: s('content', 2000).trim(),
    created_at: Number.isFinite(at) ? new Date(at).toISOString() : '',
  }
  return out.content && out.from_twitch_login ? out : null
}

// message:approved / message:flagged -> {id, categories} or null. The id is the
// post's base36 id; categories are only ever short strings the held-media
// toggles match on.
function moderationFrame(msg) {
  const d = msg?.data && typeof msg.data === 'object' ? msg.data : msg
  const id = d?.id
  if (typeof id !== 'string' || !/^[0-9a-z]{1,12}$/i.test(id)) return null
  const cats = Array.isArray(d.categories) ? d.categories.filter((c) => typeof c === 'string') : []
  return { id, categories: cats.slice(0, 20).map((c) => c.slice(0, 40)), flagged: msg.type === 'message:flagged' }
}

// dm:message (a threaded heatsync DM, plaintext) -> the incoming-DM shape the
// overlay's handleIncomingDm already renders and dedups, or null. threadId rides
// along so the panel can tell threads apart; the sender's id is how it skips
// your own echo.
function shapeDmThreadMessage(f) {
  const m = f?.message
  if (!m || typeof m !== 'object') return null
  const s = (v, n) =>
    String(v ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .slice(0, n)
  const at = new Date(s(m.created_at, 40)).getTime()
  const color = s(m.sender_color, 7)
  const out = {
    id: s(m.id, 40),
    threadId: s(f.threadId, 40),
    from_user_id: s(m.sender_id, 40),
    from_display_name: s(m.sender_display_name || m.sender_username, 60),
    from_color: /^#[0-9a-f]{6}$/i.test(color) ? color : '',
    content: s(m.content, 2000).trim(),
    created_at: Number.isFinite(at) ? new Date(at).toISOString() : '',
  }
  return out.content && out.from_user_id && out.from_display_name ? out : null
}

// Plus changed: re-read the account, then have the overlay re-resolve your own
// cosmetics (the ids your own paint lookups use) so plus-only ones appear or go.
let _plusRefreshTimer = null
function refreshPlusState() {
  clearTimeout(_plusRefreshTimer)
  _plusRefreshTimer = setTimeout(async () => {
    await fetchUserInfo()
    const { user_info: me } = await browser.storage.local.get('user_info')
    const ids = [
      me?.id,
      me?.twitch_id,
      me?.kick_id && `kick_${me.kick_id}`,
      me?.youtube_channel_id && `yt_${me.youtube_channel_id}`,
    ]
    const own = ids.filter(Boolean)
    for (const id of own) _paintsCache.delete(id)
    if (own.length) broadcastToTabs({ type: 'cosmetic_changed', ids: own })
    broadcastToTabs({ type: 'account_changed' })
  }, 500)
}

// Set the toolbar badge's notification count straight to n (server truth).
function setUnreadNotifCount(n) {
  if (n === unreadNotifCount) return
  unreadNotifCount = n
  browser.storage.session?.set({ unread_notif_count: n }).catch(() => {})
  updateExtensionBadge()
}

// Fetch server-side mute list on first auth — merges with any locally-stored
// mutes so cross-device mutes (set on heatsync.org) take effect immediately.
// Gracefully no-ops if not logged in, server is unreachable, or returns 401.
let _serverMutesFetched = false
async function fetchServerMutes() {
  if (_serverMutesFetched) return
  _serverMutesFetched = true
  try {
    const res = await fetch('https://heatsync.org/api/mutes', {
      credentials: 'include',
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      // fetch does NOT throw on an HTTP error, so the catch below never sees a
      // 5xx — and this runs off the WS 'authenticated' event, so we ARE logged
      // in and a 401 here is a token blip, not "logged out". Leaving the latch
      // set meant server mutes silently never synced again for the whole
      // session (not even on reconnect). Clear it so the next auth retries.
      _serverMutesFetched = false
      return
    }
    const data = await res.json()
    const list = Array.isArray(data) ? data : Array.isArray(data?.mutes) ? data.mutes : null
    if (!list) return
    const now = Date.now()
    let changed = false
    for (const entry of list) {
      const u = (entry.username || entry.user || '').toLowerCase()
      if (!u) continue
      const rawExp = entry.expires_at || entry.expiresAt || null
      const expiresAt = rawExp ? new Date(rawExp).getTime() : null
      if (expiresAt !== null && expiresAt <= now) continue // already expired
      if (!mutedUsers.has(u)) {
        mutedUsers.set(u, expiresAt)
        broadcastToTabs({ type: 'user_muted', username: u, expiresAt })
        changed = true
        log(' server mute synced:', u)
      }
    }
    if (changed) persistMutedUsers()
  } catch (e) {
    log(' fetchServerMutes failed:', e?.message)
    _serverMutesFetched = false // allow retry on next auth
  }
}

// Fetch server-side block list on first auth — merges with any locally-stored
// blocks so cross-device blocks (set on heatsync.org) take effect immediately.
// Gracefully no-ops if not logged in, server is unreachable, or returns 401.
let _serverBlocksFetched = false
// heatsync account id -> blockedUsers key, learned from the server list, so a
// user:unblocked push (which carries only the id) knows which entry to drop
const blockedIdToKey = new Map()
async function fetchServerBlocks(force = false) {
  if (_serverBlocksFetched && !force) return
  _serverBlocksFetched = true
  try {
    const res = await fetch('https://heatsync.org/api/user/blocks', {
      credentials: 'include',
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      // Same as fetchServerMutes: an HTTP error doesn't throw, so the catch
      // can't reset this. Blocks are safety-relevant — a silently un-synced
      // block list means a blocked user's messages reappear in chat with no
      // signal at all. Always allow the next auth to retry.
      _serverBlocksFetched = false
      return
    }
    const data = await res.json()
    const list = Array.isArray(data?.blocked_users) ? data.blocked_users : null
    if (!list) return
    let changed = false
    for (const entry of list) {
      const key = userKey(entry.username, entry.platform || null)
      if (!key) continue
      if (entry.id != null) blockedIdToKey.set(String(entry.id), key)
      if (!blockedUsers.has(key)) {
        blockedUsers.add(key)
        broadcastToTabs({ type: 'user_blocked', username: key })
        changed = true
        log(' server block synced:', key)
      }
    }
    if (changed) persistBlockedUsers()
  } catch (e) {
    log(' fetchServerBlocks failed:', e?.message)
    _serverBlocksFetched = false // allow retry on next auth
  }
}

// Write a mute to the server's REST /api/mutes endpoint. Server broadcasts
// mute:added WS event so heatsync.org MuteManager + other ext instances pick
// up. Bearer auth → CSRF-exempt.
async function syncMuteToServer(username, expiresAtMs) {
  const token = await getAuthCookie()
  if (!token) return // not logged in
  const body = {
    username: username.toLowerCase(),
    platform: null,
    expires_at: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
    reason: null,
  }
  const res = await fetch('https://heatsync.org/api/mutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) log(' /api/mutes POST', res.status)
}

async function syncUnmuteToServer(username) {
  const token = await getAuthCookie()
  if (!token) return
  const res = await fetch(`https://heatsync.org/api/mutes/${encodeURIComponent(username.toLowerCase())}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) log(' /api/mutes DELETE', res.status)
}

// Remove expired mutes and broadcast unmutes
function pruneExpiredMutes() {
  const now = Date.now()
  const expired = []
  for (const [username, expiresAt] of mutedUsers) {
    if (expiresAt !== null && expiresAt <= now) {
      expired.push(username)
    }
  }
  if (expired.length > 0) {
    expired.forEach((u) => {
      mutedUsers.delete(u)
      broadcastToTabs({ type: 'user_unmuted', username: u })
    })
    persistMutedUsers()
    log(' Pruned', expired.length, 'expired mutes')
  }
}

// Prune expired mutes — driven by chrome.alarms 'prune-expired-mutes' (MV3 SW survives across wakeups)

// Live-video resolution cache for yt_resolve_live_video (see the message
// handler) — short TTL: "who is live right now" goes stale in seconds.
const _ytLiveResolveCache = new Map() // url -> { v, ts }
const YT_LIVE_RESOLVE_TTL = 60_000

// Cached tab list to avoid repeated browser.tabs.query IPC on burst broadcasts
let _cachedTabs = null
let _cachedTabsAt = 0
const TAB_CACHE_TTL = 2000 // 2 seconds

async function getMatchingTabs() {
  const now = Date.now()
  if (_cachedTabs && now - _cachedTabsAt < TAB_CACHE_TTL) return _cachedTabs
  _cachedTabs = await browser.tabs.query({
    url: ['*://*.twitch.tv/*', '*://*.kick.com/*', '*://*.youtube.com/*', '*://*.heatsync.org/*', '*://heatsync.org/*'],
  })
  _cachedTabsAt = now
  return _cachedTabs
}

// ── visibility oracle ───────────────────────────────────────────────────────
// A renderer's document.hidden can stick at 'hidden' in a popout window whose
// occlusion/visibility flip got lost — the page then freezes its own chat
// while the user is looking right at it. The BG sees the real user signals
// (a window gaining OS focus, a tab being activated); both are airtight
// proof the tab is on screen, so nudge it and let the content script decide
// whether its visibility state is wedged. Event-driven at human cadence —
// no polling, errors swallowed (tab may have no content script).
function nudgeTabVisible(tabId) {
  browser.tabs.sendMessage(tabId, { type: 'hs_vis_nudge' }).catch(() => {})
}
try {
  browser.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === browser.windows.WINDOW_ID_NONE) return
    try {
      const tabs = await browser.tabs.query({ active: true, windowId })
      for (const t of tabs) nudgeTabVisible(t.id)
    } catch (_) {}
  })
  browser.tabs.onActivated.addListener((info) => {
    nudgeTabVisible(info.tabId)
  })
} catch (_) {}

// Coalesce per-key persistence so high-frequency broadcasts don't write storage 1-2x/sec.
// Latest payload wins; flush after a short idle window.
const _broadcastStorageQueue = new Map() // key -> latest value
let _broadcastStorageTimer = null
const BROADCAST_STORAGE_DEBOUNCE = 5000
function _scheduleBroadcastStorageFlush() {
  if (_broadcastStorageTimer) return
  _broadcastStorageTimer = setTimeout(() => {
    _broadcastStorageTimer = null
    if (!_broadcastStorageQueue.size) return
    const payload = {}
    for (const [k, v] of _broadcastStorageQueue) payload[k] = v
    _broadcastStorageQueue.clear()
    browser.storage.local.set(payload).catch(() => {})
  }, BROADCAST_STORAGE_DEBOUNCE)
}

// Broadcast updates to all content scripts AND update storage
async function broadcastToTabs(message) {
  // Coalesce storage writes — burst broadcasts collapse to one set() per 5s window
  if (message.type === 'inventory_update') {
    _broadcastStorageQueue.set('emote_inventory', message.emotes)
    _scheduleBroadcastStorageFlush()
  } else if (message.type === 'global_emotes_update') {
    _broadcastStorageQueue.set('global_emotes', message.emotes)
    _scheduleBroadcastStorageFlush()
  } else if (message.type === 'blocked_update') {
    // `message.blocked` is merged (server + local) — used by content scripts to
    // render combined block state. Do NOT persist it under `blocked_emotes`:
    // that storage key is owned by persistServerBlockedEmotes() and holds the
    // server-only set. Mixing leaks anon-era local blocks into the server set
    // on warm boot. Local set is persisted separately via saveLocalBlockedEmotes.
  }

  // Broadcast to streaming tabs only (filtered query instead of all-tabs scan)
  try {
    const tabs = await getMatchingTabs()
    for (const tab of tabs) {
      browser.tabs.sendMessage(tab.id, message).catch(() => {})
    }
  } catch (e) {
    console.error('[HS] broadcastToTabs error:', e)
  }
}

// =============================================================================
// BULLETPROOF WEBSOCKET CONNECTION
// =============================================================================
// Features:
// - Message queue for when socket isn't ready
// - Connection state machine
// - Automatic retry with exponential backoff
// - Flush queued messages on connect

const WS_STATE = {
  DISCONNECTED: 0,
  CONNECTING: 1,
  CONNECTED: 2,
  AUTHENTICATED: 3,
}

let wsState = WS_STATE.DISCONNECTED
let isAuthenticated = false
let socketAuthToken = null
let reconnectAttempts = 0
let heartbeatInterval = null // Keep connection alive
let reconnectTimer = null
let pendingReconnectSpreadMs = 0 // Set by server:shutdown — consumed once on next scheduleReconnect to spread the herd
// Set on extension install/update or browser startup. Consumed once by the
// first connectWebSocket() to delay 0–60s, so 30k clients auto-updating in
// the same window don't slam /ws simultaneously.
let pendingStartupJitterMs = 0
const messageQueue = [] // Queue messages when socket not ready
let connectionPromise = null // Track ongoing connection attempt
let lastWsDataReceived = 0 // Timestamp of last received WS message (zombie detection)
// Idle disconnect (mirrors seventvIdleClosed): every WS consumer is
// tab-directed except the toolbar notification badge, which resyncs via
// hydrateUnreadNotifCount on reconnect — so at zero platform tabs the socket
// is pure idle cost (and its 20s heartbeat pins the SW in RAM forever).
// Gates the automatic revival paths only; any explicit connect intent
// (wsSend queue, tab join, auth change) clears it in connectWebSocket.
let hsWsIdleClosed = false

function isSocketOpen() {
  return socket && socket.readyState === WebSocket.OPEN
}

// The server answers every heartbeat (20s) and pushes presence on its own, so
// an open socket that has said nothing for this long is dead even if it looks
// open. A quiet CHAT is not this: an offline channel can be silent for hours
// on a perfectly healthy socket.
const WS_ZOMBIE_MS = 45000
function isSocketZombie() {
  return !!lastWsDataReceived && Date.now() - lastWsDataReceived > WS_ZOMBIE_MS
}

const MESSAGE_QUEUE_TTL = 60000 // 60 seconds — matches max reconnect backoff + jitter

// Flush queued messages when socket becomes ready
function flushMessageQueue() {
  if (!isSocketOpen()) return

  const now = Date.now()
  // Drop messages older than TTL before counting
  while (messageQueue.length > 0 && now - messageQueue[0]._queuedAt > MESSAGE_QUEUE_TTL) {
    log(` 🗑 Dropping stale queued message: ${messageQueue[0].type}`)
    messageQueue.shift()
  }

  const queued = messageQueue.length
  if (queued > 0) {
    log(` 📤 Flushing ${queued} queued messages`)
  }

  while (messageQueue.length > 0 && isSocketOpen()) {
    const msg = messageQueue.shift()
    if (now - msg._queuedAt > MESSAGE_QUEUE_TTL) {
      log(` 🗑 Dropping stale queued message: ${msg.type}`)
      continue
    }
    try {
      // the queue stamp is ours, not the server's
      const { _queuedAt, ...wire } = msg
      socket.send(JSON.stringify(wire))
      log(` 📤 Sent queued: ${msg.type}`)
    } catch (_err) {
      messageQueue.unshift(msg) // Put it back
      break
    }
  }
}

// WS lifecycle breadcrumb — last 30 events persisted to storage.local so a
// dead/misauthed socket is DIAGNOSABLE after the fact (the SW console is
// unreachable in the field; storage is readable from any surface). Sub-100B
// events, debounced writes — silent-failure playbook, not scaffolding.
const _wsDebug = []
let _wsDebugTimer = null
function wsDebugNote(evt, extra) {
  _wsDebug.push(`${new Date().toISOString().slice(11, 19)} ${evt}${extra ? ` ${extra}` : ''}`)
  while (_wsDebug.length > 30) _wsDebug.shift()
  if (_wsDebugTimer) return
  _wsDebugTimer = setTimeout(() => {
    _wsDebugTimer = null
    browser.storage.local.set({ hs_ws_debug: _wsDebug.slice() }).catch(() => {})
  }, 2000)
}

// ============================================
// RELAYED SENDS — what the server may ask this browser to post as the user
// ============================================
// yt:relay_send / kick:relay_send. The legit flow: the user presses Enter in
// the heatsync.org composer, the server tries the platform's own API, and when
// it cannot (no linked token / scope) it asks the user's browser to post with
// the platform login only the browser has.
//
// The frame carries nothing this extension can verify (reqId, target and text
// are all chosen by the server), so it is not trusted on its own. The server
// fans a relay out to ALL of the user's extension sockets, so typing on
// heatsync.org on a phone posts through the desktop browser: no keypress ever
// happens here, and none is required. Before a relayed send runs it must clear:
//   1. a request id not seen before (a replayed frame does nothing)
//   2. not the same text to the same place within RELAY_DUP_MS
//   3. at least RELAY_MIN_GAP_MS since the last one to that place, and under
//      RELAY_PER_TARGET_PER_MIN there / RELAY_GLOBAL_PER_MIN overall. The
//      server's own bucket (5 per 30 s per user) binds first, so a real person
//      never meets these; a server that misbehaves does.
// Every relay, refused, failed or sent, is one line in the worker log and a row
// in hs_relay_log (last 50, local only); the popup's "errors" copy carries counts.
//
// RESIDUAL RISK: a compromised server can still post up to the caps above.
// The real fix is a device-pairing key: the originating device signs each relay
// and this extension verifies it before posting.
const RELAY_DUP_MS = 10_000
const RELAY_MIN_GAP_MS = 1_000
const RELAY_PER_TARGET_PER_MIN = 15
const RELAY_GLOBAL_PER_MIN = 20
const RELAY_REQ_MEMORY_MS = 120_000
const RELAY_TEXT_MAX = { youtube: 200, kick: 500 }
const RELAY_LOG_KEY = 'hs_relay_log'
const RELAY_LOG_MAX = 50

const _relay = {
  admitted: [], // { at, to } of sends let through, last minute
  lastByTarget: new Map(), // to → at of the last one let through
  dupAt: new Map(), // to|text → at
  reqIds: new Map(), // reqId → at
  logP: null, // the stored log, loaded once
  logTimer: null,
}

const relayTextKey = (text) => text.trim().toLowerCase().replace(/\s+/g, ' ')

// Decide, and on yes record the send as under way. Sync, so two frames in one
// tick cannot both pass. Answers null to proceed or the refusal code.
// platform: 'youtube' | 'kick'; target: videoId | channel.
function admitRelay({ platform, target, text, reqId }, now = Date.now()) {
  if (typeof reqId !== 'string' || !reqId || reqId.length > 64) return 'invalid_request'
  const targetOk =
    typeof target === 'string' &&
    (platform === 'youtube' ? YT_VIDEO_ID.test(target) : /^[a-z0-9_-]{1,64}$/i.test(target))
  if (!targetOk) return platform === 'youtube' ? 'invalid_video_id' : 'invalid_channel'
  if (typeof text !== 'string' || !text.trim() || text.length > (RELAY_TEXT_MAX[platform] || 200)) return 'invalid_text'
  const seen = _relay.reqIds.get(reqId)
  if (seen !== undefined && now - seen <= RELAY_REQ_MEMORY_MS) return 'duplicate_request'

  const to = `${platform}:${target.toLowerCase()}`
  const dupKey = `${to}|${relayTextKey(text)}`
  const dupAt = _relay.dupAt.get(dupKey)
  if (dupAt !== undefined && now - dupAt < RELAY_DUP_MS) return 'duplicate_message'

  while (_relay.admitted.length && now - _relay.admitted[0].at > 60_000) _relay.admitted.shift()
  const last = _relay.lastByTarget.get(to)
  if (last !== undefined && now - last < RELAY_MIN_GAP_MS) return 'rate_limited'
  if (_relay.admitted.length >= RELAY_GLOBAL_PER_MIN) return 'rate_limited'
  if (_relay.admitted.filter((a) => a.to === to).length >= RELAY_PER_TARGET_PER_MIN) return 'rate_limited'

  _relay.admitted.push({ at: now, to })
  _relay.lastByTarget.set(to, now)
  _relay.dupAt.set(dupKey, now)
  _relay.reqIds.set(reqId, now)
  pruneRelayMap(_relay.reqIds, now, RELAY_REQ_MEMORY_MS, 200)
  pruneRelayMap(_relay.dupAt, now, RELAY_DUP_MS, 200)
  pruneRelayMap(_relay.lastByTarget, now, 60_000, 100)
  return null
}

// Stale entries go first, then the oldest, so the maps stay small however much arrives.
function pruneRelayMap(m, now, ttlMs, max) {
  for (const [k, at] of m) if (now - at > ttlMs) m.delete(k)
  while (m.size > max) m.delete(m.keys().next().value)
}

// A send that was let through but did not land may be tried again at once.
function releaseRelay({ platform, target, text }) {
  const to = `${platform}:${String(target).toLowerCase()}`
  _relay.dupAt.delete(`${to}|${relayTextKey(String(text))}`)
}

// The local record the user can read: last 50 relayed sends, newest last.
// Repeats of the same outcome to the same place fold into one row with a count,
// so a flood of refusals cannot push the real entries out.
function relayLog() {
  if (!_relay.logP) {
    _relay.logP = browser.storage.local
      .get(RELAY_LOG_KEY)
      .then((got) => (Array.isArray(got?.[RELAY_LOG_KEY]) ? got[RELAY_LOG_KEY] : []))
      .catch(() => [])
  }
  return _relay.logP
}

async function noteRelay({ platform, target, text, outcome }, now = Date.now()) {
  try {
    log(` relay ${platform}:${String(target || '').slice(0, 64)} ${outcome} (${String(text || '').length} chars)`)
    const rows = await relayLog()
    const to = String(target || '').slice(0, 64)
    const prev = rows[rows.length - 1]
    if (prev && prev.p === platform && prev.to === to && prev.r === outcome && now - prev.t < 60_000) {
      prev.t = now
      prev.c = (prev.c || 1) + 1
    } else {
      rows.push({
        t: now,
        p: platform,
        to,
        n: String(text || '').length,
        x: String(text || '').slice(0, 40),
        r: outcome,
      })
      while (rows.length > RELAY_LOG_MAX) rows.shift()
    }
    if (_relay.logTimer) return
    _relay.logTimer = setTimeout(() => {
      _relay.logTimer = null
      browser.storage.local.set({ [RELAY_LOG_KEY]: rows.slice() }).catch(() => {})
    }, 1000)
  } catch {}
}

// The popup's diag copy: counts and where, never the text.
async function relayDiagSummary(now = Date.now()) {
  const rows = await relayLog()
  const outcomes = {}
  for (const r of rows) outcomes[r.r] = (outcomes[r.r] || 0) + (r.c || 1)
  return {
    outcomes,
    recent: rows.slice(-10).map((r) => ({ ageMs: now - r.t, p: r.p, to: r.to, r: r.r, c: r.c || 1 })),
  }
}

// One relayed send, start to ack. `run` does the platform work and answers
// { ok, error?, ... }; the guard decides whether it may run at all.
async function runGuardedRelay(relay, run) {
  try {
    return await guardedRelayInner(relay, run)
  } catch (e) {
    // fail closed and loud: a guard that cannot decide does not send
    log(' relay guard error:', e?.message)
    return { ok: false, error: 'relay_guard_error' }
  }
}

async function guardedRelayInner({ platform, target, text, reqId }, run) {
  const refusal = admitRelay({ platform, target, text, reqId })
  if (refusal) {
    await noteRelay({ platform, target, text, outcome: `refused:${refusal}` })
    return { ok: false, error: refusal }
  }
  let result
  try {
    result = (await run()) || { ok: false, error: 'no_response' }
  } catch (e) {
    result = { ok: false, error: e?.message || 'unknown' }
  }
  if (!result.ok) releaseRelay({ platform, target, text })
  await noteRelay({
    platform,
    target,
    text,
    outcome: result.ok ? 'sent' : `failed:${String(result.error || 'unknown').slice(0, 40)}`,
  })
  return result
}

async function connectWebSocket() {
  // Explicit connect intent ends the idle state — only the automatic
  // revival paths (watchdog alarm, scheduleReconnect, online) honor it.
  hsWsIdleClosed = false
  wsDebugNote('connect', `auth:${!!authToken}`)
  // If already connecting, wait for that attempt
  if (wsState === WS_STATE.CONNECTING && connectionPromise) {
    log(' Connection in progress, waiting...')
    return connectionPromise
  }

  // Consume startup jitter once. SW evictions during the wait are fine —
  // storage.session preserves the deadline so the next wake honors what's left.
  if (pendingStartupJitterMs > 0) {
    const ms = pendingStartupJitterMs
    pendingStartupJitterMs = 0
    browser.storage.session?.remove('startup_jitter_at').catch(() => {})
    log(` ⏱ Startup jitter: delaying first connect by ${Math.round(ms)}ms`)
    await new Promise((r) => setTimeout(r, ms))
  }

  // If already connected with SAME token, skip
  if (isSocketOpen() && socketAuthToken === authToken && wsState >= WS_STATE.CONNECTED) {
    log(' Already connected with same token')
    return Promise.resolve()
  }

  // If connected with DIFFERENT token, disconnect first
  if (isSocketOpen() && socketAuthToken !== authToken) {
    log(' 🔄 Token changed, reconnecting...')
    clearTimeout(reconnectTimer)
    reconnectTimer = null
    socket.onclose = null // prevent scheduleReconnect on intentional close
    socket.onmessage = null
    socket.onopen = null
    socket.onerror = null
    socket.close()
    wsState = WS_STATE.DISCONNECTED
    isAuthenticated = false
  }

  // Claim CONNECTING state BEFORE any await to block concurrent callers
  wsState = WS_STATE.CONNECTING
  connectionPromise = new Promise((resolve, reject) => {
    // Run async work inside the promise executor so the lock is held before any yield
    ;(async () => {
      // The cookie is the truth and this worker's copy goes stale (an unlink
      // reissues it) — read it fresh for every connect, not only when empty.
      await getAuthCookie({ fresh: true })

      socketAuthToken = authToken

      // b=1: this client unwraps {type:'batch'} frames (handleWSMessage), so
      // the server may coalesce fan-out for it — one frame per tick, not per message.
      const wsEndpoint = `${WS_URL.replace('https://', 'wss://').replace('http://', 'ws://')}/ws?b=1`
      log(' 🔌 Connecting to WebSocket:', wsEndpoint, 'with auth:', !!authToken)

      // Defensive: detach handlers from any prior closed/closing socket before reassigning
      if (socket) {
        try {
          socket.onopen = null
          socket.onmessage = null
          socket.onerror = null
          socket.onclose = null
          if (socket.readyState !== WebSocket.CLOSED) socket.close()
        } catch {}
        socket = null
      }

      try {
        socket = new WebSocket(wsEndpoint)
      } catch (err) {
        wsState = WS_STATE.DISCONNECTED
        connectionPromise = null
        scheduleReconnect()
        reject(err)
        return
      }

      // Connection timeout (10 seconds)
      const connectTimeout = setTimeout(() => {
        if (wsState === WS_STATE.CONNECTING) {
          socket.close()
          wsState = WS_STATE.DISCONNECTED
          connectionPromise = null
          scheduleReconnect()
          reject(new Error('Connection timeout'))
        }
      }, 10000)

      socket.onopen = () => {
        clearTimeout(connectTimeout)
        log(' ✅ WebSocket connected')
        // Clear "down" banner once we reconnect
        if (reconnectAttempts >= 3) {
          broadcastToTabs({ type: 'api_status', source: 'heatsync', state: 'up' })
        }
        reconnectAttempts = 0
        wsState = WS_STATE.CONNECTED
        // Missed-push convergence: emote pushes that fired while this socket
        // was down (>60s gap) are gone — nuke the sender cache and tell panels
        // to invalidate, so viewers converge at reconnect instead of at TTL.
        if (lastWsDataReceived && Date.now() - lastWsDataReceived > 60000) {
          if (globalThis.__senderEmoteCache) globalThis.__senderEmoteCache.clear()
          broadcastToTabs({ type: 'emote_added_broadcast', username: '' })
          // Same convergence for paints: any cosmetic:changed push that fired
          // while this socket was down is gone for good. Drop our own cache and
          // tell the panes theirs is suspect — nothing is refetched until a
          // name renders again, so this costs nothing on a quiet tab.
          _paintsCache.clear()
          broadcastToTabs({ type: 'cosmetics_stale_all' })
        }
        // Reset zombie-detection timestamp; otherwise a stale lastWsDataReceived
        // from before the disconnect makes the first heartbeat (90s later) trip
        // the 2min idle threshold and immediately kill the fresh socket.
        lastWsDataReceived = Date.now()

        // Two-layer heartbeat:
        //   1) chrome.alarms 'hs-ws-watchdog' (30s) survives SW eviction — wakes
        //      SW from idle to verify socket health + send heartbeat. Recovery.
        //   2) setInterval below (20s) KEEPS SW ALIVE via Chrome 116+'s
        //      WS-activity rule (any frame in/out within 30s window extends SW
        //      lifetime indefinitely). With this, SW never idle-dies while WS
        //      is connected. Server tolerates duplicate heartbeats.
        // Immediate heartbeat so server sees us right after auth.
        try {
          socket.send(JSON.stringify({ type: 'presence:heartbeat' }))
        } catch {}
        if (heartbeatInterval) {
          untrackInterval(heartbeatInterval)
          heartbeatInterval = null
        }
        heartbeatInterval = trackInterval(
          setInterval(() => {
            if (!isSocketOpen()) return
            try {
              socket.send(JSON.stringify({ type: 'presence:heartbeat' }))
            } catch {}
          }, 20000),
        )

        // Build the connect-time burst as a single queue, then drain it with
        // 80ms spacing. Server enforces a 60-token global WS rate limit per
        // socket (refill 1/sec); a user with 10+ channels was burning the
        // entire budget in <100ms, tripping the 5-violations-close threshold
        // and triggering IP-level fetch backoffs. 80ms cadence (≈12 msg/s) is
        // well under refill rate, full drain still completes in ~2s.
        const burst = []
        if (authToken) burst.push({ type: 'authenticate', token: authToken })
        const rejoinedChannels = new Set()
        for (const entry of tabChannels.values()) {
          if (entry.channel && !rejoinedChannels.has(entry.channel)) {
            const [platform, channel] = entry.channel.split('/')
            burst.push({ type: 'channel:join', platform, channel })
            rejoinedChannels.add(entry.channel)
            // Rejoin the kick tap too — tap-only kick channels have NO
            // server relay, so the server join alone leaves them silent.
            // Idempotent (_kpChannels.has guard).
            if (platform === 'kick') kickTapJoin(channel)
          }
        }
        for (const key of joinedExtraChannels) {
          if (rejoinedChannels.has(key)) continue
          const [platform, channel] = key.split('/')
          if (!platform || !channel) continue
          burst.push({ type: 'channel:join', platform, channel })
          rejoinedChannels.add(key)
          if (platform === 'kick') kickTapJoin(channel)
        }
        try {
          for (const ch of BG_IRC.channels.keys()) {
            const buf = BG_IRC.channels.get(ch)
            const all = buf?.getAll() || []
            const lastTs = all.length > 0 ? all[all.length - 1].time || 0 : 0
            burst.push({ type: 'irc:join', channel: ch })
            burst.push({ type: 'irc:resume', channel: ch, since: lastTs })
          }
        } catch (e) {
          log('irc:resume replay err:', e?.message)
        }
        burst.push({ type: 'feed:join', feed: 'new' })
        for (const room of feedRoomsHeld()) burst.push({ type: 'feed:join', feed: room })

        log(` 🌊 Connect burst queued: ${burst.length} msgs over ~${burst.length * 80}ms`)
        // rooms are rejoined by then: tabs re-seed their origins (a chat:origin missed while down)
        setTimeout(() => broadcastToTabs({ type: 'ws_connected' }), 5000)
        burst.forEach((msg, i) => {
          setTimeout(() => {
            if (!isSocketOpen()) return
            wsSendDirect(msg)
          }, i * 80)
        })

        if (!authToken) {
          log(' ℹ️ No auth token - viewer mode')
          flushMessageQueue()
        }

        // Re-subscribe to YouTube channels (global + per-channel)
        log('[hs-bg] WS connected, re-subscribing YouTube channels...')
        browser.storage.local
          .get(['youtube_url'])
          .then((data) => {
            log('[hs-bg] stored youtube data:', JSON.stringify(data))
            // Global YouTube (live tab)
            if (data.youtube_url) {
              const vidMatch =
                data.youtube_url.match(/[?&]v=([^&]+)/) ||
                data.youtube_url.match(/\/live\/([^?&/]+)/) ||
                data.youtube_url.match(/youtu\.be\/([^?&]+)/)
              if (vidMatch) setYtVideoChannel(vidMatch[1], 'global')
              wsSend({ type: 'youtube:subscribe', url: data.youtube_url })
            }
            // Per-channel YouTube URLs from in-memory map
            for (const [channelId, url] of Object.entries(youtubeChannelUrls)) {
              const vidMatch =
                url.match(/[?&]v=([^&]+)/) || url.match(/\/live\/([^?&/]+)/) || url.match(/youtu\.be\/([^?&]+)/)
              if (vidMatch) setYtVideoChannel(vidMatch[1], channelId)
              wsSend({ type: 'youtube:subscribe', url, channelId })
            }
          })
          .catch(() => {})

        connectionPromise = null
        resolve()
      }

      socket.onmessage = (event) => {
        lastWsDataReceived = Date.now()
        try {
          const msg = JSON.parse(event.data)
          handleWSMessage(msg)
        } catch (err) {
          log(' WS message parse error:', err?.message)
        }
      }

      socket.onclose = (event) => {
        clearTimeout(connectTimeout)
        if (heartbeatInterval) {
          untrackInterval(heartbeatInterval)
          heartbeatInterval = null
        }
        log(' ⚠️ WebSocket disconnected:', event.code, event.reason)
        wsDebugNote('close', String(event.code))
        // Detach handlers from the closing socket so its closure releases
        const closing = event?.target
        if (closing) {
          try {
            closing.onopen = null
            closing.onmessage = null
            closing.onerror = null
            closing.onclose = null
          } catch {}
        }
        wsState = WS_STATE.DISCONNECTED
        isAuthenticated = false
        connectionPromise = null
        scheduleReconnect()
      }

      socket.onerror = (err) => {
        log(' WebSocket error:', err?.message || 'unknown')
      }
    })().catch((err) => {
      wsState = WS_STATE.DISCONNECTED
      connectionPromise = null
      scheduleReconnect()
      reject(err)
    })
  })

  return connectionPromise
}

// Direct send (bypasses queue) - used internally
function wsSendDirect(msg) {
  if (!isSocketOpen()) {
    log(' Cannot send direct - socket not open')
    return false
  }
  try {
    socket.send(JSON.stringify(msg))
    return true
  } catch (_err) {
    return false
  }
}

// Send JSON message over WebSocket (queues if not ready)
function wsSend(msg) {
  // If socket is open and ready, send immediately
  if (isSocketOpen()) {
    try {
      socket.send(JSON.stringify(msg))
      return true
    } catch (_err) {
      return false
    }
  }

  // Queue the message and ensure we're connecting
  log(` 📥 Queueing message: ${msg.type}`)
  messageQueue.push({ ...msg, _queuedAt: Date.now() })

  // Limit queue size to prevent memory issues
  if (messageQueue.length > 50) {
    messageQueue.shift() // Remove oldest
  }

  // Trigger connection if not already connecting. Auth failed — reconnecting
  // just replays the dead cookie and loops authenticate → authentication_failed.
  // Only a fresh login (cookies.onChanged 'set' / set_auth_token) clears the
  // block. Same guard the ws watchdog uses.
  if (wsState === WS_STATE.DISCONNECTED && !authFailedBlock) {
    connectWebSocket().catch((err) => log(' WS connect failed:', err?.message))
  }

  return false
}

// Set on a worker's first ws auth; every later one is a reconnect.
let wsAuthedOnce = false

// Handle incoming WebSocket messages
function handleWSMessage(msg) {
  try {
    log(' 📨 WS message received:', msg.type, msg)

    switch (msg.type) {
      case 'authenticated':
        log(' ✅ Authenticated, userId:', msg.userId)
        wsDebugNote('authed', msg.userId ? 'user' : 'anon')
        isAuthenticated = true
        wsState = WS_STATE.AUTHENTICATED
        // Flush any queued messages now that we're authenticated
        flushMessageQueue()
        // Pull server mute + block lists once per session so heatsync.org
        // actions are reflected immediately (WS events only arrive for changes
        // while connected)
        fetchServerMutes().catch(() => {})
        fetchServerBlocks().catch(() => {})
        // Every auth (not once-per-session): resync the badge counter the
        // idle-closed socket / evicted SW couldn't keep current.
        hydrateUnreadNotifCount().catch(() => {})
        // A reconnect means any account:changed sent while we were away is lost,
        // so re-read the account (linked platforms decide whose emotes are yours).
        // The first auth of a worker is skipped: startup already fetched it.
        if (wsAuthedOnce) fetchUserInfo().catch(() => {})
        wsAuthedOnce = true
        break

      case 'account:changed':
        // A platform was linked or unlinked on heatsync.org: without this the
        // ext kept the old identity until a restart and told a linked user
        // their emotes "won't render for others". Flair set or cleared there too:
        // the panels drop what they hold for your own rows and ask again.
        fetchUserInfo().catch(() => {})
        broadcastToTabs({ type: 'account_changed' }).catch(() => {})
        break

      // blocked / unblocked on heatsync.org or another device. The frame has only
      // the account id: a block re-reads the list (learns the name), an unblock
      // drops the entry that id was learned under.
      case 'user:blocked':
        if (blockFrameId(msg)) fetchServerBlocks(true).catch(() => {})
        break

      case 'user:unblocked': {
        const id = blockFrameId(msg)
        const key = id ? blockedIdToKey.get(id) : ''
        if (!key) break
        blockedIdToKey.delete(id)
        if (!blockedUsers.delete(key)) break
        persistBlockedUsers()
        broadcastToTabs({ type: 'user_unblocked', username: key })
        break
      }

      case 'server:shutdown':
        // Server is restarting and asking clients to spread reconnects across a
        // window so 10k+ extensions don't dogpile the freshly-restarted box.
        // Honors `reconnectSpreadMs` from the server's payload.
        if (typeof msg.reconnectSpreadMs === 'number' && msg.reconnectSpreadMs > 0) {
          pendingReconnectSpreadMs = Math.min(60000, msg.reconnectSpreadMs)
          log(` 🌊 Server shutdown — will spread reconnect over ${pendingReconnectSpreadMs}ms`)
        }
        break

      case 'authentication_failed':
        isAuthenticated = false
        // A retired token is not a logout — see tokenAfterRejection. With a
        // live cookie the socket reconnects under it; only when the browser
        // holds no other token is this the end of the session.
        tokenAfterRejection(socketAuthToken)
          .then((live) => {
            if (live) {
              authFailedBlock = false
              return connectWebSocket()
            }
            authToken = null
            authFailedBlock = true
            _serverMutesFetched = false // reset so re-login triggers a fresh sync
            // Drop the stored token so the next reconnect (after a fresh login)
            // doesn't keep replaying the dead one and looping us back to here.
            browser.storage.local.remove(['auth_token_encrypted', 'auth_token']).catch(() => {})
            if (socket) socket.close()
            // Tell content scripts so the multichat panel can prompt the user to
            // log in — without this signal YT chat (which depends on the server
            // scraping for us) silently produces zero messages.
            broadcastToTabs({ type: 'auth_changed', loggedIn: false, reason: 'authentication_failed' })
          })
          .catch((err) => log(' authentication_failed handling failed:', err?.message))
        break

      case 'emote:broadcast':
        if (msg.emoteData?.url) {
          msg.emoteData.url = absUrl(msg.emoteData.url)
          if (!/^https:\/\//.test(msg.emoteData.url)) break
        }
        if (msg.emoteName) msg.emoteName = String(msg.emoteName).slice(0, 100)
        log(' 📢 EMOTE BROADCAST RECEIVED:', {
          username: msg.username,
          emoteName: msg.emoteName,
          emoteUrl: msg.emoteData?.url,
        })
        broadcastToTabs({
          type: 'emote_broadcast',
          username: msg.username,
          emoteName: msg.emoteName,
          emoteData: msg.emoteData,
        })
        break

      case 'emote:removed':
        // Could be broadcast (other users) OR personal inventory removal
        if (msg.slot !== undefined) {
          // Personal inventory removal (has slot number)
          log(' 🗑️ EMOTE REMOVED FROM YOUR INVENTORY:', msg.name, 'slot:', msg.slot)
          scheduleInventoryRefresh()
        } else if (msg.username) {
          // Broadcast from other user. New servers send senderKeys (the exact
          // batch keys this sender resolves as) + ver (emote-ver cache-bust) —
          // invalidate precisely. Legacy shape (no senderKeys): scrub by name
          // across every cached set.
          log(' 🗑️ EMOTE REMOVED BROADCAST:', msg)
          const rmKeys = sanitizeSenderKeys(msg.senderKeys)
          if (globalThis.__senderEmoteCache) {
            if (rmKeys) {
              for (const k of rmKeys) globalThis.__senderEmoteCache.delete(k)
            } else if (msg.emoteName) {
              for (const [_k, hit] of globalThis.__senderEmoteCache) {
                if (hit?.emotes && msg.emoteName in hit.emotes) {
                  delete hit.emotes[msg.emoteName]
                }
              }
            }
          }
          broadcastToTabs({
            type: 'emote_removed_broadcast',
            username: msg.username,
            emoteName: msg.emoteName,
            ...(rmKeys ? { senderKeys: rmKeys, ver: sanitizeVer(msg.ver) } : {}),
          })
        }
        break

      case 'emote:added':
        // Two shapes:
        //  - Personal add (msg.slot present): server saved YOUR own add, refresh
        //    inventory. (User-side broadcast on own add via website upload.)
        //  - Broadcast (msg.username present): a DIFFERENT user's set changed
        //    (single add carries emoteName/emoteData; bulk set change carries
        //    neither). New servers send senderKeys + ver for precise
        //    invalidation; legacy shape nukes the whole cache.
        if (msg.slot !== undefined) {
          log(' ✅ EMOTE ADDED TO INVENTORY:', msg.name, 'slot:', msg.slot)
          scheduleInventoryRefresh()
        } else if (msg.username) {
          log(' ➕ EMOTE ADDED BROADCAST:', msg)
          const addKeys = sanitizeSenderKeys(msg.senderKeys)
          if (globalThis.__senderEmoteCache) {
            if (addKeys) for (const k of addKeys) globalThis.__senderEmoteCache.delete(k)
            else globalThis.__senderEmoteCache.clear()
          }
          broadcastToTabs({
            type: 'emote_added_broadcast',
            username: msg.username,
            emoteName: msg.emoteName,
            ...(addKeys ? { senderKeys: addKeys, ver: sanitizeVer(msg.ver) } : {}),
          })
        }
        break

      case 'emotes:refresh':
        // Bulk inventory change from the site (apply saved set, channel-import,
        // shared-set import, undo/redo). Without this case the event fell through
        // and the inventory stayed stale until the 60s poll — the applied/imported
        // emotes silently didn't render.
        log(' 🔄 EMOTES REFRESH (bulk inventory change)')
        scheduleInventoryRefresh()
        break

      case 'cosmetic:changed': {
        // A user changed (or cleared) a HeatSync paint. The server sends only
        // the affected paint-space ids — never the spec, since GET /api/paints
        // withholds specs from unentitled users and re-fetching keeps that gate
        // intact. Drop our cached copies so the next lookup is authoritative,
        // then let content scripts repaint the rows already on screen.
        const changedIds = Array.isArray(msg.ids) ? msg.ids.filter((i) => typeof i === 'string') : []
        if (!changedIds.length) break
        // The same push now also covers flair, badges, display name and avatar:
        // the overlay re-asks for those too (name marks + open profile card).
        // Bounded: the frame is hostile and the list is only ever ids.
        const bounded = changedIds.slice(0, 200).map((i) => i.slice(0, 80))
        for (const id of bounded) _paintsCache.delete(id)
        broadcastToTabs({ type: 'cosmetic_changed', ids: bounded })
        break
      }

      case 'profile:color':
        // A user changed their heatsync name color — forward to content
        // scripts so the overlay recolors that user's visible rows live.
        broadcastToTabs({ type: 'profile_color', userId: msg.userId, usernames: msg.usernames, color: msg.color })
        break

      case 'emote:blocked':
        // Skip if user just unblocked locally — late WS echo would otherwise re-add.
        if (recentBlockToggleState(msg.hash) === 'unblocked') break
        if (msg.hash && !blockedEmotes.has(msg.hash)) {
          blockedEmotes.add(msg.hash)
          browser.storage.local.set({ blocked_emotes: Array.from(blockedEmotes) }).catch(() => {})
          // 2-state model: block preserves inventory. No emoteInventory filter,
          // no inventory_update broadcast — only the blocked_update + emote_blocked
          // events that tell tabs to start painting the dashed-rect overlay.
          broadcastToTabs({ type: 'blocked_update', blocked: [...blockedEmotes, ...localBlockedEmotes] })
          broadcastToTabs({ type: 'emote_blocked', hash: msg.hash })
        }
        break

      case 'emote:unblocked':
        // Skip if user just blocked locally — late WS echo would otherwise re-remove.
        if (recentBlockToggleState(msg.hash) === 'blocked') break
        if (msg.hash && blockedEmotes.has(msg.hash)) {
          blockedEmotes.delete(msg.hash)
          browser.storage.local.set({ blocked_emotes: Array.from(blockedEmotes) }).catch(() => {})
          // Refresh inventory in case the unblocked emote should be restored
          scheduleInventoryRefresh()
          broadcastToTabs({ type: 'blocked_update', blocked: [...blockedEmotes, ...localBlockedEmotes] })
          broadcastToTabs({ type: 'emote_unblocked', hash: msg.hash })
        }
        break

      case 'ui-state:update': {
        // Cross-surface UI prefs sync — server merged a patch from another
        // client and is fanning out the full state. Mirror into chrome.storage
        // .sync.ui_settings so the existing storage.onChanged listener applies
        // every key live (zebra/timestamps/avatars/active tab/etc). Large
        // blocklist prefs (chatFilterRules) split off into
        // their chrome.storage.local overflow keys instead — the SAME onChanged
        // listener already reacts to those (chat_filter_rules)
        // for the local-mirror write path, so no new plumbing is needed.
        // Sanitize the patch first — never trust server-fanned-out state. A
        // single malformed payload here will otherwise corrupt every client of
        // this user permanently (sync replicates everywhere; once bad data is
        // in, every tab and the heatsync.org chat-tile inherit it).
        if (msg.state && typeof msg.state === 'object') {
          const { sync: cleanState, overflow } = splitIncomingUiState(msg.state)
          const cleanKeys = Object.keys(cleanState)
          const overflowKeys = Object.keys(overflow)
          if (cleanKeys.length === 0 && overflowKeys.length === 0) break
          if (cleanKeys.length) {
            log(' 🎛️  ui-state sync received:', cleanKeys.length, 'keys')
            uiSettingsRmw((ui) => sanitizeUiSettings({ ...ui, ...cleanState }))
          }
          if (overflowKeys.length) {
            log(' 🎛️  ui-state sync received (overflow):', overflowKeys.length, 'keys')
            browser.storage.local.set(overflow).catch(() => {})
          }
          // No broadcast. uiSettingsRmw above writes chrome.storage.sync
          // .ui_settings, and the overlay's storage.onChanged listener in
          // main.js is what actually re-applies a setting live. This message
          // has never had a listener in any content script.
        }
        break
      }

      case 'multichat:config':
        // Cross-device sync: server sent updated multichat config
        if (Array.isArray(msg.channels) && !isStaleConfigRev(mcConfigRevSeen, currentUsername, msg.rev)) {
          // Reject malformed entries — CRLF injection in IRC (see isValidSyncedChannel).
          const validChannels = msg.channels.filter(isValidSyncedChannel)
          log(' 📋 Multichat config sync received:', validChannels.length, 'channels')
          browser.storage.local
            .get(['heatsync_multichat'])
            .then((data) => {
              const current = data.heatsync_multichat || { channels: [], enabled: true }
              const currentJson = JSON.stringify(current.channels)
              const newJson = JSON.stringify(validChannels)
              if (currentJson !== newJson) {
                browser.storage.local.set({ heatsync_multichat: { ...current, channels: validChannels } })
              }
            })
            .catch(() => {})
        }
        break

      case 'new-message': {
        log(' New message received:', msg)
        // Only show posts from followed users, exclude anonymous
        const msgUser = (msg.username || '').toLowerCase()
        if (msg.username === 'Anonymous') {
          log(' Skipping feed post — anonymous')
          break
        }
        if (currentUsername && msgUser === currentUsername.toLowerCase()) {
          // Always show own posts
        } else if (!followedUsers.some((u) => u.toLowerCase() === msgUser)) {
          log(' Skipping feed post — not followed')
          break
        }
        broadcastToTabs({
          type: 'new-message',
          data: msg,
        })
        break
      }

      case 'message-updated':
        broadcastToTabs({ type: 'message-updated', data: msg })
        break

      case 'message-edited':
        broadcastToTabs({ type: 'message-edited', data: msg })
        break

      case 'message-deleted':
        broadcastToTabs({ type: 'message-deleted', data: msg })
        break

      // a moderator pulled a post: the same ending as its author deleting it
      // (the server sends it flat — {id, reason} — not wrapped in `data`)
      case 'message:hidden': {
        const id = msg.id ?? msg.data?.id
        if (id) broadcastToTabs({ type: 'message-deleted', data: { message_id: id } })
        break
      }

      // someone's archived chat lines were removed: the open chat-logs view drops them
      case 'user-log:removed':
        if (msg.data?.username) broadcastToTabs({ type: 'user-log:removed', data: msg.data })
        break

      // a profile (bio, avatar, links…) was edited: open cards re-read it. The
      // server sends this to the author's feed room; it reaches the ext only when
      // the user's own socket is in it, so this is a best-effort live refresh.
      case 'profile:updated':
        if (msg.userId != null) broadcastToTabs({ type: 'profile_updated', userId: String(msg.userId).slice(0, 40) })
        break

      // a moderator warned THIS account (the frame never says who)
      case 'user-warned': {
        const reason = String(msg.reason ?? '')
          .replace(/[\u0000-\u001f\u007f]/g, ' ')
          .trim()
          .slice(0, 300)
        if (reason) broadcastToTabs({ type: 'mod_warned', reason })
        break
      }

      // live heat on a post (flat frame: messageId, newHeat, newMaxHeat)
      case 'heat:updated':
        if (msg.messageId) broadcastToTabs({ type: 'heat-updated', data: msg })
        break

      // the media scan settled on a post: the feed copies stop saying "scanning"
      // and a flagged one is held behind the viewer's own toggles
      case 'message:approved':
      case 'message:flagged': {
        const data = moderationFrame(msg)
        if (data) broadcastToTabs({ type: 'message_moderated', data })
        break
      }

      // a threaded heatsync DM arrived / its thread moved / someone is typing —
      // the whispers tab used to learn all three only by polling /api/dm
      case 'dm:message': {
        const data = shapeDmThreadMessage(msg)
        if (data) broadcastToTabs({ type: 'dm_thread_message', data })
        break
      }
      case 'dm:thread-update':
        if (msg.threadId)
          broadcastToTabs({ type: 'dm_thread_update', data: { threadId: String(msg.threadId).slice(0, 40) } })
        break
      case 'dm:typing':
        if (msg.threadId && msg.userId != null) {
          broadcastToTabs({
            type: 'dm_typing',
            data: { threadId: String(msg.threadId).slice(0, 40), userId: String(msg.userId).slice(0, 40) },
          })
        }
        break

      // a heatsync DM was deleted on another client
      case 'dm:message-deleted':
        if (msg.messageId) broadcastToTabs({ type: 'dm_message_deleted', data: msg })
        break

      // Live engagement on the thread a tab has open (see feedThreadSet).
      case 'reaction:added':
      case 'reaction:removed':
      case 'vote:updated':
        broadcastToTabs({ type: msg.type, data: msg })
        break

      // A new archive line for the person whose logs a tab has open (ulog room).
      case 'user-log':
        if (msg.data) broadcastToTabs({ type: 'user-log', data: msg.data })
        break

      case 'notification:new':
        log(' Notification received:', msg)
        unreadNotifCount++
        browser.storage.session?.set({ unread_notif_count: unreadNotifCount }).catch(() => {})
        updateExtensionBadge()
        // The overlay turns it into a row in its mentions tab (hsNotifIn),
        // so a reply to your post is readable, not just a number on the toolbar.
        // Only the fields the row reads leave here, bounded; the frame is hostile.
        broadcastToTabs({ type: 'hs_notif', data: shapeHsNotif(msg) })
        break

      case 'youtube:chat':
        handleYoutubeChatBatch(msg)
        break

      // A mod deleted messages, or banned an author and youtube retroactively
      // removed everything they said. The server sends this to every socket
      // subscribed to the video; before this the extension had no case for it,
      // so removed messages stayed on screen in the overlay indefinitely.
      case 'youtube:delete':
        broadcastToTabs({ type: 'youtube_delete', data: msg })
        break

      case 'youtube:status': {
        // Resolve channelId BEFORE potentially deleting the videoId mapping —
        // otherwise an `ended` event broadcasts with channelId='global' and the
        // multichat panel can't update the right channel tab.
        // Fallback: server may not echo channelId for @user/live subscribes,
        // so attribute via pending-subscribe LIFO when status carries a fresh
        // videoId we haven't seen yet.
        const bound = new Set(ytChannelsFor(msg.videoId))
        if (msg.channelId) bound.add(msg.channelId)
        // Same ambiguity as youtube:chat — only fall back when exactly one pending.
        if (!bound.size && msg.status === 'connected' && msg.videoId && pendingYtSubscribes.length === 1) {
          const pend = pendingYtSubscribes.shift()
          bound.add(pend.channelId)
        }
        // A stale fallback binding (persisted by an older build) alongside a
        // real one would fan every broadcast out twice.
        if (bound.size > 1) bound.delete(YT_FALLBACK_CHANNEL)
        const channelIds = bound.size ? [...bound] : [YT_FALLBACK_CHANNEL]
        if (msg.status === 'connected') {
          activeYoutubeVideoId = msg.videoId
          if (msg.videoId) for (const cid of channelIds) setYtVideoChannel(msg.videoId, cid)
          if (msg.videoId) ytTapMarkWanted(msg.videoId)
        } else if (msg.status === 'ended') {
          if (activeYoutubeVideoId === msg.videoId) activeYoutubeVideoId = null
          deleteYtVideoChannel(msg.videoId)
          if (msg.videoId) ytTapUnmarkWanted(msg.videoId)
        } else if (msg.status === 'error') {
          // Transient errors (rate limit, single failed fetch) shouldn't kill routing —
          // the poller usually recovers and resumes broadcasting. Keeping the mapping
          // means resumed chat lands on the right tab instead of falling to 'global'.
          if (activeYoutubeVideoId === msg.videoId) activeYoutubeVideoId = null
        }
        for (const channelId of channelIds) {
          broadcastToTabs({
            type: 'youtube_status',
            videoId: msg.videoId,
            channelId,
            status: msg.status,
            channelName: msg.channelName || '',
            title: msg.title || '',
            error: msg.error || '',
          })
        }
        break
      }

      case 'dm:new':
        broadcastToTabs({
          type: 'dm_new',
          data: msg,
        })
        break

      // A twitch whisper the server received for you. The ext also hears it from
      // eventsub; the overlay dedups on the external id, so this only fills the
      // gap when that path is down (or the overlay is on a kick/yt tab).
      case 'whisper:new': {
        const data = shapeWhisperFrame(msg)
        if (data) broadcastToTabs({ type: 'dm_new', data })
        break
      }

      case 'seen:update':
        // Cross-surface unread sync: another client (web, other ext) bumped a
        // tab's seen-at. Forward to all multichat tabs so they clear the dot.
        // Mentions/inbox seen = the heatsync notifications were read: the
        // toolbar badge clears with them, not at the next reconnect.
        if (msg.surface === 'mentions' || msg.surface === 'inbox') setUnreadNotifCount(0)
        broadcastToTabs({
          type: 'seen_update',
          surface: msg.surface,
          at: msg.at,
        })
        break

      case 'tabseen:update':
        // A channel tab was read on another client — clear its red state here.
        broadcastToTabs({ type: 'tabseen_update', tab: msg.tab, at: msg.at })
        break

      // follows changed on another client / the site: re-read the list now
      case 'follows:changed':
        fetchFollowedUsers().catch(() => {})
        // open profile cards hold a relationship that just went stale
        broadcastToTabs({ type: 'follows_changed' })
        break

      // notifications read elsewhere: the server says how many are still unread
      case 'notifications:read': {
        const n = unreadFromFrame(msg)
        if (n >= 0) setUnreadNotifCount(n)
        break
      }

      // a post was bookmarked / unbookmarked on another client
      case 'bookmarks:changed': {
        const b = bookmarkFrame(msg)
        if (b) broadcastToTabs({ type: 'bookmark_changed', id: b.id, on: b.on })
        break
      }

      // mention rules edited elsewhere: the settings editor reloads its list
      case 'mention-rules:changed':
        broadcastToTabs({ type: 'mention_rules_changed' })
        break

      case 'kick-chat-message':
        // Tee into BG buffer first so reload-history is instant
        try {
          bgKickIngest(msg.data)
        } catch {}
        _kickSrcBump(_kickSrcStats.relay, (msg.data?.channel || '').toLowerCase(), msg.data?.id)
        // Relay Kick chat messages (via server webhook) to content scripts
        broadcastToTabs({
          type: 'kick_chat_message',
          data: msg.data,
        })
        break

      case 'moment:spike':
        // server-side heat spike — forward to tabs for the moments band + 🔥 notif.
        // Carry id (dedup key for live-insert) + title/game (card context); dropping
        // them silently broke dedup-by-id and the card title.
        broadcastToTabs({
          type: 'hs_moment',
          data: {
            id: msg.id,
            platform: msg.platform,
            channel: msg.channel,
            rate: msg.rate,
            baseline: msg.baseline,
            title: msg.title,
            game: msg.game,
          },
        })
        break

      case 'irc:message': {
        // Live twitch from the heatsync server (EventSub-fed consumer fanout).
        // Heals channels whose direct IRC delivery twitch is starving —
        // including background channels no native tap can cover.
        try {
          const ch = (msg.channel || '').toLowerCase()
          const ext = msg.message ? bgIrcRecordToExt(msg.message, ch) : null
          if (ch && ext && !bgIrcDupModNotice(BG_IRC.channels.get(ch), ext)) {
            if (!(ext.id && bgIrcSeenLiveId(`${ch}:${ext.id}`))) {
              const buf = BG_IRC.channels.get(ch)
              if (buf) {
                buf.push(ext)
                bgIrcPersistChannel(ch)
              }
              bgIrcBroadcast({ type: 'bg_irc_msg', msg: ext })
            } else if (ext.hsEmotes && ext.id) {
              // Deduped: the native IRC tap already delivered this id (won the
              // race), but this server copy carries server-enriched emote refs
              // the native copy lacked. Patch the buffered row (history) and tell
              // the panel to merge them + re-render just that row. Additive and
              // safe — no-ops entirely on channels the server never fans out.
              try {
                const buf = BG_IRC.channels.get(ch)
                if (buf?.getAll) {
                  for (const m of buf.getAll()) {
                    if (m && m.id === ext.id) {
                      // ⛔ THIS WAS `if (!m.hsEmotes) m.hsEmotes = ext.hsEmotes`.
                      // hsEmotes is a MAP of name→ref, and a whole-object fill
                      // is only ever correct for a SCALAR: one name already on
                      // the row discarded every name on the server copy. The
                      // server's set is built per-message from the sender's
                      // inventory and the native tap's is not, so a two-emote
                      // message that had picked up one ref anywhere else kept
                      // that one and sent the other out as text.
                      //
                      // Same bug the site repo fixed at five leg-merge sites
                      // (79e944503) and again a tier deeper on 2026-09-22.
                      // Additive by name, never overwrite.
                      if (!m.hsEmotes) m.hsEmotes = {}
                      for (const n in ext.hsEmotes) {
                        if (ext.hsEmotes[n] && !m.hsEmotes[n]) m.hsEmotes[n] = ext.hsEmotes[n]
                      }
                      break
                    }
                  }
                }
              } catch {}
              bgIrcBroadcast({ type: 'bg_irc_enrich', channel: ch, id: ext.id, hsEmotes: ext.hsEmotes })
            }
          }
        } catch (e) {
          log('irc:message err:', e?.message)
        }
        break
      }

      case 'irc:backlog':
        // Heatsync server-side Twitch IRC ring buffer (500 msgs / 24h Redis).
        // Way deeper than robotty's instant fetch; merge it in.
        try {
          bgIrcMergeServerBacklog(msg.channel, msg.messages)
        } catch (e) {
          log('irc:backlog merge err:', e?.message)
        }
        break

      case 'kick-chat-backfill':
        // Server-side Kick ring buffer (200 msgs) replayed on channel:join.
        // Ingest into BG buffer for instant history on future tab joins, then
        // broadcast a merge notice so already-open tabs refresh.
        try {
          const ch = (msg.channel || '').toLowerCase()
          const list = Array.isArray(msg.messages) ? msg.messages : []
          if (ch && list.length > 0) {
            if (!BG_KICK.channels.has(ch)) {
              BG_KICK.channels.set(ch, new BGCircularBuffer(BG_KICK_PERSIST_MAX))
              if (BG_KICK.channels.size > MAX_BG_KICK_CHANNELS) {
                const oldest = BG_KICK.channels.keys().next().value
                BG_KICK.channels.delete(oldest)
                browser.storage.local.remove(`hs_kick_${oldest}`).catch(() => {})
              }
              bgKickFetchArchive(ch).catch(() => {})
            }
            const buf = BG_KICK.channels.get(ch)
            const existing = buf.getAll()
            // Build Sets once for O(1) per-message dedup — avoids O(n²) scan.
            const existingIds = new Set(existing.filter((m) => m.id).map((m) => m.id))
            const fpOf = (m) => `${m.user}|${m.time}|${(m.text || '').slice(0, 60)}`
            const existingFp = new Set(existing.filter((m) => !m.id).map(fpOf))
            const toAdd = []
            for (const data of list) {
              try {
                const badgeStr = Array.isArray(data.badges)
                  ? data.badges.map((b) => `${b.type || b.name || 'badge'}/${b.version || b.count || '1'}`).join(',')
                  : ''
                const m = {
                  user: data.username || data.displayName || data.user || 'unknown',
                  text: data.content || data.message || data.text || '',
                  color: data.color || '#53fc18',
                  userId: data.senderId != null ? String(data.senderId) : '',
                  badges: badgeStr,
                  channel: ch,
                  time: data.timestamp || data.time || Date.now(),
                  platform: 'kick',
                  id: data.id || '',
                  isHistory: true,
                  replyTo: data.replyTo
                    ? {
                        user: data.replyTo.username || 'unknown',
                        text: data.replyTo.content || '',
                        id: data.replyTo.id || data.replyTo.message_id || '',
                        threadId: data.replyTo.thread_id || data.replyTo.id || data.replyTo.message_id || '',
                      }
                    : null,
                }
                if (m.id) {
                  if (existingIds.has(m.id)) continue
                  existingIds.add(m.id)
                } else {
                  const fp = fpOf(m)
                  if (existingFp.has(fp)) continue
                  existingFp.add(fp)
                }
                toAdd.push(m)
              } catch {}
            }
            if (toAdd.length > 0) {
              const all = [...existing, ...toAdd].sort((a, b) => (a.time || 0) - (b.time || 0))
              buf.clear()
              for (const m of all) buf.push(m)
              bgKickPersistChannel(ch)
              broadcastToTabs({ type: 'bg_kick_history_merged', channel: ch, count: toAdd.length })
              log('BG KICK backfill merged', toAdd.length, 'msgs for', ch)
            }
          }
        } catch {}
        break

      case 'chat:origin':
        // A line in a room we joined was sent through heatsync (any sender).
        // Keyed by message id; the tabs flip the row if it is on screen or
        // stamp it when it arrives (the platform row often lands AFTER this).
        if (msg.messageId && msg.origin === 'heatsync') {
          broadcastToTabs({
            type: 'chat_origin',
            platform: msg.platform,
            channel: msg.channel,
            id: msg.messageId,
            sendId: msg.sendId,
          })
        }
        break

      case 'chat:origin_broadcast':
        // User sent a chat message from the heatsync.org chat-tile on a
        // different device — fan out to all tabs so multichat can tag the
        // upcoming platform-relay echo with [H] instead of [T]/[K].
        wsDebugNote('origin_bcast', (msg.text || '').slice(0, 24))
        broadcastToTabs({
          type: 'chat_origin_broadcast',
          text: msg.text,
          channel: msg.channel,
          origin: msg.origin || 'heatsync',
          // sendId: server stamps it since 25646584 (site-side fold); carried
          // through so the multichat fold can key on it instead of bare text.
          sendId: msg.sendId || '',
          ts: msg.ts || Date.now(),
        })
        break

      case 'yt:relay_send':
        // Server is asking us to DOM-inject text into youtube.com's live chat.
        // Find a tab on this videoId, hand off to youtube-content's existing
        // youtube_send_relay path, ack back over the WS so the originating
        // website socket knows whether it landed. Guarded: see RELAYED SENDS.
        ;(async () => {
          const reqId = msg.reqId
          const videoId = msg.videoId
          const text = msg.text
          const result = await runGuardedRelay({ platform: 'youtube', target: videoId, text, reqId }, async () => {
            const r = await sendYoutubeChat({ videoId, text })
            return { ok: !!r.ok, error: r.error, ytUsername: r.ytUsername }
          })
          wsSendDirect({
            type: 'yt:relay_ack',
            reqId,
            ok: !!result.ok,
            ytUsername: result.ytUsername,
            error: result.error,
          })
        })()
        break

      case 'kick:relay_send':
        // Server is asking us to send a chat message through a kick.com tab.
        // Unlike the YouTube relay above, Kick send is channel-parameterized
        // (channelId + session XSRF cookie) — the tab does NOT need to be on
        // that channel's page, so ANY kick.com tab works as the messaging
        // origin. Reuses the same resolve/send helpers as the local
        // kick_resolve_channel / kick_send_message runtime-message flow.
        // Guarded: see RELAYED SENDS.
        ;(async () => {
          const reqId = msg.reqId
          const channel = msg.channel
          const text = msg.text
          const result = await runGuardedRelay({ platform: 'kick', target: channel, text, reqId }, async () => {
            const resolved = await resolveKickChannelIdBg(channel.toLowerCase())
            if (!resolved.channelId) return { ok: false, error: 'no_channel' }
            const r = await sendKickMessageViaTab(resolved.channelId, text)
            return { ok: !!r?.ok, error: r?.error }
          })
          wsSendDirect({ type: 'kick:relay_ack', reqId, ok: !!result.ok, error: result.error })
        })()
        break

      case 'kick-sub-event':
        // Relay Kick subscription events to content scripts
        broadcastToTabs({
          type: 'kick_sub_event',
          channel: msg.channel,
          eventType: msg.eventType,
          username: msg.username,
          months: msg.months,
          gifter: msg.gifter,
          giftees: msg.giftees,
          message: msg.message,
        })
        break

      case 'kick-kicks-event':
        // Relay KICKs gifted events to content scripts
        broadcastToTabs({
          type: 'kick_kicks_event',
          channel: msg.channel,
          username: msg.username,
          amount: msg.amount,
          giftName: msg.giftName,
          message: msg.message,
        })
        break

      case 'stream:update':
      case 'stream:online':
      case 'stream:offline': {
        // Dedup: same channel+event within 60s (prevents dupes from stream:* and follow:stream:*)
        const streamKey = `${msg.channel}:${msg.type}:${msg.game || ''}`
        const streamNow = Date.now()
        if (wsStreamEventDedup.has(streamKey) && streamNow - wsStreamEventDedup.get(streamKey) < 60000) break
        wsStreamEventDedup.set(streamKey, streamNow)
        if (wsStreamEventDedup.size > 100) {
          for (const [k, t] of wsStreamEventDedup) {
            if (streamNow - t > 60000) wsStreamEventDedup.delete(k)
          }
        }
        broadcastToTabs({
          type: 'stream_event',
          eventType: msg.type,
          platform: msg.platform,
          channel: msg.channel,
          game: msg.game || '',
          title: msg.title || '',
          prevGame: msg.prevGame || '',
          prevTitle: msg.prevTitle || '',
          isLive: msg.isLive,
          ...streamFrameWho(msg),
        })
        break
      }

      case 'stream:redeem':
        broadcastToTabs({
          type: 'stream_event',
          eventType: 'stream:redeem',
          platform: msg.platform,
          channel: msg.channel,
          user: msg.user || '',
          title: msg.title || '',
          cost: msg.cost || 0,
        })
        break

      case 'stream:raid':
        broadcastToTabs({
          type: 'stream_event',
          eventType: 'stream:raid',
          platform: msg.platform,
          channel: msg.channel,
          target: msg.target || '',
          viewers: msg.viewers || 0,
        })
        break

      case 'stream:hype-start':
      case 'stream:hype-end':
        broadcastToTabs({
          type: 'stream_event',
          eventType: msg.type,
          platform: msg.platform,
          channel: msg.channel,
          level: msg.level || 0,
        })
        break

      // a single new twitch sub (gifted ones arrive as stream:sub-gift)
      case 'stream:sub':
        broadcastToTabs({
          type: 'stream_event',
          eventType: 'stream:sub',
          platform: msg.platform,
          channel: msg.channel,
          user: msg.user || '',
        })
        break

      case 'stream:sub-gift':
        broadcastToTabs({
          type: 'stream_event',
          eventType: 'stream:sub-gift',
          platform: msg.platform,
          channel: msg.channel,
          user: msg.user || '',
          count: msg.count || 0,
        })
        break

      case 'follow:stream:update':
      case 'follow:stream:online':
      case 'follow:stream:offline':
        handleFollowStreamEvent(msg)
        break

      case 'follow:colors':
        cachedFollowColors = msg.colors || {}
        broadcastToTabs({
          type: 'follow_colors',
          colors: cachedFollowColors,
        })
        break

      case 'follow:history':
        cachedFollowHistory = msg.events || []
        broadcastToTabs({
          type: 'follow_history',
          events: cachedFollowHistory,
        })
        break

      case 'follow:live:snapshot':
        handleFollowLiveSnapshot(msg)
        break

      case 'user:heat_batch_update': {
        // Server pushes heat updates every 60s for users whose heat changed.
        // Forward to tabs so content.js can update its username-keyed heat cache
        // without polling /api/users/heat. Drops the polled endpoint volume to
        // near-zero in steady state.
        const updates = Array.isArray(msg.updates) ? msg.updates : []
        if (updates.length > 0) {
          broadcastToTabs({ type: 'heat_batch_update', updates })
        }
        break
      }

      // Server-synced mute list — fired when the user mutes/unmutes on heatsync.org
      // (REST /api/mutes) which broadcasts these WS events to all of the user's sockets.
      case 'mute:added': {
        const u = msg.username?.toLowerCase()
        if (u) {
          const rawExp = msg.expires_at
          const expiresAt = rawExp ? new Date(rawExp).getTime() : null
          if (!mutedUsers.has(u)) {
            mutedUsers.set(u, expiresAt)
            persistMutedUsers()
            broadcastToTabs({ type: 'user_muted', username: u, expiresAt })
            log(' mute:added from server:', u)
          }
        }
        break
      }

      case 'mute:removed':
      case 'mute:expired': {
        const u = msg.username?.toLowerCase()
        if (u && mutedUsers.has(u)) {
          mutedUsers.delete(u)
          persistMutedUsers()
          broadcastToTabs({ type: 'user_unmuted', username: u })
          log(' mute:removed/expired from server:', u)
        }
        break
      }

      case 'mute:cleared': {
        if (mutedUsers.size > 0) {
          mutedUsers.clear()
          persistMutedUsers()
          broadcastToTabs({ type: 'mutes_cleared' })
          log(' mute:cleared from server')
        }
        break
      }

      // v1.6 cross-device sync for column-stored prefs (PATCH /api/user/settings).
      // Server broadcasts this to every WS-connected device for the user, so a
      // toggle flipped in tab A mirrors instantly in tab B / desktop 2 / phone,
      // without polling. The chrome.storage.local write triggers the existing
      // onChanged listener which updates BG globals + every content-script tab's
      // local mirrors. The gate (!== current) makes this a no-op for the
      // originating tab (click handler already updated before WS round-trip).
      case 'user_settings:update': {
        let settingsChanged = false
        if (typeof msg.show_sexual_emotes === 'boolean' && msg.show_sexual_emotes !== viewerShowSexual) {
          log(' user_settings:update received: show_sexual_emotes →', msg.show_sexual_emotes)
          viewerShowSexual = msg.show_sexual_emotes
          browser.storage.local.set({ viewer_show_sexual: viewerShowSexual }).catch(() => {})
          settingsChanged = true
        }
        if (typeof msg.show_gore_emotes === 'boolean' && msg.show_gore_emotes !== viewerShowGore) {
          log(' user_settings:update received: show_gore_emotes →', msg.show_gore_emotes)
          viewerShowGore = msg.show_gore_emotes
          browser.storage.local.set({ viewer_show_gore: viewerShowGore }).catch(() => {})
          settingsChanged = true
        }
        if (typeof msg.show_weapon_emotes === 'boolean' && msg.show_weapon_emotes !== viewerShowWeapon) {
          log(' user_settings:update received: show_weapon_emotes →', msg.show_weapon_emotes)
          viewerShowWeapon = msg.show_weapon_emotes
          browser.storage.local.set({ viewer_show_weapon: viewerShowWeapon }).catch(() => {})
          settingsChanged = true
        }
        if (typeof msg.show_drug_emotes === 'boolean' && msg.show_drug_emotes !== viewerShowDrug) {
          log(' user_settings:update received: show_drug_emotes →', msg.show_drug_emotes)
          viewerShowDrug = msg.show_drug_emotes
          browser.storage.local.set({ viewer_show_drug: viewerShowDrug }).catch(() => {})
          settingsChanged = true
        }
        if (typeof msg.show_hate_emotes === 'boolean' && msg.show_hate_emotes !== viewerShowHate) {
          log(' user_settings:update received: show_hate_emotes →', msg.show_hate_emotes)
          viewerShowHate = msg.show_hate_emotes
          browser.storage.local.set({ viewer_show_hate: viewerShowHate }).catch(() => {})
          settingsChanged = true
        }
        // Plus started, lapsed or was extended (billing sync): re-read the
        // account so identity-derived state follows, and have the overlay drop
        // the paints / plus tenure it holds for you so plus-only cosmetics
        // appear or go away at once.
        if (typeof msg.plus === 'boolean' || 'plus_expires_at' in msg) refreshPlusState()
        if (settingsChanged) {
          // Invalidate cross-user batch caches + refetch own inventory so the
          // chat repaints with the new filter immediately, not at the next
          // channel switch. Mirrors what the originating tab's click handler
          // does after PATCH success.
          Promise.all([fetchEmoteInventory(), fetchBlockedEmotes()]).catch(() => {})
          // Drop sender-emote LRU so next message render re-fetches with the
          // new filter params. Same cache the inventory-block path uses
          // (globalThis.__senderEmoteCache), guarded for lazy init order.
          try {
            if (globalThis.__senderEmoteCache?.clear) globalThis.__senderEmoteCache.clear()
          } catch {}
        }
        break
      }

      // Server-evaluated mention rule match — show inline notif in multichat overlay.
      case 'mention:rule-match': {
        const d = msg.data
        if (d && typeof d === 'object') {
          broadcastToTabs({
            type: 'mention_rule_match',
            ruleId: d.ruleId,
            pattern: String(d.pattern || '').slice(0, 200),
            channel: String(d.channel || '').slice(0, 50),
            platform: String(d.platform || '').slice(0, 20),
            username: String(d.username || '').slice(0, 50),
            snippet: String(d.snippet || '').slice(0, 200),
          })
          log(' mention:rule-match:', d.pattern, 'in', d.channel)
        }
        break
      }

      // EventSub fan-out — server pushes channel events subscribed via eventsub:subscribe.
      // Translate into the same stream_event shape the existing renderers expect.

      // AutoMod hold-queue — server pushes a held message for a channel this
      // user moderates (EventSub AutoMod + Helix, server-side). Trim/coerce
      // every field — never trust the wire — same discipline as eventsub:event.
      case 'automod:hold': {
        broadcastToTabs(normalizeAutomodHold(msg))
        break
      }

      // Resolution update for a held message — approved/denied/expired, by
      // this mod or any other. Ext matches it to a rendered row by msgId.
      case 'automod:update': {
        broadcastToTabs({
          type: 'automod_update',
          broadcasterId: String(msg.broadcasterId || ''),
          broadcasterLogin: String(msg.broadcasterLogin || '').toLowerCase(),
          msgId: String(msg.msgId || ''),
          status: msg.status === 'approved' || msg.status === 'denied' ? msg.status : 'expired',
          modLogin: String(msg.modLogin || ''),
        })
        break
      }

      // A mod pinned / unpinned a message in a room this socket joined. Only the
      // room and the pin ride on; the pane matches it to the tab on screen.
      case 'pin:set':
      case 'pin:clear':
        broadcastToTabs({
          type: msg.type === 'pin:set' ? 'pin_set' : 'pin_clear',
          platform: String(msg.platform || ''),
          channel: String(msg.channel || '').toLowerCase(),
          pin: msg.type === 'pin:set' && msg.pin && typeof msg.pin === 'object' ? msg.pin : null,
        })
        break

      // Coalesced fan-out (server ws-coalesce.ts): one frame per tick carrying
      // several messages. Unwrap in order — each is a frame handled above.
      case 'batch':
        if (Array.isArray(msg.messages)) for (const m of msg.messages) handleWSMessage(m)
        break

      case 'error':
        break

      default:
        log(' Unknown message type:', msg.type)
    }
  } catch (err) {
    console.error('[HS] handleWSMessage error:', err.message, 'type:', msg?.type)
  }
}

// Relay a batch of YouTube chat messages to every Twitch/Kick/YT tab.
// Extracted out of handleWSMessage's 'youtube:chat' case so the yt innertube
// fallback tap (see ~12060) can feed it too — fromTap:true batches use the
// EXACT same routing/dedup/broadcast path a server-relay batch would.
// !fromTap && msg.videoId stamps _ytTapLastDelivery: a real primary just
// delivered, so the tap's silence clock resets. Tap-fed batches must NOT
// stamp — that would be the tap feeding its own "primary is healthy" signal
// and it would never stand down.
function handleYoutubeChatBatch(msg, { fromTap = false } = {}) {
  if (!fromTap && msg.videoId) _ytTapLastDelivery.set(msg.videoId, Date.now())
  // Relay YouTube chat messages to all Twitch/Kick tabs
  if (msg.messages && Array.isArray(msg.messages) && msg.messages.length > 0) {
    // Union of server-echoed channelId and every local binding — the
    // server's per-socket map is single-valued, so its echo alone would
    // miss a second binding to the same stream.
    const bound = new Set(ytChannelsFor(msg.videoId))
    if (msg.channelId) {
      bound.add(msg.channelId)
      if (msg.videoId) setYtVideoChannel(msg.videoId, msg.channelId)
    }
    // Pending-subscribe attribution is ambiguous when multiple subscribes are
    // in flight (server may resolve them in any order). Only attribute when
    // exactly one is pending — otherwise fall through to 'global' and let
    // the eventual youtube:status event correct the mapping. This trades a
    // brief routing miss for the much worse cross-channel chat leak that
    // happens when LIFO pop guesses wrong.
    if (!bound.size && msg.videoId && pendingYtSubscribes.length === 1) {
      const pend = pendingYtSubscribes.shift()
      bound.add(pend.channelId)
      setYtVideoChannel(msg.videoId, pend.channelId)
    }
    // A stale fallback binding (persisted by an older build) alongside a
    // real one would fan every message out twice.
    if (bound.size > 1) bound.delete(YT_FALLBACK_CHANNEL)
    const channelIds = bound.size ? [...bound] : [YT_FALLBACK_CHANNEL]

    // Use real ytMsg.timestamp for both replay and live. Mellen's
    // ordering rule: every msg lands at its true chronological position
    // via fairMerge's full sort. live YT msgs may appear slightly above
    // the most-recent twitch msg if YT's timestamp is older — that's
    // chronologically correct, not a bug. Backfill ensures hard-refresh
    // accuracy: msgs from 30 min ago slot into the chat at 30 min ago.
    const sorted = msg.messages.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    const isReplay = !!msg.replay
    const buildItem = (ytMsg) => ({
      id: ytMsg.id || undefined, // innertube id — end-to-end yt dedup key
      user: ytMsg.user,
      text: ytMsg.text,
      color: ytMsg.color || '#ff0000',
      time: ytMsg.timestamp || Date.now(),
      emotes: ytMsg.emotes || [],
      msgType: ytMsg.type,
      amount: ytMsg.amount || '',
      scColor: ytMsg.scColor || '',
      sticker: ytMsg.sticker || null,
      avatar: ytMsg.avatar || undefined,
      badges: ytMsg.badges || undefined,
      systemMsg: ytMsg.systemMsg || undefined,
      // author's UC… channel id — yt_<id> paint/identity lookups. NEVER
      // put this in userId (twitch-space only, see paints.js ID-SPACE
      // SAFETY) — it rides its own field.
      authorChannelId: ytMsg.authorChannelId || undefined,
      // Server-enriched third-party emote refs (name→{url,provider,zeroWidth}) —
      // sender inventory resolved server-side; renders without a per-sender
      // fetch. Server-fed only (absent on the innertube fallback tap).
      hsEmotes: ytMsg.hsEmotes || undefined,
    })
    const items = sorted.map(buildItem)
    // ONE batch payload per bound channel, not one per message — a 20-msg
    // poll × 2 bound channels used to build 40 payloads and IPC-clone each
    // across every tab. content-script's social.js unpacks the batch back
    // through the same per-message routing:
    //   replay → ingestReplayYtMsg (bulk-buffer + 1 microtask render)
    //   live   → enqueueYtForPacing (per-channel 60-400ms cadence)
    for (const channelId of channelIds) {
      for (const item of items) {
        try {
          bgYtIngest({ channelId, ...item })
        } catch {}
      }
      broadcastToTabs({
        type: 'youtube_chat_batch',
        videoId: msg.videoId,
        channelId,
        platform: 'youtube',
        source: 'server',
        replay: isReplay,
        messages: items,
      })
    }
  }
}

// Reconnect with exponential backoff
function scheduleReconnect() {
  if (hsWsIdleClosed) return // Deliberate idle close — a returning tab reconnects
  if (authFailedBlock) return // Auth failed — don't loop
  if (reconnectTimer) return // Already scheduled
  // Don't burn retries against a known-dead network — the online listener
  // will fire a fresh connect when connectivity comes back.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    log(' Skipping reconnect — navigator.onLine is false')
    return
  }

  // If the server signalled a planned shutdown, spread reconnects across the
  // window it asked for. Consumed once — subsequent transient drops get the
  // normal exponential backoff.
  let shutdownSpread = 0
  if (pendingReconnectSpreadMs > 0) {
    shutdownSpread = Math.random() * pendingReconnectSpreadMs
    pendingReconnectSpreadMs = 0
  }

  const jitter = Math.random() * 1000
  // Capped at 15s (was 30s) — long-running stream sessions can't tolerate
  // half-minute gaps when recovering from a transient network blip.
  const delay = Math.min(1000 * 2 ** reconnectAttempts, 15000) + jitter + shutdownSpread
  reconnectAttempts++
  log(` Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempts})`)

  // After 3 consecutive failures, surface a "down" banner to UIs.
  // Cleared in socket.onopen when we reconnect.
  if (reconnectAttempts === 3) {
    broadcastToTabs({ type: 'api_status', source: 'heatsync', state: 'down' })
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectWebSocket().catch((err) => log(' WS reconnect failed:', err?.message))
  }, delay)
}

// Join channel room for emote broadcasting
async function joinChannel(platform, channelName, channelId = null, senderTabId = null) {
  const channelKey = `${platform}/${channelName}`
  if (senderTabId) {
    tabChannels.set(senderTabId, { channel: channelKey, channelOwner: null })
    saveTabChannels()
  }
  log(' 🚪 Setting channel:', channelKey, 'id:', channelId, 'tab:', senderTabId)

  // Fetch channel owner's emotes (7TV EventAPI subscription happens inside)
  fetchChannelOwnerEmotes(channelName, channelId, platform).catch((err) =>
    console.warn('[heatsync-ext] fetchChannelOwnerEmotes fetch failed:', err?.message),
  )

  // Ensure we're connected first
  if (!isSocketOpen()) {
    await connectWebSocket()
  }

  // Always send channel:join (wsSend queues if not ready)
  wsSend({ type: 'channel:join', platform, channel: channelName })
  log(' 🚪 Joined channel:', channelKey)
}

// Broadcast emote usage - returns success status
function broadcastEmoteUsage(emoteName, emoteHash, senderTabId = null) {
  const senderChannel = senderTabId ? getTabChannel(senderTabId) : null
  const channelStr = senderChannel || null
  if (!channelStr) return { success: false, reason: 'no_channel' }
  if (!isSocketOpen() || !isAuthenticated) {
    log(
      ' ⚠️ Cannot broadcast emote - socket open:',
      isSocketOpen(),
      'authenticated:',
      isAuthenticated,
      'channel:',
      channelStr,
    )
    return {
      success: false,
      reason: 'not_ready',
      socketOpen: isSocketOpen(),
      authenticated: isAuthenticated,
      channel: channelStr,
    }
  }

  // Parse platform and channel from combined format
  const [platform, channel] = channelStr.split('/')

  log(' 📤 BROADCASTING EMOTE USAGE:', {
    emoteName,
    platform,
    channel,
  })

  wsSend({
    type: 'emote:used',
    platform,
    channel,
    emoteName,
    emoteData: emoteHash ? { hash: emoteHash } : undefined,
  })

  return { success: true }
}

// Add emote to your set (for global emotes clicked in chat) - returns success/failure
//
// `opts` is for the picker's own-upload flow: `source: 'upload'` (the server
// keys ownership + hard-delete on it), the upload's phash/width/height, and
// `quiet` — the caller reports every outcome in its own words, so none of the
// failure broadcasts (a second, English-only toast) go out.
async function addToInventory(emoteName, emoteHash, emoteUrl, zeroWidth = false, replace = false, opts = {}) {
  try {
    const authToken = await getAuthCookie()
    if (!authToken) {
      if (!opts.quiet)
        broadcastToTabs({
          type: 'emote_add_failed',
          emoteName,
          error: 'Not logged in - visit heatsync.org to log in',
          // Distinct flag so the panel shows a one-click login nudge instead of a
          // transient error toast — the #1 reason emotes "don't work" for people.
          notLoggedIn: true,
        })
      return { success: false, error: 'Not logged in' }
    }

    log(' Adding to your set via API:', emoteName)

    // Call server API to add emote
    const response = await fetchWithTimeout(`${API_URL}/api/user/emotes`, {
      method: 'POST',
      // Bearer-only (omit cookie): sending the cookie makes the server enforce
      // CSRF on this mutation, which the extension can't satisfy → 403/hang. The
      // Bearer token alone is CSRF-exempt (matches the working syncMuteToServer).
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        emoteUrl,
        emoteName,
        customName: emoteName,
        source: opts.source || 'extension',
        sourceId: opts.source ? null : emoteHash,
        zeroWidth: !!zeroWidth,
        ...(opts.phash ? { phash: String(opts.phash).slice(0, 512) } : {}),
        ...(opts.width > 0 && opts.height > 0 ? { width: opts.width, height: opts.height } : {}),
        ...(replace ? { replace: true } : {}),
      }),
    })

    const data = await response.json().catch(() => ({ error: `HTTP ${response.status} (non-JSON body)` }))

    if (!response.ok) {
      if (!opts.quiet)
        broadcastToTabs({
          type: 'emote_add_failed',
          emoteName,
          error: data.error || `Server error (${response.status})`,
        })
      return { success: false, error: data.error || `HTTP ${response.status}` }
    }

    log(' ✅ Added to server inventory:', data)

    // Update local inventory immediately
    const newEmote = {
      name: emoteName,
      hash: data.hash || emoteHash,
      url: emoteUrl,
      slot: data.slot,
      addedAt: Date.now(),
    }

    // Check if already in your set (by hash) to avoid duplicates
    // Use snapshot to prevent race with concurrent filter/reassign
    // A replace re-pointed the slot: drop the old entry under this name first.
    const currentInventory = [...emoteInventory].filter((e) => !(data.replaced && e.name === emoteName))
    if (!currentInventory.some((e) => e.hash === newEmote.hash)) {
      currentInventory.push(newEmote)
      emoteInventory = currentInventory
    }

    // Broadcast success to tabs. senderKeys (from the server response) lets
    // the panel check the identity it's chatting under against the account
    // that actually received the emote — a miss means nobody else can render
    // it and the panel warns instead of lying with a local-only image.
    broadcastToTabs({
      type: 'emote_added',
      emoteName: emoteName,
      hash: data.hash || emoteHash,
      url: emoteUrl,
      slot: data.slot,
      alreadyExists: data.alreadyExists,
      ...(Array.isArray(data.senderKeys) ? { senderKeys: data.senderKeys.slice(0, 10) } : {}),
    })

    // Also update storage for persistence
    await browser.storage.local.set({ emote_inventory: emoteInventory })

    return { success: true, slot: data.slot, hash: data.hash || emoteHash, alreadyExists: data.alreadyExists }
  } catch (error) {
    if (!opts.quiet)
      broadcastToTabs({
        type: 'emote_add_failed',
        emoteName,
        error: error.message || 'Network error',
      })
    return { success: false, error: error.message || 'Network error' }
  }
}

// Coalesce concurrent removes for the same emote — without this, two tabs
// firing the same delete pick different slots from a mid-mutation inventory
// snapshot and the wrong emote gets deleted server-side.
const _removeInFlight = new Map() // hash → Promise

// Remove emote from your set - returns success/failure
async function removeFromInventory(emoteHash, emoteName) {
  const flightKey = emoteHash || emoteName
  if (flightKey && _removeInFlight.has(flightKey)) {
    return _removeInFlight.get(flightKey)
  }
  const p = _removeFromInventoryImpl(emoteHash, emoteName)
  if (flightKey) {
    _removeInFlight.set(flightKey, p)
    p.finally(() => _removeInFlight.delete(flightKey))
  }
  return p
}

// No emote_remove_failed broadcasts in here. Every one was a strict duplicate
// of the { success:false, error } this function already returns, and the picker
// — its only caller — reads that return and toasts from it. No content script
// has ever listened for the message.
async function _removeFromInventoryImpl(emoteHash, emoteName) {
  try {
    const authToken = await getAuthCookie()
    if (!authToken) {
      return { success: false, error: 'Not logged in' }
    }

    log(' Removing from your set via API:', emoteName, 'hash:', emoteHash?.substring(0, 8))

    // Tell content scripts early so they suppress this emote in new messages immediately
    // This must happen BEFORE any fetchEmoteInventory() which would broadcast inventory_update.
    // Hash is forwarded so content can optimistically tier-drop existing rendered wrappers
    // before the server roundtrip completes.
    broadcastToTabs({ type: 'emote_removing', emoteName, hash: emoteHash })

    // Find slot number by hash or name
    let emote = emoteInventory.find((e) => e.hash === emoteHash || e.name === emoteName)
    if (!emote) {
      // Refetch in case local state is stale. fetchEmoteInventory has a 10s
      // throttle — bypass it here so we don't return a spurious "not in set"
      // error during the throttle window.
      log(' Emote not in local inventory, refetching...', emoteName, emoteHash?.substring(0, 8))
      lastInventoryFetch = 0
      await fetchEmoteInventory()
      emote = emoteInventory.find((e) => e.hash === emoteHash || e.name === emoteName)
      if (!emote) {
        broadcastToTabs({ type: 'emote_removing_cancel', emoteName })
        return { success: false, error: 'Emote not found in your set' }
      }
    }

    if (emote.slot == null) {
      // Bypass throttle here too — same reason.
      lastInventoryFetch = 0
      await fetchEmoteInventory()
      const refreshedEmote = emoteInventory.find((e) => e.hash === emoteHash || e.name === emoteName)
      if (refreshedEmote?.slot == null) {
        broadcastToTabs({ type: 'emote_removing_cancel', emoteName })
        return { success: false, error: 'Could not determine emote slot' }
      }
      emote.slot = refreshedEmote.slot
    }

    const doDelete = async (slot) => {
      const resp = await fetchWithTimeout(`${API_URL}/api/user/emotes/${slot}`, {
        method: 'DELETE',
        credentials: 'omit', // Bearer-only → CSRF-exempt (cookie would trigger CSRF)
        headers: { Authorization: `Bearer ${authToken}` },
      })
      // `.catch()` covers a thrown SyntaxError, but JSON.parse('null') resolves
      // to literal null — coerce so `data.error` access can't throw a TypeError
      // and bubble up as the user-facing message.
      const d = (await resp.json().catch(() => null)) || {}
      return { resp, d }
    }

    let { resp: response, d: data } = await doDelete(emote.slot)

    // 404 here is ambiguous. The slot we read from local `emoteInventory` is
    // throttled (10s) and another tab / the move endpoint may have shifted
    // slots since — so the slot we just hit might be empty while the emote
    // is alive and well at a different slot. Without this retry path:
    //   - silent-reconcile-and-broadcast assumes "goal state already true"
    //     and drops the local row. The next 1-min inventory poll pulls the
    //     live row back from the server, the picker re-renders green, the
    //     user right-clicks again, gets 404, repeats. Whack-a-mole.
    //   - failing loud surfaces a confusing "not in set" error on an emote
    //     that visibly IS in the set.
    // So: on 404, force-bypass the inventory throttle and refetch. If the
    // emote moved, retry DELETE with the new slot (the actual destructive
    // operation the user asked for). Only treat as already-gone if the
    // fresh server view confirms the emote is genuinely absent.
    if (response.status === 404) {
      log(' DELETE 404 at slot', emote.slot, '— forcing inventory refetch to verify')
      lastInventoryFetch = 0
      await fetchEmoteInventory()
      const fresh = emoteInventory.find((e) => e.hash === emoteHash || e.name === emoteName)
      if (fresh && fresh.slot != null && fresh.slot !== emote.slot) {
        log(' Slot moved:', emote.slot, '→', fresh.slot, '— retrying DELETE')
        emote = fresh
        ;({ resp: response, d: data } = await doDelete(emote.slot))
      } else if (!fresh) {
        // Server's current view: emote isn't in user's set. Local was stale
        // (optimistic add that never reconciled, missed emote_removed event,
        // another tab beat us to it). Drop the local row + broadcast so all
        // tabs flip to unadded; same end state as a successful DELETE.
        log(' Server confirms emote not in set — reconciling local state')
        emoteInventory = emoteInventory.filter((e) => (emoteHash ? e.hash !== emoteHash : e.name !== emoteName))
        await browser.storage.local.set({ emote_inventory: emoteInventory })
        broadcastToTabs({ type: 'emote_removed', emoteName, hash: emoteHash, slot: emote.slot })
        return { success: true, slot: emote.slot, reconciled: true }
      }
      // else: fresh view still maps it to the same slot the server just 404'd
      // on. That's a server-side inconsistency we can't fix from here; fall
      // through to the loud-error branch below.
    }

    if (!response.ok) {
      // Server-reported "not found in your set" after fresh refetch above
      // means truly already-gone; treat as reconcile.
      if (data.error && /not found in your set/i.test(data.error)) {
        emoteInventory = emoteInventory.filter((e) => (emoteHash ? e.hash !== emoteHash : e.name !== emoteName))
        await browser.storage.local.set({ emote_inventory: emoteInventory })
        broadcastToTabs({ type: 'emote_removed', emoteName, hash: emoteHash, slot: emote.slot })
        return { success: true, slot: emote.slot, reconciled: true }
      }
      broadcastToTabs({ type: 'emote_removing_cancel', emoteName })
      return { success: false, error: data.error || `HTTP ${response.status}` }
    }

    log(' ✅ Removed from server inventory:', data)

    // Update local inventory
    emoteInventory = emoteInventory.filter((e) => (emoteHash ? e.hash !== emoteHash : e.name !== emoteName))
    await browser.storage.local.set({ emote_inventory: emoteInventory })

    // Broadcast success to tabs
    broadcastToTabs({
      type: 'emote_removed',
      emoteName,
      hash: emoteHash,
      slot: emote.slot,
    })

    // Broadcast removal to other clients so they clear pending broadcasts
    // Send to all active channels
    const sentChannels = new Set()
    for (const entry of tabChannels.values()) {
      if (entry.channel && isSocketOpen() && !sentChannels.has(entry.channel)) {
        const [platform, channel] = entry.channel.split('/')
        wsSend({
          type: 'emote:removed',
          platform,
          channel,
          emoteName: emoteName,
        })
        sentChannels.add(entry.channel)
      }
    }
    if (sentChannels.size > 0) {
      log(' 📤 Broadcasted emote removal:', emoteName)
    }

    return { success: true, slot: emote.slot }
  } catch (error) {
    broadcastToTabs({ type: 'emote_removing_cancel', emoteName })
    return { success: false, error: error.message || 'Network error' }
  }
}

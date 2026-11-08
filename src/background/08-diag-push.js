// background part 8 of 11 — init, diagnostics, push.
// build.js concatenates src/background/* in BG_PARTS order into background.js (the service worker cannot import);
// one scope, so a later part may read an earlier part's constants, never the reverse.

// Initialize on startup
async function initialize() {
  log(' 🚀 Starting background script...')

  // Restore startup jitter deadline if SW was evicted mid-wait.
  try {
    const j = await (browser.storage.session?.get('startup_jitter_at') ?? Promise.resolve(null))
    const remaining = (j?.startup_jitter_at || 0) - Date.now()
    if (remaining > 0) pendingStartupJitterMs = remaining
    else if (j?.startup_jitter_at) browser.storage.session?.remove('startup_jitter_at').catch(() => {})
  } catch {}

  // Run auth load + storage batch reads + session restore in PARALLEL — all independent.
  // Saves ~60-90ms of serial waits vs. awaiting them sequentially.
  const tokenP = getAuthCookie().catch((err) => {
    log(' Could not load auth token:', err.message)
    return null
  })
  const storedP = browser.storage.local
    .get([
      'user_info',
      'channel_emotes_fetched_at',
      'channel_emotes_map',
      'seventv_emote_set_ids',
      'muted_users',
      'blocked_users',
      'global_emotes',
      'emote_inventory',
      'blocked_emotes',
      'local_blocked_emotes',
      'youtube_channel_urls',
      'yt_video_to_channel',
      'joined_extra_channels',
      'heatsync_multichat',
      'badges_fetched_at',
      'bttv_badge_map',
      'ffz_badges',
      'chatterino_badges',
      'user_cosmetics_cache',
      'twitch_id_cache',
    ])
    .catch((err) => {
      log(' Storage restore failed:', err.message)
      return {}
    })
  const sessionP = (
    browser.storage.session?.get(['tab_channels', 'joined_extra_channels']) ?? Promise.resolve(null)
  ).catch((e) => {
    console.warn('session storage restore failed:', e)
    return null
  })

  // Kick off WebSocket connect AS SOON AS auth resolves — don't wait for storage to finish.
  // If no auth token, surface that to content scripts so the multichat panel can prompt
  // the user. cookies.onChanged will broadcast loggedIn:true once they sign in.
  tokenP
    .then((t) => {
      if (!t) broadcastToTabs({ type: 'auth_changed', loggedIn: false, reason: 'no_token' })
      return connectWebSocket()
    })
    .catch(() => {})

  // Batch-load all cached state from storage in ONE read
  try {
    const stored = await storedP

    if (stored.user_info?.username) {
      currentUsername = stored.user_info.username
      log(' ✓ Restored username:', currentUsername)
    }
    if (stored.channel_emotes_fetched_at && typeof stored.channel_emotes_fetched_at === 'object') {
      channelEmotesFetchedAt = stored.channel_emotes_fetched_at
      log(' ✓ Restored channelEmotesFetchedAt for', Object.keys(channelEmotesFetchedAt).length, 'channels')
    }
    if (stored.channel_emotes_map && typeof stored.channel_emotes_map === 'object') {
      Object.assign(channelEmotesMap, stored.channel_emotes_map)
      log(' ✓ Restored channelEmotesMap for', Object.keys(stored.channel_emotes_map).length, 'channels')
    }
    if (stored.seventv_emote_set_ids && typeof stored.seventv_emote_set_ids === 'object') {
      for (const [ch, id] of Object.entries(stored.seventv_emote_set_ids)) {
        seventvEmoteSetIds.set(ch, id)
      }
      if (seventvEmoteSetIds.size > 0) {
        log(' ✓ Restored seventvEmoteSetIds for', seventvEmoteSetIds.size, 'channels')
        start7TVPolling()
        for (const setId of seventvEmoteSetIds.values()) subscribe7TVEmoteSet(setId)
      }
    }
    if (stored.bttv_room_ids && typeof stored.bttv_room_ids === 'object') {
      for (const [ch, room] of Object.entries(stored.bttv_room_ids)) {
        if (typeof room === 'string' && /^(twitch|youtube):[\w-]{1,40}$/.test(room)) bttvRoomIds.set(ch, room)
      }
      if (bttvRoomIds.size > 0) {
        log(' ✓ Restored bttvRoomIds for', bttvRoomIds.size, 'channels')
        connectBTTVSocket()
      }
    }
    if (Object.keys(channelEmotesMap).some((k) => Array.isArray(channelEmotesMap[k]))) {
      startThirdPartyPolling()
    }
    if (stored.muted_users && Array.isArray(stored.muted_users)) {
      mutedUsers = new Map()
      for (const entry of stored.muted_users) {
        if (typeof entry === 'string') mutedUsers.set(entry, null)
        else if (entry?.username) mutedUsers.set(entry.username, entry.expiresAt || null)
      }
      if (stored.muted_users.length > 0 && typeof stored.muted_users[0] === 'string') persistMutedUsers()
      pruneExpiredMutes()
      log(' ✓ Loaded', mutedUsers.size, 'muted users')
    }
    if (stored.blocked_users && Array.isArray(stored.blocked_users)) {
      blockedUsers = new Set(stored.blocked_users)
      log(' ✓ Loaded', blockedUsers.size, 'blocked users')
    }
    if (stored.twitch_id_cache && typeof stored.twitch_id_cache === 'object') {
      for (const [name, id] of Object.entries(stored.twitch_id_cache)) {
        if (typeof id === 'string' && /^\d+$/.test(id)) twitchIdCache.set(name, id)
      }
      log(' ✓ Restored twitchIdCache for', twitchIdCache.size, 'usernames')
    }
    // Warm emote arrays from storage cache (instant availability while API fetches run)
    if (Array.isArray(stored.global_emotes)) {
      globalEmotes = stored.global_emotes
      log(' ✓ Warm cache:', globalEmotes.length, 'global emotes from storage')
    }
    if (Array.isArray(stored.emote_inventory)) {
      emoteInventory = stored.emote_inventory
      log(' ✓ Warm cache:', emoteInventory.length, 'inventory emotes from storage')
    }
    if (Array.isArray(stored.blocked_emotes)) {
      blockedEmotes = new Set(stored.blocked_emotes)
      log(' ✓ Warm cache:', blockedEmotes.size, 'blocked emotes from storage')
    }
    if (stored.local_blocked_emotes && Array.isArray(stored.local_blocked_emotes)) {
      localBlockedEmotes = new Set(stored.local_blocked_emotes)
      log(' ✓ Warm cache:', localBlockedEmotes.size, 'local blocked emotes from storage')
    }
    if (stored.youtube_channel_urls && typeof stored.youtube_channel_urls === 'object') {
      // Purge any persisted __live_yt_auto__ — it's an ephemeral per-page binding
      // and must be re-bound from the current channel's explicit YT link, never
      // resurrected from storage. Older builds wrote a guessed @<name>/live here,
      // which is why a stranger's YT chat kept reappearing across reloads.
      if (stored.youtube_channel_urls.__live_yt_auto__) {
        delete stored.youtube_channel_urls.__live_yt_auto__
        browser.storage.local.set({ youtube_channel_urls: { ...stored.youtube_channel_urls } })
      }
      Object.assign(youtubeChannelUrls, stored.youtube_channel_urls)
      delete youtubeChannelUrls.__live_yt_auto__
      log(' ✓ Restored youtubeChannelUrls for', Object.keys(youtubeChannelUrls).length, 'channels')
      // Race fix: connectWebSocket() was kicked off at the top of init() and
      // may have already opened, iterating an empty youtubeChannelUrls in its
      // onopen handler — losing every YT subscription on SW wake. Replay them
      // explicitly now (mirrors the joined_extra_channels pattern below).
      // wsSend queues if not yet open, sends if open.
      for (const [channelId, url] of Object.entries(youtubeChannelUrls)) {
        const vidMatch =
          url.match(/[?&]v=([^&]+)/) || url.match(/\/live\/([^?&/]+)/) || url.match(/youtu\.be\/([^?&]+)/)
        if (vidMatch) setYtVideoChannel(vidMatch[1], channelId)
        wsSend({ type: 'youtube:subscribe', url, channelId })
      }
      // Also replay the global YT subscription if one was set
      browser.storage.local
        .get(['youtube_url'])
        .then((d) => {
          if (d.youtube_url) {
            const vidMatch =
              d.youtube_url.match(/[?&]v=([^&]+)/) ||
              d.youtube_url.match(/\/live\/([^?&/]+)/) ||
              d.youtube_url.match(/youtu\.be\/([^?&]+)/)
            if (vidMatch) setYtVideoChannel(vidMatch[1], 'global')
            wsSend({ type: 'youtube:subscribe', url: d.youtube_url })
          }
        })
        .catch(() => {})
    }
    if (stored.yt_video_to_channel && typeof stored.yt_video_to_channel === 'object') {
      // Restore videoId→channelId routing so chat msgs from existing pollers
      // (server already broadcasting) land on the right tab even when the
      // server doesn't re-echo youtube:status connected on SW wake.
      // Skip __live_yt_auto__ targets — that binding is no longer restored, so
      // routing a video to it would orphan (or resurrect) a stale stream's chat.
      let _ytMapPoisoned = false
      for (const [vid, cids] of Object.entries(stored.yt_video_to_channel)) {
        // Accept both shapes: current array-of-channelIds and the legacy
        // single-string value written before the map went multi-valued.
        for (const cid of Array.isArray(cids) ? cids : [cids]) {
          if (cid === '__live_yt_auto__') {
            _ytMapPoisoned = true
            continue
          }
          const set = ytVideoToChannel.get(vid) || new Set()
          set.add(cid)
          ytVideoToChannel.set(vid, set)
        }
      }
      if (_ytMapPoisoned) persistYtVideoMap()
      log(' ✓ Restored ytVideoToChannel for', ytVideoToChannel.size, 'videos')
    }
    if (Array.isArray(stored.joined_extra_channels)) {
      // Restore Kick channel joins so the WS-connect handler replays them.
      // Survives extension reload (session storage didn't), so re-subscribes
      // fire automatically without waiting for a content-script re-init.
      let _ghostsDropped = false
      for (const key of stored.joined_extra_channels) {
        if (isGhostChannelKey(key)) {
          _ghostsDropped = true // persisted from the pre-blocklist era — purge
          continue
        }
        joinedExtraChannels.add(key)
      }
      if (_ghostsDropped) saveJoinedExtraChannels()
      log(' ✓ Restored', joinedExtraChannels.size, 'extra channel joins from local storage')
      // Replay joins on the WS now — connectWebSocket() was kicked off at the
      // start of init, so by the time storage restore finishes, the WS connect
      // handler may have ALREADY iterated an empty joinedExtraChannels Set.
      // wsSend queues if socket isn't open yet, sends immediately if it is —
      // either way, server gets the rejoin without waiting for content-script
      // multichat re-init.
      for (const key of joinedExtraChannels) {
        const [platform, channel] = key.split('/')
        if (platform && channel) {
          wsSend({ type: 'channel:join', platform, channel })
          // _kpChannels is a non-persisted Map — after SW eviction the Pusher
          // tap has forgotten every channel, and tap-only kick channels have
          // no other live source. Idempotent.
          if (platform === 'kick') kickPusherJoin(channel)
        }
      }
      // Also refetch channel owner emotes for every restored channel — the
      // WS rejoin above only subscribes to live broadcasts, it doesn't
      // refresh per-channel BTTV+FFZ+7TV sets. Without this, every multichat
      // tab except the active one renders raw text until the user clicks
      // each tab (content-side join_channel only fires for the page channel).
      // Internal cache-and-TTL gating in fetchChannelOwnerEmotes makes
      // duplicate calls cheap.
      for (const key of joinedExtraChannels) {
        const [platform, channel] = key.split('/')
        if (!platform || !channel) continue
        // Stagger by 50ms each to avoid 5-10 simultaneous third-party fetches.
        const delay = [...joinedExtraChannels].indexOf(key) * 50
        setTimeout(() => fetchChannelOwnerEmotes(channel, null, platform).catch(() => {}), delay)
      }
    }
    // Also seed joinedExtraChannels from the user's multichat config — covers
    // the very first launch after install (or storage wipe) before any content
    // script has fired kickChat.join. Without this, kick subs only start
    // working AFTER the user opens a streaming tab, not at SW boot.
    if (stored.heatsync_multichat?.channels) {
      const cfg = stored.heatsync_multichat.channels
      for (const ch of cfg) {
        if (typeof ch === 'string') continue
        if (ch.kick && typeof ch.kick === 'string') {
          const key = `kick/${ch.kick.toLowerCase()}`
          if (!joinedExtraChannels.has(key)) {
            joinedExtraChannels.add(key)
            wsSend({ type: 'channel:join', platform: 'kick', channel: ch.kick.toLowerCase() })
          }
          kickPusherJoin(ch.kick.toLowerCase())
        }
      }
      saveJoinedExtraChannels()
    }
    if (stored.badges_fetched_at && typeof stored.badges_fetched_at === 'number') {
      badgesFetchedAt = stored.badges_fetched_at
      log(' ✓ Restored badgesFetchedAt:', new Date(badgesFetchedAt).toISOString())
    }
    if (stored.user_cosmetics_cache && Array.isArray(stored.user_cosmetics_cache)) {
      const now = Date.now()
      let restored = 0
      for (const [key, val] of stored.user_cosmetics_cache) {
        if (!val?.fetchedAt) continue
        // Negative entries (no paint AND no badge) get the shorter TTL on
        // restore too — otherwise a stale null badge cache would suppress a
        // newly-granted 7TV badge for up to 30 min after extension reload.
        const isNegative = !val.paint && !val.badge
        const ttl = isNegative ? COSMETICS_NEGATIVE_TTL : USER_COSMETICS_TTL
        if (now - val.fetchedAt < ttl) {
          userCosmeticsCache.set(key, val)
          restored++
        }
      }
      if (restored > 0) log(' ✓ Warm cache:', restored, 'user cosmetics from storage')
    }
    // Warm-cache 3rd-party badge maps so badges render immediately on cold start
    if (stored.bttv_badge_map && typeof stored.bttv_badge_map === 'object') {
      bttvBadgeMap = new Map(Object.entries(stored.bttv_badge_map))
      log(' ✓ Warm cache:', bttvBadgeMap.size, 'BTTV badge entries from storage')
    }
    if (Array.isArray(stored.ffz_badges)) ffzBadgeList = stored.ffz_badges
    if (Array.isArray(stored.chatterino_badges)) chatterinoBadgeList = stored.chatterino_badges
    // the per-user maps these replaced (~8MB on disk, never read again)
    browser.storage.local.remove(['ffz_badge_map', 'chatterino_badge_map']).catch(() => {})
    // Push restored maps to tabs that loaded before this cold-wake restore landed.
    // Content scripts request get_bulk_badges during their own init; one of them
    // can arrive before the async restore completes and the multichat overlay,
    // which inits early, may receive an empty response with no later recovery
    // (cosmetics_update only re-broadcasts on a fresh fetch). A warm-cache push
    // here gives every already-listening surface the maps regardless of timing.
    if (ffzBadgeList.length || bttvBadgeMap.size || chatterinoBadgeList.length) {
      broadcastBadgeMaps()
    }
  } catch (err) {
    log(' Storage restore failed:', err.message)
  }

  // Restore tabChannels from session storage (survives worker restarts) — already in flight from initialize()
  try {
    const session = await sessionP
    if (session?.tab_channels) {
      // Validate restored tab IDs still exist
      const allTabs = await browser.tabs.query({
        url: ['*://*.twitch.tv/*', '*://*.kick.com/*', '*://*.youtube.com/*'],
      })
      const validIds = new Set(allTabs.map((t) => t.id))
      for (const [tabId, entry] of Object.entries(session.tab_channels)) {
        const id = Number(tabId)
        if (validIds.has(id)) tabChannels.set(id, entry)
      }
      log(' ✓ Restored', tabChannels.size, 'tab channels from session storage')
      // Replay joins on the WS now — same race as joinedExtraChannels above:
      // connectWebSocket() was kicked off at the start of init, so the connect
      // burst may have ALREADY iterated an empty tabChannels Map. wsSend
      // queues if the socket isn't open yet; server tolerates duplicate joins.
      const replayedTabJoins = new Set()
      for (const entry of tabChannels.values()) {
        if (!entry.channel || replayedTabJoins.has(entry.channel)) continue
        replayedTabJoins.add(entry.channel)
        const [platform, channel] = entry.channel.split('/')
        if (!platform || !channel) continue
        wsSend({ type: 'channel:join', platform, channel })
        if (platform === 'kick') kickPusherJoin(channel)
      }
    }
    if (Array.isArray(session?.joined_extra_channels)) {
      // Migration path — old code persisted to session. Pull anything still
      // there and bake it into the local-storage-backed Set on next save.
      for (const key of session.joined_extra_channels) {
        if (!isGhostChannelKey(key)) joinedExtraChannels.add(key)
      }
    }
  } catch (e) {
    console.warn('session storage restore failed:', e)
  }

  // Broadcast warm-cached badges immediately (before fresh fetch)
  if (bttvBadgeMap.size > 0 || ffzBadgeList.length > 0 || chatterinoBadgeList.length > 0) {
    broadcastBadgeMaps()
  }

  // Start WebSocket immediately (don't wait for API fetches)
  connectWebSocket().catch(() => {})

  broadcastToTabs({ type: 'loading_status', text: bgT('bg_loading_emotes') })

  // Fetch fresh data in parallel (updates warm cache)
  Promise.all([
    fetchGlobalEmotes(),
    fetchBulkBadges(),
    fetchEmoteInventory(),
    fetchBlockedEmotes(),
    fetchFollowedUsers(),
    fetchUserInfo(),
    fetchViewerSettings(),
  ])
    .then(() => {
      log(' ✓ All fetches complete - global:', globalEmotes.length, 'personal:', emoteInventory.length)
      broadcastToTabs({ type: 'loading_status', done: true })
      // Persist fresh data — single batched write (fire-and-forget, don't await).
      // emote_inventory is gated on inventoryFetchOK: if the API call failed
      // transiently, the in-memory array is the warm cache from storage and
      // writing it back is a no-op; if the API call clobbered it to [] on a
      // 401 the logout path already cleaned storage. Either way, never let a
      // post-init persist overwrite a healthy warm cache with [].
      const persist = {
        blocked_emotes: Array.from(blockedEmotes),
      }
      // Only persist a non-empty global set. globalEmotes is [] when every provider
      // (BTTV/FFZ/7TV/twitch) failed this fetch (network/VPN blip) — like the
      // emote_inventory gate below, never overwrite a healthy warm cache with [].
      // Global sets are platform-wide and never legitimately empty, so [] == failure.
      if (globalEmotes.length > 0) {
        persist.global_emotes = globalEmotes
      }
      if (inventoryFetchOK) {
        persist.emote_inventory = emoteInventory
      }
      // user_info is no longer batched here — fetchUserInfo() persists it the
      // moment it has it, so it can't be lost when this batch never runs.
      browser.storage.local.set(persist).catch(() => {})
    })
    .catch((err) => log(' Fetch error:', err.message))

  // Re-register push subscription after MV3 service worker restart.
  // The cookie-onChanged path only fires on login/logout; on cold SW wake
  // with an existing valid token, push must be re-confirmed against the server
  // so the endpoint stays active.
  if (authToken) {
    subscribeToPush(authToken).catch((err) => log(' subscribeToPush retry failed:', err?.message))
  }

  // Inventory refresh driven by chrome.alarms 'refresh-emote-inventory' (MV3 setInterval dies with SW)

  // Global emotes refresh handled by chrome.alarms (MV3 setInterval unreliable for long durations)
}

log(' 🚀 Calling initialize()...')
initPromise = initialize().catch((err) => {
  console.error('[heatsync] Initialize failed:', err)
})

// Diag snapshot for bug reports — gathered on demand, never stored.
// Combines SW-side runtime state with the most recently active tab's page-side
// state (hs_diag_page key, written by content.js). No PII; counts and states only.
function _wsLabel(ws) {
  if (!ws) return 'null'
  const s = ws.readyState
  return s === 0 ? 'connecting' : s === 1 ? 'open' : s === 2 ? 'closing' : 'closed'
}
async function buildDiagSnapshot() {
  const now = Date.now()
  const out = { ts: now, ver: 'unknown', sw: {}, page: null }
  try {
    out.ver = browser.runtime.getManifest().version
  } catch {}
  try {
    out.sw.irc = {
      state: _wsLabel(BG_IRC?.ws),
      lastDataAgeMs: BG_IRC?.lastData ? now - BG_IRC.lastData : null,
      channels: BG_IRC?.channels?.size || 0,
      liveTabs: BG_IRC?.liveTabs?.size || 0,
      reconnectAttempts: BG_IRC?.reconnectAttempts || 0,
    }
  } catch {}
  try {
    out.sw.ws7tv = _wsLabel(seventvWebSocket)
  } catch {}
  try {
    out.sw.wsHs = _wsLabel(socket)
  } catch {}
  try {
    out.sw.relays = await relayDiagSummary()
  } catch {}
  try {
    out.sw.inventory = Array.isArray(emoteInventory) ? emoteInventory.length : 0
  } catch {}
  try {
    out.sw.blocked = blockedEmotes?.size || 0
  } catch {}
  try {
    out.sw.channelEmotes = Object.keys(channelEmotesMap || {}).length
  } catch {}
  try {
    const h = await getCachedHealth()
    const { hs_health_at } = await browser.storage.local.get('hs_health_at')
    out.sw.health = {
      kill: !!h.kill,
      ext_min: h.ext_min || '',
      disabledN: (h.disabled || []).length,
      msgPresent: !!h.msg,
      ageMs: hs_health_at ? now - hs_health_at : null,
    }
  } catch {}
  try {
    const { hs_diag_page } = await browser.storage.local.get('hs_diag_page')
    if (hs_diag_page && typeof hs_diag_page === 'object') {
      out.page = { ...hs_diag_page, ageMs: hs_diag_page.ts ? now - hs_diag_page.ts : null }
    }
  } catch {}
  return out
}

// ============================================
// WEB PUSH SUBSCRIPTION
// ============================================
// MV3: service workers support PushManager via self.registration.pushManager.
// Firefox has NO push here: MV2 background pages run in a Window (no
// self.registration), and FF doesn't support the Push API in extension
// contexts at all — subscribeToPush no-ops there by design. FF's persistent
// background page keeps the WS alive, which covers live notifications.
// Notification.permission check is skipped — extensions have implicit grant
// via the 'notifications' manifest permission.

function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const out = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i)
  return out
}

async function subscribeToPush(token) {
  try {
    if (!self.registration?.pushManager) {
      log(' PushManager not available — skipping push subscription')
      return
    }
    // Fast-path: storage marker means we already confirmed a subscription this
    // browser session — skip the getSubscription() call entirely. Cleared on
    // logout / unsubscribe paths. Cuts SW-wake noise across 100k clients.
    try {
      const m = await browser.storage.session?.get?.('hs_push_ok')
      if (m?.hs_push_ok) return
    } catch {}
    const existing = await self.registration.pushManager.getSubscription()
    if (existing) {
      log(' Push already subscribed:', `${existing.endpoint.slice(0, 40)}...`)
      try {
        chrome.storage.session?.set?.({ hs_push_ok: 1 })
      } catch {}
      return
    }
    const keyRes = await fetchWithTimeout(`${API_URL}/api/push/vapid-key`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!keyRes.ok) {
      log(' VAPID key fetch failed:', keyRes.status)
      return
    }
    const keyData = await keyRes.json()
    const vapidKey = keyData.key
    if (!vapidKey) {
      log(' VAPID key missing in response')
      return
    }
    const sub = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(vapidKey),
    })
    const subJson = sub.toJSON()
    const subRes = await fetchWithTimeout(`${API_URL}/api/push/subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        endpoint: subJson.endpoint,
        keys: { p256dh: subJson.keys.p256dh, auth: subJson.keys.auth },
      }),
    })
    if (!subRes.ok) {
      log(' Push subscribe POST failed:', subRes.status)
      return
    }
    log(' Push subscription registered')
    try {
      chrome.storage.session?.set?.({ hs_push_ok: 1 })
    } catch {}
  } catch (err) {
    log(' subscribeToPush error:', err?.message)
  }
}

async function unsubscribeFromPush(token) {
  try {
    if (!self.registration?.pushManager) return
    try {
      chrome.storage.session?.remove?.('hs_push_ok')
    } catch {}
    const sub = await self.registration.pushManager.getSubscription()
    if (!sub) return
    const endpoint = sub.endpoint
    await sub.unsubscribe()
    if (token) {
      // DELETE, not POST — the server only ever registered DELETE, so this
      // 404'd every time and the swallowed error hid it. The push_subscriptions
      // row then survived until a later send hit the dead endpoint and
      // self-pruned it, costing one guaranteed failed push per stale row.
      await fetchWithTimeout(`${API_URL}/api/push/unsubscribe`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ endpoint }),
      }).catch((err) => log(' push unsubscribe failed:', err?.message))
    }
    log(' Push subscription removed')
  } catch (err) {
    log(' unsubscribeFromPush error:', err?.message)
  }
}

// Receive a push message and show a notification
self.addEventListener('push', (ev) => {
  let title = 'HeatSync'
  let body = ''
  // Use runtime.getURL so the icon resolves inside the extension package
  const icon = browser.runtime.getURL('icon-48.png')
  let data = {}
  try {
    if (ev.data) {
      const payload = ev.data.json()
      title = payload.title || title
      body = payload.body || body
      // Don't accept payload.icon — would let server set arbitrary URLs
      data = payload.data || {}
    }
  } catch (_e) {
    body = ev.data?.text() || ''
  }
  ev.waitUntil(self.registration.showNotification(title, { body, icon, data }))
})

self.addEventListener('notificationclick', (ev) => {
  ev.notification.close()
  const url = ev.notification.data?.url
  // Only open URLs on our own origin — server payloads are untrusted
  if (typeof url === 'string' && url.startsWith('https://heatsync.org/')) {
    ev.waitUntil(clients.openWindow(url))
  }
})

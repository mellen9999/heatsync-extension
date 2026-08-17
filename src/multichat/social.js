// Social - feed, notifications, activity, heatsync API

// module scope resets on re-injection, so a fresh instance re-registers
// after the old one's teardown; window-scope survives takeover and leaves
// handlers dead until hard refresh
const _onceGuardsSocial = {}

let _autoYtVideoId = null // videoId for this tab's __live_yt_auto__ subscription (cross-tab filter)

// Re-arm the __live_yt_auto__ binding for the current URL channel: drop the
// previous channel's subscription/buffer/watchdog state, then re-subscribe
// from getLivePlatformNames(). Shared by twitch/kick soft SPA nav — the yt
// host has its own path in spa-nav.js (autoYtSubscribeForPage).
function rearmLiveYtAuto() {
  // Capture videoId/url BEFORE nulling — the BG needs at least one of them
  // to send the server-side youtube:unsubscribe (channelId alone only
  // cleans local storage and leaves the old stream's poller running).
  const prevVid = _autoYtVideoId
  const prevUrl = ytSubscribedUrls.get('__live_yt_auto__')
  chrome.runtime
    .sendMessage({
      type: 'youtube_ws_unsubscribe',
      channelId: '__live_yt_auto__',
      videoId: prevVid || '',
      url: prevUrl || '',
    })
    .catch(() => {})
  clearYtPace('__live_yt_auto__')
  channelYtMessages.delete('__live_yt_auto__')
  ytChanLastSeen.delete('__live_yt_auto__')
  ytChanRejoinAttempts.delete('__live_yt_auto__')
  ytSubscribedUrls.delete('__live_yt_auto__')
  _autoYtVideoId = null
  if (gateAtBoot('chat-youtube') === false) return
  const names = getLivePlatformNames()
  if (!names.youtube) return
  ytSubscribedUrls.set('__live_yt_auto__', names.youtube)
  ytChanLastSeen.set('__live_yt_auto__', Date.now())
  chrome.runtime
    .sendMessage({
      type: 'youtube_ws_subscribe',
      url: names.youtube,
      channelId: '__live_yt_auto__',
    })
    .catch(() => {})
  // Fetch the new channel's yt emote set too, keyed by the bare url-channel
  // name so a linked channel's emotes merge into one bucket (mirrors init's
  // sibling send after its own youtube_ws_subscribe).
  const urlCh = getCurrentChannel()?.toLowerCase()
  if (urlCh) {
    safeSendMessage({
      type: 'join_channel',
      platform: 'youtube',
      channel: urlCh,
      channelId: names.youtube || null,
    })
  }
}

// YT POLL SMOOTHING: server polls YouTube every ~5s and dispatches the whole
// batch back-to-back over WS. Without smoothing, 10 msgs land in one rAF
// frame and the chat flashes them all at once. We drip them per-channel using
// the REAL inter-message timestamp deltas (msg.time from YouTube), so two
// msgs posted 1.8s apart show up 1.8s apart visually — natural human pacing.
// Floor and cap keep things perceptible without dragging.
const YT_PACE_MIN_MS = 60 // floor — never emit faster than this
const YT_PACE_MAX_MS = 400 // cap — never delay a single msg longer than this
const YT_PACE_BURST_MAX = 1500 // total projected backlog cap; overflow flushes synchronously
const _ytPaceQueue = new Map() // channelId → ytMsg[] (in real-time order)
const _ytPaceTimer = new Map() // channelId → timer handle
const _ytPaceLastEmit = new Map() // channelId → { time: ms, msgTime: real msg.time }

// Drop all pacer state for a channel. MUST be called on every unsubscribe/
// teardown path — a pending drain timer would otherwise resurrect the deleted
// buffer and bleed the old stream's queued msgs into the re-armed channel.
function clearYtPace(channelId) {
  const t = _ytPaceTimer.get(channelId)
  if (t !== undefined) cleanup.clearTimeout(t)
  _ytPaceTimer.delete(channelId)
  _ytPaceQueue.delete(channelId)
  _ytPaceLastEmit.delete(channelId)
}

// Heat tier display — big scaling numbers + color glow + row effects, no emoji
// Matches website colors.js: #444 → #888 → #aaa → #ccc → #eee → #fff
function formatHeat(heat) {
  if (heat >= 1000) {
    const k = heat / 1000
    const f = k.toFixed(1)
    return f.endsWith('.0') ? `${f.slice(0, -2)}k` : `${f}k`
  }
  return String(heat)
}

// pinned warm/orange by doctrine — heat FX ramp, not a semantic var
function getHeatNumberStyle(heat, isReply) {
  let fontSize, color, textShadow, animation
  if (isReply) {
    if (heat > 500) fontSize = 20
    else if (heat > 100) fontSize = 18
    else if (heat > 50) fontSize = 16
    else if (heat > 10) fontSize = 14
    else fontSize = 12
  } else {
    if (heat > 500) fontSize = 32
    else if (heat > 100) fontSize = 26
    else if (heat > 50) fontSize = 22
    else if (heat > 10) fontSize = 18
    else fontSize = 14
  }
  if (heat > 500) {
    color = '#fff'
    textShadow =
      '0 0 6px rgba(255,255,255,1),0 0 15px rgba(255,200,100,1),0 0 30px rgba(255,135,0,0.9),0 0 50px rgba(255,80,0,0.6)'
    animation = 'hs-heat-breathe 2s ease-in-out infinite'
  } else if (heat > 100) {
    color = '#eee'
    textShadow = '0 0 6px rgba(255,170,50,0.9),0 0 16px rgba(255,135,0,0.6),0 0 30px rgba(255,80,0,0.3)'
  } else if (heat > 50) {
    color = '#fff'
    textShadow = '0 0 6px rgba(255,135,0,0.7),0 0 14px rgba(255,135,0,0.3)'
  } else if (heat > 10) {
    color = heat > 30 ? '#aaa' : '#888'
    textShadow = heat > 30 ? '0 0 4px rgba(204,102,0,0.3)' : undefined
  } else {
    color = '#444'
    textShadow = undefined
  }
  let style = `font-size:${fontSize}px;color:${color};font-weight:900;line-height:1;`
  if (textShadow) style += `text-shadow:${textShadow};`
  if (animation) style += `animation:${animation};`
  return style
}

// pinned warm/orange by doctrine — heat FX ramp, not a semantic var
function getHeatDisplay(heat) {
  if (!heat || heat <= 0) return null
  let border = '#444',
    borderWidth = 2,
    bg = ''
  if (heat >= 500) {
    border = '#fff'
    borderWidth = 4
    bg = 'rgba(60,20,0,0.15)'
  } else if (heat >= 100) {
    border = '#eee'
    borderWidth = 3
    bg = 'rgba(50,15,0,0.10)'
  } else if (heat >= 25) {
    border = '#fff'
    borderWidth = 3
    bg = 'rgba(40,12,0,0.07)'
  } else if (heat >= 10) {
    border = '#fff'
    borderWidth = 2
  } else {
    border = '#444'
    borderWidth = 2
  }
  const suffix = heat >= 10 ? '°' : ''
  const breathe = heat >= 500
  return { suffix, border, borderWidth, bg, breathe }
}

// Feed & notifications state
let feedMessages = []
let feedLoaded = false
let feedLoading = false
let feedPage = 1
let feedHasMore = true
let feedLastFetch = 0 // Timestamp of last feed fetch
let feedFromHotFallback = false // true when /following was empty + we showed /hot instead
// /hot itself had nothing carrying heat and served newest-first instead (server sets
// `fallback`). The banner must not call those posts hot — that is the one thing the
// fallback exists to avoid.
let feedFallbackIsCold = false
const FEED_STALE_MS = 120000 // 2 minutes

// Feed scroll state — handler ref for teardown only, infinite-scroll trigger
let _feedVirtualScrollHandler = null

// Stream events injected inline into per-channel buffers (no dedicated tab)
const activityEvents = []
// Dedupe index mirroring activityEvents' `.text` values — every mutation of
// activityEvents happens through pushActivityEvent, so this never drifts.
// Was a `.some()` linear scan (up to 500 compares per event); a busy multi-
// channel session can push dozens of events per minute.
const _activityEventTexts = new Set()
const ACTIVITY_EVENTS_MAX = 500
function pushActivityEvent(evt) {
  if (_activityEventTexts.has(evt.text)) return
  activityEvents.push(evt)
  _activityEventTexts.add(evt.text)
  if (activityEvents.length > ACTIVITY_EVENTS_MAX) {
    const dropped = activityEvents.splice(0, activityEvents.length - ACTIVITY_EVENTS_MAX)
    for (const d of dropped) _activityEventTexts.delete(d.text)
  }
}
let activeThread = null // { id, op, replies[] } — when set, feed shows thread view
// Tab to return to when the thread's back button is hit. Captured at open time
// from the tab the user was on BEFORE the forced switchTab('feed') (channel tabs
// open threads via that switch). null → return to the feed. Consumed once by the
// back handler in main.js. A dedicated slot (not prevTab, which settings clobbers).
let threadReturnTab = null
let replyState = null // { msgId, user, channel } when replying to a message
let hsAuthToken = null // Heatsync auth state (loaded from storage)
let hsCurrentUsername = null // Heatsync username (loaded from storage user_info)
// Batch keys the signed-in HS account resolves as (server-computed, from
// /api/auth/me via user_info). null = unknown (old server / logged out) —
// consumers must fail open. [] = account has no resolvable platform identity.
let hsSenderKeys = null

// Load + watch heatsync username for own-post detection (edit/delete UI)
async function loadHsUsername() {
  try {
    const data = await api.storage.local.get('user_info')
    const ui = data?.user_info
    hsCurrentUsername = ui?.username?.toLowerCase() || null
    hsSenderKeys = Array.isArray(ui?.sender_keys) ? ui.sender_keys : null
    // Cross-platform mention aliases: any name across Twitch/Kick/YT counts as
    // a mention of the user, even if the chat is on a different platform.
    // ui.username (heatsync core name) is always included so bare-name mentions
    // resolve even when getCurrentUsername() returns null (e.g. logged-out Kick
    // tab) and no platform aliases are configured.
    mentionAliases = new Set()
    if (ui?.username) mentionAliases.add(ui.username.toLowerCase())
    if (ui?.kick_username) mentionAliases.add(ui.kick_username.toLowerCase())
    if (ui?.youtube_username) mentionAliases.add(ui.youtube_username.toLowerCase())
    if (ui?.twitch_username) mentionAliases.add(ui.twitch_username.toLowerCase())
    // Your own paint/tenure/colour jump the cosmetics queue and your picked
    // colour seeds now — otherwise your name waits behind the whole channel.
    primeSelfHsCosmetics(ui)
  } catch (_) {
    hsCurrentUsername = null
    hsSenderKeys = null
  }
}
function isOwnFeedPost(m) {
  return !!(hsCurrentUsername && m?.username && m.username.toLowerCase() === hsCurrentUsername)
}

const EDIT_WINDOW_MS = 10 * 60 * 1000 // 10 min — server enforces

// Inline edit UI for own feed posts
function showFeedEditUI(div, msg) {
  if (div.querySelector('.hs-feed-edit-form')) return
  const body = div.querySelector('.hs-feed-body')
  if (!body) return
  const original = msg.content || ''
  const form = document.createElement('div')
  form.className = 'hs-feed-edit-form'
  form.style.cssText = 'display:flex;gap:4px;align-items:flex-start;margin-top:4px;'
  const ta = document.createElement('textarea')
  ta.value = original
  ta.maxLength = 500
  ta.rows = 2
  ta.style.cssText =
    'flex:1;background:#000;color:#fff;border:1px solid #808080;padding:4px;font-family:inherit;font-size:13px;resize:vertical;'
  const saveBtn = document.createElement('button')
  saveBtn.textContent = 'save'
  saveBtn.style.cssText =
    'background:#fff;color:#000;border:none;padding:4px 8px;font-family:inherit;font-size:13px;cursor:pointer;'
  const cancelBtn = document.createElement('button')
  cancelBtn.textContent = 'cancel'
  cancelBtn.style.cssText =
    'background:#000;color:#fff;border:1px solid #808080;padding:4px 8px;font-family:inherit;font-size:13px;cursor:pointer;'
  const errEl = document.createElement('div')
  errEl.style.cssText = 'font-size:13px;color:var(--hs-danger);margin-top:2px;'
  form.append(ta, saveBtn, cancelBtn)
  body.style.display = 'none'
  body.parentNode.insertBefore(form, body.nextSibling)
  body.parentNode.insertBefore(errEl, form.nextSibling)
  ta.focus()
  ta.select()

  const close = () => {
    body.style.display = ''
    form.remove()
    errEl.remove()
  }
  cancelBtn.addEventListener('click', close)
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      saveBtn.click()
    }
  })
  saveBtn.addEventListener('click', async () => {
    const newContent = ta.value.trim()
    if (!newContent) {
      errEl.textContent = 'content cannot be empty'
      return
    }
    if (newContent === original) {
      close()
      return
    }
    saveBtn.disabled = true
    saveBtn.textContent = 'saving...'
    errEl.textContent = ''
    const resp = await apiFetch(`/api/messages/${encodeURIComponent(msg.base36_id)}`, {
      method: 'PATCH',
      body: { content: newContent },
    })
    if (resp?.ok && resp.data?.success) {
      msg.content = resp.data.message?.content || newContent
      msg.edited_at = resp.data.message?.edited_at
      msg.edit_count = resp.data.message?.edit_count
      close()
      // Re-render entire feed to pick up sanitized content + emote refs
      if (typeof renderFeed === 'function') renderFeed()
    } else {
      errEl.textContent = resp?.data?.error || resp?.error || 'edit failed'
      saveBtn.disabled = false
      saveBtn.textContent = 'save'
    }
  })
}

async function deleteFeedPost(msg) {
  if (!confirm('delete this post?')) return
  const resp = await apiFetch(`/api/messages/${encodeURIComponent(msg.base36_id)}`, {
    method: 'DELETE',
  })
  if (resp?.ok) {
    const div = document.querySelector(`.hs-feed-msg[data-msg-id="${CSS.escape(msg.base36_id)}"]`)
    if (div) div.remove()
    const idx = feedMessages.findIndex((m) => m.base36_id === msg.base36_id)
    if (idx >= 0) feedMessages.splice(idx, 1)
    return
  }
  // Delete was the one mutation in this file with no failure branch: an expired
  // session / 403 / 500 left the post sitting there and said nothing, so the
  // user assumed the click missed and clicked again. apiFetch never throws (it
  // returns {ok:false}), so a .catch() here would be dead code — check the flag.
  showToast(resp?.data?.error || resp?.error || t('mc_feed_delete_failed'), 'error')
}

// ============================================
// SOCIAL TABS (FEED & NOTIFICATIONS)
// ============================================

// API proxy — routes through background.js to bypass CORS + attach auth
async function apiFetch(path, opts = {}) {
  // Route through safeSendMessage, NOT a bare runtime.sendMessage. An MV3 service
  // worker that has gone to sleep rejects with "Receiving end does not exist" —
  // that's RECOVERABLE (the message itself wakes it), and safeSendMessage retries
  // on a [100,500,2000]ms ladder for exactly this. The old bare call collapsed
  // every rejection into 'context invalidated', so the first user action after a
  // BG restart silently no-op'd, and callers reported a transient wake as a
  // terminal failure — that's what made /dm say "heatsync user not found" when
  // the SW was merely restarting. ~40 call sites (follow, whispers, emotes,
  // seen-state, chat-logs, profile-card) inherit the retry from here.
  // safeSendMessage never throws; it returns {ok:false,error} instead.
  const resp = await safeSendMessage({
    type: 'api_fetch',
    path,
    method: opts.method || 'GET',
    auth: opts.auth !== false,
    body: opts.body,
  })
  return resp || { ok: false, error: 'no response' }
}

// Load heatsync auth state from storage
async function loadHsAuth() {
  try {
    const data = await api.storage.local.get(['auth_token_encrypted', 'auth_token'])
    hsAuthToken = !!(data.auth_token_encrypted || data.auth_token)
    log('Heatsync auth:', hsAuthToken ? 'logged in' : 'anonymous')
  } catch (_) {
    hsAuthToken = false
  }
  loadHsUsername()

  // Watch for auth changes (login/logout on heatsync.org)
  if (!_onceGuardsSocial.authWatcher) {
    _onceGuardsSocial.authWatcher = true
    cleanup.addListener(api.storage.onChanged, (changes, area) => {
      if (area !== 'local') return
      if (changes.user_info) {
        const ui = changes.user_info.newValue
        hsCurrentUsername = ui?.username?.toLowerCase() || null
        hsSenderKeys = Array.isArray(ui?.sender_keys) ? ui.sender_keys : null
        mentionAliases = new Set()
        if (ui?.username) mentionAliases.add(ui.username.toLowerCase())
        if (ui?.kick_username) mentionAliases.add(ui.kick_username.toLowerCase())
        if (ui?.youtube_username) mentionAliases.add(ui.youtube_username.toLowerCase())
        if (ui?.twitch_username) mentionAliases.add(ui.twitch_username.toLowerCase())
        primeSelfHsCosmetics(ui)
      }
      if (changes.auth_token_encrypted || changes.auth_token) {
        const wasAuthed = hsAuthToken
        hsAuthToken = !!(changes.auth_token_encrypted?.newValue || changes.auth_token?.newValue)
        if (wasAuthed !== hsAuthToken) {
          log('Auth state changed:', hsAuthToken ? 'logged in' : 'logged out')
          // On login, replay any whispers that failed with auth errors so the
          // user doesn't have to manually retry each one.
          if (!wasAuthed && hsAuthToken && typeof retryAuthFailedWhispers === 'function') {
            retryAuthFailedWhispers()
          }
          // Reset feed/discover/pinned data on auth change so the next
          // tab open re-fetches with new auth.
          feedLoaded = false
          feedMessages = []
          discoverLoaded = false
          discoverLoading = false
          discoverTags = []
          discoverProfiles = []
          pinnedLoaded = false
          pinnedLoading = false
          pinnedMessages = []
          if (currentTab === 'feed') {
            renderMessages(currentTab)
          }
          // Auth-bound: re-seed seen-state from the server for the new
          // identity (or fall back to local-only on logout).
          loadSeenState()
        }
      }
    })
  }
}

// Replay (backfill) handler — ordered-insert into the buffer, coalesce
// render across the burst with a microtask debounce. A replay row has no
// `ord` (see ordOf in src/lib/utils.js), so fairMerge/mergeSortedRuns sort
// it on its real `time` — each replay msg lands at its true chronological
// position; we just need ONE final render after the burst settles. Tab
// indicator only updates if user isn't viewing this tab.
const _replayRenderPending = new Set() // tabIds awaiting coalesced render
// Sidecar dedup index. O(1) lookup vs the previous O(n) buf.some() scan over
// up to 1550 entries per replay msg — replay bursts at reconnect can be huge.
const _replayDedupKeys = new Map() // channelId -> Set<dupKey>
// Id sidecar alongside the content keys. commitPacedYtMsg no longer rewrites
// a live msg's `time` (only its display-order `ord`), so the content key a
// later replay computes from the same real timestamp now matches — but the
// id index stays as the faster, exact-match-first check, and as the backstop
// for the id-less-row edge case the content key alone can't cover reliably.
// Platform ids are stable across both sources (the server serves message_id
// since c81d5cd0).
const _replayDedupIds = new Map() // channelId -> Set<platform msg id>
// Cap distinct channels tracked. Both maps are keyed by channelId and rebuild
// lazily from the live buffer on next ingest (see the `if (!dedup)` / `if (!ids)`
// blocks below), so evicting a cold channel's sidecar is loss-free — it just
// re-derives if that channel ever replays again. Without this the two maps grow
// one permanent entry per YouTube channel ever seen in a long multistream session.
const _YT_DEDUP_CHANNEL_CAP = 64
function _trimYtDedup() {
  while (_replayDedupKeys.size > _YT_DEDUP_CHANNEL_CAP) {
    const oldest = _replayDedupKeys.keys().next().value
    _replayDedupKeys.delete(oldest)
    _replayDedupIds.delete(oldest)
  }
  while (_replayDedupIds.size > _YT_DEDUP_CHANNEL_CAP) {
    const oldest = _replayDedupIds.keys().next().value
    _replayDedupIds.delete(oldest)
    _replayDedupKeys.delete(oldest)
  }
}
function _ytDupKey(m) {
  return `${m.user}|${(m.text || '').slice(0, 50)}|${Math.floor((m.time || 0) / 1000)}`
}
function _ytDedupIds(targetChannelId, buf) {
  let ids = _replayDedupIds.get(targetChannelId)
  if (!ids) {
    ids = new Set()
    for (const m of buf) if (m.id) ids.add(String(m.id))
    _replayDedupIds.set(targetChannelId, ids)
    _trimYtDedup()
  }
  return ids
}
function ingestReplayYtMsg(targetChannelId, ytMsg) {
  if (!channelYtMessages.has(targetChannelId)) channelYtMessages.set(targetChannelId, [])
  const buf = channelYtMessages.get(targetChannelId)
  let dedup = _replayDedupKeys.get(targetChannelId)
  if (!dedup) {
    dedup = new Set()
    for (const m of buf) dedup.add(_ytDupKey(m))
    _replayDedupKeys.set(targetChannelId, dedup)
    _trimYtDedup()
  }
  const ids = _ytDedupIds(targetChannelId, buf)
  if (ytMsg.id && ids.has(String(ytMsg.id))) return
  const dupKey = _ytDupKey(ytMsg)
  if (dedup.has(dupKey)) return
  dedup.add(dupKey)
  if (ytMsg.id) ids.add(String(ytMsg.id))
  // ytMsg.ord is unset here — ordOf falls back to ytMsg.time, which IS the
  // real YouTube send timestamp for a replay/backfill row (never rewritten,
  // unlike the live pacer's commit — see commitPacedYtMsg). Ordered insert
  // (not push) because backfill can legitimately land older than the buffer
  // tail (a live msg arrived first, then its own backfill window catches up).
  sortedInsert(buf, ytMsg)
  if (ytMsg.user) {
    try {
      addUsername(ytMsg.user)
    } catch {}
  }
  if (buf.length > MAX_BUFFER + 50) {
    // sortedInsert (here + commitPacedYtMsg, the only two writers of this
    // buffer) keeps it sorted by ord at all times, so a plain front-trim
    // keeps the newest MAX_BUFFER entries — no re-sort needed.
    buf.splice(0, buf.length - MAX_BUFFER)
    // Rebuild dedup sets from surviving entries (splice dropped some).
    dedup.clear()
    ids.clear()
    for (const m of buf) {
      dedup.add(_ytDupKey(m))
      if (m.id) ids.add(String(m.id))
    }
  }
  persistYt(targetChannelId)
  const tabId = targetChannelId === '__live_yt_auto__' ? 'live' : targetChannelId
  if (currentTab !== tabId) {
    updateTabIndicator(tabId)
    return
  }
  // Coalesce many replay msgs into a single renderMessages call per tab.
  if (_replayRenderPending.has(tabId)) return
  _replayRenderPending.add(tabId)
  queueMicrotask(() => {
    _replayRenderPending.delete(tabId)
    if (currentTab === tabId) renderMessages(tabId)
  })
}

// YT special-renderer events (superchat/supersticker/membership/gift purchase)
// → the same inline "stream-event" banner Twitch's raid/hype/sub-gift/redeem
// events use: toggleable via hermesToggles, [Y]-badged, colored left-stripe.
// Rides the existing YT buffer/pacing pipeline (channelYtMessages +
// enqueueYtForPacing/ingestReplayYtMsg) rather than Twitch's irc.channels-based
// dispatch — that's what already merges correctly with paired twitch/kick chat
// on a shared tab, and already persists via persistYt. giftredemption (fires
// once PER recipient — a 20-gift purchase would be 20 banners) and giftheader
// (no event data) are intentionally excluded; they stay on the plain
// system-row path in the youtube_chat_message handler below.
function dispatchYtStreamEvent(targetChannelId, msg) {
  const user = msg.user || ''
  const systemMsg = msg.systemMsg || ''
  let toggleKey = '',
    eventClass = '',
    text = ''

  if (msg.msgType === 'superchat') {
    toggleKey = 'ytSuperchat'
    eventClass = 'event-yt-superchat'
    const comment = (msg.text || '').trim()
    text = `superchat ${msg.amount || ''}`.trim() + (comment ? `: ${comment}` : '')
  } else if (msg.msgType === 'supersticker') {
    toggleKey = 'ytSupersticker'
    eventClass = 'event-yt-supersticker'
    text = `super sticker ${msg.amount || ''}`.trim()
  } else if (msg.msgType === 'membership') {
    if (classifyYtMembership(systemMsg) === 'milestone') {
      toggleKey = 'ytMilestone'
      eventClass = 'event-yt-milestone'
      text = systemMsg || 'membership milestone'
    } else {
      toggleKey = 'ytMembership'
      eventClass = 'event-yt-membership'
      text = 'became a member'
    }
  } else if (msg.msgType === 'giftpurchase') {
    toggleKey = 'ytGiftMemberships'
    eventClass = 'event-yt-gift'
    const count = parseYtGiftCount(systemMsg)
    text = `gifted ${count} membership${count === 1 ? '' : 's'}`
  } else {
    return
  }

  if (!hermesToggles?.[toggleKey]) return
  if (!user || !text) return

  // Dedup — same 60s-window Map shape the Twitch stream-event dispatchers use
  // (keyed by channel+user+text here since YT events have no msg-id to key on).
  if (!window._hsStreamEventDedup) window._hsStreamEventDedup = new Map()
  const dedup = window._hsStreamEventDedup
  const now = Date.now()
  const dedupKey = `${targetChannelId} ${user} ${text}`
  if (dedup.has(dedupKey) && now - dedup.get(dedupKey) < 60000) return
  dedup.set(dedupKey, now)
  if (dedup.size > 500) {
    for (const [k, t] of dedup) {
      if (now - t > 60000) dedup.delete(k)
    }
  }

  const evt = {
    type: 'stream-event',
    eventClass,
    text,
    user,
    actor: user,
    channel: targetChannelId,
    time: msg.time || now,
    platform: 'youtube',
    // feeds sanitizeColor()/COLOR_RE downstream — must stay literal hex, no var()
    color: msg.color || '#ff0000',
    scColor: msg.scColor || undefined,
  }

  if (msg.replay) {
    ingestReplayYtMsg(targetChannelId, evt)
  } else {
    enqueueYtForPacing(targetChannelId, evt)
  }
  pushActivityEvent(evt)

  // Yellow tab highlight, mirroring the Twitch stream-event dispatchers.
  // enqueueYtForPacing/ingestReplayYtMsg already fire the generic 'has-new'
  // dot via updateTabIndicator on a non-active tab; this adds the
  // banner-specific highlight alongside it.
  const tabId = targetChannelId === '__live_yt_auto__' ? 'live' : targetChannelId
  if (currentTab !== tabId) {
    const tab = tabBarElement?.querySelector(`[data-tab="${tabId}"]`)
    if (tab) tab.classList.add('has-stream-event')
  }
}

// Buffer-insert + visible render for ONE paced (live) YT message. Critical:
// stamp ytMsg.ord AT THE MOMENT OF EMIT (not at WS arrival) — WITHOUT
// touching ytMsg.time, which stays YouTube's true send timestamp for the
// whole life of the object (set once from the wire payload). Without a fresh
// ord, every msg in a 5-sec poll batch would share the same real timestamp
// and the chrono sort would lump them adjacent, then the next twitch msg
// slots in below — visible as a YT clump at the bottom of chat.
// With per-emit ord, each YT msg's DISPLAY position naturally interleaves
// with the live twitch arrivals that happen between pacer drains, while
// `time` stays available for anything that needs the real send time
// (dedup, analytics, a future "show real timestamps" toggle).
function commitPacedYtMsg(targetChannelId, ytMsg) {
  // The shared visual clock (visualNowOrd, src/lib/utils.js) — the same one
  // twitch and kick stamp through, so all three platforms now hand out ords
  // from ONE monotonic space instead of YT keeping a private per-channel
  // clock beside them. It carries over what the private clock guaranteed:
  // anchored to Date.now(), and +1 on collision so two msgs draining in the
  // same ms can't share (user, ord, text-prefix), produce identical
  // stableMsgIds, and have the render-diff throw the second display away.
  ytMsg.ord = visualNowOrd()
  if (!channelYtMessages.has(targetChannelId)) channelYtMessages.set(targetChannelId, [])
  const buf = channelYtMessages.get(targetChannelId)
  // Ordered insert on `ord` (the paced-commit clock above), not `time` — see
  // ordOf/sortedInsert in src/lib/utils.js. Practically always the tail
  // (ord is monotonic per channel), but a cross-channel or replay-splice
  // race is still handled correctly instead of silently unsorting the buffer.
  sortedInsert(buf, ytMsg)
  if (ytMsg.user) {
    try {
      addUsername(ytMsg.user)
    } catch {}
  }
  // Keep the replay-dedup indexes aligned with the buffer so a later replay
  // msg doesn't get re-inserted as if the live one were missing. `time` was
  // never rewritten, so the content key a future replay row computes now
  // DOES match this one — the id index below still exists as a backstop.
  const dedup = _replayDedupKeys.get(targetChannelId)
  if (dedup) dedup.add(_ytDupKey(ytMsg))
  const liveIds = _replayDedupIds.get(targetChannelId)
  if (liveIds && ytMsg.id) liveIds.add(String(ytMsg.id))
  if (buf.length > MAX_BUFFER + 50) {
    // sortedInsert keeps the buffer sorted by ord at all times, so a plain
    // front-trim keeps the newest MAX_BUFFER entries — no re-sort needed.
    buf.splice(0, buf.length - MAX_BUFFER)
    if (dedup) {
      dedup.clear()
      for (const m of buf) dedup.add(_ytDupKey(m))
    }
    if (liveIds) {
      liveIds.clear()
      for (const m of buf) if (m.id) liveIds.add(String(m.id))
    }
  }
  persistYt(targetChannelId)
  const tabId = targetChannelId === '__live_yt_auto__' ? 'live' : targetChannelId
  if (currentTab === tabId) {
    if (!appendMessage(ytMsg, tabId)) renderMessages(tabId)
  } else {
    updateTabIndicator(tabId)
  }
}

// Compute the visual delay until the next paced msg should emit. Uses the
// real-time delta between THIS msg and the PREVIOUS emitted msg, so two
// msgs posted 1.8s apart on YouTube show up 1.8s apart in the panel.
// Clamped to [MIN, MAX] so a 30s gap doesn't stall the panel and a same-
// millisecond burst still drips perceptibly.
function paceDelayFor(channelId, nextMsg) {
  const last = _ytPaceLastEmit.get(channelId)
  if (!last?.msgTime || !nextMsg?.time) return YT_PACE_MIN_MS
  const realDelta = nextMsg.time - last.msgTime
  if (realDelta <= 0) return YT_PACE_MIN_MS
  return Math.max(YT_PACE_MIN_MS, Math.min(YT_PACE_MAX_MS, realDelta))
}

// Drain ONE message from the pace queue, schedule next based on the real
// timestamp delta to the message after that.
function drainYtPaceQueue(targetChannelId) {
  _ytPaceTimer.delete(targetChannelId)
  const q = _ytPaceQueue.get(targetChannelId)
  if (!q?.length) return
  const ytMsg = q.shift()
  // ytMsg.time is YouTube's real send timestamp — commitPacedYtMsg no longer
  // rewrites it (only ytMsg.ord, the display-order clock). Used as the
  // msgTime delta basis for the next drain so paceDelayFor sees the real
  // chat cadence between consecutive msgs, not the paced commit-time clock.
  const realPostMs = ytMsg.time
  commitPacedYtMsg(targetChannelId, ytMsg)
  _ytPaceLastEmit.set(targetChannelId, { time: Date.now(), msgTime: realPostMs })
  if (q.length > 0) {
    const due = paceDelayFor(targetChannelId, q[0])
    const handle = cleanup.setTimeout(() => drainYtPaceQueue(targetChannelId), due)
    _ytPaceTimer.set(targetChannelId, handle)
  } else {
    _ytPaceQueue.delete(targetChannelId)
  }
}

// Queue a YT message for paced delivery. Idle channel (queue empty AND
// >MAX_MS since last emit) → commit immediately, no artificial delay on the
// first msg of a quiet stream. Bursts get the real-delta pacing.
// Catastrophic backlogs (>YT_PACE_BURST_MAX projected at MIN cadence) flush
// overflow synchronously so msgs never feel stale.
function enqueueYtForPacing(targetChannelId, ytMsg) {
  const now = Date.now()
  const last = _ytPaceLastEmit.get(targetChannelId)
  const idleSince = last ? now - last.time : Infinity
  const queued = _ytPaceQueue.get(targetChannelId)
  // Idle channel + cooldown elapsed → emit immediately.
  if ((!queued || queued.length === 0) && idleSince >= YT_PACE_MAX_MS) {
    const realPostMs = ytMsg.time
    commitPacedYtMsg(targetChannelId, ytMsg)
    _ytPaceLastEmit.set(targetChannelId, { time: now, msgTime: realPostMs })
    return
  }
  // Queue the msg.
  if (!queued) _ytPaceQueue.set(targetChannelId, [])
  const q = _ytPaceQueue.get(targetChannelId)
  q.push(ytMsg)
  // Synchronously flush overflow if min-cadence projection exceeds burst-max.
  const minProjected = q.length * YT_PACE_MIN_MS
  if (minProjected > YT_PACE_BURST_MAX) {
    const keep = Math.ceil(YT_PACE_BURST_MAX / YT_PACE_MIN_MS)
    while (q.length > keep) commitPacedYtMsg(targetChannelId, q.shift())
  }
  // Schedule drainer if not already scheduled.
  if (!_ytPaceTimer.has(targetChannelId)) {
    const due = Math.max(paceDelayFor(targetChannelId, q[0]) - idleSince, 0)
    const handle = cleanup.setTimeout(() => drainYtPaceQueue(targetChannelId), due)
    _ytPaceTimer.set(targetChannelId, handle)
  }
}

// Listen for social events from background (new messages, notifications)
function listenForSocialEvents() {
  // Guard: only register once (survives SPA reinit via chrome listener persistence)
  if (_onceGuardsSocial.socialListener) return
  _onceGuardsSocial.socialListener = true

  cleanup.addListener(chrome.runtime?.onMessage, (msg) => {
    if (msg.type === 'chat_origin_broadcast' && msg.text) {
      // Heatsync.org chat-tile sent a chat — record the origin so the
      // upcoming platform echo gets tagged [H] via peekSentHost. Same
      // 10s dedup window as locally-tracked sends; chrome.storage sync
      // fans this out to other extension tabs automatically.
      try {
        trackSentMessage(msg.text, 'heatsync')
        // Fold legs that BEAT this broadcast to the tab (kick echo relays
        // through this very extension, so it usually wins the race).
        retroFoldOwnEchoes()
      } catch (_) {}
      return
    }
    if (msg.type === 'seen_update') {
      // Another client (web, other browser, ext on another tab) bumped a
      // tab's seen-at. Apply locally so the red dot clears here too.
      applySeenUpdate(msg.surface, msg.at)
      return
    }
    if (msg.type === 'new-message' && msg.data) {
      // Track home/feed unread regardless of feedLoaded — the user may
      // not have opened the feed tab yet, but we still want a red dot.
      const ts = msg.data.created_at ? new Date(msg.data.created_at).getTime() : Date.now()
      if (!Number.isNaN(ts) && msg.data.username !== 'Anonymous') {
        noteSeenEvent('live', ts)
      }
      if (msg.data.username === 'Anonymous') return
      const id = msg.data.base36_id
      // Already in the feed buffer — the optimistic insert from your own post,
      // or a duplicate delivery. Never re-buffer it.
      const alreadyBuffered = !!(id && feedMessages.some((m) => m.base36_id === id))

      // Buffer maintenance genuinely needs a loaded feed. The CHAT-side row
      // below does not, and gating both on feedLoaded meant a session that
      // never opened the feed tab saw no [OP]/[RE] lines at all — the reason
      // replies never showed up in chat.
      if (feedLoaded && !alreadyBuffered) {
        // Following tab is OPs only — replies still update their thread + the
        // parent's reply_count below, but never get unshifted as a top-level row.
        if (isOpMsg(msg.data)) {
          feedMessages.unshift(msg.data)
          if (feedMessages.length > 150) feedMessages.pop()
        }

        // Real-time thread update: if reply to the active thread, append it
        const replyTo = msg.data.reply_to
        if (replyTo && activeThread && activeThread.id === replyTo) {
          if (!activeThread.replies.some((r) => r.base36_id === id)) {
            activeThread.replies.push(msg.data)
            if (activeThread.op) activeThread.op.reply_count = (activeThread.op.reply_count || 0) + 1
          }
        }
        // Update OP reply count in feed data
        if (replyTo) {
          const parent = feedMessages.find((m) => m.base36_id === replyTo)
          if (parent) parent.reply_count = (parent.reply_count || 0) + 1
        }
      }

      if (currentTab === 'feed') {
        if (feedLoaded && !alreadyBuffered) renderFeed()
      } else {
        updateTabIndicator('feed')
        // Inline notification in chat (routed through toggle system)
        const row = buildFeedInlineNotif(msg.data)
        if (row) injectInlineNotif(row.notifType, row.msg)
      }
    }
    if (msg.type === 'dm_new' && msg.data) {
      // Server-pushed Twitch whispers must route through handleIncomingWhisper
      // so the dedup key (whisper_id) matches the EventSub path. Using
      // handleIncomingDm here would produce a second timeline entry because
      // its dedup checks data.id (hs db row) != eventsub entry's id (whisper_id).
      if (msg.data.platform === 'twitch') {
        handleIncomingWhisper({
          user: msg.data.from_display_name || msg.data.from_twitch_login || 'unknown',
          userId: msg.data.from_twitch_id,
          text: msg.data.content,
          color: msg.data.from_color || '#fff',
          time: msg.data.created_at ? new Date(msg.data.created_at).getTime() : Date.now(),
          id: msg.data.external_message_id || msg.data.id || '',
        })
      } else {
        handleIncomingDm(msg.data)
      }
    }
    if (msg.type === 'message-edited' && msg.data) {
      const d = msg.data.message_id ? msg.data : msg.data.data
      const id = d?.message_id
      if (!id) return
      // Update feedMessages buffer
      const found = feedMessages.find((m) => m.base36_id === id)
      if (found) {
        found.content = d.content
        found.subject = d.subject
        found.edited_at = d.edited_at
        found.edit_count = d.edit_count
      }
      // Update active thread if applicable
      if (activeThread) {
        if (activeThread.op?.base36_id === id) {
          activeThread.op.content = d.content
          activeThread.op.subject = d.subject
          activeThread.op.edited_at = d.edited_at
        }
        const reply = activeThread.replies?.find((r) => r.base36_id === id)
        if (reply) {
          reply.content = d.content
          reply.edited_at = d.edited_at
        }
      }
      if (currentTab === 'feed') renderFeed()
    }
    if (msg.type === 'message-deleted' && msg.data) {
      const d = msg.data.message_id ? msg.data : msg.data.data
      const id = d?.message_id
      if (!id) return
      const idx = feedMessages.findIndex((m) => m.base36_id === id)
      if (idx >= 0) feedMessages.splice(idx, 1)
      if (activeThread) {
        if (activeThread.op?.base36_id === id) {
          activeThread = null
        } else if (activeThread.replies) {
          const ri = activeThread.replies.findIndex((r) => r.base36_id === id)
          if (ri >= 0) activeThread.replies.splice(ri, 1)
        }
      }
      if (currentTab === 'feed') renderFeed()
    }
    if (msg.type === 'youtube_chat_message') {
      let targetChannelId = msg.channelId
      // Same-tab native-tap copies (youtube-content.js broadcasts reach this
      // overlay directly, not just background) stamp channelId with the RAW
      // 11-char videoId — they never went through background's videoId→channel
      // map. Untreated, they land in an orphan buffer nothing renders AND
      // consume an isSentEcho credit meant for the server relay copy (the
      // yt-only own-message swallow). Retarget to the owning config channel —
      // own messages then render instantly and the later server copy dies in
      // isYtDuplicate (same bucket, same innertube id). Unowned videoIds are
      // dropped BEFORE any credit/dedup state is touched.
      if (
        targetChannelId &&
        targetChannelId !== '__live_yt_auto__' &&
        /^[a-zA-Z0-9_-]{11}$/.test(targetChannelId) &&
        !config.channels.some((c) => c.id === targetChannelId)
      ) {
        let mapped = null
        try {
          if (typeof youtubeLinks !== 'undefined') {
            for (const [chId, link] of youtubeLinks) {
              if (link?.videoId === targetChannelId) {
                mapped = chId
                break
              }
            }
          }
        } catch {}
        if (!mapped) {
          const byUrl = config.channels.find(
            (c) => typeof c.youtube === 'string' && c.youtube.includes(targetChannelId),
          )
          if (byUrl) mapped = byUrl.id
        }
        if (!mapped) return
        targetChannelId = mapped
      }
      // Filter __live_yt_auto__ messages: only accept this stream's chat
      // (prevents cross-tab leak — e.g. a stale videoId's chat bleeding in).
      // Derive the allowed videoId straight from the page URL when we're ON a
      // youtube watch/live page — that's authoritative and always available, so
      // the gate no longer depends on a status-echo or a subscribe-time var that
      // can be missed (which left it shut and the 'live' tab empty). Falls back
      // to _autoYtVideoId off-page. The videoId-match still blocks other streams.
      if (targetChannelId === '__live_yt_auto__') {
        const pageVid =
          (location.href.match(/[?&]v=([a-zA-Z0-9_-]{11})/) ||
            location.href.match(/\/live\/([a-zA-Z0-9_-]{11})/))?.[1] || _autoYtVideoId
        if (!pageVid) return // not on a watch page and no confirmed sub — reject
        if (msg.videoId && msg.videoId !== pageVid) return // wrong stream
        if (!_autoYtVideoId) _autoYtVideoId = pageVid // heal for downstream reads
      }
      // Touch the YT watchdog clock AFTER the videoId gate but before dedup —
      // dup msgs still prove the BG-server pipe is alive, but a stale stream's
      // rejected traffic must not keep the watchdog fed (it would mask a new
      // subscription that failed and never let the 180s rescue fire).
      try {
        touchYtChannel(targetChannelId)
      } catch {}
      // Event renderers (superchat/supersticker/membership/gift purchase) skip
      // the normal chat-row path entirely and go out as toggleable stream-event
      // banners instead — see dispatchYtStreamEvent for what's excluded and why.
      if (
        msg.msgType === 'superchat' ||
        msg.msgType === 'supersticker' ||
        msg.msgType === 'membership' ||
        msg.msgType === 'giftpurchase'
      ) {
        dispatchYtStreamEvent(targetChannelId, msg)
        return
      }

      // Dedup against message buffer + pace queue (survives WS reconnects
      // unlike 5s hash; id-exact when the server's innertube id is present)
      if (targetChannelId && isYtDuplicate(msg.user, msg.text, targetChannelId, msg.id)) return

      // Resolve a Twitch-channel name for emote lookup. YT-relayed messages
      // belong to a streamer who likely also has Twitch/Kick channel emotes
      // (BTTV/FFZ/7TV) configured under their Twitch handle. Without this
      // hint, processEmotes only sees globals + the user's heatsync inventory,
      // missing per-channel emotes for the linked streamer.
      let ytChannelHint = null
      // Channel-emote cache key when the display hint can't double as one.
      // A yt-ONLY channel's emotes are broadcast under the CONFIG id —
      // join_channel sends { channel: id } and channel_emotes_update echoes
      // it back as channelOwner — and auto-live is keyed by the BG's
      // yt_ensure_channel_emotes derivation: videoId, else @handle from the
      // page URL (channel /live pages carry no ?v=). Neither is fit to
      // display (raw video/config id), so it rides a separate emoteChannel
      // field; the old twitch||kick||null hint left these messages on the
      // dead 'youtube' key and channel emotes never resolved. Lowercased to
      // match _buildChannelEmoteCache's key normalization.
      let ytEmoteKey = null
      if (targetChannelId && targetChannelId !== '__live_yt_auto__') {
        const linkedCh = config.channels.find((c) => c.id === targetChannelId)
        if (linkedCh) {
          ytChannelHint = linkedCh.twitch || linkedCh.kick || null
          if (!ytChannelHint) ytEmoteKey = String(linkedCh.id).toLowerCase()
        }
      } else if (targetChannelId === '__live_yt_auto__') {
        const vid = msg.videoId || _autoYtVideoId || ''
        const handle = location.href.match(/youtube\.com\/@([\w.-]{3,30})/)?.[1]
        ytEmoteKey = (vid || (handle ? `@${handle}` : '')).toLowerCase() || null
      }

      const ytMsg = {
        // innertube message id when the server relays one — gives yt messages
        // a REAL identity: stableMsgId stops falling back to user:time:text
        // (whose time gets rewritten per pace-commit, defeating render dedup)
        id: msg.id || undefined,
        user: msg.user,
        text: msg.text,
        // feeds sanitizeColor()/COLOR_RE downstream — must stay literal hex, no var()
        color: msg.color || '#ff0000',
        channel: ytChannelHint || 'youtube',
        // Cache key for channel-emote lookup when channel itself isn't one
        // (yt-only config channels + auto-live). Render uses it over channel.
        emoteChannel: ytEmoteKey || undefined,
        time: msg.time,
        platform: 'youtube',
        emotes: msg.emotes || [],
        msgType: msg.msgType || 'text',
        amount: msg.amount || '',
        scColor: msg.scColor || '',
        sticker: msg.sticker || null,
        avatar: msg.avatar || undefined,
        badges: msg.badges || undefined,
        systemMsg: msg.systemMsg || undefined,
        // Namespaced heatsync paint uid from the author's UC… id. Same contract
        // as kick's kickNamePaintUid path: NEVER via queueMcCosmeticsLookup
        // (twitch-space only) — queued directly below.
        hsPaintUid: /^UC[A-Za-z0-9_-]{22}$/.test(msg.authorChannelId || '') ? `yt_${msg.authorChannelId}` : undefined,
        // Server-enriched third-party emote refs — render sender inventory
        // emotes without a per-sender fetch. Server-fed only. See emote-enrich.ts.
        hsEmotes: msg.hsEmotes || undefined,
      }
      if (ytMsg.hsPaintUid && typeof queuePaintLookup === 'function') queuePaintLookup(ytMsg.hsPaintUid)

      // Echo dedup + host-platform badge attribution (matches IRC/kick
      // handlers). Without this, a triple-target send would render TWO
      // copies of the user's own message — the dedup'd twitch/kick echo
      // PLUS the unfiltered YT echo. peekSentHost ensures the badge
      // reflects where the user actually typed FROM.
      if (isSentEcho(ytMsg.text, 'youtube')) return
      // Gated on peekSentHost alone — currentUsername is null on cross-origin
      // tabs (youtube.com/kick.com popout), matching the IRC/kick handlers.
      {
        const sentHost = peekSentHost(ytMsg.text)
        if (sentHost) {
          ytMsg.platform = sentHost === 'yt' ? 'youtube' : sentHost
          // YouTube has no reply threading, so the bar can ONLY come from what
          // we remembered at send time — the @mention prepend is all that ships
          // on the wire. Same ownership proof as twitch/kick.
          if (typeof restoreOwnReplyBar === 'function') restoreOwnReplyBar(ytMsg)
        }
      }

      // Same pipeline as Twitch/Kick handlers: automod + filter rules → mention → stats.
      // The rule VERDICT is kept, not just its .hide: a highlight rule can carry
      // a sound, and folding the call into the if-condition threw that away —
      // so a keyword alert fired on twitch and kick and was silently mute on
      // youtube. Lazy in the same order as the other two handlers (automod is
      // cheap, so it short-circuits before the rule eval).
      const _frOwnYt = ytMsg.user?.toLowerCase() === currentUsername?.toLowerCase()
      let _frYt = null
      if (!_frOwnYt) {
        if (shouldAutomod(ytMsg.text)) return
        _frYt = evaluateFilterRules(ytMsg, targetChannelId !== '__live_yt_auto__' ? targetChannelId : null)
        if (_frYt.hide) return
      }
      // Highlight-rule audio cue — once, on live youtube arrival.
      if (_frYt?.sound && typeof playFilterRuleSound === 'function') playFilterRuleSound(_frYt.sound)
      const isMent = isMention(ytMsg)
      bumpStreamStats(ytChannelHint || ytEmoteKey, ytMsg, isMent)
      if (isMent) {
        mentionsBuffer.push(ytMsg)
        if (mentionsBuffer.length > MAX_BUFFER + 50) mentionsBuffer.splice(0, mentionsBuffer.length - MAX_BUFFER)
        persistMentions()
        notifyMention(ytMsg)
        noteSeenEvent('mentions', ytMsg.time || Date.now())
        if (currentTab === 'mentions') {
          bumpSeen('mentions')
          if (!appendMessage(ytMsg, 'mentions')) renderMessages('mentions')
        } else {
          updateTabIndicator('mentions')
        }
      }

      if (targetChannelId && targetChannelId !== 'global') {
        // Instant-live signal for YT-only tabs (no Twitch handle = no helix
        // truth available, so first chat msg is our best signal). Tabs with
        // a Twitch or Kick handle defer to the live-status poll — otherwise
        // a YT replay/buffered msg would override the offline-Twitch truth.
        if (targetChannelId !== '__live_yt_auto__') {
          try {
            const ch = config.channels.find((c) => c.id === targetChannelId)
            const isYtOnly = ch && !ch.twitch && !ch.kick && ch.youtube
            if (isYtOnly) {
              const tabEl = document.querySelector(
                `#hs-mc-tabbar .hs-mc-tab[data-tab="${CSS.escape(targetChannelId)}"]`,
              )
              if (tabEl && tabEl.dataset.live !== 'true') tabEl.dataset.live = 'true'
            }
          } catch {}
        }
        // Backfill replay: bypass per-channel pacing entirely. Each msg has
        // its real YT timestamp, so fairMerge places it at the correct
        // chronological position scattered through the existing twitch/kick
        // history — no "all at once" flash because they're not appearing
        // at the bottom; they slot in at their real-time positions. Pacing
        // here would just delay the correct render.
        if (msg.replay) {
          ingestReplayYtMsg(targetChannelId, ytMsg)
        } else {
          enqueueYtForPacing(targetChannelId, ytMsg)
        }
      } else if (targetChannelId === 'global') {
        // Surface unresolved-routing drops so future regressions don't go silent.
        // Real cause is on background side: videoId→channelId map missed an entry.
        console.warn('[heatsync-ext] yt msg dropped — channelId=global, videoId=', msg.videoId, 'user=', msg.user)
      }
    }
    if (msg.type === 'youtube_msg_deleted') {
      // Mark all rendered messages from this user (for the matching channel)
      // as cleared so they get the dim+strikethrough treatment that Twitch/Kick
      // moderator deletions already get.
      const u = (msg.user || '').toLowerCase()
      if (!u) return
      const msgsEl = document.getElementById('hs-mc-messages')
      if (msgsEl) {
        api.storage.local
          .get(['hs_dim_timeouts'])
          .then((stored) => {
            const dim = stored.hs_dim_timeouts !== undefined ? stored.hs_dim_timeouts : true
            if (!dim) return
            // data-platform lives on the inner .hs-mc-user anchor, not the outer
            // .hs-mc-msg div (YouTube is excluded from data-msg-platform), so
            // query the anchor and walk up — mirrors main.js's YT user lookup.
            msgsEl
              .querySelectorAll(
                '.hs-mc-msg .hs-mc-user:not(.hs-mc-mention)[data-platform="yt"], .hs-mc-msg .hs-mc-user:not(.hs-mc-mention)[data-platform="youtube"]',
              )
              .forEach((a) => {
                if (a.dataset.username === u) a.closest('.hs-mc-msg')?.classList.add('hs-mc-msg-cleared')
              })
          })
          .catch(() => {})
      }
      // Also flag in buffers so re-renders preserve the dim state
      const flagBuf = (buf) => {
        if (!Array.isArray(buf)) return
        for (let i = buf.length - 1; i >= 0; i--) {
          const m = buf[i]
          if (m.platform === 'youtube' && m.user?.toLowerCase() === u) {
            m.cleared = true
            m._renderedHtml = null // force re-render with cleared class next time
          }
        }
      }
      channelYtMessages.forEach((buf) => {
        flagBuf(buf)
      })
      flagBuf(mentionsBuffer)
    }
    if (msg.type === 'youtube_status') {
      const targetChannelId = msg.channelId
      // Connected status touches the watchdog — server confirmed our sub,
      // so the channel is healthy even if no chat messages arrive yet.
      if (msg.status === 'connected') {
        try {
          touchYtChannel(targetChannelId)
        } catch {}
      }
      // Stream genuinely ended → disarm the YT watchdog for this channel.
      // The watchdog never gives up on its own (after a force-reconnect it
      // resets attempts and loops forever), so without this an ended stream
      // re-subscribes every ~3min and periodically force-reconnects the shared
      // BG WS that every channel rides — the "everything dropped, refresh fixed
      // it" symptom (Bug #2). A transient 'error' may still recover, so only a
      // terminal 'ended' disarms; the next 'connected' re-arms via touchYtChannel.
      // Mirrors the removeChannel watchdog cleanup.
      if (msg.status === 'ended' && targetChannelId && targetChannelId !== 'global') {
        try {
          ytChanLastSeen.delete(targetChannelId)
          ytChanRejoinAttempts.delete(targetChannelId)
          ytSubscribedUrls.delete(targetChannelId)
        } catch {}
      }
      // Track auto-YouTube videoId for cross-tab filtering
      if (targetChannelId === '__live_yt_auto__' && msg.status === 'connected' && msg.videoId) {
        _autoYtVideoId = msg.videoId
        log('Auto YouTube videoId:', msg.videoId)
      }
      if (targetChannelId && targetChannelId !== 'global') {
        // Per-channel YouTube status
        const link = youtubeLinks.get(targetChannelId) || { url: '', videoId: '', channelName: '' }
        if (msg.status === 'connected') {
          link.videoId = msg.videoId || ''
          link.channelName = msg.channelName || ''
          youtubeLinks.set(targetChannelId, link)
          log('YouTube connected for channel', targetChannelId, ':', link.channelName)
          // Retro-label the live composer: it booted with the raw videoId as
          // its only identity ("send to #<videoId>") — now that the server
          // resolved the channel name, repaint the placeholder with it.
          if (targetChannelId === '__live_yt_auto__') {
            // Now that the channel name resolved, relabel the live tab from the
            // generic "live" to the real channel — so the auto-live tab reads as
            // a selection ("lofigirl"), not a blank tab with chat pouring in.
            // Runs regardless of the active tab (the label is always visible).
            if (typeof updateLiveTabLabel === 'function') {
              try {
                updateLiveTabLabel()
              } catch {}
            }
            if (currentTab === 'live') {
              try {
                updateInputPlaceholder()
              } catch {}
            }
          }
        }
        // Reflect status onto the channel tab button so YT-only channels get a
        // live dot and a human-readable label (otherwise YT-only tabs sit dark
        // forever and show the auto-generated yt-<timestamp> id). Twitch/Kick-
        // having tabs defer to the live-status poll for the dot — letting YT
        // override would falsely show a Twitch streamer as live just because
        // their YT mirror is live (or replaying buffered chat).
        if (targetChannelId !== '__live_yt_auto__') {
          const tabEl = document.querySelector(`#hs-mc-tabbar .hs-mc-tab[data-tab="${CSS.escape(targetChannelId)}"]`)
          if (tabEl) {
            const ch = config.channels.find((c) => c.id === targetChannelId)
            const isYtOnly = ch && !ch.twitch && !ch.kick && ch.youtube
            if (msg.status === 'connected') {
              if (isYtOnly) {
                tabEl.dataset.live = 'true'
                if (link.channelName && tabEl.textContent !== link.channelName) {
                  tabEl.textContent = link.channelName
                }
              }
            } else if (msg.status === 'ended' || msg.status === 'error') {
              if (isYtOnly) tabEl.dataset.live = 'false'
            }
          }
        }
        // Show status in channel tab if viewing it. Dedup on a stable marker so
        // repeated youtube_status events (every WS reconnect, every retry) don't
        // append a fresh notice each time — that's what made the panel flicker:
        // notice appears, real messages push it out via trimChildren cap, next
        // event re-appends, cycle repeats.
        // Show the connect/end notice on the right tab — both per-channel
        // tabs AND the live tab (when this is the auto subscription).
        const isAutoForLive = targetChannelId === '__live_yt_auto__' && currentTab === 'live'
        if (currentTab === targetChannelId || isAutoForLive) {
          const msgsEl = document.getElementById('hs-mc-messages')
          const upsertNotice = (text, color) => {
            if (!msgsEl) return
            // Remove any existing yt-status notice — there should be at most one,
            // showing the latest state.
            for (const el of msgsEl.querySelectorAll('.hs-mc-empty[data-hs-yt-status]')) el.remove()
            const el = document.createElement('div')
            el.className = 'hs-mc-empty'
            el.dataset.hsYtStatus = '1'
            // Tag with the tab id this notice belongs to so renderMessages can
            // drop it on tab switch (otherwise the YT-offline notice from one
            // channel follows the user to other tabs and looks like a bug:
            // "stream is live, why does it say not live?").
            el.dataset.hsYtStatusTab = String(targetChannelId)
            el.textContent = text
            if (color) el.style.color = color
            msgsEl.appendChild(el)
            trimChildren(msgsEl, 150)
          }
          if (msg.status === 'connected' || msg.status === 'ended') {
            // Live or ended → drop any stale yt-status notice. No "stream
            // ended" pin: it's not actionable (the stream's just over) and it
            // never auto-cleared (the clearing 'connected' event never arrives
            // for an ended stream), so it lingered until trimmed by volume or a
            // tab switch — read as a bug. The live-dot going dark already
            // signals the stream ended; error notices below stay (actionable).
            if (msgsEl) {
              for (const el of msgsEl.querySelectorAll('.hs-mc-empty[data-hs-yt-status]')) el.remove()
            }
          } else if (msg.status === 'error') {
            // Drop noise: rate-limit, "not currently live / chat disabled",
            // AND "could not resolve youtube url" (the expected outcome when
            // a tab's YT URL is auto-guessed from the twitch handle but the
            // streamer doesn't have a matching YT — actionable to nobody).
            const errText = msg.error || ''
            const isNoise =
              /too many requests/i.test(errText) ||
              /not currently live/i.test(errText) ||
              /chat is disabled/i.test(errText) ||
              /could not resolve youtube url/i.test(errText) ||
              /invalid url/i.test(errText)
            if (!isNoise) {
              // Always prefix with "youtube:" — without it, error text looks
              // like it's about whatever stream the user is watching, not
              // the YouTube subscription that actually failed.
              upsertNotice(`youtube: ${errText || 'connection error'}`, 'var(--hs-danger)')
            }
          }
        }
      }
    }
    if (msg.type === 'message-updated' && msg.data) {
      const uid = msg.data.base36_id
      const idx = feedMessages.findIndex((m) => m.base36_id === uid)
      if (idx >= 0) Object.assign(feedMessages[idx], msg.data)
      if (activeThread?.op && activeThread.op.base36_id === uid) {
        Object.assign(activeThread.op, msg.data)
      }
    }
  })
}

// ---- FEED ----

// A feed row is an OP (original post / "tweet") when it isn't a reply. The
// following tab shows OPs only — replies live inside their thread, opened via
// >>id, never as top-level rows. Mirrors buildFeedMessageDiv's isOp test.
function isOpMsg(m) {
  return m.is_op != null ? !!m.is_op : !m.reply_to || m.reply_to === ''
}

// The last feed OP surfaced as an inline row in chat — what /opr replies to.
// Set from ONE place (buildFeedInlineNotif) so anything that can put an [OP]
// in front of you is automatically a valid reply target, including your own.
let lastInlineFeedOpId = null

// base36_id -> when we last built an inline row for it. Your own post reaches
// this twice — once as the local echo the instant it posts, once when the
// websocket broadcasts it back — and replies aren't covered by the
// feedMessages buffer dedup (only OPs get unshifted), so without this a reply
// you sent would render as two identical [RE] rows.
const _inlineFeedRowSeen = new Map()
const INLINE_ROW_DEDUP_MS = 120_000

/**
 * Map a feed row (websocket payload or a just-posted response) onto the
 * inline `feed-post` chat row. Both callers used to build this object
 * separately; they must stay identical or your own post renders differently
 * from everyone else's.
 *
 * @param {object} f feed message row
 * @returns {{notifType: string, msg: object}|null} null when the row carries
 *   no usable timestamp (the renderer needs one for its ts column)
 */
function buildFeedInlineNotif(f) {
  if (!f) return null
  const t = new Date(f.created_at).getTime()
  if (Number.isNaN(t)) return null
  const notifType = f.is_thread_op ? 'mop' : isOpMsg(f) ? 'op' : 're'
  if ((notifType === 'op' || notifType === 'mop') && f.base36_id) {
    lastInlineFeedOpId = f.base36_id
  }
  const now = Date.now()
  if (f.base36_id) {
    const seenAt = _inlineFeedRowSeen.get(f.base36_id)
    if (seenAt && now - seenAt < INLINE_ROW_DEDUP_MS) return null
    _inlineFeedRowSeen.set(f.base36_id, now)
    // Bounded: drop the oldest half once it grows, rather than sweeping the
    // whole map on every post.
    if (_inlineFeedRowSeen.size > 400) {
      for (const k of [..._inlineFeedRowSeen.keys()].slice(0, 200)) _inlineFeedRowSeen.delete(k)
    }
  }
  return {
    notifType,
    msg: {
      type: 'feed-post',
      base36_id: f.base36_id,
      feedUser: f.username || f.display_name || 'anon',
      text: f.content || '',
      color: f.user_color || '#fff',
      time: t,
      heat: f.heat || 0,
      reply_to: f.reply_to,
      emote_refs: f.emote_refs,
      is_op: f.is_op,
      is_thread_op: f.is_thread_op,
    },
  }
}

async function fetchFeed(append = false) {
  if (feedLoading) return
  feedLoading = true
  const page = append ? feedPage + 1 : 1
  // Snapshot ids before the await so we can keep posts that arrive via the WS
  // new-message handler (which unshifts onto feedMessages) while this fetch is
  // in flight — otherwise the full replace below silently drops them. Only on a
  // refresh (feedLoaded already true); first load can't race (handler bails
  // when !feedLoaded), and append doesn't replace.
  const preIds = feedLoaded && !append ? new Set(feedMessages.map((m) => m.base36_id)) : null
  const resp = await apiFetch(`/api/messages?sort=time&limit=30&page=${page}&following=true`, { auth: true })
  feedLoading = false
  if (!resp.ok) {
    // 429 means the user has multichat open in many tabs hitting /api/messages
    // simultaneously — expected, not a bug, don't spam the error log. log via
    // debug instead. true server errors (5xx, 401) still console.error.
    if (resp.status === 429) {
      log('feed fetch 429 — rate-limited, will retry on next stale check')
    } else {
      console.error('[heatsync-mc] Feed fetch failed — full resp:', JSON.stringify(resp))
    }
    if (currentTab === 'feed') {
      const msgsEl = document.getElementById('hs-mc-messages')
      if (msgsEl && feedMessages.length === 0) {
        msgsEl.innerHTML = `<div class="hs-mc-empty">${resp.status === 401 ? t('mc_social_failed_feed_auth') : t('mc_social_failed_feed')}</div>`
      }
    }
    return
  }
  let msgs = (resp.data?.messages || []).filter((m) => m.username !== 'Anonymous' && isOpMsg(m))
  let usedHotFallback = false
  let hotWasCold = false

  // Following empty → fallback to /api/messages/hot (heat-sorted, last 30d) so
  // the tab shows SOMETHING discoverable instead of an empty wall. Only on the
  // initial page (append=false) — paginating shouldn't trigger fallback.
  //
  // NO auth gate. There used to be one (`&& hsAuthToken`), on the reasoning that
  // a logged-out user gets the empty card's login CTA instead. That was sound
  // while it lasted: /api/messages/hot itself returned [] for weeks, so the gate
  // was choosing between a login card and a blank wall, and the card won. It now
  // serves 30 real rows anonymously (fixed 2026-08-16, server-side), so the
  // choice is between a login card and actual content, and the card loses.
  //
  // A logged-out session is EVERY brand-new install — someone who just did the
  // hard part and installed a browser extension. Demanding OAuth before showing
  // them a single post is the highest-friction possible first screen, and it is
  // the opposite of what every other heatsync surface promises ("no account
  // needed" — see server/lib/ssr-theme.ts archiveCta). The ask isn't lost: the
  // fallback banner below carries the login nudge for logged-out sessions, so
  // they get the proof AND the CTA instead of the CTA alone.
  //
  // Anon rows are safe to show here — the server scrubs them (lib/scrub-identity,
  // verified by ~/scripts/hs-anon-probe.py).
  if (!append && msgs.length === 0) {
    try {
      const hotResp = await apiFetch('/api/messages/hot?limit=30&hours=720', { auth: true })
      if (hotResp.ok) {
        // No anon filter here, deliberately: this path runs only when the follows feed
        // came back empty, i.e. on every new install, and its whole job is to avoid a
        // blank wall. Dropping anon posts threw away ~a sixth of everything available.
        // The server serves anon rows fully scrubbed (lib/scrub-identity) — verified by
        // ~/scripts/hs-anon-probe.py — so there is nothing to hide from here.
        const hotMsgs = (hotResp.data?.messages || []).filter((m) => isOpMsg(m))
        if (hotMsgs.length > 0) {
          msgs = hotMsgs.map((m) => Object.assign({}, m, { _fromHotFallback: true }))
          usedHotFallback = true
          hotWasCold = hotResp.data?.fallback === true
        }
      }
    } catch (_) {}
  }

  if (append) {
    feedMessages.push(...msgs)
    feedPage = page
  } else {
    if (preIds) {
      // Posts unshifted during the await that aren't in the server snapshot —
      // keep them newest-first on top so a live post isn't lost to the replace.
      const seen = new Set(msgs.map((m) => m.base36_id))
      const liveDelta = feedMessages.filter((m) => !preIds.has(m.base36_id) && !seen.has(m.base36_id))
      feedMessages = liveDelta.length ? [...liveDelta, ...msgs] : msgs
    } else {
      feedMessages = msgs
    }
    feedPage = 1
    feedFromHotFallback = usedHotFallback
    feedFallbackIsCold = hotWasCold
  }
  // Clamp after bulk load — push-path uses .pop() cap but server can return >150 in one fetch.
  if (feedMessages.length > 150) feedMessages.length = 150
  // Hot fallback returns sorted-by-heat from past 30d — never paginate that;
  // would conflict with the heat ranking on subsequent pages.
  feedHasMore = usedHotFallback ? false : (resp.data?.pagination?.hasMore ?? msgs.length >= 30)
  feedLoaded = true
  feedLastFetch = Date.now()
  // Seed latestAt.live from the newest post we just got. Without this, the
  // unread dot is event-driven only (WS new-message), so a user opening the
  // ext after sleep sees 12 unread feed posts but no red dot until the 13th
  // event arrives. Bumping latestAt here makes hasUnseen('live') agree with
  // the actual server backlog.
  if (!append && msgs.length > 0 && typeof noteSeenEvent === 'function') {
    const newestTs = msgs.reduce((mx, m) => {
      const ts = m.created_at ? new Date(m.created_at).getTime() : 0
      return ts > mx ? ts : mx
    }, 0)
    if (newestTs > 0) noteSeenEvent('live', newestTs)
  }
  if (currentTab === 'feed') renderFeed()
}

// Onboarding card shown when feed has no posts. Replaces the bare
// "no posts yet" sentinel that produced an immediate uninstall cliff.
// Variants: anonymous (login CTA) vs authed (import-twitch + discover + post).
function _renderFeedEmptyCard() {
  const card = document.createElement('div')
  card.className = 'hs-mc-empty-card'

  const title = document.createElement('div')
  title.className = 'hs-mc-empty-title'
  const sub = document.createElement('div')
  sub.className = 'hs-mc-empty-sub'
  const actions = document.createElement('div')
  actions.className = 'hs-mc-empty-actions'

  if (!hsAuthToken) {
    title.textContent = 'log in to see your home'
    sub.textContent = 'follow people, post, share — alongside multichat'

    const loginBtn = document.createElement('a')
    loginBtn.className = 'hs-mc-empty-btn primary'
    loginBtn.textContent = 'log in at heatsync.org'
    loginBtn.href = 'https://heatsync.org/login'
    loginBtn.target = '_blank'
    loginBtn.rel = 'noopener noreferrer'
    actions.appendChild(loginBtn)

    const note = document.createElement('div')
    note.className = 'hs-mc-empty-note'
    note.textContent = 'no account needed for multichat — pick a channel tab above'

    card.appendChild(title)
    card.appendChild(sub)
    card.appendChild(actions)
    card.appendChild(note)
    return card
  }

  title.textContent = 'no posts'
  sub.textContent = 'follow people or post something to populate this tab'

  const importBtn = document.createElement('button')
  importBtn.className = 'hs-mc-empty-btn primary'
  importBtn.textContent = 'import follows from twitch'
  importBtn.addEventListener('click', async () => {
    if (importBtn.disabled) return
    importBtn.disabled = true
    importBtn.textContent = 'syncing…'
    try {
      const r = await apiFetch('/api/sync-twitch-follows', { method: 'POST', auth: true })
      if (r?.ok && r?.data?.success) {
        importBtn.textContent = `synced ${r.data.synced || 0} ✓`
        try {
          chrome.runtime.sendMessage({ type: 'refresh_followed_users' })
        } catch {}
        cleanup.setTimeout(() => {
          feedLoaded = false
          if (currentTab === 'feed') renderFeed()
        }, 1200)
      } else {
        importBtn.disabled = false
        importBtn.textContent = (r?.error || r?.data?.error || 'try again').slice(0, 40)
      }
    } catch (_) {
      importBtn.disabled = false
      importBtn.textContent = 'try again'
    }
  })
  actions.appendChild(importBtn)

  const discoverBtn = document.createElement('button')
  discoverBtn.className = 'hs-mc-empty-btn'
  discoverBtn.textContent = 'discover people →'
  discoverBtn.addEventListener('click', () => {
    if (typeof switchTab === 'function') switchTab('discover')
  })
  actions.appendChild(discoverBtn)

  const postBtn = document.createElement('button')
  postBtn.className = 'hs-mc-empty-btn'
  postBtn.textContent = 'post something'
  postBtn.addEventListener('click', () => {
    if (typeof showInputBar === 'function') showInputBar()
    const inp = document.getElementById('hs-mc-input')
    if (inp) inp.focus()
  })
  actions.appendChild(postBtn)

  card.appendChild(title)
  card.appendChild(sub)
  card.appendChild(actions)
  return card
}

// Tear down virtual scroll state (called before re-setup or when leaving feed)
function _feedVirtualTeardown(msgsEl) {
  if (_feedVirtualScrollHandler && msgsEl) {
    msgsEl.removeEventListener('scroll', _feedVirtualScrollHandler)
  }
  _feedVirtualScrollHandler = null
}

function renderFeed() {
  if (typeof activeProfileCard !== 'undefined' && activeProfileCard) return
  const msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl) return

  // Wire post-link hover preview once (event delegation — survives re-renders).
  // Must run before the thread-view early-return below: >>id links live IN the
  // thread view, so wiring only on the feed-list path missed them entirely.
  if (typeof setupFeedPostLinkHover === 'function') setupFeedPostLinkHover()

  // Update feed tab button text
  const feedTabBtn = tabBarElement?.querySelector('[data-tab="feed"]')
  if (feedTabBtn) feedTabBtn.textContent = activeThread ? t('mc_social_back') : t('mc_tab_feed')

  // Thread view — show OP + replies, tear down virtual scroll
  if (activeThread) {
    _feedVirtualTeardown(msgsEl)
    renderThreadView(msgsEl)
    return
  }

  // Feed list view
  const isStale = feedLoaded && Date.now() - feedLastFetch > FEED_STALE_MS
  if ((!feedLoaded || isStale) && !feedLoading) {
    _feedVirtualTeardown(msgsEl)
    msgsEl.textContent = ''
    const loading = document.createElement('div')
    loading.className = 'hs-mc-empty'
    loading.textContent = t('mc_social_loading_feed')
    msgsEl.appendChild(loading)
    fetchFeed()
    return
  }

  if (feedMessages.length === 0) {
    _feedVirtualTeardown(msgsEl)
    msgsEl.textContent = ''
    msgsEl.appendChild(_renderFeedEmptyCard())
    return
  }

  // Render all feed posts in natural document flow. Virtualization removed —
  // posts have wildly mixed heights (32px text vs 327px media embeds) and a
  // uniform-height virtual scroller produced massive overlap. If post counts
  // grow large enough to hurt scroll perf, re-add virtualization with proper
  // per-item height measurement (cumulative offsets, not i*h).
  _feedVirtualTeardown(msgsEl)

  const items = feedMessages
  isProgrammaticScroll = true
  msgsEl.textContent = ''
  msgsEl.style.position = ''

  const frag = document.createDocumentFragment()
  // Hot-fallback banner — set when following=true returned 0 and we filled the
  // tab with /api/messages/hot. Says "no follows yet" + invites action. Pure
  // DOM construction (no innerHTML) — both strings are static, the hook flags
  // any innerHTML anyway.
  if (feedFromHotFallback) {
    const banner = document.createElement('div')
    banner.className = 'hs-mc-feed-fallback-banner'
    // 13px + integer line-height: Cozette is bitmap-native at 13px — 12px
    // rescales the glyphs (blurry), and 1.5 leading lands rows off the pixel
    // grid. No faux-bold either (synthetic bold double-strikes bitmap glyphs);
    // the #fff vs #bbb contrast carries the hierarchy.
    banner.style.cssText =
      'padding:8px 10px;background:#1a1408;border-left:2px solid #808080;color:#e6e6e6;font-size:13px;margin-bottom:4px;line-height:18px'
    const head = document.createElement('div')
    head.style.cssText = 'color:#fff;margin-bottom:2px'
    // Logged out, "no posts from your follows" is nonsense — there is no account
    // to have follows on. This banner is also where the login ask lives for that
    // session now that the fallback runs without auth and the empty card (which
    // used to carry the CTA) no longer renders once there are rows.
    head.textContent = hsAuthToken ? 'no posts from your follows' : 'what is hot on heatsync'
    const sub = document.createElement('div')
    sub.style.cssText = 'color:#bbb'
    sub.textContent = !hsAuthToken
      ? 'log in at heatsync.org to follow people and fill this with their posts'
      : feedFallbackIsCold
        ? 'showing the newest posts — follow people to fill this with their posts'
        : 'showing what is hot from the past 30 days — follow people to fill this with their posts'
    banner.appendChild(head)
    banner.appendChild(sub)
    frag.appendChild(banner)
  }
  let zebraCount = 0
  for (let i = 0; i < items.length; i++) {
    const div = buildFeedMessageDiv(items[i])
    if (zebraEnabled && ++zebraCount % 2 === 0) div.classList.add('hs-mc-zebra')
    frag.appendChild(div)
  }
  msgsEl.appendChild(frag)

  if (feedHasMore) {
    const loader = document.createElement('div')
    loader.className = 'hs-mc-empty hs-feed-loader'
    loader.textContent = t('mc_social_scroll_more')
    msgsEl.appendChild(loader)
  }

  msgsEl.scrollTop = 0
  requestAnimationFrame(() => {
    isProgrammaticScroll = false
  })

  // Reddit (and any future server-resolved embeds): replace pending placeholders
  // with rich cards via heatsync.org/api/embed/resolve. Mirrors website.
  if (typeof resolvePendingFeedEmbeds === 'function') resolvePendingFeedEmbeds(msgsEl)

  // Infinite scroll: trigger fetch near bottom
  let _feedInfiniteTimer = null
  _feedVirtualScrollHandler = () => {
    if (mcSignal?.aborted) return
    if (currentTab !== 'feed' || feedLoading || !feedHasMore) return
    if (_feedInfiniteTimer) return
    _feedInfiniteTimer = cleanup.setTimeout(() => {
      _feedInfiniteTimer = null
      const { scrollTop, scrollHeight, clientHeight } = msgsEl
      if (scrollHeight - scrollTop - clientHeight < 100) fetchFeed(true)
    }, 200)
  }
  msgsEl.addEventListener('scroll', _feedVirtualScrollHandler, { signal: mcSignal, passive: true })
}

function buildFeedMessageDiv(m, opUsername) {
  const div = document.createElement('div')
  div.className = 'hs-feed-msg'
  // Feed posts never ran mention detection — a post saying your name showed
  // as a plain row while the same text in chat went mention-red. Same
  // isMention pipeline (aliases incl. heatsync name, blocked-sender gate).
  try {
    if (
      typeof isMention === 'function' &&
      !isOwnFeedPost(m) &&
      isMention({ user: m.username || '', text: String(m.content || ''), platform: 'heatsync' })
    )
      div.classList.add('mention')
  } catch (_) {}
  div.dataset.msgId = m.base36_id

  const time = formatRelativeTime(m.created_at)
  const rawAvatar = m.profile_image_url || m.twitch_profile_pic || m.kick_profile_pic || ''
  const avatarUrl = safeUrl(rawAvatar)
  // Number() coercion is the guard: a non-numeric server value (e.g. a string)
  // would slip past getHeatDisplay's NaN comparisons and reach innerHTML
  // verbatim via formatHeat. Mirrors heatSpanHtml/heatSpanEl.
  const heat = Number(m.heat) || 0
  const replies = m.reply_count || 0
  // renderFeedContent sanitizes via escapeHtml + emote ref escaping
  const content = renderFeedContent(m.content, m.emote_refs)

  // Thread link: >>id — always expands thread inline (never navigates away)
  const shortId = (m.base36_id || '').replace(/^0+/, '') || '0'
  const inThread = !!opUsername
  const linkId = escapeHtml(m.base36_id || '')
  const threadLink = inThread
    ? `<span class="hs-feed-thread-link hs-quote-insert" data-quote-id="${escapeHtml(shortId)}" data-id="${linkId}" style="color:var(--hs-mention);cursor:pointer">${escapeHtml(shortId)}</span>`
    : `<span class="hs-feed-thread-link hs-thread-toggle" data-id="${linkId}" style="cursor:pointer">&gt;&gt;${escapeHtml(shortId)}</span>`

  // Post type tag: [OP] red = original post, [OP] magenta = OP replying in own thread, [RE] = reply
  const isOp = m.is_op != null ? !!m.is_op : !m.reply_to || m.reply_to === ''
  const isThreadOp =
    m.is_thread_op != null
      ? !!m.is_thread_op
      : opUsername && m.reply_to && m.username?.toLowerCase() === opUsername.toLowerCase()
  const typeTag = isThreadOp
    ? '<span class="hs-feed-tag hs-feed-tag-mop">[OP]</span>'
    : isOp
      ? '<span class="hs-feed-tag hs-feed-tag-op">[OP]</span>'
      : '<span class="hs-feed-tag hs-feed-tag-re">[RE]</span>'

  // Anonymity is "no user", not "no platform" — native heatsync posts have a
  // user_id but no platform (only twitch/kick/youtube-origin posts carry one).
  // Gating on platform wrongly anonymized native posts. Mirrors heatsync.org's
  // message-element renderer (`!user_id || display_name === 'Anonymous'`).
  const isAnon = !m.user_id || m.username === 'Anonymous'

  // Platform badge: [T]/[K]/[Y] (hidden for anonymous)
  const platLabel =
    m.platform === 'kick' ? '[K]' : m.platform === 'youtube' ? '[Y]' : m.platform === 'twitch' ? '[T]' : ''
  const platBadge = platLabel
    ? `<span class="hs-feed-tag" style="color:${HS_PLAT_COLORS[m.platform]}">${platLabel}</span>`
    : ''

  const timeHtml = window._hsTimestampsEnabled !== false ? `<span class="hs-feed-time">${escapeHtml(time)}</span>` : ''

  // All dynamic values sanitized: avatarUrl via encodeURIComponent,
  // username/time via escapeHtml, color via sanitizeColor, content via renderFeedContent
  const hd = getHeatDisplay(heat)
  if (hd) {
    let rowStyle = `border-left:${hd.borderWidth}px solid ${hd.border};`
    if (hd.bg) rowStyle += `background:${hd.bg};`
    if (hd.breathe) div.className += ' hs-feed-heat-breathe'
    div.setAttribute('style', rowStyle)
  }
  const isReply = !!m.reply_to
  const heatStyle = hd ? getHeatNumberStyle(heat, isReply) : ''
  const heatDeg = hd?.suffix ? '<span class="hs-heat-deg">°</span>' : ''
  const heatSpan = hd
    ? `<span class="hs-feed-stat hs-feed-heat" style="${heatStyle}"><span class="hs-heat-n">${formatHeat(heat)}</span>${heatDeg}</span>`
    : ''
  const repliesSpan =
    replies > 0 ? `<span class="hs-feed-stat hs-feed-replies" title="replies">💬${replies}</span>` : ''
  const stats = [heatSpan, repliesSpan].filter(Boolean).join(' ')
  const statsHtml = stats ? ` ${stats}` : ''

  const anonAvatar = avatarsEnabled
    ? `<img class="hs-feed-avatar" src="https://heatsync.org/anon.webp" alt="" loading="lazy">`
    : ''
  const userAvatar = avatarsEnabled
    ? avatarUrl
      ? `<img class="hs-feed-avatar" src="${escapeHtml(avatarUrl)}" alt="" loading="lazy" data-fallback-anon="1">`
      : anonAvatar
    : ''
  const tripcodeHtml = m.tripcode ? `<span class="hs-tripcode">${escapeHtml(m.tripcode)}</span>` : ''
  const userHtml = isAnon
    ? `${anonAvatar}<span class="hs-feed-user" style="color:#808080">Anonymous</span>${tripcodeHtml}`
    : `${userAvatar}<a href="https://heatsync.org/user/${encodeURIComponent(m.username)}" target="_blank" rel="noopener noreferrer" class="hs-feed-user hs-mc-user" data-username="${escapeHtml((m.username || 'anon').toLowerCase())}" style="color:${sanitizeColor(m.user_color || '#fff')}">${escapeHtml(m.username || 'anon')}</a>${tripcodeHtml}`

  // Media/embeds (img, video, iframe) — values inside are pre-sanitized via escapeHtml/safeUrl/sanitizeEmbedId
  const mediaHtml = buildFeedMediaHtml(m)
  // All interpolated parts are pre-sanitized: the meta fields via escapeHtml/safeUrl/
  // sanitizeColor/sanitizeEmbedId, and `content` via renderFeedContent (which neutralizes
  // literal '<' in the server payload, closing the server-HTML-trust vector).
  div.innerHTML = `${timeHtml}${threadLink}${typeTag}${platBadge}${userHtml}${statsHtml}: <span class="hs-feed-body">${content}</span>${mediaHtml}`

  // Wire host-CSP-safe fallbacks for avatar/media error handlers (no inline onerror=).
  attachFeedFallbacks(div)

  // Click >>id to expand/collapse thread inline — never leaves the stream
  // If this post is a reply, open the parent thread and highlight this post
  const threadLinkEl = div.querySelector('.hs-thread-toggle')
  if (threadLinkEl) {
    threadLinkEl.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const threadId = m.reply_to || m.base36_id
      const highlightId = m.reply_to ? m.base36_id : null
      toggleThread(threadId, highlightId)
    })
  }
  const repliesEl = div.querySelector('.hs-feed-replies')
  if (repliesEl && replies > 0) {
    repliesEl.style.cursor = 'pointer'
    repliesEl.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleThread(m.reply_to || m.base36_id)
    })
  }

  // Click >>id post-links in message content
  div.querySelectorAll('.hs-post-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const targetId = link.dataset.id
      if (!targetId) return
      // Find the target in feedMessages to determine its thread
      const target = feedMessages.find((f) => f.base36_id === targetId)
      const threadId = target ? target.reply_to || target.base36_id : targetId
      if (!activeThread) threadReturnTab = null // opened from the feed → back to feed
      openThread(threadId, targetId)
    })
  })

  // Stash the message object so the universal right-click handler (input.js)
  // can build the follow/block/edit/delete menu for this post.
  div._hsFeedMsg = m
  // Show edited badge if message was edited
  if (m.edited_at && !div.querySelector('.hs-feed-edited')) {
    const body = div.querySelector('.hs-feed-body')
    if (body) {
      const badge = document.createElement('span')
      badge.className = 'hs-feed-edited'
      badge.textContent = ' (edited)'
      badge.style.cssText = 'color:#888;font-size:13px;font-style:italic;margin-left:4px;'
      body.appendChild(badge)
    }
  }

  // Click post ID in thread view → insert >>id into input
  const quoteEl = div.querySelector('.hs-quote-insert')
  if (quoteEl) {
    quoteEl.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const qid = quoteEl.dataset.quoteId
      if (!qid) return
      const input = document.getElementById('hs-mc-input')
      if (!input) return
      const quote = `>>${qid} `
      if (wysiwygEnabled) {
        input.focus()
        document.execCommand('insertText', false, quote)
      } else {
        const pos = input.selectionStart || input.value.length
        input.value = input.value.slice(0, pos) + quote + input.value.slice(pos)
        input.focus()
        input.selectionStart = input.selectionEnd = pos + quote.length
      }
    })
  }

  return div
}

// Format text with markdown-style syntax (matches heatsync.org rendering)
// Must be called AFTER escapeHtml — operates on escaped HTML strings
function formatText(html) {
  // Greentext: >text< (escaped as &gt;text&lt;)
  html = html.replace(/(&gt;)([^<>&]+)(&lt;)/g, '<span class="hs-greentext">&gt;$2&lt;</span>')
  // Inline code: `text`
  html = html.replace(/`([^`]+)`/g, '<code class="hs-inline-code">$1</code>')
  // Bold: **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>')
  // Italic: *text* or _text_ (not if part of bold)
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
  html = html.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<em>$1</em>')
  // Strikethrough: ~~text~~
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>')
  // Spoilers: ||text||
  html = html.replace(/\|\|(.+?)\|\|/g, '<span class="hs-spoiler">$1</span>')
  return html
}

const _feedEmoteRegexCache = new Map()
// Render one feed emote with the SAME wrapper structure chat uses, so
// right-click block/unblock works (queryEmoteWrappers matches
// .hs-mc-emote-wrapper[data-emote-name], findEmoteTarget reads data-state).
// Bare <img> rendered the emote but left it un-blockable — toast fired, image stayed.
function renderFeedEmote(name, url, source, hash, cwCat) {
  const dn = escapeHtml(name)
  // CW-hidden wins over everything else, same as chat (emotes.js ~3879
  // emote.cw / hsOwnCwHiddenCat): a filter-flagged emote must never render as
  // an <img> in feed/thread just because it slipped past the blocked check.
  // No url either way, so paint the same dashed-cyan labeled box chat uses.
  if (cwCat) {
    const cw = escapeHtml(cwCat)
    return `<span class="hs-mc-emote-wrapper hs-mc-emote-cw" data-emote-name="${dn}" data-cw="${cw}" data-state="cw" title="${dn}">${cw}</span>`
  }
  // Blocked → dashed box (transparent px), never the real image. Matches chat's
  // blocked branch so the block actually hides the emote on re-render.
  if (typeof blockedEmoteNames !== 'undefined' && blockedEmoteNames.has(name)) {
    return `<span class="hs-mc-emote-wrapper hs-state-blocked" data-emote-name="${dn}" data-state="blocked" data-source="heatsync"><img src="${HS_TRANSPARENT_PX}" alt="${dn}" title="${dn}" class="hs-mc-emote hs-emote-blocked" style="width:var(--hs-emote-size,32px);height:var(--hs-emote-size,32px)" data-emote-name="${dn}" data-state="blocked" data-source="heatsync"></span>`
  }
  const sanitizedUrl = escapeHtml(safeUrl(url))
  const src = escapeHtml(source || 'unknown')
  const state = typeof getEmoteState === 'function' ? getEmoteState(name, source) : 'global'
  const hashAttr = hash ? ` data-emote-hash="${escapeHtml(hash)}"` : ''
  return `<span class="hs-mc-emote-wrapper hs-state-${state}" data-emote-name="${dn}" data-emote-url="${sanitizedUrl}" data-state="${state}" data-source="${src}"${hashAttr}><img src="${sanitizedUrl}" alt="${dn}" title="${dn}" class="hs-mc-emote hs-emote-${state}" data-emote-name="${dn}" data-state="${state}" data-source="${src}" loading="lazy" decoding="async"></span>`
}

function renderFeedContent(content, emoteRefs) {
  if (!content) return ''
  // Content is ALREADY HTML-escaped by the server (sanitizeUserInput on store).
  // We do NOT full-escape again — that would double-encode `&` and break the
  // server's `&gt;&gt;id` post-link syntax. But the server is a trust boundary:
  // a MITM or a server-side sanitizer bypass could deliver raw `<img onerror=…>`
  // straight into innerHTML below. Defense in depth: neutralize any LITERAL `<`
  // (legit escaped content has none — it uses `&lt;`), which makes a raw tag
  // impossible to form while leaving entities and `>>id` untouched. No parser,
  // so no mXSS/parser-differential bypass like a DOM sanitizer can have.
  let html = String(content).replace(/</g, '&lt;')
  // Linkify URLs FIRST so text-formatting can't split them on '_' or eat path chars.
  // Single regex pass with alternation: full https:// URLs OR bare domains.
  // (?<![\/\w.]) on the bare-domain branch prevents matching inside an already-linkified URL path.
  if (linksEnabled) {
    html = html.replace(/(https?:\/\/[^\s<"]+|(?<![/\w.])[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s<"]*)/gi, (match) => {
      // `match` is already server-escaped (renderFeedContent runs on
      // pre-escaped content) — re-escaping turned &amp; into &amp;amp; (broken
      // href param + visible &amp;). The regex excludes <"/space so it's
      // attribute-safe verbatim. Only add the protocol for a bare domain.
      const url = /^https?:\/\//i.test(match) ? match : `https://${match}`
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="hs-mc-link">${match}</a>`
    })
    // Partial/defanged links ("watch?v=…", "heatsync (dot) org") — same
    // post-pass chat rows use; skips the anchors built above.
    if (partialLinksEnabled) {
      html = linkifyPartialLinks(html)
    }
  }
  // Text formatting (bold, italic, spoilers, etc.) — skip <a>...</a> blocks so URL underscores aren't italicized.
  {
    const parts = html.split(/(<a\s[^>]*>[^<]*<\/a>)/i)
    html = parts.map((part, i) => (i % 2 === 1 ? part : formatText(part))).join('')
  }
  // Parse >>id post-links (like website does)
  html = html.replace(/(?:&gt;&gt;|>>)(\w{1,6})/g, (_match, id) => {
    const paddedId = id.padStart(6, '0')
    const displayId = id.replace(/^0+/, '') || '0'
    return `<span class="hs-post-link" data-id="${paddedId}" style="cursor:pointer">&gt;&gt;${displayId}</span>`
  })

  // Parse @mentions — must skip inside HTML tags (already-built anchors, post-links, etc.)
  // Match site's pattern: @username with 1-25 word chars
  {
    const parts = html.split(/(<[^>]+>)/)
    html = parts
      .map((part, i) => {
        if (i % 2 === 1) return part
        return part.replace(/@([\w]{1,25})\b/g, (_m, name) => {
          const lower = name.toLowerCase()
          const isSelf = hsCurrentUsername === lower
          const cls = isSelf ? 'hs-mention self' : 'hs-mention'
          return `<a href="https://heatsync.org/user/${encodeURIComponent(name)}" target="_blank" rel="noopener noreferrer" class="${cls}" data-username="${escapeHtml(lower)}">@${escapeHtml(name)}</a>`
        })
      })
      .join('')
  }

  // Parse #hashtags — site pattern: leading letter, 2-30 chars total
  {
    const parts = html.split(/(<[^>]+>)/)
    html = parts
      .map((part, i) => {
        if (i % 2 === 1) return part
        // (?<!&) — part is already escaped; don't tag #x27 inside &#x27; etc.
        return part.replace(/(?<!&)#([a-zA-Z][a-zA-Z0-9_]{1,29})\b/g, (_m, tag) => {
          return `<a href="https://heatsync.org/tags/${encodeURIComponent(tag)}" target="_blank" rel="noopener noreferrer" class="hs-hashtag" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</a>`
        })
      })
      .join('')
  }

  // Render emote refs as inline images (AFTER linkification so img tags aren't corrupted)
  // emote_refs can be { name: url } or { name: { url, hash, name, provider } }
  if (emoteRefs && typeof emoteRefs === 'object') {
    for (const [name, val] of Object.entries(emoteRefs)) {
      // Server-enriched refs may carry a cw stub (`cw`, string category, no
      // url) or an own-inventory `cw_cats` array gated by the owner's own
      // viewer_show_* toggles — same two shapes background.js's
      // get_sender_emotes stub + emotes.js's hsOwnCwHiddenCat handle for chat.
      // Shim the snake_case field into hsOwnCwHiddenCat's expected cwCats.
      const cwCat =
        typeof val === 'object' && val
          ? (typeof val.cw === 'string' && val.cw) ||
            (typeof hsOwnCwHiddenCat === 'function' ? hsOwnCwHiddenCat({ cwCats: val.cw_cats }) : '')
          : ''
      const url = safeUrl(typeof val === 'string' ? val : val?.url)
      if (!url && !cwCat) continue
      const source = typeof val === 'object' ? val?.provider || 'heatsync' : 'heatsync'
      const hash = typeof val === 'object' ? val?.hash : ''
      const escaped = escapeHtml(name)
      const cacheKey = escaped
      let re = _feedEmoteRegexCache.get(cacheKey)
      if (!re) {
        // Match the emote name as a whole WHITESPACE-DELIMITED token, not via
        // `\b`: emote names routinely contain non-word chars (`fern(sousounofrieren)`,
        // `non-web_source`), and `\b` fails around `(`/`)` so a parenthesized name
        // never matched — it rendered as plain text. `(?<!\S)…(?!\S)` binds to
        // spaces/string-ends instead, and won't imagify a name embedded inside a
        // larger token (e.g. `meme` inside `frierenstuckinamimic(meme)`).
        // Also accept an optional trailing `(source)` disambiguation qualifier so
        // a bare-name ref key still matches the alias-qualified body the site emits.
        const body = escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        re = new RegExp(`(?<!\\S)${body}(?:\\([^)\\s]*\\))?(?!\\S)`, 'g')
        _feedEmoteRegexCache.set(cacheKey, re)
        if (_feedEmoteRegexCache.size > 500) _feedEmoteRegexCache.delete(_feedEmoteRegexCache.keys().next().value)
      }
      html = html.replace(re, renderFeedEmote(name, url, source, hash, cwCat))
    }
  }

  // Local emote fallback: render 7TV/BTTV/FFZ/channel emotes the server can't
  // resolve (not in emote_refs — site only knows heatsync emotes). The extension
  // augments with the viewer's full local emote set, matching chat-tile rendering.
  if (typeof lookupEmote === 'function') {
    const refNames = emoteRefs && typeof emoteRefs === 'object' ? new Set(Object.keys(emoteRefs)) : null
    const parts = html.split(/(<[^>]+>)/)
    html = parts
      .map((part, i) => {
        if (i % 2 === 1) return part // inside an HTML tag — skip
        return part.replace(/\S+/g, (word) => {
          if (refNames?.has(word)) return word // already rendered above
          // Site emits alias-qualified names (`fern(sousounofrieren)`) to
          // disambiguate collisions — the emote itself is the bare `fern`. Look up
          // the bare form when the qualified token misses.
          const bare = word.replace(/\([^)\s]*\)$/, '')
          if (bare !== word && refNames?.has(bare)) return word // handled by emote_refs pass
          // Blocked emote dropped from caches — still box it, don't leak the name.
          if (
            typeof blockedEmoteNames !== 'undefined' &&
            (blockedEmoteNames.has(word) || blockedEmoteNames.has(bare))
          ) {
            return renderFeedEmote(word, '', 'heatsync', '')
          }
          const em = lookupEmote(word) || (bare !== word ? lookupEmote(bare) : null)
          // Own-inventory cwCats gate (viewer_show_* toggles) — lookupEmote's
          // first hit is viewerPersonalEmotes, which carries cwCats the same
          // way processEmotes' hsOwnCwHiddenCat check does for chat.
          if (em) {
            const cwCat = typeof hsOwnCwHiddenCat === 'function' ? hsOwnCwHiddenCat(em) : ''
            if (cwCat) return renderFeedEmote(word, '', em.source || 'heatsync', em.hash || '', cwCat)
          }
          if (!em?.url || !/^https:\/\//.test(em.url)) return word
          return renderFeedEmote(word, em.url, em.source, em.hash)
        })
      })
      .join('')
  }
  return html
}

function formatRelativeTime(isoDate) {
  if (!isoDate) return ''
  return formatRelativeMs(Date.now() - new Date(isoDate).getTime())
}

function formatRelativeMs(diff) {
  if (diff < 0) return 'now'
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

// Chat-row timestamp = wall-clock HH:MM (24h, local). The "timestamps" toggle
// promises "timestamp on each message" — a clock time, not a relative age. A
// past message's clock time never changes, so no periodic refresh is needed.
function formatTimeFromTs(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (getSetting('timestampFormat') === '12h') {
    let h = d.getHours() % 12
    if (h === 0) h = 12
    return `${h}:${String(d.getMinutes()).padStart(2, '0')}${d.getHours() >= 12 ? 'pm' : 'am'}`
  }
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// Feed + thread media URLs are origin-relative (/uploads/...) — the ext renders
// cross-origin, so a relative src silently 404s against twitch.tv/kick.com AND
// safeUrl() throws on relative URLs (dropping the image). Prefix in place;
// absolute URLs pass through untouched. Called from buildFeedMediaHtml (the
// render chokepoint) so every surface — feed, thread, /logs — is covered.
function _absolutizeThreadMedia(m) {
  if (!m) return
  for (const k of ['media_url', 'thumbnail_url']) {
    if (typeof m[k] === 'string' && m[k].startsWith('/')) m[k] = `https://heatsync.org${m[k]}`
  }
  if (Array.isArray(m.media)) {
    for (const med of m.media) {
      if (!med) continue
      for (const k of ['url', 'thumbnail_url']) {
        if (typeof med[k] === 'string' && med[k].startsWith('/')) med[k] = `https://heatsync.org${med[k]}`
      }
    }
  }
}

// Open thread view — replaces feed with OP + replies + reply input
async function openThread(msgId, highlightId) {
  // Instant paint from the feed cache when the OP is in it; the /api/thread
  // fetch below replaces it with the authoritative copy either way. The cache
  // only holds the newest ~150 OPs, so a >>ref clicked from chat routinely
  // misses — the thread MUST render from the fetch alone, never the cache.
  const op = feedMessages.find((m) => m.base36_id === msgId)
  const thread = { id: msgId, op: op || null, replies: [], loading: true, highlightId: highlightId || null }
  activeThread = thread
  renderFeed()
  _renderFeedReplyChip(thread)
  if (typeof showInputBar === 'function') showInputBar()
  // Land ready to type — entering a thread is an intent to read AND reply.
  document.getElementById('hs-mc-input')?.focus()

  const resp = await apiFetch(`/api/thread/${encodeURIComponent(msgId)}`)
  // Bail if the user closed this thread or opened another during the fetch —
  // otherwise the unconditional writes below throw on null (closeThread /
  // remote-delete) or paint thread A's replies under thread B's header.
  if (activeThread !== thread) return
  if (resp.ok && resp.data?.original) {
    const original = resp.data.original
    // Clicked a >>ref that points at a reply: reroot to its thread so the OP
    // and siblings show, with the clicked post highlighted. One hop only —
    // roots carry no reply_to, so this can't loop.
    if (original.reply_to && original.reply_to !== msgId) {
      openThread(original.reply_to, highlightId || msgId)
      return
    }
    _absolutizeThreadMedia(original)
    thread.op = original
    // /api/thread pages newest-first; the view reads top-down chronological.
    thread.replies = (resp.data.replies || []).slice().reverse()
    for (const r of thread.replies) _absolutizeThreadMedia(r)
  } else if (!thread.op) {
    // No cached OP and the fetch failed/404'd — without this flag the view
    // renders as a bare "no replies yet" with no post at all.
    thread.error = true
  }
  thread.loading = false

  renderFeed()
  // Re-render the chip: the fetched OP corrects [OP]/[RE] state for threads
  // that weren't in the feed cache when the chip first painted.
  _renderFeedReplyChip(thread)

  // Scroll to and highlight the target post
  if (highlightId) {
    const msgsEl = document.getElementById('hs-mc-messages')
    const target = msgsEl?.querySelector(`[data-msg-id="${highlightId}"]`)
    if (target) {
      target.scrollIntoView({ behavior: 'instant', block: 'center' })
      target.classList.add('hs-post-highlight')
      cleanup.setTimeout(() => target.classList.remove('hs-post-highlight'), 1000)
    }
  }
}

function closeThread() {
  activeThread = null
  _clearFeedReplyChip()
  renderFeed()
}

// Reply-state chip shown above input bar when in thread view.
// [OP] magenta if you are the thread OP, [RE] cyan otherwise.
// Mirrors the [OP]/[RE] tag system from feed posts so click-to-reply
// has the same visual language as the rendered output.
function _renderFeedReplyChip(thread) {
  document.getElementById('hs-mc-feed-reply-chip')?.remove()
  if (!thread?.id) return
  const bar = document.getElementById('hs-mc-inputbar')
  if (!bar) return

  const chip = document.createElement('div')
  chip.id = 'hs-mc-feed-reply-chip'
  chip.className = 'hs-mc-feed-reply-chip'

  const opUser = thread.op?.username?.toLowerCase() || ''
  const isOwnOp = !!(hsCurrentUsername && opUser && hsCurrentUsername.toLowerCase() === opUser)

  const tag = document.createElement('span')
  tag.className = isOwnOp ? 'hs-feed-tag hs-feed-tag-mop' : 'hs-feed-tag hs-feed-tag-re'
  tag.textContent = isOwnOp ? '[OP]' : '[RE]'
  chip.appendChild(tag)

  const ref = document.createElement('span')
  ref.className = 'hs-mc-feed-reply-ref'
  const rawId = thread.op?.base36_id || thread.id || ''
  const displayId = String(rawId).replace(/^0+/, '') || '0'
  ref.textContent = ` replying to >>${displayId}`
  chip.appendChild(ref)

  const cancel = document.createElement('button')
  cancel.className = 'hs-mc-feed-reply-cancel'
  cancel.textContent = '✕'
  cancel.title = 'leave thread'
  cancel.addEventListener('click', (e) => {
    e.preventDefault()
    closeThread()
  })
  chip.appendChild(cancel)

  bar.insertBefore(chip, bar.firstChild)
}

function _clearFeedReplyChip() {
  document.getElementById('hs-mc-feed-reply-chip')?.remove()
}

function toggleThread(msgId, highlightId) {
  if (activeThread && activeThread.id === msgId && !highlightId) {
    closeThread()
  } else {
    if (!activeThread) threadReturnTab = null // opened from a feed row → back to feed
    openThread(msgId, highlightId)
  }
}

// Render the thread view (OP + replies + back button)
function renderThreadView(msgsEl) {
  const at = activeThread
  isProgrammaticScroll = true
  msgsEl.textContent = ''
  const frag = document.createDocumentFragment()
  let zebraCount = 0

  if (at.op) {
    const opDiv = buildFeedMessageDiv(at.op, at.op?.username)
    opDiv.classList.add('hs-thread-op')
    if (zebraEnabled && ++zebraCount % 2 === 0) opDiv.classList.add('hs-mc-zebra')
    frag.appendChild(opDiv)
  }

  const container = document.createElement('div')
  container.className = 'hs-thread-container'
  container.dataset.thread = at.id

  if (at.loading) {
    const loading = document.createElement('div')
    loading.className = 'hs-mc-empty'
    loading.textContent = 'loading...'
    loading.style.fontSize = '11px'
    container.appendChild(loading)
  } else if (at.error) {
    const err = document.createElement('div')
    err.className = 'hs-mc-empty'
    err.textContent = t('mc_social_thread_unavailable')
    err.style.fontSize = '11px'
    container.appendChild(err)
  } else if (at.replies.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'hs-mc-empty'
    empty.textContent = t('mc_social_no_replies')
    empty.style.fontSize = '11px'
    container.appendChild(empty)
  } else {
    for (const r of at.replies) {
      const replyDiv = buildFeedMessageDiv(r, at.op?.username)
      replyDiv.classList.add('hs-thread-reply')
      if (r.is_thread_op) replyDiv.classList.add('is-thread-op')
      if (zebraEnabled && ++zebraCount % 2 === 0) replyDiv.classList.add('hs-mc-zebra')
      container.appendChild(replyDiv)
    }
  }
  frag.appendChild(container)
  msgsEl.appendChild(frag)

  isProgrammaticScroll = true
  msgsEl.scrollTop = 0
  requestAnimationFrame(() => {
    isProgrammaticScroll = false
  })

  if (typeof resolvePendingFeedEmbeds === 'function') resolvePendingFeedEmbeds(msgsEl)
}

// Plain-text dump of the current thread view (OP + all replies). Used by the
// universal right-click menu's "copy thread" item. Walks rendered DOM so
// emote <img alt> + already-escaped content come out as a user would read them.
function getActiveThreadCopyText() {
  const opDiv = document.querySelector('.hs-thread-op')
  if (!opDiv) return null
  const container = document.querySelector('.hs-thread-container')
  const rows = [opDiv, ...(container ? container.querySelectorAll(':scope > .hs-thread-reply') : [])]
  const lines = []
  for (const div of rows) {
    const tag = div.querySelector('.hs-feed-tag')?.textContent?.trim() || ''
    const userEl = div.querySelector('.hs-feed-user')
    const user = userEl?.textContent?.trim() || 'anonymous'
    const id = div.dataset?.msgId ? ` >>${div.dataset.msgId.replace(/^0+/, '') || '0'}` : ''
    const body = _extractFeedBodyText(div.querySelector('.hs-feed-body'))
    lines.push(`${tag ? `${tag} ` : ''}${user}${id}: ${body}`)
  }
  return lines.join('\n')
}

function _extractFeedBodyText(root) {
  if (!root) return ''
  const parts = []
  const walk = (node) => {
    if (node.nodeType === 3) {
      parts.push(node.textContent)
      return
    }
    if (node.nodeType !== 1) return
    if (node.classList?.contains('hs-feed-edited')) return
    if (node.tagName === 'BR') {
      parts.push('\n')
      return
    }
    if (node.tagName === 'IMG' && node.alt) {
      parts.push(node.alt)
      return
    }
    for (const c of node.childNodes) walk(c)
  }
  for (const c of root.childNodes) walk(c)
  return parts
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim()
}

async function postFeedMessage(text, { topLevel = false, replyTo = null } = {}) {
  const input = document.getElementById('hs-mc-input')
  if (!input) return false

  if (!hsAuthToken) {
    if (wysiwygEnabled) {
      input.dataset.placeholder = t('mc_social_login_first')
    } else {
      input.placeholder = t('mc_social_login_first')
    }
    cleanup.setTimeout(() => updateInputPlaceholder(), 2000)
    return false
  }

  // Extract pasted/uploaded media URL from content. The chat-tile flow
  // inserts /uploads/<file> as text into the input; the home-feed renderer
  // expects media_url as a separate field. Pull the first match out so it
  // renders as inline media on heatsync.org.
  let mediaUrl = null
  let mediaType = null
  const mediaMatch = text.match(
    /(?:https?:\/\/[^\s]*)?\/uploads\/([\w.-]+\.(jpg|jpeg|png|gif|webp|avif|mp4|webm|mov))(?:\?[^\s]*)?/i,
  )
  if (mediaMatch) {
    mediaUrl = mediaMatch[0].startsWith('/') ? mediaMatch[0] : new URL(mediaMatch[0]).pathname
    const ext = mediaMatch[2].toLowerCase()
    mediaType = /^(mp4|webm|mov)$/.test(ext) ? 'video' : 'image'
    text = text.replace(mediaMatch[0], '').replace(/\s+/g, ' ').trim()
  }

  const body = { content: text }
  if (mediaUrl) {
    body.media_url = mediaUrl
    body.media_type = mediaType
  }
  // An explicit target wins over view state — /opr replies to the last [OP]
  // you saw in chat, which is usually NOT the thread you happen to have open.
  if (replyTo) {
    body.reply_to = replyTo
  } else if (activeThread && !topLevel) {
    // In thread view, global input posts as a reply to the active thread —
    // unless the caller explicitly forced a top-level post (topLevel: /op's
    // whole purpose; it silently became a thread reply before this gate).
    body.reply_to = activeThread.id
  }

  const resp = await apiFetch('/api/messages', { method: 'POST', auth: true, body })
  if (resp.ok) {
    if (wysiwygEnabled) {
      input.innerHTML = ''
    } else {
      input.value = ''
    }
    pendingMessage = ''
    updateCharCount()
    hideInputBar()
    // Insert own post immediately from response (fetchFeed unreliable — service worker gets killed)
    const posted = resp.data?.message
    if (posted) {
      // OPs only in the following timeline — a reply posted from thread view
      // still lands in its thread (below), but must not leak into the feed.
      if (isOpMsg(posted) && !feedMessages.some((f) => f.base36_id === posted.base36_id)) {
        feedMessages.unshift(posted)
        if (feedMessages.length > 150) feedMessages.pop()
      }
      // If in thread view, append reply to the thread
      if (activeThread && activeThread.id === posted.reply_to) {
        if (!activeThread.replies.some((r) => r.base36_id === posted.base36_id)) {
          activeThread.replies.push(posted)
        }
        // Update OP reply count
        if (activeThread.op) activeThread.op.reply_count = (activeThread.op.reply_count || 0) + 1
        const parent = feedMessages.find((m) => m.base36_id === activeThread.id)
        if (parent) parent.reply_count = (parent.reply_count || 0) + 1
      }
    }
    if (currentTab === 'feed') renderFeed()
    // Echo your own post into chat, exactly as someone else's would appear.
    // The websocket new-message echo CANNOT do this: the optimistic unshift
    // above already put this id in feedMessages, so the ws handler's dedup
    // returns before it ever reaches injectInlineNotif (and it bails outright
    // when the feed tab was never opened). That's why /op looked like it did
    // nothing — the post landed, chat just never said so. force: your own
    // action's receipt isn't a notification about someone else, so the
    // per-type inline-notif toggle doesn't gate it.
    if (posted && currentTab !== 'feed') {
      // created_at defended: the row is unusable without a timestamp, and a
      // post the server hasn't stamped yet must still show up.
      const row = buildFeedInlineNotif({
        ...posted,
        created_at: posted.created_at || new Date().toISOString(),
      })
      if (row) injectInlineNotif(row.notifType, row.msg, { force: true })
    }
    return posted || true
  } else {
    input.style.borderColor = 'var(--hs-danger)'
    const errMsg =
      resp.status === 401
        ? t('mc_social_log_in_first')
        : resp.status === 429
          ? t('mc_social_slow_down')
          : resp.status === 409
            ? t('mc_social_duplicate')
            : t('mc_social_failed_post')
    showToast(errMsg, 'error')
    cleanup.setTimeout(() => {
      input.style.borderColor = ''
    }, 1500)
    log('Post failed:', resp.status || resp.error)
    return false
  }
}

// ============================================
// DISCOVER TAB (trending tags + profiles)
// ============================================

let discoverLoaded = false
let discoverLoading = false
let discoverPollTimer = null
function startDiscoverPolling() {
  if (discoverPollTimer) return
  // Auto-refresh while user is viewing the discover tab
  discoverPollTimer = cleanup.setIntervalIfVisible(() => {
    if (currentTab === 'discover' && !discoverLoading) {
      discoverLoaded = false
      fetchDiscover()
    } else if (currentTab !== 'discover') {
      cleanup.clearInterval(discoverPollTimer)
      discoverPollTimer = null
    }
  }, 20000)
}
let discoverTags = []
let discoverProfiles = []
let discoverPosts = []
let discoverPlatformFilter = 'all' // 'all' | 't' | 'k' | 'yt'

function _discoverSetLoading(msgsEl) {
  msgsEl.textContent = ''
  const el = document.createElement('div')
  el.className = 'hs-mc-empty'
  el.textContent = 'loading...'
  msgsEl.appendChild(el)
}

async function fetchDiscover() {
  if (discoverLoading) return
  discoverLoading = true

  const msgsEl = document.getElementById('hs-mc-messages')
  if (msgsEl && currentTab === 'discover') _discoverSetLoading(msgsEl)

  // Snapshot the tab user was on when fetch started — if they switched away and
  // back during the await, the .finally still re-renders correctly. If they
  // switched away and stayed, render is skipped (no clobbering other tab DOM).
  const tabAtFetch = currentTab
  try {
    const [tagsResp, profilesResp, postsResp] = await Promise.all([
      apiFetch('/api/tags/trending'),
      apiFetch('/api/profiles/trending'),
      apiFetch('/api/messages?sort=time&limit=40').catch(() => null),
    ])

    // Server shape: { tags: [...] } and { profiles: [...] }.
    // api_fetch proxy wraps as { ok: true, data: {...} }, so unwrap one more level.
    const tagsData = tagsResp.ok ? tagsResp.data || tagsResp : {}
    const profilesData = profilesResp.ok ? profilesResp.data || profilesResp : {}
    discoverTags = Array.isArray(tagsData) ? tagsData : tagsData.tags || []
    discoverProfiles = Array.isArray(profilesData) ? profilesData : profilesData.profiles || []

    // Posts: rank by heat, but never render the section empty while real posts exist.
    // Heat only accrues from a logged-in, non-self actor and halves every 12h, so at
    // current traffic it is 0 on every row — this gate emptied Discover completely
    // while 40 real posts sat in the response. Same rule as the server's
    // lib/cold-start.ts: rank first, fall back to newest rather than show nothing.
    // rawPosts arrives newest-first (sort=time), so the fallback keeps recency order.
    const rawPosts = postsResp?.ok ? postsResp.data?.messages || [] : []
    const eligiblePosts = rawPosts.filter((m) => m?.username && m.username !== 'Anonymous')
    const hotPosts = eligiblePosts.filter((m) => (m.heat || 0) > 0).sort((a, b) => (b.heat || 0) - (a.heat || 0))
    discoverPosts = (hotPosts.length ? hotPosts : eligiblePosts).slice(0, 8)

    // Latch ONLY when a fetch actually succeeded. Setting this on failure made
    // an outage indistinguishable from a genuinely empty Discover AND blocked
    // any retry for the rest of the session — a launch-day user on a cold
    // service worker saw a dead, empty product with no way back.
    discoverLoaded = tagsResp.ok || profilesResp.ok
  } catch (_) {
    discoverTags = []
    discoverProfiles = []
    discoverPosts = []
    discoverLoaded = false
  } finally {
    discoverLoading = false
    if (currentTab === 'discover') renderDiscoverTab()
    void tabAtFetch
  }
}

// Compact number: 12345 -> "12.3k", 1200000 -> "1.2m"
function formatDiscoverCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

// Compact heat tier styling — matches site canonical color tiers from getHeatNumberStyle,
// but with fixed (small) size so discover rows stay dense.
// Tiers: 0 → #444, 1-10 → #888, 10-30 → #888, 30-50 → #aaa, 50-100 → #ccc,
//        100-500 → #eee, 500+ → #fff with breathe animation
// pinned warm/orange by doctrine — heat FX ramp, not a semantic var
function discoverHeatStyle(heat) {
  let color = '#444',
    textShadow = '',
    animation = ''
  if (heat > 500) {
    color = '#fff'
    textShadow = '0 0 4px rgba(255,255,255,1),0 0 10px rgba(255,200,100,0.9),0 0 18px rgba(255,135,0,0.6)'
    animation = 'hs-heat-breathe 2s ease-in-out infinite'
  } else if (heat > 100) {
    color = '#eee'
    textShadow = '0 0 4px rgba(255,170,50,0.85),0 0 10px rgba(255,135,0,0.4)'
  } else if (heat > 50) {
    color = '#fff'
    textShadow = '0 0 3px rgba(255,135,0,0.55)'
  } else if (heat > 30) {
    color = '#aaa'
  } else if (heat > 10) {
    color = '#888'
  }
  let style = `color:${color};font-weight:900;font-variant-numeric:tabular-nums;`
  if (textShadow) style += `text-shadow:${textShadow};`
  if (animation) style += `animation:${animation};`
  return style
}

// Apply canonical row-level heat effects (border, bg tint, breathe class)
function applyDiscoverHeatRowEffects(row, heat) {
  const hd = getHeatDisplay(heat)
  if (!hd) return
  row.style.borderLeftColor = hd.border
  row.style.borderLeftWidth = `${hd.borderWidth}px`
  if (hd.bg) row.style.background = hd.bg
  if (hd.breathe) row.classList.add('hs-feed-heat-breathe')
}

// Canonical heat number — formatHeat + ° suffix at ≥ 10 + tier color/glow/breathe inline style.
// The number and degree symbol render in separate sub-spans (.hs-heat-n and
// .hs-heat-deg) so surfaces using a bitmap font can keep the digits crisp
// while letting the ° fall back to a vector font that has a clean glyph.
function heatSpanHtml(heat) {
  const h = Number(heat) || 0
  if (h <= 0) return ''
  const style = discoverHeatStyle(h)
  const suffix = h >= 10 ? '<span class="hs-heat-deg">°</span>' : ''
  return `<span class="hs-heat-num" style="${style}"><span class="hs-heat-n">${formatHeat(h)}</span>${suffix}</span>`
}

// Same, returned as a DOM node for createElement callers.
function heatSpanEl(heat) {
  const h = Number(heat) || 0
  if (h <= 0) return null
  const span = document.createElement('span')
  span.className = 'hs-heat-num'
  span.setAttribute('style', discoverHeatStyle(h))
  const numSpan = document.createElement('span')
  numSpan.className = 'hs-heat-n'
  numSpan.textContent = formatHeat(h)
  span.appendChild(numSpan)
  if (h >= 10) {
    const deg = document.createElement('span')
    deg.className = 'hs-heat-deg'
    deg.textContent = '°'
    span.appendChild(deg)
  }
  return span
}

function renderDiscoverProfileRow(profile, username, rank, maxHeat, showRank = true) {
  const row = document.createElement('a')
  row.className = 'hs-discover-profile-row'
  row.href = `https://heatsync.org/user/${encodeURIComponent(username)}`
  row.target = '_blank'
  row.rel = 'noopener noreferrer'

  const isLive = !!(profile.twitch_is_live || profile.kick_is_live)
  if (isLive) row.classList.add('hs-discover-row-live')

  if (showRank) {
    const rankEl = document.createElement('span')
    rankEl.className = 'hs-discover-rank'
    rankEl.textContent = String(rank).padStart(2, '0')
    row.appendChild(rankEl)
  }

  const dot = document.createElement('span')
  dot.className = isLive ? 'hs-discover-live-dot' : 'hs-discover-live-spacer'
  if (isLive) {
    const v = (profile.twitch_viewer_count || 0) + (profile.kick_viewer_count || 0)
    dot.title = v > 0 ? `live · ${v.toLocaleString()} viewer${v === 1 ? '' : 's'}` : 'live'
  }
  row.appendChild(dot)

  const avatarUrl = safeUrl(
    profile.avatarUrl || profile.avatar_url || profile.twitch_profile_pic || profile.kick_profile_pic || '',
  )
  if (avatarUrl) {
    const img = document.createElement('img')
    img.className = 'hs-discover-avatar'
    img.src = avatarUrl
    img.alt = ''
    img.loading = 'lazy'
    img.onerror = function () {
      this.style.visibility = 'hidden'
    }
    row.appendChild(img)
  } else {
    const ph = document.createElement('span')
    ph.className = 'hs-discover-avatar hs-discover-avatar-empty'
    row.appendChild(ph)
  }

  const nameEl = document.createElement('span')
  nameEl.className = 'hs-discover-profile-name'
  nameEl.style.color = sanitizeColor(profile.userColor || profile.user_color || '#fff')
  nameEl.textContent = profile.displayName || profile.display_name || username
  row.appendChild(nameEl)

  const plats = document.createElement('span')
  plats.className = 'hs-discover-platforms'
  if (profile.twitch_username) {
    const t = document.createElement('a')
    t.className = 'hs-plat hs-plat-t'
    t.textContent = 'T'
    t.href = `https://www.twitch.tv/${encodeURIComponent(profile.twitch_username)}`
    t.target = '_blank'
    t.rel = 'noopener noreferrer'
    t.title = `twitch · @${profile.twitch_username}${profile.twitch_is_live ? ' · live' : ''}`
    if (profile.twitch_is_live) t.classList.add('hs-plat-live')
    t.addEventListener('click', (e) => e.stopPropagation())
    plats.appendChild(t)
  }
  if (profile.kick_username) {
    const k = document.createElement('a')
    k.className = 'hs-plat hs-plat-k'
    k.textContent = 'K'
    k.href = `https://kick.com/${encodeURIComponent(profile.kick_username)}`
    k.target = '_blank'
    k.rel = 'noopener noreferrer'
    k.title = `kick · @${profile.kick_username}${profile.kick_is_live ? ' · live' : ''}`
    if (profile.kick_is_live) k.classList.add('hs-plat-live')
    k.addEventListener('click', (e) => e.stopPropagation())
    plats.appendChild(k)
  }
  if (plats.childNodes.length) row.appendChild(plats)

  const heat = Number(profile.stats?.total_heat ?? profile.heat ?? 0)
  const bar = document.createElement('span')
  bar.className = 'hs-discover-bar'
  const fill = document.createElement('i')
  const pct = maxHeat > 0 ? Math.max(2, Math.round((heat / maxHeat) * 100)) : 2
  fill.style.width = `${pct}%`
  bar.appendChild(fill)
  row.appendChild(bar)

  // Canonical heat number — matches website / feed posts (formatHeat + ° suffix, tiered glow).
  // Digits and ° are split into sub-spans so bitmap-font surfaces can render digits crisp
  // while keeping the degree symbol on a vector font with a clean glyph.
  const heatEl = document.createElement('span')
  heatEl.className = 'hs-discover-heat'
  heatEl.title = `${heat.toLocaleString()} heat`
  heatEl.setAttribute('style', discoverHeatStyle(heat))
  const numSpan = document.createElement('span')
  numSpan.className = 'hs-heat-n'
  numSpan.textContent = formatHeat(heat)
  heatEl.appendChild(numSpan)
  if (heat >= 10) {
    const deg = document.createElement('span')
    deg.className = 'hs-heat-deg'
    deg.textContent = '°'
    heatEl.appendChild(deg)
  }
  row.appendChild(heatEl)

  // Apply row-level heat tier effects ONLY when not live (live row has red border)
  if (!isLive) applyDiscoverHeatRowEffects(row, heat)

  if (isLive) {
    const v = (profile.twitch_viewer_count || 0) + (profile.kick_viewer_count || 0)
    if (v > 0) {
      const vEl = document.createElement('span')
      vEl.className = 'hs-discover-viewers'
      vEl.textContent = formatDiscoverCount(v)
      vEl.title = `${v.toLocaleString()} viewers`
      row.appendChild(vEl)
    }
  }

  return row
}

// Platform filter bar — click rerenders
function renderDiscoverChipsBar() {
  const bar = document.createElement('div')
  bar.className = 'hs-discover-chips-bar'

  function makeChip(label, value, currentValue, setter, extraClass) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `hs-discover-chip-btn${extraClass ? ` ${extraClass}` : ''}`
    if (value === currentValue) btn.classList.add('hs-active')
    btn.textContent = label
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      setter(value)
      renderDiscoverTab()
    })
    return btn
  }

  function makeLabel(text) {
    const l = document.createElement('span')
    l.className = 'hs-discover-chips-label'
    l.textContent = text
    return l
  }

  bar.appendChild(makeLabel('platform'))
  bar.appendChild(
    makeChip('all', 'all', discoverPlatformFilter, (v) => {
      discoverPlatformFilter = v
    }),
  )
  bar.appendChild(
    makeChip(
      't',
      't',
      discoverPlatformFilter,
      (v) => {
        discoverPlatformFilter = v
      },
      'hs-chip-plat-t',
    ),
  )
  bar.appendChild(
    makeChip(
      'k',
      'k',
      discoverPlatformFilter,
      (v) => {
        discoverPlatformFilter = v
      },
      'hs-chip-plat-k',
    ),
  )
  bar.appendChild(
    makeChip(
      'yt',
      'yt',
      discoverPlatformFilter,
      (v) => {
        discoverPlatformFilter = v
      },
      'hs-chip-plat-yt',
    ),
  )
  return bar
}

function profileMatchesPlatformFilter(p) {
  if (discoverPlatformFilter === 'all') return true
  if (discoverPlatformFilter === 't') return !!p.twitch_username
  if (discoverPlatformFilter === 'k') return !!p.kick_username
  if (discoverPlatformFilter === 'yt') return !!(p.youtube_username || p.youtube_channel_id)
  return true
}

function postMatchesPlatformFilter(m) {
  if (discoverPlatformFilter === 'all') return true
  if (discoverPlatformFilter === 't') return m.platform === 'twitch'
  if (discoverPlatformFilter === 'k') return m.platform === 'kick'
  if (discoverPlatformFilter === 'yt') return m.platform === 'youtube'
  return true
}

function sortProfilesByHeat(a, b) {
  return (b.stats?.total_heat || 0) - (a.stats?.total_heat || 0)
}

function renderDiscoverPostRow(m) {
  const row = document.createElement('a')
  row.className = 'hs-discover-post-row'
  row.href = `https://heatsync.org/m/${encodeURIComponent(m.base36_id)}`
  row.target = '_blank'
  row.rel = 'noopener noreferrer'

  // Meta line: time · plat · user · spacer · heat · replies
  const meta = document.createElement('div')
  meta.className = 'hs-discover-post-meta'

  const time = document.createElement('span')
  time.className = 'hs-discover-post-time'
  time.textContent = formatRelativeTime(m.created_at)
  time.title = new Date(m.created_at).toLocaleString()
  meta.appendChild(time)

  if (m.platform) {
    const plat = document.createElement('span')
    const code = m.platform === 'twitch' ? 't' : m.platform === 'kick' ? 'k' : m.platform === 'youtube' ? 'yt' : 'h'
    plat.className = `hs-plat hs-plat-${code} hs-discover-post-plat`
    plat.textContent = code === 'yt' ? 'Y' : code.toUpperCase()
    meta.appendChild(plat)
  }

  const user = document.createElement('span')
  user.className = 'hs-discover-post-user'
  user.style.color = sanitizeColor(m.user_color || '#fff')
  user.textContent = m.username
  meta.appendChild(user)

  const spacer = document.createElement('span')
  spacer.className = 'hs-discover-post-spacer'
  meta.appendChild(spacer)

  const heat = Number(m.heat || 0)
  const heatEl = document.createElement('span')
  heatEl.className = 'hs-discover-heat hs-discover-post-heat'
  heatEl.title = `${heat.toLocaleString()} heat`
  heatEl.setAttribute('style', discoverHeatStyle(heat))
  const numSpan = document.createElement('span')
  numSpan.className = 'hs-heat-n'
  numSpan.textContent = formatHeat(heat)
  heatEl.appendChild(numSpan)
  if (heat >= 10) {
    const deg = document.createElement('span')
    deg.className = 'hs-heat-deg'
    deg.textContent = '°'
    heatEl.appendChild(deg)
  }
  meta.appendChild(heatEl)

  if ((m.reply_count || 0) > 0) {
    const rep = document.createElement('span')
    rep.className = 'hs-discover-post-replies'
    rep.title = `${m.reply_count} repl${m.reply_count === 1 ? 'y' : 'ies'}`
    rep.textContent = `${m.reply_count}r`
    meta.appendChild(rep)
  }

  row.appendChild(meta)

  // Content line: post body, full width, max 2 lines via line-clamp
  const txt = document.createElement('div')
  txt.className = 'hs-discover-post-text'
  const snippet = String(m.content || '')
    .replace(/\s+/g, ' ')
    .trim()
  txt.textContent = snippet || '(no text)'
  row.appendChild(txt)

  // Canonical row-level heat tier effects (border tier, bg, breathe at 500+)
  applyDiscoverHeatRowEffects(row, heat)

  return row
}

function makeDiscoverSection(titleText, subtitleText, metaText, extraClass) {
  const section = document.createElement('section')
  section.className = `hs-discover-section${extraClass ? ` ${extraClass}` : ''}`
  const heading = document.createElement('div')
  heading.className = 'hs-discover-heading'

  const titleWrap = document.createElement('span')
  titleWrap.className = 'hs-discover-heading-title'
  titleWrap.textContent = titleText
  heading.appendChild(titleWrap)

  if (metaText) {
    const meta = document.createElement('span')
    meta.className = 'hs-discover-meta'
    meta.textContent = metaText
    heading.appendChild(meta)
  }
  section.appendChild(heading)

  if (subtitleText) {
    const sub = document.createElement('div')
    sub.className = 'hs-discover-subtitle'
    sub.textContent = subtitleText
    section.appendChild(sub)
  }

  const body = document.createElement('div')
  body.className = 'hs-discover-section-body'
  section.appendChild(body)
  return { section, body }
}

function renderDiscoverTab() {
  if (typeof activeProfileCard !== 'undefined' && activeProfileCard) return
  const msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl) return

  startDiscoverPolling()

  if (!discoverLoaded && !discoverLoading) {
    fetchDiscover()
    return
  }
  if (discoverLoading) {
    _discoverSetLoading(msgsEl)
    return
  }

  msgsEl.textContent = ''

  // Container query root — gives us responsive layout based on panel width, not viewport
  const root = document.createElement('div')
  root.className = 'hs-discover-root'

  const filteredProfiles = discoverProfiles.filter(profileMatchesPlatformFilter)
  const filteredPosts = discoverPosts.filter(postMatchesPlatformFilter)

  const liveProfiles = filteredProfiles
    .filter((p) => p.twitch_is_live || p.kick_is_live)
    .sort((a, b) => {
      const av = (a.twitch_viewer_count || 0) + (a.kick_viewer_count || 0)
      const bv = (b.twitch_viewer_count || 0) + (b.kick_viewer_count || 0)
      if (av !== bv) return bv - av
      return (b.stats?.total_heat || 0) - (a.stats?.total_heat || 0)
    })
  const restProfiles = filteredProfiles.filter((p) => !p.twitch_is_live && !p.kick_is_live).sort(sortProfilesByHeat)
  const maxHeat = Math.max(...filteredProfiles.map((p) => p.stats?.total_heat ?? p.heat ?? 0), 1)

  // Filter chips
  root.appendChild(renderDiscoverChipsBar())

  // Top row — LIVE NOW + HOT POSTS side by side when wide
  const topRow = document.createElement('div')
  topRow.className = 'hs-discover-row1'

  // ● LIVE NOW
  {
    const { section, body } = makeDiscoverSection(
      'live now',
      null,
      liveProfiles.length > 0 ? `${liveProfiles.length}` : '0',
      'hs-discover-section-live',
    )
    if (liveProfiles.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'hs-discover-section-empty'
      empty.textContent = 'no streams live right now'
      body.appendChild(empty)
      // Contextual nudge — if the user follows few/no people on heatsync, the
      // section will always look empty. Surface twitch import right at the
      // point of pain. safeSendMessage→get_followed_users to gate the prompt.
      try {
        chrome.runtime
          .sendMessage({ type: 'get_followed_users' })
          .then((resp) => {
            if ((resp?.users?.length || 0) >= 5) return
            if (!body.isConnected) return
            const nudge = document.createElement('div')
            nudge.className = 'hs-discover-section-empty hs-discover-import-nudge'
            const a = document.createElement('a')
            a.href = '#'
            a.textContent = 'import follows from twitch'
            a.style.color = '#fff'
            a.style.textDecoration = 'none'
            a.addEventListener('click', async (e) => {
              e.preventDefault()
              a.textContent = 'syncing…'
              try {
                const r = await apiFetch('/api/sync-twitch-follows', { method: 'POST', auth: true })
                if (r?.ok && r?.data?.success) {
                  a.textContent = `synced ${r.data.synced} ✓`
                  try {
                    chrome.runtime.sendMessage({ type: 'refresh_followed_users' })
                  } catch {}
                  cleanup.setTimeout(() => renderDiscoverTab(), 1500)
                } else {
                  a.textContent = (r?.error || r?.data?.error || 'failed').slice(0, 30)
                }
              } catch (_) {
                a.textContent = 'failed'
              }
            })
            nudge.appendChild(a)
            body.appendChild(nudge)
          })
          .catch(() => {})
      } catch {}
    } else {
      for (const profile of liveProfiles) {
        const username = profile.username || profile.name || ''
        if (!username) continue
        const row = renderDiscoverProfileRow(profile, username, 0, maxHeat, false)
        if (row) body.appendChild(row)
      }
    }
    topRow.appendChild(section)
  }

  // HOT POSTS
  {
    const { section, body } = makeDiscoverSection('hot posts', null, null, 'hs-discover-section-posts')
    if (filteredPosts.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'hs-discover-section-empty'
      empty.textContent = 'no posts match filter'
      body.appendChild(empty)
    } else {
      for (const m of filteredPosts) {
        const row = renderDiscoverPostRow(m)
        if (row) body.appendChild(row)
      }
    }
    topRow.appendChild(section)
  }

  root.appendChild(topRow)

  // TAGS — always render, above the long leaderboard
  {
    const { section, body } = makeDiscoverSection('tags', null, null, 'hs-discover-section-tags')
    if (discoverTags.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'hs-discover-section-empty'
      empty.textContent = 'none right now'
      body.appendChild(empty)
    } else {
      const chips = document.createElement('div')
      chips.className = 'hs-discover-chips'
      for (const tag of discoverTags) {
        const name = typeof tag === 'string' ? tag : tag.name || tag.tag || ''
        if (!name) continue
        const chip = document.createElement('a')
        chip.className = 'hs-discover-chip'
        chip.href = `https://heatsync.org/tags/${encodeURIComponent(name)}`
        chip.target = '_blank'
        chip.rel = 'noopener noreferrer'
        chip.textContent = name
        const count = typeof tag === 'object' ? tag.count || tag.usage || 0 : 0
        if (count > 0) {
          const c = document.createElement('span')
          c.className = 'hs-discover-chip-count'
          c.textContent = formatDiscoverCount(count)
          chip.appendChild(c)
        }
        chips.appendChild(chip)
      }
      body.appendChild(chips)
    }
    root.appendChild(section)
  }

  // LEADERBOARD — non-live profiles, multi-column when wide
  {
    const { section, body } = makeDiscoverSection('leaderboard', null, null, 'hs-discover-section-trending')
    body.classList.add('hs-discover-leaderboard-body')
    if (restProfiles.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'hs-discover-section-empty'
      empty.textContent = 'no profiles match this filter'
      body.appendChild(empty)
    } else {
      let rank = 1
      for (const profile of restProfiles) {
        const username = profile.username || profile.name || ''
        if (!username) continue
        const row = renderDiscoverProfileRow(profile, username, rank++, maxHeat)
        if (row) body.appendChild(row)
      }
    }
    root.appendChild(section)
  }

  msgsEl.appendChild(root)
}

// Pinned messages tab
let pinnedLoaded = false
let pinnedLoading = false
let pinnedPollTimer = null
function startPinnedPolling() {
  if (pinnedPollTimer) return
  pinnedPollTimer = cleanup.setIntervalIfVisible(() => {
    if (currentTab === 'pinned' && !pinnedLoading) {
      pinnedLoaded = false
      fetchPinned()
    } else if (currentTab !== 'pinned') {
      cleanup.clearInterval(pinnedPollTimer)
      pinnedPollTimer = null
    }
  }, 20000)
}
let pinnedMessages = []

function _pinnedSetLoading(msgsEl) {
  msgsEl.textContent = ''
  const el = document.createElement('div')
  el.className = 'hs-mc-empty'
  el.textContent = 'loading...'
  msgsEl.appendChild(el)
}

async function fetchPinned() {
  if (pinnedLoading) return
  pinnedLoading = true

  const msgsEl = document.getElementById('hs-mc-messages')
  if (msgsEl && currentTab === 'pinned') _pinnedSetLoading(msgsEl)

  try {
    const resp = await apiFetch('/api/messages/pinned')
    // Server returns { messages: [...] }; api_fetch proxy wraps as { ok, data: { messages } }
    const data = resp.ok ? resp.data || resp : {}
    pinnedMessages = Array.isArray(data) ? data : data.messages || []
    // Only latch on success — a failed fetch used to render the literal "no
    // pinned messages" and never retry.
    pinnedLoaded = resp.ok
  } catch (_) {
    pinnedMessages = []
    pinnedLoaded = false
  } finally {
    pinnedLoading = false
    if (currentTab === 'pinned') renderPinnedTab()
  }
}

function renderPinnedTab() {
  if (typeof activeProfileCard !== 'undefined' && activeProfileCard) return
  const msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl) return

  // Auto-refresh while viewing — no manual refresh button.
  startPinnedPolling()

  if (!pinnedLoaded && !pinnedLoading) {
    fetchPinned()
    return
  }
  if (pinnedLoading) {
    _pinnedSetLoading(msgsEl)
    return
  }

  msgsEl.textContent = ''
  const frag = document.createDocumentFragment()

  if (pinnedMessages.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'hs-mc-empty'
    empty.textContent = 'no pinned messages'
    frag.appendChild(empty)
    msgsEl.appendChild(frag)
    return
  }

  for (const m of pinnedMessages) {
    const id = m.base36_id || m.id || ''
    const channel = escapeHtml(m.channel || '')
    const user = escapeHtml(m.user || m.username || m.display_name || '')
    const content = escapeHtml(m.content || m.text || '')
    const ts = m.ts || m.created_at || m.timestamp || ''
    const timeStr = ts ? escapeHtml(new Date(ts).toLocaleString()) : ''

    const row = document.createElement('a')
    row.className = 'hs-pinned-row'
    if (id) {
      const url = safeUrl(`https://heatsync.org/m/${encodeURIComponent(id)}`)
      if (url) {
        row.href = url
        row.target = '_blank'
        row.rel = 'noopener noreferrer'
      }
    }

    const meta = document.createElement('div')
    meta.className = 'hs-pinned-meta'
    if (channel) {
      const channelSpan = document.createElement('span')
      channelSpan.className = 'hs-pinned-channel'
      channelSpan.textContent = channel
      meta.appendChild(channelSpan)
    }
    if (user) {
      const userSpan = document.createElement('span')
      userSpan.className = 'hs-pinned-user'
      userSpan.textContent = user
      meta.appendChild(userSpan)
    }
    if (timeStr) {
      const timeSpan = document.createElement('span')
      timeSpan.className = 'hs-pinned-time'
      timeSpan.textContent = timeStr
      meta.appendChild(timeSpan)
    }
    row.appendChild(meta)

    const body = document.createElement('div')
    body.className = 'hs-pinned-body'
    appendTextWithHashtags(body, content)
    row.appendChild(body)

    frag.appendChild(row)
  }

  msgsEl.appendChild(frag)
}

// Mod-action log tab — local-only history of ban/timeout/unban/delete actions
// (self + observed, all channels), newest-first. Streamers pop this out and
// drag it to a stream monitor. Data: modActionLog (main.js), recorded at the
// irc/kick message chokepoints. Render: safe createElement + textContent only
// (no innerHTML), mirroring renderPinnedTab; display strings from mod-log.js's
// unit-tested modLogLine().
function renderModLogTab() {
  if (typeof activeProfileCard !== 'undefined' && activeProfileCard) return
  const msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl) return
  msgsEl.textContent = ''
  const log = typeof modActionLog !== 'undefined' ? modActionLog : []
  if (!log.length) {
    const empty = document.createElement('div')
    empty.className = 'hs-mc-empty'
    empty.textContent = 'no mod actions yet'
    msgsEl.appendChild(empty)
    return
  }
  const frag = document.createDocumentFragment()
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]
    const row = document.createElement('div')
    row.className = `hs-modlog-row hs-modlog-${e.action || 'action'}`
    const time = document.createElement('span')
    time.className = 'hs-modlog-time'
    try {
      time.textContent = new Date(e.time || 0).toLocaleTimeString()
    } catch {
      time.textContent = ''
    }
    row.appendChild(time)
    if (e.channel) {
      const ch = document.createElement('span')
      ch.className = 'hs-modlog-channel'
      ch.textContent = e.channel
      row.appendChild(ch)
    }
    const body = document.createElement('span')
    body.className = 'hs-modlog-body'
    body.textContent = typeof modLogLine === 'function' ? modLogLine(e) : `${e.action} ${e.target}`
    row.appendChild(body)
    frag.appendChild(row)
  }
  msgsEl.appendChild(frag)
}

// ============================================
// FEED POST-LINK HOVER PREVIEW
// ============================================

// Lookup a feed message from in-memory stores, then fall back to API.
// Returns the message object or null. Fetches are deduped by id within
// the lifetime of a single hover (callers pass a generation counter).
const _feedMsgFetchCache = new Map() // id -> Promise<msg|null>

function _feedMsgLookupMemory(id) {
  if (!id) return null
  const fromFeed = feedMessages.find((m) => m.base36_id === id)
  if (fromFeed) return fromFeed
  if (activeThread) {
    if (activeThread.op?.base36_id === id) return activeThread.op
    const fromThread = activeThread.replies?.find((r) => r.base36_id === id)
    if (fromThread) return fromThread
  }
  return null
}

async function _feedMsgFetch(id) {
  if (!id) return null
  const mem = _feedMsgLookupMemory(id)
  if (mem) return mem
  if (_feedMsgFetchCache.has(id)) return _feedMsgFetchCache.get(id)
  const p = apiFetch(`/api/messages/${encodeURIComponent(id)}`)
    .then((r) => {
      // API returns the message directly in resp.data (not resp.data.message)
      if (!r.ok) return null
      const msg = r.data || null
      return msg?.base36_id ? msg : null
    })
    .catch(() => null)
  _feedMsgFetchCache.set(id, p)
  // Evict after 60s so stale data doesn't accumulate across sessions
  cleanup.setTimeout(() => _feedMsgFetchCache.delete(id), 60000)
  return p
}

async function _feedMsgFetchReplies(id) {
  if (!id) return []
  // Check activeThread first
  if (activeThread && activeThread.id === id && activeThread.replies?.length) {
    return activeThread.replies
  }
  const r = await apiFetch(`/api/messages/${encodeURIComponent(id)}/replies`)
  return r.ok ? r.data?.replies || [] : []
}

// Called once from feed init. Uses event delegation on document.body so it
// works for dynamically-rendered rows without re-wiring on each renderFeed().
function setupFeedPostLinkHover() {
  if (_onceGuardsSocial.feedPostLinkHoverSetup) return
  _onceGuardsSocial.feedPostLinkHoverSetup = true

  let _linkGen = 0
  let _currentLink = null
  const MAX_DEPTH = 50
  // Both inline >>id refs AND the leading thread-link (left of the OP) get the
  // same hover preview — a >>id is hoverable wherever it appears.
  const LINK_SEL = '.hs-post-link, .hs-feed-thread-link'

  const getOverlay = () => {
    let el = document.getElementById('hs-feed-postlink-preview')
    if (el) return el
    el = document.createElement('div')
    el.id = 'hs-feed-postlink-preview'
    document.body.appendChild(cleanup.trackNode(el))
    // Dismiss when cursor leaves the overlay itself
    el.addEventListener('mouseleave', (ev) => {
      // Only dismiss if not moving back into a post-link
      const to = ev.relatedTarget
      if (to?.closest?.(LINK_SEL)) return
      _hideOverlay()
    })
    return el
  }

  const _hideOverlay = () => {
    _currentLink = null
    const el = document.getElementById('hs-feed-postlink-preview')
    if (el) {
      el.style.display = 'none'
      el.replaceChildren()
    }
    _linkGen++
  }

  // Dismiss when #hs-mc-messages scrolls (capture phase catches it before msgsEl)
  document.addEventListener(
    'scroll',
    (ev) => {
      if (ev.target && ev.target.id === 'hs-mc-messages') _hideOverlay()
    },
    { passive: true, capture: true, signal: mcSignal },
  )

  document.body.addEventListener(
    'mouseover',
    (ev) => {
      const link = ev.target.closest?.(LINK_SEL)
      if (!link) return
      // Must be inside the feed panel
      if (!link.closest('#hs-mc-messages')) return
      if (link === _currentLink) return
      _currentLink = link

      const linkedId = link.dataset.id
      if (!linkedId) return

      const gen = ++_linkGen

      ;(async () => {
        // Always show on hover — even when the linked post is already on screen.
        // Matches the chat reply-stack and Twitch reply-thread hover (the user's
        // mental model): hovering >>id surfaces the thread context regardless of
        // visibility. (The site skips-if-visible; the cramped panel does not.)

        // Fetch the linked message
        const msg = await _feedMsgFetch(linkedId)
        if (_linkGen !== gen) return
        if (!msg) return

        // Walk ancestor chain (parents, above)
        const chain = [] // will be [oldest, ..., immediate-parent] after unshifts
        const seenUp = new Set([msg.base36_id || linkedId])
        let cur = msg
        while (chain.length < MAX_DEPTH && cur && cur.reply_to) {
          if (seenUp.has(cur.reply_to)) break
          seenUp.add(cur.reply_to)
          const parent = await _feedMsgFetch(cur.reply_to)
          if (_linkGen !== gen) return
          if (!parent) break
          chain.unshift(parent)
          cur = parent
        }

        // Walk first-child descendant chain (below)
        const descChain = []
        const seenDown = new Set([msg.base36_id || linkedId])
        let dCur = msg
        while (descChain.length < MAX_DEPTH) {
          if (_linkGen !== gen) return
          const parentId = dCur.base36_id
          if (!parentId) break
          // Check memory first (feedMessages + activeThread)
          let child = feedMessages.find((m) => m.reply_to === parentId) || null
          if (!child && activeThread?.replies) {
            child = activeThread.replies.find((r) => r.reply_to === parentId) || null
          }
          // Fall back to API replies
          if (!child) {
            const replies = await _feedMsgFetchReplies(parentId)
            if (_linkGen !== gen) return
            child = replies.length ? replies[0] : null
          }
          if (!child) break
          const childId = child.base36_id
          if (!childId || seenDown.has(childId)) break
          seenDown.add(childId)
          descChain.push(child)
          dCur = child
        }

        if (_linkGen !== gen) return

        // Build overlay
        const overlay = getOverlay()
        overlay.replaceChildren()
        overlay.style.display = 'block'

        // Render one row using buildFeedMessageDiv (handles sanitization + emotes)
        const renderRow = (m) => {
          const row = buildFeedMessageDiv(m)
          row.classList.add('hs-feed-postlink-preview-row')
          // Highlight the linked post itself
          if (m.base36_id === linkedId) row.classList.add('hs-feed-postlink-preview-linked')
          overlay.appendChild(row)
        }

        for (const ancestor of chain) renderRow(ancestor)
        renderRow(msg)
        for (const desc of descChain) renderRow(desc)

        // Position: bottom edge snug against link top, always-above, clamp to viewport
        const positionOverlay = () => {
          if (!overlay.parentNode) return
          const linkRect = link.getBoundingClientRect()
          const layoutH = document.documentElement.clientHeight
          const layoutW = document.documentElement.clientWidth

          // Bottom of overlay aligns to top of link
          const bottomFromBase = layoutH - linkRect.top
          overlay.style.bottom = `${bottomFromBase}px`
          overlay.style.top = ''

          // Max height: everything above the link (minus a small margin)
          const availableAbove = Math.max(0, linkRect.top - 4)
          overlay.style.maxHeight = `${availableAbove}px`

          // Horizontal: align left to link, clamp to viewport
          const overlayW = overlay.getBoundingClientRect().width
          let left = linkRect.left
          if (left + overlayW > layoutW - 4) left = layoutW - overlayW - 4
          if (left < 4) left = 4
          overlay.style.left = `${left}px`
        }

        // Wait for images before final positioning (emotes, avatars)
        const images = overlay.querySelectorAll('img')
        if (images.length > 0) {
          let pending = images.length
          const onLoad = () => {
            if (--pending <= 0) requestAnimationFrame(positionOverlay)
          }
          images.forEach((img) => {
            if (img.complete) {
              onLoad()
            } else {
              img.addEventListener('load', onLoad, { once: true })
              img.addEventListener('error', onLoad, { once: true })
            }
          })
          // Fallback: position after 120ms regardless
          cleanup.setTimeout(positionOverlay, 120)
        } else {
          requestAnimationFrame(() => requestAnimationFrame(positionOverlay))
        }
      })()
    },
    { signal: mcSignal },
  )

  document.body.addEventListener(
    'mouseout',
    (ev) => {
      const link = ev.target.closest?.(LINK_SEL)
      if (!link) return
      if (!link.closest('#hs-mc-messages')) return
      const to = ev.relatedTarget
      // Don't hide if moving into the overlay or another post-link
      const overlay = document.getElementById('hs-feed-postlink-preview')
      if (overlay?.contains(to)) return
      if (to?.closest?.(LINK_SEL)) return
      _hideOverlay()
    },
    { signal: mcSignal },
  )
}

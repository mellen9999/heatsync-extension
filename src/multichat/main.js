/**
 * Heatsync MultiChat - FFZ-style React-aware implementation
 *
 * KEY PRINCIPLE: Work WITHIN React, not around it.
 * - Never manipulate DOM after React renders
 * - Hook into React components and modify render output
 * - Use forceUpdate() to trigger re-renders
 * - Inject UI as React children, not DOM insertions
 */

(function() {
  'use strict';

  const STORAGE_KEY = 'heatsync_multichat';
  const LOG_PREFIX = '[heatsync-mc]';

  // bidi direction for the user's locale (ltr/rtl) — applied to injected UI roots
  // host page (twitch/kick) keeps its own dir; we only flip our overlay.
  // Resolved fresh on each panel mount so a manual locale override (set in options)
  // is reflected without a full page reload chain.
  function HS_DIR() {
    try { return (typeof bidiDir === 'function' ? bidiDir() : (chrome?.i18n?.getMessage?.('@@bidi_dir'))) || 'ltr' } catch { return 'ltr' }
  }

  const COLOR_RE = /^#[0-9a-fA-F]{3,6}$/

  // Reverse-lookup Map for config.channels — rebuilt on config changes.
  // .byId added so the dozens of `config.channels.find(c => c.id === X)`
  // calls scattered through the render path become O(1) instead of O(N).
  let _channelLookup = null
  function getChannelLookup() {
    if (_channelLookup) return _channelLookup
    _channelLookup = { twitch: new Map(), kick: new Map(), byId: new Map() }
    for (const ch of config.channels) {
      if (ch.twitch) _channelLookup.twitch.set(ch.twitch, ch)
      if (ch.kick) _channelLookup.kick.set(ch.kick, ch)
      if (ch.id) _channelLookup.byId.set(ch.id, ch)
    }
    return _channelLookup
  }
  function getChannelById(id) {
    if (id == null) return undefined
    return getChannelLookup().byId.get(id)
  }

  // Safe runtime.sendMessage wrapper (context invalidation guard, Firefox-compatible).
  // Retries on BG-unreachable — MV3 service workers sleep after ~30s idle, and a
  // full SW restart (crash, alarm-wake from longer idle) can take >2s. Backoffs
  // [100, 500, 2000]ms give ~2.6s total — catches cold-wake AND mid-restart.
  // Without this the first user action after BG-restart silently no-ops.
  // Context-invalidated still bails fast — _warnStorageMissing / the 2s
  // content-script detector triggers location.reload() within ~5s.
  const _SAFE_SEND_BACKOFFS_MS = [100, 500, 2000]
  function safeSendMessage(message) {
    return _trySendMessageOnce(message, 0)
  }
  async function _trySendMessageOnce(message, attempt) {
    try {
      return await api.runtime.sendMessage(message)
    } catch (e) {
      const err = e?.message || ''
      if (err.includes('Extension context invalidated')) {
        return { ok: false, error: 'context invalidated' }
      }
      if (attempt < _SAFE_SEND_BACKOFFS_MS.length &&
          (err.includes('Could not establish connection') || err.includes('Receiving end does not exist'))) {
        await new Promise(r => setTimeout(r, _SAFE_SEND_BACKOFFS_MS[attempt]))
        return _trySendMessageOnce(message, attempt + 1)
      }
      log('sendMessage failed:', err)
      return { ok: false, error: err }
    }
  }

  // State
  let config = { channels: [], enabled: true };
  let currentTab = 'feed';
  let prevTab = 'feed';
  let liveChannel = null;        // override channel for live tab (null = use URL channel)
  let livePlatformMap = {};      // per-URL-channel platform overrides: { [urlCh]: { twitch, kick, youtube } }
  let liveChannelSet = new Set(); // channels currently live (lowercase twitch names)
  // Channels we've already surfaced as "went live" this session. A channel can
  // only legitimately go off→on once per session — every later stream:online
  // for the same channel is a server re-broadcast (connect-snapshot, EventSub
  // re-subscribe, emote-add round-trip, etc.). Cleared by stream:offline so a
  // genuine re-go-live during a long session still shows.
  const sessionWentLiveSeen = new Set()
  // Content-script load time. Used as a connect-snapshot grace for the FIRST
  // stream:online emission per channel — sessionWentLiveSeen only catches the
  // second emission onward. SW WS auth + snapshot burst can take ~20-60s on
  // slow connects + cold SW boot; 30s wasn't enough (users saw 5+ "went live"
  // bursts on reload). 90s comfortably covers the slow path; a genuine
  // off→on transition during the grace is rare and resurfaces correctly on
  // the next /offline /online cycle.
  const mcStartedAt = Date.now()
  let irc = null;
  let kickChat = null;
  let currentUsername = null;
  let originalRender = null;
  let tabBarElement = null;
  let overlayElement = null;
  let inputBarElement = null;  // Separate input bar (always visible)
  let pendingMessage = '';     // Persists across tab switches
  let tabPosition = 'top'; // 'top', 'right', 'bottom', 'left'
  let resizeObserver = null; // Tracks overlay top sync observer
  let _updateMcLayout = () => {} // Set by ensureUIElements; callable from rotateTabPosition
  let _mcStorageListener = null;

  // Resize-drag safety net. Each resize handler (right-edge, content-region,
  // YT, Kick) sets document.body.style.cursor + appends an orange #hs-*-ghost
  // bar + a full-viewport overlay with cursor:ew-resize. If pointer capture
  // is lost (release-outside-window, captured-element removed mid-drag, tab
  // hidden), the per-handler endDrag never fires and the user is stuck with
  // a permanent ew-resize / col-resize cursor system-wide + an orange bar
  // floating in chat. Wire window-level abort on blur / hidden / focus-loss
  // so any orphaned drag artifacts get cleared even when pointerup is lost.
  // Tiny semver comparator for server-driven version-floor checks. Pads to
  // 3 parts, treats non-numeric as 0, accepts "1.2.3-foo" by stripping the
  // suffix. Returns true iff a < b. Strict-enough for kill-switch decisions.
  function _hsSemverLt(a, b) {
    const norm = (s) => String(s || '0').split('-')[0].split('.').slice(0, 3)
      .map(x => parseInt(x, 10) || 0).concat([0,0,0]).slice(0, 3)
    const A = norm(a), B = norm(b)
    for (let i = 0; i < 3; i++) {
      if (A[i] < B[i]) return true
      if (A[i] > B[i]) return false
    }
    return false
  }

  function _hsAbortAllResizes() {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    for (const id of [
      'hs-resize-ghost', 'hs-resize-overlay',
      'hs-c-resize-ghost', 'hs-c-resize-overlay',
      'hs-yt-resize-ghost', 'hs-yt-resize-overlay',
      'hs-kick-resize-ghost', 'hs-kick-resize-overlay'
    ]) document.getElementById(id)?.remove()
  }
  cleanup.addEventListener(window, 'blur', _hsAbortAllResizes)
  cleanup.addEventListener(document, 'visibilitychange', () => {
    if (document.hidden) _hsAbortAllResizes()
    // Pause our infinite breathe/livedot CSS animations while the tab is
    // hidden — no paint happens, so running them is pure wasted style recalc on
    // low-end hardware. The matching rules live in styles.js (body.hs-ext-hidden).
    try { document.body.classList.toggle('hs-ext-hidden', document.hidden) } catch (_) {}
  })

  // Muted users (right-click to hide) — loaded async from chrome.storage.local
  let mutedUsers = new Set();
  // Blocked users (right-click → block) — fully hidden, not just stripped like mute.
  // Synced with background's block_user/unblock_user (shared with content.js).
  let blockedUsers = new Set();

  // ─── User-key aliasing ─── When a Kick chatter has a 7TV-linked Twitch
  // handle (kickNameToTwitchUsername populated by the cosmetics pipeline),
  // mute/block actions fan out to BOTH names. So one mute on a Kick chatter
  // also silences them when they post on Twitch, and vice-versa. Unmute
  // mirrors. mentionAliases (mentions.js) covers the inverse for YOUR own
  // identity already.
  function getUserAliases(username, platform) {
    const u = String(username || '').toLowerCase()
    if (!u) return []
    const out = [u]
    // Kick→Twitch: only direction we have a map for. Reverse (twitch→kick)
    // would need a separate cache populated from kick-side lookups; not built
    // because we'd be guessing kick handles for every Twitch chatter.
    if (typeof kickNameToTwitchUsername !== 'undefined') {
      const tw = kickNameToTwitchUsername.get(u)
      if (tw && tw.toLowerCase() !== u) out.push(tw.toLowerCase())
    }
    return out
  }

  function isUserMuted(username, platform) {
    // Called per-message in the append/build hot path. The common case is an
    // empty mute set — short-circuit before getUserAliases allocates an array
    // and lowercases for a guaranteed-false result.
    if (!username || mutedUsers.size === 0) return false
    for (const a of getUserAliases(username, platform)) {
      if (mutedUsers.has(a)) return true
    }
    return false
  }

  function isUserBlocked(username, platform) {
    if (!username || blockedUsers.size === 0) return false
    for (const a of getUserAliases(username, platform)) {
      if (blockedUsers.has(a)) return true
    }
    return false
  }

  // Active settings sub-tab — persisted across re-renders
  let _settingsSubtab = 'display';
  // Content-warning filters live entirely in the settings registry (schema
  // entries with a `cw` sub-shape); _mcStorageListener's generic local-key
  // loop keeps the cache + visible pills coherent cross-tab.

  // Per-tab platform filters: { [tabId]: { twitch, kick, youtube } }, defaults all true
  let platformFilters = {};


  // Channel point redeem title cache: rewardId → { title, cost }
  const redeemTitleMap = new Map();

  // Buffers
  const mentionsBuffer = [];
  const MAX_BUFFER = 500;

  // Max chat rows kept as live DOM. Decoupled from the data buffers (ring
  // buffer 1500, persist 1500) which stay large for scrollback-data, sync and
  // reload restore — those are cheap plain objects. The DOM cap is the
  // expensive axis (~6 nodes/row), so we render far fewer than we remember.
  // content-visibility:auto already skips paint/layout for off-screen rows;
  // this trims the node count itself (~9.3k → ~3k nodes at a busy channel).
  // 500 unifies the whole system (MAX_BUFFER, TAB_CACHE_DOM_CAP) on one number
  // and matches the per-platform buffer, so a restored cached tab never exceeds
  // the cap. ~3.3x Twitch native scrollback.
  let DOM_RENDER_CAP = 500; // registry-managed (hs_dom_render_cap)

  // Upward scrollback: extra rows beyond DOM_RENDER_CAP to paint when the user
  // reaches the top. 0 = live tail only (DEFAULT — behaviour is byte-identical
  // to a plain cap; the feature is inert until the user scrolls up). Grows in
  // SCROLLBACK_STEP chunks up to SCROLLBACK_MAX total rendered rows, drawn from
  // the existing 3000-deep ring buffer (no network — just paint more of what's
  // already buffered). Reset to 0 on tab switch / channel nav / jump-to-bottom
  // so the DOM never stays bloated past the live tail.
  let _scrollbackWindow = 0;
  const SCROLLBACK_STEP = 250;
  const SCROLLBACK_MAX = 1500; // hard ceiling on rendered rows (3x the live cap)

  let isKick = location.hostname.includes('kick.com');
  const hostPlatform = isKick ? 'kick' : location.hostname.includes('youtube.com') ? 'yt' : 'twitch';

  // Scoped emote wrapper query (avoids full-document scan).
  // Includes the reply-stack overlays — they're appended to <body>, not inside
  // #hs-mc-overlay, so without these roots the hover-highlight never lands on
  // overlay-rendered emotes (and same-name cross-highlight misses overlay copies).
  function queryEmoteWrappers(emoteName) {
    const sel = `.hs-mc-emote-wrapper[data-emote-name="${CSS.escape(emoteName)}"]`
    const main = document.getElementById('hs-mc-overlay')
    const stackUp = document.getElementById('hs-mc-reply-stack')
    const stackDown = document.getElementById('hs-mc-reply-stack-down')
    if (!main && !stackUp && !stackDown) return document.querySelectorAll(sel)
    const out = []
    if (main) for (const w of main.querySelectorAll(sel)) out.push(w)
    if (stackUp) for (const w of stackUp.querySelectorAll(sel)) out.push(w)
    if (stackDown) for (const w of stackDown.querySelectorAll(sel)) out.push(w)
    return out
  }

  // Batch-remove excess children using a Range (single reflow instead of N)
  function trimChildren(el, limit) {
    const excess = el.children.length - limit
    if (excess > 0) {
      const range = document.createRange()
      range.setStartBefore(el.firstChild)
      range.setEndBefore(el.children[excess])
      range.deleteContents()
    }
  }

  // ============================================
  // MESSAGE-LIST DOM INDICES
  // Replace per-message O(n) DOM scans (dedup, cosmetic repaint, mention paint)
  // with O(1) Set/Map lookups. At 100 msgs/sec × 500 children, this collapses
  // ~50k DOM reads/sec to a handful.
  //   _msgKeyIndex   : Set<msgKeyStr> — appendMessage dedup
  //   _uidIndex      : Map<uid, Set<HTMLElement>> — sender msg divs by userId
  //   _mentionIndex  : Map<uid, Set<HTMLElement>> — inline @mention anchors
  // All three MUST be kept in sync with #hs-mc-messages children. Every code
  // path that adds/removes a message div has to call indexAdd / indexRemove.
  // ============================================
  const _msgKeyIndex = new Set()
  const _uidIndex = new Map()
  const _mentionIndex = new Map()

  function _indexMessageDiv(div, msgKeyStr) {
    if (!div) return
    if (msgKeyStr) _msgKeyIndex.add(msgKeyStr)
    const uid = div.dataset?.uid
    if (uid) {
      let s = _uidIndex.get(uid)
      if (!s) { s = new Set(); _uidIndex.set(uid, s) }
      s.add(div)
    }
    // Inline mentions inside this msg — cache on div for O(1) unindex on trim.
    let mentions = div._hsMentionEls
    if (!mentions) {
      mentions = [...div.querySelectorAll('a.hs-mc-mention[data-uid], a.hs-mc-reply-user[data-uid]')]
      div._hsMentionEls = mentions
    }
    for (const m of mentions) {
      const muid = m.dataset.uid
      if (!muid) continue
      let ms = _mentionIndex.get(muid)
      if (!ms) { ms = new Set(); _mentionIndex.set(muid, ms) }
      ms.add(m)
    }
  }

  function _unindexMessageDiv(div) {
    if (!div) return
    const k = div.dataset?.msgKey
    if (k) _msgKeyIndex.delete(k)
    const uid = div.dataset?.uid
    if (uid) {
      const s = _uidIndex.get(uid)
      if (s) { s.delete(div); if (!s.size) _uidIndex.delete(uid) }
    }
    const mentions = div._hsMentionEls || div.querySelectorAll('a.hs-mc-mention[data-uid], a.hs-mc-reply-user[data-uid]')
    for (const m of mentions) {
      const muid = m.dataset.uid
      if (!muid) continue
      const ms = _mentionIndex.get(muid)
      if (ms) { ms.delete(m); if (!ms.size) _mentionIndex.delete(muid) }
    }
  }

  function _clearMessageIndices() {
    _msgKeyIndex.clear()
    _uidIndex.clear()
    _mentionIndex.clear()
  }

  // Trim variant that maintains the indices. Use anywhere we trim
  // #hs-mc-messages — never call trimChildren directly on that element.
  function trimMessagesEl(el, limit) {
    const excess = el.children.length - limit
    if (excess <= 0) return
    // Unindex JS-side maps first, then batch DOM removal via Range — one tree
    // mutation instead of N .remove() calls. At 1000 msg/min trim cycles, this
    // collapses N layout-tree updates into one.
    for (let i = 0; i < excess; i++) {
      _unindexMessageDiv(el.children[i])
    }
    if (excess >= el.children.length) {
      el.replaceChildren()
      return
    }
    const range = document.createRange()
    range.setStartBefore(el.firstChild)
    range.setEndBefore(el.children[excess])
    range.deleteContents()
    range.detach?.()
  }

  // ============================================
  // PER-TAB DOM CACHE — flash-free tab/channel switches
  // Snapshot the active tab's children + indexes into a DocumentFragment when
  // leaving; restore when returning. New messages arriving for an inactive tab
  // append to its cached fragment so on switch-back the content is already
  // up-to-date — no teardown→rebuild cycle, no image-load flicker, no zebra
  // resettle.
  // ============================================
  const _tabCache = new Map() // tabId → { frag, msgKeyIndex, uidIndex, mentionIndex }
  const TAB_CACHE_DOM_CAP = 500
  try { document.documentElement.dataset.hsTabCacheV1 = '1' } catch {}

  function _isChatTab(id) {
    if (!id) return false
    if (id === 'live' || id === 'mentions') return true
    if (id === 'feed' || id === 'whispers' || id === 'discover' ||
        id === 'pinned' || id === 'settings' || id === 'add') return false
    return true // per-channel tab
  }

  function _dropTabCache(tabId) {
    _tabCache.delete(tabId)
  }

  function _dropAllTabCaches() {
    _tabCache.clear()
  }

  // True when #hs-mc-messages is empty (cold start) or holds only the empty
  // placeholder. Used by history-hydration paths to skip a wipe+rebuild render
  // when the chat is already populated — that rebuild reloads every avatar/
  // emote/badge image and looks to the user like a flash on streamer switch.
  // Live messages will append organically; the 500-cap rolls out stale msgs.
  function isMsgsElEmpty() {
    const el = document.getElementById('hs-mc-messages')
    if (!el) return true
    if (el.children.length === 0) return true
    if (el.children.length === 1 && el.firstElementChild?.classList?.contains('hs-mc-empty')) return true
    return false
  }

  function snapshotTabState(tabId) {
    if (!_isChatTab(tabId)) return
    const msgsEl = document.getElementById('hs-mc-messages')
    if (!msgsEl) return
    if (!msgsEl.firstChild) {
      _tabCache.delete(tabId)
      return
    }
    // Capture scroll state BEFORE detaching children — once moved to a frag
    // the host's scrollHeight resets to 0 and the snapshot is useless.
    const scrollTop = msgsEl.scrollTop
    const scrollHeight = msgsEl.scrollHeight
    const clientHeight = msgsEl.clientHeight
    const atBottom = !isScrolledUp || (scrollHeight - clientHeight - scrollTop) < 8
    const frag = document.createDocumentFragment()
    while (msgsEl.firstChild) frag.appendChild(msgsEl.firstChild)
    const msgKeyIndex = new Set(_msgKeyIndex)
    const uidIndex = new Map()
    for (const [k, v] of _uidIndex) uidIndex.set(k, new Set(v))
    const mentionIndex = new Map()
    for (const [k, v] of _mentionIndex) mentionIndex.set(k, new Set(v))
    _tabCache.set(tabId, {
      frag, msgKeyIndex, uidIndex, mentionIndex,
      scrollTop, scrollHeight, clientHeight, atBottom,
      isScrolledUp, newMessageCount,
    })
    _msgKeyIndex.clear()
    _uidIndex.clear()
    _mentionIndex.clear()
  }

  // Set true by restoreTabState, consumed by renderMessages on the next
  // call. Tells the renderer "trust the mounted DOM — don't remove or
  // reorder existing children, only append msgs that aren't there yet."
  // Without this gate, a fair-merge proportion shift after new msgs
  // arrived during the user's absence triggers visible reshuffles.
  let _cacheJustRestored = false

  function restoreTabState(tabId) {
    _msgKeyIndex.clear()
    _uidIndex.clear()
    _mentionIndex.clear()
    if (!_isChatTab(tabId)) return false
    const cache = _tabCache.get(tabId)
    if (!cache) return false
    const msgsEl = document.getElementById('hs-mc-messages')
    if (!msgsEl) return false
    msgsEl.appendChild(cache.frag)
    _cacheJustRestored = true
    for (const k of cache.msgKeyIndex) _msgKeyIndex.add(k)
    for (const [k, v] of cache.uidIndex) _uidIndex.set(k, new Set(v))
    for (const [k, v] of cache.mentionIndex) _mentionIndex.set(k, new Set(v))
    // Restore scroll state. If the user was at-bottom, re-pin to bottom (new
    // arrivals appended while detached push the bottom further down). If they
    // were scrolled up reading old msgs, restore exact scrollTop and the
    // newMessageCount badge so the resume context is preserved.
    const newBtn = document.getElementById('hs-mc-new-msgs')
    if (cache.atBottom) {
      isScrolledUp = false
      newMessageCount = 0
      if (newBtn) newBtn.style.display = 'none'
      // Defer scroll to after layout flush so scrollHeight reflects appended frag
      cleanup.raf(() => { try { msgsEl.scrollTop = msgsEl.scrollHeight + 10000 } catch {} })
    } else {
      isScrolledUp = true
      newMessageCount = cache.newMessageCount || 0
      if (newBtn) {
        if (newMessageCount > 0) {
          newBtn.replaceChildren()
          const arrow = document.createElement('span')
          arrow.className = 'hs-arrow-down'
          arrow.textContent = '▼'
          newBtn.append(arrow, ' ' + String(newMessageCount) + ' new')
          newBtn.style.display = 'flex'
        } else {
          newBtn.style.display = 'none'
        }
      }
      cleanup.raf(() => { try { msgsEl.scrollTop = cache.scrollTop } catch {} })
    }
    _tabCache.delete(tabId) // entry is now empty (children moved out); next snapshot rebuilds
    return true
  }

  // Fan a stream event into every inactive tab whose channel matches, so
  // their caches stay hot. Active tab is handled by the caller's normal
  // appendMessage path.
  function fanStreamEventToCaches(evt, channel) {
    if (!evt || !channel) return
    const ch = String(channel).toLowerCase()
    try {
      if (currentTab !== 'live' && typeof isLiveChannelMessage === 'function' && isLiveChannelMessage({ channel: ch })) {
        appendToCachedTab(evt, 'live')
      }
    } catch {}
    if (!Array.isArray(config?.channels)) return
    for (const c of config.channels) {
      if (!c?.id || c.id === currentTab) continue
      const tw = c.twitch?.toLowerCase()
      const ki = c.kick?.toLowerCase()
      if (tw === ch || ki === ch) appendToCachedTab(evt, c.id)
    }
  }

  // Append a message to a tab that's NOT currently visible. Builds the div,
  // inserts into the cached fragment, maintains cached indexes + cap.
  // Returns true if cached, false if no cache exists (no-op — buffer holds it,
  // first switch into the tab will full-build).
  function appendToCachedTab(msg, tabId) {
    if (!_isChatTab(tabId)) return false
    if (tabId === currentTab) return false // active tab uses appendMessage
    const cache = _tabCache.get(tabId)
    if (!cache) return false
    // Multi-platform tabs need fairMerge — raw appends break proportional
    // interleave. Drop the cache; force full rebuild on next visit.
    try { if (typeof isMultiPlatformTab === 'function' && isMultiPlatformTab(tabId)) { _tabCache.delete(tabId); return true } } catch {}
    if (msg.platform && typeof isPlatformFilterTab === 'function' && isPlatformFilterTab(tabId)) {
      const k = msg.platform === 'youtube' ? 'youtube' : msg.platform
      try { if (getPlatformFilter(tabId)[k] === false) return true } catch {}
    }
    const msgKeyStr = `${_renderEpoch}:${stableMsgId(msg)}`
    if (cache.msgKeyIndex.has(msgKeyStr)) return true
    let div
    try { div = buildMessageDiv(msg, tabId) } catch { return false }
    if (!div) return false
    div.dataset.msgKey = msgKeyStr
    if (zebraEnabled && msg.type !== 'stream-event' && msg.type !== 'feed-post' && msg.type !== 'inline-dm' && msg.type !== 'moment') {
      const prev = cache.frag.lastElementChild
      const prevZ = prev?.classList.contains('hs-mc-zebra') === true
      if (!prevZ) div.classList.add('hs-mc-zebra')
    }
    cache.frag.appendChild(div)
    cache.msgKeyIndex.add(msgKeyStr)
    const uid = div.dataset?.uid
    if (uid) {
      let s = cache.uidIndex.get(uid)
      if (!s) { s = new Set(); cache.uidIndex.set(uid, s) }
      s.add(div)
    }
    let mentions = div._hsMentionEls
    if (!mentions) {
      mentions = [...div.querySelectorAll('a.hs-mc-mention[data-uid], a.hs-mc-reply-user[data-uid]')]
      div._hsMentionEls = mentions
    }
    for (const m of mentions) {
      const muid = m.dataset.uid
      if (!muid) continue
      let ms = cache.mentionIndex.get(muid)
      if (!ms) { ms = new Set(); cache.mentionIndex.set(muid, ms) }
      ms.add(m)
    }
    while (cache.frag.children.length > TAB_CACHE_DOM_CAP) {
      const old = cache.frag.firstElementChild
      if (!old) break
      const oldKey = old.dataset?.msgKey
      if (oldKey) cache.msgKeyIndex.delete(oldKey)
      const oldUid = old.dataset?.uid
      if (oldUid) {
        const s = cache.uidIndex.get(oldUid)
        if (s) { s.delete(old); if (!s.size) cache.uidIndex.delete(oldUid) }
      }
      const oldMentions = old._hsMentionEls || old.querySelectorAll('a.hs-mc-mention[data-uid], a.hs-mc-reply-user[data-uid]')
      for (const m of oldMentions) {
        const muid = m.dataset.uid
        if (!muid) continue
        const ms = cache.mentionIndex.get(muid)
        if (ms) { ms.delete(m); if (!ms.size) cache.mentionIndex.delete(muid) }
      }
      old.remove()
    }
    return true
  }

  // mentionsSeenCount removed — mentions unread is now driven by
  // seen-state.js (server-backed seenAt.mentions vs client-tracked
  // latestAt.mentions). See bumpSeen('mentions') / noteSeenEvent('mentions').

  // Per-channel YouTube: messages and links
  const channelYtMessages = new Map();  // channelTabId → message[]
  const youtubeLinks = new Map();       // channelTabId → { url, videoId, channelName }
  // YouTube watchdog state — per-channel last activity + rejoin escalation count.
  // Mirrors the kick/twitch watchdogs: catches the case where the heatsync
  // server's YT poller dies for one video without taking down the WS, so
  // global metrics look fine but one channel goes silent.
  const ytChanLastSeen = new Map();        // channelId -> ms
  const ytChanRejoinAttempts = new Map();  // channelId -> escalation count
  const ytSubscribedUrls = new Map();      // channelId -> last-known sub URL
  function touchYtChannel(channelId) {
    if (!channelId) return;
    ytChanLastSeen.set(channelId, Date.now());
    if (ytChanRejoinAttempts.size) ytChanRejoinAttempts.delete(channelId);
  }

  // ============================================
  // PERSISTED BUFFERS — survives page reload
  // mentions + per-channel YT messages + per-tab seen-time, mirroring the
  // IRC/Kick reload-bulletproofing in irc.js. chrome.storage.local writes are
  // debounced 1.5s; localStorage takes a synchronous tail backup on pagehide
  // to close the debounce gap that survives a reload mid-burst.
  // ============================================
  const PERSIST_DEBOUNCE_MS = 1500
  const PERSIST_MAX_MENTIONS = 200
  const PERSIST_MAX_YT = 500
  const PERSIST_SYNC_MAX = 100
  const _persistMentionsState = { timer: null, dirty: false }
  const _persistYtTimers = new Map()      // channelId -> timer
  const _persistYtDirty = new Set()       // channelIds with unflushed messages
  let _persistTabSeenTimer = null
  const tabSeenAt = {}                    // tabId -> ms

  function _serializePersistMsg(m) {
    return {
      user: m.user, userId: m.userId, text: m.text, color: m.color,
      badges: m.badges, channel: m.channel, time: m.time, id: m.id,
      platform: m.platform || undefined,
      isAction: m.isAction || undefined, replyTo: m.replyTo || undefined,
      type: m.type || undefined, msgId: m.msgId || undefined,
      isHighlighted: m.isHighlighted || undefined,
      avatar: m.avatar || undefined,
      msgType: m.msgType || undefined, amount: m.amount || undefined,
      systemMsg: m.systemMsg || undefined,
      sticker: m.sticker || undefined,
      scColor: m.scColor || undefined,
      emotes: m.emotes || undefined,
      subMonths: m.subMonths || undefined,
      streakCount: m.streakCount || undefined
    }
  }

  function persistMentions() {
    _persistMentionsState.dirty = true
    if (_persistMentionsState.timer) return
    _persistMentionsState.timer = cleanup.setTimeout(() => {
      _persistMentionsState.timer = null
      _persistMentionsState.dirty = false
      try {
        if (!chrome?.runtime?.id) return
        const msgs = mentionsBuffer.slice(-PERSIST_MAX_MENTIONS).map(_serializePersistMsg)
        const p = chrome.storage.local.set({ hs_mentions_v2: { msgs, ts: Date.now() } })
        if (p && typeof p.catch === 'function') p.catch(() => {})
      } catch {}
    }, PERSIST_DEBOUNCE_MS)
  }

  function persistYt(channelId) {
    if (!channelId) return
    _persistYtDirty.add(channelId)
    if (_persistYtTimers.has(channelId)) return
    _persistYtTimers.set(channelId, cleanup.setTimeout(() => {
      _persistYtTimers.delete(channelId)
      _persistYtDirty.delete(channelId)
      try {
        if (!chrome?.runtime?.id) return
        const buf = channelYtMessages.get(channelId)
        if (!buf) return
        const msgs = buf.slice(-PERSIST_MAX_YT).map(_serializePersistMsg)
        const p = chrome.storage.local.set({ [`hs_yt_${channelId}`]: { msgs, ts: Date.now() } })
        if (p && typeof p.catch === 'function') p.catch(() => {})
      } catch {}
    }, PERSIST_DEBOUNCE_MS))
  }

  function _persistTabSeenSoon() {
    if (_persistTabSeenTimer) return
    _persistTabSeenTimer = cleanup.setTimeout(() => {
      _persistTabSeenTimer = null
      try {
        if (!chrome?.runtime?.id) return
        chrome.storage.local.set({ hs_tab_seen_v1: { ...tabSeenAt } })
      } catch {}
    }, 500)
  }

  function markTabSeen(tabId) {
    if (!tabId) return
    tabSeenAt[tabId] = Date.now()
    _persistTabSeenSoon()
  }

  function _flushPersistenceSync() {
    try {
      if (_persistMentionsState.dirty) {
        const msgs = mentionsBuffer.slice(-PERSIST_SYNC_MAX).map(_serializePersistMsg)
        localStorage.setItem('hs_mentions_sync', JSON.stringify({ msgs, ts: Date.now() }))
      }
      for (const channelId of _persistYtDirty) {
        const buf = channelYtMessages.get(channelId)
        if (!buf) continue
        const msgs = buf.slice(-PERSIST_SYNC_MAX).map(_serializePersistMsg)
        localStorage.setItem(`hs_yt_sync_${channelId}`, JSON.stringify({ msgs, ts: Date.now() }))
      }
      if (_persistTabSeenTimer) {
        localStorage.setItem('hs_tab_seen_sync', JSON.stringify({ data: { ...tabSeenAt }, ts: Date.now() }))
      }
    } catch {}
  }

  window.addEventListener('pagehide', _flushPersistenceSync, { signal: mcSignal })

  async function restorePersistedBuffers() {
    try {
      const seenRes = await chrome.storage.local.get('hs_tab_seen_v1')
      if (seenRes.hs_tab_seen_v1 && typeof seenRes.hs_tab_seen_v1 === 'object') {
        Object.assign(tabSeenAt, seenRes.hs_tab_seen_v1)
      }
      try {
        const raw = localStorage.getItem('hs_tab_seen_sync')
        if (raw) {
          const data = JSON.parse(raw)
          if (data?.data && Date.now() - data.ts < 86400000) {
            for (const [k, v] of Object.entries(data.data)) {
              if (typeof v === 'number' && (!tabSeenAt[k] || v > tabSeenAt[k])) tabSeenAt[k] = v
            }
          }
        }
      } catch {}

      let mChrome = null, mSync = null
      try {
        const r = await chrome.storage.local.get('hs_mentions_v2')
        if (r.hs_mentions_v2?.msgs?.length > 0 && Date.now() - r.hs_mentions_v2.ts < 86400000) {
          mChrome = r.hs_mentions_v2.msgs
        }
      } catch {}
      try {
        const raw = localStorage.getItem('hs_mentions_sync')
        if (raw) {
          const data = JSON.parse(raw)
          if (data?.msgs?.length > 0 && Date.now() - data.ts < 86400000) mSync = data.msgs
        }
      } catch {}
      if (mChrome || mSync) {
        const byId = new Map()
        const noId = []
        const ingest = (a) => { if (!a) return; for (const m of a) { if (m.id) byId.set(m.id, m); else noId.push(m) } }
        ingest(mChrome); ingest(mSync)
        const merged = [...byId.values(), ...noId].sort((a, b) => (a.time || 0) - (b.time || 0))
        for (const m of merged) {
          m.isHistory = true
          mentionsBuffer.push(m)
        }
        if (mentionsBuffer.length > PERSIST_MAX_MENTIONS) {
          mentionsBuffer.splice(0, mentionsBuffer.length - PERSIST_MAX_MENTIONS)
        }
        log('Restored mentions:', mentionsBuffer.length, 'chrome:' + (mChrome?.length || 0), 'sync:' + (mSync?.length || 0))
      }

      try {
        const all = await chrome.storage.local.get(null)
        // Self-heal: only YT-linked channels keep persisted YT history. Buffers
        // left behind by the old @<name>/live bleed (see
        // [[heatsync_yt_handle_guess_bleed]]) live under channels that carry NO
        // youtube link — restoring them resurfaces a stranger's chat on every
        // reload. Collect those and purge their storage so they stop coming back.
        // Gate the purge on config having loaded channels, so a transient
        // loadConfig failure can't mass-delete legit YT history.
        const configLoaded = Array.isArray(config?.channels) && config.channels.length > 0
        const staleYtIds = []
        for (const [k, v] of Object.entries(all)) {
          if (!k.startsWith('hs_yt_') || k.startsWith('hs_yt_sync_')) continue
          const channelId = k.slice('hs_yt_'.length)
          if (!channelId) continue
          const hasYtLink = configLoaded &&
            config.channels.some(c => c && c.id === channelId && c.youtube)
          if (!hasYtLink) { if (configLoaded) staleYtIds.push(channelId); continue }
          if (!v?.msgs?.length || Date.now() - v.ts >= 86400000) continue
          if (!channelYtMessages.has(channelId)) channelYtMessages.set(channelId, [])
          const buf = channelYtMessages.get(channelId)
          let syncMsgs = null
          try {
            const raw = localStorage.getItem(`hs_yt_sync_${channelId}`)
            if (raw) {
              const data = JSON.parse(raw)
              if (data?.msgs?.length > 0 && Date.now() - data.ts < 86400000) syncMsgs = data.msgs
            }
          } catch {}
          const seen = new Set()
          const ingest = (arr) => {
            if (!arr) return
            for (const m of arr) {
              const key = `${m.user || ''}|${m.time || 0}|${(m.text || '').slice(0, 80)}`
              if (seen.has(key)) continue
              seen.add(key)
              m.isHistory = true
              buf.push(m)
            }
          }
          ingest(v.msgs); ingest(syncMsgs)
          buf.sort((a, b) => (a.time || 0) - (b.time || 0))
          if (buf.length > PERSIST_MAX_YT) buf.splice(0, buf.length - PERSIST_MAX_YT)
        }
        if (staleYtIds.length) {
          try { await chrome.storage.local.remove(staleYtIds.map(id => `hs_yt_${id}`)) } catch {}
          for (const id of staleYtIds) {
            try { localStorage.removeItem(`hs_yt_sync_${id}`) } catch {}
            try { channelYtMessages.delete(id) } catch {}
          }
          log('Purged stale YT buffers (channel has no YT link):', staleYtIds.join(','))
        }
      } catch {}
    } catch (e) {
      log('restorePersistedBuffers failed:', e?.message)
    }
  }

  // After buffers + irc/kick history have hydrated, walk every tab and add
  // has-new / has-mentions if any buffered msg time > tabSeenAt[tabId].
  // Special tabs (mentions/whispers/feed) are managed by seen-state.js so
  // they're skipped here.
  function applyUnreadIndicatorsFromPersist() {
    if (!tabBarElement) return
    const tabs = tabBarElement.querySelectorAll('.hs-mc-tab[data-tab]')
    const SPECIAL = new Set(['mentions', 'whispers', 'feed', 'discover', 'pinned',
                             'add', 'settings', 'live'])
    for (const tabEl of tabs) {
      const tabId = tabEl.dataset.tab
      if (!tabId || tabId === currentTab) continue
      if (SPECIAL.has(tabId)) continue
      const seen = tabSeenAt[tabId] || 0
      if (!seen) continue  // first-time view of this tab — don't spuriously light up
      const ch = getChannelById(tabId)
      if (!ch) continue
      let maxTime = 0
      let hasMention = false
      const scan = (arr) => {
        if (!arr) return
        for (const m of arr) {
          const t = m.time || 0
          if (t > maxTime) maxTime = t
          if (t > seen) {
            try { if (isMention(m)) hasMention = true } catch {}
          }
        }
      }
      if (ch.twitch && irc?.channels?.has(ch.twitch.toLowerCase())) {
        scan(irc.channels.get(ch.twitch.toLowerCase()).getAll())
      }
      if (ch.kick && kickChat?.channels?.has(ch.kick.toLowerCase())) {
        scan(kickChat.channels.get(ch.kick.toLowerCase()).getAll())
      }
      scan(channelYtMessages.get(tabId))
      if (maxTime > seen) {
        tabEl.classList.add('has-new')
        if (hasMention) tabEl.classList.add('has-mentions')
      }
    }
  }

  // YouTube global state (per-channel only now — global removed)

  // Third-party cosmetics state (BTTV/FFZ/Chatterino badges, 7TV paints+badges)
  let mcBttvBadgeMap = new Map()
  let mcFfzBadgeMap = new Map()
  let mcChatterinoBadgeMap = new Map()
  const mcUserCosmetics = new Map()
  // A channel buffer renders ~1500-2000 distinct users; caps below must clear
  // that or a full-buffer rebuild silently drops most cosmetic lookups. (500/100
  // meant switching to a busy/restored channel resolved only the first ~100
  // users — everyone after, paints included, rendered plain.)
  const MC_COSMETICS_MAX = 3000
  function setMcCosmetic(uid, c) {
    mcUserCosmetics.set(uid, c)
    if (mcUserCosmetics.size > MC_COSMETICS_MAX) {
      mcUserCosmetics.delete(mcUserCosmetics.keys().next().value)
    }
  }
  const MC_COSMETICS_PENDING_MAX = 3000
  const mcCosmeticsPending = new Set()
  let mcCosmeticsTimer = null

  // Username cache for tab completion — LRU-capped (Set preserves insertion order)
  const usernameCache = new Set();
  const USERNAME_CACHE_MAX = 5000
  function addUsername(name) {
    if (!name) return
    if (usernameCache.has(name)) {
      usernameCache.delete(name)
      usernameCache.add(name)
      return
    }
    usernameCache.add(name)
    if (usernameCache.size > USERNAME_CACHE_MAX) {
      const iter = usernameCache.values()
      for (let i = 0; i < 500; i++) usernameCache.delete(iter.next().value)
    }
  }
  // Username → color map for @mention coloring (LRU-bounded)
  const knownColors = new Map()
  // Username → Twitch userId for paint cosmetics on @mentions
  const knownUserIds = new Map()
  function setKnownColor(user, color, userId) {
    knownColors.set(user, color)
    if (knownColors.size > 2000) {
      const iter = knownColors.keys()
      for (let i = 0; i < 500; i++) knownColors.delete(iter.next().value)
    }
    if (userId) {
      knownUserIds.set(user, userId)
      if (knownUserIds.size > 2000) {
        const iter = knownUserIds.keys()
        for (let i = 0; i < 500; i++) knownUserIds.delete(iter.next().value)
      }
    }
  }
  // Avatar URL cache: username → CDN URL (fetched from decapi)
  const avatarCache = new Map()
  const avatarFetching = new Set() // prevent duplicate fetches
  let _activeAvatarFetches = 0
  const MAX_AVATAR_FETCHES = 5
  // Neutral initials avatar. Renders immediately so the fixed 18px avatar box
  // is reserved from first paint — the real pfp (fetched async via decapi for
  // twitch, carried inline for yt, absent for kick) then swaps in IN PLACE with
  // zero layout shift instead of popping the row sideways on arrival. A failed
  // or absent fetch simply stays as the initial — no blank gap. `withDataUser`
  // tags the twitch placeholder so fetchAvatar can find and replace it.
  function avatarFallbackHtml(user, key, withDataUser) {
    const initial = (user || '?').charAt(0).toUpperCase()
    const palette = ['#ff8700', '#5f87ff', '#00d65a', '#ffff00', '#ff4f4d', '#af87ff']
    let h = 0
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
    const du = withDataUser ? ` data-user="${escapeHtml(key)}"` : ''
    return `<span class="hs-mc-avatar hs-mc-avatar-fallback"${du} style="background:${palette[h % palette.length]};color:#000">${escapeHtml(initial)}</span>`
  }
  function fetchAvatar(username) {
    const key = username.toLowerCase()
    if (avatarCache.has(key) || avatarFetching.has(key)) return
    if (_activeAvatarFetches >= MAX_AVATAR_FETCHES) return
    avatarFetching.add(key)
    _activeAvatarFetches++
    fetch(`https://decapi.me/twitch/avatar/${encodeURIComponent(key)}`, { credentials: 'omit' })
      .then(r => r.ok ? r.text() : null)
      .then(url => {
        avatarFetching.delete(key)
        _activeAvatarFetches--
        const safe = safeUrl((url || '').trim())
        if (!safe) return
        avatarCache.set(key, safe)
        if (avatarCache.size > 500) {
          avatarCache.delete(avatarCache.keys().next().value)
        }
        // Swap each initials placeholder for the real avatar img IN PLACE. The
        // placeholder span already holds the 18px box, so replacing it with an
        // equally-sized img produces zero layout shift (no pop).
        if (avatarsEnabled) {
          const safeSrc = avatarCache.get(key)
          document.querySelectorAll(`.hs-mc-avatar[data-user="${CSS.escape(key)}"]`).forEach(el => {
            const img = document.createElement('img')
            img.className = 'hs-mc-avatar'
            img.src = safeSrc
            img.alt = ''
            img.loading = 'lazy'
            img.decoding = 'async'
            el.replaceWith(img)
          })
        }
      })
      .catch(() => { avatarFetching.delete(key); _activeAvatarFetches-- })
  }

  // YT-name → twitch_id resolver. YouTube chat doesn't expose channel IDs in
  // the DOM, so we look the user up on heatsync to get a twitchId, then feed
  // that into the existing 7TV cosmetics pipeline. The map caches both hits
  // (twitch_id) and misses (null) — LRU-evicted at YT_NAME_CACHE_MAX so a
  // long stream session can't grow it without bound.
  const ytNameToTwitchId = new Map()      // ytUserKey → twitchId | null
  const ytNameLookupPending = new Set()
  let ytNameLookupTimer = null
  const YT_NAME_BATCH = 8
  const YT_NAME_CACHE_MAX = 1000

  function evictYtNameCache() {
    if (ytNameToTwitchId.size >= YT_NAME_CACHE_MAX) {
      ytNameToTwitchId.delete(ytNameToTwitchId.keys().next().value)
    }
  }

  function ytNameKey(user) { return (user || '').toLowerCase().replace(/^@/, '') }

  function queueYtNameToTwitchId(user) {
    const key = ytNameKey(user)
    if (!key) return
    if (ytNameToTwitchId.has(key)) return
    if (ytNameLookupPending.has(key)) return
    ytNameLookupPending.add(key)
    if (ytNameLookupPending.size >= YT_NAME_BATCH) {
      if (ytNameLookupTimer) { cleanup.clearTimeout(ytNameLookupTimer); ytNameLookupTimer = null }
      flushYtNameLookups()
      return
    }
    if (!ytNameLookupTimer) {
      ytNameLookupTimer = cleanup.setTimeout(() => {
        ytNameLookupTimer = null
        flushYtNameLookups()
      }, 800)
    }
  }

  async function flushYtNameLookups() {
    if (!ytNameLookupPending.size) return
    const batch = [...ytNameLookupPending].slice(0, YT_NAME_BATCH)
    batch.forEach(k => ytNameLookupPending.delete(k))
    // Serialize — Promise.all over the batch was firing 8 concurrent
    // /api/profile/X requests that monopolized the SW's heatsync slot pool
    // and starved channel-emote / cosmetics fetches. YT cosmetics aren't
    // time-critical; a slower-but-quieter walk is the right trade.
    const lookupOne = async (key) => {
      try {
        const resp = await safeSendMessage({
          type: 'api_fetch',
          path: '/api/profile/' + encodeURIComponent(key),
          method: 'GET'
        })
        const tid = resp?.data?.twitch_id || resp?.twitch_id || null
        evictYtNameCache()
        ytNameToTwitchId.set(key, tid ? String(tid) : null)
        if (tid) {
          const tidStr = String(tid)
          // Backfill: stamp data-uid on all currently-rendered YT msgs by this
          // user so updateCosmeticsInPlace can find them once cosmetics resolve.
          const container = document.getElementById('hs-mc-messages')
          if (container) {
            const sel = `.hs-mc-msg .hs-mc-user[data-platform="yt"][data-username="${CSS.escape('@' + key)}"], .hs-mc-msg .hs-mc-user[data-platform="yt"][data-username="${CSS.escape(key)}"]`
            for (const userEl of container.querySelectorAll(sel)) {
              const div = userEl.closest('.hs-mc-msg')
              if (div && !div.dataset.uid) div.dataset.uid = tidStr
            }
          }
          // Patch buffered messages so the next render picks up the userId and
          // walks the cosmetics-aware path (otherwise the cached _renderedHtml
          // keeps the paint-less version forever).
          const patchBuf = (buf) => {
            if (!Array.isArray(buf) && !(buf && typeof buf[Symbol.iterator] === 'function')) return
            for (const m of buf) {
              if (m && m.platform === 'youtube' && m.user) {
                const mk = m.user.toLowerCase().replace(/^@/, '')
                if (mk === key) { m.userId = tidStr; m._renderedHtml = null }
              }
            }
          }
          if (typeof channelYtMessages !== 'undefined') channelYtMessages.forEach(patchBuf)
          if (typeof mentionsBuffer !== 'undefined') patchBuf(mentionsBuffer)
          // Now feed through the existing cosmetics pipeline; it will resolve
          // 7TV paint/badge and call updateCosmeticsInPlace which paints by uid.
          if (!mcUserCosmetics.has(tidStr)) queueMcCosmeticsLookup(tidStr)
        }
      } catch {
        evictYtNameCache()
        ytNameToTwitchId.set(key, null)
      }
    }
    for (const key of batch) await lookupOne(key)
    if (ytNameLookupPending.size > 0 && !ytNameLookupTimer) {
      ytNameLookupTimer = cleanup.setTimeout(() => {
        ytNameLookupTimer = null
        flushYtNameLookups()
      }, 1500)
    }
  }

  // ─── Kick username → 7TV cosmetics + twitchId lookup ───
  // Kick chat WS doesn't propagate user_id to the panel, but 7TV's /users/kick/{username}
  // endpoint accepts the kick handle directly and returns the linked twitch connection.
  // We use the returned twitchId as the cosmetics cache key so a chatter with linked
  // accounts gets the same paint/badge across both platforms.
  const kickNameResolved = new Map()      // kickHandle → twitchId | null
  const kickNameToTwitchUsername = new Map() // kickHandle → twitchUsername | null
  const kickNameLookupPending = new Set()
  let kickNameLookupTimer = null
  const KICK_NAME_BATCH = 8
  const KICK_NAME_CACHE_MAX = 1000

  function evictKickNameCache() {
    if (kickNameResolved.size >= KICK_NAME_CACHE_MAX) {
      const oldest = kickNameResolved.keys().next().value
      kickNameResolved.delete(oldest)
      kickNameToTwitchUsername.delete(oldest)
    }
  }

  // Exposed for profile-card.js / tooltips.js cross-platform identity render.
  // Returns the linked twitch username if known, else null. Triggers a lookup
  // when first asked so the second hover/right-click picks up the answer.
  function getKickLinkedTwitch(kickUsername) {
    if (!kickUsername) return null
    const k = String(kickUsername).toLowerCase()
    if (kickNameToTwitchUsername.has(k)) return kickNameToTwitchUsername.get(k)
    queueKickNameToCosmetics(k)
    return null
  }

  function queueKickNameToCosmetics(user) {
    const key = (user || '').toLowerCase()
    if (!key) return
    if (kickNameResolved.has(key)) return
    if (kickNameLookupPending.has(key)) return
    kickNameLookupPending.add(key)
    if (kickNameLookupPending.size >= KICK_NAME_BATCH) {
      if (kickNameLookupTimer) { cleanup.clearTimeout(kickNameLookupTimer); kickNameLookupTimer = null }
      flushKickNameLookups()
      return
    }
    if (!kickNameLookupTimer) {
      kickNameLookupTimer = cleanup.setTimeout(() => {
        kickNameLookupTimer = null
        flushKickNameLookups()
      }, 800)
    }
  }

  async function flushKickNameLookups() {
    if (!kickNameLookupPending.size) return
    const batch = [...kickNameLookupPending].slice(0, KICK_NAME_BATCH)
    batch.forEach(k => kickNameLookupPending.delete(k))
    let resp = null
    try {
      resp = await safeSendMessage({ type: 'get_kick_user_cosmetics', kickUsernames: batch })
    } catch { resp = null }
    const cosmetics = resp?.cosmetics || {}
    const changedIds = []
    for (const key of batch) {
      const c = cosmetics[key]
      evictKickNameCache()
      const tid = c?.twitchId ? String(c.twitchId) : null
      kickNameResolved.set(key, tid)
      kickNameToTwitchUsername.set(key, c?.twitchUsername || null)
      if (!tid) continue
      // Fold the {paint, badge} into the twitch-id-keyed cosmetics cache so the
      // existing updateCosmeticsInPlace pipeline paints by uid.
      setMcCosmetic(tid, { paint: c.paint || null, badge: c.badge || null })
      changedIds.push(tid)
      // Backfill data-uid on rendered Kick msgs by lowercase username so
      // updateCosmeticsInPlace finds the right rows.
      const container = document.getElementById('hs-mc-messages')
      if (container) {
        const sel = `.hs-mc-msg .hs-mc-user[data-platform="kick"][data-username="${CSS.escape(key)}"]`
        for (const userEl of container.querySelectorAll(sel)) {
          const div = userEl.closest('.hs-mc-msg')
          if (div && !div.dataset.uid) div.dataset.uid = tid
        }
      }
      // Patch buffered Kick messages so the next render picks up userId and
      // walks the cosmetics-aware path.
      const patchBuf = (buf) => {
        if (!buf || (!Array.isArray(buf) && !(buf && typeof buf[Symbol.iterator] === 'function'))) return
        for (const m of buf) {
          if (m && m.platform === 'kick' && m.user) {
            const mk = m.user.toLowerCase()
            if (mk === key) { m.userId = tid; m._renderedHtml = null }
          }
        }
      }
      if (typeof kickChat !== 'undefined' && kickChat?.channels) {
        for (const ch of kickChat.channels.keys()) patchBuf(kickChat.getMessages(ch))
      }
      if (typeof mentionsBuffer !== 'undefined') patchBuf(mentionsBuffer)
    }
    if (changedIds.length) updateCosmeticsInPlace(changedIds)
    if (kickNameLookupPending.size > 0 && !kickNameLookupTimer) {
      kickNameLookupTimer = cleanup.setTimeout(() => {
        kickNameLookupTimer = null
        flushKickNameLookups()
      }, 1500)
    }
  }

  // 7TV cosmetics queue — batch lookups to avoid per-message requests
  function queueMcCosmeticsLookup(userId) {
    if (!userId || mcUserCosmetics.has(userId)) return
    if (mcCosmeticsPending.size >= MC_COSMETICS_PENDING_MAX) return
    mcCosmeticsPending.add(userId)
    if (!mcCosmeticsTimer) {
      mcCosmeticsTimer = cleanup.setTimeout(() => {
        mcCosmeticsTimer = null
        flushMcCosmeticsBatch()
      }, 100)
    }
  }

  function flushMcCosmeticsBatch() {
    if (!mcCosmeticsPending.size) return
    // Drain newest-queued first: messages queue oldest→newest, but the user is
    // looking at the bottom (newest) of the buffer, so the visible viewport
    // resolves in the first batch instead of last. Off-screen/scrolled-away
    // users still fill in as the queue drains.
    const batch = [...mcCosmeticsPending].slice(-25)
    batch.forEach(id => mcCosmeticsPending.delete(id))
    safeSendMessage({ type: 'get_user_cosmetics', twitchIds: batch }).then(resp => {
      if (!resp?.cosmetics) return
      const changedIds = []
      for (const [uid, c] of Object.entries(resp.cosmetics)) {
        if (c) { setMcCosmetic(uid, c); changedIds.push(uid) }
      }
      if (changedIds.length) updateCosmeticsInPlace(changedIds)
    }).catch(() => {})
    if (mcCosmeticsPending.size > 0) {
      mcCosmeticsTimer = cleanup.setTimeout(() => { mcCosmeticsTimer = null; flushMcCosmeticsBatch() }, 500)
    }
  }

  // ═══ Sender-perma emote queue ═══
  // Lazy-fetch each unseen sender's 7TV/BTTV personal set ONCE, cache write-once-per-(sender, name) forever.
  /**
   * Load stale-emote registry from chrome.storage.local. Populates the
   * window._hsStaleEmotes Map<channelLower, Map<emoteName, meta>> so message
   * render can decorate ghost emotes from prior sessions. 7-day TTL.
   */
  async function loadStaleEmotes() {
    try {
      const stored = await chrome.storage.local.get(['hs_stale_emotes_v1'])
      const obj = stored?.hs_stale_emotes_v1 || {}
      const reg = window._hsStaleEmotes || (window._hsStaleEmotes = new Map())
      const cutoff = Date.now() - 7 * 86400000
      for (const [ch, entries] of Object.entries(obj)) {
        const m = new Map()
        for (const [name, meta] of (entries || [])) {
          if ((meta?.at || 0) >= cutoff) m.set(name, meta)
        }
        if (m.size) reg.set(ch, m)
      }
    } catch (e) {}
  }

  // Survives hard refresh because emotes.js loadSenderEmoteSets() runs at boot before render.
  const senderEmotePending = new Set()
  let senderEmoteTimer = null
  const SENDER_EMOTE_BATCH = 15
  // Per-sender fetch freshness (in-memory, NOT persisted). A sender's set was
  // previously fetched once and never re-validated, so any emote they ADDED
  // afterward never reached viewers who'd already cached them. Re-fetch when the
  // entry is older than this; the empty in-memory map after a reload means every
  // sender is re-validated once per session (picks up adds made since last visit).
  const senderEmoteFetchedAt = new Map() // senderKey -> ts
  const SENDER_EMOTE_REFETCH_MS = 5 * 60 * 1000
  // Keep this freshness map bounded to the SAME cap as the backing emote store
  // (emotes.js senderEmoteSets / SENDER_EMOTE_LRU_MAX — shared multichat block
  // scope). Otherwise it grows unbounded AND diverges: once the store LRU-evicts
  // a sender, a stale "fresh" entry here would wrongly suppress the re-fetch that
  // would reload their emotes. delete-then-set bumps LRU recency on each write.
  function markSenderEmoteFetched(senderKey, ts) {
    senderEmoteFetchedAt.delete(senderKey)
    senderEmoteFetchedAt.set(senderKey, ts)
    if (senderEmoteFetchedAt.size > SENDER_EMOTE_LRU_MAX) {
      senderEmoteFetchedAt.delete(senderEmoteFetchedAt.keys().next().value)
    }
  }

  function resolveSenderEmoteKey(m) {
    if (!m) return null
    if (m.platform === 'kick') {
      const id = m.userId || (m.user && m.user.toLowerCase())
      return id ? `kick:${id}` : null
    }
    if (m.platform === 'youtube') {
      // For YT, prefer resolved twitch_id (lets us reuse the twitch 7tv set) but
      // fall back to YT user key when twitch resolution hasn't completed yet.
      if (m.userId) return `twitch:${m.userId}`
      const ytKey = (m.user || '').toLowerCase().replace(/^@/, '')
      return ytKey ? `yt:${ytKey}` : null
    }
    // Default: twitch
    return m.userId ? `twitch:${m.userId}` : null
  }

  function queueSenderEmoteFetch(senderKey, m) {
    if (!senderKey) return
    if (senderEmotePending.has(senderKey)) return
    // Re-fetch when stale (or never validated this session) so emotes a sender
    // adds later propagate. The cached set is still used for rendering meanwhile;
    // mergeSenderEmotes layers any new names on top without dropping the old.
    const fetchedAt = senderEmoteFetchedAt.get(senderKey)
    if (fetchedAt && (Date.now() - fetchedAt) < SENDER_EMOTE_REFETCH_MS) return
    senderEmotePending.add(senderKey)
    if (senderEmotePending.size >= SENDER_EMOTE_BATCH) {
      if (senderEmoteTimer) { cleanup.clearTimeout(senderEmoteTimer); senderEmoteTimer = null }
      flushSenderEmoteBatch()
      return
    }
    if (!senderEmoteTimer) {
      senderEmoteTimer = cleanup.setTimeout(() => {
        senderEmoteTimer = null
        flushSenderEmoteBatch()
      }, 250)
    }
  }

  function flushSenderEmoteBatch() {
    if (!senderEmotePending.size) return
    const batch = [...senderEmotePending].slice(0, SENDER_EMOTE_BATCH)
    batch.forEach(k => senderEmotePending.delete(k))
    safeSendMessage({ type: 'get_sender_emotes', senderKeys: batch }).then(resp => {
      const emotes = resp?.emotes || {}
      const changedKeys = []
      // Stamp freshness for EVERY batch key (even empty ones) so we don't re-fetch
      // until the TTL elapses — without this, senders with no personal set re-queue
      // on every render and loop render→fetch→re-render on busy chats.
      const now = Date.now()
      for (const key of batch) {
        // resp arrived — treat the value as authoritative and replace the cached
        // set entirely. Use replace (not merge) so names removed on the server
        // also disappear here; merge was the bleed: removed emotes lingered
        // forever and rendered for other viewers until the cache was nuked.
        const changed = replaceSenderEmotes(key, emotes[key] || {})
        markSenderEmoteFetched(key, now)
        if (changed) changedKeys.push(key)
      }
      if (changedKeys.length) upgradeMessagesForSenders(changedKeys)
    }).catch(() => {
      // Network/IPC failure — seed empty sentinel + freshness so the next render
      // doesn't re-queue immediately (retries after the TTL).
      const now = Date.now()
      for (const key of batch) { mergeSenderEmotes(key, {}); markSenderEmoteFetched(key, now) }
    })
    if (senderEmotePending.size > 0) {
      senderEmoteTimer = cleanup.setTimeout(() => { senderEmoteTimer = null; flushSenderEmoteBatch() }, 500)
    }
  }

  // After a sender's personal set arrives, invalidate cached _renderedHtml on
  // their buffered messages, then debounced-trigger a re-render of the active
  // tab so already-visible rows pick up the new resolution.
  // Debounce: fires once 600ms after the LAST sender resolves. During cold
  // boot ~50+ senders resolve in tight bursts — one renderMessages per batch
  // caused visible flicker, scroll-handler races (yellow "new msgs" button
  // showing on fresh load), and stale-state flashes. One coalesced re-render
  // at the tail of the boot burst replaces all of that.
  let _upgradeRenderTimer = null
  const _pendingUpgradeKeys = new Set()
  function upgradeMessagesForSenders(senderKeys) {
    if (!senderKeys?.length) return
    for (const k of senderKeys) _pendingUpgradeKeys.add(k)

    const keySet = _pendingUpgradeKeys
    const matches = (m) => {
      if (!m) return false
      const k = resolveSenderEmoteKey(m)
      return k && keySet.has(k)
    }
    const patchBuf = (buf) => {
      if (!buf || typeof buf[Symbol.iterator] !== 'function') return
      for (const m of buf) {
        if (matches(m)) m._renderedHtml = null
      }
    }
    // Invalidate cached HTML immediately — the next render (debounced or
    // user-triggered by tab switch / new message) picks up the new emotes.
    if (typeof irc !== 'undefined' && irc?.channels) {
      for (const ch of irc.channels.keys()) patchBuf(irc.getMessages(ch))
    }
    if (typeof kickChat !== 'undefined' && kickChat?.channels) {
      for (const ch of kickChat.channels.keys()) patchBuf(kickChat.getMessages(ch))
    }
    if (typeof channelYtMessages !== 'undefined') channelYtMessages.forEach(patchBuf)
    if (typeof mentionsBuffer !== 'undefined') patchBuf(mentionsBuffer)

    // Debounced re-render of active tab. Reset timer on every new batch so
    // the eventual render sees the FINAL invalidation set, not a partial mid-
    // boot snapshot. 600ms is long enough to coalesce a typical boot burst
    // (~300ms across multiple safeSendMessage round-trips) but short enough
    // that emote upgrades feel near-instant once chat settles.
    if (_upgradeRenderTimer) cleanup.clearTimeout(_upgradeRenderTimer)
    _upgradeRenderTimer = cleanup.setTimeout(() => {
      _upgradeRenderTimer = null
      _pendingUpgradeKeys.clear()
      // Skip re-render entirely if user has scrolled up — they're reading
      // older messages and don't want their viewport snapping. The emotes
      // upgrade lazily on next scroll-to-bottom or tab switch.
      if (isScrolledUp) return
      if (typeof renderMessages === 'function' && typeof currentTab !== 'undefined') {
        try { renderMessages(currentTab) } catch {}
      }
    }, 600)
  }

  // 7TV badge imgs sometimes fail at insert-time: a burst of cdn.7tv.app
  // requests races HTTP/3 and the CDN drops a few. The URL is valid (a fresh
  // fetch succeeds), so retry up to 2x — cache-busted + staggered — before
  // hiding, instead of leaving a permanent broken-image icon.
  function retryOrHideBadgeImg(img) {
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('hs-mc-badge-img')) return
    const n = +img.dataset.hsRetry || 0
    if (n >= 2) { img.style.display = 'none'; return }
    img.dataset.hsRetry = String(n + 1)
    const base = img.dataset.hsSrc || (img.dataset.hsSrc = img.src.replace(/[?&]hsr=\d+$/, ''))
    cleanup.setTimeout(() => {
      img.src = base + (base.includes('?') ? '&' : '?') + 'hsr=' + img.dataset.hsRetry
    }, 200 * (n + 1))
  }

  // Update cosmetics (badges + paint) in-place without full re-render.
  // O(1) lookup via _uidIndex / _mentionIndex instead of querySelectorAll over
  // the full message container — at 25-user batches × 500 children that was
  // 50 full DOM scans per cosmetic flush.
  function updateCosmeticsInPlace(userIds) {
    if (!document.getElementById('hs-mc-messages')) return
    for (const uid of userIds) {
      const cosmetic = mcUserCosmetics.get(uid)
      if (!cosmetic) continue
      const paintStyle = getMcPaintStyle(uid)
      // Repaint inline @mentions of this user across all visible messages
      if (paintStyle) {
        const mentionSet = _mentionIndex.get(uid)
        if (mentionSet) {
          for (const mention of mentionSet) mention.setAttribute('style', paintStyle)
        }
      }
      const divSet = _uidIndex.get(uid)
      if (!divSet) continue
      for (const div of divSet) {
        // Update paint on the SENDER's username link — exclude the reply
        // target (.hs-mc-reply-user) which also has .hs-mc-user but is a
        // different person and would get the wrong paint/badge.
        const userLink = div.querySelector('.hs-mc-user:not(.hs-mc-reply-user)')
        if (userLink) {
          if (paintStyle) {
            userLink.setAttribute('style', paintStyle)
          }
        }
        // Add 7TV badge if not already present and cosmetic has one
        if (cosmetic.badge && !div.querySelector('.hs-mc-7tv-badge')) {
          const files = cosmetic.badge.host?.files || []
          const file = files.find(f => f.name?.endsWith('.webp')) || files.find(f => f.name?.endsWith('.avif')) || files[0]
          if (file) {
            const base = cosmetic.badge.host?.url || ''
            // 7TV returns protocol-relative URLs (//cdn.7tv.app/...) — promote
            // to https before validation so safeUrl doesn't drop them.
            const absBase = base.startsWith('//') ? 'https:' + base : base
            const rawUrl = (absBase.endsWith('/') ? absBase : absBase + '/') + file.name
            const url = safeUrl(rawUrl)
            if (url) {
              const img = document.createElement('img')
              img.className = 'hs-mc-badge-img hs-mc-7tv-badge'
              img.alt = '7TV'
              img.title = cosmetic.badge.tooltip || '7TV'
              img.style.cssText = 'width:18px;height:18px;'
              img.dataset.hsSrc = url
              // Insert FIRST, then set src — so an immediate QUIC-drop error
              // fires while the img is already under msgsEl and the capture-phase
              // error handler (→ retryOrHideBadgeImg) catches it.
              if (userLink) userLink.parentNode.insertBefore(img, userLink)
              img.src = url
            }
          }
        }
      }
    }
  }

  // In-place third-party badge injection (BTTV/FFZ/Chatterino). Mirrors
  // updateCosmeticsInPlace's 7TV-badge path: when the bulk badge maps arrive
  // late (cold service worker, or the ~24h cosmetics_update broadcast), patch
  // the badges into already-rendered rows via _uidIndex (keyed by twitch uid,
  // same key renderThirdPartyBadges uses) instead of bumpRenderEpoch()+full
  // rebuild — that rebuild tore down every row and reloaded every avatar/emote
  // image = the "loads then shifts" flash on channel switch. Per-provider class
  // dedups so a warm row (built after the maps populated) isn't double-badged.
  // Anchor = before the avatar (or username when avatars are off) so injected
  // badges land exactly where buildMessageDiv's ${badges} sits: after native
  // badges, before ${avatarHtml}${userLink}.
  function updateThirdPartyBadgesInPlace() {
    if (!document.getElementById('hs-mc-messages')) return
    const wantBttv = getSetting('bttvBadges')
    const wantFfz = getSetting('ffzBadges')
    const wantChat = getSetting('chatterinoBadges')
    if (!wantBttv && !wantFfz && !wantChat) return
    const mkBadge = (cls, url, title, bg) => {
      const safe = safeUrl(url)
      if (!safe) return null
      const img = document.createElement('img')
      img.className = 'hs-mc-badge-img ' + cls
      img.alt = title || ''
      img.title = title || ''
      img.loading = 'lazy'; img.decoding = 'async'
      img.width = 18; img.height = 18
      img.style.cssText = 'width:18px;height:18px;' + (bg ? `background:${bg};border-radius:2px;` : '')
      // Insert FIRST, then set src (caller) — so an immediate QUIC-drop error
      // fires while the img is already under msgsEl and the capture-phase error
      // handler (retryOrHideBadgeImg) catches it. Mirrors updateCosmeticsInPlace.
      img.dataset.hsSrc = safe
      return img
    }
    for (const [uid, divSet] of _uidIndex) {
      const bttv = wantBttv ? mcBttvBadgeMap.get(uid) : null
      const ffzList = wantFfz ? mcFfzBadgeMap.get(uid) : null
      const chat = wantChat ? mcChatterinoBadgeMap.get(uid) : null
      if (!bttv && !ffzList && !chat) continue
      for (const div of divSet) {
        const anchor = div.querySelector('.hs-mc-avatar')
          || div.querySelector('.hs-mc-user:not(.hs-mc-reply-user)')
        if (!anchor) continue
        const insert = (img) => { if (img) { anchor.parentNode.insertBefore(img, anchor); img.src = img.dataset.hsSrc } }
        if (bttv && !div.querySelector('.hs-mc-bttv-badge')) {
          insert(mkBadge('hs-mc-bttv-badge', bttv.url, bttv.description))
        }
        if (ffzList && !div.querySelector('.hs-mc-ffz-badge')) {
          for (const b of ffzList) {
            const safeColor = /^#[0-9a-fA-F]{3,8}$/.test(b.color) ? b.color : ''
            insert(mkBadge('hs-mc-ffz-badge', b.url, b.title, safeColor))
          }
        }
        if (chat && !div.querySelector('.hs-mc-chatterino-badge')) {
          insert(mkBadge('hs-mc-chatterino-badge', chat.url, chat.tooltip || 'Chatterino'))
        }
      }
    }
  }

  // 7TV paint → CSS style string
  // 7TV paint → CSS is static per paint object but getMcPaintStyle runs per
  // sender + per @mention + inside updateCosmeticsInPlace, re-deriving the same
  // gradient/shadow string (map/join/toFixed churn) every render. Memoize on the
  // paint object: a WeakMap auto-evicts when the cosmetic is dropped, and keying
  // on identity means a replaced paint recomputes with no manual invalidation.
  const _mcPaintStyleCache = new WeakMap()
  function getMcPaintStyle(userId) {
    if (!getSetting('sevenTvPaints')) return ''
    const cosmetic = mcUserCosmetics.get(userId)
    const paint = cosmetic?.paint
    if (!paint || !paint.function) return ''
    const cached = _mcPaintStyleCache.get(paint)
    if (cached !== undefined) return cached
    const style = _computeMcPaintStyle(paint)
    _mcPaintStyleCache.set(paint, style)
    return style
  }
  function _computeMcPaintStyle(paint) {
    const fn = paint.function.toLowerCase()
    if (fn === 'url' && paint.image_url) {
      if (!/^https:\/\//.test(paint.image_url)) return ''
      const safeCssUrl = paint.image_url.replace(/[()'"\\;{}]/g, encodeURIComponent)
      let style = `background-image:url(${safeCssUrl});background-size:cover;-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text`
      if (paint.shadows?.length) {
        style += ';filter:' + paint.shadows.map(s => {
          const r = (s.color >>> 24) & 0xff
          const g = (s.color >>> 16) & 0xff
          const b = (s.color >>> 8) & 0xff
          const a = (s.color & 0xff) / 255
          return `drop-shadow(${Number(s.x_offset) || 0}px ${Number(s.y_offset) || 0}px ${Number(s.radius) || 0}px rgba(${r},${g},${b},${a.toFixed(2)}))`
        }).join(' ')
      }
      return style
    }
    if ((fn === 'linear-gradient' || fn === 'radial-gradient' || fn === 'linear_gradient' || fn === 'radial_gradient') && paint.stops?.length) {
      const stops = paint.stops.map(s => {
        const r = (s.color >>> 24) & 0xff
        const g = (s.color >>> 16) & 0xff
        const b = (s.color >>> 8) & 0xff
        const a = (s.color & 0xff) / 255
        return `rgba(${r},${g},${b},${a.toFixed(2)}) ${Math.round(s.at * 100)}%`
      }).join(', ')
      const safeAngle = Number.isFinite(Number(paint.angle)) ? Number(paint.angle) : 0
      const safeShape = /^(circle|ellipse)$/.test(paint.shape) ? paint.shape : 'circle'
      const grad = (fn === 'linear-gradient' || fn === 'linear_gradient')
        ? `linear-gradient(${safeAngle}deg, ${stops})`
        : `radial-gradient(${safeShape}, ${stops})`
      let style = `background:${grad};-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text`
      if (paint.shadows?.length) {
        style += ';filter:' + paint.shadows.map(s => {
          const r = (s.color >>> 24) & 0xff
          const g = (s.color >>> 16) & 0xff
          const b = (s.color >>> 8) & 0xff
          const a = (s.color & 0xff) / 255
          return `drop-shadow(${Number(s.x_offset) || 0}px ${Number(s.y_offset) || 0}px ${Number(s.radius) || 0}px rgba(${r},${g},${b},${a.toFixed(2)}))`
        }).join(' ')
      }
      return style
    }
    if (paint.color) {
      const r = (paint.color >>> 24) & 0xff
      const g = (paint.color >>> 16) & 0xff
      const b = (paint.color >>> 8) & 0xff
      const a = (paint.color & 0xff) / 255
      return `color:rgba(${r},${g},${b},${a.toFixed(2)})`
    }
    return ''
  }

  // Resolve a 7TV paint CSS string for any username surface (reply context,
  // whispers, DMs, profile cards). Prefers an explicit Twitch userId; falls
  // back to the lowercase-name → uid map (same path as inline @mentions).
  // Queues a cosmetics lookup when the uid is known but not yet cached, so the
  // paint lands on the next render/in-place repaint. Returns '' when no paint
  // is available — callers fall back to their plain color.
  function userPaintStyle(uid, lower) {
    if (!uid && lower) uid = knownUserIds.get(lower) || ''
    if (!uid) return ''
    if (!mcUserCosmetics.has(uid)) queueMcCosmeticsLookup(uid)
    return getMcPaintStyle(uid)
  }

  // Stream event user colors — login → color (populated from server on connect)
  const streamColorMap = new Map();

  // Init-time storage cache — load* functions all read the SAME `ui_settings`
  // key. Without this, init() fires 17+ separate sync IPCs to chrome.storage.
  // One `cachedUiSettings()` call boots a single in-flight Promise that every
  // loader awaits. Cleared at end of init so post-load changes go to disk.
  let _uiSettingsCachePromise = null
  function cachedUiSettings() {
    if (!_uiSettingsCachePromise) {
      _uiSettingsCachePromise = chrome.storage.sync.get(['ui_settings'])
    }
    return _uiSettingsCachePromise
  }
  function invalidateUiSettingsCache() { _uiSettingsCachePromise = null }

  // Overflow cache — large/per-tab settings live in chrome.storage.local
  // (unlimitedStorage permission) instead of sync (8 KB QUOTA_BYTES_PER_ITEM).
  // Keeps sync featherweight for cross-device prefs and avoids ever-bloating
  // the single ui_settings record with platformFilters[tabId] / keyword text.
  let _uiOverflowCachePromise = null
  function cachedUiOverflow() {
    if (!_uiOverflowCachePromise) {
      _uiOverflowCachePromise = chrome.storage.local.get(['platform_filters', 'keyword_highlights'])
    }
    return _uiOverflowCachePromise
  }
  function invalidateUiOverflowCache() { _uiOverflowCachePromise = null }

  // One-shot migration: heal any chrome.storage.sync.ui_settings record that
  // accumulated indexed-key bloat (server fanout used to merge raw payloads
  // without validation, which once injected `{0:{},1:"...",...}` shaped data
  // and pushed the record over the 8 KB QUOTA_BYTES_PER_ITEM ceiling). Also
  // moves platformFilters / keywordHighlights to chrome.storage.local where
  // they belong (per-tab map and free-form text — neither fits in sync).
  // Idempotent + race-safe — multiple tabs running in parallel converge to
  // the same cleaned record. Gated by ui_settings_migrated_v2 in local.
  async function migrateUiSettingsOnce() {
    try {
      const flag = await chrome.storage.local.get('ui_settings_migrated_v2')
      if (flag.ui_settings_migrated_v2) return
      const synced = await chrome.storage.sync.get('ui_settings')
      const dirty = synced.ui_settings || {}
      const overflow = {}
      if (dirty.platformFilters && typeof dirty.platformFilters === 'object' && !Array.isArray(dirty.platformFilters)) {
        // Shape-validate each entry: { twitch?: bool, kick?: bool, youtube?: bool }
        const safe = {}
        for (const [id, val] of Object.entries(dirty.platformFilters)) {
          if (!id || typeof id !== 'string' || id.length > 128) continue
          if (!val || typeof val !== 'object' || Array.isArray(val)) continue
          const e = {}
          if (typeof val.twitch === 'boolean') e.twitch = val.twitch
          if (typeof val.kick === 'boolean') e.kick = val.kick
          if (typeof val.youtube === 'boolean') e.youtube = val.youtube
          if (Object.keys(e).length) safe[id] = e
        }
        if (Object.keys(safe).length) overflow.platform_filters = safe
      }
      if (typeof dirty.keywordHighlights === 'string' && dirty.keywordHighlights.length <= 65536) {
        overflow.keyword_highlights = dirty.keywordHighlights
      }
      const cleaned = sanitizeUiSettings(dirty)
      const writes = []
      writes.push(chrome.storage.sync.set({ ui_settings: cleaned }))
      if (Object.keys(overflow).length) writes.push(chrome.storage.local.set(overflow))
      writes.push(chrome.storage.local.set({ ui_settings_migrated_v2: true }))
      await Promise.all(writes.map(p => p.catch(() => {})))
      invalidateUiSettingsCache()
      invalidateUiOverflowCache()
    } catch {}
  }

  // Bound localStorage chat_history footprint. These keys can accumulate to
  // 2 MB+ on heavy users (tracked across many channels over months). Keep
  // newest N channels by savedAt/last-write timestamp; older keys evict.
  // Runs once per session as an opportunistic janitor.
  function pruneChatHistoryOnce() {
    try {
      const HISTORY_KEEP = 5
      const MSG_CACHE_KEEP = 5
      const collect = (prefix) => {
        const entries = []
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)
          if (!k || !k.startsWith(prefix)) continue
          let ts = 0
          try {
            const raw = localStorage.getItem(k)
            const parsed = raw ? JSON.parse(raw) : null
            ts = parsed?.savedAt || parsed?.ts || parsed?.timestamp || 0
          } catch {}
          entries.push({ k, ts, sz: (localStorage.getItem(k) || '').length })
        }
        return entries
      }
      const evict = (entries, keep) => {
        if (entries.length <= keep) return
        entries.sort((a, b) => a.ts - b.ts) // oldest first
        for (let i = 0; i < entries.length - keep; i++) {
          try { localStorage.removeItem(entries[i].k) } catch {}
        }
      }
      evict(collect('hs_chat_history_'), HISTORY_KEEP)
      evict(collect('hs_msg_cache_'), MSG_CACHE_KEEP)
    } catch {}
  }

  // Batched ui_settings writer — coalesces multiple saves into one read-modify-write
  let _pendingSettings = null
  let _settingsSaveTimer = null

  // Layout-critical keys mirror to localStorage so early-layout.js can
  // read them sync at document_start (before chrome.storage is available
  // to content scripts). Eliminates the cold-boot flash on hard refresh.
  const _LAYOUT_MIRROR_KEYS = new Set(['tabPosition', 'chatPosition'])
  function _mirrorLayoutToLS(key, value) {
    try { localStorage.setItem('hs_layout_' + key, JSON.stringify(value)) } catch {}
  }

  // Cross-fade the document_start prepaint pseudo-element with the real
  // multichat container. Both transition over 200ms — prepaint opacity 1→0
  // while container opacity 0→1 — so there's no visible black gap or
  // tab-bar pop. Two rAFs before the fade guarantee the overlay has
  // actually painted before the swap starts (rAF 1 = post-style commit,
  // rAF 2 = post-paint).
  let _prepaintTornDown = false
  function tearDownPrepaint() {
    const html = document.documentElement
    const container = document.getElementById('hs-mc-container')
    const firstRun = !_prepaintTornDown
    _prepaintTornDown = true
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Always (re)apply on every call — container can be recreated on
        // SPA navigation, and a fresh element won't carry the class.
        if (container) container.classList.add('hs-mc-shown')
        if (!firstRun) return
        if (html.classList.contains('hs-prepaint-active')) {
          html.classList.add('hs-prepaint-fade')
        }
        setTimeout(() => {
          html.classList.remove('hs-prepaint-active')
          html.classList.remove('hs-prepaint-fade')
          document.getElementById('hs-early-layout')?.remove()
        }, 220)
      })
    })
  }

  function saveUiSetting(key, value) {
    if (!_pendingSettings) _pendingSettings = {}
    _pendingSettings[key] = value
    if (_LAYOUT_MIRROR_KEYS.has(key)) _mirrorLayoutToLS(key, value)
    if (_settingsSaveTimer) cleanup.clearTimeout(_settingsSaveTimer)
    _settingsSaveTimer = cleanup.setTimeout(() => {
      const pending = _pendingSettings
      _pendingSettings = null
      _settingsSaveTimer = null

      // Split: blocklist keys go to chrome.storage.local (no quota cap, no
      // server sync, no cross-device leak). Everything else goes to sync.
      const localPatch = {}
      const syncPatch = {}
      for (const k in pending) {
        if (UI_SYNC_BLOCKLIST.has(k)) {
          if (k === 'platformFilters') localPatch.platform_filters = pending[k]
          else if (k === 'keywordHighlights') localPatch.keyword_highlights = pending[k]
        } else {
          syncPatch[k] = pending[k]
        }
      }

      if (Object.keys(localPatch).length) {
        invalidateUiOverflowCache()
        chrome.storage.local.set(localPatch).catch(() => {})
      }

      if (Object.keys(syncPatch).length) {
        invalidateUiSettingsCache()
        chrome.storage.sync.get(['ui_settings']).then(async s => {
          const merged = sanitizeUiSettings({ ...s.ui_settings, ...syncPatch })
          // Quota guard: chrome.storage.sync caps each key at 8192 bytes.
          // Check usage before writing — warn + toast if near the ceiling.
          try {
            const used = await chrome.storage.sync.getBytesInUse('ui_settings')
            if (used > 7000) {
              warn('ui_settings quota near limit:', used, '/ 8192 bytes')
              showToast('settings storage near limit — some preferences may not save across devices', 'error')
            }
          } catch (_) { /* getBytesInUse unavailable (Firefox MV2) — skip check */ }
          chrome.storage.sync.set({ ui_settings: merged }).catch(err => {
            warn('ui_settings write failed:', err?.message)
            showToast('settings failed to save — storage quota exceeded', 'error')
          })
        })
        // Cross-surface insta-sync: server merges + fans out to every other
        // client of this user (other tabs, ext on Twitch/Kick/YT, heatsync.org).
        // chrome.storage.sync only syncs Chrome → Chrome with same Google
        // account; server-backed covers Firefox + heatsync.org + signed-out
        // Chrome profiles using the same heatsync login. Blocklist keys are
        // omitted — they're per-device by design.
        try {
          chrome.runtime.sendMessage({
            type: 'ws_send',
            data: { type: 'ui-state:sync', patch: syncPatch }
          })
        } catch (_) { /* context invalidated */ }
      }
    }, 100)
  }

  // ─── settings registry engine ─────────────────────────────────────────
  // SETTINGS (src/lib/settings-schema.js) is the declarative catalog; this
  // engine is the single runtime around it: hydrate (loadAllSettings), read
  // (getSetting), write (setSetting → existing saveUiSetting/local storage
  // paths, preserving the debounce, sync/local split, quota guard, and ws
  // ui-state:sync fanout), reset (resetSettingsToDefaults). Legacy
  // module-level `let` vars stay the in-render source of truth via
  // _RUNTIME_BRIDGE until every reader moves to getSetting(); the bridge
  // keeps both views of a value identical during the migration.
  const _SETTINGS_BY_KEY = new Map(SETTINGS.map(function(d) { return [d.key, d] }))
  const _settingsCache = {}
  // locale option labels live in browser-api.js (single source of locale
  // display names) — hydrate the schema's value-only options once
  for (const _locOpt of _SETTINGS_BY_KEY.get('hs_ui_locale').options) {
    _locOpt.label = I18N_LOCALE_NAMES[_locOpt.value] || _locOpt.value
  }

  // runtimeVar name → {get,set} over the legacy module-level binding.
  // Closures only execute post-init, so referencing `let`s declared further
  // down the file (or in modules) is TDZ-safe here.
  const _RUNTIME_BRIDGE = {
    wysiwygEnabled: { get: function() { return wysiwygEnabled }, set: function(v) { wysiwygEnabled = v } },
    linksEnabled: { get: function() { return linksEnabled }, set: function(v) { linksEnabled = v } },
    linkPreviewsEnabled: { get: function() { return linkPreviewsEnabled }, set: function(v) { linkPreviewsEnabled = v } },
    viModeEnabled: { get: function() { return viModeEnabled }, set: function(v) { viModeEnabled = v } },
    platformBadgesEnabled: { get: function() { return platformBadgesEnabled }, set: function(v) { platformBadgesEnabled = v } },
    zebraEnabled: { get: function() { return zebraEnabled }, set: function(v) { zebraEnabled = v } },
    multichatOverlayEnabled: { get: function() { return multichatOverlayEnabled }, set: function(v) { multichatOverlayEnabled = v } },
    // setter also feeds the window flag content.js reads for timestamp paint
    timestampsEnabled: { get: function() { return timestampsEnabled }, set: function(v) { timestampsEnabled = v; window._hsTimestampsEnabled = v } },
    avatarsEnabled: { get: function() { return avatarsEnabled }, set: function(v) { avatarsEnabled = v } },
    autoClaimPoints: { get: function() { return autoClaimPoints }, set: function(v) { autoClaimPoints = v } },
    dimTimeouts: { get: function() { return dimTimeouts }, set: function(v) { dimTimeouts = v } },
    readableNamesEnabled: { get: function() { return readableNamesEnabled }, set: function(v) { readableNamesEnabled = v } },
    autoHideInput: { get: function() { return autoHideInput }, set: function(v) { autoHideInput = v } },
    firstChatterGlow: { get: function() { return firstChatterGlow }, set: function(v) { firstChatterGlow = v } },
    keywordHighlights: { get: function() { return keywordHighlights }, set: function(v) { keywordHighlights = v } },
    emoteSize: { get: function() { return emoteSize }, set: function(v) { emoteSize = v } },
    emojiSize: { get: function() { return emojiSize }, set: function(v) { emojiSize = v } },
    domRenderCap: { get: function() { return DOM_RENDER_CAP }, set: function(v) { DOM_RENDER_CAP = v } },
    emoteAnimationEnabled: { get: function() { return emoteAnimationEnabled }, set: function(v) { emoteAnimationEnabled = v } },
    tabPosition: { get: function() { return tabPosition }, set: function(v) { tabPosition = v } },
    chatPosition: { get: function() { return chatPosition }, set: function(v) { chatPosition = v } },
    modToolbarButtons: { get: function() { return [...modToolbarButtons] }, set: function(v) { modToolbarButtons = v.filter(function(id) { return MOD_BUTTON_CATALOG[id] }) } },
    hiddenTabs: { get: function() { return [...hiddenTabs] }, set: function(v) { hiddenTabs = new Set(v) } },
    // boolmap runtime objects — coercion already filtered to known subkeys
    inlineNotifs: { get: function() { return { ...inlineNotifs } }, set: function(v) { for (const k in v) inlineNotifs[k] = !!v[k] } },
    hermesToggles: { get: function() { return { ...hermesToggles } }, set: function(v) { for (const k in v) hermesToggles[k] = !!v[k] } },
  }
  // apply id → side-effect runner. Each mirrors the legacy toggle/save
  // function's effects exactly. onLoad=true on the single init pass —
  // skips work that only makes sense on an interactive change.
  const _APPLIERS = {
    rebuildInput: function() { rebuildInput() },
    viMode: function(v) {
      // mirror to localStorage + notify MAIN-world vi-mode.js
      try {
        const ls = JSON.parse(localStorage.getItem('heatsync-extension-settings') || '{}')
        ls.viMode = v
        localStorage.setItem('heatsync-extension-settings', JSON.stringify(ls))
      } catch (_) {}
      window.postMessage({ type: 'heatsync-settings-changed', nonce: window.HS?.getMainWorldNonce?.() || null, settings: { viMode: v } }, location.origin)
    },
    autoHide: function(v) {
      const bar = document.getElementById('hs-mc-inputbar')
      const pickerOpen = document.getElementById('hs-mc-emote-picker')?.classList.contains('visible') || false
      if (v) {
        if (bar) bar.classList.add('hs-hidden')
        inputBarVisible = false
      } else {
        if (bar) bar.classList.remove('hs-hidden')
        inputBarVisible = true
      }
      adjustOverlayForPicker(pickerOpen)
    },
    autoClaim: function(v) { if (v) startAutoClaimPoller(); else stopAutoClaimPoller() },
    ytSuggestions: function(v) {
      // YT-only body class; CSS un-collapses #secondary into a vertical strip
      // beside the title column (left/right dock). Harmless off-YT (no match).
      try { document.body.classList.toggle('hs-yt-suggestions', !!v) } catch (_) {}
      try { applyPlatformPositionOverrides() } catch (_) {}
    },
    ytNonLiveChat: function(v) {
      // YT-only opt-in: when ON, show the panel on non-live pages too (VOD/home);
      // default OFF hides it everywhere except livestreams (gated in CSS against
      // hs-yt-has-livechat). Harmless off-YT (no match).
      try { document.body.classList.toggle('hs-yt-nonlive-chat', !!v) } catch (_) {}
    },
    keywordRegex: function() { rebuildKeywordRegex() },
    fonts: function() {
      applyFontSettings(getSetting('fontFamily'), getSetting('fontSize'), getSetting('customFontName'))
    },
    emoteSize: function(v, def, onLoad) {
      applyEmoteSize()
      if (onLoad) return
      // URLs encode size — picker DOM is now stale
      markPickerDirty()
      prebuildPickerIdle()
    },
    emojiSize: function() { applyEmojiSize() },
    hiddenTabs: function() { applyHiddenTabs() },
    // density — pure CSS vars, no re-render needed
    density: function() {
      const pad = getSetting('messageDensity') === 'cozy' ? '5px 8px' : '2px 4px'
      const root = document.documentElement
      root.style.setProperty('--hs-mc-row-pad', pad)
      root.style.setProperty('--hs-mc-row-lh', getSetting('lineHeight') + 'px')
    },
    // render cap — debounced re-render (range fires per step)
    renderCap: (function() {
      let t = null
      return function() {
        if (t) cleanup.clearTimeout(t)
        t = cleanup.setTimeout(function() {
          t = null
          if (currentTab !== 'settings') renderMessages(currentTab)
        }, 300)
      }
    })(),
    muteKeywords: function() { rebuildMuteKeywordsRegex() },
    // rendered html is cached per message — a src change needs a cache
    // flush before the re-render or old animated imgs survive the toggle
    emoteAnimation: function(v, def, onLoad) {
      if (onLoad) return
      clearRenderedHtmlCache()
      renderMessages(currentTab)
    },
    locale: function(v) { setI18nLocale(v).catch(function() {}) },
    modToolbar: function() { if (typeof _modToolbar !== 'undefined' && _modToolbar) rebuildModToolbarButtons() },
    tabPosition: function() { applyTabsPosition() },
    chatPosition: function(v, def, onLoad, isRemote) {
      applyChatPosition()
      // visible positions become the hide-toggle restore point (mirrors
      // toggleChatHidden's previous-tracking). remote changes update the
      // local var but skip the write-back — the originating tab persisted it
      if (v && v !== 'hidden' && v !== chatPositionPrevious) {
        chatPositionPrevious = v
        if (!isRemote) saveUiSetting('chatPositionPrevious', v)
      }
    },
    automod: function() {
      compileAutomod({ automodAllCaps: getSetting('automodAllCaps'), automodRegex: getSetting('automodRegex') })
    },
    notifPermission: function(v) {
      if (!v) return
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(function() {})
      }
    },
    mentionPing: function(v) {
      if (!(v > 0)) return
      if (typeof playMentionPing === 'function') {
        try { playMentionPing(v) } catch (_) {}
      }
    },
    // content-warning toggles PATCH the server; the local write is already
    // optimistic (setSetting persisted it) — roll back on failure. BG picks
    // up the storage change via onChanged and re-appends include_* params;
    // refresh_all flushes inline emote caches on success.
    // Subsystem pills — live gates apply immediately (their code paths
    // check isEnabled at use time); reload-tagged flips get a toast. Tab
    // affordances of gated subsystems hide/show right away.
    subsystemToggle: function() {
      applyHiddenTabs()
      // persistent [reload] chips (rendered per-row from _gatesAtBoot)
      // replace the old one-shot toast
      if (currentTab === 'settings') renderSettingsTab()
    },
    cwServerPatch: function(v, def) {
      safeSendMessage({
        type: 'api_fetch',
        path: '/api/user/settings',
        method: 'PATCH',
        auth: true,
        body: { [def.cw.serverBody]: v }
      }).then(function(resp) {
        if (!resp || !resp.ok) { _cwRollback(def, v); return }
        safeSendMessage({ type: 'refresh_all' }).catch(function() {})
      }).catch(function() { _cwRollback(def, v) })
    },
    // Overlay on/off needs a clean boot either way: the live teardown left
    // the native chat column blank (the overlay hides it at init and only
    // youtube's iframe was restored), and turning it ON in a lite-booted
    // tab would mount UI with no init behind it. Flush the setting
    // explicitly (the debounced writer wouldn't survive the reload), then
    // reload — visible tab immediately, background tabs when next visible.
    multichatOverlay: function(v, def, onLoad, isRemote) {
      if (onLoad) return
      if (isRemote) { _liteReload(); return } // already persisted remotely — just reload
      showToast(v ? 'multichat back on — reloading' : 'emotes-only mode — reloading', 'info')
      try {
        chrome.storage.sync.get('ui_settings', function(d) {
          const ui = (d && d.ui_settings) || {}
          chrome.storage.sync.set({ ui_settings: sanitizeUiSettings({ ...ui, multichatOverlayEnabled: !!v }) }, function() {
            if (chrome.runtime.lastError) {
              console.warn('[heatsync-ext] overlay mode save failed:', chrome.runtime.lastError.message)
            }
            _liteReload()
          })
        })
      } catch (_) { _liteReload() }
    },
  }

  // Reload for overlay-mode flips — visible tab reloads now, hidden tabs
  // defer to visibilitychange (same anti-thundering-herd shape as the
  // ext-reload path). Deduped per page.
  function _liteReload() {
    if (window.__hsLiteReloadScheduled) return
    window.__hsLiteReloadScheduled = true
    const doReload = () => { try { location.reload() } catch (_) {} }
    if (document.visibilityState === 'visible') {
      setTimeout(doReload, 150)
    } else {
      document.addEventListener('visibilitychange', function once() {
        if (document.visibilityState !== 'visible') return
        document.removeEventListener('visibilitychange', once)
        setTimeout(doReload, 300 + Math.random() * 1500)
      })
    }
  }

  function _cwRollback(def, attempted) {
    setSetting(def.key, !attempted, { silent: true })
    document.querySelectorAll('.hs-mc-toggle-pill[data-set-key="' + def.key + '"]')
      .forEach(function(pill) { pill.classList.toggle('active', !attempted) })
    showToast('failed to save ' + def.cw.noun + ' — try again', 'error')
  }

  // Resolve the legacy runtime binding for an entry (entries without one
  // are served from _settingsCache after hydration).
  function _bridgeFor(def) {
    return def.runtimeVar ? _RUNTIME_BRIDGE[def.runtimeVar] : null
  }

  /**
   * @param {string} key registry storage key
   * @returns {*} current value (cache → runtime bridge → default)
   */
  function getSetting(key) {
    const def = _SETTINGS_BY_KEY.get(key)
    if (!def) { warn('getSetting: unknown key', key); return undefined }
    if (key in _settingsCache) return _settingsCache[key]
    const bridge = _bridgeFor(def)
    return bridge ? bridge.get() : def.default
  }

  // Single write path: coerce + validate, update cache + legacy binding,
  // persist through the existing storage routes, run the applier.
  // opts.silent skips applier + rerender (storage-change rehydration uses it
  // to avoid re-applying a value the local write just set).
  /**
   * @param {string} key registry storage key
   * @param {*} value coerced + validated before write
   * @param {{silent?: boolean}} [opts] silent skips appliers + re-renders
   * @returns {boolean} false when the key is unknown or the value invalid
   */
  function setSetting(key, value, opts) {
    const def = _SETTINGS_BY_KEY.get(key)
    if (!def) { warn('setSetting: unknown key', key); return false }
    const v = coerceSettingValue(def, value)
    if (v === undefined || !validateSettingValue(def, v)) {
      warn('setSetting: invalid value for', key, value)
      return false
    }
    _settingsCache[key] = v
    const bridge = _bridgeFor(def)
    if (bridge) bridge.set(v)
    if (def.scope === 'local') {
      chrome.storage.local.set({ [key]: v }).catch(function() {})
    } else {
      // sync + local-mirror both route through saveUiSetting — it owns the
      // debounce, UI_SYNC_BLOCKLIST split, quota guard, and ws sync patch
      saveUiSetting(key, v)
    }
    if (!opts || !opts.silent) {
      const applier = def.apply && _APPLIERS[def.apply]
      if (applier) { try { applier(v, def, false) } catch (e) { warn('applier failed:', def.apply, e) } }
      if (def.rerender) {
        // rows render through an insert-only DOM diff — existing rows are
        // never rebuilt without an epoch bump, so a visual toggle would
        // only affect newly arriving messages
        bumpRenderEpoch()
        renderMessages(currentTab)
      }
      // re-render the panel when the entry asks for it OR when another
      // entry's dependsOn watches this key (progressive disclosure)
      if ((def.rerenderSettings || _DEPENDS_PARENTS.has(key)) && currentTab === 'settings') renderSettingsTab()
    }
    return true
  }
  const _DEPENDS_PARENTS = new Set(SETTINGS.filter(function(d) { return d.dependsOn }).map(function(d) { return d.dependsOn.key }))

  // ─── subsystem gates ────────────────────────────────────────────────────
  // isEnabled(id): live read — server health kill-list wins, then the
  // user's ui_settings.subsystems map (default ON). Live-tagged code paths
  // (mentions, stream-stats, right-click-block) call this at use time.
  // gateAtBoot(id): the init()-time snapshot — every init guard reads this
  // so a mid-init storage write can't half-apply a subsystem.
  let _gatesAtBoot = null
  function isEnabled(id) {
    try { if (window.__hsHealth?.disabled?.includes(id)) return false } catch (_) {}
    return getSetting('subsystems')[id] !== false
  }
  function snapshotGates() {
    _gatesAtBoot = Object.assign({}, getSetting('subsystems'))
  }
  function gateAtBoot(id) {
    try { if (window.__hsHealth?.disabled?.includes(id)) return false } catch (_) {}
    return !_gatesAtBoot || _gatesAtBoot[id] !== false
  }

  // One hydration pass over the whole registry — replaces the per-setting
  // loadXSetting() functions. Reads the shared init caches, fills
  // cache + bridge, runs one-shot migrations, then runs each distinct
  // applier once (onLoad=true).
  async function loadAllSettings() {
    const localKeys = SETTINGS.filter(function(d) { return d.scope === 'local' }).map(function(d) { return d.key })
    const [synced, local, overflow] = await Promise.all([
      cachedUiSettings().catch(function() { return {} }),
      localKeys.length ? chrome.storage.local.get(localKeys).catch(function() { return {} }) : {},
      cachedUiOverflow().catch(function() { return {} }),
    ])
    const ui = (synced && synced.ui_settings) || {}
    // custom presets ride along in ui_settings (not a registry entry —
    // they're user data, not a setting)
    _customPresets = Array.isArray(ui.customPresets)
      ? ui.customPresets.filter(function(p) { return p && typeof p === 'object' && p.id && p.name && p.diff && typeof p.diff === 'object' })
      : []
    // applier id → def; dedupes shared ids (the three font keys all map to
    // 'fonts'). Only applyOnLoad entries run here — set-time-only effects
    // (rebuildInput, notification permission, ping preview) never fire on init.
    const appliersToRun = new Map()
    const firstRunLocal = {}

    for (const def of SETTINGS) {
      // one-shot default-flip migration (e.g. wysiwyg false→true retirement):
      // until the guard key is stamped, force the new default and persist both
      if (def.migrate && !ui[def.migrate]) {
        _settingsCache[def.key] = def.default
        const b = _bridgeFor(def)
        if (b) b.set(def.default)
        saveUiSetting(def.key, def.default)
        saveUiSetting(def.migrate, true)
        if (def.apply && def.applyOnLoad) appliersToRun.set(def.apply, def)
        continue
      }

      let raw
      if (def.scope === 'sync') raw = ui[def.key]
      else if (def.scope === 'local') raw = local[def.key]
      else raw = overflow[def.mirrorKey]

      // local-mirror one-shot migration: legacy installs still hold the
      // value in sync — adopt it and persist to the local overflow bucket
      if (raw === undefined && def.legacySyncFallback && ui[def.key] !== undefined) {
        raw = ui[def.key]
        if (validateSettingValue(def, coerceSettingValue(def, raw))) {
          chrome.storage.local.set({ [def.mirrorKey]: coerceSettingValue(def, raw) }).catch(function() {})
        }
      }
      // retired-key migration (e.g. bigEmoji false → emoji size 1x)
      if (raw === undefined && def.legacy) {
        try { raw = def.legacy(ui, local) } catch (_) {}
      }
      // first run for self-announcing local keys: persist the default so
      // other surfaces (options page) render the real state
      if (raw === undefined && def.firstRunPersist) firstRunLocal[def.key] = def.default

      const v = raw === undefined ? def.default : coerceSettingValue(def, raw)
      const value = (v !== undefined && validateSettingValue(def, v)) ? v : def.default
      _settingsCache[def.key] = value
      const bridge = _bridgeFor(def)
      if (bridge) bridge.set(value)
      if (def.apply && def.applyOnLoad) appliersToRun.set(def.apply, def)
    }

    if (Object.keys(firstRunLocal).length) {
      chrome.storage.local.set(firstRunLocal).catch(function() {})
    }
    // one-shot: the retired F-/F+ buttons stored a per-device size override in
    // localStorage that quietly beat the fontSize setting. Fold the user's last
    // size into fontSize (the slider now owns it), then drop the legacy key so
    // this runs only once. Done before appliers so the fonts applier paints it.
    try {
      const ov = parseInt(localStorage.getItem('heatsync-chat-font-size'), 10)
      if (ov >= 10 && ov <= 22) {
        if (ov !== _settingsCache.fontSize) { _settingsCache.fontSize = ov; saveUiSetting('fontSize', ov) }
        localStorage.removeItem('heatsync-chat-font-size')
      }
    } catch (_) {}
    // boot snapshot for reload-applied entries — drives the [reload] chip
    for (const def of SETTINGS) {
      if (def.reloadApply) _bootVals[def.key] = getSetting(def.key)
    }
    for (const [id, def] of appliersToRun) {
      const applier = _APPLIERS[id]
      if (applier) { try { applier(getSetting(def.key), def, true) } catch (e) { warn('load applier failed:', id, e) } }
    }
  }

  // Registry-derived reset — every entry returns to its default through the
  // normal setSetting path (storage write + bridge + applier). noReset
  // entries (server-coupled content-warning prefs) are left untouched.
  // Sync writes coalesce into one debounced ui_settings patch.
  function resetSettingsToDefaults() {
    for (const def of SETTINGS) {
      if (def.noReset) continue
      setSetting(def.key, def.default)
    }
    renderSettingsTab()
  }

  // Generic control dispatch — resolves a clicked/changed element to its
  // registry entry via data-set-key. Returns true when handled.
  function handleRegistryControl(el, rawValue) {
    const ds = el.dataset
    const def = ds.setKey && _SETTINGS_BY_KEY.get(ds.setKey)
    if (!def) return false
    // boolmap subkey pill — flip one subkey, persist the whole map
    if (def.type === 'boolmap' && ds.setSub !== undefined) {
      const map = Object.assign({}, getSetting(def.key))
      map[ds.setSub] = !map[ds.setSub]
      if (setSetting(def.key, map)) {
        el.classList.toggle('active', map[ds.setSub])
        _syncRowModEdge(el, def, def.options.find(function(o) { return String(o.value) === ds.setSub }))
      }
      return true
    }
    // multiselect member pill — toggle membership (invertDisplay = stored
    // set is "hidden" but pills show "visible")
    if (def.type === 'multiselect' && ds.setValue !== undefined) {
      const cur = getSetting(def.key)
      const val = ds.setValue
      const next = cur.includes(val) ? cur.filter(function(x) { return x !== val }) : cur.concat(val)
      if (setSetting(def.key, next)) {
        const member = next.includes(val)
        el.classList.toggle('active', def.invertDisplay ? !member : member)
        _syncRowModEdge(el, def, def.options.find(function(o) { return String(o.value) === val }))
      }
      return true
    }
    // segmented enum button — value carried on the button
    if (def.type === 'enum' && ds.setValue !== undefined) {
      if (setSetting(def.key, ds.setValue)) {
        const row = el.closest('.hs-mc-setting-row')
        if (row) {
          const cur2 = String(getSetting(def.key))
          row.querySelectorAll('[data-set-value]').forEach(function(b) {
            b.classList.toggle('active', b.dataset.setValue === cur2)
          })
        }
        _syncRowModEdge(el, def)
      }
      return true
    }
    if (def.type === 'bool') {
      const next = !getSetting(def.key)
      if (setSetting(def.key, next)) {
        el.classList.toggle('active', next)
        _syncRowModEdge(el, def)
      }
      return true
    }
    if (setSetting(def.key, rawValue !== undefined ? rawValue : el.value)) {
      _syncRowModEdge(el, def)
      return true
    }
    return false
  }

  // Stream events persistence — survives tab switches AND page refresh
  const STREAM_EVENTS_KEY = 'hs_stream_events';
  const STREAM_EVENTS_MAX = 200;
  let streamEventsLoaded = false;

  // Inject stream events into IRC buffers + activityEvents (deduped)
  // recentOnly: only inject events <15min old into chat buffers (on reload)
  function injectStreamEventsIntoBuffers(events, recentOnly = false) {
    const liveCh = getLiveChannel()
    const liveBuffer = liveCh ? irc?.channels?.get(liveCh) : null
    const chatCutoff = recentOnly ? Date.now() - 900000 : 0 // 15min
    let added = 0

    for (const evt of events) {
      const ch = evt.channel
      if (!ch) continue

      // On replay (overlay load / reconnect) drop "went live" events. They are,
      // by definition, channels that were ALREADY live when you opened — a wall
      // of online dumps (plus stale dupes when a channel switched games while
      // you were away). Genuine go-lives that happen DURING the session still
      // surface via the realtime stream_event / follow_stream_event listeners,
      // which don't go through this replay path. offline + game-switch replay
      // fine (low volume, useful context).
      if (recentOnly && evt.eventClass?.includes('event-online')) continue

      const injectToChat = !recentOnly || (evt.time && evt.time > chatCutoff)
      const isFollowEvent = evt.eventClass?.includes('event-follow')

      // Inject into the channel's own buffer
      if (injectToChat) {
        const buffer = irc?.channels?.get(ch)
        if (buffer) {
          const existing = buffer.getAll()
          const isDupe = existing.some(m => m.type === 'stream-event' && m.text === evt.text)
          if (!isDupe) { buffer.push(evt); added++ }
        }
      }

      // Follow events (went live, switched game) go into live buffer for all followed channels
      // Channel-specific events (redeems, raids, hype) only go to live buffer if channel matches
      if (injectToChat && liveBuffer) {
        const liveBufferMatch = isFollowEvent || ch === liveCh
        if (liveBufferMatch) {
          const chBuffer = irc?.channels?.get(ch)
          if (liveBuffer !== chBuffer) {
            const existing = liveBuffer.getAll()
            const isDupe = existing.some(m => m.type === 'stream-event' && m.text === evt.text)
            if (!isDupe) { liveBuffer.push(evt); added++ }
          }
        }
      }

      // Always push to activityEvents regardless of age
      pushActivityEvent(evt)
    }
    return added
  }

  async function loadStreamEvents() {
    try {
      const data = await api.storage.local.get(STREAM_EVENTS_KEY)
      const events = data[STREAM_EVENTS_KEY]
      if (!Array.isArray(events) || events.length === 0) return
      const cutoff = Date.now() - 86400000 // 24h expiry
      // Dedup by text (multi-tab race can create duplicate entries in storage)
      const seenTexts = new Set()
      const valid = []
      for (const e of events) {
        if (e.time <= cutoff) continue
        if (e.text && seenTexts.has(e.text)) continue
        seenTexts.add(e.text)
        valid.push(e)
      }


      injectStreamEventsIntoBuffers(valid, true)

      // Seed dedup map so realtime handlers don't re-add loaded events.
      // Seed with the event's ORIGINAL time, not Date.now(): the 60s dedup
      // window is for echo-suppression of fresh broadcasts. Seeding with
      // `now` makes every loaded event look just-arrived and blocks legit
      // new same-text events for 60s after every reload.
      if (!window._hsStreamEventDedup) window._hsStreamEventDedup = new Map()
      for (const e of valid) {
        if (e.text && e.time) window._hsStreamEventDedup.set(e.text, e.time)
      }

      // Prune expired + deduped from storage
      if (valid.length < events.length) {
        await api.storage.local.set({ [STREAM_EVENTS_KEY]: valid })
      }
      streamEventsLoaded = true
    } catch {}
  }

  // Queued storage writer — prevents concurrent read-modify-write races
  let saveQueue = Promise.resolve()

  async function saveStreamEvent(evt) {
    saveQueue = saveQueue.then(async () => {
      try {
        const data = await api.storage.local.get(STREAM_EVENTS_KEY)
        const events = data[STREAM_EVENTS_KEY] || []
        // Dedup by text before saving
        if (!events.some(e => e.text === evt.text)) {
          events.push(evt)
        }
        // Prune old events (keep last STREAM_EVENTS_MAX)
        if (events.length > STREAM_EVENTS_MAX) events.splice(0, events.length - STREAM_EVENTS_MAX)
        await api.storage.local.set({ [STREAM_EVENTS_KEY]: events })
      } catch {}
    })
    return saveQueue
  }

  async function saveStreamEventsBatch(evts) {
    saveQueue = saveQueue.then(async () => {
      try {
        const data = await api.storage.local.get(STREAM_EVENTS_KEY)
        const events = data[STREAM_EVENTS_KEY] || []
        const existingTexts = new Set(events.map(e => e.text))
        for (const evt of evts) {
          if (!existingTexts.has(evt.text)) {
            events.push(evt)
            existingTexts.add(evt.text)
          }
        }
        if (events.length > STREAM_EVENTS_MAX) events.splice(0, events.length - STREAM_EVENTS_MAX)
        await api.storage.local.set({ [STREAM_EVENTS_KEY]: events })
      } catch {}
    })
    return saveQueue
  }


  // Dedup: track recent server-sourced YouTube messages to skip content-script duplicates

  // Normalize YouTube URL — accepts full URLs or bare username
  const normalizeYtUrl = (raw) => {
    // Bare username (no slashes, no dots) → /@name/live
    if (/^@?[\w-]+$/.test(raw)) {
      const name = raw.startsWith('@') ? raw.slice(1) : raw
      return 'https://www.youtube.com/@' + name + '/live'
    }
    try {
      const u = new URL(raw)
      const v = u.searchParams.get('v')
      if (v) return 'https://www.youtube.com/watch?v=' + v
      const liveMatch = raw.match(/\/live\/([^?&\/]+)/)
      if (liveMatch) return 'https://www.youtube.com/live/' + liveMatch[1]
      const shortMatch = raw.match(/youtu\.be\/([^?&]+)/)
      if (shortMatch) return 'https://www.youtube.com/watch?v=' + shortMatch[1]
    } catch {}
    return raw
  }

  // ============================================
  // REACT UTILITIES (FFZ-STYLE)
  // ============================================

  /**
   * Find the chat room container component
   */
  function findChatRoomComponent() {
    // Try multiple starting points (including popout chat selectors)
    const selectors = [
      '[class*="chat-room"]',
      CONFIG.SELECTORS.TWITCH_STREAM_CHAT,
      '[data-test-selector="chat-room-component"]',
      '[data-a-target="chat-room-component"]',
      CONFIG.SELECTORS.TWITCH_CHAT_SHELL,
      '.chat-room'
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;

      // Look for component with render method and chat-related props
      const result = findComponent(el, (inst, fiber) => {
        // Check if this is a class component with render
        if (typeof inst?.render !== 'function') return false;

        // Check fiber type name for chat-related components
        const typeName = fiber?.type?.displayName || fiber?.type?.name || '';
        if (typeName.toLowerCase().includes('chat')) return true;

        // Check for chat-related props (direct key probe — JSON.stringify per
        // fiber level was burning ~30× on every retry)
        const props = inst.props
        if (props) {
          for (const k in props) {
            if (k === 'channel' || k === 'room' || k.startsWith('channel') || k.startsWith('room')) return true
          }
        }

        return false;
      }, 30);

      if (result) return result;
    }

    return null;
  }

  // ============================================
  // UI CREATION (React-compatible elements)
  // ============================================

  function createTabBar() {
    const container = document.createElement('div');
    container.id = 'hs-mc-tabbar';
    container.dir = HS_DIR();
    // Static hardcoded tab buttons — no user input, safe innerHTML
    // Two sections: scrollable channel tabs + fixed utility buttons (always visible)
    // Static hardcoded buttons — all in one wrapping flow, no user input
    container.innerHTML = `
      <div class="hs-mc-tabs-scroll">
        <button class="hs-mc-tab active" data-tab="feed">${t('mc_tab_feed')}</button>
        <button class="hs-mc-tab" data-tab="whispers">${t('mc_tab_whispers')}</button>
        <button class="hs-mc-tab" data-tab="mentions">${t('mc_tab_mentions')}</button>
        <button class="hs-mc-tab" data-tab="pinned">${t('mc_tab_pinned')}</button>
        <button class="hs-mc-tab" data-tab="live">${t('mc_tab_live')}</button>
        <button class="hs-mc-tab" data-tab="add">+</button>
      </div>
      <div class="hs-mc-right-cluster">
        <div class="hs-mc-util-row">
          <button class="hs-mc-tab hs-mc-util-btn" data-tab="settings" title="${t('mc_btn_settings')}">\u2699</button>
          <button class="hs-mc-tab hs-mc-util-btn hs-mc-collapse-btn" id="hs-mc-collapse-btn" data-tab="collapse" title="hide chat (\\)" aria-label="hide chat"></button>
          <button class="hs-mc-tab hs-mc-util-btn hs-mc-popout-btn" data-tab="popout" title="pop out chat to standalone window" style="display:none">\u26f6</button>
        </div>
        <div id="hs-mc-platfilter"></div>
      </div>
    `;

    // Event delegation for tab clicks
    container.addEventListener('click', (e) => {
      const tab = e.target.closest('.hs-mc-tab');
      if (!tab) return;

      const tabId = tab.dataset.tab;
      log('Tab clicked:', tabId);
      // Acknowledge unread indicators on click — guarantees clearing even on
      // paths that don't run switchTab (live picker), and survives any new
      // mention that lands in the same frame between click and render.
      tab.classList.remove('has-mentions', 'has-new', 'has-stream-event');
      if (tabId === 'mentions') bumpSeen('mentions');
      else if (tabId === 'whispers') bumpSeen('whispers');
      else if (tabId === 'feed') bumpSeen('live');
      if (tabId === 'add') {
        switchTab('add');
      } else if (tabId === 'popout') {
        openPopoutForCurrentTab();
      } else if (tabId === 'live') {
        showLiveChannelPicker(tab);
      } else if (tabId === 'collapse') {
        toggleChatHidden();
      } else if (tabId === 'settings' && currentTab === 'settings') {
        switchTab(prevTab || 'feed');
      } else {
        switchTab(tabId);
      }
    });

    // Right-click tabs → mark as read + channel context menu
    container.addEventListener('contextmenu', (e) => {
      const tab = e.target.closest('.hs-mc-tab');
      if (!tab) return;
      const tabId = tab.dataset.tab;
      // Right-click any tab clears all unread indicators (mentions, new, stream-event)
      if (tab.classList.contains('has-mentions') || tab.classList.contains('has-new') || tab.classList.contains('has-stream-event')) {
        e.preventDefault();
        tab.classList.remove('has-mentions', 'has-new', 'has-stream-event');
        // Sync server-backed seen state so the dot doesn't reappear and
        // every other client clears via WS broadcast.
        if (tabId === 'mentions') bumpSeen('mentions');
        else if (tabId === 'whispers') bumpSeen('whispers');
        else if (tabId === 'feed') bumpSeen('live');
        return;
      }

      // Live tab gets platform edit context menu
      if (tabId === 'live') {
        e.preventDefault();
        document.getElementById('hs-mc-ctx-menu')?.remove();
        const menu = document.createElement('div');
        menu.id = 'hs-mc-ctx-menu';
        menu.style.cssText = 'position:fixed;z-index:99999;background:#000;border:1px solid #808080;border-radius:0;padding:4px 0;min-width:150px;font-size:13px;font-family:inherit;';
        const item = document.createElement('div');
        item.textContent = 'edit platforms';
        item.style.cssText = 'padding:6px 12px;cursor:pointer;color:#fff;';
        item.addEventListener('mouseenter', () => item.style.background = 'rgba(255,255,255,0.06)');
        item.addEventListener('mouseleave', () => item.style.background = '');
        item.addEventListener('click', () => { menu.remove(); showEditLivePlatforms(); });
        menu.appendChild(item);
        document.body.appendChild(menu);
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 4) + 'px';
        menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 4) + 'px';
        const dismiss = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', dismiss); } };
        cleanup.setTimeout(() => document.addEventListener('click', dismiss, { signal: mcSignal }), 0);
        return;
      }

      // Channel tabs get edit/remove context menu
      const reserved = ['feed', 'mentions', 'whispers', 'discover', 'pinned', 'add', 'settings'];
      if (reserved.includes(tabId)) return;
      e.preventDefault();

      // Remove any existing context menu
      document.getElementById('hs-mc-ctx-menu')?.remove();

      const ch = getChannelById(tabId);
      const menu = document.createElement('div');
      menu.id = 'hs-mc-ctx-menu';
      menu.style.cssText = 'position:fixed;z-index:99999;background:#000;border:1px solid #808080;border-radius:0;padding:4px 0;min-width:150px;font-size:13px;font-family:inherit;';

      const mkItem = (label, color, fn) => {
        const item = document.createElement('div');
        item.textContent = label;
        item.style.cssText = `padding:6px 12px;cursor:pointer;color:${color};`;
        item.addEventListener('mouseenter', () => item.style.background = 'rgba(255,255,255,0.06)');
        item.addEventListener('mouseleave', () => item.style.background = '');
        item.addEventListener('click', () => { menu.remove(); fn(); });
        menu.appendChild(item);
      };

      mkItem('edit', '#fff', () => showEditChannelForm(tabId));
      mkItem('remove', '#ff4444', () => removeChannel(tabId));

      // Append then clamp to viewport so it doesn't overflow off-screen
      document.body.appendChild(menu);
      const mw = menu.offsetWidth, mh = menu.offsetHeight;
      menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 4) + 'px';
      menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 4) + 'px';

      const dismiss = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', dismiss); } };
      cleanup.setTimeout(() => document.addEventListener('click', dismiss, { signal: mcSignal }), 0);
    });

    return container;
  }


  // Edit form active — block renders while editing channel config
  let editingChannel = false;

  // Track scroll state for "new messages" button
  let isScrolledUp = false;
  let emoteReloadTimer = null;
  // Track scopes (channel:X / global / inventory) whose first emote payload
  // we've already received this session. After first load, subsequent emote
  // updates skip clearRenderedHtmlCache so old messages keep their rendering
  // even when emotes are removed — "history is sacred" UX.
  const _emoteFirstLoad = new Set();
  // Scopes that arrived since the last debounce flush. Collected across
  // progressive broadcasts (BTTV/FFZ/7TV/Twitch arrive separately for the
  // same channel) so the eventual loadEmotes() knows every scope to
  // first-load-clear in one shot. Drained when the timer fires.
  let _pendingEmoteScopes = new Set();
  let newMessageCount = 0;
  let isProgrammaticScroll = false; // Flag to ignore programmatic scrolls

  // WYSIWYG mode (inline emote images in input)
  let wysiwygEnabled = true;

  // Clickable links in chat messages (default on)
  let linksEnabled = true;

  // Link preview tooltip on hover (default on)
  let linkPreviewsEnabled = true;

  // Vi mode for chat input (default off)
  let viModeEnabled = false;

  // Platform badges [T]/[K]/[Y] on messages (default on)
  let platformBadgesEnabled = true;

  // Zebra striping — alternate row backgrounds (default on)
  let zebraEnabled = true;

  // Emotes-only mode — when false, suppresses the multichat overlay entirely;
  // native-chat emotes and the picker button keep working normally (default on)
  let multichatOverlayEnabled = true;

  // Util row collapsed — hides C/T/F-/F+/⚙ for clean single-line tabs

  // User-hidable tabs — persisted in ui_settings.hiddenTabs (auto-syncs cross-device)
  const HIDABLE_TABS = ['feed', 'whispers', 'mentions', 'pinned'];
  // Default hidden — empty for new users until they enable in settings (saved/pinned tab)
  const DEFAULT_HIDDEN_TABS = ['pinned'];
  let hiddenTabs = new Set(DEFAULT_HIDDEN_TABS);

  // Timestamps on messages (default off)
  let timestampsEnabled = false;
  window._hsTimestampsEnabled = false;
  let avatarsEnabled = false;

  // Auto-claim Twitch channel points bonus chests across every twitch
  // channel in your multichat. Uses the official ClaimCommunityPoints GQL
  // call (same one Twitch's own UI fires) — pure user benefit, ToS-clean.
  // Toast notifies on each successful claim.
  let autoClaimPoints = true;

  // Dim timed-out/banned messages instead of hiding (default on)
  let dimTimeouts = true;

  // Boost username color brightness for readability on black bg (default on)
  let readableNamesEnabled = true;

  // Input bar auto-hide — hidden when empty, shown on first keystroke
  let autoHideInput = false;
  let inputBarVisible = true;

  // First-time chatter highlight — orange edge on first message from a user this session (default on)
  let firstChatterGlow = true;
  // channelLower → Set<usernameLower> seen this session
  const seenChattersByChannel = new Map();
  function markChatterSeen(channel, username) {
    if (!channel || !username) return false
    const ch = channel.toLowerCase()
    const u = username.toLowerCase()
    let set = seenChattersByChannel.get(ch)
    if (!set) {
      set = new Set(); seenChattersByChannel.set(ch, set)
      // Bound the OUTER map too: each unique channel ever visited (config +
      // every SPA-nav target) otherwise keeps its ~5000-name Set for the whole
      // session. Evict the oldest channel past a generous cap — mirrors the
      // LRU on knownColors/knownUserIds/mcUserCosmetics.
      if (seenChattersByChannel.size > 64) {
        seenChattersByChannel.delete(seenChattersByChannel.keys().next().value)
      }
    }
    if (set.has(u)) return false
    set.add(u)
    // LRU cap to 5000 per channel
    if (set.size > 5000) {
      const iter = set.values()
      for (let i = 0; i < 1000; i++) set.delete(iter.next().value)
    }
    return true
  }

  // Keyword highlights — newline-separated terms; messages containing any get an orange tint
  let keywordHighlights = '';
  let keywordHighlightsRegex = null;
  function rebuildKeywordRegex() {
    const terms = keywordHighlights.split(/\n/).map(s => s.trim()).filter(Boolean)
    if (!terms.length) { keywordHighlightsRegex = null; return }
    const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    try { keywordHighlightsRegex = new RegExp('\\b(' + escaped.join('|') + ')\\b', 'i') }
    catch { keywordHighlightsRegex = null }
  }

  // ═══ Inline notification routing ═══
  // Modular registry: each type can be toggled independently
  // Colors match website conventions
  // Derived from the settings registry boolmap entry — option rows carry
  // tag/color/label keys; i18n resolves here (t() unavailable in lib scope).
  const INLINE_NOTIF_TYPES = {}
  for (const o of _SETTINGS_BY_KEY.get('inlineNotifs').options) {
    INLINE_NOTIF_TYPES[o.value] = {
      tag: o.tag, color: o.color, borderColor: o.borderColor, defaultOn: o.default,
      label: o.labelKey ? t(o.labelKey) : o.label, desc: o.tipKey ? t(o.tipKey) : o.tip,
    }
  }
  // Runtime state: { op: true, re: false, dm: false, mention: true }
  const inlineNotifs = {}
  for (const [k, v] of Object.entries(INLINE_NOTIF_TYPES)) inlineNotifs[k] = v.defaultOn

  // Hermes event toggles (Twitch-native events: raids, hype trains, etc.) —
  // same registry derivation as INLINE_NOTIF_TYPES above.
  const HERMES_EVENT_TYPES = {}
  for (const o of _SETTINGS_BY_KEY.get('hermesEvents').options) {
    HERMES_EVENT_TYPES[o.value] = {
      color: o.color, defaultOn: o.default,
      label: o.labelKey ? t(o.labelKey) : o.label, desc: o.tipKey ? t(o.tipKey) : o.tip,
    }
  }
  const hermesToggles = {}
  for (const [k, v] of Object.entries(HERMES_EVENT_TYPES)) hermesToggles[k] = v.defaultOn

  function showInputBar() {
    if (inputBarVisible) return
    inputBarVisible = true
    const bar = document.getElementById('hs-mc-inputbar')
    if (bar) bar.classList.remove('hs-hidden')
    const overlay = document.getElementById('hs-mc-overlay')
    if (overlay) overlay.style.bottom = ''
    const picker = document.getElementById('hs-mc-emote-picker')
    adjustOverlayForPicker(picker?.classList.contains('visible') || false)
    // ResizeObserver doesn't fire on display:none → :flex; recompute anchors
    // so the docked Twitch callout follows the inputbar.
    _updateMcLayout?.()
  }

  function hideInputBar() {
    if (!autoHideInput) return
    if (!inputBarVisible) return
    const input = document.getElementById('hs-mc-input')
    const hasText = input ? (input.value || input.textContent || '').trim().length > 0 : false
    const hasContent = hasText || (input && input.querySelector('img, span.hs-mc-emoji'))
    if (hasContent) return
    // Don't hide while emote picker is open
    const picker = document.getElementById('hs-mc-emote-picker')
    if (picker?.classList.contains('visible')) return
    // Don't hide while reply is active
    if (replyState) return
    inputBarVisible = false
    const bar = document.getElementById('hs-mc-inputbar')
    if (bar) bar.classList.add('hs-hidden')
    const overlay = document.getElementById('hs-mc-overlay')
    if (overlay) overlay.style.bottom = '0'
    _updateMcLayout?.()
  }

  // Chat width state
  let chatWidth = 340; // Default width
  const DEFAULT_CHAT_WIDTH = 340;
  // 10px floor ≈ the bar's invisible grab-zone (2px line + 4px each side) —
  // chat can shrink to just the handle so the player nearly fills the
  // viewport, but the handle stays grabbable to drag it back. No artificial
  // "minimum usable size"
  // — user explicitly wants pixel-level freedom.
  const MIN_CHAT_WIDTH = 10;
  const MAX_CHAT_WIDTH = 800;
  // YouTube enforces #primary { min-width: 640px } — never let chat encroach
  // on the video player. The +20px fudge covers column-gap and scrollbar
  // gutter so we don't trip a 1px viewport overflow at the boundary.
  const YT_MIN_PRIMARY_WIDTH = 660;
  // YT suggestions strip (opt-in ytShowSuggestions → body.hs-yt-suggestions):
  // a fixed column beside the player on left/right dock. Single source of truth
  // for both the player-sizing arithmetic below AND the stylesheet — published
  // as --hs-yt-sugg-w so the CSS fallback (300px) is only a pre-JS placeholder.
  const YT_SUGG_STRIP_W = 300;
  // Twitch: when .channel-root__main shrinks below this, Twitch flips to its
  // narrow-stack layout — .persistent-player gets re-positioned absolute at
  // the bottom of the about section (y > 2000px), so the video falls below
  // the fold and the empty player slot at the top shows the "?" placeholder.
  // Cap chat-col width so main stays above this threshold.
  const TWITCH_MIN_MAIN_WIDTH = 600;
  const TWITCH_SIDE_NAV_WIDTH = 50; // left rail when collapsed; conservative
  const TWITCH_TOP_NAV_HEIGHT = 50; // .top-nav strip; hidden in theatre mode

  // Compute the largest chat width that won't squash YouTube's video column.
  // Bases on the watch-flexy container width (the actual flex-row that holds
  // primary + secondary) when available, falling back to viewport. Keeps a
  // YT_MIN_PRIMARY_WIDTH gutter for the player.
  function getYtMaxChatWidth() {
    if (hostPlatform !== 'yt') return MAX_CHAT_WIDTH
    const flexy = document.querySelector('ytd-watch-flexy:not([hidden])')
    const flexyW = flexy?.getBoundingClientRect?.().width || 0
    const vw = window.innerWidth || document.documentElement.clientWidth || 1280
    const available = flexyW > 0 ? Math.min(flexyW, vw) : vw
    return Math.max(MIN_CHAT_WIDTH, Math.min(MAX_CHAT_WIDTH, available - YT_MIN_PRIMARY_WIDTH))
  }

  // Twitch: max chat width that keeps .channel-root__main >= TWITCH_MIN_MAIN_WIDTH.
  // Vertical tab strip eats +90 from the right-column total, so subtract it
  // from the chat budget too. The 600 min only matters for chat-right —
  // there the right-column is part of Twitch's flex layout, and pushing
  // .channel-root__main below 600 trips Twitch's narrow-layout breakpoint
  // and teleports the persistent-player off-screen. For chat-left our panel
  // is a fixed-position overlay; it doesn't shrink channel-root, so the
  // breakpoint doesn't fire — applying 600 there just collapses the resize
  // range to a few px on narrow viewports. Use a much smaller player floor
  // (300) to keep a usable video area without crippling drag.
  function getTwitchMaxChatWidth() {
    if (hostPlatform !== 'twitch') return MAX_CHAT_WIDTH
    const vw = window.innerWidth || document.documentElement.clientWidth || 1280
    const tabStrip = (tabPosition === 'left' || tabPosition === 'right') ? 90 : 0
    const floor = (chatPosition && chatPosition !== 'right') ? 300 : TWITCH_MIN_MAIN_WIDTH
    const navW = (typeof _twitchSideNavW === 'number' && _twitchSideNavW > 0) ? _twitchSideNavW : TWITCH_SIDE_NAV_WIDTH
    const max = vw - navW - floor - tabStrip
    return Math.max(MIN_CHAT_WIDTH, Math.min(MAX_CHAT_WIDTH, max))
  }

  function createOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'hs-mc-overlay';
    overlay.dir = HS_DIR();
    // Static hardcoded layout — only static strings, no user input, safe innerHTML
    const searchPlaceholder = 'search messages…'
    overlay.innerHTML = `
      <div id="hs-mc-search-bar">
        <input id="hs-mc-search-input" type="text" placeholder="${searchPlaceholder}" autocomplete="off" spellcheck="false" />
        <div id="hs-mc-search-spinner"></div>
      </div>
      <div id="hs-mc-statusbar">
        <div id="hs-notif-layer-statusbar" class="hs-notif-layer hs-notif-layer-statusbar"></div>
      </div>
      <div id="hs-mc-multistream-banner" hidden></div>
      <div id="hs-mc-messages">
        <div class="hs-mc-empty">${t('mc_no_messages')}</div>
      </div>
      <button id="hs-mc-new-msgs" style="display:none"></button>
    `;

    // Setup scroll detection after DOM insertion
    cleanup.setTimeout(() => {
      const msgsEl = document.getElementById('hs-mc-messages');
      const newBtn = document.getElementById('hs-mc-new-msgs');
      if (!msgsEl || !newBtn) return;
      wireModToolbarHover(msgsEl);

      // Retry broken emote imgs — 7TV/BTTV/FFZ CDNs occasionally 503 and
      // surface as broken (naturalWidth=0). Capture phase since 'error' doesn't
      // bubble. Backoff 1s/3s/8s, max 3 tries, scoped to .hs-mc-emote.
      cleanup.addEventListener(msgsEl, 'error', (e) => {
        const img = e.target
        if (!(img instanceof HTMLImageElement)) return
        if (!img.classList.contains('hs-mc-emote')) return
        const tries = +(img.dataset.hsRetries || 0)
        if (tries >= 3 || !img.src || !img.isConnected) return
        img.dataset.hsRetries = String(tries + 1)
        const delay = tries === 0 ? 1000 : tries === 1 ? 3000 : 8000
        const target = img.src
        cleanup.setTimeout(() => {
          if (!img.isConnected || img.src !== target) return
          img.removeAttribute('src')
          img.src = target
        }, delay)
      }, true);

      const isStaticTab = () => currentTab === 'feed' || currentTab === 'settings' || currentTab === 'discover' || currentTab === 'pinned';

      // Bulletproof scroll-pause: ANY upward movement pauses chat sticky.
      // Resumes ONLY when user lands within 2px of true bottom OR clicks "new" button.
      // Prior 50px slop let small wheels/drags re-trigger auto-scroll, breaking pause.
      const ATBOTTOM_PX = 2
      const setPaused = (paused) => {
        if (paused) {
          if (!isScrolledUp) {
            isScrolledUp = true
            newBtn.innerHTML = newMessageCount > 0
              ? `<span class="hs-arrow-down">▼</span> ${t('mc_new_messages', [String(newMessageCount)])}`
              : `<span class="hs-arrow-down">▼</span> ${t('mc_resume')}`
            newBtn.style.display = 'flex'
          }
        } else {
          if (isScrolledUp) {
            isScrolledUp = false
            newMessageCount = 0
            newBtn.style.display = 'none'
          }
        }
      }

      // BULLETPROOF AUTO-SCROLL RULE:
      // isScrolledUp is set TRUE only by explicit user input — wheel-up,
      // touchmove going up, PageUp/Home/ArrowUp keys, mousedown on scrollbar
      // thumb. NEVER by passive scroll events from DOM mutation, render
      // churn, image-load layout shift, or programmatic scrollMsgsToBottom.
      // Resume (FALSE) only when scroll events confirm we're back at bottom
      // AFTER a user-driven scroll, OR via the new-msgs button click, OR
      // explicit programmatic resume on tab switch.
      let _scrollFrame = null
      let _userInputScroll = false  // set by wheel/touch/key, cleared after scroll settles
      mcSignal.addEventListener('abort', () => {
        if (_scrollFrame) { cancelAnimationFrame(_scrollFrame); _scrollFrame = null }
      })

      const checkAtBottom = () => {
        if (isStaticTab()) return msgsEl.scrollTop <= ATBOTTOM_PX
        return (msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight) <= ATBOTTOM_PX
      }

      // Scroll/scrollend handler: ONLY resumes (sets isScrolledUp=false when
      // user-driven scroll lands at bottom). Never pauses — passive scroll
      // events caused by DOM mutation during boot would otherwise flip
      // isScrolledUp=true mid-build, then yellow "N new" accumulates without
      // ever auto-scrolling.
      const onScrollMaybeResume = () => {
        if (isProgrammaticScroll) return
        if (!_userInputScroll) return
        if (!isScrolledUp) return
        if (checkAtBottom()) {
          isScrolledUp = false
          newMessageCount = 0
          newBtn.style.display = 'none'
          _scrollbackWindow = 0 // back at the live tail — drop scrollback DOM
        }
      }

      // Near the top while paused → paint the next chunk of older history.
      const SCROLLBACK_TRIGGER_PX = 200
      const maybeLoadOlder = () => {
        if (isProgrammaticScroll) return
        if (!_userInputScroll) return
        if (!isScrolledUp) return
        if (isStaticTab()) return
        if (msgsEl.scrollTop > SCROLLBACK_TRIGGER_PX) return
        loadOlderScrollback()
      }

      msgsEl.addEventListener('scroll', () => {
        if (_scrollFrame) return
        _scrollFrame = requestAnimationFrame(() => {
          _scrollFrame = null
          onScrollMaybeResume()
          maybeLoadOlder()
        })
      }, { passive: true, signal: mcSignal })

      msgsEl.addEventListener('scrollend', () => {
        if (_scrollFrame) { cancelAnimationFrame(_scrollFrame); _scrollFrame = null }
        onScrollMaybeResume()
        // touch-end / wheel-coast finished — clear input flag so subsequent
        // passive scroll events don't accidentally count as user-driven.
        _userInputScroll = false
      }, { signal: mcSignal })

      // Wheel-up: pause INSTANTLY (before any scroll event fires).
      msgsEl.addEventListener('wheel', (e) => {
        if (isStaticTab()) return
        _userInputScroll = true
        if (e.deltaY < 0) setPaused(true)
      }, { passive: true, signal: mcSignal })

      // Touch: track touchmove direction. Drag DOWN (page scrolls UP visually
      // — finger moves down means content moves down, we see earlier msgs)
      // pauses chat. mark _userInputScroll on any touch interaction.
      let _touchStartY = 0
      msgsEl.addEventListener('touchstart', (e) => {
        _touchStartY = e.touches[0]?.clientY || 0
        _userInputScroll = true
      }, { passive: true, signal: mcSignal })
      msgsEl.addEventListener('touchmove', (e) => {
        if (isStaticTab()) return
        const y = e.touches[0]?.clientY || 0
        if (y > _touchStartY + 4) setPaused(true)
        _touchStartY = y
      }, { passive: true, signal: mcSignal })

      // Keys that scroll up — pause.
      msgsEl.addEventListener('keydown', (e) => {
        if (isStaticTab()) return
        if (e.key === 'PageUp' || e.key === 'Home' || e.key === 'ArrowUp') {
          _userInputScroll = true
          setPaused(true)
        } else if (e.key === 'PageDown' || e.key === 'End' || e.key === 'ArrowDown' || e.key === ' ') {
          _userInputScroll = true
        }
      }, { signal: mcSignal })

      // Mousedown on scrollbar thumb (target === msgsEl, click outside content)
      // — flag user input so subsequent scroll counts as user-driven.
      msgsEl.addEventListener('mousedown', (e) => {
        if (e.target === msgsEl) _userInputScroll = true
      }, { passive: true, signal: mcSignal })

      newBtn.addEventListener('click', () => {
        isScrolledUp = false;
        newMessageCount = 0;
        newBtn.style.display = 'none';
        _scrollbackWindow = 0; // jumping to live tail — drop scrollback DOM
        if (isStaticTab()) {
          // Static tabs: re-render then scroll to top (newest content)
          renderMessages(currentTab);
          msgsEl.scrollTop = 0;
        } else {
          // Chat tabs: re-render then teleport to bottom. The new render
          // diff only auto-pins if user was AT bottom; here the user was
          // scrolled UP and clicked to come back, so force the scroll.
          renderMessages(currentTab);
          scrollMsgsToBottom(msgsEl);
        }
      }, { signal: mcSignal });

      // Bulletproof sticky-bottom: any change to msgsEl's box (panel resize,
      // window resize, tab/input bar height shift, font-size change) re-pins
      // to bottom unless the user explicitly scrolled up. Plugs the gap where
      // a width-rewrap shifted scrollTop a few px and the geometric
      // wasAtBottom check in renderMessages flipped to false.
      const _stickyResizeObs = new ResizeObserver(() => {
        if (isScrolledUp) return
        if (isStaticTab()) return
        scrollMsgsToBottom(msgsEl)
      })
      _stickyResizeObs.observe(msgsEl)
      cleanup.trackObserver(_stickyResizeObs)

      // Image-load re-pin: lazy-loaded emotes/badges/avatars decode AFTER the
      // message row rendered and we already pinned. Late-resolving height
      // grows the row, pushing bottom past the viewport → "drifted up by a
      // few px for a few sec" on busy channels with many lazy assets per
      // message. ResizeObserver doesn't catch this (msgsEl's box stays
      // constant). `load` doesn't bubble so capture phase is required. rAF
      // coalesce so a 100-image burst still does one layout per frame.
      let _imgLoadPinScheduled = false
      const onImgLoadOrError = (e) => {
        // A cosmetic badge img failed (e.g. 7TV CDN QUIC drop under request
        // burst). The URL is valid, so retry before giving up — only hide after
        // 2 failed retries — so we never render a permanent broken-image icon.
        if (e?.type === 'error') {
          const t = e.target
          if (t instanceof HTMLImageElement && t.classList.contains('hs-mc-badge-img'))
            retryOrHideBadgeImg(t)
          if (t instanceof HTMLImageElement && t.classList.contains('hs-mc-avatar'))
            t.style.display = 'none'
          // static-emote proxy failure (heatsync.org unreachable / 429) —
          // swap back to the original CDN url once instead of a broken icon
          if (t instanceof HTMLImageElement && t.classList.contains('hs-mc-emote')
              && (t.src || '').includes('/api/emote-proxy') && !t.dataset.hsProxyFell) {
            t.dataset.hsProxyFell = '1'
            const orig = t.closest('.hs-mc-emote-wrapper')?.dataset?.emoteUrl
            if (orig) t.src = orig
          }
        }
        // Snap the emote box to an integer width so the text after it stays on
        // the pixel grid (see hsSnapEmoteBox — fixes blurry post-emote text).
        if (e?.type === 'load') {
          const t = e.target
          if (t instanceof HTMLImageElement && t.classList.contains('hs-mc-emote')) hsSnapEmoteBox(t)
        }
        if (isScrolledUp) return
        if (isStaticTab()) return
        if (_imgLoadPinScheduled) return
        _imgLoadPinScheduled = true
        cleanup.raf(() => {
          _imgLoadPinScheduled = false
          if (isScrolledUp || isStaticTab()) return
          scrollMsgsToBottom(msgsEl)
        })
      }
      msgsEl.addEventListener('load', onImgLoadOrError, { capture: true, passive: true, signal: mcSignal })
      msgsEl.addEventListener('error', onImgLoadOrError, { capture: true, passive: true, signal: mcSignal })

      // Reply-chain stack overlay — viewport-bounded stack of all parents above active row
      let _stackActiveRow = null
      // Live-extend bookkeeping: when a new reply arrives whose replyTo matches
      // the bottommost id of the current descendant chain, append it to the
      // down-stack so the user sees the new message slide into the olive zebra
      // while the thread is open.
      let _stackTailId = ''
      let _stackChannel = ''
      let _stackPlatform = ''
      let _stackOwnId = ''
      let _stackThreadId = ''
      const dismissStack = () => {
        _stackStyleCache = null
        const overlay = document.getElementById('hs-mc-reply-stack')
        if (overlay) {
          overlay.style.display = 'none'
          overlay.replaceChildren()
          overlay.dataset.expanded = ''
          overlay.style.overflowY = ''
          overlay.style.overscrollBehavior = ''
          overlay._fullChain = null
        }
        const overlayDown = document.getElementById('hs-mc-reply-stack-down')
        if (overlayDown) {
          overlayDown.style.display = 'none'
          overlayDown.replaceChildren()
        }
        if (_stackActiveRow) {
          _stackActiveRow.classList.remove('hs-mc-reply-stack-active')
        }
        _stackActiveRow = null
        _stackTailId = ''
        _stackChannel = ''
        _stackPlatform = ''
        _stackOwnId = ''
        _stackThreadId = ''
      }
      const lookupMsgById = (channel, platform, id) => {
        if (!id) return null
        const ch = (channel || '').toLowerCase()
        if (platform === 'kick') {
          const buf = kickChat?.channels?.get(ch)
          if (buf) {
            const msgs = buf.getAll()
            for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].id === id) return msgs[i]
          }
          return null
        }
        if (ch && irc?.channels) {
          const buf = irc.channels.get(ch)
          if (buf) {
            const msgs = buf.getAll()
            for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].id === id) return msgs[i]
          }
        }
        if (irc?.channels) {
          for (const buf of irc.channels.values()) {
            const msgs = buf.getAll()
            for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].id === id) return msgs[i]
          }
        }
        return null
      }
      // Thread = all messages sharing the same Twitch reply-thread root (or
      // Kick thread_id). Walks the channel buffer once, splits members into
      // those before and after the hovered row by buffer order. Falls back to
      // direct-parent linkage when threadId isn't set (older Kick payloads).
      // Returns ancestors (chronological, oldest→newest) and descendants
      // (chronological, oldest→newest).
      const walkThreadMembers = (channel, platform, hoveredMsg, maxMembers) => {
        const out = { ancestors: [], descendants: [] }
        if (!hoveredMsg) return out
        const threadId = hoveredMsg.replyTo?.threadId || hoveredMsg.replyTo?.id || hoveredMsg.id
        if (!threadId) return out
        const ch = (channel || '').toLowerCase()
        const isMember = (m) => m === hoveredMsg
          || m.id === threadId
          || m.replyTo?.threadId === threadId
          || m.replyTo?.id === threadId
        const collectFrom = (buf) => {
          const msgs = buf.getAll()
          let foundHovered = false
          for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i]
            const match = m === hoveredMsg || (hoveredMsg.id && m.id === hoveredMsg.id)
            if (match) { foundHovered = true; continue }
            if (!isMember(m)) continue
            if (!foundHovered) {
              out.ancestors.push(m)
              if (out.ancestors.length > maxMembers) out.ancestors.shift()
            } else {
              out.descendants.push(m)
              if (out.descendants.length >= maxMembers) return true
            }
          }
          return foundHovered
        }
        if (platform === 'kick') {
          const buf = kickChat?.channels?.get(ch)
          if (buf) collectFrom(buf)
          return out
        }
        if (ch && irc?.channels) {
          const buf = irc.channels.get(ch)
          if (buf && collectFrom(buf)) return out
        }
        if (irc?.channels) {
          for (const buf of irc.channels.values()) {
            if (collectFrom(buf)) break
          }
        }
        return out
      }
      // Expose chain walkers so input.js's right-click handler can build the
      // "copy thread" item for any chat row (overlay-row or native).
      window.__hsMcLookupMsg = lookupMsgById
      window.__hsMcWalkThread = walkThreadMembers
      // Forward wheel events from the reply-stack overlays to the chat
      // container. Without this, wheeling while hovering the overlay
      // (positioned above/below the active row) does nothing — the overlay
      // has overflow:hidden and isn't a scroll target — so the user feels
      // the chat "lock up" mid-scroll.
      const forwardWheelToMsgs = (ev) => {
        // Expanded up-stack scrolls inside the overlay — let native wheel run
        // (CSS overscroll-behavior:contain blocks chaining at the edge).
        if (ev.currentTarget && ev.currentTarget.dataset?.expanded === '1') return
        if (isStaticTab()) return
        // Re-fetch the live msgsEl every wheel — the closure-captured ref can
        // become a detached node if the overlay HTML is ever rebuilt (SPA nav,
        // settings reload). Writing to a detached node is a silent no-op which
        // looks to the user like "scroll is broken when hovering a reply
        // thread" — wheel preventDefault fires but chat never moves.
        const liveMsgsEl = document.getElementById('hs-mc-messages') || msgsEl
        if (!liveMsgsEl) return
        ev.preventDefault()
        _userInputScroll = true
        if (ev.deltaY < 0) setPaused(true)
        // scrollBy honors deltaMode (lines/pages/pixels) so high-DPI mice and
        // line-mode wheels feel native. The += assignment treated everything
        // as pixels.
        const px = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaMode === 2 ? ev.deltaY * liveMsgsEl.clientHeight : ev.deltaY
        liveMsgsEl.scrollTop += px
      }
      const ensureStackOverlay = () => {
        let el = document.getElementById('hs-mc-reply-stack')
        if (el) return el
        el = document.createElement('div')
        el.id = 'hs-mc-reply-stack'
        el.style.display = 'none'
        document.body.appendChild(cleanup.trackNode(el))
        wireModToolbarHover(el)
        el.addEventListener('wheel', forwardWheelToMsgs, { passive: false, signal: mcSignal })
        el.addEventListener('click', (ev) => {
          const chip = ev.target.closest('.hs-mc-reply-stack-chip')
          if (!chip) return
          ev.preventDefault()
          ev.stopPropagation()
          // Expand inline: render the full chain into the up overlay and
          // turn it into a scrollable popover. User reads all parents in
          // place, no chat jump, hover stays alive.
          const chain = el._fullChain
          if (!chain || !chain.length) return
          el.replaceChildren()
          el.dataset.expanded = '1'
          el.style.overflowY = 'auto'
          el.style.overscrollBehavior = 'contain'
          for (let i = 0; i < chain.length; i++) {
            const row = buildMessageDiv(chain[i], currentTab)
            if (!row) continue
            row.classList.add('hs-mc-reply-stack-row')
            el.insertBefore(row, el.firstChild)
          }
          // Pin to bottom — immediate parent (closest to active row) visible
          // first, oldest scroll-up.
          el.scrollTop = el.scrollHeight
        }, { signal: mcSignal })
        return el
      }
      const ensureStackOverlayDown = () => {
        let el = document.getElementById('hs-mc-reply-stack-down')
        if (el) return el
        el = document.createElement('div')
        el.id = 'hs-mc-reply-stack-down'
        el.style.display = 'none'
        document.body.appendChild(cleanup.trackNode(el))
        wireModToolbarHover(el)
        el.addEventListener('wheel', forwardWheelToMsgs, { passive: false, signal: mcSignal })
        return el
      }
      const showStack = (hoveredEl) => {
        const replyId = hoveredEl.dataset.replyId
        if (!replyId) return
        const channel = hoveredEl.dataset.msgChannel
        const platform = hoveredEl.dataset.msgPlatform
        const ownId = hoveredEl.dataset.msgId
        const threadId = hoveredEl.dataset.replyThreadId || replyId
        const hoveredMsg = ownId ? lookupMsgById(channel, platform, ownId) : null
        const { ancestors, descendants } = hoveredMsg
          ? walkThreadMembers(channel, platform, hoveredMsg, 128)
          : { ancestors: [], descendants: [] }
        // chain[0] = closest ancestor (immediate parent), chain[n] = oldest.
        // Up-overlay rendering loop prepends each → visual top-down is oldest→newest.
        const chain = ancestors.slice().reverse()
        const descChain = descendants
        if (!chain.length && !descChain.length) return
        // Overlay rows match native .hs-mc-msg padding exactly, so the stack
        // butts flush against the active row — no overlap into the row's
        // padding (which used to compensate for zero-padded overlay rows).
        const cRect = msgsEl.getBoundingClientRect()
        const hRect = hoveredEl.getBoundingClientRect()
        const availableUp = hRect.top - cRect.top
        const availableDown = cRect.bottom - hRect.bottom
        const layoutViewportHeight = document.documentElement.clientHeight

        // ── Render ANCESTORS in the up overlay ──
        let upShown = 0
        if (chain.length && availableUp >= 24) {
          const overlay = ensureStackOverlay()
          overlay.replaceChildren()
          overlay.dataset.expanded = ''
          overlay.style.overflowY = ''
          overlay.style.overscrollBehavior = ''
          overlay._fullChain = chain
          overlay.style.position = 'fixed'
          overlay.style.left = hRect.left + 'px'
          overlay.style.width = hRect.width + 'px'
          overlay.style.bottom = (layoutViewportHeight - hRect.top) + 'px'
          overlay.style.maxHeight = availableUp + 'px'
          overlay.style.display = 'block'
          for (let i = 0; i < chain.length; i++) {
            const parent = chain[i]
            const row = buildMessageDiv(parent, currentTab)
            if (!row) continue
            row.classList.add('hs-mc-reply-stack-row')
            overlay.insertBefore(row, overlay.firstChild)
            if (overlay.scrollHeight > availableUp) {
              overlay.removeChild(row)
              const remaining = chain.length - upShown
              if (remaining > 0) {
                const chip = document.createElement('div')
                chip.className = 'hs-mc-reply-stack-chip'
                chip.textContent = '↑ ' + remaining + ' more'
                chip.dataset.targetId = chain[chain.length - 1].id
                overlay.insertBefore(chip, overlay.firstChild)
              }
              break
            }
            upShown++
          }
          if (!upShown) overlay.style.display = 'none'
        } else {
          const overlay = document.getElementById('hs-mc-reply-stack')
          if (overlay) { overlay.style.display = 'none'; overlay.replaceChildren() }
        }

        // ── Render DESCENDANTS in the down overlay ──
        let downShown = 0
        if (descChain.length && availableDown >= 24) {
          const overlay = ensureStackOverlayDown()
          overlay.replaceChildren()
          overlay.style.position = 'fixed'
          overlay.style.left = hRect.left + 'px'
          overlay.style.width = hRect.width + 'px'
          overlay.style.top = hRect.bottom + 'px'
          overlay.style.maxHeight = availableDown + 'px'
          overlay.style.display = 'block'
          for (let i = 0; i < descChain.length; i++) {
            const child = descChain[i]
            const row = buildMessageDiv(child, currentTab)
            if (!row) continue
            row.classList.add('hs-mc-reply-stack-row')
            overlay.appendChild(row)  // chronological top-down
            if (overlay.scrollHeight > availableDown) {
              overlay.removeChild(row)
              break
            }
            downShown++
          }
          if (!downShown) overlay.style.display = 'none'
        } else {
          const overlay = document.getElementById('hs-mc-reply-stack-down')
          if (overlay) { overlay.style.display = 'none'; overlay.replaceChildren() }
        }

        if (!upShown && !downShown) return
        if (_stackActiveRow && _stackActiveRow !== hoveredEl) {
          _stackActiveRow.classList.remove('hs-mc-reply-stack-active')
        }
        hoveredEl.classList.add('hs-mc-reply-stack-active')
        _stackActiveRow = hoveredEl
        // Tail = id of the actual chain tail (the deepest known descendant) so
        // new replies whose replyTo matches it slot in below. If descChain was
        // overflow-clipped, the tail is still the buffer's deepest descendant
        // — live appends roll the visible window forward.
        _stackTailId = descChain.length ? (descChain[descChain.length - 1].id || '') : (ownId || '')
        _stackChannel = (channel || '').toLowerCase()
        _stackPlatform = platform || ''
        _stackOwnId = ownId || ''
        _stackThreadId = threadId || ''
      }

      // Click the "Replying to" pill to open the thread stack. Click again on
      // the same row's pill to close. Click on the @user link inside the pill
      // still navigates to the profile (target=_blank). Opens pause chat
      // auto-scroll so the active row doesn't slide out from under the stack.
      msgsEl.addEventListener('click', (e) => {
        const pill = e.target.closest('.hs-mc-reply-ctx')
        if (!pill) return
        if (e.target.closest('a')) return
        const msg = pill.closest('.hs-mc-msg')
        if (!msg || !msg.dataset.replyId) return
        e.preventDefault()
        e.stopPropagation()
        if (_stackActiveRow === msg) { dismissStack(); return }
        if (_stackActiveRow) dismissStack()
        setPaused(true)
        showStack(msg)
      }, { signal: mcSignal })
      // Dismiss on outside click — keep open when clicking inside the active
      // row or either overlay (chip-expand, link clicks, etc.).
      document.addEventListener('mousedown', (e) => {
        if (!_stackActiveRow) return
        if (_stackActiveRow.contains(e.target)) return
        const oUp = document.getElementById('hs-mc-reply-stack')
        if (oUp && oUp.contains(e.target)) return
        const oDown = document.getElementById('hs-mc-reply-stack-down')
        if (oDown && oDown.contains(e.target)) return
        dismissStack()
      }, { signal: mcSignal })
      document.addEventListener('keydown', (e) => {
        if (_stackActiveRow && e.key === 'Escape') { dismissStack(); e.stopPropagation() }
      }, { signal: mcSignal })
      // On chat scroll, follow the active row by repositioning both overlays
      // (up + down) instead of dismissing. Only dismiss if the row scrolled
      // fully out of the chat viewport. Cache style metrics that don't change
      // for the same row — getComputedStyle in scroll path forced layout on
      // every wheel tick, the user-perceived "laggy when scrolling on a
      // reply thread."
      let _stackStyleCache = null // { row, layoutH }
      const refreshStackStyleCache = (row) => {
        if (!row) { _stackStyleCache = null; return }
        _stackStyleCache = { row, layoutH: document.documentElement.clientHeight }
      }
      // msgsEl sits inside fixed-position #hs-mc-container, so its viewport
      // rect is invariant across chat-scroll. Cache it and invalidate only on
      // resize/layout updates — halves forced-layout reads per scroll frame
      // (was 2 getBoundingClientRect, now 1) so reply-stack scrolling stops
      // stalling the compositor on busy channels.
      let _msgsRectCache = null
      const invalidateMsgsRect = () => { _msgsRectCache = null }
      const getMsgsRect = () => {
        if (!_msgsRectCache) _msgsRectCache = msgsEl.getBoundingClientRect()
        return _msgsRectCache
      }
      let _repositionRaf = 0
      // Click-opened stack: scroll-out HIDES overlays (display:none) but keeps
      // their content + state so scrolling back into view restores them. The
      // gate for "should this overlay be visible if room allows?" is whether
      // it has children — showStack populates children, dismissStack clears.
      const repositionStack = () => {
        // No open reply stack → nothing to follow. Bail before scheduling so a
        // busy chat's continuous scroll doesn't queue a rAF per frame just to
        // no-op. (The inner guard stays: a dismiss can land between schedule and
        // frame.)
        if (!_stackActiveRow) return
        if (_repositionRaf) return
        _repositionRaf = requestAnimationFrame(() => {
          _repositionRaf = 0
          if (!_stackActiveRow) return
          // Row trimmed out of DOM (chat hit render cap during scroll) — no
          // way to restore. Real dismiss so click again on a new row works.
          if (!_stackActiveRow.isConnected) { dismissStack(); return }
          const cRect = getMsgsRect()
          const hRect = _stackActiveRow.getBoundingClientRect()
          const overlayUp = document.getElementById('hs-mc-reply-stack')
          const overlayDown = document.getElementById('hs-mc-reply-stack-down')
          const rowOutOfView = hRect.bottom < cRect.top || hRect.top > cRect.bottom
          if (rowOutOfView) {
            if (overlayUp) overlayUp.style.display = 'none'
            if (overlayDown) overlayDown.style.display = 'none'
            return
          }
          if (!_stackStyleCache || _stackStyleCache.row !== _stackActiveRow) {
            refreshStackStyleCache(_stackActiveRow)
          }
          const { layoutH } = _stackStyleCache

          if (overlayUp && overlayUp.firstChild) {
            const availableUp = hRect.top - cRect.top
            if (availableUp < 24) {
              overlayUp.style.display = 'none'
            } else {
              overlayUp.style.display = 'block'
              overlayUp.style.left = hRect.left + 'px'
              overlayUp.style.width = hRect.width + 'px'
              overlayUp.style.bottom = (layoutH - hRect.top) + 'px'
              overlayUp.style.maxHeight = availableUp + 'px'
            }
          }
          if (overlayDown && overlayDown.firstChild) {
            const availableDown = cRect.bottom - hRect.bottom
            if (availableDown < 24) {
              overlayDown.style.display = 'none'
            } else {
              overlayDown.style.display = 'block'
              overlayDown.style.left = hRect.left + 'px'
              overlayDown.style.width = hRect.width + 'px'
              overlayDown.style.top = hRect.bottom + 'px'
              overlayDown.style.maxHeight = availableDown + 'px'
            }
          }
        })
      }
      msgsEl.addEventListener('scroll', repositionStack, { passive: true, signal: mcSignal })
      window.addEventListener('resize', () => { invalidateMsgsRect(); if (_stackActiveRow) repositionStack() }, { passive: true, signal: mcSignal })
      // Panel resize (drag handle) and tab/input bar height shifts change the
      // msgsEl viewport rect. Invalidate the cache so the next scroll-frame
      // reposition uses fresh coords.
      const _msgsRectInvalidator = new ResizeObserver(invalidateMsgsRect)
      _msgsRectInvalidator.observe(msgsEl)
      cleanup.trackObserver(_msgsRectInvalidator)

      // Live-extend the down-stack: when a new chat row is appended whose
      // replyTo id matches the current chain tail, mirror it into the down
      // overlay so the user sees it slot into the olive zebra without losing
      // hover. If the overlay is full, drop oldest rows from the top of the
      // down stack (closest to active row) so the latest reply stays visible
      // — same behavior chat itself has at-bottom.
      const tryExtendStack = (newDiv) => {
        if (!_stackActiveRow || !_stackActiveRow.isConnected) return
        if (!_stackThreadId) return
        const replyId = newDiv.dataset.replyId || ''
        const replyThreadId = newDiv.dataset.replyThreadId || ''
        // Thread match: new reply belongs if its threadId matches, or its
        // direct parent is the thread root (covers Twitch + Kick fallbacks).
        if (replyThreadId !== _stackThreadId && replyId !== _stackThreadId && replyId !== _stackTailId) return
        const newMsgId = newDiv.dataset.msgId || ''
        if (!newMsgId) return
        const msgChannel = (newDiv.dataset.msgChannel || '').toLowerCase()
        const msgPlatform = newDiv.dataset.msgPlatform || ''
        if (msgChannel !== _stackChannel || msgPlatform !== _stackPlatform) return
        const m = lookupMsgById(msgChannel, msgPlatform, newMsgId)
        if (!m) return
        const overlay = ensureStackOverlayDown()
        const cRect = msgsEl.getBoundingClientRect()
        const hRect = _stackActiveRow.getBoundingClientRect()
        if (hRect.bottom < cRect.top || hRect.top > cRect.bottom) return
        if (!_stackStyleCache || _stackStyleCache.row !== _stackActiveRow) refreshStackStyleCache(_stackActiveRow)
        const availableDown = cRect.bottom - hRect.bottom
        if (availableDown < 24) return
        const maxH = availableDown
        overlay.style.position = 'fixed'
        overlay.style.left = hRect.left + 'px'
        overlay.style.width = hRect.width + 'px'
        overlay.style.top = hRect.bottom + 'px'
        overlay.style.maxHeight = maxH + 'px'
        overlay.style.display = 'block'
        const row = buildMessageDiv(m, currentTab)
        if (!row) return
        row.classList.add('hs-mc-reply-stack-row')
        overlay.appendChild(row)
        while (overlay.scrollHeight > maxH && overlay.firstElementChild && overlay.firstElementChild !== row) {
          overlay.removeChild(overlay.firstElementChild)
        }
        if (overlay.scrollHeight > maxH) {
          overlay.removeChild(row)
          if (!overlay.firstElementChild) overlay.style.display = 'none'
          return
        }
        _stackTailId = newMsgId
      }
      const _liveStackObs = new MutationObserver((muts) => {
        if (!_stackActiveRow) return
        for (const mut of muts) {
          for (const node of mut.addedNodes) {
            if (node.nodeType !== 1) continue
            if (!node.classList || !node.classList.contains('hs-mc-msg')) continue
            tryExtendStack(node)
          }
        }
      })
      _liveStackObs.observe(msgsEl, { childList: true })
      cleanup.trackObserver(_liveStackObs)
    }, 100);

    // Search bar wiring — debounce 250ms then call /api/search
    const searchInput = overlay.querySelector('#hs-mc-search-input')
    const searchSpinner = overlay.querySelector('#hs-mc-search-spinner')
    let _searchTimer = null
    let _searchActive = false
    let _searchToken = 0

    if (searchInput && searchSpinner) {
      searchInput.addEventListener('input', () => {
        // Live/channel tabs: instant local buffer filter — no server call, no spinner.
        if (isLiveSearchTab(currentTab)) {
          if (_searchTimer) { cleanup.clearTimeout(_searchTimer); _searchTimer = null }
          searchSpinner.classList.remove('visible')
          // Debounce: renderMessages → fairMerge sorts up to ~4500 items + a
          // full DOM diff. Running that synchronously on every keystroke stalls
          // the frame on low-RAM hardware. 80ms coalesces a fast typist's burst
          // into a single render; currentTab is re-read at fire time.
          _searchTimer = cleanup.setTimeout(() => { _searchTimer = null; renderMessages(currentTab) }, 80)
          return
        }
        if (_searchTimer) { cleanup.clearTimeout(_searchTimer); _searchTimer = null }
        const q = searchInput.value.trim()
        if (!q) {
          _searchActive = false
          _searchToken++
          searchSpinner.classList.remove('visible')
          if (currentTab === 'mentions') renderMessages('mentions')
          return
        }
        _searchActive = true
        searchSpinner.classList.add('visible')
        _searchTimer = cleanup.setTimeout(async () => {
          _searchTimer = null
          if (!_searchActive) return
          const token = ++_searchToken
          const msgsEl = document.getElementById('hs-mc-messages')
          if (!msgsEl || currentTab !== 'mentions') return
          try {
            const resp = await apiFetch(`/api/search?q=${encodeURIComponent(q)}&mode=messages&limit=50`)
            // Bail if a newer query superseded this one mid-flight, else slow
            // responses can paint stale results out of order.
            if (token !== _searchToken || !_searchActive || currentTab !== 'mentions') return
            searchSpinner.classList.remove('visible')
            const results = resp?.data?.results || resp?.results || []
            renderSearchResults(msgsEl, results, q)
          } catch (e) {
            searchSpinner.classList.remove('visible')
          }
        }, 250)
      }, { signal: mcSignal })

      // Clear search state when input is cleared via keyboard
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          searchInput.value = ''
          _searchActive = false
          searchSpinner.classList.remove('visible')
          if (_searchTimer) { cleanup.clearTimeout(_searchTimer); _searchTimer = null }
          renderMessages(currentTab)
          searchInput.blur()
        }
      }, { signal: mcSignal })
    }

    return overlay;
  }

  function renderSearchResults(msgsEl, results, query) {
    _clearMessageIndices()
    msgsEl.textContent = ''
    if (!results.length) {
      const empty = document.createElement('div')
      empty.className = 'hs-mc-search-empty'
      empty.textContent = 'no results'
      msgsEl.appendChild(empty)
      return
    }
    const frag = document.createDocumentFragment()
    for (const r of results) {
      const div = document.createElement('div')
      div.className = 'hs-mc-search-result'

      const ts = r.created_at ? new Date(r.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
      const user = r.display_name || r.username || ''
      const content = r.content || ''
      const msgId = r.base36_id || ''
      const permalink = msgId ? `https://heatsync.org/m/${msgId}` : null

      const meta = document.createElement('div')
      meta.className = 'hs-mc-search-meta'
      if (ts) {
        const tsSpan = document.createElement('span')
        tsSpan.textContent = ts
        meta.appendChild(tsSpan)
      }
      const userSpan = document.createElement('span')
      userSpan.className = 'hs-mc-search-user'
      userSpan.textContent = user
      meta.appendChild(userSpan)

      const body = document.createElement('div')
      body.className = 'hs-mc-search-content'
      body.textContent = content

      div.appendChild(meta)
      div.appendChild(body)

      if (permalink) {
        div.addEventListener('click', () => window.open(permalink, '_blank', 'noopener'))
      }

      frag.appendChild(div)
    }
    msgsEl.appendChild(frag)
  }

  /**
   * Setup resize handle for dragging chat width
   *
   * Buttery-smooth strategy: during drag we DO NOT change rightCol's width.
   * Twitch packs ~2500 Layout-sc-* React components inside right-column, and
   * every width change triggers React reconciliation across all of them — that
   * was the lag. Instead, we render a fixed-positioned ghost div as a live
   * boundary preview. The ghost moves at compositor speed (no layout, no
   * reconciles, no mutations). On release we commit the real width once,
   * giving the player and Twitch's React tree exactly one reflow.
   */
  // Shared drag-ghost style — identical across the twitch/kick/yt resize
  // handles. One spec to keep in sync (orange tint, 3px left edge, z 99998).
  const buildGhostCss = (rect, w0) => `position:fixed;top:${rect.top}px;right:0;height:${rect.height}px;width:${w0}px;background:rgba(255,135,0,0.06);border-left:3px solid #ff8700;pointer-events:none;z-index:99998;will-change:width;`
  function setupResizeHandle() {
    const rightCol = document.querySelector('.right-column.right-column--beside')
    if (!rightCol || document.getElementById('hs-mc-resize-handle')) return

    const handle = document.createElement('div')
    handle.id = 'hs-mc-resize-handle'
    handle.style.touchAction = 'none'
    rightCol.insertBefore(handle, rightCol.firstChild)

    let isResizing = false
    let startX = 0
    let startWidth = 0
    let rafId = 0
    let pendingWidth = 0
    let lastGhostWidth = 0
    let activePointerId = -1
    let overlay = null
    let ghost = null
    const isVertical = () => tabPosition === 'left' || tabPosition === 'right'

    function applyResize() {
      rafId = 0
      if (pendingWidth === lastGhostWidth) return
      lastGhostWidth = pendingWidth
      chatWidth = pendingWidth
      // Compositor-only update — no layout, no React reconcile
      if (ghost) ghost.style.width = (pendingWidth + (isVertical() ? 90 : 0)) + 'px'
    }

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      isResizing = true
      activePointerId = e.pointerId
      try { handle.setPointerCapture(e.pointerId) } catch (_) {}
      startX = e.clientX
      startWidth = chatWidth
      const rect = rightCol.getBoundingClientRect()
      const w0 = Math.round(rect.width)
      pendingWidth = chatWidth
      lastGhostWidth = w0

      document.body.style.cursor = 'ew-resize'
      document.body.style.userSelect = 'none'

      // Live boundary preview — fixed-positioned, pointer-events:none, will-change:width
      // for the compositor. Visual: subtle orange tint with a 3px left edge.
      ghost = document.createElement('div')
      ghost.id = 'hs-resize-ghost'
      ghost.style.cssText = buildGhostCss(rect, w0)
      document.body.appendChild(ghost)

      overlay = document.createElement('div')
      overlay.id = 'hs-resize-overlay'
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;cursor:ew-resize'
      document.body.appendChild(overlay)
      e.preventDefault()
    }, { signal: mcSignal })

    handle.addEventListener('pointermove', (e) => {
      if (!isResizing || e.pointerId !== activePointerId) return
      const delta = startX - e.clientX
      const max = Math.min(MAX_CHAT_WIDTH, getTwitchMaxChatWidth())
      pendingWidth = Math.min(max, Math.max(MIN_CHAT_WIDTH, startWidth + delta))
      if (!rafId) rafId = requestAnimationFrame(applyResize)
    }, { signal: mcSignal })

    function endDrag(e) {
      if (!isResizing || (e && e.pointerId !== activePointerId)) return
      isResizing = false
      activePointerId = -1
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
      chatWidth = pendingWidth || chatWidth
      if (ghost) { ghost.remove(); ghost = null }
      // Single real width commit — player reflows exactly once here
      applyChatWidth(rightCol)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (overlay) { overlay.remove(); overlay = null }
      // Force Twitch's player + ad layer (.video-ad-display, IMA iframe) to
      // re-measure. Without this, ad video keeps its pre-resize dimensions.
      try { window.dispatchEvent(new Event('resize')) } catch (_) {}
      // Re-pin scroll: the single reflow shifts msgsEl.scrollHeight (taller
      // wrapped lines on shrink, shorter on expand). Without this, a
      // bottom-pinned user sees their viewport slide up after the drag.
      // Helper self-bails if isScrolledUp.
      const m = document.getElementById('hs-mc-messages')
      if (m) try { scrollMsgsToBottom(m) } catch (_) {}
      saveChatWidth()
    }
    handle.addEventListener('pointerup', endDrag, { signal: mcSignal })
    handle.addEventListener('pointercancel', endDrag, { signal: mcSignal })

    loadChatWidth()
    loadChatHeight()
  }

  function applyChatWidth(cachedRightCol) {
    const rightCol = cachedRightCol || document.querySelector('.right-column')
    if (!rightCol) return
    // No-channel pages (/videos, /directory, …) body-mount the panel as a
    // fixed overlay, so Twitch's flex .right-column slot is dead space. Zero
    // it so twilight-main reclaims the width — otherwise users see a 306px
    // gap between page content and the floating chat.
    if (document.body.classList.contains('hs-twitch-no-channel')) {
      rightCol.style.setProperty('width', '0', 'important')
      rightCol.style.setProperty('min-width', '0', 'important')
      rightCol.style.setProperty('max-width', '0', 'important')
      return
    }
    // C button took chat off the right edge — don't restore native width here
    // or the right-column reclaims its 340px and the player snaps back.
    if (chatPosition && chatPosition !== 'right') {
      rightCol.style.setProperty('width', '0', 'important')
      rightCol.style.setProperty('min-width', '0', 'important')
      rightCol.style.setProperty('max-width', '0', 'important')
      return
    }
    const collapsed = rightCol.classList.contains('right-column--collapsed')

    if (collapsed) {
      rightCol.style.removeProperty('width')
      rightCol.style.removeProperty('min-width')
      rightCol.style.removeProperty('flex-shrink')
      // Force parent wrapper (Twitch sets inline width: fit-content) to 0
      // overflow must be visible so the collapse/expand arrow can render
      const parent = rightCol.parentElement
      if (parent && parent !== document.body) {
        parent.style.setProperty('width', '0px', 'important')
        parent.style.setProperty('min-width', '0px', 'important')
        parent.style.setProperty('overflow', 'visible', 'important')
      }
      return
    }

    // Restore parent when expanded
    const parent = rightCol.parentElement
    if (parent && parent !== document.body) {
      parent.style.removeProperty('width')
      parent.style.removeProperty('min-width')
      parent.style.removeProperty('overflow')
    }

    // Clamp against viewport-aware max so a too-wide saved value (or the
    // user dragging on a wider window then resizing it down) can't push
    // .channel-root__main below Twitch's narrow-layout threshold and
    // teleport the persistent-player off-screen.
    const tMax = getTwitchMaxChatWidth()
    if (chatWidth > tMax) chatWidth = tMax
    const isVertical = tabPosition === 'left' || tabPosition === 'right'
    const colWidth = chatWidth + (isVertical ? 90 : 0)

    rightCol.style.setProperty('width', colWidth + 'px', 'important')
    rightCol.style.setProperty('min-width', colWidth + 'px', 'important')
    rightCol.style.setProperty('flex-shrink', '0', 'important')

    const innerCol = rightCol.querySelector('.channel-root__right-column')
    if (innerCol) {
      innerCol.style.setProperty('width', '100%', 'important')
    }
  }

  let _saveChatWidthTimer = null;
  function saveChatWidth() {
    // Mirror to localStorage immediately for early-layout.js to read at
    // document_start. chrome.storage write is debounced; localStorage isn't.
    try { localStorage.setItem('hs_layout_chatWidth', String(chatWidth)) } catch {}
    if (_saveChatWidthTimer) cleanup.clearTimeout(_saveChatWidthTimer);
    _saveChatWidthTimer = cleanup.setTimeout(() => {
      _saveChatWidthTimer = null;
      chrome.storage.local.set({ hs_chat_width: chatWidth });
      log('Saved chat width:', chatWidth);
    }, 250);
  }

  // ============================================
  // CHAT HEIGHT — for top/bottom chatPosition. Persisted in chrome.storage
  // alongside chatWidth so the C button's drag handle survives reloads.
  // ============================================
  const MIN_CHAT_HEIGHT = 10;
  function getMaxChatHeight() { return Math.max(MIN_CHAT_HEIGHT, window.innerHeight - 10); }
  // Clamp to MIN so a tiny window at module-load doesn't trap the user with
  // a default below the legal range.
  let chatHeight = Math.max(MIN_CHAT_HEIGHT, Math.round(window.innerHeight * 0.35));
  let _saveChatHeightTimer = null;
  function saveChatHeight() {
    try { localStorage.setItem('hs_layout_chatHeight', String(chatHeight)) } catch {}
    if (_saveChatHeightTimer) cleanup.clearTimeout(_saveChatHeightTimer);
    _saveChatHeightTimer = cleanup.setTimeout(() => {
      _saveChatHeightTimer = null;
      chrome.storage.local.set({ hs_chat_height: chatHeight });
      log('Saved chat height:', chatHeight);
    }, 250);
  }
  async function loadChatHeight() {
    try {
      const data = await chrome.storage.local.get(['hs_chat_height']);
      if (data.hs_chat_height) {
        chatHeight = Math.max(MIN_CHAT_HEIGHT, Math.min(getMaxChatHeight(), data.hs_chat_height));
        // Mirror loadChatWidth: push CSS var + reposition the unified handle so
        // the panel + orange bar render at the saved height on first paint.
        document.documentElement.style.setProperty('--hs-chat-h', chatHeight + 'px');
        try { positionChatResizeHandle() } catch {}
      }
    } catch (_) {}
  }

  // ============================================
  // UNIFIED CHAT RESIZE HANDLE — bulletproof across all 4 chatPosition
  // values × all 3 platforms × theatre mode. Single #hs-c-resize-handle on
  // body, position:fixed, repositioned by positionChatResizeHandle() which
  // is called from applyChatPosition. Drags chatWidth (left/right) or
  // chatHeight (top/bottom). Hides itself when chatPosition='right' and
  // delegates to existing per-platform handles for the default layout.
  // Orange #ff8700, 2px thin + invisible grab, no text — matches the
  // --hs-resize-thickness token in styles.js (and heatsync.org's .hs-resizer).
  // ============================================
  const HS_RESIZE_PX = 4; // visible thickness — mirrors --hs-resize-thickness
  let _isResizingC = false;
  function ensureChatResizeHandle() {
    let handle = document.getElementById('hs-c-resize-handle');
    if (handle) return handle;
    handle = document.createElement('div');
    handle.id = 'hs-c-resize-handle';
    Object.assign(handle.style, {
      position: 'fixed',
      background: '#ff8700',
      opacity: '0.55',
      userSelect: 'none',
      touchAction: 'none',
      display: 'none',
      pointerEvents: 'auto',
      transition: 'opacity 0.12s'
    });
    // Use !important on z-index so YT can't compete with its own
    // own modal stacking contexts (chrome bottom bar, settings menu).
    handle.style.setProperty('z-index', '2147483647', 'important');
    document.body.appendChild(cleanup.trackNode(handle));
    handle.addEventListener('mouseenter', () => { handle.style.opacity = '1'; });
    handle.addEventListener('mouseleave', () => { if (!_isResizingC) handle.style.opacity = '0.55'; });

    // Window-level reflow: WM fullscreen (dwl mod-e, sway/i3 fullscreen),
    // browser zoom, devtools toggle all change viewport without firing the
    // platform-internal layout signals (Twitch theatre attr, YT flexy attr).
    // Without this the orange bar's inline px from getBoundingClientRect goes
    // stale and floats over wrong pixels until the user moves the cursor.
    // Suppressed during the live drag (drag dispatches resize itself for the
    // player to re-layout — we don't want recursion).
    let _resizeReflowTimer = null
    window.addEventListener('resize', () => {
      if (_isResizingC) return
      if (_resizeReflowTimer) cleanup.clearTimeout(_resizeReflowTimer)
      _resizeReflowTimer = cleanup.setTimeout(() => {
        _resizeReflowTimer = null
        try { positionChatResizeHandle() } catch {}
        try { _updateMcLayout() } catch {}
      }, 60)
    }, { passive: true, signal: mcSignal });

    // Live drag: chat + player resize on every pointermove (rAF-throttled).
    // We suppress the YT window-resize dispatch during drag so IMA SDK / html5
    // player don't re-decode the video on every frame. CSS handles smooth
    // visual scaling; one final resize event fires on pointerup so the player
    // re-measures cleanly (and ad <video> elements snap to final dimensions).
    let startX = 0, startY = 0, startW = 0, startH = 0, axis = 'x', activePid = -1;
    let pendingW = 0, pendingH = 0, overlay = null, ghost = null;
    let liveRaf = 0;
    // Panel anchor edges captured at pointerdown — the edges that DON'T
    // move during the drag. See positionChatResizeHandle for the static
    // (non-drag) equivalent that DOES read rect.
    let panelTop = 0, panelLeft = 0, panelRight = 0, panelBottom = 0;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // Stop YT's player-level pointer handlers from also catching this
      // event. At narrow viewports the player extends under the chat
      // overlay (single-column layout) and YT's pointermove/down listeners
      // can intercept events even though our handle has higher z-index.
      e.stopImmediatePropagation();
      _isResizingC = true;
      activePid = e.pointerId;
      try { handle.setPointerCapture(e.pointerId) } catch (_) {}
      startX = e.clientX; startY = e.clientY;
      startW = chatWidth; startH = chatHeight;
      pendingW = chatWidth; pendingH = chatHeight;
      axis = (chatPosition === 'left' || chatPosition === 'right') ? 'x' : 'y';
      // Capture the panel's actual rendered edges. Container is position:
      // fixed but transformed ancestors (Twitch top-nav) can shift it from
      // the viewport's true (0,0) origin — the bar must track the panel's
      // true edge, not raw chat dimensions.
      const cont = document.getElementById('hs-mc-container');
      const r = cont ? cont.getBoundingClientRect()
                     : { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
      panelTop = r.top; panelLeft = r.left; panelRight = r.right; panelBottom = r.bottom;
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
      handle.style.opacity = '1';
      // Full-viewport overlay: captures pointer events even when crossing
      // iframes (YT player iframe steals events otherwise).
      overlay = document.createElement('div');
      overlay.id = 'hs-c-resize-overlay';
      overlay.style.cssText = `position:fixed;inset:0;z-index:99998;cursor:${axis === 'x' ? 'col-resize' : 'row-resize'};`;
      document.body.appendChild(overlay);
      // Ghost preview — fixed-positioned, pointer-events:none, will-change
      // for the compositor. Mirrors the per-platform handles' approach
      // (#hs-mc-resize-handle, #hs-kick-resize-handle, #hs-yt-resize-handle).
      // Memory rule: never touch the actual chat width/player layout during
      // the live drag — Twitch right-column has ~2500 React Layout nodes
      // and inline-style writes on YT player wrappers thrash IMA SDK.
      ghost = document.createElement('div');
      ghost.id = 'hs-c-resize-ghost';
      const baseStyle = 'position:fixed;background:rgba(255,135,0,0.06);pointer-events:none;z-index:99997;';
      if (chatPosition === 'right') {
        ghost.style.cssText = baseStyle + `top:${panelTop}px;right:0;height:${panelBottom - panelTop}px;width:${pendingW}px;border-left:3px solid #ff8700;will-change:width;`;
      } else if (chatPosition === 'left') {
        ghost.style.cssText = baseStyle + `top:${panelTop}px;left:0;height:${panelBottom - panelTop}px;width:${pendingW}px;border-right:3px solid #ff8700;will-change:width;`;
      } else if (chatPosition === 'top') {
        ghost.style.cssText = baseStyle + `top:0;left:0;right:0;height:${pendingH}px;border-bottom:3px solid #ff8700;will-change:height;`;
      } else if (chatPosition === 'bottom') {
        ghost.style.cssText = baseStyle + `bottom:0;left:0;right:0;height:${pendingH}px;border-top:3px solid #ff8700;will-change:height;`;
      }
      document.body.appendChild(ghost);
      e.preventDefault();
    }, { signal: mcSignal });
    handle.addEventListener('pointermove', (e) => {
      if (!_isResizingC || e.pointerId !== activePid) return;
      // Full pixel-freedom drag — bounded only by viewport-10 so the
      // handle stays grabbable on either extreme.
      const maxW = Math.max(MIN_CHAT_WIDTH, window.innerWidth - 10);
      if (chatPosition === 'right') {
        pendingW = Math.max(MIN_CHAT_WIDTH, Math.min(maxW, startW + (startX - e.clientX)));
      } else if (chatPosition === 'left') {
        pendingW = Math.max(MIN_CHAT_WIDTH, Math.min(maxW, startW + (e.clientX - startX)));
      } else if (chatPosition === 'top') {
        pendingH = Math.max(MIN_CHAT_HEIGHT, Math.min(getMaxChatHeight(), startH + (e.clientY - startY)));
      } else if (chatPosition === 'bottom') {
        pendingH = Math.max(MIN_CHAT_HEIGHT, Math.min(getMaxChatHeight(), startH + (startY - e.clientY)));
      }
      // Compositor-only update during drag — no layout, no React reconcile,
      // no inline-style writes on player wrappers. Just move the orange bar
      // and resize the ghost preview. Final commit happens on pointerup.
      if (!liveRaf) {
        liveRaf = requestAnimationFrame(() => {
          liveRaf = 0;
          if (chatPosition === 'right') {
            handle.style.left = (panelRight - pendingW) + 'px';
            if (ghost) ghost.style.width = pendingW + 'px';
          } else if (chatPosition === 'left') {
            handle.style.left = (panelLeft + pendingW - 10) + 'px';
            if (ghost) ghost.style.width = pendingW + 'px';
          } else if (chatPosition === 'top') {
            handle.style.top = (panelTop + pendingH - 10) + 'px';
            if (ghost) ghost.style.height = pendingH + 'px';
          } else if (chatPosition === 'bottom') {
            handle.style.top = (panelBottom - pendingH) + 'px';
            if (ghost) ghost.style.height = pendingH + 'px';
          }
        });
      }
    }, { signal: mcSignal });
    const endDrag = (e) => {
      if (!_isResizingC || (e && e.pointerId !== activePid)) return;
      _isResizingC = false;
      activePid = -1;
      if (liveRaf) { cancelAnimationFrame(liveRaf); liveRaf = 0; }
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      handle.style.opacity = '0.55';
      if (overlay) { overlay.remove(); overlay = null; }
      if (ghost) { ghost.remove(); ghost = null; }
      // Final commit — single reflow for the player + React tree.
      if (axis === 'x') chatWidth = pendingW;
      else chatHeight = pendingH;
      document.documentElement.style.setProperty('--hs-chat-w', chatWidth + 'px');
      document.documentElement.style.setProperty('--hs-chat-h', chatHeight + 'px');
      applyChatPosition();
      requestAnimationFrame(() => { try { publishPanelWidth() } catch (_) {} });
      // applyChatPosition strips inline width on #secondary for YT chat-right
      // and relies on "next reflow" to repopulate it — force it now.
      if (hostPlatform === 'yt') {
        try { applyYouTubeChatWidth() } catch {}
      }
      // Force every platform's player (including ad layers — Twitch
      // .video-ad-display, YT IMA SDK, Kick video.js) to re-measure.
      try { window.dispatchEvent(new Event('resize')) } catch (_) {}
      // Re-pin scroll: width change re-wraps messages, scrollHeight shifts.
      // Helper self-bails if isScrolledUp.
      const m = document.getElementById('hs-mc-messages');
      if (m) try { scrollMsgsToBottom(m) } catch (_) {}
      saveChatWidth();
      saveChatHeight();
    };
    handle.addEventListener('pointerup', endDrag, { signal: mcSignal });
    handle.addEventListener('pointercancel', endDrag, { signal: mcSignal });
    return handle;
  }
  function positionChatResizeHandle() {
    const handle = ensureChatResizeHandle();
    ;['top','bottom','left','right','width','height'].forEach(p => handle.style.removeProperty(p));
    // For YT, chat-right is now position:fixed so the unified handle
    // owns ALL four positions. For Twitch/Kick, chat-right uses the
    // existing per-platform handles (which have ghost-preview perf
    // optimisations worth keeping) — UNLESS the platform anchor is
    // missing (Twitch /directory, Kick non-channel pages), in which
    // case the unified handle takes over so the panel is still
    // resizeable.
    if ((chatPosition === 'right' || !chatPosition) && hostPlatform !== 'yt') {
      // In no-channel / clipped-chat mode the per-platform handle lives inside
      // a broken/missing chat-shell and can't be reached — always use the
      // unified body-mounted handle.
      const noChannelMode =
        document.body.classList.contains('hs-twitch-no-channel') ||
        document.body.classList.contains('hs-kick-no-channel');
      const platformAnchor = noChannelMode ? null :
        hostPlatform === 'kick'
          ? document.getElementById('channel-chatroom')
          : document.querySelector('.right-column.right-column--beside');
      if (platformAnchor) {
        handle.style.display = 'none';
        return;
      }
    }
    handle.style.display = 'block';
    // Anchor the bar to the panel container's ACTUAL rendered edges via
    // getBoundingClientRect. The handle is position:fixed on body, but
    // the panel container's own position:fixed can be shifted by a
    // transformed ancestor (Twitch's top-nav transforms put chat-top at
    // viewport y≈50 even though it's "fixed; top: 0"). Reading the rect
    // makes the bar track the panel's true edge regardless of those
    // offsets — otherwise the bar overlays tabbar/inputbar content.
    const cont = document.getElementById('hs-mc-container');
    const r = cont ? cont.getBoundingClientRect() : null;
    const cTop = r ? r.top : 0;
    const cLeft = r ? r.left : 0;
    const cRight = r ? r.right : window.innerWidth;
    const cBottom = r ? r.bottom : window.innerHeight;
    const cWidth = r ? r.width : window.innerWidth;
    const cHeight = r ? r.height : window.innerHeight;
    if (chatPosition === 'right') {
      handle.style.top = cTop + 'px';
      handle.style.left = cLeft + 'px';
      handle.style.height = cHeight + 'px';
      handle.style.width = HS_RESIZE_PX + 'px';
      handle.style.cursor = 'col-resize';
    } else if (chatPosition === 'left') {
      handle.style.top = cTop + 'px';
      handle.style.left = (cRight - HS_RESIZE_PX) + 'px';
      handle.style.height = cHeight + 'px';
      handle.style.width = HS_RESIZE_PX + 'px';
      handle.style.cursor = 'col-resize';
    } else if (chatPosition === 'top') {
      handle.style.top = (cBottom - HS_RESIZE_PX) + 'px';
      handle.style.left = cLeft + 'px';
      handle.style.width = cWidth + 'px';
      handle.style.height = HS_RESIZE_PX + 'px';
      handle.style.cursor = 'row-resize';
    } else if (chatPosition === 'bottom') {
      handle.style.top = cTop + 'px';
      handle.style.left = cLeft + 'px';
      handle.style.width = cWidth + 'px';
      handle.style.height = HS_RESIZE_PX + 'px';
      handle.style.cursor = 'row-resize';
    }
  }
  function hidePlatformResizeHandles(hide) {
    // hide=true: set display:none + mark as hidden-by-us. hide=false: only
    // restore display if we previously hid it (platforms like YT manage
    // their own display:none for theatre mode — don't clobber that).
    for (const id of ['hs-mc-resize-handle','hs-kick-resize-handle','hs-yt-resize-handle']) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (hide) {
        el.dataset._hsCHidden = '1';
        el.style.setProperty('display', 'none', 'important');
      } else if (el.dataset._hsCHidden === '1') {
        delete el.dataset._hsCHidden;
        el.style.removeProperty('display');
      }
    }
  }

  async function loadChatWidth() {
    try {
      const data = await chrome.storage.local.get(['hs_chat_width']);
      if (data.hs_chat_width) {
        chatWidth = data.hs_chat_width;
        // Sync the CSS var driving every chat-position rule + reposition the
        // unified resize handle. Without this, the panel renders at the default
        // 340px until the first applyChatPosition fires (theatre toggle, drag
        // end, etc) — at which point the panel + bar visibly jump to the saved
        // width. That's the "first-load teleport" the user reports.
        document.documentElement.style.setProperty('--hs-chat-w', chatWidth + 'px');
        applyChatWidth();
        try { positionChatResizeHandle() } catch {}
        log('Loaded chat width:', chatWidth);
      }
    } catch (e) {
      log('Error loading chat width:', e);
    }
  }

  /**
   * Detect Kick's left sidebar at the current viewport width. Kick drops the
   * sidebar from the DOM at narrow widths (~< ~1000px). The padding-left we
   * apply to <main> needs to subtract the sidebar's effective width so the
   * video starts where our fixed panel ends — without leaving a gap when the
   * sidebar is present, and without overlapping the video when it isn't.
   */
  function getKickSidebarWidth() {
    const el = document.querySelector('[class*="sidebar-collapsed-width"]')
    if (!el) return 0
    const w = el.offsetWidth
    return w > 0 ? w : 0
  }

  function syncKickSidebarVar() {
    document.documentElement.style.setProperty('--hs-kick-sidebar-w', getKickSidebarWidth() + 'px')
  }

  /**
   * Apply chat width to Kick's fixed #channel-chatroom panel
   */
  function applyKickChatWidth() {
    const chatroom = document.getElementById('channel-chatroom')
    if (!chatroom) return
    chatWidth = Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, chatWidth))
    document.documentElement.style.setProperty('--hs-kick-chat-width', chatWidth + 'px')
    document.documentElement.style.setProperty('--chat-width', chatWidth + 'px')
    syncKickSidebarVar()
    // C button took chat off the right edge — chatroom is hidden via CSS,
    // skip restoring its width (would un-hide it visually as the shell still
    // claims layout when display is intercepted by the cascade).
    if (chatPosition && chatPosition !== 'right') return
    chatroom.style.setProperty('width', chatWidth + 'px', 'important')
  }

  /**
   * Setup resize handle for Kick — left edge of fixed #channel-chatroom panel
   * Uses rAF batching, iframe overlay, and kills Kick's native transitions
   */
  function setupKickResizeHandle() {
    const chatroom = document.getElementById('channel-chatroom')
    const mcContainer = document.getElementById('hs-mc-container')
    if (!chatroom || !mcContainer || document.getElementById('hs-kick-resize-handle')) return

    const handle = document.createElement('div')
    handle.id = 'hs-kick-resize-handle'
    handle.style.touchAction = 'none'
    mcContainer.insertBefore(handle, mcContainer.firstChild)

    let isResizing = false
    let startX = 0
    let startWidth = 0
    let rafId = 0
    let pendingWidth = 0
    let lastGhostWidth = 0
    let activePointerId = -1
    let overlay = null
    let ghost = null

    function applyResize() {
      rafId = 0
      if (pendingWidth === lastGhostWidth) return
      lastGhostWidth = pendingWidth
      chatWidth = pendingWidth
      if (ghost) ghost.style.width = pendingWidth + 'px'
    }

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      isResizing = true
      activePointerId = e.pointerId
      try { handle.setPointerCapture(e.pointerId) } catch (_) {}
      startX = e.clientX
      startWidth = chatWidth
      const rect = (chatroom.classList.contains('hs-native-hidden') ? mcContainer : chatroom).getBoundingClientRect()
      const w0 = Math.round(rect.width)
      pendingWidth = chatWidth
      lastGhostWidth = w0
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      ghost = document.createElement('div')
      ghost.id = 'hs-resize-ghost'
      ghost.style.cssText = buildGhostCss(rect, w0)
      document.body.appendChild(ghost)

      overlay = document.createElement('div')
      overlay.id = 'hs-resize-overlay'
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;cursor:col-resize'
      document.body.appendChild(overlay)
      e.preventDefault()
    }, { signal: mcSignal })

    handle.addEventListener('pointermove', (e) => {
      if (!isResizing || e.pointerId !== activePointerId) return
      const delta = startX - e.clientX
      pendingWidth = Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, startWidth + delta))
      if (!rafId) rafId = requestAnimationFrame(applyResize)
    }, { signal: mcSignal })

    function endDrag(e) {
      if (!isResizing || (e && e.pointerId !== activePointerId)) return
      isResizing = false
      activePointerId = -1
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
      chatWidth = pendingWidth || chatWidth
      if (ghost) { ghost.remove(); ghost = null }
      applyKickChatWidth()
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (overlay) { overlay.remove(); overlay = null }
      // Force Kick's video.js player + any preroll/midroll ad layer to
      // re-measure so the ad video stops overlapping chat.
      try { window.dispatchEvent(new Event('resize')) } catch (_) {}
      saveChatWidth()
    }
    handle.addEventListener('pointerup', endDrag, { signal: mcSignal })
    handle.addEventListener('pointercancel', endDrag, { signal: mcSignal })

    loadChatWidth().then(() => { applyKickChatWidth() })
    loadChatHeight()
  }

  /**
   * Apply chat width to YouTube's #secondary sidebar
   */
  function applyYouTubeChatWidth() {
    const secondary = document.querySelector('#secondary, ytd-watch-flexy #secondary')
    if (!secondary) return
    // Only modify #secondary on actual watch pages — home/search/channel
    // have their OWN #secondary (the recommended-sidebar wrapper inside
    // ytd-two-column-browse-results-renderer) that we must not touch.
    // Without this guard, after a watch → home SPA back, #secondary on
    // the home grid stays clamped at the chat width and #primary collapses
    // to (parent − chatWidth) ≈ 334px, breaking the grid wrap.
    // `:not([hidden])` matters: ytd-watch-flexy stays in the DOM with
    // `hidden` attr on non-watch pages — bare `ytd-watch-flexy` selector
    // returns true on home and we'd clamp #secondary anyway.
    // hs-offline = panel hidden on this YT page (non-live, no opt-in). Restore
    // #secondary (related videos) to its natural width — don't reserve the chat
    // strip for a hidden panel. Same clearing as the non-watch-page path.
    const onWatchPage = !!document.querySelector('ytd-watch-flexy:not([hidden])')
    if (!onWatchPage || document.body.classList.contains('hs-offline')) {
      secondary.style.removeProperty('width')
      secondary.style.removeProperty('min-width')
      secondary.style.removeProperty('max-width')
      secondary.style.removeProperty('flex')
      const handle = document.getElementById('hs-yt-resize-handle')
      if (handle) handle.style.display = 'none'
      return
    }
    // Reflow var: attach the below-top observer from here too — applyYouTube-
    // ChatWidth reliably runs on every YT watch render (it sizes #secondary),
    // whereas applyPlatformPositionOverrides' YT branch can be skipped on a
    // fresh single-column load, leaving --hs-yt-below-top unset (#below pinned
    // over the video). Self-retry inside handles the player not existing yet.
    try { _hsEnsureYtBelowObserver() } catch (_) {}
    // C button took chat off the right edge — collapse #secondary to 0 so
    // the freed width goes back to the player; don't run the native width
    // sizer which would re-claim the sidebar.
    if (chatPosition && chatPosition !== 'right') {
      secondary.style.setProperty('width', '0', 'important')
      secondary.style.setProperty('min-width', '0', 'important')
      secondary.style.setProperty('max-width', '0', 'important')
      secondary.style.setProperty('flex', '0 0 0', 'important')
      const handle = document.getElementById('hs-yt-resize-handle')
      if (handle) handle.style.display = 'none'
      return
    }
    // Theater (cinema) and fullscreen mode rearrange the watch layout so that
    // #secondary sits BELOW the player at full row width. Our fixed-px width
    // would fight that reflow, so just clear our overrides and let YT's CSS
    // run unmodified. Also hide the left-edge resize handle since the panel
    // no longer has a left edge to drag against.
    const flexy = document.querySelector('ytd-watch-flexy:not([hidden])')
    const isTheater = !!flexy?.hasAttribute('theater') || !!flexy?.hasAttribute('fullscreen')
    const handle = document.getElementById('hs-yt-resize-handle')
    if (isTheater) {
      secondary.style.removeProperty('width')
      secondary.style.removeProperty('min-width')
      secondary.style.removeProperty('max-width')
      secondary.style.removeProperty('flex')
      const container = document.getElementById('hs-mc-container')
      if (container) container.style.removeProperty('width')
      if (handle) handle.style.display = 'none'
      return
    }
    // Note: NOT setting handle.style.display — the unified resize handle
    // (#hs-c-resize-handle) owns ALL chat positions on YT, so the platform
    // handle stays hidden by hidePlatformResizeHandles. Clearing display
    // here would un-hide it and render two orange bars.
    // Full freedom — only clamp to viewport so the chat can't escape it.
    const ytMax = Math.max(MIN_CHAT_WIDTH, window.innerWidth - 10)
    chatWidth = Math.min(ytMax, Math.max(MIN_CHAT_WIDTH, chatWidth))
    secondary.style.setProperty('width', chatWidth + 'px', 'important')
    secondary.style.setProperty('min-width', chatWidth + 'px', 'important')
    secondary.style.setProperty('max-width', chatWidth + 'px', 'important')
    secondary.style.setProperty('flex', 'none', 'important')
    // Note: NOT setting width on #hs-mc-container — chat-right now uses
    // position:fixed via CSS (body.hs-platform-yt.hs-chat-right #hs-mc-container)
    // so the container's width is owned by var(--hs-chat-w). Setting inline
    // width here would beat that CSS and stretch chat across full viewport.
    const container = document.getElementById('hs-mc-container')
    if (container) container.style.removeProperty('width')
  }

  // Twitch: .persistent-player mounts asynchronously after our initial
  // applyChatPosition runs. Without this, our top:0 fix never applies on
  // first load. Also: on certain SPA flows (channel→home→channel) Twitch's
  // React resets persistent-player's inline top to "", letting it fall to
  // its natural-flow position at the bottom of root-scrollable__wrapper
  // (y > 2000px), which pushes the video off-screen below the about
  // section. Watch for the mount + style resets and re-pin top:0 left:0
  // when we're in chat-right normal mode.
  let _ttvPpObserver = null
  let _ttvPpStyleObserver = null
  let _ttvPpLastSeen = null
  function pinTwitchPersistentPlayer() {
    if (hostPlatform !== 'twitch' || isKick) return
    const pp = document.querySelector('.persistent-player')
    if (!pp) return
    // For non-right chatPosition, the player must inset around the chat
    // strip. applyChatPosition's first call fires before .persistent-player
    // mounts on SPA nav (channel→channel), so our inline top/bottom/left/
    // right are never applied. Re-apply ONCE on mount. We deliberately do
    // NOT observe style mutations on pp here — applyPlatformPositionOverrides
    // itself writes inline styles, which would self-trigger the observer
    // and loop the page to a freeze. Twitch rarely resets our !important
    // inline overrides; the rotateChatPosition path re-applies if needed.
    if (chatPosition !== 'right' && !theatreMode) {
      const tag = `${chatPosition}:${chatWidth}:${chatHeight}:${pp === _ttvPpLastSeen}`
      if (pp._hsTwPosTag === tag) return
      pp._hsTwPosTag = tag
      _ttvPpLastSeen = pp
      try { applyPlatformPositionOverrides() } catch (_) {}
      return
    }
    if (theatreMode) return
    // Offline channel: Twitch shows a small recommended-VOD PiP mini-player
    // (~185×104) on the channel-home page. Pinning it top:0/left:0 makes it
    // float awkwardly in the corner instead of where Twitch positioned it.
    // Skip pinning when .channel-root--home is present.
    if (document.querySelector('.channel-root--home')) {
      // Also clear any prior pin we may have applied before going offline.
      if (pp.style.top === '0px' || pp.style.left === '0px') {
        pp.style.removeProperty('top')
        pp.style.removeProperty('left')
      }
      return
    }
    // chatPosition === 'right' default path — pin top:0 when Twitch's React
    // forgets to set it (player falls to natural-flow position y > 2000px).
    const cur = pp.style.top
    const resolved = parseFloat(getComputedStyle(pp).top) || 0
    if (cur === '0px' && resolved < 100) return // already pinned
    pp.style.setProperty('top', '0', 'important')
    pp.style.setProperty('left', '0', 'important')
    if (_ttvPpLastSeen !== pp) {
      _ttvPpLastSeen = pp
      if (_ttvPpStyleObserver) { try { _ttvPpStyleObserver.disconnect() } catch (_) {} _ttvPpStyleObserver = null }
      _ttvPpStyleObserver = new MutationObserver(() => {
        if (chatPosition !== 'right' || theatreMode) return
        // Same offline guard inside the style observer — Twitch's React may
        // re-render mid-session (live → offline) and we'd otherwise re-pin.
        if (document.querySelector('.channel-root--home')) return
        const r = parseFloat(getComputedStyle(pp).top) || 0
        if (r > 200) {
          pp.style.setProperty('top', '0', 'important')
          pp.style.setProperty('left', '0', 'important')
        }
      })
      _ttvPpStyleObserver.observe(pp, { attributes: true, attributeFilter: ['style'] })
      cleanup.trackObserver(_ttvPpStyleObserver)
    }
  }
  function watchTwitchPersistentPlayer() {
    if (hostPlatform !== 'twitch' || isKick) return
    pinTwitchPersistentPlayer() // immediate, in case it's already mounted
    if (_ttvPpObserver) return
    let _ttvPpRaf = 0
    let _ttvPpDetachObs = null
    // Two-phase observer to avoid permanent body-subtree dispatch on Twitch:
    //   1. Body watch — fires until the persistent player mounts and we pin it,
    //      then disconnects. Walking body subtree is only paid during SPA nav.
    //   2. Detach watch — observes the pinned player's PARENT (childList only,
    //      no subtree) so we re-arm phase 1 the moment Twitch unmounts the
    //      player on channel→channel nav. Effectively zero per-frame overhead
    //      while the player is stable, which is 99% of session time.
    const armDetachWatch = () => {
      if (_ttvPpDetachObs) { try { _ttvPpDetachObs.disconnect() } catch (_) {} _ttvPpDetachObs = null }
      const pp = _ttvPpLastSeen
      const parent = pp?.parentElement
      if (!parent) { armBodyWatch(); return }
      _ttvPpDetachObs = new MutationObserver(() => {
        if (pp && pp.isConnected) return
        try { _ttvPpDetachObs.disconnect() } catch (_) {}
        _ttvPpDetachObs = null
        _ttvPpLastSeen = null
        armBodyWatch()
      })
      _ttvPpDetachObs.observe(parent, { childList: true })
      cleanup.trackObserver(_ttvPpDetachObs)
    }
    function armBodyWatch() {
      if (_ttvPpObserver) { try { _ttvPpObserver.disconnect() } catch (_) {} }
      _ttvPpObserver = new MutationObserver(() => {
        if (_ttvPpLastSeen && _ttvPpLastSeen.isConnected) {
          try { _ttvPpObserver.disconnect() } catch (_) {}
          armDetachWatch()
          return
        }
        if (_ttvPpRaf) return
        _ttvPpRaf = requestAnimationFrame(() => {
          _ttvPpRaf = 0
          pinTwitchPersistentPlayer()
          if (_ttvPpLastSeen?.isConnected) {
            try { _ttvPpObserver.disconnect() } catch (_) {}
            armDetachWatch()
          }
        })
      })
      _ttvPpObserver.observe(document.body, { childList: true, subtree: true })
      cleanup.trackObserver(_ttvPpObserver)
    }
    if (_ttvPpLastSeen?.isConnected) armDetachWatch()
    else armBodyWatch()
  }

  // Re-apply layout whenever YT toggles theater/fullscreen so we release or
  // restore our width overrides at the right moment.
  function watchYtLayoutAttrs() {
    if (hostPlatform !== 'yt') return
    const flexy = document.querySelector('ytd-watch-flexy:not([hidden])')
    if (!flexy) return
    const obs = new MutationObserver(() => applyYouTubeChatWidth())
    obs.observe(flexy, { attributes: true, attributeFilter: ['theater', 'fullscreen', 'is-two-columns_'] })
    cleanup.trackObserver(obs)
  }

  // Re-run applyChatPosition when ytd-watch-flexy mounts on an SPA nav from
  // a non-watch page (home/search/channel) → a watch page. Without this,
  // the first applyChatPosition call ran with isYtNonWatch=true and never
  // re-added hs-chat-right to <body>, so the position:fixed CSS for
  // #hs-mc-container stayed inactive even after flexy mounted.
  let _ytFlexyMountObs = null
  function watchYtFlexyMount() {
    // Idempotent: callable from init AND from applyChatPosition when it
    // detects isYtNonWatch on a watch URL (cold-load before flexy mounts).
    // Without re-arming on every nav, the body class hs-chat-* stays stripped
    // when flexy unmounts during /watch → /watch SPA transitions and the
    // observer was already torn down.
    if (hostPlatform !== 'yt') return
    if (_ytFlexyMountObs) return
    if (document.querySelector('ytd-watch-flexy:not([hidden])')) return // already there
    _ytFlexyMountObs = new MutationObserver(() => {
      if (!document.querySelector('ytd-watch-flexy:not([hidden])')) return
      _ytFlexyMountObs.disconnect()
      _ytFlexyMountObs = null
      try { applyChatPosition() } catch {}
      try { applyYouTubeChatWidth() } catch {}
    })
    _ytFlexyMountObs.observe(document.body, { childList: true, subtree: true })
    cleanup.trackObserver(_ytFlexyMountObs)
  }

  // Re-clamp chat width when viewport shrinks (window resize / devtools open).
  // Without this, a chat width persisted at a wider viewport pushes the video
  // off-screen on a smaller window and the resize handle's max can't catch up.
  let _ytViewportClampTimer = null
  function watchYtViewportClamp() {
    if (hostPlatform !== 'yt') return
    const onResize = () => {
      if (_ytViewportClampTimer) cleanup.clearTimeout(_ytViewportClampTimer)
      _ytViewportClampTimer = cleanup.setTimeout(() => {
        _ytViewportClampTimer = null
        applyYouTubeChatWidth()
        // Recompute the player's inline size for the new viewport. Without this
        // the player keeps the px size computed at the LAST chat-position change
        // — resize the window and the video overshoots its column (huge, clips
        // off both edges) while the metadata column is crushed into a sliver.
        // applyYouTubeChatWidth (above) re-clamps chatWidth first, so the player
        // sizes off the corrected width. Mirrors the Kick resize handler.
        try { applyPlatformPositionOverrides() } catch {}
        // Re-run full layout reflow — viewport change (WM fullscreen, devtools
        // toggle, browser zoom) needs every position-dependent piece updated.
        // The orange resize bar uses inline px from container.getBoundingClientRect
        // and goes stale; the tab/input bars follow via _updateMcLayout's
        // ResizeObserver but only when the bars themselves resize, which doesn't
        // fire on pure viewport changes. Cheap calls — all early-bail when nothing
        // to reposition.
        try { positionChatResizeHandle() } catch {}
        try { _updateMcLayout() } catch {}
      }, 80)
    }
    window.addEventListener('resize', onResize, { signal: mcSignal })
  }

  // Kick: re-apply player sizing on window resize AND on player mount.
  // applyPlatformPositionOverrides runs early in init — usually before Kick
  // mounts #injected-channel-player — and never re-ran, so overrides never
  // landed. Always re-apply once the player is present, plus on every resize.
  let _kickViewportClampTimer = null
  let _kickPlayerMountObs = null
  function watchKickViewportClamp() {
    if (!isKick) return
    const onResize = () => {
      if (_kickViewportClampTimer) cleanup.clearTimeout(_kickViewportClampTimer)
      _kickViewportClampTimer = cleanup.setTimeout(() => {
        _kickViewportClampTimer = null
        applyPlatformPositionOverrides()
        try { positionChatResizeHandle() } catch {}
        try { _updateMcLayout() } catch {}
      }, 80)
    }
    window.addEventListener('resize', onResize, { signal: mcSignal })

    if (document.querySelector('#injected-channel-player')) {
      // Player already mounted — apply now (early init call missed it).
      applyPlatformPositionOverrides()
    } else if (!_kickPlayerMountObs) {
      _kickPlayerMountObs = new MutationObserver(() => {
        if (document.querySelector('#injected-channel-player')) {
          _kickPlayerMountObs.disconnect()
          _kickPlayerMountObs = null
          applyPlatformPositionOverrides()
        }
      })
      _kickPlayerMountObs.observe(document.body, { childList: true, subtree: true })
      cleanup.trackObserver(_kickPlayerMountObs)
    }
  }

  /**
   * Setup resize handle for YouTube — left edge of #secondary sidebar
   */
  function setupYouTubeResizeHandle() {
    const secondary = document.querySelector('#secondary, ytd-watch-flexy #secondary')
    const mcContainer = document.getElementById('hs-mc-container')
    if (!secondary || !mcContainer || document.getElementById('hs-yt-resize-handle')) return

    const handle = document.createElement('div')
    handle.id = 'hs-yt-resize-handle'
    handle.style.touchAction = 'none'
    // YT now uses the unified #hs-c-resize-handle for ALL chat positions
    // (because chat-right is position:fixed, not in YT's flex tree). Hide
    // this platform handle on creation so we don't render two orange bars.
    handle.dataset._hsCHidden = '1'
    handle.style.setProperty('display', 'none', 'important')
    secondary.style.position = 'relative'
    secondary.insertBefore(handle, secondary.firstChild)

    let isResizing = false
    let startX = 0
    let startWidth = 0
    let rafId = 0
    let pendingWidth = 0
    let lastGhostWidth = 0
    let activePointerId = -1
    let overlay = null
    let ghost = null

    function applyResize() {
      rafId = 0
      if (pendingWidth === lastGhostWidth) return
      lastGhostWidth = pendingWidth
      chatWidth = pendingWidth
      if (ghost) ghost.style.width = pendingWidth + 'px'
    }

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      isResizing = true
      activePointerId = e.pointerId
      try { handle.setPointerCapture(e.pointerId) } catch (_) {}
      startX = e.clientX
      startWidth = chatWidth
      const rect = secondary.getBoundingClientRect()
      const w0 = Math.round(rect.width)
      pendingWidth = chatWidth
      lastGhostWidth = w0
      document.body.style.cursor = 'ew-resize'
      document.body.style.userSelect = 'none'

      ghost = document.createElement('div')
      ghost.id = 'hs-resize-ghost'
      ghost.style.cssText = buildGhostCss(rect, w0)
      document.body.appendChild(ghost)

      overlay = document.createElement('div')
      overlay.id = 'hs-resize-overlay'
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;cursor:ew-resize'
      document.body.appendChild(overlay)
      e.preventDefault()
    }, { signal: mcSignal })

    handle.addEventListener('pointermove', (e) => {
      if (!isResizing || e.pointerId !== activePointerId) return
      const delta = startX - e.clientX
      // Use the viewport-aware cap so a small window can't be dragged past the
      // point where the video column gets crushed.
      const ytMax = getYtMaxChatWidth()
      pendingWidth = Math.min(ytMax, Math.max(MIN_CHAT_WIDTH, startWidth + delta))
      if (!rafId) rafId = requestAnimationFrame(applyResize)
    }, { signal: mcSignal })

    function endDrag(e) {
      if (!isResizing || (e && e.pointerId !== activePointerId)) return
      isResizing = false
      activePointerId = -1
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
      chatWidth = pendingWidth || chatWidth
      if (ghost) { ghost.remove(); ghost = null }
      applyYouTubeChatWidth()
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (overlay) { overlay.remove(); overlay = null }
      // Force YT's IMA SDK + html5 player to re-measure so a mid-ad resize
      // doesn't leave the ad video at its pre-drag dimensions.
      try { window.dispatchEvent(new Event('resize')) } catch (_) {}
      saveChatWidth()
    }
    handle.addEventListener('pointerup', endDrag, { signal: mcSignal })
    handle.addEventListener('pointercancel', endDrag, { signal: mcSignal })

    loadChatWidth().then(() => { applyYouTubeChatWidth() })
    loadChatHeight()
    watchYtViewportClamp()
    watchYtLayoutAttrs()
    watchYtFlexyMount()
  }

  // Emote size — registry-managed (hs_emote_size); the emoteSize applier
  // runs applyEmoteSize + picker invalidation. Kept as a named function for
  // the picker's size buttons (emotes.js).
  function setEmoteSize(size) {
    setSetting('hs_emote_size', size)
  }

  function applyEmoteSize() {
    const targets = [document.documentElement, document.getElementById('hs-mc-messages')].filter(Boolean);
    // 28px = Twitch /1.0 native; /2.0 = 56; /3.0 = 112. Base matches URL res so 1x is truly native.
    const baseEmote = 28;
    const vars = {
      '--hs-emote-size': (baseEmote * emoteSize) + 'px',
      '--hs-time-font': (10 * emoteSize) + 'px',
      '--hs-badge-size': (18 * emoteSize) + 'px',
      '--hs-badge-font': (10 * emoteSize) + 'px',
      '--hs-stat-badge-font': (9 * emoteSize) + 'px',
      '--hs-stat-badge-line': (16 * emoteSize) + 'px',
      '--hs-badge-img': (18 * emoteSize) + 'px',
    };
    for (const el of targets) {
      for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
    }
    renderMessages(currentTab);
  }

  // Emoji scale — separate var, default 2x. Registry-managed (hs_emoji_size,
  // incl. the legacy bigEmoji=false → 1x migration).
  let emojiSize = 2;
  function applyEmojiSize() {
    const targets = [document.documentElement, document.getElementById('hs-mc-messages')].filter(Boolean);
    for (const el of targets) el.style.setProperty('--hs-emoji-scale', String(emojiSize));
  }

  // =====================================================================
  // MOD TOOLBAR — singleton element moved row→row on hover. Mirrors the
  // heatsync.org website spec (mod-toolbar.js + mod-toolbar.css).
  // Twitch only — GQL APIs already in twitch-api.js. No re-build on hover;
  // only the per-row gate runs to show/hide individual buttons.
  // =====================================================================
  const MOD_BUTTON_CATALOG = {
    delete_message: { label: 'x',  title: 'delete this message', action: 'delete',  durationSec: null,   needsMsgId: true,  hotkey: 'x' },
    timeout_1m:     { label: '1m', title: 'timeout 1 minute',    action: 'timeout', durationSec: 60,     needsMsgId: false, hotkey: null },
    timeout_10m:    { label: '10m',title: 'timeout 10 minutes',  action: 'timeout', durationSec: 600,    needsMsgId: false, hotkey: 't' },
    timeout_1h:     { label: '1h', title: 'timeout 1 hour',      action: 'timeout', durationSec: 3600,   needsMsgId: false, hotkey: null },
    timeout_24h:    { label: '24h',title: 'timeout 24 hours',    action: 'timeout', durationSec: 86400,  needsMsgId: false, hotkey: null },
    timeout_7d:     { label: '7d', title: 'timeout 7 days',      action: 'timeout', durationSec: 604800, needsMsgId: false, hotkey: null },
    ban:            { label: '⛔',title: 'permanent ban',    action: 'ban',     durationSec: null,   needsMsgId: false, hotkey: 'b' },
    unban:          { label: '✓',title: 'unban user',       action: 'unban',   durationSec: null,   needsMsgId: false, hotkey: null },
  }
  // Hover toolbar is fully opt-in: NO buttons default-on. Even the X
  // (delete-this-message) is hidden until the user enables it in settings →
  // mod toolbar. Timeouts/bans live on the profile-card mod row instead —
  // left-click username surfaces the full set at the top of the card.
  const DEFAULT_MOD_BUTTONS = []
  let modToolbarButtons = [...DEFAULT_MOD_BUTTONS]

  // Per-channel mod state. Pre-fetch on tab/render so first hover doesn't lag.
  const _modStateCache = new Map()
  const _modStatePending = new Map()
  async function isModFor(channel) {
    if (!channel) return false
    channel = channel.toLowerCase()
    if (_modStateCache.has(channel)) return _modStateCache.get(channel)
    if (_modStatePending.has(channel)) return _modStatePending.get(channel)
    const p = (async () => {
      try {
        const safe = channel.replace(/[^a-z0-9_]/g, '')
        if (!safe) return false
        const data = await twitchGql(`{ user(login: "${safe}") { self { isModerator } } }`)
        const isMod = !!data?.data?.user?.self?.isModerator
        _modStateCache.set(channel, isMod)
        return isMod
      } catch (_) { return false }
      finally { _modStatePending.delete(channel) }
    })()
    _modStatePending.set(channel, p)
    return p
  }
  function isModForSync(channel) {
    if (!channel) return false
    const c = channel.toLowerCase()
    return _modStateCache.get(c) === true
  }
  function prefetchModFor(channel) {
    if (!channel) return
    const c = channel.toLowerCase()
    if (!_modStateCache.has(c) && !_modStatePending.has(c)) isModFor(c)
  }

  // Singleton toolbar — built once, moved between rows.
  let _modToolbar = null
  let _modRow = null
  let _modCtx = null
  let _modHideTimer = null

  function buildModToolbarOnce() {
    if (_modToolbar) return _modToolbar
    const bar = document.createElement('div')
    bar.className = 'hs-mod-toolbar'
    bar.setAttribute('role', 'toolbar')
    bar.setAttribute('aria-label', 'message moderation actions')
    bar.addEventListener('mousedown', e => e.stopPropagation())
    bar.addEventListener('click', e => e.stopPropagation())
    _modToolbar = bar
    rebuildModToolbarButtons()
    return bar
  }
  function rebuildModToolbarButtons() {
    if (!_modToolbar) return
    _modToolbar.textContent = ''
    for (const id of modToolbarButtons) {
      const def = MOD_BUTTON_CATALOG[id]
      if (!def) continue
      const b = document.createElement('button')
      b.className = 'hs-mod-btn hs-mod-' + def.action
      b.type = 'button'
      b.textContent = def.label
      b.title = def.title + (def.hotkey ? ` (${def.hotkey.toUpperCase()})` : '')
      b.dataset.modBtn = id
      b.tabIndex = -1
      b.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation() })
      b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); runModAction(id) })
      _modToolbar.appendChild(b)
    }
  }
  function gateModButtons(ctx) {
    if (!_modToolbar) return false
    let anyVisible = false
    for (const btn of _modToolbar.querySelectorAll('.hs-mod-btn')) {
      const def = MOD_BUTTON_CATALOG[btn.dataset.modBtn]
      let ok = !!def
      if (ok && def.needsMsgId && !ctx.msgId) ok = false
      if (ok && !ctx.user) ok = false
      btn.style.display = ok ? '' : 'none'
      if (ok) anyVisible = true
    }
    return anyVisible
  }
  function attachToRow(row) {
    if (_modRow === row && _modToolbar?.parentElement === row) return
    const bar = buildModToolbarOnce()
    const replyBtn = row.querySelector('.hs-mc-reply-btn')
    if (replyBtn) row.insertBefore(bar, replyBtn)
    else row.appendChild(bar)
    _modRow = row
  }
  function detachModToolbar() {
    if (_modHideTimer) { clearTimeout(_modHideTimer); _modHideTimer = null }
    if (_modToolbar?.parentElement) _modToolbar.parentElement.removeChild(_modToolbar)
    _modRow = null
    _modCtx = null
  }
  function cancelModHide() {
    if (_modHideTimer) { clearTimeout(_modHideTimer); _modHideTimer = null }
  }
  function scheduleModHide() {
    cancelModHide()
    // 0ms: detach on next task tick — cancelable by an adjacent-row mouseover
    // firing in the same event-loop turn (sibling row, mod button inside row,
    // or overlay row via the wiring in ensureStackOverlay*). 200ms felt laggy.
    _modHideTimer = setTimeout(detachModToolbar, 0)
  }
  async function runModAction(id) {
    const def = MOD_BUTTON_CATALOG[id]
    if (!def || !_modCtx) return
    const { channel, user, msgId, row } = _modCtx
    const wasOp = row?.style?.opacity
    if (row) row.style.opacity = '0.5'
    let resp
    try {
      if (def.action === 'delete')       resp = await deleteTwitchMessage(channel, msgId)
      else if (def.action === 'timeout') resp = await timeoutTwitchUser(channel, user, def.durationSec, '')
      else if (def.action === 'ban')     resp = await banTwitchUser(channel, user, '')
      else if (def.action === 'unban')   resp = await unbanTwitchUser(channel, user)
    } catch (e) { resp = { error: e.message } }
    if (row) row.style.opacity = wasOp || ''
    if (resp?.ok) {
      if (def.action === 'delete' && row && dimTimeouts) row.classList.add('hs-mc-msg-cleared')
      const verb = def.action === 'timeout' ? `timed out ${user} ${def.durationSec}s`
                 : def.action === 'ban'     ? `banned ${user}`
                 : def.action === 'unban'   ? `unbanned ${user}`
                 :                            'deleted'
      try { showToast(verb, 'success') } catch (_) {}
    } else {
      try { showToast(`${def.action} failed: ${resp?.error || 'unknown'}`, 'error') } catch (_) {}
    }
    detachModToolbar()
  }
  function wireModToolbarHover(messagesEl) {
    if (!messagesEl || messagesEl._hsModToolbarWired) return
    messagesEl._hsModToolbarWired = true
    messagesEl.addEventListener('mouseover', (e) => {
      const row = e.target.closest('.hs-mc-msg')
      if (!row) return
      if (row === _modRow) { cancelModHide(); return }
      const plat = row.dataset.msgPlatform
      if (plat === 'kick' || plat === 'youtube' || plat === 'yt') return
      const channel = row.dataset.msgChannel
      const user = row.dataset.msgUser
      const msgId = row.dataset.msgId
      if (!channel || !user) return
      // Skip own messages — mod actions on yourself are nonsense UX. Use the
      // data-msg-self flag set at build time (currentUsername may be null at
      // hover time during pre-auth bootstrap); fall back to live compare.
      if (row.dataset.msgSelf === '1') return
      if (currentUsername && user.toLowerCase() === currentUsername.toLowerCase()) return
      // Sync gate: only attach if we already know we're a mod. Pre-fetch otherwise
      // so the next hover in this channel is instant — no UI lag.
      if (!isModForSync(channel)) { prefetchModFor(channel); return }
      const ctx = { channel, user, msgId, row }
      _modCtx = ctx
      buildModToolbarOnce()
      if (!gateModButtons(ctx)) return
      attachToRow(row)
      cancelModHide()
    }, true)
    messagesEl.addEventListener('mouseout', (e) => {
      if (!_modRow) return
      const to = e.relatedTarget
      if (to && _modRow.contains(to)) return
      scheduleModHide()
    }, true)
    messagesEl.addEventListener('scroll', () => detachModToolbar(), { passive: true })
  }

  // Hotkeys — x (delete), t (10m timeout), b (ban). Hold while hovering a row.
  document.addEventListener('keydown', (e) => {
    if (!_modCtx) return
    const t = e.target
    const typing = t && (t.isContentEditable || ['INPUT', 'TEXTAREA'].includes(t.tagName))
    if (typing) return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const key = (e.key || '').toLowerCase()
    for (const id of modToolbarButtons) {
      const def = MOD_BUTTON_CATALOG[id]
      if (def?.hotkey === key) {
        e.preventDefault()
        runModAction(id)
        return
      }
    }
  }, { signal: mcSignal })

  // '/' focuses the live-tab chat filter (vim-style) — only when not already
  // typing, no modifier held, and the filter bar is actually showing.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
    const t = e.target
    if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA'].includes(t.tagName))) return
    if (!isLiveSearchTab(currentTab)) return
    const bar = document.getElementById('hs-mc-search-bar')
    if (!bar || !bar.classList.contains('visible')) return
    const input = document.getElementById('hs-mc-search-input')
    if (!input) return
    e.preventDefault()
    input.focus()
    input.select()
  }, { signal: mcSignal })

  // (automod moved to automod.js)

  // Ephemeral auto-tabs — every stream open ANYWHERE in the browser shows
  // up as a tab here (dimmed, unsaved, vanishes when its window closes).
  // BG broadcasts the open-channel set; entries are runtime-only:
  // saveConfig/server-sync filter `ephemeral`, so nothing persists.
  function reconcileAutoTabs(openChannels) {
    const openSet = new Set(openChannels.map(c => String(c).toLowerCase()))
    const here = (getCurrentChannel() || '').toLowerCase()
    openSet.delete(here) // this tab's own channel is already the live tab
    let changed = false
    // drop ephemerals whose browser tab closed
    for (let i = config.channels.length - 1; i >= 0; i--) {
      const c = config.channels[i]
      if (c?.ephemeral && !openSet.has((c.twitch || '').toLowerCase())) {
        config.channels.splice(i, 1)
        changed = true
      }
    }
    // add ephemerals for newly opened streams not already configured
    for (const ch of openSet) {
      const exists = config.channels.some(c =>
        (c?.twitch && c.twitch.toLowerCase() === ch))
      if (exists) continue
      config.channels.push({ id: `auto_${ch}`, twitch: ch, ephemeral: true })
      try { irc?.join?.(ch) } catch (_) {}
      // load the channel's third-party emote sets (bttv/ffz/7tv) — without
      // this, everyone else's channel emotes render as raw text on auto-tabs
      // (own emotes still worked: inventory is global). same call the
      // manual add-channel path makes; bg caches+TTLs duplicates.
      try { chrome.runtime.sendMessage({ type: 'join_channel', platform: 'twitch', channel: ch }) } catch (_) {}
      changed = true
    }
    if (changed) {
      _channelLookup = null
      try { updateTabBar() } catch (_) {}
    }
  }

  // Server-side heat spike (moment detector) → inline 🔥 row in all chats.
  // Dedupe per channel per 10min mirrors the server cooldown so multi-source
  // delivery (reconnects) can't double-post.
  const _momentSeen = new Map()
  function handleMomentSpike(d) {
    if (!d?.channel) return
    // relevance filter — the server broadcasts spikes for EVERY tracked
    // channel (the site's rail/hot page want that breadth); the inline 🔥
    // alert is personal: only channels in YOUR tabs or the one you're
    // watching. without this, 199-channel coverage = spam about strangers.
    const chLc = String(d.channel).toLowerCase()
    const relevant = (config?.channels || []).some(c =>
      (c?.twitch && c.twitch.toLowerCase() === chLc) ||
      (c?.kick && c.kick.toLowerCase() === chLc)
    ) || (typeof getCurrentChannel === 'function' && (getCurrentChannel() || '').toLowerCase() === chLc)
    if (!relevant) return
    const key = `${d.platform}:${d.channel}`
    const now = Date.now()
    if (now - (_momentSeen.get(key) || 0) < 10 * 60_000) return
    _momentSeen.set(key, now)
    if (_momentSeen.size > 200) { const k0 = _momentSeen.keys().next().value; _momentSeen.delete(k0) }
    injectInlineNotif('moment', {
      type: 'moment',
      momentChannel: d.channel,
      momentPlatform: d.platform || 'twitch',
      text: `${d.channel} chat is exploding — ${d.rate} msgs/30s (usually ~${Math.max(1, Math.round(d.baseline))})`,
      color: '#ff8700',
      time: now,
    })
  }

  // Inject an inline notification into active chat tabs
  function injectInlineNotif(notifType, msg) {
    if (!inlineNotifs[notifType]) return
    const typeDef = INLINE_NOTIF_TYPES[notifType]
    if (!typeDef) return

    msg.inlineNotifType = notifType
    msg.inlineNotifColor = typeDef.color
    msg.inlineNotifBorderColor = typeDef.borderColor
    msg.inlineNotifLabel = typeDef.tag

    // Persist into ALL channel buffers (IRC + Kick + YouTube) so notification appears on every tab
    for (const ch of config.channels) {
      const twitchName = ch?.twitch
      const kickName = ch.kick
      const chId = ch?.id
      const buffer = (twitchName && irc?.channels?.get(twitchName)) ||
                     (kickName && kickChat?.channels?.get(kickName))
      if (buffer) buffer.push(msg)
      // Also inject into YouTube channel buffers
      const ytBuf = chId && channelYtMessages.get(chId)
      if (ytBuf) {
        ytBuf.push(msg)
        if (ytBuf.length > PERSIST_MAX_YT) ytBuf.splice(0, ytBuf.length - PERSIST_MAX_YT)
      }
    }

    // Live-append to current tab if it's a chat tab
    const active = currentTab
    const isChatTab = active === 'live' || active === 'mentions' ||
      config.channels.some(ch => ch.id === active)
    if (isChatTab) appendMessage(msg, active)
  }

  // Font family + size — mirrors heatsync.org's appearance picker.
  // CozetteVector + GohuFont are bundled bitmap fonts (chrome/fonts/);
  // 'monospace' uses host system, 'custom' uses settings.customFontName.
  // Apply via CSS vars on #hs-mc-container so storage.onChanged can flip
  // it live without rebuilding the panel.
  function resolveFontStack(family, customName) {
    if (family === 'GohuFont') return "'GohuFont', 'Courier New', monospace";
    if (family === 'monospace') return "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    if (family === 'twitch') return "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";
    if (family === 'custom') {
      const name = (customName || '').trim();
      if (name) return `'${name.replace(/'/g, '')}', 'Courier New', monospace`;
    }
    return "'CozetteVector', 'Courier New', monospace";
  }
  function applyFontSettings(fontFamily, fontSize, customFontName) {
    // Bitmap-font mode flag — kills AA + faux-bold + hinting for crisp
    // pixel-grid rendering. Cozette/Gohu only ship a single 400 master,
    // so any font-weight ≥500 in CSS would otherwise synthesize a blurry
    // bold. .hs-font-bitmap rule in styles.js sets font-synthesis:none.
    // Toggle on body+root FIRST (always available) — reply-stack/notif
    // overlays mount to <body> outside the container, so body is the
    // authoritative carrier. Container toggle below is belt-and-braces.
    const isBitmap = fontFamily === 'CozetteVector' || fontFamily === 'GohuFont' || !fontFamily;
    document.body.classList.toggle('hs-font-bitmap', isBitmap);
    document.documentElement.classList.toggle('hs-font-bitmap', isBitmap);
    // Set the vars on :root FIRST, unconditionally — the panel often mounts
    // AFTER settings load (the load-time applier ran with no container), so a
    // non-default size used to silently fall back to 13px until the user poked
    // a setting. :root always exists and the panel inherits from it, so the
    // size lands on the first paint. Container writes below are belt-and-braces.
    const stack = resolveFontStack(fontFamily, customFontName);
    const root = document.documentElement;
    root.style.setProperty('--hs-mc-font', stack);
    const sizeNum = parseInt(fontSize, 10);
    if (sizeNum >= 10 && sizeNum <= 22) {
      // One synced size drives both the panel chrome and the message area —
      // the old per-device override (F+/F-) folded into this setting.
      root.style.setProperty('--hs-mc-base-size', sizeNum + 'px');
      root.style.setProperty('--hs-chat-font', sizeNum + 'px');
    }
    const container = document.getElementById('hs-mc-container');
    if (!container) return;
    container.style.setProperty('--hs-mc-font', stack);
    container.classList.toggle('hs-font-bitmap', isBitmap);
    if (sizeNum >= 10 && sizeNum <= 22) {
      container.style.setProperty('--hs-mc-base-size', sizeNum + 'px');
      container.style.setProperty('--hs-chat-font', sizeNum + 'px');
      const msgsEl = document.getElementById('hs-mc-messages');
      if (msgsEl) msgsEl.style.setProperty('--hs-chat-font', sizeNum + 'px');
    }
  }


  // Platform filters — per-tab toggle to mute Twitch/Kick/YT messages.
  // Persisted to chrome.storage.local (overflow bucket); never enters sync.
  // Self-prunes here: only keep entries for tabs this user actually has now.
  async function loadPlatformFilters() {
    try {
      const overflow = await cachedUiOverflow();
      let stored = overflow.platform_filters
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
        // One-shot migration: pull from sync if a legacy install still has it.
        const legacy = await cachedUiSettings();
        if (legacy.ui_settings?.platformFilters && typeof legacy.ui_settings.platformFilters === 'object') {
          stored = legacy.ui_settings.platformFilters
          chrome.storage.local.set({ platform_filters: stored }).catch(() => {})
        }
      }
      if (stored && typeof stored === 'object') {
        // Drop entries for tab IDs we no longer have — bounded growth.
        const knownIds = new Set((config.channels || []).map(c => c.id))
        const pruned = {}
        for (const [id, val] of Object.entries(stored)) {
          if (knownIds.has(id) && val && typeof val === 'object') pruned[id] = val
        }
        platformFilters = pruned
      }
    } catch {}
  }

  function getPlatformFilter(tabId) {
    const f = platformFilters[tabId] || {};
    return { twitch: f.twitch !== false, kick: f.kick !== false, youtube: f.youtube !== false };
  }

  function togglePlatformFilter(tabId, plat) {
    const f = getPlatformFilter(tabId);
    f[plat] = !f[plat];
    platformFilters[tabId] = f;
    saveUiSetting('platformFilters', platformFilters);
  }

  function isPlatformFilterTab(tabId) {
    return tabId === 'live' || config.channels.some(c => c.id === tabId);
  }

  function renderPlatformFilterButtons() {
    const group = document.getElementById('hs-mc-platfilter');
    if (!group) return;
    while (group.firstChild) group.removeChild(group.firstChild);
    const tab = currentTab;
    if (!isPlatformFilterTab(tab)) return; // empty container hides via :empty CSS

    // Determine which platforms apply to this tab. Read config.channels
    // directly (cached lookup can lag a beat behind mutations) and treat an
    // unknown tab as no-platforms — never offer filters a tab can't use.
    let hasTwitch = true, hasKick = true, hasYt = true;
    if (tab !== 'live') {
      const ch = config.channels.find(c => c.id === tab);
      if (!ch) return;
      hasTwitch = !!ch.twitch;
      hasKick = !!ch.kick;
      hasYt = !!ch.youtube;
    }

    // Single-platform tab — filter is degenerate, leave container empty
    const activePlatforms = [hasTwitch, hasKick, hasYt].filter(Boolean).length;
    if (activePlatforms < 2) return;

    const filt = getPlatformFilter(tab);
    const meta = [
      { key: 'twitch', label: 'T', show: hasTwitch },
      { key: 'kick', label: 'K', show: hasKick },
      { key: 'youtube', label: 'Y', show: hasYt }
    ];

    for (const p of meta) {
      if (!p.show) continue;
      const btn = document.createElement('button');
      btn.className = 'hs-mc-pf-btn hs-mc-pf-' + p.key;
      btn.dataset.platform = p.key;
      btn.classList.toggle('off', !filt[p.key]);
      btn.textContent = p.label;
      btn.title = (filt[p.key] ? 'Hide ' : 'Show ') + p.key + ' messages';
      btn.addEventListener('click', () => {
        togglePlatformFilter(currentTab, p.key);
        const on = getPlatformFilter(currentTab)[p.key];
        btn.classList.toggle('off', !on);
        btn.title = (on ? 'Hide ' : 'Show ') + p.key + ' messages';
        renderMessages(currentTab);
      });
      group.appendChild(btn);
    }
  }


  // Tab subsystems — a disabled subsystem hides its tab affordance too
  const _TAB_SUBSYSTEM = { feed: 'feed', whispers: 'whispers', mentions: 'mentions' }
  function applyHiddenTabs() {
    if (!tabBarElement) return;
    for (const id of HIDABLE_TABS) {
      const btn = tabBarElement.querySelector(`.hs-mc-tab[data-tab="${id}"]`);
      const subOff = _TAB_SUBSYSTEM[id] && !isEnabled(_TAB_SUBSYSTEM[id]);
      if (btn) btn.style.display = (hiddenTabs.has(id) || subOff) ? 'none' : '';
    }
    const curOff = _TAB_SUBSYSTEM[currentTab] && !isEnabled(_TAB_SUBSYSTEM[currentTab]);
    if (hiddenTabs.has(currentTab) || curOff) switchTab('live');
  }

  // Background chest-claim sweeper. Chests spawn every ~15min during active
  // viewing and expire after ~15min unclaimed. 5min poll catches each within
  // its claim window. Calls fetchChannelRewards (from twitch-api.js) which
  // returns availableClaim id, then claimCommunityPoints fires the GQL mutation
  // and emits a toast on success.
  let _autoClaimPoller = null
  let _autoClaimSweepInFlight = false
  async function _autoClaimSweep() {
    if (_autoClaimSweepInFlight || !autoClaimPoints) return
    _autoClaimSweepInFlight = true
    try {
      const seen = new Set()
      const channels = (config.channels || [])
        .map(c => (c.twitch || '').toLowerCase().trim())
        .filter(ch => ch && !seen.has(ch) && (seen.add(ch), true))
      for (let i = 0; i < channels.length; i++) {
        if (!autoClaimPoints) break
        const ch = channels[i]
        try {
          const r = await fetchChannelRewards(ch)
          if (r?.availableClaim && r.channelId) {
            await claimCommunityPoints(r.availableClaim, r.channelId, ch)
          }
        } catch (_) {}
        if (i < channels.length - 1) await new Promise(res => setTimeout(res, 2000))
      }
    } finally {
      _autoClaimSweepInFlight = false
    }
  }
  function startAutoClaimPoller() {
    if (_autoClaimPoller || !autoClaimPoints) return
    cleanup.setTimeout(_autoClaimSweep, 20000)
    _autoClaimPoller = cleanup.setInterval(_autoClaimSweep, 5 * 60 * 1000)
  }
  function stopAutoClaimPoller() {
    if (!_autoClaimPoller) return
    cleanup.clearInterval(_autoClaimPoller)
    _autoClaimPoller = null
  }

  // ─── settings sub-tab helpers ────────────────────────────────────────────

  // SVG icons for the settings sub-tabs (16x16 stroke, no fill)
  const _SET_SUBTAB_ICONS = {
    display: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="2" width="14" height="10" rx="1"/><line x1="5" y1="14" x2="11" y2="14"/><line x1="8" y1="12" x2="8" y2="14"/></svg>',
    chat:    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6l-3 2v-2H3a1 1 0 0 1-1-1V3z"/></svg>',
    notifs:  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2a5 5 0 0 1 5 5v3l1 1H2l1-1V7a5 5 0 0 1 5-5z"/><line x1="6.5" y1="13" x2="9.5" y2="13"/></svg>',
    mod:     '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5l5 2.5v4c0 3-2.5 5.5-5 6.5C5.5 13.5 3 11 3 8V4l5-2.5z"/></svg>',
    filters: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4h12M4 8h8M6 12h4"/></svg>',
    tweaks:  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4h3l1-2h4l1 2h3M2 8h12M2 12h3l1 2h4l1-2h3"/></svg>',
    system:  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.42 1.42M11.53 11.53l1.42 1.42M3.05 12.95l1.42-1.42M11.53 4.47l1.42-1.42"/></svg>',
  };
  const _SET_SUBTAB_ORDER = ['display', 'chat', 'notifs', 'mod', 'filters', 'tweaks', 'system'];

  // Tweaks (twitch ui noise toggles) render straight from the registry
  // (`tweak: true` entries); content.js applyUiSettings owns the CSS rules.
  function _renderSetSubtabBar() {
    return '<div class="hs-mc-set-subtabs">' +
      _SET_SUBTAB_ORDER.map(function(id) {
        return '<button class="hs-mc-set-subtab' + (_settingsSubtab === id ? ' active' : '') + '" data-set-subtab="' + id + '" title="' + id + '">' +
          _SET_SUBTAB_ICONS[id] + '</button>';
      }).join('') +
    '</div>';
  }

  // ─── registry-driven settings renderer ───────────────────────────────
  // Every registry entry renders through one emitter per control type,
  // reusing the existing DOM/CSS vocabulary (setting-row, toggle-pill,
  // size-btns, locale-select, textarea). Categories compose registry
  // sections with the few hand-rendered islands (mod toolbar, language,
  // muted users, crash log, backup, defaults).

  let _setQuery = ''
  const _setCollapsed = new Set()        // '<category>|<section title>'
  let _setFocusRow = null                // data-set-row id of keyboard focus
  let _setPaneCtx = ''                   // pane identity for scroll preservation
  let _setHelpOpen = false               // '?' keybinding overlay
  ;(function _loadCollapsedSections() {
    try {
      chrome.storage.local.get('hs_set_collapsed', function(d) {
        if (Array.isArray(d?.hs_set_collapsed)) {
          for (const id of d.hs_set_collapsed) _setCollapsed.add(String(id))
        }
      })
    } catch (_) {}
  })()
  function _saveCollapsedSections() {
    try { chrome.storage.local.set({ hs_set_collapsed: [..._setCollapsed] }) } catch (_) {}
  }

  function _setLabel(def) { return def.labelKey ? t(def.labelKey) : (def.label || def.key) }
  function _setTip(def) { return def.tipKey ? t(def.tipKey) : (def.tip || '') }
  function _setSectionTitle(def) { return def.sectionKey ? t(def.sectionKey) : (def.section || '') }
  function _optLabel(o) { return o.labelKey ? t(o.labelKey) : (o.label !== undefined ? o.label : String(o.value)) }

  function _setLabelSpan(def, extraHtml) {
    var tip = _setTip(def)
    var tipAttr = tip ? ' data-tip="' + escapeHtml(tip) + '"' : ''
    return '<span class="hs-mc-setting-label"' + tipAttr + '>' + (extraHtml || '') + escapeHtml(_setLabel(def)) + '</span>'
  }

  function _depSatisfied(def) {
    if (!def.dependsOn) return true
    var v = getSetting(def.dependsOn.key)
    return 'equals' in def.dependsOn ? v === def.dependsOn.equals : !!v
  }

  // One renderable row = {id, html, hay}. boolmap/multiselect entries
  // expand to one row per option so search and keyboard nav see each.
  // Boot-time values for entries that need a reload to apply (reloadApply
  // schema field) — snapshot in loadAllSettings, drives the [reload] chip.
  const _bootVals = {}

  // Does this row's current value differ from its default? (noReset entries
  // never show modified — they have no working reset.)
  function _rowModified(def, opt) {
    if (def.noReset) return false
    const cur = getSetting(def.key)
    if (def.type === 'boolmap' && opt) return (cur[opt.value] !== false) !== (opt.default !== false)
    if (def.type === 'multiselect' && opt) return cur.includes(opt.value) !== def.default.includes(opt.value)
    return JSON.stringify(cur) !== JSON.stringify(def.default)
  }

  // Does this row need a page reload before its current value takes effect?
  function _reloadPending(def, opt) {
    if (def.key === 'subsystems' && opt && opt.applies === 'reload' && _gatesAtBoot) {
      return (getSetting('subsystems')[opt.value] !== false) !== (_gatesAtBoot[opt.value] !== false)
    }
    if (def.reloadApply && def.key in _bootVals) {
      return JSON.stringify(getSetting(def.key)) !== JSON.stringify(_bootVals[def.key])
    }
    return false
  }

  // In-place update of the modified edge + the section's orange counter
  // after a control change (no full re-render needed for plain pills).
  function _syncRowModEdge(el, def, opt) {
    const row = el.closest('.hs-mc-setting-row')
    if (!row) return
    row.classList.toggle('hs-mc-set-mod', _rowModified(def, opt))
    const group = row.closest('.hs-mc-settings-group')
    const title = group && group.querySelector('[data-set-fold]')
    if (!title) return
    const count = group.querySelectorAll('.hs-mc-setting-row.hs-mc-set-mod').length
    let cnt = title.querySelector('.hs-mc-set-modcnt')
    if (!count) { if (cnt) cnt.remove(); return }
    if (!cnt) {
      cnt = document.createElement('span')
      cnt.className = 'hs-mc-set-modcnt'
      title.appendChild(document.createTextNode(' '))
      title.appendChild(cnt)
    }
    cnt.textContent = count + '*'
  }

  function _rowsForDef(def) {
    var rows = []
    var base = (_setLabel(def) + ' ' + _setTip(def) + ' ' + _setSectionTitle(def) + ' ' +
      def.category + ' ' + def.key + ' ' + (def.alias || '')).toLowerCase()
    var child = def.dependsOn ? ' hs-mc-set-child' : ''
    var glyph = def.dependsOn ? '<span class="hs-mc-set-child-glyph">└ </span>' : ''

    if (def.type === 'boolmap') {
      for (const o of def.options) {
        var on = !!getSetting(def.key)[o.value]
        var prefix = '<span style="color:' + o.color + '">' + (o.tag || '◆') + '</span> '
        var lbl = _optLabel(o)
        if (o.tag) lbl = lbl.replace(o.tag, '').trim()
        var oTip = o.tipKey ? t(o.tipKey) : (o.tip || '')
        var oMod = _rowModified(def, o)
        var oChip = _reloadPending(def, o) ? '<button class="hs-mc-set-reload" data-set-reload>reload</button>' : ''
        rows.push({
          id: def.key + ':' + o.value,
          mod: oMod,
          hay: (base + ' ' + lbl + ' ' + oTip + ' ' + o.value).toLowerCase(),
          html: '<div class="hs-mc-setting-row' + child + (oMod ? ' hs-mc-set-mod' : '') + '" data-set-row="' + def.key + ':' + o.value + '">' +
            glyph +
            '<button class="hs-mc-toggle-pill' + (on ? ' active' : '') + '" data-set-key="' + def.key + '" data-set-sub="' + o.value + '"><span class="hs-mc-toggle-knob"></span></button>' +
            '<span class="hs-mc-setting-label"' + (oTip ? ' data-tip="' + escapeHtml(oTip) + '"' : '') + '>' + prefix + escapeHtml(lbl) + '</span>' + oChip +
          '</div>',
        })
      }
      return rows
    }

    if (def.type === 'multiselect') {
      for (const o of def.options) {
        var member = getSetting(def.key).includes(o.value)
        var active = def.invertDisplay ? !member : member
        var mMod = _rowModified(def, o)
        var mTag = o.tag ? '<span style="font-family:monospace;color:#ff8700;margin-right:6px;min-width:34px;display:inline-block">' + escapeHtml(o.tag) + '</span>' : ''
        rows.push({
          id: def.key + ':' + o.value,
          mod: mMod,
          hay: (base + ' ' + _optLabel(o) + ' ' + o.value).toLowerCase(),
          html: '<div class="hs-mc-setting-row' + child + (mMod ? ' hs-mc-set-mod' : '') + '" data-set-row="' + def.key + ':' + o.value + '">' +
            glyph +
            '<button class="hs-mc-toggle-pill' + (active ? ' active' : '') + '" data-set-key="' + def.key + '" data-set-value="' + escapeHtml(String(o.value)) + '"><span class="hs-mc-toggle-knob"></span></button>' +
            '<span class="hs-mc-setting-label">' + mTag + escapeHtml(_optLabel(o)) + '</span>' +
          '</div>',
        })
      }
      return rows
    }

    var inner = ''
    var split = true
    var block = false
    var val = getSetting(def.key)

    if (def.type === 'bool') {
      split = false
      inner = '<button class="hs-mc-toggle-pill' + (val ? ' active' : '') + '" data-set-key="' + def.key + '"><span class="hs-mc-toggle-knob"></span></button>' +
        _setLabelSpan(def)
    } else if (def.type === 'enum' && (def.control === 'sizebtns' || def.options.length <= 3)) {
      inner = _setLabelSpan(def) +
        '<div class="hs-mc-size-btns">' +
        def.options.map(function(o) {
          return '<button class="hs-mc-size-btn' + (o.value === val ? ' active' : '') + '" data-set-key="' + def.key + '" data-set-value="' + escapeHtml(String(o.value)) + '">' + escapeHtml(_optLabel(o)) + '</button>'
        }).join('') +
        '</div>'
    } else if (def.type === 'enum') {
      inner = _setLabelSpan(def) +
        '<select class="hs-mc-locale-select" data-set-key="' + def.key + '" style="max-width:55%">' +
        def.options.map(function(o) {
          return '<option value="' + escapeHtml(String(o.value)) + '"' + (o.value === val ? ' selected' : '') + '>' + escapeHtml(_optLabel(o)) + '</option>'
        }).join('') +
        '</select>'
    } else if (def.type === 'range') {
      var scale = def.displayScale || 1
      inner = _setLabelSpan(def) +
        '<div style="display:flex;align-items:center;gap:6px">' +
        '<input class="hs-mc-set-range" type="range" min="' + (def.options.min * scale) + '" max="' + (def.options.max * scale) + '" step="' + (def.options.step * scale) + '" value="' + Math.round(val * scale) + '" data-set-key="' + def.key + '">' +
        '<span class="hs-mc-set-range-val">' + Math.round(val * scale) + '</span>' +
        '</div>'
    } else if (def.control === 'textarea') {
      block = true
      split = false
      var ph = def.placeholderKey ? t(def.placeholderKey) : (def.placeholder || '')
      inner = _setLabelSpan(def) +
        '<textarea class="hs-mc-setting-textarea" data-set-key="' + def.key + '" placeholder="' + escapeHtml(ph) + '" rows="3">' + escapeHtml(val) + '</textarea>'
    } else { // text
      inner = _setLabelSpan(def) +
        '<input class="hs-mc-set-text-input" data-set-key="' + def.key + '" type="text" value="' + escapeHtml(val) + '" style="width:140px">'
    }

    var sMod = _rowModified(def)
    var sChip = _reloadPending(def) ? '<button class="hs-mc-set-reload" data-set-reload>reload</button>' : ''
    rows.push({
      id: def.key,
      mod: sMod,
      hay: base + ' ' + (def.type === 'enum' ? def.options.map(function(o) { return _optLabel(o) + ' ' + o.value }).join(' ').toLowerCase() : ''),
      html: '<div class="hs-mc-setting-row' +
        (split ? ' hs-mc-setting-row-split' : '') +
        (block ? ' hs-mc-setting-row-block' : '') + child + (sMod ? ' hs-mc-set-mod' : '') + '" data-set-row="' + def.key + '">' +
        glyph + inner + sChip +
      '</div>',
    })
    return rows
  }

  function _setQueryTokens() {
    return _setQuery.toLowerCase().split(/\s+/).filter(Boolean)
  }
  function _rowMatches(hay, tokens) {
    return tokens.every(function(tk) { return hay.indexOf(tk) !== -1 })
  }

  // Render the registry sections of one category. opts.only limits to the
  // named sections (lets system interleave hand-rendered islands).
  function _regSections(cat, only) {
    var sections = []
    var byTitle = new Map()
    for (const def of SETTINGS) {
      if (def.category !== cat || !_depSatisfied(def)) continue
      var title = _setSectionTitle(def)
      if (only && only.indexOf(def.section) === -1) continue
      var s = byTitle.get(title)
      if (!s) { s = { title: title, rows: [] }; byTitle.set(title, s); sections.push(s) }
      s.rows.push.apply(s.rows, _rowsForDef(def))
    }
    return sections.map(function(s) {
      var fold = _setCollapsed.has(_settingsSubtab + '|' + s.title)
      var modCount = s.rows.filter(function(r) { return r.mod }).length
      var counts = fold
        ? ' <span class="hs-mc-set-cnt">(' + s.rows.length + (modCount ? ' · <span class="hs-mc-set-modcnt">' + modCount + '*</span>' : '') + ')</span>'
        : (modCount ? ' <span class="hs-mc-set-modcnt">' + modCount + '*</span>' : '')
      return '<div class="hs-mc-settings-group">' +
        '<div class="hs-mc-settings-group-title" data-set-fold="' + escapeHtml(s.title) + '">' + (fold ? '▸ ' : '▾ ') + escapeHtml(s.title) + counts + '</div>' +
        (fold ? '' : s.rows.map(function(r) { return r.html }).join('')) +
      '</div>'
    }).join('')
  }

  // Search across ALL categories — matched rows grouped under clickable
  // "category · section" headers (click = jump to that pane + section).
  // Current-category groups list first.
  function _renderSearchResults() {
    var tokens = _setQueryTokens()
    var groups = []
    var byKey = new Map()
    var total = 0
    var count = 0
    for (const def of SETTINGS) {
      if (!_depSatisfied(def)) continue
      var rows = _rowsForDef(def)
      total += rows.length
      var matched = rows.filter(function(r) { return _rowMatches(r.hay, tokens) })
      if (!matched.length) continue
      count += matched.length
      var section = _setSectionTitle(def)
      var gk = def.category + '|' + section
      var g = byKey.get(gk)
      if (!g) { g = { cat: def.category, section: section, rows: [] }; byKey.set(gk, g); groups.push(g) }
      g.rows.push.apply(g.rows, matched)
    }
    groups.sort(function(a, b) {
      return (a.cat === _settingsSubtab ? 0 : 1) - (b.cat === _settingsSubtab ? 0 : 1)
    })
    var html = groups.map(function(g) {
      return '<div class="hs-mc-settings-group">' +
        '<div class="hs-mc-set-search-hdr" data-set-jump="' + escapeHtml(g.cat + '|' + g.section) + '">' + escapeHtml(g.cat + ' · ' + g.section) + '</div>' +
        g.rows.map(function(r) { return r.html }).join('') +
      '</div>'
    }).join('')
    // action rows (export/import/defaults) — searchable buttons
    var actions = _SET_ACTION_ROWS.filter(function(a) { return _rowMatches(a.hay, tokens) })
    total += _SET_ACTION_ROWS.length
    if (actions.length) {
      count += actions.length
      html += '<div class="hs-mc-settings-group">' +
        '<div class="hs-mc-set-search-hdr" data-set-jump="system|backup / restore">system · backup / restore</div>' +
        actions.map(function(a) { return a.html }).join('') +
      '</div>'
    }
    if (!count) html = '<div class="hs-mc-setting-row" style="color:#808080">no matches</div>'
    return { html: html, count: count, total: total }
  }

  // ── hand-rendered islands ────────────────────────────────────────────



  function _renderMutedGroup() {
    return '<div class="hs-mc-settings-group">' +
      '<div class="hs-mc-settings-group-title">' + t('mc_settings_muted_users') + '</div>' +
      (mutedUsers.size === 0
        ? '<div class="hs-mc-setting-row" style="color:#808080;font-size:13px">' + t('mc_settings_no_muted') + '</div>'
        : Array.from(mutedUsers).sort().map(function(u) {
          return '<div class="hs-mc-setting-row hs-mc-setting-row-split">' +
            '<span class="hs-mc-setting-label" style="font-size:13px">' + escapeHtml(u) + '</span>' +
            '<button class="hs-mc-unmute-btn" data-username="' + escapeHtml(u) + '" style="background:none;border:1px solid #808080;color:#808080;font-size:13px;cursor:pointer;padding:1px 6px;line-height:1.4" title="' + t('mc_settings_unmute') + '">✕</button>' +
          '</div>';
        }).join('')
      ) +
    '</div>';
  }

  function _renderCrashLogBlock() {
    var crash = !!getSetting('crashTelemetry');
    return '<div class="hs-mc-setting-row hs-mc-setting-row-block" id="hs-set-crashlog-row"' + (!crash ? ' style="display:none"' : '') + '>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;width:100%">' +
        '<span class="hs-mc-setting-label">recent errors</span>' +
        '<div style="display:flex;gap:4px">' +
          '<button id="hs-set-crash-copy" style="background:#000;color:#fff;border:1px solid #808080;padding:2px 8px;font-size:11px;cursor:pointer;font-family:inherit">copy</button>' +
          '<button id="hs-set-crash-clear" style="background:#000;color:#fff;border:1px solid #808080;padding:2px 8px;font-size:11px;cursor:pointer;font-family:inherit">clear</button>' +
        '</div>' +
      '</div>' +
      '<pre id="hs-set-crash-pre" class="hs-mc-set-crash-pre">(loading...)</pre>' +
    '</div>';
  }

  // Action rows — buttons, not settings, but people search for them.
  // Shared between the system pane (_renderBackupGroup) and search results.
  const _SET_ACTION_ROWS = [
    {
      hay: 'export settings backup download json save system',
      html: '<div class="hs-mc-setting-row hs-mc-setting-row-split">' +
        '<span class="hs-mc-setting-label" data-tip="dump ui_settings + all hs_* keys to a JSON file. portable across devices and browsers.">export settings</span>' +
        '<button class="hs-mc-settings-btn" data-action="export-settings" style="background:#000;color:#fff;border:1px solid #808080;padding:2px 10px;font-size:13px;cursor:pointer;font-family:inherit">download .json</button>' +
      '</div>',
    },
    {
      hay: 'import settings restore load json system',
      html: '<div class="hs-mc-setting-row hs-mc-setting-row-split">' +
        '<span class="hs-mc-setting-label" data-tip="restore from a previously-exported JSON file. merges into existing settings.">import settings</span>' +
        '<button class="hs-mc-settings-btn" data-action="import-settings" style="background:#000;color:#fff;border:1px solid #808080;padding:2px 10px;font-size:13px;cursor:pointer;font-family:inherit">load .json</button>' +
      '</div>',
    },
    {
      hay: 'default reset all settings factory system',
      html: '<div class="hs-mc-setting-row" style="justify-content:flex-end">' +
        '<button class="hs-mc-defaults-btn" style="background:#000;color:#fff;border:1px solid #808080;padding:2px 10px;font-size:13px;cursor:pointer;font-family:inherit">default</button>' +
      '</div>',
    },
  ]

  function _renderBackupGroup() {
    return '<div class="hs-mc-settings-group">' +
      '<div class="hs-mc-settings-group-title">backup / restore</div>' +
      _SET_ACTION_ROWS[0].html + _SET_ACTION_ROWS[1].html +
    '</div>' +
    '<div class="hs-mc-settings-group">' +
      _SET_ACTION_ROWS[2].html +
    '</div>';
  }

  // Compose one category pane: registry sections + that category's islands.
  function _renderCategoryPane(cat) {
    if (cat === 'mod') return _regSections(cat)
    if (cat === 'tweaks') {
      return '<div class="hs-mc-set-keyhint" style="padding-top:8px">twitch.tv only — kick/youtube unaffected</div>' + _regSections(cat)
    }
    if (cat === 'system') {
      // crash log block nests inside the advanced section, after its pill
      var adv = _regSections(cat, ['advanced'])
      var advFolded = _setCollapsed.has(cat + '|advanced')
      if (!advFolded && adv.endsWith('</div>')) {
        adv = adv.slice(0, -6) + _renderCrashLogBlock() + '</div>'
      }
      return _regSections(cat, ['tabs', 'subsystems', 'language']) + _renderMutedGroup() + adv + _renderBackupGroup()
    }
    return _regSections(cat)
  }

  // ─── settings export / import ────────────────────────────────────────────
  // Export: dumps ui_settings (sync) + all hs_* keys (local) into a single
  // JSON. Import: file picker → JSON parse → schema-validate → merge into
  // storage. Both areas restored. Errors toast, don't throw.
  async function _exportAllSettings() {
    try {
      var syncObj = await chrome.storage.sync.get(null);
      var localObj = await chrome.storage.local.get(null);
      var hsLocal = {};
      Object.keys(localObj).forEach(function(k) { if (k.indexOf('hs_') === 0 || k.indexOf('viewer_') === 0) hsLocal[k] = localObj[k]; });
      var bundle = {
        kind: 'heatsync-settings',
        version: 1,
        exportedAt: new Date().toISOString(),
        sync: { ui_settings: syncObj.ui_settings || {} },
        local: hsLocal,
      };
      var blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'heatsync-settings-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
      showToast('settings exported', 'info');
    } catch (err) {
      showToast('export failed: ' + (err && err.message ? err.message : 'unknown'), 'error');
    }
  }

  async function _importAllSettings() {
    return new Promise(function(resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.style.display = 'none';
      input.onchange = async function() {
        var file = input.files && input.files[0];
        input.remove();
        if (!file) { resolve(false); return; }
        if (file.size > 2 * 1024 * 1024) {
          showToast('file too large (>2MB)', 'error');
          resolve(false); return;
        }
        try {
          var txt = await file.text();
          var data = JSON.parse(txt);
          if (!data || data.kind !== 'heatsync-settings') {
            showToast('not a heatsync settings file', 'error');
            resolve(false); return;
          }
          var writes = [];
          if (data.sync && data.sync.ui_settings && typeof data.sync.ui_settings === 'object') {
            // Merge — preserve any keys absent from the import. sanitize via
            // existing util so corrupt fields don't leak in.
            var stored = await chrome.storage.sync.get(['ui_settings']);
            var merged = sanitizeUiSettings(Object.assign({}, stored.ui_settings || {}, data.sync.ui_settings));
            writes.push(chrome.storage.sync.set({ ui_settings: merged }));
          }
          if (data.local && typeof data.local === 'object') {
            var safeLocal = {};
            Object.keys(data.local).forEach(function(k) {
              if (k.length < 1 || k.length > 128) return;
              if (k.indexOf('hs_') !== 0 && k.indexOf('viewer_') !== 0) return;
              safeLocal[k] = data.local[k];
            });
            if (Object.keys(safeLocal).length) writes.push(chrome.storage.local.set(safeLocal));
          }
          await Promise.all(writes);
          showToast('settings imported — reloading…', 'info');
          setTimeout(function() { try { location.reload(); } catch (_) {} }, 800);
          resolve(true);
        } catch (err) {
          showToast('import failed: ' + (err && err.message ? err.message : 'parse error'), 'error');
          resolve(false);
        }
      };
      document.body.appendChild(input);
      input.click();
    });
  }

  // _loadServerFilters removed in v1.6 audit pass — fetched /api/user/settings
  // expecting a JSONB `settings` blob that the server never produced. The
  // 11 toggles it populated were unwired (server didn't read those keys),
  // so removing it has no functional change. See _SERVER_FILTER_DEFS deletion.

  // Load recent errors + diag snapshot into the system sub-tab pre element.
  // Reads hs_errors directly (single source of truth — written by lib/error-reporter).
  async function _loadCrashLog() {
    var pre = document.getElementById('hs-set-crash-pre');
    if (!pre) return;
    try {
      var cur = await new Promise(function(r) { chrome.storage.local.get('hs_errors', r); });
      var log = Array.isArray(cur && cur.hs_errors) ? cur.hs_errors : [];
      var diag = null;
      try { diag = (await chrome.runtime.sendMessage({ type: 'get_diag' }))?.diag || null; } catch (_) {}
      function fmtTs(ts) {
        var d = new Date(ts);
        return d.toISOString().replace('T', ' ').slice(0, 19);
      }
      var head = diag ? ('--- diag ---\n' + JSON.stringify(diag, null, 2) + '\n\n') : '';
      if (log.length === 0) { pre.textContent = head + '(no errors recorded)'; return; }
      pre.textContent = head + log.slice().reverse().map(function(entry) {
        return '[' + fmtTs(entry.ts) + '] ' + (entry.plat || entry.type || '?') + ': ' + (entry.msg || '') + '\n' + (entry.stack || '') + '\n';
      }).join('\n');
    } catch (err) {
      pre.textContent = '(unable to read log)';
    }
  }

  // ─── presets ("builds") — sparse diffs over defaults ─────────────────
  // Built-ins live in settings-schema.js (SETTINGS_PRESETS); customs are
  // diff-vs-defaults snapshots in ui_settings.customPresets (synced, and
  // sharable via the existing settings export/import). Applying always
  // goes through a diff-confirm panel; one-shot undo restores the prior
  // values of exactly the keys the preset touched.
  let _customPresets = []
  let _lastPresetUndo = null
  let _presetPending = null // {label, diff} or {savePrompt:true}

  function _presetIsActive(p) {
    return Object.keys(p.diff).every(function(k) {
      return JSON.stringify(getSetting(k)) === JSON.stringify(p.diff[k])
    })
  }
  function _presetChanges(diff) {
    const out = []
    for (const k in diff) {
      const def = _SETTINGS_BY_KEY.get(k)
      if (!def) continue
      const from = getSetting(k)
      if (JSON.stringify(from) !== JSON.stringify(diff[k])) out.push({ key: k, def: def, from: from, to: diff[k] })
    }
    return out
  }
  function _fmtPresetVal(def, v) {
    if (def.type === 'bool') return v ? 'on' : 'off'
    if (def.type === 'boolmap') {
      const offs = Object.keys(v).filter(function(k) { return v[k] === false })
      return offs.length ? 'off: ' + offs.join(', ') : 'all on'
    }
    if (def.type === 'multiselect') return v.length ? v.join(', ') : 'none'
    return String(v)
  }
  function _applyPresetDiff(label, diff) {
    const changes = _presetChanges(diff)
    _presetPending = null
    if (!changes.length) { showToast('already matching ' + label, 'info'); renderSettingsTab(); return }
    const undo = {}
    for (const c of changes) undo[c.key] = c.from
    _lastPresetUndo = { label: label, diff: undo }
    for (const c of changes) setSetting(c.key, c.to)
    showToast('applied ' + label + ' — ' + changes.length + ' change' + (changes.length === 1 ? '' : 's'), 'info')
    renderSettingsTab()
  }
  function _saveCustomPreset(name) {
    name = (name || '').trim().slice(0, 24)
    if (!name) { showToast('preset needs a name', 'error'); return }
    const diff = {}
    for (const def of SETTINGS) {
      if (def.noReset) continue
      const cur = getSetting(def.key)
      if (JSON.stringify(cur) !== JSON.stringify(def.default)) diff[def.key] = cur
    }
    const entry = { id: 'c_' + Date.now().toString(36), name: name, diff: diff, createdAt: Date.now() }
    const next = _customPresets.filter(function(p) { return p.name !== name }).concat(entry).slice(-8)
    if (JSON.stringify(next).length > 5000) { showToast('presets storage full — delete one first', 'error'); return }
    _customPresets = next
    saveUiSetting('customPresets', next)
    _presetPending = null
    showToast('saved preset: ' + name, 'info')
    renderSettingsTab()
  }
  function _deleteCustomPreset(id) {
    _customPresets = _customPresets.filter(function(p) { return p.id !== id })
    saveUiSetting('customPresets', _customPresets)
    showToast('preset deleted', 'info')
  }
  function _openPresetMenu(anchorEl) {
    const r = anchorEl.getBoundingClientRect()
    const items = []
    for (const p of SETTINGS_PRESETS) {
      items.push({
        label: (_presetIsActive(p) ? '■ ' : '□ ') + p.label,
        fn: (function(preset) { return function() { _presetPending = { label: preset.label, diff: preset.diff }; renderSettingsTab() } })(p),
      })
    }
    if (_customPresets.length) {
      items.push('sep')
      for (const p of _customPresets) {
        items.push({
          label: (_presetIsActive(p) ? '■ ' : '□ ') + p.name,
          fn: (function(preset) { return function() { _presetPending = { label: preset.name, diff: preset.diff }; renderSettingsTab() } })(p),
        })
      }
      items.push({
        label: 'delete a preset…',
        danger: true,
        fn: function() {
          const delItems = _customPresets.map(function(p) {
            return { label: '✕ ' + p.name, danger: true, fn: function() { _deleteCustomPreset(p.id) } }
          })
          showHsCtxMenu(r.left, r.bottom + 4, 'delete preset', delItems)
        },
      })
    }
    items.push('sep')
    items.push({ label: 'save current as…', fn: function() { _presetPending = { savePrompt: true }; renderSettingsTab() } })
    if (_lastPresetUndo) {
      items.push({
        label: 'undo: ' + _lastPresetUndo.label,
        fn: function() { const u = _lastPresetUndo; _lastPresetUndo = null; _applyPresetDiff('undo ' + u.label, u.diff) },
      })
    }
    showHsCtxMenu(r.left, r.bottom + 4, 'presets', items)
  }
  function _renderPresetPanel() {
    if (_presetPending.savePrompt) {
      return '<div class="hs-mc-settings-group">' +
        '<div class="hs-mc-settings-group-title">save current as preset</div>' +
        '<div class="hs-mc-setting-row hs-mc-setting-row-split">' +
          '<input class="hs-mc-set-text-input" id="hs-preset-name" type="text" placeholder="preset name" maxlength="24" style="flex:1">' +
          '<div style="display:flex;gap:4px">' +
            '<button class="hs-mc-settings-btn" data-preset-action="save-custom" style="background:#000;color:#fff;border:1px solid #808080;padding:2px 10px;font-size:13px;cursor:pointer;font-family:inherit">save</button>' +
            '<button class="hs-mc-settings-btn" data-preset-action="cancel" style="background:#000;color:#fff;border:1px solid #808080;padding:2px 10px;font-size:13px;cursor:pointer;font-family:inherit">cancel</button>' +
          '</div>' +
        '</div>' +
        '<div class="hs-mc-set-keyhint">snapshots every setting that differs from defaults — sharable via export settings</div>' +
      '</div>'
    }
    const changes = _presetChanges(_presetPending.diff)
    let rows = ''
    if (!changes.length) {
      rows = '<div class="hs-mc-setting-row" style="color:#808080">already matching — nothing to change</div>'
    }
    for (const c of changes) {
      rows += '<div class="hs-mc-setting-row hs-mc-setting-row-split">' +
        '<span class="hs-mc-setting-label">' + escapeHtml(_setLabel(c.def)) + '</span>' +
        '<span style="font-size:13px;flex-shrink:0"><span style="color:#808080">' + escapeHtml(_fmtPresetVal(c.def, c.from)) + '</span>' +
        ' → <span style="color:#ff8700">' + escapeHtml(_fmtPresetVal(c.def, c.to)) + '</span></span>' +
      '</div>'
    }
    return '<div class="hs-mc-settings-group">' +
      '<div class="hs-mc-settings-group-title">apply preset: ' + escapeHtml(_presetPending.label) + '</div>' +
      rows +
      '<div class="hs-mc-setting-row" style="justify-content:flex-end;gap:4px">' +
        (changes.length ? '<button class="hs-mc-settings-btn" data-preset-action="apply" style="background:#ff8700;color:#000;border:none;padding:2px 12px;font-size:13px;cursor:pointer;font-family:inherit">apply</button>' : '') +
        '<button class="hs-mc-settings-btn" data-preset-action="cancel" style="background:#000;color:#fff;border:1px solid #808080;padding:2px 10px;font-size:13px;cursor:pointer;font-family:inherit">cancel</button>' +
      '</div>' +
    '</div>'
  }

  // '?' keybinding overlay — square, two-column key grid; vim block only
  // when vi mode is on. Click anywhere on it (or Esc / ?) closes.
  function _renderHelpOverlay() {
    var always = [
      ['/', 'search'], ['1-7', 'category'],
      ['↑ ↓', 'move'], ['← →', 'adjust'],
      ['enter', 'toggle'], ['bksp', 'reset row'],
      ['esc', 'close / clear'], ['?', 'this help'],
    ]
    var vim = [
      ['j k', 'move'], ['h l', 'adjust'],
      ['gg G', 'first / last'], ['za', 'fold section'],
      ['d', 'reset row'], ['p', 'presets'],
      ['H L', 'prev / next category'],
    ]
    function grid(pairs) {
      return pairs.map(function(kv) {
        return '<span class="hs-mc-set-help-key">' + escapeHtml(kv[0]) + '</span><span>' + escapeHtml(kv[1]) + '</span>'
      }).join('')
    }
    return '<div class="hs-mc-set-help">' +
      '<div class="hs-mc-set-help-grid">' + grid(always) + '</div>' +
      (viModeEnabled ? '<div class="hs-mc-set-help-title">vi</div><div class="hs-mc-set-help-grid">' + grid(vim) + '</div>' : '') +
    '</div>'
  }

  // ─── settings keyboard nav — roving focus, vim-first ────────────────
  // One document-level listener (bound once). Bare-letter motions
  // (j/k/h/l/g/G/d/z) gate on viModeEnabled; arrows, Enter, /, Esc and
  // Backspace always work. Letters typed into the search box stay there.
  let _setKeysBound = false
  let _setPendingKey = ''
  function _setVisibleRows() {
    const msgsEl = document.getElementById('hs-mc-messages')
    return msgsEl ? [...msgsEl.querySelectorAll('[data-set-row]')] : []
  }
  function _setFocusMove(rows, i) {
    if (!rows.length) return
    const next = Math.max(0, Math.min(rows.length - 1, i))
    rows.forEach(function(r) { r.classList.remove('hs-mc-set-row-focus') })
    rows[next].classList.add('hs-mc-set-row-focus')
    _setFocusRow = rows[next].dataset.setRow
    rows[next].scrollIntoView({ block: 'nearest' })
  }
  function _setRowDef(row) {
    const key = (row.dataset.setRow || '').split(':')[0]
    return _SETTINGS_BY_KEY.get(key)
  }
  function _setRowActivate(row) {
    const pill = row.querySelector('button.hs-mc-toggle-pill[data-set-key]')
    if (pill) { pill.click(); return }
    const seg = row.querySelector('.hs-mc-size-btn[data-set-key]')
    if (seg) { _setRowAdjust(row, 1); return }
    const ctl = row.querySelector('select[data-set-key], input[data-set-key], textarea[data-set-key]')
    if (ctl) ctl.focus()
  }
  function _setRowAdjust(row, dir) {
    const def = _setRowDef(row)
    if (!def) return
    if (def.type === 'enum') {
      const i = def.options.findIndex(function(o) { return o.value === getSetting(def.key) })
      const o = def.options[(i + dir + def.options.length) % def.options.length]
      setSetting(def.key, o.value)
      renderSettingsTab()
    } else if (def.type === 'range') {
      const v = getSetting(def.key) + dir * def.options.step
      setSetting(def.key, v)
      renderSettingsTab()
    }
  }
  function _setRowReset(row) {
    const def = _setRowDef(row)
    if (!def || def.noReset) return
    // sub-rows (boolmap/multiselect options) reset exactly that option,
    // not the whole map
    const sub = (row.dataset.setRow || '').split(':')[1]
    if (def.type === 'boolmap' && sub !== undefined) {
      const opt = def.options.find(function(o) { return String(o.value) === sub })
      if (opt) {
        const map = Object.assign({}, getSetting(def.key))
        map[opt.value] = opt.default
        setSetting(def.key, map)
      }
    } else if (def.type === 'multiselect' && sub !== undefined) {
      const cur = getSetting(def.key)
      const inDefault = def.default.includes(sub)
      setSetting(def.key, inDefault
        ? (cur.includes(sub) ? cur : cur.concat(sub))
        : cur.filter(function(x) { return x !== sub }))
    } else {
      setSetting(def.key, def.default)
    }
    renderSettingsTab()
  }
  function _bindSettingsKeyboard() {
    if (_setKeysBound) return
    _setKeysBound = true
    document.addEventListener('keydown', function(e) {
      if (currentTab !== 'settings') return
      const msgsEl = document.getElementById('hs-mc-messages')
      if (!msgsEl || !msgsEl.querySelector('.hs-mc-settings-panel')) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const searchEl = msgsEl.querySelector('input.hs-mc-set-search')
      const t = e.target
      const inSearch = t === searchEl
      const typing = t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))
      const rows = _setVisibleRows()
      const idx = rows.findIndex(function(r) { return r.dataset.setRow === _setFocusRow })

      if (inSearch) {
        if (e.key === 'Escape') {
          e.preventDefault()
          _setQuery = ''
          renderSettingsTab()
        } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
          e.preventDefault()
          searchEl.blur()
          _setFocusMove(rows, 0)
        }
        return // everything else is query text
      }
      if (typing) return // free typing in textareas / inputs / selects

      const vim = viModeEnabled
      const k = e.key
      if (k === '/') { e.preventDefault(); if (searchEl) searchEl.focus(); return }
      if (k === '?') { e.preventDefault(); _setHelpOpen = !_setHelpOpen; renderSettingsTab(); return }
      if (k === 'Escape') {
        if (_setHelpOpen) { _setHelpOpen = false; renderSettingsTab(); return }
        if (_setQuery) { _setQuery = ''; renderSettingsTab(); return }
        rows.forEach(function(r) { r.classList.remove('hs-mc-set-row-focus') })
        _setFocusRow = null
        return
      }
      // 1-7 jump straight to a category
      if (k.length === 1 && k >= '1' && k <= '7') {
        e.preventDefault()
        _settingsSubtab = _SET_SUBTAB_ORDER[+k - 1]
        _setFocusRow = null
        renderSettingsTab()
        return
      }
      if (k === 'ArrowLeft' && idx >= 0) { e.preventDefault(); _setRowAdjust(rows[idx], -1); return }
      if (k === 'ArrowRight' && idx >= 0) { e.preventDefault(); _setRowAdjust(rows[idx], 1); return }
      if (k === 'ArrowDown' || (vim && k === 'j')) { e.preventDefault(); _setFocusMove(rows, idx + 1); _setPendingKey = ''; return }
      if (k === 'ArrowUp' || (vim && k === 'k')) { e.preventDefault(); _setFocusMove(rows, idx - 1); _setPendingKey = ''; return }
      if ((k === 'Enter' || k === ' ') && idx >= 0) { e.preventDefault(); _setRowActivate(rows[idx]); return }
      if (k === 'Backspace' && idx >= 0) { e.preventDefault(); _setRowReset(rows[idx]); return }
      if (!vim) return
      if (k === 'g') {
        if (_setPendingKey === 'g') { _setPendingKey = ''; e.preventDefault(); _setFocusMove(rows, 0) }
        else _setPendingKey = 'g'
        return
      }
      if (k === 'G') { e.preventDefault(); _setPendingKey = ''; _setFocusMove(rows, rows.length - 1); return }
      if (k === 'h' && idx >= 0) { e.preventDefault(); _setRowAdjust(rows[idx], -1); return }
      if (k === 'l' && idx >= 0) { e.preventDefault(); _setRowAdjust(rows[idx], 1); return }
      if (k === 'H' || k === 'L') {
        e.preventDefault()
        const cur = _SET_SUBTAB_ORDER.indexOf(_settingsSubtab)
        const len = _SET_SUBTAB_ORDER.length
        _settingsSubtab = _SET_SUBTAB_ORDER[(cur + (k === 'L' ? 1 : len - 1)) % len]
        _setFocusRow = null
        renderSettingsTab()
        return
      }
      if (k === 'd' && idx >= 0) { e.preventDefault(); _setRowReset(rows[idx]); return }
      if (k === 'p') {
        const btn = msgsEl.querySelector('.hs-mc-set-presets-btn')
        if (btn) { e.preventDefault(); _openPresetMenu(btn) }
        return
      }
      if (k === 'z') { _setPendingKey = 'z'; return }
      if (k === 'a' && _setPendingKey === 'z') {
        _setPendingKey = ''
        if (idx >= 0) {
          const fold = rows[idx].closest('.hs-mc-settings-group')
          const title = fold && fold.querySelector('[data-set-fold]')
          if (title) { e.preventDefault(); title.click() }
        }
        return
      }
      _setPendingKey = ''
    }, { signal: mcSignal })
  }

  function renderSettingsTab() {
    var msgsEl = document.getElementById('hs-mc-messages');
    if (!msgsEl) return;

    _clearMessageIndices();

    // Scroll preservation — #hs-mc-messages is the actual scroll parent
    // (the panel grows inside it); keep its scroll across re-renders of
    // the same logical pane (toggle/applier-triggered rebuilds)
    var hadPanel = !!msgsEl.querySelector('.hs-mc-settings-panel')
    var paneCtx = _settingsSubtab + '|' + _setQuery + '|' + !!_presetPending
    var keepScroll = (hadPanel && paneCtx === _setPaneCtx) ? msgsEl.scrollTop : 0

    var searchActive = _setQueryTokens().length > 0
    var bodyContent
    var countLabel = ''
    if (_presetPending) {
      bodyContent = _renderPresetPanel()
    } else if (searchActive) {
      var res = _renderSearchResults()
      bodyContent = res.html
      countLabel = res.count + '/' + res.total
    } else {
      bodyContent = _renderCategoryPane(_settingsSubtab)
    }

    // All values in the template are from module state or escapeHtml'd -- no raw user input
    msgsEl.innerHTML =
      '<div class="hs-mc-settings-panel">' +
        _renderSetSubtabBar() +
        '<div class="hs-mc-set-searchbar">' +
          '<input class="hs-mc-set-search" type="search" placeholder="/ search settings..." value="' + escapeHtml(_setQuery) + '">' +
          '<span class="hs-mc-set-search-count">' + countLabel + '</span>' +
          '<button class="hs-mc-set-presets-btn">presets</button>' +
          '<button class="hs-mc-set-help-btn" title="keybindings">?</button>' +
        '</div>' +
        '<div class="hs-mc-set-subtab-body">' +
          bodyContent +
        '</div>' +
        (_setHelpOpen ? _renderHelpOverlay() : '') +
      '</div>';

    // Controls render with live values inline (getSetting); only the crash
    // log pre needs an async fill, and keyboard focus needs restoring.
    if (_settingsSubtab === 'system' && !searchActive && getSetting('crashTelemetry')) _loadCrashLog();
    if (_setFocusRow) {
      var fr = msgsEl.querySelector('[data-set-row="' + CSS.escape(_setFocusRow) + '"]');
      if (fr) fr.classList.add('hs-mc-set-row-focus');
      else _setFocusRow = null;
    }
    _setPaneCtx = paneCtx;
    if (keepScroll) msgsEl.scrollTop = keepScroll;

    // Wire up toggles via event delegation
    if (msgsEl._hsSettingsClick) msgsEl.removeEventListener('click', msgsEl._hsSettingsClick);
    msgsEl._hsSettingsClick = function settingsClick(e) {
      // Sub-tab navigation
      var subtabBtn = e.target.closest('.hs-mc-set-subtab[data-set-subtab]');
      if (subtabBtn) {
        var next = subtabBtn.dataset.setSubtab;
        if (next && next !== _settingsSubtab) {
          _settingsSubtab = next;
          renderSettingsTab();
        }
        return;
      }

      // Settings export / import buttons
      var settingsActionBtn = e.target.closest('.hs-mc-settings-btn[data-action]');
      if (settingsActionBtn) {
        var action = settingsActionBtn.dataset.action;
        if (action === 'export-settings') { _exportAllSettings(); }
        else if (action === 'import-settings') { _importAllSettings(); }
        return;
      }

      // '?' help — button toggles, clicking the overlay closes
      if (e.target.closest('.hs-mc-set-help-btn')) {
        _setHelpOpen = !_setHelpOpen;
        renderSettingsTab();
        return;
      }
      if (e.target.closest('.hs-mc-set-help')) {
        _setHelpOpen = false;
        renderSettingsTab();
        return;
      }

      // [reload] chip — value differs from the boot snapshot; apply it now
      if (e.target.closest('[data-set-reload]')) {
        location.reload();
        return;
      }

      // search result header — jump to that category + section
      var jumpHdr = e.target.closest('[data-set-jump]');
      if (jumpHdr) {
        var jump = jumpHdr.dataset.setJump.split('|');
        _settingsSubtab = jump[0];
        _setQuery = '';
        _setFocusRow = null;
        renderSettingsTab();
        var tgt = [...msgsEl.querySelectorAll('[data-set-fold]')].find(function(el2) { return el2.dataset.setFold === jump[1] });
        if (tgt) tgt.scrollIntoView({ block: 'start' });
        return;
      }

      // Presets dropdown + diff-confirm actions
      var presetsBtn = e.target.closest('.hs-mc-set-presets-btn');
      if (presetsBtn) {
        _openPresetMenu(presetsBtn);
        return;
      }
      var presetAction = e.target.closest('[data-preset-action]');
      if (presetAction) {
        var pAct = presetAction.dataset.presetAction;
        if (pAct === 'apply' && _presetPending) _applyPresetDiff(_presetPending.label, _presetPending.diff);
        else if (pAct === 'save-custom') _saveCustomPreset(msgsEl.querySelector('#hs-preset-name')?.value);
        else if (pAct === 'cancel') { _presetPending = null; renderSettingsTab(); }
        return;
      }

      // Section fold/unfold
      var foldTitle = e.target.closest('.hs-mc-settings-group-title[data-set-fold]');
      if (foldTitle) {
        var foldId = _settingsSubtab + '|' + foldTitle.dataset.setFold;
        if (_setCollapsed.has(foldId)) _setCollapsed.delete(foldId);
        else _setCollapsed.add(foldId);
        _saveCollapsedSections();
        renderSettingsTab();
        return;
      }

      // Registry controls — data-set-key (registry-rendered) covers every
      // pill, size button, and multiselect chip; selects/inputs/textareas
      // are handled by the change/input listeners below.
      var regCtl = e.target.closest('[data-set-key]');
      if (regCtl && !/^(SELECT|INPUT|TEXTAREA)$/.test(regCtl.tagName)) {
        handleRegistryControl(regCtl);
        return;
      }

      var unmuteBtn = e.target.closest('.hs-mc-unmute-btn[data-username]');
      if (unmuteBtn) {
        var username = unmuteBtn.dataset.username;
        if (username) {
          mutedUsers.delete(username);
          safeSendMessage({ type: 'unmute_user', username: username });
          restoreMcUnmutedDom(username);
          renderMessages(currentTab);
          renderSettingsTab();
        }
        return;
      }

      // Crash log buttons
      if (e.target.id === 'hs-set-crash-copy') {
        var pre = document.getElementById('hs-set-crash-pre');
        if (pre && pre.textContent) {
          navigator.clipboard.writeText(pre.textContent).catch(function() {});
          var copyBtn = e.target;
          copyBtn.textContent = 'copied';
          cleanup.setTimeout(function() { copyBtn.textContent = 'copy'; }, 1500);
        }
        return;
      }
      if (e.target.id === 'hs-set-crash-clear') {
        chrome.storage.local.remove('hs_errors', function() { void chrome.runtime.lastError; });
        _loadCrashLog();
        return;
      }

      var defaultsBtn = e.target.closest('.hs-mc-defaults-btn');
      if (defaultsBtn) {
        resetSettingsToDefaults();
        return;
      }
    };
    msgsEl.addEventListener('click', msgsEl._hsSettingsClick);

    // Input handler — search box, registry text/textarea (debounced) + range
    if (msgsEl._hsSettingsInput) msgsEl.removeEventListener('input', msgsEl._hsSettingsInput);
    var _setInputDebounce = {};
    var _setSearchDebounce = null;
    msgsEl._hsSettingsInput = function settingsInput(e) {
      var search = e.target.closest('input.hs-mc-set-search');
      if (search) {
        if (_setSearchDebounce) cleanup.clearTimeout(_setSearchDebounce);
        _setSearchDebounce = cleanup.setTimeout(function() {
          _setQuery = search.value;
          renderSettingsTab();
          // re-render replaced the input — restore focus + caret
          var fresh = msgsEl.querySelector('input.hs-mc-set-search');
          if (fresh) {
            fresh.focus();
            fresh.setSelectionRange(fresh.value.length, fresh.value.length);
          }
        }, 150);
        return;
      }
      var regInput = e.target.closest('[data-set-key]');
      if (regInput) {
        var def = _SETTINGS_BY_KEY.get(regInput.dataset.setKey);
        if (!def) return;
        if (def.type === 'range') {
          var scale = def.displayScale || 1;
          setSetting(def.key, parseFloat(regInput.value) / scale);
          var valEl = regInput.parentElement.querySelector('.hs-mc-set-range-val');
          if (valEl) valEl.textContent = regInput.value;
          _syncRowModEdge(regInput, def);
          return;
        }
        if (def.type === 'text') {
          if (_setInputDebounce[def.key]) cleanup.clearTimeout(_setInputDebounce[def.key]);
          _setInputDebounce[def.key] = cleanup.setTimeout(function() {
            setSetting(def.key, regInput.value);
            _syncRowModEdge(regInput, def);
          }, 400);
          return;
        }
      }
    };
    msgsEl.addEventListener('input', msgsEl._hsSettingsInput);

    // Change handler — registry selects
    if (msgsEl._hsSettingsChange) msgsEl.removeEventListener('change', msgsEl._hsSettingsChange);
    msgsEl._hsSettingsChange = function settingsChange(e) {
      var regSel = e.target.closest('select[data-set-key]');
      if (regSel) {
        var selKey = regSel.dataset.setKey;
        if (selKey === 'fontFamily') {
          // Bitmap fonts render crisp at their native size only — snap the
          // size to the font's design size. silent: the fontFamily write
          // below runs the (shared) fonts applier once with both values.
          var fam = regSel.value;
          var nativeSize = fam === 'GohuFont' ? 14 : (fam === 'CozetteVector' || fam === 'twitch') ? 13 : null;
          if (nativeSize) setSetting('fontSize', nativeSize, { silent: true });
          setSetting('fontFamily', fam); // fonts applier + settings re-render
          return;
        }
        setSetting(selKey, regSel.value);
        return;
      }
    };
    msgsEl.addEventListener('change', msgsEl._hsSettingsChange);

    _bindSettingsKeyboard();

    // Custom tooltip for settings labels (native title attribute blocked in content scripts)
    var tip = document.getElementById('hs-settings-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'hs-settings-tip';
      document.body.appendChild(cleanup.trackNode(tip));
    }
    if (!msgsEl._hsSettingsTipBound) {
      msgsEl._hsSettingsTipBound = true;
      msgsEl.addEventListener('mouseenter', function(e) {
        var label = e.target.closest('.hs-mc-setting-label[data-tip]');
        if (!label) return;
        var tipEl = document.getElementById('hs-settings-tip');
        if (!tipEl) return;
        tipEl.textContent = label.dataset.tip;
        var rect = label.getBoundingClientRect();
        tipEl.style.left = rect.left + 'px';
        tipEl.style.top = (rect.bottom + 4) + 'px';
        tipEl.classList.add('visible');
      }, { capture: true, signal: mcSignal });
      msgsEl.addEventListener('mouseleave', function(e) {
        var label = e.target.closest('.hs-mc-setting-label[data-tip]');
        if (label) { var tipEl = document.getElementById('hs-settings-tip'); if (tipEl) tipEl.classList.remove('visible'); }
      }, { capture: true, signal: mcSignal });
    }
  }


  function updateTabBar() {
    if (!tabBarElement) return;

    // Clear existing channel tabs (keep built-in tabs)
    const existingChannelTabs = tabBarElement.querySelectorAll('.hs-mc-tab[data-tab]:not([data-tab="live"]):not([data-tab="feed"]):not([data-tab="mentions"]):not([data-tab="whispers"]):not([data-tab="discover"]):not([data-tab="pinned"]):not([data-tab="add"]):not([data-tab="settings"]):not([data-tab="popout"]):not([data-tab="collapse"])');
    existingChannelTabs.forEach(t => t.remove());

    // Add channel tabs before the + button in the scroll section
    const scrollSection = tabBarElement.querySelector('.hs-mc-tabs-scroll') || tabBarElement;
    const addBtn = scrollSection.querySelector('[data-tab="add"]');
    config.channels.forEach(ch => {
      const tab = document.createElement('button');
      tab.className = ch?.ephemeral ? 'hs-mc-tab hs-mc-tab-auto' : 'hs-mc-tab';
      if (ch?.ephemeral) tab.title = 'open in another window — tab disappears when that window closes'
      const id = ch.id;
      tab.dataset.tab = id;
      // Show best human-readable name. Order:
      //   1. ch.twitch / ch.kick if present
      //   2. resolved channelName from youtubeLinks (set by youtube_status)
      //   3. @handle parsed from the youtube URL
      //   4. ch.id when it looks like a real handle (i.e. user-named, not a
      //      generated `linked_<ts>` / `yt-<ts>` id)
      //   5. URL fallback (last resort — would have shown "watch?v=…" before)
      let label = id
      if (ch.twitch) label = ch.twitch
      else if (ch.kick) label = ch.kick
      else if (ch.youtube) {
        const linked = youtubeLinks.get(ch.id)
        const m = ch.youtube.match(/@([^/?]+)/)
        const looksAuto = !ch.id || /^(linked|yt|kick|twitch)[-_]\d+$/.test(ch.id)
        if (linked?.channelName) label = linked.channelName
        else if (m) label = m[1]
        else if (!looksAuto) label = ch.id
        else label = ch.youtube.replace(/^https?:\/\/(www\.)?youtube\.com\//, '').replace(/\/.*$/, '')
      }
      tab.textContent = label;
      // Restore live dot from cached liveChannelSet (survives tab recreate).
      // Check BOTH twitch and kick slugs — a Kick-only channel or a paired
      // channel whose twitch handle differs from its kick slug would otherwise
      // miss the dot. SW followed snapshot already populates kick slugs into
      // liveChannelSet at line ~8908.
      if (liveChannelSet.size > 0) {
        const tw = ch.twitch?.toLowerCase()
        const ki = ch.kick?.toLowerCase()
        const idLower = ch.id?.toLowerCase()
        const isLive = (tw && liveChannelSet.has(tw))
          || (ki && liveChannelSet.has(ki))
          || (!tw && !ki && idLower && liveChannelSet.has(idLower))
        tab.dataset.live = String(isLive)
      }
      // YT-only tabs aren't in liveChannelSet (which is Twitch-only), so
      // re-derive live state from the resolved YouTube subscription. This
      // also wins the race when the youtube_status connected event arrived
      // before the tabbar was rendered.
      if (ch.youtube && !ch.twitch && !ch.kick) {
        const ytLink = youtubeLinks.get(ch.id)
        if (ytLink?.videoId) tab.dataset.live = 'true'
      }
      if (addBtn) addBtn.before(tab);
      else scrollSection.appendChild(tab);
    });

    // Update active state
    tabBarElement.querySelectorAll('.hs-mc-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === currentTab);
    });

    applyHiddenTabs();
  }


  // ============================================
  // RENDER PATCHING (FFZ-STYLE CORE)
  // ============================================

  /**
   * Patch a component's render method to inject our UI
   * This is the FFZ approach - modify render output, don't manipulate DOM
   */
  function patchChatRoomRender(component) {
    if (!component?.instance?.render) {
      log('Cannot patch - no render method');
      return false;
    }

    const inst = component.instance;
    if (inst._hs_multichat_patched) {
      log('Already patched');
      return true;
    }

    originalRender = inst.render.bind(inst);

    inst.render = function() {
      const result = originalRender();

      // If result is null or not an object, return as-is
      if (!result || typeof result !== 'object') return result;

      // Clone the result to avoid mutating React's internals
      // We'll inject our tab bar at the top level
      // Elements are in #hs-mc-container (outside React's tree)
      // so no need to re-inject on every render

      return result;
    };

    inst._hs_multichat_patched = true;
    log('✅ Patched chat room render');

    // Force initial re-render
    if (typeof inst.forceUpdate === 'function') {
      inst.forceUpdate();
    }

    return true;
  }

  /**
   * FFZ-style: Fix chat column transform bug
   * Twitch applies translateX(-34rem) even when --expanded class is set
   * We fix this persistently via multiple layers
   */

  // Layer 1: CSS override (always active, catches most cases)
  function injectTransformOverrideCss() {
    if (document.getElementById('hs-chat-transform-fix')) return;
    const style = document.createElement('style');
    style.id = 'hs-chat-transform-fix';
    style.textContent = `
      /* Fix inner column transform — must be 'none', not translateX(0),
         because any transform value creates a containing block that breaks
         position:fixed on descendant elements (tab bar goes off-screen).
         Kill the transition too — without it Twitch's 500ms transform
         transition keeps interpolating to translateX(-340px) on every
         class flip, leaving the panel partially off-screen. */
      .channel-root__right-column--expanded {
        transform: none !important;
        transition: none !important;
      }
      /* Fix collapse/expand arrow — Twitch applies translateX(-340px) to
         slide it with the chat panel animation, but our layout changes make
         the transform wrong. Kill both transform and its transition (the
         transition fights !important by interpolating from the old value). */
      .right-column__toggle-visibility {
        transform: none !important;
        transition: none !important;
      }
    `;
    document.head.appendChild(cleanup.trackNode(style));
    log('✅ Injected chat column CSS fixes');
  }

  // Fix inline transform that Twitch's CSS-in-JS sets on the inner column.
  // CSS rule handles the class-based override; this catches inline style overrides.
  function fixChatTransform() {
    const expanded = document.querySelector('.channel-root__right-column--expanded');
    if (!expanded) return false;

    const transform = expanded.style.transform || getComputedStyle(expanded).transform;
    if (transform && transform !== 'none') {
      expanded.style.setProperty('transform', 'none', 'important');
      return true;
    }
    return false;
  }

  // Layer 3: Watch for class/style changes on BOTH column elements
  let columnObserver = null;
  function startColumnClassWatcher() {
    if (columnObserver) return; // Already watching

    const inner = document.querySelector('.channel-root__right-column');
    const outer = document.querySelector('.right-column.right-column--beside');

    if (!inner && !outer) return;

    columnObserver = cleanup.trackObserver(new MutationObserver(() => {
      // When class/style changes, fix both elements
      cleanup.raf(() => {
        fixChatTransform();
        applyChatWidth()
        // Re-render after expand — container was display:none while collapsed
        const rightCol = document.querySelector('.right-column')
        if (rightCol && !rightCol.classList.contains('right-column--collapsed')) {
          ensureUIElements()
          renderMessages(currentTab)
        }
      }, 'column-transform-fix');
    }), 'column-class-watcher');

    const config = { attributes: true, attributeFilter: ['class', 'style'] };

    if (inner) columnObserver.observe(inner, config);
    if (outer) columnObserver.observe(outer, config);

    log('✅ Started column watchers (inner + outer)');
  }

  // Polling removed — CSS rule + MutationObserver handle all cases.
  // The 500ms polling was redundant and caused layout fighting.

  function ensureChatColumnVisible() {
    // CSS override + observer (no polling, no parent walking)
    injectTransformOverrideCss();
    startColumnClassWatcher();

    // One-time fix for current state
    fixChatTransform();

    // Return the chat column for injection purposes
    return document.querySelector('[data-a-target="right-column-chat-bar"]') ||
           document.querySelector('.channel-root__right-column');
  }

  /**
   * Alternative approach: Use MutationObserver + strategic element injection
   * This is more reliable than render patching for layout elements
   */
  /**
   * Get or create the HeatSync container OUTSIDE React's DOM tree.
   * Placed as a sibling of chatRoom so React can't destroy our elements.
   */
  function getOrCreateHsContainer(chatRoom) {
    let container = document.getElementById('hs-mc-container')
    if (container && document.contains(container)) return container
    container = document.createElement('div')
    container.id = 'hs-mc-container'
    // On Kick: insert as SIBLING of #channel-chatroom (not child!) to avoid
    // breaking Kick's React virtual scroll. React's reconciliation errors
    // corrupt native chat when our container is inside its managed tree.
    // On Twitch: insert into chat-shell (which has proper dimensions)
    // On YouTube: insert after the live chat frame in #chat-container or #secondary
    let parent
    if (hostPlatform === 'yt') {
      // Hide native YouTube chat iframe wherever it is in the tree. YT loads
      // the frame LATE on slow streams — if it isn't there yet, watch for it,
      // or the user sees the native "Live chat / open panel" card fighting
      // the overlay. data-hs-hidden marks frames we hid so teardown only
      // restores our own work.
      const hideYtFrame = () => {
        const f = document.querySelector('ytd-live-chat-frame#chat')
        if (!f) return false
        if (f.style.display !== 'none') {
          const frameHeight = f.offsetHeight || 500
          f.dataset.hsPrevDisplay = f.style.display ?? ''
          f.dataset.hsHidden = '1'
          f.style.display = 'none'
          window._hsYtChatFrameHeight = frameHeight
          container.style.cssText = `height:${frameHeight}px;overflow:hidden;`
        }
        return true
      }
      if (!hideYtFrame()) {
        const frameWatch = new MutationObserver(() => { if (hideYtFrame()) frameWatch.disconnect() })
        frameWatch.observe(document.documentElement, { childList: true, subtree: true })
        mcSignal.addEventListener('abort', () => frameWatch.disconnect(), { once: true })
      }
      // Append to <body> instead of nesting inside #chat-container. On
      // narrow / single-column viewports YT collapses the right sidebar and
      // moves #chat-container into #below, which YT (and our own CSS at
      // body.hs-platform-yt #below) sets to display:none — taking our
      // position:fixed panel down with it. Body is the only stable parent.
      parent = document.body
      parent.appendChild(container)
      // Teardown: restore native iframe display and remove our body-appended
      // container so disabling/reloading the extension doesn't leave the YT
      // chat permanently hidden. mcSignal aborts on pagehide and on full
      // lifecycle teardown.
      mcSignal.addEventListener('abort', () => {
        const f = document.querySelector('ytd-live-chat-frame#chat[data-hs-hidden]')
        if (f) {
          f.style.display = f.dataset.hsPrevDisplay || ''
          delete f.dataset.hsHidden
          delete f.dataset.hsPrevDisplay
        }
        if (container && container.parentElement === document.body) {
          container.remove()
        }
      }, { once: true })
    } else if (isKick) {
      if (chatRoom) {
        parent = chatRoom.parentElement
        chatRoom.after(container)
      } else {
        // No #channel-chatroom on this Kick URL (browse, settings, search,
        // categories, …) — body-mount as a position:fixed overlay via the
        // hs-kick-no-channel CSS rules. Same teardown contract as Twitch.
        parent = document.body
        parent.appendChild(container)
        mcSignal.addEventListener('abort', () => {
          if (container && container.parentElement === document.body) container.remove()
        }, { once: true })
      }
    } else {
      // Twitch: prefer chat-shell on channel pages (preserves theatre/persistent
      // -player layout). Fall back to <body> on non-channel pages (directory,
      // settings, videos, …) where chat-shell doesn't exist — panel becomes a
      // position:fixed overlay via the hs-twitch-no-channel CSS rules.
      const chatShell = document.querySelector('.chat-shell') || document.querySelector(CONFIG.SELECTORS.TWITCH_CHAT_SHELL)
      if (chatShell) {
        parent = chatShell
        parent.appendChild(container)
      } else {
        parent = document.body
        parent.appendChild(container)
        mcSignal.addEventListener('abort', () => {
          if (container && container.parentElement === document.body) container.remove()
        }, { once: true })
      }
    }
    log('Created #hs-mc-container in', parent.tagName + '.' + [...parent.classList].join('.'))
    // Reposition the unified resize handle now that the container has a real
    // rect. On no-chat pages (Twitch /directory etc) applyChatPosition fired
    // before this point with cont=null, so the handle was stranded at 0,0.
    requestAnimationFrame(() => { try { positionChatResizeHandle() } catch (_) {} })
    return container
  }

  // Twitch resub-share / sub-anniversary callout: hide the native Pin toggle
  // (it pins to the hidden native chat → looks broken), inject our own X
  // button that just hides the callout. Idempotent + survives re-mounts via
  // dataset guard. Also hooks the Share button so we can guarantee a local
  // celebration line even if Twitch suppresses the self-echo USERNOTICE.
  //
  // Share-dedupe contract (bulletproof against duplicates):
  //   Phase 1 [0–2000ms after click]: wait for Twitch's real USERNOTICE.
  //     - If it arrives matching channel+user+msg-id → cancel synthetic.
  //   Phase 2 [+0–30s after synthetic injection]: keep watching.
  //     - If real arrives late → hide synthetic from buffer + remove its
  //       DOM row → real takes its place. Single celebration always.
  let _hsCalloutCloseObs = null
  let _pendingShareClaim = null
  let _resubShareModeTimer = null
  let _resubShareCtx = null
  let _watchstreakShareModeTimer = null
  let _watchstreakShareCtx = null
  let _lastSurfacedShareBtn = null

  // Once-per-day rate-limit on the watch-streak share UI. Twitch sometimes
  // re-shows the callout if you reload the tab mid-stream; cap our surfacing
  // at one per channel per local-day so it never feels spammy.
  function _watchstreakDayKey(channel) {
    const d = new Date()
    const ymd = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    return `hs-watchstreak-shared:${channel}:${ymd}`
  }
  function _watchstreakAlreadySharedToday(channel) {
    try { return !!localStorage.getItem(_watchstreakDayKey(channel)) } catch (_) { return false }
  }
  function _markWatchstreakSharedToday(channel) {
    try { localStorage.setItem(_watchstreakDayKey(channel), '1') } catch (_) {}
  }
  function _injectShareSynthetic(claim, user, months, customText) {
    const synthId = `hs-synth-share-${claim.channel}-${months}-${Date.now()}`
    claim.synthId = synthId
    claim.customText = customText || ''
    const synth = {
      type: 'usernotice', msgId: 'resub', user, text: customText || '',
      systemMsg: `${user} is celebrating ${months} months as a subscriber!`,
      color: '#ff8700', badges: ownBadgesFor(claim.channel) || '', channel: claim.channel,
      time: Date.now(), subTier: '1', subMonths: months, giftCount: 0,
      recipient: '', raidViewers: 0, raidFrom: '', announceColor: '',
      bitsTier: 0, id: synthId, isSynthetic: true, userOverride: !!customText
    }
    try { irc?._handleMsg?.(synth) } catch (_) {}
    claim.postTimer = cleanup.setTimeout(() => {
      if (_pendingShareClaim === claim) _pendingShareClaim = null
    }, 30000)
  }
  function _enterResubShareMode(claim, user, months) {
    // Mutually exclusive with watchstreak-share — exit that first if active,
    // silently (keep its banner up so user can come back to it).
    if (_watchstreakShareCtx) _exitWatchstreakShareMode(_watchstreakShareCtx.claim, false, true)
    _resubShareCtx = { claim, user, months }
    const input = document.getElementById('hs-mc-input')
    const inputBar = document.getElementById('hs-mc-inputbar')
    if (!input) return
    inputBar?.classList.add('hs-mc-resub-share')
    input.classList.add('hs-mc-resub-share')
    if (input.dataset.hsOrigPlaceholder === undefined) {
      input.dataset.hsOrigPlaceholder = input.getAttribute('placeholder') || ''
    }
    if (input.dataset.hsOrigDataPlaceholder === undefined) {
      input.dataset.hsOrigDataPlaceholder = input.getAttribute('data-placeholder') || ''
    }
    const placeholder = `resub message (${months}mo) — enter to share`
    input.setAttribute('placeholder', placeholder)
    input.setAttribute('data-placeholder', placeholder)
    try { input.focus() } catch (_) {}
    if (_resubShareModeTimer) cleanup.clearTimeout(_resubShareModeTimer)
    _resubShareModeTimer = cleanup.setTimeout(() => _exitResubShareMode(claim, true), 30000)
  }
  function _exitResubShareMode(claim, fireFallback, silent) {
    if (claim && _resubShareCtx?.claim !== claim) return
    const wasCtx = _resubShareCtx
    _resubShareCtx = null
    if (_resubShareModeTimer) { cleanup.clearTimeout(_resubShareModeTimer); _resubShareModeTimer = null }
    // Dismiss the HsNotifs banner only on VOLUNTARY exit (consume, timeout,
    // dismiss-click). On a forced exit (another share-mode took the input),
    // silent=true keeps the banner visible so the user can come back to it.
    if (wasCtx && !silent) {
      try {
        window.HsNotifs?.dismissByKey?.('twitch-resub-share', `resub:${wasCtx.claim.channel}:${wasCtx.months}`)
      } catch (_) {}
    }
    const input = document.getElementById('hs-mc-input')
    const inputBar = document.getElementById('hs-mc-inputbar')
    inputBar?.classList.remove('hs-mc-resub-share')
    input?.classList.remove('hs-mc-resub-share')
    if (input?.dataset.hsOrigPlaceholder !== undefined) {
      input.setAttribute('placeholder', input.dataset.hsOrigPlaceholder)
      delete input.dataset.hsOrigPlaceholder
    }
    if (input?.dataset.hsOrigDataPlaceholder !== undefined) {
      if (input.dataset.hsOrigDataPlaceholder) {
        input.setAttribute('data-placeholder', input.dataset.hsOrigDataPlaceholder)
      } else {
        input.removeAttribute('data-placeholder')
      }
      delete input.dataset.hsOrigDataPlaceholder
    }
    // 30s timeout with no user text → fall back to the empty-body synthetic so
    // the celebration banner still shows locally.
    if (fireFallback && wasCtx && !wasCtx.claim.synthId) {
      _injectShareSynthetic(wasCtx.claim, wasCtx.user, wasCtx.months, '')
    }
  }
  // Celebration failed AFTER the text was consumed — never let the user's
  // message vanish: surface the failure and send the text as plain chat.
  async function _resubShareTextRescue(channel, text) {
    showToast('celebration share failed — sending your message to chat', 'error')
    if (!text) return
    try {
      const token = getTwitchAuthToken()
      if (token) {
        const res = await sendIrcMessage(channel, text, token)
        if (res === true || res === 'queued') return
      }
    } catch (_) {}
    showToast('message could not be sent — it is still shown in your celebration row', 'error')
  }

  // Programmatic-click escape hatch so consume() can fire the native Twitch
  // Share button without our own surface() hook re-entering share-mode.
  let _allowNativeShare = false
  // Exposed for input.js sendMessage: consume typed text as resub-share body.
  // .enter() is called directly by the HsNotifs Share button — bypasses the
  // native Twitch click which would insta-send a default celebration message.
  window.__hsResubShare = {
    active: () => !!_resubShareCtx,
    // Returns false so input.js sendMessage CONTINUES into the regular IRC
    // send path — the typed text needs to actually go to Twitch chat so other
    // viewers see it and it persists across refresh. We also inject a local
    // synthetic usernotice for instant visual feedback, AND fire the native
    // Twitch share button for the global celebration broadcast.
    consume: (text) => {
      if (!_resubShareCtx) return false
      const { claim, user, months } = _resubShareCtx
      // 1. Local synthetic — instant styled celebration in OUR view with the
      //    user's custom text. Doesn't go anywhere else; viewer-only.
      try { _injectShareSynthetic(claim, user, months, text || '') } catch (_) {}
      // 2. GQL broadcast — call Chat_ShareResub_UseResubToken directly with the
      //    typed body. Sidesteps Twitch's hidden composer UI entirely; reaches
      //    the same backend mutation their native "Send" button fires after the
      //    composer opens. The token is the resub claim Twitch hands us in the
      //    callout's React props (or reconstructed from <userId>:<channelId>:
      //    <months>:cumulative when the prop wasn't found).
      const nativeClickFallback = () => {
        // No token — last-resort: programmatic-click the hidden native button.
        // Fires Twitch's default empty-body celebration; the typed text still
        // goes out as a plain follow-up message via the IRC send path below.
        const QUEUE_SEL = '[data-test-selector="chat-private-callout-queue__callout-container"]'
        const liveBtn = document.querySelector(QUEUE_SEL + ' [data-a-target="chat-private-callout__primary-button"]')
        const btn = liveBtn || claim._nativeShareBtn
        if (!btn || typeof getFiber !== 'function') return false
        try {
          let f = getFiber(btn)
          for (let i = 0; f && i < 10; i++, f = f.return) {
            const oc = f?.memoizedProps?.onClick
            if (typeof oc === 'function') {
              oc({ preventDefault(){}, stopPropagation(){}, persist(){}, currentTarget: btn, target: btn, nativeEvent: { isTrusted: true }, type: 'click', button: 0, buttons: 0 })
              return true
            }
          }
        } catch (_) {}
        return false
      }
      // No token → the native click can only post Twitch's DEFAULT
      // celebration (no body). Return false so sendMessage continues and
      // the typed text still lands as a normal chat message — celebration
      // + message, nothing swallowed. (This was the documented contract;
      // an unconditional `return true` here used to eat the text.)
      if (!claim.resubToken) {
        console.warn('[heatsync-ext] resub-share: no token — native btn fallback')
        _exitResubShareMode(claim, false)
        let clicked = false
        try { clicked = nativeClickFallback() } catch (_) {}
        showToast(clicked
          ? 'no share token — celebration sent without text, your message goes to chat'
          : 'share unavailable — sending your message to chat', 'error')
        return false
      }

      // Token path: optimistic synthetic + instant exit, GQL in the
      // background. Any failure rescues the typed text into plain chat —
      // the user's words must never silently vanish.
      try { _injectShareSynthetic(claim, user, months, text || '') } catch (_) {}
      _exitResubShareMode(claim, false)
      ;(async () => {
        try {
          const data = await gqlProxy('Chat_ShareResub_UseResubToken', {
            input: {
              message: text || '',
              channelLogin: claim.channel,
              includeStreak: false,
              tokenID: claim.resubToken,
            }
          })
          const errs = data?.errors || data?.data?.shareResub?.error
          if (!errs) { log('resub-share: GQL fired ok'); return }
          console.warn('[heatsync-ext] resub-share GQL error:', JSON.stringify(errs).slice(0, 200))
          await _resubShareTextRescue(claim.channel, text)
        } catch (e) {
          console.warn('[heatsync-ext] resub-share GQL threw:', e?.message || e)
          await _resubShareTextRescue(claim.channel, text)
        }
      })()
      // true = sendMessage stops here; the typed text is the celebration
      // body (or gets rescued above on failure).
      return true
    },
    enter: (months, user, channel, resubToken) => {
      try {
        if (_pendingShareClaim) {
          cleanup.clearTimeout(_pendingShareClaim.postTimer)
        }
        const claim = { channel, userLc: (user || '').toLowerCase(), months, synthId: null, postTimer: null, customText: '', _nativeShareBtn: _lastSurfacedShareBtn, resubToken: resubToken || null }
        _pendingShareClaim = claim
        _enterResubShareMode(claim, user, months)
      } catch (_) {}
    },
    // Internal: surface()'s native-button hook reads this to know whether to
    // block the click (user-initiated) or pass through (programmatic from us).
    _allowNativeShare: () => _allowNativeShare,
  }

  // ── Watch-streak share: mirror of resub-share for Twitch's daily ───────
  // "you're on an N stream watch streak!" callout. Same dedupe contract,
  // same native-button forwarding, separate placeholder/mode CSS so the
  // user can tell which celebration they're composing. Once-per-day per
  // channel via localStorage.
  function _injectWatchstreakSynthetic(claim, user, streakCount, customText) {
    const synthId = `hs-synth-wstreak-${claim.channel}-${streakCount}-${Date.now()}`
    claim.synthId = synthId
    claim.customText = customText || ''
    const synth = {
      type: 'usernotice', msgId: 'watchstreak', user, text: customText || '',
      systemMsg: `${user} watched ${streakCount} streams in a row — watch streak`,
      color: '#ff8700', badges: ownBadgesFor(claim.channel) || '', channel: claim.channel,
      time: Date.now(), subTier: '', subMonths: 0, giftCount: 0,
      recipient: '', raidViewers: 0, raidFrom: '', announceColor: '',
      bitsTier: 0, streakCount, id: synthId, isSynthetic: true, userOverride: !!customText
    }
    try { irc?._handleMsg?.(synth) } catch (_) {}
    claim.postTimer = cleanup.setTimeout(() => {
      if (_pendingShareClaim === claim) _pendingShareClaim = null
    }, 30000)
  }
  function _enterWatchstreakShareMode(claim, user, streakCount) {
    // Mutually exclusive with resub-share — exit that first if active, silently
    // (keep its banner up so user can come back to it).
    if (_resubShareCtx) _exitResubShareMode(_resubShareCtx.claim, false, true)
    _watchstreakShareCtx = { claim, user, streakCount }
    const input = document.getElementById('hs-mc-input')
    const inputBar = document.getElementById('hs-mc-inputbar')
    if (!input) return
    inputBar?.classList.add('hs-mc-watchstreak-share')
    input.classList.add('hs-mc-watchstreak-share')
    if (input.dataset.hsOrigPlaceholder === undefined) {
      input.dataset.hsOrigPlaceholder = input.getAttribute('placeholder') || ''
    }
    if (input.dataset.hsOrigDataPlaceholder === undefined) {
      input.dataset.hsOrigDataPlaceholder = input.getAttribute('data-placeholder') || ''
    }
    const placeholder = `watch streak (${streakCount}) — enter to share`
    input.setAttribute('placeholder', placeholder)
    input.setAttribute('data-placeholder', placeholder)
    try { input.focus() } catch (_) {}
    if (_watchstreakShareModeTimer) cleanup.clearTimeout(_watchstreakShareModeTimer)
    _watchstreakShareModeTimer = cleanup.setTimeout(() => _exitWatchstreakShareMode(claim, true), 30000)
  }
  function _exitWatchstreakShareMode(claim, fireFallback, silent) {
    if (claim && _watchstreakShareCtx?.claim !== claim) return
    const wasCtx = _watchstreakShareCtx
    _watchstreakShareCtx = null
    if (_watchstreakShareModeTimer) { cleanup.clearTimeout(_watchstreakShareModeTimer); _watchstreakShareModeTimer = null }
    if (wasCtx && !silent) {
      try {
        window.HsNotifs?.dismissByKey?.('twitch-watchstreak-share', `watchstreak:${wasCtx.claim.channel}:${wasCtx.streakCount}`)
      } catch (_) {}
    }
    const input = document.getElementById('hs-mc-input')
    const inputBar = document.getElementById('hs-mc-inputbar')
    inputBar?.classList.remove('hs-mc-watchstreak-share')
    input?.classList.remove('hs-mc-watchstreak-share')
    if (input?.dataset.hsOrigPlaceholder !== undefined) {
      input.setAttribute('placeholder', input.dataset.hsOrigPlaceholder)
      delete input.dataset.hsOrigPlaceholder
    }
    if (input?.dataset.hsOrigDataPlaceholder !== undefined) {
      if (input.dataset.hsOrigDataPlaceholder) {
        input.setAttribute('data-placeholder', input.dataset.hsOrigDataPlaceholder)
      } else {
        input.removeAttribute('data-placeholder')
      }
      delete input.dataset.hsOrigDataPlaceholder
    }
    if (fireFallback && wasCtx && !wasCtx.claim.synthId) {
      _injectWatchstreakSynthetic(wasCtx.claim, wasCtx.user, wasCtx.streakCount, '')
    }
  }
  window.__hsWatchstreakShare = {
    active: () => !!_watchstreakShareCtx,
    consume: (text) => {
      if (!_watchstreakShareCtx) return false
      const { claim, user, streakCount } = _watchstreakShareCtx
      try { _injectWatchstreakSynthetic(claim, user, streakCount, text || '') } catch (_) {}
      const broadcastShare = () => {
        const QUEUE_SEL = '[data-test-selector="chat-private-callout-queue__callout-container"]'
        const liveBtn = document.querySelector(QUEUE_SEL + ' [data-a-target="chat-private-callout__primary-button"]')
        const candidates = [liveBtn, claim._nativeShareBtn].filter(Boolean)
        const seen = new Set()
        const tryFiberOnClick = (btn) => {
          try {
            if (typeof getFiber !== 'function') return false
            let f = getFiber(btn)
            for (let i = 0; f && i < 10; i++, f = f.return) {
              const oc = f?.memoizedProps?.onClick
              if (typeof oc === 'function') {
                const fakeEvt = {
                  preventDefault() {}, stopPropagation() {}, persist() {},
                  currentTarget: btn, target: btn, nativeEvent: { isTrusted: true },
                  type: 'click', button: 0, buttons: 0,
                }
                oc(fakeEvt)
                log('watchstreak-share: fired via fiber onClick')
                return true
              }
            }
          } catch (e) {
            console.warn('[heatsync-ext] watchstreak-share fiber onClick threw:', e)
          }
          return false
        }
        const tryDomClick = (btn) => {
          try {
            _allowNativeShare = true
            try {
              const opts = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 }
              btn.dispatchEvent(new MouseEvent('mousedown', opts))
              btn.dispatchEvent(new MouseEvent('mouseup', opts))
              btn.dispatchEvent(new MouseEvent('click', opts))
              btn.click()
            } finally { _allowNativeShare = false }
            log('watchstreak-share: fired via DOM click sequence')
            return true
          } catch (e) {
            console.warn('[heatsync-ext] watchstreak-share DOM click threw:', e)
            return false
          }
        }
        for (const btn of candidates) {
          if (!btn || seen.has(btn)) continue
          seen.add(btn)
          if (tryFiberOnClick(btn)) return true
        }
        for (const btn of candidates) {
          if (!btn) continue
          if (tryDomClick(btn)) return true
        }
        console.warn('[heatsync-ext] watchstreak-share: NO broadcast — native callout btn missing')
        return false
      }
      try { broadcastShare() } catch (e) { console.warn('[heatsync-ext] watchstreak-share broadcast outer threw:', e) }
      _markWatchstreakSharedToday(claim.channel)
      _exitWatchstreakShareMode(claim, false)
      return false
    },
    enter: (streakCount, user, channel) => {
      try {
        if (_pendingShareClaim) {
          cleanup.clearTimeout(_pendingShareClaim.postTimer)
        }
        const claim = { kind: 'watchstreak', channel, userLc: (user || '').toLowerCase(), streakCount, synthId: null, postTimer: null, customText: '', _nativeShareBtn: _lastSurfacedShareBtn }
        _pendingShareClaim = claim
        _enterWatchstreakShareMode(claim, user, streakCount)
      } catch (_) {}
    },
  }

  function setupHsCalloutCloseButton() {
    if (_hsCalloutCloseObs) return
    // Native callout is hidden by CSS (.hs-notif-twitch-resub-share rule).
    // We extract data from the native DOM, hook its Share button so the
    // existing _enterResubShareMode flow runs when user clicks our forwarded
    // Share, and emit our own HsNotifs notif to render the controlled UI.
    const surface = (calloutEl) => {
      if (!calloutEl || calloutEl.dataset.hsSurfaced === '1') return
      const txt = calloutEl.textContent || ''
      const ch = (getLiveChannel?.() || getCurrentChannel?.() || '').toLowerCase()
      const user = currentUsername || ''
      if (!ch || !user) return
      const shareBtn = calloutEl.querySelector('[data-a-target="chat-private-callout__primary-button"]')

      // Capture Twitch's resub token from React props on the callout subtree.
      // Token is what Chat_ShareResub_UseResubToken GQL expects as input.tokenID.
      // Format observed: base64("<userId>:<channelId>:<months>:cumulative").
      // We walk up from both the button and container — Twitch wraps the token
      // in different ancestor components across surfaces (chat, popout, embed).
      // Whichever prop name Twitch uses, we accept; also record channelId for
      // fallback reconstruction if no direct token prop is found.
      const fiberTokenScan = (rootEl) => {
        if (typeof getFiber !== 'function' || !rootEl) return null
        const out = { token: null, channelId: null }
        const queue = [getFiber(rootEl)]
        const seen = new WeakSet()
        let steps = 0
        const tokenKeys = ['tokenID', 'tokenId', 'resubToken', 'token', 'calloutID', 'calloutId', 'shareToken']
        const channelKeys = ['channelID', 'channelId']
        while (queue.length && steps < 60 && !(out.token && out.channelId)) {
          const f = queue.shift()
          if (!f || seen.has(f)) continue
          seen.add(f); steps++
          const p = f.memoizedProps
          if (p && typeof p === 'object') {
            if (!out.token) {
              for (const k of tokenKeys) {
                const v = p[k]
                if (typeof v === 'string' && v.length > 12) { out.token = v; break }
              }
            }
            if (!out.channelId) {
              for (const k of channelKeys) {
                const v = p[k]
                if (typeof v === 'string' && /^\d+$/.test(v)) { out.channelId = v; break }
              }
            }
          }
          if (f.return) queue.push(f.return)
          if (f.child) queue.push(f.child)
        }
        return out
      }
      const scan = fiberTokenScan(shareBtn || calloutEl) || {}
      let resubToken = scan.token || null
      // ChannelId for token reconstruction. Twitch's React tree often doesn't
      // expose channelID near the callout (private callouts mount above the
      // chat-root), so prefer the documentElement attribute that early-inject
      // stamps from the page channel resolver. Fiber scan is fallback.
      const channelIdForToken = document.documentElement?.dataset?.hsTwitchChannelId || scan.channelId || null
      const fallbackToken = (months) => {
        const selfId = document.documentElement?.dataset?.hsSelfTwitchId
        if (!selfId || !channelIdForToken || !months) return null
        try { return btoa(`${selfId}:${channelIdForToken}:${months}:cumulative`) } catch { return null }
      }

      // Watch-streak first (text mentions "watch streak"); resub fallback (only
      // "N month" — without "watch streak"). Order matters: a watch-streak
      // callout never mentions months, but a sub-anniversary may incidentally
      // contain "stream", so explicit watchstreak check wins.
      const isWatchstreak = /watch[\s-]*streak/i.test(txt)
      const streakMatch   = isWatchstreak ? txt.match(/(\d+)\s*stream/i) : null
      const streakCount   = streakMatch ? parseInt(streakMatch[1]) : 0
      const monthMatch    = !isWatchstreak ? txt.match(/(\d+)\s*month/i) : null
      const months        = monthMatch ? parseInt(monthMatch[1]) : 0

      if (isWatchstreak && streakCount) {
        if (_watchstreakAlreadySharedToday(ch)) {
          calloutEl.dataset.hsSurfaced = '1'
          return
        }
        calloutEl.dataset.hsSurfaced = '1'
        if (shareBtn && shareBtn.dataset.hsShareHooked !== '1') {
          shareBtn.dataset.hsShareHooked = '1'
          shareBtn.addEventListener('click', (e) => {
            if (_allowNativeShare) return
            e.stopImmediatePropagation()
            e.preventDefault()
            try {
              if (_pendingShareClaim) {
                cleanup.clearTimeout(_pendingShareClaim.postTimer)
              }
              const claim = { kind: 'watchstreak', channel: ch, userLc: user.toLowerCase(), streakCount, synthId: null, postTimer: null, customText: '', _nativeShareBtn: shareBtn }
              _pendingShareClaim = claim
              _enterWatchstreakShareMode(claim, user, streakCount)
            } catch (_) {}
          }, { capture: true })
        }
        _lastSurfacedShareBtn = shareBtn || null
        try {
          HsNotifs.emit('twitch-watchstreak-share', {
            streakCount, user, channel: ch,
            _nativeShareBtn: shareBtn,
            _nativeCallout: calloutEl,
          })
        } catch (_) {}
        try { _updateMcLayout?.() } catch (_) {}
        return
      }

      if (!months) return
      calloutEl.dataset.hsSurfaced = '1'
      if (!resubToken) resubToken = fallbackToken(months)
      if (shareBtn && shareBtn.dataset.hsShareHooked !== '1') {
        shareBtn.dataset.hsShareHooked = '1'
        shareBtn.addEventListener('click', (e) => {
          if (window.__hsResubShare?._allowNativeShare?.()) return
          e.stopImmediatePropagation()
          e.preventDefault()
          try {
            if (_pendingShareClaim) {
              cleanup.clearTimeout(_pendingShareClaim.postTimer)
            }
            const claim = { kind: 'resub', channel: ch, userLc: user.toLowerCase(), months, synthId: null, postTimer: null, customText: '', _nativeShareBtn: shareBtn, resubToken }
            _pendingShareClaim = claim
            _enterResubShareMode(claim, user, months)
          } catch (_) {}
        }, { capture: true })
      }
      _lastSurfacedShareBtn = shareBtn || null
      try {
        HsNotifs.emit('twitch-resub-share', {
          months, user, channel: ch,
          _nativeShareBtn: shareBtn,
          _nativeCallout: calloutEl,
          _resubToken: resubToken,
        })
      } catch (_) {}
      try { _updateMcLayout?.() } catch (_) {}
    }
    // Twitch removed `.pinned-callout` in a recent refactor — the callout body
    // now lives directly under the queue container. Surface every container;
    // surface() reads text + Share button via descendant selectors and self-
    // gates with dataset.hsSurfaced='1'. Multiple callouts (e.g. resub +
    // watch-streak) can fire as siblings inside the queue parent — we must
    // observe each on first touch and the parent of any we see so subsequent
    // siblings are caught.
    const QUEUE_SEL = '[data-test-selector="chat-private-callout-queue__callout-container"]'
    document.querySelectorAll(QUEUE_SEL).forEach(c => { if (c.querySelector('*')) surface(c) })
    let _narrowedTo = null
    const _narrowIfPossible = (calloutEl) => {
      const parent = calloutEl?.parentElement
      if (!parent || _narrowedTo === parent) return
      _narrowedTo = parent
      try { _hsCalloutCloseObs.disconnect() } catch (_) {}
      // Observe the queue PARENT (not the callout itself) — sibling callouts
      // added later land as direct children and fire childList mutations here.
      _hsCalloutCloseObs.observe(parent, { childList: true, subtree: true })
    }
    _hsCalloutCloseObs = new MutationObserver((muts) => {
      // Surface ALL currently-present callouts on any mutation — the
      // dataset.hsSurfaced guard makes this idempotent.
      for (const c of document.querySelectorAll(QUEUE_SEL)) {
        if (c.querySelector('*')) surface(c)
      }
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue
          if (node.matches?.(QUEUE_SEL)) {
            if (node.querySelector('*')) surface(node)
            _narrowIfPossible(node)
          } else if (node.querySelector) {
            node.querySelectorAll(QUEUE_SEL).forEach(c => {
              if (c.querySelector('*')) surface(c)
              _narrowIfPossible(c)
            })
          }
        }
      }
    })
    const initialCallouts = document.querySelectorAll(QUEUE_SEL)
    if (initialCallouts.length > 0) {
      _narrowIfPossible(initialCallouts[0])
    } else {
      _hsCalloutCloseObs.observe(document.body, { childList: true, subtree: true })
    }
    cleanup.trackObserver(_hsCalloutCloseObs)
  }

  function ensureUIElements() {
    if (!multichatOverlayEnabled) return

    // Re-assert the stylesheet — twitch SPA navigations can sweep injected
    // <style> tags from <head>, leaving a remounted overlay fully unstyled
    // (raw text flow). injectStyles is idempotent (id check), so this is a
    // getElementById per call when healthy.
    try { injectStyles() } catch (_) {}

    // Always watch for collapse/expand class changes so we can clean up
    // inline styles when the user clicks the expand arrow
    if (hostPlatform !== 'yt') startColumnClassWatcher();

    // Don't fight Twitch when chat is collapsed — let the native expand arrow work
    if (hostPlatform !== 'yt') {
      const rightCol = document.querySelector('.right-column')
      const collapsed = rightCol && rightCol.classList.contains('right-column--collapsed')
      if (collapsed) return
      // Make sure chat column is visible (only when expanded)
      ensureChatColumnVisible();
    }

    // Find the React-controlled chat room
    let chatRoom
    if (hostPlatform === 'yt') {
      chatRoom = document.querySelector('#chat-container') ||
                 document.querySelector('ytd-live-chat-frame#chat')?.parentElement ||
                 document.querySelector('#secondary')
    } else if (isKick) {
      chatRoom = document.getElementById('channel-chatroom') || document.querySelector('[id*="chatroom"]')
    } else {
      chatRoom = document.querySelector('[class*="chat-room__content"]') ||
                 document.querySelector('[data-a-target="chat-room-component"]') ||
                 document.querySelector('.chat-shell') ||
                 document.querySelector(CONFIG.SELECTORS.TWITCH_STREAM_CHAT) ||
                 document.querySelector('.chat-room')
    }

    // Non-channel pages (Twitch /directory, Kick /browse, /categories,
    // YT home/search) have no chat-shell / #channel-chatroom. Fall
    // through with chatRoom=null so getOrCreateHsContainer body-mounts
    // the panel as a position:fixed overlay. Panel persists across
    // every SPA nav on all three platforms.

    // Transform fix handled by CSS (#hs-chat-transform-fix) + MutationObserver.
    // No parent tree walking — it displaced the collapse arrow.

    // Get our container outside React's tree
    const container = getOrCreateHsContainer(chatRoom)

    // Ensure tab bar exists
    if (!tabBarElement || !document.contains(tabBarElement)) {
      const existing = document.getElementById('hs-mc-tabbar');
      if (existing) {
        tabBarElement = existing;
        log('Reclaimed existing tab bar');
      } else {
        tabBarElement = createTabBar();
        updateTabBar();
        if (!liveStatusInterval) startLiveStatusPolling();
        log('Created tab bar');
      }
    }
    if (!container.contains(tabBarElement)) {
      container.insertBefore(tabBarElement, container.firstChild);
      log('Inserted tab bar into container');
    }

    // Ensure overlay exists
    if (!overlayElement || !document.contains(overlayElement)) {
      const existing = document.getElementById('hs-mc-overlay');
      if (existing) {
        overlayElement = existing;
        log('Reclaimed existing overlay');
      } else {
        overlayElement = createOverlay();
        log('Created overlay');
      }
    }
    if (!container.contains(overlayElement)) {
      container.appendChild(overlayElement);
      log('Injected overlay into container');
    }

    // Ensure emote picker panel exists (between overlay and inputbar)
    let pickerEl = document.getElementById('hs-mc-emote-picker');
    if (!pickerEl) {
      pickerEl = document.createElement('div');
      pickerEl.id = 'hs-mc-emote-picker';
    }
    if (!container.contains(pickerEl)) {
      container.appendChild(pickerEl);
    }

    // Ensure input bar exists
    if (!inputBarElement || !document.contains(inputBarElement)) {
      inputBarElement = createInputBar();
      // Start hidden — typing reveals it
      if (autoHideInput) {
        inputBarElement.classList.add('hs-hidden')
        inputBarVisible = false
      }
      log('Created input bar');
    }
    if (!container.contains(inputBarElement)) {
      container.appendChild(inputBarElement);
      log('Injected input bar into container');

      // Restore pending message if any
      const input = document.getElementById('hs-mc-input');
      if (input && pendingMessage) {
        input.value = pendingMessage;
      }
    }

    // Adjust overlay/inputbar/tabbar geometry based on actual tabbar+inputbar
    // dimensions — handles multi-row tabbar wrapping AND vertical tab columns.
    // Single source of truth so CSS hardcodes don't drift from real layout.
    _updateMcLayout = () => {
      if (!tabBarElement || !overlayElement) return
      const tabRect = tabBarElement.getBoundingClientRect()
      const tw = tabRect.width
      const th = tabRect.height
      const ih = inputBarElement ? inputBarElement.getBoundingClientRect().height : 0

      // Reset before re-applying to avoid stale rules between transitions
      for (const el of [overlayElement, inputBarElement, tabBarElement]) {
        if (!el) continue
        el.style.removeProperty('top')
        el.style.removeProperty('bottom')
        el.style.removeProperty('left')
        el.style.removeProperty('right')
      }

      if (tabPosition === 'top') {
        if (th > 0) overlayElement.style.top = th + 'px'
        overlayElement.style.bottom = ih + 'px'
      } else if (tabPosition === 'bottom') {
        overlayElement.style.top = '0px'
        overlayElement.style.bottom = (th + ih) + 'px'
        // Park tabbar directly above inputbar
        if (tabBarElement) tabBarElement.style.bottom = ih + 'px'
      } else if (tabPosition === 'right') {
        overlayElement.style.top = '0px'
        overlayElement.style.bottom = ih + 'px'
        if (tw > 0) {
          overlayElement.style.right = tw + 'px'
          if (inputBarElement) inputBarElement.style.right = tw + 'px'
        }
      } else if (tabPosition === 'left') {
        overlayElement.style.top = '0px'
        overlayElement.style.bottom = ih + 'px'
        if (tw > 0) {
          overlayElement.style.left = tw + 'px'
          if (inputBarElement) inputBarElement.style.left = tw + 'px'
        }
      }

      // Recompute geometry for ALL HsNotifs layers in one place. Each layer's
      // CSS vars (--hs-layer-*-{top|left|right|bottom}) drive its container's
      // CSS positioning. Adding a new layer = registerLayer + matching CSS.
      const containerEl = document.getElementById('hs-mc-container')
      try {
        HsNotifs.updateLayout({
          overlayElement, inputBarElement, tabBarElement,
          containerElement: containerEl, tabPosition,
          activeChannels: getActiveViewedChannels(),
        })
      } catch (_) {}
    }

    if (tabBarElement && overlayElement && !resizeObserver) {
      resizeObserver = new ResizeObserver(_updateMcLayout)
      resizeObserver.observe(tabBarElement)
      if (inputBarElement) resizeObserver.observe(inputBarElement)
      cleanup.trackObserver(resizeObserver)
      _updateMcLayout()
    }

    // Twitch resub-share callout: swap the native Pin toggle for our own X
    // close button. The native Pin pins the resub message to Twitch's chat
    // (which we hide), so it just dismisses the callout with nothing visible
    // afterward. Our X just clears the callout from view — Share button is
    // untouched.
    setupHsCalloutCloseButton()

    // Auto-show overlay if not already visible
    if (overlayElement && !overlayElement.classList.contains('visible')) {
      overlayElement.classList.add('visible');
      if (!currentTab) {
        currentTab = 'live';
        if (tabBarElement) {
          tabBarElement.querySelectorAll('.hs-mc-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === 'live');
          });
        }
      }
      renderMessages(currentTab);
      log('Auto-showed overlay on load');
    }
    // Always reveal container — when overlay is reclaimed (SPA persist /
    // re-mount), the visible-gated branch above is skipped and the
    // container would stay at opacity:0. Idempotent via _prepaintTornDown.
    tearDownPrepaint()

    // Ensure resize handle exists on left edge of chat panel
    if (hostPlatform === 'yt') {
      setupYouTubeResizeHandle()
    } else if (isKick) {
      setupKickResizeHandle()
      watchKickViewportClamp()
    } else {
      setupResizeHandle()
      watchTwitchPersistentPlayer()
    }
    // Platform-specific handles are only used when chatPosition === 'right'.
    // hidePlatformResizeHandles ran earlier from applyChatPosition before
    // these setup* calls created the handle elements, so any non-right mode
    // would leave a stray handle (e.g. the orange vertical bar on the left
    // of chat-bottom). Re-apply now with the freshly-created handles in DOM.
    if (chatPosition && chatPosition !== 'right') hidePlatformResizeHandles(true)

    // Always ensure native chat is hidden when our UI is active
    setNativeChatHidden(true);
  }

  // ============================================
  // TAB/CHANNEL MANAGEMENT
  // ============================================

  function switchTab(id) {
    log('switchTab called:', id);
    // Leaving an edit form: drop the outgoing tab's cache and clear msgsEl so
    // the upcoming snapshotTabState doesn't capture the form (which would then
    // be restored when switching back to the same channel id and look like
    // "save didn't exit").
    if (editingChannel) {
      _dropTabCache(currentTab);
      const _msgsEl = document.getElementById('hs-mc-messages');
      if (_msgsEl) _msgsEl.textContent = '';
    }
    editingChannel = false;
    // Tab switch is the user telling us they care about live state right
    // now — kick a debounced refresh so any stale red dots on channel tabs
    // get corrected without waiting up to 30s for the next poll cycle.
    try { refreshLiveStatusSoon() } catch {}
    // Tab switch closes profile card without re-rendering (we'll render the tab below)
    if (typeof activeProfileCard !== 'undefined' && activeProfileCard) activeProfileCard = null;

    // Clicking feed tab while in thread view → go back to feed, don't switch tabs
    if (id === 'feed' && currentTab === 'feed' && activeThread) {
      closeThread();
      return;
    }

    // Close thread view when leaving feed
    if (currentTab === 'feed' && id !== 'feed') {
      activeThread = null;
      _clearFeedReplyChip();
      const feedTabBtn = tabBarElement?.querySelector('[data-tab="feed"]');
      if (feedTabBtn) feedTabBtn.textContent = t('mc_tab_feed');
    }
    if (currentTab !== 'settings') prevTab = currentTab;
    // Snapshot the outgoing tab's DOM into the cache so a future switch back
    // restores it instantly (no rebuild). Skipped for static tabs which manage
    // their own DOM. Must run BEFORE currentTab flips.
    snapshotTabState(currentTab);
    currentTab = id;
    _scrollbackWindow = 0; // new tab starts at the live tail, not prior scrollback depth
    markTabSeen(id);

    // Update settings button icon: X when settings open, cog otherwise
    if (tabBarElement) {
      const settingsBtn = tabBarElement.querySelector('[data-tab="settings"]');
      if (settingsBtn) settingsBtn.textContent = id === 'settings' ? '✕' : '⚙';
    }
    updatePopoutBtnVisibility();

    // Channel/tab switch flips which channel-emote cache the picker reads —
    // mark cache dirty + queue idle prebuild for the new context.
    markPickerDirty();
    prebuildPickerIdle();

    // Mark mentions as seen when switching to that tab
    if (id === 'mentions') {
      bumpSeen('mentions');
      updateTabBadges();
    }
    if (id === 'feed') bumpSeen('live');

    // Search bar: server search on mentions, instant local filter on live/channel tabs.
    const searchBar = document.getElementById('hs-mc-search-bar')
    if (searchBar) searchBar.classList.toggle('visible', id === 'mentions' || isLiveSearchTab(id))
    // Reset the query on tab switch so a live filter doesn't bleed across
    // channels; placeholder reflects the active mode.
    const _searchInputEl = document.getElementById('hs-mc-search-input')
    if (_searchInputEl) {
      _searchInputEl.value = ''
      _searchInputEl.placeholder = isLiveSearchTab(id) ? 'filter chat — @user for one person' : 'search messages…'
    }

    // Discover/pinned refresh bars removed — auto-poll handles freshness

    // Clear whisper unread when switching to whispers tab — server-backed.
    if (id === 'whispers') {
      bumpSeen('whispers')
      whisperSaveDebounced()
    }

    // Persist active tab across refreshes/popouts (skip transient tabs)
    if (id !== 'add') {
      try {
        saveUiSetting('activeTab', id)
        // liveChannel override is popout-scoped — persisting it from regular
        // pages was how a stale pick haunted every future boot
        if (document.body.classList.contains('hs-popout')) saveUiSetting('liveChannel', liveChannel)
      } catch (e) { /* context invalidated */ }
    }

    // Refresh platform filter buttons for the new tab
    renderPlatformFilterButtons();

    // Update tab bar active state
    if (tabBarElement) {
      const liveCh = getLiveChannel()?.toLowerCase()
      tabBarElement.querySelectorAll('.hs-mc-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === id);
        if (t.dataset.tab === id) {
          t.classList.remove('has-new');
          t.classList.remove('has-stream-event');
          t.classList.remove('has-mentions');
        }
        // Switching to live also clears the matching channel tab's indicators
        if (id === 'live' && liveCh && t.dataset.tab !== 'live') {
          const ch = getChannelById(t.dataset.tab)
          if (ch) {
            const tw = ch.twitch?.toLowerCase()
            const ki = (ch.kick)?.toLowerCase()
            if (tw === liveCh || ki === liveCh) {
              t.classList.remove('has-new', 'has-stream-event', 'has-mentions')
            }
          }
        }
        // Switching to a channel tab that matches live clears the live tab too
        if (id !== 'live' && liveCh && t.dataset.tab === 'live') {
          const ch = getChannelById(id)
          if (ch) {
            const tw = ch.twitch?.toLowerCase()
            const ki = (ch.kick)?.toLowerCase()
            if (tw === liveCh || ki === liveCh) {
              t.classList.remove('has-new', 'has-stream-event', 'has-mentions')
            }
          }
        }
      });
    }

    // Update live tab label when switching to it
    if (id === 'live') updateLiveTabLabel();

    // Reset scroll state BEFORE rendering - always start at bottom when switching tabs
    isScrolledUp = false;
    newMessageCount = 0;
    const newBtn = document.getElementById('hs-mc-new-msgs');
    if (newBtn) newBtn.style.display = 'none';

    // Native chat always hidden — multichat handles all tabs including live on Kick

    // Hide input bar on add-channel form, or when auto-hide is on
    if (inputBarElement) {
      const pickerOpen = document.getElementById('hs-mc-emote-picker')?.classList.contains('visible');
      if (id === 'add' || id === 'settings' || id === 'discover' || id === 'pinned') {
        inputBarElement.classList.add('hs-hidden');
        inputBarVisible = false;
      } else if (autoHideInput && !pickerOpen) {
        const input = document.getElementById('hs-mc-input')
        const hasContent = input && ((input.value || input.textContent || '').trim().length > 0 || input.querySelector('img, span.hs-mc-emoji'))
        if (hasContent) {
          inputBarElement.classList.remove('hs-hidden')
          inputBarVisible = true
        } else {
          inputBarElement.classList.add('hs-hidden')
          inputBarVisible = false
        }
      } else {
        inputBarElement.classList.remove('hs-hidden');
        inputBarVisible = true;
      }
    }

    if (overlayElement) {
      overlayElement.classList.add('visible');
      // Sync overlay bottom with input bar visibility — clear inline style when
      // input is back so the CSS bottom-padding-for-input-bar reapplies
      if (inputBarVisible) overlayElement.style.bottom = ''
      else overlayElement.style.bottom = '0'
      // Restore cached fragment for the incoming tab if we have one. The
      // existing renderMessages diff then operates against pre-painted DOM —
      // most diffs become no-ops (cache stayed hot via appendToCachedTab),
      // worst case it adds a few late arrivals.
      restoreTabState(id);
      renderMessages(id);
    } else {
      log('No overlay element to show!');
    }

    // Update input placeholder for new tab
    updateInputPlaceholder();

    // Hide native chat when our overlay is active
    setNativeChatHidden(true);

    // Refresh HsNotifs channel scope so per-channel callouts (resub-share,
    // watchstreak) hide when leaving their channel's tab and reappear when
    // returning. Layout call piggybacks on the existing recompute path.
    try { _updateMcLayout?.() } catch (_) {}
  }

  /**
   * Toggle native Twitch chat visibility (FFZ-style)
   * Adds class to parent container rather than relying on :has() selector
   */
  function setNativeChatHidden(hidden) {
    if (isKick) {
      // Kick selectors
      const chatroom = document.getElementById('channel-chatroom') ||
                       document.querySelector('[id*="chatroom"]');
      if (chatroom) chatroom.classList.toggle('hs-native-hidden', hidden);
      return;
    }

    // Twitch: Add class to chat-shell (outermost container)
    const chatShell = document.querySelector('.chat-shell') ||
                      document.querySelector(CONFIG.SELECTORS.TWITCH_CHAT_SHELL);
    if (chatShell) {
      chatShell.classList.toggle('hs-native-hidden', hidden);
    }

    // Add class to chat-room__content (where our elements are injected)
    const chatRoom = document.querySelector('[class*="chat-room__content"]') ||
                     document.querySelector('[data-a-target="chat-room-component"]');
    if (chatRoom) {
      chatRoom.classList.toggle('hs-native-hidden', hidden);
    }

    // Also try stream-chat for popout mode
    const streamChat = document.querySelector('.stream-chat') ||
                       document.querySelector(CONFIG.SELECTORS.TWITCH_STREAM_CHAT);
    if (streamChat) {
      streamChat.classList.toggle('hs-native-hidden', hidden);
    }
  }

  function updateTabBadges() {
    refreshSeenBadges();
    if (!tabBarElement) return;
    const mentionsTab = tabBarElement.querySelector('[data-tab="mentions"]');
    if (mentionsTab) mentionsTab.textContent = 'mentions';
  }



  // Dedup helper: check against actual message buffers (survives WS reconnects)
  function isYtDuplicate(user, text, channelId) {
    const buf = channelYtMessages.get(channelId)
    if (!buf || buf.length === 0) return false
    // check last 200 messages in buffer (matches server recentMessages cap)
    const start = Math.max(0, buf.length - 200)
    const needle = `${user}:${text.slice(0, 50)}`
    for (let i = buf.length - 1; i >= start; i--) {
      const m = buf[i]
      if (`${m.user}:${m.text.slice(0, 50)}` === needle) return true
    }
    return false
  }

  // Build a message div element (shared by full rebuild and incremental append)
  // Note: innerHTML here is safe — badges/emotes are from extension data, user text
  // goes through escapeHtml() and processEmotes() which sanitize content
  // Compute a message's rendered text HTML (emotes + YT emoji + mention
  // highlights + cheermotes), cached on m._renderedHtml. Extracted from
  // buildMessageDiv so the in-place emote reload (reprocessEmoteTextInPlace)
  // produces BYTE-IDENTICAL output to a fresh rebuild — one source of truth,
  // no drift.
  // @param {object} m  message object (m.text, m.channel, m.twitchEmotes, …)
  // @returns {string}  sanitized HTML for the message text span
  function computeMessageText(m) {
    if (m._renderedHtml != null) return m._renderedHtml
    // Pass Twitch native emotes (per-message IRC tags) into processEmotes so
    // they participate in the overlay-stack pipeline alongside 7TV emotes.
    const isOwn = m.user && currentUsername && m.user.toLowerCase() === currentUsername.toLowerCase()
    let twitchExtra = null
    if (m.twitchEmotes) {
      twitchExtra = new Map()
      // Lock detection: viewer can post a Twitch native sub emote only with a
      // subscriber/founder badge in this channel. Own outgoing msgs bypass.
      const viewerBadges = viewerBadgesPerChannel.get(m.channel)
      const viewerCanPostSub = isOwn || (viewerBadges && (viewerBadges.has('subscriber') || viewerBadges.has('founder')))
      for (const [name, url] of Object.entries(m.twitchEmotes)) {
        let state = 'locked'
        if (viewerCanPostSub) state = 'global'
        else {
          const alt = (typeof lookupEmote === 'function') ? lookupEmote(name) : null
          if (alt && (alt.state === 'owned' || alt.state === 'global' || alt.state === 'channel')) state = 'global'
        }
        twitchExtra.set(name, { url, source: 'twitch', state, zeroWidth: false })
      }
    }
    // Sender-perma emote resolution: own → viewerPersonalEmotes, others →
    // senderEmoteSets["plat:uid"] (lazy-fetched, perma cached).
    let senderEmotes = null
    const senderKey = resolveSenderEmoteKey(m)
    if (isOwn) {
      senderEmotes = viewerPersonalEmotes
    } else if (senderKey) {
      senderEmotes = getSenderEmotes(senderKey)
      queueSenderEmoteFetch(senderKey, m)
    }
    let processedText = processEmotes(escapeHtml(m.text), m.channel, twitchExtra, senderEmotes, m.time)
    if (m.emotes && m.emotes.length > 0) {
      processedText = processYtEmotes(processedText, m.emotes, true)
    }
    // Safety net: strip any remaining escaped HTML img tag fragments that leaked through.
    if (processedText.includes('&lt;img')) {
      processedText = processedText.replace(/&lt;img\b[^<]*/g, '')
    }
    // Highlight mentions AFTER emote processing so emote-name <img> tags aren't touched.
    processedText = highlightMentionsInHtml(processedText)
    // Cheermotes — only when twitch IRC tagged bits=N (server-confirmed cheer).
    if (m.bits) processedText = renderCheermotesInText(processedText, m.bits)
    m._renderedHtml = processedText
    return processedText
  }

  // Shared post-render reconcile of heatsync emote states (blocked vs pasteable)
  // against current inventory/blocked. Used by buildMessageDiv (root=div) and the
  // in-place emote reload (root=swapped text span).
  function reconcileHeatsyncEmoteStates(root) {
    for (const w of root.querySelectorAll('.hs-mc-emote-wrapper[data-source="heatsync"]')) {
      const name = w.dataset.emoteName
      const newState = blockedEmoteNames.has(name) ? 'blocked'
        : inventoryEmotes.has(name) ? 'owned'
        : 'global'
      if (w.dataset.state !== newState) {
        w.classList.remove('hs-state-owned', 'hs-state-unadded', 'hs-state-blocked', 'hs-state-global', 'hs-state-channel')
        w.classList.add(`hs-state-${newState}`)
        w.dataset.state = newState
      }
    }
  }

  // In-place emote reload. When a channel/global emote set FIRST loads, plain-text
  // history rows must pick up the now-renderable emotes. The old path called
  // clearRenderedHtmlCache() → _renderEpoch++ → renderMessages tore down + rebuilt
  // every row → every avatar/emote/badge img reloaded = the "loads then shifts"
  // flash. Instead, swap ONLY each rendered row's text span (.hs-mc-text), computed
  // by the SAME computeMessageText helper buildMessageDiv uses (byte-identical to a
  // rebuild), so the row/avatar/badges keep their identity and never reload.
  function reprocessEmoteTextInPlace() {
    const msgsEl = document.getElementById('hs-mc-messages')
    if (!msgsEl) return
    for (const div of msgsEl.querySelectorAll('.hs-mc-msg[data-msg-key]')) {
      const span = div.querySelector(':scope > .hs-mc-text')
      const m = div._hsMsg
      if (!span || !m) continue
      const html = computeMessageText(m) // m._renderedHtml cleared by caller → recomputes
      span.innerHTML = html
      if (html.includes('data-source="heatsync"')) reconcileHeatsyncEmoteStates(span)
      // The swap recreated mention anchors — re-index so updateCosmeticsInPlace
      // still finds them (stale refs would silently fail to repaint paints).
      _unindexMessageDiv(div)
      div._hsMentionEls = null
      _indexMessageDiv(div, div.dataset.msgKey)
    }
  }

  // First-emote-load handler: clear cached HTML everywhere so every tab recomputes
  // with the new emotes, repaint the CURRENT tab in place (no flash), and drop
  // other tabs' snapshot caches so they rebuild fresh on switch. NO _renderEpoch
  // bump → no full teardown (mirrors invalidateRenderedForEmotes' tab handling).
  function reloadEmotesInPlace(reprocess = true) {
    const clearBuf = (msgs) => { for (const m of msgs) delete m._renderedHtml }
    if (irc?.channels) for (const [, buf] of irc.channels) clearBuf(buf.getAll())
    if (kickChat?.channels) for (const [, buf] of kickChat.channels) clearBuf(buf.getAll())
    clearBuf(mentionsBuffer)
    for (const msgs of channelYtMessages.values()) clearBuf(msgs)
    // Skip the visible-row swap when scrolled up (caller passes reprocess=false) —
    // the cleared cache means those rows recompute with emotes on the next natural
    // render, without disturbing the user's scroll position now.
    if (reprocess) reprocessEmoteTextInPlace()
    _dropAllTabCaches()
  }

  // Static platform→accent map — hoisted out of buildMessageDiv so it isn't
  // reallocated for every chat row rendered.
  const PLAT_COLORS = { twitch: '#9146ff', kick: '#53fc18', yt: '#ff0000', heatsync: '#ff8700' }
  function buildMessageDiv(m, tabId) {
    // Blocked user — fully hide (skip render entirely). Both the append and the
    // full-rebuild path go through buildMessageDiv, so returning null here hides
    // the message everywhere. Unblock + renderMessages brings them back.
    if (m.user && isUserBlocked(m.user, m.platform)) return null;
    // Stream event — render as magenta inline notification.
    // Render-time gate: skip if the corresponding hermes toggle is off
    // (buffer can hold events saved before a toggle flipped). Mirrors the
    // heatsync.org chat-tile _streamEventEnabled() filter.
    if (m.type === 'stream-event') {
      const cls = m.eventClass || ''
      const tokens = cls.split(/\s+/)
      const last = tokens[tokens.length - 1] || ''
      const evtMap = {
        'event-offline': 'offline',
        'event-online':  'online',
        'event-update':  'gameSwitch',
        'event-raid':    'raid',
        'event-hype':    'hype',
        'event-sub':     'sub',
        'event-redeem':  'redeem',
        'event-pred':    'pred'
      }
      const hkey = evtMap[last]
      if (hkey && hermesToggles?.[hkey] === false) return null
      const div = document.createElement('div')
      div.className = `hs-mc-stream-event ${m.eventClass || ''}`
      const tsVal = timestampsEnabled && m.time ? formatTimeFromTs(m.time) : ''
      const tsSpan = tsVal ? `<span class="hs-mc-ts">${tsVal}</span>` : ''
      // For redeems, the actor is the redeemer (m.actor). For other events the channel is the actor.
      const ch = m.actor || m.channel || ''
      const chLc = ch.toLowerCase()
      // Look up color: event data → color map → profile cache → IRC buffers → async fetch
      let userColor = m.color || ''
      if (!userColor) userColor = streamColorMap.get(chLc) || ''
      if (!userColor) {
        const cached = _profileCache.get(chLc)
        if (cached?.profile?.twitch_color) userColor = cached.profile.twitch_color
      }
      if (!userColor && chLc && irc?.channels) {
        for (const [, buf] of irc.channels) {
          const msgs = buf.getAll()
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].user?.toLowerCase() === chLc) {
              userColor = msgs[i].color || ''
              break
            }
          }
          if (userColor) break
        }
      }
      // Build structured HTML: [username] ◆ action game
      if (!userColor) userColor = '#fff'
      const colorStyle = `color:${sanitizeColor(userColor)}`
      const userLink = `<a href="https://twitch.tv/${encodeURIComponent(ch)}" target="_blank" class="hs-mc-user hs-evt-user" data-username="${escapeHtml(ch)}" style="${colorStyle}">${escapeHtml(ch)}</a>`
      const textAfterChannel = escapeHtml(m.text).replace(/^\[[^\]]+\]\s*/, '')
      const actionHtml = textAfterChannel.replace(/(switched to |now playing |went live \u2014 )(.+)$/, '$1<span class="hs-evt-game">$2</span>')
      div.innerHTML = `${tsSpan}${userLink} ${actionHtml}`
      // Async fetch color if not cached
      if (!userColor && chLc) {
        apiFetch(`/api/profile/${encodeURIComponent(chLc)}`).then(resp => {
          if (resp?.ok && resp.data?.profile) {
            const profile = resp.data.profile
            const color = profile.twitch_color
            if (color) {
              const el = div.querySelector('.hs-evt-user')
              if (el) el.style.color = sanitizeColor(color)
            }
            _profileCache.set(chLc, { profile, ts: Date.now() })
          }
        })
      }
      return div
    }

    // Inline feed post — uses notification type colors from registry
    if (m.type === 'feed-post') {
      const div = document.createElement('div')
      div.className = 'hs-mc-feed-inline'
      div.dataset.msgId = m.base36_id || ''
      const isOp = m.is_op != null ? !!m.is_op : (!m.reply_to || m.reply_to === '')
      const isThreadOp = !!m.is_thread_op
      const notifType = isThreadOp ? 'mop' : isOp ? 'op' : 're'
      const typeDef = INLINE_NOTIF_TYPES[notifType]
      const borderColor = m.inlineNotifBorderColor || typeDef?.borderColor || '#ff8700'
      div.style.borderLeftColor = borderColor
      const tsVal = timestampsEnabled ? formatTimeFromTs(m.time) : ''
      const tsSpan = tsVal ? `<span class="hs-mc-ts">${tsVal}</span>` : ''
      const tagColor = typeDef?.color || '#ff0000'
      const tagLabel = isThreadOp || isOp ? '[OP]' : '[RE]'
      const typeTag = `<span class="hs-feed-tag" style="color:${tagColor};font-size:13px;margin-right:3px">${tagLabel}</span>`
      const shortId = (m.base36_id || '').replace(/^0+/, '') || '0'
      // Span (not <a>): falls through to the row click handler below → switchTab('feed') + openThread, in-ext. An anchor would open heatsync.org in a new tab.
      const threadLink = `<span class="hs-feed-thread-link" data-id="${escapeHtml(m.base36_id || '')}" style="cursor:pointer">&gt;&gt;${escapeHtml(shortId)}</span>`
      const userLink = `<a href="https://heatsync.org/user/${encodeURIComponent(m.feedUser)}" target="_blank" class="hs-mc-user" data-username="${escapeHtml((m.feedUser || 'anon').toLowerCase())}" style="color:${sanitizeColor(m.color || '#fff')}">${escapeHtml(m.feedUser || 'anon')}</a>`
      const content = renderFeedContent(m.text, m.emote_refs)
      // Canonical heat: formatHeat + ° suffix (≥10) + tier color/glow/breathe via heatSpanHtml
      const heatHtml = (m.heat || 0) > 0 ? ' ' + heatSpanHtml(m.heat) : ''
      // All values sanitized — safe innerHTML (heat is numeric, emoji/color are hardcoded)
      div.innerHTML = `${tsSpan}${threadLink}${typeTag}${userLink}${heatHtml}: <span class="hs-feed-body">${content}</span>`
      div.addEventListener('click', (e) => {
        const spoiler = e.target.closest('.hs-spoiler')
        if (spoiler) { spoiler.classList.toggle('revealed'); return }
        if (e.target.closest('a, .hs-mc-emote, .hs-mc-link')) return
        switchTab('feed')
        openThread(m.reply_to || m.base36_id)
      })
      return div
    }

    // Inline DM/whisper notification
    if (m.type === 'inline-dm') {
      const div = document.createElement('div')
      div.className = 'hs-mc-feed-inline hs-mc-dm-inline'
      const borderColor = m.inlineNotifBorderColor || INLINE_NOTIF_TYPES.dm.borderColor
      div.style.borderLeftColor = borderColor
      const tsVal = timestampsEnabled ? formatTimeFromTs(m.time) : ''
      const tsSpan = tsVal ? `<span class="hs-mc-ts">${tsVal}</span>` : ''
      const labelColor = m.inlineNotifColor || INLINE_NOTIF_TYPES.dm.color
      const label = `<span style="color:${labelColor};font-size:13px;font-weight:700;margin-right:3px">[DM]</span>`
      const platBadge = m.platform === 'twitch'
        ? '<span style="color:#9146ff;font-size:13px;font-weight:700;margin-right:3px">[T]</span>'
        : '<span style="color:#ff8700;font-size:13px;font-weight:700;margin-right:3px">[HS]</span>'
      const dmPaint = m.platform === 'twitch' ? userPaintStyle(m.userId, (m.user || '').toLowerCase()) : ''
      const userName = `<span style="${dmPaint || `color:${sanitizeColor(m.color)};font-weight:600`}">${escapeHtml(m.user)}</span>`
      // All values sanitized — safe innerHTML
      if (m._renderedHtml == null) m._renderedHtml = processEmotes(escapeHtml(m.text), null)
      // All values already sanitized via escapeHtml/processEmotes — safe innerHTML (existing pattern)
      div.innerHTML = `${tsSpan}${label}${platBadge}${userName}: ${m._renderedHtml}`
      div.style.cursor = 'pointer'
      div.addEventListener('click', (e) => {
        if (e.target.closest('a, .hs-mc-emote')) return
        switchTab('whispers')
      })
      return div
    }

    if (m.type === 'moment') {
      const div = document.createElement('div')
      div.className = 'hs-mc-feed-inline hs-mc-moment-inline'
      div.style.borderLeftColor = m.inlineNotifBorderColor || '#ff8700'
      const tsVal = timestampsEnabled ? formatTimeFromTs(m.time) : ''
      const tsSpan = tsVal ? `<span class="hs-mc-ts">${tsVal}</span>` : ''
      const label = `<span style="color:${m.inlineNotifColor || '#ff8700'};font-size:13px;font-weight:700;margin-right:3px">[🔥]</span>`
      div.innerHTML = `${tsSpan}${label}<span style="color:#c0c0c0">${escapeHtml(m.text || '')}</span>`
      div.style.cursor = 'pointer'
      const ch = m.momentChannel
      const plat = m.momentPlatform || 'twitch'
      div.title = `open ${plat}/${ch}`
      div.addEventListener('click', (e) => {
        if (e.target.closest('a')) return
        const url = plat === 'kick' ? `https://kick.com/${ch}` : `https://www.twitch.tv/${ch}`
        try { window.open(url, '_blank', 'noopener') } catch (_) {}
      })
      return div
    }

    // Guard against messages with no user (malformed IRC / system messages)
    if (!m.user) {
      if (m.text || m.systemMsg) {
        const div = document.createElement('div')
        div.className = 'hs-mc-msg hs-mc-system'
        div.textContent = m.systemMsg || m.text || ''
        return div
      }
      return null
    }

    const showChannel = tabId === 'mentions';
    const isSuperChat = m.platform === 'youtube' && (m.msgType === 'superchat' || m.msgType === 'supersticker')
    const isMembership = m.platform === 'youtube' && (m.msgType === 'membership' || m.msgType === 'giftpurchase' || m.msgType === 'giftredemption')
    const isKicksEvent = m.kicksEvent === true
    // Map noticeType / msgId to a semantic CSS modifier so each event class
    // (unban, ban, mod-add, mode-change, sub, raid, etc.) can have its own color/icon
    const noticeKind = (() => {
      if (m.type !== 'notice' && m.type !== 'usernotice') return ''
      const id = m.noticeType || m.msgId || ''
      if (!id) return ''
      // group related msg-ids into a single semantic class
      if (id === 'unban_success') return 'hs-mc-notice-unban'
      if (id === 'untimeout_success') return 'hs-mc-notice-untimeout'
      if (id === 'ban_success') return 'hs-mc-notice-ban'
      if (id === 'timeout_success') return 'hs-mc-notice-timeout'
      if (id === 'mod_success') return 'hs-mc-notice-mod-add'
      if (id === 'vip_success') return 'hs-mc-notice-vip-add'
      if (id === 'unmod_success') return 'hs-mc-notice-mod-remove'
      if (id === 'unvip_success') return 'hs-mc-notice-vip-remove'
      if (id === 'delete_message_success') return 'hs-mc-notice-delete'
      if (id === 'mode_change' || id === 'slow_on' || id === 'slow_off' ||
          id === 'subs_on' || id === 'subs_off' || id === 'emote_only_on' || id === 'emote_only_off' ||
          id === 'followers_on' || id === 'followers_on_zero' || id === 'followers_off' ||
          id === 'r9k_on' || id === 'r9k_off') return 'hs-mc-notice-mode'
      if (id === 'sub' || id === 'resub') return 'hs-mc-notice-sub'
      // Kick event names — heatsync server passes Kick-side strings through;
      // normalize to the same CSS classes Twitch sub/gift events use so the
      // sub-purple border, gift-bubble pink, etc. render identically.
      if (id === 'subscription' || id === 'channel.subscription.new' ||
          id === 'channel.subscription.renewal' || id === 'resubscription') return 'hs-mc-notice-sub'
      if (id === 'subgift' || id === 'anonsubgift' || id === 'submysterygift' ||
          id === 'giftpaidupgrade' || id === 'anongiftpaidupgrade' ||
          id === 'gift_subscription' || id === 'gifted_subscriptions' ||
          id === 'channel.subscription.gifts') return 'hs-mc-notice-gift'
      if (id === 'raid' || id === 'unraid') return 'hs-mc-notice-raid'
      // Kick host events — render same as raid
      if (id === 'host' || id === 'unhost' || id === 'channel.host') return 'hs-mc-notice-raid'
      // Kick "Kicks" gifted events (already wired in irc.js as kicksEvent)
      if (id === 'kicks_gifted' || id === 'kicks') return 'hs-mc-notice-bits'
      if (id === 'announcement') return 'hs-mc-notice-announce'
      if (id === 'bitsbadgetier') return 'hs-mc-notice-bits'
      if (id === 'watchstreak') return 'hs-mc-notice-watchstreak'
      if (id === 'viewermilestone') return 'hs-mc-notice-milestone'
      // mod-anniversary — Twitch ships USERNOTICE every 6 months a user
      // moderates a channel (announced TwitchCon Rotterdam 2026). Same payload
      // shape as sub anniversary; render with mod-add's blue family so the
      // moderator-celebration thread reads consistently.
      if (id === 'mod-anniversary' || id === 'mod_anniversary') return 'hs-mc-notice-mod-anniversary'
      if (id === 'msg_banned' || id === 'msg_timedout' || id === 'no_permission' ||
          id.startsWith('bad_') || id.startsWith('usage_')) return 'hs-mc-notice-error'
      return ''
    })()
    const cls = tabId === 'mentions' ? 'hs-mc-msg mention' :
isKicksEvent ? 'hs-mc-msg hs-mc-system hs-mc-kicks' :
isMembership ? 'hs-mc-msg hs-mc-system' :
m.type === 'usernotice' || m.type === 'notice' ? `hs-mc-msg hs-mc-system ${noticeKind}`.trim() :
                m.isHighlighted ? 'hs-mc-msg hs-mc-highlighted' :
                m.redeemed ? 'hs-mc-msg hs-mc-redeemed' :
                isSuperChat ? 'hs-mc-msg hs-mc-superchat' :
                isMention(m) ? 'hs-mc-msg mention' : 'hs-mc-msg';
    const channelSpan = showChannel && m.channel ? `<span class="hs-mc-channel">${escapeHtml(m.channel)}</span>` : '';
    // Render badges — YouTube sends array of {type,label,url}, Twitch/Kick send IRC badge string
    let badges = ''
    if (m.platform === 'youtube' && Array.isArray(m.badges)) {
      badges = m.badges.map(b => {
        if (b.url) {
          return `<img class="hs-mc-badge-img" src="${escapeHtml(b.url)}" alt="${escapeHtml(b.label)}" title="${escapeHtml(b.label)}" loading="lazy" decoding="async" width="18" height="18" style="width:18px;height:18px;">`
        }
        // Text fallback for owner/mod without image
        const ytBadgeStyles = { owner: { bg: '#ffd600', fg: '#000', label: '\u2606' }, moderator: { bg: '#5e84f1', fg: '#fff', label: '\u2694' } }
        const style = ytBadgeStyles[b.type]
        if (style) return `<span class="hs-mc-badge" style="background:${style.bg};color:${style.fg}" title="${escapeHtml(b.label)}">${style.label}</span>`
        return ''
      }).join('')
    } else {
      // m.badgePlatform preserves the ORIGINAL chat origin (twitch IRC vs
       // Kick WS) when peekSentHost retags m.platform to the user's send-host
       // ('kick' on own msg from kick.com). Badge URL lookup must use the
       // origin platform — mod/sub badges on a Twitch IRC msg always belong
       // to the Twitch badge namespace, regardless of [K]/[T] indicator.
      badges = renderBadges(m.badges, m.channel, m.badgePlatform || m.platform)
    }
    // YT messages don't carry a Twitch ID — resolve via heatsync profile
    // lookup keyed by the YT @handle. If cached, hoist into m.userId so the
    // existing badge + cosmetics pipeline applies; if not, queue a lookup
    // and updateCosmeticsInPlace will repaint after backfill.
    if (!m.userId && m.platform === 'youtube' && m.user) {
      const ytKey = (m.user || '').toLowerCase().replace(/^@/, '')
      const cached = ytNameToTwitchId.get(ytKey)
      if (cached) m.userId = cached
      else if (cached === undefined) queueYtNameToTwitchId(m.user)
    }
    // Kick: panel sees usernames only — resolve via 7TV/v3/users/kick/{name}
    // which also returns the linked twitch_id when present. Hoist into m.userId
    // so the existing cosmetics pipeline applies.
    if (!m.userId && m.platform === 'kick' && m.user) {
      const kKey = (m.user || '').toLowerCase()
      const cached = kickNameResolved.get(kKey)
      if (cached) m.userId = cached
      else if (cached === undefined) queueKickNameToCosmetics(m.user)
    }
    if (m.userId) {
      badges += renderThirdPartyBadges(m.userId)
      if (!mcUserCosmetics.has(m.userId)) queueMcCosmeticsLookup(m.userId)
    }
    const plat = m.platform === 'youtube' ? 'yt' : m.platform === 'kick' ? 'kick' : m.platform === 'heatsync' ? 'heatsync' : 'twitch'
    const platLabel = plat === 'yt' ? '[Y]' : plat === 'kick' ? '[K]' : plat === 'heatsync' ? '[H]' : '[T]'
    const platformBadge = (platformBadgesEnabled || plat !== hostPlatform) ? `<span class="hs-mc-platform-badge hs-mc-pb-${plat}" style="font-size:13px;margin-right:3px;font-weight:700;vertical-align:middle;color:${PLAT_COLORS[plat]}">${platLabel}</span>` : ''
    const safeScColor = sanitizeColor(m.scColor || '#ffd600')
    const scBadge = isSuperChat && m.amount ? `<span class="hs-mc-sc-badge" style="background:${safeScColor};color:#000;padding:0 4px;border-radius:0;font-size:13px;font-weight:700;margin-right:3px;">${escapeHtml(m.amount)}</span>` : ''
    const bitsBadge = m.bits ? `<span class="hs-mc-bits-badge" title="${m.bits} bits">${m.bits} bits</span>` : ''
    // (cheermote rendering is applied inline in processedText via renderCheermotesInText)
    const paintStyle = m.userId ? getMcPaintStyle(m.userId) : ''
    // Build the channel link for the username. YouTube usernames arrive
    // prefixed with "@" so we strip it before concatenating to avoid
    // youtube.com/@/%40handle-style double-encoding.
    let userHref
    if (plat === 'kick') {
      userHref = `https://kick.com/${encodeURIComponent(m.user)}`
    } else if (plat === 'yt') {
      const ytHandle = (m.user || '').replace(/^@/, '')
      userHref = `https://youtube.com/@${encodeURIComponent(ytHandle)}`
    } else if (plat === 'heatsync') {
      userHref = `https://heatsync.org/${encodeURIComponent(m.user)}`
    } else {
      userHref = `https://twitch.tv/${encodeURIComponent(m.user)}`
    }
    const userLink = `<a href="${userHref}" target="_blank" class="hs-mc-user" data-username="${escapeHtml(m.user.toLowerCase())}" data-platform="${plat}" style="${paintStyle || 'color:' + sanitizeColor(m.color || '#fff')}">${escapeHtml(m.user)}</a>`;
    let avatarHtml = ''
    if (avatarsEnabled) {
      const userKey = m.user.toLowerCase()
      // YouTube messages carry avatar URL directly — cache it and skip decapi.
      // Same 500-entry LRU as the decapi path so 30k unique YT chatters can't
      // grow the Map unbounded over an 8h stream.
      if (m.avatar && m.platform === 'youtube') {
        avatarCache.set(userKey, m.avatar)
        if (avatarCache.size > 500) {
          avatarCache.delete(avatarCache.keys().next().value)
        }
      }
      const cachedUrl = avatarCache.get(userKey)
      if (cachedUrl) {
        avatarHtml = `<img class="hs-mc-avatar" src="${escapeHtml(cachedUrl)}" alt="" loading="lazy" decoding="async">`
      } else if (!m.platform || m.platform === 'twitch') {
        // Initials reserve the box immediately; decapi fetch swaps the real pfp
        // in place on success (zero shift) or it stays as the initial on a
        // miss/failure (no blank gap). Unifies with the kick/yt path below.
        avatarHtml = avatarFallbackHtml(m.user, userKey, true)
        fetchAvatar(userKey)
      } else {
        // Kick/YouTube without a cached avatar — neutral initials placeholder so
        // the avatar column doesn't have an empty gap (no decapi for these).
        avatarHtml = avatarFallbackHtml(m.user, userKey, false)
      }
    }

    // Process text (emotes + YT emoji + mentions + cheermotes), cached on
    // m._renderedHtml. Shared with reprocessEmoteTextInPlace via this helper so
    // an in-place emote reload produces byte-identical HTML to a full rebuild.
    // Skip text-less rows (system/usernotice with only a systemMsg) — they
    // render via ${systemLine}, never ${processedText}, so computing would just
    // cache a spurious '' (and pointlessly queue a sender-emote fetch).
    const processedText = m.text ? computeMessageText(m) : ''

    // Sticker for super stickers
    let stickerHtml = ''
    if (m.sticker && m.sticker.url) {
      stickerHtml = ` <img src="${escapeHtml(m.sticker.url)}" alt="${escapeHtml(m.sticker.alt || 'sticker')}" loading="lazy" decoding="async" style="height:48px;vertical-align:middle;" />`
    }

    const div = document.createElement('div');
    div.className = cls;
    div._hsMsg = m // back-ref for reprocessEmoteTextInPlace (GC'd with the row)
    if (m.userId) div.dataset.uid = m.userId
    if (isSuperChat && m.scColor) {
      const safeBg = sanitizeColor(m.scColor)
      div.style.background = safeBg + '22'
      div.style.borderLeft = `3px solid ${safeBg}`
      div.style.paddingLeft = '4px'
    }
    // First-time chatter highlight (this session, per channel)
    if (firstChatterGlow && m.user && m.channel && !isMembership && !isKicksEvent && m.type !== 'usernotice' && m.type !== 'notice') {
      // Mark seen regardless so the user's NEXT message isn't mis-flagged yellow,
      // but channel-first (purple hs-mc-first-msg) outranks session-first — don't glow yellow over it.
      const sessionFirst = markChatterSeen(m.channel, m.user)
      if (sessionFirst && !m.isFirstMsg) {
        div.classList.add('hs-first-msg')
      }
    }
    // Twitch first-msg flag — brand new user to the channel (not just this session)
    if (m.isFirstMsg) {
      div.classList.add('hs-mc-first-msg')
    }
    // Cleared by mod (timeout/ban/delete) — Twitch-native dim + strikethrough on offending content
    if (m.cleared && dimTimeouts) {
      div.classList.add('hs-mc-msg-cleared')
      if (m.clearedReason) div.title = m.clearedReason
    }
    // Keyword highlight — message text matches a user-defined term
    if (keywordHighlightsRegex && m.text && keywordHighlightsRegex.test(m.text)) {
      div.classList.add('hs-kw-match')
    }
    // Reply context bar (Chatterino-style) — all values escaped via escapeHtml
    const replyLower = (m.replyTo && m.replyTo.user) ? m.replyTo.user.toLowerCase() : ''
    // Paint the reply target's name with their 7TV cosmetic — same person, same
    // paint as their own messages. Twitch carries reply-parent-user-id; Kick
    // (no parent id) falls back to the name→uid map. data-uid lets
    // updateCosmeticsInPlace repaint it once the cosmetic batch lands.
    const replyUid = (m.replyTo && (m.replyTo.userId || knownUserIds.get(replyLower))) || ''
    const replyPaint = replyUid ? userPaintStyle(replyUid, replyLower) : ''
    const replyStyle = replyPaint || `color:${mentionColor(replyLower)}`
    const replyUidAttr = replyUid ? ` data-uid="${escapeHtml(replyUid)}"` : ''
    const replyBar = (m.replyTo && m.replyTo.user) ? `<div class="hs-mc-reply-ctx" title="${escapeHtml(m.replyTo.user)}: ${escapeHtml(m.replyTo.text || '')}">&#8618; Replying to <a href="https://heatsync.org/user/${encodeURIComponent(m.replyTo.user)}" target="_blank" class="hs-mc-user hs-mc-reply-user" data-username="${escapeHtml(replyLower)}"${replyUidAttr} style="${replyStyle}">@${escapeHtml(m.replyTo.user)}</a>${m.replyTo.text ? ': ' + escapeHtml(m.replyTo.text.length > 80 ? m.replyTo.text.slice(0, 80) + '...' : m.replyTo.text) : ''}</div>` : ''
    // Redeem label — look up reward title from Hermes cache
    let redeemLabel = ''
    if (m.redeemed && m.rewardId) {
      const reward = redeemTitleMap.get(m.rewardId)
      redeemLabel = reward
        ? `<span class="hs-mc-system-text hs-mc-redeem-label">\u25C6 ${escapeHtml(reward.title)} \u00B7 ${Number(reward.cost).toLocaleString()} pts</span>`
        : `<span class="hs-mc-system-text hs-mc-redeem-label">\u25C6 channel point redeem</span>`
    } else if (m.isHighlighted) {
      redeemLabel = `<span class="hs-mc-system-text hs-mc-highlight-label">\u2728 highlighted message</span>`
    }
    // USERNOTICE system line (all values go through escapeHtml — same pattern as existing innerHTML above)
    const systemLine = (m.systemMsg ? `<span class="hs-mc-system-text">${escapeHtml(m.systemMsg)}</span>` : '') + redeemLabel
    // Skip the date-format work entirely when the timestamp won't render —
    // formatTimeFromTs builds a Date per call, and at 100msg/s that's free CPU
    // we can give back when timestamps are off.
    const showTs = timestampsEnabled || tabId === 'mentions';
    const ts = showTs ? formatTimeFromTs(m.time) : '';
    const tsHtml = ts ? `<span class="hs-mc-ts">${ts}</span>` : '';
    const msgBody = (m.type === 'usernotice' || m.type === 'notice') && !m.text
      ? `${tsHtml}${systemLine}`
      : m.type === 'notice'
      ? `${tsHtml}<span class="hs-mc-text">${processedText}</span>`
      : m.isAction
      ? `${tsHtml}${systemLine}${platformBadge}${scBadge}${bitsBadge}${badges}${avatarHtml}${userLink}${channelSpan} <span class="hs-mc-text" style="color:${sanitizeColor(m.color || '#fff')};font-style:italic">${processedText}</span>${stickerHtml}`
      : `${tsHtml}${systemLine}${platformBadge}${scBadge}${bitsBadge}${badges}${avatarHtml}${userLink}${channelSpan}: <span class="hs-mc-text">${processedText}</span>${stickerHtml}`
    div.innerHTML = `${replyBar}${msgBody}`;
    // Correct emote states based on current inventory + blocked (cached HTML
    // may have stale states). String-includes gate skips the querySelectorAll
    // walk on the >95% of msgs that don't contain heatsync emotes — the gate
    // is a single substring scan, the QSA was iterating div subtree.
    if (processedText.includes('data-source="heatsync"')) reconcileHeatsyncEmoteStates(div)
    // Reply button for threading (Twitch/Kick — YT has no native thread id,
    // so we'd render an @-mention reply, but the YT message renderer reuses
    // videoId as id which collides across messages; suppress on YT for now).
    if (m.id && m.platform !== 'youtube') {
      div.dataset.msgId = m.id
      div.dataset.msgUser = m.user
      div.dataset.msgChannel = m.channel || ''
      div.dataset.msgPlatform = m.platform || ''
      // Mark self-messages so the mod hover toolbar can skip them without
      // re-deriving currentUsername (which may be null pre-auth). Inlined
      // compare — the `isOwn` const above is scoped to the !_renderedHtml
      // branch, so it's undefined when the cached-html path is taken.
      if (m.user && currentUsername && m.user.toLowerCase() === currentUsername.toLowerCase()) {
        div.dataset.msgSelf = '1'
      }
      const replyBtn = document.createElement('button')
      replyBtn.className = 'hs-mc-reply-btn'
      replyBtn.textContent = '↩'
      replyBtn.title = 'Reply'
      div.appendChild(replyBtn)
    }
    // Reply-thread linkage for hover highlight
    if (m.replyTo) {
      if (m.replyTo.id) div.dataset.replyId = m.replyTo.id
      if (m.replyTo.threadId) div.dataset.replyThreadId = m.replyTo.threadId
    }
    return div;
  }

  // LRU cache for processYtEmotes' combined regex. Pattern key is the joined
  // alt-text alternation; same emote-set across many messages → same key →
  // one RegExp compile per unique set instead of per message.
  const _YT_EMOTE_REGEX_CACHE_MAX = 64
  const _ytEmoteRegexCache = new Map()
  function _getYtCombinedRegex(joined) {
    const hit = _ytEmoteRegexCache.get(joined)
    if (hit) {
      // LRU touch — move to most-recent
      _ytEmoteRegexCache.delete(joined)
      _ytEmoteRegexCache.set(joined, hit)
      return hit
    }
    const re = new RegExp(`(<[^>]*>)|(${joined})`, 'g')
    _ytEmoteRegexCache.set(joined, re)
    if (_ytEmoteRegexCache.size > _YT_EMOTE_REGEX_CACHE_MAX) {
      const oldest = _ytEmoteRegexCache.keys().next().value
      _ytEmoteRegexCache.delete(oldest)
    }
    return re
  }

  // Process YouTube emotes (inline emoji images from innertube)
  // preEscaped=true when input is already HTML-escaped (chained after processEmotes)
  function processYtEmotes(text, emotes, preEscaped) {
    if (!emotes || emotes.length === 0) return preEscaped ? text : escapeHtml(text)

    let result = preEscaped ? text : escapeHtml(text)

    // Build replacement map: escaped alt text → img HTML
    const replacements = new Map()
    const altPatterns = []
    for (const emote of emotes) {
      const url = typeof emote.url === 'string' ? emote.url.trim() : ''
      const alt = typeof emote.alt === 'string' ? emote.alt : ''
      if (!alt || !url || !(url.startsWith('http') || url.startsWith('//'))) continue
      // Don't skip names with `<` — escapeHtml() handles them correctly and emotes
      // like `<3`, `<3` need to render. (Alt is set via escaped attribute below.)
      const escaped = escapeHtml(alt)
      if (replacements.has(escaped)) continue
      const imgHtml = `<img src="${escapeHtml(url)}" alt="${escaped}" class="hs-mc-emote" loading="lazy" decoding="async" style="height:1.2em;vertical-align:middle;" />`
      replacements.set(escaped, imgHtml)
      altPatterns.push(escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    }

    // Single-pass replacement that skips HTML tags — prevents matching inside
    // attributes of already-rendered emote/emoji spans from processEmotes.
    // RegExp compile is the slow step: cached by joined pattern so the same
    // emote-set across many YT messages reuses a single compiled instance.
    if (altPatterns.length > 0) {
      const combined = _getYtCombinedRegex(altPatterns.join('|'))
      result = result.replace(combined, (match, htmlTag) => {
        if (htmlTag) return htmlTag
        return replacements.get(match) || match
      })
    }

    // Clean up escaped HTML img tag fragments (from emotes with HTML alt text)
    if (result.includes('&lt;img')) {
      result = result.replace(/&lt;img\b(?:[^]*?(?:\/&gt;|&gt;)|[^<]*)/g, '')
    }
    return result
  }

  // A mentioned user who hasn't spoken in this channel yet has no entry in
  // knownColors, so their @mention / reply link would render flat white. Resolve
  // their color asynchronously (heatsync → twitch → hash palette, same as input
  // chips) and repaint every visible mention/reply anchor for them in place.
  const _mentionColorPending = new Set()
  function resolveMentionColor(lower) {
    if (!lower || _mentionColorPending.has(lower)) return
    if (typeof hsResolveUserColor !== 'function') return
    _mentionColorPending.add(lower)
    hsResolveUserColor(lower).then(c => {
      _mentionColorPending.delete(lower)
      if (!c) return
      const safe = sanitizeColor(c)
      let esc
      try { esc = CSS.escape(lower) } catch { esc = lower }
      document.querySelectorAll(
        `a.hs-mc-mention[data-username="${esc}"], a.hs-mc-reply-user[data-username="${esc}"]`
      ).forEach(a => {
        // a 7TV paint cosmetic outranks a flat color — never overwrite it
        const uid = a.dataset.uid
        if (uid && getMcPaintStyle(uid)) return
        a.style.color = safe
      })
    }).catch(() => { _mentionColorPending.delete(lower) })
  }
  // Sanitized color for a mentioned user. Returns a known color synchronously
  // (seen this session, or cached from a prior lookup); otherwise queues the
  // async resolve+repaint and falls back to white until it lands.
  function mentionColor(lower) {
    let c = knownColors.get(lower)
    if (!c && typeof _hsUserColorCache !== 'undefined') c = _hsUserColorCache.get(lower) || null
    if (c) return sanitizeColor(c)
    resolveMentionColor(lower)
    return '#fff'
  }

  // Highlight @mentions and bare known usernames in rendered chat HTML.
  // Splits on tags so substitution only happens in text segments.
  // Applies 7TV paint cosmetics if the mentioned user's userId + paint are cached.
  function highlightMentionsInHtml(html) {
    if (!html || (!html.includes('@') && knownColors.size === 0)) return html
    const parts = html.split(/(<[^>]+>)/)
    for (let i = 0; i < parts.length; i += 2) {
      const seg = parts[i]
      if (!seg) continue
      parts[i] = seg.replace(
        /(^|[\s.,!?;:()\[\]"'])(@?)([A-Za-z0-9_]{3,25})(?=$|[\s.,!?;:()\[\]"'])/g,
        (m, lead, at, name) => {
          const lower = name.toLowerCase()
          const known = knownColors.has(lower)
          if (!at && !known) return m
          // @mentions resolve a color even for users we haven't seen (async);
          // bare known names already have one in knownColors.
          const color = at ? mentionColor(lower) : sanitizeColor(knownColors.get(lower) || '#fff')
          const safeName = escapeHtml(name)
          const safeLower = escapeHtml(lower)
          const uid = knownUserIds.get(lower) || ''
          let style = `color:${color}`
          let uidAttr = ''
          if (uid) {
            uidAttr = ` data-uid="${escapeHtml(uid)}"`
            if (!mcUserCosmetics.has(uid)) queueMcCosmeticsLookup(uid)
            const paint = getMcPaintStyle(uid)
            if (paint) style = paint
          }
          return `${lead}<a href="https://heatsync.org/user/${encodeURIComponent(lower)}" target="_blank" class="hs-mc-user hs-mc-mention" data-username="${safeLower}"${uidAttr} style="${style}">${at}${safeName}</a>`
        }
      )
    }
    return parts.join('')
  }

  // Show "new" button for static tabs (activity/feed) — points up since newest is at top
  function showStaticNewButton() {
    const newBtn = document.getElementById('hs-mc-new-msgs');
    if (!newBtn) return;
    newMessageCount++;
    newBtn.innerHTML = `<span class="hs-arrow-down" style="transform:rotate(180deg)">▼</span> ${newMessageCount} new`;
    newBtn.style.display = 'flex';
  }

  // Scroll helper — reused by both renderMessages and appendMessage
  function scrollMsgsToBottom(msgsEl) {
    const newBtn = document.getElementById('hs-mc-new-msgs');
    newMessageCount = 0;
    if (newBtn) newBtn.style.display = 'none';
    if (isScrolledUp) return;
    // Single sync write — reading scrollHeight forces layout flush so the
    // new content's height is reflected before we set scrollTop. The +rAF
    // catches the rare case where layout settles a frame later (e.g. font
    // metrics changing post-decode). Late image loads / box changes are
    // covered by the capture-phase load+error delegation and ResizeObserver
    // wired in the scroll-listener block above — no need to scan
    // .hs-mc-emote and attach per-image listeners (was O(N) per call,
    // duplicated by delegation, and leaked listeners on rapid bursts).
    isProgrammaticScroll = true;
    msgsEl.scrollTop = msgsEl.scrollHeight + 10000;
    cleanup.raf(() => {
      if (!isScrolledUp) msgsEl.scrollTop = msgsEl.scrollHeight + 10000;
      isProgrammaticScroll = false;
    });
  }

  // Incremental append for single messages on the active tab (hot path)
  // Returns true if handled, false if full rebuild needed
  // Check if a tab has multiple platform sources active (needs fair merge)
  let _multiPlatformRenderTimer = null
  function isMultiPlatformTab(tabId) {
    if (tabId === 'live') {
      const curCh = getLiveChannel()
      let count = 0
      if (curCh && irc?.getMessages(curCh)?.length) count++
      if (curCh && kickChat?.getMessages(curCh)?.length) count++
      if ((channelYtMessages.get('__live_yt_auto__')?.length) || 0) count++
      if (count < 2) {
        // Also check config-linked platforms
        const linked = config.channels.find(ch => (ch.twitch === curCh || ch.kick === curCh))
        if (linked?.kick && kickChat?.getMessages(linked.kick)?.length) count++
        if (linked?.youtube && channelYtMessages.get(linked.id)?.length) count++
      }
      return count > 1
    }
    const ch = getChannelById(tabId)
    if (!ch) return false
    let count = 0
    if (ch.twitch && irc?.getMessages(ch.twitch)?.length) count++
    if (ch.kick && kickChat?.getMessages(ch.kick)?.length) count++
    // own linked YT only — __live_yt_auto__ no longer merges into per-channel
    // tabs (mirrors renderMessages bleed fix)
    const ytMsgs = channelYtMessages.get(tabId)?.length || 0
    if (ytMsgs) count++
    return count > 1
  }

  // ─── render-time content filters ──────────────────────────────────────
  // Hidden at render, kept in buffers — toggling off un-hides retroactively.
  const _BOT_NAMES = new Set(['nightbot', 'streamelements', 'moobot', 'fossabot', 'streamlabs', 'wizebot', 'botrix', 'sery_bot', 'soundalerts', 'pokemoncommunitygame', 'kofistreambot', 'blerp'])
  let _muteKeywordsRegex = null
  function rebuildMuteKeywordsRegex() {
    const terms = getSetting('hs_mute_keywords').split(/\n/).map(function(t) { return t.trim() }).filter(Boolean)
    if (!terms.length) { _muteKeywordsRegex = null; return }
    const escaped = terms.map(function(t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') })
    try { _muteKeywordsRegex = new RegExp(escaped.join('|'), 'i') } catch { _muteKeywordsRegex = null }
  }
  // Read the content-filter settings once per render pass — isMsgFiltered
  // runs per message in the render hot path (up to 1500 msgs per render).
  function _filterFlags() {
    return {
      bots: getSetting('hideBots'),
      cmds: getSetting('hideCommands'),
      dups: getSetting('hideDuplicates'),
    }
  }
  function isMsgFiltered(m, f) {
    if (!m || m.type === 'stream-event' || m.inlineNotifType) return false
    const u = m.user ? m.user.toLowerCase() : ''
    if (u && u === currentUsername) return false // never hide own messages
    if (u && f.bots && _BOT_NAMES.has(u)) return true
    if (typeof m.text !== 'string') return false
    if (f.cmds && m.text.charCodeAt(0) === 33) return true
    if (_muteKeywordsRegex && _muteKeywordsRegex.test(m.text)) return true
    return false
  }
  const _lastMsgTextByTab = new Map()

  function appendMessage(msg, tabId) {
    if (editingChannel) return false;
    // Hidden by share-dedupe (real USERNOTICE replaced our synthetic)
    if (msg?.hidden) return true;
    // Skip live append while profile card is open — buffer keeps the msg, restored on close
    if (typeof activeProfileCard !== 'undefined' && activeProfileCard) return true;
    if (isScrolledUp || currentTab !== tabId) return false;

    // Platform filter: skip messages for muted platforms (single-platform tab path)
    if (msg.platform && isPlatformFilterTab(tabId)) {
      const k = msg.platform === 'youtube' ? 'youtube' : msg.platform;
      if (getPlatformFilter(tabId)[k] === false) return true;
    }

    // Content filters — hidden at render, buffers keep the message
    const _ff = _filterFlags();
    if (isMsgFiltered(msg, _ff)) return true;
    if (typeof msg.text === 'string' && _ff.dups) {
      if (_lastMsgTextByTab.get(tabId) === msg.text) return true;
      _lastMsgTextByTab.set(tabId, msg.text);
    }

    // Multi-platform tabs: skip appendMessage (trimChildren is platform-blind
    // and lets the fastest source push others out). Debounce to renderMessages
    // which has fair per-platform capping.
    if (isMultiPlatformTab(tabId)) {
      if (!_multiPlatformRenderTimer) {
        _multiPlatformRenderTimer = cleanup.raf(() => {
          _multiPlatformRenderTimer = null
          renderMessages(currentTab)
        })
      }
      return true // tell caller we handled it
    }

    const msgsEl = document.getElementById('hs-mc-messages');
    if (!msgsEl) return false;

    // Remove "no messages" placeholder
    const empty = msgsEl.querySelector('.hs-mc-empty');
    if (empty) empty.remove();

    // Compute key first so we can skip if a node with this key already exists
    // (IRC reconnect, replay echo, dual-send race — all paths benefit from
    // a single guard instead of relying on each caller to dedup). Direct
    // iteration vs. CSS attr selector — CSS.escape encodes for identifier
    // grammar, not attribute-value grammar, so a key like "3:@user:t:Tr" was
    // producing a selector that didn't match the literal dataset value and
    // the guard silently failed.
    const msgKeyStr = `${_renderEpoch}:${stableMsgId(msg)}`
    if (_msgKeyIndex.has(msgKeyStr)) return true

    const div = buildMessageDiv(msg, tabId);
    if (!div) return false;
    // Tag with the same msgKey renderMessages uses, so a later tab switch into a
    // multi-platform view can prefix-match this DOM and avoid a one-shot rebuild.
    div.dataset.msgKey = msgKeyStr
    // Strict alternation: append flips from last sibling's zebra. Append-only path
    // always alternates cleanly. Bigger-tier than hash (which only ~50% alternates).
    if (zebraEnabled && msg.type !== 'stream-event' && msg.type !== 'feed-post' && msg.type !== 'inline-dm' && msg.type !== 'moment') {
      const prev = msgsEl.lastElementChild
      const prevZ = prev?.classList.contains('hs-mc-zebra') === true
      if (!prevZ) div.classList.add('hs-mc-zebra')
    }
    msgsEl.appendChild(div);
    _indexMessageDiv(div, msgKeyStr)

    // Trim oldest rows beyond the live-DOM cap (data buffer keeps more).
    trimMessagesEl(msgsEl, DOM_RENDER_CAP);

    // Apply mute to just this message — strip content for muted users.
    // msg.user is the sender; avoid a DOM scan to recompute it. Routes
    // through isUserMuted so a kick chatter whose linked twitch handle was
    // muted (or vice-versa) gets stripped on either platform.
    const username = msg.user ? String(msg.user).toLowerCase() : '';
    if (username && isUserMuted(username, msg.platform)) {
      stripMcMutedMessage(div);
    }

    // No updateTabBadges() here: it only refreshes the mentions/whispers/feed
    // "unseen" badges, whose state changes solely via noteSeenEvent/bumpSeen
    // (both already call refreshSeenBadges). A plain incoming chat message can't
    // change it, so calling it per-append was 3 querySelectors/msg of pure waste.
    scrollMsgsToBottom(msgsEl);
    return true;
  }

  // Render epoch — bumps when external state invalidates already-rendered DOM
  // (emote data, settings that change visual output). Embedded in msgKey so the
  // diff-aware render in renderMessages forces a full rebuild after a bump
  // instead of treating identical content as already-rendered.
  let _renderEpoch = 0;

  // Full rebuild — used for tab switches, scroll resume, and initial load
  // Invalidate cached rendered HTML on all messages (when emote data changes)
  function clearRenderedHtmlCache() {
    const clearBuf = (msgs) => { for (const m of msgs) delete m._renderedHtml };
    if (irc?.channels) for (const [, buf] of irc.channels) clearBuf(buf.getAll());
    if (kickChat?.channels) for (const [, buf] of kickChat.channels) clearBuf(buf.getAll());
    clearBuf(mentionsBuffer);
    for (const msgs of channelYtMessages.values()) clearBuf(msgs);
    _renderEpoch++;
    // Tab caches are keyed by old epoch — drop them all so next switch
    // rebuilds at the new epoch instead of restoring stale-keyed children
    // that the diff would immediately wipe.
    _dropAllTabCaches();
  }

  // Bump render epoch WITHOUT clearing _renderedHtml. Used when late-arriving
  // out-of-band data (Twitch native badges, BTTV/FFZ/Chatterino bulk badge
  // maps) needs to re-flow into the DOM. The diff renderer skips identical
  // msgKeys, so a bare renderMessages after badge fetch is a no-op — bumping
  // the epoch forces a fresh build that recomputes badges while keeping
  // cached emote HTML on _renderedHtml.
  function bumpRenderEpoch() {
    _renderEpoch++;
    _dropAllTabCaches();
  }

  // Coalesce the late-data rebuild renders. On cold load, channel badges + the
  // BTTV/FFZ/Chatterino bulk badge maps + cosmetics arrive in rapid bursts, each
  // doing bumpRenderEpoch()+renderMessages() = a full rebuild = an image-reload
  // flash; 3 landed within 23ms on a busy channel (a visible strobe). Debounce so
  // a burst collapses to ONE rebuild. The epoch still increments per bump, so the
  // single coalesced render rebuilds with ALL the newly-arrived data.
  let _coalescedRenderTimer = null
  function scheduleCoalescedRender() {
    if (_coalescedRenderTimer !== null) return
    _coalescedRenderTimer = cleanup.setTimeout(() => {
      _coalescedRenderTimer = null
      try { renderMessages(currentTab) } catch {}
    }, 120)
  }

  // Surgical invalidation for a block/unblock of specific emote(s). The full
  // clearRenderedHtmlCache() bumps _renderEpoch, which re-keys EVERY message so
  // the next render (constant on live chat) tears down and rebuilds the whole
  // list — a visible whole-chat flash. block/unblockEmote already correct the
  // live DOM in-place, so we only need to (a) drop cached _renderedHtml on the
  // messages that actually reference these emotes, so a LATER rebuild reprocesses
  // them with current block state, and (b) drop other tabs' cached fragments so
  // they rebuild fresh on next visit. No epoch bump → current tab is untouched →
  // no flash.
  function invalidateRenderedForEmotes(names) {
    const list = Array.isArray(names) ? names : [names]
    const wanted = list.filter(Boolean)
    if (wanted.length === 0) return
    const clearBuf = (msgs) => {
      for (const m of msgs) {
        if (m._renderedHtml == null || !m.text) continue
        for (const n of wanted) { if (m.text.includes(n)) { delete m._renderedHtml; break } }
      }
    }
    if (irc?.channels) for (const [, buf] of irc.channels) clearBuf(buf.getAll())
    if (kickChat?.channels) for (const [, buf] of kickChat.channels) clearBuf(buf.getAll())
    clearBuf(mentionsBuffer)
    for (const msgs of channelYtMessages.values()) clearBuf(msgs)
    _dropAllTabCaches()
  }

  // Merge multiple platform sources into ~150 messages with proportional
  // interleaving. Each platform's messages maintain internal chronological
  // order, but platforms are woven together evenly so no single source
  // dominates any region of the output — even when their time ranges
  // don't overlap (e.g. IRC history from hours ago + YT from seconds ago).
  function fairMerge(sources) {
    if (MC_DEBUG) log('fairMerge sources:', sources.map(s => s.length))
    const limit = DOM_RENDER_CAP
    const active = sources.filter(s => s.length > 0)
    if (active.length === 0) return []
    if (active.length === 1) return active[0].slice(-limit)

    // Co-live detection. When every source's newest msg lands within ~10 min
    // of each other AND is fresh (<1h old), both platforms are streaming now
    // — a firehose twitch can drown a trickle YT/kick, so apply the
    // proportional per-source cap to preserve fairness. Otherwise (offline
    // channel with sparse recent traffic, or sources timestamps far apart)
    // let chronological order rule so older historical msgs from a sparse
    // source don't get amputated by a too-small slice(-250).
    const maxTimes = active.map(s => s[s.length - 1]?.time || 0)
    const newestMax = Math.max(...maxTimes)
    const oldestMax = Math.min(...maxTimes)
    const CO_LIVE_WINDOW_MS = 10 * 60 * 1000
    const RECENT_THRESHOLD_MS = 60 * 60 * 1000
    const coLive = (newestMax - oldestMax) < CO_LIVE_WINDOW_MS && newestMax > Date.now() - RECENT_THRESHOLD_MS

    const pool = []
    if (coLive) {
      // Anti-drown WITHOUT retroactive eviction. The old proportional cap
      // (ceil(limit/active.length)) re-sliced every source whenever active
      // count changed — so the moment a quiet platform (e.g. YouTube) started
      // trickling in, active went 2→3, twitch's share dropped 250→167, and
      // ~80 already-visible rows vanished mid-stream. Instead: guarantee each
      // source a small recency FLOOR (so a firehose can't fully bury a
      // trickle), then fill the rest of the budget by pure global recency.
      // A new source going live now only costs its own floor (~40), filled by
      // its own fresh messages — no chunk of another platform disappears.
      const seen = new Set()
      const FLOOR = Math.min(40, Math.floor(limit / (active.length + 1)))
      for (const s of active) for (const m of s.slice(-FLOOR)) { if (!seen.has(m)) { seen.add(m); pool.push(m) } }
      const rest = []
      for (const s of active) for (const m of s) if (!seen.has(m)) rest.push(m)
      rest.sort(byTimeStable)
      const room = Math.max(0, limit - pool.length)
      for (const m of rest.slice(-room)) { seen.add(m); pool.push(m) }
    } else {
      for (const s of active) pool.push(...s.slice(-limit))
    }

    // Stable chronological sort. Secondary stableMsgId key keeps tied
    // timestamps deterministic across renders — without it, the insert-only
    // diff treats every flipped pair as a new insert and duplicates pile up.
    pool.sort(byTimeStable)
    return pool.slice(-limit)
  }
  function stableMsgId(m) {
    // Memoize on the message object — id/base36_id/user/time/text are immutable
    // once a chat object is buffered (the only .text rewrite is in irc.js history
    // ingest, before push). The render diff (msgKey, below) + fairMerge sort +
    // appendMessage all rebuild this same fallback string; on a 500-row co-live
    // tab that was tens of thousands of concats per render.
    return m._sid ?? (m._sid = m.id || m.base36_id || `${m.user || ''}:${m.time || ''}:${(m.text || '').slice(0, 32)}`)
  }
  function byTimeStable(a, b) {
    const dt = (a.time || 0) - (b.time || 0)
    if (dt !== 0) return dt
    const ka = stableMsgId(a), kb = stableMsgId(b)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  }

  // ─── Multistream auto-detect banner ─────────────────────────────────────
  // Tier 1: rely on heatsync server's resolveIdentity. If a streamer is live
  // on >=2 platforms and the user hasn't already linked them in config.channels,
  // surface a one-click "link channels" suggestion. Right-click dismisses
  // permanently for that channel pair.
  let _multistreamDismissed = null
  let _multistreamLastChecked = ''
  let _multistreamLastResult = '' // 'shown' | 'hidden' — sticky per channel/key
  async function loadMultistreamDismissed() {
    if (_multistreamDismissed) return _multistreamDismissed
    try {
      const data = await chrome.storage.local.get('hs_multistream_dismissed')
      _multistreamDismissed = new Set(data.hs_multistream_dismissed || [])
    } catch { _multistreamDismissed = new Set() }
    return _multistreamDismissed
  }
  function persistMultistreamDismissed() {
    try {
      chrome.storage.local.set({ hs_multistream_dismissed: [..._multistreamDismissed] })
    } catch {}
  }
  function hideMultistreamBanner() {
    const el = document.getElementById('hs-mc-multistream-banner')
    if (el) { el.hidden = true; el.replaceChildren() }
  }
  async function maybeShowMultistreamBanner(channelName, platform) {
    const el = document.getElementById('hs-mc-multistream-banner')
    if (!el) return
    if (!channelName) { hideMultistreamBanner(); return }
    const key = `${platform || 'auto'}:${channelName.toLowerCase()}`
    // Avoid redundant API calls when the user re-enters the same channel tab
    // — track last result per key so a 'hidden' decision sticks until channel changes.
    if (_multistreamLastChecked === key) {
      if (_multistreamLastResult === 'shown' && !el.hidden) return
      if (_multistreamLastResult === 'hidden') return
    }
    _multistreamLastChecked = key
    const dismissed = await loadMultistreamDismissed()
    if (_multistreamLastChecked !== key) return
    if (dismissed.has(key)) { _multistreamLastResult = 'hidden'; hideMultistreamBanner(); return }
    if (typeof resolveIdentity !== 'function') { _multistreamLastResult = 'hidden'; hideMultistreamBanner(); return }
    const res = await resolveIdentity(channelName, platform ? { platform } : {})
    if (_multistreamLastChecked !== key) return
    if (!res?.ok || !res.identity) { _multistreamLastResult = 'hidden'; hideMultistreamBanner(); return }
    const id = res.identity
    const liveOn = res.liveOn || []
    if (liveOn.length < 2) { _multistreamLastResult = 'hidden'; hideMultistreamBanner(); return }
    // Already linked in config? Skip.
    const lower = channelName.toLowerCase()
    const alreadyLinked = config.channels.some(ch => {
      const t = ch.twitch?.toLowerCase()
      const k = ch.kick?.toLowerCase()
      const matchesThis = (t === lower || k === lower ||
        (id.twitch && t === id.twitch.toLowerCase()) ||
        (id.kick && k === id.kick.toLowerCase()))
      if (!matchesThis) return false
      // Linked = at least 2 of {twitch,kick,youtube} populated
      let count = 0
      if (ch.twitch) count++
      if (ch.kick) count++
      if (ch.youtube) count++
      return count >= 2
    })
    if (alreadyLinked) { _multistreamLastResult = 'hidden'; hideMultistreamBanner(); return }
    // Build banner
    const platLabel = (p) => p === 'twitch' ? 'Twitch' : p === 'kick' ? 'Kick' : p === 'youtube' ? 'YouTube' : p
    const otherPlatforms = liveOn.filter(p => p !== platform)
    const display = res.profile?.display_name || channelName
    _multistreamLastResult = 'shown'
    el.replaceChildren()
    el.hidden = false
    const text = document.createElement('span')
    text.className = 'hs-mc-multi-text'
    text.textContent = `${display} is also live on ${otherPlatforms.map(platLabel).join(' + ')}`
    const linkBtn = document.createElement('button')
    linkBtn.className = 'hs-mc-multi-link'
    linkBtn.textContent = 'link channels'
    linkBtn.addEventListener('click', (e) => {
      e.preventDefault()
      const entry = { id: `linked_${Date.now()}` }
      if (id.twitch) entry.twitch = id.twitch
      if (id.kick) entry.kick = id.kick
      if (id.youtube) entry.youtube = id.youtube
      config.channels.push(entry)
      saveConfig()
      try { updateTabBar() } catch {}
      hideMultistreamBanner()
    })
    const dismissBtn = document.createElement('button')
    dismissBtn.className = 'hs-mc-multi-dismiss'
    dismissBtn.textContent = '×'
    dismissBtn.title = 'dismiss (right-click also works)'
    const dismissNow = () => {
      _multistreamDismissed.add(key)
      persistMultistreamDismissed()
      hideMultistreamBanner()
    }
    dismissBtn.addEventListener('click', dismissNow)
    if (el._hsCtxDismiss) el.removeEventListener('contextmenu', el._hsCtxDismiss)
    const ctxHandler = (e) => { e.preventDefault(); dismissNow() }
    el._hsCtxDismiss = ctxHandler
    el.addEventListener('contextmenu', ctxHandler)
    el.append(text, linkBtn, dismissBtn)
  }

  // ── live-tab chat search / filter-by-user ─────────────────────────────────
  // Server-search + social tabs render their own content; every other tab (live
  // + per-channel) is an in-memory buffer the search bar filters locally and
  // instantly — no network round-trip.
  const _SERVER_TABS = new Set(['mentions', 'feed', 'whispers', 'discover', 'pinned', 'settings', 'add'])
  function isLiveSearchTab(id) { return typeof id === 'string' && !_SERVER_TABS.has(id) }
  // Active local-filter query for a live tab (trimmed, lowercased), else ''.
  function liveSearchQuery(id) {
    if (!isLiveSearchTab(id)) return ''
    const el = document.getElementById('hs-mc-search-input')
    return el ? el.value.trim().toLowerCase() : ''
  }
  // '@name' scopes to one user (name prefix); bare text matches username OR
  // message body. Substring, case-insensitive.
  function matchesLiveSearch(m, q) {
    if (!q) return true
    const user = String(m.user || m.display_name || '').toLowerCase()
    if (q[0] === '@') return user.startsWith(q.slice(1))
    return user.includes(q) || String(m.text || '').toLowerCase().includes(q)
  }

  // Upward infinite-scroll: when the user reaches the top, paint the next chunk
  // of OLDER buffered messages (already in the 3000-deep ring) by growing the
  // render window and re-running the SAME diff renderer — so indexing, zebra,
  // mutes, cosmetics and epoch-keying all stay correct by construction. Anchors
  // scroll so the viewport doesn't jump when rows prepend above it.
  function loadOlderScrollback() {
    if (!isScrolledUp) return; // only while the user is paused (scrolled up)
    if (currentTab === 'feed' || currentTab === 'settings' || currentTab === 'discover' || currentTab === 'pinned') return;
    if (_scrollbackWindow >= SCROLLBACK_MAX - DOM_RENDER_CAP) return; // at the depth ceiling
    const msgsEl = document.getElementById('hs-mc-messages');
    if (!msgsEl) return;
    // Try to grow the window, then check whether older rows actually appeared.
    // We don't pre-guard on a row count — rendered rows can sit just under the
    // cap (content filters, fair-merge) so a "< cap" test would false-bail one
    // short. Instead: bump, render, and revert if nothing older was available.
    const before = msgsEl.children.length;
    const prevWindow = _scrollbackWindow;
    const oldH = msgsEl.scrollHeight;
    const oldTop = msgsEl.scrollTop;
    _scrollbackWindow = Math.min(_scrollbackWindow + SCROLLBACK_STEP, SCROLLBACK_MAX - DOM_RENDER_CAP);
    isProgrammaticScroll = true;
    try { renderMessages(currentTab, { bypassScrollPause: true }); } catch (_) {}
    if (msgsEl.children.length > before) {
      // Anchor: keep the previously-visible content under the same viewport
      // offset (rows added above shift everything down by the height delta).
      msgsEl.scrollTop = oldTop + (msgsEl.scrollHeight - oldH);
    } else {
      _scrollbackWindow = prevWindow; // buffer exhausted — don't inflate uselessly
    }
    cleanup.raf(() => { isProgrammaticScroll = false });
  }

  function renderMessages(id, opts) {
    if (editingChannel) return;
    // Idempotent — ensures mod toolbar hover works even when extension reloads
    // mid-session (the overlay-init setTimeout doesn't re-fire).
    const _msgsForMod = document.getElementById('hs-mc-messages')
    if (_msgsForMod && !_msgsForMod._hsModToolbarWired) wireModToolbarHover(_msgsForMod)
    // Pre-fetch isMod for the active channel so first hover is instant.
    if (typeof id === 'string' && /^[a-z0-9_]{2,40}$/i.test(id)) prefetchModFor(id)
    // Profile card overrides normal tab content while open
    if (typeof activeProfileCard !== 'undefined' && activeProfileCard) {
      renderProfileCardView();
      return;
    }
    // Social tabs have their own renderers — banner doesn't apply there
    if (id === 'feed') { hideMultistreamBanner(); renderFeed(); return; }
    if (id === 'whispers') { hideMultistreamBanner(); renderWhispersTab(); return; }
    if (id === 'discover') { hideMultistreamBanner(); renderDiscoverTab(); return; }
    if (id === 'pinned') { hideMultistreamBanner(); renderPinnedTab(); return; }
    if (id === 'settings') { hideMultistreamBanner(); renderSettingsTab(); return; }
    if (id === 'mentions') { hideMultistreamBanner(); }
    // Banner: streamer-tab only (live or per-channel)
    if (id === 'live') {
      const liveCh = getLiveChannel()
      maybeShowMultistreamBanner(liveCh, hostPlatform)
    } else if (id && id !== 'add' && !['mentions','feed','whispers','discover','pinned','settings'].includes(id)) {
      // Per-channel tab — id may be a username or a linked-tab id; resolve from config
      const ch = getChannelById(id)
      // YT-only channels: extract handle from the youtube URL so the banner can
      // resolve identity ("foo is also live on Twitch + Kick") for them too.
      let ytHandle = null
      if (ch?.youtube && !ch.twitch && !ch.kick) {
        const m = ch.youtube.match(/@([^/?]+)/)
        if (m) ytHandle = m[1]
      }
      const channelName = (ch && (ch.twitch || ch.kick)) || ytHandle || id
      const platHint = ch?.twitch ? 'twitch' : ch?.kick ? 'kick' : ytHandle ? 'youtube' : null
      maybeShowMultistreamBanner(channelName, platHint)
    }

    // If search is active on mentions tab, don't clobber search results
    if (id === 'mentions') {
      const searchInput = document.getElementById('hs-mc-search-input')
      if (searchInput && searchInput.value.trim()) return
    }

    const msgsEl = document.getElementById('hs-mc-messages');
    if (!msgsEl) return;

    // Consume the cache-restored flag exactly once per render, here — BEFORE the
    // scrolled-up early-return below. If we only reset it at the fast-path site
    // (further down), a scrolled-up render returns early and strands the flag
    // true; the NEXT render — for a different, uncached tab — then wrongly takes
    // the append-only "trust mounted DOM" path and bleeds the prior channel's
    // messages into the new view. Capturing it now scopes it to this one render.
    const justRestored = _cacheJustRestored;
    _cacheJustRestored = false;

    const newBtn = document.getElementById('hs-mc-new-msgs');

    // Scrolled-up readers normally don't re-render (live msgs just bump the
    // "N new" counter). loadOlderScrollback passes bypassScrollPause so it CAN
    // re-render while paused — to paint older rows — without yanking the view
    // (it anchors scroll itself afterward).
    if (isScrolledUp && !(opts && opts.bypassScrollPause)) {
      newMessageCount++;
      if (newBtn) {
        newBtn.innerHTML = `<span class="hs-arrow-down">▼</span> ${newMessageCount} new`;
        newBtn.style.display = 'flex';
      }
      return;
    }

    let msgs = [];

    if (id === 'mentions') {
      msgs = mentionsBuffer;
    } else if (id === 'add') {
      hideMultistreamBanner();
      renderAddChannelForm(msgsEl);
      return;
    } else if (id === 'live') {
      const curCh = getLiveChannel();
      const platNames = getLivePlatformNames()
      // Use platform-specific names (may differ from curCh if overridden)
      const twitchCh = platNames.twitch || curCh
      const kickCh = platNames.kick || curCh
      // Ensure channels are joined + history loaded
      if (twitchCh && irc && !irc.channels.has(twitchCh.toLowerCase())) irc.join(twitchCh)
      if (kickCh && kickChat && !kickChat.channels.has(kickCh.toLowerCase())) kickChat.join(kickCh)
      const ircMsgs = twitchCh ? (irc?.getMessages(twitchCh) || []) : []
      let kickMsgs = kickCh ? (kickChat?.getMessages(kickCh) || []) : []
      if (!kickMsgs.length && curCh) {
        // Check if any config entry links current channel to a Kick channel
        const linked = config.channels.find(ch => ch.twitch === curCh && ch.kick);
        if (linked) kickMsgs = kickChat?.getMessages(linked.kick) || [];
      }
      // On Kick, also pull messages from the URL channel (may differ from live override)
      if (!kickMsgs.length && hostPlatform === 'kick') {
        const urlCh = getCurrentChannel();
        if (urlCh && urlCh !== curCh) kickMsgs = kickChat?.getMessages(urlCh) || [];
      }
      // YouTube messages for live tab: auto-discovered or linked via config
      let ytMsgs = channelYtMessages.get('__live_yt_auto__') || [];
      if (!ytMsgs.length && curCh) {
        const linkedYt = config.channels.find(ch => (ch.twitch === curCh || ch.kick === curCh) && ch.youtube);
        if (linkedYt) ytMsgs = channelYtMessages.get(linkedYt.id) || [];
      }
      const filt = getPlatformFilter('live')
      msgs = fairMerge([
        filt.twitch ? ircMsgs : [],
        filt.kick ? kickMsgs : [],
        filt.youtube ? ytMsgs : []
      ])
    } else {
      // Channel tab — merge IRC + Kick + per-channel YouTube messages
      const ch = getChannelById(id);
      const twitchName = ch?.twitch;
      const kickName = ch?.kick;
      const ircMsgs = twitchName ? (irc?.getMessages(twitchName) || []) : [];
      const kickMsgs = kickName ? (kickChat?.getMessages(kickName) || []) : [];
      // YouTube ONLY from this channel's own explicit link. The global
      // __live_yt_auto__ bucket (the host page's auto-discovered YT, bound to
      // whatever stream is focused) must NOT merge into a per-channel tab — that
      // bleeds an unrelated stream's YT chat into this channel (e.g. a focused
      // jynxzi tab leaking into nl_kripp). __live_yt_auto__ is the live tab's
      // alone. Explicitly-linked channels already get their YT via
      // channelYtMessages[id]. See [[heatsync_yt_handle_guess_bleed]].
      const ytMsgs = channelYtMessages.get(id) || [];
      const filt = getPlatformFilter(id)
      msgs = fairMerge([
        filt.twitch ? ircMsgs : [],
        filt.kick ? kickMsgs : [],
        filt.youtube ? ytMsgs : []
      ])
    }

    // Merge follow stream events into channel + live tabs (went live,
    // switched game, went offline). Skip mentions: it's reserved for actual
    // @-mentions of the user, not followed-channel stream events. fairMerge's
    // full sort below puts everything at its correct chronological position
    // regardless of insertion order.
    if (id !== 'mentions' && activityEvents.length > 0 && msgs.length > 0) {
      const existingTexts = new Set(msgs.filter(m => m.type === 'stream-event').map(m => m.text))
      const missing = activityEvents.filter(e =>
        e.eventClass?.includes('event-follow') && !existingTexts.has(e.text)
      )
      if (missing.length > 0) {
        msgs.push(...missing)
        msgs.sort(byTimeStable)
      }
    }

    updateTabBadges()

    if (msgs.length === 0) {
      _clearMessageIndices()
      msgsEl.textContent = ''
      const empty = document.createElement('div')
      empty.className = 'hs-mc-empty'
      // First-run: a blank "no messages" panel teaches a new user nothing. When
      // no channels are configured, show an actionable CTA pointing at the core
      // multichat value (add streams across platforms) instead of a dead end.
      if (id === 'live' && !(config.channels && config.channels.length)) {
        const title = document.createElement('div')
        title.style.cssText = 'font-weight:600;margin-bottom:4px'
        title.textContent = 'add your streams'
        const sub = document.createElement('div')
        sub.style.cssText = 'opacity:.7;margin-bottom:10px'
        sub.textContent = 'merge twitch, kick + youtube chat in one panel'
        const btn = document.createElement('button')
        btn.style.cssText = 'cursor:pointer;padding:6px 12px;border:1px solid currentColor;background:transparent;color:inherit;font:inherit'
        btn.textContent = '+ add a channel'
        try { cleanup.addEventListener(btn, 'click', () => { try { switchTab('add') } catch (_) {} }) } catch (_) {}
        empty.appendChild(title); empty.appendChild(sub); empty.appendChild(btn)
      } else {
        empty.textContent = t('mc_no_messages')
      }
      msgsEl.appendChild(empty)
      return
    }

    // Stale-event guard: drop stream-events older than 2h so the 24h
    // event archive doesn't pile up at the top. Chat volume is bound by the
    // data buffers plus the DOM_RENDER_CAP live-row cap below.
    const STALE_WINDOW_MS = 2 * 60 * 60 * 1000
    let newestTime = 0
    for (let i = msgs.length - 1; i >= 0; i--) {
      const t = msgs[i]?.time
      if (t && t > newestTime) newestTime = t
      if (i < msgs.length - 50 && newestTime > 0) break
    }
    if (newestTime > 0) {
      const cutoff = newestTime - STALE_WINDOW_MS
      const first = msgs[0]
      if (first && first.time && first.time < cutoff) {
        msgs = msgs.filter(m => m.type !== 'stream-event' || !m.time || m.time >= cutoff)
      }
    }

    const _ff = _filterFlags()
    let toRender = msgs.filter(m => !m?.hidden && !isMsgFiltered(m, _ff))
    if (_ff.dups) {
      const out = []
      let prevText = null
      for (const m of toRender) {
        const txt = typeof m.text === 'string' ? m.text : null
        if (txt !== null && txt === prevText) continue
        if (txt !== null) prevText = txt
        out.push(m)
      }
      toRender = out
    }
    // Live-tab local filter: keep only matches (applied before the cap so the
    // cap bounds matches, not pre-filter rows). Empty result shows its own state.
    const _liveQ = liveSearchQuery(id)
    if (_liveQ) {
      toRender = toRender.filter(m => matchesLiveSearch(m, _liveQ))
      if (toRender.length === 0) {
        _clearMessageIndices()
        msgsEl.textContent = ''
        const empty = document.createElement('div')
        empty.className = 'hs-mc-empty'
        empty.textContent = 'no matches'
        msgsEl.appendChild(empty)
        return
      }
    }
    // Live tail is always DOM_RENDER_CAP; _scrollbackWindow adds older rows
    // when the user has scrolled to the top (loadOlderScrollback). Capped at
    // SCROLLBACK_MAX so the DOM stays bounded on low-RAM hardware.
    const _renderCap = Math.min(DOM_RENDER_CAP + _scrollbackWindow, SCROLLBACK_MAX)
    toRender = toRender.slice(-_renderCap)
    isProgrammaticScroll = true;

    // STABLE-ORDER RENDER:
    // mellen's bulletproof rules: (1) once a msg is in DOM, it never changes
    // position; (2) order is correct BEFORE showing; (3) zebra never flickers.
    //
    // strategy: insert-only diff.
    //   - PASS A: remove DOM children whose msgKey is no longer in `toRender`
    //     (msg trimmed off the buffer cap or filter-toggled out).
    //   - PASS B: walk `toRender` in order. for each msg, if DOM[domIdx] has
    //     the same msgKey, advance both. otherwise the desired msg is new —
    //     insertBefore DOM[domIdx] (or append if at end).
    //
    // existing DOM nodes stay put. new msgs slot in at chronologically
    // correct positions (because `toRender` is already chrono-sorted by
    // fairMerge below). no shuffling. no rebuild-from-prefix flash.
    // Shares stableMsgId's per-object memo — byte-identical to the old inline
    // fallback, only the _renderEpoch prefix is re-applied each render.
    const msgKey = (m) => `${_renderEpoch}:${stableMsgId(m)}`
    const desiredKeys = toRender.map(msgKey)
    const desiredSet = new Set(desiredKeys)

    // Neighbor-based zebra: each new insert flips from its DOM-prev sibling. Existing
    // DOM nodes keep their assigned class (no flicker), and the insert-only diff above
    // means tail appends always alternate cleanly. Mid-inserts may briefly double up at
    // the boundary but won't ripple to other msgs.
    const zebraOfInsert = (m, prevDiv) => {
      if (!zebraEnabled) return false
      if (m.type === 'stream-event' || m.type === 'feed-post' || m.type === 'inline-dm' || m.type === 'moment') return false
      if (!prevDiv) return false
      return !prevDiv.classList.contains('hs-mc-zebra')
    }

    // PASS 0: capture expanded emote stacks (mostly relevant for full rebuilds
    // when _renderEpoch increments — stacks would otherwise reset to collapsed).
    // Short-circuit the per-child scan: an expanded stack is rare (user has to
    // click one open), so one querySelector that stops at the first match beats
    // up to DOM_RENDER_CAP querySelectorAll walks every render. When none is
    // expanded, expandedStacks stays empty and the reapply below no-ops — same
    // result as scanning all children and finding nothing.
    const expandedStacks = []
    if (msgsEl.querySelector('.hs-mc-emote-stack.expanded')) {
      for (const msgDiv of msgsEl.children) {
        const mid = msgDiv.dataset?.msgId
        if (!mid) continue
        const stacks = msgDiv.querySelectorAll('.hs-mc-emote-stack')
        for (let s = 0; s < stacks.length; s++) {
          if (stacks[s].classList.contains('expanded')) expandedStacks.push([mid, s])
        }
      }
    }

    // CACHE-RESTORED FAST PATH: when restoreTabState just mounted a cached
    // fragment, trust its DOM order. Don't remove/reorder — only APPEND
    // msgs the user didn't see yet (those whose key isn't in DOM). This
    // eliminates the brief "reorder shimmer" from fairMerge proportions
    // shifting after new msgs arrived during the user's absence.
    if (justRestored) {
      const insertedKeys = new Set()
      for (let j = 0; j < toRender.length; j++) {
        const key = desiredKeys[j]
        if (insertedKeys.has(key)) continue
        insertedKeys.add(key)
        if (_msgKeyIndex.has(key)) continue // already in DOM somewhere — leave it
        const m = toRender[j]
        const div = buildMessageDiv(m, id)
        if (!div) continue
        div.dataset.msgKey = key
        const prev = msgsEl.lastElementChild
        if (zebraOfInsert(m, prev)) div.classList.add('hs-mc-zebra')
        msgsEl.appendChild(div)
        _indexMessageDiv(div, key)
      }
      if (msgsEl.children.length > toRender.length) trimMessagesEl(msgsEl, toRender.length)
      applyMcMutes()
      // Re-apply cleared (ban/timeout/delete) state to cached nodes that were
      // in a DocumentFragment while the mod action fired — buildMessageDiv was
      // skipped for these, so patch the class directly now.
      if (dimTimeouts) {
        const keyToMsg = new Map()
        for (let j = 0; j < toRender.length; j++) keyToMsg.set(desiredKeys[j], toRender[j])
        for (const child of msgsEl.children) {
          const k = child.dataset?.msgKey
          if (!k) continue
          const cm = keyToMsg.get(k)
          if (cm?.cleared) {
            child.classList.add('hs-mc-msg-cleared')
            if (cm.clearedReason && !child.title) child.title = cm.clearedReason
          }
        }
      }
      // Cached fragment was mounted as-is — restored messages bypassed
      // buildMessageDiv, so their 7TV paint/badge was never queued or applied
      // (cached HTML is paint-less). Re-apply for already-resolved users and
      // queue lookups for the rest; updateCosmeticsInPlace repaints via the
      // restored _uidIndex once each resolves.
      const _restoredCosUids = []
      for (const m of toRender) {
        if (!m.userId) continue
        if (mcUserCosmetics.has(m.userId)) _restoredCosUids.push(m.userId)
        else queueMcCosmeticsLookup(m.userId)
      }
      if (_restoredCosUids.length) updateCosmeticsInPlace([...new Set(_restoredCosUids)])
      cleanup.raf(() => { isProgrammaticScroll = false })
      if (!isScrolledUp && !(id === 'feed' || id === 'settings' || id === 'discover' || id === 'pinned')) {
        scrollMsgsToBottom(msgsEl)
      }
      return
    }

    // PASS A: index existing DOM by msgKey, dedup pre-existing duplicates,
    // detach yt-status notices for re-pin at end, drop everything else not in
    // desiredSet. Pre-existing dupes can exist when a prior buggy diff (or
    // a code path that bypassed the diff) inserted twice — heal them here so
    // the renderer is self-correcting across reloads of buggy state.
    const existingByKey = new Map()
    const detachedExtras = []
    for (const c of [...msgsEl.children]) {
      if (c.dataset?.hsYtStatus && c.dataset?.hsYtStatusTab === String(id)) {
        detachedExtras.push(c)
        c.remove() // yt-status pins aren't tracked in indices
        continue
      }
      const k = c.dataset?.msgKey
      if (k && desiredSet.has(k)) {
        if (existingByKey.has(k)) {
          _unindexMessageDiv(c) // pre-existing dupe — drop the second copy
          c.remove()
        } else {
          existingByKey.set(k, c)
        }
      } else {
        _unindexMessageDiv(c)
        c.remove()
      }
    }

    // Bulletproof sticky-bottom: if the user hasn't scrolled up via input,
    // we re-pin unconditionally. Geometric "wasAtBottom" snapshot was
    // unreliable — a width rewrap, image-load reflow, or content-visibility
    // resolve could shift scrollTop a few px and flip the gate to false even
    // though the user logically was at-bottom.
    const isStaticRender = id === 'feed' || id === 'settings' || id === 'discover' || id === 'pinned'

    // PASS B: walk desired list, MOVE existing nodes into position or insert
    // new ones. Crucially: when a desired key already lives in DOM at the
    // wrong position, we MOVE its node — never build a second one. This is
    // the bulletproof guarantee against duplicate-key accumulation.
    // Per-render insertedKeys set — even if two buffer entries collide on
    // stableMsgId (rare: same user, same ms post-pacer-commit, same text-
    // prefix), the second occurrence is skipped so DOM stays one-per-key.
    const insertedKeys = new Set()
    let domIdx = 0
    for (let j = 0; j < toRender.length; j++) {
      const key = desiredKeys[j]
      if (insertedKeys.has(key)) continue
      insertedKeys.add(key)
      const cur = msgsEl.children[domIdx]
      const existing = existingByKey.get(key)
      if (existing) {
        existingByKey.delete(key)
        if (cur !== existing) msgsEl.insertBefore(existing, cur || null)
        // Reused div skipped buildMessageDiv — re-queue its cosmetic so a prior
        // failed/absent lookup is retried (resolves on a later flush). Without
        // this, a frozen channel's restored buffer never re-attempts cosmetics.
        const _rm = toRender[j]
        if (_rm?.userId && !mcUserCosmetics.has(_rm.userId)) queueMcCosmeticsLookup(_rm.userId)
        domIdx++
        continue
      }
      // Build new msg div at correct position.
      const m = toRender[j]
      const div = buildMessageDiv(m, id)
      if (!div) continue
      div.dataset.msgKey = key
      const prevDiv = msgsEl.children[domIdx - 1] || null
      if (zebraOfInsert(m, prevDiv)) div.classList.add('hs-mc-zebra')
      msgsEl.insertBefore(div, cur || null)
      _indexMessageDiv(div, key)
      domIdx++
    }

    // Re-pin yt-status notices to the very end.
    for (const ex of detachedExtras) msgsEl.appendChild(ex)

    // Final safety net: hard-cap DOM so no future regression can OOM the tab.
    // toRender is already sliced to 500; anything beyond that + yt-status
    // pins is a leak. trimMessagesEl removes from the front (oldest first)
    // and keeps indices in sync.
    const hardCap = toRender.length + detachedExtras.length
    if (msgsEl.children.length > hardCap) trimMessagesEl(msgsEl, hardCap)

    // Re-apply expanded stacks (only relevant when full rebuild fired).
    for (const [mid, idx] of expandedStacks) {
      const m = msgsEl.querySelector(`.hs-mc-msg[data-msg-id="${CSS.escape(mid)}"]`)
      if (!m) continue
      const stacks = m.querySelectorAll('.hs-mc-emote-stack')
      if (stacks[idx]) stacks[idx].classList.add('expanded')
    }

    applyMcMutes()

    // Scroll behavior: re-pin if user hasn't paused. Static tabs (feed/
    // discover/pinned/settings) skip — they pin the newest at TOP, not
    // bottom. mellen's rule: scrollbar locked at bottom unless user
    // explicitly scrolls up.
    cleanup.raf(() => { isProgrammaticScroll = false })
    if (!isScrolledUp && !isStaticRender) {
      scrollMsgsToBottom(msgsEl)
    }
  }

  // Memoized: input color strings are bounded (Twitch colors per session are
  // a small set). Cache resets when readableNamesEnabled flips. boostReadability
  // does HSL math (parseInt x6, Math.max/min) — was running 2-3x per msg build.
  let _colorCacheReadable = readableNamesEnabled
  const _colorCache = new Map()
  function sanitizeColor(color) {
    if (_colorCacheReadable !== readableNamesEnabled) {
      _colorCache.clear()
      _colorCacheReadable = readableNamesEnabled
    }
    const hit = _colorCache.get(color)
    if (hit !== undefined) return hit
    let out
    if (!COLOR_RE.test(color)) out = '#ffffff'
    else out = readableNamesEnabled ? boostReadability(color) : color
    _colorCache.set(color, out)
    if (_colorCache.size > 500) _colorCache.delete(_colorCache.keys().next().value)
    return out
  }


  function renderAddChannelForm(msgsEl) {
    _clearMessageIndices()
    msgsEl.textContent = ''
    const wrapper = document.createElement('div')
    wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;color:#a8a8a8;font-size:13px;padding:20px;box-sizing:border-box;'

    const title = document.createElement('div')
    title.textContent = t('mc_add_channel')
    title.style.cssText = 'font-size:17px;font-weight:700;color:#ffffff;letter-spacing:.5px;'
    wrapper.appendChild(title)

    const desc = document.createElement('div')
    desc.textContent = t('mc_enter_platform')
    desc.style.cssText = 'font-size:13px;color:#808080;margin-bottom:2px;'
    wrapper.appendChild(desc)

    const makeRow = (label, placeholder) => {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;max-width:300px;'
      const lbl = document.createElement('span')
      lbl.textContent = label
      lbl.style.cssText = 'font-size:13px;font-weight:600;min-width:56px;color:#949494;text-transform:lowercase;'
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'hs-mc-ch-input'
      input.placeholder = placeholder
      // The visible label is a separate <span>, so the input itself is unlabeled
      // to assistive tech — name it explicitly (label is 'twitch'/'kick'/'youtube').
      input.setAttribute('aria-label', label)
      input.style.cssText = 'flex:1;background:#000;color:#fff;border:1px solid #808080;padding:6px 10px;border-radius:0;font-size:14px;outline:none;font-family:inherit;'
      // Stop YouTube/Kick keyboard shortcuts from stealing keystrokes
      input.addEventListener('keydown', (e) => e.stopPropagation())
      row.appendChild(lbl)
      row.appendChild(input)
      return { row, input }
    }

    const twitch = makeRow('twitch', t('mc_username_placeholder'))
    const kick = makeRow('kick', t('mc_username_placeholder'))
    const yt = makeRow('youtube', t('mc_username_url_placeholder'))

    wrapper.appendChild(twitch.row)
    wrapper.appendChild(kick.row)
    wrapper.appendChild(yt.row)

    // Error message (between inputs and buttons)
    const errEl = document.createElement('div')
    errEl.style.cssText = 'font-size:13px;color:#ff0000;display:none;'
    errEl.setAttribute('role', 'alert')
    wrapper.appendChild(errEl)

    const btnRow = document.createElement('div')
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:4px;'

    const makeMcBtn = (text, primary) => {
      const btn = document.createElement('button')
      btn.textContent = text
      const base = primary
        ? 'background:transparent;color:#ffffff;border:1px solid #ffffff;'
        : 'background:transparent;color:#808080;border:1px solid #808080;'
      btn.style.cssText = base + 'padding:6px 22px;border-radius:0;cursor:pointer;font-weight:600;font-size:14px;font-family:inherit;min-width:80px;transition:all .15s;'
      btn.addEventListener('mouseenter', () => {
        btn.style.background = '#ffffff'; btn.style.color = '#000000'
      })
      btn.addEventListener('mouseleave', () => {
        btn.style.background = 'transparent'
        btn.style.color = primary ? '#ffffff' : '#808080'
      })
      return btn
    }

    const addBtn = makeMcBtn('add', true)
    const cancelBtn = makeMcBtn('cancel', false)

    btnRow.appendChild(addBtn)
    btnRow.appendChild(cancelBtn)
    wrapper.appendChild(btnRow)

    msgsEl.appendChild(wrapper)

    cancelBtn.addEventListener('click', () => switchTab('live'))

    const showErr = (msg) => { errEl.textContent = msg; errEl.style.display = 'block'; }

    // Parse a typed/pasted value into a clean platform slug: strip a leading
    // @, and if the user pasted a platform URL (twitch.tv/xqc, kick.com/xqc,
    // popout/mod links) reduce it to just the slug. Without this, pasting a URL
    // or a name with trailing junk created a permanent dead tab that forever
    // showed nothing (Bug #9). A malformed remainder is rejected by the charset
    // check below — a name with spaces/slashes can never be a real channel.
    const parseTwitchLogin = (raw) => {
      let v = (raw || '').trim().replace(/^@/, '')
      const m = v.match(/twitch\.tv\/(?:popout\/|moderator\/)?([^/?#\s]+)/i)
      if (m) v = m[1]
      return v.toLowerCase()
    }
    const parseKickSlug = (raw) => {
      let v = (raw || '').trim().replace(/^@/, '')
      const m = v.match(/kick\.com\/([^/?#\s]+)/i)
      if (m) v = m[1]
      return v.toLowerCase()
    }

    const doAdd = () => {
      errEl.style.display = 'none'
      const twitchVal = parseTwitchLogin(twitch.input.value)
      const kickVal = parseKickSlug(kick.input.value)
      const ytVal = yt.input.value.trim() ? normalizeYtUrl(yt.input.value.trim()) : ''

      if (!twitchVal && !kickVal && !ytVal) {
        showErr(t('mc_enter_platform'))
        return
      }

      // Charset gate — a slug outside the platform's allowed character set can
      // never resolve to a real channel (twitch [a-z0-9_], kick adds '-'), so a
      // typo with spaces or a half-parsed URL is rejected here instead of
      // becoming a silent dead tab. Real channel names always pass.
      if (twitchVal && !/^[a-z0-9_]{1,25}$/.test(twitchVal)) {
        showErr(t('mc_invalid_name'))
        return
      }
      if (kickVal && !/^[a-z0-9_-]{1,25}$/.test(kickVal)) {
        showErr(t('mc_invalid_name'))
        return
      }

      const id = twitchVal || kickVal || ('yt-' + Date.now())
      const reserved = ['live', 'feed', 'mentions', 'whispers', 'discover', 'pinned', 'add', 'settings']
      if (reserved.includes(id)) {
        showErr(t('mc_reserved_name'))
        return
      }
      if (config.channels.some(c => c.id === id)) {
        showErr(t('mc_channel_exists'))
        return
      }
      // Check duplicate Twitch/Kick username across channels
      if (twitchVal && config.channels.some(c => c.twitch === twitchVal)) {
        showErr(t('mc_twitch_exists'))
        return
      }
      if (kickVal && config.channels.some(c => c.kick === kickVal)) {
        showErr(t('mc_kick_exists'))
        return
      }

      const channel = { id, twitch: twitchVal, kick: kickVal, youtube: ytVal }
      config.channels.push(channel)
      saveConfig()

      if (twitchVal) {
        irc?.join(twitchVal)
        try {
          chrome.runtime.sendMessage({ type: 'join_channel', platform: 'twitch', channel: twitchVal })
        } catch (e) { /* context invalidated */ }
      }
      if (kickVal) {
        kickChat?.join(kickVal)
      }
      if (ytVal) {
        youtubeLinks.set(id, { url: ytVal, videoId: '', channelName: '' })
        chrome.runtime.sendMessage({ type: 'youtube_ws_subscribe', url: ytVal, channelId: id }).catch(() => {})
      }

      updateTabBar()
      switchTab(id)
    }

    addBtn.addEventListener('click', doAdd)
    // Tab cycles inputs, Enter submits, Escape cancels
    const inputs = [twitch.input, kick.input, yt.input]
    inputs.forEach((inp, i) => {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault()
          inputs[(i + (e.shiftKey ? inputs.length - 1 : 1)) % inputs.length].focus()
        }
        if (e.key === 'Enter') doAdd()
        if (e.key === 'Escape') switchTab('live')
      })
      // Track user edits per-field so autofill never overwrites typed input
      inp.addEventListener('input', () => { inp.dataset.userEdited = '1' })
    })

    // Heatsync linkage status indicator (between rows and error)
    const linkStatus = document.createElement('div')
    linkStatus.style.cssText = 'font-size:13px;color:#808080;min-height:14px;font-family:ui-monospace,monospace;'
    wrapper.insertBefore(linkStatus, errEl)

    // Debounced autofill — when user types in any field, look up that name on
    // heatsync and prefill the OTHER fields if they haven't been edited.
    let _autofillGen = 0
    let _autofillTimer = null
    const _autofillCancelable = (handler) => {
      if (_autofillTimer) cleanup.clearTimeout(_autofillTimer)
      _autofillTimer = cleanup.setTimeout(handler, 500)
    }

    async function autofillFromName(name, sourcePlatform) {
      if (!name) { linkStatus.textContent = ''; return }
      const gen = ++_autofillGen
      linkStatus.textContent = 'checking heatsync…'
      linkStatus.style.color = '#808080'
      const res = (typeof resolveIdentity === 'function')
        ? await resolveIdentity(name, { platform: sourcePlatform })
        : { ok: false }
      if (gen !== _autofillGen) return
      if (!res?.ok) {
        linkStatus.textContent = res?.notFound ? 'no heatsync profile — fill manually' : 'couldn\'t reach heatsync'
        linkStatus.style.color = '#666'
        return
      }
      const id = res.identity
      const platforms = []
      // Fill ONLY empty + non-user-edited fields
      const fillIfBlank = (input, value, label) => {
        if (!value) return
        if (input.dataset.userEdited === '1' && input.value.trim()) return
        if (input.value.trim()) return
        input.value = value
        platforms.push(label)
      }
      fillIfBlank(twitch.input, id.twitch, 't')
      fillIfBlank(kick.input, id.kick, 'k')
      fillIfBlank(yt.input, id.youtube, 'yt')
      const linkedLabels = []
      if (id.twitch) linkedLabels.push('t')
      if (id.kick) linkedLabels.push('k')
      if (id.youtube) linkedLabels.push('yt')
      const liveLabels = res.liveOn?.length ? ` · live on ${res.liveOn.map(p => p === 'twitch' ? 't' : p === 'kick' ? 'k' : p).join(',')}` : ''
      linkStatus.style.color = '#53fc18'
      linkStatus.textContent = `✓ matched ${id.heatsync || name} on heatsync — linked: ${linkedLabels.join(',') || 'none'}${liveLabels}${platforms.length ? ` · autofilled: ${platforms.join(',')}` : ''}`
    }

    twitch.input.addEventListener('input', () => {
      const v = twitch.input.value.trim().replace(/^@/, '')
      if (v.length >= 2) _autofillCancelable(() => autofillFromName(v, 'twitch'))
    })
    kick.input.addEventListener('input', () => {
      const v = kick.input.value.trim().replace(/^@/, '')
      if (v.length >= 2) _autofillCancelable(() => autofillFromName(v, 'kick'))
    })

    // Auto-focus twitch input
    cleanup.raf(() => twitch.input.focus())
  }

  function removeChannel(tabId) {
    const ch = getChannelById(tabId);
    config.channels = config.channels.filter(c => c.id !== tabId);
    saveConfig();
    _dropTabCache(tabId);

    const twitchName = ch?.twitch;
    if (twitchName) irc?.part(twitchName);

    const kickName = ch?.kick;
    if (kickName) kickChat?.part(kickName);

    // Clean up per-channel sub tenure data to prevent stale map growth
    if (twitchName) subTenureMap.delete(twitchName.toLowerCase());
    if (kickName) subTenureMap.delete(kickName.toLowerCase());

    // Unsubscribe per-channel YouTube (pass URL as fallback if videoId not yet received)
    if (ch && ch.youtube) {
      const link = youtubeLinks.get(tabId);
      chrome.runtime.sendMessage({
        type: 'youtube_ws_unsubscribe',
        videoId: link?.videoId || '',
        url: ch.youtube,
        channelId: tabId,
      }).catch(() => {});
      youtubeLinks.delete(tabId);
      channelYtMessages.delete(tabId);
      // Clear YT watchdog state too — otherwise the 180s rejoin loop resurrects
      // a removed channel forever and periodically force-reconnects the shared
      // WS that every channel rides on.
      ytChanLastSeen.delete(tabId);
      ytChanRejoinAttempts.delete(tabId);
      ytSubscribedUrls.delete(tabId);
    }

    // Drop per-tab platform filter state so it can't leak across channel adds/removes
    if (platformFilters && platformFilters[tabId]) {
      delete platformFilters[tabId];
      saveUiSetting('platformFilters', platformFilters);
    }

    updateTabBar();
    if (currentTab === tabId) switchTab('live');
  }

  // Get platform overrides for the current live channel (or defaults from URL)
  function getLivePlatformNames() {
    const urlCh = getCurrentChannel()?.toLowerCase()
    if (!urlCh) return { twitch: '', kick: '', youtube: '' }
    const overrides = livePlatformMap[urlCh]
    return {
      twitch: overrides?.twitch ?? urlCh,
      kick: overrides?.kick ?? urlCh,
      // No YT fallback: a guessed youtube.com/@<urlCh>/live resolves to whoever
      // owns that handle (often a different person) and bleeds their live chat
      // into this channel. YouTube must be linked explicitly — same-name across
      // platforms is a safe assumption for Twitch/Kick, NOT for YouTube handles.
      youtube: overrides?.youtube ?? ''
    }
  }

  function saveLivePlatformMap() {
    chrome.storage.local.set({ hs_live_platform_map: livePlatformMap })
  }

  async function loadLivePlatformMap() {
    try {
      const data = await chrome.storage.local.get('hs_live_platform_map')
      if (data.hs_live_platform_map) livePlatformMap = data.hs_live_platform_map
    } catch {}
  }

  // Apply live platform overrides — join the correct channels on each platform
  function applyLivePlatformOverrides() {
    const names = getLivePlatformNames()
    if (names.twitch) irc?.join(names.twitch)
    if (names.kick) kickChat?.join(names.kick)
    if (names.youtube) {
      ytSubscribedUrls.set('__live_yt_auto__', names.youtube)
      ytChanLastSeen.set('__live_yt_auto__', Date.now())
      chrome.runtime.sendMessage({
        type: 'youtube_ws_subscribe', url: names.youtube, channelId: '__live_yt_auto__'
      }).catch(() => {})
    }
    renderMessages(currentTab)
  }

  function showEditLivePlatforms() {
    const urlCh = getCurrentChannel()?.toLowerCase()
    if (!urlCh) return
    editingChannel = true
    const names = getLivePlatformNames()

    const msgsEl = document.getElementById('hs-mc-messages')
    if (!msgsEl) return
    _clearMessageIndices()
    msgsEl.textContent = ''

    const wrapper = document.createElement('div')
    wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;color:#a8a8a8;font-size:13px;padding:20px;box-sizing:border-box;'

    const title = document.createElement('div')
    title.textContent = `edit live — ${urlCh}`
    title.style.cssText = 'font-size:17px;font-weight:700;color:#ffffff;letter-spacing:.5px;'
    wrapper.appendChild(title)

    const makeRow = (label, placeholder, value) => {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;max-width:300px;'
      const lbl = document.createElement('span')
      lbl.textContent = label
      lbl.style.cssText = 'font-size:13px;font-weight:600;min-width:56px;color:#949494;text-transform:lowercase;'
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'hs-mc-ch-input'
      input.placeholder = placeholder
      input.value = value || ''
      input.style.cssText = 'flex:1;background:#000;color:#fff;border:1px solid #808080;padding:6px 10px;border-radius:0;font-size:14px;outline:none;font-family:inherit;'
      input.addEventListener('keydown', (e) => e.stopPropagation())
      row.appendChild(lbl)
      row.appendChild(input)
      return { row, input }
    }

    const twitch = makeRow('twitch', 'username', names.twitch)
    const kick = makeRow('kick', 'username', names.kick)
    const yt = makeRow('youtube', 'url or @handle', names.youtube)
    wrapper.appendChild(twitch.row)
    wrapper.appendChild(kick.row)
    wrapper.appendChild(yt.row)

    const btnRow = document.createElement('div')
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:4px;'

    const makeMcBtn = (text, primary) => {
      const btn = document.createElement('button')
      btn.textContent = text
      const base = primary
        ? 'background:transparent;color:#ffffff;border:1px solid #ffffff;'
        : 'background:transparent;color:#808080;border:1px solid #808080;'
      btn.style.cssText = base + 'padding:6px 22px;border-radius:0;cursor:pointer;font-weight:600;font-size:14px;font-family:inherit;min-width:80px;transition:all .15s;'
      btn.addEventListener('mouseenter', () => { btn.style.background = '#ffffff'; btn.style.color = '#000000' })
      btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; btn.style.color = primary ? '#ffffff' : '#808080' })
      return btn
    }

    const saveBtn = makeMcBtn('save', true)
    const cancelBtn = makeMcBtn('cancel', false)
    const resetBtn = makeMcBtn('reset', false)
    btnRow.appendChild(saveBtn)
    btnRow.appendChild(cancelBtn)
    btnRow.appendChild(resetBtn)
    wrapper.appendChild(btnRow)
    msgsEl.appendChild(wrapper)

    cancelBtn.addEventListener('click', () => { editingChannel = false; switchTab('live') })

    resetBtn.addEventListener('click', () => {
      delete livePlatformMap[urlCh]
      saveLivePlatformMap()
      editingChannel = false
      applyLivePlatformOverrides()
      switchTab('live')
    })

    const doSave = () => {
      const tw = twitch.input.value.trim().toLowerCase().replace(/^@/, '')
      const ki = kick.input.value.trim().toLowerCase().replace(/^@/, '')
      const ytVal = yt.input.value.trim() ? normalizeYtUrl(yt.input.value.trim()) : ''

      livePlatformMap[urlCh] = { twitch: tw, kick: ki, youtube: ytVal }
      saveLivePlatformMap()
      editingChannel = false
      applyLivePlatformOverrides()
      switchTab('live')
    }

    saveBtn.addEventListener('click', doSave)
    // Enter in any input saves
    ;[twitch.input, kick.input, yt.input].forEach(inp => {
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave() } })
    })
    // Esc cancels
    wrapper.addEventListener('keydown', (e) => { if (e.key === 'Escape') { editingChannel = false; switchTab('live') } })
    twitch.input.focus()
  }

  function showEditChannelForm(tabId) {
    const ch = getChannelById(tabId);
    if (!ch) return;
    editingChannel = true;

    const msgsEl = document.getElementById('hs-mc-messages');
    if (!msgsEl) return;
    _clearMessageIndices();
    msgsEl.textContent = '';

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;color:#a8a8a8;font-size:13px;padding:20px;box-sizing:border-box;';

    const title = document.createElement('div');
    title.textContent = t('mc_edit_channel', [tabId]);
    title.style.cssText = 'font-size:17px;font-weight:700;color:#ffffff;letter-spacing:.5px;';
    wrapper.appendChild(title);

    const makeRow = (label, placeholder, value) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;max-width:300px;';
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = 'font-size:13px;font-weight:600;min-width:56px;color:#949494;text-transform:lowercase;';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'hs-mc-ch-input';
      input.placeholder = placeholder;
      input.value = value || '';
      input.style.cssText = 'flex:1;background:#000;color:#fff;border:1px solid #808080;padding:6px 10px;border-radius:0;font-size:14px;outline:none;font-family:inherit;';
      // Stop YouTube/Kick keyboard shortcuts from stealing keystrokes
      input.addEventListener('keydown', (e) => e.stopPropagation())
      row.appendChild(lbl);
      row.appendChild(input);
      return { row, input };
    };

    const twitch = makeRow('twitch', t('mc_username_placeholder'), ch.twitch);
    const kick = makeRow('kick', t('mc_username_placeholder'), ch.kick);
    const yt = makeRow('youtube', t('mc_username_url_placeholder'), ch.youtube);
    wrapper.appendChild(twitch.row);
    wrapper.appendChild(kick.row);
    wrapper.appendChild(yt.row);

    const errEl = document.createElement('div');
    errEl.style.cssText = 'font-size:13px;color:#ff0000;display:none;';
    errEl.setAttribute('role', 'alert');
    wrapper.appendChild(errEl);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:4px;';

    const makeMcBtn = (text, primary) => {
      const btn = document.createElement('button');
      btn.textContent = text;
      const base = primary
        ? 'background:transparent;color:#ffffff;border:1px solid #ffffff;'
        : 'background:transparent;color:#808080;border:1px solid #808080;';
      btn.style.cssText = base + 'padding:6px 22px;border-radius:0;cursor:pointer;font-weight:600;font-size:14px;font-family:inherit;min-width:80px;transition:all .15s;';
      btn.addEventListener('mouseenter', () => {
        btn.style.background = '#ffffff'; btn.style.color = '#000000';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = 'transparent';
        btn.style.color = primary ? '#ffffff' : '#808080';
      });
      return btn;
    };

    const saveBtn = makeMcBtn('save', true);
    const cancelBtn = makeMcBtn('cancel', false);
    btnRow.appendChild(saveBtn);
    btnRow.appendChild(cancelBtn);
    wrapper.appendChild(btnRow);
    msgsEl.appendChild(wrapper);

    cancelBtn.addEventListener('click', () => switchTab(tabId));
    const showErr = (msg) => { errEl.textContent = msg; errEl.style.display = 'block'; };

    const doSave = () => {
      errEl.style.display = 'none';
      const twitchVal = twitch.input.value.trim().toLowerCase().replace(/^@/, '');
      const kickVal = kick.input.value.trim().toLowerCase().replace(/^@/, '');
      const ytVal = yt.input.value.trim() ? normalizeYtUrl(yt.input.value.trim()) : '';

      if (!twitchVal && !kickVal && !ytVal) {
        showErr(t('mc_enter_platform'));
        return;
      }

      // Check duplicate twitch/kick (excluding self)
      if (twitchVal && config.channels.some(c => c !== ch && c.twitch === twitchVal)) {
        showErr(t('mc_twitch_exists'));
        return;
      }
      if (kickVal && config.channels.some(c => c !== ch && c.kick === kickVal)) {
        showErr(t('mc_kick_exists'));
        return;
      }

      // Part old channels if changed
      const oldTwitch = ch.twitch;
      const oldKick = ch.kick;
      const oldYt = ch.youtube;

      if (oldTwitch && oldTwitch !== twitchVal) irc?.part(oldTwitch);
      if (oldKick && oldKick !== kickVal) kickChat?.part(oldKick);

      // Unsubscribe old YouTube if changed
      if (oldYt && oldYt !== ytVal) {
        const oldLink = youtubeLinks.get(tabId);
        chrome.runtime.sendMessage({
          type: 'youtube_ws_unsubscribe',
          videoId: oldLink?.videoId || '',
          url: oldYt,
          channelId: tabId,
        }).catch(() => {});
        youtubeLinks.delete(tabId);
        channelYtMessages.delete(tabId);
      }

      // Update channel config
      ch.twitch = twitchVal;
      ch.kick = kickVal;
      ch.youtube = ytVal;

      // Update id to match primary platform
      const newId = twitchVal || kickVal || ch.id;
      if (newId !== ch.id) {
        // Migrate maps keyed by old id
        const ytData = youtubeLinks.get(tabId);
        const ytMsgs = channelYtMessages.get(tabId);
        if (ytData) { youtubeLinks.delete(tabId); youtubeLinks.set(newId, ytData); }
        if (ytMsgs) { channelYtMessages.delete(tabId); channelYtMessages.set(newId, ytMsgs); }
        ch.id = newId;
      }
      saveConfig();

      // Join new channels if changed
      if (twitchVal && twitchVal !== oldTwitch) {
        irc?.join(twitchVal);
        try { chrome.runtime.sendMessage({ type: 'join_channel', platform: 'twitch', channel: twitchVal }); } catch (e) {}
      }
      if (kickVal && kickVal !== oldKick) kickChat?.join(kickVal);
      if (ytVal && ytVal !== oldYt) {
        youtubeLinks.set(newId, { url: ytVal, videoId: '', channelName: '' });
        chrome.runtime.sendMessage({ type: 'youtube_ws_subscribe', url: ytVal, channelId: newId }).catch(() => {});
      }

      updateTabBar();
      switchTab(newId);
    };

    saveBtn.addEventListener('click', doSave);
    const inputs = [twitch.input, kick.input, yt.input];
    inputs.forEach((inp, i) => {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          inputs[(i + (e.shiftKey ? inputs.length - 1 : 1)) % inputs.length].focus();
        }
        if (e.key === 'Enter') doSave();
        if (e.key === 'Escape') switchTab(tabId);
      });
    });
    cleanup.raf(() => twitch.input.focus());
  }

  function updateTabIndicator(tabId) {
    const tab = tabBarElement?.querySelector(`[data-tab="${tabId}"]`);
    if (!tab || currentTab === tabId) return;

    // Don't light up duplicate tabs showing the same channel
    // If on live, suppress channel tab indicator for the live channel
    // If on a channel tab, suppress live tab indicator for the same channel
    const liveCh = getLiveChannel()?.toLowerCase();
    if (liveCh) {
      if (currentTab === 'live' && tabId !== 'feed' && tabId !== 'mentions') {
        const chConfig = getChannelById(tabId);
        if (chConfig) {
          const tw = chConfig.twitch?.toLowerCase();
          const ki = (chConfig.kick)?.toLowerCase();
          if (tw === liveCh || ki === liveCh) return;
        }
      }
      if (tabId === 'live') {
        const curConfig = getChannelById(currentTab);
        if (curConfig) {
          const tw = curConfig.twitch?.toLowerCase();
          const ki = (curConfig.kick)?.toLowerCase();
          if (tw === liveCh || ki === liveCh) return;
        }
      }
    }

    tab.classList.add('has-new');
    if (tabId === 'mentions') tab.classList.add('has-mentions');
  }

  function updateTabMentionIndicator(tabId) {
    const tab = tabBarElement?.querySelector(`[data-tab="${tabId}"]`)
    if (tab && currentTab !== tabId) {
      tab.classList.add('has-new', 'has-mentions')
    }
  }

  // ============================================
  // LIVE STATUS POLLING
  // ============================================

  let liveStatusInterval = null;
  let _lastLiveStatusPoll = 0;
  let _liveStatusInFlight = false;
  // Cached SW snapshot of followed-user live state. Refreshed by the SW alarm
  // every 60s and pushed via `live_followed_updated`. We use it to short-circuit
  // /api/platform/live-status calls for channels the SW already covers — at
  // 100k users this turns the per-content 30s poll into a no-op for most users.
  let _swLiveSet = null;

  function startLiveStatusPolling() {
    // Seed from SW cached snapshot, so first paint doesn't wait on the network.
    try {
      chrome.runtime.sendMessage({ type: 'get_live_followed' }).then(resp => {
        if (resp?.snapshot) _applyFollowedSnapshot(resp.snapshot);
        updateLiveStatus();
      }).catch(() => updateLiveStatus());
    } catch { updateLiveStatus(); }
    // Backup poll covers channels the SW doesn't follow (popout / unfollowed).
    // Extended 30s → 90s — SW broadcast handles freshness for the common case.
    liveStatusInterval = cleanup.setInterval(updateLiveStatus, 90000);
  }

  function _applyFollowedSnapshot(snapshot) {
    if (!Array.isArray(snapshot)) return;
    _swLiveSet = new Set(
      snapshot
        .filter(s => s.platform === 'twitch' || s.platform === 'kick')
        .map(s => String(s.username || '').toLowerCase())
        .filter(Boolean)
    );
    // Stamp dots from SW snapshot, then re-apply local cache as overlay.
    if (!tabBarElement) return;
    if (_swLiveSet.size) {
      const merged = new Set([...liveChannelSet, ..._swLiveSet]);
      liveChannelSet = merged;
      applyLiveDotsFromCache();
    }
  }

  // Debounced re-poll — call when user activity suggests stale dots are
  // worth refreshing (tab switch, panel re-open, page focus). Skips the
  // network round-trip if we polled <5s ago to avoid hammering helix.
  function refreshLiveStatusSoon() {
    if (_liveStatusInFlight) return;
    if (Date.now() - _lastLiveStatusPoll < 5000) return;
    updateLiveStatus();
  }

  async function updateLiveStatus() {
    if (!tabBarElement) return;
    // Split config channels by platform — the live-status API takes twitch
    // names in `channels` and kick slugs in `kickChannels`. Bug #7: the poll
    // used to send every channel as a twitch name, so Kick-only tabs queried
    // helix with their kick slug and always came back not-live (their dots
    // flickered off every 90s). Mirror the picker — query each platform's API.
    const twitchAll = [];
    const kickAll = [];
    for (const ch of config.channels) {
      if (ch.twitch) twitchAll.push(ch.twitch);
      else if (ch.kick) kickAll.push(ch.kick);
      else if (ch.id && !ch.youtube) twitchAll.push(ch.id); // legacy twitch-id-only entries
    }
    const urlCh = getCurrentChannel();
    if (urlCh) {
      const u = urlCh.toLowerCase();
      if (hostPlatform === 'kick') {
        if (!kickAll.some(c => c.toLowerCase() === u)) kickAll.push(urlCh);
      } else if (!twitchAll.some(c => c.toLowerCase() === u)) {
        twitchAll.push(urlCh);
      }
    }
    if (twitchAll.length === 0 && kickAll.length === 0) return;

    // Skip the twitch fetch for names the SW live snapshot already covers
    // (most followed channels at scale). The SW snapshot is twitch-only, so
    // kick slugs are always queried fresh.
    const twitchNames = _swLiveSet
      ? twitchAll.filter(c => !_swLiveSet.has(c.toLowerCase()))
      : twitchAll;

    if (twitchNames.length === 0 && kickAll.length === 0) {
      applyLiveDotsFromCache();
      _lastLiveStatusPoll = Date.now();
      return;
    }

    _liveStatusInFlight = true;
    _lastLiveStatusPoll = Date.now();
    try {
      const data = await chrome.runtime.sendMessage({ type: 'fetch_live_status', channels: twitchNames, kickChannels: kickAll });
      // If we asked for twitch names but got no twitch array back, the call
      // failed — keep the last good snapshot rather than clobbering dots.
      if (twitchNames.length > 0 && !Array.isArray(data?.live)) {
        applyLiveDotsFromCache();
        return;
      }
      // Merge SW snapshot + fresh twitch + fresh kick into one live set, then
      // stamp every tab (both platforms) via the shared cache-applier so
      // Kick-only tabs light up from kickLive, not the twitch set.
      const liveSet = new Set([
        ...(_swLiveSet || []),
        ...(Array.isArray(data?.live) ? data.live.map(c => c.toLowerCase()) : []),
        ...(Array.isArray(data?.kickLive) ? data.kickLive.map(c => c.toLowerCase()) : []),
      ]);
      liveChannelSet = liveSet;
      applyLiveDotsFromCache();

      // Update live tab's own red dot based on selected channel. On a YT
      // host page the "selected channel" is a videoId (e.g. jfKfPfyJRdk),
      // which is never in the Twitch live-set, so we'd always stamp 'false'
      // and clobber the chatframe-based detection. Defer to detectOfflineState.
      if (hostPlatform !== 'yt') {
        const liveTab = tabBarElement?.querySelector('[data-tab="live"]');
        const curLive = getLiveChannel()?.toLowerCase();
        if (liveTab) liveTab.dataset.live = String(curLive && liveSet.has(curLive));
      }

      // If override channel went offline, fall back to URL channel or first live
      if (liveChannel && !liveSet.has(liveChannel)) {
        liveChannel = null;
        updateLiveTabLabel();
        _dropTabCache('live');
        if (currentTab === 'live') renderMessages('live');
      }

      // Auto-select if no override and URL channel isn't live but others are
      if (!liveChannel && urlCh && !liveSet.has(urlCh.toLowerCase()) && liveSet.size > 0) {
        // Don't auto-override — user can pick via the menu
      }
    } catch (e) {
      // Network error — re-apply last known good snapshot so stale dots
      // don't persist past their truth window.
      applyLiveDotsFromCache();
    } finally {
      _liveStatusInFlight = false;
    }
  }

  // Re-stamp data-live on every channel tab from the cached liveChannelSet,
  // so a failed fetch / DOM re-render race / late tabbar mutation can't leave
  // a stale dot showing. Single source of truth: liveChannelSet.
  function applyLiveDotsFromCache() {
    if (!tabBarElement) return;
    config.channels.forEach(ch => {
      const id = ch.id;
      const tab = tabBarElement.querySelector(`[data-tab="${id}"]`);
      if (!tab) return;
      const isYtOnly = !ch.twitch && !ch.kick && ch.youtube;
      if (isYtOnly) return;
      // Check both twitch + kick slugs so Kick-only channels (and pairs whose
      // twitch handle differs from kick slug) get the live dot too.
      const tw = ch.twitch?.toLowerCase();
      const ki = ch.kick?.toLowerCase();
      const idLower = id?.toLowerCase();
      const isLive = (tw && liveChannelSet.has(tw))
        || (ki && liveChannelSet.has(ki))
        || (!tw && !ki && idLower && liveChannelSet.has(idLower));
      tab.dataset.live = String(isLive);
    });
  }

  // ============================================
  // USERNAME & MENTIONS
  // ============================================

  // Non-channel URL slugs shared by getCurrentChannel + the soft-nav
  // prevLiveCh extractor. Prod logs showed the server subscribing to
  // 'browse', 'u', 'mellen9' as Kick channels — covers both twitch + kick
  // reserved paths so we don't burn API quota (kick rate-limits subscribe;
  // each garbage slug eats budget).
  const NON_CHANNEL_PATHS = new Set([
    // shared
    'directory', 'settings', 'videos', 'moderator', 'subscriptions',
    'search', 'help', 'about', 'jobs', 'contact', 'wallet', 'inventory',
    'friends', 'admin', 'broadcast', 'drops', 'store', 'popout', 'embed',
    // twitch-specific
    'partners', 'turbo', 'prime', 'p', 'subs', 'turbo-faq', 'bits',
    // kick-specific
    'browse', 'category', 'categories', 'community', 'clips', 'leaderboards',
    'dashboard', 'vods', 'u', 'auth', 'authorize',
  ]);

  /**
   * Get current channel from URL
   */
  function getCurrentChannel() {
    // YouTube: /@handle/live, /watch?v=, /live/videoId
    if (location.hostname.includes('youtube.com')) {
      const handleMatch = location.pathname.match(/^\/@([^/]+)/)
      if (handleMatch) return handleMatch[1].toLowerCase()
      const vParam = new URLSearchParams(location.search).get('v')
      if (vParam) return vParam
      const liveMatch = location.pathname.match(/^\/live\/([^/?]+)/)
      if (liveMatch) return liveMatch[1]
      return null
    }

    // Match /username or /popout/username/chat or /embed/username/chat
    const match = location.pathname.match(/^\/(?:popout\/|embed\/)?([a-zA-Z0-9_-]+)/);
    if (match && match[1]) {
      const channel = match[1].toLowerCase();
      // Skip non-channel pages (shared module-scope Set above).
      if (NON_CHANNEL_PATHS.has(channel)) {
        return null;
      }
      return channel;
    }
    return null;
  }

  /** Channel the live tab is currently showing (override or URL fallback) */
  function getLiveChannel() {
    return liveChannel || getCurrentChannel();
  }

  /** Lowercase channel-name set the user is *currently viewing* — used by
   *  HsNotifs to scope channel-tagged callouts (resub-share, watchstreak) to
   *  the matching tab only. On non-channel tabs (feed/mentions/whispers/etc)
   *  returns an empty Set so channel-scoped callouts hide. Never returns
   *  null — passing null to setActiveChannels disables the filter, which
   *  would let stale callouts bleed across tabs. */
  function getActiveViewedChannels() {
    const out = new Set()
    const addCh = (ch) => {
      if (!ch) return
      if (ch.twitch) out.add(ch.twitch.toLowerCase())
      if (ch.kick) out.add(ch.kick.toLowerCase())
      if (ch.id) out.add(String(ch.id).toLowerCase())
    }
    if (currentTab === 'live') {
      const liveCh = getLiveChannel()?.toLowerCase()
      if (liveCh) {
        out.add(liveCh)
        // Paired channel: live=zackrawrr (twitch) + kick=asmongold belong to
        // the same logical "stream" — show callouts for either side.
        for (const ch of config.channels) {
          const tw = ch.twitch?.toLowerCase()
          const ki = ch.kick?.toLowerCase()
          if (tw === liveCh || ki === liveCh) addCh(ch)
        }
      }
      return out
    }
    const ch = getChannelById(currentTab)
    if (ch) addCh(ch)
    return out
  }

  // Check if a message belongs to the live tab — direct match OR paired via config
  // e.g., on twitch.tv/asmongold with config {twitch:"zackrawrr", kick:"asmongold"}
  // → shows both zackrawrr Twitch messages AND asmongold Kick messages
  function isLiveChannelMessage(msg) {
    const curCh = getLiveChannel()?.toLowerCase()
    if (!curCh) return false
    const mc = msg.channel?.toLowerCase()
    if (mc === curCh) return true
    // Check configured channel pairs — either side can be the live channel
    return config.channels.some(ch => {
      const tw = ch.twitch?.toLowerCase()
      const ki = ch.kick?.toLowerCase()
      return (tw === curCh && ki === mc) || (ki === curCh && tw === mc)
    })
    // On Kick, URL channel messages always belong to live tab
    || (hostPlatform === 'kick' && mc === getCurrentChannel()?.toLowerCase())
  }

  /** Update the live tab button label to show selected channel */
  function updateLiveTabLabel() {
    const liveTab = tabBarElement?.querySelector('[data-tab="live"]');
    if (!liveTab) return;
    const ch = liveChannel;
    // Show channel name when overridden to a non-URL channel
    if (ch && ch !== getCurrentChannel()?.toLowerCase()) {
      liveTab.textContent = t('mc_tab_live_channel', [ch]);
    } else {
      liveTab.textContent = t('mc_tab_live');
    }
  }

  /** Query background script for all channels the user has open tabs for */
  async function getWatchingChannels() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'get_watching_channels' });
      return resp?.channels || [];
    } catch (e) {
      return [];
    }
  }

  /**
   * Resolve a live candidate ({name, platform, youtubeUrl?}) to a real channel tab.
   * Auto-adds the channel to config.channels so 'live' is a launcher, never the sticky tab.
   */
  async function resolveLiveCandidateToTab({ name, platform, youtubeUrl }) {
    const lower = name.toLowerCase();
    const reserved = ['live', 'feed', 'mentions', 'whispers', 'discover', 'pinned', 'add', 'settings'];

    // Resolve all 3 platform identities up-front via /api/profile so the resulting
    // tab pulls Twitch + Kick + YouTube together — not just the platform we
    // anchored on. resolveIdentity is the same path pcAddAsChannel uses.
    let identity = null, profile = null
    if (typeof resolveIdentity === 'function') {
      try {
        const res = await resolveIdentity(name, platform ? { platform } : {})
        if (res?.ok && res.identity) { identity = res.identity; profile = res.profile }
      } catch {}
    }

    // Build canonical YouTube URL: prefer @handle, fall back to channel id.
    const buildYtUrl = () => {
      const handle = profile?.youtube_username
      const chanId = profile?.youtube_channel_id
      if (handle) return `https://www.youtube.com/@${String(handle).replace(/^@/, '')}/live`
      if (chanId) return `https://www.youtube.com/channel/${chanId}/live`
      // Fallback: identity.youtube may be either; UC-prefixed 24-char strings are channel ids.
      const yt = identity?.youtube
      if (!yt) return ''
      if (/^UC[\w-]{20,}$/.test(yt)) return `https://www.youtube.com/channel/${yt}/live`
      return `https://www.youtube.com/@${String(yt).replace(/^@/, '')}/live`
    }

    // Optimistic fallback: when heatsync has no linkage (shadow profile / unknown
     // streamer), assume the same username on every platform. Most streamers
     // use one handle everywhere; the user can edit the tab if the guess is wrong.
    const twitchName = (identity?.twitch || lower).toLowerCase()
    const kickName = (identity?.kick || lower).toLowerCase()
    // Twitch/Kick same-name guessing is safe (handles match across those platforms).
    // YouTube is NOT: a fabricated youtube.com/@<name>/live resolves to whoever owns
    // that handle — usually a STRANGER who happens to be live — and bleeds their chat
    // into this tab (see ac4892c + [[heatsync_yt_handle_guess_bleed]]). Bind YT ONLY
    // from an explicit youtubeUrl (user navigated to a YT page) or a real resolved
    // identity (buildYtUrl uses heatsync profile/identity linkage). Never from a name.
    const ytUrl = platform === 'youtube'
      ? (youtubeUrl || buildYtUrl() || '')
      : (buildYtUrl() || '')
    const ytLower = ytUrl.toLowerCase()

    // Find existing channel tab matching any resolved platform.
    let entry = config.channels.find(c => {
      if (typeof c === 'string') return c.toLowerCase() === lower
      const tw = c.twitch?.toLowerCase()
      const ki = c.kick?.toLowerCase()
      const yt = c.youtube?.toLowerCase()
      if (twitchName && tw === twitchName) return true
      if (kickName && ki === kickName) return true
      if (ytUrl && yt === ytLower) return true
      if (yt) {
        const handleMatch = yt.match(/\/@([^/?]+)/)
        if (handleMatch?.[1] === lower) return true
      }
      return false
    })

    if (!entry) {
      let id = (identity?.heatsync || twitchName || kickName || lower).toLowerCase()
      if (reserved.includes(id) || config.channels.some(c => c.id === id)) {
        id = platform === 'youtube' ? `yt_${Date.now()}` : `ch_${Date.now()}`
      }
      entry = { id, twitch: twitchName, kick: kickName, youtube: ytUrl }
      config.channels.push(entry)
      try { saveConfig() } catch {}

      if (entry.twitch) {
        try { irc?.join?.(entry.twitch) } catch {}
        try { chrome.runtime.sendMessage({ type: 'join_channel', platform: 'twitch', channel: entry.twitch }) } catch {}
      }
      if (entry.kick) {
        try { kickChat?.join?.(entry.kick) } catch {}
      }
      if (entry.youtube) {
        try { youtubeLinks.set(entry.id, { url: entry.youtube, videoId: '', channelName: '' }) } catch {}
        try { chrome.runtime.sendMessage({ type: 'youtube_ws_subscribe', url: entry.youtube, channelId: entry.id }) } catch {}
      }

      try { updateTabBar() } catch {}
    } else if (typeof entry !== 'string') {
      // Backfill any platforms missing on the existing entry (don't overwrite).
      let mutated = false
      if (!entry.twitch && twitchName) {
        entry.twitch = twitchName; mutated = true
        try { irc?.join?.(twitchName) } catch {}
        try { chrome.runtime.sendMessage({ type: 'join_channel', platform: 'twitch', channel: twitchName }) } catch {}
      }
      if (!entry.kick && kickName) {
        entry.kick = kickName; mutated = true
        try { kickChat?.join?.(kickName) } catch {}
      }
      if (!entry.youtube && ytUrl) {
        entry.youtube = ytUrl; mutated = true
        try { youtubeLinks.set(entry.id, { url: ytUrl, videoId: '', channelName: '' }) } catch {}
        try { chrome.runtime.sendMessage({ type: 'youtube_ws_subscribe', url: ytUrl, channelId: entry.id }) } catch {}
      }
      if (mutated) {
        try { saveConfig() } catch {}
        try { updateTabBar() } catch {}
      }
    }

    const tabId = entry.id;
    // Reset liveChannel override — live is no longer the sticky tab.
    liveChannel = null;
    _dropTabCache('live');
    switchTab(tabId);
  }

  /** Show picker for choosing which live channel to view */
  async function showLiveChannelPicker(anchorEl) {
    document.getElementById('hs-mc-live-picker')?.remove();

    const urlCh = getCurrentChannel()?.toLowerCase();
    const watching = await getWatchingChannels();

    // Split watching by platform — API supports `channels` (twitch) + `kick_channels`
    const twitchNames = [];
    const kickNames = [];
    for (const w of watching) {
      if (w.platform === 'kick') kickNames.push(w.name);
      else if (w.platform === 'twitch') twitchNames.push(w.name);
    }
    if (urlCh && hostPlatform === 'twitch' && !twitchNames.includes(urlCh)) twitchNames.push(urlCh);
    if (urlCh && hostPlatform === 'kick' && !kickNames.includes(urlCh)) kickNames.push(urlCh);

    let twitchLive = liveChannelSet;
    let kickLive = new Set();
    if (twitchNames.length > 0 || kickNames.length > 0) {
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'fetch_live_status', channels: twitchNames, kickChannels: kickNames });
        if (resp?.live) twitchLive = new Set(resp.live.map(c => c.toLowerCase()));
        if (resp?.kickLive) kickLive = new Set(resp.kickLive.map(c => c.toLowerCase()));
      } catch (e) { /* use cached liveChannelSet */ }
    }

    // Only show channels that are actually live; dedupe same name across platforms (twitch > kick > youtube)
    const priority = { twitch: 3, kick: 2, youtube: 1 };
    const byName = new Map();
    for (const w of watching) {
      const ch = w.name.toLowerCase();
      let isLive = false;
      if (w.platform === 'twitch') isLive = twitchLive.has(ch);
      else if (w.platform === 'kick') isLive = kickLive.has(ch);
      else if (w.platform === 'youtube') isLive = true;
      if (!isLive) continue;
      const existing = byName.get(ch);
      if (!existing || priority[w.platform] > priority[existing.platform]) {
        byName.set(ch, { name: w.name, platform: w.platform, youtubeUrl: w.youtubeUrl, isCurrent: ch === urlCh });
      }
    }
    const channels = Array.from(byName.values());

    if (channels.length <= 1) {
      // Popout: navigate to channel's popout URL when picking a different channel.
      if (channels.length === 1 && document.body.classList.contains('hs-popout') && channels[0].name.toLowerCase() !== urlCh) {
        if (hostPlatform === 'twitch') location.href = `/popout/${channels[0].name}/chat?popout=`;
        else if (hostPlatform === 'kick') location.href = `/${channels[0].name}`;
        return;
      }
      if (channels.length === 1) {
        await resolveLiveCandidateToTab(channels[0]);
        return;
      }
      // 0 candidates — fall back to urlCh (auto-add) so something opens; else just sit on live.
      if (urlCh && (hostPlatform === 'twitch' || hostPlatform === 'kick')) {
        await resolveLiveCandidateToTab({ name: urlCh, platform: hostPlatform });
        return;
      }
      switchTab('live');
      return;
    }

    const menu = document.createElement('div');
    menu.id = 'hs-mc-live-picker';
    const rect = anchorEl.getBoundingClientRect();
    menu.style.cssText = `position:fixed;z-index:99999;background:#000;border:1px solid #808080;padding:4px 0;min-width:130px;font-size:13px;font-family:inherit;left:${rect.left}px;top:${rect.bottom + 2}px;`;

    const curLive = getLiveChannel()?.toLowerCase();

    for (const ch of channels) {
      const item = document.createElement('div');
      const isActive = ch.name.toLowerCase() === curLive;

      // Red dot — all channels in picker are confirmed live
      const dot = document.createElement('span');
      dot.style.cssText = `display:inline-block;width:6px;height:6px;border-radius:50%;background:#f00;margin-right:6px;vertical-align:middle`;
      item.appendChild(dot);
      item.appendChild(document.createTextNode(ch.name));

      const baseColor = isActive ? '#ff8700' : '#fff';
      item.style.cssText = `padding:6px 12px;cursor:pointer;color:${baseColor};white-space:nowrap;`;
      item.addEventListener('mouseenter', () => { item.style.background = '#fff'; item.style.color = '#000'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'none'; item.style.color = baseColor; });
      item.addEventListener('click', async () => {
        menu.remove();
        // Popout mode keeps URL navigation — each popout window is locked to one channel.
        if (document.body.classList.contains('hs-popout') && ch.name.toLowerCase() !== urlCh) {
          try {
            const s = await chrome.storage.sync.get(['ui_settings'])
            await chrome.storage.sync.set({ ui_settings: sanitizeUiSettings({ ...s.ui_settings, activeTab: 'live', liveChannel: ch.name }) })
          } catch {}
          if (ch.platform === 'twitch' || hostPlatform === 'twitch') {
            location.href = `/popout/${ch.name}/chat?popout=`;
          } else if (ch.platform === 'kick' || hostPlatform === 'kick') {
            location.href = `/${ch.name}`;
          }
          return;
        }
        await resolveLiveCandidateToTab(ch);
      });
      menu.appendChild(item);
    }

    document.body.appendChild(menu);

    // Clamp position so menu stays fully visible
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth) {
      menu.style.left = Math.max(0, window.innerWidth - menuRect.width - 4) + 'px';
    }
    if (menuRect.bottom > window.innerHeight) {
      menu.style.top = Math.max(0, rect.top - menuRect.height - 2) + 'px';
    }

    // Dismiss on outside click
    const dismiss = (e) => {
      if (!menu.contains(e.target) && e.target !== anchorEl) {
        menu.remove();
        document.removeEventListener('click', dismiss, true);
      }
    };
    cleanup.setTimeout(() => document.addEventListener('click', dismiss, { capture: true, signal: mcSignal }), 0);
  }

  function getCurrentUsername() {
    // Method 1: localStorage displayName
    try {
      const displayName = localStorage.getItem('twilight.user.displayName');
      if (displayName) {
        const name = displayName.replace(/"/g, '').trim();
        if (name && name.length > 0 && name.length < 30) {
          return name.toLowerCase();
        }
      }
    } catch (e) {}

    // Method 2: localStorage user object
    try {
      const twilight = localStorage.getItem('twilight.user');
      if (twilight) {
        const data = JSON.parse(twilight);
        if (data?.displayName) return data.displayName.toLowerCase();
      }
    } catch (e) {}

    // Method 3: Twitch 'name' cookie (works in popout chat)
    try {
      const cookies = document.cookie.split(';');
      for (const cookie of cookies) {
        const [key, value] = cookie.trim().split('=');
        if (key === 'name' && value) {
          const name = decodeURIComponent(value).toLowerCase();
          if (name.length > 0 && name.length < 30) {
            log('Found username from cookie:', name);
            return name;
          }
        }
      }
    } catch (e) {}

    // Kick — DOM selectors keep getting stripped (current redesign moved login to
    // an unlabeled person-icon button with no /profile link). Cross-platform
    // mention detection now falls back to ui.username via mentionAliases, so we
    // don't fight the moving target here. Returning null is fine.

    return null;
  }


  // ============================================
  // STORAGE
  // ============================================

  async function loadConfig() {
    try {
      const s = await chrome.storage.local.get([STORAGE_KEY]);
      config = { channels: [], enabled: true, ...s[STORAGE_KEY] };
      _channelLookup = null
      // Migrate old string channels to object format
      let needsSave = false;
      if (config.channels.some(c => typeof c === 'string')) {
        config.channels = config.channels.map(ch =>
          typeof ch === 'string' ? { id: ch, twitch: ch, kick: '', youtube: '' } : ch
        );
        needsSave = true;
      }
      if (needsSave) saveConfig();
      // First-run seed: no channels yet AND we're on a real Twitch/Kick channel
      // page → add the current channel so the panel opens with working chat
      // instead of a blank list. getCurrentChannel() returns null on home/
      // directory/reserved pages, so this can never seed a garbage slug. YouTube
      // is skipped (it needs a URL form, not a bare slug); the empty-state CTA
      // covers that case.
      if (!config.channels.length) {
        try {
          const host = location.hostname;
          const onTwitch = host.includes('twitch.tv');
          const onKick = host.includes('kick.com');
          if (onTwitch || onKick) {
            const cur = getCurrentChannel();
            if (cur) {
              config.channels = [onKick
                ? { id: cur, twitch: '', kick: cur, youtube: '' }
                : { id: cur, twitch: cur, kick: '', youtube: '' }];
              saveConfig();
            }
          }
        } catch (_) {}
      }
      // Subscribe per-channel YouTube links
      for (const ch of config.channels) {
        if (ch.youtube) {
          youtubeLinks.set(ch.id, { url: ch.youtube, videoId: '', channelName: '' });
          ytSubscribedUrls.set(ch.id, ch.youtube);
          ytChanLastSeen.set(ch.id, Date.now());
          chrome.runtime.sendMessage({ type: 'youtube_ws_subscribe', url: ch.youtube, channelId: ch.id }).catch(() => {});
        }
      }
    } catch (e) {}
  }

  let _skipNextConfigSync = false

  async function saveConfig() {
    _channelLookup = null
    // Notify any open UI (profile card, etc.) that channel list may have changed
    try { document.dispatchEvent(new CustomEvent('hs-channels-changed')) } catch {}
    try {
      _skipNextConfigSync = true
      // ephemeral auto-tabs (open browser streams) never persist
      const persistable = { ...config, channels: (config.channels || []).filter(c => !c?.ephemeral) }
      await chrome.storage.local.set({ [STORAGE_KEY]: persistable });
      // Sync to server for cross-device sync
      try {
        chrome.runtime.sendMessage({ type: 'ws_send', data: { type: 'multichat:sync', channels: (config.channels || []).filter(c => !c?.ephemeral) } })
      } catch (e) { /* context invalidated */ }
    } catch (e) { console.warn('saveConfig failed:', e) }
  }

  // ============================================
  // TABS POSITION SETTING
  // ============================================

  async function loadTabsPosition() {
    try {
      const stored = await cachedUiSettings();
      if (stored.ui_settings?.tabPosition !== undefined) {
        tabPosition = stored.ui_settings.tabPosition;
      }
      applyTabsPosition();
    } catch (e) {
      log('Error loading tabs position:', e);
    }
  }

  let _savedActiveTab = null;
  // 'discover' intentionally omitted — tab is hidden from the bar pre-launch,
  // so a stale saved 'discover' falls back to 'live' on restore.
  const BUILTIN_TABS = ['live', 'feed', 'mentions', 'pinned', 'add'];
  async function loadActiveTab() {
    try {
      const stored = await cachedUiSettings();
      const saved = stored.ui_settings?.activeTab || 'live';
      // Validate: must be a built-in tab or a configured channel (never restore 'add')
      const channelIds = config.channels.map(c => c.id);
      _savedActiveTab = (saved !== 'add' && (BUILTIN_TABS.includes(saved) || channelIds.includes(saved)))
        ? saved : 'live';
      // Restore live channel override — POPOUT ONLY. The override exists so
      // the popout picker survives its navigation hop; restoring it on
      // regular pages pinned the live tab to a long-dead pick (the
      // "live tab always opens quin69" bug) instead of the page's channel.
      if (stored.ui_settings?.liveChannel && document.body.classList.contains('hs-popout')) {
        liveChannel = stored.ui_settings.liveChannel;
      }
      // Popout window is locked to one channel by URL — ignore the parent
      // session's saved tab (which often points to a different channel and
      // produces a blank panel because that channel's pane was never built).
      if (document.body.classList.contains('hs-popout')) {
        const urlCh = location.pathname.match(/^\/(?:popout|embed)\/([a-zA-Z0-9_-]+)/)?.[1]
        if (urlCh) {
          _savedActiveTab = 'live'
          liveChannel = urlCh
        }
      }
    } catch (e) {
      _savedActiveTab = 'live';
    }
  }

  let _applyingPosition = false
  function applyTabsPosition() {
    if (_applyingPosition) return
    _applyingPosition = true
    try { _applyTabsPositionInner() } finally { _applyingPosition = false }
  }
  function _applyTabsPositionInner() {
    document.body.classList.remove('hs-tabs-top', 'hs-tabs-right', 'hs-tabs-bottom', 'hs-tabs-left');
    document.body.classList.add(`hs-tabs-${tabPosition}`);

    // Re-run dynamic layout — clears stale inline rules + applies fresh ones for new position.
    try { _updateMcLayout() } catch (_) {}

    // Re-apply column width (accounts for vertical tab offset)
    applyChatWidth()

    log('Tabs position:', tabPosition);
  }

  function rotateTabPosition() {
    const positions = ['top', 'right', 'bottom', 'left'];
    const currentIndex = positions.indexOf(tabPosition);
    const prev = tabPosition
    tabPosition = positions[(currentIndex + 1) % positions.length];
    log('rotate:', prev, '→', tabPosition)

    setSetting('tabPosition', tabPosition); // applier applies + rerender
  }

  // ============================================
  // CHAT POSITION SETTING (C button)
  // Cycles which side of the player the chat panel docks to.
  // right (default) → bottom → left → top → right
  // Vertical-monitor parity: top/bottom horizontal strips matter when the
  // viewport is taller than wide.
  //
  // Single source of truth: 3 body classes are the ONLY layout signal.
  //   hs-platform-{twitch,kick,yt}  (set once at init)
  //   hs-mode-{normal,theatre}      (set by theatre observer)
  //   hs-chat-{right,left,top,bottom} (set by C button)
  // CSS in styles.js fully derives layout from these three dimensions.
  // ============================================
  let chatPosition = 'right'; // 'right', 'bottom', 'left', 'top'
  let theatreMode = false;
  let _theatreObserver = null;
  let _twitchSideNavObs = null;
  let _twitchSideNavWinHooked = false;
  let _twitchSideNavW = TWITCH_SIDE_NAV_WIDTH;
  let _twitchTopNavObs = null;
  let _twitchTopNavH = TWITCH_TOP_NAV_HEIGHT;

  // Twitch's left side-nav is 50px when collapsed, ~240px when expanded.
  // It auto-expands on wide viewports (>~1200px), and the user can also
  // toggle it. chat-left layout subtracts this width from chatWidth to land
  // the player flush with the HS panel — so the live value must be tracked,
  // not assumed. Pushes --hs-twitch-sidenav-w for the CSS rules to consume,
  // and re-runs applyPlatformPositionOverrides so JS-side arithmetic
  // (persistent-player inset, channel-root padding) updates too.
  function updateTwitchSideNavWidth() {
    if (hostPlatform !== 'twitch') return;
    const nav = document.querySelector('.side-nav');
    const w = nav?.getBoundingClientRect?.().width;
    const next = (w && w > 0) ? Math.round(w) : TWITCH_SIDE_NAV_WIDTH;
    if (next === _twitchSideNavW) return;
    _twitchSideNavW = next;
    document.documentElement.style.setProperty('--hs-twitch-sidenav-w', next + 'px');
    if (chatPosition === 'left') {
      try { applyPlatformPositionOverrides() } catch (_) {}
    }
  }

  // Twitch's top nav (.top-nav) is 50px tall and lives in a sibling DOM tree
  // that paints above HS's chat container — even though HS has z-index 9999,
  // the chat container is trapped inside .channel-root__right-column's z=1
  // stacking context. Fight: don't compete on z-index, just offset chat down
  // by the nav height when chat docks left/top so the rotate buttons aren't
  // hidden under Following/Browse. Theatre mode hides .top-nav (height = 0),
  // so the offset auto-collapses and chat reclaims the full viewport.
  function updateTwitchTopNavHeight() {
    if (hostPlatform !== 'twitch') return;
    const nav = document.querySelector('.top-nav');
    let h = 0;
    if (nav) {
      const r = nav.getBoundingClientRect();
      // height>0 AND visible — theatre mode collapses to 0 via display:none
      h = (r.height > 0 && getComputedStyle(nav).display !== 'none') ? Math.round(r.height) : 0;
    }
    if (h === _twitchTopNavH) return;
    _twitchTopNavH = h;
    document.documentElement.style.setProperty('--hs-twitch-topnav-h', h + 'px');
    if (chatPosition === 'left' || chatPosition === 'top') {
      try { applyPlatformPositionOverrides() } catch (_) {}
    }
  }

  function setupTwitchTopNavObserver() {
    if (hostPlatform !== 'twitch') return;
    document.documentElement.style.setProperty('--hs-twitch-topnav-h', _twitchTopNavH + 'px');
    if (_twitchTopNavObs) { try { _twitchTopNavObs.disconnect() } catch (_) {} _twitchTopNavObs = null; }
    const nav = document.querySelector('.top-nav');
    if (nav && typeof ResizeObserver !== 'undefined') {
      _twitchTopNavObs = new ResizeObserver(() => updateTwitchTopNavHeight());
      _twitchTopNavObs.observe(nav);
      cleanup.trackObserver(_twitchTopNavObs);
    }
    updateTwitchTopNavHeight();
  }

  // Persistent-overlay mode toggle. Sets `hs-twitch-no-channel` on body when
  // we're on a twitch URL with no .channel-root (directory, settings, videos,
  // search, …). CSS rules keyed off this class flip the panel to position:
  // fixed and squeeze twitch's main content via a body width/height
  // constraint. Re-checked on every SPA nav.
  function updateTwitchNoChannelClass() {
    if (hostPlatform !== 'twitch') return;
    // Chokepoint that runs on every soft nav (reparent + 700ms + 4s timers)
    // and theatre flip — re-assert the stylesheet here, since twitch SPA
    // transitions can sweep injected <style> tags. Idempotent (id check).
    try { injectStyles() } catch (_) {}
    const onChannel = !!document.querySelector('.channel-root, [class*="channel-root"]');
    const popout = document.body.classList.contains('hs-popout');
    let noChannel = !onChannel && !popout;
    if (!noChannel && !popout) {
      // Twitch layout bug: on miniplayer-restore from twitch.tv/, the channel
      // page mounts but the right-column flex slot stays 0-width — chat-shell
      // overflows off-screen to the right (x ≥ viewport.right). Detect and
      // fall back to body-mounted fixed-overlay mode so chat stays visible.
      const chatShell = document.querySelector('.chat-shell, ' + CONFIG.SELECTORS.TWITCH_CHAT_SHELL);
      if (chatShell) {
        const r = chatShell.getBoundingClientRect();
        if (r.right > window.innerWidth + 1 || r.width === 0) {
          noChannel = true;
          const c = document.getElementById('hs-mc-container');
          if (c && c.parentElement !== document.body) document.body.appendChild(c);
        }
      }
    }
    const prev = document.body.classList.contains('hs-twitch-no-channel');
    document.body.classList.toggle('hs-twitch-no-channel', noChannel);
    // State flip: re-run width so the right-column slot zeros (entering
    // no-channel) or reclaims its size (returning to a channel page).
    if (prev !== noChannel) {
      try { applyChatWidth() } catch (_) {}
    }
  }

  // Mirror of updateTwitchNoChannelClass for Kick. #channel-chatroom is
  // present only on /<channel> pages; absent on /browse, /categories,
  // /following, /search, /settings, etc. CSS keyed off this flips the
  // panel to position:fixed overlay and squeezes <main> width/height.
  function updateKickNoChannelClass() {
    if (!isKick) return;
    try { injectStyles() } catch (_) {} // kick SPA navs — same sweep guard

    const onChannel = !!document.getElementById('channel-chatroom');
    const popout = document.body.classList.contains('hs-popout');
    document.body.classList.toggle('hs-kick-no-channel', !onChannel && !popout);
  }

  function setupTwitchSideNavObserver() {
    if (hostPlatform !== 'twitch') return;
    document.documentElement.style.setProperty('--hs-twitch-sidenav-w', _twitchSideNavW + 'px');
    if (_twitchSideNavObs) { try { _twitchSideNavObs.disconnect() } catch (_) {} _twitchSideNavObs = null; }
    const nav = document.querySelector('.side-nav');
    if (nav && typeof ResizeObserver !== 'undefined') {
      _twitchSideNavObs = new ResizeObserver(() => updateTwitchSideNavWidth());
      _twitchSideNavObs.observe(nav);
      cleanup.trackObserver(_twitchSideNavObs);
    }
    if (!_twitchSideNavWinHooked) {
      _twitchSideNavWinHooked = true;
      window.addEventListener('resize', () => updateTwitchSideNavWidth(), { passive: true, signal: mcSignal });
    }
    updateTwitchSideNavWidth();
  }

  async function loadChatPosition() {
    try {
      const stored = await cachedUiSettings();
      if (stored.ui_settings?.chatPosition !== undefined) {
        chatPosition = stored.ui_settings.chatPosition;
      }
      // Load previous-visible for hide↔show toggle restore.
      const prevStored = stored.ui_settings?.chatPositionPrevious;
      if (['right','bottom','left','top'].includes(prevStored)) chatPositionPrevious = prevStored;
      if (['right','bottom','left','top'].includes(chatPosition)) {
        chatPositionPrevious = chatPosition;
      }
      // Load saved width + height BEFORE first applyChatPosition. Without this,
      // applyChatPosition runs with default chatHeight (35% innerHeight) and
      // positions the orange handle there. loadChatHeight then updates the
      // variable but not the handle's screen position, so first click captures
      // the saved value and the bar instantly snaps to it — looks like a
      // mouse teleport from the user's POV.
      await Promise.all([loadChatWidth(), loadChatHeight()]);
      // Stamp the platform class once — never changes per-page
      const platformClass = `hs-platform-${hostPlatform === 'yt' ? 'yt' : (isKick ? 'kick' : 'twitch')}`;
      document.body.classList.add(platformClass);
      detectTheatreMode();
      setupTheatreObserver();
      setupTwitchSideNavObserver();
      setupTwitchTopNavObserver();
      updateTwitchNoChannelClass();
      updateKickNoChannelClass();
      applyChatPosition();
    } catch (e) {
      log('Error loading chat position:', e);
    }
  }

  // Detect platform-native theatre/cinema/expanded-player mode.
  // Twitch:  .right-column--theatre OR .video-player--theatre
  // Kick:    main[data-theatre="true"]
  // YouTube: ytd-watch-flexy[theater]
  // Publish the container's MEASURED width (chat column + side tab strip)
  // for CSS that must reserve the full panel footprint (theatre player inset).
  function publishPanelWidth() {
    const c = document.getElementById('hs-mc-container');
    if (c && c.offsetWidth > 0) {
      document.documentElement.style.setProperty('--hs-panel-w', c.offsetWidth + 'px');
    }
  }

  function detectTheatreMode() {
    let next = false;
    if (hostPlatform === 'yt') {
      next = !!document.querySelector('ytd-watch-flexy[theater], ytd-watch-flexy[fullscreen]');
    } else if (isKick) {
      const m = document.querySelector('main[data-theatre-mode-container]');
      next = m?.dataset.theatre === 'true' || !!document.querySelector('main[data-theatre="true"]');
    } else {
      next = !!document.querySelector('.right-column--theatre, .video-player--theatre');
    }
    if (next !== theatreMode) {
      theatreMode = next;
      applyChatPosition();
      // Theatre flips collapse/restore the right column — re-evaluate the
      // no-channel body-mount AFTER the 500ms column animation settles, same
      // contract as the soft-nav path. Without this, exiting theatre strands
      // the panel in fixed body-mount until the next SPA nav.
      cleanup.setTimeout(() => {
        try { updateTwitchNoChannelClass() } catch (_) {}
        try { positionChatResizeHandle() } catch (_) {}
        try { publishPanelWidth() } catch (_) {}
        // Theatre transitions can transiently overflow the root scroller
        // horizontally; if a scroll sticks, the whole page renders shifted
        // left with a dead zone before the panel. Reset it.
        try {
          const sa = document.querySelector('.root-scrollable');
          if (sa && sa.scrollLeft > 0) sa.scrollLeft = 0;
        } catch (_) {}
      }, 700, 'theatre-flip-nochannel-recheck');
    }
    return next;
  }

  function setupTheatreObserver() {
    if (_theatreObserver) { try { _theatreObserver.disconnect() } catch (_) {} _theatreObserver = null }
    const targets = [];
    if (hostPlatform === 'yt') {
      const flexy = document.querySelector('ytd-watch-flexy:not([hidden])');
      if (flexy) targets.push(flexy);
    } else if (isKick) {
      const main = document.querySelector('main');
      if (main) targets.push(main);
    } else {
      // Twitch: theatre class lands on .right-column AND inside the player.
      // Watch the body — most-specific reliable observation point covers SPA navs.
      targets.push(document.body);
    }
    if (targets.length === 0) return;
    // Body-subtree observation fires on every React class flip (chat-line
    // animations, hover toggles, ad layer churn) — ~100+ callbacks/sec.
    // Cheap pre-filter: skip mutations whose target class doesn't contain
    // a theatre token. Saves the querySelector inside detectTheatreMode().
    _theatreObserver = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.attributeName !== 'class') { detectTheatreMode(); return }
        const c = m.target && m.target.className
        const s = typeof c === 'string' ? c : (c && c.baseVal) || ''
        if (s.indexOf('theat') !== -1 || s.indexOf('fullscreen') !== -1) {
          detectTheatreMode()
          return
        }
      }
    });
    for (const t of targets) {
      _theatreObserver.observe(t, { attributes: true, attributeFilter: ['class', 'data-theatre', 'theater', 'fullscreen'], subtree: true });
    }
    cleanup.trackObserver(_theatreObserver);
  }

  function applyChatPosition() {
    // Sanitize — 5 valid positions: 4 visible + 'hidden'.
    const VALID_POSITIONS = ['right', 'bottom', 'left', 'top', 'hidden'];
    if (!VALID_POSITIONS.includes(chatPosition)) {
      log('[c-button] sanitizing invalid chatPosition:', chatPosition, '→ right');
      chatPosition = 'right';
    }
    // Popout chat = full window. Force 'right' + visible.
    if (document.body.classList.contains('hs-popout') && chatPosition !== 'right') {
      chatPosition = 'right';
    }
    // Hidden state: collapse overlay, drop all handles, show edge-pill.
    // Pill + `\` shortcut are the ONLY restore paths.
    if (chatPosition === 'hidden') {
      document.body.classList.remove('hs-chat-top', 'hs-chat-right', 'hs-chat-bottom', 'hs-chat-left');
      document.body.classList.add('hs-chat-hidden');
      document.body.classList.toggle('hs-platform-yt', hostPlatform === 'yt');
      document.body.classList.toggle('hs-platform-twitch', hostPlatform !== 'yt' && !isKick);
      document.body.classList.toggle('hs-platform-kick', !!isKick);
      document.body.classList.toggle('hs-mode-theatre', theatreMode);
      document.body.classList.toggle('hs-mode-normal', !theatreMode);
      hidePlatformResizeHandles(true);
      const uh = document.getElementById('hs-c-resize-handle');
      if (uh) uh.style.setProperty('display', 'none', 'important');
      ensureChatRestorePill(true);
      try { applyPlatformPositionOverrides() } catch (_) {}
      log('Chat position: hidden, theatre:', theatreMode);
      return;
    }
    document.body.classList.remove('hs-chat-hidden');
    ensureChatRestorePill(false);
    // YouTube: layout overrides that touch #primary/#secondary are gated
    // separately (live-only via :not(.hs-offline)). The hs-chat-{position}
    // class is now applied on EVERY YT page so the persistent multichat
    // panel renders via the position:fixed CSS rule across home, search,
    // VOD, channel, and live — matching the Twitch persistent overlay.
    const isYtNonWatch = hostPlatform === 'yt' && !document.querySelector('ytd-watch-flexy:not([hidden])');
    document.body.classList.remove('hs-chat-top', 'hs-chat-right', 'hs-chat-bottom', 'hs-chat-left');
    document.body.classList.toggle('hs-platform-yt', hostPlatform === 'yt');
    document.body.classList.toggle('hs-platform-twitch', hostPlatform !== 'yt' && !isKick);
    document.body.classList.toggle('hs-platform-kick', !!isKick);
    document.body.classList.add(`hs-chat-${chatPosition}`);
    if (isYtNonWatch && location.pathname === '/watch') {
      // We're on a watch URL but flexy hasn't mounted yet (SPA cold-load,
      // /watch → /watch transition where React unmounted then remounts).
      // Re-arm the flexy-mount observer so applyChatPosition fires again
      // once it's there.
      try { watchYtFlexyMount() } catch (_) {}
    }
    document.body.classList.toggle('hs-mode-theatre', theatreMode);
    document.body.classList.toggle('hs-mode-normal', !theatreMode);
    // Push the chatWidth css var down so the per-position CSS can build offsets
    // off it (rather than chasing platform-specific selectors twice).
    document.documentElement.style.setProperty('--hs-chat-w', chatWidth + 'px');
    document.documentElement.style.setProperty('--hs-chat-h', chatHeight + 'px');
    // Refresh Twitch side-nav width — it can flip 50↔240 across a chat
    // toggle (user F11s, viewport crosses Twitch's expand breakpoint, etc).
    if (hostPlatform === 'twitch') updateTwitchSideNavWidth();
    // Apply inline-style overrides on platform-native elements that set
    // width/height with inline !important (CSS alone can't beat that).
    applyPlatformPositionOverrides();
    // Bulletproof orange resize handle — covers all 4 chat positions.
    positionChatResizeHandle();
    // Hide platform handles when chat is non-right OR when on YT (where
    // unified handle now owns chat-right too since YT uses position:fixed).
    hidePlatformResizeHandles(chatPosition !== 'right' || hostPlatform === 'yt');
    log('Chat position:', chatPosition, 'theatre:', theatreMode);
    // Reflow the multichat layout so input/overlay/picker re-anchor.
    try { _updateMcLayout?.() } catch (_) {}
    // YT computes player size in JS asynchronously and caches it; nudge it
    // to re-read CSS vars (margin, non-player-{width,height}) by dispatching
    // resize events at multiple timing points. The player init is async and
    // can complete after our applyChatPosition runs on initial load — without
    // multiple nudges, YT's own resize observer doesn't fire until ~10s.
    if (hostPlatform === 'yt') {
      const fire = () => { try { window.dispatchEvent(new Event('resize')) } catch (_) {} };
      fire();
      cleanup.setTimeout(fire, 100);
      cleanup.setTimeout(fire, 500);
      cleanup.setTimeout(fire, 1500);
    }
  }

  // Inline-style overrides keyed off chatPosition. These run AFTER class
  // toggling. They exist because Twitch/Kick/YT set inline width/height/
  // padding with !important that beats CSS rules — only inline can fight
  // inline. When chatPosition flips back to 'right' we restore the native
  // values (Twitch's chat-width JS will re-apply them on next tick).
  let _overrideObserver = null;
  // YT reflow: a ResizeObserver on #movie_player keeps --hs-yt-below-top in sync
  // with the real video bottom. The rAF-based set in applyPlatformPositionOverrides
  // is racy on fresh load (the player gets its size after our last run), leaving
  // #below pinned at the fallback top over the video. The observer fires whenever
  // the player sizes/resizes, so the var is always correct. Re-observes on SPA nav.
  let _hsYtBelowRO = null, _hsYtBelowEl = null, _hsYtBelowPoll = null;
  function _hsSetYtBelowTop() {
    // Panel hidden (non-live, no opt-in) → don't pin #below; the CSS reflow rule
    // is gated on :not(.hs-offline) anyway, but clear the var to be tidy.
    if (document.body.classList.contains('hs-offline')) { document.documentElement.style.removeProperty('--hs-yt-below-top'); return }
    if (chatPosition !== 'left' && chatPosition !== 'right') { document.documentElement.style.removeProperty('--hs-yt-below-top'); return }
    const flexy = document.querySelector('ytd-watch-flexy');
    if (flexy && (flexy.hasAttribute('theater') || flexy.hasAttribute('fullscreen'))) { document.documentElement.style.removeProperty('--hs-yt-below-top'); return }
    const mp = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    const b = mp && mp.getBoundingClientRect();
    if (b && b.height > 0) document.documentElement.style.setProperty('--hs-yt-below-top', Math.round(b.bottom) + 'px');
  }
  function _hsEnsureYtBelowObserver(_tries) {
    const mp = document.querySelector('#movie_player');
    // On fresh load applyPlatformPositionOverrides often runs before #movie_player
    // exists; self-retry so the observer attaches once the player mounts (instead
    // of depending on the function happening to re-run after). ~12s ceiling.
    if (!mp) { if ((_tries || 0) < 30) cleanup.setTimeout(() => _hsEnsureYtBelowObserver((_tries || 0) + 1), 400); return; }
    if (_hsYtBelowEl !== mp) {
      if (_hsYtBelowRO) _hsYtBelowRO.disconnect();
      _hsYtBelowEl = mp;
      _hsYtBelowRO = new ResizeObserver(_hsSetYtBelowTop);
      _hsYtBelowRO.observe(mp);
      cleanup.trackObserver(_hsYtBelowRO);
    }
    // ResizeObserver only fires on SIZE changes — but YT shifts the player's
    // POSITION during load (same height, different top), so the observed bottom
    // goes stale. A light poll catches position shifts + keeps the var honest.
    if (!_hsYtBelowPoll) _hsYtBelowPoll = cleanup.setInterval(_hsSetYtBelowTop, 500);
    _hsSetYtBelowTop();
  }
  function applyPlatformPositionOverrides() {
    const isRight = chatPosition === 'right';
    const w = `${chatWidth}px`;
    const h = `${chatHeight}px`;

    // The chat container itself: inline styles beat any platform-bundled CSS
    // (Twitch's chat-shell rules, Kick's existing hs-tabs-* rules etc.).
    // We only touch geometry when overriding; the platform's mount code
    // (getOrCreateHsContainer for YT) may set its own inline height/etc that
    // we must not blow away when chatPosition === 'right'.
    const container = document.getElementById('hs-mc-container');
    const GEOM_PROPS = ['top','bottom','left','right','width','min-width','max-width','height','position','z-index'];
    if (container) {
      if (isRight) {
        if (container.dataset._hsChatOverride === '1') {
          delete container.dataset._hsChatOverride;
          GEOM_PROPS.forEach(p => container.style.removeProperty(p));
          container.style.removeProperty('background');
          container.style.removeProperty('overflow');
          // YT chat-right is now position:fixed via CSS rule — don't set
          // any inline geometry, let the stylesheet own it (works on
          // initial load without waiting for a C-cycle).
          if (isKick) {
            try { applyKickChatWidth() } catch (_) {}
          }
        }
      } else {
        container.dataset._hsChatOverride = '1';
        GEOM_PROPS.forEach(p => container.style.removeProperty(p));
        container.style.setProperty('position', 'fixed', 'important');
        container.style.setProperty('z-index', '9999', 'important');
        container.style.setProperty('background', '#000', 'important');
        // Twitch-only: offset by .top-nav height for left/top so the rotate
        // buttons aren't trapped under Following/Browse (HS lives inside
        // .channel-root__right-column's z=1 stacking context, can't outrank).
        const twitchTopOffset = (hostPlatform === 'twitch' && !theatreMode) ? _twitchTopNavH : 0;
        const topPx = twitchTopOffset + 'px';
        if (chatPosition === 'left') {
          container.style.setProperty('top', topPx, 'important');
          container.style.setProperty('bottom', '0', 'important');
          container.style.setProperty('left', '0', 'important');
          container.style.setProperty('right', 'auto', 'important');
          container.style.setProperty('width', w, 'important');
          container.style.setProperty('height', `calc(100vh - ${topPx})`, 'important');
        } else if (chatPosition === 'top') {
          container.style.setProperty('top', topPx, 'important');
          container.style.setProperty('bottom', 'auto', 'important');
          container.style.setProperty('left', '0', 'important');
          container.style.setProperty('right', '0', 'important');
          container.style.setProperty('width', '100vw', 'important');
          container.style.setProperty('height', h, 'important');
        } else if (chatPosition === 'bottom') {
          container.style.setProperty('top', 'auto', 'important');
          container.style.setProperty('bottom', '0', 'important');
          container.style.setProperty('left', '0', 'important');
          container.style.setProperty('right', '0', 'important');
          container.style.setProperty('width', '100vw', 'important');
          container.style.setProperty('height', h, 'important');
        }
      }
    }

    if (hostPlatform === 'yt') {
      // Panel hidden on this YT page (non-live + no opt-in → hs-offline): don't
      // reshape the page for a chat that isn't showing. Revert any inline player
      // sizing + the reflow var so it's normal YT (full player, related videos).
      if (document.body.classList.contains('hs-offline')) {
        ['#player-container-outer', '#player-container-inner', '#player-container', '#player', 'ytd-player#ytd-player'].forEach(s => {
          const e = document.querySelector(s);
          if (e && e.dataset._hsCYtSized === '1') {
            delete e.dataset._hsCYtSized;
            ['width', 'height', 'max-width', 'max-height', 'min-height'].forEach(p => e.style.removeProperty(p));
          }
        });
        document.documentElement.style.removeProperty('--hs-yt-below-top');
        return;
      }
      const sec = document.querySelector('#secondary');
      if (sec) {
        if (isRight) {
          sec.style.removeProperty('width');
          sec.style.removeProperty('min-width');
          sec.style.removeProperty('max-width');
          sec.style.removeProperty('flex');
          // applyYouTubeChatWidth will reset width on next reflow
        } else {
          sec.style.setProperty('width', '0', 'important');
          sec.style.setProperty('min-width', '0', 'important');
          sec.style.setProperty('max-width', '0', 'important');
          sec.style.setProperty('flex', '0 0 0', 'important');
        }
      }
      // Keep --hs-yt-below-top synced to the real video bottom via a
      // ResizeObserver (robust against fresh-load timing). Retries each run
      // until #movie_player exists; re-observes the new player on SPA nav.
      _hsEnsureYtBelowObserver();
      // Force aspect-preserved player size inline on the player WRAPPER chain.
      // We deliberately omit #movie_player itself — YT's controls (volume,
      // play, settings) compute hit-targets from #movie_player's intrinsic
      // dimensions, and forcing a size on it desyncs the click hitboxes from
      // the visible buttons. Sizing the wrappers only constrains the player
      // visually (movie_player fills its parent via CSS) without disturbing
      // YT's controls geometry.
      const ytSelectors = [
        '#player-container-outer',
        '#player-container-inner',
        '#player-container',
        '#player',
        'ytd-player#ytd-player',
      ];
      const ytSizedEls = ytSelectors.map(s => document.querySelector(s)).filter(Boolean);
      const PLAYER_GEOM = ['width', 'height', 'max-width', 'max-height', 'min-height'];
      if (chatPosition === 'top' || chatPosition === 'bottom' || chatPosition === 'left' || chatPosition === 'right') {
        // Compute aspect-preserved player size for the freed area.
        // top/bottom: chat eats height, player fills the rest (full width).
        // left/right: chat eats width, player fills the rest (full height).
        // Use clientWidth (NOT innerWidth) — innerWidth counts the ~15px
        // vertical scrollbar that the fixed panel anchors outside of, so
        // sizing off innerWidth makes the player overshoot its column and
        // tuck its right edge (where the Skip Ad / fullscreen buttons live)
        // under the panel.
        const usableW = document.documentElement.clientWidth;
        let availH, availW;
        if (chatPosition === 'left' || chatPosition === 'right') {
          // Opt-in suggestions strip eats a fixed column beside the player on
          // left/right dock — subtract it or the player renders UNDER the strip
          // (overshoots its column, clips off-edge). Publish the width so the
          // stylesheet (#below inset + strip geometry) and this arithmetic stay
          // in lockstep. Off → drop the var so CSS sees 0 contribution.
          const suggOn = document.body.classList.contains('hs-yt-suggestions');
          const suggW = suggOn ? YT_SUGG_STRIP_W : 0;
          if (suggOn) document.documentElement.style.setProperty('--hs-yt-sugg-w', suggW + 'px');
          else document.documentElement.style.removeProperty('--hs-yt-sugg-w');
          availW = Math.max(200, usableW - chatWidth - suggW);
          availH = innerHeight;
        } else {
          availH = Math.max(200, innerHeight - chatHeight);
          availW = usableW - 32;
        }
        const aspectW = availH * 16 / 9;
        const aspectH = availW * 9 / 16;
        // Pick the dimension that hits its limit first (16:9 fits inside both)
        let finalW, finalH;
        if (aspectW <= availW) { finalW = aspectW; finalH = availH; }
        else                   { finalW = availW; finalH = aspectH; }
        const wPx = Math.round(finalW) + 'px';
        const hPx = Math.round(finalH) + 'px';
        for (const el of ytSizedEls) {
          el.dataset._hsCYtSized = '1';
          el.style.setProperty('width', wPx, 'important');
          el.style.setProperty('height', hPx, 'important');
          el.style.setProperty('max-width', wPx, 'important');
          el.style.setProperty('max-height', hPx, 'important');
          el.style.setProperty('min-height', '0', 'important');
        }
        requestAnimationFrame(() => {
          for (const el of ytSizedEls) {
            if (!el.dataset._hsCYtSized) continue;
            el.style.setProperty('width', wPx, 'important');
            el.style.setProperty('height', hPx, 'important');
            el.style.setProperty('max-width', wPx, 'important');
            el.style.setProperty('max-height', hPx, 'important');
          }
          // Left/right: publish the REAL video bottom so the CSS can pin the
          // metadata column (#below) directly under it. On live/single-column
          // YT renders the player in #full-bleed-container and reserves more
          // flow height than the shrunk 16:9 video uses — that reserved-but-
          // empty band is the black gap. Reading #movie_player's rendered rect
          // (we never resize it ourselves) works for both single- and two-
          // column layouts. Skip in theater/fullscreen (no metadata column).
          if (chatPosition === 'left' || chatPosition === 'right') {
            const flexy = document.querySelector('ytd-watch-flexy')
            const special = flexy && (flexy.hasAttribute('theater') || flexy.hasAttribute('fullscreen'))
            const mp = document.querySelector('#movie_player') || document.querySelector('.html5-video-player')
            const b = mp && mp.getBoundingClientRect()
            if (!special && b && b.height > 0) {
              document.documentElement.style.setProperty('--hs-yt-below-top', Math.round(b.bottom) + 'px')
            } else {
              document.documentElement.style.removeProperty('--hs-yt-below-top')
            }
          } else {
            // top/bottom (or any non-left/right that still reached here): the
            // pin is left/right-only, so clear any stale value from a prior dock.
            document.documentElement.style.removeProperty('--hs-yt-below-top')
          }
        });
      } else {
        for (const el of ytSizedEls) {
          if (el.dataset._hsCYtSized === '1') {
            delete el.dataset._hsCYtSized;
            PLAYER_GEOM.forEach(p => el.style.removeProperty(p));
          }
        }
        document.documentElement.style.removeProperty('--hs-yt-below-top')
      }
    } else if (isKick) {
      // Keep --hs-kick-sidebar-w in sync — Kick drops the sidebar from the
      // DOM at narrow widths, and main's padding-left depends on this value.
      syncKickSidebarVar()
      // Kick's player chain uses Tailwind `aspect-video w-full` which locks
      // height = width × 9/16 — it ignores the freed area when chat eats
      // top/bottom. Force aspect-preserved width + height inline on the
      // player wrapper + injected container. Don't touch <main> — that's
      // the entire content column.
      const injected = document.querySelector('#injected-channel-player')
      const playerWrap = injected?.parentElement   // div.bg-black, immediate player box
      const kickPlayerEls = [playerWrap, injected].filter(Boolean)
      const KICK_PLAYER_GEOM = ['width', 'height', 'max-width', 'max-height', 'min-height', 'aspect-ratio']
      // Strip stale overrides from any element no longer in our target list.
      // First buggy version of this branch targeted <main> by mistake, so
      // clean up any leftover marker so legacy inline styles don't pin main's
      // size after a fresh load.
      const targetSet = new Set(kickPlayerEls)
      for (const stale of document.querySelectorAll('[data-_hs-c-kick-sized]')) {
        if (targetSet.has(stale)) continue
        delete stale.dataset._hsCKickSized
        KICK_PLAYER_GEOM.forEach(p => stale.style.removeProperty(p))
      }
      if (chatPosition === 'top' || chatPosition === 'bottom' || chatPosition === 'left' || chatPosition === 'right') {
        const navEl = document.querySelector('nav, [class*="navbar"]')
        const navH = navEl ? Math.round(navEl.getBoundingClientRect().height) : 60
        // Kick reserves space for its left sidebar (~56px) inside main's flex
        // parent — when the sidebar is present, the freed video area is
        // innerWidth - chatWidth - sidebar. Use the live measurement (not a
        // CSS var) because Kick drops the sidebar from the DOM at narrow
        // viewports, where subtracting 56 would shrink the player needlessly.
        const sidebarW = getKickSidebarWidth()
        let availH, availW
        if (chatPosition === 'right') {
          availW = Math.max(200, innerWidth - chatWidth - sidebarW)
          availH = Math.max(200, innerHeight - navH)
        } else if (chatPosition === 'left') {
          // chat panel is fixed at left:0 width:chatW — it covers the sidebar.
          // Subtracting sidebar again leaves a useless gap on the right edge
          // of the video.
          availW = Math.max(200, innerWidth - chatWidth)
          availH = Math.max(200, innerHeight - navH)
        } else {
          availH = Math.max(200, innerHeight - chatHeight - navH)
          availW = Math.max(200, innerWidth - sidebarW)
        }
        const aspectW = availH * 16 / 9
        const aspectH = availW * 9 / 16
        let finalW, finalH
        if (aspectW <= availW) { finalW = aspectW; finalH = availH }
        else                   { finalW = availW; finalH = aspectH }
        const wPx = Math.round(finalW) + 'px'
        const hPx = Math.round(finalH) + 'px'
        for (const el of kickPlayerEls) {
          el.dataset._hsCKickSized = '1'
          el.style.setProperty('width', wPx, 'important')
          el.style.setProperty('height', hPx, 'important')
          el.style.setProperty('max-width', wPx, 'important')
          el.style.setProperty('max-height', hPx, 'important')
          el.style.setProperty('aspect-ratio', 'auto', 'important')
        }
        // Kick re-asserts inline `height: unset` on the wrapper post-render.
        // Re-apply on the next frame so our values stick.
        requestAnimationFrame(() => {
          for (const el of kickPlayerEls) {
            if (!el.dataset._hsCKickSized) continue
            el.style.setProperty('width', wPx, 'important')
            el.style.setProperty('height', hPx, 'important')
            el.style.setProperty('max-width', wPx, 'important')
            el.style.setProperty('max-height', hPx, 'important')
          }
        })
      } else {
        // chat-right: clear our overrides — Kick's native layout owns sizing.
        for (const el of kickPlayerEls) {
          if (el?.dataset._hsCKickSized === '1') {
            delete el.dataset._hsCKickSized
            KICK_PLAYER_GEOM.forEach(p => el.style.removeProperty(p))
          }
        }
      }
    } else {
      // Twitch
      const rc = document.querySelector('.right-column');
      if (rc) {
        if (isRight) {
          // Restore: clear our overrides; Twitch's own width logic will
          // re-assert on next layout pass.
          rc.style.removeProperty('width');
          rc.style.removeProperty('min-width');
          rc.style.removeProperty('max-width');
          rc.style.removeProperty('flex-shrink');
        } else {
          rc.style.setProperty('width', '0', 'important');
          rc.style.setProperty('min-width', '0', 'important');
          rc.style.setProperty('max-width', '0', 'important');
        }
      }
      // .persistent-player has inline height:100%/max-height:100vh that
      // ignores any CSS bottom: inset. Override the player's geometry
      // directly so the chat strip doesn't sit on top of the video.
      const pp = document.querySelector('.persistent-player');
      if (pp) {
        if (isRight) {
          // Twitch's persistent-player has position:absolute with no CSS
          // rule setting `top`. The previous code removed inline top expecting
          // Twitch's React effect to re-apply it — but on certain layouts
          // (narrow window / chat resize / cold load) Twitch never sets it,
          // so the element falls to its natural-flow position at the bottom
          // of root-scrollable__wrapper (y ≈ 2000+px), pushing the video
          // off-screen below the about section. Pin it explicitly to top:0
          // (within root-scrollable__wrapper, that's the player slot).
          pp.style.setProperty('top', '0', 'important');
          pp.style.setProperty('left', '0', 'important');
          pp.style.removeProperty('bottom');
          pp.style.removeProperty('right');
          pp.style.removeProperty('max-height');
          pp.style.removeProperty('height');
          pp.style.removeProperty('width');
        } else if (chatPosition === 'left') {
          // chat-left: only shift the player horizontally. Don't touch
          // top/bottom/right/width/height — Twitch's natural 16:9 sizing
          // already gives the right height (and leaves room for the
          // channel-info bar below the player). Forcing bottom:0 here
          // would stretch the player to full viewport height and overlap
          // the follow/sub/gift buttons. Width/height CSS rule below is
          // also gated to chat-top/bottom only.
          // Note: w above is a CSS string ("Npx"); for arithmetic use
          // the raw chatWidth number.
          // Containing block (.root-scrollable__wrapper) starts AFTER
          // Twitch's side-nav (50px collapsed, ~240px expanded on wide
          // viewports), which our HS panel covers, so subtract the live
          // nav width to avoid double-counting.
          const leftInsetPx = Math.max(0, chatWidth - _twitchSideNavW) + 'px';
          pp.style.setProperty('left', leftInsetPx, 'important');
          pp.style.setProperty('inset-inline-start', leftInsetPx, 'important');
        } else {
          // chat-top / chat-bottom: full overhaul. Width/height are
          // handled by the .hs-chat-* CSS rules (width:auto !important /
          // height:auto !important). We can't do it here via inline
          // setProperty('important') because Twitch's React effect later
          // does `el.style.height = 'X'` which wipes the inline priority
          // — only a stylesheet rule survives that.
          pp.style.removeProperty('width');
          pp.style.removeProperty('height');
          pp.style.removeProperty('max-height');
          pp.style.setProperty('top', chatPosition === 'top' ? h : '0', 'important');
          pp.style.setProperty('bottom', chatPosition === 'bottom' ? h : '0', 'important');
          pp.style.setProperty('left', '0', 'important');
          pp.style.setProperty('right', '0', 'important');
          pp.style.setProperty('inset-inline-start', '0', 'important');
          pp.style.setProperty('inset-inline-end', '0', 'important');
        }
      }
    }

    // If the platform re-asserts its inline width/height (e.g. Twitch's
    // own chat-width JS on resize), we re-apply on the same hooks the
    // platform uses: window.resize + chat-width persistence. No observer
    // here — observers on style attrs loop on our own writes.
  }

  function rotateChatPosition() {
    // C cycles 4 visible. Hidden via toggleChatHidden(). From hidden → previous-visible.
    if (document.body.classList.contains('hs-popout')) return;
    const positions = ['right', 'bottom', 'left', 'top'];
    const prev = chatPosition;
    if (chatPosition === 'hidden') {
      chatPosition = positions.includes(chatPositionPrevious) ? chatPositionPrevious : 'right';
    } else {
      let idx = positions.indexOf(chatPosition);
      if (idx === -1) idx = 0;
      chatPosition = positions[(idx + 1) % positions.length];
    }
    log('rotate-chat:', prev, '→', chatPosition);
    setSetting('chatPosition', chatPosition); // applier applies + tracks previous
  }

  // ============================================
  // CHAT HIDE/SHOW TOGGLE — \ key + edge-pill.
  // chatPositionPrevious survives across hide cycles so restore lands on the
  // last-known visible position, not the default 'right'.
  // ============================================
  let chatPositionPrevious = 'right';

  function toggleChatHidden() {
    if (document.body.classList.contains('hs-popout')) return;
    const visible = ['right', 'bottom', 'left', 'top'];
    if (chatPosition === 'hidden') {
      chatPosition = visible.includes(chatPositionPrevious) ? chatPositionPrevious : 'right';
    } else {
      if (visible.includes(chatPosition)) chatPositionPrevious = chatPosition;
      chatPosition = 'hidden';
    }
    saveUiSetting('chatPositionPrevious', chatPositionPrevious);
    setSetting('chatPosition', chatPosition);
    log('[chat-toggle] →', chatPosition, 'prev:', chatPositionPrevious);
  }

  // Edge-pill: orange strip pinned to the edge where chat last lived. Click to
  // restore (not a resize bar) — kept visible/thick on purpose, #ff8700, no text.
  function ensureChatRestorePill(show) {
    let pill = document.getElementById('hs-chat-restore-pill');
    if (!show) { if (pill) pill.remove(); return; }
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'hs-chat-restore-pill';
      pill.title = 'show chat (\\)';
      pill.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleChatHidden();
      });
      pill.addEventListener('mousedown', (e) => e.stopPropagation());
      document.body.appendChild(pill);
    }
    const edge = ['right', 'bottom', 'left', 'top'].includes(chatPositionPrevious) ? chatPositionPrevious : 'right';
    pill.dataset.edge = edge;
  }

  // Resolve the channel context to popout for the active tab.
  // Returns { name, twitch, kick, youtube } or null if no channel context.
  function resolvePopoutContext() {
    const id = currentTab
    if (!id) return null
    // Per-channel tab → use its config row directly
    if (_isChatTab(id) && id !== 'live') {
      const ch = (config.channels || []).find(c => c.id === id)
      if (!ch) return null
      return { name: ch.id, twitch: ch.twitch || '', kick: ch.kick || '', youtube: ch.youtube || '' }
    }
    // Live tab → use the live channel for the host platform
    if (id === 'live') {
      const ch = (getLiveChannel() || '').toLowerCase()
      if (!ch) return null
      const ctx = { name: ch, twitch: '', kick: '', youtube: '' }
      if (hostPlatform === 'twitch') ctx.twitch = ch
      else if (hostPlatform === 'kick') ctx.kick = ch
      else if (hostPlatform === 'yt') ctx.youtube = ch
      return (ctx.twitch || ctx.kick || ctx.youtube) ? ctx : null
    }
    return null
  }

  // Pop out the active tab to the host platform's native chat popout window
  // (twitch.tv / kick.com / youtube.com). When a tab is linked to multiple
  // platforms, prefer the platform we're currently browsing on so the user
  // gets the chat for the page they're already watching.
  function openPopoutForCurrentTab() {
    const ctx = resolvePopoutContext()
    if (!ctx) return

    // Pick which platform's native chat to open. Prefer host platform if the
    // tab has a channel for it; else fall back to whichever platform exists.
    const hostPick = (hostPlatform === 'twitch' && ctx.twitch) ? 'twitch'
                   : (hostPlatform === 'kick' && ctx.kick) ? 'kick'
                   : (hostPlatform === 'yt' && ctx.youtube) ? 'youtube'
                   : null
    const platform = hostPick
      || (ctx.twitch ? 'twitch' : ctx.kick ? 'kick' : ctx.youtube ? 'youtube' : null)
    if (!platform) return

    let url, features = 'width=400,height=600,menubar=no,toolbar=no,location=no,status=no'
    if (platform === 'twitch') {
      url = `https://www.twitch.tv/popout/${ctx.twitch}/chat?popout=`
    } else if (platform === 'kick') {
      url = `https://kick.com/popout/${ctx.kick}/chat`
    } else if (platform === 'youtube') {
      // youtube live_chat needs a videoId — pull from cached youtubeLinks
      // if the active tab is in there; else fall back to channel-page redirect.
      const link = youtubeLinks.get(currentTab)
      if (link?.videoId) {
        url = `https://www.youtube.com/live_chat?v=${link.videoId}&is_popout=1`
      } else {
        // ctx.youtube is the original watch URL — open it in a small window
        // so the user can use yt's own popout-chat from there.
        url = ctx.youtube
      }
    }
    try {
      window.open(url, `hs-popout-${platform}-${ctx.name}`, features)
    } catch (e) { log('popout open failed:', e) }
  }

  // Show the popout button when the active tab has a channel context.
  // Hidden on static tabs (feed/mentions/whispers/pinned/settings/add).
  function updatePopoutBtnVisibility() {
    const btn = tabBarElement?.querySelector('.hs-mc-popout-btn')
    if (!btn) return
    btn.style.display = resolvePopoutContext() ? '' : 'none'
  }

  // Drop a panel callout (status/error banner) directly below the search/filter
  // bar — never above it, where it would shove the filter input down on reload.
  // Falls back to the container top only if the overlay isn't mounted yet.
  function _insertPanelCallout(el) {
    const searchBar = document.getElementById('hs-mc-search-bar')
    if (searchBar && searchBar.parentNode) { searchBar.parentNode.insertBefore(el, searchBar.nextSibling); return }
    const container = document.getElementById('hs-mc-container')
    if (container) container.insertBefore(el, container.firstChild)
  }

  // Render a small banner inside the multichat panel when an upstream API is unreachable.
  // Auto-removes when state flips back to 'up'. Only renders when our panel is mounted.
  function showApiStatusBanner(source, state) {
    const container = document.getElementById('hs-mc-container')
    if (!container) return
    const id = 'hs-mc-api-banner-' + (source || 'unknown').replace(/[^a-z0-9_-]/gi, '')
    const existing = document.getElementById(id)
    if (state === 'up') { existing?.remove(); return }
    if (existing) return
    const banner = document.createElement('div')
    banner.id = id
    banner.className = 'hs-mc-api-banner'
    banner.style.cssText = 'background:#ff8700;color:#000;font:600 11px/1.4 monospace;padding:6px 10px;text-align:center;display:flex;align-items:center;justify-content:center;gap:8px;'
    const label = source === 'heatsync' ? 'heatsync.org unreachable — reconnecting' : `${source} unreachable`
    const text = document.createElement('span')
    text.textContent = label
    const dismiss = document.createElement('span')
    dismiss.textContent = '×'
    dismiss.style.cssText = 'cursor:pointer;font-weight:700;padding:0 4px;'
    dismiss.addEventListener('click', () => banner.remove())
    banner.append(text, dismiss)
    _insertPanelCallout(banner)
  }

  // Auth banner: shown when bg signals loggedIn=false AND the user has at least
  // one channel with a youtube URL — YT chat needs server-side scraping, which
  // requires auth, so without it the user sees zero YT messages and no clue why.
  function showAuthLoginBanner(loggedIn) {
    const container = document.getElementById('hs-mc-container')
    if (!container) return
    const id = 'hs-mc-auth-banner'
    const existing = document.getElementById(id)
    if (loggedIn) { existing?.remove(); return }
    const hasYt = Array.isArray(config?.channels) && config.channels.some(c => c.youtube)
    if (!hasYt) { existing?.remove(); return }
    if (existing) return
    const banner = document.createElement('div')
    banner.id = id
    banner.className = 'hs-mc-auth-banner'
    banner.style.cssText = 'background:#ff8700;color:#000;font:600 11px/1.4 monospace;padding:6px 10px;text-align:center;display:flex;align-items:center;justify-content:center;gap:8px;'
    const text = document.createElement('span')
    text.textContent = 'youtube chat needs heatsync login —'
    const link = document.createElement('a')
    link.href = 'https://heatsync.org/settings/account'
    link.target = '_blank'
    link.rel = 'noopener'
    link.textContent = 'sign in'
    link.style.cssText = 'color:#000;text-decoration:underline;font-weight:700;'
    const dismiss = document.createElement('span')
    dismiss.textContent = '×'
    dismiss.style.cssText = 'cursor:pointer;font-weight:700;padding:0 4px;margin-left:4px;'
    dismiss.addEventListener('click', () => banner.remove())
    banner.append(text, link, dismiss)
    _insertPanelCallout(banner)
  }

  function listenForSettingsChanges() {
    if (window._hsMcSettingsListener) return;
    window._hsMcSettingsListener = true;

    // Listen for messages from popup — tracked through cleanup so SPA
    // reinit removes the prior handler and replaces it.
    cleanup.addListener(chrome.runtime?.onMessage, (msg) => {
      if (msg.type === 'ui_settings_changed' && msg.settings) {
        log('Settings changed via message:', msg.settings);
        if (msg.settings.tabPosition !== undefined && msg.settings.tabPosition !== tabPosition) {
          tabPosition = msg.settings.tabPosition;
          applyTabsPosition();
        }
        if (msg.settings.chatPosition !== undefined && msg.settings.chatPosition !== chatPosition) {
          chatPosition = msg.settings.chatPosition;
          applyChatPosition();
        }
      }
      if (msg.type === 'debug_log' && MC_DEBUG) console.log('[hs-bg]', msg.msg)
      if (msg.type === 'api_status') {
        try { showApiStatusBanner(msg.source, msg.state) } catch (e) {}
      }
      if (msg.type === 'auth_changed') {
        try { showAuthLoginBanner(!!msg.loggedIn) } catch (e) {}
      }
      if (msg.type === 'cosmetics_update') {
        const bttv = Object.entries(msg.bttvBadges || {})
        const ffz = Object.entries(msg.ffzBadges || {})
        const chat = Object.entries(msg.chatterinoBadges || {})
        // Never let an empty broadcast wipe populated maps.
        if (bttv.length + ffz.length + chat.length > 0) {
          mcBttvBadgeMap = new Map(bttv)
          mcFfzBadgeMap = new Map(ffz)
          mcChatterinoBadgeMap = new Map(chat)
          // In-place patch instead of bumpRenderEpoch()+rebuild (the flash).
          // Current tab's live rows get badges injected now; other tabs drop
          // their snapshot caches so they rebuild fresh on switch (mirrors
          // invalidateRenderedForEmotes — no epoch bump, current tab untouched).
          updateThirdPartyBadgesInPlace()
          _dropAllTabCaches()
        }
      }
      // SW pushes its `/api/live/following` snapshot every ~60s. Consume it
      // here so we can skip /api/platform/live-status calls for the channels
      // it already covers — the bulk of the 100k-client live-poll load.
      if (msg.type === 'live_followed_updated') {
        try { _applyFollowedSnapshot(msg.snapshot) } catch {}
      }
      // 7TV EventAPI pushed user.update / entitlement.* — drop our local
      // cosmetic cache and re-queue lookup so badges/paint show up fresh.
      if (msg.type === 'cosmetics_invalidated' && msg.twitchId) {
        mcUserCosmetics.delete(String(msg.twitchId))
        // Re-queue lookup; updateCosmeticsInPlace fires on response and adds
        // the badge to all existing messages with this uid.
        queueMcCosmeticsLookup(String(msg.twitchId))
      }
      // Listen for emote updates from background
      if (msg.type === 'global_emotes_update' || msg.type === 'channel_emotes_update') {
        // Channel updates: take the broadcast payload at face value and populate
        // channelEmoteCaches synchronously. BG sends multiple coalesced broadcasts
        // during a fetch (one per provider) and only writes storage AFTER the
        // final one — the old loadEmotes-from-storage path raced with that write
        // and could leave the cache empty for a channel whose fetch completed
        // mid-debounce. Direct populate sidesteps the race entirely.
        if (msg.type === 'channel_emotes_update' && msg.channelOwner && Array.isArray(msg.emotes)) {
          // platform tag lets the panel keep both sets for a same-name twitch+kick
          // simulcast instead of one overwriting the other (merge-per-platform).
          _buildChannelEmoteCache(msg.channelOwner.toLowerCase(), msg.emotes, msg.platform)
          markPickerDirty()
        }
        // Cold-start (first emote payload for this scope) needs clear+rerender
        // so old plain-text messages from history pick up newly-loaded emotes.
        // Subsequent updates (add/remove via 7TV EventAPI) preserve _renderedHtml
        // — old messages keep their emote rendering even if an emote is removed.
        // History is sacred: what was rendered as an emote stays an emote.
        const scope = msg.type === 'channel_emotes_update' ? `ch:${msg.channelOwner || '_'}` : 'global'
        _pendingEmoteScopes.add(scope)
        cleanup.clearTimeout(emoteReloadTimer);
        emoteReloadTimer = cleanup.setTimeout(() => {
          const pending = _pendingEmoteScopes
          _pendingEmoteScopes = new Set()
          loadEmotes().then(() => {
            let firstLoad = false
            for (const s of pending) {
              if (!_emoteFirstLoad.has(s)) { _emoteFirstLoad.add(s); firstLoad = true }
            }
            // First emote payload for this scope: plain-text history rows need to
            // pick up the now-renderable emotes. In-place text swap instead of
            // clearRenderedHtmlCache()→epoch bump→full rebuild (the flash).
            if (firstLoad) reloadEmotesInPlace();
          });
        }, 300);
      }
      // Inventory changes: update membership + viewer's personal set.
      // CRITICAL: do NOT add inventory items to emoteCache (the global render
      // pool). emoteCache is consulted as a fallback for OTHER senders'
      // messages, so writing the viewer's inventory there made viewer-owned
      // emotes render for every sender's messages — exactly the "personal set
      // bleed" that viewerPersonalEmotes was built to prevent (see line 1389).
      // Lookups for own outgoing use senderEmotes=viewerPersonalEmotes; tab
      // completion / picker use lookupEmote() which checks viewerPersonalEmotes
      // first. emoteCache only needs the state flipped when the same name is
      // ALSO a heatsync global.
      if (msg.type === 'open_channels') {
        try { reconcileAutoTabs(Array.isArray(msg.channels) ? msg.channels : []) } catch (_) {}
        return
      }
      if (msg.type === 'hs_moment') {
        try { handleMomentSpike(msg.data) } catch (_) {}
        return
      }
      if (msg.type === 'inventory_update') {
        const prevInventory = new Set(inventoryEmotes)
        inventoryEmotes.clear();
        inventoryHashes.clear();
        (msg.emotes || []).forEach(e => {
          if (e.name) {
            inventoryEmotes.add(e.name);
            if (e.hash) inventoryHashes.set(e.name, e.hash);
            // Flip state for emotes that are ALSO in the heatsync globals pool;
            // do not ADD new entries to emoteCache here.
            if (emoteCache.has(e.name)) {
              const c = emoteCache.get(e.name);
              c.state = 'owned';
              if (e.slot != null) c.slot = e.slot;
            }
            if (e.url) {
              // Recover overlay flag for emotes whose server row is pre-zero_width
              // (DB column added 2026-05-23; rows added before that have FALSE).
              // The 7TV channel/global caches still carry the flag — borrow it so
              // a viewer's pre-existing CarrotTime/wavE stacks without re-adding.
              const zwFromAny = (typeof zeroWidthFromAnyCache === 'function') ? zeroWidthFromAnyCache(e.name) : false
              viewerPersonalEmotes.set(e.name, { url: e.url, source: 'heatsync', state: 'owned', hash: e.hash, slot: e.slot, zeroWidth: !!(e.zero_width ?? e.zeroWidth ?? zwFromAny) });
            }
          }
        });
        // Remove emotes no longer in inventory from cache (if heatsync source)
        for (const [name, emote] of emoteCache) {
          if (emote.source === 'heatsync' && !inventoryEmotes.has(name)) {
            emoteCache.delete(name);
          }
        }
        for (const name of viewerPersonalEmotes.keys()) {
          if (!inventoryEmotes.has(name)) viewerPersonalEmotes.delete(name);
        }
        // Flip already-rendered wrappers in chat: owned ↔ unadded so a just-
        // posted emote that the viewer then removes turns orange instead of
        // staying green. No-op on names whose membership didn't change.
        const removed = [...prevInventory].filter(n => !inventoryEmotes.has(n))
        const added = [...inventoryEmotes].filter(n => !prevInventory.has(n))
        for (const n of removed) refreshEmoteWrappersState(n)
        for (const n of added) refreshEmoteWrappersState(n)
        // Newly-owned names also need _renderedHtml invalidated so a row that
        // rendered the name as plain text (because viewerPersonalEmotes was empty
        // at the time — startup race / inventory wipe before refetch) re-resolves
        // to an emote img on the next paint. refreshEmoteWrappersState only flips
        // existing wrappers; it can't conjure one out of a text node.
        if (added.length && typeof invalidateRenderedForEmotes === 'function') {
          invalidateRenderedForEmotes(added)
        }
        // First inventory_update after page load: the buffer may contain rows
        // rendered with an EMPTY viewerPersonalEmotes (any name now in inventory
        // would have processed as plain text). Brute-force invalidate everything
        // ONCE so those rows re-resolve to emote imgs. Subsequent updates use
        // the per-name path above (cheap).
        if (!window.__hsInventoryEverLoaded) {
          window.__hsInventoryEverLoaded = true
          if (typeof invalidateRenderedForEmotes === 'function' && inventoryEmotes.size) {
            invalidateRenderedForEmotes([...inventoryEmotes])
          }
        }
        log('inventory_update:', inventoryEmotes.size, 'emotes');
        // Inventory just changed emoteCache contents — picker is stale.
        markPickerDirty();
        prebuildPickerIdle();
        // Background probe: for owned 7TV emotes whose zeroWidth ended up FALSE
        // (DB row predates the column AND no loaded channel set carries the flag
        // — e.g. an emote added via picker search without subscribing to a
        // channel that owns it), hit 7tv.io/v3/emotes/{hash} to recover the
        // overlay flag and POST a sticky-true upgrade to the server. Cached in
        // window.__hsZwProbed so we don't re-probe across inventory polls.
        if (!window.__hsZwProbed) window.__hsZwProbed = new Set()
        const _probeTargets = []
        for (const [name, em] of viewerPersonalEmotes) {
          if (em.zeroWidth) continue
          if (window.__hsZwProbed.has(name)) continue
          // Only 7TV CDN URLs have a usable hash for the REST emote-by-id probe.
          if (!em.url || !em.url.includes('cdn.7tv.app/emote/')) continue
          const m = em.url.match(/cdn\.7tv\.app\/emote\/([A-Z0-9]+)/i)
          const sevenTvId = m?.[1] || em.hash
          if (!sevenTvId) continue
          window.__hsZwProbed.add(name)
          _probeTargets.push({ name, sevenTvId, em })
        }
        if (_probeTargets.length) {
          // Trickle 4-at-a-time so a viewer with 200 owned 7TV emotes doesn't
          // flash-fire 200 simultaneous 7TV fetches on every inventory_update.
          const _runProbeBatch = async (batch) => {
            await Promise.allSettled(batch.map(async ({ name, sevenTvId, em }) => {
              try {
                const r = await fetch('https://7tv.io/v3/emotes/' + sevenTvId).then(r => r.ok ? r.json() : null)
                const isZw = !!(r && ((r.flags || 0) & 256))
                if (!isZw) return
                em.zeroWidth = true
                if (typeof invalidateRenderedForEmotes === 'function') invalidateRenderedForEmotes([name])
                // Sticky-true upgrade on the server so every other viewer of any
                // sender owning this emote inherits the flag too.
                try { chrome.runtime.sendMessage({ type: 'add_to_inventory', emoteName: name, emoteHash: em.hash || sevenTvId, emoteUrl: em.url, zeroWidth: true }, () => {}) } catch (_) {}
              } catch (_) {}
            }))
          }
          ;(async () => {
            for (let i = 0; i < _probeTargets.length; i += 4) {
              await _runProbeBatch(_probeTargets.slice(i, i + 4))
            }
          })()
        }
      }

      // Cross-platform mute sync (from background.js — other tabs, server WS, or expiry)
      if (msg.type === 'user_muted') {
        const u = msg.username?.toLowerCase()
        if (u && !mutedUsers.has(u)) {
          mutedUsers.add(u)
          applyMcMutes()
        }
      }
      if (msg.type === 'user_unmuted') {
        const u = msg.username?.toLowerCase()
        if (u && mutedUsers.has(u)) {
          mutedUsers.delete(u)
          restoreMcUnmutedDom(u)
          renderMessages(currentTab)
        }
      }
      // Server cleared the entire mute list (e.g. user clicked "clear all" on heatsync.org)
      if (msg.type === 'mutes_cleared' && mutedUsers.size > 0) {
        for (const u of mutedUsers) restoreMcUnmutedDom(u)
        mutedUsers.clear()
        renderMessages(currentTab)
      }
      // Cross-surface block sync (content.js, other tabs). Full re-render so blocked
      // users drop out / reappear (buildMessageDiv filters them).
      if (msg.type === 'user_blocked') {
        const u = msg.username?.toLowerCase()
        if (u && !blockedUsers.has(u)) { blockedUsers.add(u); renderMessages(currentTab) }
      }
      if (msg.type === 'user_unblocked') {
        const u = msg.username?.toLowerCase()
        if (u && blockedUsers.delete(u)) renderMessages(currentTab)
      }

      // A different user added an emote to their set. Drop the freshness
      // stamp on every cached sender so the next render of any of their
      // messages triggers a refetch, picking up the new emote without
      // waiting for the 5-min senderEmoteFetchedAt TTL. We don't know which
      // sender key this user maps to (msg.username != twitch_id), so we
      // bust everyone — next render of any message refreshes.
      if (msg.type === 'emote_added_broadcast') {
        try {
          if (typeof senderEmoteFetchedAt !== 'undefined') senderEmoteFetchedAt.clear()
        } catch (_) {}
      }

      // A different user removed an emote from their set. Background already
      // dropped __senderEmoteCache; mirror in the panel's persisted
      // senderEmoteSets so we stop imagifying their now-gone name. Re-render
      // matching messages so the wrappers become raw text (or fall through to
      // channel/global pool, if present).
      if (msg.type === 'emote_removed_broadcast' && msg.emoteName) {
        const changed = typeof dropEmoteFromAllSenders === 'function'
          ? dropEmoteFromAllSenders(msg.emoteName) : false
        if (changed) {
          try {
            const inv = (buf) => {
              if (!buf) return
              const arr = (typeof buf.forEach === 'function' && !Array.isArray(buf)) ? null : buf
              const iter = arr || (typeof buf.values === 'function' ? buf.values() : null)
              if (!iter) return
              for (const m of iter) {
                if (m && m.text && m.text.includes(msg.emoteName)) m._renderedHtml = null
              }
            }
            // Twitch + Kick IRC buffers (per-channel)
            try { for (const ch of (irc?.channels?.keys?.() || [])) inv(irc.getMessages(ch)) } catch (_) {}
            try { for (const ch of (kickChat?.channels?.keys?.() || [])) inv(kickChat.getMessages(ch)) } catch (_) {}
            if (typeof mentionsBuffer !== 'undefined') inv(mentionsBuffer)
            if (typeof channelYtMessages !== 'undefined') channelYtMessages.forEach(inv)
            renderMessages(currentTab)
          } catch (_) {}
        }
      }

      // Server-evaluated mention rule match — show as inline toast
      if (msg.type === 'mention_rule_match') {
        const channel = String(msg.channel || '').toLowerCase()
        const username = String(msg.username || '')
        const snippet = String(msg.snippet || '').slice(0, 200)
        const pattern = String(msg.pattern || '')
        try {
          HsNotifs.emit('server-mention-rule', { channel, username, snippet, pattern })
        } catch (_) {}
      }

      // 7TV emote add/remove — surface as an inline stream-event in the
      // matching channel tab (and live tab if it IS the live channel).
      if (msg.type === 'channel_emote_added' || msg.type === 'channel_emote_removed') {
        log('7TV emote change:', msg.message);
        const channel = (msg.channel || '').toLowerCase()
        if (!channel) return
        const actor = msg.actor || ''
        // Stale-emote ghost: when an emote leaves the channel set, mark
        // historical messages so the cached IMG renders dimmed + tagged with
        // who removed it. Restored on re-add. Persisted to chrome.storage so
        // it survives reload. 7-day TTL handled at read.
        const _staleReg = window._hsStaleEmotes || (window._hsStaleEmotes = new Map())
        const _ensureChannel = (ch) => { let m = _staleReg.get(ch); if (!m) { m = new Map(); _staleReg.set(ch, m) } return m }
        const _persistStale = () => {
          try {
            const out = {}; const cutoff = Date.now() - 7 * 86400000
            for (const [ch, m] of _staleReg) {
              const entries = []
              for (const [name, meta] of m) { if ((meta?.at || 0) >= cutoff) entries.push([name, meta]) }
              if (entries.length) out[ch] = entries.slice(-100)
            }
            chrome.storage.local.set({ hs_stale_emotes_v1: out }).catch(() => {})
          } catch (e) {}
        }
        const _patchDom = (emoteName, mode, meta) => {
          try {
            // Merged stream: only touch rows from THIS channel. Row keeps the
            // original casing, registry key is lowercased — match case-insensitively.
            const rows = document.querySelectorAll(`#hs-mc-messages [data-msg-channel="${CSS.escape(channel)}" i]`)
            const nameSel = `[data-emote-name="${CSS.escape(emoteName)}"]`
            for (const row of rows) {
              for (const node of row.querySelectorAll(nameSel)) {
                const w = node.classList.contains('hs-mc-emote-wrapper') ? node : node.closest('.hs-mc-emote-wrapper')
                if (!w) continue
                // Identity guard: don't ghost a same-name emote of different art.
                if (mode === 'mark' && meta?.hash && w.dataset.emoteHash && w.dataset.emoteHash !== meta.hash) continue
                if (mode === 'mark') {
                  w.classList.add('hs-state-stale')
                  if (meta?.actor) w.dataset.staleActor = meta.actor
                  if (meta?.at) w.dataset.staleAt = String(meta.at)
                } else {
                  w.classList.remove('hs-state-stale')
                  delete w.dataset.staleActor
                  delete w.dataset.staleAt
                }
              }
            }
          } catch (e) {}
        }
        if (msg.type === 'channel_emote_removed' && msg.emoteName) {
          _ensureChannel(channel).set(msg.emoteName, { at: Date.now(), actor, hash: msg.emoteHash || '', provider: '7tv' })
          _patchDom(msg.emoteName, 'mark', { actor, at: Date.now(), hash: msg.emoteHash || '' })
          _persistStale()
        } else if (msg.type === 'channel_emote_added' && msg.emote?.name) {
          const m = _staleReg.get(channel)
          if (m?.delete(msg.emote.name)) {
            if (m.size === 0) _staleReg.delete(channel)
            _patchDom(msg.emote.name, 'unmark', null)
            _persistStale()
          }
        }
        // Build clean action text (actor rendered separately as the username-link;
        // including it inside text would duplicate it via buildMessageDiv).
        let action
        if (msg.type === 'channel_emote_added') {
          action = msg.emote?.name ? `added 7TV emote ${msg.emote.name}` : (msg.message || '7TV emote set updated')
        } else {
          action = msg.emoteName ? `removed 7TV emote ${msg.emoteName}` : (msg.message || '7TV emote set updated')
        }
        // Strip leading "${actor} " duplicate that bg may include in single-emote case
        if (actor && action.toLowerCase().startsWith(actor.toLowerCase() + ' ')) {
          action = action.slice(actor.length + 1)
        }
        const dedup = window._hsStreamEventDedup || (window._hsStreamEventDedup = new Map())
        const text = `[${channel}] ◆ ${action}`
        const now = Date.now()
        if (dedup.has(text) && now - dedup.get(text) < 60000) return
        dedup.set(text, now)
        if (dedup.size > 100) {
          for (const [k, t] of dedup) { if (now - t > 60000) dedup.delete(k) }
        }
        const evt = { type: 'stream-event', eventClass: 'event-emote', text, channel, actor: actor || null, time: now }
        const liveChannel = getLiveChannel()
        const chBuffer = irc?.channels?.get(channel)
        if (chBuffer) {
          const existing = chBuffer.getAll()
          if (!existing.some(m => m.type === 'stream-event' && m.text === evt.text)) {
            chBuffer.push(evt)
            saveStreamEvent(evt)
          }
        }
        if (channel === liveChannel) {
          const liveBuffer = irc?.channels?.get(liveChannel)
          if (liveBuffer && liveBuffer !== chBuffer) {
            const existing = liveBuffer.getAll()
            if (!existing.some(m => m.type === 'stream-event' && m.text === evt.text)) {
              liveBuffer.push(evt)
              if (!chBuffer) saveStreamEvent(evt)
            }
          }
        }
        try { pushActivityEvent(evt) } catch (e) {}
        const activeTab = currentTab
        if (activeTab === 'live') {
          if (isLiveChannelMessage({ channel })) {
            if (!appendMessage(evt, activeTab)) renderMessages(activeTab)
          } else {
            const liveTab = tabBarElement?.querySelector('[data-tab="live"]')
            if (liveTab && channel === liveChannel) liveTab.classList.add('has-stream-event')
          }
        } else {
          const tabCh = getChannelById(activeTab)
          if (tabCh) {
            const tw = tabCh.twitch?.toLowerCase()
            const ki = (tabCh.kick)?.toLowerCase()
            if (tw === channel || ki === channel) {
              if (!appendMessage(evt, activeTab)) renderMessages(activeTab)
            } else {
              const matchTab = config.channels.find(c => (c.twitch?.toLowerCase() === channel) || (c.kick?.toLowerCase() === channel))
              if (matchTab) {
                const tabEl = tabBarElement?.querySelector(`[data-tab="${CSS.escape(matchTab.id)}"]`)
                if (tabEl) tabEl.classList.add('has-stream-event')
              }
            }
          }
        }
      }
    });

    // Also listen for storage changes (more reliable)
    // Remove previous storage listener to prevent accumulation on SPA nav
    if (_mcStorageListener) chrome.storage.onChanged.removeListener(_mcStorageListener)
    _mcStorageListener = (changes, area) => {
      // UI settings synced via storage.sync (cross-tab + cross-device)
      if (area === 'sync' && changes.ui_settings) {
        const ns = changes.ui_settings.newValue || {}
        log('Settings synced:', Object.keys(ns).join(', '))

        // Registry-driven rehydration — one loop replaces the old per-key
        // blocks: cache, runtime bridge, applier, and render flags all come
        // from the schema. Same-tab echoes no-op via the changed-compare
        // (our own setSetting updated the cache before the storage write
        // landed). syncSilent entries skip their applier on remote changes
        // (e.g. a synced volume change must not play the preview ping).
        let needsRender = false
        for (const def of SETTINGS) {
          if (def.scope !== 'sync' || ns[def.key] === undefined) continue
          const v = coerceSettingValue(def, ns[def.key])
          if (v === undefined || !validateSettingValue(def, v)) continue
          const changed = JSON.stringify(v) !== JSON.stringify(getSetting(def.key))
          _settingsCache[def.key] = v
          if (!changed) continue
          const bridge = _bridgeFor(def)
          if (bridge) bridge.set(v)
          if (def.apply && !def.syncSilent) {
            const applier = _APPLIERS[def.apply]
            // 4th arg isRemote — appliers with persist side-effects must not
            // write back (N receiving tabs would each rewrite ui_settings)
            if (applier) { try { applier(v, def, false, true) } catch (e) { warn('sync applier failed:', def.apply, e) } }
          }
          if (def.rerender) needsRender = true
        }
        if (Array.isArray(ns.customPresets)) _customPresets = ns.customPresets

        if (needsRender) {
          bumpRenderEpoch() // insert-only diff: existing rows need the epoch
          renderMessages(currentTab)
        }
        // Update settings panel toggles if visible
        if (currentTab === 'settings') renderSettingsTab()
      }

      if (area !== 'local') return

      // Overflow bucket — large/per-tab UI prefs that bypass the 8 KB sync
      // ceiling. Local-only, so cross-device sync intentionally skips them.
      if (changes.keyword_highlights) {
        const v = changes.keyword_highlights.newValue
        if (typeof v === 'string' && v !== keywordHighlights) {
          keywordHighlights = v
          rebuildKeywordRegex()
          renderMessages(currentTab)
          if (currentTab === 'settings') renderSettingsTab()
        }
      }
      if (changes.platform_filters) {
        const v = changes.platform_filters.newValue
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          platformFilters = v
          renderMessages(currentTab)
        }
      }

      // Emote updates - reload when storage changes (debounced to avoid spam)
      if (changes.global_emotes || changes.channel_emotes_map || changes.emote_inventory || changes.native_twitch_emotes) {
        log('storage changed:', changes.channel_emotes_map ? 'channel_emotes_map' : '', changes.global_emotes ? 'global_emotes' : '', changes.emote_inventory ? 'emote_inventory' : '', changes.native_twitch_emotes ? 'native_twitch_emotes' : '');
        // Cold-start vs. update split: clear cache only on the first payload
        // per scope this session. Subsequent updates (add/remove) preserve
        // _renderedHtml so removed emotes stay rendered in old messages.
        const scope = changes.global_emotes ? 'global' : (changes.channel_emotes_map ? 'ch:_storage' : (changes.native_twitch_emotes ? 'native' : ''))
        if (scope) _pendingEmoteScopes.add(scope)
        cleanup.clearTimeout(emoteReloadTimer);
        emoteReloadTimer = cleanup.setTimeout(() => {
          const pending = _pendingEmoteScopes
          _pendingEmoteScopes = new Set()
          loadEmotes().then(() => {
            let firstLoad = false
            for (const s of pending) {
              if (!_emoteFirstLoad.has(s)) { _emoteFirstLoad.add(s); firstLoad = true }
            }
            // firstLoad: in-place text swap (no rebuild flash), skipping the
            // visible-row swap when scrolled up. non-firstLoad emote edits render
            // now (only when at/near bottom, to not yank a scrolled-up reader).
            if (firstLoad) reloadEmotesInPlace(!isScrolledUp);
            else if (!isScrolledUp) renderMessages(currentTab);
          });
        }, 300);
      }

      // Multichat config sync (cross-tab + cross-device)
      if (changes.heatsync_multichat) {
        if (_skipNextConfigSync) {
          _skipNextConfigSync = false
        } else {
          const newConfig = changes.heatsync_multichat.newValue || { channels: [], enabled: true }
          const oldChannels = config.channels || []
          const newChannels = newConfig.channels || []

          // Diff: find added and removed channels
          const oldIds = new Set(oldChannels.map(c => c.id))
          const newIds = new Set(newChannels.map(c => c.id))

          // Part removed channels
          for (const ch of oldChannels) {
            const id = ch.id
            if (!newIds.has(id)) {
              const twitchName = ch.twitch
              if (twitchName) irc?.part(twitchName)
              const kickName = ch.kick
              if (kickName) kickChat?.part(kickName)
              if (ch.youtube) {
                const link = youtubeLinks.get(id)
                chrome.runtime.sendMessage({
                  type: 'youtube_ws_unsubscribe',
                  videoId: link?.videoId || '',
                  url: ch.youtube,
                  channelId: id,
                }).catch(() => {})
                youtubeLinks.delete(id)
                channelYtMessages.delete(id)
              }
            }
          }

          // Join added channels (subsystem gates: a disabled platform feed
          // never joins)
          for (const ch of newChannels) {
            const id = ch.id
            if (!oldIds.has(id)) {
              const twitchName = ch.twitch
              if (twitchName && isEnabled('irc-twitch')) {
                irc?.join(twitchName)
                try { chrome.runtime.sendMessage({ type: 'join_channel', platform: 'twitch', channel: twitchName }) } catch (e) {}
              }
              const kickName = ch.kick
              if (kickName && isEnabled('chat-kick')) kickChat?.join(kickName)
              if (ch.youtube && isEnabled('chat-youtube')) {
                youtubeLinks.set(id, { url: ch.youtube, videoId: '', channelName: '' })
                chrome.runtime.sendMessage({ type: 'youtube_ws_subscribe', url: ch.youtube, channelId: id }).catch(() => {})
              }
            }
          }

          // Update config and UI
          config.channels = newChannels
          _channelLookup = null
          config.enabled = newConfig.enabled !== undefined ? newConfig.enabled : config.enabled
          updateTabBar()
          // If current tab was removed, switch to live
          if (currentTab !== 'live' && currentTab !== 'feed' && currentTab !== 'mentions' && currentTab !== 'whispers' && !newIds.has(currentTab)) {
            switchTab('live')
          }
          log('Config synced from another tab/device:', newChannels.length, 'channels')
        }
      }

      // Blocked emotes — diff-apply only the hash changes. The previous code
      // reloaded the whole set from storage and re-rendered every message,
      // which caused chat-wide flicker on every block/unblock and could revert
      // optimistic toggles if storage lagged the user action.
      if (changes.blocked_emotes) {
        applyBlockedHashDelta(changes.blocked_emotes.newValue || []);
      }

      // Emote/emoji scale changes from options page propagate live.
      if (changes.hs_emote_size) {
        const v = changes.hs_emote_size.newValue
        if (v === 1 || v === 2 || v === 4) { emoteSize = v; applyEmoteSize() }
      }
      if (changes.hs_emoji_size) {
        const v = changes.hs_emoji_size.newValue
        if (v === 1 || v === 2 || v === 4) { emojiSize = v; applyEmojiSize() }
      }

      // Multi-tab seen-state merge — without this, three open tabs writing
      // hs_tab_seen_v1 in close succession last-write-wins and lose each
      // other's per-tab seen timestamps. Merge with max-per-key so any tab
      // marking a channel seen propagates instead of getting clobbered when
      // another tab flushes.
      if (changes.hs_tab_seen_v1?.newValue && typeof changes.hs_tab_seen_v1.newValue === 'object') {
        const remote = changes.hs_tab_seen_v1.newValue
        for (const k of Object.keys(remote)) {
          const v = remote[k]
          if (typeof v === 'number' && (!tabSeenAt[k] || v > tabSeenAt[k])) {
            tabSeenAt[k] = v
          }
        }
      }
      // Registry cache + bridge coherence for local-scoped keys (cw filters,
      // hs_notifications, dim/readable/auto-claim, sizes, overflow mirrors).
      // Runs AFTER the specific handlers above — some gate their re-render on
      // var inequality, which an early bridge write would defeat.
      for (const def of SETTINGS) {
        const change = def.scope === 'local' ? changes[def.key]
          : def.scope === 'local-mirror' ? changes[def.mirrorKey] : null
        if (!change) continue
        const v = coerceSettingValue(def, change.newValue)
        if (v === undefined || !validateSettingValue(def, v)) continue
        _settingsCache[def.key] = v
        const b = _bridgeFor(def)
        if (b) b.set(v)
        // content-warning pills flip live cross-tab (BG also writes these
        // keys when the server broadcasts a settings update)
        if (def.cw && typeof v === 'boolean') {
          document.querySelectorAll('.hs-mc-toggle-pill[data-set-key="' + def.key + '"]')
            .forEach(function(pill) { pill.classList.toggle('active', v) })
        }
      }
    }
    chrome.storage.onChanged.addListener(_mcStorageListener)
  }

  // ============================================
  // OFFLINE DETECTION
  // ============================================

  function detectOfflineState() {
    // On Kick, detect live status from page and set the live tab dot
    if (isKick) {
      let kickLiveFound = false
      function checkKickLive() {
        const isLive = !!document.querySelector('video')
        const liveTab = tabBarElement?.querySelector('[data-tab="live"]')
        if (liveTab) liveTab.dataset.live = String(isLive)
        const curCh = getCurrentChannel()?.toLowerCase()
        if (curCh && isLive) liveChannelSet.add(curCh)
        if (isLive) kickLiveFound = true
      }
      checkKickLive()
      const fastPoll = cleanup.setInterval(() => {
        checkKickLive()
        if (kickLiveFound) { cleanup.clearInterval(fastPoll); cleanup.setIntervalIfVisible(checkKickLive, 10000) }
      }, 1000)
      return
    }
    // On YouTube, the live_chat iframe only loads on live streams; presence
    // there is the most reliable "is live" signal we can get without polling
    // the InnerTube API.
    if (hostPlatform === 'yt') {
      function checkYtLive() {
        // "This page has live chat" = the ytd-live-chat-frame WRAPPER exists.
        // It's present only on livestreams-with-chat (absent on VODs/home), and
        // appears with the page layout — far faster than waiting for the inner
        // iframe's contentDocument to load (which left the panel hidden for
        // seconds). This is the signal that gates the default panel visibility.
        const frameEl = document.querySelector('ytd-live-chat-frame#chat')
        const hasChatFrame = !!frameEl
        const isLive = hasChatFrame || !!_autoYtVideoId
        const liveTab = tabBarElement?.querySelector('[data-tab="live"]')
        if (liveTab) liveTab.dataset.live = String(isLive)
        // Show the multichat panel on YT only when THIS page has its own live
        // chat (a livestream), OR the user opted into chat on non-live pages
        // (ytChatOnNonLive → body.hs-yt-nonlive-chat). hs-offline drives both the
        // existing :not(.hs-offline) layout gating AND the panel-hide rule below,
        // so this single signal hides the panel on VODs/home/search by default.
        // Use hasChatFrame (THIS page) — NOT isLive, which is true whenever any
        // tracked YT channel is live and would wrongly surface the panel on a VOD.
        const showYtChat = hasChatFrame || document.body.classList.contains('hs-yt-nonlive-chat')
        document.body.classList.toggle('hs-offline', !showYtChat)
        // Watch-page detection: ytd-watch-flexy stays in DOM with `hidden`
        // attr off-watch — only count it as a watch page when visible.
        const onWatch = !!document.querySelector('ytd-watch-flexy:not([hidden])')
        document.body.classList.toggle('hs-yt-watch', onWatch)
        // Hide native YT live chat once it mounts — our multichat panel takes
        // its place. (frameEl computed above.) Re-attempt as the iframe loads.
        if (frameEl && frameEl.style.display !== 'none') {
          frameEl.style.display = 'none'
        }
      }
      checkYtLive()
      // 1.5s steady poll (was 4s): catches live→offline transitions + (only
      // while visible) keeps the panel state honest.
      cleanup.setIntervalIfVisible(checkYtLive, 1500)
      // Fast initial detection: the live_chat iframe lazy-loads after first
      // paint, and the panel now defaults HIDDEN until detected — without this
      // burst the panel would pop in up to 1.5s late on every livestream. Plain
      // timeouts (not IfVisible) so a freshly-opened/focused livestream resolves
      // in ~300ms. Cheap (a few DOM checks); they no-op once steady-state holds.
      ;[250, 600, 1100, 2000, 3500].forEach(ms => cleanup.setTimeout(checkYtLive, ms))
      return
    }
    // Popout chat has no video — don't mark as offline
    if (location.pathname.match(/^\/(popout|embed)\//)) return

    let wasOffline = null

    function checkOffline() {
      const playerOffline = !!document.querySelector('.channel-root__player--offline')
      const isLive = !playerOffline && !!document.querySelector(
        '[class*="stream-type-indicator"], [data-a-target="player-overlay-click-handler"] video, .video-player video'
      )
      const isOffline = !isLive
      document.body.classList.toggle('hs-offline', isOffline)
      // On state change, recalculate player width
      if (wasOffline !== null && wasOffline !== isOffline) {
        applyChatWidth()
      }
      wasOffline = isOffline
    }

    // Immediate check
    checkOffline()

    // Fast polling for first 10s (covers React paint delay)
    let fastChecks = 0
    const fastId = cleanup.setInterval(() => {
      checkOffline()
      if (++fastChecks >= 10) cleanup.clearInterval(fastId)
    }, 1000)

    // Steady-state polling
    cleanup.setIntervalIfVisible(checkOffline, 5000)

    // MutationObserver for instant transitions
    const root = document.querySelector('[class*="channel-root"]')
    if (root) {
      const observer = new MutationObserver(() => checkOffline())
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
      cleanup.trackObserver(observer)
    }
  }

  // ============================================
  // MAIN INITIALIZATION
  // ============================================

  let mcInitialized = false;
  async function init() {
    let isPopout = false;
    if (hostPlatform === 'yt') {
      // YouTube: persistent overlay across every URL — home, watch, search,
      // channel, /live, etc. — so the multichat panel survives SPA nav.
      // The destructive layout overrides (#secondary collapse, recommendeds
      // hidden) are gated separately on `:not(.hs-offline)` so non-live
      // pages keep YouTube's native layout intact.
    } else if (isKick) {
      // Kick: persistent overlay across every URL — channel, browse,
      // categories, search, following, settings — so the panel survives
      // SPA nav. body-mount fallback in getOrCreateHsContainer when
      // #channel-chatroom is absent.
    } else {
      // Twitch: persistent overlay across every URL — directory, settings,
      // videos, etc. all keep the panel mounted. getOrCreateHsContainer
      // body-mounts when no .chat-shell exists; CSS squeezes twitch content.
      isPopout = !!location.pathname.match(/^\/(popout|embed)\/[a-zA-Z0-9_-]+\/chat/);
    }
    if (mcInitialized) return;
    mcInitialized = true;

    // ── PHASE -1: server kill-switch ──────────────────────────────────────
    // One round-trip to background for cached health. If the server flagged
    // a broken release, bail before painting anything. Default is fail-open
    // — background only stores a record after a successful schema-valid
    // fetch, so a never-reached server leaves us fully active.
    let _hsHealth = null
    try {
      const r = await new Promise(res => {
        try { chrome.runtime.sendMessage({ type: 'get_health' }, res) }
        catch { res(null) }
      })
      _hsHealth = r?.health || null
    } catch {}
    window.__hsHealth = _hsHealth || { v:1, kill:false, disabled:[], ext_min:'0.0.0', ext_hard_min:null, msg:null }
    if (_hsHealth?.kill) { log('kill-switch active, aborting init'); return }
    if (Array.isArray(_hsHealth?.disabled) && _hsHealth.disabled.includes('multichat')) {
      log('multichat disabled by server health flag'); return
    }
    const _curVer = (chrome.runtime.getManifest?.().version) || '0.0.0'
    if (_hsHealth?.ext_hard_min && _hsSemverLt(_curVer, _hsHealth.ext_hard_min)) {
      log('extension below ext_hard_min', _curVer, '<', _hsHealth.ext_hard_min); return
    }
    if (_hsHealth?.ext_min && _hsSemverLt(_curVer, _hsHealth.ext_min)) {
      // Deferred emit — HsNotifs needs the overlay container before it can
      // mount. Fire after init completes so toast-stack geometry is ready.
      setTimeout(() => {
        try { HsNotifs.emit('hs-update-required', { current: _curVer, min: _hsHealth.ext_min, msg: _hsHealth.msg }) } catch (_) {}
      }, 4000)
    }

    // ── PHASE 0: synchronous prep (no awaits) ─────────────────────────────
    // Inject CSS NOW so the panel paints with correct styles the moment it
    // mounts. injectStyles has zero settings deps — moving it before any
    // await shaves ~10-15ms off the cold visual path.
    injectStyles();
    // YouTube: pre-set hs-offline so the destructive layout overrides
    // (#secondary collapse, #primary fixed, recommendeds hidden) don't fire
    // on first paint for VOD viewers. checkYtLive() removes the class once
    // it detects a live chatframe; if it's actually a livestream, native
    // YT live chat is shown briefly until our override kicks in.
    if (hostPlatform === 'yt') document.body.classList.add('hs-offline');
    detectOfflineState();
    if (isPopout) document.body.classList.add('hs-popout');
    currentUsername = getCurrentUsername();

    // ── PHASE 1: warm caches in parallel ──────────────────────────────────
    // Prime ui_settings cache so the 18+ load* functions all pull from one
    // in-flight Promise. Also fan out independent storage.local reads.
    // Migration + chat_history prune are fire-and-forget — they don't block
    // first paint; sanitizeUiSettings is also applied on every save so the
    // worst-case failure of migration is "we self-heal on next user action."
    migrateUiSettingsOnce()
    pruneChatHistoryOnce()
    const _uiPrime = cachedUiSettings()
    const _localPrime = chrome.storage.local.get([STORAGE_KEY, 'user_info', 'muted_users'])
    await loadConfig();
    if (!config.enabled) return;
    // Lite / emotes-only mode — multichatOverlayEnabled off kills the whole
    // panel before any DOM or sockets exist. The emote layer (content.js,
    // separate script) keeps running. Re-enable: settings pill (live),
    // extension popup, or heatsync.org. The retired subsystems.overlay key
    // is honored here too until the loadAllSettings legacy hook migrates it.
    try {
      const _pre = await _uiPrime
      const _ui = _pre?.ui_settings
      if (_ui?.multichatOverlayEnabled === false || _ui?.subsystems?.overlay === false) {
        log('overlay off — lite mode, skipping multichat init')
        return
      }
    } catch {}
    log('Initializing...');

    // ── PHASE 2: hydrate username + muted users from prefetched local ─────
    try {
      const local = await _localPrime
      if (!currentUsername && local.user_info?.username) {
        currentUsername = local.user_info.username.toLowerCase()
      }
      if (Array.isArray(local.muted_users)) {
        const now = Date.now()
        for (const entry of local.muted_users) {
          const u = (typeof entry === 'string' ? entry : entry.username)?.toLowerCase()
          const exp = typeof entry === 'string' ? null : entry.expiresAt
          if (u && (!exp || exp > now)) mutedUsers.add(u)
        }
      }
    } catch {}
    // Blocked users — shared with content.js via background's `blocked_users`.
    try {
      const bd = await new Promise(res => { try { chrome.storage.local.get('blocked_users', r => res(r || {})) } catch { res({}) } })
      if (Array.isArray(bd.blocked_users)) for (const u of bd.blocked_users) { if (u) blockedUsers.add(String(u).toLowerCase()) }
    } catch {}
    log('Username:', currentUsername);

    // ── PHASE 3: settings hydration + emote load (all in parallel) ────────
    // All load* funcs, blocked-emotes, and emotes share the cached ui_settings
    // or hit independent local keys; they can run concurrently.
    // Resilient init: each loader may fail OR stall without aborting the rest.
    // (Plain Promise.all let a single throwing/hanging settings-loader kill
    // everything after it — including badge loading.) Cap each at 5s + swallow
    // rejections so the panel always finishes booting.
    await Promise.allSettled([
      _uiPrime,  // already in flight; just await here to ensure it landed
      loadActiveTab(),
      loadTabsPosition(),
      loadChatPosition(),
      loadLivePlatformMap(),
      loadAllSettings(),
      loadPlatformFilters(),
      loadBlockedEmotes(),
      loadEmotes(),
      loadSenderEmoteSets(),
      loadStaleEmotes(),
    ].map(p => Promise.race([
      Promise.resolve(p).catch(() => {}),
      new Promise(r => setTimeout(r, 5000)),
    ])));
    // Init done — drop the cache so subsequent reads see fresh data.
    invalidateUiSettingsCache()
    // Freeze the subsystem gates for the rest of init — a mid-init storage
    // write can't half-apply a subsystem. Live reads still use isEnabled().
    snapshotGates()

    // Request background to re-send channel emotes (may have been fetched before we loaded)
    try {
      chrome.runtime.sendMessage({ type: 'get_channel_emotes' });
    } catch (e) { /* context invalidated */ }

    setupEmoteTooltipHandlers();
    setupUserTooltipHandlers();
    setupLinkTooltipHandlers();
    if (gateAtBoot('profile-cards')) setupProfileCardHandlers();
    listenForSettingsChanges();

    // Request initial BTTV/FFZ/Chatterino badge maps from background.
    // A cold service worker can answer before its storage restore lands,
    // returning empty maps; cosmetics_update only re-broadcasts on a fresh
    // fetch, so a one-shot request that lands empty would leave the overlay
    // badge-less until the next ~24h refresh. Retry with backoff until the
    // maps come back non-empty (the background also pushes a warm-cache
    // cosmetics_update once restore completes — whichever wins, we recover).
    const loadBulkBadges = (attempt = 0) => {
      safeSendMessage({ type: 'get_bulk_badges' }).then(resp => {
        const bttv = resp?.bttvBadges ? Object.entries(resp.bttvBadges) : []
        const ffz = resp?.ffzBadges ? Object.entries(resp.ffzBadges) : []
        const chat = resp?.chatterinoBadges ? Object.entries(resp.chatterinoBadges) : []
        if (bttv.length + ffz.length + chat.length === 0) {
          if (attempt < 8) cleanup.setTimeout(() => loadBulkBadges(attempt + 1), Math.min(500 * (attempt + 1), 3000))
          return
        }
        mcBttvBadgeMap = new Map(bttv)
        mcFfzBadgeMap = new Map(ffz)
        mcChatterinoBadgeMap = new Map(chat)
        // In-place patch instead of bumpRenderEpoch()+rebuild (the flash) —
        // see the cosmetics_update handler for the rationale.
        updateThirdPartyBadgesInPlace()
        _dropAllTabCaches()
      }).catch(() => {
        if (attempt < 8) cleanup.setTimeout(() => loadBulkBadges(attempt + 1), Math.min(500 * (attempt + 1), 3000))
      })
    }
    if (gateAtBoot('cosmetics')) loadBulkBadges()

    // Load heatsync auth state
    loadHsAuth();

    // Probe bg for auth state so the login banner can show on tabs that opened
    // after the initial auth_changed broadcast already fired (cookies.onChanged
    // and the no_token boot signal are both one-shot).
    try {
      chrome.runtime.sendMessage({ type: 'get_auth_state' }, (resp) => {
        if (chrome.runtime.lastError || !resp) return
        try { showAuthLoginBanner(!!resp.loggedIn) } catch {}
      })
    } catch {}

    // Listen for social tab events from background
    if (gateAtBoot('feed')) listenForSocialEvents();

    // Load whisper conversations from storage
    if (gateAtBoot('whispers')) loadWhispers();

    // Seed cross-device unread state from server (mentions/whispers/home).
    // Independent of auth — anonymous users skip the network hit and use
    // local-only state. Awaits internally; doesn't block init.
    loadSeenState();

    // Seed cross-device UI state from server. Server-merged blob lands in
    // chrome.storage.sync.ui_settings so the existing storage.onChanged
    // listener applies every changed pref live. WS keeps it warm after.
    ;(async () => {
      try {
        if (typeof hsAuthToken !== 'undefined' && !hsAuthToken) return
        const resp = await apiFetch('/api/user/ui-state')
        if (!resp?.ok || !resp.data?.state) return
        const remote = resp.data.state
        if (!remote || typeof remote !== 'object' || Object.keys(remote).length === 0) return
        const stored = await chrome.storage.sync.get(['ui_settings'])
        // Sanitize the merged blob before persisting — `remote` is server-fanned
        // state (accumulated across every client/version that ever PATCHed this
        // account) and must NOT be trusted into the cross-device sync key raw.
        // Every sibling write sanitizes (main.js:1760/5736, bg ui-state:update);
        // this seed was the lone bypass. Skipping it let numeric-key/oversized/
        // __proto__ garbage replicate to all devices + push the record past the
        // 8KB quota, after which all future pref writes silently fail.
        const merged = sanitizeUiSettings({ ...(stored.ui_settings || {}), ...remote })
        await chrome.storage.sync.set({ ui_settings: merged })
      } catch (e) { log('ui-state seed failed:', e?.message) }
    })();

    // ── PHASE 4: defer all network connect to post-paint ─────────────────
    // IRC/Kick socket open + N channel-join are 500ms-2s of network work
    // that doesn't need to block the first visible render. The panel can
    // mount, switch tabs, show settings, etc. while sockets warm up.
    // requestIdleCallback fires after paint; setTimeout fallback for older
    // browsers. New IRC()/KickChat() ctor is sync (no socket open) so the
    // refs `irc`/`kickChat` are available immediately for any sync caller.
    irc = new IRC();
    kickChat = new KickChat();
    // Restore persisted mentions/YT buffers + tab-seen state so first paint
    // already shows everything from before the reload. Awaited because
    // mentions tab on reload would otherwise paint empty for a beat.
    await restorePersistedBuffers();
    const startNetwork = () => {
      // Subsystem gates — a disabled platform feed never opens its socket
      // or joins channels (gating at the registration call = no orphans).
      const gTwitch = gateAtBoot('irc-twitch')
      const gKick = gateAtBoot('chat-kick')
      const gYt = gateAtBoot('chat-youtube')
      if (gTwitch) irc.connect();
      if (gKick) kickChat.connect();

      // Connect auth IRC eagerly so first send is instant (whispers no longer arrive over IRC)
      if (gTwitch && hostPlatform === 'twitch') {
        const token = getTwitchAuthToken()
        const nick = currentUsername || getCurrentUsername()
        if (token && nick) {
          connectAuthIrc(token, nick).then(ok => {
            if (ok === true) log('Auth IRC ready')
          })
          // Upgrade the BG reader connection to authed — twitch starves
          // anonymous readers (live messages trickle while history loads);
          // an authenticated reader receives normally.
          try { safeSendMessage({ type: 'bg_irc_auth', token, nick: nick.toLowerCase() }).catch(() => {}) } catch (_) {}
        }
      }
      // Native-chat tap — current channel's live messages mined from the
      // rows twitch's own (unthrottled) delivery renders; id-deduped against
      // IRC. See native-tap.js for the why.
      if (gTwitch && hostPlatform === 'twitch') {
        try { startNativeTap(getCurrentChannel()) } catch (_) {}
      }
      // Auto-tabs: pull the current open-stream set once at boot — the bg
      // broadcast only fires on CHANGES, so a fresh tab would otherwise not
      // see streams that were already open before it loaded.
      try {
        safeSendMessage({ type: 'bg_get_open_channels' }).then(r => {
          if (r?.channels) reconcileAutoTabs(r.channels)
        }).catch(() => {})
      } catch (_) {}

      // Twitch deprecated WHISPER over IRC in Feb 2023 — receive via EventSub instead.
      // Works on any host (the ESW socket is independent of the chat IRC).
      if (gateAtBoot('whispers')) startEventSubWhispers()

      // Auto-join current channel on all platforms (using overrides if set)
      const currentChannel = getCurrentChannel();
      if (currentChannel) {
        const platNames = getLivePlatformNames()
        const twitchCh = platNames.twitch || currentChannel
        const kickCh = platNames.kick || currentChannel
        // Only bind YouTube when we KNOW this channel's YT identity (an explicit
        // cross-platform link). Guessing youtube.com/@<twitchname>/live resolves
        // to whoever owns that handle — usually a DIFFERENT person — and bleeds a
        // stranger's live chat into this channel's tabs. No cross-platform
        // identity guessing.
        const ytUrl = platNames.youtube || null

        if (gTwitch) irc.join(twitchCh)
        if (gKick) kickChat.join(kickCh)
        // Also join the URL channel name if different (for native platform messages)
        if (gTwitch && twitchCh !== currentChannel) irc.join(currentChannel)
        if (gKick && kickCh !== currentChannel) kickChat.join(currentChannel)

        // Subscribe YouTube. On a YT watch/live URL getCurrentChannel returns the
        // 11-char videoId — feeding that to `@${id}/live` produces a bogus
        // @<videoId>/live URL that the server can't resolve. Use the actual
        // /watch?v=<id> form whenever we're on a YT video page so the server has
        // something concrete to bind to. The previous `length > 20` check never
        // matched (videoIds are 11), so YT-tab subs were silently broken.
        const onYtVideoPage = hostPlatform === 'yt' && /\/watch|\/live\//.test(location.pathname + location.search)
        const autoYtUrl = onYtVideoPage
          ? `https://youtube.com/watch?v=${currentChannel}`
          : ytUrl
        if (gYt && autoYtUrl) {
          ytSubscribedUrls.set('__live_yt_auto__', autoYtUrl)
          ytChanLastSeen.set('__live_yt_auto__', Date.now())
          chrome.runtime.sendMessage({
            type: 'youtube_ws_subscribe', url: autoYtUrl, channelId: '__live_yt_auto__'
          }).catch(() => {})
        }
        log('Auto-joined current channel:', currentChannel, 'platforms:', twitchCh, kickCh, ytUrl || '(no yt link)');
      }

      // Ensure live channel override is also joined on all platforms
      const liveCh = getLiveChannel();
      if (liveCh && liveCh !== currentChannel) {
        if (gTwitch) irc?.join(liveCh);
        if (gKick) kickChat?.join(liveCh);
        log('Auto-joined live channel override:', liveCh);
      }

      // Serialize background-channel joins. Each irc.join awaits bg_irc_history
      // (up to 3000 msgs replay + buffer hydration); N parallel joins meant N
      // simultaneous renderMessages + DOM walks fighting paint at boot. Active
      // channel is already joined above — these are the bystander tabs.
      const bgChannels = config.channels.filter(ch => {
        const tw = ch.twitch?.toLowerCase()
        const kk = ch.kick?.toLowerCase()
        return (tw && !irc.channels.has(tw)) || (kk && !kickChat.channels.has(kk))
      })
      hsSched.chunk(bgChannels, async (ch) => {
        const twitchName = ch.twitch;
        const kickName = ch.kick;
        if (gTwitch && twitchName) {
          // Don't gate the join_channel sendMessage on irc.join — irc.join
          // awaits bg_irc_history (up to 4s) and a stalled history fetch would
          // delay the BG channel-emotes fetch indefinitely. Kick off both
          // independently; emote fetch only needs the channel name.
          irc.join(twitchName);
          try {
            chrome.runtime.sendMessage({ type: 'join_channel', platform: 'twitch', channel: twitchName })
          } catch (e) {}
        }
        if (gKick && kickName) {
          kickChat.join(kickName);
        }
        // YouTube subscription is owned by loadConfig() (line ~6071) so this
        // loop only handles irc/kick — duplicate yt subs were idempotent but
        // noisy in the bg log.
      }, { budgetMs: 6, respectScroll: false }).catch(() => {})
    };
    // Schedule connect+joins for the next idle slice so paint goes first.
    // Falls back to setTimeout(0) where rIC is unavailable (older Chrome,
    // Safari ext). 200ms timeout cap ensures we don't sit idle forever
    // when the page is busy.
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(startNetwork, { timeout: 200 });
    } else {
      setTimeout(startNetwork, 0);
    }

    // After channel buffers have hydrated (IRC.loadHistory fires on each JOIN
    // and resolves async), repaint per-tab unread indicators against the
    // restored tabSeenAt timestamps. 2s lets storage reads settle without
    // blocking the panel; an extra pass at 8s catches the second-pass robotty
    // refetch that fills the reload-window gap.
    cleanup.setTimeout(() => { try { applyUnreadIndicatorsFromPersist() } catch {} }, 2000)
    cleanup.setTimeout(() => { try { applyUnreadIndicatorsFromPersist() } catch {} }, 8000)

    // Restore persisted stream events into buffers AFTER irc.join has populated
    // them. Running in parallel with startNetwork races: storage.get often
    // resolves before requestIdleCallback fires, so injectStreamEventsIntoBuffers
    // sees empty irc.channels and silently drops chat injection.
    cleanup.setTimeout(() => {
      loadStreamEvents().then(() => {
        if (streamEventsLoaded) {
          const active = currentTab;
          if (active === 'live' || config.channels.some(ch => ch.id === active)) {
            renderMessages(active);
          }
        }
      });
    }, 300);

    // Scan existing chat for mentions (before IRC catches new ones)
    cleanup.setTimeout(() => { if (isEnabled('mentions')) scanExistingMentions() }, 2000);

    // Handle incoming IRC messages
    irc.on('message', (msg) => {
      // Share-claim dedupe: a real resub/milestone USERNOTICE from Twitch
      // matches a pending Share click. Pre-injection → cancel synthetic.
      // Post-injection → hide synthetic so real takes its place. Single
      // celebration always.
      const _claimKind = _pendingShareClaim?.kind || 'resub'
      const _allowedMsgIds = _claimKind === 'watchstreak'
        ? ['watchstreak', 'viewermilestone']
        : ['resub', 'sub', 'viewermilestone']
      if (_pendingShareClaim && msg.type === 'usernotice' && !msg.isSynthetic &&
          msg.channel?.toLowerCase() === _pendingShareClaim.channel &&
          msg.user?.toLowerCase() === _pendingShareClaim.userLc &&
          _allowedMsgIds.includes(msg.msgId)) {
        const claim = _pendingShareClaim
        // If our synthetic carries user-typed body and the real broadcast came
        // through empty (Twitch's one-click Share has no composer), keep the
        // synthetic and hide real so the chat shows the user's custom message.
        const realBody = (msg.text || '').trim()
        if (claim.customText && claim.synthId && !realBody) {
          msg.hidden = true
          return
        }
        cleanup.clearTimeout(claim.postTimer)
        _pendingShareClaim = null
        if (claim.synthId) {
          const buf = irc?.channels?.get(claim.channel)
          if (buf) {
            for (const m of buf.getAll()) {
              if (m.id === claim.synthId) { m.hidden = true; break }
            }
          }
          try {
            const msgsEl = document.getElementById('hs-mc-messages')
            const safe = (CSS.escape ? CSS.escape(claim.synthId) : claim.synthId.replace(/"/g, '\\"'))
            const row = msgsEl?.querySelector(`.hs-mc-msg[data-msg-id="${safe}"]`)
            if (row) row.remove()
          } catch (_) {}
        }
      }
      // CLEARCHAT/CLEARMSG → live-dim already-rendered DOM rows from the offender.
      // Buffer entries were already flagged with `cleared=true` inside the IRC client,
      // so future re-renders pick it up via the renderer; this just patches the visible DOM.
      if (msg.type === 'notice' && (msg.noticeType === 'ban_success' || msg.noticeType === 'timeout_success') && msg.targetUser) {
        const targetLc = msg.targetUser.toLowerCase()
        const msgsEl = document.getElementById('hs-mc-messages')
        const rows = msgsEl?.querySelectorAll(`.hs-mc-msg[data-msg-user]`) || []
        for (const row of rows) {
          if ((row.dataset.msgUser || '').toLowerCase() === targetLc) {
            if (dimTimeouts) row.classList.add('hs-mc-msg-cleared')
            row.title = msg.banDuration ? `timed out (${msg.banDuration}s)` : 'banned'
          }
        }
      }
      if (msg.type === 'notice' && msg.noticeType === 'delete_message_success' && msg.targetMsgId) {
        const safe = (CSS.escape ? CSS.escape(msg.targetMsgId) : msg.targetMsgId.replace(/"/g, '\\"'))
        const msgsEl = document.getElementById('hs-mc-messages')
        const row = msgsEl?.querySelector(`.hs-mc-msg[data-msg-id="${safe}"]`)
        if (row) { if (dimTimeouts) row.classList.add('hs-mc-msg-cleared'); row.title = 'deleted' }
      }
      // Track sub tenure from IRC badge-info
      if (msg.subMonths && msg.channel) {
        trackSubTenure(msg.channel, msg.user, msg.subMonths)
      }
      // Cache own badges for optimistic display. Per-channel + global mirror —
      // synthetic celebrations stamp the right sub badge tier when injected on
      // a channel where the user has previously sent at least once.
      if (msg.user?.toLowerCase() === currentUsername?.toLowerCase() && msg.badges) {
        _ownBadges = msg.badges
        if (msg.channel) _ownBadgesByChannel.set(String(msg.channel).toLowerCase(), msg.badges)
      }
      // Echo confirmation for the pending-send tracker (input.js). MUST run
      // before isSentEcho — that call mutates the dedup counter and on dual-
      // send second-echo it would consume the entry before we could confirm.
      // Pass 'twitch' platform so per-platform awaiting set drains; entry only
      // dismisses when every awaited platform has echoed (dual-send safety).
      // Fallback: if text-match misses but msg is from our own user on a
      // channel with pending sends, drain the oldest FIFO. Twitch echoes own
      // PRIVMSGs via global broadcast, so an own-name PRIVMSG on a pending
      // channel proves SOMETHING posted — catches the wysiwyg-chip/NBSP/
      // serializer-divergence false-positive class.
      {
        let _pendId = findPendingByEchoText(msg.text)
        if (!_pendId && msg.user) {
          const u = msg.user.toLowerCase()
          // currentUsername works on-host (twitch.tv) but is null on cross-
          // origin tabs (kick.com/youtube.com where twitch storage isn't
          // reachable). authState.nick (from auth-irc handshake) is the
          // user's TWITCH nick once auth-irc has connected — works cross-
          // origin too. Also accept a peekSentHost text hit (cross-tab-
          // synced via storage) as a final own-msg signal.
          const isOwnUser =
            (currentUsername && u === currentUsername.toLowerCase()) ||
            (typeof authState !== 'undefined' && authState?.nick && u === authState.nick.toLowerCase()) ||
            (typeof peekSentHost === 'function' && !!peekSentHost(msg.text))
          if (isOwnUser) _pendId = findPendingByChannelFifo(msg.channel)
        }
        if (_pendId) confirmPending(_pendId, 'twitch')
      }
      // Suppress echo of own sent messages (dedup dual-send). Pass 'twitch'
      // explicitly — IRC msgs leave m.platform unset so the host-platform
      // preference in isSentEcho can compare against it.
      if (isSentEcho(msg.text, 'twitch')) return
      // Own-message badge: only override when the echo matches a message we
      // tracked as sent FROM the extension input bar. That way echoes
      // originating from elsewhere (e.g. heatsync.org website) keep
      // whatever platform tag the server attached — leaving room for a
      // server-emitted [H] tag without us clobbering it.
      if (msg.user?.toLowerCase() === currentUsername?.toLowerCase()) {
        const sentHost = peekSentHost(msg.text)
        if (sentHost) {
          // IRC origin — badges are Twitch namespace regardless of [K] retag.
          msg.badgePlatform = 'twitch'
          msg.platform = sentHost === 'yt' ? 'youtube' : sentHost
        }
      }
      // Automod: drop messages matching user-defined filter or all-caps spam.
      // Don't filter own messages (you saw what you typed).
      if (msg.user?.toLowerCase() !== currentUsername?.toLowerCase() && shouldAutomod(msg.text)) return
      const isMent = isMention(msg)
      bumpStreamStats(msg.channel, msg, isMent)
      if (isMent) {
        mentionsBuffer.push(msg);
        if (mentionsBuffer.length > MAX_BUFFER + 50) mentionsBuffer.splice(0, mentionsBuffer.length - MAX_BUFFER);
        persistMentions();
        notifyMention(msg);
        noteSeenEvent('mentions', msg.time || Date.now());

        if (currentTab === 'mentions') {
          bumpSeen('mentions');
          if (!appendMessage(msg, 'mentions')) renderMessages('mentions');
        } else {
          updateTabIndicator('mentions');
        }
      }

      // Channel tab routing
      const chTabId = getChannelLookup().twitch.get(msg.channel);
      const tabId = chTabId?.id;
      if (tabId && currentTab === tabId) {
        if (!appendMessage(msg, tabId)) renderMessages(tabId);
      } else if (tabId) {
        updateTabIndicator(tabId);
        if (isMent) updateTabMentionIndicator(tabId)
      }

      // Live tab: show if this channel matches live OR is paired via config
      if (isLiveChannelMessage(msg)) {
        if (currentTab === 'live') {
          if (!appendMessage(msg, 'live')) renderMessages('live');
        } else {
          updateTabIndicator('live');
          if (isMent) updateTabMentionIndicator('live')
        }
      }
    });

    // Handle incoming Kick messages
    kickChat.on('message', (msg) => {
      // Lazy-resolve username → 7TV cosmetics + twitchId. First sighting per
      // session triggers one /users/kick/{name} fetch; result is cached and
      // backfilled into the rendered DOM so paints/badges paint in place.
      if (msg.user && !msg.userId) queueKickNameToCosmetics(msg.user)
      // Echo confirmation for pending-send tracker. Runs before isSentEcho
      // for the same reason as the IRC handler above.
      // Pass 'kick' platform so per-platform awaiting set drains correctly.
      // FIFO-by-channel fallback applies for same reason as twitch handler.
      {
        let _pendId = findPendingByEchoText(msg.text)
        if (!_pendId && msg.user) {
          const u = msg.user.toLowerCase()
          const isOwnUser =
            (currentUsername && u === currentUsername.toLowerCase()) ||
            (typeof peekSentHost === 'function' && !!peekSentHost(msg.text))
          if (isOwnUser) _pendId = findPendingByChannelFifo(msg.channel)
        }
        if (_pendId) confirmPending(_pendId, 'kick')
      }
      // Suppress echo of own sent messages (dedup dual-send) — pass 'kick'
      // so host-platform preference can favor this echo when on kick.com.
      if (isSentEcho(msg.text, 'kick')) return
      // Own-message badge: only override for ext-tracked sends (matches
      // IRC handler comment above). Untracked echoes keep msg.platform='kick'
      // which already renders as [K].
      if (msg.user?.toLowerCase() === currentUsername?.toLowerCase()) {
        const sentHost = peekSentHost(msg.text)
        if (sentHost) {
          // Kick origin — badges look up in kickBadgeUrls.
          msg.badgePlatform = 'kick'
          msg.platform = sentHost === 'yt' ? 'youtube' : sentHost
        }
      }
      if (msg.user?.toLowerCase() !== currentUsername?.toLowerCase() && shouldAutomod(msg.text)) return
      const isMent = isMention(msg)
      bumpStreamStats(msg.channel, msg, isMent)
      if (isMent) {
        mentionsBuffer.push(msg);
        if (mentionsBuffer.length > MAX_BUFFER + 50) mentionsBuffer.splice(0, mentionsBuffer.length - MAX_BUFFER);
        persistMentions();
        notifyMention(msg);
        noteSeenEvent('mentions', msg.time || Date.now());

        if (currentTab === 'mentions') {
          bumpSeen('mentions');
          if (!appendMessage(msg, 'mentions')) renderMessages('mentions');
        } else {
          updateTabIndicator('mentions');
        }
      }

      // Channel tab routing — find config entry where ch.kick matches
      const chConfig = getChannelLookup().kick.get(msg.channel);
      const tabId = chConfig?.id;
      if (tabId && currentTab === tabId) {
        if (!appendMessage(msg, tabId)) renderMessages(tabId);
      } else if (tabId) {
        updateTabIndicator(tabId);
        if (isMent) updateTabMentionIndicator(tabId)
      }

      // Live tab: show if this channel matches live OR is paired via config
      if (isLiveChannelMessage(msg)) {
        if (currentTab === 'live') {
          if (!appendMessage(msg, 'live')) renderMessages('live');
        } else {
          updateTabIndicator('live');
          if (isMent) updateTabMentionIndicator('live')
        }
      }
    });

    // Global dedup for stream events — prevents dupes from multiple sources
    // (Twitch EventSub + Kick webhook + follow poll can all fire for the same event)
    if (!window._hsStreamEventDedup) window._hsStreamEventDedup = new Map()
    const streamEventDedup = window._hsStreamEventDedup

    // Handle stream events (game switch, online/offline) from HeatSync WS
    if (!window._hsMcStreamEventListener) {
      window._hsMcStreamEventListener = true;
      cleanup.addListener(chrome.runtime?.onMessage, (msg) => {
        if (msg.type !== 'stream_event') return;
        const channel = msg.channel?.toLowerCase();
        if (!channel) return;

        // Build inline notification
        let text = '', eventClass = '';
        if (msg.eventType === 'stream:update' && msg.game && msg.prevGame !== msg.game) {
          if (!hermesToggles?.gameSwitch) return;
          text = msg.prevGame
            ? `[${channel}] \u25C6 switched to ${msg.game}`
            : `[${channel}] \u25C6 now playing ${msg.game}`;
          eventClass = 'event-update';
        } else if (msg.eventType === 'stream:online') {
          try { streamStats.delete((channel || '').toLowerCase()) } catch (e) {}
          if (!hermesToggles?.online) return;
          // Same gate as the follow_stream_event listener: if the authoritative
          // poll snapshot already has this channel live, the WS "went live" is
          // a connect-snapshot replay (the server pushes the whole live roster
          // as realtime online events on every (re)connect), not a genuine
          // off\u2192on transition. Drop it. A real transition pushes faster than
          // the 60s poll refresh so it won't be in the set yet and still shows.
          // Triple guard against the "went live" wall:
          //  1. sessionWentLiveSeen — a channel emits at most one went-live
          //     per session (offline clears the mark below). Kills every later
          //     server re-broadcast: connect-snapshot replays, EventSub
          //     re-subscribe, emote-add round-trips that fan out cached
          //     stream.online events, etc.
          //  2. Membership — if a poll snapshot already knows this channel
          //     live, the FIRST emission we see is a snapshot, not a
          //     transition. Drop.
          //  3. Grace window — for the first 30s after content load, the WS
          //     burst can arrive before either set has populated, so neither
          //     #1 nor #2 catches it. Treat any first-emission within 30s as
          //     snapshot.
          // A genuine off→on transition beats the 60s poll and arrives outside
          // the grace, so it still surfaces (and gets recorded so any later
          // re-broadcast of the same channel is deduped).
          if (sessionWentLiveSeen.has(channel)) return;
          const _alreadyLive = liveChannelSet?.has(channel) || _swLiveSet?.has(channel);
          const _inGrace = Date.now() - mcStartedAt < 90000;
          sessionWentLiveSeen.add(channel);
          if (_alreadyLive || _inGrace) return;
          text = msg.game ? `[${channel}] \u25C6 went live \u2014 ${msg.game}` : `[${channel}] \u25C6 went live`;
          eventClass = 'event-online';
        } else if (msg.eventType === 'stream:offline') {
          sessionWentLiveSeen.delete(channel); // genuine re-go-live can resurface
          try { renderStreamSummary(channel) } catch (e) {}
          if (!hermesToggles?.offline) return;
          text = `[${channel}] \u25C6 went offline`;
          eventClass = 'event-offline';
        } else if (msg.eventType === 'stream:redeem') {
          if (!hermesToggles?.redeem) return;
          text = `\u25C6 redeemed "${escapeHtml(msg.title)}"`;
          if (msg.cost) text += ` (${msg.cost})`;
          eventClass = 'event-redeem';
        } else if (msg.eventType === 'stream:raid') {
          if (!hermesToggles?.raid) return;
          text = `[${channel}] \u25C6 raided ${escapeHtml(msg.target)} with ${msg.viewers || 0} viewers`;
          eventClass = 'event-raid';
        } else if (msg.eventType === 'stream:hype-start') {
          if (!hermesToggles?.hype) return;
          text = `[${channel}] \u25C6 hype train started`;
          eventClass = 'event-hype';
        } else if (msg.eventType === 'stream:hype-end') {
          if (!hermesToggles?.hype) return;
          text = `[${channel}] \u25C6 hype train ended at level ${msg.level || 0}`;
          eventClass = 'event-hype';
        } else if (msg.eventType === 'stream:sub-gift') {
          if (!hermesToggles?.sub) return;
          text = `[${channel}] \u25C6 ${escapeHtml(msg.user)} gifted ${msg.count || 0} subs`;
          eventClass = 'event-sub';
        }
        if (!text) return;

        // Dedup: skip if same event was shown in last 60s. Key by channel too —
        // redeem text carries no channel, so a global text key would drop an
        // identical reward redeemed in a different channel as a false duplicate.
        const now = Date.now()
        const dedupKey = channel + ' ' + text
        if (streamEventDedup.has(dedupKey) && now - streamEventDedup.get(dedupKey) < 60000) return
        streamEventDedup.set(dedupKey, now)
        // Prune old entries
        if (streamEventDedup.size > 100) {
          for (const [k, t] of streamEventDedup) { if (now - t > 60000) streamEventDedup.delete(k) }
        }

        log('[Stream]', channel, text);
        notifyStreamEvent(channel, msg.eventType, msg.game, msg.platform);
        const actor = msg.eventType === 'stream:redeem' ? msg.user : null;
        const evt = { type: 'stream-event', eventClass, text, channel, actor, time: Date.now() };

        // Push into the live channel buffer (dedup by text to prevent doubles on reload).
        // Gate on isLiveChannelMessage: without it, a redeem/raid from ANY other
        // subscribed channel lands in the live buffer — and since redeem text has no
        // [channel] prefix, it reads like it happened on the channel you're watching.
        const liveChannel = getLiveChannel();
        const liveBuffer = (liveChannel && isLiveChannelMessage({ channel })) ? (irc?.channels?.get(liveChannel) || kickChat?.channels?.get(liveChannel)) : null;
        if (liveBuffer) {
          const existing = liveBuffer.getAll();
          if (!existing.some(m => m.type === 'stream-event' && m.text === evt.text)) {
            liveBuffer.push(evt);
            saveStreamEvent(evt);
          }
        }

        // Also push into the matching channel buffer if different from live
        if (channel !== liveChannel) {
          const chBuffer = irc?.channels?.get(channel) || kickChat?.channels?.get(channel);
          if (chBuffer) {
            const existing = chBuffer.getAll();
            if (!existing.some(m => m.type === 'stream-event' && m.text === evt.text)) {
              chBuffer.push(evt);
              if (!liveBuffer) saveStreamEvent(evt);
            }
          }
        }
        pushActivityEvent(evt);

        // Yellow tab highlight only for game changes, and only when not viewing that channel
        // (live tab and its matching channel tab are equivalent — viewing either counts)
        if (msg.eventType === 'stream:update') {
          const viewingChannel = currentTab === 'live' || config.channels.some(ch => {
            const tw = ch.twitch?.toLowerCase()
            const ki = (ch.kick)?.toLowerCase()
            return currentTab === ch.id && (tw === channel || ki === channel)
          })
          if (!viewingChannel) {
            // Only yellow the live tab if this event is for the live channel
            const isLiveEvent = isLiveChannelMessage({ channel })
            if (isLiveEvent) {
              const liveTab = tabBarElement?.querySelector('[data-tab="live"]');
              if (liveTab) liveTab.classList.add('has-stream-event');
            }
            // Yellow the matching channel tab
            for (const ch of config.channels) {
              const twName = ch.twitch;
              const kickName = ch.kick;
              const tabId = ch.id;
              if ((twName === channel || kickName === channel) && currentTab !== tabId) {
                const tab = tabBarElement?.querySelector(`[data-tab="${tabId}"]`);
                if (tab) tab.classList.add('has-stream-event');
              }
            }
          }
        }

        // Render only on tabs whose channel matches this event
        const activeTab = currentTab;
        if (activeTab === 'live') {
          if (isLiveChannelMessage({ channel })) {
            if (!appendMessage(evt, activeTab)) renderMessages(activeTab);
          }
        } else {
          const tabCh = getChannelById(activeTab)
          if (tabCh) {
            const tw = tabCh.twitch?.toLowerCase()
            const ki = (tabCh.kick)?.toLowerCase()
            if (tw === channel || ki === channel) {
              if (!appendMessage(evt, activeTab)) renderMessages(activeTab);
            }
          }
        }
      });
    }


    // Handle Hermes events (raids, hype trains, redeems, sub gifts) from MAIN world
    window.addEventListener('message', (e) => {
      // e.source === window: legit events come from our same-window MAIN-world
      // inject (early-inject-main.js postMessage). Reject other frames so a
      // same-origin iframe can't spoof raid/hype/sub banners. Mirrors the guard
      // used across twitch-api.js / autocomplete-hook.js.
      if (e.source !== window || e.origin !== location.origin || e.data?.type !== 'heatsync-hermes-event') return
      const { eventType, channel, data } = e.data
      if (!eventType || !channel) return

      // Map eventType to toggle key and eventClass
      let toggleKey, eventClass, text
      if (eventType === 'raid') {
        toggleKey = 'raid'
        eventClass = 'event-raid'
        text = `[${escapeHtml(channel)}] \u25C6 raided ${escapeHtml(data.target)} with ${Number(data.viewers) || 0} viewers`
      } else if (eventType === 'hype-train-start') {
        toggleKey = 'hype'
        eventClass = 'event-hype'
        text = `[${escapeHtml(channel)}] \u25C6 hype train started`
        if (typeof onHypeTrainStart === 'function') onHypeTrainStart(data.level)
      } else if (eventType === 'hype-train-end') {
        toggleKey = 'hype'
        eventClass = 'event-hype'
        text = `[${escapeHtml(channel)}] \u25C6 hype train ended at level ${Number(data.level) || 0}`
        if (typeof onHypeTrainEnd === 'function') onHypeTrainEnd()
      } else if (eventType === 'sub-gift') {
        toggleKey = 'sub'
        eventClass = 'event-sub'
        text = `[${escapeHtml(channel)}] \u25C6 ${t('mc_irc_gift_subs', [escapeHtml(data.user), String(Number(data.count) || 0), escapeHtml(channel)])}`
      } else if (eventType === 'redeem') {
        toggleKey = 'redeem'
        eventClass = 'event-redeem'
        text = `\u25C6 redeemed "${escapeHtml(data.title)}"`
        if (data.rewardId) {
          redeemTitleMap.set(data.rewardId, { title: data.title, cost: data.cost })
          if (redeemTitleMap.size > 200) redeemTitleMap.delete(redeemTitleMap.keys().next().value)
        }
      } else if (eventType === 'prediction-start') {
        toggleKey = 'pred'
        eventClass = 'event-pred'
        const title = data?.title ? ' — ' + escapeHtml(data.title) : ''
        text = `[${escapeHtml(channel)}] ◆ new prediction up${title}`
      } else return

      if (!hermesToggles[toggleKey]) return

      const actor = eventType === 'redeem' ? data.user : null
      const evt = { type: 'stream-event', eventClass, text, channel, actor, time: Date.now() }

      // Push into relevant buffers — only the channel the event belongs to
      const liveChannel = getLiveChannel()
      const chBuffer = irc?.channels?.get(channel)
      if (chBuffer) {
        const existing = chBuffer.getAll()
        if (!existing.some(m => m.type === 'stream-event' && m.text === evt.text)) {
          chBuffer.push(evt)
          saveStreamEvent(evt)
        }
      }
      // Also push into live buffer if this event's channel IS the live channel
      if (channel === liveChannel) {
        const liveBuffer = irc?.channels?.get(liveChannel)
        if (liveBuffer && liveBuffer !== chBuffer) {
          const existing = liveBuffer.getAll()
          if (!existing.some(m => m.type === 'stream-event' && m.text === evt.text)) {
            liveBuffer.push(evt)
          }
        }
      }
      pushActivityEvent(evt)

      // Render only on tabs whose channel matches this event
      const activeTab = currentTab
      if (activeTab === 'live') {
        if (isLiveChannelMessage({ channel })) {
          if (!appendMessage(evt, activeTab)) renderMessages(activeTab)
        }
      } else {
        const tabCh = getChannelById(activeTab)
        if (tabCh) {
          const tw = tabCh.twitch?.toLowerCase()
          const ki = (tabCh.kick)?.toLowerCase()
          if (tw === channel || ki === channel) {
            if (!appendMessage(evt, activeTab)) renderMessages(activeTab)
          }
        }
      }
    }, { signal: mcSignal })

    // Handle follow-driven stream events (from followed channels not currently viewed)
    if (!window._hsMcFollowStreamEventListener) {
      window._hsMcFollowStreamEventListener = true;
      cleanup.addListener(chrome.runtime?.onMessage, (msg) => {
        if (msg.type !== 'follow_stream_event') return;
        const channel = msg.channel?.toLowerCase();
        if (!channel) return;

        // Skip channels already in config — they get stream_event, avoid duplicates
        if (config.channels.some(ch => {
          const id = ch.id?.toLowerCase()
          const tw = (ch.twitch)?.toLowerCase()
          return id === channel || tw === channel
        })) return;

        // Build inline notification
        let text = '', eventClass = '';
        if (msg.eventType === 'stream:update' && msg.game && msg.prevGame !== msg.game) {
          if (!hermesToggles?.gameSwitch) return;
          text = msg.prevGame
            ? `[${channel}] \u25C6 switched to ${msg.game}`
            : `[${channel}] \u25C6 now playing ${msg.game}`;
          eventClass = 'event-follow event-update';
        } else if (msg.eventType === 'stream:online') {
          if (!hermesToggles?.online) return;
          // Drop the "already live on (re)connect" wall: the server replays the
          // whole live roster as realtime online events whenever the WS connects.
          // _swLiveSet is the authoritative poll snapshot of who's *currently*
          // live \u2014 if this channel is already in it, it didn't just go live, so
          // this is snapshot noise. A genuine off\u2192on transition pushes faster
          // than the 60s poll refreshes the set, so it won't be present yet and
          // still surfaces.
          // Triple guard against the "went live" wall:
          //  1. sessionWentLiveSeen — a channel emits at most one went-live
          //     per session (offline clears the mark below). Kills every later
          //     server re-broadcast: connect-snapshot replays, EventSub
          //     re-subscribe, emote-add round-trips that fan out cached
          //     stream.online events, etc.
          //  2. Membership — if a poll snapshot already knows this channel
          //     live, the FIRST emission we see is a snapshot, not a
          //     transition. Drop.
          //  3. Grace window — for the first 30s after content load, the WS
          //     burst can arrive before either set has populated, so neither
          //     #1 nor #2 catches it. Treat any first-emission within 30s as
          //     snapshot.
          // A genuine off→on transition beats the 60s poll and arrives outside
          // the grace, so it still surfaces (and gets recorded so any later
          // re-broadcast of the same channel is deduped).
          if (sessionWentLiveSeen.has(channel)) return;
          const _alreadyLive = liveChannelSet?.has(channel) || _swLiveSet?.has(channel);
          const _inGrace = Date.now() - mcStartedAt < 90000;
          sessionWentLiveSeen.add(channel);
          if (_alreadyLive || _inGrace) return;
          text = msg.game ? `[${channel}] \u25C6 went live \u2014 ${msg.game}` : `[${channel}] \u25C6 went live`;
          eventClass = 'event-follow event-online';
        } else if (msg.eventType === 'stream:offline') {
          sessionWentLiveSeen.delete(channel); // genuine re-go-live can resurface
          if (!hermesToggles?.offline) return;
          text = `[${channel}] \u25C6 went offline`;
          eventClass = 'event-follow event-offline';
        }
        if (!text) return;

        // Dedup: skip if same text was shown in last 60s (same dedup map as stream_event)
        const now = Date.now()
        if (streamEventDedup.has(text) && now - streamEventDedup.get(text) < 60000) return
        streamEventDedup.set(text, now)

        log('[FollowStream]', channel, text);
        notifyStreamEvent(channel, msg.eventType, msg.game, msg.platform);
        const evt = { type: 'stream-event', eventClass, text, channel, time: Date.now(), color: msg.color || '' };

        // Push into the live channel buffer (dedup by text)
        const liveChannel = getLiveChannel();
        const liveBuffer = liveChannel ? irc?.channels?.get(liveChannel) : null;
        if (liveBuffer) {
          const existing = liveBuffer.getAll();
          if (!existing.some(m => m.type === 'stream-event' && m.text === evt.text)) {
            liveBuffer.push(evt);
            saveStreamEvent(evt);
          }
        }

        // Also push into matching channel buffer if different from live
        if (channel !== liveChannel) {
          const chBuffer = irc?.channels?.get(channel);
          if (chBuffer) {
            const existing = chBuffer.getAll();
            if (!existing.some(m => m.type === 'stream-event' && m.text === evt.text)) {
              chBuffer.push(evt);
              if (!liveBuffer) saveStreamEvent(evt);
            }
          }
        }
        pushActivityEvent(evt);

        // Yellow tab highlight only for game changes on the live channel, only when not viewing live
        if (msg.eventType === 'stream:update' && currentTab !== 'live' && isLiveChannelMessage({ channel })) {
          const tab = tabBarElement?.querySelector('[data-tab="live"]');
          if (tab) tab.classList.add('has-stream-event');
        }

        // Render only on tabs whose channel matches this event
        const activeTab = currentTab;
        if (activeTab === 'live') {
          if (isLiveChannelMessage({ channel })) {
            if (!appendMessage(evt, activeTab)) renderMessages(activeTab);
          }
        } else {
          const tabCh = getChannelById(activeTab)
          if (tabCh) {
            const tw = tabCh.twitch?.toLowerCase()
            const ki = (tabCh.kick)?.toLowerCase()
            if (tw === channel || ki === channel) {
              if (!appendMessage(evt, activeTab)) renderMessages(activeTab);
            }
          }
        }
      });
    }

    // Handle color map from server (for persisted stream event history)
    if (!window._hsMcFollowColorsListener) {
      window._hsMcFollowColorsListener = true;
      cleanup.addListener(chrome.runtime?.onMessage, (msg) => {
        if (msg.type !== 'follow_colors') return;
        processFollowColors(msg.colors);
      });
    }

    // Process follow history events (shared by listener + on-demand request)
    function processFollowHistory(events) {
      if (!Array.isArray(events) || events.length === 0) return;

      const builtEvents = [];
      const now = Date.now()
      for (const e of events) {
        const channel = e.channel?.toLowerCase();
        if (!channel) continue;

        // Skip channels already in config — they get stream_event directly
        if (config.channels.some(ch => {
          const id = ch.id?.toLowerCase()
          const tw = (ch.twitch)?.toLowerCase()
          return id === channel || tw === channel
        })) continue;

        let text = '', eventClass = '';
        if (e.type === 'follow:stream:update' && e.game) {
          if (!hermesToggles?.gameSwitch) continue;
          text = e.prevGame
            ? `[${channel}] \u25C6 switched to ${e.game}`
            : `[${channel}] \u25C6 now playing ${e.game}`;
          eventClass = 'event-follow event-update';
        } else if (e.type === 'follow:stream:online') {
          if (!hermesToggles?.online) continue;
          text = e.game ? `[${channel}] \u25C6 went live \u2014 ${e.game}` : `[${channel}] \u25C6 went live`;
          eventClass = 'event-follow event-online';
        } else if (e.type === 'follow:stream:offline') {
          if (!hermesToggles?.offline) continue;
          text = `[${channel}] \u25C6 went offline`;
          eventClass = 'event-follow event-offline';
        }
        if (!text) continue;

        // Dedup against realtime events (same map as stream_event / follow_stream_event)
        if (streamEventDedup.has(text) && now - streamEventDedup.get(text) < 60000) continue
        streamEventDedup.set(text, now)

        const evt = { type: 'stream-event', eventClass, text, channel, time: e.time, color: e.color || '' };
        builtEvents.push(evt)
      }

      const added = injectStreamEventsIntoBuffers(builtEvents, true)
      if (builtEvents.length > 0) saveStreamEventsBatch(builtEvents)

      if (added > 0) {
        log('[FollowHistory]', added, 'events loaded');
        const active = currentTab;
        if (active === 'live' || config.channels.some(ch => ch.id === active)) {
          renderMessages(active);
        }
      }
    }

    // Process follow colors (shared by listener + on-demand request)
    function processFollowColors(colors) {
      if (!colors || typeof colors !== 'object') return;
      if (streamColorMap.size > 500) streamColorMap.clear();
      for (const [login, color] of Object.entries(colors)) {
        if (color) streamColorMap.set(login.toLowerCase(), color);
      }
      log('[FollowColors]', streamColorMap.size, 'colors received');
      const active = currentTab;
      if (active === 'live' || config.channels.some(ch => ch.id === active)) {
        renderMessages(active);
      }
    }

    // Handle real-time follow_history from background broadcast
    if (!window._hsMcFollowHistoryListener) {
      window._hsMcFollowHistoryListener = true;
      cleanup.addListener(chrome.runtime?.onMessage, (msg) => {
        if (msg.type !== 'follow_history') return;
        processFollowHistory(msg.events);
      });
    }

    // Request cached follow history from background (handles race condition on load)
    safeSendMessage({ type: 'get_follow_history' }).then(resp => {
      if (resp?.colors) processFollowColors(resp.colors);
      if (resp?.history) processFollowHistory(resp.history);
    });

    // === BULLETPROOF CONNECTION MAINTENANCE ===

    // 0. YouTube per-channel watchdog. Mirrors the kick watchdog: heatsync
    // server's per-video YT pollers can die without taking the BG WS down,
    // which would otherwise leave one channel silent for hours. 30s tick,
    // 3-min silence threshold (YT chats are slower than twitch/kick on
    // average), then escalate: re-subscribe → unsubscribe+subscribe → BG
    // WS force-reconnect.
    cleanup.setInterval(() => {
      const now = Date.now()
      for (const [channelId, last] of ytChanLastSeen) {
        if (!last || now - last <= 180000) continue
        // Resolve a URL we can re-subscribe with: in priority order, the
        // last one we used, the auto-detected link, the config entry.
        const url = ytSubscribedUrls.get(channelId)
          || youtubeLinks.get(channelId)?.url
          || (() => {
            const c = getChannelById(channelId)
            return c?.youtube || null
          })()
        if (!url) continue
        const attempts = ytChanRejoinAttempts.get(channelId) || 0
        const silenceS = Math.round((now - last) / 1000)
        if (attempts === 0) {
          log('YT', channelId, 'silent', silenceS, 's — re-subscribing')
          chrome.runtime.sendMessage({ type: 'youtube_ws_subscribe', url, channelId }).catch(() => {})
        } else if (attempts === 1) {
          log('YT', channelId, 'still silent', silenceS, 's — unsubscribe + subscribe')
          chrome.runtime.sendMessage({ type: 'youtube_ws_unsubscribe', channelId }).catch(() => {})
          chrome.runtime.sendMessage({ type: 'youtube_ws_subscribe', url, channelId }).catch(() => {})
        } else {
          log('YT', channelId, 'unresponsive', silenceS, 's after', attempts, '— BG WS force-reconnect')
          chrome.runtime.sendMessage({ type: 'ws_force_reconnect', source: 'yt_watchdog', channel: channelId }).catch(() => {})
          ytChanRejoinAttempts.set(channelId, 0)
          ytChanLastSeen.set(channelId, now)
          continue
        }
        ytChanRejoinAttempts.set(channelId, attempts + 1)
        ytChanLastSeen.set(channelId, now) // disarm one cycle
      }
    }, 30000)

    // 1. Detect extension context invalidation → defer reload to visibility.
    // When Chrome restarts the service worker or updates the extension, content
    // scripts become orphaned. Defer reload until tab is visible so background
    // tabs don't all reload at once and crash Chrome. Dedupe via global flag —
    // bootstrap.js + content.js may also schedule.
    cleanup.setInterval(() => {
      const scheduleReload = () => {
        if (window.__heatsyncReloadScheduled) return
        window.__heatsyncReloadScheduled = true
        const doReload = () => { try { location.reload() } catch (_) {} }
        if (document.visibilityState === 'visible') {
          setTimeout(doReload, 1000 + Math.random() * 4000)
        } else {
          document.addEventListener('visibilitychange', function once() {
            if (document.visibilityState !== 'visible') return
            document.removeEventListener('visibilitychange', once)
            setTimeout(doReload, 500 + Math.random() * 2000)
          })
        }
      }
      try {
        if (!chrome.runtime?.id) throw new Error('dead');
        chrome.runtime.sendMessage({ type: 'ping' }).catch(() => {
          log('Background unreachable, deferring reload to visibility...');
          scheduleReload()
        });
      } catch {
        log('Extension context invalidated, deferring reload to visibility...');
        scheduleReload()
      }
    }, 30000)

    // 2. Reconnect auth IRC on tab focus (for sending messages)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (authState.ws && authState.ws.readyState === WebSocket.OPEN) return;
      // Auth IRC is dead — reconnect if we have credentials
      const token = getTwitchAuthToken();
      const nick = currentUsername || getCurrentUsername();
      if (!isEnabled('irc-twitch')) return;
      if (token && nick && !authState.connecting) {
        log('Tab visible, auth IRC dead — reconnecting');
        const prev = [...authState.joined];
        connectAuthIrc(token, nick).then(ok => {
          if (ok === true) {
            for (const ch of prev) joinChannel(ch);
            drainSendQueue();
          }
        });
      }
    }, { signal: mcSignal });

    // 3. Reconnect Kick chat on tab focus
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (!isEnabled('chat-kick')) return;
      if (kickChat && (!kickChat.ws || kickChat.ws.readyState !== WebSocket.OPEN)) {
        log('Tab visible, Kick chat dead — reconnecting');
        kickChat.connect();
      }
    }, { signal: mcSignal });

    // 4. Reconnect EventSub whispers on tab focus
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (!isEnabled('whispers')) return;
      reconnectEventSubIfDead();
    }, { signal: mcSignal });

    // 5. Re-poll live status on tab focus — corrects any stale red dots
    // left over from a missed poll cycle while the tab was hidden.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      try { refreshLiveStatusSoon() } catch {}
    }, { signal: mcSignal });

    // MutationObserver-based mount waiter: fires the moment `find()` returns
    // truthy, then disconnects. Beats the old 500ms polling (avg ~250ms
    // perceived load lag) — content scripts run at document_idle, and the
    // chat container often mounts within 50-150ms of that. 15s safety
    // fallback timer in case the observer never fires (SPA bug, slow page).
    const waitForMount = (find, label) => {
      if (mcSignal?.aborted) return;
      const inject = () => {
        if (mcSignal?.aborted) return;
        ensureUIElements();
        switchTab(_savedActiveTab || 'live');
        startLayoutWatcher();
      };
      if (find()) { inject(); return; }
      let done = false;
      const obs = new MutationObserver(() => {
        if (done || !find()) return;
        done = true;
        obs.disconnect();
        inject();
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      cleanup.trackObserver(obs);
      cleanup.setTimeout(() => {
        if (done) return;
        done = true;
        obs.disconnect();
        if (!find()) log('Failed to find', label, 'after 15s');
        else inject();
      }, 15000);
    };
    if (hostPlatform === 'yt') {
      // YT panel is body-mounted on every page (home, VOD, live, channel),
      // so there's no DOM mount point to wait on. Inject immediately; any
      // late-mounting live chatframe is hidden separately by the chatframe
      // observer in getOrCreateHsContainer + the SPA nav handler.
      ensureUIElements();
      switchTab(_savedActiveTab || 'live');
      startLayoutWatcher();
      // YT computes grid items-per-row + #primary widths from window-keyed
      // ResizeObservers; our layout overrides happen mid-cycle and YT
      // doesn't re-measure until something fires `resize`. One synthetic
      // dispatch (after a paint) gets the home grid to render at the
      // capped width without the user having to wiggle the chat handle.
      requestAnimationFrame(() => {
        try { window.dispatchEvent(new Event('resize')) } catch {}
      });
    } else if (isKick) {
      // Kick non-channel pages (/browse, /categories, /following, /search,
      // /settings, …) never mount #channel-chatroom. Body-mount immediately
      // so the persistent overlay appears without waiting on the 15s safety
      // timeout. Single-segment paths likely become a channel page once
      // chatroom mounts; waitForMount handles that — except for the reserved
      // path names below, which look channel-shaped to the regex but never
      // mount a chatroom, leaving the overlay invisible on /browse etc.
      const KICK_RESERVED_PATHS = new Set([
        'browse', 'categories', 'category', 'following', 'search', 'settings',
        'dashboard', 'help', 'messages', 'notifications', 'community',
        'about', 'subscriptions', 'wallet', 'verify', 'login', 'signup',
        'logout', 'privacy', 'terms', 'rules', 'careers', 'press',
        'profile', 'support'
      ]);
      const isPopout = document.body.classList.contains('hs-popout');
      const segMatch = location.pathname.match(/^\/([a-zA-Z0-9_-]+)\/?$/);
      const couldBeChannel = !!segMatch && !KICK_RESERVED_PATHS.has(segMatch[1].toLowerCase()) && !isPopout;
      if (!couldBeChannel) {
        ensureUIElements();
        switchTab(_savedActiveTab || 'live');
        startLayoutWatcher();
      } else {
        waitForMount(
          () => document.getElementById('channel-chatroom') || document.querySelector('[id*="chatroom"]'),
          'Kick chatroom'
        );
      }
    } else {
      // Twitch: try to hook into React, fall back to MutationObserver
      tryHookReact();
    }
  }

  /**
   * Attempt to hook React components, with fallback.
   * Fires the moment the chat-room appears via MutationObserver — the old
   * 500ms poll meant up to 500ms of perceived lag after Twitch's React
   * actually mounted. Now: usually <1 frame.
   */
  function tryHookReact() {
    let done = false;
    const tryHook = () => {
      if (done || mcSignal?.aborted) return false;
      // Non-channel twitch pages (/directory, /settings, /videos, /search…)
      // never mount .chat-shell or chat-room. Body-mount immediately so the
      // persistent overlay appears without waiting on the 15s safety timeout.
      // Detection: no .channel-root anywhere AND no popout class. Popout has
      // its own .chat-shell mount path that we still want to flow through.
      const onChannel = !!document.querySelector('.channel-root, [class*="channel-root"]');
      const isPopout = document.body.classList.contains('hs-popout');
      if (!onChannel && !isPopout) {
        done = true;
        log('Twitch non-channel page — body-mount overlay');
        ensureUIElements();
        switchTab(_savedActiveTab || 'live');
        startLayoutWatcher();
        return true;
      }
      const chatRoom = findChatRoomComponent();
      if (chatRoom) {
        done = true;
        log('Found chat room component');
        patchChatRoomRender(chatRoom);
        ensureUIElements();
        switchTab(_savedActiveTab || 'live');
        startLayoutWatcher();
        return true;
      }
      const chatContainer = document.querySelector('[class*="chat-room__content"]') ||
                           document.querySelector('[data-a-target="chat-room-component"]') ||
                           document.querySelector('.chat-shell') ||
                           document.querySelector(CONFIG.SELECTORS.TWITCH_STREAM_CHAT) ||
                           document.querySelector('.chat-room');
      if (chatContainer) {
        done = true;
        log('Using fallback DOM injection');
        ensureUIElements();
        switchTab(_savedActiveTab || 'live');
        startLayoutWatcher();
        return true;
      }
      return false;
    };

    if (tryHook()) return;
    const obs = new MutationObserver(() => { if (tryHook()) obs.disconnect() });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    cleanup.trackObserver(obs);
    // Safety net: a slow tab might mount after observer-window misses; bail
    // after 15s to free the observer.
    cleanup.setTimeout(() => {
      if (done) return;
      done = true;
      obs.disconnect();
      log('Failed to find chat components after 15s');
    }, 15000);
  }

  /**
   * Watch for layout changes and re-inject elements if needed
   * This handles theatre mode, popouts, SPA navigation
   */
  let _layoutWatcherStarted = false
  function startLayoutWatcher() {
    if (_layoutWatcherStarted) return
    _layoutWatcherStarted = true

    const reinject = () => {
      if (spaReinitializing) return;
      if (document.getElementById('hs-mc-container')) return;
      log('Container missing, re-injecting...');
      tabBarElement = null;
      overlayElement = null;
      inputBarElement = null;
      resizeObserver = null;
      ensureUIElements();
      updateTabBar();
      renderMessages(currentTab);
    }

    // Safety-net poll. Previously paired with a documentElement-scoped
    // MutationObserver — that observer fired on every Twitch React
    // reconciliation tick (huge sustained CPU). Removed in favor of poll-only.
    // Skipped while tab is hidden so backgrounded tabs cost ~0.
    cleanup.setIntervalIfVisible(() => reinject(), 500);
  }

  // ============================================
  // STARTUP
  // ============================================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { signal: mcSignal });
  } else {
    init();
  }

  // SPA navigation handler — event-driven via early-inject-main.js history hooks
  let lastPath = location.pathname;
  // For YT: /watch?v=A → /watch?v=B keeps the same pathname so we also track
  // the full search string to catch video-to-video hops.
  let lastSearch = location.search;
  let spaReinitializing = false;
  // Twitch SPA nav: zero-flicker soft refresh. Pre-emptively migrate the
  // panel to <body> so twitch's chat-shell teardown doesn't take it down,
  // refresh the body class for the new URL, and (if the new page is a
  // channel page) reparent into the freshly-mounted chat-shell once it
  // appears. IRC, kickChat, observers, feed state — none of it gets
  // destroyed, so the visible panel keeps showing live messages without
  // a single empty frame.
  function softTwitchNav(prevLiveCh) {
    const container = document.getElementById('hs-mc-container');
    // SPA nav changes the URL channel — only the LIVE tab cache becomes
    // stale (it follows getLiveChannel()). Per-channel tab caches stay
    // valid since their data is keyed by channel buffer, not URL.
    try { _dropTabCache('live') } catch {}
    // Mark body for the entire transition window so the CSS guard hides any
    // native chat-shell children that paint during Twitch's teardown/remount.
    document.body.classList.add('hs-mc-navigating');
    // Step 1 — detach from doomed chat-shell ahead of twitch's teardown.
    if (container && container.parentElement && container.parentElement !== document.body) {
      document.body.appendChild(container);
    }
    // Step 2 — flip CSS state to match the new URL's mount surface.
    try { updateTwitchNoChannelClass() } catch (_) {}

    // Step 3 — if the new page is a channel page, wait for its chat-shell to
    // mount, then reparent the panel back so theatre/persistent-player layout
    // continues to work. Single-shot observer; gives up after 4s on slow tabs.
    let done = false;
    const finish = () => {
      // Re-apply hs-native-hidden to the new chat-shell + chat-room + stream-
      // chat. Without this the body.hs-mc-navigating guard would be the only
      // thing hiding native chat — once we drop that class native chat blooms.
      try { setNativeChatHidden(true) } catch (_) {}
      // Resume sticky-bottom on every channel switch — the panel persists
      // across SPA nav, so without this reset the new channel inherits the
      // previous channel's mid-scroll position and live messages stack
      // behind a "N new" pause indicator the user never asked for.
      isScrolledUp = false;
      newMessageCount = 0;
      _scrollbackWindow = 0; // new channel starts at the live tail
      // SPA nav changed the URL channel — re-join + repaint the live tab so the
      // new channel actually connects and renders. Without this the panel froze
      // on the previous channel until an unrelated render fired — a deadlock on
      // a quiet/offline target, the classic "broken or just needs a refresh?"
      // symptom. renderMessages('live') performs the lazy join itself.
      if (currentTab === 'live') { try { renderMessages('live') } catch (_) {} }
      const newBtn = document.getElementById('hs-mc-new-msgs');
      if (newBtn) newBtn.style.display = 'none';
      const msgsEl = document.getElementById('hs-mc-messages');
      if (msgsEl) try { scrollMsgsToBottom(msgsEl) } catch (_) {}
      // Join the new live channel so IRC delivers messages for it.
      // Without this the live tab shows nothing (and deadlocks on quiet
      // channels) because irc never subscribes to the new channel name.
      // Part the previous live channel first (Bug #3) so we don't accumulate
      // a 3000-msg CircularBuffer per visited channel over a long session.
      // Only part if it is not also a config-managed channel tab.
      try {
        const newCh = getCurrentChannel()?.toLowerCase()
        if (prevLiveCh && prevLiveCh !== newCh) {
          const isConfigCh = config.channels.some(ch =>
            ch.twitch?.toLowerCase() === prevLiveCh || ch.kick?.toLowerCase() === prevLiveCh)
          if (!isConfigCh) {
            irc?.part(prevLiveCh)
            kickChat?.part(prevLiveCh)
          }
        }
        if (newCh && irc && !irc.channels.has(newCh)) irc.join(newCh)
        if (newCh && kickChat && !kickChat.channels.has(newCh)) kickChat.join(newCh)
        // Re-arm the native-chat tap on the new channel. Twitch tears down and
        // remounts the message container across SPA nav; without an eager
        // re-bind the tap stays dark until the 5s remount poll fires, leaving a
        // hole in live coverage on every channel switch (worst on starved IPs
        // where the tap IS the live source). startNativeTap is idempotent.
        if (newCh) try { startNativeTap(newCh) } catch (_) {}
        renderMessages('live')
      } catch (_) {}
      // Hold the nav guard for ~300ms so Twitch's render cycle + width
      // transitions on chat-shell ancestors complete entirely behind it.
      // Two rAFs (~32ms) was too short — the grey theme wrappers re-bled in
      // mid-transition. 300ms covers Twitch's full reflow on every machine
      // tested. Plus a chat-shell mutation observer continuously re-applies
      // hs-native-hidden in case React swaps the chat-room__content node.
      const reHide = new MutationObserver(() => { try { setNativeChatHidden(true) } catch (_) {} });
      const target = document.querySelector('.chat-shell, ' + CONFIG.SELECTORS.TWITCH_CHAT_SHELL);
      if (target) {
        reHide.observe(target, { childList: true });
        cleanup.trackObserver(reHide);
      }
      cleanup.setTimeout(() => {
        cleanup.untrackObserver(reHide);
        document.body.classList.remove('hs-mc-navigating');
        // Bar tracks container.getBoundingClientRect — re-anchor now that the
        // container has moved out of its nav-guard fixed slot into chat-shell.
        try { positionChatResizeHandle() } catch (_) {}
      }, 300, 'twitch-soft-nav-release');
      // Twitch's right-column slide-in animation is 500ms. Re-check after it
      // settles so the clipped-chat detection in updateTwitchNoChannelClass
      // catches miniplayer→fullscreen layout breakage post-animation.
      cleanup.setTimeout(() => {
        try { updateTwitchNoChannelClass() } catch (_) {}
        try { positionChatResizeHandle() } catch (_) {}
      }, 700, 'twitch-soft-nav-clipped-check');
    };
    const tryReparent = () => {
      if (done) return true;
      const chatShell = document.querySelector('.chat-shell, [class*="chat-shell"]');
      const c = document.getElementById('hs-mc-container');
      if (chatShell && c && !chatShell.contains(c)) {
        chatShell.appendChild(c);
        try { updateTwitchNoChannelClass() } catch (_) {}
        done = true;
        finish();
        return true;
      }
      return false;
    };
    if (tryReparent()) return;
    const obs = new MutationObserver(() => { if (tryReparent()) cleanup.untrackObserver(obs) });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    cleanup.trackObserver(obs);
    cleanup.setTimeout(() => {
      if (!done) {
        done = true;
        cleanup.untrackObserver(obs);
        try { updateTwitchNoChannelClass() } catch (_) {}
        finish();
      }
    }, 4000, 'twitch-soft-nav-finalize');
  }

  // Kick mirror of softTwitchNav — keep the panel mounted across SPA nav.
  // Pre-emptively migrate to <body> so kick's React teardown of the
  // #channel-chatroom region doesn't take it down, refresh the no-channel
  // class for the new URL, and reparent into a freshly-mounted #channel-
  // chatroom once it appears (channel pages).
  function softKickNav(prevLiveCh) {
    const container = document.getElementById('hs-mc-container');
    // Bug #5: if the container is gone (e.g. back-button landed on a page
    // before our script had mounted it, or a prior nav already removed it),
    // run the full destroy+rebuild path rather than spinning a useless
    // MutationObserver that can never recover a null reference.
    if (!container) {
      fullSpaReinit();
      return;
    }
    // Only invalidate live cache — per-channel tabs stay valid (their
    // buffers are keyed by channel name, unchanged by URL).
    try { _dropTabCache('live') } catch {}
    document.body.classList.add('hs-mc-navigating');
    if (container.parentElement && container.parentElement !== document.body) {
      document.body.appendChild(container);
    }
    try { updateKickNoChannelClass() } catch (_) {}
    let done = false;
    const finish = () => {
      try { setNativeChatHidden(true) } catch (_) {}
      isScrolledUp = false;
      newMessageCount = 0;
      _scrollbackWindow = 0; // new channel starts at the live tail
      // SPA nav changed the URL channel — re-join + repaint the live tab so the
      // new Kick channel connects and renders (otherwise the panel freezes on
      // the previous channel until an unrelated render fires).
      if (currentTab === 'live') { try { renderMessages('live') } catch (_) {} }
      const newBtn = document.getElementById('hs-mc-new-msgs');
      if (newBtn) newBtn.style.display = 'none';
      const msgsEl = document.getElementById('hs-mc-messages');
      if (msgsEl) try { scrollMsgsToBottom(msgsEl) } catch (_) {}
      // Join the new live channel (Bug #1 for Kick path).
      // Part the previous live channel (Bug #3) to avoid buffer accumulation.
      try {
        const newCh = getCurrentChannel()?.toLowerCase()
        if (prevLiveCh && prevLiveCh !== newCh) {
          const isConfigCh = config.channels.some(ch =>
            ch.twitch?.toLowerCase() === prevLiveCh || ch.kick?.toLowerCase() === prevLiveCh)
          if (!isConfigCh) {
            irc?.part(prevLiveCh)
            kickChat?.part(prevLiveCh)
          }
        }
        if (newCh && irc && !irc.channels.has(newCh)) irc.join(newCh)
        if (newCh && kickChat && !kickChat.channels.has(newCh)) kickChat.join(newCh)
        renderMessages('live')
      } catch (_) {}
      const reHide = new MutationObserver(() => { try { setNativeChatHidden(true) } catch (_) {} });
      const target = document.getElementById('channel-chatroom');
      if (target) {
        reHide.observe(target, { childList: true });
        cleanup.trackObserver(reHide);
      }
      cleanup.setTimeout(() => {
        cleanup.untrackObserver(reHide);
        document.body.classList.remove('hs-mc-navigating');
      }, 300, 'kick-soft-nav-release');
    };
    const tryReparent = () => {
      if (done) return true;
      const chatRoom = document.getElementById('channel-chatroom');
      const c = document.getElementById('hs-mc-container');
      if (chatRoom && c && c.previousElementSibling !== chatRoom) {
        chatRoom.after(c);
        try { updateKickNoChannelClass() } catch (_) {}
        done = true;
        finish();
        return true;
      }
      return false;
    };
    if (tryReparent()) return;
    const obs = new MutationObserver(() => { if (tryReparent()) cleanup.untrackObserver(obs) });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    cleanup.trackObserver(obs);
    cleanup.setTimeout(() => {
      if (!done) {
        done = true;
        cleanup.untrackObserver(obs);
        try { updateKickNoChannelClass() } catch (_) {}
        finish();
      }
    }, 4000, 'kick-soft-nav-finalize');
  }

  function handleMcNav() {
    // On YouTube, /watch?v=A → /watch?v=B keeps the same pathname — detect
    // the video change via the full search string so the YT soft-nav block
    // runs and swaps the WS subscription to the new video. YT-only: Twitch
    // (?t=, clip params) and Kick (?category=) churn search via replaceState
    // without a channel change — comparing search there would fire spurious
    // soft-navs (part+join on the live channel) on every param flip.
    const newSearch = location.search
    if (location.pathname === lastPath && (hostPlatform !== 'yt' || newSearch === lastSearch)) return
    // Bug #3: capture the old live channel before updating lastPath so
    // soft-nav can part it and avoid an unbounded irc.channels accumulation.
    // NON_CHANNEL_PATHS filter mirrors getCurrentChannel — without it a nav
    // away from /settings would call irc.part('settings').
    const prevLiveCh = (() => {
      try {
        const m = lastPath.match(/^\/(?:popout\/|embed\/)?([a-zA-Z0-9_-]+)/)
        const slug = m?.[1]?.toLowerCase() || null
        return (slug && !NON_CHANNEL_PATHS.has(slug)) ? slug : null
      } catch { return null }
    })()
    lastPath = location.pathname;
    lastSearch = newSearch;
    log('Navigation detected, reinitializing...');
    // Re-evaluate body-mount overlay state for the new URL before teardown so
    // CSS rules flip ahead of the panel reappearing on the new page.
    try { updateTwitchNoChannelClass() } catch (_) {}
    try { updateKickNoChannelClass() } catch (_) {}

    // Twitch SPA nav: skip the destroy+rebuild path entirely. The panel
    // (and IRC, and feed state) all survive intact — see softTwitchNav.
    // Popout chat is exempt since it never SPA-navigates between URLs.
    if (hostPlatform === 'twitch' && !document.body.classList.contains('hs-popout')) {
      softTwitchNav(prevLiveCh);
      return;
    }

    // Kick SPA nav: same soft path as Twitch. Panel + kickChat persist;
    // body class refreshes for the new URL.
    if (isKick && !document.body.classList.contains('hs-popout')) {
      softKickNav(prevLiveCh);
      return;
    }

    // YouTube SPA nav: panel is body-mounted and survives across URLs.
    // Same rationale as Twitch — destroying + waiting 1s for init left a
    // visible blank gap when the user clicked back from a stream. Just
    // refresh per-page WS subs, re-apply layout. The 4s checkYtLive
    // interval already refreshes hs-offline class within 4s.
    if (hostPlatform === 'yt') {
      // Mark transition so the CSS guard absorbs any flash from YT's primary
      // column reflow (watch ↔ home swaps #primary width, recommendeds visible
      // /hidden, chatframe iframe mount). 300ms covers the full page-state
      // pivot; same pattern as Twitch/Kick soft-nav.
      document.body.classList.add('hs-mc-navigating');
      // Unsubscribe the auto-YT route for the previous page so the new
      // page gets a clean __live_yt_auto__ binding (videoId differs).
      chrome.runtime.sendMessage({
        type: 'youtube_ws_unsubscribe', channelId: '__live_yt_auto__'
      }).catch(() => {})
      channelYtMessages.delete('__live_yt_auto__')
      // Bug #2: clear the watchdog entry for the old video so the 30s
      // interval does not keep force-reconnecting a subscription that no
      // longer exists (ended stream re-subscribe loop).
      ytChanLastSeen.delete('__live_yt_auto__')
      ytChanRejoinAttempts.delete('__live_yt_auto__')
      ytSubscribedUrls.delete('__live_yt_auto__')
      _autoYtVideoId = null;
      // Re-apply layout so destructive overrides re-evaluate against the
      // new pathname (watch ↔ home).
      try { applyChatPosition(); } catch {}
      try { applyYouTubeChatWidth(); } catch {}
      // Nudge YT's responsive code so it recomputes --ytd-rich-grid-width
      // and #primary widths against the new page. Without this the home
      // grid stays clamped at the previous page's width until the user
      // wiggles the resize handle.
      try { window.dispatchEvent(new Event('resize')) } catch {}
      // Resume sticky-bottom on the persistent panel — without this the new
      // page inherits whatever scroll position the previous video left.
      isScrolledUp = false;
      newMessageCount = 0;
      const newBtn = document.getElementById('hs-mc-new-msgs');
      if (newBtn) newBtn.style.display = 'none';
      const msgsEl = document.getElementById('hs-mc-messages');
      if (msgsEl) try { scrollMsgsToBottom(msgsEl) } catch (_) {}
      cleanup.setTimeout(() => {
        document.body.classList.remove('hs-mc-navigating');
      }, 300, 'yt-soft-nav-release');
      return;
    }

    fullSpaReinit();
  }

  // Full destroy+rebuild SPA path — shared by handleMcNav's fallback branch
  // and softKickNav's null-container recovery so both tear down identically.
  function fullSpaReinit() {
    // Flag prevents layout watcher from re-injecting elements we're about to remove
    spaReinitializing = true;
    _layoutWatcherStarted = false;

    // Unsubscribe auto-YouTube from previous channel AND every per-channel
    // YT subscription so init() can cleanly re-subscribe each. Otherwise the
    // server sees duplicate youtube:subscribe events on every SPA navigation
    // and may re-deliver buffered messages.
    chrome.runtime.sendMessage({
      type: 'youtube_ws_unsubscribe', channelId: '__live_yt_auto__'
    }).catch(() => {})
    channelYtMessages.delete('__live_yt_auto__')
    // Bug #2: clear watchdog entries for all unsubscribed YT channels so
    // the 30s watchdog doesn't keep force-reconnecting dead subscriptions.
    ytChanLastSeen.delete('__live_yt_auto__')
    ytChanRejoinAttempts.delete('__live_yt_auto__')
    ytSubscribedUrls.delete('__live_yt_auto__')
    for (const ch of config.channels) {
      if (!ch.youtube) continue
      const link = youtubeLinks.get(ch.id)
      chrome.runtime.sendMessage({
        type: 'youtube_ws_unsubscribe',
        channelId: ch.id,
        url: ch.youtube,
        videoId: link?.videoId || ''
      }).catch(() => {})
      youtubeLinks.delete(ch.id)
      ytChanLastSeen.delete(ch.id)
      ytChanRejoinAttempts.delete(ch.id)
      ytSubscribedUrls.delete(ch.id)
    }

    // Close old read-only IRC to prevent zombie WebSocket reconnect loops
    // NOTE: auth IRC (for sending) is NOT killed here — it survives SPA navigation
    if (irc) {
      irc.destroy();
    }
    irc = null;

    // Destroy old KickChat to prevent stale message listeners
    if (kickChat) {
      kickChat.destroy();
      kickChat = null;
    }

    // Clean up — remove entire container (our elements are inside it)
    document.getElementById('hs-mc-container')?.remove();
    tabBarElement = null;
    overlayElement = null;
    inputBarElement = null;
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    // Disconnect all tracked observers from previous channel to prevent accumulation
    _timers.observers.forEach(o => { try { o.disconnect() } catch {} })
    _timers.observers.length = 0
    // Drain per-channel intervals/timeouts too. init() unconditionally re-registers
    // its pollers (offline 5s/1s, YT-live 1.5s, kick 10s, YT watchdog 30s, ctx-death
    // 1s, layout reinject 500ms) on every reinit; without this they stack one full
    // live set per channel hop and never stop firing (unbounded leak). Persistent
    // ids (bootstrap's module-load ctx-death detector) are kept — they're not
    // re-registered by init(). The spa-reinit setTimeout below is registered AFTER
    // this drain, so it survives.
    _timers.intervals = _timers.intervals.filter(id => {
      if (_timers.persistent.has(id)) return true
      try { clearInterval(id) } catch {}
      return false
    })
    _timers.timeouts = _timers.timeouts.filter(id => {
      if (_timers.persistent.has(id)) return true
      try { clearTimeout(id) } catch {}
      return false
    })
    mcInitialized = false; // Allow init() to run again

    // Reset social tab state (stale on nav)
    feedLoaded = false;
    feedLoading = false;
    feedMessages = [];
    feedPage = 1;
    feedHasMore = true;
    feedLastFetch = 0;
    activeThread = null;
    _autoYtVideoId = null;
    // Reset feed scroll listener flag (new DOM element)
    const oldMsgs = document.getElementById('hs-mc-messages');
    if (oldMsgs) oldMsgs._hsFeedScroll = false;

    // Reinitialize after short delay
    cleanup.setTimeout(() => {
      spaReinitializing = false;
      init();
    }, 1000, 'spa-reinit');
  }

  // KICK PRE-EMPTIVE MIGRATE: Kick's router calls React's render BEFORE it
  // commits the URL via history.pushState — so by the time our MAIN-world
  // pushState hook fires, React has already removed our panel from the
  // chat-layout div. softKickNav running on the heatsync-nav event then
  // sees a detached container and can't save it.
  //
  // Catch the user's click on streamer links in CAPTURE PHASE — runs BEFORE
  // Kick's bubble/target-phase listener triggers React. Migrate container
  // to <body> synchronously; React's teardown of chat-layout no longer
  // affects us. softKickNav still fires post-nav to handle the reparent
  // back into the new chat-room.
  if (isKick) {
    document.addEventListener('click', (ev) => {
      // Only primary button, no modifier keys, no defaultPrevented
      if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.defaultPrevented) return
      const a = ev.target?.closest?.('a[href]')
      if (!a) return
      // Skip new-tab clicks — those don't navigate this tab
      if (a.target && a.target !== '_self') return
      let href = a.getAttribute('href')
      if (!href || !href.startsWith('/')) return
      // Streamer slug = single-segment path (no slashes after first), not a
      // reserved Kick route. Mirrors the eligibility checks in waitForMount.
      const slug = href.replace(/^\/+|\/+$/g, '').toLowerCase()
      if (!slug) return
      if (slug.includes('/')) return
      const reserved = new Set(['browse','category','categories','following','search','settings','login','signup','help','community','privacy','terms','support','dmca','dashboard','partner','vip','agency','bug','press','redeem','clips','games','api','admin','moderation','jobs','about','blog','company','careers','dmca','responsible-disclosure','accessibility','referrals','agent','kickbot','wallet','vault','feedback'])
      if (reserved.has(slug)) return
      // Same URL — don't move anything
      if (location.pathname === href) return
      const container = document.getElementById('hs-mc-container')
      if (!container || container.parentElement === document.body) return
      // Pre-emptive migrate. Runs BEFORE Kick's React handler fires.
      document.body.appendChild(container)
      document.body.classList.add('hs-mc-navigating')
    }, { capture: true, signal: mcSignal })
  }

  // Primary: instant notification from MAIN world history hooks
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return
    if (event.data?.type === 'heatsync-nav') handleMcNav()
    // Fallback rotate paths — heatsync-button.js settings panel posts these
    // so the user always has a way to rotate even if the chat tabbar is
    // somehow not clickable (e.g. extreme drag, weird layout state).
    if (event.data?.type === 'heatsync-rotate-tabs') {
      try { rotateTabPosition() } catch (e) { log('rotate-tabs message handler:', e) }
    }
    if (event.data?.type === 'heatsync-rotate-chat') {
      try { rotateChatPosition() } catch (e) { log('rotate-chat message handler:', e) }
    }
  }, { signal: mcSignal })

  // YouTube SPA navigation
  if (hostPlatform === 'yt') {
    document.addEventListener('yt-navigate-finish', () => handleMcNav(), { signal: mcSignal })
  }

  // Fallback: polling in case MAIN world script didn't load
  cleanup.setIntervalIfVisible(() => handleMcNav(), 5000);

})();

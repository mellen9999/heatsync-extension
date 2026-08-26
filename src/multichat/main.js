/**
 * Heatsync MultiChat - FFZ-style React-aware implementation
 *
 * KEY PRINCIPLE: Work WITHIN React, not around it.
 * - Never manipulate DOM after React renders
 * - Hook into React components and modify render output
 * - Use forceUpdate() to trigger re-renders
 * - Inject UI as React children, not DOM insertions
 */

;(() => {
  const STORAGE_KEY = 'heatsync_multichat'
  const LOG_PREFIX = '[heatsync-mc]'

  // module scope resets on re-injection, so a fresh instance re-registers
  // after the old one's teardown; window-scope survives takeover and leaves
  // handlers dead until hard refresh
  const _onceGuardsMain = {}

  // bidi direction for the user's locale (ltr/rtl) — applied to injected UI roots
  // host page (twitch/kick) keeps its own dir; we only flip our overlay.
  // Resolved fresh on each panel mount so a manual locale override (set in options)
  // is reflected without a full page reload chain.
  function HS_DIR() {
    try {
      return (typeof bidiDir === 'function' ? bidiDir() : chrome?.i18n?.getMessage?.('@@bidi_dir')) || 'ltr'
    } catch {
      return 'ltr'
    }
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
      if (
        attempt < _SAFE_SEND_BACKOFFS_MS.length &&
        (err.includes('Could not establish connection') || err.includes('Receiving end does not exist'))
      ) {
        await new Promise((r) => setTimeout(r, _SAFE_SEND_BACKOFFS_MS[attempt]))
        return _trySendMessageOnce(message, attempt + 1)
      }
      log('sendMessage failed:', err)
      return { ok: false, error: err }
    }
  }

  // State
  let config = { channels: [], enabled: true }
  // 'live' is the only tab that can never be hidden — the pre-restore default
  // must be one you can actually see, or the window before boot's switchTab
  // paints a tab that isn't in the bar.
  let currentTab = 'live'
  let prevTab = 'live'
  // Tabs whose chat legs are still joining. A fresh install lands on a channel
  // and the first messages take ~15-25s (bg irc join + history hydration), and
  // an empty panel saying "no messages yet" for that long reads as broken —
  // the exact silence a new installer judges the extension on. Counter, not a
  // flag: one tab can join twitch + kick + youtube legs.
  const _tabJoining = new Map() // tabId -> outstanding leg count
  // When a tab's last leg settled. A settled join is NOT the same as chat
  // arriving — irc.join resolves once history is requested, and the first
  // messages land seconds later — so the copy holds "connecting…" for a short
  // grace after settle. Also covers the window before any mark exists: marks
  // land in startNetwork's idle slice, well after the panel's first paint.
  const _tabSettledAt = new Map()
  const JOIN_STALL_MS = 30000
  const CONNECT_GRACE_MS = 5000
  let liveChannel = null // override channel for live tab (null = use URL channel)
  let livePlatformMap = {} // per-URL-channel platform overrides: { [urlCh]: { twitch, kick, youtube } }
  let liveChannelSet = new Set() // live per the direct /live-status poll (lowercase names)
  // Live per the service worker's /api/live/following snapshot. Declared HERE,
  // beside the poll set, so isChannelLive() below can never touch it in its
  // temporal dead zone. null = no snapshot seen yet (distinct from "none live").
  let _swLiveSet = null

  /* Does this tab have any chat leg to connect at all? A tab with none (no
   * channel on the page, a link-only entry) is genuinely empty, not connecting. */
  function tabHasChatLegs(id) {
    try {
      if (id === 'live') return !!getCurrentChannel() || !!getLiveChannel()
      const ch = config?.channels?.find((c) => c?.id === id)
      return !!(ch?.twitch || ch?.kick || ch?.youtube)
    } catch {
      return false
    }
  }

  /* Is this tab still wiring up its chat? True while legs are in flight, while
   * a tab with legs has never settled one, and for CONNECT_GRACE_MS after the
   * last settle (join resolves before the first messages hydrate). */
  function isTabConnecting(id) {
    const k = String(id)
    if (_tabJoining.get(k)) return true
    if (!tabHasChatLegs(id)) return false
    const settledAt = _tabSettledAt.get(k)
    if (!settledAt) return true
    return Date.now() - settledAt < CONNECT_GRACE_MS
  }

  /* Mark a tab as joining while `p` (an irc/kick join promise) is outstanding,
   * so its empty state can say "connecting…" instead of "no messages yet".
   * Settles on resolve AND reject — a failed join must not strand the tab on
   * "connecting…" forever (irc.join already toasts its own give-up), and
   * JOIN_STALL_MS covers a promise that never settles at all. */
  function trackJoin(tabId, p) {
    if (!tabId) return p
    const id = String(tabId)
    _tabJoining.set(id, (_tabJoining.get(id) || 0) + 1)
    // Repaint on mark, not just on settle: the panel paints before startNetwork's
    // idle-slice issues the joins, so a visible empty tab has already rendered
    // "no messages yet" by the time we get here.
    if (currentTab === id) {
      try {
        renderMessages(id)
      } catch {}
    }
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      _tabSettledAt.set(id, Date.now())
      const left = (_tabJoining.get(id) || 1) - 1
      if (left > 0) _tabJoining.set(id, left)
      else _tabJoining.delete(id)
      // Only the visible tab needs a repaint; a background tab re-renders on
      // its next switchTab anyway.
      if (currentTab === id) {
        try {
          renderMessages(id)
        } catch {}
      }
      // Repaint once the grace expires so a genuinely silent channel stops
      // claiming "connecting…" — a dead channel must read as dead.
      setTimeout(() => {
        if (currentTab === id && !_tabJoining.get(id)) {
          try {
            renderMessages(id)
          } catch {}
        }
      }, CONNECT_GRACE_MS + 50)
    }
    setTimeout(settle, JOIN_STALL_MS)
    try {
      Promise.resolve(p).then(settle, settle)
    } catch {
      settle()
    }
    return p
  }

  /* Is this lowercase channel name live, per EITHER source?
   *
   * Two sources exist and neither is a superset: the service worker's
   * /api/live/following snapshot (_swLiveSet — only channels you follow) and the
   * direct live-status poll (liveChannelSet — whatever tabs are open). They used
   * to be UNIONED INTO liveChannelSet, which made the set monotonic: a channel
   * that went offline kept its dot because nothing ever removed it, and an EMPTY
   * snapshot (i.e. "nothing you follow is live", the normal case) skipped the
   * update entirely so the stale dot became permanent. Deriving membership at
   * read time means either source refreshing is enough to clear a dot. */
  function isChannelLive(name) {
    if (!name) return false
    return (_swLiveSet ? _swLiveSet.has(name) : false) || liveChannelSet.has(name)
  }
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
  let irc = null
  let kickChat = null
  let currentUsername = null
  let originalRender = null
  let tabBarElement = null
  let overlayElement = null
  let inputBarElement = null // Separate input bar (always visible)
  let pendingMessage = '' // Persists across tab switches
  let tabPosition = 'top' // 'top', 'right', 'bottom', 'left'
  let resizeObserver = null // Tracks overlay top sync observer
  // Exact nodes resizeObserver is currently watching. ensureUIElements can
  // replace tabBarElement/inputBarElement on any platform re-render, and an
  // observer created once would keep watching the detached originals — so the
  // targets are reconciled against this list on every pass.
  let _roWatched = []
  let _updateMcLayout = () => {} // Set by ensureUIElements; callable from rotateTabPosition
  let _mcStorageListener = null

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
    const norm = (s) =>
      String(s || '0')
        .split('-')[0]
        .split('.')
        .slice(0, 3)
        .map((x) => parseInt(x, 10) || 0)
        .concat([0, 0, 0])
        .slice(0, 3)
    const A = norm(a),
      B = norm(b)
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
      'hs-resize-ghost',
      'hs-resize-overlay',
      'hs-c-resize-ghost',
      'hs-c-resize-overlay',
      'hs-yt-resize-ghost',
      'hs-yt-resize-overlay',
      'hs-kick-resize-ghost',
      'hs-kick-resize-overlay',
    ])
      document.getElementById(id)?.remove()
  }
  cleanup.addEventListener(window, 'blur', _hsAbortAllResizes)
  // Hidden-tab DOM pause: appendMessage skips all DOM work while the tab is
  // hidden (buffers stay the source of truth); this flag marks that at least
  // one message was skipped so the visible transition rebuilds once.
  let _hiddenSkippedAppend = false
  // Wedge flag: true when the BG oracle proved this tab is on screen while
  // document.hidden still reads true (lost occlusion flip — popout windows).
  // A real visibilitychange event proves the tracking is live again.
  let _visWedged = false
  // Inverse-wedge flag: rAF starved while document.hidden reads false
  // (occluded window whose visibility flip never arrived). Set/cleared by
  // rafOrTimeout's watchdog + recovery probe.
  let _rafStarved = false
  let _rafProbePending = false
  const hsDiagLog = (e, x) => {
    try {
      window.__hsDiag?.(e, x)
    } catch (_) {}
  }
  cleanup.addEventListener(document, 'visibilitychange', () => {
    _visWedged = false
    hsDiagLog('vis', { hidden: document.hidden, focus: document.hasFocus() })
    if (document.hidden) _hsAbortAllResizes()
    // Pause our infinite breathe/livedot CSS animations while the tab is
    // hidden — no paint happens, so running them is pure wasted style recalc on
    // low-end hardware. The matching rules live in styles.js (body.hs-ext-hidden).
    try {
      document.body.classList.toggle('hs-ext-hidden', document.hidden)
    } catch (_) {}
    // Hidden: shed most of the live chat DOM (rows + their image refs) — the
    // buffers hold everything, and the visible transition below rebuilds the
    // full cap. Setting the skip flag makes that rebuild unconditional, so a
    // trim with zero messages arriving while hidden still restores itself.
    if (document.hidden) {
      try {
        // Chat surfaces only: feed/settings/social tabs and open profile
        // cards hold interactive state (drafts, scroll pos) a trim+rebuild
        // would wipe. Chat rows are pure render output — safe to shed.
        // Scroll-paused readers are NOT safe to shed: isScrolledUp means the
        // user deliberately scrolled up to read history; trimming to the
        // newest 100 rows destroys the rows (and scroll anchor) they're
        // parked on, and the rebuild-on-visible below renders the buffer
        // tail — their place is gone. Skip the shed while paused; the
        // scroll-pause gate in renderMessages keeps the DOM stable on return.
        const staticTabs = new Set(['settings', 'feed', 'whispers', 'discover', 'pinned'])
        const cardOpen = typeof activeProfileCard !== 'undefined' && activeProfileCard
        const msgsEl = document.getElementById('hs-mc-messages')
        if (msgsEl && msgsEl.childElementCount > 100 && !staticTabs.has(currentTab) && !cardOpen && !isScrolledUp) {
          trimMessagesEl(msgsEl, 100)
          _hiddenSkippedAppend = true
        }
      } catch (_) {}
    }
    // Catch up after a hidden stretch: one rebuild from buffers replaces the
    // N per-message appends we skipped. renderMessages self-guards for the
    // settings tab and open profile cards, so no state checks needed here.
    if (!document.hidden && _hiddenSkippedAppend) {
      _hiddenSkippedAppend = false
      try {
        renderMessages(currentTab)
      } catch (_) {}
    }
  })
  // Escape hatches for the catch-up above: popout windows can miss the
  // hidden→visible visibilitychange (wayland/occlusion tracking), leaving the
  // pane frozen on stale rows even though messages keep buffering. A window
  // focus is proof the user is looking — rebuild if anything was skipped.
  cleanup.addEventListener(window, 'focus', () => {
    if (!_hiddenSkippedAppend) return
    _hiddenSkippedAppend = false
    hsDiagLog('catchup', { src: 'focus' })
    try {
      renderMessages(currentTab)
    } catch (_) {}
  })
  // BG visibility oracle nudge: fired when this tab's window gained OS focus
  // or the tab was activated — airtight proof it's on screen. If we still
  // believe hidden, the visibility tracking is wedged: mark it, drop the
  // animation-pause class, and catch up. appendMessage honors _visWedged so
  // rendering stays live until a real visibilitychange arrives.
  cleanup.addListener(chrome.runtime?.onMessage, (msg) => {
    if (msg?.type !== 'hs_vis_nudge') return
    if (!document.hidden) return // tracking agrees — nothing wedged
    if (!_visWedged) hsDiagLog('wedge_detected', { skipped: _hiddenSkippedAppend })
    _visWedged = true
    try {
      document.body.classList.remove('hs-ext-hidden')
    } catch (_) {}
    if (_hiddenSkippedAppend) {
      _hiddenSkippedAppend = false
      hsDiagLog('catchup', { src: 'nudge' })
      try {
        renderMessages(currentTab)
      } catch (_) {}
    }
  })

  // Shared fail-loud path for user-intent storage writes — an added channel,
  // a mute, a block. A swallowed failure here means the action LOOKS saved
  // (the in-memory state + UI already reflect it) and is silently gone on
  // reload. console.warn alone doesn't cut it — the error reporter only
  // hooks console.error. Every write below this shape routes through here
  // instead of duplicating the try/catch/toast.
  function reportStorageWriteFailure(what, err, toastKey) {
    console.error(`[heatsync-mc] ${what} storage write failed:`, err)
    try {
      showToast(t(toastKey), 'error')
    } catch (_) {}
  }

  // Muted users (right-click to hide) — hydrated at boot from the
  // background-synced `muted_users` key (see PHASE 2), NOT from the
  // heatsync_mc_muted write below, which nothing reads. Do not "fix" that by
  // reading it back: unmutes routed straight to background (settings-ui.js)
  // never update it, so a stale entry would silently resurrect a mute.
  const mutedUsers = new Set()
  // Single persist path for the mute list — every toggle site routes here so
  // a storage failure (quota, mid-reload context death) surfaces as a toast
  // instead of dying in the MC_DEBUG-gated logger after the success toast
  // already fired. Mirrors the ui_settings save path's fail-loud convention.
  function persistMcMuted() {
    try {
      chrome.storage.local
        .set({ heatsync_mc_muted: [...mutedUsers] })
        .catch((e) => reportStorageWriteFailure('mute list', e, 'mc_main_mute_save_failed'))
    } catch (e) {
      reportStorageWriteFailure('mute list', e, 'mc_main_mute_save_failed')
    }
  }
  // Blocked users (right-click → block) — fully hidden, not just stripped like mute.
  // Synced with background's block_user/unblock_user (shared with content.js).
  const blockedUsers = new Set()

  // Per-tab hide (/hide, right-click → "hide in this tab") — fully hides a user's
  // rows in ONE tab only. Deliberately EPHEMERAL and LOCAL: Map<tabId, Set<userKey>>,
  // never persisted, never fanned out via safeSendMessage — so a tab-scoped hide
  // can't leak into other tabs, the popout, or another surface the way blocked/
  // muted (which sync globally) do. Cleared on reload. Distinct from block (which
  // is account-level + global) and mute (which strips content but keeps the row).
  const perTabHidden = new Map()

  // ─── User-key aliasing ─── When a Kick chatter has a 7TV-linked Twitch
  // handle (kickNameToTwitchUsername populated by the cosmetics pipeline),
  // mute/block actions fan out to BOTH names. So one mute on a Kick chatter
  // also silences them when they post on Twitch, and vice-versa. Unmute
  // mirrors. mentionAliases (mentions.js) covers the inverse for YOUR own
  // identity already.
  function getUserAliases(username, _platform) {
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
    // YouTube→Twitch: same direction as Kick, populated by the YT cosmetics
    // lookup (flushYtNameLookups), which fetches the heatsync profile and now
    // also caches its twitch_username. YT handles render with/without a leading
    // '@', so normalize the bare form too — a mute/block on the linked Twitch
    // (or YouTube) identity then also hides their YouTube messages.
    if (typeof ytNameToTwitchUsername !== 'undefined') {
      const yk = u.replace(/^@/, '')
      if (yk !== u && !out.includes(yk)) out.push(yk)
      const tw = ytNameToTwitchUsername.get(yk)
      if (tw && !out.includes(tw.toLowerCase())) out.push(tw.toLowerCase())
    }
    return out
  }

  // Namespaced-key variant of getUserAliases: `platform:username` for the base
  // identity plus any linked cross-platform identity (always twitch). Feeds the
  // platform-scoped block/mute Sets so unrelated same-handle users on different
  // platforms don't collide. See user-key.js.
  function getUserAliasKeys(username, platform) {
    const u = String(username || '')
      .toLowerCase()
      .replace(/^@/, '')
    if (!u) return []
    const keys = [userKey(u, platform)]
    if (typeof kickNameToTwitchUsername !== 'undefined') {
      const tw = kickNameToTwitchUsername.get(u)
      if (tw) {
        const k = userKey(tw, 'twitch')
        if (!keys.includes(k)) keys.push(k)
      }
    }
    if (typeof ytNameToTwitchUsername !== 'undefined') {
      const tw = ytNameToTwitchUsername.get(u)
      if (tw) {
        const k = userKey(tw, 'twitch')
        if (!keys.includes(k)) keys.push(k)
      }
    }
    return keys
  }

  function isUserMuted(username, platform) {
    // Per-message hot path — short-circuit the empty set before allocating.
    // userSetMatches checks the legacy bare key first, so pre-namespace stored
    // mutes still match on every platform (no migration); the platform-scoped and
    // linked-identity keys match new namespaced writes. See user-key.js.
    if (!username || mutedUsers.size === 0) return false
    return userSetMatches(mutedUsers, username, platform, getUserAliasKeys(username, platform))
  }

  function isUserBlocked(username, platform) {
    if (!username || blockedUsers.size === 0) return false
    return userSetMatches(blockedUsers, username, platform, getUserAliasKeys(username, platform))
  }

  // Per-tab hide predicate — hot path, so short-circuit before allocating alias
  // keys when this tab has no hidden users. Same alias-matching as block/mute.
  function isUserHiddenInTab(username, platform, tabId) {
    if (!username || !tabId) return false
    const set = perTabHidden.get(tabId)
    if (!set || set.size === 0) return false
    return userSetMatches(set, username, platform, getUserAliasKeys(username, platform))
  }

  // Content-warning filters live entirely in the settings registry (schema
  // entries with a `cw` sub-shape); _mcStorageListener's generic local-key
  // loop keeps the cache + visible pills coherent cross-tab.

  // Per-tab platform filters: { [tabId]: { twitch, kick, youtube } }, defaults all true
  let platformFilters = {}

  // Channel point redeem title cache: rewardId → { title, cost }
  const redeemTitleMap = new Map()

  // Buffers
  const mentionsBuffer = []
  const MAX_BUFFER = 500

  // Mod-action log: capped in-memory history of ban/timeout/unban/delete notices
  // (self + observed, all channels), for the streamer/mod popout view. Recorded
  // at the irc/kick 'message' chokepoints (below) so it survives chat-buffer
  // cycling. Pure logic + dedup/cap live in mod-log.js (unit-tested).
  const modActionLog = []

  // Max chat rows kept as live DOM. Decoupled from the data buffers (ring
  // buffer 1500, persist 1500) which stay large for scrollback-data, sync and
  // reload restore — those are cheap plain objects. The DOM cap is the
  // expensive axis (~6 nodes/row), so we render far fewer than we remember.
  // Rows render fully (content-visibility:auto was dropped 2026-07-14 — the
  // skipped→rendered flip left stale paint smears on scroll), so this cap is
  // the only bound on both node count AND paint cost at a busy channel.
  // 500 unifies the whole system (MAX_BUFFER) on one number and matches the
  // per-platform buffer, so a restored cached tab never exceeds the cap.
  // ~3.3x Twitch native scrollback.
  let DOM_RENDER_CAP = 500 // registry-managed (hs_dom_render_cap)

  // Upward scrollback: extra rows beyond DOM_RENDER_CAP to paint when the user
  // reaches the top. 0 = live tail only (DEFAULT — behaviour is byte-identical
  // to a plain cap; the feature is inert until the user scrolls up). Grows in
  // SCROLLBACK_STEP chunks up to SCROLLBACK_MAX total rendered rows, drawn from
  // the existing 3000-deep ring buffer (no network — just paint more of what's
  // already buffered). Reset to 0 on tab switch / channel nav / jump-to-bottom
  // so the DOM never stays bloated past the live tail.
  let _scrollbackWindow = 0
  const SCROLLBACK_STEP = 250
  const SCROLLBACK_MAX = 1500 // hard ceiling on rendered rows (3x the live cap)

  // n/N match cursor for the live-tab search filter — msgKey of the row
  // currently marked .hs-mc-search-current, or null when inactive. Keyed by
  // msgKey (not a DOM ref or array index) so it self-heals across renders:
  // renderMessages just re-finds this key in the new toRender each pass.
  // Reset on query change / query clear / tab switch (never bleeds across
  // channels — same rule as the query itself).
  let _liveSearchCurrentKey = null

  // Platform from location.hostname — the manifest's match patterns gate
  // which hostnames the shared multichat-core.js bundle is injected into, so
  // hostname IS the platform declaration (the retired per-platform bundles
  // used an esbuild __HS_HOST__ define; a shared core can't constant-fold).
  const isKick = location.hostname.includes('kick.com')
  const hostPlatform = isKick ? 'kick' : location.hostname.includes('youtube.com') ? 'yt' : 'twitch'

  // A standalone youtube.com/live_chat TOP window = a HeatSync pop-out chat
  // window. The youtube multichat entry only runs in the top frame, so /live_chat here
  // can only be a popout (never the watch-page's embedded chat iframe, which is
  // a child frame the bundle never touches). Treat it like the twitch/kick
  // popout: fill the window, single stream, native chat hidden, boot to 'live'.
  // NOT /live_chat_replay — that's yt's native VOD-chat popout; taking it over
  // would hide the replay chat behind a live overlay with nothing to show.
  const isYtPopout = hostPlatform === 'yt' && /^\/live_chat(?!_replay)/.test(location.pathname)
  // yt's native VOD-chat popout — never surface the panel there, even with
  // chat-on-all-pages on: the page IS a chat surface, the panel would dock
  // over the replay it exists to show.
  const isYtReplayPopout = hostPlatform === 'yt' && /^\/live_chat_replay/.test(location.pathname)

  // Whether the user has chosen to show native platform chat alongside HS.
  // Persisted via settings registry (key: nativeVisible). Default false = same
  // behaviour as before this feature existed.
  let nativeVisible = false

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
      if (!s) {
        s = new Set()
        _uidIndex.set(uid, s)
      }
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
      if (!ms) {
        ms = new Set()
        _mentionIndex.set(muid, ms)
      }
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
      if (s) {
        s.delete(div)
        if (!s.size) _uidIndex.delete(uid)
      }
    }
    const mentions =
      div._hsMentionEls || div.querySelectorAll('a.hs-mc-mention[data-uid], a.hs-mc-reply-user[data-uid]')
    for (const m of mentions) {
      const muid = m.dataset.uid
      if (!muid) continue
      const ms = _mentionIndex.get(muid)
      if (ms) {
        ms.delete(m)
        if (!ms.size) _mentionIndex.delete(muid)
      }
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
  // leaving; restore when returning — no teardown→rebuild cycle, no image-load
  // flicker, no zebra resettle. Messages that arrived while inactive are
  // reconciled against the buffer on restore.
  // ============================================
  const _tabCache = new Map() // tabId → { frag, msgKeyIndex, uidIndex, mentionIndex }
  // LRU cap. Each entry holds up to DOM_RENDER_CAP detached rows plus cloned
  // index Maps, and every row keeps its emote <img> bitmaps decoded — at the
  // default cap that is up to 6000 detached rows resident purely so a tab
  // switch does not flash. On a 4GB box that is the single largest allocation
  // the extension makes, and unlike the render cap there was no way to reach
  // it. Scale it to the machine: navigator.deviceMemory is a coarse GB figure
  // (Chrome clamps it to 0.25–8; Firefox does not implement it, hence the
  // default). Two cached tabs still cover the common there-and-back switch.
  const _TAB_CACHE_MAX = (() => {
    try {
      const gb = navigator.deviceMemory
      if (typeof gb === 'number' && gb > 0 && gb <= 4) return 2
    } catch (_) {}
    return 4
  })()
  try {
    document.documentElement.dataset.hsTabCacheV1 = '1'
  } catch {}

  function _isChatTab(id) {
    if (!id) return false
    if (id === 'live' || id === 'mentions') return true
    if (
      id === 'feed' ||
      id === 'whispers' ||
      id === 'discover' ||
      id === 'pinned' ||
      id === 'modlog' ||
      id === 'settings' ||
      id === 'add'
    )
      return false
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
    const atBottom = !isScrolledUp || scrollHeight - clientHeight - scrollTop < 8
    const frag = document.createDocumentFragment()
    while (msgsEl.firstChild) frag.appendChild(msgsEl.firstChild)
    const msgKeyIndex = new Set(_msgKeyIndex)
    const uidIndex = new Map()
    for (const [k, v] of _uidIndex) uidIndex.set(k, new Set(v))
    const mentionIndex = new Map()
    for (const [k, v] of _mentionIndex) mentionIndex.set(k, new Set(v))
    // Re-set (delete then set) moves tabId to the MRU end of iteration order —
    // a Map re-assigning an EXISTING key does not reorder it. LRU-evict past
    // the cap: each entry holds a DocumentFragment of up to 1500 detached rows
    // plus cloned index Maps, so an unbounded number of snapshotted-and-never-
    // revisited tabs (many channels switched through in one session) would
    // otherwise grow this without limit.
    _tabCache.delete(tabId)
    _tabCache.set(tabId, {
      frag,
      msgKeyIndex,
      uidIndex,
      mentionIndex,
      scrollTop,
      scrollHeight,
      clientHeight,
      atBottom,
      isScrolledUp,
      newMessageCount,
    })
    if (_tabCache.size > _TAB_CACHE_MAX) _tabCache.delete(_tabCache.keys().next().value)
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
    _snapCompleteEmotes(cache.frag)
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
      rafOrTimeout(() => {
        try {
          msgsEl.scrollTop = msgsEl.scrollHeight + 10000
        } catch {}
      })
    } else {
      isScrolledUp = true
      newMessageCount = cache.newMessageCount || 0
      if (newBtn) {
        if (newMessageCount > 0) {
          newBtn.replaceChildren()
          const arrow = document.createElement('span')
          arrow.className = 'hs-arrow-down'
          arrow.textContent = '▼'
          newBtn.append(arrow, ` ${String(newMessageCount)} new`)
          newBtn.style.display = 'flex'
        } else {
          newBtn.style.display = 'none'
        }
      }
      rafOrTimeout(() => {
        try {
          msgsEl.scrollTop = cache.scrollTop
        } catch {}
      })
    }
    _tabCache.delete(tabId) // entry is now empty (children moved out); next snapshot rebuilds
    return true
  }

  // mentionsSeenCount removed — mentions unread is now driven by
  // seen-state.js (server-backed seenAt.mentions vs client-tracked
  // latestAt.mentions). See bumpSeen('mentions') / noteSeenEvent('mentions').

  // Per-channel YouTube: messages and links
  const channelYtMessages = new Map() // channelTabId → message[]
  const youtubeLinks = new Map() // channelTabId → { url, videoId, channelName }
  // YouTube watchdog state — per-channel last activity + rejoin escalation count.
  // Mirrors the kick/twitch watchdogs: catches the case where the heatsync
  // server's YT poller dies for one video without taking down the WS, so
  // global metrics look fine but one channel goes silent.
  const ytChanLastSeen = new Map() // channelId -> ms
  const ytChanRejoinAttempts = new Map() // channelId -> escalation count
  const ytSubscribedUrls = new Map() // channelId -> last-known sub URL
  function touchYtChannel(channelId) {
    if (!channelId) return
    ytChanLastSeen.set(channelId, Date.now())
    if (ytChanRejoinAttempts.size) ytChanRejoinAttempts.delete(channelId)
  }

  // ============================================
  // PERSISTED BUFFERS — survives page reload
  // mentions + per-channel YT messages + per-tab seen-time, mirroring the
  // IRC/Kick reload-bulletproofing in irc.js. chrome.storage.local writes are
  // debounced 1.5s; localStorage takes a synchronous tail backup on pagehide
  // to close the debounce gap that survives a reload mid-burst.
  // ============================================
  const PERSIST_DEBOUNCE_MS = 1500
  const PERSIST_MAX_MENTIONS = 500 // matches MAX_BUFFER so restore fills the live buffer
  const PERSIST_MAX_YT = 500
  const _persistMentionsState = { timer: null, dirty: false }
  const _persistYtTimers = new Map() // channelId -> timer
  const _persistYtDirty = new Set() // channelIds with unflushed messages
  let _persistTabSeenTimer = null
  const tabSeenAt = {} // tabId -> ms

  function _serializePersistMsg(m) {
    return {
      user: m.user,
      userId: m.userId,
      text: m.text,
      color: m.color,
      badges: m.badges,
      channel: m.channel,
      time: m.time,
      id: m.id,
      platform: m.platform || undefined,
      isAction: m.isAction || undefined,
      replyTo: m.replyTo || undefined,
      type: m.type || undefined,
      msgId: m.msgId || undefined,
      isHighlighted: m.isHighlighted || undefined,
      avatar: m.avatar || undefined,
      msgType: m.msgType || undefined,
      amount: m.amount || undefined,
      systemMsg: m.systemMsg || undefined,
      sticker: m.sticker || undefined,
      scColor: m.scColor || undefined,
      eventClass: m.eventClass || undefined,
      actor: m.actor || undefined,
      emotes: m.emotes || undefined,
      subMonths: m.subMonths || undefined,
      streakCount: m.streakCount || undefined,
    }
  }

  function _writeMentionsNow() {
    try {
      if (!chrome?.runtime?.id) return
      const msgs = mentionsBuffer.slice(-PERSIST_MAX_MENTIONS).map(_serializePersistMsg)
      const p = chrome.storage.local.set({ hs_mentions_v2: { msgs, ts: Date.now() } })
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch {}
  }

  function persistMentions() {
    _persistMentionsState.dirty = true
    if (_persistMentionsState.timer) return
    _persistMentionsState.timer = cleanup.setTimeout(() => {
      _persistMentionsState.timer = null
      _persistMentionsState.dirty = false
      _writeMentionsNow()
    }, PERSIST_DEBOUNCE_MS)
  }

  function _writeYtNow(channelId) {
    try {
      if (!chrome?.runtime?.id) return
      const buf = channelYtMessages.get(channelId)
      if (!buf) return
      const msgs = buf.slice(-PERSIST_MAX_YT).map(_serializePersistMsg)
      const p = chrome.storage.local.set({ [`hs_yt_${channelId}`]: { msgs, ts: Date.now() } })
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch {}
  }

  function persistYt(channelId) {
    if (!channelId) return
    _persistYtDirty.add(channelId)
    if (_persistYtTimers.has(channelId)) return
    _persistYtTimers.set(
      channelId,
      cleanup.setTimeout(() => {
        _persistYtTimers.delete(channelId)
        _persistYtDirty.delete(channelId)
        _writeYtNow(channelId)
      }, PERSIST_DEBOUNCE_MS),
    )
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
      // chat history and cross-platform mentions are backed exclusively by
      // chrome.storage.local (persistMentions/persistYt) — writing them to the
      // host page's localStorage (twitch.tv/kick.com/youtube.com) would expose
      // HeatSync user data to host-page scripts and co-resident extensions.
      if (_persistTabSeenTimer) {
        localStorage.setItem('hs_tab_seen_sync', JSON.stringify({ data: { ...tabSeenAt }, ts: Date.now() }))
      }
    } catch {}
    // Drain pending mention/YT debounces the way KickChat._flushPendingSync
    // drains kick buffers: a storage.local.set DISPATCHED during pagehide
    // survives the unload, so this closes the 1.5s debounce gap without
    // writing HeatSync data to the host page's localStorage.
    try {
      if (_persistMentionsState.timer) {
        cleanup.clearTimeout(_persistMentionsState.timer)
        _persistMentionsState.timer = null
        _persistMentionsState.dirty = false
        _writeMentionsNow()
      }
      for (const [channelId, t] of [..._persistYtTimers]) {
        cleanup.clearTimeout(t)
        _persistYtTimers.delete(channelId)
        _persistYtDirty.delete(channelId)
        _writeYtNow(channelId)
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

      let mChrome = null,
        mSync = null
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
          // Legacy residue: older builds mirrored cross-platform mentions to
          // host-page localStorage (readable by the host site + co-resident
          // extensions). We no longer write it — chrome.storage.local
          // (hs_mentions_v2) is authoritative — so migrate any remaining copy
          // via the merge below, then purge it from the host origin for good.
          localStorage.removeItem('hs_mentions_sync')
        }
      } catch {}
      if (mChrome || mSync) {
        const byId = new Map()
        const noId = []
        const ingest = (a) => {
          if (!a) return
          for (const m of a) {
            if (m.id) byId.set(m.id, m)
            else noId.push(m)
          }
        }
        ingest(mChrome)
        ingest(mSync)
        const merged = [...byId.values(), ...noId].sort((a, b) => (a.time || 0) - (b.time || 0))
        for (const m of merged) {
          m.isHistory = true
          mentionsBuffer.push(m)
        }
        if (mentionsBuffer.length > PERSIST_MAX_MENTIONS) {
          mentionsBuffer.splice(0, mentionsBuffer.length - PERSIST_MAX_MENTIONS)
        }
        log('Restored mentions:', mentionsBuffer.length, `chrome:${mChrome?.length || 0}`, `sync:${mSync?.length || 0}`)
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
          const hasYtLink = configLoaded && config.channels.some((c) => c && c.id === channelId && c.youtube)
          if (!hasYtLink) {
            if (configLoaded) staleYtIds.push(channelId)
            continue
          }
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
          ingest(v.msgs)
          ingest(syncMsgs)
          // ordOf, not raw time — a persisted live-paced row carries its own
          // `ord` (the paced-commit clock), which is what fairMerge/
          // mergeSortedRuns actually sort on. Sorting by raw time here would
          // restore the buffer in a different order than it was ever
          // rendered in, breaking the sortedness invariant those rely on.
          buf.sort((a, b) => ordOf(a) - ordOf(b))
          if (buf.length > PERSIST_MAX_YT) buf.splice(0, buf.length - PERSIST_MAX_YT)
        }
        if (staleYtIds.length) {
          try {
            await chrome.storage.local.remove(staleYtIds.map((id) => `hs_yt_${id}`))
          } catch {}
          for (const id of staleYtIds) {
            try {
              localStorage.removeItem(`hs_yt_sync_${id}`)
            } catch {}
            try {
              channelYtMessages.delete(id)
            } catch {}
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
    const SPECIAL = new Set(['mentions', 'whispers', 'feed', 'discover', 'pinned', 'modlog', 'add', 'settings', 'live'])
    for (const tabEl of tabs) {
      const tabId = tabEl.dataset.tab
      if (!tabId || tabId === currentTab) continue
      if (SPECIAL.has(tabId)) continue
      const seen = tabSeenAt[tabId] || 0
      if (!seen) continue // first-time view of this tab — don't spuriously light up
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
            try {
              if (isMention(m)) hasMention = true
            } catch {}
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

  // Username cache for tab completion — LRU-capped (Set preserves insertion order)
  const usernameCache = new Set()
  const USERNAME_CACHE_MAX = 5000
  function addUsername(name) {
    if (!name) return
    if (usernameCache.has(name)) {
      usernameCache.delete(name)
      usernameCache.add(name)
      return
    }
    usernameCache.add(name)
    // _ucDisplay (input.js) mirrors usernameCache as bareLowerName → cased
    // name, kept incremental here instead of rebuilt by scanning the whole
    // cache on every autocomplete keystroke. A yt "@handle" and a twitch
    // "handle" collide on the same bare key — last-added wins, matching the
    // old full-rescan's insertion-order behavior.
    // Also load-bearing beyond autocomplete: highlightMentionsInHtml uses it as
    // the "this name actually spoke" oracle that gates bare-word mentions. Keep
    // addUsername (fed only by real sender paths) its sole writer — seeding it
    // from a name lookup would re-open the "@you made every 'you' a link" bug.
    _ucDisplay.set(name.toLowerCase().replace(/^@/, ''), name)
    if (usernameCache.size > USERNAME_CACHE_MAX) {
      const iter = usernameCache.values()
      for (let i = 0; i < 500; i++) {
        const evicted = iter.next().value
        usernameCache.delete(evicted)
        const key = evicted.toLowerCase().replace(/^@/, '')
        // Only clear the display entry if it still points at the evicted name —
        // a newer, still-live name sharing the same bare key must survive.
        if (_ucDisplay.get(key) === evicted) _ucDisplay.delete(key)
      }
    }
  }
  // Username → color map for @mention coloring (LRU-bounded)
  const knownColors = new Map()
  // platform:username → Twitch userId for paint cosmetics on @mentions. Keyed
  // by platform so a twitch "alice" and an unrelated kick "alice" never share
  // a slot — without the prefix, whichever platform's chatter spoke last would
  // silently steal the other's 7TV paint/badge on every @mention/reply of that
  // name. Values are always a resolved TWITCH id (see resolveSenderEmoteKey /
  // flushKickNameLookups) — only the KEY needs the platform tag.
  const knownUserIds = new Map()
  function setKnownColor(user, color, userId, platform) {
    knownColors.set(user, color)
    if (knownColors.size > 2000) {
      const iter = knownColors.keys()
      for (let i = 0; i < 500; i++) knownColors.delete(iter.next().value)
    }
    if (userId) {
      const uidKey = typeof userKey === 'function' ? userKey(user, platform) : user
      knownUserIds.set(uidKey, userId)
      if (knownUserIds.size > 2000) {
        const iter = knownUserIds.keys()
        for (let i = 0; i < 500; i++) knownUserIds.delete(iter.next().value)
      }
    }
  }

  // Live username-color sync — another client (heatsync.org, another ext
  // instance) just saved a new name color. background.js relays the server's
  // `profile:color` WS broadcast as `profile_color` (same translation
  // pattern as seen_update in seen-state.js). Updates knownColors so future
  // @mentions/replies pick it up for free, and recolors this user's
  // currently-visible rows in place — no refetch, no full re-render. Old
  // rows already scrolled past keep their prior color (matches Twitch/Kick).
  //
  // NOTE: this listener only fires once background.js forwards the event —
  // that one-line case in handleWSMessage() is NOT added by this change
  // (background.js is off-limits here). Needs, once, elsewhere:
  //   case 'profile:color':
  //     broadcastToTabs({ type: 'profile_color', userId: msg.userId, usernames: msg.usernames, color: msg.color })
  //     break
  function applyLiveProfileColor(usernames, color) {
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return
    const names = Array.isArray(usernames)
      ? usernames.filter((u) => typeof u === 'string' && u).map((u) => u.toLowerCase())
      : []
    if (!names.length) return

    for (const name of names) setKnownColor(name, color)

    const msgsEl = document.getElementById('hs-mc-messages')
    if (!msgsEl) return
    const nameSet = new Set(names)
    const spans = msgsEl.querySelectorAll('.hs-mc-user[data-username]')
    for (const el of spans) {
      if (!nameSet.has(el.dataset.username)) continue
      // A HeatSync paint owns the fill via its hsp-<hash> class — never override it.
      if ([...el.classList].some((c) => c.startsWith('hsp-'))) continue
      el.style.color = color
    }
  }
  if (!_onceGuardsMain.profileColorListener) {
    _onceGuardsMain.profileColorListener = true
    try {
      cleanup.addListener(chrome.runtime?.onMessage, (msg) => {
        if (msg?.type !== 'profile_color') return
        applyLiveProfileColor(msg.usernames, msg.color)
      })
    } catch {}
  }

  // A HeatSync paint was changed or cleared by its owner. background.js
  // forwards the server's `cosmetic:changed` push (ids only — the spec is
  // withheld from unentitled viewers by GET /api/paints, and re-fetching keeps
  // that gate intact) as `cosmetic_changed`. invalidateHsCosmetics drops what
  // this pane cached and re-queues only uids it has already resolved, so a
  // broadcast to every open chat does not turn into a fetch per open chat.
  if (!_onceGuardsMain.cosmeticChangedListener) {
    _onceGuardsMain.cosmeticChangedListener = true
    try {
      cleanup.addListener(chrome.runtime?.onMessage, (msg) => {
        if (msg?.type === 'cosmetics_stale_all') {
          // Socket was down long enough to have missed pushes — everything
          // cached here is suspect. Costs nothing until a name renders again.
          markAllHsCosmeticsStale()
          return
        }
        if (msg?.type !== 'cosmetic_changed') return
        invalidateHsCosmetics(msg.ids)
      })
    } catch {}
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
        for (const [name, meta] of entries || []) {
          if ((meta?.at || 0) >= cutoff) m.set(name, meta)
        }
        if (m.size) reg.set(ch, m)
      }
    } catch (_) {}
  }

  // Survives hard refresh because emotes.js loadSenderEmoteSets() runs at boot before render.
  const senderEmotePending = new Set()
  let senderEmoteTimer = null
  let senderEmoteTimerUrgent = false
  const SENDER_EMOTE_BATCH = 15
  // Per-sender fetch freshness (in-memory, NOT persisted). A sender's set was
  // previously fetched once and never re-validated, so any emote they ADDED
  // afterward never reached viewers who'd already cached them. Re-fetch when the
  // entry is older than this; the empty in-memory map after a reload means every
  // sender is re-validated once per session (picks up adds made since last visit).
  const senderEmoteFetchedAt = new Map() // senderKey -> ts
  // senderKey -> emote-ver from the last live push. Consumed (and cleared) by
  // the next flush containing that key: the ver rides the batch fetch as &v=
  // so the CF edge can't serve the pre-push cached set. Bounded implicitly —
  // entries are deleted at flush; a key that never flushes is re-set on the
  // next push for that sender.
  const senderEmoteBustVer = new Map()
  // Bounded the same way markSenderEmoteFetched bounds senderEmoteFetchedAt
  // below: "deleted at flush" only holds for keys we actually hold/refetch —
  // a sender key pushed while we don't hold their set (never added to
  // senderEmotePending, see emote_added_broadcast below) never flushes and
  // sat in this map forever, one entry per distinct sender seen all session.
  function setSenderEmoteBustVer(key, ver) {
    senderEmoteBustVer.delete(key)
    senderEmoteBustVer.set(key, ver)
    if (senderEmoteBustVer.size > SENDER_EMOTE_LRU_MAX) {
      senderEmoteBustVer.delete(senderEmoteBustVer.keys().next().value)
    }
  }
  // 2min: the MISSED-PUSH fallback floor. The primary path is the server's
  // global emote:added/removed push (senderKeys + ver) which invalidates and
  // refetches immediately; this TTL only bounds staleness when that push was
  // missed (socket down, reconnect gap). batch fetch is cheap.
  const SENDER_EMOTE_REFETCH_MS = 2 * 60 * 1000
  const SENDER_EMOTE_NEGATIVE_REFETCH_MS = 90 * 1000
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
  // Keys whose set got an authoritative replace this session. Distinct from
  // senderEmoteFetchedAt, which is also stamped on ERRORED keys for pacing —
  // this set answers "can the cached emotes be trusted", the map answers
  // "when may we fetch again". Cleared wholesale at a generous cap: the only
  // cost of forgetting is a slightly earlier retry after a failed fetch.
  const senderEmoteVerified = new Set()
  const SENDER_EMOTE_VERIFIED_MAX = 2000
  const SENDER_EMOTE_ERROR_RETRY_MS = 15 * 1000
  const senderEmoteFastRetried = new Set()
  // Freshness stamp for a FAILED fetch. A verified sender keeps the full TTL
  // (existing pacing, cache is trustworthy); an unverified one may be painting
  // stale persisted emotes — back-date so the retry lands in ~15s instead of
  // parking suspect images for the full TTL. ONE fast retry per key per
  // session, then normal TTL pacing: BG forwards these to the real upstream
  // API uncached on error (SENDER_FETCH_ERR is deliberately not cached), so
  // an unbounded 15s cadence across every viewer would hammer upstream for
  // the whole duration of an outage.
  function erroredFetchStamp(key, now) {
    if (senderEmoteVerified.has(key) || senderEmoteFastRetried.has(key)) return now
    if (senderEmoteFastRetried.size > SENDER_EMOTE_VERIFIED_MAX) senderEmoteFastRetried.clear()
    senderEmoteFastRetried.add(key)
    const known = typeof senderEmoteSets !== 'undefined' ? senderEmoteSets.get(key) : null
    const ttl = known && known.size > 0 ? SENDER_EMOTE_REFETCH_MS : SENDER_EMOTE_NEGATIVE_REFETCH_MS
    return now - Math.max(0, ttl - SENDER_EMOTE_ERROR_RETRY_MS)
  }

  function resolveSenderEmoteKey(m) {
    if (!m) return null
    if (m.platform === 'kick') {
      // ALWAYS the username slug: /api/users/emotes/batch resolves kick keys
      // by kick_username only — pusher/relay messages carry a numeric kick
      // userId, and `kick:<numeric>` never matches (sender emotes silently
      // missing).
      const slug = m.user?.toLowerCase()
      return slug ? `kick:${slug}` : null
    }
    if (m.platform === 'youtube') {
      // For YT, prefer resolved twitch_id (lets us reuse the twitch 7tv set).
      if (m.userId) return `twitch:${m.userId}`
      // Otherwise key off the sender's real UC… channel id (server resolves
      // youtube senders by channel id, not display name — a display-name key
      // never matches, which is why sender emotes never rendered for
      // youtube-only chatters). hsPaintUid carries it as `yt_<UCid>` (stamped
      // by social.js off the raw message); authorChannelId is a plain fallback
      // if it ever rides the message directly.
      const channelId =
        typeof m.hsPaintUid === 'string' && m.hsPaintUid.startsWith('yt_')
          ? m.hsPaintUid.slice(3)
          : m.authorChannelId || null
      if (channelId) return `ytc:${channelId}`
      // Last resort: display-name key when no channel id is known yet.
      const ytKey = (m.user || '').toLowerCase().replace(/^@/, '')
      return ytKey ? `yt:${ytKey}` : null
    }
    // Default: twitch
    return m.userId ? `twitch:${m.userId}` : null
  }

  function queueSenderEmoteFetch(senderKey, _m) {
    if (!senderKey) return
    if (senderEmotePending.has(senderKey)) return
    // Re-fetch when stale (or never validated this session) so emotes a sender
    // adds later propagate. The cached set is still used for rendering meanwhile;
    // mergeSenderEmotes layers any new names on top without dropping the old.
    // Misses re-validate on the short ttl: an empty set is the window where a
    // sender's brand-new emote renders as text if the live broadcast was missed.
    const fetchedAt = senderEmoteFetchedAt.get(senderKey)
    // senderEmoteSets values are Maps — Object.keys(Map) is always [], which
    // silently put EVERY sender on the 90s negative cadence instead of 5min
    // (pure over-fetch; sets still rendered fine).
    const known = typeof senderEmoteSets !== 'undefined' ? senderEmoteSets.get(senderKey) : null
    const refetchMs = known && known.size > 0 ? SENDER_EMOTE_REFETCH_MS : SENDER_EMOTE_NEGATIVE_REFETCH_MS
    if (fetchedAt && Date.now() - fetchedAt < refetchMs) return
    senderEmotePending.add(senderKey)
    if (senderEmotePending.size >= SENDER_EMOTE_BATCH) {
      if (senderEmoteTimer) {
        cleanup.clearTimeout(senderEmoteTimer)
        senderEmoteTimer = null
        senderEmoteTimerUrgent = false
      }
      flushSenderEmoteBatch()
      return
    }
    // A non-empty cached set never verified this session is the one case where
    // first paint may already be showing stale (since-removed) emotes — fetch
    // on a 50ms tick instead of 250ms so the correction lands before the eye
    // settles. Only ever SHORTENS an armed timer; batching is unaffected
    // because same-tick renders queue their keys before any timer fires.
    const urgent = !fetchedAt && !!(known && known.size > 0)
    if (senderEmoteTimer && urgent && !senderEmoteTimerUrgent) {
      cleanup.clearTimeout(senderEmoteTimer)
      senderEmoteTimer = null
    }
    if (!senderEmoteTimer) {
      senderEmoteTimerUrgent = urgent
      senderEmoteTimer = cleanup.setTimeout(
        () => {
          senderEmoteTimer = null
          senderEmoteTimerUrgent = false
          flushSenderEmoteBatch()
        },
        urgent ? 50 : 250,
      )
    }
  }

  // Identity-mismatch warning: the signed-in HS account can't be resolved from
  // the identity the user is chatting under, so their HS emotes render for
  // nobody else. Terse inline banner above the composer, once per senderKey per
  // session, dismissible for good per (account, key) via ui_settings-style
  // storage. Never fires when hsSenderKeys is unknown (old server/logged out).
  const _identityWarned = new Set()
  function warnIdentityMismatch(senderKey) {
    if (!senderKey || _identityWarned.has(senderKey)) return
    _identityWarned.add(senderKey)
    const dismissKey = `hs_idwarn_${hsCurrentUsername || ''}_${senderKey}`
    api.storage.local
      .get(dismissKey)
      .then((d) => {
        if (d?.[dismissKey]) return
        const bar = document.getElementById('hs-mc-inputbar')
        if (!bar || document.getElementById('hs-mc-idwarn')) return
        const el = document.createElement('div')
        el.id = 'hs-mc-idwarn'
        const acct = hsCurrentUsername || 'unknown'
        const ident = senderKey.replace(':', ' ')
        el.innerHTML = `<span>your emotes won't render for others here — heatsync acct <b>${escapeHtml(acct)}</b>, chatting as <b>${escapeHtml(ident)}</b> — <a href="https://heatsync.org/settings" target="_blank" rel="noopener">link accounts</a></span><button id="hs-mc-idwarn-x" title="dismiss">×</button>`
        bar.parentNode.insertBefore(el, bar)
        el.querySelector('#hs-mc-idwarn-x')?.addEventListener('click', () => {
          el.remove()
          api.storage.local.set({ [dismissKey]: true })
        })
      })
      .catch(() => {})
  }

  function flushSenderEmoteBatch() {
    if (!senderEmotePending.size) return
    const batch = [...senderEmotePending].slice(0, SENDER_EMOTE_BATCH)
    batch.forEach((k) => {
      senderEmotePending.delete(k)
    })
    // Any push-supplied ver for a key in this batch rides along as the edge
    // cache-bust; multiple keys' vers join into one opaque token.
    let bust = null
    for (const k of batch) {
      const v = senderEmoteBustVer.get(k)
      if (v != null) {
        bust = bust == null ? String(v) : `${bust}-${v}`
        senderEmoteBustVer.delete(k)
      }
    }
    safeSendMessage({ type: 'get_sender_emotes', senderKeys: batch, ...(bust ? { v: bust.slice(0, 32) } : {}) })
      .then((resp) => {
        const emotes = resp?.emotes || {}
        const errored = new Set(resp?.errored || [])
        const changedKeys = []
        let anyDropped = false
        // Stamp freshness for EVERY batch key (even empty ones) so we don't re-fetch
        // until the TTL elapses — without this, senders with no personal set re-queue
        // on every render and loop render→fetch→re-render on busy chats.
        const now = Date.now()
        for (const key of batch) {
          // BG-flagged errored key: the fetch blipped, the value is partial —
          // replacing would clobber a good cached set and re-render the
          // sender's emotes as raw text. Keep what we have; stamp keeps pacing
          // (back-dated for unverified keys so suspect images retry soon).
          if (errored.has(key)) {
            markSenderEmoteFetched(key, erroredFetchStamp(key, now))
            continue
          }
          // resp arrived — treat the value as authoritative and replace the cached
          // set entirely. Use replace (not merge) so names removed on the server
          // also disappear here; merge was the bleed: removed emotes lingered
          // forever and rendered for other viewers until the cache was nuked.
          const { changed, dropped } = replaceSenderEmotes(key, emotes[key] || {})
          if (senderEmoteVerified.size > SENDER_EMOTE_VERIFIED_MAX) senderEmoteVerified.clear()
          senderEmoteVerified.add(key)
          markSenderEmoteFetched(key, now)
          if (changed) changedKeys.push(key)
          if (dropped) anyDropped = true
        }
        if (changedKeys.length) upgradeMessagesForSenders(changedKeys, { immediate: anyDropped })
      })
      .catch(() => {
        // Network/IPC failure — seed empty sentinel + freshness so the next render
        // doesn't re-queue immediately (retries after the TTL; sooner when the
        // cached set was never verified this session).
        const now = Date.now()
        for (const key of batch) {
          const stamp = erroredFetchStamp(key, now)
          mergeSenderEmotes(key, {})
          markSenderEmoteFetched(key, stamp)
        }
      })
    if (senderEmotePending.size > 0) {
      senderEmoteTimerUrgent = false
      senderEmoteTimer = cleanup.setTimeout(() => {
        senderEmoteTimer = null
        flushSenderEmoteBatch()
      }, 500)
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
  // One in-place reprocess per animation frame, for corrections that can't
  // wait out the 600ms debounce (a WRONG emote is already painted: sender-set
  // downgrades, removal broadcasts). rAF-coalesced so boot bursts cost one
  // pass per frame; scroll-safe because reprocess only swaps innerHTML on
  // existing rows. The later debounced pass no-ops on these rows via the
  // _hsAppliedText skip.
  let _immediateReprocessQueued = false
  function queueImmediateReprocess() {
    if (_immediateReprocessQueued) return
    _immediateReprocessQueued = true
    cleanup.raf(() => {
      _immediateReprocessQueued = false
      if (typeof reprocessEmoteTextInPlace === 'function') {
        try {
          reprocessEmoteTextInPlace()
        } catch {}
      }
    })
  }
  // Identity switched on heatsync.org (login, logout, account switch). Every
  // render decision that depends on WHO YOU ARE just went stale in this tab:
  // honest-wysiwyg judges your own messages against hsSenderKeys, and
  // viewerPersonalEmotes still holds the PREVIOUS account's set. Nothing
  // invalidated either, so a tab left open across a switch kept painting your
  // own emotes as plain text until it was manually reloaded. Switching is rare
  // and the repaint is cheap, so invalidate everything rather than reason about
  // which rows care. The repaint waits on loadEmotes(), which also gives
  // social.js's storage listener time to install the new hsSenderKeys.
  function repaintForIdentityChange() {
    const patchBuf = (buf) => {
      if (!buf || typeof buf[Symbol.iterator] !== 'function') return
      for (const m of buf) {
        if (m) m._renderedHtml = null
      }
    }
    if (irc?.channels) {
      for (const ch of irc.channels.keys()) patchBuf(irc.getMessages(ch))
    }
    if (kickChat?.channels) {
      for (const ch of kickChat.channels.keys()) patchBuf(kickChat.getMessages(ch))
    }
    if (typeof channelYtMessages !== 'undefined') channelYtMessages.forEach(patchBuf)
    if (typeof mentionsBuffer !== 'undefined') patchBuf(mentionsBuffer)
    // Drawn rows outlive their buffer after an SPA nav — reach them through the
    // _hsMsg back-ref or they stay frozen forever (see upgradeMessagesForSenders).
    const _msgsElId = document.getElementById('hs-mc-messages')
    if (_msgsElId) {
      for (const div of _msgsElId.querySelectorAll('.hs-mc-msg')) {
        if (div._hsMsg) div._hsMsg._renderedHtml = null
      }
    }
    const _repaint = () => {
      try {
        renderMessages(currentTab)
      } catch (_) {}
    }
    Promise.resolve(typeof loadEmotes === 'function' ? loadEmotes() : null)
      .then(_repaint)
      .catch(_repaint)
  }

  function upgradeMessagesForSenders(senderKeys, opts) {
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
    if (irc?.channels) {
      for (const ch of irc.channels.keys()) patchBuf(irc.getMessages(ch))
    }
    if (kickChat?.channels) {
      for (const ch of kickChat.channels.keys()) patchBuf(kickChat.getMessages(ch))
    }
    if (typeof channelYtMessages !== 'undefined') channelYtMessages.forEach(patchBuf)
    if (typeof mentionsBuffer !== 'undefined') patchBuf(mentionsBuffer)
    // Also invalidate the LIVE DOM rows directly, via their `_hsMsg` back-ref.
    // A drawn row can outlive the buffer these patchBuf() walks reach: a twitch
    // SPA nav (channel → /directory) reinits chat state, orphaning already-drawn
    // rows — their backing message is gone from the current irc/kick/yt buffers,
    // so buffer-only invalidation never clears their cache and they stay frozen
    // at whatever they last rendered (raw text if the sender-set was cold then),
    // forever, even as fresh messages from the same sender render fine. Clearing
    // through the DOM back-ref is the only path that reaches those orphans.
    const _msgsElUp = document.getElementById('hs-mc-messages')
    if (_msgsElUp) {
      for (const div of _msgsElUp.querySelectorAll('.hs-mc-msg[data-msg-key]')) {
        if (matches(div._hsMsg)) div._hsMsg._renderedHtml = null
      }
    }

    // Downgrade correction (a dropped emote is already painted as an image)
    // runs next frame instead of waiting out the debounce below.
    if (opts?.immediate) queueImmediateReprocess()

    // Debounced re-render of active tab. Reset timer on every new batch so
    // the eventual render sees the FINAL invalidation set, not a partial mid-
    // boot snapshot. 600ms is long enough to coalesce a typical boot burst
    // (~300ms across multiple safeSendMessage round-trips) but short enough
    // that emote upgrades feel near-instant once chat settles.
    if (_upgradeRenderTimer) cleanup.clearTimeout(_upgradeRenderTimer)
    _upgradeRenderTimer = cleanup.setTimeout(() => {
      _upgradeRenderTimer = null
      _pendingUpgradeKeys.clear()
      // In-place reprocess ALWAYS runs — it swaps emote HTML on the live DOM
      // rows via `_hsMsg` (the invalidated ones recompute, unchanged ones skip)
      // without touching scroll, so it's safe while scrolled up AND it reaches
      // orphaned rows the buffer-driven renderMessages() below never rebuilds.
      if (typeof reprocessEmoteTextInPlace === 'function') {
        try {
          reprocessEmoteTextInPlace()
        } catch {}
      }
      // Full re-render picks up buffered-but-not-yet-drawn rows, but snaps the
      // viewport — skip it while the user is scrolled up reading history (those
      // rows upgrade lazily on the next scroll-to-bottom / tab switch).
      if (isScrolledUp) return
      if (typeof renderMessages === 'function' && typeof currentTab !== 'undefined') {
        try {
          renderMessages(currentTab)
        } catch {}
      }
    }, 600)
  }

  // Stream event user colors — login → color (populated from server on connect)
  const streamColorMap = new Map()

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
  function invalidateUiSettingsCache() {
    _uiSettingsCachePromise = null
  }

  // Overflow cache — large/per-tab settings live in chrome.storage.local
  // (unlimitedStorage permission) instead of sync (8 KB QUOTA_BYTES_PER_ITEM).
  // Keeps sync featherweight for cross-device prefs and avoids ever-bloating
  // the single ui_settings record with platformFilters[tabId] / keyword text.
  let _uiOverflowCachePromise = null
  function cachedUiOverflow() {
    if (!_uiOverflowCachePromise) {
      _uiOverflowCachePromise = chrome.storage.local.get([
        'platform_filters',
        'keyword_highlights',
        'chat_filter_rules',
      ])
    }
    return _uiOverflowCachePromise
  }
  function invalidateUiOverflowCache() {
    _uiOverflowCachePromise = null
  }

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
      await Promise.all(writes.map((p) => p.catch(() => {})))
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
          if (!k?.startsWith(prefix)) continue
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
          try {
            localStorage.removeItem(entries[i].k)
          } catch {}
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
    try {
      localStorage.setItem(`hs_layout_${key}`, JSON.stringify(value))
    } catch {}
  }

  // Cross-fade the document_start prepaint pseudo-element with the real
  // multichat container. Both transition over 200ms — prepaint opacity 1→0
  // while container opacity 0→1 — so there's no visible black gap or
  // tab-bar pop. Two rAFs before the fade guarantee the overlay has
  // actually painted before the swap starts (rAF 1 = post-style commit,
  // rAF 2 = post-paint).
  function tearDownPrepaint() {
    const html = document.documentElement
    const container = document.getElementById('hs-mc-container')
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Always (re)apply on every call — container can be recreated on
        // SPA navigation, and a fresh element won't carry the class.
        if (container) container.classList.add('hs-mc-shown')
        // Clear whatever prepaint is currently up, not just the first one:
        // early-layout re-arms on SPA navigation into a chat page (booting on
        // /directory and clicking a stream), so a later mount must be able to
        // fade its bar out too. Without this the re-armed bar sat until the
        // 4s self-destruct. No-ops when nothing is armed.
        if (!html.classList.contains('hs-prepaint-active')) return
        html.classList.add('hs-prepaint-fade')
        setTimeout(() => {
          html.classList.remove('hs-prepaint-active')
          html.classList.remove('hs-prepaint-fade')
          document.getElementById('hs-early-layout')?.remove()
        }, 220)
      })
    })
  }

  // THE ui_settings writer. Every sync-scope write goes through the SW's
  // serialized rmw chain — a content-script get→merge→set races that chain (and
  // every other tab's), and the loser's keys vanish with no error. Direct write
  // only as a last resort: when the SW is unreachable (context invalidated), a
  // raced write still beats a silently dropped setting.
  async function writeUiSettings(patch) {
    const resp = await safeSendMessage({ type: 'ui_settings_rmw', patch })
    if (resp?.ok) return true
    try {
      const s = await chrome.storage.sync.get(['ui_settings'])
      await chrome.storage.sync.set({ ui_settings: sanitizeUiSettings({ ...(s.ui_settings || {}), ...patch }) })
      return true
    } catch (_) {
      return false
    }
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

      // Split: blocklist keys go to chrome.storage.local (no quota cap).
      // Everything else goes to chrome.storage.sync. The ws fanout patch is
      // a third, overlapping view: syncPatch keys PLUS any blocklist key
      // that's a real cross-device preference (not DEVICE_LOCAL_KEYS) and
      // fits under LARGE_KEY_SYNC_MAX — keywordHighlights/chatFilterRules
      // ride the server channel this way even though they never touch
      // chrome.storage.sync directly (8KB ceiling).
      const localPatch = {}
      const syncPatch = {}
      const wsPatch = {}
      for (const k in pending) {
        const v = pending[k]
        if (UI_SYNC_BLOCKLIST.has(k)) {
          const mirrorKey = OVERFLOW_MIRROR_KEYS[k]
          if (mirrorKey) localPatch[mirrorKey] = v
          if (isLargeKeySyncEligible(k, v)) {
            // large free-text keys ride a SLOWER debounce (below) — the 100ms
            // flush is tuned for toggles; a keystroke-by-keystroke textarea
            // edit would otherwise fan a fresh up-to-32KB patch to every
            // device several times per edit session
            _pendingLargeWsPatch[k] = v
          } else if (!DEVICE_LOCAL_KEYS.has(k)) {
            warn(
              'settings sync: skipping',
              k,
              '—',
              estimateSettingSize(v),
              'bytes exceeds',
              LARGE_KEY_SYNC_MAX,
              'cap, staying device-local',
            )
          }
        } else {
          syncPatch[k] = v
          wsPatch[k] = v
        }
      }

      if (Object.keys(localPatch).length) {
        invalidateUiOverflowCache()
        chrome.storage.local.set(localPatch).catch(() => {})
      }

      if (Object.keys(syncPatch).length) {
        invalidateUiSettingsCache()
        ;(async () => {
          // Quota guard: chrome.storage.sync caps each key at 8192 bytes.
          // Check usage before writing — warn + toast if near the ceiling.
          try {
            const used = await chrome.storage.sync.getBytesInUse('ui_settings')
            if (used > 7000) {
              warn('ui_settings quota near limit:', used, '/ 8192 bytes')
              showToast(t('mc_main_quota_near_limit'), 'error')
            }
          } catch (_) {
            /* getBytesInUse unavailable (Firefox MV2) — skip check */
          }
          if (!(await writeUiSettings(syncPatch))) {
            warn('ui_settings write failed')
            showToast(t('mc_main_settings_save_failed'), 'error')
          }
        })()
      }

      if (Object.keys(wsPatch).length) {
        // Cross-surface insta-sync: server merges + fans out to every other
        // client of this user (other tabs, ext on Twitch/Kick/YT, heatsync.org).
        // chrome.storage.sync only syncs Chrome → Chrome with same Google
        // account; server-backed covers Firefox + heatsync.org + signed-out
        // Chrome profiles using the same heatsync login. Only DEVICE_LOCAL_KEYS
        // (platformFilters) are omitted — genuinely per-device, not a pref.
        safeSendMessage({
          type: 'ws_send',
          data: { type: 'ui-state:sync', patch: wsPatch },
        })
      }

      if (Object.keys(_pendingLargeWsPatch).length) {
        if (_largeWsPatchTimer) cleanup.clearTimeout(_largeWsPatchTimer)
        _largeWsPatchTimer = cleanup.setTimeout(() => {
          _largeWsPatchTimer = null
          const patch = _pendingLargeWsPatch
          _pendingLargeWsPatch = {}
          safeSendMessage({
            type: 'ws_send',
            data: { type: 'ui-state:sync', patch },
          })
        }, 1200)
      }
    }, 100)
  }

  // large-key ws fanout buffer — see saveUiSetting's slow-debounce comment
  let _pendingLargeWsPatch = {}
  let _largeWsPatchTimer = null

  // ─── settings registry engine ─────────────────────────────────────────
  // SETTINGS (src/lib/settings-schema.js) is the declarative catalog; this
  // engine is the single runtime around it: hydrate (loadAllSettings), read
  // (getSetting), write (setSetting → existing saveUiSetting/local storage
  // paths, preserving the debounce, sync/local split, quota guard, and ws
  // ui-state:sync fanout), reset (resetSettingsToDefaults). Legacy
  // module-level `let` vars stay the in-render source of truth via
  // _RUNTIME_BRIDGE until every reader moves to getSetting(); the bridge
  // keeps both views of a value identical during the migration.
  const _SETTINGS_BY_KEY = new Map(SETTINGS.map((d) => [d.key, d]))
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
    wysiwygEnabled: {
      get: () => wysiwygEnabled,
      set: (v) => {
        wysiwygEnabled = v
      },
    },
    linksEnabled: {
      get: () => linksEnabled,
      set: (v) => {
        linksEnabled = v
      },
    },
    partialLinksEnabled: {
      get: () => partialLinksEnabled,
      set: (v) => {
        partialLinksEnabled = v
      },
    },
    linkPreviewsEnabled: {
      get: () => linkPreviewsEnabled,
      set: (v) => {
        linkPreviewsEnabled = v
      },
    },
    mediaEmbedsEnabled: {
      get: () => mediaEmbedsEnabled,
      set: (v) => {
        mediaEmbedsEnabled = v
      },
    },
    viModeEnabled: {
      get: () => viModeEnabled,
      set: (v) => {
        viModeEnabled = v
      },
    },
    platformBadgesEnabled: {
      get: () => platformBadgesEnabled,
      set: (v) => {
        platformBadgesEnabled = v
      },
    },
    textBadgesEnabled: {
      get: () => textBadgesEnabled,
      set: (v) => {
        textBadgesEnabled = v
      },
    },
    pronounsEnabled: {
      get: () => pronounsEnabled,
      set: (v) => {
        pronounsEnabled = v
      },
    },
    zebraEnabled: {
      get: () => zebraEnabled,
      set: (v) => {
        zebraEnabled = v
      },
    },
    emoteProviderPriority: {
      get: () => emoteProviderPriority,
      set: (v) => {
        emoteProviderPriority = v
      },
    },
    whisperToastEnabled: {
      get: () => whisperToastEnabled,
      set: (v) => {
        whisperToastEnabled = v
      },
    },
    scrollWheelVolumeEnabled: {
      get: () => scrollWheelVolumeEnabled,
      set: (v) => {
        scrollWheelVolumeEnabled = v
      },
    },
    // setter also feeds the window flag content.js reads for timestamp paint
    timestampsEnabled: {
      get: () => timestampsEnabled,
      set: (v) => {
        timestampsEnabled = v
        window._hsTimestampsEnabled = v
      },
    },
    avatarsEnabled: {
      get: () => avatarsEnabled,
      set: (v) => {
        avatarsEnabled = v
      },
    },
    autoClaimPoints: {
      get: () => autoClaimPoints,
      set: (v) => {
        autoClaimPoints = v
      },
    },
    dimTimeouts: {
      get: () => dimTimeouts,
      set: (v) => {
        dimTimeouts = v
      },
    },
    modConfirmBan: {
      get: () => modConfirmBan,
      set: (v) => {
        modConfirmBan = v
      },
    },
    modBanReasons: {
      get: () => modBanReasons,
      set: (v) => {
        modBanReasons = v
      },
    },
    readableNamesEnabled: {
      get: () => readableNamesEnabled,
      set: (v) => {
        readableNamesEnabled = v
      },
    },
    autoHideInput: {
      get: () => autoHideInput,
      set: (v) => {
        autoHideInput = v
      },
    },
    firstChatterGlow: {
      get: () => firstChatterGlow,
      set: (v) => {
        firstChatterGlow = v
      },
    },
    keywordHighlights: {
      get: () => keywordHighlights,
      set: (v) => {
        keywordHighlights = v
      },
    },
    emoteSize: {
      get: () => emoteSize,
      set: (v) => {
        emoteSize = v
      },
    },
    emojiSize: {
      get: () => emojiSize,
      set: (v) => {
        emojiSize = v
      },
    },
    domRenderCap: {
      get: () => DOM_RENDER_CAP,
      set: (v) => {
        DOM_RENDER_CAP = v
      },
    },
    emoteAnimationMode: {
      get: () => emoteAnimationMode,
      set: (v) => {
        emoteAnimationMode = v
      },
    },
    tabPosition: {
      get: () => tabPosition,
      set: (v) => {
        tabPosition = v
      },
    },
    chatPosition: {
      get: () => chatPosition,
      set: (v) => {
        chatPosition = v
      },
    },
    modToolbarButtons: {
      get: () => [...modToolbarButtons],
      set: (v) => {
        modToolbarButtons = v.filter((id) => MOD_BUTTON_CATALOG[id])
      },
    },
    hiddenTabs: {
      get: () => [...hiddenTabs],
      set: (v) => {
        hiddenTabs = new Set(v)
      },
    },
    // boolmap runtime objects — coercion already filtered to known subkeys
    inlineNotifs: {
      get: () => ({ ...inlineNotifs }),
      set: (v) => {
        for (const k in v) inlineNotifs[k] = !!v[k]
      },
    },
    hermesToggles: {
      get: () => ({ ...hermesToggles }),
      set: (v) => {
        for (const k in v) hermesToggles[k] = !!v[k]
      },
    },
    nativeVisible: {
      // native-chat escape hatch removed — force OFF so a stored `true` can't
      // reactivate the (removed) native mode.
      get: () => false,
      set: () => {
        nativeVisible = false
      },
    },
  }
  // apply id → side-effect runner. Each mirrors the legacy toggle/save
  // function's effects exactly. onLoad=true on the single init pass —
  // skips work that only makes sense on an interactive change.
  const _APPLIERS = {
    rebuildInput: () => {
      rebuildInput()
    },
    // Repaint every tab and start/stop the heat ticker to match the new mode.
    tabCounter: () => {
      refreshTabCounters()
    },
    namePaints: (v) => {
      // Toggle off: drop the injected <style id="hs-mc-paints"> sheet (rather
      // than leaving stale/orphaned rules behind — hygiene, no correctness
      // impact since bumpRenderEpoch's rebuild below already stops adding the
      // hsp-* class to any element). Cache entries are kept; a later toggle-on
      // recompiles fresh from the same spec.
      if (!v) clearHsPaintSheet()
      // toggle ON: cached specs kept their hsp-<hash> class on rows but the
      // sheet was dropped — re-inject so painted names aren't left unstyled.
      else if (typeof reinjectHsPaintSheet === 'function') reinjectHsPaintSheet()
    },
    viMode: (v) => {
      // mirror to localStorage + notify MAIN-world vi-mode.js
      try {
        const ls = JSON.parse(localStorage.getItem('heatsync-extension-settings') || '{}')
        ls.viMode = v
        localStorage.setItem('heatsync-extension-settings', JSON.stringify(ls))
      } catch (_) {}
      window.postMessage(
        { type: 'heatsync-settings-changed', nonce: window.HS?.getMainWorldNonce?.() || null, settings: { viMode: v } },
        location.origin,
      )
    },
    autoHide: (v) => {
      const bar = document.getElementById('hs-mc-inputbar')
      // Honor the pop-out override — never actually hide there even if the
      // setting is switched on (canAutoHideInput would keep it off anyway).
      // Switching auto-hide OFF still can't conjure a composer on a tab that
      // has nowhere to send.
      if ((v && !isYtPopout) || !tabAcceptsInput(currentTab)) {
        if (bar) bar.classList.add('hs-hidden')
        inputBarVisible = false
      } else {
        if (bar) bar.classList.remove('hs-hidden')
        inputBarVisible = true
      }
      // The composer just changed height — the open picker mirrors the message
      // list's box, so re-measure rather than leaving it short or overhanging.
      syncPickerBox()
    },
    autoClaim: (v) => {
      if (v) startAutoClaimPoller()
      else stopAutoClaimPoller()
    },
    ytSuggestions: (v) => {
      // YT-only body class; CSS un-collapses #secondary into a vertical strip
      // beside the title column (left/right dock). Harmless off-YT (no match).
      try {
        document.body.classList.toggle('hs-yt-suggestions', !!v)
      } catch (_) {}
      try {
        applyPlatformPositionOverrides()
      } catch (_) {}
    },
    ytNonLiveChat: (v) => {
      // YT-only, default ON: show the panel on every YT page (home/VOD/search),
      // not just livestreams. Opting out hides it everywhere except livestreams.
      // Harmless off-YT (no match).
      try {
        document.body.classList.toggle('hs-yt-nonlive-chat', !!v)
      } catch (_) {}
      // Mirror for early-layout.js: it stamps the boot body state (panel vs
      // hs-offline) at document_start, before chrome.storage is readable —
      // without this YT measures its grid during the wrong-state window and
      // strands a squeezed layout. Runs on load + change (applyOnLoad).
      try {
        localStorage.setItem('hs_layout_ytNonLiveChat', v ? '1' : '0')
      } catch (_) {}
    },
    keywordRegex: () => {
      rebuildKeywordRegex()
    },
    filterRules: () => {
      let rules = []
      try {
        rules = JSON.parse(getSetting('chatFilterRules') || '[]')
      } catch {}
      compileFilterRules(Array.isArray(rules) ? rules : [])
    },
    // Live re-merge: loadEmotes() rebuilds channelEmoteCaches + emoteCache
    // from storage, replaying the same 7tv/bttv/ffz collision resolver with
    // the new priority — no reload needed. History rows keep their prior
    // rendering ("history is sacred"); only new messages/picker/tab-complete
    // pick up the new winner.
    emoteProviderPriority: () => {
      loadEmotes()
      markPickerDirty()
    },
    nativeVisible: () => {
      // native-chat escape hatch removed — always keep native hidden + the
      // body class off, regardless of any stored value.
      document.body.classList.remove('hs-native-visible')
      try {
        setNativeChatHidden(true)
      } catch (_) {}
    },
    fonts: () => {
      applyFontSettings(getSetting('fontFamily'), getSetting('fontSize'), getSetting('customFontName'))
    },
    emoteSize: (_v, _def, onLoad) => {
      applyEmoteSize()
      if (onLoad) return
      // URLs encode size — picker DOM is now stale
      markPickerDirty()
      prebuildPickerIdle()
    },
    emojiSize: () => {
      applyEmojiSize()
    },
    hiddenTabs: () => {
      applyHiddenTabs()
    },
    // density — pure CSS vars, no re-render needed
    density: () => {
      const pad = getSetting('messageDensity') === 'cozy' ? '5px 8px' : '2px 4px'
      const root = document.documentElement
      root.style.setProperty('--hs-mc-row-pad', pad)
      root.style.setProperty('--hs-mc-row-lh', `${getSetting('lineHeight')}px`)
    },
    // render cap — debounced re-render (range fires per step)
    renderCap: (() => {
      let t = null
      return () => {
        if (t) cleanup.clearTimeout(t)
        t = cleanup.setTimeout(() => {
          t = null
          if (currentTab !== 'settings') renderMessages(currentTab)
        }, 300)
      }
    })(),
    muteKeywords: () => {
      rebuildMuteKeywordsRegex()
    },
    // rendered html is cached per message — a src change needs a cache
    // flush before the re-render or old animated imgs survive the toggle
    emoteAnimation: (v, _def, onLoad) => {
      // Drives the hs-fx-* animation gate in 10-emotes.css (never → off,
      // hover → row-hover only). Set on load too, before the early return.
      document.documentElement.dataset.hsEmoteAnim = v || 'always'
      if (onLoad) return
      clearRenderedHtmlCache()
      renderMessages(currentTab)
    },
    paintAnimation: (v, _def, onLoad) => {
      // Drives the paint kill-switch in paints.js / youtube-content.js. Set on
      // load too, before the early return — see applyOnLoad in the schema.
      // No re-render: the paints sheet is CSS-only, so the attribute flip is
      // the whole effect and every painted name on screen follows it live.
      document.documentElement.dataset.hsPaintAnim = v || 'always'
      if (onLoad) return
    },
    locale: (v) => {
      setI18nLocale(v).catch(() => {})
    },
    modToolbar: () => {
      if (typeof _modToolbar !== 'undefined' && _modToolbar) rebuildModToolbarButtons()
    },
    tabPosition: () => {
      applyTabsPosition()
    },
    chatPosition: (v, _def, _onLoad, isRemote) => {
      if (chatHiddenLocal && v && v !== 'hidden') {
        if (isRemote) {
          // Another tab moved chat while THIS tab is \-hidden (tab-local).
          // Adopt the new position as the restore point but stay hidden here.
          chatPositionPrevious = v
          chatPosition = 'hidden'
          applyChatPosition()
          return
        }
        // Explicit position pick in THIS tab (settings dropdown / C rotate)
        // overrides the tab-local hide.
        chatHiddenLocal = false
        _saveChatHiddenLocal()
      }
      applyChatPosition()
      // visible positions become the hide-toggle restore point (mirrors
      // toggleChatHidden's previous-tracking). remote changes update the
      // local var but skip the write-back — the originating tab persisted it
      if (v && v !== 'hidden' && v !== chatPositionPrevious) {
        chatPositionPrevious = v
        if (!isRemote) saveUiSetting('chatPositionPrevious', v)
      }
    },
    automod: () => {
      compileAutomod({ automodAllCaps: getSetting('automodAllCaps'), automodRegex: getSetting('automodRegex') })
    },
    notifPermission: (v) => {
      if (!v) return
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {})
      }
    },
    mentionPing: (v) => {
      if (!(v > 0)) return
      if (typeof playMentionPing === 'function') {
        try {
          playMentionPing(v)
        } catch (_) {}
      }
    },
    // content-warning toggles PATCH the server; the local write is already
    // optimistic (setSetting persisted it) — roll back on failure. BG picks
    // up the storage change via onChanged and re-appends include_* params;
    // refresh_all flushes inline emote caches on success.
    // Subsystem pills — live gates apply immediately (their code paths
    // check isEnabled at use time); reload-tagged flips get a toast. Tab
    // affordances of gated subsystems hide/show right away.
    subsystemToggle: () => {
      applyHiddenTabs()
      // persistent [reload] chips (rendered per-row from _gatesAtBoot)
      // replace the old one-shot toast
      if (currentTab === 'settings') renderSettingsTab()
    },
    cwServerPatch: (v, def) => {
      _cwPatch(def, v, false)
      _cwRepaintOwnFlagged()
    },
  }

  // Own flagged emotes flip visibility instantly on a cw toggle: their rows
  // render from viewerPersonalEmotes (cwCats annotation) checked against the
  // toggles at render time — invalidate + repaint is all it takes. Cross-user
  // stubs heal separately via the sender-set refetch after refresh_all.
  function _cwRepaintOwnFlagged() {
    const ownFlagged = []
    if (typeof viewerPersonalEmotes !== 'undefined') {
      for (const [name, e] of viewerPersonalEmotes) {
        if (Array.isArray(e?.cwCats) && e.cwCats.length) ownFlagged.push(name)
      }
    }
    if (!ownFlagged.length || typeof invalidateRenderedForEmotes !== 'function') return
    invalidateRenderedForEmotes(ownFlagged)
    if (!isScrolledUp && typeof renderMessages === 'function' && typeof currentTab !== 'undefined') {
      try {
        renderMessages(currentTab)
      } catch {}
    }
  }

  // Server PATCH for a content-warning toggle. Enabling an adult category
  // (sexual/nsfw) 403s with AGE_REQUIRED until the account has a server-side
  // 18+ affirmation — mirror the site flow: confirm dialog → POST
  // /api/user/age-verify → retry the PATCH once. Decline rolls the pill back
  // without the misleading "try again" toast.
  async function _cwPatch(def, v, retried) {
    let resp
    try {
      resp = await safeSendMessage({
        type: 'api_fetch',
        path: '/api/user/settings',
        method: 'PATCH',
        auth: true,
        body: { [def.cw.serverBody]: v },
      })
    } catch (_) {
      resp = null
    }
    if (resp?.ok) {
      safeSendMessage({ type: 'refresh_all' }).catch(() => {})
      return
    }
    if (!retried && v === true && resp?.code === 'AGE_REQUIRED') {
      const { ok } = await hsConfirm(t('mc_main_age_confirm'), t('mc_main_age_confirm_ok'))
      if (!ok) {
        _cwRollback(def, v, true)
        return
      }
      const av = await safeSendMessage({
        type: 'api_fetch',
        path: '/api/user/age-verify',
        method: 'POST',
        auth: true,
      }).catch(() => null)
      if (av?.ok) {
        _cwPatch(def, v, true)
        return
      }
    }
    _cwRollback(def, v, false)
  }

  function _cwRollback(def, attempted, declined) {
    setSetting(def.key, !attempted, { silent: true })
    document.querySelectorAll(`.hs-mc-toggle-pill[data-set-key="${def.key}"]`).forEach((pill) => {
      pill.classList.toggle('active', !attempted)
    })
    // silent setSetting skips apply handlers — repaint own flagged rows here
    // or a failed PATCH leaves them rendered under the reverted toggle.
    _cwRepaintOwnFlagged()
    if (!declined) showToast(t('mc_main_cw_save_failed', [def.cw.noun]), 'error')
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
    if (!def) {
      warn('getSetting: unknown key', key)
      return undefined
    }
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
    if (!def) {
      warn('setSetting: unknown key', key)
      return false
    }
    const v = coerceSettingValue(def, value)
    if (v === undefined || !validateSettingValue(def, v)) {
      warn('setSetting: invalid value for', key, value)
      return false
    }
    _settingsCache[key] = v
    const bridge = _bridgeFor(def)
    if (bridge) bridge.set(v)
    if (def.scope === 'local') {
      // Failure must be LOUD: the in-memory cache + UI already flipped, so a
      // silently-dropped write means the setting reverts on next load with
      // zero warning (NSFW filters + mute keywords live on this path).
      chrome.storage.local.set({ [key]: v }).catch(() => {
        try {
          showToast(t('mc_main_settings_save_failed'), 'error')
        } catch {}
        warn('setSetting: local write failed for', key)
      })
    } else {
      // sync + local-mirror both route through saveUiSetting — it owns the
      // debounce, UI_SYNC_BLOCKLIST split, quota guard, and ws sync patch
      saveUiSetting(key, v)
    }
    if (!opts?.silent) {
      const applier = def.apply && _APPLIERS[def.apply]
      if (applier) {
        try {
          applier(v, def, false)
        } catch (e) {
          warn('applier failed:', def.apply, e)
        }
      }
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
  const _DEPENDS_PARENTS = new Set(SETTINGS.filter((d) => d.dependsOn).map((d) => d.dependsOn.key))

  // ─── subsystem gates ────────────────────────────────────────────────────
  // isEnabled(id): live read — server health kill-list wins, then the
  // user's ui_settings.subsystems map (default ON). Live-tagged code paths
  // (mentions, stream-stats) call this at use time.
  // gateAtBoot(id): the init()-time snapshot — every init guard reads this
  // so a mid-init storage write can't half-apply a subsystem.
  let _gatesAtBoot = null
  function isEnabled(id) {
    try {
      if (window.__hsHealth?.disabled?.includes(id)) return false
    } catch (_) {}
    return getSetting('subsystems')[id] !== false
  }
  // Taken BEFORE the first consumer, which is loadConfig() — it subscribes a
  // youtube stream for every saved channel, and an unsnapshotted gateAtBoot
  // silently answered "enabled", so `chat-youtube: false` still opened them.
  // A gate that defaults to ON when asked too early is not a gate.
  //
  // Reads the already-in-flight ui_settings prime directly rather than
  // getSetting(): the settings registry is not hydrated this early and would
  // hand back the all-true schema default — the same silent yes by another
  // route. Merged OVER that default so an unknown/absent key still resolves.
  async function snapshotGates() {
    let stored = null
    try {
      stored = (await cachedUiSettings())?.ui_settings?.subsystems || null
    } catch (_) {}
    _gatesAtBoot = Object.assign({}, _SETTINGS_BY_KEY.get('subsystems')?.default, stored)
  }
  function gateAtBoot(id) {
    try {
      if (window.__hsHealth?.disabled?.includes(id)) return false
    } catch (_) {}
    // Snapshot missing means someone moved a consumer above snapshotGates().
    // Defer to the live read rather than inventing a yes.
    if (_gatesAtBoot == null) return isEnabled(id)
    return _gatesAtBoot[id] !== false
  }

  // One hydration pass over the whole registry — replaces the per-setting
  // loadXSetting() functions. Reads the shared init caches, fills
  // cache + bridge, runs one-shot migrations, then runs each distinct
  // applier once (onLoad=true).
  async function loadAllSettings() {
    const localKeys = SETTINGS.filter((d) => d.scope === 'local').map((d) => d.key)
    const [synced, local, overflow] = await Promise.all([
      cachedUiSettings().catch(() => ({})),
      localKeys.length ? chrome.storage.local.get(localKeys).catch(() => ({})) : {},
      cachedUiOverflow().catch(() => ({})),
    ])
    const ui = synced?.ui_settings || {}
    // custom presets ride along in ui_settings (declared in the registry as
    // system/state json; the shape filter below owns the semantics)
    _customPresets = Array.isArray(ui.customPresets)
      ? ui.customPresets.filter(
          (p) => p && typeof p === 'object' && p.id && p.name && p.diff && typeof p.diff === 'object',
        )
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
          chrome.storage.local.set({ [def.mirrorKey]: coerceSettingValue(def, raw) }).catch(() => {})
        }
      }
      // retired-key migration (e.g. bigEmoji false → emoji size 1x)
      let legacyAdopted = false
      if (raw === undefined && def.legacy) {
        try {
          raw = def.legacy(ui, local)
        } catch (_) {}
        legacyAdopted = raw !== undefined
      }
      // first run for self-announcing local keys: persist the default so
      // other surfaces (options page) render the real state
      if (raw === undefined && def.firstRunPersist) firstRunLocal[def.key] = def.default

      const v = raw === undefined ? def.default : coerceSettingValue(def, raw)
      const value = v !== undefined && validateSettingValue(def, v) ? v : def.default
      // Persist the adopted legacy value — without this only this surface sees
      // the migration (in-memory), while every other reader of the real key
      // still gets the default (bigEmoji false → overlay 1x but native 2x).
      // One-shot: the write makes raw defined next boot, so legacy never re-fires.
      if (legacyAdopted) {
        if (def.scope === 'local') chrome.storage.local.set({ [def.key]: value }).catch(() => {})
        else saveUiSetting(def.key, value)
      }
      _settingsCache[def.key] = value
      const bridge = _bridgeFor(def)
      if (bridge) bridge.set(value)
      if (def.apply && def.applyOnLoad) appliersToRun.set(def.apply, def)
    }

    if (Object.keys(firstRunLocal).length) {
      chrome.storage.local.set(firstRunLocal).catch(() => {})
    }
    // one-shot: the retired F-/F+ buttons stored a per-device size override in
    // localStorage that quietly beat the fontSize setting. Fold the user's last
    // size into fontSize (the slider now owns it), then drop the legacy key so
    // this runs only once. Done before appliers so the fonts applier paints it.
    try {
      const ov = parseInt(localStorage.getItem('heatsync-chat-font-size'), 10)
      if (ov >= 10 && ov <= 22) {
        if (ov !== _settingsCache.fontSize) {
          _settingsCache.fontSize = ov
          saveUiSetting('fontSize', ov)
        }
        localStorage.removeItem('heatsync-chat-font-size')
      }
    } catch (_) {}
    // boot snapshot for reload-applied entries — drives the [reload] chip
    for (const def of SETTINGS) {
      if (def.reloadApply) _bootVals[def.key] = getSetting(def.key)
    }
    for (const [id, def] of appliersToRun) {
      const applier = _APPLIERS[id]
      if (applier) {
        try {
          applier(getSetting(def.key), def, true)
        } catch (e) {
          warn('load applier failed:', id, e)
        }
      }
    }
  }

  // Registry-derived reset — every entry returns to its default through the
  // normal setSetting path (storage write + bridge + applier). noReset
  // entries (server-coupled content-warning prefs) are left untouched.
  // Sync writes coalesce into one debounced ui_settings patch.
  // Optional `cat` scopes the reset to one settings page (per-page default
  // button); no arg = everything (system page's all-settings button).
  function resetSettingsToDefaults(cat) {
    for (const def of SETTINGS) {
      if (def.noReset) continue
      if (cat && def.category !== cat) continue
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
        _syncRowModEdge(
          el,
          def,
          def.options.find((o) => String(o.value) === ds.setSub),
        )
      }
      return true
    }
    // multiselect member pill — toggle membership (invertDisplay = stored
    // set is "hidden" but pills show "visible")
    if (def.type === 'multiselect' && ds.setValue !== undefined) {
      const cur = getSetting(def.key)
      const val = ds.setValue
      const next = cur.includes(val) ? cur.filter((x) => x !== val) : cur.concat(val)
      if (setSetting(def.key, next)) {
        const member = next.includes(val)
        el.classList.toggle('active', def.invertDisplay ? !member : member)
        _syncRowModEdge(
          el,
          def,
          def.options.find((o) => String(o.value) === val),
        )
      }
      return true
    }
    // segmented enum button — value carried on the button
    if (def.type === 'enum' && ds.setValue !== undefined) {
      if (setSetting(def.key, ds.setValue)) {
        const row = el.closest('.hs-mc-setting-row')
        if (row) {
          const cur2 = String(getSetting(def.key))
          row.querySelectorAll('[data-set-value]').forEach((b) => {
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
  const STREAM_EVENTS_KEY = 'hs_stream_events'
  const STREAM_EVENTS_MAX = 200
  let streamEventsLoaded = false

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
          const isDupe = existing.some((m) => m.type === 'stream-event' && m.text === evt.text)
          if (!isDupe) {
            // insertOrdered, not push: unlike the realtime stream-event
            // dispatchers (which always stamp time: Date.now()), evt.time
            // here is the event's REAL historical time (persisted storage /
            // reload replay) — it can legitimately be older than whatever
            // live messages already reached this buffer before boot restore
            // finished, so a blind push would break buffer sortedness.
            buffer.insertOrdered(evt)
            added++
          }
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
            const isDupe = existing.some((m) => m.type === 'stream-event' && m.text === evt.text)
            if (!isDupe) {
              liveBuffer.insertOrdered(evt)
              added++
            }
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
        if (!events.some((e) => e.text === evt.text)) {
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
        const existingTexts = new Set(events.map((e) => e.text))
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
    // Bare UC channel id → /channel/<id>/live (mirrors identityYtLiveUrl)
    if (/^UC[\w-]{20,}$/.test(raw)) return `https://www.youtube.com/channel/${raw}/live`
    // Bare username (no slashes; handles allow . _ -) → /@name/live
    if (/^@?[\w.-]{3,30}$/.test(raw)) {
      const name = raw.startsWith('@') ? raw.slice(1) : raw
      return `https://www.youtube.com/@${name}/live`
    }
    try {
      const u = new URL(raw)
      const v = u.searchParams.get('v')
      if (v) return `https://www.youtube.com/watch?v=${v}`
      const liveMatch = raw.match(/\/live\/([^?&/]+)/)
      if (liveMatch) return `https://www.youtube.com/live/${liveMatch[1]}`
      const shortMatch = raw.match(/youtu\.be\/([^?&]+)/)
      if (shortMatch) return `https://www.youtube.com/watch?v=${shortMatch[1]}`
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
      '.chat-room',
    ]

    for (const sel of selectors) {
      const el = document.querySelector(sel)
      if (!el) continue

      // Look for component with render method and chat-related props
      const result = findComponent(
        el,
        (inst, fiber) => {
          // Check if this is a class component with render
          if (typeof inst?.render !== 'function') return false

          // Check fiber type name for chat-related components
          const typeName = fiber?.type?.displayName || fiber?.type?.name || ''
          if (typeName.toLowerCase().includes('chat')) return true

          // Check for chat-related props (direct key probe — JSON.stringify per
          // fiber level was burning ~30× on every retry)
          const props = inst.props
          if (props) {
            for (const k in props) {
              if (k === 'channel' || k === 'room' || k.startsWith('channel') || k.startsWith('room')) return true
            }
          }

          return false
        },
        30,
      )

      if (result) return result
    }

    return null
  }

  // ============================================
  // UI CREATION (React-compatible elements)
  // ============================================

  /** Mark a tab active. Keeps aria-selected in lockstep with the `active`
   * class — three separate call sites used to toggle the class by hand, and a
   * screen reader reads aria-selected, not a css class. Only real tabs carry
   * role="tab"; the utility buttons share the class and must not claim it. */
  function setTabActive(el, on) {
    if (!el) return
    el.classList.toggle('active', on)
    if (el.getAttribute('role') === 'tab') el.setAttribute('aria-selected', String(on))
  }

  function createTabBar() {
    const container = document.createElement('div')
    container.id = 'hs-mc-tabbar'
    container.dir = HS_DIR()
    // Static hardcoded tab buttons — no user input, safe innerHTML
    // Two sections: scrollable channel tabs + fixed utility buttons (always visible)
    // Static hardcoded buttons — all in one wrapping flow, no user input
    container.innerHTML = `
      <div class="hs-mc-tabs-scroll" role="tablist" aria-label="chat tabs">
        <button class="hs-mc-tab" role="tab" aria-selected="false" data-tab="feed">${t('mc_tab_feed')}</button>
        <button class="hs-mc-tab" role="tab" aria-selected="false" data-tab="whispers">${t('mc_tab_whispers')}</button>
        <button class="hs-mc-tab" role="tab" aria-selected="false" data-tab="mentions">${t('mc_tab_mentions')}</button>
        <button class="hs-mc-tab" role="tab" aria-selected="false" data-tab="pinned">${t('mc_tab_pinned')}</button>
        <button class="hs-mc-tab" role="tab" aria-selected="false" data-tab="modlog">${t('mc_tab_modlog')}</button>
        <button class="hs-mc-tab active" role="tab" aria-selected="true" data-tab="live">${t('mc_tab_live')}</button>
        <button class="hs-mc-tab" data-tab="add">+</button>
      </div>
      <div class="hs-mc-right-cluster">
        <div class="hs-mc-util-row">
          <button class="hs-mc-tab hs-mc-util-btn" data-tab="settings" title="${t('mc_btn_settings')}">\u2699</button>
          <button class="hs-mc-tab hs-mc-util-btn hs-mc-collapse-btn" id="hs-mc-collapse-btn" data-tab="collapse" title="hide chat (\\)" aria-label="hide chat"></button>
          <button class="hs-mc-tab hs-mc-util-btn hs-mc-popout-btn" data-tab="popout" title="pop out chat to standalone window" style="display:none">\u26f6</button>
          <button class="hs-mc-tab hs-mc-util-btn hs-mc-sub-btn" data-tab="subscribe" title="subscribe \u2014 support this channel" style="display:none">$</button>
        </div>
        <div id="hs-mc-platfilter"></div>
      </div>
    `

    // native-chat escape hatch removed (too fragile across chat positions/boot).

    // Event delegation for tab clicks
    container.addEventListener('click', (e) => {
      const tab = e.target.closest('.hs-mc-tab')
      if (!tab) return

      const tabId = tab.dataset.tab
      log('Tab clicked:', tabId)
      // Acknowledge unread indicators on click — guarantees clearing even on
      // paths that don't run switchTab (live picker), and survives any new
      // mention that lands in the same frame between click and render.
      tab.classList.remove('has-mentions', 'has-new', 'has-stream-event')
      markTabRead(tabId)
      if (tabId === 'mentions') bumpSeen('mentions')
      else if (tabId === 'whispers') bumpSeen('whispers')
      else if (tabId === 'feed') bumpSeen('live')
      if (tabId === 'add') {
        switchTab('add')
      } else if (tabId === 'popout') {
        openPopoutForCurrentTab()
      } else if (tabId === 'subscribe') {
        openSubForCurrentTab(tab)
      } else if (tabId === 'live') {
        showLiveChannelPicker(tab)
      } else if (tabId === 'collapse') {
        toggleChatHidden()
      } else if (tabId === 'native') {
        setSetting('nativeVisible', !getSetting('nativeVisible'))
      } else if (tabId === 'settings' && currentTab === 'settings') {
        switchTab(prevTab || 'feed')
      } else {
        switchTab(tabId)
      }
    })

    // Right-click tabs → mark as read + channel context menu
    container.addEventListener('contextmenu', (e) => {
      const tab = e.target.closest('.hs-mc-tab')
      if (!tab) return
      const tabId = tab.dataset.tab
      // Right-click any tab clears all unread indicators (mentions, new, stream-event, whispers)
      if (
        tab.classList.contains('has-mentions') ||
        tab.classList.contains('has-new') ||
        tab.classList.contains('has-stream-event') ||
        tab.classList.contains('has-whispers')
      ) {
        e.preventDefault()
        tab.classList.remove('has-mentions', 'has-new', 'has-stream-event', 'has-whispers')
        markTabRead(tabId)
        // Sync server-backed seen state so the dot doesn't reappear and
        // every other client clears via WS broadcast.
        if (tabId === 'mentions') bumpSeen('mentions')
        else if (tabId === 'whispers') bumpSeen('whispers')
        else if (tabId === 'feed') bumpSeen('live')
        return
      }

      // Live tab gets platform edit context menu
      if (tabId === 'live') {
        e.preventDefault()
        document.getElementById('hs-mc-ctx-menu')?.remove()
        const menu = document.createElement('div')
        menu.id = 'hs-mc-ctx-menu'
        menu.style.cssText =
          'position:fixed;z-index:99999;background:#000;border:1px solid #808080;border-radius:0;padding:4px 0;min-width:150px;font-size:13px;font-family:inherit;'
        const item = document.createElement('div')
        item.textContent = 'edit platforms'
        item.style.cssText = 'padding:6px 12px;cursor:pointer;color:#fff;'
        item.addEventListener('mouseenter', () => (item.style.background = 'rgba(255,255,255,0.06)'), {
          signal: mcSignal,
        })
        item.addEventListener('mouseleave', () => (item.style.background = ''), { signal: mcSignal })
        item.addEventListener('click', () => {
          menu.remove()
          showEditLivePlatforms()
        })
        menu.appendChild(item)
        document.body.appendChild(menu)
        const mw = menu.offsetWidth,
          mh = menu.offsetHeight
        menu.style.left = `${Math.min(e.clientX, window.innerWidth - mw - 4)}px`
        menu.style.top = `${Math.min(e.clientY, window.innerHeight - mh - 4)}px`
        const dismiss = (ev) => {
          if (!menu.contains(ev.target)) {
            menu.remove()
            document.removeEventListener('click', dismiss)
          }
        }
        cleanup.setTimeout(() => document.addEventListener('click', dismiss, { signal: mcSignal }), 0)
        return
      }

      // Channel tabs get edit/remove context menu
      const reserved = ['feed', 'mentions', 'whispers', 'discover', 'pinned', 'modlog', 'add', 'settings']
      if (reserved.includes(tabId)) return
      e.preventDefault()

      // Remove any existing context menu
      document.getElementById('hs-mc-ctx-menu')?.remove()

      const ch = getChannelById(tabId)
      const menu = document.createElement('div')
      menu.id = 'hs-mc-ctx-menu'
      menu.style.cssText =
        'position:fixed;z-index:99999;background:#000;border:1px solid #808080;border-radius:0;padding:4px 0;min-width:150px;font-size:13px;font-family:inherit;'

      const mkItem = (label, color, fn) => {
        const item = document.createElement('div')
        item.textContent = label
        item.style.cssText = `padding:6px 12px;cursor:pointer;color:${color};`
        item.addEventListener('mouseenter', () => (item.style.background = 'rgba(255,255,255,0.06)'), {
          signal: mcSignal,
        })
        item.addEventListener('mouseleave', () => (item.style.background = ''), { signal: mcSignal })
        item.addEventListener('click', () => {
          menu.remove()
          fn()
        })
        menu.appendChild(item)
      }

      mkItem('edit', '#fff', () => showEditChannelForm(tabId))
      for (const l of channelSubLinks(ch)) {
        mkItem(l.label, '#ff8700', () => window.open(l.url, '_blank', 'noopener'))
      }
      mkItem('remove', 'var(--hs-danger)', () => removeChannel(tabId))

      // Append then clamp to viewport so it doesn't overflow off-screen
      document.body.appendChild(menu)
      const mw = menu.offsetWidth,
        mh = menu.offsetHeight
      menu.style.left = `${Math.min(e.clientX, window.innerWidth - mw - 4)}px`
      menu.style.top = `${Math.min(e.clientY, window.innerHeight - mh - 4)}px`

      const dismiss = (ev) => {
        if (!menu.contains(ev.target)) {
          menu.remove()
          document.removeEventListener('click', dismiss)
        }
      }
      cleanup.setTimeout(() => document.addEventListener('click', dismiss, { signal: mcSignal }), 0)
    })

    return container
  }

  // Edit form active — block renders while editing channel config
  let editingChannel = false

  // Track scroll state for "new messages" button
  let isScrolledUp = false
  let emoteReloadTimer = null
  // Track scopes (channel:X / global / inventory) whose first emote payload
  // we've already received this session. After first load, subsequent emote
  // updates skip clearRenderedHtmlCache so old messages keep their rendering
  // even when emotes are removed — "history is sacred" UX.
  const _emoteFirstLoad = new Set()
  const _emoteFirstLoadAt = new Map() // scope → first-seen ms
  // Cold-load re-render window. The BG fires ONE channel_emotes_update per provider
  // (bttv / ffz / 7tv / native) during the initial channel fetch, so a channel
  // emote that lives in a LATE-resolving provider (e.g. a 7TV "Cabge"/"speed0" when
  // 7tv lands after bttv) arrives AFTER the first payload. A first-payload-only gate
  // would then never upgrade the plain-text history rows for it — the reported
  // "7TV emotes render as text after refresh (but fine live)". Treat every payload
  // within this window of a scope's first as still cold-loading so late providers
  // still swap text→image; a genuine live add/remove (7TV EventAPI) lands long
  // after and correctly stays in the history-preserving (no re-render) path.
  const EMOTE_COLD_LOAD_MS = 25000
  function _emoteColdLoad(scopes) {
    const now = Date.now()
    let cold = false
    for (const s of scopes) {
      const at = _emoteFirstLoadAt.get(s)
      if (at == null) {
        _emoteFirstLoadAt.set(s, now)
        _emoteFirstLoad.add(s)
        cold = true
      } else if (now - at < EMOTE_COLD_LOAD_MS) {
        cold = true
      }
    }
    return cold
  }
  // Scopes that arrived since the last debounce flush. Collected across
  // progressive broadcasts (BTTV/FFZ/7TV/Twitch arrive separately for the
  // same channel) so the eventual loadEmotes() knows every scope to
  // first-load-clear in one shot. Drained when the timer fires.
  let _pendingEmoteScopes = new Set()
  // Set when a channel_emotes_update payload contains names that weren't
  // renderable before — drives the upgrade-only history heal even outside the
  // cold-load window (late provider / deferred join / refetch payloads).
  let _pendingEmoteAdds = false
  let newMessageCount = 0
  let isProgrammaticScroll = false // Flag to ignore programmatic scrolls

  // WYSIWYG mode (inline emote images in input)
  let wysiwygEnabled = true

  // Clickable links in chat messages (default on)
  let linksEnabled = true

  // Partial/defanged link detection — watch?v= refs + "(dot)"-style domains
  let partialLinksEnabled = true

  // Link preview tooltip on hover (default on)
  let linkPreviewsEnabled = true

  // Inline media embeds in chat — images/gifs/video/link-cards rendered below
  // the message (never live iframes; see extractChatEmbed). Default on.
  let mediaEmbedsEnabled = true

  // Vi mode for chat input (default off)
  let viModeEnabled = false

  // Platform badges [T]/[K]/[Y] on messages (default on)
  let platformBadgesEnabled = true

  // Mod/vip/sub badges as terse text chips instead of images (default off).
  // Read from twitch-api.js's renderBadges and cosmetics.js's
  // _patchBadgesInRoot — same concatenated scope, and both only run after
  // init has executed this line, so the TDZ never bites (same guarantee
  // _RUNTIME_BRIDGE above relies on).
  let textBadgesEnabled = false

  // Pronouns (pronoundb.org, twitch-only) on the profile card + hover
  // tooltip (default on)
  let pronounsEnabled = true

  // Zebra striping — alternate row backgrounds (default on)
  let zebraEnabled = true

  // Toast on incoming whisper/DM while not on the whispers tab (default on) —
  // the has-whispers tab badge alone was easy to miss (wollip kept missing
  // whispers entirely).
  let whisperToastEnabled = true

  // Scroll-wheel volume on the player (classic BTTV behavior, default on) —
  // read live by the document-level wheel listener (see setupScrollWheelVolume).
  let scrollWheelVolumeEnabled = true

  // Util row collapsed — hides C/T/F-/F+/⚙ for clean single-line tabs

  // User-hidable tabs — persisted in ui_settings.hiddenTabs (auto-syncs cross-device)
  const HIDABLE_TABS = ['feed', 'whispers', 'mentions', 'pinned', 'modlog']
  // Real steady-state default stays 'pinned' only (see hiddenTabs registry entry
  // in settings-schema.js) — this wider set is the fresh-install-only target:
  // whispers/mentions/modlog are genuinely login-walled for a signed-out
  // first-run user, so applyFreshInstallHiddenTabs() pushes new installs here
  // once, and revealFreshInstallTabsOnce() un-hides them on first login.
  //
  // `feed` was on this list until 2026-08-25 and must never go back on it. It
  // was correct when written (2026-07-27): the feed really was an empty wall
  // for a signed-out user. The 2026-08-16 cold-start fix ended that — /hot
  // serves 30 real rows anonymously and social.js dropped its auth gate on the
  // explicit reasoning that "a logged-out session is EVERY brand-new install"
  // — but this list was not revisited, so the tab showing that feed stayed off
  // the bar until first login. Every new install therefore had no feed tab at
  // all, which is why prod measured ~5 live installs a day and ZERO requests to
  // the feed endpoint over three days. Same bug as the other three layers, one
  // repo up: each looked fixed from the layer above.
  const DEFAULT_HIDDEN_TABS = ['pinned', 'whispers', 'mentions', 'modlog']
  // The set stamped on installs from 2026-07-27 to 2026-08-25. Still recognised
  // so those installs are treated as "never customised" rather than stranded
  // with a hidden feed forever.
  const LEGACY_FRESH_HIDDEN_TABS = ['pinned', 'feed', 'whispers', 'mentions', 'modlog']
  let hiddenTabs = new Set(['pinned'])

  // One-time fresh-install tab hiding: background.js stamps hs_fresh_install_hidden_tabs
  // on chrome.runtime.onInstalled(reason:'install') only — never on update, so
  // existing users who never touched the Tabs setting are untouched. Consumes
  // the flag immediately so this can never re-fire, and only applies if the
  // user hasn't already customized hiddenTabs (never fights a manual choice).
  async function applyFreshInstallHiddenTabs() {
    try {
      const { hs_fresh_install_hidden_tabs } = await chrome.storage.local.get('hs_fresh_install_hidden_tabs')
      if (!hs_fresh_install_hidden_tabs) return
      chrome.storage.local.remove('hs_fresh_install_hidden_tabs').catch(() => {})
      const cur = getSetting('hiddenTabs')
      if (Array.isArray(cur) && cur.length === 1 && cur[0] === 'pinned') {
        setSetting('hiddenTabs', DEFAULT_HIDDEN_TABS)
        saveUiSetting('hiddenTabsRevealPending', true)
      }
    } catch (_) {}
  }
  // Reveals the fresh-install-hidden tabs on first successful heatsync login.
  // One-shot (guard flag consumed on first call) and only reveals if the user
  // hasn't since customized hiddenTabs themselves — otherwise leaves their
  // choice alone. Called both from the auth_changed broadcast and the
  // get_auth_state boot probe (covers "already logged in before install finished").
  async function revealFreshInstallTabsOnce() {
    try {
      const { ui_settings } = await chrome.storage.sync.get('ui_settings')
      if (!ui_settings?.hiddenTabsRevealPending) return
      saveUiSetting('hiddenTabsRevealPending', false)
      const cur = getSetting('hiddenTabs')
      const matches = (set) => Array.isArray(cur) && cur.length === set.length && set.every((id) => cur.includes(id))
      // Either shape counts as untouched: an install stamped before feed came
      // off the list still carries the legacy set, and comparing only against
      // the current one would leave it hidden-forever instead of revealed.
      if (matches(DEFAULT_HIDDEN_TABS) || matches(LEGACY_FRESH_HIDDEN_TABS)) setSetting('hiddenTabs', ['pinned'])
    } catch (_) {}
  }

  // One-shot: give the feed tab back to installs stamped while `feed` was on the
  // fresh-install hidden list (2026-07-27 → 2026-08-25).
  //
  // Without this, the fix above only helps installs made after the next release:
  // everyone already carrying the legacy set keeps a hidden feed until they log
  // in, which is the exact wall being removed — and they are the only users
  // there are. Acts solely on an EXACT match of the legacy set, which no manual
  // edit can leave behind, so a deliberate choice to hide the feed is never
  // overridden. Removes only `feed`; whispers/mentions/modlog stay hidden until
  // login, because those really are login-walled.
  async function unhideFeedOnce() {
    try {
      const { hs_feed_unhidden } = await chrome.storage.local.get('hs_feed_unhidden')
      if (hs_feed_unhidden) return
      chrome.storage.local.set({ hs_feed_unhidden: true }).catch(() => {})
      const cur = getSetting('hiddenTabs')
      const isLegacy =
        Array.isArray(cur) &&
        cur.length === LEGACY_FRESH_HIDDEN_TABS.length &&
        LEGACY_FRESH_HIDDEN_TABS.every((id) => cur.includes(id))
      if (isLegacy) setSetting('hiddenTabs', DEFAULT_HIDDEN_TABS)
    } catch (_) {}
  }

  // Timestamps on messages (default off)
  let timestampsEnabled = false
  window._hsTimestampsEnabled = false
  let avatarsEnabled = false

  // Auto-claim Twitch channel points bonus chests across every twitch
  // channel in your multichat. Uses the official ClaimCommunityPoints GQL
  // call (same one Twitch's own UI fires) — pure user benefit, ToS-clean.
  // Toast notifies on each successful claim.
  let autoClaimPoints = true

  // Dim timed-out/banned messages instead of hiding (default on)
  let dimTimeouts = true

  // Opt-in (default off): confirm before a permanent ban — guards against a
  // fat-fingered irreversible ban. Read at the dispatchModAction chokepoint.
  let modConfirmBan = false

  // Configurable ban reasons (one per line, default empty). When set, the ban
  // dialog shows them as selectable chips; the choice flows to the ban API.
  let modBanReasons = ''

  // Boost username color brightness for readability on black bg (default on)
  let readableNamesEnabled = true

  // Input bar auto-hide — hidden when empty, shown on first keystroke
  let autoHideInput = false
  let inputBarVisible = true
  // Rapid-fire guard: keepComposerOpen() suppresses auto-hide for a short
  // window (Tab-reveal, sticky-focus sends on non-auto-hide setups) so a
  // transient blur can't collapse the bar mid-flow. Auto-hide sends do NOT
  // route through this — settleComposerAfterSend() zeroes the window and
  // hides instantly on Enter; type-to-reveal covers the next keystroke.
  let _keepComposerOpenUntil = 0
  function keepComposerOpen(ms) {
    _keepComposerOpenUntil = performance.now() + (ms || 500)
  }
  // …except in the /live_chat pop-out — a blurred composer there sends f/t/etc.
  // to the host page's find-as-you-type or a link-hint extension instead of chat.
  // Works WITH vi mode: input-vi only acts while the composer is focused (and
  // types the first printable key into an empty composer even in normal mode),
  // so a hidden composer never eats keys — the type-to-reveal handler wins.
  const autoHideEligible = () => autoHideInput && !isYtPopout
  const canAutoHideInput = () => autoHideEligible() && performance.now() >= _keepComposerOpenUntil

  // First-time chatter highlight — orange edge on first message from a user this session (default on)
  let firstChatterGlow = true
  // channelLower → Set<usernameLower> seen this session
  const seenChattersByChannel = new Map()
  function markChatterSeen(channel, username) {
    if (!channel || !username) return false
    const ch = channel.toLowerCase()
    const u = username.toLowerCase()
    let set = seenChattersByChannel.get(ch)
    if (!set) {
      set = new Set()
      seenChattersByChannel.set(ch, set)
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
  let keywordHighlights = ''
  let keywordHighlightsRegex = null
  function rebuildKeywordRegex() {
    const terms = keywordHighlights
      .split(/\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (!terms.length) {
      keywordHighlightsRegex = null
      return
    }
    const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    try {
      keywordHighlightsRegex = new RegExp(`\\b(${escaped.join('|')})\\b`, 'i')
    } catch {
      keywordHighlightsRegex = null
    }
  }

  // ═══ Inline notification routing ═══
  // Modular registry: each type can be toggled independently
  // Colors match website conventions
  // Derived from the settings registry boolmap entry — option rows carry
  // tag/color/label keys; i18n resolves here (t() unavailable in lib scope).
  const INLINE_NOTIF_TYPES = {}
  for (const o of _SETTINGS_BY_KEY.get('inlineNotifs').options) {
    INLINE_NOTIF_TYPES[o.value] = {
      tag: o.tag,
      color: o.color,
      borderColor: o.borderColor,
      defaultOn: o.default,
      label: o.labelKey ? t(o.labelKey) : o.label,
      desc: o.tipKey ? t(o.tipKey) : o.tip,
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
      color: o.color,
      defaultOn: o.default,
      label: o.labelKey ? t(o.labelKey) : o.label,
      desc: o.tipKey ? t(o.tipKey) : o.tip,
    }
  }
  const hermesToggles = {}
  for (const [k, v] of Object.entries(HERMES_EVENT_TYPES)) hermesToggles[k] = v.defaultOn

  // Can the composer actually send from this tab? ONE answer, used by every
  // path that shows, focuses, reveals, or sends from the bar — a box you can
  // type into that quietly eats the message is worse than no box.
  //   live      — the channel the page is on (nothing on /directory)
  //   feed      — posts to your heatsync feed (placeholder says so)
  //   whispers  — /r, /w, /dm; a bare send is refused out loud
  //   mentions  — same, slash commands only
  //   <channel> — a configured channel tab
  // add / settings / discover / pinned / modlog — and any stale id left behind
  // by a removed channel — can't send anywhere: sendMessage's targetChannel
  // fell back to the TAB ID, so Enter on the modlog tab addressed a channel
  // named "modlog" and the message went nowhere, silently.
  // Narrower: tabs where a plain message goes to a live CHAT. The social tabs
  // take input but refuse a bare send, so anything that means "start chatting
  // to this person" (profile-card mention) needs this one, not the broad test.
  function tabSendsToChat(id) {
    if (!id) return false
    if (id === 'live') return !!getLiveChannel()
    return !!getChannelById(id)
  }
  function tabAcceptsInput(id) {
    return tabSendsToChat(id) || id === 'feed' || id === 'whispers' || id === 'mentions'
  }

  // The DOM class is the truth; inputBarVisible is only a cache of it. Several
  // paths add/remove hs-hidden directly (log + profile-card views, the autoHide
  // toggle, a container rebuild that mints a fresh bar), so the cache can drift
  // — and every drift is a dead composer: a stale `false` on a VISIBLE bar made
  // hideInputBar() early-return forever (empty bar stranded on screen,
  // "auto-hide stopped working"), a stale `true` on a HIDDEN bar made
  // showInputBar() early-return (no way to type). Re-read before each decision.
  function syncInputBarVisible() {
    const bar = document.getElementById('hs-mc-inputbar')
    if (bar) inputBarVisible = !bar.classList.contains('hs-hidden')
    return inputBarVisible
  }

  function showInputBar() {
    // Single choke point for every reveal (emote click-paste, quote, mention,
    // upload, type-to-reveal): a tab that can't send never gets a composer.
    if (!tabAcceptsInput(currentTab)) return
    if (syncInputBarVisible()) return
    inputBarVisible = true
    const bar = document.getElementById('hs-mc-inputbar')
    if (bar) bar.classList.remove('hs-hidden')
    // Overlay bottom inset is owned by _updateMcLayout (measured inputbar
    // height) — writing it here from CSS assumptions left a dead band when the
    // real composer height differed from the stylesheet fallback.
    // ResizeObserver doesn't fire on display:none → :flex; recompute anchors
    // so the docked Twitch callout follows the inputbar. (Also re-mirrors an
    // open picker onto the message list's new box — see syncPickerBox.)
    _updateMcLayout?.()
  }

  // vi-mode (chrome/vi-mode.js, same isolated world) reports "normal mode
  // settled on an empty composer" — the keyboard-first "done here" signal.
  // A keyboard-only flow never blurs on its own, so without this the empty
  // bar could never auto-hide (the focused-composer guard blocked forever).
  // Blur first so that guard passes, and zero the rapid-fire/sticky windows —
  // an explicit Escape outranks post-send stickiness.
  window.__hsViComposerEmpty = (el) => {
    if (el?.id !== 'hs-mc-input' || !autoHideEligible()) return
    _keepComposerOpenUntil = 0
    _composerStickyUntil = 0
    el.blur()
    hideInputBar()
  }

  let _autoHideRetryTimer = null
  function hideInputBar() {
    if (!autoHideEligible()) return
    if (!syncInputBarVisible()) return
    const input = document.getElementById('hs-mc-input')
    const hasText = input ? (input.value || input.textContent || '').trim().length > 0 : false
    const hasContent = hasText || input?.querySelector('img, span.hs-mc-emoji')
    if (hasContent) return
    // vi change-operators (cc/s/S/C, c+motion) empty the composer for one
    // synchronous beat before re-entering insert — never hide on that
    // transient empty. (Focus alone is NOT a keep signal: empty = hidden,
    // instantly; the rapid-fire send flow is covered by keepComposerOpen.)
    if (window.__hsViChanging?.()) return
    // Don't hide while emote picker is open
    const picker = document.getElementById('hs-mc-emote-picker')
    if (picker?.classList.contains('visible')) return
    // Don't hide while reply is active
    if (replyState) return
    // Rapid-fire window (keepComposerOpen): don't SWALLOW the hide — blur's
    // attempt is one-shot, so a hide dropped here used to leave the empty bar
    // stuck until some later blur ("auto-hide only works sometimes"). Retry
    // once the window expires; every guard above re-runs then.
    const wait = _keepComposerOpenUntil - performance.now()
    if (wait > 0) {
      if (!_autoHideRetryTimer) {
        _autoHideRetryTimer = cleanup.setTimeout(() => {
          _autoHideRetryTimer = null
          hideInputBar()
        }, wait + 50)
      }
      return
    }
    inputBarVisible = false
    const bar = document.getElementById('hs-mc-inputbar')
    if (bar) bar.classList.add('hs-hidden')
    // Hiding blurs the composer. Tell vi-mode to let go NOW — its own focusout
    // detach is 150ms behind, and a key pressed inside that gap runs as a vi
    // command on an invisible composer (blockEvent kills it) instead of
    // reaching the type-to-reveal handler. Every hide funnels through here, so
    // the timer-driven and reconciler-driven hides are covered too, not just
    // the vi-initiated one.
    try {
      window.__hsViDetachNow?.(document.getElementById('hs-mc-input'))
    } catch (_) {}
    // Overlay bottom follows via _updateMcLayout (hs-hidden → inputbar
    // measures 0) — a hardcoded '0' here was wrong for bottom-tabs, where the
    // inset must stay tabbar-height.
    _updateMcLayout?.()
  }

  function createOverlay() {
    const overlay = document.createElement('div')
    overlay.id = 'hs-mc-overlay'
    overlay.dir = HS_DIR()
    // Static hardcoded layout — only static strings, no user input, safe innerHTML
    const searchPlaceholder = 'search messages…'
    overlay.innerHTML = `
      <div id="hs-mc-search-bar">
        <input id="hs-mc-search-input" type="text" placeholder="${searchPlaceholder}" autocomplete="off" spellcheck="false" />
        <span id="hs-mc-search-count"></span>
        <div id="hs-mc-search-spinner"></div>
      </div>
      <div id="hs-mc-statusbar">
        <div id="hs-notif-layer-statusbar" class="hs-notif-layer hs-notif-layer-statusbar"></div>
      </div>
      <div id="hs-mc-multistream-banner" hidden></div>
      <div id="hs-mc-messages" role="log" aria-label="chat messages">
        <!-- Skeleton state, painted before any join has even been issued —
             so it must be "connecting…", not "no messages yet". renderMessages
             owns the swap: it prints "no messages yet" only once _tabJoining
             says every leg has settled. This static string is the one a fresh
             install actually stares at while the panel wires up. -->
        <div class="hs-mc-empty">${t('mc_connecting')}</div>
      </div>
      <button id="hs-mc-new-msgs" style="display:none"></button>
    `

    // Setup scroll detection after DOM insertion
    cleanup.setTimeout(() => {
      const msgsEl = document.getElementById('hs-mc-messages')
      const newBtn = document.getElementById('hs-mc-new-msgs')
      if (!msgsEl || !newBtn) return
      wireModToolbarHover(msgsEl)

      // Retry broken emote imgs — 7TV/BTTV/FFZ CDNs occasionally 503 and
      // surface as broken (naturalWidth=0). Capture phase since 'error' doesn't
      // bubble. Backoff 1s/3s/8s, max 3 tries, scoped to .hs-mc-emote.
      cleanup.addEventListener(
        msgsEl,
        'error',
        (e) => {
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
        },
        { capture: true },
      )

      const isStaticTab = () =>
        currentTab === 'feed' ||
        currentTab === 'settings' ||
        currentTab === 'discover' ||
        currentTab === 'pinned' ||
        currentTab === 'modlog'

      // Bulletproof scroll-pause: ANY upward movement pauses chat sticky.
      // Resumes ONLY when user lands within 2px of true bottom OR clicks "new" button.
      // Prior 50px slop let small wheels/drags re-trigger auto-scroll, breaking pause.
      const ATBOTTOM_PX = 2
      const setPaused = (paused) => {
        if (paused) {
          if (!isScrolledUp) {
            isScrolledUp = true
            newBtn.innerHTML =
              newMessageCount > 0
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
      let _userInputScroll = false // set by wheel/touch/key, cleared after scroll settles
      mcSignal.addEventListener('abort', () => {
        if (_scrollFrame) {
          cancelAnimationFrame(_scrollFrame)
          _scrollFrame = null
        }
      })

      const checkAtBottom = () => {
        if (isStaticTab()) return msgsEl.scrollTop <= ATBOTTOM_PX
        return msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight <= ATBOTTOM_PX
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

      msgsEl.addEventListener(
        'scroll',
        () => {
          if (_scrollFrame) return
          _scrollFrame = requestAnimationFrame(() => {
            _scrollFrame = null
            onScrollMaybeResume()
            maybeLoadOlder()
          })
        },
        { passive: true, signal: mcSignal },
      )

      msgsEl.addEventListener(
        'scrollend',
        () => {
          if (_scrollFrame) {
            cancelAnimationFrame(_scrollFrame)
            _scrollFrame = null
          }
          onScrollMaybeResume()
          // touch-end / wheel-coast finished — clear input flag so subsequent
          // passive scroll events don't accidentally count as user-driven.
          _userInputScroll = false
        },
        { signal: mcSignal },
      )

      // Wheel-up: pause INSTANTLY (before any scroll event fires).
      msgsEl.addEventListener(
        'wheel',
        (e) => {
          if (isStaticTab()) return
          _userInputScroll = true
          if (e.deltaY < 0) setPaused(true)
        },
        { passive: true, signal: mcSignal },
      )

      // Touch: track touchmove direction. Drag DOWN (page scrolls UP visually
      // — finger moves down means content moves down, we see earlier msgs)
      // pauses chat. mark _userInputScroll on any touch interaction.
      let _touchStartY = 0
      msgsEl.addEventListener(
        'touchstart',
        (e) => {
          _touchStartY = e.touches[0]?.clientY || 0
          _userInputScroll = true
        },
        { passive: true, signal: mcSignal },
      )
      msgsEl.addEventListener(
        'touchmove',
        (e) => {
          if (isStaticTab()) return
          const y = e.touches[0]?.clientY || 0
          if (y > _touchStartY + 4) setPaused(true)
          _touchStartY = y
        },
        { passive: true, signal: mcSignal },
      )

      // Keys that scroll up — pause.
      msgsEl.addEventListener(
        'keydown',
        (e) => {
          if (isStaticTab()) return
          if (e.key === 'PageUp' || e.key === 'Home' || e.key === 'ArrowUp') {
            _userInputScroll = true
            setPaused(true)
          } else if (e.key === 'PageDown' || e.key === 'End' || e.key === 'ArrowDown' || e.key === ' ') {
            _userInputScroll = true
          }
        },
        { signal: mcSignal },
      )

      // Mousedown on scrollbar thumb (target === msgsEl, click outside content)
      // — flag user input so subsequent scroll counts as user-driven.
      msgsEl.addEventListener(
        'mousedown',
        (e) => {
          if (e.target === msgsEl) _userInputScroll = true
        },
        { passive: true, signal: mcSignal },
      )

      newBtn.addEventListener(
        'click',
        () => {
          isScrolledUp = false
          newMessageCount = 0
          newBtn.style.display = 'none'
          _scrollbackWindow = 0 // jumping to live tail — drop scrollback DOM
          if (isStaticTab()) {
            // Static tabs: re-render then scroll to top (newest content)
            renderMessages(currentTab)
            msgsEl.scrollTop = 0
          } else {
            // Chat tabs: re-render then teleport to bottom. The new render
            // diff only auto-pins if user was AT bottom; here the user was
            // scrolled UP and clicked to come back, so force the scroll.
            renderMessages(currentTab)
            scrollMsgsToBottom(msgsEl)
          }
        },
        { signal: mcSignal },
      )

      // Bulletproof sticky-bottom: any change to msgsEl's box (panel resize,
      // window resize, tab/input bar height shift, font-size change) re-pins
      // to bottom unless the user explicitly scrolled up. Plugs the gap where
      // a width-rewrap shifted scrollTop a few px and the geometric
      // wasAtBottom check in renderMessages flipped to false.
      const _stickyResizeObs = new ResizeObserver(() => {
        if (isScrolledUp) return
        if (isStaticTab()) return
        // Shared frame-coalesced pinner — see onImgLoadOrError. A direct
        // scrollMsgsToBottom here was a second same-frame scrollTop writer
        // racing the append path's pin.
        scheduleScrollPin(msgsEl)
      })
      _stickyResizeObs.observe(msgsEl)
      cleanup.trackObserver(_stickyResizeObs)

      // Image-load re-pin: lazy-loaded emotes/badges/avatars decode AFTER the
      // message row rendered and we already pinned. Late-resolving height
      // grows the row, pushing bottom past the viewport → "drifted up by a
      // few px for a few sec" on busy channels with many lazy assets per
      // message. ResizeObserver doesn't catch this (msgsEl's box stays
      // constant). `load` doesn't bubble so capture phase is required.
      // Coalescing lives in scheduleScrollPin (shared with every other pin
      // trigger) so a 100-image burst still does one layout per frame.
      const onImgLoadOrError = (e) => {
        // A cosmetic badge img failed (e.g. 7TV CDN QUIC drop under request
        // burst). The URL is valid, so retry before giving up — only hide after
        // 2 failed retries — so we never render a permanent broken-image icon.
        if (e?.type === 'error') {
          const t = e.target
          if (t instanceof HTMLImageElement && t.classList.contains('hs-mc-badge-img')) retryOrHideBadgeImg(t)
          if (t instanceof HTMLImageElement && t.classList.contains('hs-mc-avatar')) t.style.display = 'none'
          // static-emote proxy failure (heatsync.org unreachable / 429) —
          // swap back to the original CDN url once instead of a broken icon
          if (
            t instanceof HTMLImageElement &&
            t.classList.contains('hs-mc-emote') &&
            (t.src || '').includes('/api/emote-proxy') &&
            !t.dataset.hsProxyFell
          ) {
            t.dataset.hsProxyFell = '1'
            const orig = t.closest('.hs-mc-emote-wrapper')?.dataset?.emoteUrl
            if (orig) t.src = orig
          }
          // CDN static-variant miss (brand-new emote still processing) — fall
          // back to the original animated url once instead of a broken icon.
          // avif static misses are excluded: the avif block below retries the
          // webp static variant first; only its failure lands back here.
          if (
            t instanceof HTMLImageElement &&
            t.classList.contains('hs-mc-emote') &&
            /(_static\.|\/static\/)/.test(t.src || '') &&
            !/\.avif(\?|$)/i.test(t.src || '') &&
            !t.dataset.hsStaticFell
          ) {
            t.dataset.hsStaticFell = '1'
            const orig = t.closest('.hs-mc-emote-wrapper')?.dataset?.emoteUrl
            if (orig) t.src = orig
          }
          // 7TV emote requested as AVIF (10x smaller for animated) but this
          // emote has no avif variant (rare — e.g. brand-new emote still
          // processing) → fall back to webp once instead of a broken icon.
          if (
            t instanceof HTMLImageElement &&
            t.classList.contains('hs-mc-emote') &&
            (t.src || '').includes('cdn.7tv.app/emote/') &&
            t.src.endsWith('.avif') &&
            !t.dataset.hsAvifFell
          ) {
            t.dataset.hsAvifFell = '1'
            t.src = t.src.replace(/\.avif$/, '.webp')
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
        // Route through the ONE frame-coalesced pinner. Every scroll-pin
        // trigger (append, resize, image decode) must share a single
        // scrollTop writer per frame — independent rAF writers raced each
        // other and the rows visibly jumped ("virtual scrolling bugging out").
        scheduleScrollPin(msgsEl)
      }
      msgsEl.addEventListener('load', onImgLoadOrError, { capture: true, passive: true, signal: mcSignal })
      msgsEl.addEventListener('error', onImgLoadOrError, { capture: true, passive: true, signal: mcSignal })

      // Hover-to-animate (animateEmotes: 'hover') — rows render static srcs;
      // pointing at a message swaps all its emotes to the original animated
      // url (data-emote-url), leaving restores the exact pre-hover src via a
      // stash (never recomputed, so proxy/avif fallbacks survive roundtrips).
      // Row-level swap: one hover animates the whole message, matching how
      // people actually read chat, and keeps the hit target big.
      let _hoverAnimRow = null
      const _restoreHoverRow = () => {
        if (!_hoverAnimRow) return
        for (const img of _hoverAnimRow.querySelectorAll('img.hs-mc-emote')) {
          if (img.dataset.hsStaticSrc) {
            img.src = img.dataset.hsStaticSrc
            delete img.dataset.hsStaticSrc
          }
        }
        _hoverAnimRow = null
      }
      msgsEl.addEventListener(
        'mouseover',
        (e) => {
          if (emoteAnimationMode !== 'hover') return
          const row = e.target instanceof Element ? e.target.closest('.hs-mc-msg') : null
          if (row === _hoverAnimRow) return
          _restoreHoverRow()
          if (!row) return
          _hoverAnimRow = row
          for (const img of row.querySelectorAll('img.hs-mc-emote')) {
            const orig = img.closest('.hs-mc-emote-wrapper')?.dataset?.emoteUrl
            if (orig && img.src !== orig && !img.dataset.hsStaticSrc) {
              img.dataset.hsStaticSrc = img.src
              img.src = orig
            }
          }
        },
        { passive: true, signal: mcSignal },
      )
      msgsEl.addEventListener('mouseleave', _restoreHoverRow, { passive: true, signal: mcSignal })

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
        // Flip the pill's state back — aria-expanded is what tells a screen
        // reader (and the caret rule) whether the thread is open, so it has to
        // track dismissal from every path: outside click, Escape, re-click.
        try {
          const prevPill = _stackActiveRow?.querySelector('.hs-mc-reply-ctx[aria-expanded="true"]')
          if (prevPill) prevPill.setAttribute('aria-expanded', 'false')
        } catch (_) {}
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
        const isMember = (m) =>
          m === hoveredMsg || m.id === threadId || m.replyTo?.threadId === threadId || m.replyTo?.id === threadId
        const collectFrom = (buf) => {
          const msgs = buf.getAll()
          let foundHovered = false
          for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i]
            const match = m === hoveredMsg || (hoveredMsg.id && m.id === hoveredMsg.id)
            if (match) {
              foundHovered = true
              continue
            }
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
        const px =
          ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaMode === 2 ? ev.deltaY * liveMsgsEl.clientHeight : ev.deltaY
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
        el.addEventListener(
          'click',
          (ev) => {
            const chip = ev.target.closest('.hs-mc-reply-stack-chip')
            if (!chip) return
            ev.preventDefault()
            ev.stopPropagation()
            // Expand inline: render the full chain into the up overlay and
            // turn it into a scrollable popover. User reads all parents in
            // place, no chat jump, hover stays alive.
            const chain = el._fullChain
            if (!chain?.length) return
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
          },
          { signal: mcSignal },
        )
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
          overlay.style.left = `${hRect.left}px`
          overlay.style.width = `${hRect.width}px`
          overlay.style.bottom = `${layoutViewportHeight - hRect.top}px`
          overlay.style.maxHeight = `${availableUp}px`
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
                chip.textContent = `↑ ${remaining} more`
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
          if (overlay) {
            overlay.style.display = 'none'
            overlay.replaceChildren()
          }
        }

        // ── Render DESCENDANTS in the down overlay ──
        let downShown = 0
        if (descChain.length && availableDown >= 24) {
          const overlay = ensureStackOverlayDown()
          overlay.replaceChildren()
          overlay.style.position = 'fixed'
          overlay.style.left = `${hRect.left}px`
          overlay.style.width = `${hRect.width}px`
          overlay.style.top = `${hRect.bottom}px`
          overlay.style.maxHeight = `${availableDown}px`
          overlay.style.display = 'block'
          for (let i = 0; i < descChain.length; i++) {
            const child = descChain[i]
            const row = buildMessageDiv(child, currentTab)
            if (!row) continue
            row.classList.add('hs-mc-reply-stack-row')
            overlay.appendChild(row) // chronological top-down
            if (overlay.scrollHeight > availableDown) {
              overlay.removeChild(row)
              break
            }
            downShown++
          }
          if (!downShown) overlay.style.display = 'none'
        } else {
          const overlay = document.getElementById('hs-mc-reply-stack-down')
          if (overlay) {
            overlay.style.display = 'none'
            overlay.replaceChildren()
          }
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
        _stackTailId = descChain.length ? descChain[descChain.length - 1].id || '' : ownId || ''
        _stackChannel = (channel || '').toLowerCase()
        _stackPlatform = platform || ''
        _stackOwnId = ownId || ''
        _stackThreadId = threadId || ''
      }

      // Click the "Replying to" pill to open the thread stack. Click again on
      // the same row's pill to close. Click on the @user link inside the pill
      // still navigates to the profile (target=_blank). Opens pause chat
      // auto-scroll so the active row doesn't slide out from under the stack.
      msgsEl.addEventListener(
        'click',
        (e) => {
          const pill = e.target.closest('.hs-mc-reply-ctx')
          if (!pill) return
          if (e.target.closest('a')) return
          const msg = pill.closest('.hs-mc-msg')
          if (!msg?.dataset.replyId) return
          e.preventDefault()
          e.stopPropagation()
          if (_stackActiveRow === msg) {
            dismissStack()
            return
          }
          if (_stackActiveRow) dismissStack()
          setPaused(true)
          showStack(msg)
          pill.setAttribute('aria-expanded', 'true')
        },
        { signal: mcSignal },
      )
      // Keyboard: the pill is a button now, so Enter/Space must open it like
      // any other. Without this it was reachable by Tab and then inert, which
      // is worse than not being focusable at all.
      msgsEl.addEventListener(
        'keydown',
        (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          const pill = e.target.closest?.('.hs-mc-reply-ctx')
          if (!pill) return
          e.preventDefault()
          pill.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
        },
        { signal: mcSignal },
      )
      // Dismiss on outside click — keep open when clicking inside the active
      // row or either overlay (chip-expand, link clicks, etc.).
      document.addEventListener(
        'mousedown',
        (e) => {
          if (!_stackActiveRow) return
          if (_stackActiveRow.contains(e.target)) return
          const oUp = document.getElementById('hs-mc-reply-stack')
          if (oUp?.contains(e.target)) return
          const oDown = document.getElementById('hs-mc-reply-stack-down')
          if (oDown?.contains(e.target)) return
          dismissStack()
        },
        { signal: mcSignal },
      )
      document.addEventListener(
        'keydown',
        (e) => {
          if (_stackActiveRow && e.key === 'Escape') {
            dismissStack()
            e.stopPropagation()
          }
        },
        { signal: mcSignal },
      )
      // On chat scroll, follow the active row by repositioning both overlays
      // (up + down) instead of dismissing. Only dismiss if the row scrolled
      // fully out of the chat viewport. Cache style metrics that don't change
      // for the same row — getComputedStyle in scroll path forced layout on
      // every wheel tick, the user-perceived "laggy when scrolling on a
      // reply thread."
      let _stackStyleCache = null // { row, layoutH }
      const refreshStackStyleCache = (row) => {
        if (!row) {
          _stackStyleCache = null
          return
        }
        _stackStyleCache = { row, layoutH: document.documentElement.clientHeight }
      }
      // msgsEl sits inside fixed-position #hs-mc-container, so its viewport
      // rect is invariant across chat-scroll. Cache it and invalidate only on
      // resize/layout updates — halves forced-layout reads per scroll frame
      // (was 2 getBoundingClientRect, now 1) so reply-stack scrolling stops
      // stalling the compositor on busy channels.
      let _msgsRectCache = null
      const invalidateMsgsRect = () => {
        _msgsRectCache = null
      }
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
          if (!_stackActiveRow.isConnected) {
            dismissStack()
            return
          }
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

          if (overlayUp?.firstChild) {
            const availableUp = hRect.top - cRect.top
            if (availableUp < 24) {
              overlayUp.style.display = 'none'
            } else {
              overlayUp.style.display = 'block'
              overlayUp.style.left = `${hRect.left}px`
              overlayUp.style.width = `${hRect.width}px`
              overlayUp.style.bottom = `${layoutH - hRect.top}px`
              overlayUp.style.maxHeight = `${availableUp}px`
            }
          }
          if (overlayDown?.firstChild) {
            const availableDown = cRect.bottom - hRect.bottom
            if (availableDown < 24) {
              overlayDown.style.display = 'none'
            } else {
              overlayDown.style.display = 'block'
              overlayDown.style.left = `${hRect.left}px`
              overlayDown.style.width = `${hRect.width}px`
              overlayDown.style.top = `${hRect.bottom}px`
              overlayDown.style.maxHeight = `${availableDown}px`
            }
          }
        })
      }
      msgsEl.addEventListener('scroll', repositionStack, { passive: true, signal: mcSignal })
      window.addEventListener(
        'resize',
        () => {
          invalidateMsgsRect()
          if (_stackActiveRow) repositionStack()
        },
        { passive: true, signal: mcSignal },
      )
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
        if (!_stackActiveRow?.isConnected) return
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
        overlay.style.left = `${hRect.left}px`
        overlay.style.width = `${hRect.width}px`
        overlay.style.top = `${hRect.bottom}px`
        overlay.style.maxHeight = `${maxH}px`
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
            if (!node.classList?.contains('hs-mc-msg')) continue
            tryExtendStack(node)
          }
        }
      })
      _liveStackObs.observe(msgsEl, { childList: true })
      cleanup.trackObserver(_liveStackObs)
    }, 100)

    // Search bar wiring — debounce 250ms then call /api/search
    const searchInput = overlay.querySelector('#hs-mc-search-input')
    const searchSpinner = overlay.querySelector('#hs-mc-search-spinner')
    let _searchTimer = null
    let _searchActive = false
    let _searchToken = 0

    if (searchInput && searchSpinner) {
      searchInput.addEventListener(
        'input',
        () => {
          // Live/channel tabs: instant local buffer filter — no server call, no spinner.
          if (isLiveSearchTab(currentTab)) {
            if (_searchTimer) {
              cleanup.clearTimeout(_searchTimer)
              _searchTimer = null
            }
            searchSpinner.classList.remove('visible')
            // Typing changes the match set, so any n/N cursor position is stale.
            _clearLiveSearchCursor()
            // Debounce: renderMessages → fairMerge sorts up to ~4500 items + a
            // full DOM diff. Running that synchronously on every keystroke stalls
            // the frame on low-RAM hardware. 80ms coalesces a fast typist's burst
            // into a single render; currentTab is re-read at fire time.
            _searchTimer = cleanup.setTimeout(() => {
              _searchTimer = null
              renderMessages(currentTab)
            }, 80)
            return
          }
          if (_searchTimer) {
            cleanup.clearTimeout(_searchTimer)
            _searchTimer = null
          }
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
            } catch (_) {
              searchSpinner.classList.remove('visible')
            }
          }, 250)
        },
        { signal: mcSignal },
      )

      // Clear search state when input is cleared via keyboard
      searchInput.addEventListener(
        'keydown',
        (e) => {
          if (e.key === 'Escape') {
            searchInput.value = ''
            _searchActive = false
            searchSpinner.classList.remove('visible')
            if (_searchTimer) {
              cleanup.clearTimeout(_searchTimer)
              _searchTimer = null
            }
            renderMessages(currentTab)
            searchInput.blur()
          }
        },
        { signal: mcSignal },
      )
    }

    return overlay
  }

  function renderSearchResults(msgsEl, results, query) {
    _clearMessageIndices()
    msgsEl.textContent = ''
    if (!results.length) {
      const empty = document.createElement('div')
      empty.className = 'hs-mc-search-empty'
      empty.textContent = query ? `no results for "${query}"` : 'no results'
      msgsEl.appendChild(empty)
      return
    }
    const frag = document.createDocumentFragment()
    for (const r of results) {
      const div = document.createElement('div')
      div.className = 'hs-mc-search-result'

      const ts = r.created_at
        ? new Date(r.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : ''
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
      appendTextWithHashtags(body, content)

      div.appendChild(meta)
      div.appendChild(body)

      if (permalink) {
        div.addEventListener('click', () => window.open(permalink, '_blank', 'noopener'))
      }

      frag.appendChild(div)
    }
    _snapCompleteEmotes(frag)
    msgsEl.appendChild(frag)
  }

  // Emote size — registry-managed (hs_emote_size); the emoteSize applier
  // runs applyEmoteSize + picker invalidation. Kept as a named function for
  // the picker's size buttons (emotes.js).
  function setEmoteSize(size) {
    setSetting('hs_emote_size', size)
  }

  function applyEmoteSize() {
    const targets = [document.documentElement, document.getElementById('hs-mc-messages')].filter(Boolean)
    // 28px = Twitch /1.0 native; /2.0 = 56; /3.0 = 112. Base matches URL res so 1x is truly native.
    const baseEmote = 28
    const vars = {
      '--hs-emote-size': `${baseEmote * emoteSize}px`,
      '--hs-time-font': `${10 * emoteSize}px`,
      '--hs-badge-size': `${18 * emoteSize}px`,
      '--hs-badge-font': `${10 * emoteSize}px`,
      '--hs-stat-badge-font': `${9 * emoteSize}px`,
      '--hs-stat-badge-line': `${16 * emoteSize}px`,
      '--hs-badge-img': `${18 * emoteSize}px`,
    }
    for (const el of targets) {
      for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v)
    }
    // Already-posted messages cache their rendered HTML (m._renderedHtml) built
    // with the previous size's emote-res URLs, so a plain renderMessages would
    // re-serve the old low-res <img> (box grows, image can't). reloadEmotesInPlace
    // clears the per-message cache and reprocesses, so existing emotes rebuild at
    // the new res from getChatResUrl — matching new messages.
    reloadEmotesInPlace()
  }

  // Emoji scale — separate var, default 2x. Registry-managed (hs_emoji_size,
  // incl. the legacy bigEmoji=false → 1x migration).
  let emojiSize = 2
  function applyEmojiSize() {
    const targets = [document.documentElement, document.getElementById('hs-mc-messages')].filter(Boolean)
    for (const el of targets) el.style.setProperty('--hs-emoji-scale', String(emojiSize))
  }

  // Start typing while reading our chat and the keystroke lands in the
  // composer. Gated on attention (pointer over the panel, or a popout where
  // the panel IS the window) rather than firing globally — on twitch.tv the
  // host owns single-key player shortcuts (space/k pause, m mute, f fullscreen,
  // t theatre, digits seek) and swallowing those would be a worse bug than the
  // one this fixes. See src/multichat/type-to-focus.js.
  initTypeToFocus(mcSignal)

  // '/' focuses the live-tab chat filter (vim-style) — only when not already
  // typing, no modifier held, and the filter bar is actually showing.
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA'].includes(t.tagName))) return
      if (!isLiveSearchTab(currentTab)) return
      const bar = document.getElementById('hs-mc-search-bar')
      if (!bar?.classList.contains('visible')) return
      const input = document.getElementById('hs-mc-search-input')
      if (!input) return
      e.preventDefault()
      input.focus()
      input.select()
    },
    { signal: mcSignal },
  )

  // n / N — vim-style cycling through the live-tab search filter's matches.
  // The filter already hides every non-matching row, so every .hs-mc-msg
  // currently in msgsEl IS a match; this just walks that list and marks one
  // "current". Same guards as '/': live tab, bar visible, not typing — plus
  // a non-empty query (nothing to cycle through otherwise).
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'n' && e.key !== 'N') return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA'].includes(t.tagName))) return
      if (!isLiveSearchTab(currentTab)) return
      const bar = document.getElementById('hs-mc-search-bar')
      if (!bar?.classList.contains('visible')) return
      if (!liveSearchQuery(currentTab)) return
      e.preventDefault()
      cycleLiveSearchMatch(e.key === 'n' ? 1 : -1)
    },
    { signal: mcSignal },
  )

  // Keyboard-first tab nav: alt+1..9 jump to the Nth content tab, alt+] / alt+[
  // cycle next/prev (wrapping). Alt (not ctrl/cmd) avoids the browser's own
  // ctrl/cmd+N tab switching. Only the scrollable content tabs (feed/whispers/
  // mentions/pinned/live + channels) are navigable — the util buttons
  // (add/settings/collapse/popout) live outside .hs-mc-tabs-scroll, so the
  // selector skips them. e.code (Digit1.. / Bracket*) is layout-independent and
  // immune to Alt-composition on non-Linux keymaps.
  function _navigableTabIds() {
    const out = []
    for (const el of document.querySelectorAll('.hs-mc-tabs-scroll .hs-mc-tab[data-tab]')) {
      if (el.dataset.tab === 'add' || el.offsetParent === null) continue
      out.push(el.dataset.tab)
    }
    return out
  }
  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      const t = e.target
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA'].includes(t.tagName))) return
      const isDigit = /^Digit[1-9]$/.test(e.code || '')
      const isBracket = e.code === 'BracketRight' || e.code === 'BracketLeft'
      if (!isDigit && !isBracket) return
      const ids = _navigableTabIds()
      if (!ids.length) return
      if (isDigit) {
        const idx = Number(e.code.slice(5)) - 1
        if (idx >= ids.length) return
        e.preventDefault()
        switchTab(ids[idx])
        return
      }
      // alt+] next, alt+[ prev — wrap. If the current tab isn't navigable
      // (e.g. settings), start from the nearest end so the first press lands.
      const cur = ids.indexOf(currentTab)
      const fwd = e.code === 'BracketRight'
      const base = cur === -1 ? (fwd ? -1 : 0) : cur
      const next = fwd ? (base + 1) % ids.length : (base - 1 + ids.length) % ids.length
      e.preventDefault()
      switchTab(ids[next])
    },
    { signal: mcSignal },
  )

  // (automod moved to automod.js)

  // Ephemeral auto-tabs — every stream open ANYWHERE in the browser shows
  // up as a tab here (dimmed, unsaved, vanishes when its window closes).
  // BG broadcasts the open-channel set; entries are runtime-only:
  // saveConfig/server-sync filter `ephemeral`, so nothing persists.
  function reconcileAutoTabs(openChannels) {
    const openSet = new Set(openChannels.map((c) => String(c).toLowerCase()))
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
    // add ephemerals for newly opened streams not already configured.
    // HARD CAP: never let auto-tabs run away — a stale/buggy open-channel set
    // (e.g. the 22-tab report: a long idle session accumulating entries) must not
    // spawn a wall of tabs. 8 is well past any real "streams open at once".
    const MAX_EPHEMERAL_TABS = 8
    let ephemeralCount = config.channels.filter((c) => c?.ephemeral).length
    for (const ch of openSet) {
      // BG's open-channel set is twitch IRC interest — anything that isn't a
      // plausible twitch login (yt videoIds leaked in here pre-fix; they can
      // carry '-' and are meaningless as twitch channels) must never become
      // a tab. Guards against stale BG SW state from before the yt-join fix.
      if (!isValidTwitchLogin(ch)) continue
      // Reserved URL slugs are shape-valid logins ('login', 'oauth2') — the
      // oauth redirect pages leaked them into BG open-channel state.
      if (NON_CHANNEL_PATHS.has(ch)) continue
      const exists = config.channels.some((c) => c?.twitch && c.twitch.toLowerCase() === ch)
      if (exists) continue
      if (ephemeralCount >= MAX_EPHEMERAL_TABS) break
      ephemeralCount++
      config.channels.push({ id: `auto_${ch}`, twitch: ch, ephemeral: true })
      try {
        irc?.join?.(ch)
      } catch (_) {}
      // load the channel's third-party emote sets (bttv/ffz/7tv) — without
      // this, everyone else's channel emotes render as raw text on auto-tabs
      // (own emotes still worked: inventory is global). same call the
      // manual add-channel path makes; bg caches+TTLs duplicates.
      safeSendMessage({ type: 'join_channel', platform: 'twitch', channel: ch })
      changed = true
    }
    if (changed) {
      _channelLookup = null
      try {
        updateTabBar()
      } catch (_) {}
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
    const relevant =
      (config?.channels || []).some(
        (c) => (c?.twitch && c.twitch.toLowerCase() === chLc) || (c?.kick && c.kick.toLowerCase() === chLc),
      ) ||
      (typeof getCurrentChannel === 'function' && (getCurrentChannel() || '').toLowerCase() === chLc)
    if (!relevant) return
    const key = `${d.platform}:${d.channel}`
    const now = Date.now()
    if (now - (_momentSeen.get(key) || 0) < 10 * 60_000) return
    _momentSeen.set(key, now)
    if (_momentSeen.size > 200) {
      const k0 = _momentSeen.keys().next().value
      _momentSeen.delete(k0)
    }
    injectInlineNotif('moment', {
      type: 'moment',
      momentId: d.id != null ? String(d.id) : null,
      momentChannel: d.channel,
      momentPlatform: d.platform || 'twitch',
      text: `${d.channel} chat is exploding — ${d.rate} msgs/30s (usually ~${Math.max(1, Math.round(d.baseline))})`,
      color: '#fff',
      time: now,
    })
  }

  // Inject an inline notification into active chat tabs
  function injectInlineNotif(notifType, msg, opts = {}) {
    // opts.force — receipts for something YOU just did (posting from chat)
    // aren't notifications about other people, so the per-type toggle that
    // silences other users' feed posts must not also silence your own.
    if (!inlineNotifs[notifType] && !opts.force) return
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
      const buffer = (twitchName && irc?.channels?.get(twitchName)) || (kickName && kickChat?.channels?.get(kickName))
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
    const isChatTab = active === 'live' || active === 'mentions' || config.channels.some((ch) => ch.id === active)
    if (isChatTab) appendMessage(msg, active)
  }

  // Font family + size — mirrors heatsync.org's appearance picker.
  // CozetteVector is the bundled bitmap font (chrome/fonts/);
  // 'monospace' uses host system, 'custom' uses settings.customFontName.
  // Apply via CSS vars on #hs-mc-container so storage.onChanged can flip
  // it live without rebuilding the panel.
  function resolveFontStack(family, customName) {
    if (family === 'monospace') return 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    if (family === 'twitch') return "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif"
    if (family === 'custom') {
      const name = (customName || '').trim()
      if (name) return `'${name.replace(/'/g, '')}', 'Courier New', monospace`
    }
    return "'CozetteVector', 'Courier New', monospace"
  }
  function applyFontSettings(fontFamily, fontSize, customFontName) {
    // Migrate the removed GohuFont option → Cozette. Users who had it selected
    // keep a crisp bitmap font instead of stranding on a now-missing face.
    if (fontFamily === 'GohuFont') fontFamily = 'CozetteVector'
    // Bitmap-font mode flag — kills AA + faux-bold + hinting for crisp
    // pixel-grid rendering. CozetteVector only ships a single 400 master,
    // so any font-weight ≥500 in CSS would otherwise synthesize a blurry
    // bold. .hs-font-bitmap rule in styles.js sets font-synthesis:none.
    // Toggle on body+root FIRST (always available) — reply-stack/notif
    // overlays mount to <body> outside the container, so body is the
    // authoritative carrier. Container toggle below is belt-and-braces.
    // A bitmap face is crisp on its own pixel grid and nowhere else.
    // CozetteVector renders whole only at 13px and its 2x, 26px — every other
    // size resamples the glyphs and smears them, which is why "cozette looks
    // bad sometimes" was never about cozette. The size control accepted 10-22,
    // i.e. eleven sizes that cannot render and one that can.
    //
    // So the grid is part of choosing the font, the way it is for any pixel
    // face: pick cozette and the size snaps to the nearest size cozette HAS.
    // Snapping rather than switching typeface behind the user's back — family
    // is the deliberate aesthetic choice, size is comfort, so we honour the
    // choice and correct the thing that cannot be honoured. A user who wants a
    // size off the grid picks a vector font and gets exactly that size.
    // One policy, shared with the settings UI and the site: font-grid.js.
    fontSize = snapSize(fontFamily, fontSize)
    const isBitmap = isBitmapFamily(fontFamily) || !fontFamily
    document.body.classList.toggle('hs-font-bitmap', isBitmap)
    document.documentElement.classList.toggle('hs-font-bitmap', isBitmap)
    // Set the vars on :root FIRST, unconditionally — the panel often mounts
    // AFTER settings load (the load-time applier ran with no container), so a
    // non-default size used to silently fall back to 13px until the user poked
    // a setting. :root always exists and the panel inherits from it, so the
    // size lands on the first paint. Container writes below are belt-and-braces.
    const stack = resolveFontStack(fontFamily, customFontName)
    const root = document.documentElement
    root.style.setProperty('--hs-mc-font', stack)
    const sizeNum = parseInt(fontSize, 10)
    if (sizeNum >= 10 && sizeNum <= 26) {
      // One synced size drives both the panel chrome and the message area —
      // the old per-device override (F+/F-) folded into this setting.
      root.style.setProperty('--hs-mc-base-size', `${sizeNum}px`)
      root.style.setProperty('--hs-chat-font', `${sizeNum}px`)
    }
    const container = document.getElementById('hs-mc-container')
    if (!container) return
    container.style.setProperty('--hs-mc-font', stack)
    container.classList.toggle('hs-font-bitmap', isBitmap)
    if (sizeNum >= 10 && sizeNum <= 26) {
      container.style.setProperty('--hs-mc-base-size', `${sizeNum}px`)
      container.style.setProperty('--hs-chat-font', `${sizeNum}px`)
      const msgsEl = document.getElementById('hs-mc-messages')
      if (msgsEl) msgsEl.style.setProperty('--hs-chat-font', `${sizeNum}px`)
    }
  }

  // Platform filters — per-tab toggle to mute Twitch/Kick/YT messages.
  // Persisted to chrome.storage.local (overflow bucket); never enters sync.
  // Self-prunes here: only keep entries for tabs this user actually has now.
  async function loadPlatformFilters() {
    try {
      const overflow = await cachedUiOverflow()
      let stored = overflow.platform_filters
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
        // One-shot migration: pull from sync if a legacy install still has it.
        const legacy = await cachedUiSettings()
        if (legacy.ui_settings?.platformFilters && typeof legacy.ui_settings.platformFilters === 'object') {
          stored = legacy.ui_settings.platformFilters
          chrome.storage.local.set({ platform_filters: stored }).catch(() => {})
        }
      }
      if (stored && typeof stored === 'object') {
        // Drop entries for tab IDs we no longer have — bounded growth.
        const knownIds = new Set((config.channels || []).map((c) => c.id))
        const pruned = {}
        for (const [id, val] of Object.entries(stored)) {
          if (knownIds.has(id) && val && typeof val === 'object') pruned[id] = val
        }
        platformFilters = pruned
      }
    } catch {}
  }

  function getPlatformFilter(tabId) {
    const f = platformFilters[tabId] || {}
    return { twitch: f.twitch !== false, kick: f.kick !== false, youtube: f.youtube !== false }
  }

  function togglePlatformFilter(tabId, plat) {
    const f = getPlatformFilter(tabId)
    f[plat] = !f[plat]
    platformFilters[tabId] = f
    saveUiSetting('platformFilters', platformFilters)
  }

  function isPlatformFilterTab(tabId) {
    return tabId === 'live' || config.channels.some((c) => c.id === tabId)
  }

  function renderPlatformFilterButtons() {
    const group = document.getElementById('hs-mc-platfilter')
    if (!group) return
    while (group.firstChild) group.removeChild(group.firstChild)
    const tab = currentTab
    if (!isPlatformFilterTab(tab)) return // empty container hides via :empty CSS

    // Determine which platforms apply to this tab. Read config.channels
    // directly (cached lookup can lag a beat behind mutations) and treat an
    // unknown tab as no-platforms — never offer filters a tab can't use.
    let hasTwitch = true,
      hasKick = true,
      hasYt = true
    if (tab !== 'live') {
      const ch = config.channels.find((c) => c.id === tab)
      if (!ch) return
      hasTwitch = !!ch.twitch
      hasKick = !!ch.kick
      hasYt = !!ch.youtube
    }

    // Single-platform tab — filter is degenerate, leave container empty
    const activePlatforms = [hasTwitch, hasKick, hasYt].filter(Boolean).length
    if (activePlatforms < 2) return

    const filt = getPlatformFilter(tab)
    const meta = [
      { key: 'twitch', label: 'T', show: hasTwitch },
      { key: 'kick', label: 'K', show: hasKick },
      { key: 'youtube', label: 'Y', show: hasYt },
    ]

    // No text label — the twin T K Y clusters are told apart by style +
    // place: this view filter is OUTLINE and lives in the tab strip; send
    // chips are FILLED and sit at the composer. Tooltips carry the words.
    for (const p of meta) {
      if (!p.show) continue
      const btn = document.createElement('button')
      btn.className = `hs-mc-pf-btn hs-mc-pf-${p.key}`
      btn.dataset.platform = p.key
      btn.classList.toggle('off', !filt[p.key])
      btn.textContent = p.label
      btn.title = `${(filt[p.key] ? 'Hide ' : 'Show ') + p.key} messages`
      btn.addEventListener('click', () => {
        togglePlatformFilter(currentTab, p.key)
        const on = getPlatformFilter(currentTab)[p.key]
        btn.classList.toggle('off', !on)
        btn.title = `${(on ? 'Hide ' : 'Show ') + p.key} messages`
        renderMessages(currentTab)
      })
      group.appendChild(btn)
    }
  }

  // Tab subsystems — a disabled subsystem hides its tab affordance too
  const _TAB_SUBSYSTEM = { feed: 'feed', whispers: 'whispers', mentions: 'mentions' }
  function applyHiddenTabs() {
    if (!tabBarElement) return
    for (const id of HIDABLE_TABS) {
      const btn = tabBarElement.querySelector(`.hs-mc-tab[data-tab="${id}"]`)
      const subOff = _TAB_SUBSYSTEM[id] && !isEnabled(_TAB_SUBSYSTEM[id])
      if (btn) btn.style.display = hiddenTabs.has(id) || subOff ? 'none' : ''
    }
    const curOff = _TAB_SUBSYSTEM[currentTab] && !isEnabled(_TAB_SUBSYSTEM[currentTab])
    if (hiddenTabs.has(currentTab) || curOff) switchTab('live')
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
        .map((c) => (c.twitch || '').toLowerCase().trim())
        .filter((ch) => {
          if (!ch || seen.has(ch)) return false
          seen.add(ch)
          return true
        })
      for (let i = 0; i < channels.length; i++) {
        if (!autoClaimPoints) break
        const ch = channels[i]
        try {
          const r = await fetchChannelRewards(ch)
          if (r?.availableClaim && r.channelId) {
            await claimCommunityPoints(r.availableClaim, r.channelId, ch)
          }
        } catch (_) {}
        if (i < channels.length - 1) await new Promise((res) => setTimeout(res, 2000))
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

  // One-shot per videoId: ask BG to turn a bare videoId into the channel's
  // @handle (oEmbed, cached there) so a watch-URL tab gets a real name. Both
  // outcomes are recorded — a video that can't resolve (private, deleted,
  // rate-limited) must not re-fetch on every tab repaint.
  const _ytLabelTried = new Set()
  function resolveYtTabLabel(chId, videoId) {
    if (!videoId || _ytLabelTried.has(videoId)) return
    _ytLabelTried.add(videoId)
    safeSendMessage({ type: 'yt_channel_handle', videoId })
      .then((r) => {
        const handle = r?.handle
        if (!handle) return
        const prev = youtubeLinks.get(chId) || {}
        if (prev.channelName === handle) return
        youtubeLinks.set(chId, { ...prev, channelName: handle })
        updateTabBar()
      })
      .catch(() => {})
  }

  function updateTabBar() {
    if (!tabBarElement) return

    // Clear existing channel tabs (keep built-in tabs). NOTE: the exclusion list
    // must cover EVERY util button or this strips it — native + actions live in
    // the util-row (createTabBar) with their own data-tab, so without excluding
    // them updateTabBar (runs on every channel load) silently removes the ⇄ / ⚡
    // buttons right after they render. That was "BUG 1: ⇄ missing on kick".
    const existingChannelTabs = tabBarElement.querySelectorAll(
      '.hs-mc-tab[data-tab]:not([data-tab="live"]):not([data-tab="feed"]):not([data-tab="mentions"]):not([data-tab="whispers"]):not([data-tab="discover"]):not([data-tab="pinned"]):not([data-tab="modlog"]):not([data-tab="add"]):not([data-tab="settings"]):not([data-tab="popout"]):not([data-tab="collapse"]):not([data-tab="native"]):not([data-tab="actions"]):not([data-tab="subscribe"])',
    )
    existingChannelTabs.forEach((t) => {
      t.remove()
    })

    // Add channel tabs before the + button in the scroll section
    const scrollSection = tabBarElement.querySelector('.hs-mc-tabs-scroll') || tabBarElement
    const addBtn = scrollSection.querySelector('[data-tab="add"]')
    config.channels.forEach((ch) => {
      const tab = document.createElement('button')
      tab.className = ch?.ephemeral ? 'hs-mc-tab hs-mc-tab-auto' : 'hs-mc-tab'
      tab.setAttribute('role', 'tab')
      tab.setAttribute('aria-selected', 'false')
      if (ch?.ephemeral) tab.title = 'open in another window — tab disappears when that window closes'
      const id = ch.id
      tab.dataset.tab = id
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
        else {
          // Adding a channel by pasting a /watch?v= link lands here: no
          // @handle in the URL, and channelName only ever gets filled by a
          // youtube_status for a stream that's actually connected — so an
          // offline one kept this fallback forever and the tab read
          // "watch?v=VGe-dpUmnos". Resolve the handle off the videoId once
          // (BG already does this via oEmbed for the subscribe path) and
          // repaint. Until it lands, show the video id alone rather than the
          // URL guts.
          const vid = ch.youtube.match(/[?&]v=([\w-]{11})|\/live\/([\w-]{11})/)
          const videoId = vid ? vid[1] || vid[2] : ''
          label = videoId || ch.youtube.replace(/^https?:\/\/(www\.)?youtube\.com\//, '').replace(/\/.*$/, '')
          if (videoId) resolveYtTabLabel(ch.id, videoId)
        }
      }
      tab.textContent = label
      // Restore live dot from cached liveChannelSet (survives tab recreate).
      // Check BOTH twitch and kick slugs — a Kick-only channel or a paired
      // channel whose twitch handle differs from its kick slug would otherwise
      // miss the dot. SW followed snapshot already populates kick slugs into
      // liveChannelSet at line ~8908.
      if (liveChannelSet.size > 0) {
        const tw = ch.twitch?.toLowerCase()
        const ki = ch.kick?.toLowerCase()
        const idLower = ch.id?.toLowerCase()
        const isLive = isChannelLive(tw) || isChannelLive(ki) || (!tw && !ki && isChannelLive(idLower))
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
      if (addBtn) addBtn.before(tab)
      else scrollSection.appendChild(tab)
    })

    // Update active state
    tabBarElement.querySelectorAll('.hs-mc-tab').forEach((t) => {
      setTabActive(t, t.dataset.tab === currentTab)
    })

    applyHiddenTabs()
    // The tabs above were rebuilt from scratch and their labels written with
    // textContent, which drops the counter chip — repaint it, or the number
    // vanishes on every live-status poll and channel edit.
    refreshTabCounters()
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
      log('Cannot patch - no render method')
      return false
    }

    const inst = component.instance
    if (inst._hs_multichat_patched) {
      log('Already patched')
      return true
    }

    originalRender = inst.render.bind(inst)

    inst.render = () => {
      const result = originalRender()

      // If result is null or not an object, return as-is
      if (!result || typeof result !== 'object') return result

      // Clone the result to avoid mutating React's internals
      // We'll inject our tab bar at the top level
      // Elements are in #hs-mc-container (outside React's tree)
      // so no need to re-inject on every render

      return result
    }

    inst._hs_multichat_patched = true
    log('✅ Patched chat room render')

    // Force initial re-render
    if (typeof inst.forceUpdate === 'function') {
      inst.forceUpdate()
    }

    return true
  }

  /**
   * FFZ-style: Fix chat column transform bug
   * Twitch applies translateX(-34rem) even when --expanded class is set
   * We fix this persistently via multiple layers
   */

  // Layer 1: CSS override (always active, catches most cases)
  function injectTransformOverrideCss() {
    if (document.getElementById('hs-chat-transform-fix')) return
    const style = document.createElement('style')
    style.id = 'hs-chat-transform-fix'
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
    `
    document.head.appendChild(cleanup.trackNode(style))
    log('✅ Injected chat column CSS fixes')
  }

  // Fix inline transform that Twitch's CSS-in-JS sets on the inner column.
  // CSS rule handles the class-based override; this catches inline style overrides.
  function fixChatTransform() {
    const expanded = document.querySelector('.channel-root__right-column--expanded')
    if (!expanded) return false

    const transform = expanded.style.transform || getComputedStyle(expanded).transform
    if (transform && transform !== 'none') {
      expanded.style.setProperty('transform', 'none', 'important')
      return true
    }
    return false
  }

  // Layer 3: Watch for class/style changes on BOTH column elements
  let columnObserver = null
  function startColumnClassWatcher() {
    if (columnObserver) return // Already watching

    const inner = document.querySelector('.channel-root__right-column')
    const outer = document.querySelector('.right-column.right-column--beside')

    if (!inner && !outer) return

    columnObserver = cleanup.trackObserver(
      new MutationObserver(() => {
        // When class/style changes, fix both elements
        cleanup.raf(() => {
          fixChatTransform()
          applyChatWidth()
          // Re-render after expand — container was display:none while collapsed
          const rightCol = document.querySelector('.right-column')
          if (rightCol && !rightCol.classList.contains('right-column--collapsed')) {
            ensureUIElements()
            renderMessages(currentTab)
          }
        }, 'column-transform-fix')
      }),
      'column-class-watcher',
    )

    const config = { attributes: true, attributeFilter: ['class', 'style'] }

    if (inner) columnObserver.observe(inner, config)
    if (outer) columnObserver.observe(outer, config)

    log('✅ Started column watchers (inner + outer)')
  }

  // Polling removed — CSS rule + MutationObserver handle all cases.
  // The 500ms polling was redundant and caused layout fighting.

  function ensureChatColumnVisible() {
    // CSS override + observer (no polling, no parent walking)
    injectTransformOverrideCss()
    startColumnClassWatcher()

    // One-time fix for current state
    fixChatTransform()

    // Return the chat column for injection purposes
    return (
      document.querySelector('[data-a-target="right-column-chat-bar"]') ||
      document.querySelector('.channel-root__right-column')
    )
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
    // Keep a live reference: twitch commits the chat-shell unmount BEFORE
    // pushState on some SPA transitions (channel → /directory), so by the time
    // the nav event fires the panel is detached and invisible to
    // getElementById. softTwitchNav re-adopts this node with its state intact.
    _hsMcContainerNode = container
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
        const frameWatch = new MutationObserver(() => {
          if (hideYtFrame()) frameWatch.disconnect()
        })
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
      mcSignal.addEventListener(
        'abort',
        () => {
          const f = document.querySelector('ytd-live-chat-frame#chat[data-hs-hidden]')
          if (f) {
            f.style.display = f.dataset.hsPrevDisplay || ''
            delete f.dataset.hsHidden
            delete f.dataset.hsPrevDisplay
          }
          if (container && container.parentElement === document.body) {
            container.remove()
          }
        },
        { once: true },
      )
    } else if (isKick) {
      if (chatRoom) {
        parent = chatRoom.parentElement
        chatRoom.after(container)
        // Same teardown contract as the body-mount branches: without it,
        // disabling/reloading the extension strands a zombie panel in kick's DOM.
        mcSignal.addEventListener(
          'abort',
          () => {
            if (container?.isConnected) container.remove()
          },
          { once: true },
        )
      } else {
        // No #channel-chatroom on this Kick URL (browse, settings, search,
        // categories, …) — body-mount as a position:fixed overlay via the
        // hs-kick-no-channel CSS rules. Same teardown contract as Twitch.
        parent = document.body
        parent.appendChild(container)
        mcSignal.addEventListener(
          'abort',
          () => {
            if (container && container.parentElement === document.body) container.remove()
          },
          { once: true },
        )
      }
    } else {
      // Twitch: prefer chat-shell on channel pages (preserves theatre/persistent
      // -player layout). Fall back to <body> on non-channel pages (directory,
      // settings, videos, …) where chat-shell doesn't exist — panel becomes a
      // position:fixed overlay via the hs-twitch-no-channel CSS rules.
      const chatShell =
        document.querySelector('.chat-shell') || document.querySelector(CONFIG.SELECTORS.TWITCH_CHAT_SHELL)
      if (chatShell) {
        parent = chatShell
        parent.appendChild(container)
        mcSignal.addEventListener(
          'abort',
          () => {
            if (container?.isConnected) container.remove()
          },
          { once: true },
        )
      } else {
        parent = document.body
        parent.appendChild(container)
        mcSignal.addEventListener(
          'abort',
          () => {
            if (container && container.parentElement === document.body) container.remove()
          },
          { once: true },
        )
      }
    }
    log('Created #hs-mc-container in', `${parent.tagName}.${[...parent.classList].join('.')}`)
    // Reposition the unified resize handle now that the container has a real
    // rect. On no-chat pages (Twitch /directory etc) applyChatPosition fired
    // before this point with cont=null, so the handle was stranded at 0,0.
    requestAnimationFrame(() => {
      try {
        positionChatResizeHandle()
      } catch (_) {}
    })
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
  let _lastSurfacedCallout = null
  const CALLOUT_QUEUE_SEL = '[data-test-selector="chat-private-callout-queue__callout-container"]'

  // Twitch's callout tokens are base64 of "<userId>:<channelId>:<count>:<kind>"
  // (kind = "cumulative" for a sub anniversary). Decoding is the validation:
  // nothing else on the page base64-decodes to that exact shape, so a match is
  // the token by construction — no prop name to guess and nothing to re-learn
  // when twitch renames its components.
  const CALLOUT_TOKEN_SHAPE = /^(\d+):(\d+):(\d+):([a-z_]+)$/i
  function decodeCalloutToken(raw) {
    if (typeof raw !== 'string' || raw.length < 16 || raw.length > 200) return null
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null
    let plain
    try {
      plain = atob(raw)
    } catch {
      return null
    }
    const m = CALLOUT_TOKEN_SHAPE.exec(plain)
    if (!m) return null
    return { raw, userId: m[1], channelId: m[2], count: Number(m[3]), kind: m[4].toLowerCase() }
  }

  // Once-per-day rate-limit on the watch-streak share UI. Twitch sometimes
  // re-shows the callout if you reload the tab mid-stream; cap our surfacing
  // at one per channel per local-day so it never feels spammy.
  function _watchstreakDayKey(channel) {
    const d = new Date()
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return `hs-watchstreak-shared:${channel}:${ymd}`
  }
  function _watchstreakAlreadySharedToday(channel) {
    try {
      return !!localStorage.getItem(_watchstreakDayKey(channel))
    } catch (_) {
      return false
    }
  }
  function _markWatchstreakSharedToday(channel) {
    try {
      localStorage.setItem(_watchstreakDayKey(channel), '1')
    } catch (_) {}
  }
  function _injectShareSynthetic(claim, user, months, customText) {
    const synthId = `hs-synth-share-${claim.channel}-${months}-${Date.now()}`
    claim.synthId = synthId
    claim.customText = customText || ''
    const synth = {
      type: 'usernotice',
      msgId: 'resub',
      user,
      text: customText || '',
      systemMsg: `${user} is celebrating ${months} months as a subscriber!`,
      color: '#fff',
      badges: ownBadgesFor(claim.channel) || '',
      channel: claim.channel,
      time: Date.now(),
      subTier: '1',
      subMonths: months,
      giftCount: 0,
      recipient: '',
      raidViewers: 0,
      raidFrom: '',
      announceColor: '',
      bitsTier: 0,
      id: synthId,
      isSynthetic: true,
      userOverride: !!customText,
    }
    try {
      irc?._handleMsg?.(synth)
    } catch (_) {}
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
    try {
      input.focus()
    } catch (_) {}
    if (_resubShareModeTimer) cleanup.clearTimeout(_resubShareModeTimer)
    _resubShareModeTimer = cleanup.setTimeout(() => _exitResubShareMode(claim, true), 30000)
  }
  function _exitResubShareMode(claim, fireFallback, silent) {
    if (claim && _resubShareCtx?.claim !== claim) return
    const wasCtx = _resubShareCtx
    _resubShareCtx = null
    if (_resubShareModeTimer) {
      cleanup.clearTimeout(_resubShareModeTimer)
      _resubShareModeTimer = null
    }
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
    showToast(t('mc_main_celebration_share_failed'), 'error')
    if (!text) return
    try {
      const token = getTwitchAuthToken()
      if (token) {
        const res = await sendIrcMessage(channel, text, token)
        if (res === true || res === 'queued') return
      }
    } catch (_) {}
    showToast(t('mc_main_message_not_sent'), 'error')
  }

  // Programmatic-click escape hatch so consume() can fire the native Twitch
  // Share button without our own surface() hook re-entering share-mode.
  let _allowNativeShare = false
  // Exposed for input.js sendMessage: consume typed text as resub-share body.
  // .enter() is called directly by the HsNotifs Share button — bypasses the
  // native Twitch click which would insta-send a default celebration message.
  // Resub/watchstreak token scan. Module scope, NOT inside surface(): the notif
  // click path re-runs it when the token it was emitted with is missing. The
  // callout is emitted the moment it is detected, and the event payload lives in
  // contextMenu.props.children.props.event — a subtree React may not have mounted
  // yet. Measured on a live 107mo callout: the payload was absent from the notif
  // but sitting at BFS step 46 minutes later, so the extension fell through to
  // twitch's own button every time, which posts twitch's default celebration and
  // drops the custom message. Re-scanning at click time is correct whether the
  // cause was that race or a root that never reached the payload.
  /**
   * Does this scan hold the token for the callout we think it does?
   *
   * The count is months for a sub anniversary and streams for a watch streak,
   * which is why the scan reports a generic `count` — an `out.months` read as
   * `scan.count` is undefined, silently false, and disables the whole path.
   * That shipped once. Every gate goes through here now.
   */
  function calloutTokenMatches(scan, expect) {
    if (!scan?.token) return false
    if (!expect) return true
    if (expect.kind !== undefined && scan.kind !== expect.kind) return false
    if (expect.count !== undefined && scan.count !== expect.count) return false
    return true
  }

  function fiberTokenScan(rootEl) {
    if (typeof getFiber !== 'function' || !rootEl) return null
    const out = { token: null, channelId: null, count: 0, kind: null }
    const root = getFiber(rootEl)
    if (!root) return out
    // Breadth-first over the callout's own subtree. Twitch carries the token as
    // the React *key* of the element it renders the callout from — measured
    // live on a 107-month callout, two fibers below the queue container. It is
    // not a prop under any name, which is why every earlier scan came back
    // empty and the whole share flow fell through to twitch's own button. That
    // button hands the celebration to twitch's composer, which heatsync has
    // replaced, so the share never completed and the callout came back on the
    // next reload.
    // Children + siblings only: from the container there is nothing above worth
    // walking, and climbing turns a two-step lookup into a walk of the whole
    // chat tree.
    //
    // The ROOT's siblings are the exception — they are the other callouts in
    // the queue (a sub anniversary and a watch streak mount side by side), each
    // carrying its own token. Following them would hand back a neighbour's
    // token, which the caller cannot tell apart from its own.
    const queue = [root]
    const seen = new WeakSet()
    let steps = 0
    while (queue.length && steps < 400 && !out.token) {
      const f = queue.shift()
      if (!f || seen.has(f)) continue
      seen.add(f)
      steps++
      const tok = decodeCalloutToken(f.key)
      if (tok) {
        out.token = tok.raw
        out.channelId = tok.channelId
        out.count = tok.count
        out.kind = tok.kind
        break
      }
      if (f.child) queue.push(f.child)
      if (f !== root && f.sibling) queue.push(f.sibling)
    }
    return out
  }

  /**
   * Hand a callout token back to twitch with the user's own words as the
   * celebration body. This is the whole point of taking the click: twitch's own
   * Share button only puts twitch's composer into share-mode, and heatsync has
   * replaced that composer, so the native path can never finish the job.
   *
   * One mutation serves every callout kind — the resolver is
   * `useChatNotificationToken`, and the token says which callout is being
   * consumed. Throws on rejection so both callers can rescue the typed text
   * into plain chat; a rejected token comes back HTTP 200 with an errors[]
   * entry and a null field, so "no exception" is not "it worked".
   */
  async function _consumeCalloutToken(channel, token, text) {
    const data = await gqlProxy('Chat_ShareResub_UseResubToken', {
      input: { message: text || '', channelLogin: channel, includeStreak: false, tokenID: token },
    })
    const errs =
      (Array.isArray(data?.errors) && data.errors.length ? data.errors : null) ||
      (data?.data && data.data.useChatNotificationToken === null ? [{ message: 'token rejected' }] : null)
    if (errs) throw new Error(JSON.stringify(errs).slice(0, 200))
  }

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
      try {
        _injectShareSynthetic(claim, user, months, text || '')
      } catch (_) {}
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
        const liveBtn = document.querySelector(
          `${CALLOUT_QUEUE_SEL} [data-a-target="chat-private-callout__primary-button"]`,
        )
        const btn = liveBtn || claim._nativeShareBtn
        if (!btn || typeof getFiber !== 'function') return false
        try {
          let f = getFiber(btn)
          for (let i = 0; f && i < 10; i++, f = f.return) {
            const oc = f?.memoizedProps?.onClick
            if (typeof oc === 'function') {
              oc({
                preventDefault() {},
                stopPropagation() {},
                persist() {},
                currentTarget: btn,
                target: btn,
                nativeEvent: { isTrusted: true },
                type: 'click',
                button: 0,
                buttons: 0,
              })
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
        try {
          clicked = nativeClickFallback()
        } catch (_) {}
        showToast(clicked ? t('mc_main_no_share_token') : t('mc_main_share_unavailable'), 'error')
        return false
      }

      // Token path: instant exit, GQL in the background. Any failure rescues
      // the typed text into plain chat — the user's words must never silently
      // vanish. The optimistic synthetic is NOT re-injected here: step 1 above
      // already ran unconditionally, and _injectShareSynthetic stamps a fresh
      // Date.now() id and pushes a new row every call, so doing it twice put
      // two identical celebrations in the sharer's own view.
      _exitResubShareMode(claim, false)
      ;(async () => {
        try {
          await _consumeCalloutToken(claim.channel, claim.resubToken, text)
          log('resub-share: GQL fired ok')
        } catch (e) {
          console.warn('[heatsync-ext] resub-share GQL failed:', e?.message || e)
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
        const claim = {
          channel,
          userLc: (user || '').toLowerCase(),
          months,
          synthId: null,
          postTimer: null,
          customText: '',
          _nativeShareBtn: _lastSurfacedShareBtn,
          resubToken: resubToken || null,
        }
        _pendingShareClaim = claim
        _enterResubShareMode(claim, user, months)
      } catch (_) {}
    },
    /**
     * Re-scan for the resub token at CLICK time. The notif carries whatever the
     * scan found when the callout was first detected, and that can be nothing —
     * the payload lives in a React subtree that may not be mounted yet. By the
     * time a human clicks share, it always is. Returns the base64 tokenID
     * (<userId>:<channelId>:<months>:cumulative) or null.
     */
    rescanToken: (rootEl, expect) => {
      try {
        // Scan the callout we were HANDED. Reaching for
        // querySelector(CALLOUT_QUEUE_SEL) takes the first container in the
        // DOM, which is a different callout whenever a sub anniversary and a
        // watch streak are queued together — the same cross-callout mixup the
        // scan itself refuses to make by not following the root's siblings.
        if (rootEl?.isConnected) {
          const scan = fiberTokenScan(rootEl)
          if (calloutTokenMatches(scan, expect)) return scan.token
          return null
        }
        // Detached: twitch re-rendered the queue under us and a detached fiber
        // still hands back its stale key. Re-find the live callout by asking
        // each one whether it is ours — that is what `expect` is for.
        for (const el of document.querySelectorAll(CALLOUT_QUEUE_SEL)) {
          const scan = fiberTokenScan(el)
          if (calloutTokenMatches(scan, expect)) return scan.token
        }
        return null
      } catch (_) {
        return null
      }
    },
    // Internal: surface()'s native-button hook reads this to know whether to
    // block the click (user-initiated) or pass through (programmatic from us).
    _allowNativeShare: () => _allowNativeShare,
    /**
     * Fire twitch's own share button, with our interceptor standing down for
     * the duration. Used when we have no genuine resub token: twitch's flow is
     * then the only one that can actually consume it, so ours gets out of the
     * way rather than half-completing. Mirrors tryDomClick's sequence — a bare
     * .click() alone does not always satisfy their handler.
     */
    clickNative: (btn) => {
      if (!btn) return false
      try {
        _allowNativeShare = true
        try {
          const opts = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 }
          btn.dispatchEvent(new MouseEvent('mousedown', opts))
          btn.dispatchEvent(new MouseEvent('mouseup', opts))
          btn.dispatchEvent(new MouseEvent('click', opts))
          btn.click()
        } finally {
          _allowNativeShare = false
        }
        return true
      } catch (_) {
        return false
      }
    },
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
      type: 'usernotice',
      msgId: 'watchstreak',
      user,
      text: customText || '',
      systemMsg: `${user} watched ${streakCount} streams in a row — watch streak`,
      color: '#fff',
      badges: ownBadgesFor(claim.channel) || '',
      channel: claim.channel,
      time: Date.now(),
      subTier: '',
      subMonths: 0,
      giftCount: 0,
      recipient: '',
      raidViewers: 0,
      raidFrom: '',
      announceColor: '',
      bitsTier: 0,
      streakCount,
      id: synthId,
      isSynthetic: true,
      userOverride: !!customText,
    }
    try {
      irc?._handleMsg?.(synth)
    } catch (_) {}
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
    try {
      input.focus()
    } catch (_) {}
    if (_watchstreakShareModeTimer) cleanup.clearTimeout(_watchstreakShareModeTimer)
    _watchstreakShareModeTimer = cleanup.setTimeout(() => _exitWatchstreakShareMode(claim, true), 30000)
  }
  function _exitWatchstreakShareMode(claim, fireFallback, silent) {
    if (claim && _watchstreakShareCtx?.claim !== claim) return
    const wasCtx = _watchstreakShareCtx
    _watchstreakShareCtx = null
    if (_watchstreakShareModeTimer) {
      cleanup.clearTimeout(_watchstreakShareModeTimer)
      _watchstreakShareModeTimer = null
    }
    if (wasCtx && !silent) {
      try {
        window.HsNotifs?.dismissByKey?.(
          'twitch-watchstreak-share',
          `watchstreak:${wasCtx.claim.channel}:${wasCtx.streakCount}`,
        )
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
      try {
        _injectWatchstreakSynthetic(claim, user, streakCount, text || '')
      } catch (_) {}
      const broadcastShare = () => {
        const liveBtn = document.querySelector(
          `${CALLOUT_QUEUE_SEL} [data-a-target="chat-private-callout__primary-button"]`,
        )
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
                  preventDefault() {},
                  stopPropagation() {},
                  persist() {},
                  currentTarget: btn,
                  target: btn,
                  nativeEvent: { isTrusted: true },
                  type: 'click',
                  button: 0,
                  buttons: 0,
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
            } finally {
              _allowNativeShare = false
            }
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
      // With a token we can finish the share ourselves, body and all — same
      // path the sub anniversary takes. Without one, fall back to clicking
      // twitch's button and letting the typed text go out as ordinary chat,
      // which is all this flow could ever do before.
      if (claim.streakToken) {
        _exitWatchstreakShareMode(claim, false)
        ;(async () => {
          try {
            await _consumeCalloutToken(claim.channel, claim.streakToken, text)
            // Marked only once it landed. A failed share leaves the day
            // unspent so a reload can offer it again — twitch never consumed
            // the token, so the callout is still there to offer.
            _markWatchstreakSharedToday(claim.channel)
            log('watchstreak-share: GQL fired ok')
          } catch (e) {
            console.warn('[heatsync-ext] watchstreak-share GQL failed:', e?.message || e)
            await _resubShareTextRescue(claim.channel, text)
          }
        })()
        // true = the typed text IS the celebration body, so sendMessage stops
        // here rather than posting it a second time as a plain message.
        return true
      }
      try {
        broadcastShare()
      } catch (e) {
        console.warn('[heatsync-ext] watchstreak-share broadcast outer threw:', e)
      }
      _markWatchstreakSharedToday(claim.channel)
      _exitWatchstreakShareMode(claim, false)
      return false
    },
    enter: (streakCount, user, channel, streakToken) => {
      try {
        if (_pendingShareClaim) {
          cleanup.clearTimeout(_pendingShareClaim.postTimer)
        }
        const claim = {
          kind: 'watchstreak',
          channel,
          userLc: (user || '').toLowerCase(),
          streakCount,
          synthId: null,
          postTimer: null,
          customText: '',
          _nativeShareBtn: _lastSurfacedShareBtn,
          streakToken: streakToken || null,
        }
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

      // Capture twitch's callout token from the callout subtree. It is what
      // Chat_ShareResub_UseResubToken takes as input.tokenID, and it decodes to
      // "<userId>:<channelId>:<count>:<kind>". Scan the container, never the
      // button: the token sits two fibers under the container, while from the
      // button the same breadth-first walk fans out across the chat tree
      // without ever reaching it.
      const scan = fiberTokenScan(calloutEl) || {}

      // Watch-streak first (text mentions "watch streak"); resub fallback (only
      // "N month" — without "watch streak"). Order matters: a watch-streak
      // callout never mentions months, but a sub-anniversary may incidentally
      // contain "stream", so explicit watchstreak check wins.
      const isWatchstreak = /watch[\s-]*streak/i.test(txt)
      const streakMatch = isWatchstreak ? txt.match(/(\d+)\s*stream/i) : null
      const streakCount = streakMatch ? parseInt(streakMatch[1], 10) : 0
      const monthMatch = !isWatchstreak ? txt.match(/(\d+)\s*month/i) : null
      const months = monthMatch ? parseInt(monthMatch[1], 10) : 0

      if (isWatchstreak && streakCount) {
        if (_watchstreakAlreadySharedToday(ch)) {
          calloutEl.dataset.hsSurfaced = '1'
          return
        }
        calloutEl.dataset.hsSurfaced = '1'
        // A watch-streak token counts streams where a resub token counts
        // months; the kind string differs and we never assume it. If the count
        // does not match the callout, we hold no token and the flow stays on
        // twitch's own button exactly as before.
        const streakToken = calloutTokenMatches(scan, { count: streakCount }) ? scan.token : null
        if (shareBtn && shareBtn.dataset.hsShareHooked !== '1') {
          shareBtn.dataset.hsShareHooked = '1'
          shareBtn.addEventListener(
            'click',
            (e) => {
              if (_allowNativeShare) return
              e.stopImmediatePropagation()
              e.preventDefault()
              try {
                if (_pendingShareClaim) {
                  cleanup.clearTimeout(_pendingShareClaim.postTimer)
                }
                const claim = {
                  kind: 'watchstreak',
                  channel: ch,
                  userLc: user.toLowerCase(),
                  streakCount,
                  synthId: null,
                  postTimer: null,
                  customText: '',
                  _nativeShareBtn: shareBtn,
                  streakToken,
                }
                _pendingShareClaim = claim
                _enterWatchstreakShareMode(claim, user, streakCount)
              } catch (_) {}
            },
            { capture: true },
          )
        }
        _lastSurfacedShareBtn = shareBtn || null
        _lastSurfacedCallout = calloutEl
        try {
          HsNotifs.emit('twitch-watchstreak-share', {
            streakCount,
            user,
            channel: ch,
            _nativeShareBtn: shareBtn,
            _nativeCallout: calloutEl,
            _streakToken: streakToken,
          })
        } catch (_) {}
        try {
          _updateMcLayout?.()
        } catch (_) {}
        return
      }

      if (!months) return
      calloutEl.dataset.hsSurfaced = '1'
      // Only take the click when the token we hold is genuinely this callout's:
      // the months it encodes must match the months the callout announces. A
      // token is never guessed or reconstructed — a wrong one fails the
      // mutation, and the failure path posts the typed text as ordinary chat,
      // which reads as success while twitch never marks the resub shared, so
      // the callout returns on every reload. Without a token we do not
      // intervene at all; a silent half-success is worse than not helping.
      const resubToken = calloutTokenMatches(scan, { kind: 'cumulative', count: months }) ? scan.token : null
      const hasRealToken = !!resubToken
      if (hasRealToken && shareBtn && shareBtn.dataset.hsShareHooked !== '1') {
        shareBtn.dataset.hsShareHooked = '1'
        shareBtn.addEventListener(
          'click',
          (e) => {
            if (window.__hsResubShare?._allowNativeShare?.()) return
            e.stopImmediatePropagation()
            e.preventDefault()
            try {
              if (_pendingShareClaim) {
                cleanup.clearTimeout(_pendingShareClaim.postTimer)
              }
              const claim = {
                kind: 'resub',
                channel: ch,
                userLc: user.toLowerCase(),
                months,
                synthId: null,
                postTimer: null,
                customText: '',
                _nativeShareBtn: shareBtn,
                resubToken,
              }
              _pendingShareClaim = claim
              _enterResubShareMode(claim, user, months)
            } catch (_) {}
          },
          { capture: true },
        )
      }
      _lastSurfacedShareBtn = shareBtn || null
      _lastSurfacedCallout = calloutEl
      try {
        HsNotifs.emit('twitch-resub-share', {
          months,
          user,
          channel: ch,
          _nativeShareBtn: shareBtn,
          _nativeCallout: calloutEl,
          // Only ever a token twitch handed us. Downstream reads its absence
          // as "we cannot finish this" and routes the click to twitch's own
          // button instead of half-completing.
          _resubToken: resubToken,
        })
      } catch (_) {}
      try {
        _updateMcLayout?.()
      } catch (_) {}
    }
    // Twitch removed `.pinned-callout` in a recent refactor — the callout body
    // now lives directly under the queue container. Surface every container;
    // surface() reads text + Share button via descendant selectors and self-
    // gates with dataset.hsSurfaced='1'. Multiple callouts (e.g. resub +
    // watch-streak) can fire as siblings inside the queue parent — we must
    // observe each on first touch and the parent of any we see so subsequent
    // siblings are caught.
    document.querySelectorAll(CALLOUT_QUEUE_SEL).forEach((c) => {
      if (c.querySelector('*')) surface(c)
    })
    let _narrowedTo = null
    const _narrowIfPossible = (calloutEl) => {
      const parent = calloutEl?.parentElement
      if (!parent || _narrowedTo === parent) return
      _narrowedTo = parent
      try {
        _hsCalloutCloseObs.disconnect()
      } catch (_) {}
      // Observe the queue PARENT (not the callout itself) — sibling callouts
      // added later land as direct children and fire childList mutations here.
      _hsCalloutCloseObs.observe(parent, { childList: true, subtree: true })
    }
    _hsCalloutCloseObs = new MutationObserver((muts) => {
      // While un-narrowed this observes document.body — our own overlay appends
      // (every chat row) land here too. Callouts are twitch DOM and can never
      // appear inside the overlay, so batches entirely within it are noise.
      const _ov = document.getElementById('hs-mc-overlay')
      if (_ov) {
        let outside = false
        for (const m of muts) {
          if (!_ov.contains(m.target)) {
            outside = true
            break
          }
        }
        if (!outside) return
      }
      // Surface ALL currently-present callouts on any mutation — the
      // dataset.hsSurfaced guard makes this idempotent.
      for (const c of document.querySelectorAll(CALLOUT_QUEUE_SEL)) {
        if (c.querySelector('*')) surface(c)
      }
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue
          if (node.matches?.(CALLOUT_QUEUE_SEL)) {
            if (node.querySelector('*')) surface(node)
            _narrowIfPossible(node)
          } else if (node.querySelector) {
            node.querySelectorAll(CALLOUT_QUEUE_SEL).forEach((c) => {
              if (c.querySelector('*')) surface(c)
              _narrowIfPossible(c)
            })
          }
        }
      }
    })
    const initialCallouts = document.querySelectorAll(CALLOUT_QUEUE_SEL)
    if (initialCallouts.length > 0) {
      _narrowIfPossible(initialCallouts[0])
    } else {
      _hsCalloutCloseObs.observe(document.body, { childList: true, subtree: true })
    }
    cleanup.trackObserver(_hsCalloutCloseObs)
  }

  function ensureUIElements() {
    // Re-assert the stylesheet — twitch SPA navigations can sweep injected
    // <style> tags from <head>, leaving a remounted overlay fully unstyled
    // (raw text flow). injectStyles is idempotent (id check), so this is a
    // getElementById per call when healthy.
    try {
      injectStyles()
    } catch (_) {}

    // Always watch for collapse/expand class changes so we can clean up
    // inline styles when the user clicks the expand arrow
    if (hostPlatform !== 'yt') startColumnClassWatcher()

    // Don't fight Twitch when chat is collapsed — let the native expand arrow work
    if (hostPlatform !== 'yt') {
      const rightCol = document.querySelector('.right-column')
      const collapsed = rightCol?.classList.contains('right-column--collapsed')
      if (collapsed) return
      // Make sure chat column is visible (only when expanded)
      ensureChatColumnVisible()
    }

    // Find the React-controlled chat room
    let chatRoom
    if (hostPlatform === 'yt') {
      chatRoom =
        document.querySelector('#chat-container') ||
        document.querySelector('ytd-live-chat-frame#chat')?.parentElement ||
        document.querySelector('#secondary')
    } else if (isKick) {
      chatRoom = document.getElementById('channel-chatroom') || document.querySelector('[id*="chatroom"]')
    } else {
      chatRoom =
        document.querySelector('[class*="chat-room__content"]') ||
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
      const existing = document.getElementById('hs-mc-tabbar')
      if (existing) {
        tabBarElement = existing
        log('Reclaimed existing tab bar')
      } else {
        tabBarElement = createTabBar()
        updateTabBar()
        if (!liveStatusInterval) startLiveStatusPolling()
        log('Created tab bar')
      }
    }
    if (!container.contains(tabBarElement)) {
      container.insertBefore(tabBarElement, container.firstChild)
      log('Inserted tab bar into container')
    }

    // Ensure overlay exists
    if (!overlayElement || !document.contains(overlayElement)) {
      const existing = document.getElementById('hs-mc-overlay')
      if (existing) {
        overlayElement = existing
        log('Reclaimed existing overlay')
      } else {
        overlayElement = createOverlay()
        log('Created overlay')
      }
    }
    if (!container.contains(overlayElement)) {
      container.appendChild(overlayElement)
      log('Injected overlay into container')
    }

    // Ensure emote picker panel exists (between overlay and inputbar)
    let pickerEl = document.getElementById('hs-mc-emote-picker')
    if (!pickerEl) {
      pickerEl = document.createElement('div')
      pickerEl.id = 'hs-mc-emote-picker'
    }
    if (!container.contains(pickerEl)) {
      container.appendChild(pickerEl)
    }

    // Ensure input bar exists
    if (!inputBarElement || !document.contains(inputBarElement)) {
      inputBarElement = createInputBar()
      // Start hidden — typing reveals it (never in the pop-out: it stays put +
      // focused). A rebuild with a draft pending (twitch swapped the container
      // mid-typing) must stay visible, or the restored draft hides with the
      // bar and reads as "my message got eaten".
      if (!tabAcceptsInput(currentTab) || (canAutoHideInput() && !pendingMessage.trim())) {
        inputBarElement.classList.add('hs-hidden')
        inputBarVisible = false
      } else {
        // Born visible — say so. A rebuild during the keepComposerOpen window
        // (or with a draft pending) left the flag on its pre-rebuild `false`
        // while the fresh bar carried no hs-hidden class, and that stranded
        // combination is unrecoverable on its own: hideInputBar() bails on the
        // flag, so the empty bar stays up until something types into it.
        inputBarVisible = true
      }
      log('Created input bar')
    }
    if (!container.contains(inputBarElement)) {
      container.appendChild(inputBarElement)
      log('Injected input bar into container')

      // Wire handlers + restore the draft NOW — createInputBar defers its own
      // initInput behind setTimeout(0), and keystrokes landing in that gap
      // bypass pendingMessage tracking (the draft then vanishes on the next
      // rebuild). initInput is idempotent, so the deferred call no-ops.
      initInput()
      // Restore pending message if any (skip if initInput already did, or the
      // user typed into the fresh input first — never clobber live content)
      const input = document.getElementById('hs-mc-input')
      if (input && pendingMessage && !(input.value || input.textContent || '').trim()) {
        if (input.isContentEditable) input.textContent = pendingMessage
        else input.value = pendingMessage
      }
    }

    // Adjust overlay/inputbar/tabbar geometry based on actual tabbar+inputbar
    // dimensions — handles multi-row tabbar wrapping AND vertical tab columns.
    // Single source of truth so CSS hardcodes don't drift from real layout.
    let _lastMcLayoutSig = ''
    _updateMcLayout = () => {
      if (!tabBarElement || !overlayElement) return
      // Panel width (chat + tab strip) drives the chat-left player inset via
      // --hs-panel-w. Publish it here — this runs on cold-load layout and via
      // the tab/input ResizeObserver — so the inset is correct before the
      // first drag-resize (which was previously the only thing that set it).
      publishPanelWidth()
      const tabRect = tabBarElement.getBoundingClientRect()
      const tw = tabRect.width
      const th = tabRect.height
      const ih = inputBarElement ? inputBarElement.getBoundingClientRect().height : 0
      // No-op when nothing that drives the insets changed. The ResizeObserver
      // fires on every inputbar box mutation — while TYPING in the wysiwyg
      // composer that's every keystroke, and the remove+reapply below
      // invalidates layout for the whole overlay each time (visible churn on
      // the rows above the composer). Signature covers every input the
      // positioning + HsNotifs geometry read.
      const _containerEl = document.getElementById('hs-mc-container')
      // Search-bar visibility feeds the statusbar layer's top offset — include
      // it in the signature or a mentions↔chat tab hop with identical channel
      // sets would skip the recompute and leave the toast strip misanchored.
      const _searchVis = document.getElementById('hs-mc-search-bar')?.classList.contains('visible') ? 1 : 0
      const _sig = `${tabPosition}|${tw}|${th}|${ih}|${_searchVis}|${_containerEl ? _containerEl.offsetHeight : 0}|${[...getActiveViewedChannels()].join(',')}`
      if (_sig === _lastMcLayoutSig) return
      _lastMcLayoutSig = _sig

      // Reset before re-applying to avoid stale rules between transitions
      for (const el of [overlayElement, inputBarElement, tabBarElement]) {
        if (!el) continue
        el.style.removeProperty('top')
        el.style.removeProperty('bottom')
        el.style.removeProperty('left')
        el.style.removeProperty('right')
      }

      if (tabPosition === 'top') {
        if (th > 0) overlayElement.style.top = `${th}px`
        overlayElement.style.bottom = `${ih}px`
      } else if (tabPosition === 'bottom') {
        overlayElement.style.top = '0px'
        overlayElement.style.bottom = `${th + ih}px`
        // Park tabbar directly above inputbar
        if (tabBarElement) tabBarElement.style.bottom = `${ih}px`
      } else if (tabPosition === 'right') {
        overlayElement.style.top = '0px'
        overlayElement.style.bottom = `${ih}px`
        if (tw > 0) {
          overlayElement.style.right = `${tw}px`
          if (inputBarElement) inputBarElement.style.right = `${tw}px`
        }
      } else if (tabPosition === 'left') {
        overlayElement.style.top = '0px'
        overlayElement.style.bottom = `${ih}px`
        if (tw > 0) {
          overlayElement.style.left = `${tw}px`
          if (inputBarElement) inputBarElement.style.left = `${tw}px`
        }
      }

      // Recompute geometry for ALL HsNotifs layers in one place. Each layer's
      // CSS vars (--hs-layer-*-{top|left|right|bottom}) drive its container's
      // CSS positioning. Adding a new layer = registerLayer + matching CSS.
      const containerEl = document.getElementById('hs-mc-container')
      try {
        HsNotifs.updateLayout({
          overlayElement,
          inputBarElement,
          tabBarElement,
          containerElement: containerEl,
          tabPosition,
          activeChannels: getActiveViewedChannels(),
        })
      } catch (_) {}

      // An open picker mirrors the message list's box exactly — re-measure it
      // here, the one place that knows the chat body just moved (tab bar grew a
      // row, composer shown/hidden, tab position rotated).
      syncPickerBox()
    }

    // Re-observe on every pass, not just the first. The bug this fixes: the tab
    // bar is `flex-wrap: wrap` with a max-height, so during boot it measures
    // ~307px while still wrapped to five rows, then settles to 55px a moment
    // later. The ResizeObserver that should catch that shrink was created once
    // behind a `!resizeObserver` guard — so after any rebuild it was pointed at
    // a DETACHED tab bar, the shrink never fired _updateMcLayout, and the
    // overlay kept the boot-time inset for the rest of the session: ~510px of
    // chat instead of ~828px, with 318px of dead space under it.
    if (tabBarElement && overlayElement) {
      const watch = inputBarElement ? [tabBarElement, inputBarElement] : [tabBarElement]
      const stale = !resizeObserver || watch.length !== _roWatched.length || watch.some((el, i) => el !== _roWatched[i])
      if (stale) {
        if (resizeObserver) cleanup.untrackObserver(resizeObserver)
        resizeObserver = new ResizeObserver(_updateMcLayout)
        for (const el of watch) resizeObserver.observe(el)
        cleanup.trackObserver(resizeObserver)
        _roWatched = watch
      }
      // Always recompute: a rebuild gives _updateMcLayout a fresh closure with
      // an empty _lastMcLayoutSig, and the fresh tab/input nodes carry none of
      // the inline insets the old ones had.
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
      overlayElement.classList.add('visible')
      if (!currentTab) {
        currentTab = 'live'
        if (tabBarElement) {
          tabBarElement.querySelectorAll('.hs-mc-tab').forEach((t) => {
            setTabActive(t, t.dataset.tab === 'live')
          })
        }
      }
      renderMessages(currentTab)
      log('Auto-showed overlay on load')
    }
    // Always reveal container — when overlay is reclaimed (SPA persist /
    // re-mount), the visible-gated branch above is skipped and the
    // container would stay at opacity:0. Idempotent — no-ops when no prepaint.
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

    // Ensure native chat is hidden when our UI is active — unless the user
    // toggled the escape-hatch (nativeVisible), in which case keep it shown.
    if (!nativeVisible) setNativeChatHidden(true)
  }

  // ============================================
  // TAB/CHANNEL MANAGEMENT
  // ============================================

  // Tab id → the surface name the server counts (site-stats.ts EXT_SURFACES),
  // reported from switchTab because that is the one choke point every surface
  // change goes through.
  //
  // Only the social surfaces and "is using chat at all" are named. The tabs
  // below are deliberately uncounted — they say nothing about whether anyone
  // reaches the social layer, which is the only question this measures. Any id
  // that is neither is a channel tab (the SPECIAL set in renderTabs is the
  // other half of this list) and means multichat is in use.
  const _UNCOUNTED_TABS = new Set(['discover', 'pinned', 'modlog', 'add', 'settings'])
  function _reportSurfaceOpen(id) {
    const surface =
      id === 'feed'
        ? 'feed'
        : id === 'whispers'
          ? 'dm'
          : id === 'mentions'
            ? 'mentions'
            : _UNCOUNTED_TABS.has(id)
              ? null
              : 'multichat'
    if (!surface) return
    // Never awaited and never retried past safeSendMessage's own backoff: a
    // counter must not be able to delay or break a tab switch.
    try {
      safeSendMessage({ type: 'hs_surface_open', surface })
    } catch (_) {}
  }

  function switchTab(id) {
    log('switchTab called:', id)
    _reportSurfaceOpen(id)
    // Leaving an edit form: drop the outgoing tab's cache and clear msgsEl so
    // the upcoming snapshotTabState doesn't capture the form (which would then
    // be restored when switching back to the same channel id and look like
    // "save didn't exit").
    if (editingChannel) {
      _dropTabCache(currentTab)
      const _msgsEl = document.getElementById('hs-mc-messages')
      if (_msgsEl) _msgsEl.textContent = ''
    }
    editingChannel = false
    // Bulk-select is per-tab: leaving a tab clears the selection + action bar so
    // it can never persist invisibly into another channel and fire there.
    try {
      if (typeof exitBulkSelectMode === 'function') exitBulkSelectMode()
    } catch (_) {}
    // Tab switch is the user telling us they care about live state right
    // now — kick a debounced refresh so any stale red dots on channel tabs
    // get corrected without waiting up to 30s for the next poll cycle.
    try {
      refreshLiveStatusSoon()
    } catch {}
    // Tab switch closes profile card without re-rendering (we'll render the tab below)
    if (typeof activeProfileCard !== 'undefined' && activeProfileCard) activeProfileCard = null

    // Clicking feed tab (relabeled "back") while in thread view → close the
    // thread. If we entered from a channel tab, return THERE, not the feed —
    // switchTab(rt) with currentTab still 'feed' also runs the thread-cleanup
    // block below (nulls activeThread, resets the feed tab label). Otherwise
    // just close and stay on the feed.
    if (id === 'feed' && currentTab === 'feed' && activeThread) {
      if (threadReturnTab && threadReturnTab !== 'feed') {
        const rt = threadReturnTab
        threadReturnTab = null
        switchTab(rt)
      } else {
        closeThread()
      }
      return
    }

    // Close thread view when leaving feed
    if (currentTab === 'feed' && id !== 'feed') {
      activeThread = null
      _clearFeedReplyChip()
      const feedTabBtn = tabBarElement?.querySelector('[data-tab="feed"]')
      if (feedTabBtn) feedTabBtn.textContent = t('mc_tab_feed')
    }
    if (currentTab !== 'settings') prevTab = currentTab
    // Snapshot the outgoing tab's DOM into the cache so a future switch back
    // restores it instantly (no rebuild). Skipped for static tabs which manage
    // their own DOM. Must run BEFORE currentTab flips.
    snapshotTabState(currentTab)
    currentTab = id
    _scrollbackWindow = 0 // new tab starts at the live tail, not prior scrollback depth
    markTabSeen(id)

    // Update settings button icon: X when settings open, cog otherwise
    if (tabBarElement) {
      const settingsBtn = tabBarElement.querySelector('[data-tab="settings"]')
      if (settingsBtn) settingsBtn.textContent = id === 'settings' ? '✕' : '⚙'
    }
    updatePopoutBtnVisibility()
    updateSubBtnVisibility()

    // Channel/tab switch flips which channel-emote cache the picker reads —
    // mark cache dirty + queue idle prebuild for the new context.
    markPickerDirty()
    prebuildPickerIdle()

    // Mark mentions as seen when switching to that tab
    if (id === 'mentions') {
      bumpSeen('mentions')
      updateTabBadges()
    }
    if (id === 'feed') bumpSeen('live')

    // Search bar: server search on mentions, instant local filter on live/channel tabs.
    const searchBar = document.getElementById('hs-mc-search-bar')
    if (searchBar) searchBar.classList.toggle('visible', id === 'mentions' || isLiveSearchTab(id))
    // Reset the query on tab switch so a live filter doesn't bleed across
    // channels; placeholder reflects the active mode.
    const _searchInputEl = document.getElementById('hs-mc-search-input')
    if (_searchInputEl) {
      _searchInputEl.value = ''
      _searchInputEl.placeholder = isLiveSearchTab(id) ? 'filter — /regex/ or @user' : 'search messages…'
    }
    const _searchCountEl = document.getElementById('hs-mc-search-count')
    if (_searchCountEl) _searchCountEl.classList.remove('visible')

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
      } catch (_) {
        /* context invalidated */
      }
    }

    // Refresh platform filter buttons for the new tab
    renderPlatformFilterButtons()
    renderSendTargetChips()

    // Update tab bar active state
    if (tabBarElement) {
      const liveCh = getLiveChannel()?.toLowerCase()
      tabBarElement.querySelectorAll('.hs-mc-tab').forEach((t) => {
        setTabActive(t, t.dataset.tab === id)
        if (t.dataset.tab === id) {
          t.classList.remove('has-new')
          t.classList.remove('has-stream-event')
          t.classList.remove('has-mentions')
          clearTabUnread(t.dataset.tab)
        }
        // Switching to live also clears the matching channel tab's indicators
        if (id === 'live' && liveCh && t.dataset.tab !== 'live') {
          const ch = getChannelById(t.dataset.tab)
          if (ch) {
            const tw = ch.twitch?.toLowerCase()
            const ki = ch.kick?.toLowerCase()
            if (tw === liveCh || ki === liveCh) {
              t.classList.remove('has-new', 'has-stream-event', 'has-mentions')
              clearTabUnread(t.dataset.tab)
            }
          }
        }
        // Switching to a channel tab that matches live clears the live tab too
        if (id !== 'live' && liveCh && t.dataset.tab === 'live') {
          const ch = getChannelById(id)
          if (ch) {
            const tw = ch.twitch?.toLowerCase()
            const ki = ch.kick?.toLowerCase()
            if (tw === liveCh || ki === liveCh) {
              t.classList.remove('has-new', 'has-stream-event', 'has-mentions')
              clearTabUnread(t.dataset.tab)
            }
          }
        }
      })
      // One repaint after the sweep — the loop above may have cleared several
      // tabs, and the newly-active tab's own count has to drop to nothing.
      refreshTabCounters()
    }

    // Update live tab label when switching to it
    if (id === 'live') updateLiveTabLabel()

    // Reset scroll state BEFORE rendering - always start at bottom when switching tabs
    isScrolledUp = false
    newMessageCount = 0
    const newBtn = document.getElementById('hs-mc-new-msgs')
    if (newBtn) newBtn.style.display = 'none'

    // Native chat always hidden — multichat handles all tabs including live on Kick

    // Hide input bar on add-channel form, or when auto-hide is on
    if (inputBarElement) {
      const pickerOpen = document.getElementById('hs-mc-emote-picker')?.classList.contains('visible')
      // No send target on this tab ⇒ no composer, auto-hide setting or not.
      if (!tabAcceptsInput(id)) {
        inputBarElement.classList.add('hs-hidden')
        inputBarVisible = false
      } else if (autoHideEligible() && !pickerOpen) {
        // Eligibility WITHOUT the keepComposerOpen time window: a tab switch
        // isn't the rapid-fire send flow, and force-showing here during the
        // window left an empty bar stuck (nothing re-hides until a later blur).
        const input = document.getElementById('hs-mc-input')
        const hasContent =
          input &&
          ((input.value || input.textContent || '').trim().length > 0 || input.querySelector('img, span.hs-mc-emoji'))
        if (hasContent) {
          inputBarElement.classList.remove('hs-hidden')
          inputBarVisible = true
        } else {
          inputBarElement.classList.add('hs-hidden')
          inputBarVisible = false
        }
      } else {
        inputBarElement.classList.remove('hs-hidden')
        inputBarVisible = true
      }
    }

    if (overlayElement) {
      overlayElement.classList.add('visible')
      // Overlay bottom inset is NOT written here. _updateMcLayout (called at
      // the end of switchTab) owns it, measured from the real inputbar box.
      // Clearing it here dropped the overlay to the stylesheet's 52px
      // fallback, and the layout recompute then skipped the repair (its
      // signature — tab/input sizes — is unchanged by a tab switch), leaving
      // a dead band between the last message and the composer.
      // Restore cached fragment for the incoming tab if we have one. The
      // existing renderMessages diff then operates against pre-painted DOM —
      // it re-adds whatever arrived while the tab was inactive.
      restoreTabState(id)
      renderMessages(id)
    } else {
      log('No overlay element to show!')
    }

    // Update input placeholder for new tab
    updateInputPlaceholder()

    // Hide native chat when our overlay is active (unless user chose nativeVisible)
    if (!nativeVisible) setNativeChatHidden(true)

    // Refresh HsNotifs channel scope so per-channel callouts (resub-share,
    // watchstreak) hide when leaving their channel's tab and reappear when
    // returning. Layout call piggybacks on the existing recompute path.
    try {
      _updateMcLayout?.()
    } catch (_) {}
  }

  // Render-success gate for native-tap.js's suppression decision (point 1)
  // and this file's own dead-man watchdog (below). Flips true only after a
  // full ensureUIElements/switchTab/startLayoutWatcher pass completes without
  // throwing — see the waitForMount/tryHookReact call sites. A throw resets
  // it to false so both mechanisms fail open to native chat being visible.
  let _hsOverlayRenderOk = false
  // Set only by the dead-man watchdog below, cleared the moment a mount pass
  // proves the overlay healthy again. Distinguishes "we forced native chat
  // back" from "the user asked for it" — only the former may be re-armed.
  let _watchdogForcedNative = false
  function _markOverlayRenderOk(ok) {
    _hsOverlayRenderOk = !!ok
    // A confirmed mount pass after the watchdog fired means the overlay came
    // good. Re-hide native chat ONCE so a transient boot stall doesn't cost the
    // takeover until reload. If the overlay is genuinely broken this never runs
    // (the pass has to complete without throwing), and if it stalls again the
    // watchdog simply fires again 15s later — the pair self-corrects.
    if (ok && _watchdogForcedNative) {
      _watchdogForcedNative = false
      try {
        setNativeChatHidden(true)
      } catch (_) {}
    }
    try {
      if (typeof setOverlayRenderOk === 'function') setOverlayRenderOk(!!ok)
    } catch (_) {}
    // A successful mount pass proves this boot didn't hit the failure loop —
    // reset early-layout.js's pre-arm retry budget so the NEXT load gets a
    // clean slate (see chrome/early-layout.js's takeoverArms gate).
    if (ok) {
      try {
        localStorage.setItem('hs_layout_takeoverArms', '0')
      } catch (_) {}
    }
  }

  // Runs one ensureUIElements/switchTab/startLayoutWatcher mount pass. These
  // used to run unguarded with `done=true` set beforehand — a throw anywhere
  // in the triplet left the overlay container present but empty AND native
  // chat already hidden, with nothing to ever undo either. Any throw here
  // must fail OPEN: mark render-not-ok (native-tap.js stops suppressing),
  // force native chat visible again, and clear the takeover mirror so
  // early-layout.js's next-load pre-arm doesn't re-arm suppression blind.
  function _runOverlayMountPass(label, fn) {
    try {
      fn()
      _markOverlayRenderOk(true)
    } catch (e) {
      console.warn('[heatsync-ext] overlay mount pass threw:', label, e?.message || e)
      _markOverlayRenderOk(false)
      try {
        setNativeChatHidden(false)
      } catch (_) {}
      try {
        localStorage.setItem('hs_layout_nativeTakeover', '0')
      } catch (_) {}
    }
  }

  // Dead-man switch for setNativeChatHidden(true): once `.hs-native-hidden`
  // was applied it persisted regardless of whether the overlay kept
  // rendering. Poll the heartbeat native-tap.js writes (hsSuppressBeat) plus
  // our own render-success flag; force native chat back the moment either
  // goes stale so it VISUALLY returns, not just resumes internal message
  // flow. Twitch-only — that's the only platform the suppress dataset and
  // native-tap.js apply to.
  let _nativeHiddenWatchdogStarted = false
  function startNativeHiddenWatchdog() {
    if (_nativeHiddenWatchdogStarted || hostPlatform !== 'twitch') return
    _nativeHiddenWatchdogStarted = true
    cleanup.setInterval(() => {
      const ds = document.body?.dataset
      if (ds?.hsSuppressNative !== '1') return
      const beat = parseInt(ds.hsSuppressBeat, 10)
      const stale = !Number.isFinite(beat) || Date.now() - beat > 45000
      if (!stale && _hsOverlayRenderOk) return
      // Say WHICH condition tripped and by how much. The old line named both
      // and committed to neither, so a correct fire (slow cold boot, tap not
      // started yet — working as designed) was indistinguishable from a
      // spurious one on a healthy overlay. One occurrence should be enough to
      // tell them apart, because this is not reproducible on demand.
      const age = Number.isFinite(beat) ? `${Math.round((Date.now() - beat) / 1000)}s` : 'never-written'
      const rows = document.getElementById('hs-mc-messages')?.childElementCount ?? -1
      console.warn(
        `[heatsync-ext] native-hidden watchdog: restoring native chat — beat=${age} stale=${stale} renderOk=${_hsOverlayRenderOk} overlayRows=${rows}`,
      )
      // Remember that WE revealed native chat, not the user. Without this the
      // reveal latches forever: _updateNativeSuppress (native-tap.js) only
      // suppresses while native chat is invisible, so our own remedy trips the
      // "user revealed native chat" guard and suppression can never resume —
      // one 45s timing blip cost the takeover for the rest of the page load.
      _watchdogForcedNative = true
      setNativeChatHidden(false)
      ds.hsSuppressNative = '0'
      try {
        localStorage.setItem('hs_layout_nativeTakeover', '0')
      } catch (_) {}
    }, 15000)
  }

  /**
   * Toggle native Twitch chat visibility (FFZ-style)
   * Adds class to parent container rather than relying on :has() selector
   */
  function setNativeChatHidden(hidden) {
    if (isKick) {
      // Kick selectors
      const chatroom = document.getElementById('channel-chatroom') || document.querySelector('[id*="chatroom"]')
      if (chatroom) chatroom.classList.toggle('hs-native-hidden', hidden)
      return
    }

    // Twitch: Add class to chat-shell (outermost container)
    const chatShell =
      document.querySelector('.chat-shell') || document.querySelector(CONFIG.SELECTORS.TWITCH_CHAT_SHELL)
    if (chatShell) {
      chatShell.classList.toggle('hs-native-hidden', hidden)
    }

    // Add class to chat-room__content (where our elements are injected)
    const chatRoom =
      document.querySelector('[class*="chat-room__content"]') ||
      document.querySelector('[data-a-target="chat-room-component"]')
    if (chatRoom) {
      chatRoom.classList.toggle('hs-native-hidden', hidden)
    }

    // Also try stream-chat for popout mode
    const streamChat =
      document.querySelector('.stream-chat') || document.querySelector(CONFIG.SELECTORS.TWITCH_STREAM_CHAT)
    if (streamChat) {
      streamChat.classList.toggle('hs-native-hidden', hidden)
    }
  }

  function updateTabBadges() {
    refreshSeenBadges()
    if (!tabBarElement) return
    const mentionsTab = tabBarElement.querySelector('[data-tab="mentions"]')
    if (mentionsTab && mentionsTab.textContent !== 'mentions') mentionsTab.textContent = 'mentions'
  }

  // Dedup helper: check against actual message buffers (survives WS reconnects)
  function isYtDuplicate(user, text, channelId, id) {
    const needle = `${user}:${text.slice(0, 50)}`
    // When both sides carry the server's innertube id, identity is exact —
    // same id = duplicate, different id = genuinely repeated text (a user
    // legitimately spamming the same line must NOT be collapsed). Only the
    // id-less legacy path falls back to the user:text heuristic.
    const isDup = (m) => (id && m.id ? m.id === id : `${m.user}:${(m.text || '').slice(0, 50)}` === needle)
    // Pace queue FIRST: duplicates re-delivered inside the 60-400ms pacing
    // window used to race past the committed-buffer check below, then drain
    // sequentially — the "3 identical copies in a row" bug.
    const q = _ytPaceQueue.get(channelId)
    if (q) {
      for (const m of q) if (isDup(m)) return true
    }
    const buf = channelYtMessages.get(channelId)
    if (!buf || buf.length === 0) return false
    // check last 200 messages in buffer (matches server recentMessages cap)
    const start = Math.max(0, buf.length - 200)
    for (let i = buf.length - 1; i >= start; i--) {
      if (isDup(buf[i])) return true
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
      const viewerCanPostSub =
        isOwn || (viewerBadges && (viewerBadges.has('subscriber') || viewerBadges.has('founder')))
      for (const [name, url] of Object.entries(m.twitchEmotes)) {
        let state = 'locked'
        if (viewerCanPostSub) state = 'global'
        else {
          const alt = typeof lookupEmote === 'function' ? lookupEmote(name) : null
          if (alt && (alt.state === 'owned' || alt.state === 'global' || alt.state === 'channel')) state = 'global'
        }
        // Key by the HTML-ESCAPED name: processEmotes below receives
        // escapeHtml(m.text), so its per-word lookups see escaped tokens.
        // Native emote names can contain HTML specials (`<3`, `:-&` style
        // smilies) — a raw-name key never matches `&lt;3` and the emote
        // renders as text. escapeHtml is identity for names without specials.
        twitchExtra.set(escapeHtml(name), { url, source: 'twitch', state, zeroWidth: false })
      }
    }
    // Sender-perma emote resolution: own → viewerPersonalEmotes, others →
    // senderEmoteSets["plat:uid"] (lazy-fetched, perma cached).
    let senderEmotes = null
    const senderKey = resolveSenderEmoteKey(m)
    if (isOwn) {
      // Honest wysiwyg: the local owned set is only truthful when the identity
      // this message was sent under resolves to the signed-in HS account —
      // otherwise render exactly what other viewers get (usually plain text)
      // and warn, instead of showing the sender an emote nobody else sees.
      // hsSenderKeys null (old server / logged out) fails open to old behavior.
      if (senderKey && Array.isArray(hsSenderKeys) && !hsSenderKeys.includes(senderKey)) {
        senderEmotes = getSenderEmotes(senderKey)
        queueSenderEmoteFetch(senderKey, m)
        warnIdentityMismatch(senderKey)
      } else {
        senderEmotes = viewerPersonalEmotes
      }
    } else if (senderKey) {
      senderEmotes = getSenderEmotes(senderKey)
      queueSenderEmoteFetch(senderKey, m)
    }
    // skipMentions=true: highlightMentionsInHtml (below) is the single source
    // of truth for mention anchors on this surface (uid resolution, HeatSync
    // paint/7TV precedence, letter-split). Letting processEmotes ALSO wrap
    // "@name" in its own plain <a> here would produce a nested <a>…<a>…</a></a>
    // — invalid HTML5 that browsers "fix" by auto-closing the outer anchor
    // empty, leaving a permanently blank username node next to its painted
    // sibling. See processEmotes' skipMentions doc comment (emotes.js).
    // m.emoteChannel: explicit channel-emote cache key for messages whose
    // channel is display-only (yt-only config channels + yt auto-live key by
    // config id / videoId, not a twitch/kick name). See social.js ytEmoteKey.
    // Server-enriched third-party refs (name→{url,provider,zeroWidth}) for THIS
    // message. Keyed by ESCAPED name so it matches processEmotes' per-word
    // lookups against escapeHtml(m.text) (mirrors twitchExtra above). Renders
    // the sender's inventory emotes without any per-sender fetch.
    let hsMsgRefs = null
    if (m.hsEmotes && typeof m.hsEmotes === 'object') {
      for (const name in m.hsEmotes) {
        const r = m.hsEmotes[name]
        if (!r) continue
        // cw stub — server hid a filter-flagged emote for THIS viewer and sent
        // {name, cw} with no url (mirrors background.js's get_sender_emotes
        // stub handling, see cw-stub-passthrough.test.js). `!r.url` alone used
        // to drop these entirely, so the name fell through to the next lookup
        // tier (sender/global cache) and rendered the REAL image — exactly the
        // leak the server-side cw filter exists to stop. Keep the stub so
        // processEmotes' emote.cw check (emotes.js ~3879) paints the
        // dashed-cyan placeholder instead of nothing.
        const isStub = !r.url && typeof r.cw === 'string' && r.cw
        if (!r.url && !isStub) continue
        ;(hsMsgRefs ||= new Map()).set(escapeHtml(name), {
          url: r.url || '',
          source: r.provider || 'heatsync',
          state: isStub ? 'cw' : 'global',
          zeroWidth: !!r.zeroWidth,
          cw: isStub ? r.cw : null,
          // own-inventory cw annotation — camelCase to match hsOwnCwHiddenCat's
          // reader (emotes.js); the server sends cw_cats snake_case.
          cwCats: Array.isArray(r.cw_cats) && r.cw_cats.length ? r.cw_cats : null,
          nsfw: !!r.nsfw,
        })
      }
    }
    // Own messages: fall back to click-pasted refs (never rolled back) so an
    // emote you pasted from someone else's message renders in your echo even if
    // the auto-add-on-send commit failed. Own-only — clickPastedRefs is keyed by
    // escaped name and carries {url,source,state,zeroWidth} already.
    if (isOwn && typeof clickPastedRefs !== 'undefined' && clickPastedRefs.size) {
      for (const [k, v] of clickPastedRefs) {
        if (!(hsMsgRefs ||= new Map()).has(k)) hsMsgRefs.set(k, v)
      }
    }
    let processedText = processEmotes(
      escapeHtml(m.text),
      m.emoteChannel || m.channel,
      twitchExtra,
      senderEmotes,
      m.time,
      true,
      hsMsgRefs,
    )
    if (m.emotes && m.emotes.length > 0) {
      processedText = processYtEmotes(processedText, m.emotes, true)
    }
    // Safety net: strip any remaining escaped HTML img tag fragments that leaked through.
    if (processedText.includes('&lt;img')) {
      processedText = processedText.replace(/&lt;img\b[^<]*/g, '')
    }
    // Highlight mentions AFTER emote processing so emote-name <img> tags aren't touched.
    processedText = highlightMentionsInHtml(processedText, m.platform)
    // Magenta #hashtags — mirrors the feed (renderFeedContent) so tags read the same everywhere.
    processedText = highlightHashtagsInHtml(processedText)
    // Yellow >>id thread references — links a HeatSync thread from inside platform
    // chat, mirroring the feed's >>id convention. Click opens the thread in the
    // overlay (wired per-row in buildMessageDiv), not a new tab.
    processedText = highlightThreadRefsInHtml(processedText)
    // Partial/defanged links ("watch?v=…", "heatsync (dot) org") — html
    // post-pass, skips existing anchors/tags. Rides the links master toggle.
    if (linksEnabled && partialLinksEnabled) {
      processedText = linkifyPartialLinks(processedText)
    }
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
      const newState = blockedEmoteNames.has(name) ? 'blocked' : inventoryEmotes.has(name) ? 'owned' : 'global'
      if (w.dataset.state !== newState) {
        w.classList.remove(
          'hs-state-owned',
          'hs-state-unadded',
          'hs-state-blocked',
          'hs-state-global',
          'hs-state-channel',
        )
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
    // Snapshot rows ONCE — DOM may mutate across async chunks
    const rows = [...msgsEl.querySelectorAll('.hs-mc-msg[data-msg-key]')]
    if (rows.length === 0) return

    const CHUNK = 50

    function _processRow(div) {
      if (!div.isConnected) return // removed mid-iteration — skip
      const span = div.querySelector(':scope > .hs-mc-text')
      const m = div._hsMsg
      if (!span || !m) return
      const html = computeMessageText(m) // m._renderedHtml cleared by caller → recomputes
      // No-op when the recompute produced identical HTML — innerHTML assignment
      // recreates every <img> even for byte-identical markup, and a recreated
      // emote paints its alt TEXT for a frame before the image decodes (the
      // "emotes flash to text" jank on every emote-set broadcast).
      if (div._hsAppliedText === html) return
      span.innerHTML = html
      div._hsAppliedText = html
      if (html.includes('data-source="heatsync"')) reconcileHeatsyncEmoteStates(span)
      // The swap recreated mention anchors — re-index so updateCosmeticsInPlace
      // still finds them (stale refs would silently fail to repaint paints).
      _unindexMessageDiv(div)
      div._hsMentionEls = null
      _indexMessageDiv(div, div.dataset.msgKey)
    }

    // Fast path: ≤50 rows — run synchronously, no rAF overhead
    if (rows.length <= CHUNK) {
      for (const div of rows) _processRow(div)
      return
    }

    // Chunked path: capture invalidation state ONCE at start. Each chunk bails
    // immediately if the tab switches, epoch bumps, or msgsEl is replaced —
    // stale work must never paint after a channel change or full rebuild.
    const snapTab = currentTab
    const snapEpoch = _renderEpoch

    function processChunk(offset) {
      if (currentTab !== snapTab || _renderEpoch !== snapEpoch || document.getElementById('hs-mc-messages') !== msgsEl)
        return
      const end = Math.min(offset + CHUNK, rows.length)
      for (let i = offset; i < end; i++) _processRow(rows[i])
      // Schedule next chunk via rafOrTimeout — tracked timers/rafs, cancelled
      // by destroyAll() on teardown so the loop never outlives the panel, and
      // starvation-proof: a bare rAF here would stall a rebuild mid-chunks in
      // an occluded window whose visibility flip never arrived.
      if (end < rows.length) rafOrTimeout(() => processChunk(end))
    }

    // First chunk runs synchronously on the current frame; subsequent chunks
    // each get their own animation frame (~50 rows/frame, no stall).
    processChunk(0)
  }

  // First-emote-load handler: clear cached HTML everywhere so every tab recomputes
  // with the new emotes, repaint the CURRENT tab in place (no flash), and drop
  // other tabs' snapshot caches so they rebuild fresh on switch. NO _renderEpoch
  // bump → no full teardown (mirrors invalidateRenderedForEmotes' tab handling).
  function reloadEmotesInPlace(reprocess = true) {
    const clearBuf = (msgs) => {
      for (const m of msgs) delete m._renderedHtml
    }
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

  // Platform→accent map lives in palette.js (HS_PLAT_COLORS).
  const PLAT_COLORS = HS_PLAT_COLORS

  // Pure builder for the inline feed-post quote row's username anchor (hoisted
  // out of buildMessageDiv, same reasoning as PLAT_COLORS above). Mirrors the
  // sender/mention/reply-bar precedence exactly: a resolved HeatSync paint
  // (already-rendered `hsPaint` — cls/html/splitAttr from hsPaintRender) wins;
  // otherwise a resolved 7TV `paintStyle` string; otherwise the plain
  // per-post color. Takes the resolved paint/style in rather than resolving
  // them itself so it stays unit-testable without any cache/DOM/network state.
  function buildFeedQuoteUserLink(feedUser, uid, hsPaint, paintStyle, color) {
    const name = feedUser || 'anon'
    const lower = name.toLowerCase()
    const cls = `hs-mc-user hs-mc-mention${hsPaint ? ` ${hsPaint.cls}` : ''}`
    const uidAttr = uid ? ` data-uid="${escapeHtml(uid)}"` : ''
    const splitAttr = hsPaint ? hsPaint.splitAttr : ''
    // Mount stamp (not a color decl) when painted — phase-locks this copy to
    // the same wall-clock frame as every other copy of the paint.
    const style = hsPaint ? `--hsp-t:${paintPhaseNow()};` : paintStyle || `color:${sanitizeColor(color || '#fff')}`
    const inner = hsPaint ? hsPaint.html : escapeHtml(name)
    return `<a href="https://heatsync.org/user/${encodeURIComponent(name)}" target="_blank" rel="noopener noreferrer" class="${cls}" data-username="${escapeHtml(lower)}"${uidAttr}${splitAttr} style="${style}">${inner}</a>`
  }

  function buildMessageDiv(m, tabId) {
    // Blocked user — fully hide (skip render entirely). Both the append and the
    // full-rebuild path go through buildMessageDiv, so returning null here hides
    // the message everywhere. Unblock + renderMessages brings them back.
    // m.actor covers stream-events whose sender is carried in actor, not user —
    // channel-point redeems (redeemer, set ~13343) and 7TV emote-change banners
    // (set ~12245). Those have no m.user so the first check misses them. Hiding a
    // blocked user's emote-add banner is desirable too. online/offline/raid/hype/
    // sub events leave actor null, so their banners still render.
    if (m.user && isUserBlocked(m.user, m.platform)) return null
    if (m.actor && isUserBlocked(m.actor, m.platform)) return null
    // Per-tab hide (/hide) — fully drop this user's rows, but only when building
    // for the tab they were hidden in (tabId), never globally.
    if (m.user && isUserHiddenInTab(m.user, m.platform, tabId)) return null
    if (m.actor && isUserHiddenInTab(m.actor, m.platform, tabId)) return null
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
        'event-online': 'online',
        'event-update': 'gameSwitch',
        'event-raid': 'raid',
        'event-hype': 'hype',
        'event-sub': 'sub',
        'event-redeem': 'redeem',
        'event-pred': 'pred',
        'event-poll': 'poll',
        'event-yt-superchat': 'ytSuperchat',
        'event-yt-supersticker': 'ytSupersticker',
        'event-yt-membership': 'ytMembership',
        'event-yt-milestone': 'ytMilestone',
        'event-yt-gift': 'ytGiftMemberships',
      }
      const hkey = evtMap[last]
      if (hkey && hermesToggles?.[hkey] === false) return null
      const div = document.createElement('div')
      div.className = `hs-mc-stream-event ${m.eventClass || ''}`
      // Superchat/sticker tier color rides per-message (m.scColor, extracted from
      // YouTube's own renderer background) — overrides the eventClass default.
      if (m.scColor) div.style.setProperty('--evt', sanitizeColor(m.scColor))
      const tsVal = timestampsEnabled && m.time ? formatTimeFromTs(m.time) : ''
      const tsSpan = tsVal ? `<span class="hs-mc-ts">${tsVal}</span>` : ''
      const isYtEvent = m.platform === 'youtube'
      // [Y] platform badge — parity with regular YT chat rows.
      const platBadge =
        isYtEvent && (platformBadgesEnabled || hostPlatform !== 'yt')
          ? `<span class="hs-mc-platform-badge hs-mc-pb-yt" style="font-size:13px;margin-right:3px;font-weight:700;vertical-align:middle;color:${PLAT_COLORS.yt}">[Y]</span>`
          : ''
      // For redeems, the actor is the redeemer (m.actor). For other events the channel is the actor.
      const ch = m.actor || m.channel || ''
      const chLc = ch.toLowerCase()
      // Look up color: event data → color map → profile cache → IRC buffers → async fetch.
      // YT events already carry their own m.color from the DOM scrape — the
      // Twitch-profile-keyed lookups below would be meaningless (and could even
      // false-match a same-named Twitch user), so skip them entirely for YT.
      let userColor = m.color || ''
      if (!isYtEvent) {
        if (!userColor) userColor = streamColorMap.get(chLc) || ''
        if (!userColor) {
          const cached = _profileCache.get(chLc)
          if (cached?.profile?.twitch_color) userColor = cached.profile.twitch_color
        }
        if (!userColor && chLc && irc?.channels) {
          for (const [, buf] of irc.channels) {
            const msgs = buf.getAll()
            // Bound the scan: a stream-event fires rarely but this used to walk
            // EVERY message of EVERY channel (O(channels×msgs)) — a burst on a busy
            // multi-channel setup scanned tens of thousands. A color from >300 msgs
            // ago is stale; cap the lookback so the fallback stays cheap.
            const floor = Math.max(0, msgs.length - 300)
            for (let i = msgs.length - 1; i >= floor; i--) {
              if (msgs[i].user?.toLowerCase() === chLc) {
                userColor = msgs[i].color || ''
                break
              }
            }
            if (userColor) break
          }
        }
      }
      // Build structured HTML: [username] ◆ action game
      if (!userColor) userColor = '#fff'
      const colorStyle = `color:${sanitizeColor(userColor)}`
      // YT has no reliable channel URL from a display name alone — render plain
      // text instead of a (likely wrong) twitch.tv link.
      const userLink = isYtEvent
        ? `<span class="hs-mc-user hs-evt-user" data-username="${escapeHtml(ch)}" style="${colorStyle}">${escapeHtml(ch)}</span>`
        : `<a href="https://twitch.tv/${encodeURIComponent(ch)}" target="_blank" rel="noopener noreferrer" class="hs-mc-user hs-evt-user" data-username="${escapeHtml(ch)}" style="${colorStyle}">${escapeHtml(ch)}</a>`
      const textAfterChannel = escapeHtml(m.text).replace(/^\[[^\]]+\]\s*/, '')
      const actionHtml = textAfterChannel.replace(
        /(switched to |now playing |went live \u2014 )(.+)$/,
        '$1<span class="hs-evt-game">$2</span>',
      )
      div.innerHTML = `${tsSpan}${platBadge}${userLink} ${actionHtml}`
      // The whole row is a shortcut to that channel's page. Clicks that land on
      // the username (or any link/emote) are left alone so the existing
      // profile-card / context-menu behaviour still wins there — only the empty
      // parts of the row open the stream. data-hs-clickable opts it into the
      // universal white-bg/black-text hover, same as the inline DM rows.
      // YT events are skipped: a display name gives no reliable channel URL, so
      // a guessed twitch.tv link would be worse than not being clickable.
      //
      // Only rows whose subject IS the channel get it. `ch` above prefers
      // m.actor, which is set on exactly the rows where the name is NOT a
      // channel — a channel-point redeem carries the redeemer, a 7TV banner the
      // editor. Those rows were opening twitch.tv/<some viewer> and, worse,
      // wearing the white hover plate the whole time they sat there, which
      // advertises a destination on a line that is a notice, not a link. A row
      // announcing that someone redeemed something is not a shortcut to
      // anywhere; the redeemer's own name is still a link for whoever wants it.
      if (!isYtEvent && ch && !m.actor) {
        div.dataset.hsClickable = ''
        div.style.cursor = 'pointer'
        div.title = `open ${ch} on twitch`
        div.addEventListener('click', (e) => {
          if (e.target.closest('a, .hs-mc-user, .hs-mc-emote')) return
          window.open(`https://twitch.tv/${encodeURIComponent(ch)}`, '_blank', 'noopener,noreferrer')
        })
      }
      // Async fetch color if not cached — Twitch profile lookup only; YT color
      // already came from m.color above.
      if (!isYtEvent && !userColor && chLc) {
        apiFetch(`/api/profile/${encodeURIComponent(chLc)}`).then((resp) => {
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
      const isOp = m.is_op != null ? !!m.is_op : !m.reply_to || m.reply_to === ''
      const isThreadOp = !!m.is_thread_op
      const notifType = isThreadOp ? 'mop' : isOp ? 'op' : 're'
      const typeDef = INLINE_NOTIF_TYPES[notifType]
      const borderColor = m.inlineNotifBorderColor || typeDef?.borderColor || '#fff'
      div.style.borderLeftColor = borderColor
      const tsVal = timestampsEnabled ? formatTimeFromTs(m.time) : ''
      const tsSpan = tsVal ? `<span class="hs-mc-ts">${tsVal}</span>` : ''
      const tagColor = typeDef?.color || 'var(--hs-danger)'
      const tagLabel = isThreadOp || isOp ? '[OP]' : '[RE]'
      const typeTag = `<span class="hs-feed-tag" style="color:${tagColor};font-size:13px;margin-right:3px">${tagLabel}</span>`
      const shortId = (m.base36_id || '').replace(/^0+/, '') || '0'
      // Span (not <a>): falls through to the row click handler below → switchTab('feed') + openThread, in-ext. An anchor would open heatsync.org in a new tab.
      const threadLink = `<span class="hs-feed-thread-link" data-id="${escapeHtml(m.base36_id || '')}" style="cursor:pointer">&gt;&gt;${escapeHtml(shortId)}</span>`
      // Same precedence + resolution chokepoint as the sender/mention/reply-bar
      // sites above: knownUserIds only ever holds a RESOLVED twitch-space id
      // (see paints.js ID-SPACE SAFETY note), populated from real chat activity
      // in joined channels — never invent a second lookup path here. HeatSync
      // paint wins over 7TV, same as everywhere else; queueMcCosmeticsLookup
      // (not queuePaintLookup directly — that must stay the sole call site,
      // see tests/paints.test.js) seeds both caches so a later resolution
      // retro-applies via _mentionIndex (this anchor is indexed generically by
      // _indexMessageDiv purely from its hs-mc-mention class + data-uid, same
      // as any other inline @mention — no bespoke registration needed).
      const feedUid = knownUserIds.get(userKey((m.feedUser || '').toLowerCase(), 'twitch')) || ''
      const feedHsPaint = feedUid ? hsPaintRender(feedUid, m.feedUser || 'anon') : null
      if (feedUid && !feedHsPaint && !mcUserCosmetics.has(feedUid)) queueMcCosmeticsLookup(feedUid)
      const feedPaintStyle = feedHsPaint ? '' : feedUid ? getMcPaintStyle(feedUid) : ''
      const userLink = buildFeedQuoteUserLink(m.feedUser, feedUid, feedHsPaint, feedPaintStyle, m.color)
      // Plus tenure — same uid this row's paint already resolved above.
      let feedPlusHtml = ''
      if (feedUid) {
        const feedSince = getHsPlusTenureSince(feedUid)
        if (feedSince === undefined) queuePlusTenureLookup(feedUid)
        else if (feedSince) feedPlusHtml = renderPlusTenureToken(feedSince)
      }
      const content = renderFeedContent(m.text, m.emote_refs)
      // Canonical heat: formatHeat + ° suffix (≥10) + tier color/glow/breathe via heatSpanHtml
      const heatHtml = (m.heat || 0) > 0 ? ` ${heatSpanHtml(m.heat)}` : ''
      // All values sanitized — safe innerHTML (heat is numeric, emoji/color are hardcoded)
      div.innerHTML = `${tsSpan}${threadLink}${typeTag}${userLink}${feedPlusHtml}${heatHtml}: <span class="hs-feed-body">${content}</span>`
      div.addEventListener('click', (e) => {
        const spoiler = e.target.closest('.hs-spoiler')
        if (spoiler) {
          spoiler.classList.toggle('revealed')
          return
        }
        if (e.target.closest('a, .hs-mc-emote, .hs-mc-link')) return
        // Remember where we came from so thread "back" returns here, not the feed.
        threadReturnTab = currentTab === 'feed' ? null : currentTab
        switchTab('feed')
        // A reply row displays >>its-own-id but its thread is the PARENT — open
        // the parent and highlight the clicked reply, else clicking a reply
        // silently dumps you on the parent OP (looked like "wrong post"). Mirrors
        // the feed-tab row handler (social.js buildFeedMessageDiv).
        openThread(m.reply_to || m.base36_id, m.reply_to ? m.base36_id : null)
      })
      return div
    }

    // Inline DM/whisper notification
    if (m.type === 'inline-dm') {
      const div = document.createElement('div')
      // Direction color-codes the whole row so an inbound/outbound whisper is
      // unmistakable at a glance: cyan (--hs-reply, the whisper accent) = came
      // IN to you, orange (--hs-brand, self) = went OUT from you. Border, label
      // and the big arrow all share it.
      div.className = `hs-mc-feed-inline hs-mc-dm-inline ${m.outgoing ? 'hs-whisper-out' : 'hs-whisper-in'}`
      const dirColor = m.outgoing ? 'var(--hs-brand)' : 'var(--hs-reply)'
      div.style.borderLeftColor = dirColor
      const tsVal = timestampsEnabled ? formatTimeFromTs(m.time) : ''
      const tsSpan = tsVal ? `<span class="hs-mc-ts">${tsVal}</span>` : ''
      // twitch = whisper, heatsync = native DM — distinct labels so the row
      // says what it actually is (both used to render [DM], which was wrong)
      const labelText = m.platform === 'twitch' ? '[whisper]' : '[DM]'
      const label = `<span style="color:${dirColor};font-size:13px;font-weight:700;margin-right:4px">${labelText}</span>`
      const platBadge =
        m.platform === 'twitch'
          ? '<span style="color:var(--hs-plat-twitch);font-size:13px;font-weight:700;margin-right:3px">[T]</span>'
          : '<span style="color:#fff;font-size:13px;font-weight:700;margin-right:3px">[HS]</span>'
      const dmPaint = m.platform === 'twitch' ? userPaintStyle(m.userId, (m.user || '').toLowerCase(), 'twitch') : ''
      // Always render the pair "who → who" (sender → recipient). m.user is the
      // OTHER party in both directions (recipient on outgoing, sender on
      // incoming), so the arrow flows away from you on sends, toward you on
      // receives — the same mental model as a chat client's whisper split.
      const otherName = `<span style="${dmPaint || `color:${sanitizeColor(m.color)};font-weight:600`}">${escapeHtml(m.user)}</span>`
      const youTok = '<span class="hs-whisper-you">you</span>'
      const arrow = `<span class="hs-whisper-arrow" style="color:${dirColor}">→</span>`
      const dirPair = m.outgoing ? `${youTok}${arrow}${otherName}` : `${otherName}${arrow}${youTok}`
      // All values sanitized — safe innerHTML
      // @mentions in the DM body paint like anywhere else a person is named —
      // route through highlightMentionsInHtml (skipMentions=true avoids the
      // double-anchor bug), reusing the sender path's HS-paint → 7TV → color
      // precedence + twitch-space id-guard rather than the plain fallback.
      if (m._renderedHtml == null)
        m._renderedHtml = highlightHashtagsInHtml(
          highlightMentionsInHtml(
            processEmotes(escapeHtml(m.text), null, undefined, undefined, undefined, true),
            m.platform,
          ),
        )
      // All values already sanitized via escapeHtml/processEmotes — safe innerHTML (existing pattern)
      div.innerHTML = `${tsSpan}${label}${platBadge}${dirPair}: ${m._renderedHtml}`
      // Clickable rows must obey the universal hover invert like every other
      // control. role="button" isn't an option — the row contains anchors
      // (@mentions), so it'd nest interactive-in-interactive; the data attribute
      // opts it into the same single rule.
      div.dataset.hsClickable = ''
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
      div.style.borderLeftColor = m.inlineNotifBorderColor || '#fff'
      const tsVal = timestampsEnabled ? formatTimeFromTs(m.time) : ''
      const tsSpan = tsVal ? `<span class="hs-mc-ts">${tsVal}</span>` : ''
      const label = `<span style="color:${m.inlineNotifColor || '#fff'};font-size:13px;font-weight:700;margin-right:3px">[🔥]</span>`
      // ¶ permalink → shareable SSR page (right-click copy-link works natively);
      // the row click handler ignores anchors, mirrors the site's moment-card.
      // Shift-click pastes the URL into the chat input instead — the in-chat
      // visibility loop: non-users see a plain heatsync.org link, click =
      // instant value, no wall. Never auto-sends; the user owns the enter key.
      const perma =
        m.momentId && /^\d+$/.test(m.momentId)
          ? ` <a class="hs-mc-moment-perma" href="https://heatsync.org/moment/${m.momentId}" target="_blank" rel="noopener" title="permalink — click to open, shift-click to paste into chat">¶</a>`
          : ''
      div.innerHTML = `${tsSpan}${label}<span style="color:#c0c0c0">${escapeHtml(m.text || '')}</span>${perma}`
      // Same deal as the inline DM row: clickable, contains an anchor (¶ perma),
      // so it opts into the universal hover via the attribute, not role.
      div.dataset.hsClickable = ''
      div.style.cursor = 'pointer'
      const ch = m.momentChannel
      const plat = m.momentPlatform || 'twitch'
      div.title = `open ${ch} chat`
      div.addEventListener('click', (e) => {
        const permaEl = e.target.closest?.('a.hs-mc-moment-perma')
        if (permaEl && e.shiftKey) {
          e.preventDefault()
          const input = document.getElementById('hs-mc-input')
          if (!input) return
          const momentUrl = permaEl.getAttribute('href')
          const cur = (typeof getInputText === 'function' ? getInputText() : input.value) || ''
          const next = `${(cur.trim() ? `${cur.trimEnd()} ` : '') + momentUrl} `
          if (typeof wysiwygEnabled !== 'undefined' && wysiwygEnabled && typeof restoreWysiwygText === 'function') {
            restoreWysiwygText(input, next)
          } else {
            input.value = next
          }
          try {
            input.focus()
          } catch (_) {}
          return
        }
        if (e.target.closest('a')) return
        // A spike row lands you in the CHAT ROOM, not the stream page: the
        // relevance filter (handleMomentSpike) only surfaces spikes for
        // channels in your tabs or the one you're watching, so a chat tab
        // exists in almost every case — switch to it. The currently-watched
        // channel maps to the live tab. Only a spike with no tab anywhere
        // falls back to opening the stream in a new tab.
        const chLc = (ch || '').toLowerCase()
        const tabCh = (config?.channels || []).find((c) =>
          plat === 'kick' ? c?.kick?.toLowerCase() === chLc : c?.twitch?.toLowerCase() === chLc,
        )
        if (tabCh?.id) {
          switchTab(tabCh.id)
          return
        }
        if (typeof getCurrentChannel === 'function' && (getCurrentChannel() || '').toLowerCase() === chLc) {
          switchTab('live')
          return
        }
        const url = plat === 'kick' ? `https://kick.com/${ch}` : `https://www.twitch.tv/${ch}`
        try {
          window.open(url, '_blank', 'noopener')
        } catch (_) {}
      })
      return div
    }

    // AutoMod hold-queue row — twitch automod paused a viewer's message in a
    // channel this user moderates. Rendered on its own (not through the usual
    // notice/noticeKind path — mutable status + buttons need custom content).
    // Escaping happens in automod-queue.js's buildAutomodHoldContentHtml so
    // nothing here touches the raw sender/text/terms payload.
    if (m.type === 'automod-hold') {
      const div = document.createElement('div')
      div.className = 'hs-mc-msg hs-mc-automod'
      div.dataset.msgId = m.msgId
      div.dataset.msgChannel = m.broadcasterLogin || ''
      const tsVal = timestampsEnabled ? formatTimeFromTs(m.heldAt) : ''
      const tsSpan = tsVal ? `<span class="hs-mc-ts">${tsVal}</span>` : ''
      const { senderHtml, textHtml, reasonHtml } = buildAutomodHoldContentHtml(m)
      const actionsHtml = renderAutomodHoldActionsHtml(m)
      const safeMsgId = escapeHtml(m.msgId || '')
      // All values pre-escaped (buildAutomodHoldContentHtml) or hardcoded/numeric — safe innerHTML
      div.innerHTML =
        `${tsSpan}<span class="hs-mc-automod-badge">${escapeHtml(t('mc_automod_label'))}</span>` +
        `<span class="hs-mc-automod-chip">${reasonHtml}</span>` +
        `<div class="hs-mc-automod-body"><span class="hs-mc-automod-sender">${senderHtml}</span>: <span class="hs-mc-automod-text">${textHtml}</span></div>` +
        `<div class="hs-mc-automod-actions" data-msg-id="${safeMsgId}">${actionsHtml}</div>`
      return div
    }

    const showChannel = tabId === 'mentions'
    const isSuperChat = m.platform === 'youtube' && (m.msgType === 'superchat' || m.msgType === 'supersticker')
    const isMembership =
      m.platform === 'youtube' &&
      (m.msgType === 'membership' || m.msgType === 'giftpurchase' || m.msgType === 'giftredemption')
    const isKicksEvent = m.kicksEvent === true
    // Map noticeType / msgId to a semantic CSS modifier so each event class
    // (unban, ban, mod-add, mode-change, sub, raid, etc.) can have its own color/icon
    const noticeKind = (() => {
      if (m.type !== 'notice' && m.type !== 'usernotice') return ''
      let id = m.noticeType || m.msgId || ''
      if (!id) return ''
      // shared-chat wrapper: the real event type rides in source-msg-id
      if (id === 'sharedchatnotice' && m.sourceMsgId) id = m.sourceMsgId
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
      if (
        id === 'mode_change' ||
        id === 'slow_on' ||
        id === 'slow_off' ||
        id === 'subs_on' ||
        id === 'subs_off' ||
        id === 'emote_only_on' ||
        id === 'emote_only_off' ||
        id === 'followers_on' ||
        id === 'followers_on_zero' ||
        id === 'followers_off' ||
        id === 'r9k_on' ||
        id === 'r9k_off'
      )
        return 'hs-mc-notice-mode'
      if (id === 'sub' || id === 'resub' || id === 'primepaidupgrade' || id === 'extendsub') return 'hs-mc-notice-sub'
      // Kick event names — heatsync server passes Kick-side strings through;
      // normalize to the same CSS classes Twitch sub/gift events use so the
      // sub-purple border, gift-bubble pink, etc. render identically.
      if (
        id === 'subscription' ||
        id === 'channel.subscription.new' ||
        id === 'channel.subscription.renewal' ||
        id === 'resubscription'
      )
        return 'hs-mc-notice-sub'
      if (
        id === 'subgift' ||
        id === 'anonsubgift' ||
        id === 'submysterygift' ||
        id === 'giftpaidupgrade' ||
        id === 'anongiftpaidupgrade' ||
        id === 'rewardgift' ||
        id === 'standardpayforward' ||
        id === 'communitypayforward' ||
        id === 'gift_subscription' ||
        id === 'gifted_subscriptions' ||
        id === 'channel.subscription.gifts'
      )
        return 'hs-mc-notice-gift'
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
      if (id === 'charitydonation' || id === 'charity_donation') return 'hs-mc-notice-charity'
      // ritual = twitch's legacy new-chatter usernotice; render with the
      // user-intro treatment (same "new here" semantics)
      if (id === 'ritual' || id === 'new_chatter') return 'hs-mc-user-intro'
      if (id === 'pin') return 'hs-mc-notice-pin'
      if (
        id === 'msg_banned' ||
        id === 'msg_timedout' ||
        id === 'no_permission' ||
        id.startsWith('bad_') ||
        id.startsWith('usage_')
      )
        return 'hs-mc-notice-error'
      return ''
    })()
    // Guard against messages with no user (malformed IRC / system messages).
    // Sits BELOW the classifier on purpose: user-less NOTICEs (mode changes,
    // msg_banned errors, pin lines) still get their semantic notice color —
    // the old early-return rendered them all as bare grey system rows.
    if (!m.user) {
      if (m.text || m.systemMsg) {
        const div = document.createElement('div')
        div.className = `hs-mc-msg hs-mc-system ${noticeKind}`.trim()
        // .hs-mc-system-text span so the per-kind text-color rules apply
        const span = document.createElement('span')
        span.className = 'hs-mc-system-text'
        span.textContent = m.systemMsg || m.text || ''
        div.appendChild(span)
        return div
      }
      return null
    }
    const cls =
      tabId === 'mentions'
        ? 'hs-mc-msg mention'
        : isKicksEvent
          ? 'hs-mc-msg hs-mc-system hs-mc-kicks'
          : isMembership
            ? 'hs-mc-msg hs-mc-system'
            : m.type === 'usernotice' || m.type === 'notice'
              ? `hs-mc-msg hs-mc-system ${noticeKind}`.trim()
              : m.isHighlighted
                ? 'hs-mc-msg hs-mc-highlighted'
                : m.redeemed
                  ? 'hs-mc-msg hs-mc-redeemed'
                  : isSuperChat
                    ? 'hs-mc-msg hs-mc-superchat'
                    : isMention(m)
                      ? 'hs-mc-msg mention'
                      : 'hs-mc-msg'
    const channelSpan = showChannel && m.channel ? `<span class="hs-mc-channel">${escapeHtml(m.channel)}</span>` : ''
    // Render badges — YouTube sends array of {type,label,url}, Twitch/Kick send IRC badge string
    let badges = ''
    if (m.platform === 'youtube' && Array.isArray(m.badges)) {
      badges = m.badges
        .map((b) => {
          if (b.url) {
            return `<img class="hs-mc-badge-img" src="${escapeHtml(b.url)}" alt="${escapeHtml(b.label)}" title="${escapeHtml(b.label)}" decoding="async" width="18" height="18" style="width:18px;height:18px;">`
          }
          // Text fallback for owner/mod without image
          const ytBadgeStyles = {
            owner: { bg: '#ffd600', fg: '#000', label: '\u2606' },
            moderator: { bg: '#5e84f1', fg: '#fff', label: '\u2694' },
          }
          const style = ytBadgeStyles[b.type]
          if (style)
            return `<span class="hs-mc-badge" style="background:${style.bg};color:${style.fg}" title="${escapeHtml(b.label)}">${style.label}</span>`
          return ''
        })
        .join('')
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
    // Kick: resolve via 7TV/v3/users/kick/{name} which also returns the linked
    // twitch_id when present. Hoist into m.userId + m._uidTwitch so the
    // existing cosmetics pipeline applies. Gated on !m._uidTwitch (NOT
    // !m.userId): pusher/relay kick messages always carry the numeric KICK id,
    // which is a different id-space — only the _uidTwitch stamp marks a
    // resolved twitch identity.
    if (m.platform === 'kick' && m.user && !m._uidTwitch) {
      const kKey = (m.user || '').toLowerCase()
      const cached = kickNameResolved.get(kKey)
      if (cached) {
        m.userId = cached
        m._uidTwitch = cached
      } else if (cached === undefined) queueKickNameToCosmetics(m.user)
    }
    // Kick-space paint uid (kick_<kickid>) — set independent of whether the
    // twitch lookup above resolved (a kick-origin HeatSync account can have
    // its own paint with or without a linked twitch account). Cache-hit path
    // only; a cold lookup lands this via flushKickNameLookups' patchBuf once
    // the batch resolves.
    if (!m.hsPaintUid && m.platform === 'kick' && m.user) {
      const paintUid = kickNamePaintUid.get((m.user || '').toLowerCase())
      if (paintUid) m.hsPaintUid = paintUid
    }
    // ID-SPACE SAFETY: a kick row's userId is the raw numeric KICK id until
    // the hoist above / flushKickNameLookups patches in the linked twitch id
    // (m._uidTwitch). The badge maps, 7TV cosmetics and paint caches below are
    // all TWITCH id-space — a bare kick id collides with an unrelated twitch
    // user's entry, painting the wrong person. Kick rows resolve through the
    // name-keyed kick pipeline (kickNamePaintUid + queueKickNameToCosmetics).
    const uidTwitch = (m.platform === 'kick' ? m._uidTwitch : m.userId) || ''
    if (uidTwitch) {
      badges += renderThirdPartyBadges(uidTwitch)
      if (!mcUserCosmetics.has(uidTwitch)) queueMcCosmeticsLookup(uidTwitch)
    }
    const plat =
      m.platform === 'youtube'
        ? 'yt'
        : m.platform === 'kick'
          ? 'kick'
          : m.platform === 'heatsync'
            ? 'heatsync'
            : 'twitch'
    const platLabel = plat === 'yt' ? '[Y]' : plat === 'kick' ? '[K]' : plat === 'heatsync' ? '[H]' : '[T]'
    const platformBadge =
      platformBadgesEnabled || plat !== hostPlatform
        ? `<span class="hs-mc-platform-badge hs-mc-pb-${plat}" style="font-size:13px;margin-right:3px;font-weight:700;vertical-align:middle;color:${PLAT_COLORS[plat]}">${platLabel}</span>`
        : ''
    const safeScColor = sanitizeColor(m.scColor || '#ffd600')
    const scBadge =
      isSuperChat && m.amount
        ? `<span class="hs-mc-sc-badge" style="background:${safeScColor};color:#000;padding:0 4px;border-radius:0;font-size:13px;font-weight:700;margin-right:3px;">${escapeHtml(m.amount)}</span>`
        : ''
    const bitsBadge = m.bits ? `<span class="hs-mc-bits-badge" title="${m.bits} bits">${m.bits} bits</span>` : ''
    // (cheermote rendering is applied inline in processedText via renderCheermotesInText)
    // HeatSync paint (own-platform cosmetic) takes precedence over 7TV — see
    // hsPaintRender in paints.js. Returns null (falls through to the existing
    // 7TV/plain-color path) until/unless one is cached for this uid. A kick
    // chatter's own kick-space uid (m.hsPaintUid, kick_<id>) is a fallback
    // behind their resolved twitch uid — see the ID-SPACE SAFETY note in
    // paints.js: a kick-origin HeatSync account can exist with or without a
    // twitch link, so try twitch first, then the kick-namespaced id.
    // uidTwitch (not raw m.userId): paint caches are twitch-space — a kick
    // row's numeric kick id would fetch/render an unrelated twitch user's paint.
    const hsPaint =
      (uidTwitch ? hsPaintRender(uidTwitch, m.user) : null) ||
      (m.hsPaintUid ? hsPaintRender(m.hsPaintUid, m.user) : null)
    const paintStyle = hsPaint ? '' : uidTwitch ? getMcPaintStyle(uidTwitch) : ''
    // Plus tenure ("+5mo"/"+3y" beside an active Plus member's name) — an
    // identity signal, not a cosmetic, so it resolves regardless of the
    // showNamePaints setting. Same uid precedence as hsPaint above: resolved
    // twitch-space uid first, kick/yt-namespaced hsPaintUid fallback.
    const hsPlusUid = uidTwitch || m.hsPaintUid || ''
    let hsPlusHtml = ''
    if (hsPlusUid) {
      const since = getHsPlusTenureSince(hsPlusUid)
      if (since === undefined) queuePlusTenureLookup(hsPlusUid)
      else if (since) hsPlusHtml = renderPlusTenureToken(since)
    }
    // Name colour (when no HS/7TV paint owns the fill): the user's PICKED
    // heatsync colour on youtube + kick ONLY — never twitch, whose custom name
    // colour is the prime/turbo paid perk. YouTube has no native colour, so its
    // names fall back to a deterministic djb2 palette colour (identical to
    // heatsync.org) instead of a flat red. Picked colour resolves async via the
    // same batch as paints (updateHsColorsInPlace repaints in place).
    let hsNameColor = m.color
    if (plat === 'yt' || plat === 'kick') {
      if (m.hsPaintUid) queueNameColorLookup(m.hsPaintUid)
      const picked = m.hsPaintUid ? getHsPickedColor(m.hsPaintUid) : null
      if (picked) hsNameColor = picked
      else if (plat === 'yt') hsNameColor = hsUsernameColor(m.user)
    }
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
    // When painted, drop the inline color decl (the class owns the paint
    // fill) and carry the mount stamp instead so every copy of the paint
    // phase-locks to the wall clock (lib/paint-spec.js syncDelayCalc).
    const userLink = `<a href="${userHref}" target="_blank" rel="noopener noreferrer" class="hs-mc-user${hsPaint ? ` ${hsPaint.cls}` : ''}" data-username="${escapeHtml(m.user.toLowerCase())}" data-platform="${plat}"${hsPaint ? hsPaint.splitAttr : ''} style="${hsPaint ? `--hsp-t:${paintPhaseNow()};` : paintStyle || `color:${sanitizeColor(hsNameColor || '#fff')}`}">${hsPaint ? hsPaint.html : escapeHtml(m.user)}</a>`
    let avatarHtml = ''
    if (avatarsEnabled) {
      const userKey = m.user.toLowerCase()
      // YouTube messages carry avatar URL directly — cache it and skip the fetch.
      // Same 500-entry LRU as the fetched-avatar path so 30k unique YT chatters
      // can't grow the Map unbounded over an 8h stream.
      if (m.avatar && m.platform === 'youtube') {
        // Protocol-validate before caching — this URL later flows into img.src.
        // Mirrors the fetched avatar path which already routes through safeUrl.
        const safe = safeUrl(m.avatar)
        if (safe) avatarCache.set(userKey, safe)
        if (avatarCache.size > 500) {
          avatarCache.delete(avatarCache.keys().next().value)
        }
      }
      const cachedUrl = avatarCache.get(userKey)
      if (cachedUrl) {
        avatarHtml = `<img class="hs-mc-avatar" src="${escapeHtml(cachedUrl)}" alt="" loading="lazy" decoding="async">`
      } else if (!m.platform || m.platform === 'twitch') {
        // Initials reserve the box immediately; fetchAvatar swaps the real pfp
        // in place on success (zero shift) or it stays as the initial on a
        // miss/failure (no blank gap). Unifies with the kick/yt path below.
        avatarHtml = avatarFallbackHtml(m.user, userKey, true)
        fetchAvatar(userKey)
      } else if (m.platform === 'kick') {
        // Kick real avatars ride the cosmetics pipeline (flushKickNameLookups
        // caches the profile_pic from the same v1/users fetch that resolves
        // cosmetics). Tag the placeholder with data-user so that swap can find
        // and replace it in place — same zero-shift mechanism as twitch.
        avatarHtml = avatarFallbackHtml(m.user, userKey, true)
      } else {
        // YouTube without an inline avatar — neutral initials, no swap path.
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
    if (m.sticker?.url) {
      stickerHtml = ` <img src="${escapeHtml(m.sticker.url)}" alt="${escapeHtml(m.sticker.alt || 'sticker')}" loading="lazy" decoding="async" style="height:48px;vertical-align:middle;" />`
    }

    const div = document.createElement('div')
    div.className = cls
    div._hsMsg = m // back-ref for reprocessEmoteTextInPlace (GC'd with the row)
    div._hsAppliedText = processedText // baseline for reprocess's unchanged-skip
    // uidTwitch, never raw m.userId: data-uid is twitch-id-space only (feeds
    // _uidIndex / updateCosmeticsInPlace). A kick row's numeric kick id here
    // would both collide with an unrelated twitch user's repaint AND block
    // flushKickNameLookups' backfill (it only stamps when data-uid is empty).
    if (uidTwitch) div.dataset.uid = uidTwitch
    // Kick-space paint uid — parallel to data-uid, never a substitute for it
    // (data-uid stays twitch-id-space only). Lets a kick-namespaced
    // HS paint resolution find this row in-place (updateHsPaintsInPlace).
    if (m.hsPaintUid) div.dataset.hsPaintUid = m.hsPaintUid
    if (isSuperChat && m.scColor) {
      const safeBg = sanitizeColor(m.scColor)
      div.style.background = `${safeBg}22`
      div.style.borderLeft = `3px solid ${safeBg}`
      div.style.paddingLeft = '4px'
    }
    // First-time chatter highlight (this session, per channel)
    if (
      firstChatterGlow &&
      m.user &&
      m.channel &&
      !isMembership &&
      !isKicksEvent &&
      m.type !== 'usernotice' &&
      m.type !== 'notice'
    ) {
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
    // Returning chatter — chatted before, back after a long absence (twitch tag).
    if (m.isReturningChatter) div.classList.add('is-returning')
    // "new to chat" intro message (twitch msg-id=user-intro)
    if (m.userIntro) div.classList.add('hs-mc-user-intro')
    // Power-ups: gigantified emote (last emote renders big) + message effect
    // (static fx chip — no motion by design; the effect NAME is the info)
    if (m.gigantified) div.classList.add('hs-mc-gigantified')
    if (m.animationId) {
      div.classList.add('hs-mc-animated')
      div.dataset.hsAnim = String(m.animationId).slice(0, 32)
    }
    // Shared-chat session: message originated in the partner channel
    if (m.sharedChat) div.classList.add('hs-mc-shared')
    // Raider — a first message arriving in the window after a raid into this channel.
    if (m.isRaider) div.classList.add('is-raider')
    // Cleared by mod (timeout/ban/delete) — Twitch-native dim + strikethrough on offending content
    if (m.cleared && dimTimeouts) {
      div.classList.add('hs-mc-msg-cleared')
      if (m.clearedReason) div.title = m.clearedReason
    }
    // Keyword highlight — message text matches a user-defined term
    if (keywordHighlightsRegex && m.text && keywordHighlightsRegex.test(m.text)) {
      div.classList.add('hs-kw-match')
    }
    // Filter rule highlight — per-rule color accent (hide is handled before buffer insert)
    const _frHL = evaluateFilterRules(m, tabId)
    if (_frHL.highlight) {
      div.classList.add('hs-mc-rule-highlight')
      div.style.setProperty('--hs-rule-hl', _frHL.highlight)
    }
    // Reply context bar (Chatterino-style) — all values escaped via escapeHtml
    const replyLower = m.replyTo?.user ? m.replyTo.user.toLowerCase() : ''
    // Paint the reply target's name with their 7TV cosmetic — same person, same
    // paint as their own messages. Twitch carries reply-parent-user-id; Kick
    // (no parent id) falls back to the name→uid map. data-uid lets
    // updateCosmeticsInPlace repaint it once the cosmetic batch lands.
    const replyUid = (m.replyTo && (m.replyTo.userId || knownUserIds.get(userKey(replyLower, m.platform)))) || ''
    // HeatSync paint wins over 7TV here too — same precedence rule as the
    // sender username above.
    const replyHsPaint = replyUid ? hsPaintRender(replyUid, `@${m.replyTo?.user || ''}`) : null
    const replyPaint = replyHsPaint ? '' : replyUid ? userPaintStyle(replyUid, replyLower, m.platform) : ''
    // Mount stamp (not a color decl) when painted — phase-locks this copy to
    // the same wall-clock frame as every other copy of the paint.
    const replyStyle = replyHsPaint ? `--hsp-t:${paintPhaseNow()};` : replyPaint || `color:${mentionColor(replyLower)}`
    const replyUidAttr = replyUid ? ` data-uid="${escapeHtml(replyUid)}"` : ''
    const replyUserCls = `hs-mc-user hs-mc-reply-user${replyHsPaint ? ` ${replyHsPaint.cls}` : ''}`
    const replyUserSplitAttr = replyHsPaint ? replyHsPaint.splitAttr : ''
    const replyUserHtml = replyHsPaint ? replyHsPaint.html : `@${escapeHtml(m.replyTo?.user || '')}`
    // Plus tenure ("+5mo"/"+3y") — identity signal, resolves regardless of
    // the paint setting. Same replyUid the reply-bar paint already resolved.
    let replyPlusHtml = ''
    if (replyUid) {
      const replySince = getHsPlusTenureSince(replyUid)
      if (replySince === undefined) queuePlusTenureLookup(replyUid)
      else if (replySince) replyPlusHtml = renderPlusTenureToken(replySince)
    }
    // A blocked user's name + message snippet must not leak through a reply
    // context bar when someone else replies to them. Show a neutral marker
    // with no name, no text, no profile link.
    const replyBlocked = m.replyTo?.user && isUserBlocked(m.replyTo.user, m.platform)
    const replyBar = replyBlocked
      ? `<span class="hs-mc-reply-ctx">&#8618;[blocked]</span> `
      : m.replyTo?.user
        ? // role/tabindex/aria make the pill the control it always was. Clicking
          // it has opened the thread stack for a long time, but nothing SAID so:
          // it read as static text, so the feature was invisible unless you
          // already knew. The trailing caret is the affordance, aria-expanded is
          // the state, and both the universal hover invert and keyboard
          // activation come free once it is a button.
          `<span class="hs-mc-reply-ctx" role="button" tabindex="0" aria-expanded="false" title="${escapeHtml(m.replyTo.user)}: ${escapeHtml(m.replyTo.text || '')}">&#8618;<a href="https://heatsync.org/user/${encodeURIComponent(m.replyTo.user)}" target="_blank" rel="noopener noreferrer" class="${replyUserCls}" data-username="${escapeHtml(replyLower)}"${replyUidAttr}${replyUserSplitAttr} style="${replyStyle}">${replyUserHtml}</a>${replyPlusHtml}<span class="hs-mc-reply-caret" aria-hidden="true"></span>${m.replyTo.text ? `<span class="hs-mc-reply-snippet">: ${escapeHtml(m.replyTo.text)}</span>` : ''}</span> `
        : ''
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
    // First-message rows said what they were with COLOUR ALONE — a magenta bar
    // for a channel-first, a faint inset glow for a session-first. Nobody can
    // read a colour they were never given a key to, and the glow was barely
    // above the background besides. Redeems and highlights next to them have
    // carried a text label all along; these get the same treatment, using the
    // same primitive rather than a new one.
    //
    // Its own variable, not another branch of the chain above: a first message
    // can also be a redeem or a highlight, and those are different facts about
    // the same row. Appending keeps both instead of picking a winner.
    // ONLY twitch's real first-message-ever gets a label. The session-first
    // glow is our own bookkeeping ("first time YOU have seen them since the tab
    // opened") and mellen does not want it announced — it is not a fact about
    // the chatter, it is a fact about your tab, and labelling it competed with
    // the one that matters.
    let firstMsgLabel = ''
    if (m.isFirstMsg) {
      firstMsgLabel = `<span class="hs-mc-system-text hs-mc-first-label">\u25C7 first message in this channel</span>`
    }
    // USERNOTICE system line (all values go through escapeHtml — same pattern as existing innerHTML above)
    const systemLine =
      (m.systemMsg ? `<span class="hs-mc-system-text">${escapeHtml(m.systemMsg)}</span>` : '') +
      redeemLabel +
      firstMsgLabel
    // Skip the date-format work entirely when the timestamp won't render —
    // formatTimeFromTs builds a Date per call, and at 100msg/s that's free CPU
    // we can give back when timestamps are off.
    const showTs = timestampsEnabled || tabId === 'mentions'
    const ts = showTs ? formatTimeFromTs(m.time) : ''
    const tsHtml = ts ? `<span class="hs-mc-ts">${ts}</span>` : ''
    const msgBody =
      (m.type === 'usernotice' || m.type === 'notice') && !m.text
        ? `${tsHtml}${systemLine}`
        : m.type === 'notice'
          ? `${tsHtml}<span class="hs-mc-text">${processedText}</span>`
          : m.isAction
            ? `${tsHtml}${systemLine}${platformBadge}${scBadge}${bitsBadge}${badges}${avatarHtml}${userLink}${hsPlusHtml}${channelSpan} <span class="hs-mc-text" style="color:${sanitizeColor(m.color || '#fff')};font-style:italic">${processedText}</span>${stickerHtml}`
            : `${tsHtml}${systemLine}${platformBadge}${scBadge}${bitsBadge}${badges}${avatarHtml}${userLink}${hsPlusHtml}${channelSpan}: <span class="hs-mc-text">${processedText}</span>${stickerHtml}`
    div.innerHTML = `${replyBar}${msgBody}`
    // Correct emote states based on current inventory + blocked (cached HTML
    // may have stale states). String-includes gate skips the querySelectorAll
    // walk on the >95% of msgs that don't contain heatsync emotes — the gate
    // is a single substring scan, the QSA was iterating div subtree.
    if (processedText.includes('data-source="heatsync"')) reconcileHeatsyncEmoteStates(div)
    // >>id thread refs → open the thread in the overlay feed panel. Mirrors the
    // feed's own per-row handler (social.js:1453) + a switchTab so the panel
    // surfaces when clicked from a chat tab. Class gate skips the QSA on the
    // >99% of messages with no thread ref.
    if (processedText.includes('hs-post-link') && typeof openThread === 'function') {
      div.querySelectorAll('.hs-post-link').forEach((link) => {
        link.addEventListener('click', (e) => {
          e.preventDefault()
          e.stopPropagation()
          const targetId = link.dataset.id
          if (!targetId) return
          const target = feedMessages.find((f) => f.base36_id === targetId)
          const threadId = target ? target.reply_to || target.base36_id : targetId
          // Remember where we came from so thread "back" returns here, not the feed.
          threadReturnTab = currentTab === 'feed' ? null : currentTab
          switchTab('feed')
          openThread(threadId, targetId)
        })
      })
    }
    // Row identity for reply + mod actions. YT was excluded here back when a yt
    // message's only id was the videoId (shared by every message in the stream,
    // so it collided) — it isn't anymore: both the DOM tap and the server relay
    // now carry youtube's own per-message innertube id (social.js ytMsg.id), and
    // an id-less message still fails the `m.id` test below. Excluding youtube
    // left its rows with no dataset at all, which silently disabled BOTH the
    // @-mention reply (send-targets ytReplyText) and every yt mod action: the
    // ctx menu reads dataset.msgPlatform, so a yt row read as twitch with an
    // empty channel and the whole mod block was skipped.
    if (m.id) {
      div.dataset.msgId = m.id
      div.dataset.msgUser = m.user
      // True login for mod actions + notice dedup. Twitch display-name ≠ login
      // for non-Latin names (display 田中 / login tanaka123); banning the display
      // name would target a bogus login and silently fail. m.login is the IRC
      // prefix login; kick has no separate display/login so it falls back to user.
      div.dataset.msgLogin = m.login || m.user || ''
      div.dataset.msgChannel = m.channel || ''
      div.dataset.msgPlatform = m.platform || ''
      // Send time (tmi-sent-ts / the platform's own stamp), not receive time —
      // it picks the UTC day in a /logs permalink, and the archive stores the
      // same value. Without it a row can be identified but not cited.
      if (m.time) div.dataset.msgTime = String(m.time)
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
      // Thread button — the discoverable way to mint a heatsync thread. The
      // capability already existed as `/op`, a slash command with no UI: 56
      // posts from 2 authors in 41 days, because nobody finds a command they
      // were never shown. `»` mirrors the `>>id` quote syntax the feed already
      // uses. It SEEDS the composer rather than posting — one click publishing
      // someone else's words under your name is a trap, and the user's own take
      // is what makes the thread worth reading.
      const threadBtn = document.createElement('button')
      threadBtn.className = 'hs-mc-thread-btn'
      threadBtn.textContent = '»'
      threadBtn.title = t('mc_msg_start_thread') || 'start a thread from this message'
      div.appendChild(threadBtn)
    }
    // Reply-thread linkage for hover highlight
    if (m.replyTo) {
      if (m.replyTo.id) div.dataset.replyId = m.replyTo.id
      if (m.replyTo.threadId) div.dataset.replyThreadId = m.replyTo.threadId
    }
    // Inline media — a single lightweight embed (direct img/video, a youtube
    // thumbnail, or a server-resolved rich card) below the text. NEVER a live
    // iframe: chat is high-volume and runs on low-RAM hardware. Appended as a
    // sibling node (outside the cached _renderedHtml) so toggling the setting
    // takes effect on the next rerender. Lazy-loaded, error-guarded, capped.
    if (
      mediaEmbedsEnabled &&
      !m.cleared &&
      m.text &&
      m.type !== 'usernotice' &&
      m.type !== 'notice' &&
      typeof extractChatEmbed === 'function'
    ) {
      const embedHtml = extractChatEmbed(m.text, { partialLinks: linksEnabled && partialLinksEnabled })
      if (embedHtml) {
        const holder = document.createElement('div')
        holder.className = 'hs-mc-media-wrap'
        holder.insertAdjacentHTML('afterbegin', embedHtml)
        div.appendChild(holder)
        if (typeof resolvePendingFeedEmbeds === 'function') resolvePendingFeedEmbeds(holder)
        if (typeof attachFeedFallbacks === 'function') attachFeedFallbacks(holder)
        foldEmbeddedMediaUrl(div, holder)
      }
    }
    return div
  }

  // A pasted image posts as its URL — that IS the wire payload, chat has no
  // attachments. Showing the url AND the picture it renders is noise, so fold
  // the url away once its own media is on screen. Direct media only: the
  // embed builder marks those with data-hs-src-url, and a link CARD is
  // deliberately left alone, because there you're being asked to click through
  // and you should get to see where to.
  //
  // The url goes only when the picture has actually PAINTED — on load, never on
  // insert. Hiding it up front and restoring it on error reads as equivalent and
  // isn't: chat images are loading="lazy", so one rendered out of view never
  // fetches, never errors, and never fires anything at all. That row would have
  // sat there as a blank line, url hidden behind an image that was never coming,
  // until you happened to scroll it into view. Waiting for the load event has no
  // such hole — nothing is hidden until its replacement is on screen.
  function foldEmbeddedMediaUrl(row, holder) {
    const media = holder.querySelector('[data-hs-src-url]')
    const src = media?.dataset.hsSrcUrl
    if (!src) return
    // Match on href, not on the visible text: chat truncates long urls for
    // display, and linkifyPartialLinks synthesizes an href for a url that was
    // never fully typed. The href is the only field that means the same thing
    // in both cases.
    const link = Array.from(row.querySelectorAll('a.hs-mc-link')).find(
      (a) => a.getAttribute('href') === src || a.href === src,
    )
    if (!link) return
    const img = media.querySelector('img')
    if (!img) return
    const fold = () => link.classList.add('hs-mc-url-folded')
    // Already decoded — a re-render of a row whose image is in cache.
    if (img.complete && img.naturalWidth > 0) fold()
    else img.addEventListener('load', fold, { once: true })
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
      // biome-ignore lint/correctness/noEmptyCharacterClassInRegex: [^] is the intentional "any char incl newline" idiom for stripping multi-line img fragments
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
    hsResolveUserColor(lower)
      .then((c) => {
        _mentionColorPending.delete(lower)
        let esc
        try {
          esc = CSS.escape(lower)
        } catch {
          esc = lower
        }
        const anchors = document.querySelectorAll(
          `a.hs-mc-mention[data-username="${esc}"], a.hs-mc-reply-user[data-username="${esc}"]`,
        )
        if (c) {
          const safe = sanitizeColor(c)
          anchors.forEach((a) => {
            // A HeatSync paint or a 7TV paint cosmetic outranks a flat color —
            // never overwrite either. hasResolvedHsPaint MUST be checked here
            // too (not just getMcPaintStyle/7TV): applyHsPaintToElement clears
            // this exact element's style attribute when it paints it, and if
            // this async color resolve lands afterward it would silently
            // re-add an inline style that outranks the class-based paint by
            // specificity — stomping the paint precedence the class relies on.
            const uid = a.dataset.uid
            if (uid && (getMcPaintStyle(uid) || hasResolvedHsPaint(uid))) return
            a.style.color = safe
          })
        }
        // Twitch uid piggybacked off the same /api/profile/ lookup hsResolveUserColor
        // just made (hsResolveUserId reads the cache it populated — no extra
        // request). Render time had no uid for this name; close the loop now:
        // stamp it on every live anchor, index them so the cosmetics/paint
        // batches (which only know about indexed elements) can retro-paint,
        // and remember it in knownUserIds so the NEXT render of this name
        // hits synchronously instead of taking this async detour again.
        const resolvedUid = typeof _hsUserIdCache !== 'undefined' ? _hsUserIdCache.get(lower) || null : null
        if (!resolvedUid) return
        for (const a of anchors) {
          if (a.dataset.uid) continue // already stamped/indexed (or render-time known)
          // Id-space guard: this uid is Twitch-resolved (twitch_user_id from the
          // profile API), so only stamp anchors that belong to a twitch-platform
          // message — a same-named Kick/YouTube chatter must never inherit a
          // Twitch stranger's uid/cosmetics.
          const row = a.closest('.hs-mc-msg')
          if ((row?._hsMsg?.platform || 'twitch') !== 'twitch') continue
          a.dataset.uid = resolvedUid
          let ms = _mentionIndex.get(resolvedUid)
          if (!ms) {
            ms = new Set()
            _mentionIndex.set(resolvedUid, ms)
          }
          ms.add(a)
          // Keep the row's cached mention list (built once by _indexMessageDiv via
          // querySelectorAll('[data-uid]')) in sync — it excluded this anchor when
          // first indexed because data-uid was empty then, so _unindexMessageDiv's
          // cleanup would otherwise never find it here.
          if (Array.isArray(row?._hsMentionEls) && !row._hsMentionEls.includes(a)) {
            row._hsMentionEls.push(a)
          }
        }
        try {
          setKnownColor(lower, c || knownColors.get(lower) || '#fff', resolvedUid, 'twitch')
        } catch {}
        queueMcCosmeticsLookup(resolvedUid)
      })
      .catch(() => {
        _mentionColorPending.delete(lower)
      })
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

  // Everyday words that are never a bare mention, even when someone with that
  // login is chatting. "bruh", "what", "yeah", "mods" and "based" are all real
  // twitch accounts — without this, one of them speaking anywhere turns every
  // ordinary use of the word into a colored link across every channel. The
  // bare form is a convenience; @name stays the explicit way to mention them,
  // and it is unaffected by this list. Contraction stems ("don", "isn", "didn")
  // are here because the regex's boundary set includes the apostrophe, so
  // "don't" offers up "don" as a candidate name.
  const BARE_MENTION_STOPWORDS = new Set(
    `the and you are for not but all any can has had her him his how its new now old see two way who did let put say she too use man own why yes yet off got run set try war win act add age air bad big end few
     that was with they this have from one were when what where whats which who whom while your yours yourself said there their theirs them these those some such here huh hmm oof will other about out many then would make like into more could than been being both people may down get come made over only just know take well very want because give most also back after work first even need much right think thing things does don isn wasn didn doesn couldn wouldn shouldn won ain dont cant wont thats hes shes youre theyre youve ive lets gonna wanna gotta kinda sorta before between during through under until against having each
     lol lmao lmfao omg wtf wth ngl tbh imo imho fyi idk ikr brb gtg yeah yea yep yup nah nope sure same true real fake bruh bro dude guys chat mods mod stream streamer game good nice best worst cool damn holy actually literally basically honestly seriously bot bots based cringe insane crazy sick wild huge small pog poggers kek lul ggs wow hey hello thanks thank please sorry congrats welcome night morning today tomorrow yesterday time year years day days week hour min sec guy girl kid dog cat food life love hate live dead lose lost play played playing watch watching look looks looking seen saw tell told talk ask asked keep stop start help wait coming going went gone still again never always ever maybe probably definitely absolutely`
      .split(/\s+/)
      .filter(Boolean),
  )

  // Highlight @mentions and bare known usernames in rendered chat HTML.
  // Splits on tags so substitution only happens in text segments.
  // Applies 7TV paint cosmetics if the mentioned user's userId + paint are cached.
  function highlightMentionsInHtml(html, platform) {
    // Twitch is the implicit default platform — m.platform is UNDEFINED on
    // twitch rows (same convention as buildMessageDiv's `!m.platform ||
    // m.platform === 'twitch'`). Without this, userKey(lower, undefined)
    // never matches the 'twitch'-scoped knownUserIds entries and every
    // twitch mention renders uid-less (unpaintable).
    platform = platform || 'twitch'
    if (!html || (!html.includes('@') && knownColors.size === 0)) return html
    // Skips whole <a>…</a> spans, not just tags — a bare word or @handle inside
    // an already-linkified url must not be re-wrapped, or the nested <a> splits
    // the link (see highlightHashtagsInHtml for the same bug, reported live).
    return outsideTags(
      html,
      /(^|[\s.,!?;:()[\]"'])(@?)([A-Za-z0-9_]{3,25})(?=$|[\s.,!?;:()[\]"'])/g,
      (m, lead, at, name) => {
        const lower = name.toLowerCase()
        // A bare word only becomes a mention when the name belongs to someone
        // we've actually HEARD SPEAK. knownColors answers "what color", not
        // "is this a person": every @word in chat runs through mentionColor →
        // hsResolveUserColor, which always returns a color (falling back to
        // twitch's hash palette even for logins that don't exist) and writes it
        // into knownColors. So one person typing "@you" — not even a real
        // account — made the literal word "you" a known "user" for the rest of
        // the session, and every plain "you" in every channel rendered as a
        // colored mention link. _ucDisplay is the lowercase mirror of
        // usernameCache, written only by addUsername from real sender paths,
        // so it answers the question knownColors can't. Both are required:
        // color-only or spoke-only would each widen what highlights today.
        const known = knownColors.has(lower) && _ucDisplay.has(lower) && !BARE_MENTION_STOPWORDS.has(lower)
        if (!at && !known) return m
        // @mentions resolve a color even for users we haven't seen (async);
        // bare known names already have one in knownColors.
        const color = at ? mentionColor(lower) : sanitizeColor(knownColors.get(lower) || '#fff')
        const safeName = escapeHtml(name)
        const safeLower = escapeHtml(lower)
        // Platform-scoped lookup — a twitch and kick chatter sharing this
        // lowercase name must never trade 7TV paints/cosmetics. Falls back
        // to the async-resolved uid cache (survives when knownUserIds was
        // never seeded this session — e.g. page reload restored the color
        // cache but the user hasn't chatted yet).
        const uid =
          knownUserIds.get(userKey(lower, platform)) ||
          (platform === 'twitch' && typeof _hsUserIdCache !== 'undefined' ? _hsUserIdCache.get(lower) || '' : '')
        // No uid yet: fire the profile resolve for its uid side-effect even
        // when the COLOR is already cached — mentionColor short-circuits on
        // known colors and would otherwise never fetch the uid, leaving
        // this mention unpaintable forever. Deduped via _mentionColorPending.
        if (!uid && platform === 'twitch') resolveMentionColor(lower)
        let style = `color:${color}`
        let uidAttr = ''
        let mentionCls = 'hs-mc-user hs-mc-mention'
        let splitAttr = ''
        let inner = `${at}${safeName}`
        if (uid) {
          uidAttr = ` data-uid="${escapeHtml(uid)}"`
          if (!mcUserCosmetics.has(uid)) queueMcCosmeticsLookup(uid)
          // HeatSync paint wins over 7TV — same precedence rule as the
          // sender username / reply-context bar.
          const hsPaint = hsPaintRender(uid, `${at}${name}`)
          if (hsPaint) {
            mentionCls += ` ${hsPaint.cls}`
            splitAttr = hsPaint.splitAttr
            inner = hsPaint.html
            // Mount stamp instead of a color decl — phase-locks this copy
            // to the same wall-clock frame as every other copy of the paint.
            style = `--hsp-t:${paintPhaseNow()};`
          } else {
            const paint = getMcPaintStyle(uid)
            if (paint) style = paint
          }
        }
        // No plus-tenure "+" on an inline @mention: the token is a
        // sender-identity mark (shown beside the sender before the colon),
        // not part of a name typed inside message content. The sender's own
        // name and the reply-context header still carry it.
        // data-platform is what the hover card reads to disambiguate a name
        // that exists on more than one platform. Without it the tooltip called
        // /api/profile/<name> with no platform and the server picked whichever
        // identity it liked — hovering @nl_kripp in twitch chat could answer
        // with a youtube shadow user, and the card then rendered thin because
        // followage/banner/pronouns all key off the twitch id it never got.
        // Use the same platform the uid lookup two blocks up already uses, so
        // the mention's identity and its hover card agree by construction.
        return `${lead}<a href="https://heatsync.org/user/${encodeURIComponent(lower)}" target="_blank" rel="noopener noreferrer" class="${mentionCls}" data-username="${safeLower}" data-platform="${escapeHtml(platform)}"${uidAttr}${splitAttr} style="${style}">${inner}</a>`
      },
    )
  }

  // DOM-node twin of highlightHashtagsInHtml for surfaces that build via text
  // nodes instead of innerHTML (archive viewer, pinned tab, search results).
  // Same regex/route/class so #tags read identically everywhere. stopPropagation
  // keeps a tag click from also firing a row-level handler (search/pinned rows).
  function appendTextWithHashtags(parent, text) {
    const s = String(text == null ? '' : text)
    if (!s.includes('#')) {
      if (s) parent.appendChild(document.createTextNode(s))
      return
    }
    const parts = s.split(/(#[a-zA-Z][a-zA-Z0-9_]{1,29})\b/g)
    for (const p of parts) {
      if (!p) continue
      if (p[0] === '#' && /^#[a-zA-Z][a-zA-Z0-9_]{1,29}$/.test(p)) {
        const tag = p.slice(1)
        const a = document.createElement('a')
        a.className = 'hs-hashtag'
        a.href = `https://heatsync.org/tags/${encodeURIComponent(tag)}`
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        a.dataset.tag = tag
        a.textContent = `#${tag}`
        a.addEventListener('click', (e) => e.stopPropagation())
        parent.appendChild(a)
      } else {
        parent.appendChild(document.createTextNode(p))
      }
    }
  }

  // Magenta #hashtags in chat — same pattern + link target as the feed so tags
  // are consistent on every surface. Splits on tags so attrs/img/<a> aren't touched.
  function highlightHashtagsInHtml(html) {
    if (!html?.includes('#')) return html
    // outsideTags skips whole <a>…</a> spans, not just tags. A url fragment
    // like ".../2026-07-22?m=…#mb812bf1a-46d8-…" is tag-shaped, and wrapping it
    // put an <a> inside an <a> — invalid html5, so the browser closes the outer
    // link at that point: the fragment rendered magenta and the rest of the url
    // fell out of the link entirely as plain text.
    // (?<!&) — seg is already escaped, so a #tag inside an HTML entity
    // (&#x27; → #x27, &#39; → #39) must NOT match, else an apostrophe renders
    // as a bogus magenta tag.
    return outsideTags(html, /(?<!&)#([a-zA-Z][a-zA-Z0-9_]{1,29})\b/g, (_m, tag) => {
      return `<a href="https://heatsync.org/tags/${encodeURIComponent(tag)}" target="_blank" rel="noopener noreferrer" class="hs-hashtag" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</a>`
    })
  }

  // Yellow >>id HeatSync thread references in chat — same regex, id format, span
  // and yellow style the social feed already ships (social.js renderFeedContent),
  // so a thread ref reads identically on every surface. Emits the feed's
  // .hs-post-link span (NOT an <a>) so the click opens the thread inside the
  // overlay feed panel rather than a new tab — wired per-row in buildMessageDiv.
  // Text is HTML-escaped here, so a typed ">>" arrives as "&gt;&gt;".
  function highlightThreadRefsInHtml(html) {
    // Gate on the doubled forms — text is HTML-escaped here so a typed ">>" is
    // "&gt;&gt;" (no bare ">"); also accept raw ">>" belt-and-suspenders.
    if (!html || (!html.includes('&gt;&gt;') && !html.includes('>>'))) return html
    // Anchor-aware for the same reason as the two passes above.
    return outsideTags(html, /(?:&gt;&gt;|>>)(\w{1,6})/g, (_m, id) => {
      const paddedId = id.padStart(6, '0')
      const displayId = id.replace(/^0+/, '') || '0'
      return `<span class="hs-post-link" data-id="${escapeHtml(paddedId)}" style="cursor:pointer">&gt;&gt;${escapeHtml(displayId)}</span>`
    })
  }

  // Scroll helper — reused by both renderMessages and appendMessage
  function scrollMsgsToBottom(msgsEl) {
    const newBtn = document.getElementById('hs-mc-new-msgs')
    newMessageCount = 0
    if (newBtn) newBtn.style.display = 'none'
    if (isScrolledUp) return
    // Single sync write — reading scrollHeight forces layout flush so the
    // new content's height is reflected before we set scrollTop. The +rAF
    // catches the rare case where layout settles a frame later (e.g. font
    // metrics changing post-decode). Late image loads / box changes are
    // covered by the capture-phase load+error delegation and ResizeObserver
    // wired in the scroll-listener block above — no need to scan
    // .hs-mc-emote and attach per-image listeners (was O(N) per call,
    // duplicated by delegation, and leaked listeners on rapid bursts).
    isProgrammaticScroll = true
    msgsEl.scrollTop = msgsEl.scrollHeight + 10000
    if (document.hidden || _rafStarved) {
      // No frames coming (believed-hidden or starved-rAF, any flavor): settle
      // synchronously instead of leaving the programmatic flag up for a
      // throttled timer's lifetime — a raised flag eats the user's own
      // scroll events.
      isProgrammaticScroll = false
    } else {
      // rafOrTimeout, not bare rAF: if starvation begins right here, the
      // watchdog still lowers the programmatic flag instead of leaving it
      // eating user scrolls until the next real frame.
      rafOrTimeout(() => {
        if (!isScrolledUp) msgsEl.scrollTop = msgsEl.scrollHeight + 10000
        isProgrammaticScroll = false
      })
    }
  }

  // rAF that still fires when chrome believes the tab hidden AND a user
  // signal (window focus / BG-oracle wedge) says someone is looking. rAF is
  // frozen in believed-hidden, so every render/scroll callback riding a bare
  // rAF silently never fires there and rows pile up below a stuck viewport.
  // The timeout fallback engages ONLY in that user-looking state: a genuinely
  // hidden background tab must keep the free rAF pause (a timer fallback
  // there would burn 1Hz renders in every backgrounded tab — measured).
  //
  // Inverse wedge: document.hidden reads FALSE but rAF is frozen — chrome
  // occlusion-throttles a covered window without ever delivering the
  // visibilitychange (wayland/tiling WMs lose the flip; this failure ships
  // zero 'vis' events to the diag ring). A bare rAF then swallows the
  // coalesced render forever while the user stares at a frozen pane, and the
  // BG-oracle nudge can't help (it only acts when document.hidden is true).
  // So every believed-visible rAF races a watchdog timer: rAF wins → timer
  // cleared, zero cost. Timer wins → rAF is starved regardless of what the
  // visibility API claims; render on a timer cadence — fast when focused,
  // 1Hz when not — and keep a probe rAF out so the first real frame ends
  // the episode.
  function rafOrTimeout(fn) {
    if (document.hidden) {
      if (document.hasFocus() || _visWedged) {
        cleanup.setTimeout(fn, 16)
        return true
      }
      return cleanup.raf(fn) // genuinely hidden — keep the free rAF pause
    }
    if (_rafStarved) {
      cleanup.setTimeout(fn, document.hasFocus() ? 150 : 1000)
      _probeRafRecovery()
      return true
    }
    let settled = false
    const rafId = cleanup.raf(() => {
      if (settled) return
      settled = true
      cleanup.clearTimeout(watchdog)
      fn()
    })
    const watchdog = cleanup.setTimeout(() => {
      if (settled) return
      settled = true
      cleanup.cancelRaf(rafId)
      _rafStarved = true
      hsDiagLog('raf_starved', { focus: document.hasFocus() })
      _probeRafRecovery()
      fn()
    }, 300)
    return true
  }
  // One outstanding bare rAF while starved — it firing is proof frames are
  // back (window uncovered / occlusion lifted), so the next render returns to
  // the free rAF path.
  function _probeRafRecovery() {
    if (_rafProbePending) return
    _rafProbePending = true
    cleanup.raf(() => {
      _rafProbePending = false
      if (_rafStarved) {
        _rafStarved = false
        hsDiagLog('raf_recovered')
      }
    })
  }

  // Coalesced scroll-pin for the single-message append path. Calling
  // scrollMsgsToBottom inline per message forced a synchronous layout flush
  // (read scrollHeight, write scrollTop) on every message — 60 forced reflows/s
  // on a busy solo tab. Batching to one rAF pins once per frame (before paint,
  // so no visible lag) and reads layout once instead of per message.
  let _scrollPinRaf = null
  let _lastSyncPin = 0
  function scheduleScrollPin(msgsEl) {
    if (_scrollPinRaf) return
    if (_rafStarved || (document.hidden && (document.hasFocus() || _visWedged))) {
      // Believed-hidden but still appending (focus/wedge override): rAF is
      // dead and timers clamp to ~1s, which reads as "chat stuck at the
      // bottom". Pin synchronously at ≥100ms spacing — bounded reflow cost,
      // fluid enough to read — with a clamped trailing timer as backstop.
      const now = Date.now()
      if (now - _lastSyncPin >= 100) {
        _lastSyncPin = now
        scrollMsgsToBottom(msgsEl)
        return
      }
      _scrollPinRaf = true
      cleanup.setTimeout(() => {
        _scrollPinRaf = null
        _lastSyncPin = Date.now()
        scrollMsgsToBottom(msgsEl)
      }, 120)
      return
    }
    // rafOrTimeout, not bare rAF: starvation beginning while this pin is
    // outstanding would otherwise leave _scrollPinRaf truthy forever and
    // every future pin skipped.
    _scrollPinRaf = rafOrTimeout(() => {
      _scrollPinRaf = null
      scrollMsgsToBottom(msgsEl)
    })
  }

  // Incremental append for single messages on the active tab (hot path)
  // Returns true if handled, false if full rebuild needed
  // Check if a tab has multiple platform sources active (needs fair merge)
  let _multiPlatformRenderTimer = null
  function isMultiPlatformTab(tabId) {
    if (tabId === 'live') {
      const curCh = getLiveChannel()
      let count = 0
      if (curCh && irc?.getCount(curCh)) count++
      if (curCh && kickChat?.getCount(curCh)) count++
      if (channelYtMessages.get('__live_yt_auto__')?.length || 0) count++
      if (count < 2) {
        // Also check config-linked platforms (O(1) via the prebuilt lookup)
        const lk = getChannelLookup()
        const linked = lk.twitch.get(curCh) || lk.kick.get(curCh)
        if (linked?.kick && kickChat?.getCount(linked.kick)) count++
        if (linked?.youtube && channelYtMessages.get(linked.id)?.length) count++
      }
      return count > 1
    }
    const ch = getChannelById(tabId)
    if (!ch) return false
    let count = 0
    if (ch.twitch && irc?.getCount(ch.twitch)) count++
    if (ch.kick && kickChat?.getCount(ch.kick)) count++
    // own linked YT only — __live_yt_auto__ no longer merges into per-channel
    // tabs (mirrors renderMessages bleed fix)
    const ytMsgs = channelYtMessages.get(tabId)?.length || 0
    if (ytMsgs) count++
    return count > 1
  }

  // ─── render-time content filters ──────────────────────────────────────
  // Hidden at render, kept in buffers — toggling off un-hides retroactively.
  const _BOT_NAMES = new Set([
    'nightbot',
    'streamelements',
    'moobot',
    'fossabot',
    'streamlabs',
    'wizebot',
    'botrix',
    'sery_bot',
    'soundalerts',
    'pokemoncommunitygame',
    'kofistreambot',
    'blerp',
  ])
  let _muteKeywordsRegex = null
  function rebuildMuteKeywordsRegex() {
    const terms = getSetting('hs_mute_keywords')
      .split(/\n/)
      .map((t) => t.trim())
      .filter(Boolean)
    if (!terms.length) {
      _muteKeywordsRegex = null
      return
    }
    const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    try {
      _muteKeywordsRegex = new RegExp(escaped.join('|'), 'i')
    } catch {
      _muteKeywordsRegex = null
    }
  }
  // Read the content-filter settings once per render pass — isMsgFiltered
  // runs per message in the render hot path (up to 1500 msgs per render).
  function _filterFlags() {
    return {
      bots: getSetting('hideBots'),
      cmds: getSetting('hideCommands'),
      dups: getSetting('hideDuplicates'),
      dim: dimTimeouts,
    }
  }
  // The live-DOM half of the same decision, for rows already on screen when a
  // mod acts. The render filter above is the durable answer; this makes it
  // immediate instead of "next time anyone says anything".
  function markClearedRow(row, title) {
    if (!row) return
    if (!dimTimeouts) {
      // Exactly what the next render pass would do — isMsgFiltered drops it.
      row.remove()
      return
    }
    row.classList.add('hs-mc-msg-cleared')
    if (title) row.title = title
  }
  function isMsgFiltered(m, f) {
    if (!m || m.type === 'stream-event' || m.type === 'automod-hold' || m.inlineNotifType) return false
    const u = m.user ? m.user.toLowerCase() : ''
    if (u && u === currentUsername) return false // never hide own messages
    if (u && f.bots && _BOT_NAMES.has(u)) return true
    // `dim timed-out messages` offers two treatments and only one of them was
    // implemented in the overlay: with it OFF, a moderated message was neither
    // dimmed NOR hidden — it stayed fully readable, the opposite of what
    // "50% opacity instead of hiding" promises. Hiding belongs here, at the
    // render filter, because this is the one platform-blind place every
    // buffer's messages pass through — the dim path is patched into the live
    // DOM from six separate call sites and youtube's, added later, never
    // checked the setting at all.
    if (m.cleared && !f.dim) return true
    if (typeof m.text !== 'string') return false
    if (f.cmds && m.text.charCodeAt(0) === 33) return true
    if (_muteKeywordsRegex?.test(m.text)) return true
    return false
  }
  const _lastMsgTextByTab = new Map()

  // Cached emote imgs are already `complete` when a row mounts, so their `load`
  // event never fires and the msgsEl load listener never snaps them — meaning
  // hsSnapEmoteBox's integer-width pin AND its modifier space reservation are
  // skipped, leaving wide/tall-modified cached emotes (e.g. a channel "Cabge
  // ffzW") overlapping. Enqueue every already-complete emote img so the snap
  // runs; non-cached imgs still snap via their load event. hsSnapEmoteBox is
  // rAF-batched + idempotent, so this is cheap even in a bulk rebuild.
  // Reserve horizontal/vertical space for a wide/tall-modified emote sized to its
  // REAL width (fixes runs of "Cabge ffzW" overlapping). offsetWidth is the
  // untransformed layout width; the visual is that × scale, so each side needs
  // width*(scale-1)/2. Overrides the static 28px-based fallback margins.
  // Takes pre-read dimensions — lets the batch caller read all sizes first,
  // THEN write all margins, instead of read→write→read→write (which forces a
  // layout reflow per wrapper on the per-message append hot path).
  function _reserveModWrapSized(wrap, w, h) {
    const sx = Math.abs(parseFloat(wrap.dataset.hsModSx) || 1)
    const sy = Math.abs(parseFloat(wrap.dataset.hsModSy) || 1)
    if (sx > 1 && w) {
      const m = `${Math.round((w * (sx - 1)) / 2)}px`
      wrap.style.setProperty('margin-left', m, 'important')
      wrap.style.setProperty('margin-right', m, 'important')
    }
    if (sy > 1 && h) {
      const m = `${Math.round((h * (sy - 1)) / 2)}px`
      wrap.style.setProperty('margin-top', m, 'important')
      wrap.style.setProperty('margin-bottom', m, 'important')
    }
  }
  let _hsModReserveRO = null
  function _snapCompleteEmotes(root) {
    if (!root?.querySelectorAll) return
    if (typeof hsSnapEmoteBox === 'function') {
      for (const eimg of root.querySelectorAll('img.hs-mc-emote')) {
        if (eimg.complete && eimg.naturalWidth) hsSnapEmoteBox(eimg)
      }
    }
    // Modifier reservation via ResizeObserver — fires exactly when the wrapper
    // gets a real size (img decoded, incl. cached imgs whose `load` never fires),
    // so it never depends on the load event or which render path mounted the row.
    const mods = root.querySelectorAll('.hs-mc-emote-wrapper[data-hs-mod-sx]')
    if (!mods.length) return
    if (!_hsModReserveRO && typeof ResizeObserver !== 'undefined') {
      _hsModReserveRO = new ResizeObserver((entries) => {
        for (const e of entries) {
          const box = e.borderBoxSize?.[0]
          const w = box ? box.inlineSize : e.contentRect.width
          const h = box ? box.blockSize : e.contentRect.height
          if (w) {
            _reserveModWrapSized(e.target, w, h)
            _hsModReserveRO.unobserve(e.target)
          }
        }
      })
      if (typeof cleanup !== 'undefined' && cleanup.trackObserver) cleanup.trackObserver(_hsModReserveRO)
    }
    // Batch: read every wrapper's size FIRST (one reflow), then write all margins
    // + observe — never interleave a layout read after a style write in the loop.
    const sized = []
    for (const wrap of mods) sized.push([wrap, wrap.offsetWidth, wrap.offsetHeight])
    for (const [wrap, w, h] of sized) {
      _reserveModWrapSized(wrap, w, h) // immediate if already sized
      if (_hsModReserveRO) _hsModReserveRO.observe(wrap) // and again once it is
    }
  }

  function appendMessage(msg, tabId) {
    if (editingChannel) return false
    // Hidden by share-dedupe (real USERNOTICE replaced our synthetic)
    if (msg?.hidden) return true
    // Skip live append while profile card is open — buffer keeps the msg, restored on close
    if (typeof activeProfileCard !== 'undefined' && activeProfileCard) return true
    // Same for the predictions/polls view — it owns the chat area while open.
    if (typeof predViewOpen === 'function' && predViewOpen()) return true
    if (isScrolledUp || currentTab !== tabId) return false

    // Platform filter: skip messages for muted platforms (single-platform tab path)
    if (msg.platform && isPlatformFilterTab(tabId)) {
      const k = msg.platform === 'youtube' ? 'youtube' : msg.platform
      if (getPlatformFilter(tabId)[k] === false) return true
    }

    // Content filters — hidden at render, buffers keep the message
    const _ff = _filterFlags()
    if (isMsgFiltered(msg, _ff)) return true
    if (typeof msg.text === 'string' && _ff.dups) {
      if (_lastMsgTextByTab.get(tabId) === msg.text) return true
      _lastMsgTextByTab.set(tabId, msg.text)
    }

    // Multi-platform tabs: skip appendMessage (trimChildren is platform-blind
    // and lets the fastest source push others out). Debounce to renderMessages
    // which has fair per-platform capping.
    if (isMultiPlatformTab(tabId)) {
      if (!_multiPlatformRenderTimer) {
        _multiPlatformRenderTimer = rafOrTimeout(() => {
          _multiPlatformRenderTimer = null
          renderMessages(currentTab)
        })
      }
      return true // tell caller we handled it
    }

    // Hidden tab: skip ALL DOM work (build/append/trim/pin) — buffers keep the
    // message and the visibilitychange handler rebuilds once on return. The
    // multi-platform path above pauses for free (rAF never fires while hidden).
    // hasFocus() and the BG-oracle wedge flag override a stuck 'hidden': if
    // the visibility flip got lost (popout/wayland occlusion) but the window
    // is focused or the BG proved it on-screen, the user IS looking — keep
    // appending instead of freezing the pane.
    if (document.hidden && !document.hasFocus() && !_visWedged) {
      _hiddenSkippedAppend = true
      return true
    }

    const msgsEl = document.getElementById('hs-mc-messages')
    if (!msgsEl) return false

    // Remove "no messages" placeholder. It's always the sole/first child (see
    // isEmptyTab), so an O(1) firstChild check beats a descendant querySelector
    // on every appended message.
    const first = msgsEl.firstElementChild
    if (first?.classList.contains('hs-mc-empty')) first.remove()

    // Compute key first so we can skip if a node with this key already exists
    // (IRC reconnect, replay echo, dual-send race — all paths benefit from
    // a single guard instead of relying on each caller to dedup). Direct
    // iteration vs. CSS attr selector — CSS.escape encodes for identifier
    // grammar, not attribute-value grammar, so a key like "3:@user:t:Tr" was
    // producing a selector that didn't match the literal dataset value and
    // the guard silently failed.
    const msgKeyStr = msgKeyOf(msg)
    if (_msgKeyIndex.has(msgKeyStr)) return true

    const div = buildMessageDiv(msg, tabId)
    if (!div) return true
    // Tag with the same msgKey renderMessages uses, so a later tab switch into a
    // multi-platform view can prefix-match this DOM and avoid a one-shot rebuild.
    div.dataset.msgKey = msgKeyStr
    div.dataset.hsEpoch = String(_renderEpoch)
    // Strict alternation: append flips from last sibling's zebra. Append-only path
    // always alternates cleanly. Bigger-tier than hash (which only ~50% alternates).
    if (
      zebraEnabled &&
      msg.type !== 'stream-event' &&
      msg.type !== 'feed-post' &&
      msg.type !== 'inline-dm' &&
      msg.type !== 'moment' &&
      msg.type !== 'automod-hold'
    ) {
      const prev = msgsEl.lastElementChild
      const prevZ = prev?.classList.contains('hs-mc-zebra') === true
      if (!prevZ) div.classList.add('hs-mc-zebra')
    }
    msgsEl.appendChild(div)
    _indexMessageDiv(div, msgKeyStr)
    _snapCompleteEmotes(div)

    // Trim oldest rows beyond the live-DOM cap (data buffer keeps more).
    // Hysteresis: let the append hot path overshoot the cap by 50 rows, then
    // trim back down to it — one Range op per ~50 messages instead of one per
    // message at steady state. Every other trim site stays exact-cap (tab
    // restore paths assume ≤ cap).
    if (msgsEl.childElementCount > DOM_RENDER_CAP + 50) trimMessagesEl(msgsEl, DOM_RENDER_CAP)

    // Apply mute to just this message — strip content for muted users.
    // msg.user is the sender; avoid a DOM scan to recompute it. Routes
    // through isUserMuted so a kick chatter whose linked twitch handle was
    // muted (or vice-versa) gets stripped on either platform.
    const username = msg.user ? String(msg.user).toLowerCase() : ''
    if (username && isUserMuted(username, msg.platform)) {
      stripMcMutedMessage(div)
    }

    // No updateTabBadges() here: it only refreshes the mentions/whispers/feed
    // "unseen" badges, whose state changes solely via noteSeenEvent/bumpSeen
    // (both already call refreshSeenBadges). A plain incoming chat message can't
    // change it, so calling it per-append was 3 querySelectors/msg of pure waste.
    scheduleScrollPin(msgsEl)
    return true
  }

  // Render epoch — bumps when external state invalidates already-rendered DOM
  // (emote data, settings that change visual output). Each row is stamped with
  // the epoch it was built at (data-hs-epoch); after a bump the diff render
  // rebuilds stale rows in place — never a teardown, never a reorder.
  let _renderEpoch = 0

  // Full rebuild — used for tab switches, scroll resume, and initial load
  // Invalidate cached rendered HTML on all messages (when emote data changes)
  function clearRenderedHtmlCache() {
    const clearBuf = (msgs) => {
      for (const m of msgs) delete m._renderedHtml
    }
    if (irc?.channels) for (const [, buf] of irc.channels) clearBuf(buf.getAll())
    if (kickChat?.channels) for (const [, buf] of kickChat.channels) clearBuf(buf.getAll())
    clearBuf(mentionsBuffer)
    for (const msgs of channelYtMessages.values()) clearBuf(msgs)
    _renderEpoch++
    // Tab caches are keyed by old epoch — drop them all so next switch
    // rebuilds at the new epoch instead of restoring stale-keyed children
    // that the diff would immediately wipe.
    _dropAllTabCaches()
  }

  // Bump render epoch WITHOUT clearing _renderedHtml. Used when late-arriving
  // out-of-band data (Twitch native badges, BTTV/FFZ/Chatterino bulk badge
  // maps) needs to re-flow into the DOM. The diff renderer skips identical
  // msgKeys, so a bare renderMessages after badge fetch is a no-op — bumping
  // the epoch forces a fresh build that recomputes badges while keeping
  // cached emote HTML on _renderedHtml.
  function bumpRenderEpoch() {
    _renderEpoch++
    _dropAllTabCaches()
  }

  // Surgical invalidation for a block/unblock of specific emote(s). The full
  // clearRenderedHtmlCache() bumps _renderEpoch, which marks EVERY row stale so
  // the next render rebuilds each one in place — order-safe, but still a full
  // rebuild's worth of work + img churn. block/unblockEmote already correct the
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
        for (const n of wanted) {
          if (m.text.includes(n)) {
            delete m._renderedHtml
            break
          }
        }
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
  // Merge k already-time-sorted runs into one ascending array, exploiting each
  // source's chronological order instead of re-sorting the whole pool every
  // frame (fairMerge runs once per render, ~60×/s on a busy tab). Tie policy:
  // equal byTimeStable → lowest run index first — deterministic across renders,
  // so the insert-only diff stays stable. k is the platform count (≤~4), so the
  // linear head-scan beats Array.sort's O(n log n) on the merged buffer.
  function mergeSortedRuns(runs) {
    const live = runs.filter((r) => r.length > 0)
    if (live.length === 0) return []
    if (live.length === 1) return live[0].slice()
    const idx = new Array(live.length).fill(0)
    let total = 0
    for (const r of live) total += r.length
    const out = new Array(total)
    let o = 0
    for (;;) {
      let best = -1
      for (let i = 0; i < live.length; i++) {
        if (idx[i] >= live[i].length) continue
        if (best === -1 || byTimeStable(live[i][idx[i]], live[best][idx[best]]) < 0) best = i
      }
      if (best === -1) break
      out[o++] = live[best][idx[best]++]
    }
    return out
  }

  function fairMerge(sources) {
    if (MC_DEBUG)
      log(
        'fairMerge sources:',
        sources.map((s) => s.length),
      )
    const limit = DOM_RENDER_CAP
    const active = sources.filter((s) => s.length > 0)
    if (active.length === 0) return []
    if (active.length === 1) {
      const s = active[0]
      // ALWAYS return a copy — the follow-event merge below splices into the
      // returned array in place. IRC/Kick getMessages/getTail already copy,
      // but YT sources are the raw channelYtMessages arrays; returning one by
      // ref let the splice permanently insert "X went live" events into that
      // buffer, which persistYt then serialized as fake chat history.
      return s.length <= limit ? s.slice() : s.slice(-limit)
    }

    // Co-live detection. When every source's newest msg lands within ~10 min
    // of each other AND is fresh (<1h old), both platforms are streaming now
    // — a firehose twitch can drown a trickle YT/kick, so apply the
    // proportional per-source cap to preserve fairness. Otherwise (offline
    // channel with sparse recent traffic, or sources timestamps far apart)
    // let chronological order rule so older historical msgs from a sparse
    // source don't get amputated by a too-small slice(-250).
    // ordOf (not raw .time): a live-paced YT source's newest msg may carry a
    // true send time far behind its display ord — coLive must read the SAME
    // key everything else sorts/merges on, or a paced YT source could look
    // "not co-live" by wall-clock time while rendering interleaved as if it were.
    const maxTimes = active.map((s) => ordOf(s[s.length - 1]) || 0)
    const newestMax = Math.max(...maxTimes)
    const oldestMax = Math.min(...maxTimes)
    const CO_LIVE_WINDOW_MS = 10 * 60 * 1000
    const RECENT_THRESHOLD_MS = 60 * 60 * 1000
    const coLive = newestMax - oldestMax < CO_LIVE_WINDOW_MS && newestMax > Date.now() - RECENT_THRESHOLD_MS

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
      const FLOOR = Math.min(40, Math.floor(limit / (active.length + 1)))
      // Each source is already ord-sorted (invariant #1), so its tail slice
      // is too — floorRuns are k already-sorted runs, disjoint by
      // construction (each drawn from a different source array).
      const floorRuns = active.map((s) => s.slice(-FLOOR))
      const seen = new Set()
      for (const run of floorRuns) for (const m of run) seen.add(m)
      // rest = each source's non-floor tail (a sorted run) → k-way merge, not sort.
      const rest = mergeSortedRuns(active.map((s) => s.filter((m) => !seen.has(m))))
      const floorPoolSize = floorRuns.reduce((n, r) => n + r.length, 0)
      const room = Math.max(0, limit - floorPoolSize)
      // rest is itself sorted, so its newest-`room` suffix is too.
      const restTail = room > 0 ? rest.slice(-room) : []
      // floorRuns + restTail are all disjoint, individually-sorted runs —
      // ONE more k-way merge finishes the job with no full-array sort.
      // (mergeSortedRuns' run-index tie-break keeps tied ords deterministic
      // across renders; the old pool.sort(byTimeStable) did the same via
      // stableMsgId — without a deterministic tiebreak the insert-only diff
      // would duplicate flipped pairs.)
      const pool = mergeSortedRuns([...floorRuns, restTail])
      if (typeof __HS_DEV_BUILD__ !== 'undefined' && __HS_DEV_BUILD__)
        _assertSortedByOrd(pool, 'fairMerge co-live pool')
      return pool.slice(-limit)
    }
    // Non-co-live: each source is already chronological, so merge the sorted
    // tails directly — no full re-sort of the merged buffer this frame.
    const merged = mergeSortedRuns(active.map((s) => s.slice(-limit)))
    if (typeof __HS_DEV_BUILD__ !== 'undefined' && __HS_DEV_BUILD__)
      _assertSortedByOrd(merged, 'fairMerge non-co-live merge')
    return merged.length <= limit ? merged : merged.slice(-limit)
  }
  // DEV-only correctness net for the merge paths above: mergeSortedRuns is
  // only a valid substitute for pool.sort() when every input run truly IS
  // sorted by ord (invariant #1 — every buffer stays sorted via insertOrdered/
  // sortedInsert). Folds away entirely in packaged builds (__HS_DEV_BUILD__ →
  // false, dead-code eliminated) — a violation here would otherwise surface
  // as a silent, hard-to-repro row-ordering glitch instead of a loud error.
  function _assertSortedByOrd(arr, label) {
    for (let i = 1; i < arr.length; i++) {
      if (ordOf(arr[i]) < ordOf(arr[i - 1])) {
        console.error(`[heatsync-ext] ${label}: not sorted at index ${i}`, arr[i - 1], arr[i])
        return
      }
    }
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
    const dt = ordOf(a) - ordOf(b)
    if (dt !== 0) return dt
    const ka = stableMsgId(a),
      kb = stableMsgId(b)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  }
  // Stable msgKey (rides stableMsgId's _sid memo). Deliberately EXCLUDES
  // _renderEpoch: an epoch-in-the-key meant every bump re-keyed every row, so
  // the diff saw 500 strangers, tore the list down and rebuilt it in fresh
  // fairMerge order — a visible whole-chat flash AND a row reorder whenever
  // the fresh sort disagreed with the never-move history order (mellen's
  // "posts flicker/reorder sometimes", 2026-07-17). Staleness now lives on
  // the row itself (data-hs-epoch); renderMessages rebuilds stale rows IN
  // PLACE, so order and scroll survive a bump by construction.
  function msgKeyOf(m) {
    return stableMsgId(m)
  }
  // Reused render-pass buffers: renderMessages is synchronous and never
  // re-enters itself mid-body, so per-run collections are safe to pool.
  const _rmDesiredKeys = []
  const _rmDesiredSet = new Set()
  const _rmExistingByKey = new Map()
  const _rmInsertedKeys = new Set()
  function zebraOfInsert(m, prevDiv) {
    if (!zebraEnabled || !prevDiv) return false
    if (
      m.type === 'stream-event' ||
      m.type === 'feed-post' ||
      m.type === 'inline-dm' ||
      m.type === 'moment' ||
      m.type === 'automod-hold'
    )
      return false
    return !prevDiv.classList.contains('hs-mc-zebra')
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
    } catch {
      _multistreamDismissed = new Set()
    }
    return _multistreamDismissed
  }
  function persistMultistreamDismissed() {
    try {
      chrome.storage.local.set({ hs_multistream_dismissed: [..._multistreamDismissed] })
    } catch {}
  }
  function hideMultistreamBanner() {
    const el = document.getElementById('hs-mc-multistream-banner')
    if (el) {
      el.hidden = true
      el.replaceChildren()
    }
  }
  async function maybeShowMultistreamBanner(channelName, platform) {
    const el = document.getElementById('hs-mc-multistream-banner')
    if (!el) return
    if (!channelName) {
      hideMultistreamBanner()
      return
    }
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
    if (dismissed.has(key)) {
      _multistreamLastResult = 'hidden'
      hideMultistreamBanner()
      return
    }
    if (typeof resolveIdentity !== 'function') {
      _multistreamLastResult = 'hidden'
      hideMultistreamBanner()
      return
    }
    const res = await resolveIdentity(channelName, platform ? { platform } : {})
    if (_multistreamLastChecked !== key) return
    if (!res?.ok || !res.identity) {
      _multistreamLastResult = 'hidden'
      hideMultistreamBanner()
      return
    }
    const id = res.identity
    const liveOn = res.liveOn || []
    if (liveOn.length < 2) {
      _multistreamLastResult = 'hidden'
      hideMultistreamBanner()
      return
    }
    // Find this streamer's config entry (any platform overlap). Suppress only
    // when it already covers every platform they're live on — an entry linked
    // as twitch+kick must still get the nudge when their youtube goes live.
    // config yt values may be full URLs while identity carries a handle, so
    // compare youtube by extracted @handle.
    const lower = channelName.toLowerCase()
    const ytHandleOf = (v) => {
      if (!v) return null
      const m = String(v).match(/@([^/?]+)/)
      return (m ? m[1] : String(v)).toLowerCase()
    }
    const matchEntry = config.channels.find((ch) => {
      const t = ch.twitch?.toLowerCase()
      const k = ch.kick?.toLowerCase()
      const y = ytHandleOf(ch.youtube)
      return (
        t === lower ||
        k === lower ||
        y === lower ||
        (id.twitch && t === id.twitch.toLowerCase()) ||
        (id.kick && k === id.kick.toLowerCase()) ||
        (id.youtube && y === ytHandleOf(id.youtube))
      )
    })
    const missingLive = liveOn.filter((p) => id[p] && !matchEntry?.[p])
    if (matchEntry && missingLive.length === 0) {
      _multistreamLastResult = 'hidden'
      hideMultistreamBanner()
      return
    }
    // Build banner. Copy stays name-free and lowercase — the banner sits on
    // the streamer's own tab, and the panel is ~360px wide: a display name
    // pushes the platform list (the whole point) past the ellipsis.
    const otherPlatforms = liveOn.filter((p) => p !== platform)
    _multistreamLastResult = 'shown'
    el.replaceChildren()
    el.hidden = false
    const text = document.createElement('span')
    text.className = 'hs-mc-multi-text'
    text.textContent = `also live on ${otherPlatforms.join(' + ')}`
    const linkBtn = document.createElement('button')
    linkBtn.className = 'hs-mc-multi-link'
    linkBtn.textContent = 'link channels'
    linkBtn.addEventListener('click', (e) => {
      e.preventDefault()
      // Merge into the existing entry when there is one — pushing a fresh
      // entry for an already-tabbed streamer would duplicate their tab.
      if (matchEntry) {
        if (id.twitch && !matchEntry.twitch) matchEntry.twitch = id.twitch
        if (id.kick && !matchEntry.kick) matchEntry.kick = id.kick
        if (id.youtube && !matchEntry.youtube) matchEntry.youtube = id.youtube
      } else {
        const entry = { id: `linked_${Date.now()}` }
        if (id.twitch) entry.twitch = id.twitch
        if (id.kick) entry.kick = id.kick
        if (id.youtube) entry.youtube = id.youtube
        config.channels.push(entry)
      }
      saveConfig()
      try {
        updateTabBar()
      } catch {}
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
    const ctxHandler = (e) => {
      e.preventDefault()
      dismissNow()
    }
    el._hsCtxDismiss = ctxHandler
    el.addEventListener('contextmenu', ctxHandler)
    el.append(text, linkBtn, dismissBtn)
  }

  // ── live-tab chat search / filter-by-user ─────────────────────────────────
  // Server-search + social tabs render their own content; every other tab (live
  // + per-channel) is an in-memory buffer the search bar filters locally and
  // instantly — no network round-trip.
  const _SERVER_TABS = new Set(['mentions', 'feed', 'whispers', 'discover', 'pinned', 'settings', 'add'])
  function isLiveSearchTab(id) {
    return typeof id === 'string' && !_SERVER_TABS.has(id)
  }
  // Active local-filter query for a live tab (trimmed, case preserved), else ''.
  // Case preservation is required so /Pattern/i vs /Pattern/ both work correctly.
  function liveSearchQuery(id) {
    if (!isLiveSearchTab(id)) return ''
    const el = document.getElementById('hs-mc-search-input')
    return el ? el.value.trim() : ''
  }

  // Clear the n/N match cursor (both the marked row and the remembered key).
  // Called whenever the query changes/clears or the tab switches — the same
  // "never bleeds across context" rule the filter query itself follows.
  function _clearLiveSearchCursor() {
    if (!_liveSearchCurrentKey) return
    _liveSearchCurrentKey = null
    const cur = document.querySelector('.hs-mc-search-current')
    if (cur) cur.classList.remove('hs-mc-search-current')
  }

  // n/N cursor step. The filter already renders ONLY matching rows, so every
  // .hs-mc-msg in msgsEl is a match — this just walks that list. Position is
  // re-derived from the DOM each call (rows.indexOf(prev)) rather than trusted
  // from stored state, so a re-render between keypresses (new msg arriving)
  // can never leave the cursor pointing at a stale/removed row.
  function cycleLiveSearchMatch(dir) {
    const msgsEl = document.getElementById('hs-mc-messages')
    if (!msgsEl) return
    const rows = [...msgsEl.querySelectorAll('.hs-mc-msg[data-msg-key]')]
    if (!rows.length) return
    const prev = msgsEl.querySelector('.hs-mc-search-current')
    if (prev) prev.classList.remove('hs-mc-search-current')
    const prevIdx = prev ? rows.indexOf(prev) : -1
    const idx = prevIdx === -1 ? (dir > 0 ? 0 : rows.length - 1) : (prevIdx + dir + rows.length) % rows.length
    const row = rows[idx]
    row.classList.add('hs-mc-search-current')
    _liveSearchCurrentKey = row.dataset.msgKey
    row.scrollIntoView({ behavior: 'instant', block: 'center' })
    const countEl = document.getElementById('hs-mc-search-count')
    if (countEl) countEl.textContent = `${idx + 1}/${rows.length}`
  }

  // Upward infinite-scroll: when the user reaches the top, paint the next chunk
  // of OLDER buffered messages (already in the 3000-deep ring) by growing the
  // render window and re-running the SAME diff renderer — so indexing, zebra,
  // mutes, cosmetics and epoch-keying all stay correct by construction. Anchors
  // scroll so the viewport doesn't jump when rows prepend above it.
  function loadOlderScrollback() {
    if (!isScrolledUp) return // only while the user is paused (scrolled up)
    if (
      currentTab === 'feed' ||
      currentTab === 'settings' ||
      currentTab === 'discover' ||
      currentTab === 'pinned' ||
      currentTab === 'modlog'
    )
      return
    if (_scrollbackWindow >= SCROLLBACK_MAX - DOM_RENDER_CAP) return // at the depth ceiling
    const msgsEl = document.getElementById('hs-mc-messages')
    if (!msgsEl) return
    // Try to grow the window, then check whether older rows actually appeared.
    // We don't pre-guard on a row count — rendered rows can sit just under the
    // cap (content filters, fair-merge) so a "< cap" test would false-bail one
    // short. Instead: bump, render, and revert if nothing older was available.
    const before = msgsEl.children.length
    const prevWindow = _scrollbackWindow
    const oldH = msgsEl.scrollHeight
    const oldTop = msgsEl.scrollTop
    _scrollbackWindow = Math.min(_scrollbackWindow + SCROLLBACK_STEP, SCROLLBACK_MAX - DOM_RENDER_CAP)
    isProgrammaticScroll = true
    try {
      renderMessages(currentTab, { bypassScrollPause: true })
    } catch (_) {}
    if (msgsEl.children.length > before) {
      // Anchor: keep the previously-visible content under the same viewport
      // offset (rows added above shift everything down by the height delta).
      msgsEl.scrollTop = oldTop + (msgsEl.scrollHeight - oldH)
    } else {
      _scrollbackWindow = prevWindow // buffer exhausted — don't inflate uselessly
    }
    cleanup.raf(() => {
      isProgrammaticScroll = false
    })
  }

  // Trailing collapse for hydration-class FULL rebuilds. On reload, every
  // per-channel history merge (twitch/kick/yt BG hydration) ends in its own
  // renderMessages(currentTab); several land across consecutive frames and the
  // back-to-back teardown+rebuild paints read as jumbled fly-in. Each request
  // (re)arms one short trailing window and a single render fires after the
  // last, capped at 400ms from the first request so a merge trickle can't
  // starve the paint. currentTab is read at fire time; the render only fires
  // for channel/live tabs — the old call sites' isCurrent guards never
  // repainted own-renderer tabs (settings/feed/…) from hydration, and firing
  // into them mid-interaction is the composer-rebuild bug class. User-driven
  // renders (tab click, scrollback, send) stay synchronous — never route them
  // through here.
  let _renderCollapseTimer = null
  let _renderCollapseFirstAt = 0
  function scheduleRenderMessages() {
    const now = Date.now()
    if (_renderCollapseTimer === null) _renderCollapseFirstAt = now
    else cleanup.clearTimeout(_renderCollapseTimer)
    const wait = Math.min(80, Math.max(16, 400 - (now - _renderCollapseFirstAt)))
    _renderCollapseTimer = cleanup.setTimeout(() => {
      _renderCollapseTimer = null
      if (currentTab === 'live' || getChannelById(currentTab)) renderMessages(currentTab)
    }, wait)
  }

  function renderMessages(id, opts) {
    if (editingChannel) return
    // Idempotent — ensures mod toolbar hover works even when extension reloads
    // mid-session (the overlay-init setTimeout doesn't re-fire).
    const _msgsForMod = document.getElementById('hs-mc-messages')
    if (_msgsForMod && !_msgsForMod._hsModToolbarWired) wireModToolbarHover(_msgsForMod)
    // Pre-fetch isMod for the active channel so first hover is instant.
    if (typeof id === 'string' && /^[a-z0-9_]{2,40}$/i.test(id)) prefetchModFor(id)
    // Symmetric kick warm-up — so the first kick right-click/hover surfaces mod
    // actions without a cold-cache miss (resolve the linked kick slug for this tab).
    const _chForMod = typeof getChannelById === 'function' ? getChannelById(id) : null
    if (_chForMod?.kick) prefetchKickModFor(_chForMod.kick)
    // Profile card overrides normal tab content while open
    if (typeof activeProfileCard !== 'undefined' && activeProfileCard) {
      renderProfileCardView()
      return
    }
    // Predictions/polls take the chat area the same way. Without this guard the
    // next incoming message repaints chat straight over the open view.
    if (typeof predViewOpen === 'function' && predViewOpen()) {
      renderPredView()
      return
    }
    // Social tabs have their own renderers — banner doesn't apply there
    if (id === 'feed') {
      hideMultistreamBanner()
      renderFeed()
      return
    }
    if (id === 'whispers') {
      hideMultistreamBanner()
      renderWhispersTab()
      return
    }
    if (id === 'discover') {
      hideMultistreamBanner()
      renderDiscoverTab()
      return
    }
    if (id === 'pinned') {
      hideMultistreamBanner()
      renderPinnedTab()
      return
    }
    if (id === 'modlog') {
      hideMultistreamBanner()
      renderModLogTab()
      return
    }
    if (id === 'settings') {
      hideMultistreamBanner()
      renderSettingsTab()
      return
    }
    if (id === 'mentions') {
      hideMultistreamBanner()
    }
    // Banner: streamer-tab only (live or per-channel)
    if (id === 'live') {
      const liveCh = getLiveChannel()
      maybeShowMultistreamBanner(liveCh, hostPlatform)
    } else if (
      id &&
      id !== 'add' &&
      !['mentions', 'feed', 'whispers', 'discover', 'pinned', 'modlog', 'settings'].includes(id)
    ) {
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
      if (searchInput?.value.trim()) return
    }

    const msgsEl = document.getElementById('hs-mc-messages')
    if (!msgsEl) return

    // Consume the cache-restored flag exactly once per render, here — BEFORE the
    // scrolled-up early-return below. If we only reset it at the fast-path site
    // (further down), a scrolled-up render returns early and strands the flag
    // true; the NEXT render — for a different, uncached tab — then wrongly takes
    // the append-only "trust mounted DOM" path and bleeds the prior channel's
    // messages into the new view. Capturing it now scopes it to this one render.
    const justRestored = _cacheJustRestored
    _cacheJustRestored = false

    const newBtn = document.getElementById('hs-mc-new-msgs')

    // Scrolled-up readers normally don't re-render (live msgs just bump the
    // "N new" counter). loadOlderScrollback passes bypassScrollPause so it CAN
    // re-render while paused — to paint older rows — without yanking the view
    // (it anchors scroll itself afterward).
    if (isScrolledUp && !opts?.bypassScrollPause) {
      newMessageCount++
      if (newBtn) {
        newBtn.innerHTML = `<span class="hs-arrow-down">▼</span> ${newMessageCount} new`
        newBtn.style.display = 'flex'
      }
      return
    }

    let msgs = []
    // Set when a tab has messages but its T/K/Y filter hides ALL of them, so the
    // empty state can say so + offer a one-click reveal instead of a dead blank
    // panel (a filter must never make a tab look broken). See tab-messages.js.
    let _tabFilterHidden = null

    if (id === 'mentions') {
      msgs = mentionsBuffer
    } else if (id === 'add') {
      hideMultistreamBanner()
      renderAddChannelForm(msgsEl)
      return
    } else if (id === 'live') {
      const curCh = getLiveChannel()
      const platNames = getLivePlatformNames()
      // Use platform-specific names (may differ from curCh if overridden).
      // yt: no same-name fallback — curCh is a videoId/@handle, not a
      // twitch/kick channel (same rule as the boot auto-join; falling back
      // here silently re-joined the ghost videoId channel on every render).
      const urlChFallback = hostPlatform === 'yt' ? '' : curCh
      const twitchCh = platNames.twitch || urlChFallback
      const kickCh = platNames.kick || urlChFallback
      // Ensure channels are joined + history loaded
      if (twitchCh && irc && !irc.channels.has(twitchCh.toLowerCase())) irc.join(twitchCh)
      if (kickCh && kickChat && !kickChat.channels.has(kickCh.toLowerCase())) kickChat.join(kickCh)
      // getTail (not getMessages/getAll): the render only ever shows the
      // newest SCROLLBACK_MAX rows (the hard DOM ceiling below), so there's
      // no reason to copy the full 3000-cap buffer every render.
      const ircMsgs = twitchCh ? irc?.getTail(twitchCh, SCROLLBACK_MAX) || [] : []
      let kickMsgs = kickCh ? kickChat?.getTail(kickCh, SCROLLBACK_MAX) || [] : []
      if (!kickMsgs.length && curCh) {
        // Check if any config entry links current channel to a Kick channel
        const linked = config.channels.find((ch) => ch.twitch === curCh && ch.kick)
        if (linked) kickMsgs = kickChat?.getTail(linked.kick, SCROLLBACK_MAX) || []
      }
      // On Kick, also pull messages from the URL channel (may differ from live override)
      if (!kickMsgs.length && hostPlatform === 'kick') {
        const urlCh = getCurrentChannel()
        if (urlCh && urlCh !== curCh) kickMsgs = kickChat?.getTail(urlCh, SCROLLBACK_MAX) || []
      }
      // YouTube messages for live tab: auto-discovered or linked via config
      let ytMsgs = channelYtMessages.get('__live_yt_auto__') || []
      if (!ytMsgs.length && curCh) {
        const linkedYt = config.channels.find((ch) => (ch.twitch === curCh || ch.kick === curCh) && ch.youtube)
        if (linkedYt) ytMsgs = channelYtMessages.get(linkedYt.id) || []
      }
      const sel = selectTabSources({ twitch: ircMsgs, kick: kickMsgs, youtube: ytMsgs }, getPlatformFilter('live'))
      _tabFilterHidden = sel.hiddenByFilter ? sel : null
      msgs = fairMerge(sel.included)
    } else {
      // Channel tab — merge IRC + Kick + per-channel YouTube messages
      const ch = getChannelById(id)
      const twitchName = ch?.twitch
      const kickName = ch?.kick
      const ircMsgs = twitchName ? irc?.getTail(twitchName, SCROLLBACK_MAX) || [] : []
      const kickMsgs = kickName ? kickChat?.getTail(kickName, SCROLLBACK_MAX) || [] : []
      // YouTube ONLY from this channel's own explicit link. The global
      // __live_yt_auto__ bucket (the host page's auto-discovered YT, bound to
      // whatever stream is focused) must NOT merge into a per-channel tab — that
      // bleeds an unrelated stream's YT chat into this channel (e.g. a focused
      // jynxzi tab leaking into nl_kripp). __live_yt_auto__ is the live tab's
      // alone. Explicitly-linked channels already get their YT via
      // channelYtMessages[id]. See [[heatsync_yt_handle_guess_bleed]].
      const ytMsgs = channelYtMessages.get(id) || []
      const sel = selectTabSources({ twitch: ircMsgs, kick: kickMsgs, youtube: ytMsgs }, getPlatformFilter(id))
      _tabFilterHidden = sel.hiddenByFilter ? sel : null
      msgs = fairMerge(sel.included)
    }

    // Merge follow stream events into channel + live tabs (went live,
    // switched game, went offline). Skip mentions: it's reserved for actual
    // @-mentions of the user, not followed-channel stream events. msgs is
    // already chronological from fairMerge, and `missing` is tiny, so
    // binary-insert each at its position instead of re-sorting the whole buffer.
    if (id !== 'mentions' && activityEvents.length > 0 && msgs.length > 0) {
      // Cheap pre-filter first: only scan msgs for existing stream-event texts
      // when there actually are follow-class events to merge — activityEvents
      // is usually all non-follow, and the msgs scan is O(buffer) per render.
      let followEvents = null
      for (const e of activityEvents) {
        if (e.eventClass?.includes('event-follow')) (followEvents ??= []).push(e)
      }
      const existingTexts = followEvents
        ? new Set(msgs.filter((m) => m.type === 'stream-event').map((m) => m.text))
        : null
      const missing = followEvents ? followEvents.filter((e) => !existingTexts.has(e.text)) : []
      for (const e of missing) {
        let lo = 0
        let hi = msgs.length
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (byTimeStable(msgs[mid], e) < 0) lo = mid + 1
          else hi = mid
        }
        msgs.splice(lo, 0, e)
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
      if (id === 'live' && !config.channels?.length) {
        const title = document.createElement('div')
        title.style.cssText = 'font-weight:600;margin-bottom:4px'
        title.textContent = 'add your streams'
        const sub = document.createElement('div')
        sub.style.cssText = 'opacity:.7;margin-bottom:10px'
        sub.textContent = 'merge twitch, kick + youtube chat in one panel'
        const btn = document.createElement('button')
        btn.style.cssText =
          'cursor:pointer;padding:6px 12px;border:1px solid currentColor;background:transparent;color:inherit;font:inherit'
        btn.textContent = '+ add a channel'
        try {
          cleanup.addEventListener(btn, 'click', () => {
            try {
              switchTab('add')
            } catch (_) {}
          })
        } catch (_) {}
        empty.appendChild(title)
        empty.appendChild(sub)
        // (falls through to the add-channel button appended below)
        empty.appendChild(btn)
      } else if (_tabFilterHidden) {
        // Messages exist but the tab's T/K/Y filter is hiding every one of them.
        // Say so + offer a one-click reveal — NEVER a silent blank that reads as
        // "no chat" (that exact failure swallowed a debugging night).
        const plats = _tabFilterHidden.availablePlatforms.map((p) => p.toUpperCase()).join('/')
        const n = _tabFilterHidden.hiddenCount
        const line = document.createElement('div')
        line.style.cssText = 'opacity:.75;margin-bottom:10px'
        line.textContent = `${n} ${plats} message${n === 1 ? '' : 's'} hidden by filter`
        const btn = document.createElement('button')
        btn.style.cssText =
          'cursor:pointer;padding:6px 12px;border:1px solid currentColor;background:transparent;color:inherit;font:inherit'
        btn.textContent = 'show all'
        try {
          cleanup.addEventListener(btn, 'click', () => {
            try {
              for (const p of _tabFilterHidden.availablePlatforms) {
                if (!getPlatformFilter(id)[p]) togglePlatformFilter(id, p)
              }
              renderPlatformFilterButtons()
              renderMessages(id)
            } catch (_) {}
          })
        } catch (_) {}
        empty.appendChild(line)
        empty.appendChild(btn)
      } else if (isTabConnecting(id)) {
        // Not wired up yet — say so rather than claiming an empty chat we
        // haven't actually connected to.
        empty.textContent = t('mc_connecting')
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
      if (first?.time && first.time < cutoff) {
        msgs = msgs.filter((m) => m.type !== 'stream-event' || !m.time || m.time >= cutoff)
      }
    }

    const _ff = _filterFlags()
    let toRender = msgs.filter((m) => !m?.hidden && !isMsgFiltered(m, _ff))
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
    // Live-tab local filter: matcher compiled ONCE per query (not per message)
    // so /regex/ patterns, ReDoS guards, and @user/text modes are all O(1) setup.
    const _liveQ = liveSearchQuery(id)
    const _liveMatcher = _liveQ ? buildLiveSearchMatcher(_liveQ) : null
    const _liveCountEl = document.getElementById('hs-mc-search-count')
    if (_liveMatcher) {
      toRender = toRender.filter((m) => _liveMatcher.test(m))
      if (_liveCountEl) {
        // Plain total normally; "i/N" while an n/N cursor is active. The
        // cursor is keyed by msgKey (not a DOM ref), so its position is
        // re-derived from the freshly filtered array on every render — if
        // the current match dropped out of the filter (dedup, trim, edit),
        // this naturally falls back to the plain total and drops the cursor.
        const _curIdx = _liveSearchCurrentKey ? toRender.findIndex((m) => msgKeyOf(m) === _liveSearchCurrentKey) : -1
        if (_liveSearchCurrentKey && _curIdx === -1) _liveSearchCurrentKey = null
        _liveCountEl.textContent = _curIdx >= 0 ? `${_curIdx + 1}/${toRender.length}` : String(toRender.length)
        _liveCountEl.classList.add('visible')
      }
      if (toRender.length === 0) {
        _clearMessageIndices()
        msgsEl.textContent = ''
        const empty = document.createElement('div')
        empty.className = 'hs-mc-empty'
        empty.textContent = 'no matches'
        msgsEl.appendChild(empty)
        return
      }
    } else {
      if (_liveCountEl) _liveCountEl.classList.remove('visible')
      _clearLiveSearchCursor()
    }
    // Live tail is always DOM_RENDER_CAP; _scrollbackWindow adds older rows
    // when the user has scrolled to the top (loadOlderScrollback). Capped at
    // SCROLLBACK_MAX so the DOM stays bounded on low-RAM hardware.
    const _renderCap = Math.min(DOM_RENDER_CAP + _scrollbackWindow, SCROLLBACK_MAX)
    toRender = toRender.slice(-_renderCap)
    isProgrammaticScroll = true

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
    // fairMerge below). no shuffling. no rebuild-from-prefix flash. rows whose
    // data-hs-epoch predates _renderEpoch are rebuilt via same-slot replaceChild
    // in PASS B — even a full invalidation never moves a row. Collections are
    // pooled (_rm* buffers above stableMsgId); zebra lives in zebraOfInsert.
    const desiredKeys = _rmDesiredKeys
    const desiredSet = _rmDesiredSet
    desiredKeys.length = 0
    desiredSet.clear()
    for (let j = 0; j < toRender.length; j++) {
      const k = msgKeyOf(toRender[j])
      desiredKeys.push(k)
      desiredSet.add(k)
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
      const insertedKeys = _rmInsertedKeys
      insertedKeys.clear()
      for (let j = 0; j < toRender.length; j++) {
        const key = desiredKeys[j]
        if (insertedKeys.has(key)) continue
        insertedKeys.add(key)
        if (_msgKeyIndex.has(key)) continue // already in DOM somewhere — leave it
        const m = toRender[j]
        const div = buildMessageDiv(m, id)
        if (!div) continue
        div.dataset.msgKey = key
        div.dataset.hsEpoch = String(_renderEpoch)
        const prev = msgsEl.lastElementChild
        if (zebraOfInsert(m, prev)) div.classList.add('hs-mc-zebra')
        msgsEl.appendChild(div)
        _indexMessageDiv(div, key)
        _snapCompleteEmotes(div)
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
      // HeatSync paints are a SEPARATE cache from 7TV cosmetics (hsPaintCache
      // in paints.js vs mcUserCosmetics here) — a paint can already be
      // resolved even when mcUserCosmetics has nothing for this uid, so it
      // needs its own re-apply pass here too. Without this, a painted user's
      // restored rows (reload, tab-switch-back) stay unpainted forever: the
      // cache-restored fast path returns below and never calls
      // buildMessageDiv, which is the only other place that applies a paint.
      // Plus tenure has the exact same restored-fragment gap as HeatSync
      // paints above — a cached fragment predates this session's tenure
      // resolution, so an already-active Plus member's restored rows never
      // show the token without this pass.
      const _restoredCosUids = []
      const _restoredPaintUids = []
      const _restoredPlusUids = []
      for (const m of toRender) {
        if (!m.userId) continue
        if (mcUserCosmetics.has(m.userId)) _restoredCosUids.push(m.userId)
        else queueMcCosmeticsLookup(m.userId)
        if (hasResolvedHsPaint(m.userId)) _restoredPaintUids.push(m.userId)
        const since = getHsPlusTenureSince(m.userId)
        if (since) _restoredPlusUids.push(m.userId)
        else if (since === undefined) queuePlusTenureLookup(m.userId)
      }
      if (_restoredCosUids.length) updateCosmeticsInPlace([...new Set(_restoredCosUids)])
      if (_restoredPaintUids.length) updateHsPaintsInPlace([...new Set(_restoredPaintUids)])
      if (_restoredPlusUids.length) applyHsPlusTenureToVisible([...new Set(_restoredPlusUids)])
      cleanup.raf(() => {
        isProgrammaticScroll = false
      })
      if (
        !isScrolledUp &&
        !(id === 'feed' || id === 'settings' || id === 'discover' || id === 'pinned' || id === 'modlog')
      ) {
        scrollMsgsToBottom(msgsEl)
      }
      return
    }

    // PASS A: index existing DOM by msgKey, dedup pre-existing duplicates,
    // detach yt-status notices for re-pin at end, drop everything else not in
    // desiredSet. Pre-existing dupes can exist when a prior buggy diff (or
    // a code path that bypassed the diff) inserted twice — heal them here so
    // the renderer is self-correcting across reloads of buggy state.
    const existingByKey = _rmExistingByKey
    existingByKey.clear()
    const detachedExtras = []
    // Walk the LIVE HTMLCollection in place instead of materializing
    // [...msgsEl.children] (up to DOM_RENDER_CAP+scrollback nodes, every
    // render). Safe because we only ever advance `i` when the current child
    // is KEPT: removing children[i] slides the next child into that same
    // index, so re-checking index i next iteration is correct — nothing is
    // skipped, and nothing here reorders a kept node.
    for (let i = 0; i < msgsEl.children.length; ) {
      const c = msgsEl.children[i]
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
          continue
        }
        existingByKey.set(k, c)
      } else {
        _unindexMessageDiv(c)
        c.remove()
        continue
      }
      i++
    }

    // Bulletproof sticky-bottom: if the user hasn't scrolled up via input,
    // we re-pin unconditionally. Geometric "wasAtBottom" snapshot was
    // unreliable — a width rewrap, image-load reflow, or content-visibility
    // resolve could shift scrollTop a few px and flip the gate to false even
    // though the user logically was at-bottom.
    const isStaticRender = id === 'feed' || id === 'settings' || id === 'discover' || id === 'pinned' || id === 'modlog'

    // PASS B: walk desired list, insert NEW nodes at their sorted position.
    // Existing nodes are NEVER moved — rule (1) above is literal: once the
    // user has seen two rows in an order, that order is history and stays.
    // The old code insertBefore'd an existing node whenever fairMerge's fresh
    // sort disagreed with DOM order — but the co-live floor/rest split (and
    // the yt pacer's commit-time stamps) can legally flip already-rendered
    // neighbors between two renders, and each flip was a visible row shuffle
    // (mellen's "order glitches after I post, heals in ~5s", 2026-07-14).
    // Instead we DEFER: leave the node where it is and don't advance domIdx;
    // the walk re-aligns when it reaches that node's actual DOM position.
    // Duplicate-key accumulation is still impossible — dupes are healed in
    // PASS A, and a found `existing` never builds a second div.
    // Per-render insertedKeys set — even if two buffer entries collide on
    // stableMsgId (rare: same user, same ms post-pacer-commit, same text-
    // prefix), the second occurrence is skipped so DOM stays one-per-key.
    const insertedKeys = _rmInsertedKeys
    insertedKeys.clear()
    let domIdx = 0
    for (let j = 0; j < toRender.length; j++) {
      const key = desiredKeys[j]
      if (insertedKeys.has(key)) continue
      insertedKeys.add(key)
      const cur = msgsEl.children[domIdx]
      const existing = existingByKey.get(key)
      if (existing) {
        existingByKey.delete(key)
        const _rm = toRender[j]
        // Reused div skipped buildMessageDiv — re-queue its cosmetic so a prior
        // failed/absent lookup is retried (resolves on a later flush). Without
        // this, a frozen channel's restored buffer never re-attempts cosmetics.
        if (_rm?.userId && !mcUserCosmetics.has(_rm.userId)) queueMcCosmeticsLookup(_rm.userId)
        // Stale epoch → the row's rendered output is invalidated (emote
        // animation toggle, rerender setting, badge bulk-load). Rebuild the
        // div and swap it IN THE SAME SLOT — position, zebra stripe, and
        // scroll geometry all survive. This replaces the old "epoch re-keys
        // everything → teardown + fresh-sort rebuild" path that flashed and
        // reordered the visible list.
        if (existing.dataset.hsEpoch !== String(_renderEpoch)) {
          const nd = buildMessageDiv(_rm, id)
          if (nd) {
            nd.dataset.msgKey = key
            nd.dataset.hsEpoch = String(_renderEpoch)
            // Recompute (not copy) zebra from the actual previous sibling: the
            // walk replaces in DOM order, so alternation stays consistent — and
            // a zebra toggle-OFF bump actually strips stripes from old rows.
            if (zebraOfInsert(_rm, existing.previousElementSibling)) nd.classList.add('hs-mc-zebra')
            _unindexMessageDiv(existing)
            msgsEl.replaceChild(nd, existing)
            _indexMessageDiv(nd, key)
          } else {
            // Message no longer renderable under new state — keep the old row
            // (dropping it would move neighbors) and stop re-attempting.
            existing.dataset.hsEpoch = String(_renderEpoch)
          }
        }
        if (cur === existing) domIdx++ // aligned — consume the DOM slot
        // else: deferred — node stays put, walk catches up to it later
        continue
      }
      // Build new msg div at correct position.
      const m = toRender[j]
      const div = buildMessageDiv(m, id)
      if (!div) continue
      div.dataset.msgKey = key
      div.dataset.hsEpoch = String(_renderEpoch)
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
    cleanup.raf(() => {
      isProgrammaticScroll = false
    })
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

  // Get platform overrides for the current live channel (or defaults from URL)
  function getLivePlatformNames() {
    const urlCh = getCurrentChannel()?.toLowerCase()
    if (!urlCh) return { twitch: '', kick: '', youtube: '' }
    const overrides = livePlatformMap[urlCh]
    // Same-name fallback is only safe between twitch↔kick. On a YouTube page
    // urlCh is a video id or @handle — guessing it as a twitch/kick channel
    // joins junk channels (bogus IRC joins + external history fetches) and can
    // bleed a real same-named twitch/kick chat into this stream. Mirror of the
    // yt-handle-guess rule below: cross-platform on yt pages is explicit-only.
    const sameNameOk = hostPlatform !== 'yt'
    return {
      twitch: overrides?.twitch ?? (sameNameOk ? urlCh : ''),
      kick: overrides?.kick ?? (sameNameOk ? urlCh : ''),
      // No YT fallback: a guessed youtube.com/@<urlCh>/live resolves to whoever
      // owns that handle (often a different person) and bleeds their live chat
      // into this channel. YouTube must be linked explicitly — same-name across
      // platforms is a safe assumption for Twitch/Kick, NOT for YouTube handles.
      youtube: overrides?.youtube ?? '',
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

  function updateTabIndicator(tabId) {
    const tab = tabBarElement?.querySelector(`[data-tab="${tabId}"]`)
    if (!tab || currentTab === tabId) return
    if (tab.classList.contains('has-new') && (tabId !== 'mentions' || tab.classList.contains('has-mentions'))) return

    // Don't light up duplicate tabs showing the same channel
    // If on live, suppress channel tab indicator for the live channel
    // If on a channel tab, suppress live tab indicator for the same channel
    const liveCh = getLiveChannel()?.toLowerCase()
    if (liveCh) {
      if (currentTab === 'live' && tabId !== 'feed' && tabId !== 'mentions') {
        const chConfig = getChannelById(tabId)
        if (chConfig) {
          const tw = chConfig.twitch?.toLowerCase()
          const ki = chConfig.kick?.toLowerCase()
          if (tw === liveCh || ki === liveCh) return
        }
      }
      if (tabId === 'live') {
        const curConfig = getChannelById(currentTab)
        if (curConfig) {
          const tw = curConfig.twitch?.toLowerCase()
          const ki = curConfig.kick?.toLowerCase()
          if (tw === liveCh || ki === liveCh) return
        }
      }
    }

    tab.classList.add('has-new')
    if (tabId === 'mentions') tab.classList.add('has-mentions')
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

  let liveStatusInterval = null
  let _lastLiveStatusPoll = 0
  let _liveStatusInFlight = false
  // Cached SW snapshot of followed-user live state. Refreshed by the SW alarm
  // every 60s and pushed via `live_followed_updated`. We use it to short-circuit
  // /api/platform/live-status calls for channels the SW already covers — at
  // 100k users this turns the per-content 30s poll into a no-op for most users.
  // (declared beside liveChannelSet at the top — isChannelLive() reads both)

  function startLiveStatusPolling() {
    // Seed from SW cached snapshot, so first paint doesn't wait on the network.
    try {
      chrome.runtime
        .sendMessage({ type: 'get_live_followed' })
        .then((resp) => {
          if (resp?.snapshot) _applyFollowedSnapshot(resp.snapshot)
          updateLiveStatus()
        })
        .catch(() => updateLiveStatus())
    } catch {
      updateLiveStatus()
    }
    // Backup poll covers channels the SW doesn't follow (popout / unfollowed).
    // Extended 30s → 90s — SW broadcast handles freshness for the common case.
    liveStatusInterval = cleanup.setInterval(updateLiveStatus, 90000)
  }

  function _applyFollowedSnapshot(snapshot) {
    if (!Array.isArray(snapshot)) return
    _swLiveSet = new Set(
      snapshot
        .filter((s) => s.platform === 'twitch' || s.platform === 'kick')
        .map((s) => String(s.username || '').toLowerCase())
        .filter(Boolean),
    )
    // Re-stamp unconditionally. _swLiveSet has just been REPLACED (not merged),
    // so an empty snapshot is real information — "none of the channels you
    // follow are live" — and has to be able to clear a dot.
    if (!tabBarElement) return
    applyLiveDotsFromCache()
  }

  // Debounced re-poll — call when user activity suggests stale dots are
  // worth refreshing (tab switch, panel re-open, page focus). Skips the
  // network round-trip if we polled <5s ago to avoid hammering helix.
  function refreshLiveStatusSoon() {
    if (_liveStatusInFlight) return
    if (Date.now() - _lastLiveStatusPoll < 5000) return
    updateLiveStatus()
  }

  async function updateLiveStatus() {
    if (!tabBarElement) return
    // Split config channels by platform — the live-status API takes twitch
    // names in `channels` and kick slugs in `kickChannels`. Bug #7: the poll
    // used to send every channel as a twitch name, so Kick-only tabs queried
    // helix with their kick slug and always came back not-live (their dots
    // flickered off every 90s). Mirror the picker — query each platform's API.
    const twitchAll = []
    const kickAll = []
    for (const ch of config.channels) {
      // Query BOTH platforms independently. A dual-platform tab (same person on
      // twitch AND kick) must be checked on kick too — the old `else if (kick)`
      // only ran for kick-ONLY tabs, so a streamer live on kick but not twitch
      // got queried on helix (offline) and never on kick, showing no live dot.
      // Kick-only and legacy twitch-id-only paths are unchanged.
      if (ch.twitch) twitchAll.push(ch.twitch)
      if (ch.kick) kickAll.push(ch.kick)
      if (!ch.twitch && !ch.kick && ch.id && !ch.youtube) twitchAll.push(ch.id) // legacy twitch-id-only entries
    }
    const urlCh = getCurrentChannel()
    if (urlCh) {
      const u = urlCh.toLowerCase()
      if (hostPlatform === 'kick') {
        if (!kickAll.some((c) => c.toLowerCase() === u)) kickAll.push(urlCh)
      } else if (!twitchAll.some((c) => c.toLowerCase() === u)) {
        twitchAll.push(urlCh)
      }
    }
    if (twitchAll.length === 0 && kickAll.length === 0) return

    // Skip the twitch fetch for names the SW live snapshot already covers
    // (most followed channels at scale). The SW snapshot is twitch-only, so
    // kick slugs are always queried fresh.
    const twitchNames = _swLiveSet ? twitchAll.filter((c) => !_swLiveSet.has(c.toLowerCase())) : twitchAll

    if (twitchNames.length === 0 && kickAll.length === 0) {
      applyLiveDotsFromCache()
      _lastLiveStatusPoll = Date.now()
      return
    }

    _liveStatusInFlight = true
    _lastLiveStatusPoll = Date.now()
    try {
      const data = await chrome.runtime.sendMessage({
        type: 'fetch_live_status',
        channels: twitchNames,
        kickChannels: kickAll,
      })
      // If we asked for twitch names but got no twitch array back, the call
      // failed — keep the last good snapshot rather than clobbering dots.
      if (twitchNames.length > 0 && !Array.isArray(data?.live)) {
        applyLiveDotsFromCache()
        return
      }
      // Merge SW snapshot + fresh twitch + fresh kick into one live set, then
      // stamp every tab (both platforms) via the shared cache-applier so
      // Kick-only tabs light up from kickLive, not the twitch set.
      // Poll-owned set ONLY. Folding _swLiveSet in here is what made a stale
      // snapshot entry survive every subsequent poll; isChannelLive() reads both.
      const liveSet = new Set([
        ...(Array.isArray(data?.live) ? data.live.map((c) => c.toLowerCase()) : []),
        ...(Array.isArray(data?.kickLive) ? data.kickLive.map((c) => c.toLowerCase()) : []),
      ])
      liveChannelSet = liveSet
      applyLiveDotsFromCache()

      // Update live tab's own red dot based on selected channel. On a YT
      // host page the "selected channel" is a videoId (e.g. jfKfPfyJRdk),
      // which is never in the Twitch live-set, so we'd always stamp 'false'
      // and clobber the chatframe-based detection. Defer to detectOfflineState.
      if (hostPlatform !== 'yt') {
        const liveTab = tabBarElement?.querySelector('[data-tab="live"]')
        const curLive = getLiveChannel()?.toLowerCase()
        if (liveTab) liveTab.dataset.live = String(curLive && liveSet.has(curLive))
      }

      // If override channel went offline, fall back to URL channel or first live
      if (liveChannel && !liveSet.has(liveChannel)) {
        liveChannel = null
        updateLiveTabLabel()
        _dropTabCache('live')
        if (currentTab === 'live') renderMessages('live')
      }

      // Auto-select if no override and URL channel isn't live but others are
      if (!liveChannel && urlCh && !liveSet.has(urlCh.toLowerCase()) && liveSet.size > 0) {
        // Don't auto-override — user can pick via the menu
      }
    } catch (_) {
      // Network error — re-apply last known good snapshot so stale dots
      // don't persist past their truth window.
      applyLiveDotsFromCache()
    } finally {
      _liveStatusInFlight = false
    }
  }

  // Re-stamp data-live on every channel tab from the cached liveChannelSet,
  // so a failed fetch / DOM re-render race / late tabbar mutation can't leave
  // a stale dot showing. Single source of truth: liveChannelSet.
  function applyLiveDotsFromCache() {
    if (!tabBarElement) return
    config.channels.forEach((ch) => {
      const id = ch.id
      const tab = tabBarElement.querySelector(`[data-tab="${id}"]`)
      if (!tab) return
      const isYtOnly = !ch.twitch && !ch.kick && ch.youtube
      if (isYtOnly) return
      // Check both twitch + kick slugs so Kick-only channels (and pairs whose
      // twitch handle differs from kick slug) get the live dot too.
      const tw = ch.twitch?.toLowerCase()
      const ki = ch.kick?.toLowerCase()
      const idLower = id?.toLowerCase()
      const isLive = isChannelLive(tw) || isChannelLive(ki) || (!tw && !ki && isChannelLive(idLower))
      tab.dataset.live = String(isLive)
    })
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
    'directory',
    'settings',
    // auth-flow paths — the 3-account login odyssey (2026-07-14) created
    // persisted ghost channels 'login'/'oauth2' with IRC joins + auto tabs
    'login',
    'logout',
    'signup',
    'oauth',
    'oauth2',
    'activate',
    'checkout',
    'videos',
    'moderator',
    'subscriptions',
    'search',
    'help',
    'about',
    'jobs',
    'contact',
    'wallet',
    'inventory',
    'friends',
    'admin',
    'broadcast',
    'drops',
    'store',
    'popout',
    'embed',
    // twitch-specific
    'partners',
    'turbo',
    'prime',
    'p',
    'subs',
    'turbo-faq',
    'bits',
    // kick-specific
    'browse',
    'category',
    'categories',
    'community',
    'clips',
    'leaderboards',
    'dashboard',
    'vods',
    'u',
    'auth',
    'authorize',
  ])

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

    // Channel pages live on the apex/www/m hosts only. Sibling subdomains
    // (dashboard.kick.com, dashboard.twitch.tv, help.*, dev.*) reuse
    // channel-shaped paths — the kick creator dashboard's /moderation and
    // /stream routes spoofed real channels here and fired FFZ/emote lookups
    // for "moderation". A path blocklist can't keep up with their routes;
    // gate on host instead.
    if (!/^(www\.|m\.)?(twitch\.tv|kick\.com)$/.test(location.hostname)) return null

    // Match /username or /popout/username/chat or /embed/username/chat
    const match = location.pathname.match(/^\/(?:popout\/|embed\/)?([a-zA-Z0-9_-]+)/)
    if (match?.[1]) {
      const channel = match[1].toLowerCase()
      // Skip non-channel pages (shared module-scope Set above).
      if (NON_CHANNEL_PATHS.has(channel)) {
        return null
      }
      return channel
    }
    return null
  }

  /** Channel the live tab is currently showing (override or URL fallback) */
  function getLiveChannel() {
    return liveChannel || getCurrentChannel()
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
    return (
      config.channels.some((ch) => {
        const tw = ch.twitch?.toLowerCase()
        const ki = ch.kick?.toLowerCase()
        return (tw === curCh && ki === mc) || (ki === curCh && tw === mc)
      }) ||
      // On Kick, URL channel messages always belong to live tab
      (hostPlatform === 'kick' && mc === getCurrentChannel()?.toLowerCase())
    )
  }

  /** Update the live tab button label to show the channel it's bound to, so the
   *  tab reads as a real selection ("lofigirl") instead of a generic "live"
   *  that looks unselected while its chat streams in on auto-live. */
  function updateLiveTabLabel() {
    const liveTab = tabBarElement?.querySelector('[data-tab="live"]')
    if (!liveTab) return
    const cur = getCurrentChannel()?.toLowerCase()
    const override = liveChannel
    let name = ''
    if (override && override !== cur) {
      name = override
    } else if (cur) {
      // youtube: getCurrentChannel is the 11-char videoId — swap for the
      // resolved channel name when we have it, else keep the generic label
      // (never show a raw videoId as the tab name).
      if (hostPlatform === 'yt') {
        name = youtubeLinks.get('__live_yt_auto__')?.channelName || ''
      } else {
        name = cur
      }
    }
    liveTab.textContent = name ? t('mc_tab_live_channel', [name]) : t('mc_tab_live')
  }

  /** Query background script for all channels the user has open tabs for */
  async function getWatchingChannels() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'get_watching_channels' })
      return resp?.channels || []
    } catch (_) {
      return []
    }
  }

  /**
   * Resolve a live candidate ({name, platform, youtubeUrl?}) to a real channel tab.
   * Auto-adds the channel to config.channels so 'live' is a launcher, never the sticky tab.
   */
  async function resolveLiveCandidateToTab({ name, platform, youtubeUrl }) {
    const lower = name.toLowerCase()
    const reserved = ['live', 'feed', 'mentions', 'whispers', 'discover', 'pinned', 'modlog', 'add', 'settings']

    // Resolve all 3 platform identities up-front via /api/profile so the resulting
    // tab pulls Twitch + Kick + YouTube together — not just the platform we
    // anchored on. resolveIdentity is the same path pcAddAsChannel uses.
    let identity = null,
      profile = null
    if (typeof resolveIdentity === 'function') {
      try {
        const res = await resolveIdentity(name, platform ? { platform } : {})
        if (res?.ok && res.identity) {
          identity = res.identity
          profile = res.profile
        }
      } catch {}
    }

    // Build canonical YouTube URL: prefer @handle, fall back to channel id.
    const buildYtUrl = () => (typeof identityYtLiveUrl === 'function' ? identityYtLiveUrl({ identity, profile }) : '')

    // Optimistic fallback: when heatsync has no linkage (shadow profile / unknown
    // streamer), assume the same username on every platform. Most streamers
    // use one handle everywhere; the user can edit the tab if the guess is wrong.
    // EXCEPT when the anchor IS a youtube identity: a yt @handle is not a
    // twitch/kick name (kripparrian's yt vs twitch nl_kripp — the guess filled
    // all 3 slots and joined/sent to a STRANGER's twitch channel). Same rule
    // as getLivePlatformNames: cross-platform from yt is explicit-only.
    const fromYt = platform === 'youtube'
    const twitchName = (identity?.twitch || (fromYt ? '' : lower)).toLowerCase()
    const kickName = (identity?.kick || (fromYt ? '' : lower)).toLowerCase()
    // Twitch/Kick same-name guessing is safe (handles match across those platforms).
    // YouTube is NOT: a fabricated youtube.com/@<name>/live resolves to whoever owns
    // that handle — usually a STRANGER who happens to be live — and bleeds their chat
    // into this tab (see ac4892c + [[heatsync_yt_handle_guess_bleed]]). Bind YT ONLY
    // from an explicit youtubeUrl (user navigated to a YT page) or a real resolved
    // identity (buildYtUrl uses heatsync profile/identity linkage). Never from a name.
    const ytUrl = platform === 'youtube' ? youtubeUrl || buildYtUrl() || '' : buildYtUrl() || ''
    const ytLower = ytUrl.toLowerCase()

    // Find existing channel tab matching any resolved platform.
    let entry = config.channels.find((c) => {
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
      if (reserved.includes(id) || config.channels.some((c) => c.id === id)) {
        id = platform === 'youtube' ? `yt_${Date.now()}` : `ch_${Date.now()}`
      }
      entry = { id, twitch: twitchName, kick: kickName, youtube: ytUrl }
      config.channels.push(entry)
      try {
        saveConfig()
      } catch {}

      if (entry.twitch) {
        try {
          trackJoin(entry.id, irc?.join?.(entry.twitch))
        } catch {}
        safeSendMessage({ type: 'join_channel', platform: 'twitch', channel: entry.twitch })
      }
      if (entry.kick) {
        try {
          trackJoin(entry.id, kickChat?.join?.(entry.kick))
        } catch {}
      }
      if (entry.youtube) {
        try {
          youtubeLinks.set(entry.id, { url: entry.youtube, videoId: '', channelName: '' })
          // Arm the watchdog — it reads ytChanLastSeen/ytSubscribedUrls, so a
          // sub added without them is never re-subscribed when it goes silent.
          ytSubscribedUrls.set(entry.id, entry.youtube)
          ytChanLastSeen.set(entry.id, Date.now())
        } catch {}
        try {
          ytSubscribe(entry.id, entry.youtube, entry.id)
        } catch {}
      }

      try {
        updateTabBar()
      } catch {}
    } else if (typeof entry !== 'string') {
      // Backfill any platforms missing on the existing entry (don't overwrite).
      let mutated = false
      if (!entry.twitch && twitchName) {
        entry.twitch = twitchName
        mutated = true
        try {
          trackJoin(entry.id, irc?.join?.(twitchName))
        } catch {}
        safeSendMessage({ type: 'join_channel', platform: 'twitch', channel: twitchName })
      }
      if (!entry.kick && kickName) {
        entry.kick = kickName
        mutated = true
        try {
          trackJoin(entry.id, kickChat?.join?.(kickName))
        } catch {}
      }
      if (!entry.youtube && ytUrl) {
        entry.youtube = ytUrl
        mutated = true
        try {
          youtubeLinks.set(entry.id, { url: ytUrl, videoId: '', channelName: '' })
          ytSubscribedUrls.set(entry.id, ytUrl)
          ytChanLastSeen.set(entry.id, Date.now())
        } catch {}
        try {
          ytSubscribe(entry.id, ytUrl, entry.id)
        } catch {}
      }
      if (mutated) {
        try {
          saveConfig()
        } catch {}
        try {
          updateTabBar()
        } catch {}
      }
    }

    const tabId = entry.id
    // Reset liveChannel override — live is no longer the sticky tab.
    liveChannel = null
    _dropTabCache('live')
    switchTab(tabId)
  }

  /** Show picker for choosing which live channel to view */
  async function showLiveChannelPicker(anchorEl) {
    document.getElementById('hs-mc-live-picker')?.remove()

    const urlCh = getCurrentChannel()?.toLowerCase()
    const watching = await getWatchingChannels()

    // Split watching by platform — API supports `channels` (twitch) + `kick_channels`
    const twitchNames = []
    const kickNames = []
    for (const w of watching) {
      if (w.platform === 'kick') kickNames.push(w.name)
      else if (w.platform === 'twitch') twitchNames.push(w.name)
    }
    if (urlCh && hostPlatform === 'twitch' && !twitchNames.includes(urlCh)) twitchNames.push(urlCh)
    if (urlCh && hostPlatform === 'kick' && !kickNames.includes(urlCh)) kickNames.push(urlCh)

    let twitchLive = liveChannelSet
    let kickLive = new Set()
    if (twitchNames.length > 0 || kickNames.length > 0) {
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'fetch_live_status',
          channels: twitchNames,
          kickChannels: kickNames,
        })
        if (resp?.live) twitchLive = new Set(resp.live.map((c) => c.toLowerCase()))
        if (resp?.kickLive) kickLive = new Set(resp.kickLive.map((c) => c.toLowerCase()))
      } catch (_) {
        /* use cached liveChannelSet */
      }
    }

    // Only show channels that are actually live; dedupe same name across platforms (twitch > kick > youtube)
    const priority = { twitch: 3, kick: 2, youtube: 1 }
    // Unlike twitch/kick, a "watching" youtube entry is only a URL-shape match
    // (tab sitting on /@handle/live, /live/<id>, /watch?v=<id>) — background.js
    // has no way to tell a live broadcast from a tab that's still parked on
    // that URL after the stream ended (YT swaps live→replay in-place, no
    // navigation). So it's never real evidence the way a helix/kick API hit
    // is. Treat it as a live candidate ONLY when nothing else confirmed-live
    // exists this round — a stale youtube tab must never outrank (or get
    // auto-selected over) an actually-live twitch/kick channel.
    const anyRealLive = watching.some(
      (w) =>
        (w.platform === 'twitch' && twitchLive.has(w.name.toLowerCase())) ||
        (w.platform === 'kick' && kickLive.has(w.name.toLowerCase())),
    )
    const byName = new Map()
    for (const w of watching) {
      const ch = w.name.toLowerCase()
      let isLive = false
      if (w.platform === 'twitch') isLive = twitchLive.has(ch)
      else if (w.platform === 'kick') isLive = kickLive.has(ch)
      else if (w.platform === 'youtube') isLive = !anyRealLive
      if (!isLive) continue
      const existing = byName.get(ch)
      if (!existing || priority[w.platform] > priority[existing.platform]) {
        byName.set(ch, { name: w.name, platform: w.platform, youtubeUrl: w.youtubeUrl, isCurrent: ch === urlCh })
      }
    }
    const channels = Array.from(byName.values())

    if (channels.length <= 1) {
      if (channels.length === 1) {
        // In-overlay switch everywhere, including popouts. The overlay renders
        // chat from HS's own streams (independent of the native page underneath)
        // and send resolves the target per-tab (relay/IRC, not the page URL), so
        // a popout switches channels in place — no destructive reload/navigation.
        await resolveLiveCandidateToTab(channels[0])
        return
      }
      // 0 candidates — fall back to urlCh (auto-add) so something opens; else just sit on live.
      if (urlCh && (hostPlatform === 'twitch' || hostPlatform === 'kick')) {
        await resolveLiveCandidateToTab({ name: urlCh, platform: hostPlatform })
        return
      }
      switchTab('live')
      return
    }

    const menu = document.createElement('div')
    menu.id = 'hs-mc-live-picker'
    const rect = anchorEl.getBoundingClientRect()
    menu.style.cssText = `position:fixed;z-index:99999;background:#000;border:1px solid #808080;padding:4px 0;min-width:130px;font-size:13px;font-family:inherit;left:${rect.left}px;top:${rect.bottom + 2}px;`

    const curLive = getLiveChannel()?.toLowerCase()

    for (const ch of channels) {
      const item = document.createElement('div')
      const isActive = ch.name.toLowerCase() === curLive

      // Red dot — all channels in picker are confirmed live
      const dot = document.createElement('span')
      dot.style.cssText = `display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--hs-danger);margin-right:6px;vertical-align:middle`
      item.appendChild(dot)
      item.appendChild(document.createTextNode(ch.name))

      const baseColor = isActive ? '#fff' : '#fff'
      item.style.cssText = `padding:6px 12px;cursor:pointer;color:${baseColor};white-space:nowrap;`
      item.addEventListener('mouseenter', () => {
        item.style.background = '#fff'
        item.style.color = '#000'
      })
      item.addEventListener('mouseleave', () => {
        item.style.background = 'none'
        item.style.color = baseColor
      })
      item.addEventListener('click', async () => {
        menu.remove()
        // In-overlay switch in every context, popout included — no navigation,
        // no destructive reload, no spawned window. The overlay is self-sufficient
        // (chat from HS streams, send per-tab), so picking a channel just switches.
        await resolveLiveCandidateToTab(ch)
      })
      menu.appendChild(item)
    }

    document.body.appendChild(menu)

    // Clamp position so menu stays fully visible
    const menuRect = menu.getBoundingClientRect()
    if (menuRect.right > window.innerWidth) {
      menu.style.left = `${Math.max(0, window.innerWidth - menuRect.width - 4)}px`
    }
    if (menuRect.bottom > window.innerHeight) {
      menu.style.top = `${Math.max(0, rect.top - menuRect.height - 2)}px`
    }

    // Dismiss on outside click
    const dismiss = (e) => {
      if (!menu.contains(e.target) && e.target !== anchorEl) {
        menu.remove()
        document.removeEventListener('click', dismiss, true)
      }
    }
    cleanup.setTimeout(() => document.addEventListener('click', dismiss, { capture: true, signal: mcSignal }), 0)
  }

  function getCurrentUsername() {
    // Method 1: localStorage displayName
    try {
      const displayName = localStorage.getItem('twilight.user.displayName')
      if (displayName) {
        const name = displayName.replace(/"/g, '').trim()
        if (name && name.length > 0 && name.length < 30) {
          return name.toLowerCase()
        }
      }
    } catch (_) {}

    // Method 2: localStorage user object
    try {
      const twilight = localStorage.getItem('twilight.user')
      if (twilight) {
        const data = JSON.parse(twilight)
        if (data?.displayName) return data.displayName.toLowerCase()
      }
    } catch (_) {}

    // Method 3: Twitch 'name'/'login' cookies (work in popout chat, and exist
    // for every logged-in twitch user regardless of heatsync login). 'login'
    // matters: it is the canonical lowercase login twitch pairs with the
    // auth-token cookie — the exact NICK the authed IRC upgrade must send.
    // Relying on heatsync's user_info alone left every heatsync-logged-out
    // user on an anonymous reader, which twitch starves (live messages
    // trickle — reads as "chat is slow").
    try {
      const cookies = document.cookie.split(';')
      for (const cookie of cookies) {
        const [key, value] = cookie.trim().split('=')
        if ((key === 'login' || key === 'name') && value) {
          const name = decodeURIComponent(value).toLowerCase()
          if (name.length > 0 && name.length < 30) {
            log('Found username from cookie:', name)
            return name
          }
        }
      }
    } catch (_) {}

    // Kick — DOM selectors keep getting stripped (current redesign moved login to
    // an unlabeled person-icon button with no /profile link). Cross-platform
    // mention detection now falls back to ui.username via mentionAliases, so we
    // don't fight the moving target here. Returning null is fine.

    return null
  }

  // ============================================
  // STORAGE
  // ============================================

  async function loadConfig() {
    try {
      const s = await chrome.storage.local.get([STORAGE_KEY])
      const _raw = s[STORAGE_KEY]
      config = { channels: [], enabled: true, ...(_raw && typeof _raw === 'object' ? _raw : {}) }
      // Guard: a persisted null channels field (corrupted storage) would propagate
      // through the spread and cause config.channels.some() to throw below.
      if (!Array.isArray(config.channels)) config.channels = []
      _channelLookup = null
      // Migrate old string channels to object format
      let needsSave = false
      if (config.channels.some((c) => typeof c === 'string')) {
        config.channels = config.channels.map((ch) =>
          typeof ch === 'string' ? { id: ch, twitch: ch, kick: '', youtube: '' } : ch,
        )
        needsSave = true
      }
      // Purge persisted ghost channels: reserved URL slugs that slipped in as
      // channel names before they were blocklisted (login/oauth2 from oauth
      // redirects). They IRC-join garbage, burn kick subscribe quota, and
      // shuffle the tab bar. Shape-valid logins, so only the blocklist knows.
      const _ghost = (name) => !!name && NON_CHANNEL_PATHS.has(String(name).toLowerCase())
      const _prePurge = config.channels.length
      config.channels = config.channels.filter((c) => !(_ghost(c.twitch) || _ghost(c.kick) || _ghost(c.id)))
      if (config.channels.length !== _prePurge) needsSave = true
      if (needsSave) saveConfig()
      // First-run seed: no channels yet AND we're on a real Twitch/Kick channel
      // page → add the current channel so the panel opens with working chat
      // instead of a blank list. getCurrentChannel() returns null on home/
      // directory/reserved pages, so this can never seed a garbage slug. YouTube
      // is skipped (it needs a URL form, not a bare slug); the empty-state CTA
      // covers that case.
      if (!config.channels.length) {
        try {
          const host = location.hostname
          const onTwitch = host.includes('twitch.tv')
          const onKick = host.includes('kick.com')
          if (onTwitch || onKick) {
            const cur = getCurrentChannel()
            if (cur) {
              config.channels = [
                onKick
                  ? { id: cur, twitch: '', kick: cur, youtube: '' }
                  : { id: cur, twitch: cur, kick: '', youtube: '' },
              ]
              saveConfig()
            }
          }
        } catch (_) {}
      }
      // Subscribe per-channel YouTube links
      for (const ch of config.channels) {
        if (ch.youtube) {
          youtubeLinks.set(ch.id, { url: ch.youtube, videoId: '', channelName: '' })
          ytSubscribedUrls.set(ch.id, ch.youtube)
          ytChanLastSeen.set(ch.id, Date.now())
          // 7TV/BTTV YouTube channel emotes ride along — channelId is a hint
          // (the stored youtube URL/handle); background resolves the real UC id.
          ytSubscribe(ch.id, ch.youtube, ch.id)
        }
      }
    } catch (_) {}
  }

  let _skipNextConfigSync = false
  // Snapshot of what we last wrote, so the cross-tab union below can tell
  // "another tab added this" from "we deliberately removed this".
  let _lastPersistedChannelKeys = null
  // Serializes saveConfig bodies — two rapid saves must not interleave their
  // read-then-write halves (the same lost-update the union above prevents
  // cross-tab, but within one tab). Mirrors the ui_settings write mutex.
  let _saveConfigChain = Promise.resolve()

  function saveConfig() {
    _channelLookup = null
    // Notify any open UI (profile card, etc.) that channel list may have changed
    try {
      document.dispatchEvent(new CustomEvent('hs-channels-changed'))
    } catch {}
    _saveConfigChain = _saveConfigChain.then(_saveConfigNow, _saveConfigNow)
    return _saveConfigChain
  }

  async function _saveConfigNow() {
    try {
      _skipNextConfigSync = true
      // ephemeral auto-tabs (open browser streams) never persist
      const persistable = { ...config, channels: (config.channels || []).filter((c) => !c?.ephemeral) }
      // Union the channel list with what's in storage before writing. A blind
      // full-object set makes two tabs (twitch + kick, the normal setup) race:
      // whoever writes last wins, and the loser's just-added channel is both
      // dropped from storage AND parted locally when the onChanged diff sees
      // it missing. Reconcile on channelKey identity, ours winning on shape.
      try {
        const stored = (await chrome.storage.local.get(STORAGE_KEY))?.[STORAGE_KEY]
        const theirs = Array.isArray(stored?.channels) ? stored.channels : null
        if (theirs?.length) {
          const key = (c) => `${c?.platform || 'twitch'}:${(c?.id || c?.twitch || c?.name || '').toLowerCase()}`
          const mine = new Set(persistable.channels.map(key))
          // A channel we deliberately removed this session must stay removed —
          // only adopt entries that appeared after our last known snapshot.
          const removed = _lastPersistedChannelKeys
          for (const c of theirs) {
            const k = key(c)
            if (!mine.has(k) && !removed?.has(k)) persistable.channels.push(c)
          }
        }
      } catch {}
      _lastPersistedChannelKeys = new Set(
        persistable.channels.map(
          (c) => `${c?.platform || 'twitch'}:${(c?.id || c?.twitch || c?.name || '').toLowerCase()}`,
        ),
      )
      await chrome.storage.local.set({ [STORAGE_KEY]: persistable })
      // Sync to server for cross-device sync
      safeSendMessage({
        type: 'ws_send',
        data: { type: 'multichat:sync', channels: (config.channels || []).filter((c) => !c?.ephemeral) },
      })
    } catch (e) {
      // A swallowed failure here looks like a saved channel — it isn't. See
      // reportStorageWriteFailure above.
      reportStorageWriteFailure('channel config', e, 'mc_main_config_save_failed')
    }
  }

  // ============================================
  // TABS POSITION SETTING
  // ============================================

  async function loadTabsPosition() {
    try {
      const stored = await cachedUiSettings()
      if (stored.ui_settings?.tabPosition !== undefined) {
        tabPosition = stored.ui_settings.tabPosition
      }
      applyTabsPosition()
    } catch (e) {
      log('Error loading tabs position:', e)
    }
  }

  let _savedActiveTab = null
  // 'discover' intentionally omitted — tab is hidden from the bar pre-launch,
  // so a stale saved 'discover' falls back to 'live' on restore.
  // 'whispers' belongs here too — it's a real, restorable tab; leaving it out
  // silently bounced you to 'live' every reload if that's where you were.
  const BUILTIN_TABS = ['live', 'feed', 'mentions', 'whispers', 'pinned', 'modlog', 'add']
  async function loadActiveTab() {
    try {
      const stored = await cachedUiSettings()
      const saved = stored.ui_settings?.activeTab || 'live'
      // Validate: must be a built-in tab or a configured channel (never restore 'add')
      const channelIds = config.channels.map((c) => c.id)
      _savedActiveTab = saved !== 'add' && (BUILTIN_TABS.includes(saved) || channelIds.includes(saved)) ? saved : 'live'
      // Restore live channel override — POPOUT ONLY. The override exists so
      // the popout picker survives its navigation hop; restoring it on
      // regular pages pinned the live tab to a long-dead pick (the
      // "live tab always opens quin69" bug) instead of the page's channel.
      if (stored.ui_settings?.liveChannel && document.body.classList.contains('hs-popout')) {
        liveChannel = stored.ui_settings.liveChannel
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
    } catch (_) {
      _savedActiveTab = 'live'
    }
  }

  let _applyingPosition = false
  function applyTabsPosition() {
    if (_applyingPosition) return
    _applyingPosition = true
    try {
      _applyTabsPositionInner()
    } finally {
      _applyingPosition = false
    }
  }
  function _applyTabsPositionInner() {
    document.body.classList.remove('hs-tabs-top', 'hs-tabs-right', 'hs-tabs-bottom', 'hs-tabs-left')
    document.body.classList.add(`hs-tabs-${tabPosition}`)

    // Re-run dynamic layout — clears stale inline rules + applies fresh ones for new position.
    try {
      _updateMcLayout()
    } catch (_) {}

    // Re-apply column width (accounts for vertical tab offset)
    applyChatWidth()

    log('Tabs position:', tabPosition)
  }

  function rotateTabPosition() {
    const positions = ['top', 'right', 'bottom', 'left']
    const currentIndex = positions.indexOf(tabPosition)
    const prev = tabPosition
    tabPosition = positions[(currentIndex + 1) % positions.length]
    log('rotate:', prev, '→', tabPosition)

    setSetting('tabPosition', tabPosition) // applier applies + rerender
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
  let chatPosition = 'right' // 'right', 'bottom', 'left', 'top'
  let theatreMode = false
  let _theatreObserver = null
  let _panelWObs = null // ResizeObserver on #hs-mc-container → --hs-panel-w
  let _twitchSideNavObs = null
  let _twitchSideNavWinHooked = false
  let _twitchSideNavW = TWITCH_SIDE_NAV_WIDTH
  // _twitchTopNavObs moved to twitch-host.js (platform module)
  let _twitchTopNavH = TWITCH_TOP_NAV_HEIGHT
  // _kickTopNavObs, _kickTopNavH moved to kick-host.js (platform module)

  // Twitch's left side-nav is 50px when collapsed, ~240px when expanded.
  // It auto-expands on wide viewports (>~1200px), and the user can also
  // toggle it. chat-left layout subtracts this width from chatWidth to land
  // the player flush with the HS panel — so the live value must be tracked,
  // not assumed. Pushes --hs-twitch-sidenav-w for the CSS rules to consume,
  // and re-runs applyPlatformPositionOverrides so JS-side arithmetic
  // (persistent-player inset, channel-root padding) updates too.
  // updateTwitchSideNavWidth moved to twitch-host.js (platform module)

  // Twitch's top nav (.top-nav) is 50px tall and lives in a sibling DOM tree
  // that paints above HS's chat container — even though HS has z-index 9999,
  // the chat container is trapped inside .channel-root__right-column's z=1
  // stacking context. Fight: don't compete on z-index, just offset chat down
  // by the nav height when chat docks left/top so the rotate buttons aren't
  // hidden under Following/Browse. Theatre mode hides .top-nav (height = 0),
  // so the offset auto-collapses and chat reclaims the full viewport.
  // updateTwitchTopNavHeight moved to twitch-host.js (platform module)

  // setupTwitchTopNavObserver moved to twitch-host.js (platform module)

  // Kick's top nav is position:fixed, ~60px tall (matches the CSS fallback).
  // Mirrors the twitch pattern: measure once, track via ResizeObserver, push
  // --hs-kick-topnav-h so CSS rules that offset the panel don't need to
  // hard-code the height. Selector matches the <nav> used elsewhere in the
  // codebase for kick nav height measurement.
  // updateKickTopNavHeight moved to kick-host.js (platform module)

  // setupKickTopNavObserver moved to kick-host.js (platform module)

  // Persistent-overlay mode toggle. Sets `hs-twitch-no-channel` on body when
  // we're on a twitch URL with no .channel-root (directory, settings, videos,
  // search, …). CSS rules keyed off this class flip the panel to position:
  // fixed and squeeze twitch's main content via a body width/height
  // constraint. Re-checked on every SPA nav.
  function updateTwitchNoChannelClass() {
    if (hostPlatform !== 'twitch') return
    // Chokepoint that runs on every soft nav (reparent + 700ms + 4s timers)
    // and theatre flip — re-assert the stylesheet here, since twitch SPA
    // transitions can sweep injected <style> tags. Idempotent (id check).
    try {
      injectStyles()
    } catch (_) {}
    const onChannel = !!document.querySelector('.channel-root, [class*="channel-root"]')
    const popout = document.body.classList.contains('hs-popout')
    let noChannel = !onChannel && !popout
    if (!noChannel && !popout) {
      // Twitch layout bug: on miniplayer-restore from twitch.tv/, the channel
      // page mounts but the right-column flex slot stays 0-width — chat-shell
      // overflows off-screen to the right (x ≥ viewport.right). Detect and
      // fall back to body-mounted fixed-overlay mode so chat stays visible.
      const chatShell = document.querySelector(`.chat-shell, ${CONFIG.SELECTORS.TWITCH_CHAT_SHELL}`)
      if (chatShell) {
        const r = chatShell.getBoundingClientRect()
        // A zero-width chat shell is NOT proof of the layout bug above — it is
        // also the normal state when the right column is collapsed, and when
        // WE hid the native chat ourselves (hs-native-hidden). Treating those
        // as "broken" was self-inflicted: hiding native chat zeroed the shell,
        // this branch then forced hs-twitch-no-channel, which squeezes the
        // layout AND early-returns the player guard (player-guard.js), so
        // twitch demoted the video into .persistent-player — the stream turned
        // into a white rectangle at the bottom of the page. That is the
        // "ext breaks the stream / white screen" report.
        //
        // Only the genuine off-screen overflow still counts on its own; a bare
        // width===0 counts only when nothing we or the user did explains it.
        const selfHidden = chatShell.classList.contains('hs-native-hidden')
        const collapsed = !!document.querySelector('.right-column--collapsed, [class*="right-column--collapsed"]')
        const overflowsOffScreen = r.right > window.innerWidth + 1
        const unexplainedZeroWidth = r.width === 0 && !selfHidden && !collapsed
        if (overflowsOffScreen || unexplainedZeroWidth) {
          noChannel = true
          const c = document.getElementById('hs-mc-container')
          if (c && c.parentElement !== document.body) document.body.appendChild(c)
        }
      }
    }
    const prev = document.body.classList.contains('hs-twitch-no-channel')
    document.body.classList.toggle('hs-twitch-no-channel', noChannel)
    // State flip: re-run width so the right-column slot zeros (entering
    // no-channel) or reclaims its size (returning to a channel page).
    if (prev !== noChannel) {
      try {
        applyChatWidth()
      } catch (_) {}
    }
  }

  // updateKickNoChannelClass moved to kick-host.js (platform module)

  // ── Scroll-wheel volume (BTTV-style) ────────────────────────────────────
  // Wheel over the platform's <video> steps volume ±0.05/tick (clamped
  // [0,1]); scrolling up while muted unmutes first. One delegated listener
  // on document (target-checked via closest() at event time) — the player
  // node gets torn down/rebuilt across SPA nav on all 3 platforms, so a
  // single persistent listener beats re-observing a moving target. Gated
  // live on scrollWheelVolumeEnabled (audit-toggle rule: read at event time,
  // not just at listener-setup time) — off behaves exactly like the
  // listener isn't there (native page scroll).
  // yt is `#movie_player` ONLY — deliberately NOT `.html5-video-player`, which
  // also matches `#shorts-player` and the home-feed hover-preview player. On
  // both of those the wheel is the PAGE's own control (advance the reel, scroll
  // the feed), so preventDefault there wedges youtube: the short can't be
  // scrolled past, and muting/unmuting the <video> directly desyncs shorts'
  // own per-reel audio state, leaving the previous short audible under the next.
  const HS_PLAYER_SELECTOR = {
    twitch: '.video-player',
    kick: '.channel-root__player, #injected-channel-player',
    yt: '#movie_player',
  }
  // Shorts still gets volume — behind shift, which the reel itself doesn't use.
  const HS_MODIFIER_PLAYER_SELECTOR = { yt: '#shorts-player' }
  let _hsVolOsdEl = null
  let _hsVolOsdHideTimer = null
  function _hsShowVolumeOsd(playerEl, video) {
    if (!_hsVolOsdEl) {
      _hsVolOsdEl = document.createElement('div')
      _hsVolOsdEl.id = 'hs-vol-osd'
      document.body.appendChild(cleanup.trackNode(_hsVolOsdEl))
    }
    _hsVolOsdEl.textContent = `vol ${Math.round(video.volume * 100)}%`
    const r = playerEl.getBoundingClientRect()
    _hsVolOsdEl.style.left = `${Math.round(r.left + r.width / 2)}px`
    _hsVolOsdEl.style.top = `${Math.round(r.top + 16)}px`
    _hsVolOsdEl.classList.add('visible')
    cleanup.clearTimeout(_hsVolOsdHideTimer)
    _hsVolOsdHideTimer = cleanup.setTimeout(() => {
      if (_hsVolOsdEl) _hsVolOsdEl.classList.remove('visible')
    }, 800)
  }
  function setupScrollWheelVolume() {
    const sel = HS_PLAYER_SELECTOR[hostPlatform]
    const modSel = HS_MODIFIER_PLAYER_SELECTOR[hostPlatform]
    if (!sel && !modSel) return
    document.addEventListener(
      'wheel',
      (e) => {
        if (!scrollWheelVolumeEnabled) return
        // Never hijack scroll over HeatSync's own UI — every floating HS
        // surface (panel, picker, ctx menu, banners) uses an hs- prefixed id.
        if (e.target.closest?.('[id^="hs-"]')) return
        let playerEl = sel ? e.target.closest(sel) : null
        // Shift-only players (yt shorts): plain wheel stays the page's.
        if (!playerEl && modSel && e.shiftKey) playerEl = e.target.closest(modSel)
        if (!playerEl) return
        // Scoped lookup only — the old document-wide fallback grabbed an
        // arbitrary <video> on multi-player pages. Fall back only when the
        // page has exactly one, where "arbitrary" can't be wrong.
        const all = document.querySelectorAll('video')
        const video = playerEl.querySelector('video') || (all.length === 1 ? all[0] : null)
        if (!video) return
        e.preventDefault()
        const next = resolveVolumeWheelStep({ volume: video.volume, muted: video.muted }, e.deltaY)
        video.muted = next.muted
        video.volume = next.volume
        _hsShowVolumeOsd(playerEl, video)
      },
      { passive: false, signal: mcSignal },
    )
  }

  function setupTwitchSideNavObserver() {
    if (hostPlatform !== 'twitch') return
    document.documentElement.style.setProperty('--hs-twitch-sidenav-w', `${_twitchSideNavW}px`)
    if (_twitchSideNavObs) {
      try {
        _twitchSideNavObs.disconnect()
      } catch (_) {}
      _twitchSideNavObs = null
    }
    const nav = document.querySelector('.side-nav')
    if (nav && typeof ResizeObserver !== 'undefined') {
      _twitchSideNavObs = new ResizeObserver(() => updateTwitchSideNavWidth())
      _twitchSideNavObs.observe(nav)
      cleanup.trackObserver(_twitchSideNavObs)
    }
    if (!_twitchSideNavWinHooked) {
      _twitchSideNavWinHooked = true
      window.addEventListener('resize', () => updateTwitchSideNavWidth(), { passive: true, signal: mcSignal })
    }
    updateTwitchSideNavWidth()
  }

  async function loadChatPosition() {
    try {
      const stored = await cachedUiSettings()
      if (stored.ui_settings?.chatPosition !== undefined) {
        chatPosition = stored.ui_settings.chatPosition
      }
      // Load previous-visible for hide↔show toggle restore.
      const prevStored = stored.ui_settings?.chatPositionPrevious
      if (['right', 'bottom', 'left', 'top'].includes(prevStored)) chatPositionPrevious = prevStored
      if (['right', 'bottom', 'left', 'top'].includes(chatPosition)) {
        chatPositionPrevious = chatPosition
      }
      // Legacy heal: 'hidden' used to be persisted into the SYNCED setting, so
      // one \ press hid chat in every tab forever. Hidden is tab-local now
      // (sessionStorage) — migrate a stored 'hidden' into this tab's local
      // flag and restore the synced value to the last visible position.
      if (chatPosition === 'hidden') {
        chatHiddenLocal = true
        try {
          sessionStorage.setItem('hs-chat-hidden-local', '1')
        } catch (_) {}
        // silent: heal the stored value only — the applier would treat this
        // as an explicit local position pick and clear the tab-local flag.
        setSetting('chatPosition', chatPositionPrevious, { silent: true })
        chatPosition = 'hidden' // runtime stays hidden HERE; other tabs unhide
      } else {
        // Per-tab hide survives reload/SPA nav via sessionStorage (scoped to
        // this browser tab by definition — exactly the ask).
        try {
          if (sessionStorage.getItem('hs-chat-hidden-local')) {
            chatHiddenLocal = true
            chatPosition = 'hidden'
          }
        } catch (_) {}
      }
      // Load saved width + height BEFORE first applyChatPosition. Without this,
      // applyChatPosition runs with default chatHeight (35% innerHeight) and
      // positions the orange handle there. loadChatHeight then updates the
      // variable but not the handle's screen position, so first click captures
      // the saved value and the bar instantly snaps to it — looks like a
      // mouse teleport from the user's POV.
      await Promise.all([loadChatWidth(), loadChatHeight()])
      // Stamp the platform class once — never changes per-page
      const platformClass = `hs-platform-${hostPlatform === 'yt' ? 'yt' : isKick ? 'kick' : 'twitch'}`
      document.body.classList.add(platformClass)
      detectTheatreMode()
      setupTheatreObserver()
      setupTwitchSideNavObserver()
      if (hostPlatform === 'twitch') setupTwitchTopNavObserver()
      if (isKick) setupKickTopNavObserver()
      updateTwitchNoChannelClass()
      if (isKick) updateKickNoChannelClass()
      applyChatPosition()
    } catch (e) {
      log('Error loading chat position:', e)
    }
  }

  // Detect platform-native theatre/cinema/expanded-player mode.
  // Twitch:  .right-column--theatre OR .video-player--theatre
  // Kick:    main[data-theatre="true"]
  // YouTube: ytd-watch-flexy[theater]
  // Publish the container's MEASURED width (chat column + side tab strip)
  // for CSS that must reserve the full panel footprint (theatre player inset).
  function publishPanelWidth() {
    const c = document.getElementById('hs-mc-container')
    if (!c) return
    if (c.offsetWidth > 0) {
      document.documentElement.style.setProperty('--hs-panel-w', `${c.offsetWidth}px`)
    }
    // Self-install a ResizeObserver on the container the first time we see it.
    // Call-site timing is unreliable on cold load (the panel is still 0-width
    // when applyChatPosition / the tab-bar observer fire, so the guard above
    // skips and --hs-panel-w stays unset until a drag-resize). Observing the
    // container directly catches its 0 → full-width layout and every later
    // resize, so the chat-left player inset is correct from first paint.
    if (!_panelWObs && typeof ResizeObserver !== 'undefined') {
      _panelWObs = new ResizeObserver(() => {
        const el = document.getElementById('hs-mc-container')
        if (el && el.offsetWidth > 0) {
          document.documentElement.style.setProperty('--hs-panel-w', `${el.offsetWidth}px`)
        }
      })
      _panelWObs.observe(c)
      cleanup.trackObserver(_panelWObs)
    }
  }

  function detectTheatreMode() {
    let next = false
    if (hostPlatform === 'yt') {
      next = !!document.querySelector('ytd-watch-flexy[theater], ytd-watch-flexy[fullscreen]')
    } else if (isKick) {
      // Kick MOVED the theatre flag off <main>: it now lives on a wrapper
      // div.group/main that CONTAINS main (a direct child of body), and <main>
      // only keeps a static data-theatre-mode-container marker. Both old checks
      // were pinned to the main tag, so theatre silently stopped being detected
      // — hs-mode-theatre never applied, and every theatre layout rule (which is
      // what keeps the panel off the player) went dead. Don't pin it to a tag,
      // just find the flag wherever Kick puts it next.
      next = !!document.querySelector('[data-theatre="true"]')
    } else {
      next = !!document.querySelector('.right-column--theatre, .video-player--theatre')
    }
    if (next !== theatreMode) {
      theatreMode = next
      applyChatPosition()
      // Theatre flips collapse/restore the right column — re-evaluate the
      // no-channel body-mount AFTER the 500ms column animation settles, same
      // contract as the soft-nav path. Without this, exiting theatre strands
      // the panel in fixed body-mount until the next SPA nav.
      cleanup.setTimeout(
        () => {
          try {
            updateTwitchNoChannelClass()
          } catch (_) {}
          try {
            positionChatResizeHandle()
          } catch (_) {}
          try {
            publishPanelWidth()
          } catch (_) {}
          // Theatre transitions can transiently overflow the root scroller
          // horizontally; if a scroll sticks, the whole page renders shifted
          // left with a dead zone before the panel. Reset it.
          try {
            const sa = document.querySelector('.root-scrollable')
            if (sa && sa.scrollLeft > 0) sa.scrollLeft = 0
          } catch (_) {}
        },
        700,
        'theatre-flip-nochannel-recheck',
      )
    }
    return next
  }

  function setupTheatreObserver() {
    if (_theatreObserver) {
      try {
        _theatreObserver.disconnect()
      } catch (_) {}
      _theatreObserver = null
    }
    const targets = []
    if (hostPlatform === 'yt') {
      const flexy = document.querySelector('ytd-watch-flexy:not([hidden])')
      if (flexy) targets.push(flexy)
    } else if (isKick) {
      // Must watch the BODY, not main: the theatre flag sits on an ANCESTOR of
      // main, and subtree:true only ever sees descendants — observing main could
      // never fire on the toggle. The class pre-filter below keeps this cheap.
      targets.push(document.body)
    } else {
      // Twitch: theatre class lands on .right-column AND inside the player.
      // Watch the body — most-specific reliable observation point covers SPA navs.
      targets.push(document.body)
    }
    if (targets.length === 0) return
    // Body-subtree observation fires on every React class flip (chat-line
    // animations, hover toggles, ad layer churn) — ~100+ callbacks/sec.
    // Cheap pre-filter: skip mutations whose target class doesn't contain
    // a theatre token. Saves the querySelector inside detectTheatreMode().
    _theatreObserver = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.attributeName !== 'class') {
          detectTheatreMode()
          return
        }
        const c = m.target?.className
        const s = typeof c === 'string' ? c : c?.baseVal || ''
        if (s.indexOf('theat') !== -1 || s.indexOf('fullscreen') !== -1) {
          detectTheatreMode()
          return
        }
      }
    })
    for (const t of targets) {
      _theatreObserver.observe(t, {
        attributes: true,
        attributeFilter: ['class', 'data-theatre', 'theater', 'fullscreen'],
        subtree: true,
      })
    }
    cleanup.trackObserver(_theatreObserver)
    // Deadman: the observer's attributeFilter + class-substring pre-filter are
    // guesses about how the platform flags theatre — kick has already moved
    // the flag once (v1.7.31) and a miss fails silent. A slow poll bounds the
    // damage of any future filter miss to 5s instead of forever.
    cleanup.setIntervalIfVisible(() => detectTheatreMode(), 5000)
  }

  function applyChatPosition() {
    // Native chat shown: don't re-position/override layout (races native chat).
    if (typeof getSetting === 'function' && getSetting('nativeVisible')) return
    // Sanitize — 5 valid positions: 4 visible + 'hidden'.
    const VALID_POSITIONS = ['right', 'bottom', 'left', 'top', 'hidden']
    if (!VALID_POSITIONS.includes(chatPosition)) {
      log('[c-button] sanitizing invalid chatPosition:', chatPosition, '→ right')
      chatPosition = 'right'
    }
    // Popout chat = full window. Force 'right' + visible.
    if (document.body.classList.contains('hs-popout') && chatPosition !== 'right') {
      chatPosition = 'right'
    }
    // Hidden state: collapse overlay, drop all handles, show edge-pill.
    // Pill + `\` shortcut are the ONLY restore paths.
    if (chatPosition === 'hidden') {
      document.body.classList.remove('hs-chat-top', 'hs-chat-right', 'hs-chat-bottom', 'hs-chat-left')
      document.body.classList.add('hs-chat-hidden')
      document.body.classList.toggle('hs-platform-yt', hostPlatform === 'yt')
      document.body.classList.toggle('hs-platform-twitch', hostPlatform !== 'yt' && !isKick)
      document.body.classList.toggle('hs-platform-kick', !!isKick)
      document.body.classList.toggle('hs-mode-theatre', theatreMode)
      document.body.classList.toggle('hs-mode-normal', !theatreMode)
      hidePlatformResizeHandles(true)
      const uh = document.getElementById('hs-c-resize-handle')
      if (uh) uh.style.setProperty('display', 'none', 'important')
      ensureChatRestorePill(true)
      try {
        applyPlatformPositionOverrides()
      } catch (_) {}
      log('Chat position: hidden, theatre:', theatreMode)
      return
    }
    document.body.classList.remove('hs-chat-hidden')
    ensureChatRestorePill(false)
    // YouTube: layout overrides that touch #primary/#secondary are gated
    // separately (live-only via :not(.hs-offline)). The hs-chat-{position}
    // class is now applied on EVERY YT page so the persistent multichat
    // panel renders via the position:fixed CSS rule across home, search,
    // VOD, channel, and live — matching the Twitch persistent overlay.
    const isYtNonWatch = hostPlatform === 'yt' && !document.querySelector('ytd-watch-flexy:not([hidden])')
    document.body.classList.remove('hs-chat-top', 'hs-chat-right', 'hs-chat-bottom', 'hs-chat-left')
    document.body.classList.toggle('hs-platform-yt', hostPlatform === 'yt')
    document.body.classList.toggle('hs-platform-twitch', hostPlatform !== 'yt' && !isKick)
    document.body.classList.toggle('hs-platform-kick', !!isKick)
    document.body.classList.add(`hs-chat-${chatPosition}`)
    if (isYtNonWatch && location.pathname === '/watch') {
      // We're on a watch URL but flexy hasn't mounted yet (SPA cold-load,
      // /watch → /watch transition where React unmounted then remounts).
      // Re-arm the flexy-mount observer so applyChatPosition fires again
      // once it's there.
      try {
        watchYtFlexyMount()
      } catch (_) {}
    }
    document.body.classList.toggle('hs-mode-theatre', theatreMode)
    document.body.classList.toggle('hs-mode-normal', !theatreMode)
    // Push the chatWidth css var down so the per-position CSS can build offsets
    // off it (rather than chasing platform-specific selectors twice).
    document.documentElement.style.setProperty('--hs-chat-w', `${chatWidth}px`)
    document.documentElement.style.setProperty('--hs-chat-h', `${chatHeight}px`)
    // Refresh Twitch side-nav width — it can flip 50↔240 across a chat
    // toggle (user F11s, viewport crosses Twitch's expand breakpoint, etc).
    if (hostPlatform === 'twitch') updateTwitchSideNavWidth()
    // Apply inline-style overrides on platform-native elements that set
    // width/height with inline !important (CSS alone can't beat that).
    applyPlatformPositionOverrides()
    // Bulletproof orange resize handle — covers all 4 chat positions.
    positionChatResizeHandle()
    // Hide platform handles when chat is non-right OR when on YT (where
    // unified handle now owns chat-right too since YT uses position:fixed).
    hidePlatformResizeHandles(chatPosition !== 'right' || hostPlatform === 'yt')
    log('Chat position:', chatPosition, 'theatre:', theatreMode)
    // Reflow the multichat layout so input/overlay/picker re-anchor.
    try {
      _updateMcLayout?.()
    } catch (_) {}
    // YT computes player size in JS asynchronously and caches it; nudge it
    // to re-read CSS vars (margin, non-player-{width,height}) by dispatching
    // resize events at multiple timing points. The player init is async and
    // can complete after our applyChatPosition runs on initial load — without
    // multiple nudges, YT's own resize observer doesn't fire until ~10s.
    if (hostPlatform === 'yt') {
      const fire = () => {
        try {
          window.dispatchEvent(new Event('resize'))
        } catch (_) {}
      }
      fire()
      cleanup.setTimeout(fire, 100)
      cleanup.setTimeout(fire, 500)
      cleanup.setTimeout(fire, 1500)
    }
  }

  // Inline-style overrides keyed off chatPosition. These run AFTER class
  // toggling. They exist because Twitch/Kick/YT set inline width/height/
  // padding with !important that beats CSS rules — only inline can fight
  // inline. When chatPosition flips back to 'right' we restore the native
  // values (Twitch's chat-width JS will re-apply them on next tick).
  const _overrideObserver = null
  // _hsSetYtBelowTop, _hsEnsureYtBelowObserver moved to youtube-host.js (platform module)
  function applyPlatformPositionOverrides() {
    // Native chat shown: stop touching the player/chat geometry — our overrides
    // race Twitch's native layout and push the native input off-screen. The panel
    // is collapsed to its strip (handled in the nativeVisible reader); leave the
    // rest to Twitch.
    if (typeof getSetting === 'function' && getSetting('nativeVisible')) return
    // The guard already caught this page's player collapsing under our
    // geometry and handed layout back to the platform. Re-asserting here would
    // walk straight back into the race it just bailed out of.
    if (typeof playerGuardDisengaged === 'function' && playerGuardDisengaged()) return
    const isRight = chatPosition === 'right'
    const w = `${chatWidth}px`
    const h = `${chatHeight}px`

    // The chat container itself: inline styles beat any platform-bundled CSS
    // (Twitch's chat-shell rules, Kick's existing hs-tabs-* rules etc.).
    // We only touch geometry when overriding; the platform's mount code
    // (getOrCreateHsContainer for YT) may set its own inline height/etc that
    // we must not blow away when chatPosition === 'right'.
    const container = document.getElementById('hs-mc-container')
    const GEOM_PROPS = [
      'top',
      'bottom',
      'left',
      'right',
      'width',
      'min-width',
      'max-width',
      'height',
      'position',
      'z-index',
    ]
    if (container) {
      if (isRight) {
        if (container.dataset._hsChatOverride === '1') {
          delete container.dataset._hsChatOverride
          GEOM_PROPS.forEach((p) => {
            container.style.removeProperty(p)
          })
          container.style.removeProperty('background')
          container.style.removeProperty('overflow')
          // YT chat-right is now position:fixed via CSS rule — don't set
          // any inline geometry, let the stylesheet own it (works on
          // initial load without waiting for a C-cycle).
          if (isKick) {
            try {
              applyKickChatWidth()
            } catch (_) {}
          }
        }
      } else {
        container.dataset._hsChatOverride = '1'
        GEOM_PROPS.forEach((p) => {
          container.style.removeProperty(p)
        })
        container.style.setProperty('position', 'fixed', 'important')
        // On twitch no-channel pages (directory/settings/…) the panel mounts in
        // a gutter with no host content beneath it, so it can sit BELOW twitch's
        // popup layers (balloon 2000 / overlay 3000 / modal 5000) — otherwise a
        // full-width top-nav's dropdowns (user menu, browse, search) open over
        // the panel and get buried under z 9999. Mirrors the CSS z for the
        // right dock (which is stylesheet-owned). Channel pages keep 9999 — there
        // the panel overlaps host chat and must outrank twitch's React layout.
        const twitchNoChannel = hostPlatform === 'twitch' && document.body.classList.contains('hs-twitch-no-channel')
        container.style.setProperty('z-index', twitchNoChannel ? '1500' : '9999', 'important')
        container.style.setProperty('background', '#000', 'important')
        // Twitch-only: offset by .top-nav height for left/top so the rotate
        // buttons aren't trapped under Following/Browse (HS lives inside
        // .channel-root__right-column's z=1 stacking context, can't outrank).
        const twitchTopOffset = hostPlatform === 'twitch' && !theatreMode ? _twitchTopNavH : 0
        const topPx = `${twitchTopOffset}px`
        if (chatPosition === 'left') {
          container.style.setProperty('top', topPx, 'important')
          container.style.setProperty('bottom', '0', 'important')
          container.style.setProperty('left', '0', 'important')
          container.style.setProperty('right', 'auto', 'important')
          container.style.setProperty('width', w, 'important')
          container.style.setProperty('height', `calc(100vh - ${topPx})`, 'important')
        } else if (chatPosition === 'top') {
          container.style.setProperty('top', topPx, 'important')
          container.style.setProperty('bottom', 'auto', 'important')
          container.style.setProperty('left', '0', 'important')
          container.style.setProperty('right', '0', 'important')
          container.style.setProperty('width', '100vw', 'important')
          container.style.setProperty('height', h, 'important')
        } else if (chatPosition === 'bottom') {
          container.style.setProperty('top', 'auto', 'important')
          container.style.setProperty('bottom', '0', 'important')
          container.style.setProperty('left', '0', 'important')
          container.style.setProperty('right', '0', 'important')
          container.style.setProperty('width', '100vw', 'important')
          container.style.setProperty('height', h, 'important')
        }
      }
    }

    if (hostPlatform === 'yt') {
      // Panel hidden on this YT page (non-live + no opt-in → hs-offline): don't
      // reshape the page for a chat that isn't showing. Revert any inline player
      // sizing + the reflow var so it's normal YT (full player, related videos).
      if (document.body.classList.contains('hs-offline')) {
        ;[
          '#player-container-outer',
          '#player-container-inner',
          '#player-container',
          '#player',
          'ytd-player#ytd-player',
        ].forEach((s) => {
          const e = document.querySelector(s)
          if (e && e.dataset._hsCYtSized === '1') {
            delete e.dataset._hsCYtSized
            ;['width', 'height', 'max-width', 'max-height', 'min-height'].forEach((p) => {
              e.style.removeProperty(p)
            })
          }
        })
        document.documentElement.style.removeProperty('--hs-yt-below-top')
        return
      }
      const sec = document.querySelector('#secondary')
      if (sec) {
        // 'hidden' (collapsed) restores #secondary too: with the chat gone there's
        // nothing occupying the sidebar, so YT's recommended-videos list must come
        // back. Squashing it to 0 here was hiding recommendations on collapse.
        if (isRight || chatPosition === 'hidden') {
          sec.style.removeProperty('width')
          sec.style.removeProperty('min-width')
          sec.style.removeProperty('max-width')
          sec.style.removeProperty('flex')
          // applyYouTubeChatWidth will reset width on next reflow
        } else {
          sec.style.setProperty('width', '0', 'important')
          sec.style.setProperty('min-width', '0', 'important')
          sec.style.setProperty('max-width', '0', 'important')
          sec.style.setProperty('flex', '0 0 0', 'important')
        }
      }
      // Keep --hs-yt-below-top synced to the real video bottom via a
      // ResizeObserver (robust against fresh-load timing). Retries each run
      // until #movie_player exists; re-observes the new player on SPA nav.
      _hsEnsureYtBelowObserver()
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
      ]
      const ytSizedEls = ytSelectors.map((s) => document.querySelector(s)).filter(Boolean)
      const PLAYER_GEOM = ['width', 'height', 'max-width', 'max-height', 'min-height']
      if (chatPosition === 'top' || chatPosition === 'bottom' || chatPosition === 'left' || chatPosition === 'right') {
        // Compute aspect-preserved player size for the freed area.
        // top/bottom: chat eats height, player fills the rest (full width).
        // left/right: chat eats width, player fills the rest (full height).
        // Use clientWidth (NOT innerWidth) — innerWidth counts the ~15px
        // vertical scrollbar that the fixed panel anchors outside of, so
        // sizing off innerWidth makes the player overshoot its column and
        // tuck its right edge (where the Skip Ad / fullscreen buttons live)
        // under the panel.
        const usableW = document.documentElement.clientWidth
        let availH, availW
        if (chatPosition === 'left' || chatPosition === 'right') {
          // Opt-in suggestions strip eats a fixed column beside the player on
          // left/right dock — subtract it or the player renders UNDER the strip
          // (overshoots its column, clips off-edge). Publish the width so the
          // stylesheet (#below inset + strip geometry) and this arithmetic stay
          // in lockstep. Off → drop the var so CSS sees 0 contribution.
          const suggOn = document.body.classList.contains('hs-yt-suggestions')
          const suggW = suggOn ? YT_SUGG_STRIP_W : 0
          if (suggOn) document.documentElement.style.setProperty('--hs-yt-sugg-w', `${suggW}px`)
          else document.documentElement.style.removeProperty('--hs-yt-sugg-w')
          availW = Math.max(200, usableW - chatWidth - suggW)
          availH = innerHeight
        } else {
          availH = Math.max(200, innerHeight - chatHeight)
          availW = usableW - 32
        }
        const aspectW = (availH * 16) / 9
        const aspectH = (availW * 9) / 16
        // Pick the dimension that hits its limit first (16:9 fits inside both)
        let finalW, finalH
        if (aspectW <= availW) {
          finalW = aspectW
          finalH = availH
        } else {
          finalW = availW
          finalH = aspectH
        }
        const wPx = `${Math.round(finalW)}px`
        const hPx = `${Math.round(finalH)}px`
        for (const el of ytSizedEls) {
          el.dataset._hsCYtSized = '1'
          el.style.setProperty('width', wPx, 'important')
          el.style.setProperty('height', hPx, 'important')
          el.style.setProperty('max-width', wPx, 'important')
          el.style.setProperty('max-height', hPx, 'important')
          el.style.setProperty('min-height', '0', 'important')
        }
        requestAnimationFrame(() => {
          for (const el of ytSizedEls) {
            if (!el.dataset._hsCYtSized) continue
            el.style.setProperty('width', wPx, 'important')
            el.style.setProperty('height', hPx, 'important')
            el.style.setProperty('max-width', wPx, 'important')
            el.style.setProperty('max-height', hPx, 'important')
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
            const b = mp?.getBoundingClientRect()
            if (!special && b && b.height > 0) {
              document.documentElement.style.setProperty('--hs-yt-below-top', `${Math.round(b.bottom)}px`)
            } else {
              document.documentElement.style.removeProperty('--hs-yt-below-top')
            }
          } else {
            // top/bottom (or any non-left/right that still reached here): the
            // pin is left/right-only, so clear any stale value from a prior dock.
            document.documentElement.style.removeProperty('--hs-yt-below-top')
          }
        })
      } else {
        for (const el of ytSizedEls) {
          if (el.dataset._hsCYtSized === '1') {
            delete el.dataset._hsCYtSized
            PLAYER_GEOM.forEach((p) => {
              el.style.removeProperty(p)
            })
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
      const playerWrap = injected?.parentElement // div.bg-black, immediate player box
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
        KICK_PLAYER_GEOM.forEach((p) => {
          stale.style.removeProperty(p)
        })
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
        const aspectW = (availH * 16) / 9
        const aspectH = (availW * 9) / 16
        let finalW, finalH
        if (aspectW <= availW) {
          finalW = aspectW
          finalH = availH
        } else {
          finalW = availW
          finalH = aspectH
        }
        const wPx = `${Math.round(finalW)}px`
        const hPx = `${Math.round(finalH)}px`
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
            KICK_PLAYER_GEOM.forEach((p) => {
              el.style.removeProperty(p)
            })
          }
        }
      }
    } else {
      // Twitch
      const rc = document.querySelector('.right-column')
      if (rc) {
        if (isRight) {
          // Restore: clear our overrides; Twitch's own width logic will
          // re-assert on next layout pass.
          rc.style.removeProperty('width')
          rc.style.removeProperty('min-width')
          rc.style.removeProperty('max-width')
          rc.style.removeProperty('flex-shrink')
        } else {
          rc.style.setProperty('width', '0', 'important')
          rc.style.setProperty('min-width', '0', 'important')
          rc.style.setProperty('max-width', '0', 'important')
        }
      }
      // .persistent-player has inline height:100%/max-height:100vh that
      // ignores any CSS bottom: inset. Override the player's geometry
      // directly so the chat strip doesn't sit on top of the video.
      const pp = document.querySelector('.persistent-player')
      if (pp) {
        // On no-channel pages (directory, browse, following) .persistent-player
        // is Twitch's floating mini-player. Clear any stale overrides we applied
        // on the prior channel page and let Twitch own the mini-player geometry.
        if (document.body.classList.contains('hs-twitch-no-channel')) {
          pp.style.removeProperty('top')
          pp.style.removeProperty('left')
          pp.style.removeProperty('bottom')
          pp.style.removeProperty('right')
          pp.style.removeProperty('width')
          pp.style.removeProperty('height')
          pp.style.removeProperty('max-height')
        } else if (isRight) {
          // Twitch's persistent-player has position:absolute with no CSS
          // rule setting `top`. The previous code removed inline top expecting
          // Twitch's React effect to re-apply it — but on certain layouts
          // (narrow window / chat resize / cold load) Twitch never sets it,
          // so the element falls to its natural-flow position at the bottom
          // of root-scrollable__wrapper (y ≈ 2000+px), pushing the video
          // off-screen below the about section. Pin it explicitly to top:0
          // (within root-scrollable__wrapper, that's the player slot).
          pp.style.setProperty('top', '0', 'important')
          pp.style.setProperty('left', '0', 'important')
          pp.style.removeProperty('bottom')
          pp.style.removeProperty('right')
          pp.style.removeProperty('max-height')
          pp.style.removeProperty('height')
          pp.style.removeProperty('width')
        } else if (chatPosition === 'left') {
          // chat-left: geometry is owned entirely by the .hs-chat-left CSS
          // rules (width:auto, left:calc(--hs-chat-w - sidenav), right:0,
          // top:0). They use --hs-chat-w with a 340px fallback so they're
          // correct even before the var is published, and a stylesheet
          // !important survives React's later inline writes.
          // Writing left inline here raced: on a cold load chatWidth was
          // momentarily 0, so left computed to 0 and the player slid under
          // the HS panel (inline !important beats the correct CSS rule).
          // Just clear any stale inline geometry — including a top:0/left:0
          // pair left behind by a prior right-mode pass — so CSS wins.
          pp.style.removeProperty('left')
          pp.style.removeProperty('inset-inline-start')
          pp.style.removeProperty('top')
          pp.style.removeProperty('width')
          pp.style.removeProperty('height')
          pp.style.removeProperty('max-height')
        } else {
          // chat-top / chat-bottom: full overhaul. Width/height are
          // handled by the .hs-chat-* CSS rules (width:auto !important /
          // height:auto !important). We can't do it here via inline
          // setProperty('important') because Twitch's React effect later
          // does `el.style.height = 'X'` which wipes the inline priority
          // — only a stylesheet rule survives that.
          pp.style.removeProperty('width')
          pp.style.removeProperty('height')
          pp.style.removeProperty('max-height')
          pp.style.setProperty('top', chatPosition === 'top' ? h : '0', 'important')
          pp.style.setProperty('bottom', chatPosition === 'bottom' ? h : '0', 'important')
          pp.style.setProperty('left', '0', 'important')
          pp.style.setProperty('right', '0', 'important')
          pp.style.setProperty('inset-inline-start', '0', 'important')
          pp.style.setProperty('inset-inline-end', '0', 'important')
        }
      }
    }

    // If the platform re-asserts its inline width/height (e.g. Twitch's
    // own chat-width JS on resize), we re-apply on the same hooks the
    // platform uses: window.resize + chat-width persistence. No observer
    // here — observers on style attrs loop on our own writes.

    // Watch what our geometry actually did to the player. Idempotent, and it
    // only ever acts when the player has ended up unusable — see
    // player-guard.js for why this watches the outcome instead of adding
    // another !important to the race.
    try {
      installPlayerGuard()
    } catch (_) {}
  }

  function rotateChatPosition() {
    // C cycles 4 visible. Hidden via toggleChatHidden(). From hidden → previous-visible.
    if (document.body.classList.contains('hs-popout')) return
    const positions = ['right', 'bottom', 'left', 'top']
    const prev = chatPosition
    if (chatPosition === 'hidden') {
      chatPosition = positions.includes(chatPositionPrevious) ? chatPositionPrevious : 'right'
    } else {
      let idx = positions.indexOf(chatPosition)
      if (idx === -1) idx = 0
      chatPosition = positions[(idx + 1) % positions.length]
    }
    log('rotate-chat:', prev, '→', chatPosition)
    setSetting('chatPosition', chatPosition) // applier applies + tracks previous
  }

  // ============================================
  // CHAT HIDE/SHOW TOGGLE — \ key + edge-pill.
  // TAB-LOCAL on purpose (viewer ask): hiding chat on one stream must not
  // hide it on every other open tab. The hidden state lives in this page's
  // runtime + sessionStorage (per browser tab, survives reload/SPA nav) and
  // is NEVER written to the synced chatPosition setting. chatPositionPrevious
  // still syncs so restore lands on the last-known visible position.
  // ============================================
  let chatPositionPrevious = 'right'
  let chatHiddenLocal = false

  function _saveChatHiddenLocal() {
    try {
      if (chatHiddenLocal) sessionStorage.setItem('hs-chat-hidden-local', '1')
      else sessionStorage.removeItem('hs-chat-hidden-local')
    } catch (_) {}
  }

  function toggleChatHidden() {
    if (document.body.classList.contains('hs-popout')) return
    const visible = ['right', 'bottom', 'left', 'top']
    if (chatPosition === 'hidden') {
      chatHiddenLocal = false
      chatPosition = visible.includes(chatPositionPrevious) ? chatPositionPrevious : 'right'
      // The synced setting already holds a visible position — hide never
      // writes it (and boot heals legacy stored-'hidden'). Local apply only.
      applyChatPosition()
    } else {
      if (visible.includes(chatPosition)) {
        chatPositionPrevious = chatPosition
        saveUiSetting('chatPositionPrevious', chatPositionPrevious)
      }
      chatHiddenLocal = true
      chatPosition = 'hidden' // runtime only — the synced setting keeps the visible position
      applyChatPosition()
    }
    _saveChatHiddenLocal()
    log('[chat-toggle] →', chatPosition, 'local-only:', chatHiddenLocal, 'prev:', chatPositionPrevious)
  }

  // Edge-pill: orange strip pinned to the edge where chat last lived. Click to
  // restore (not a resize bar) — kept visible/thick on purpose, #fff, no text.
  function ensureChatRestorePill(show) {
    let pill = document.getElementById('hs-chat-restore-pill')
    if (!show) {
      if (pill) pill.remove()
      return
    }
    if (!pill) {
      pill = document.createElement('div')
      pill.id = 'hs-chat-restore-pill'
      pill.title = 'show chat (\\)'
      pill.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        toggleChatHidden()
      })
      pill.addEventListener('mousedown', (e) => e.stopPropagation())
      document.body.appendChild(pill)
    }
    const edge = ['right', 'bottom', 'left', 'top'].includes(chatPositionPrevious) ? chatPositionPrevious : 'right'
    pill.dataset.edge = edge
  }

  // Resolve the channel context to popout for the active tab.
  // Returns { name, twitch, kick, youtube } or null if no channel context.
  function resolvePopoutContext() {
    const id = currentTab
    if (!id) return null
    // Per-channel tab → use its config row directly
    if (_isChatTab(id) && id !== 'live') {
      const ch = (config.channels || []).find((c) => c.id === id)
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
      return ctx.twitch || ctx.kick || ctx.youtube ? ctx : null
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
    const hostPick =
      hostPlatform === 'twitch' && ctx.twitch
        ? 'twitch'
        : hostPlatform === 'kick' && ctx.kick
          ? 'kick'
          : hostPlatform === 'yt' && ctx.youtube
            ? 'youtube'
            : null
    const platform = hostPick || (ctx.twitch ? 'twitch' : ctx.kick ? 'kick' : ctx.youtube ? 'youtube' : null)
    if (!platform) return

    let url,
      features = 'width=400,height=600,menubar=no,toolbar=no,location=no,status=no'
    if (platform === 'twitch') {
      url = `https://www.twitch.tv/popout/${ctx.twitch}/chat?popout=`
    } else if (platform === 'kick') {
      url = `https://kick.com/popout/${ctx.kick}/chat`
    } else if (platform === 'youtube') {
      // A YouTube pop-out is CHAT-ONLY (youtube.com/live_chat) — never the whole
      // watch page. Resolve a concrete live videoId from every source we trust,
      // tab-scoped first: the poller-cached link for this tab, then a watch/live
      // url stored in ctx.youtube, then (only when we're on a youtube page) the
      // current page url or the auto-live stream. A channel/handle url has NO
      // videoId → nothing to pop out; show that instead of opening a full page
      // with the video + title + description (which is not a chat pop-out).
      const link = youtubeLinks.get(currentTab)
      const videoId =
        link?.videoId ||
        extractYoutubeVideoId(ctx.youtube) ||
        (hostPlatform === 'yt' ? extractYoutubeVideoId(location.href) || _autoYtVideoId || '' : '')
      if (!videoId) {
        showToast(t('mc_main_no_yt_stream'), 'info')
        return
      }
      url = `https://www.youtube.com/live_chat?v=${videoId}&is_popout=1`
    }
    try {
      window.open(url, `hs-popout-${platform}-${ctx.name}`, features)
    } catch (e) {
      log('popout open failed:', e)
    }
  }

  // Show the popout button when the active tab has a channel context.
  // Hidden on static tabs (feed/mentions/whispers/pinned/settings/add).
  function updatePopoutBtnVisibility() {
    const btn = tabBarElement?.querySelector('.hs-mc-popout-btn')
    if (!btn) return
    btn.style.display = resolvePopoutContext() ? '' : 'none'
  }

  // Platform subscribe deep-links for a channel tab. The money path must
  // never dead-end: twitch/kick land on the real checkout, youtube lands on
  // the channel with the subscribe confirm (join/membership sits right next
  // to it when the channel has one — a /join deep-link 404-pages channels
  // without memberships, so we deliberately don't use it).
  function channelSubLinks(ch) {
    const links = []
    if (!ch) return links
    if (ch.twitch)
      links.push({ label: 'sub — twitch', url: `https://www.twitch.tv/subs/${encodeURIComponent(ch.twitch)}` })
    if (ch.kick) links.push({ label: 'sub — kick', url: `https://kick.com/${encodeURIComponent(ch.kick)}` })
    if (ch.youtube) {
      try {
        const u = new URL(ch.youtube)
        const m = u.pathname.match(/^\/(@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+|user\/[\w.-]+)/)
        if (u.protocol === 'https:' && /(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(u.hostname) && m) {
          links.push({ label: 'sub — youtube', url: `https://www.youtube.com/${m[1]}?sub_confirmation=1` })
        }
      } catch (_) {}
    }
    return links
  }

  // One platform → straight to its sub page. Simulcast tab → tiny picker,
  // same square black chrome as the tab context menu.
  function openSubForCurrentTab(anchorEl) {
    const links = channelSubLinks(getChannelById(currentTab))
    if (!links.length) return
    if (links.length === 1) {
      window.open(links[0].url, '_blank', 'noopener')
      return
    }
    document.getElementById('hs-mc-ctx-menu')?.remove()
    const menu = document.createElement('div')
    menu.id = 'hs-mc-ctx-menu'
    menu.style.cssText =
      'position:fixed;z-index:99999;background:#000;border:1px solid #808080;border-radius:0;padding:4px 0;min-width:150px;font-size:13px;font-family:inherit;'
    for (const l of links) {
      const item = document.createElement('div')
      item.textContent = l.label
      item.style.cssText = 'padding:6px 12px;cursor:pointer;color:#ff8700;'
      item.addEventListener('mouseenter', () => (item.style.background = 'rgba(255,255,255,0.06)'), {
        signal: mcSignal,
      })
      item.addEventListener('mouseleave', () => (item.style.background = ''), { signal: mcSignal })
      item.addEventListener('click', () => {
        menu.remove()
        window.open(l.url, '_blank', 'noopener')
      })
      menu.appendChild(item)
    }
    document.body.appendChild(menu)
    const r = anchorEl?.getBoundingClientRect?.()
    const mw = menu.offsetWidth,
      mh = menu.offsetHeight
    menu.style.left = `${Math.min(r ? r.left : 0, window.innerWidth - mw - 4)}px`
    menu.style.top = `${Math.min(r ? r.bottom + 2 : 0, window.innerHeight - mh - 4)}px`
    const dismiss = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove()
        document.removeEventListener('click', dismiss)
      }
    }
    cleanup.setTimeout(() => document.addEventListener('click', dismiss, { signal: mcSignal }), 0)
  }

  // $ shows only when the active tab has at least one platform sub target.
  function updateSubBtnVisibility() {
    const btn = tabBarElement?.querySelector('.hs-mc-sub-btn')
    if (!btn) return
    btn.style.display = channelSubLinks(getChannelById(currentTab)).length ? '' : 'none'
  }

  // Drop a panel callout (status/error banner) directly below the search/filter
  // bar — never above it, where it would shove the filter input down on reload.
  // Falls back to the container top only if the overlay isn't mounted yet.
  function _insertPanelCallout(el) {
    const searchBar = document.getElementById('hs-mc-search-bar')
    if (searchBar?.parentNode) {
      searchBar.parentNode.insertBefore(el, searchBar.nextSibling)
      return
    }
    const container = document.getElementById('hs-mc-container')
    if (container) container.insertBefore(el, container.firstChild)
  }

  // Render a small banner inside the multichat panel when an upstream API is unreachable.
  // Auto-removes when state flips back to 'up'. Only renders when our panel is mounted.
  function showApiStatusBanner(source, state) {
    const container = document.getElementById('hs-mc-container')
    if (!container) return
    const id = `hs-mc-api-banner-${(source || 'unknown').replace(/[^a-z0-9_-]/gi, '')}`
    const existing = document.getElementById(id)
    if (state === 'up') {
      existing?.remove()
      return
    }
    if (existing) return
    const banner = document.createElement('div')
    banner.id = id
    banner.className = 'hs-mc-api-banner'
    banner.style.cssText =
      'background:#fff;color:#000;font:600 11px/1.4 monospace;padding:6px 10px;text-align:center;display:flex;align-items:center;justify-content:center;gap:8px;'
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
    if (loggedIn) {
      existing?.remove()
      return
    }
    const hasYt = Array.isArray(config?.channels) && config.channels.some((c) => c.youtube)
    if (!hasYt) {
      existing?.remove()
      return
    }
    if (existing) return
    const banner = document.createElement('div')
    banner.id = id
    banner.className = 'hs-mc-auth-banner'
    banner.style.cssText =
      'background:#fff;color:#000;font:600 11px/1.4 monospace;padding:6px 10px;text-align:center;display:flex;align-items:center;justify-content:center;gap:8px;'
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

  // Persistent one-click login nudge — shown when someone tries to collect/use an
  // emote while signed out of heatsync. Their emotes render for nobody and vanish
  // on refresh until they log in; a transient toast never conveys that, so people
  // conclude the ext is broken. Square, terminal, dead-simple: one button to
  // login. Auto-dismisses on successful login (auth_changed) and on any
  // successful add (emote_added). Idempotent.
  function showEmoteLoginNudge() {
    const container = document.getElementById('hs-mc-container')
    if (!container) return
    const id = 'hs-mc-emote-login-nudge'
    if (document.getElementById(id)) return
    const banner = document.createElement('div')
    banner.id = id
    banner.className = 'hs-mc-auth-banner'
    banner.style.cssText =
      'background:#fff;color:#000;font:600 11px/1.4 monospace;padding:6px 10px;text-align:center;display:flex;align-items:center;justify-content:center;gap:8px;'
    const text = document.createElement('span')
    text.textContent = 'log in to heatsync so your emotes work for everyone'
    const link = document.createElement('a')
    link.href = 'https://heatsync.org/login'
    link.target = '_blank'
    link.rel = 'noopener'
    link.textContent = 'log in'
    // nowrap so the link never splits across lines when the panel is narrow
    link.style.cssText = 'color:#000;text-decoration:underline;font-weight:700;cursor:pointer;white-space:nowrap;'
    const dismiss = document.createElement('span')
    dismiss.textContent = '×'
    dismiss.style.cssText = 'cursor:pointer;font-weight:700;padding:0 4px;margin-left:4px;'
    dismiss.addEventListener('click', () => banner.remove())
    banner.append(text, link, dismiss)
    _insertPanelCallout(banner)
  }
  function dismissEmoteLoginNudge() {
    document.getElementById('hs-mc-emote-login-nudge')?.remove()
  }

  function listenForSettingsChanges() {
    if (_onceGuardsMain.settingsListener) return
    _onceGuardsMain.settingsListener = true

    // Listen for messages from popup — tracked through cleanup so SPA
    // reinit removes the prior handler and replaces it.
    cleanup.addListener(chrome.runtime?.onMessage, (msg) => {
      if (msg.type === 'ui_settings_changed' && msg.settings) {
        log('Settings changed via message:', msg.settings)
        if (msg.settings.tabPosition !== undefined && msg.settings.tabPosition !== tabPosition) {
          tabPosition = msg.settings.tabPosition
          applyTabsPosition()
        }
        if (msg.settings.chatPosition !== undefined && msg.settings.chatPosition !== chatPosition) {
          chatPosition = msg.settings.chatPosition
          applyChatPosition()
        }
      }
      if (msg.type === 'debug_log' && MC_DEBUG) console.log('[hs-bg]', msg.msg)
      if (msg.type === 'emote_add_failed') {
        // BG's collect POST failed (logged out — common right after an ext
        // reload — rate limit, server error). This was silent on the multichat
        // surface: the emote kept rendering locally from the session index and
        // vanished on refresh with no server row (the o7 bug). Fail loud.
        try {
          if (msg.notLoggedIn) {
            // The dominant cause of "emotes don't work / the ext sucks": the user
            // isn't signed into heatsync, so their added emotes render for nobody
            // and vanish on refresh. A disappearing toast doesn't fix the
            // confusion — show a persistent, one-click login nudge instead.
            showEmoteLoginNudge()
          } else {
            showToast(t('mc_main_emote_add_failed', [msg.emoteName || 'emote', msg.error || 'server error']), 'error')
          }
        } catch (_) {}
      }
      if (msg.type === 'api_status') {
        try {
          showApiStatusBanner(msg.source, msg.state)
        } catch (_) {}
      }
      // Server-enriched emote refs for a twitch message the native tap already
      // delivered (which lacks them). Merge onto the row by id and re-render it
      // in place so the sender's emotes resolve without a per-sender fetch.
      if (msg.type === 'bg_irc_enrich' && msg.id && msg.hsEmotes) {
        try {
          const ech = (msg.channel || '').toLowerCase()
          const rows = irc?.getMessages ? irc.getMessages(ech) : null
          if (rows) {
            for (const m of rows) {
              if (m && m.id === msg.id) {
                if (!m.hsEmotes) {
                  m.hsEmotes = msg.hsEmotes
                  m._renderedHtml = null
                  if (typeof queueImmediateReprocess === 'function') queueImmediateReprocess()
                }
                break
              }
            }
          }
        } catch (_) {}
      }
      if (msg.type === 'auth_changed') {
        try {
          showAuthLoginBanner(!!msg.loggedIn)
          if (msg.loggedIn) {
            dismissEmoteLoginNudge()
            revealFreshInstallTabsOnce()
          }
        } catch (_) {}
      }
      // The `cosmetics` switch gated only the PULL (loadBulkBadges). This is
      // the PUSH — background re-broadcasts the bttv/ffz/chatterino maps on
      // every refresh — so with cosmetics off the maps were repopulated and
      // re-injected into live rows anyway. Gate the pull, miss the push: the
      // same shape that made irc-twitch a switch that turned nothing off.
      if (msg.type === 'cosmetics_update' && gateAtBoot('cosmetics') === false) return
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
        try {
          _applyFollowedSnapshot(msg.snapshot)
        } catch {}
      }
      // 7TV EventAPI pushed user.update / entitlement.* — drop our local
      // cosmetic cache and re-queue lookup so badges/paint show up fresh.
      if (msg.type === 'cosmetics_invalidated' && msg.twitchId && gateAtBoot('cosmetics') !== false) {
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
          const _ownerKey = msg.channelOwner.toLowerCase()
          // Additive diff BEFORE the rebuild: does this payload make any name
          // renderable that wasn't? Late payloads (a provider resolving after
          // the 25s cold window — deferred joins, slow 7TV, a refetch landing
          // minutes in) must still heal plain-text history rows; the time
          // window alone missed them. Upgrade-only: removal payloads add no
          // names, so they never trigger a history re-render ("history is
          // sacred" — the stale-ghost registry handles removals).
          const _prevCache = channelEmoteCaches[_ownerKey]
          for (const _e of msg.emotes) {
            if (_e?.name && _e.url && !(_prevCache instanceof Map && _prevCache.has(_e.name))) {
              _pendingEmoteAdds = true
              break
            }
          }
          _buildChannelEmoteCache(_ownerKey, msg.emotes, msg.platform)
          if (msg.platform === 'youtube') {
            // Alias the SAME Map under the shapes getCurrentChannel() yields on
            // yt pages — raw-case videoId (watch?v=) and bare handle (no @) —
            // so picker/lookup fallbacks hit. yt cache keys are videoId/@handle
            // (BG yt_ensure_channel_emotes derivation), never a channel name.
            for (const a of [msg.channelOwner, _ownerKey.replace(/^@/, '')]) {
              if (a && a !== _ownerKey) channelEmoteCaches[a] = channelEmoteCaches[_ownerKey]
            }
          }
          markPickerDirty()
        }
        // Cold-start (first emote payload for this scope) needs clear+rerender
        // so old plain-text messages from history pick up newly-loaded emotes.
        // Subsequent updates (add/remove via 7TV EventAPI) preserve _renderedHtml
        // — old messages keep their emote rendering even if an emote is removed.
        // History is sacred: what was rendered as an emote stays an emote.
        const scope = msg.type === 'channel_emotes_update' ? `ch:${msg.channelOwner || '_'}` : 'global'
        _pendingEmoteScopes.add(scope)
        cleanup.clearTimeout(emoteReloadTimer)
        emoteReloadTimer = cleanup.setTimeout(() => {
          const pending = _pendingEmoteScopes
          _pendingEmoteScopes = new Set()
          const hadAdds = _pendingEmoteAdds
          _pendingEmoteAdds = false
          loadEmotes()
            .then(() => {
              // Heal plain-text history rows whenever this flush made new names
              // renderable (additive diff), or during a scope's cold-load window
              // (covers global/inventory scopes with no diff). In-place text
              // swap instead of clearRenderedHtmlCache()→epoch bump→full
              // rebuild (the flash). Additive-only outside the window, so a
              // removal never re-renders history ("history is sacred").
              if (hadAdds || _emoteColdLoad(pending)) reloadEmotesInPlace()
            })
            .catch((e) => log('[heatsync-mc] loadEmotes error:', e))
        }, 300)
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
        try {
          reconcileAutoTabs(Array.isArray(msg.channels) ? msg.channels : [])
        } catch (_) {}
        return
      }
      if (msg.type === 'hs_moment') {
        try {
          handleMomentSpike(msg.data)
        } catch (_) {}
        return
      }
      if (msg.type === 'inventory_update') {
        const prevInventory = new Set(inventoryEmotes)
        inventoryEmotes.clear()
        inventoryHashes.clear()
        ;(msg.emotes || []).forEach((e) => {
          if (e.name) {
            inventoryEmotes.add(e.name)
            if (e.hash) inventoryHashes.set(e.name, e.hash)
            // Flip state for emotes that are ALSO in the heatsync globals pool;
            // do not ADD new entries to emoteCache here.
            if (emoteCache.has(e.name)) {
              const c = emoteCache.get(e.name)
              c.state = 'owned'
              if (e.slot != null) c.slot = e.slot
            }
            if (e.url) {
              // Recover overlay flag for emotes whose server row is pre-zero_width
              // (DB column added 2026-05-23; rows added before that have FALSE).
              // The 7TV channel/global caches still carry the flag — borrow it so
              // a viewer's pre-existing CarrotTime/wavE stacks without re-adding.
              const zwFromAny = typeof zeroWidthFromAnyCache === 'function' ? zeroWidthFromAnyCache(e.name) : false
              viewerPersonalEmotes.set(e.name, {
                url: e.url,
                source: 'heatsync',
                state: 'owned',
                hash: e.hash,
                slot: e.slot,
                zeroWidth: !!(e.zero_width ?? e.zeroWidth ?? zwFromAny),
                // BG-normalized epoch ms — inventory-time render gate
                addedAt: e.addedAt || 0,
                // server CW annotation — own msgs hide these at render when
                // the owner's own viewer_show_* toggles say so
                cwCats: Array.isArray(e.cw_cats) && e.cw_cats.length ? e.cw_cats : null,
              })
            }
          }
        })
        // Remove emotes no longer in inventory from cache (if heatsync source)
        for (const [name, emote] of emoteCache) {
          if (emote.source === 'heatsync' && !inventoryEmotes.has(name)) {
            emoteCache.delete(name)
          }
        }
        for (const name of viewerPersonalEmotes.keys()) {
          if (!inventoryEmotes.has(name)) viewerPersonalEmotes.delete(name)
        }
        // Flip already-rendered wrappers in chat: owned ↔ unadded so a just-
        // posted emote that the viewer then removes turns orange instead of
        // staying green. No-op on names whose membership didn't change.
        const removed = [...prevInventory].filter((n) => !inventoryEmotes.has(n))
        const added = [...inventoryEmotes].filter((n) => !prevInventory.has(n))
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
        log('inventory_update:', inventoryEmotes.size, 'emotes')
        // Inventory just changed emoteCache contents — picker is stale.
        markPickerDirty()
        prebuildPickerIdle()
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
          if (!em.url?.includes('cdn.7tv.app/emote/')) continue
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
            await Promise.allSettled(
              batch.map(async ({ name, sevenTvId, em }) => {
                try {
                  const r = await fetch(`https://7tv.io/v3/emotes/${sevenTvId}`).then((r) => (r.ok ? r.json() : null))
                  const isZw = !!(r && (r.flags || 0) & 256)
                  if (!isZw) return
                  em.zeroWidth = true
                  if (typeof invalidateRenderedForEmotes === 'function') invalidateRenderedForEmotes([name])
                  // Sticky-true upgrade on the server so every other viewer of any
                  // sender owning this emote inherits the flag too.
                  try {
                    chrome.runtime.sendMessage(
                      {
                        type: 'add_to_inventory',
                        emoteName: name,
                        emoteHash: em.hash || sevenTvId,
                        emoteUrl: em.url,
                        zeroWidth: true,
                      },
                      () => {
                        void chrome.runtime.lastError
                      },
                    )
                  } catch (_) {}
                } catch (_) {}
              }),
            )
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
        // Key may be namespaced (twitch:alice) or legacy bare (alice). Delete both
        // so unmuting always clears the Set regardless of when the entry was written.
        const u = msg.username?.toLowerCase()
        const bare = u?.includes(':') ? u.split(':')[1] : null
        let changed = false
        if (u && mutedUsers.has(u)) {
          mutedUsers.delete(u)
          changed = true
        }
        if (bare && mutedUsers.has(bare)) {
          mutedUsers.delete(bare)
          changed = true
        }
        if (changed) {
          restoreMcUnmutedDom(bare || u)
          renderMessages(currentTab, { bypassScrollPause: true })
        }
      }
      // Server cleared the entire mute list (e.g. user clicked "clear all" on heatsync.org)
      if (msg.type === 'mutes_cleared' && mutedUsers.size > 0) {
        for (const u of mutedUsers) {
          // Keys may be namespaced — restoreMcUnmutedDom matches by bare display name
          const bare = u.includes(':') ? u.split(':')[1] : u
          restoreMcUnmutedDom(bare)
        }
        mutedUsers.clear()
        renderMessages(currentTab, { bypassScrollPause: true })
      }
      // Cross-surface block sync (content.js, other tabs). Full re-render so blocked
      // users drop out / reappear (buildMessageDiv filters them).
      if (msg.type === 'user_blocked') {
        const u = msg.username?.toLowerCase()
        if (u && !blockedUsers.has(u)) {
          blockedUsers.add(u)
          renderMessages(currentTab, { bypassScrollPause: true })
        }
      }
      if (msg.type === 'user_unblocked') {
        // Delete both namespaced key AND legacy bare form so unblock always lands.
        const u = msg.username?.toLowerCase()
        const bare = u?.includes(':') ? u.split(':')[1] : null
        const had = (u && blockedUsers.delete(u)) | (bare && blockedUsers.delete(bare))
        if (had) renderMessages(currentTab, { bypassScrollPause: true })
      }

      // A different user's emote set changed. New servers send senderKeys —
      // invalidate + refetch exactly that sender (v-busted past the CF edge);
      // the flush path's upgradeMessagesForSenders re-renders their rows.
      // Legacy shape (no senderKeys, incl. the reconnect-convergence nudge):
      // bust everyone — next render of any message refreshes.
      if (msg.type === 'emote_added_broadcast') {
        try {
          if (Array.isArray(msg.senderKeys) && msg.senderKeys.length) {
            for (const key of msg.senderKeys.slice(0, 30)) {
              if (typeof key !== 'string' || !key) continue
              senderEmoteFetchedAt.delete(key)
              senderEmoteVerified.delete(key)
              if (msg.ver != null) setSenderEmoteBustVer(key, msg.ver)
              // Only refetch senders we actually hold — a key never seen in
              // this panel has no rows to fix and would be pure fetch noise.
              if (typeof senderEmoteSets !== 'undefined' && senderEmoteSets.has(key)) {
                senderEmotePending.add(key)
              }
            }
            if (senderEmotePending.size) {
              if (senderEmoteTimer) {
                cleanup.clearTimeout(senderEmoteTimer)
                senderEmoteTimer = null
                senderEmoteTimerUrgent = false
              }
              flushSenderEmoteBatch()
            }
          } else {
            if (typeof senderEmoteFetchedAt !== 'undefined') senderEmoteFetchedAt.clear()
            // Freshness alone only helps FUTURE renders — if chat is quiet,
            // nothing re-renders and the already-painted rows stay text.
            // Actively re-queue the senders of recent buffered rows (same
            // buffers the removal path walks); the flush path's
            // upgradeMessagesForSenders() re-renders whatever changed.
            const requeue = (buf) => {
              if (!buf) return
              const arr = Array.isArray(buf) ? buf : typeof buf.values === 'function' ? [...buf.values()] : null
              if (!arr) return
              let queued = 0
              for (let i = arr.length - 1; i >= 0 && queued < 60; i--, queued++) {
                const m = arr[i]
                const key = m && typeof resolveSenderEmoteKey === 'function' ? resolveSenderEmoteKey(m) : null
                if (key) queueSenderEmoteFetch(key, m)
              }
            }
            try {
              for (const ch of irc?.channels?.keys?.() || []) requeue(irc.getMessages(ch))
            } catch (_) {}
            try {
              for (const ch of kickChat?.channels?.keys?.() || []) requeue(kickChat.getMessages(ch))
            } catch (_) {}
          }
        } catch (_) {}
      }

      // A different user removed an emote from their set. Background already
      // dropped __senderEmoteCache; tombstone the panel's persisted
      // senderEmoteSets (dropEmoteFromAllSenders stamps removedAt) so FUTURE
      // messages stop imagifying the name while already-owned history keeps
      // its render (_sGate interval). Re-render matching messages so each row
      // settles on its interval-correct form.
      if (msg.type === 'emote_removed_broadcast' && msg.emoteName) {
        // Precise path (new servers): strip the name from exactly the pushed
        // sender's keys — no collateral, no global freshness bust.
        const precise = Array.isArray(msg.senderKeys) && msg.senderKeys.length > 0
        const changed = precise
          ? typeof dropEmoteFromSenders === 'function' &&
            dropEmoteFromSenders(msg.senderKeys.slice(0, 30), msg.emoteName)
          : typeof dropEmoteFromAllSenders === 'function' && dropEmoteFromAllSenders(msg.emoteName)
        if (precise) {
          for (const key of msg.senderKeys.slice(0, 30)) {
            if (typeof key === 'string' && key) {
              senderEmoteFetchedAt.delete(key)
              if (msg.ver != null) setSenderEmoteBustVer(key, msg.ver)
            }
          }
        }
        if (changed) {
          try {
            // Legacy path strips by NAME from every cached set — an innocent
            // sender who owns a same-named emote just lost it too. Bust
            // freshness so their next render refetches and restores it.
            if (!precise && typeof senderEmoteFetchedAt !== 'undefined') senderEmoteFetchedAt.clear()
            const inv = (buf) => {
              if (!buf) return
              const arr = typeof buf.forEach === 'function' && !Array.isArray(buf) ? null : buf
              const iter = arr || (typeof buf.values === 'function' ? buf.values() : null)
              if (!iter) return
              for (const m of iter) {
                if (m?.text?.includes(msg.emoteName)) m._renderedHtml = null
              }
            }
            // Twitch + Kick IRC buffers (per-channel)
            try {
              for (const ch of irc?.channels?.keys?.() || []) inv(irc.getMessages(ch))
            } catch (_) {}
            try {
              for (const ch of kickChat?.channels?.keys?.() || []) inv(kickChat.getMessages(ch))
            } catch (_) {}
            if (typeof mentionsBuffer !== 'undefined') inv(mentionsBuffer)
            if (typeof channelYtMessages !== 'undefined') channelYtMessages.forEach(inv)
            // Drawn rows can be orphaned from every buffer walked above (SPA
            // nav reinits chat state) — invalidate through the _hsMsg back-ref
            // too, same as upgradeMessagesForSenders, or they stay imagified
            // forever.
            const msgsEl = document.getElementById('hs-mc-messages')
            if (msgsEl) {
              for (const div of msgsEl.querySelectorAll('.hs-mc-msg[data-msg-key]')) {
                const m = div._hsMsg
                if (m?.text?.includes(msg.emoteName)) m._renderedHtml = null
              }
            }
            // In-place swap reaches orphans and never touches scroll; the full
            // re-render only when pinned to bottom (it snaps the viewport).
            queueImmediateReprocess()
            if (!isScrolledUp) renderMessages(currentTab)
          } catch (_) {}
        }
      }

      // Server-evaluated mention rule match — show as inline toast
      if (msg.type === 'mention_rule_match') {
        const channel = String(msg.channel || '').toLowerCase()
        const username = String(msg.username || '')
        const snippet = String(msg.snippet || '').slice(0, 200)
        const pattern = String(msg.pattern || '')
        // Blocked users can't ping you, even via a server-evaluated rule.
        if (typeof isUserBlocked === 'function' && isUserBlocked(username, msg.platform)) return
        try {
          HsNotifs.emit('server-mention-rule', { channel, username, snippet, pattern })
        } catch (_) {}
      }

      // 7TV emote add/remove — surface as an inline stream-event in the
      // matching channel tab (and live tab if it IS the live channel).
      if (msg.type === 'channel_emote_added' || msg.type === 'channel_emote_removed') {
        log('7TV emote change:', msg.message)
        const channel = (msg.channel || '').toLowerCase()
        if (!channel) return
        const actor = msg.actor || ''
        // Stale-emote ghost: when an emote leaves the channel set, mark
        // historical messages so the cached IMG renders dimmed + tagged with
        // who removed it. Restored on re-add. Persisted to chrome.storage so
        // it survives reload. 7-day TTL handled at read.
        const _staleReg = window._hsStaleEmotes || (window._hsStaleEmotes = new Map())
        const _ensureChannel = (ch) => {
          let m = _staleReg.get(ch)
          if (!m) {
            m = new Map()
            _staleReg.set(ch, m)
          }
          return m
        }
        const _persistStale = () => {
          try {
            const out = {}
            const cutoff = Date.now() - 7 * 86400000
            for (const [ch, m] of _staleReg) {
              const entries = []
              for (const [name, meta] of m) {
                if ((meta?.at || 0) >= cutoff) entries.push([name, meta])
              }
              if (entries.length) out[ch] = entries.slice(-100)
            }
            chrome.storage.local.set({ hs_stale_emotes_v1: out }).catch(() => {})
          } catch (_) {}
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
          } catch (_) {}
        }
        if (msg.type === 'channel_emote_removed' && msg.emoteName) {
          _ensureChannel(channel).set(msg.emoteName, {
            at: Date.now(),
            actor,
            hash: msg.emoteHash || '',
            provider: '7tv',
          })
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
          action = msg.emote?.name ? `added 7TV emote ${msg.emote.name}` : msg.message || '7TV emote set updated'
        } else {
          action = msg.emoteName ? `removed 7TV emote ${msg.emoteName}` : msg.message || '7TV emote set updated'
        }
        // Strip leading "${actor} " duplicate that bg may include in single-emote case
        if (actor && action.toLowerCase().startsWith(`${actor.toLowerCase()} `)) {
          action = action.slice(actor.length + 1)
        }
        const dedup = window._hsStreamEventDedup || (window._hsStreamEventDedup = new Map())
        const text = `[${channel}] ◆ ${action}`
        const now = Date.now()
        if (dedup.has(text) && now - dedup.get(text) < 60000) return
        dedup.set(text, now)
        if (dedup.size > 100) {
          for (const [k, t] of dedup) {
            if (now - t > 60000) dedup.delete(k)
          }
        }
        const evt = { type: 'stream-event', eventClass: 'event-emote', text, channel, actor: actor || null, time: now }
        const liveChannel = getLiveChannel()
        const chBuffer = irc?.channels?.get(channel)
        if (chBuffer) {
          const existing = chBuffer.getAll()
          if (!existing.some((m) => m.type === 'stream-event' && m.text === evt.text)) {
            chBuffer.push(evt)
            saveStreamEvent(evt)
          }
        }
        if (channel === liveChannel) {
          const liveBuffer = irc?.channels?.get(liveChannel)
          if (liveBuffer && liveBuffer !== chBuffer) {
            const existing = liveBuffer.getAll()
            if (!existing.some((m) => m.type === 'stream-event' && m.text === evt.text)) {
              liveBuffer.push(evt)
              if (!chBuffer) saveStreamEvent(evt)
            }
          }
        }
        try {
          pushActivityEvent(evt)
        } catch (_) {}
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
            const ki = tabCh.kick?.toLowerCase()
            if (tw === channel || ki === channel) {
              if (!appendMessage(evt, activeTab)) renderMessages(activeTab)
            } else {
              const matchTab = config.channels.find(
                (c) => c.twitch?.toLowerCase() === channel || c.kick?.toLowerCase() === channel,
              )
              if (matchTab) {
                const tabEl = tabBarElement?.querySelector(`[data-tab="${CSS.escape(matchTab.id)}"]`)
                if (tabEl) tabEl.classList.add('has-stream-event')
              }
            }
          }
        }
      }
    })

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
            if (applier) {
              try {
                applier(v, def, false, true)
              } catch (e) {
                warn('sync applier failed:', def.apply, e)
              }
            }
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

      // Registry-driven rehydration for local-scope settings — same loop as
      // the sync branch above. Without it every scope:'local' setting (mute
      // keywords, emote size, notifications, …) was a dead toggle across
      // tabs: the writing tab applied it, every other tab ignored the change.
      {
        let needsRender = false
        for (const def of SETTINGS) {
          if (def.scope !== 'local' || changes[def.key] === undefined) continue
          const v = coerceSettingValue(def, changes[def.key].newValue)
          if (v === undefined || !validateSettingValue(def, v)) continue
          const changed = JSON.stringify(v) !== JSON.stringify(getSetting(def.key))
          _settingsCache[def.key] = v
          if (!changed) continue
          const bridge = _bridgeFor(def)
          if (bridge) bridge.set(v)
          if (def.apply && !def.syncSilent) {
            const applier = _APPLIERS[def.apply]
            if (applier) {
              try {
                applier(v, def, false, true)
              } catch (e) {
                warn('local applier failed:', def.apply, e)
              }
            }
          }
          if (def.rerender) needsRender = true
        }
        if (needsRender) {
          bumpRenderEpoch()
          renderMessages(currentTab)
          if (currentTab === 'settings') renderSettingsTab()
        }
      }

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
      if (changes.chat_filter_rules) {
        const v = changes.chat_filter_rules.newValue
        if (typeof v === 'string') {
          let rules = []
          try {
            rules = JSON.parse(v)
          } catch {}
          compileFilterRules(Array.isArray(rules) ? rules : [])
          renderMessages(currentTab)
          if (currentTab === 'settings') renderSettingsTab()
        }
      }

      // Identity switch — compare the fields render decisions actually read, so
      // an unrelated user_info refresh (avatar, heat) doesn't force a repaint.
      if (changes.user_info) {
        const _identityOf = (v) => `${JSON.stringify(v?.sender_keys ?? null)}|${v?.username ?? ''}`
        if (_identityOf(changes.user_info.oldValue) !== _identityOf(changes.user_info.newValue)) {
          log('identity changed — repainting rows for the new account')
          repaintForIdentityChange()
        }
      }

      // Emote updates - reload when storage changes (debounced to avoid spam)
      if (
        changes.global_emotes ||
        changes.channel_emotes_map ||
        changes.emote_inventory ||
        changes.native_twitch_emotes
      ) {
        log(
          'storage changed:',
          changes.channel_emotes_map ? 'channel_emotes_map' : '',
          changes.global_emotes ? 'global_emotes' : '',
          changes.emote_inventory ? 'emote_inventory' : '',
          changes.native_twitch_emotes ? 'native_twitch_emotes' : '',
        )
        // Cold-start vs. update split: clear cache only on the first payload
        // per scope this session. Subsequent updates (add/remove) preserve
        // _renderedHtml so removed emotes stay rendered in old messages.
        const scope = changes.global_emotes
          ? 'global'
          : changes.channel_emotes_map
            ? 'ch:_storage'
            : changes.native_twitch_emotes
              ? 'native'
              : ''
        if (scope) _pendingEmoteScopes.add(scope)
        cleanup.clearTimeout(emoteReloadTimer)
        emoteReloadTimer = cleanup.setTimeout(() => {
          const pending = _pendingEmoteScopes
          _pendingEmoteScopes = new Set()
          loadEmotes()
            .then(() => {
              // cold-load: in-place text swap (no rebuild flash), skipping the
              // visible-row swap when scrolled up. non-cold emote edits render
              // now (only when at/near bottom, to not yank a scrolled-up reader).
              if (_emoteColdLoad(pending)) reloadEmotesInPlace(!isScrolledUp)
              else if (!isScrolledUp) renderMessages(currentTab)
            })
            .catch((e) => log('[heatsync-mc] loadEmotes error:', e))
        }, 300)
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
          const oldIds = new Set(oldChannels.map((c) => c.id))
          const newIds = new Set(newChannels.map((c) => c.id))

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
                chrome.runtime
                  .sendMessage({
                    type: 'youtube_ws_unsubscribe',
                    videoId: link?.videoId || '',
                    url: ch.youtube,
                    channelId: id,
                  })
                  .catch(() => {})
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
                safeSendMessage({ type: 'join_channel', platform: 'twitch', channel: twitchName })
              }
              const kickName = ch.kick
              if (kickName && isEnabled('chat-kick')) kickChat?.join(kickName)
              if (ch.youtube && isEnabled('chat-youtube')) {
                youtubeLinks.set(id, { url: ch.youtube, videoId: '', channelName: '' })
                // Arm the watchdog — it reads ytChanLastSeen/ytSubscribedUrls,
                // so a sub added without them is never re-subscribed on silence.
                ytSubscribedUrls.set(id, ch.youtube)
                ytChanLastSeen.set(id, Date.now())
                ytSubscribe(id, ch.youtube, id)
              }
            }
          }

          // Update config and UI
          config.channels = newChannels
          _channelLookup = null
          config.enabled = newConfig.enabled !== undefined ? newConfig.enabled : config.enabled
          updateTabBar()
          // If current tab was removed, switch to live
          if (
            currentTab !== 'live' &&
            currentTab !== 'feed' &&
            currentTab !== 'mentions' &&
            currentTab !== 'whispers' &&
            !newIds.has(currentTab)
          ) {
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
        applyBlockedHashDelta(changes.blocked_emotes.newValue || [])
        // applyBlockedHashDelta patches chat rows + input chips but NOT the cached
        // picker grid/search tiles — mark it dirty so the next open re-derives each
        // tile's state from the now-current blockedEmoteNames. Without this a
        // cross-tab/device block left the picker tile clickable+pasteable (it reads
        // state straight off the stale tile dataset), a real bypass not just cosmetic.
        if (typeof markPickerDirty === 'function') markPickerDirty()
      }

      // Emote/emoji scale changes from options page propagate live.
      if (changes.hs_emote_size) {
        const v = changes.hs_emote_size.newValue
        if (v === 1 || v === 2 || v === 4) {
          emoteSize = v
          applyEmoteSize()
        }
      }
      if (changes.hs_emoji_size) {
        const v = changes.hs_emoji_size.newValue
        if (v === 1 || v === 2 || v === 4) {
          emojiSize = v
          applyEmojiSize()
        }
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
        const change =
          def.scope === 'local' ? changes[def.key] : def.scope === 'local-mirror' ? changes[def.mirrorKey] : null
        if (!change) continue
        const v = coerceSettingValue(def, change.newValue)
        if (v === undefined || !validateSettingValue(def, v)) continue
        _settingsCache[def.key] = v
        const b = _bridgeFor(def)
        if (b) b.set(v)
        // content-warning pills flip live cross-tab (BG also writes these
        // keys when the server broadcasts a settings update)
        if (def.cw && typeof v === 'boolean') {
          document.querySelectorAll(`.hs-mc-toggle-pill[data-set-key="${def.key}"]`).forEach((pill) => {
            pill.classList.toggle('active', v)
          })
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
        if (kickLiveFound) {
          cleanup.clearInterval(fastPoll)
          cleanup.setIntervalIfVisible(checkKickLive, 10000)
        }
      }, 1000)
      return
    }
    // On YouTube, the live_chat iframe only loads on live streams; presence
    // there is the most reliable "is live" signal we can get without polling
    // the InnerTube API.
    if (hostPlatform === 'yt') {
      // True while WE collapsed yt's native chat (vs the user having done it
      // themselves) — gates the symmetric restore in checkYtLive.
      let _hsCollapsedNativeYt = false
      let _hsHidNativeYt = false
      let _hsYtFrameEmptySince = 0
      let _hsPrevShowYtChat = null
      function checkYtLive() {
        // Keep theatre state honest from the same 1.5s tick — the attribute
        // observer has been seen missing the [theater] flip (body stuck on
        // hs-mode-normal inside theatre), which strands every .hs-mode-theatre
        // rule. detectTheatreMode no-ops when nothing changed.
        try {
          detectTheatreMode()
        } catch (_) {}
        // A LIVE stream mounts ytd-live-chat-frame#chat with a LIVE chat iframe
        // (/live_chat). A VOD of a past stream mounts the SAME element but with a
        // chat-REPLAY iframe (/live_chat_replay) — so frame-presence alone wrongly
        // flags VODs as live and surfaced our panel on non-live videos. Distinguish
        // by the iframe src (the same signal youtube-content.js gates on): replay ⇒
        // treat as non-live so the panel stays hidden on VODs by default.
        const frameEl = document.querySelector('ytd-live-chat-frame#chat')
        const chatSrc = frameEl?.querySelector('iframe')?.getAttribute('src') || ''
        const isReplayChat = chatSrc.includes('live_chat_replay')
        // Require a RESOLVED src before treating this as live: the frame mounts
        // for both live and VOD before its iframe src populates, and an empty
        // src is not yet 'live_chat_replay' — so a bare !isReplayChat would
        // flash chat onto a VOD during that window. Empty src = inconclusive,
        // let the default hs-offline hold until the src truly resolves.
        const hasLiveChat = !!frameEl && !!chatSrc && !isReplayChat
        const _ytFlowing =
          typeof channelYtMessages !== 'undefined' ? channelYtMessages.get('__live_yt_auto__')?.length || 0 : 0
        // Live dot needs a CONFIRMED signal: resolved live src or messages
        // actually flowing. _autoYtVideoId is just the render gate — it's set
        // on EVERY /watch page, so counting it lit the dot on plain VODs.
        const isLive = hasLiveChat || _ytFlowing > 0
        const liveTab = tabBarElement?.querySelector('[data-tab="live"]')
        if (liveTab) liveTab.dataset.live = String(isLive)
        // Show the multichat panel on YT only when THIS page has its own LIVE
        // chat (a livestream), OR the user opted into chat on non-live pages
        // (ytChatOnNonLive → body.hs-yt-nonlive-chat). hs-offline drives both the
        // existing :not(.hs-offline) layout gating AND the panel-hide rule below,
        // so this single signal hides the panel on VODs/home/search by default.
        // Use hasLiveChat (THIS page, live-not-replay) — NOT isLive, which is true
        // whenever any tracked YT channel is live and would surface it on a VOD.
        // hasLiveChat relies on the live-chat iframe's `src` attribute — but
        // current YouTube leaves that src EMPTY on live streams (the frame mounts
        // and loads its chat without ever populating the src attr), so the src
        // check alone mis-flagged live streams as offline and hid the ENTIRE
        // panel (hs-offline → display:none). Ground truth instead: the server
        // only relays __live_yt_auto__ chat for a genuinely-live stream, so once
        // messages are flowing for THIS page it IS live, iframe src be damned.
        // The old gate required the live-chat iframe's `src` to be a populated
        // `/live_chat` url — but current YouTube leaves that src EMPTY on live
        // streams, so it hid the panel on EVERY livestream. Relax it: a chat
        // frame that is present and NOT a replay is a livestream (empty src =
        // not-yet-replay = live; a VOD's src resolves to `live_chat_replay` and
        // flips this off). Show immediately, no wait. Two more signals keep it
        // honest: chat actively flowing (server only relays for live) and the
        // non-live opt-in.
        const liveChatFramePresent = !!frameEl && !isReplayChat
        const ytAutoLiveMsgs = _ytFlowing
        const showYtChat =
          !isYtReplayPopout &&
          (isYtPopout ||
            liveChatFramePresent ||
            ytAutoLiveMsgs > 0 ||
            document.body.classList.contains('hs-yt-nonlive-chat'))
        // YT sizes its grids/columns from a width measured once per resize —
        // the panel's reserve appearing/vanishing without one strands a
        // squeezed layout (3-col home grid + dead column where the panel
        // was). Nudge a re-measure whenever panel visibility actually flips.
        // First run compares against the early-layout BOOT stamp (the state
        // YT first measured under), so a stale localStorage mirror still
        // gets its correction resize.
        if (_hsPrevShowYtChat === null) {
          _hsPrevShowYtChat = !document.body.classList.contains('hs-offline')
        }
        document.body.classList.toggle('hs-offline', !showYtChat)
        if (_hsPrevShowYtChat !== showYtChat) {
          try {
            window.dispatchEvent(new Event('resize'))
          } catch (_) {}
        }
        _hsPrevShowYtChat = showYtChat
        // Watch-page detection: ytd-watch-flexy stays in DOM with `hidden`
        // attr off-watch — only count it as a watch page when visible.
        const onWatch = !!document.querySelector('ytd-watch-flexy:not([hidden])')
        document.body.classList.toggle('hs-yt-watch', onWatch)
        // Shorts pages render via ytd-shorts (never ytd-watch-flexy), so
        // without this class the generic non-watch squeeze rules fired there
        // and shrank the shorts UI with no compensation. Shorts gets neither
        // squeeze nor panel (17-platform-position.css gates on it).
        const onShorts =
          location.pathname.startsWith('/shorts/') || !!document.querySelector('ytd-shorts:not([hidden])')
        document.body.classList.toggle('hs-yt-shorts', onShorts)
        // CONFIRMED live only (resolved live src, messages flowing, or src
        // still empty after a grace window) — the destructive actions below
        // must never fire on the inconclusive empty-src window: collapsing
        // there UNLOADS the iframe, so a VOD's src can never resolve to
        // live_chat_replay and the page stays permanently misclassified as
        // live with its replay chat destroyed. A VOD's replay src populates
        // within a couple seconds of mount; live streams often leave it empty
        // FOREVER — so empty-past-8s counts as live (covers quiet streams
        // where no relayed message arrives to confirm).
        if (frameEl && !chatSrc) {
          if (!_hsYtFrameEmptySince) _hsYtFrameEmptySince = Date.now()
        } else {
          _hsYtFrameEmptySince = 0
        }
        const _emptySrcAged = _hsYtFrameEmptySince && Date.now() - _hsYtFrameEmptySince > 8000
        const confirmedLive = hasLiveChat || ytAutoLiveMsgs > 0 || !!_emptySrcAged
        // Hide native YT chat once it mounts — but ONLY when we're showing our
        // panel in its place AND the page is confirmed live. On a replay VOD
        // (no opt-in) we leave YT's chat replay visible.
        if (showYtChat && confirmedLive && frameEl && frameEl.style.display !== 'none') {
          frameEl.style.display = 'none'
          _hsHidNativeYt = true
        }
        // display:none alone never releases YT's LAYOUT reservation: flexy
        // sizes the player off its own chat-collapsed state, not CSS
        // visibility — so theatre kept the video ~300px narrow with a dead
        // gap where yt still reserved its chat column (live-verified: click
        // yt's own collapse → collapsed attr → player snaps to full row).
        // Drive yt's real collapse; the attr guard makes this a one-shot.
        if (showYtChat && confirmedLive && frameEl && !frameEl.hasAttribute('collapsed')) {
          try {
            frameEl.querySelector('#show-hide-button button')?.click()
            _hsCollapsedNativeYt = true
          } catch (_) {}
        }
        // Symmetric restore — if the panel goes away (opt-out flip, stream
        // ends, or the page resolved to a VOD) and WE hid/collapsed native
        // chat, give it back.
        if (!showYtChat && frameEl && _hsHidNativeYt && frameEl.style.display === 'none') {
          frameEl.style.removeProperty('display')
          _hsHidNativeYt = false
        }
        if (!showYtChat && frameEl && _hsCollapsedNativeYt && frameEl.hasAttribute('collapsed')) {
          try {
            if (frameEl.style.display === 'none') frameEl.style.removeProperty('display')
            frameEl.querySelector('#show-hide-button button')?.click()
            _hsCollapsedNativeYt = false
          } catch (_) {}
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
      ;[250, 600, 1100, 2000, 3500].forEach((ms) => {
        cleanup.setTimeout(checkYtLive, ms)
      })
      return
    }
    // Popout chat has no video — don't mark as offline
    if (location.pathname.match(/^\/(popout|embed)\//)) return

    let wasOffline = null
    // Element caches: checkOffline fires on every player-region React flush
    // (rAF-coalesced) + the polls below; two full-document querySelectors per
    // call added up. Re-query only when the cached node left the DOM — same
    // semantics (a removed indicator/video re-queries and correctly reads
    // offline; a connected one means live either way). Per-mount scope, so
    // SPA nav resets both naturally.
    let _playerEl = null
    let _liveEl = null

    function checkOffline() {
      if (!_playerEl?.isConnected) _playerEl = document.querySelector('.channel-root__player')
      const playerOffline = _playerEl
        ? _playerEl.classList.contains('channel-root__player--offline')
        : !!document.querySelector('.channel-root__player--offline')
      if (_liveEl && !_liveEl.isConnected) _liveEl = null
      if (!playerOffline && !_liveEl) {
        _liveEl = document.querySelector(
          '[class*="stream-type-indicator"], [data-a-target="player-overlay-click-handler"] video, .video-player video',
        )
      }
      const isLive = !playerOffline && !!_liveEl
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

    // MutationObserver for instant transitions. Narrowed to the player region
    // (parent of .channel-root__player, so a wholesale player-node swap is
    // still a visible childList mutation) — observing the full channel-root
    // subtree meant record generation on every React flush anywhere on the
    // page (~2500 nodes) when only the player (~200) matters here. The 1s/5s
    // polls above remain the correctness backstop if the region itself is
    // replaced mid-view.
    const _playerForObs = document.querySelector('.channel-root__player')
    const root = _playerForObs?.parentElement || document.querySelector('[class*="channel-root"]')
    if (root) {
      // Coalesce to one check per frame — Twitch's React reconciler mutates this
      // subtree continuously; an unthrottled callback burns CPU on every flush.
      let offlineCheckQueued = false
      const observer = new MutationObserver(() => {
        if (offlineCheckQueued) return
        offlineCheckQueued = true
        cleanup.raf(() => {
          offlineCheckQueued = false
          checkOffline()
        })
      })
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
      cleanup.trackObserver(observer)
    }
  }

  // ============================================
  // MAIN INITIALIZATION
  // ============================================

  let mcInitialized = false
  // Re-arm the __live_yt_auto__ binding for the CURRENT yt video page.
  // Called from yt soft-nav (spa-nav.js), which unsubscribes the previous
  // video's binding on every navigation — init()'s auto-join sibling below
  // (~12240) only runs on full page load, so without this, SPA-navigating
  // into a live stream left the multichat dead until refresh. Video-page
  // subset only: the channel-mirror (explicit yt link) case stays init-time.
  function autoYtSubscribeForPage() {
    if (hostPlatform !== 'yt') return
    if (gateAtBoot('chat-youtube') === false) return
    const vid = getCurrentChannel()
    if (!vid) return
    if (!/\/watch|\/live\//.test(location.pathname + location.search)) return
    const autoYtUrl = `https://youtube.com/watch?v=${vid}`
    ytSubscribedUrls.set('__live_yt_auto__', autoYtUrl)
    ytChanLastSeen.set('__live_yt_auto__', Date.now())
    // Concrete on-page videoId — open the render gate now (same rationale as
    // the init-time sibling: the poller's 'connected' echo is missed on
    // already-polled popular streams).
    _autoYtVideoId = vid
    ytSubscribe('__live_yt_auto__', autoYtUrl, vid)
  }

  // The tab to activate on mount. When we're on an actual stream/channel watch
  // page, the "live" tab (the stream you're looking at) is what you want — NOT
  // a stale last-used channel tab. Restoring _savedActiveTab there is exactly
  // why heatsync-on-youtube read as "no chat": it dropped you on a saved
  // channel (nl_kripp) instead of the lofi stream on screen. Off a stream page
  // (directory / home / search), restore the saved tab as before.
  // MODULE scope — tryHookReact()'s mount passes call this too; defining it
  // inside init() made every twitch react-hook mount throw a ReferenceError
  // and strand fresh viewers on the empty saved tab.
  const bootActiveTab = () => {
    const path = location.pathname + location.search
    const onStreamPage =
      isYtPopout ||
      (hostPlatform === 'yt' && /\/watch|\/live\//.test(path)) ||
      (hostPlatform !== 'yt' && !isKick && !!document.querySelector('.channel-root, [class*="channel-root"]')) ||
      (isKick && !!(document.getElementById('channel-chatroom') || document.querySelector('[id*="chatroom"]')))
    // Force "live" (the on-screen stream) on a watch page ONLY for viewers with
    // no channel tabs of their own — that's the "youtube read as no-chat" fix
    // (a fresh viewer shouldn't land on an empty saved tab). A user who HAS
    // tabs keeps their last-active one instead of being yanked onto the current
    // page's stream: being on lofigirl's page shouldn't override your nl_kripp
    // tab and dump lofigirl's chat in. A popout is single-channel — always live.
    const hasChannelTabs = !!config.channels?.length
    // A saved tab that is now HIDDEN (or whose subsystem was switched off) is
    // not restorable — you land on a tab that isn't in the bar, so nothing
    // looks selected ("I'm on no tab") while the composer quietly points at
    // that invisible surface. loadActiveTab validates the id against
    // BUILTIN_TABS + channels but runs before hiddenTabs is known, and
    // applyHiddenTabs' own correction only fires if it runs AFTER this restore
    // — on a cold boot it doesn't.
    const restorable =
      _savedActiveTab &&
      !hiddenTabs.has(_savedActiveTab) &&
      !(_TAB_SUBSYSTEM[_savedActiveTab] && !isEnabled(_TAB_SUBSYSTEM[_savedActiveTab]))
    return isYtPopout || (onStreamPage && !hasChannelTabs) ? 'live' : restorable ? _savedActiveTab : 'live'
  }

  // PHASE -1 kill-switch aborts init before any panel/HsNotifs infra exists,
  // so they used to bail behind log() — a no-op at MC_DEBUG=false — leaving
  // an install at permanent zero UI with nothing telling the user why.
  // Self-contained: no dependency on anything init() would normally set up.
  function showKillSwitchBanner(reason, msg) {
    try {
      if (document.getElementById('hs-mc-killswitch-banner')) return
      const banner = document.createElement('div')
      banner.id = 'hs-mc-killswitch-banner'
      banner.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#ff8700;color:#000;' +
        'font:600 12px/1.4 monospace;padding:6px 10px;text-align:center;'
      banner.textContent = msg ? `heatsync: ${reason} — ${msg}` : `heatsync: ${reason}`
      ;(document.body || document.documentElement).appendChild(banner)
    } catch (_) {}
  }

  async function init() {
    // BG-created send-bridge tab (#hs-bridge on the live_chat url): stay
    // completely silent. Booting the multichat here rebound the single
    // __live_yt_auto__ WS slot to the bridge's videoId (killing the watch
    // tab's live feed on reconnect) and its popout overlay hid the native
    // chat — the tab BG activates for youtube sign-in showed no login UI.
    // youtube-content.js (the actual relay) runs regardless of this guard.
    if (hostPlatform === 'yt' && location.hash.includes('hs-bridge')) return
    let isPopout = false
    if (hostPlatform === 'yt') {
      // YouTube: persistent overlay across every URL — home, watch, search,
      // channel, /live, etc. — so the multichat panel survives SPA nav.
      // The destructive layout overrides (#secondary collapse, recommendeds
      // hidden) are gated separately on `:not(.hs-offline)` so non-live
      // pages keep YouTube's native layout intact.
      // A /live_chat top window is a pop-out → fill-window layout (same
      // hs-popout path twitch/kick use).
      isPopout = isYtPopout
    } else if (isKick) {
      // Kick: persistent overlay across every URL — channel, browse,
      // categories, search, following, settings — so the panel survives
      // SPA nav. body-mount fallback in getOrCreateHsContainer when
      // #channel-chatroom is absent.
      // /popout/<slug>/chat is a pop-out window — the url our own popout button
      // opens — and gets the same fill-window layout twitch and yt already get.
      // Without this the panel mounted at its docked 376px inside a ~400px
      // popout window, and the kick body-mount branch below reads hs-popout
      // expecting it to be set.
      isPopout = /^\/popout\/[a-zA-Z0-9_-]+\/chat/.test(location.pathname)
    } else {
      // Twitch: persistent overlay across every URL — directory, settings,
      // videos, etc. all keep the panel mounted. getOrCreateHsContainer
      // body-mounts when no .chat-shell exists; CSS squeezes twitch content.
      isPopout = !!location.pathname.match(/^\/(popout|embed)\/[a-zA-Z0-9_-]+\/chat/)
    }
    if (mcInitialized) return
    mcInitialized = true

    // ── PHASE -1: server kill-switch ──────────────────────────────────────
    // One round-trip to background for cached health. If the server flagged
    // a broken release, bail before painting anything. Default is fail-open
    // — background only stores a record after a successful schema-valid
    // fetch, so a never-reached server leaves us fully active.
    let _hsHealth = null
    try {
      const r = await new Promise((res) => {
        try {
          chrome.runtime.sendMessage({ type: 'get_health' }, (r) => {
            void chrome.runtime.lastError
            res(r)
          })
        } catch {
          res(null)
        }
      })
      _hsHealth = r?.health || null
    } catch {}
    window.__hsHealth = _hsHealth || {
      v: 1,
      kill: false,
      disabled: [],
      ext_min: '0.0.0',
      ext_hard_min: null,
      msg: null,
    }
    if (_hsHealth?.kill) {
      log('kill-switch active, aborting init')
      showKillSwitchBanner('disabled by heatsync (kill-switch active)', _hsHealth?.msg)
      return
    }
    if (Array.isArray(_hsHealth?.disabled) && _hsHealth.disabled.includes('multichat')) {
      log('multichat disabled by server health flag')
      showKillSwitchBanner('multichat disabled by heatsync', _hsHealth?.msg)
      return
    }
    const _curVer = chrome.runtime.getManifest?.().version || '0.0.0'
    if (_hsHealth?.ext_hard_min && _hsSemverLt(_curVer, _hsHealth.ext_hard_min)) {
      log('extension below ext_hard_min', _curVer, '<', _hsHealth.ext_hard_min)
      showKillSwitchBanner(`extension update required (v${_hsHealth.ext_hard_min}+)`, _hsHealth?.msg)
      return
    }
    if (_hsHealth?.ext_min && _hsSemverLt(_curVer, _hsHealth.ext_min)) {
      // Deferred emit — HsNotifs needs the overlay container before it can
      // mount. Fire after init completes so toast-stack geometry is ready.
      setTimeout(() => {
        try {
          HsNotifs.emit('hs-update-required', { current: _curVer, min: _hsHealth.ext_min, msg: _hsHealth.msg })
        } catch (_) {}
      }, 4000)
    }

    // ── PHASE 0: synchronous prep (no awaits) ─────────────────────────────
    // Inject CSS NOW so the panel paints with correct styles the moment it
    // mounts. injectStyles has zero settings deps — moving it before any
    // await shaves ~10-15ms off the cold visual path.
    injectStyles()
    // YouTube: pre-set hs-offline so the destructive layout overrides
    // (#secondary collapse, #primary fixed, recommendeds hidden) don't fire
    // on first paint for VOD viewers. checkYtLive() removes the class once
    // it detects a live chatframe; if it's actually a livestream, native
    // YT live chat is shown briefly until our override kicks in.
    // …except a /live_chat pop-out, which IS the live chat — never pre-hide it,
    // and except chat-on-all-pages installs (early-layout stamped
    // hs-yt-nonlive-chat at document_start) — pre-hiding there would undo the
    // boot state YT already measured its layout under, for checkYtLive to
    // flip it right back ~250ms later.
    if (hostPlatform === 'yt' && !isYtPopout && !document.body.classList.contains('hs-yt-nonlive-chat')) {
      document.body.classList.add('hs-offline')
    }
    detectOfflineState()
    if (isPopout) document.body.classList.add('hs-popout')
    setupScrollWheelVolume()
    currentUsername = getCurrentUsername()
    // Independent of whether native-tap starts below (subsystem could be
    // disabled) — early-layout.js can pre-arm hsSuppressNative purely from
    // last session's localStorage mirror, so the dead-man needs to watch
    // regardless of this session's gating.
    startNativeHiddenWatchdog()

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
    // Before loadConfig — it is the first thing that consults a subsystem gate.
    await snapshotGates()
    await loadConfig()
    if (!config.enabled) return
    // Lite / emotes-only mode is fully removed — overlay always boots.
    log('Initializing...')

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
      const bd = await new Promise((res) => {
        try {
          chrome.storage.local.get('blocked_users', (r) => res(r || {}))
        } catch {
          res({})
        }
      })
      if (Array.isArray(bd.blocked_users))
        for (const u of bd.blocked_users) {
          if (u) blockedUsers.add(String(u).toLowerCase())
        }
    } catch {}
    log('Username:', currentUsername)

    // ── PHASE 3: settings hydration + emote load (all in parallel) ────────
    // All load* funcs, blocked-emotes, and emotes share the cached ui_settings
    // or hit independent local keys; they can run concurrently.
    // Resilient init: each loader may fail OR stall without aborting the rest.
    // (Plain Promise.all let a single throwing/hanging settings-loader kill
    // everything after it — including badge loading.) Cap each at 5s + swallow
    // rejections so the panel always finishes booting.
    // Keep raw handles on the two blocked-emote-relevant loads (not just the
    // raced/timed-out copies below) — a cold service worker can outlast the 5s
    // cap, and the first render (persisted buffers, shortly after this phase)
    // would then bake blocked emotes' real images into m._renderedHtml with
    // nothing to ever repaint them. rebuildBlockedNames() runs inside both, so
    // whichever lands last leaves blockedEmoteNames correct.
    let _blockedHydrated = false
    const _blockedEmotesP = loadBlockedEmotes()
    const _emotesP = loadEmotes()
    Promise.all([_blockedEmotesP, _emotesP]).then(
      () => {
        _blockedHydrated = true
      },
      () => {
        _blockedHydrated = true
      },
    )
    await Promise.allSettled(
      [
        _uiPrime, // already in flight; just await here to ensure it landed
        loadActiveTab(),
        loadTabsPosition(),
        loadChatPosition(),
        loadLivePlatformMap(),
        loadAllSettings(),
        loadPlatformFilters(),
        _blockedEmotesP,
        _emotesP,
        loadSenderEmoteSets(),
        loadStaleEmotes(),
      ].map((p) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, 5000))])),
    )
    // Boot race: loadBlockedEmotes/loadEmotes timed out above (still pending)
    // — the imminent first render will paint with a stale/empty blocked set.
    // Attach a late repaint that fires whenever they actually land: invalidate
    // the frozen _renderedHtml for the (now-known) blocked names and repaint
    // via the same scrolled-up-safe path other blocked-state changes use.
    if (!_blockedHydrated) {
      Promise.all([_blockedEmotesP, _emotesP])
        .then(() => {
          if (!blockedEmoteNames.size) return
          if (typeof invalidateRenderedForEmotes === 'function') {
            invalidateRenderedForEmotes([...blockedEmoteNames])
          }
          if (!isScrolledUp && typeof renderMessages === 'function' && typeof currentTab !== 'undefined') {
            try {
              renderMessages(currentTab)
            } catch {}
          }
        })
        .catch(() => {})
    }
    // Fresh-install-only: hide feed/whispers/mentions/modlog until first login
    // (see applyFreshInstallHiddenTabs above). Must land before the tab bar's
    // first real paint, so it runs right after settings hydration.
    await applyFreshInstallHiddenTabs()
    // Then hand the feed tab back to installs stamped while it was on that
    // list — must also land before the tab bar's first paint.
    await unhideFeedOnce()
    // Init done — drop the cache so subsequent reads see fresh data.
    invalidateUiSettingsCache()
    // Freeze the subsystem gates for the rest of init — a mid-init storage
    // write can't half-apply a subsystem. Live reads still use isEnabled().

    setupEmoteTooltipHandlers()
    setupUserTooltipHandlers()
    setupLinkTooltipHandlers()
    if (gateAtBoot('profile-cards')) setupProfileCardHandlers()
    listenForSettingsChanges()

    // Request background to re-send channel emotes (may have been fetched
    // before we loaded). A cold/restarting service worker can answer this pull
    // before its channel_emotes_map restore (or the join-fetch) completes,
    // returning count:0 — a one-shot fire-and-forget then leaves per-channel
    // 7TV/FFZ/BTTV emotes AND emote tab-complete dead until a full page reload.
    // Mirror loadBulkBadges: retry-until-count>0 with backoff, and only AFTER
    // listenForSettingsChanges() registered the channel_emotes_update listener
    // (the BG re-broadcasts synchronously, so a not-yet-registered listener
    // would drop the payload).
    const loadChannelEmotes = (attempt = 0) => {
      safeSendMessage({ type: 'get_channel_emotes' })
        .then((resp) => {
          if (!resp?.count) {
            if (attempt < 8)
              cleanup.setTimeout(() => loadChannelEmotes(attempt + 1), Math.min(500 * (attempt + 1), 3000))
          }
        })
        .catch(() => {
          if (attempt < 8) cleanup.setTimeout(() => loadChannelEmotes(attempt + 1), Math.min(500 * (attempt + 1), 3000))
        })
    }
    loadChannelEmotes()

    // Request initial BTTV/FFZ/Chatterino badge maps from background.
    // A cold service worker can answer before its storage restore lands,
    // returning empty maps; cosmetics_update only re-broadcasts on a fresh
    // fetch, so a one-shot request that lands empty would leave the overlay
    // badge-less until the next ~24h refresh. Retry with backoff until the
    // maps come back non-empty (the background also pushes a warm-cache
    // cosmetics_update once restore completes — whichever wins, we recover).
    const loadBulkBadges = (attempt = 0) => {
      safeSendMessage({ type: 'get_bulk_badges' })
        .then((resp) => {
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
        })
        .catch(() => {
          if (attempt < 8) cleanup.setTimeout(() => loadBulkBadges(attempt + 1), Math.min(500 * (attempt + 1), 3000))
        })
    }
    if (gateAtBoot('cosmetics')) loadBulkBadges()

    // Load heatsync auth state
    loadHsAuth()

    // Probe bg for auth state so the login banner can show on tabs that opened
    // after the initial auth_changed broadcast already fired (cookies.onChanged
    // and the no_token boot signal are both one-shot).
    try {
      chrome.runtime.sendMessage({ type: 'get_auth_state' }, (resp) => {
        if (chrome.runtime.lastError || !resp) return
        try {
          showAuthLoginBanner(!!resp.loggedIn)
          // Covers a fresh install where the heatsync cookie was already valid
          // (auth_changed won't fire again — that's a one-shot cookie event).
          if (resp.loggedIn) revealFreshInstallTabsOnce()
        } catch {}
      })
    } catch {}

    // Listen for social tab events from background.
    //
    // Unconditional, and that is the point. This one listener carries the
    // site's feed pushes, every youtube message type, DMs, seen-state and
    // send-origin tagging — four different subsystems' worth. Any gate here
    // is wrong for three of them: `feed` alone killed youtube chat, and
    // `feed || chat-youtube` then stopped `chat-youtube` from turning youtube
    // chat off. Each family now checks its own switch inside the dispatcher
    // (social.js), which is the only place that can be right for all of them.
    listenForSocialEvents()

    // Load whisper conversations from storage
    if (gateAtBoot('whispers')) loadWhispers()

    // Seed cross-device unread state from server (mentions/whispers/home).
    // Independent of auth — anonymous users skip the network hit and use
    // local-only state. Awaits internally; doesn't block init.
    loadSeenState()
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

        // Split remote state: small sync-scope prefs merge into chrome.storage
        // .sync.ui_settings (below); large blocklist prefs that ride the server
        // channel (keywordHighlights/chatFilterRules) land in their
        // chrome.storage.local overflow keys instead — never chrome.storage.sync
        // (8KB ceiling). DEVICE_LOCAL_KEYS (platformFilters) are dropped — a
        // foreign device's per-tab layout would be meaningless here.
        const syncState = {}
        const localOverflow = {}
        for (const k in remote) {
          if (!Object.hasOwn(remote, k)) continue
          if (DEVICE_LOCAL_KEYS.has(k)) continue
          if (UI_SYNC_BLOCKLIST.has(k)) {
            const mirrorKey = OVERFLOW_MIRROR_KEYS[k]
            // string-only, mirroring splitIncomingUiState (background.js) — the
            // overflow bucket bypasses sanitizeUiSettings, so shape-check here
            if (mirrorKey && typeof remote[k] === 'string' && estimateSettingSize(remote[k]) <= LARGE_KEY_SYNC_MAX)
              localOverflow[mirrorKey] = remote[k]
          } else {
            syncState[k] = remote[k]
          }
        }

        if (Object.keys(syncState).length) {
          // writeUiSettings routes through the SW's serialized rmw chain, which
          // sanitizes the merged blob — `remote` is server-fanned state
          // (accumulated across every client/version that ever PATCHed this
          // account) and must NOT be trusted into the cross-device sync key raw.
          // Unsanitized, numeric-key/oversized/__proto__ garbage replicates to
          // every device and pushes the record past the 8KB quota, after which
          // all future pref writes silently fail.
          await writeUiSettings(syncState)
        }
        if (Object.keys(localOverflow).length) {
          invalidateUiOverflowCache()
          await chrome.storage.local.set(localOverflow)
        }
      } catch (e) {
        log('ui-state seed failed:', e?.message)
      }
    })()

    // ── PHASE 4: defer all network connect to post-paint ─────────────────
    // IRC/Kick socket open + N channel-join are 500ms-2s of network work
    // that doesn't need to block the first visible render. The panel can
    // mount, switch tabs, show settings, etc. while sockets warm up.
    // requestIdleCallback fires after paint; setTimeout fallback for older
    // browsers. New IRC()/KickChat() ctor is sync (no socket open) so the
    // refs `irc`/`kickChat` are available immediately for any sync caller.
    irc = new IRC()
    kickChat = new KickChat()
    // Restore persisted mentions/YT buffers + tab-seen state so first paint
    // already shows everything from before the reload. Awaited because
    // mentions tab on reload would otherwise paint empty for a beat.
    await restorePersistedBuffers()
    const startNetwork = () => {
      // Subsystem gates — a disabled platform feed never opens its socket
      // or joins channels (gating at the registration call = no orphans).
      const gTwitch = gateAtBoot('irc-twitch')
      const gKick = gateAtBoot('chat-kick')
      const gYt = gateAtBoot('chat-youtube')
      // irc.connect() is a documented no-op — the BG owns the twitch socket —
      // so this gate decides nothing. The real irc-twitch gate is in the IRC
      // class (listener registration + join), which is where it has to be:
      // gating a no-op is what made this switch turn nothing off.
      if (gTwitch) irc.connect()
      if (gKick) kickChat.connect()

      // Connect auth IRC eagerly so first send is instant (whispers no longer arrive over IRC)
      if (gTwitch && hostPlatform === 'twitch') {
        const token = getTwitchAuthToken()
        // Twitch-derived identity first (twilight localStorage / login cookie):
        // NICK must match the account behind the auth-token cookie. The
        // heatsync username is a fallback — for a kick-primary account it can
        // be a different name entirely, and a NICK/PASS mismatch fails login.
        const nick = getCurrentUsername() || currentUsername
        if (token && nick) {
          connectAuthIrc(token, nick).then((ok) => {
            if (ok === true) log('Auth IRC ready')
          })
          // Upgrade the BG reader connection to authed — twitch starves
          // anonymous readers (live messages trickle while history loads);
          // an authenticated reader receives normally.
          try {
            safeSendMessage({ type: 'bg_irc_auth', token, nick: nick.toLowerCase() }).catch(() => {})
          } catch (_) {}
        }
      }
      // Native-chat tap — current channel's live messages mined from the
      // rows twitch's own (unthrottled) delivery renders; id-deduped against
      // IRC. See native-tap.js for the why.
      if (gTwitch && hostPlatform === 'twitch') {
        try {
          startNativeTap(getCurrentChannel())
        } catch (_) {}
      }
      // Kick page-level chat tap — third transport line for the current page
      // channel, inert while the BG Pusher tap / server relay are delivering.
      // typeof-guarded: the module is bundled for the kick host only.
      //
      // gKick, matching the twitch tap two blocks up. The module gates itself on
      // its OWN toggle (kick-native-tap) but never checked whether kick chat is
      // enabled at all, so switching the chat-kick subsystem off skipped
      // kickChat.connect() and left this running — and because this tap is
      // designed to be inert only WHILE the relay delivers, turning kick off did
      // not merely leak, it woke the fallback up. A control that does not cover
      // what it claims to is worse than no control.
      if (gKick && hostPlatform === 'kick' && typeof initKickNativeTap === 'function') {
        try {
          initKickNativeTap()
        } catch (_) {}
      }
      // Auto-tabs: pull the current open-stream set once at boot — the bg
      // broadcast only fires on CHANGES, so a fresh tab would otherwise not
      // see streams that were already open before it loaded.
      try {
        safeSendMessage({ type: 'bg_get_open_channels' })
          .then((r) => {
            if (r?.channels) reconcileAutoTabs(r.channels)
          })
          .catch(() => {})
      } catch (_) {}

      // Twitch deprecated WHISPER over IRC in Feb 2023 — receive via EventSub instead.
      // Works on any host (the ESW socket is independent of the chat IRC).
      // Guarded: a sync throw here used to kill every init below it silently.
      try {
        if (gateAtBoot('whispers')) startEventSubWhispers()
      } catch (e) {
        log('whispers init failed:', e?.message)
      }

      // AutoMod hold-queue — works on any host (channel tabs, not the current
      // page, decide relevance). Registers unconditionally: isEnabled() is
      // checked at event/sweep time so toggling the subsystem live (no
      // reload) actually takes effect, unlike a boot-time gate here would.
      try {
        if (typeof __HS_DEV_BUILD__ !== 'undefined' && __HS_DEV_BUILD__)
          document.documentElement.dataset.hsAutomodInit = 'reached'
        if (typeof initAutomodQueue === 'function') initAutomodQueue()
        if (typeof __HS_DEV_BUILD__ !== 'undefined' && __HS_DEV_BUILD__)
          document.documentElement.dataset.hsAutomodInit = 'done'
      } catch (e) {
        log('automod init failed:', e?.message)
        try {
          document.documentElement.dataset.hsAutomodInit = `err:${e?.message || 'unknown'}`
        } catch (_) {}
      }

      // /live_chat pop-out: subscribe to THIS window's stream (?v=<id>) and open
      // the auto-live render gate immediately. The auto-join below is skipped on
      // a bare /live_chat path (getCurrentChannel() is empty), so the popout's
      // own videoId is wired here.
      if (isYtPopout && gYt) {
        const _popVid = new URLSearchParams(location.search).get('v') || ''
        if (/^[a-zA-Z0-9_-]{11}$/.test(_popVid)) {
          _autoYtVideoId = _popVid
          const _popUrl = `https://youtube.com/watch?v=${_popVid}`
          ytSubscribedUrls.set('__live_yt_auto__', _popUrl)
          ytChanLastSeen.set('__live_yt_auto__', Date.now())
          ytSubscribe('__live_yt_auto__', _popUrl)
        }
      }

      // Pop-out is a dedicated chat window — the composer must stay focused so
      // every keystroke types into chat instead of leaking to the host page
      // (where f/t/etc. fires browser find or a link-hint extension). Keeping it
      // focused is also what makes typing CONSISTENT: whether you just clicked a
      // message to read or the input already had focus, pressing a letter types.
      if (isYtPopout) {
        const focusComposer = () => {
          const inp = document.getElementById('hs-mc-input')
          if (inp && document.activeElement !== inp) inp.focus()
        }
        cleanup.setTimeout(focusComposer, 300)
        // Refocus when the window regains focus (alt-tab back) so it never
        // drifts to <body>.
        cleanup.addEventListener(window, 'focus', focusComposer)
        // Clicking the messages area to read/scroll blurs the composer to
        // <body> — refocus it after the click so the next letter still types.
        // Skip when the click was on an interactive control (username, link,
        // button, tab, the composer itself) or when the user is selecting text
        // to copy — those intentionally own focus / the selection.
        cleanup.addEventListener(
          document,
          'click',
          (e) => {
            const sel = window.getSelection?.()
            if (sel && String(sel).length > 0) return
            if (
              e.target.closest(
                'input, textarea, [contenteditable], button, a, select, [role="button"], .hs-mc-user, .hs-mc-tab, #hs-mc-emote-picker, #hs-mc-inputbar',
              )
            )
              return
            focusComposer()
          },
          { signal: mcSignal },
        )
      }

      // Auto-join current channel on all platforms (using overrides if set)
      const currentChannel = getCurrentChannel()
      if (currentChannel) {
        const platNames = getLivePlatformNames()
        // On yt pages the URL channel is a videoId or @handle — NEVER a
        // twitch/kick identity (getLivePlatformNames already refuses the
        // same-name guess there, see its sameNameOk note). Falling back to
        // currentChannel re-introduced exactly that: the raw videoId got
        // IRC-joined as a bogus twitch channel, BG registered it in the
        // open-channel set, and every multichat spawned a ghost
        // `auto_<videoId>` ephemeral tab — even for dead streams, even on
        // twitch pages (wollip's ghost-tab report). Explicit links only.
        const urlChFallback = hostPlatform === 'yt' ? '' : currentChannel
        const twitchCh = platNames.twitch || urlChFallback
        const kickCh = platNames.kick || urlChFallback
        // Only bind YouTube when we KNOW this channel's YT identity (an explicit
        // cross-platform link). Guessing youtube.com/@<twitchname>/live resolves
        // to whoever owns that handle — usually a DIFFERENT person — and bleeds a
        // stranger's live chat into this channel's tabs. No cross-platform
        // identity guessing.
        const ytUrl = platNames.youtube || null

        if (gTwitch && twitchCh) trackJoin('live', irc.join(twitchCh))
        if (gKick && kickCh) trackJoin('live', kickChat.join(kickCh))
        // Also join the URL channel name if different (for native platform
        // messages) — twitch/kick hosts only (urlChFallback is '' on yt).
        if (gTwitch && urlChFallback && twitchCh !== urlChFallback) trackJoin('live', irc.join(urlChFallback))
        if (gKick && urlChFallback && kickCh !== urlChFallback) trackJoin('live', kickChat.join(urlChFallback))

        // Subscribe YouTube. On a YT watch/live URL getCurrentChannel returns the
        // 11-char videoId — feeding that to `@${id}/live` produces a bogus
        // @<videoId>/live URL that the server can't resolve. Use the actual
        // /watch?v=<id> form whenever we're on a YT video page so the server has
        // something concrete to bind to. The previous `length > 20` check never
        // matched (videoIds are 11), so YT-tab subs were silently broken.
        const onYtVideoPage = hostPlatform === 'yt' && /\/watch|\/live\//.test(location.pathname + location.search)
        const autoYtUrl = onYtVideoPage ? `https://youtube.com/watch?v=${currentChannel}` : ytUrl
        if (gYt && autoYtUrl) {
          ytSubscribedUrls.set('__live_yt_auto__', autoYtUrl)
          ytChanLastSeen.set('__live_yt_auto__', Date.now())
          // Open the auto-live render gate (social.js `_autoYtVideoId`) NOW, from
          // the videoId we're on — don't wait for the youtube:status 'connected'
          // echo. That echo is missed whenever the server poller already exists
          // for a popular stream (it fires per-poller-start, and a busy stream is
          // already being polled), which left social.js:739 rejecting EVERY live
          // message and the "live" tab permanently empty. We only do this with a
          // concrete on-page videoId (currentChannel is the 11-char id on a
          // /watch|/live page), so the videoId-match cross-tab guard still holds;
          // the channel-mirror case (autoYtUrl = ytUrl, no id yet) still defers to
          // the status echo. spa-nav resets it to null on navigation.
          if (onYtVideoPage && currentChannel) _autoYtVideoId = currentChannel
          ytSubscribe('__live_yt_auto__', autoYtUrl)
          // Emote join stays separate here (the block is already gated on gYt):
          // its channelId hint is the CHANNEL url, not the video url we just
          // subscribed with, so it can't ride ytSubscribe's third argument.
          // Fetch this channel's 7TV/BTTV YouTube emote set. `channel` is the
          // same bare identifier used for the Twitch/Kick joins above so a
          // linked multi-platform channel's emotes merge into one bucket
          // (_buildChannelEmoteCache keys by bare channel name); `channelId` is
          // just a hint — background.js resolves the real UC... id itself
          // (from ytUrl if it carries one, else a handle/videoId lookup).
          safeSendMessage({
            type: 'join_channel',
            platform: 'youtube',
            channel: currentChannel,
            channelId: ytUrl || null,
          })
        } else if (gYt && hostPlatform !== 'yt') {
          // No stored/explicit yt link — zero-config path: resolve the
          // channel's linked youtube from its heatsync identity (social.js).
          autoResolveLiveYt()
        }
        log('Auto-joined current channel:', currentChannel, 'platforms:', twitchCh, kickCh, ytUrl || '(no yt link)')
      }

      // Ensure live channel override is also joined on all platforms
      const liveCh = getLiveChannel()
      if (liveCh && liveCh !== currentChannel) {
        if (gTwitch) irc?.join(liveCh)
        if (gKick) kickChat?.join(liveCh)
        log('Auto-joined live channel override:', liveCh)
      }

      // Serialize background-channel joins. Each irc.join awaits bg_irc_history
      // (up to 3000 msgs replay + buffer hydration); N parallel joins meant N
      // simultaneous renderMessages + DOM walks fighting paint at boot. Active
      // channel is already joined above — these are the bystander tabs.
      const bgChannels = config.channels.filter((ch) => {
        const tw = ch.twitch?.toLowerCase()
        const kk = ch.kick?.toLowerCase()
        return (tw && !irc.channels.has(tw)) || (kk && !kickChat.channels.has(kk))
      })
      hsSched
        .chunk(
          bgChannels,
          async (ch) => {
            const twitchName = ch.twitch
            const kickName = ch.kick
            if (gTwitch && twitchName) {
              // Don't gate the join_channel sendMessage on irc.join — irc.join
              // awaits bg_irc_history (up to 4s) and a stalled history fetch would
              // delay the BG channel-emotes fetch indefinitely. Kick off both
              // independently; emote fetch only needs the channel name.
              trackJoin(ch.id, irc.join(twitchName))
              safeSendMessage({ type: 'join_channel', platform: 'twitch', channel: twitchName })
            }
            if (gKick && kickName) {
              trackJoin(ch.id, kickChat.join(kickName))
            }
            // YouTube subscription is owned by loadConfig() (line ~6071) so this
            // loop only handles irc/kick — duplicate yt subs were idempotent but
            // noisy in the bg log.
          },
          { budgetMs: 6, respectScroll: false },
        )
        .catch(() => {})
    }
    // Schedule connect+joins for the next idle slice so paint goes first.
    // Falls back to setTimeout(0) where rIC is unavailable (older Chrome,
    // Safari ext). 200ms timeout cap ensures we don't sit idle forever
    // when the page is busy.
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(startNetwork, { timeout: 200 })
    } else {
      setTimeout(startNetwork, 0)
    }

    // After channel buffers have hydrated (IRC.loadHistory fires on each JOIN
    // and resolves async), repaint per-tab unread indicators against the
    // restored tabSeenAt timestamps. 2s lets storage reads settle without
    // blocking the panel; an extra pass at 8s catches the second-pass robotty
    // refetch that fills the reload-window gap.
    cleanup.setTimeout(() => {
      try {
        applyUnreadIndicatorsFromPersist()
      } catch {}
    }, 2000)
    cleanup.setTimeout(() => {
      try {
        applyUnreadIndicatorsFromPersist()
      } catch {}
    }, 8000)

    // Restore persisted stream events into buffers AFTER irc.join has populated
    // them. Running in parallel with startNetwork races: storage.get often
    // resolves before requestIdleCallback fires, so injectStreamEventsIntoBuffers
    // sees empty irc.channels and silently drops chat injection.
    cleanup.setTimeout(() => {
      loadStreamEvents()
        .then(() => {
          if (streamEventsLoaded) {
            const active = currentTab
            if (active === 'live' || config.channels.some((ch) => ch.id === active)) {
              renderMessages(active)
            }
          }
        })
        .catch((e) => log('[heatsync-mc] loadStreamEvents error:', e))
    }, 300)

    // Scan existing chat for mentions (before IRC catches new ones)
    cleanup.setTimeout(() => {
      if (isEnabled('mentions')) scanExistingMentions()
    }, 2000)

    // CLEARCHAT/CLEARMSG-style live DOM dimming for a mod-action notice —
    // shared by BOTH the twitch (irc) and kick (kickChat) message handlers, so
    // kick bans/timeouts/deletes reflect identically. Buffer entries are already
    // flagged `cleared` at the source (twitch IRC client / irc.js kick handler)
    // so future re-renders persist; this patches the currently-rendered rows.
    function _applyModNoticeDim(msg) {
      if (msg?.type !== 'notice') return
      const msgsEl = document.getElementById('hs-mc-messages')
      if (!msgsEl) return
      const samePlat = (row) => !(msg.platform && row.dataset.msgPlatform && msg.platform !== row.dataset.msgPlatform)
      if ((msg.noticeType === 'ban_success' || msg.noticeType === 'timeout_success') && msg.targetUser) {
        const targetLc = msg.targetUser.toLowerCase()
        for (const row of msgsEl.querySelectorAll('.hs-mc-msg[data-msg-user]')) {
          if ((row.dataset.msgUser || '').toLowerCase() !== targetLc || !samePlat(row)) continue
          markClearedRow(row, msg.banDuration ? `timed out (${msg.banDuration}s)` : 'banned')
        }
      } else if (msg.noticeType === 'delete_message_success' && msg.targetMsgId) {
        const safe = CSS.escape ? CSS.escape(msg.targetMsgId) : msg.targetMsgId.replace(/"/g, '\\"')
        const row = msgsEl.querySelector(`.hs-mc-msg[data-msg-id="${safe}"]`)
        if (row) {
          markClearedRow(row, 'deleted')
        }
      } else if (msg.noticeType === 'unban_success' && msg.targetUser) {
        // Lift a prior ban/timeout dim (not a delete) when the user is unbanned.
        const targetLc = msg.targetUser.toLowerCase()
        for (const row of msgsEl.querySelectorAll('.hs-mc-msg[data-msg-user]')) {
          if ((row.dataset.msgUser || '').toLowerCase() !== targetLc || !samePlat(row)) continue
          if (row.title === 'banned' || /timed out/.test(row.title || '')) {
            row.classList.remove('hs-mc-msg-cleared')
            row.removeAttribute('title')
          }
        }
      }
    }

    // Handle incoming IRC messages
    // Late reply context: the losing transport's copy of an already-rendered
    // message carried the reply-parent tags the winner lacked. Patch it in
    // rather than lose the "replying to" bar (and, because a native reply to
    // you counts as a mention, the red with it).
    irc.on('reply-ctx', (msg) => {
      try {
        // Patch the message wherever it lives, which is not always one place.
        // A drawn row can outlive — or simply not be — the object currently in
        // the buffer (see repaintForIdentityChange: "Drawn rows outlive their
        // buffer after an SPA nav — reach them through the _hsMsg back-ref or
        // they stay frozen forever"). Patching only the buffer left the row on
        // screen still holding the tap's context-free copy: no "replying to"
        // bar and, since a reply to you is a mention, no red — the exact
        // symptom this repair exists to prevent.
        const apply = (m) => {
          if (!m || m.id !== msg.id) return false
          if (m.replyTo?.user) return false // already had it — nothing to do
          m.replyTo = msg.replyTo
          // isMention(m) is recomputed per render and reads replyTo, so the
          // reply bar and the red both come back from this one assignment;
          // clearing the text cache lets the row rebuild.
          m._renderedHtml = null
          return true
        }

        let patched = false
        const buf = irc.getMessages?.(msg.channel)
        const iter = Array.isArray(buf) ? buf : typeof buf?.values === 'function' ? buf.values() : null
        if (iter) {
          for (const m of iter) {
            if (apply(m)) {
              patched = true
              break
            }
          }
        }
        const msgsEl = document.getElementById('hs-mc-messages')
        if (msgsEl) {
          for (const div of msgsEl.querySelectorAll('.hs-mc-msg')) {
            if (apply(div._hsMsg)) patched = true
          }
        }
        if (patched) scheduleRenderMessages()
      } catch (_) {}
    })

    irc.on('message', (msg) => {
      // Share-claim dedupe: a real resub/milestone USERNOTICE from Twitch
      // matches a pending Share click. Pre-injection → cancel synthetic.
      // Post-injection → hide synthetic so real takes its place. Single
      // celebration always.
      const _claimKind = _pendingShareClaim?.kind || 'resub'
      const _allowedMsgIds =
        _claimKind === 'watchstreak' ? ['watchstreak', 'viewermilestone'] : ['resub', 'sub', 'viewermilestone']
      if (
        _pendingShareClaim &&
        msg.type === 'usernotice' &&
        !msg.isSynthetic &&
        msg.channel?.toLowerCase() === _pendingShareClaim.channel &&
        msg.user?.toLowerCase() === _pendingShareClaim.userLc &&
        _allowedMsgIds.includes(msg.msgId)
      ) {
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
              if (m.id === claim.synthId) {
                m.hidden = true
                break
              }
            }
          }
          try {
            const msgsEl = document.getElementById('hs-mc-messages')
            const safe = CSS.escape ? CSS.escape(claim.synthId) : claim.synthId.replace(/"/g, '\\"')
            const row = msgsEl?.querySelector(`.hs-mc-msg[data-msg-id="${safe}"]`)
            if (row) row.remove()
          } catch (_) {}
        }
      }
      // Record every mod-action notice (self + observed, all channels) into the
      // mod-action log for the streamer/mod popout. No-op for non-mod notices.
      pushModLogEntry(modActionLog, modLogEntryFromNotice(msg))
      // CLEARCHAT/CLEARMSG → live-dim already-rendered DOM rows from the offender.
      // Buffer entries were already flagged with `cleared=true` inside the IRC client,
      // so future re-renders pick it up via the renderer; this just patches the visible DOM.
      _applyModNoticeDim(msg)
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
          const _twNick = typeof authState !== 'undefined' && authState?.nick ? authState.nick.toLowerCase() : ''
          // When the twitch identity IS known (auth-irc handshake), the sender
          // name is authoritative — a stranger repeating your text must not
          // drain the pending tracker (false confirm = a genuinely dropped
          // send never retries). Text-hit fallback only when no nick exists.
          const isOwnUser = _twNick
            ? u === _twNick
            : (currentUsername && u === currentUsername.toLowerCase()) ||
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
      // peekSentHost only matches ext-input sends, so a hit IS the ownership
      // signal — and it works cross-origin (youtube.com/kick.com popout)
      // where currentUsername is null and a name guard would skip the retag,
      // leaving the yt-popout's own echo painted [T]. But when the twitch
      // nick IS known, a mismatched sender is definitively someone else —
      // without that gate any stranger repeating your recent text got their
      // message retagged to your send host.
      {
        const _twNickRt = typeof authState !== 'undefined' && authState?.nick ? authState.nick.toLowerCase() : ''
        const notOwn = _twNickRt && msg.user && msg.user.toLowerCase() !== _twNickRt
        const sentHost = notOwn ? null : peekSentHost(msg.text)
        if (sentHost) {
          // IRC origin — badges are Twitch namespace regardless of [K] retag.
          msg.badgePlatform = 'twitch'
          msg.platform = sentHost === 'yt' ? 'youtube' : sentHost
          // Restore the reply bar on our own echo when the winning transport
          // dropped the reply-parent tags (see rememberOwnReply). sentHost hit
          // already proves this is our ext send, so no stranger can be stamped.
          if (typeof restoreOwnReplyBar === 'function') restoreOwnReplyBar(msg)
        }
      }
      // Automod + filter rules: drop messages matching filter. Own msgs exempt.
      const _frOwnTw = msg.user?.toLowerCase() === currentUsername?.toLowerCase()
      let _frTw = null
      if (!_frOwnTw) {
        // Lazy: automod first (cheap), then filter rules only if it survives —
        // preserves the original short-circuit so automod'd messages skip the eval.
        if (shouldAutomod(msg.text)) return
        _frTw = evaluateFilterRules(msg, getChannelLookup().twitch.get(msg.channel)?.id)
        if (_frTw.hide) return
      }
      // Highlight-rule audio cue — once, on live arrival (this path is live-only;
      // history replay doesn't reach here). Own/hidden already returned above.
      if (_frTw?.sound && typeof playFilterRuleSound === 'function') playFilterRuleSound(_frTw.sound)
      const isMent = isMention(msg)
      bumpStreamStats(msg.channel, msg, isMent)
      if (isMent) {
        mentionsBuffer.push(msg)
        if (mentionsBuffer.length > MAX_BUFFER + 50) mentionsBuffer.splice(0, mentionsBuffer.length - MAX_BUFFER)
        persistMentions()
        notifyMention(msg)
        noteSeenEvent('mentions', msg.time || Date.now())

        if (currentTab === 'mentions') {
          bumpSeen('mentions')
          if (!appendMessage(msg, 'mentions')) renderMessages('mentions')
        } else {
          updateTabIndicator('mentions')
        }
      }

      // Channel tab routing
      const chTabId = getChannelLookup().twitch.get(msg.channel)
      const tabId = chTabId?.id
      // Count before the branch: heat is about the channel, so it has to count
      // the tab you're looking at too — updateTabIndicator below never fires
      // for the active tab.
      if (tabId) {
        bumpTabActivity(tabId, currentTab === tabId)
        refreshTabCounter(tabId)
      }
      if (tabId && currentTab === tabId) {
        if (!appendMessage(msg, tabId)) renderMessages(tabId)
      } else if (tabId) {
        updateTabIndicator(tabId)
        if (isMent) updateTabMentionIndicator(tabId)
      }

      // Live tab: show if this channel matches live OR is paired via config
      if (isLiveChannelMessage(msg)) {
        if (currentTab === 'live') {
          if (!appendMessage(msg, 'live')) renderMessages('live')
        } else {
          updateTabIndicator('live')
          if (isMent) updateTabMentionIndicator('live')
        }
      }
    })

    // Handle incoming Kick messages
    kickChat.on('message', (msg) => {
      // Record Kick mod-action notices into the mod-action log (no-op otherwise).
      pushModLogEntry(modActionLog, modLogEntryFromNotice(msg))
      // Reflect kick ban/timeout/delete/unban notices in the live DOM (same
      // shared path twitch uses) — this handler, not irc.on('message'), is where
      // kick notices land.
      _applyModNoticeDim(msg)
      // Lazy-resolve username → 7TV cosmetics + twitchId. First sighting per
      // session triggers one /users/kick/{name} fetch; result is cached and
      // backfilled into the rendered DOM so paints/badges paint in place.
      // NOT gated on !msg.userId: pusher/relay kick messages always carry the
      // numeric KICK id now, and that gate starved this pipeline entirely
      // (no kick avatars/paints/linked-twitch cosmetics). Dedup lives inside
      // queueKickNameToCosmetics (kickNameResolved/pending).
      if (msg.user) queueKickNameToCosmetics(msg.user)
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
      // which already renders as [K]. Gated on peekSentHost alone — same
      // cross-origin-null currentUsername reasoning as the IRC handler.
      {
        const sentHost = peekSentHost(msg.text)
        if (sentHost) {
          // Kick origin — badges look up in kickBadgeUrls.
          msg.badgePlatform = 'kick'
          msg.platform = sentHost === 'yt' ? 'youtube' : sentHost
          // Kick's echo of our own send carries no reply payload, so the bar
          // only exists if we put it back. Same ownership proof as twitch.
          if (typeof restoreOwnReplyBar === 'function') restoreOwnReplyBar(msg)
        }
      }
      const _frOwnKi = msg.user?.toLowerCase() === currentUsername?.toLowerCase()
      let _frKi = null
      if (!_frOwnKi) {
        if (shouldAutomod(msg.text)) return
        _frKi = evaluateFilterRules(msg, getChannelLookup().kick.get(msg.channel)?.id)
        if (_frKi.hide) return
      }
      // Highlight-rule audio cue — once, on live kick arrival.
      if (_frKi?.sound && typeof playFilterRuleSound === 'function') playFilterRuleSound(_frKi.sound)
      const isMent = isMention(msg)
      bumpStreamStats(msg.channel, msg, isMent)
      if (isMent) {
        mentionsBuffer.push(msg)
        if (mentionsBuffer.length > MAX_BUFFER + 50) mentionsBuffer.splice(0, mentionsBuffer.length - MAX_BUFFER)
        persistMentions()
        notifyMention(msg)
        noteSeenEvent('mentions', msg.time || Date.now())

        if (currentTab === 'mentions') {
          bumpSeen('mentions')
          if (!appendMessage(msg, 'mentions')) renderMessages('mentions')
        } else {
          updateTabIndicator('mentions')
        }
      }

      // Channel tab routing — find config entry where ch.kick matches
      const chConfig = getChannelLookup().kick.get(msg.channel)
      const tabId = chConfig?.id
      // Count before the branch — see the twitch handler above.
      if (tabId) {
        bumpTabActivity(tabId, currentTab === tabId)
        refreshTabCounter(tabId)
      }
      if (tabId && currentTab === tabId) {
        if (!appendMessage(msg, tabId)) renderMessages(tabId)
      } else if (tabId) {
        updateTabIndicator(tabId)
        if (isMent) updateTabMentionIndicator(tabId)
      }

      // Live tab: show if this channel matches live OR is paired via config
      if (isLiveChannelMessage(msg)) {
        if (currentTab === 'live') {
          if (!appendMessage(msg, 'live')) renderMessages('live')
        } else {
          updateTabIndicator('live')
          if (isMent) updateTabMentionIndicator('live')
        }
      }
    })

    // Global dedup for stream events — prevents dupes from multiple sources
    // (Twitch EventSub + Kick webhook + follow poll can all fire for the same event)
    if (!window._hsStreamEventDedup) window._hsStreamEventDedup = new Map()
    const streamEventDedup = window._hsStreamEventDedup

    // Handle stream events (game switch, online/offline) from HeatSync WS
    if (!_onceGuardsMain.streamEventListener) {
      _onceGuardsMain.streamEventListener = true
      cleanup.addListener(chrome.runtime?.onMessage, (msg) => {
        if (msg.type !== 'stream_event') return
        const channel = msg.channel?.toLowerCase()
        if (!channel) return

        // Build inline notification
        let text = '',
          eventClass = ''
        if (msg.eventType === 'stream:update' && msg.game && msg.prevGame !== msg.game) {
          if (!hermesToggles?.gameSwitch) return
          text = msg.prevGame
            ? `[${channel}] \u25C6 switched to ${msg.game}`
            : `[${channel}] \u25C6 now playing ${msg.game}`
          eventClass = 'event-update'
        } else if (msg.eventType === 'stream:online') {
          try {
            streamStats.delete((channel || '').toLowerCase())
          } catch (_) {}
          if (!hermesToggles?.online) return
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
          if (sessionWentLiveSeen.has(channel)) return
          const _alreadyLive = isChannelLive(channel)
          const _inGrace = Date.now() - mcStartedAt < 90000
          sessionWentLiveSeen.add(channel)
          if (_alreadyLive || _inGrace) return
          text = msg.game ? `[${channel}] \u25C6 went live \u2014 ${msg.game}` : `[${channel}] \u25C6 went live`
          eventClass = 'event-online'
        } else if (msg.eventType === 'stream:offline') {
          sessionWentLiveSeen.delete(channel) // genuine re-go-live can resurface
          try {
            renderStreamSummary(channel)
          } catch (_) {}
          if (!hermesToggles?.offline) return
          text = `[${channel}] \u25C6 went offline`
          eventClass = 'event-offline'
        } else if (msg.eventType === 'stream:redeem') {
          if (!hermesToggles?.redeem) return
          text = `\u25C6 redeemed "${String(msg.title ?? '')}"`
          if (msg.cost) text += ` (${msg.cost})`
          eventClass = 'event-redeem'
        } else if (msg.eventType === 'stream:raid') {
          if (!hermesToggles?.raid) return
          text = `[${channel}] \u25C6 raided ${String(msg.target ?? '')} with ${msg.viewers || 0} viewers`
          eventClass = 'event-raid'
        } else if (msg.eventType === 'stream:hype-start') {
          if (!hermesToggles?.hype) return
          text = `[${channel}] \u25C6 hype train started`
          eventClass = 'event-hype'
        } else if (msg.eventType === 'stream:hype-end') {
          if (!hermesToggles?.hype) return
          text = `[${channel}] \u25C6 hype train ended at level ${msg.level || 0}`
          eventClass = 'event-hype'
        } else if (msg.eventType === 'stream:sub-gift') {
          if (!hermesToggles?.sub) return
          text = `[${channel}] \u25C6 ${String(msg.user ?? '')} gifted ${msg.count || 0} subs`
          eventClass = 'event-sub'
        }
        if (!text) return

        // Dedup: skip if same event was shown in last 60s. Key by channel too —
        // redeem text carries no channel, so a global text key would drop an
        // identical reward redeemed in a different channel as a false duplicate.
        const now = Date.now()
        const dedupKey = `${channel} ${text}`
        if (streamEventDedup.has(dedupKey) && now - streamEventDedup.get(dedupKey) < 60000) return
        streamEventDedup.set(dedupKey, now)
        // Prune old entries
        if (streamEventDedup.size > 100) {
          for (const [k, t] of streamEventDedup) {
            if (now - t > 60000) streamEventDedup.delete(k)
          }
        }

        log('[Stream]', channel, text)
        notifyStreamEvent(channel, msg.eventType, msg.game, msg.platform)
        const actor = msg.eventType === 'stream:redeem' ? msg.user : null
        const evt = { type: 'stream-event', eventClass, text, channel, actor, time: Date.now() }

        // Push into the live channel buffer (dedup by text to prevent doubles on reload).
        // Gate on isLiveChannelMessage: without it, a redeem/raid from ANY other
        // subscribed channel lands in the live buffer — and since redeem text has no
        // [channel] prefix, it reads like it happened on the channel you're watching.
        const liveChannel = getLiveChannel()
        const liveBuffer =
          liveChannel && isLiveChannelMessage({ channel })
            ? irc?.channels?.get(liveChannel) || kickChat?.channels?.get(liveChannel)
            : null
        if (liveBuffer) {
          const existing = liveBuffer.getAll()
          if (!existing.some((m) => m.type === 'stream-event' && m.text === evt.text)) {
            liveBuffer.push(evt)
            saveStreamEvent(evt)
          }
        }

        // Also push into the matching channel buffer if different from live
        if (channel !== liveChannel) {
          const chBuffer = irc?.channels?.get(channel) || kickChat?.channels?.get(channel)
          if (chBuffer) {
            const existing = chBuffer.getAll()
            if (!existing.some((m) => m.type === 'stream-event' && m.text === evt.text)) {
              chBuffer.push(evt)
              if (!liveBuffer) saveStreamEvent(evt)
            }
          }
        }
        pushActivityEvent(evt)

        // Yellow tab highlight only for game changes, and only when not viewing that channel
        // (live tab and its matching channel tab are equivalent — viewing either counts)
        if (msg.eventType === 'stream:update') {
          const viewingChannel =
            currentTab === 'live' ||
            config.channels.some((ch) => {
              const tw = ch.twitch?.toLowerCase()
              const ki = ch.kick?.toLowerCase()
              return currentTab === ch.id && (tw === channel || ki === channel)
            })
          if (!viewingChannel) {
            // Only yellow the live tab if this event is for the live channel
            const isLiveEvent = isLiveChannelMessage({ channel })
            if (isLiveEvent) {
              const liveTab = tabBarElement?.querySelector('[data-tab="live"]')
              if (liveTab) liveTab.classList.add('has-stream-event')
            }
            // Yellow the matching channel tab
            for (const ch of config.channels) {
              const twName = ch.twitch
              const kickName = ch.kick
              const tabId = ch.id
              if ((twName === channel || kickName === channel) && currentTab !== tabId) {
                const tab = tabBarElement?.querySelector(`[data-tab="${tabId}"]`)
                if (tab) tab.classList.add('has-stream-event')
              }
            }
          }
        }

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
            const ki = tabCh.kick?.toLowerCase()
            if (tw === channel || ki === channel) {
              if (!appendMessage(evt, activeTab)) renderMessages(activeTab)
            }
          }
        }
      })
    }

    // Handle Hermes events (raids, hype trains, redeems, sub gifts) from MAIN world
    window.addEventListener(
      'message',
      (e) => {
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
          text = `[${channel}] \u25C6 raided ${String(data.target ?? '')} with ${Number(data.viewers) || 0} viewers`
        } else if (eventType === 'hype-train-start') {
          toggleKey = 'hype'
          eventClass = 'event-hype'
          text = `[${channel}] \u25C6 hype train started`
          if (typeof onHypeTrainStart === 'function') onHypeTrainStart(data.level)
        } else if (eventType === 'hype-train-end') {
          toggleKey = 'hype'
          eventClass = 'event-hype'
          text = `[${channel}] \u25C6 hype train ended at level ${Number(data.level) || 0}`
          if (typeof onHypeTrainEnd === 'function') onHypeTrainEnd()
        } else if (eventType === 'sub-gift') {
          toggleKey = 'sub'
          eventClass = 'event-sub'
          text = `[${channel}] \u25C6 ${t('mc_irc_gift_subs', [String(data.user ?? ''), String(Number(data.count) || 0), channel])}`
        } else if (eventType === 'redeem') {
          toggleKey = 'redeem'
          eventClass = 'event-redeem'
          text = `\u25C6 redeemed "${String(data.title ?? '')}"`
          if (data.rewardId) {
            redeemTitleMap.set(data.rewardId, { title: data.title, cost: data.cost })
            if (redeemTitleMap.size > 200) redeemTitleMap.delete(redeemTitleMap.keys().next().value)
          }
        } else if (eventType === 'pin' || eventType === 'unpin') {
          // pinned-chat pubsub — was tapped but dropped on the floor. Render as
          // a gold notice line through the usernotice path (pin = a mod act).
          // early-inject-main.js forwards { message: <text string>, sender, id }
          const pinText = String(typeof data?.message === 'string' ? data.message : (data?.text ?? '')).slice(0, 200)
          const pinBy = String(data?.sender ?? '')
          try {
            irc?._handleMsg?.({
              type: 'notice',
              noticeType: 'pin',
              systemMsg:
                eventType === 'pin' ? `pinned${pinBy ? ` ${pinBy}:` : ':'} ${pinText}`.trim() : 'message unpinned',
              channel,
              time: Date.now(),
              isSynthetic: true,
              id: `hs-pin-${channel}-${eventType}-${Date.now()}`,
            })
          } catch (_) {}
          return
        } else if (eventType === 'prediction-start') {
          toggleKey = 'pred'
          eventClass = 'event-pred'
          const title = data?.title ? ` — ${String(data.title)}` : ''
          text = `[${channel}] ◆ new prediction up${title}`
        } else if (eventType === 'poll-start') {
          toggleKey = 'poll'
          eventClass = 'event-poll'
          const title = data?.title ? ` — ${String(data.title)}` : ''
          text = `[${channel}] ◆ new poll up${title}`
        } else return

        if (!hermesToggles[toggleKey]) return

        const actor = eventType === 'redeem' ? data.user : null
        const evt = { type: 'stream-event', eventClass, text, channel, actor, time: Date.now() }

        // Push into relevant buffers — only the channel the event belongs to
        const liveChannel = getLiveChannel()
        const chBuffer = irc?.channels?.get(channel)
        if (chBuffer) {
          const existing = chBuffer.getAll()
          if (!existing.some((m) => m.type === 'stream-event' && m.text === evt.text)) {
            chBuffer.push(evt)
            saveStreamEvent(evt)
          }
        }
        // Also push into live buffer if this event's channel IS the live channel
        if (channel === liveChannel) {
          const liveBuffer = irc?.channels?.get(liveChannel)
          if (liveBuffer && liveBuffer !== chBuffer) {
            const existing = liveBuffer.getAll()
            if (!existing.some((m) => m.type === 'stream-event' && m.text === evt.text)) {
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
            const ki = tabCh.kick?.toLowerCase()
            if (tw === channel || ki === channel) {
              if (!appendMessage(evt, activeTab)) renderMessages(activeTab)
            }
          }
        }
      },
      { signal: mcSignal },
    )

    // Handle follow-driven stream events (from followed channels not currently viewed)
    if (!_onceGuardsMain.followStreamEventListener) {
      _onceGuardsMain.followStreamEventListener = true
      cleanup.addListener(chrome.runtime?.onMessage, (msg) => {
        if (msg.type !== 'follow_stream_event') return
        const channel = msg.channel?.toLowerCase()
        if (!channel) return

        // Skip channels already in config — they get stream_event, avoid duplicates
        if (
          config.channels.some((ch) => {
            const id = ch.id?.toLowerCase()
            const tw = ch.twitch?.toLowerCase()
            return id === channel || tw === channel
          })
        )
          return

        // Build inline notification
        let text = '',
          eventClass = ''
        if (msg.eventType === 'stream:update' && msg.game && msg.prevGame !== msg.game) {
          if (!hermesToggles?.gameSwitch) return
          text = msg.prevGame
            ? `[${channel}] \u25C6 switched to ${msg.game}`
            : `[${channel}] \u25C6 now playing ${msg.game}`
          eventClass = 'event-follow event-update'
        } else if (msg.eventType === 'stream:online') {
          if (!hermesToggles?.online) return
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
          if (sessionWentLiveSeen.has(channel)) return
          const _alreadyLive = liveChannelSet?.has(channel) || _swLiveSet?.has(channel)
          const _inGrace = Date.now() - mcStartedAt < 90000
          sessionWentLiveSeen.add(channel)
          if (_alreadyLive || _inGrace) return
          text = msg.game ? `[${channel}] \u25C6 went live \u2014 ${msg.game}` : `[${channel}] \u25C6 went live`
          eventClass = 'event-follow event-online'
        } else if (msg.eventType === 'stream:offline') {
          sessionWentLiveSeen.delete(channel) // genuine re-go-live can resurface
          if (!hermesToggles?.offline) return
          text = `[${channel}] \u25C6 went offline`
          eventClass = 'event-follow event-offline'
        }
        if (!text) return

        // Dedup: skip if same text was shown in last 60s (same dedup map as stream_event)
        const now = Date.now()
        if (streamEventDedup.has(text) && now - streamEventDedup.get(text) < 60000) return
        streamEventDedup.set(text, now)

        log('[FollowStream]', channel, text)
        notifyStreamEvent(channel, msg.eventType, msg.game, msg.platform)
        const evt = { type: 'stream-event', eventClass, text, channel, time: Date.now(), color: msg.color || '' }

        // Push into the live channel buffer (dedup by text)
        const liveChannel = getLiveChannel()
        const liveBuffer = liveChannel ? irc?.channels?.get(liveChannel) : null
        if (liveBuffer) {
          const existing = liveBuffer.getAll()
          if (!existing.some((m) => m.type === 'stream-event' && m.text === evt.text)) {
            liveBuffer.push(evt)
            saveStreamEvent(evt)
          }
        }

        // Also push into matching channel buffer if different from live
        if (channel !== liveChannel) {
          const chBuffer = irc?.channels?.get(channel)
          if (chBuffer) {
            const existing = chBuffer.getAll()
            if (!existing.some((m) => m.type === 'stream-event' && m.text === evt.text)) {
              chBuffer.push(evt)
              if (!liveBuffer) saveStreamEvent(evt)
            }
          }
        }
        pushActivityEvent(evt)

        // Yellow tab highlight only for game changes on the live channel, only when not viewing live
        if (msg.eventType === 'stream:update' && currentTab !== 'live' && isLiveChannelMessage({ channel })) {
          const tab = tabBarElement?.querySelector('[data-tab="live"]')
          if (tab) tab.classList.add('has-stream-event')
        }

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
            const ki = tabCh.kick?.toLowerCase()
            if (tw === channel || ki === channel) {
              if (!appendMessage(evt, activeTab)) renderMessages(activeTab)
            }
          }
        }
      })
    }

    // Handle color map from server (for persisted stream event history)
    if (!_onceGuardsMain.followColorsListener) {
      _onceGuardsMain.followColorsListener = true
      cleanup.addListener(chrome.runtime?.onMessage, (msg) => {
        if (msg.type !== 'follow_colors') return
        processFollowColors(msg.colors)
      })
    }

    // Process follow history events (shared by listener + on-demand request)
    function processFollowHistory(events) {
      if (!Array.isArray(events) || events.length === 0) return

      const builtEvents = []
      const now = Date.now()
      for (const e of events) {
        const channel = e.channel?.toLowerCase()
        if (!channel) continue

        // Skip channels already in config — they get stream_event directly
        if (
          config.channels.some((ch) => {
            const id = ch.id?.toLowerCase()
            const tw = ch.twitch?.toLowerCase()
            return id === channel || tw === channel
          })
        )
          continue

        let text = '',
          eventClass = ''
        if (e.type === 'follow:stream:update' && e.game) {
          if (!hermesToggles?.gameSwitch) continue
          text = e.prevGame ? `[${channel}] \u25C6 switched to ${e.game}` : `[${channel}] \u25C6 now playing ${e.game}`
          eventClass = 'event-follow event-update'
        } else if (e.type === 'follow:stream:online') {
          if (!hermesToggles?.online) continue
          text = e.game ? `[${channel}] \u25C6 went live \u2014 ${e.game}` : `[${channel}] \u25C6 went live`
          eventClass = 'event-follow event-online'
        } else if (e.type === 'follow:stream:offline') {
          if (!hermesToggles?.offline) continue
          text = `[${channel}] \u25C6 went offline`
          eventClass = 'event-follow event-offline'
        }
        if (!text) continue

        // Dedup against realtime events (same map as stream_event / follow_stream_event)
        if (streamEventDedup.has(text) && now - streamEventDedup.get(text) < 60000) continue
        streamEventDedup.set(text, now)

        const evt = { type: 'stream-event', eventClass, text, channel, time: e.time, color: e.color || '' }
        builtEvents.push(evt)
      }

      const added = injectStreamEventsIntoBuffers(builtEvents, true)
      if (builtEvents.length > 0) saveStreamEventsBatch(builtEvents)

      if (added > 0) {
        log('[FollowHistory]', added, 'events loaded')
        const active = currentTab
        if (active === 'live' || config.channels.some((ch) => ch.id === active)) {
          renderMessages(active)
        }
      }
    }

    // Process follow colors (shared by listener + on-demand request)
    function processFollowColors(colors) {
      if (!colors || typeof colors !== 'object') return
      if (streamColorMap.size > 500) streamColorMap.clear()
      for (const [login, color] of Object.entries(colors)) {
        if (color) streamColorMap.set(login.toLowerCase(), color)
      }
      log('[FollowColors]', streamColorMap.size, 'colors received')
      const active = currentTab
      if (active === 'live' || config.channels.some((ch) => ch.id === active)) {
        renderMessages(active)
      }
    }

    // Handle real-time follow_history from background broadcast
    if (!_onceGuardsMain.followHistoryListener) {
      _onceGuardsMain.followHistoryListener = true
      cleanup.addListener(chrome.runtime?.onMessage, (msg) => {
        if (msg.type !== 'follow_history') return
        processFollowHistory(msg.events)
      })
    }

    // Request cached follow history from background (handles race condition on load)
    safeSendMessage({ type: 'get_follow_history' })
      .then((resp) => {
        if (resp?.colors) processFollowColors(resp.colors)
        if (resp?.history) processFollowHistory(resp.history)
      })
      .catch(() => {})

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
        const url =
          ytSubscribedUrls.get(channelId) ||
          youtubeLinks.get(channelId)?.url ||
          (() => {
            const c = getChannelById(channelId)
            return c?.youtube || null
          })()
        if (!url) continue
        const attempts = ytChanRejoinAttempts.get(channelId) || 0
        const silenceS = Math.round((now - last) / 1000)
        if (attempts === 0) {
          log('YT', channelId, 'silent', silenceS, 's — re-subscribing')
          ytSubscribe(channelId, url)
        } else if (attempts === 1) {
          log('YT', channelId, 'still silent', silenceS, 's — unsubscribe + subscribe')
          chrome.runtime.sendMessage({ type: 'youtube_ws_unsubscribe', channelId }).catch(() => {})
          ytSubscribe(channelId, url)
        } else {
          log('YT', channelId, 'unresponsive', silenceS, 's after', attempts, '— BG WS force-reconnect')
          chrome.runtime
            .sendMessage({ type: 'ws_force_reconnect', source: 'yt_watchdog', channel: channelId })
            .catch(() => {})
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
        const doReload = () => {
          try {
            location.reload()
          } catch (_) {}
        }
        if (document.visibilityState === 'visible') {
          setTimeout(doReload, 1000 + Math.random() * 4000)
        } else {
          // Not visibilitychange alone — popout windows can miss the
          // hidden→visible flip (wayland/occlusion tracking) and then a
          // torn-down tab stays frozen forever. focus/pageshow are the escape
          // hatches; hasFocus() counts as proof-of-visible in case the
          // visibility state itself is stuck at 'hidden'.
          const wake = () => {
            if (document.visibilityState !== 'visible' && !document.hasFocus()) return
            document.removeEventListener('visibilitychange', wake)
            window.removeEventListener('focus', wake)
            window.removeEventListener('pageshow', wake)
            setTimeout(doReload, 500 + Math.random() * 2000)
          }
          document.addEventListener('visibilitychange', wake)
          window.addEventListener('focus', wake)
          window.addEventListener('pageshow', wake)
        }
      }
      try {
        if (!chrome.runtime?.id) throw new Error('dead')
        chrome.runtime.sendMessage({ type: 'ping' }).catch(() => {
          log('Background unreachable, deferring reload to visibility...')
          scheduleReload()
        })
      } catch {
        log('Extension context invalidated, deferring reload to visibility...')
        scheduleReload()
      }
    }, 30000)

    // 2. Reconnect auth IRC on tab focus (for sending messages)
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState !== 'visible') return
        if (authState.ws && authState.ws.readyState === WebSocket.OPEN) return
        // Auth IRC is dead — reconnect if we have credentials
        const token = getTwitchAuthToken()
        const nick = currentUsername || getCurrentUsername()
        if (!isEnabled('irc-twitch')) return
        if (token && nick && !authState.connecting) {
          log('Tab visible, auth IRC dead — reconnecting')
          const prev = [...authState.joined]
          connectAuthIrc(token, nick).then((ok) => {
            if (ok === true) {
              for (const ch of prev) joinChannel(ch)
              drainSendQueue()
            }
          })
        }
      },
      { signal: mcSignal },
    )

    // 3. Reconnect Kick chat on tab focus
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState !== 'visible') return
        if (!isEnabled('chat-kick')) return
        if (kickChat && (!kickChat.ws || kickChat.ws.readyState !== WebSocket.OPEN)) {
          log('Tab visible, Kick chat dead — reconnecting')
          kickChat.connect()
        }
      },
      { signal: mcSignal },
    )

    // 4. Reconnect EventSub whispers on tab focus
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState !== 'visible') return
        if (!isEnabled('whispers')) return
        reconnectEventSubIfDead()
      },
      { signal: mcSignal },
    )

    // 5. Re-poll live status on tab focus — corrects any stale red dots
    // left over from a missed poll cycle while the tab was hidden.
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState !== 'visible') return
        try {
          refreshLiveStatusSoon()
        } catch {}
      },
      { signal: mcSignal },
    )

    // MutationObserver-based mount waiter: fires the moment `find()` returns
    // truthy, then disconnects. Beats the old 500ms polling (avg ~250ms
    // perceived load lag) — content scripts run at document_idle, and the
    // chat container often mounts within 50-150ms of that. 15s safety
    // fallback timer in case the observer never fires (SPA bug, slow page).
    const waitForMount = (find, label) => {
      if (mcSignal?.aborted) return
      const inject = () => {
        if (mcSignal?.aborted) return
        _runOverlayMountPass(label || 'waitForMount', () => {
          ensureUIElements()
          switchTab(bootActiveTab())
          startLayoutWatcher()
        })
      }
      if (find()) {
        inject()
        return
      }
      let done = false
      const obs = new MutationObserver(() => {
        if (done || !find()) return
        done = true
        obs.disconnect()
        inject()
      })
      obs.observe(document.documentElement, { childList: true, subtree: true })
      cleanup.trackObserver(obs)
      cleanup.setTimeout(() => {
        if (done) return
        done = true
        obs.disconnect()
        if (!find()) log('Failed to find', label, 'after 15s')
        else inject()
      }, 15000)
    }
    if (hostPlatform === 'yt') {
      // YT panel is body-mounted on every page (home, VOD, live, channel),
      // so there's no DOM mount point to wait on. Inject immediately; any
      // late-mounting live chatframe is hidden separately by the chatframe
      // observer in getOrCreateHsContainer + the SPA nav handler.
      _runOverlayMountPass('yt body-mount', () => {
        ensureUIElements()
        switchTab(bootActiveTab())
        startLayoutWatcher()
      })
      // YT computes grid items-per-row + #primary widths from window-keyed
      // ResizeObservers; our layout overrides happen mid-cycle and YT
      // doesn't re-measure until something fires `resize`. One synthetic
      // dispatch (after a paint) gets the home grid to render at the
      // capped width without the user having to wiggle the chat handle.
      requestAnimationFrame(() => {
        try {
          window.dispatchEvent(new Event('resize'))
        } catch {}
      })
    } else if (isKick) {
      // Kick non-channel pages (/browse, /categories, /following, /search,
      // /settings, …) never mount #channel-chatroom. Body-mount immediately
      // so the persistent overlay appears without waiting on the 15s safety
      // timeout. Single-segment paths likely become a channel page once
      // chatroom mounts; waitForMount handles that — except for the reserved
      // path names below, which look channel-shaped to the regex but never
      // mount a chatroom, leaving the overlay invisible on /browse etc.
      const KICK_RESERVED_PATHS = new Set([
        'browse',
        'categories',
        'category',
        'following',
        'search',
        'settings',
        'dashboard',
        'help',
        'messages',
        'notifications',
        'community',
        'about',
        'subscriptions',
        'wallet',
        'verify',
        'login',
        'signup',
        'logout',
        'privacy',
        'terms',
        'rules',
        'careers',
        'press',
        'profile',
        'support',
      ])
      const isPopout = document.body.classList.contains('hs-popout')
      const segMatch = location.pathname.match(/^\/([a-zA-Z0-9_-]+)\/?$/)
      const couldBeChannel = !!segMatch && !KICK_RESERVED_PATHS.has(segMatch[1].toLowerCase()) && !isPopout
      if (!couldBeChannel) {
        _runOverlayMountPass('kick non-channel body-mount', () => {
          ensureUIElements()
          switchTab(bootActiveTab())
          startLayoutWatcher()
        })
      } else {
        waitForMount(
          () => document.getElementById('channel-chatroom') || document.querySelector('[id*="chatroom"]'),
          'Kick chatroom',
        )
      }
    } else {
      // Twitch: try to hook into React, fall back to MutationObserver
      tryHookReact()
    }
  }

  /**
   * Attempt to hook React components, with fallback.
   * Fires the moment the chat-room appears via MutationObserver — the old
   * 500ms poll meant up to 500ms of perceived lag after Twitch's React
   * actually mounted. Now: usually <1 frame.
   */
  function tryHookReact() {
    let done = false
    const tryHook = () => {
      if (done || mcSignal?.aborted) return false
      // Non-channel twitch pages (/directory, /settings, /videos, /search…)
      // never mount .chat-shell or chat-room. Body-mount immediately so the
      // persistent overlay appears without waiting on the 15s safety timeout.
      // Detection: no .channel-root anywhere AND no popout class. Popout has
      // its own .chat-shell mount path that we still want to flow through.
      const onChannel = !!document.querySelector('.channel-root, [class*="channel-root"]')
      const isPopout = document.body.classList.contains('hs-popout')
      if (!onChannel && !isPopout) {
        done = true
        log('Twitch non-channel page — body-mount overlay')
        _runOverlayMountPass('twitch non-channel body-mount', () => {
          ensureUIElements()
          switchTab(bootActiveTab())
          startLayoutWatcher()
        })
        return true
      }
      const chatRoom = findChatRoomComponent()
      if (chatRoom) {
        done = true
        log('Found chat room component')
        _runOverlayMountPass('twitch react hook', () => {
          patchChatRoomRender(chatRoom)
          ensureUIElements()
          switchTab(bootActiveTab())
          startLayoutWatcher()
        })
        return true
      }
      const chatContainer =
        document.querySelector('[class*="chat-room__content"]') ||
        document.querySelector('[data-a-target="chat-room-component"]') ||
        document.querySelector('.chat-shell') ||
        document.querySelector(CONFIG.SELECTORS.TWITCH_STREAM_CHAT) ||
        document.querySelector('.chat-room')
      if (chatContainer) {
        done = true
        log('Using fallback DOM injection')
        _runOverlayMountPass('twitch fallback dom injection', () => {
          ensureUIElements()
          switchTab(bootActiveTab())
          startLayoutWatcher()
        })
        return true
      }
      return false
    }

    if (tryHook()) return
    const obs = new MutationObserver(() => {
      if (tryHook()) obs.disconnect()
    })
    obs.observe(document.documentElement, { childList: true, subtree: true })
    cleanup.trackObserver(obs)
    // Safety net: a slow tab might mount after observer-window misses; bail
    // after 15s to free the observer.
    cleanup.setTimeout(() => {
      if (done) return
      done = true
      obs.disconnect()
      log('Failed to find chat components after 15s')
    }, 15000)
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
      if (spaReinitializing) return
      if (document.getElementById('hs-mc-container')) return
      log('Container missing, re-injecting...')
      tabBarElement = null
      overlayElement = null
      inputBarElement = null
      resizeObserver = null
      _roWatched = []
      ensureUIElements()
      updateTabBar()
      renderMessages(currentTab)
    }

    // Safety-net poll. Previously paired with a documentElement-scoped
    // MutationObserver — that observer fired on every Twitch React
    // reconciliation tick (huge sustained CPU). Removed in favor of poll-only.
    // Skipped while tab is hidden so backgrounded tabs cost ~0.
    cleanup.setIntervalIfVisible(() => reinject(), 500)
  }

  // ============================================
  // STARTUP
  // ============================================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { signal: mcSignal })
  } else {
    init()
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
    document.addEventListener(
      'click',
      (ev) => {
        // Only primary button, no modifier keys, no defaultPrevented
        if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.defaultPrevented) return
        const a = ev.target?.closest?.('a[href]')
        if (!a) return
        // Skip new-tab clicks — those don't navigate this tab
        if (a.target && a.target !== '_self') return
        const href = a.getAttribute('href')
        if (!href?.startsWith('/')) return
        // Streamer slug = single-segment path (no slashes after first), not a
        // reserved Kick route. Mirrors the eligibility checks in waitForMount.
        const slug = href.replace(/^\/+|\/+$/g, '').toLowerCase()
        if (!slug) return
        if (slug.includes('/')) return
        const reserved = new Set([
          'browse',
          'category',
          'categories',
          'following',
          'search',
          'settings',
          'login',
          'signup',
          'help',
          'community',
          'privacy',
          'terms',
          'support',
          'dmca',
          'dashboard',
          'partner',
          'vip',
          'agency',
          'bug',
          'press',
          'redeem',
          'clips',
          'games',
          'api',
          'admin',
          'moderation',
          'jobs',
          'about',
          'blog',
          'company',
          'careers',
          'dmca',
          'responsible-disclosure',
          'accessibility',
          'referrals',
          'agent',
          'kickbot',
          'wallet',
          'vault',
          'feedback',
        ])
        if (reserved.has(slug)) return
        // Same URL — don't move anything
        if (location.pathname === href) return
        const container = document.getElementById('hs-mc-container')
        if (!container || container.parentElement === document.body) return
        // Pre-emptive migrate. Runs BEFORE Kick's React handler fires.
        document.body.appendChild(container)
        document.body.classList.add('hs-mc-navigating')
      },
      { capture: true, signal: mcSignal },
    )
  }

  // Primary: instant notification from MAIN world history hooks
  window.addEventListener(
    'message',
    (event) => {
      if (event.source !== window) return
      if (event.origin !== location.origin) return
      if (event.data?.type === 'heatsync-nav') handleMcNav()
      // Fallback rotate paths — heatsync-button.js settings panel posts these
      // so the user always has a way to rotate even if the chat tabbar is
      // somehow not clickable (e.g. extreme drag, weird layout state).
      if (event.data?.type === 'heatsync-rotate-tabs') {
        try {
          rotateTabPosition()
        } catch (e) {
          log('rotate-tabs message handler:', e)
        }
      }
      if (event.data?.type === 'heatsync-rotate-chat') {
        try {
          rotateChatPosition()
        } catch (e) {
          log('rotate-chat message handler:', e)
        }
      }
    },
    { signal: mcSignal },
  )

  // YouTube SPA navigation
  if (hostPlatform === 'yt') {
    document.addEventListener('yt-navigate-finish', () => handleMcNav(), { signal: mcSignal })
  }

  // Fallback: polling in case MAIN world script didn't load
  cleanup.setIntervalIfVisible(() => handleMcNav(), 5000)
})()

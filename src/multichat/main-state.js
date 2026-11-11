// part 1 of 8 of the multichat main body — state, filters, first paint, message-list dom indices, per-tab dom cache, persisted buffers, restore, unread, colors, sender emotes.
// one scope with the other main-*.js parts and main.js at bundle time (build.js MAIN_PARTS, in list order).
// no wrapper here: the IIFE is the bundle's.

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
// Set to the tab id we auto-switched to when the temp tab ('live') went away
// under the user (the page lost its channel, or a saved tab now covers it), so
// the next nav onto an uncovered channel can hand the panel back. Any tab the
// user picks themselves clears it (switchTab). '' = nothing to hand back.
let _bouncedFromLive = ''
let _autoSwitching = false
// The temp tab only redirects once boot has landed on a tab, so an early
// updateTabBar can't switch a half-built panel.
let _liveSyncArmed = false
let _keepingLive = false
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
// Verified cross-platform handles heatsync resolved for a page channel,
// { [urlCh]: { twitch, kick } } ('' = same-name stands). Below an explicit
// override, above the same-name guess; in-memory only — the server is the
// record. See applyLiveIdentityCounterpart (social.js).
const liveIdentityMap = {}
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
// Both sets hold `platform:name` keys (a twitch "xqc" being live says nothing about
// kick "xqc"). `plat` omitted = live on ANY platform (event rows that carry no platform).
const _LIVE_PLATS = ['twitch', 'kick', 'youtube']
const liveKey = (plat, name) => `${plat === 'yt' ? 'youtube' : plat}:${String(name || '').toLowerCase()}`
function liveSetHas(set, name, plat) {
  if (!set || !name) return false
  const n = String(name).toLowerCase()
  return plat ? set.has(liveKey(plat, n)) : _LIVE_PLATS.some((p) => set.has(`${p}:${n}`))
}
/** bare names of one platform out of a keyed live set */
function liveNames(set, plat) {
  const pre = `${plat}:`
  return new Set([...(set || [])].filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length)))
}
function isChannelLive(name, plat) {
  if (!name) return false
  return liveSetHas(_swLiveSet, name, plat) || liveSetHas(liveChannelSet, name, plat)
}
/** youtube @handle of a channel tab's youtube link ('' when it holds none) */
const tabYtHandle = (ch) => (String(ch?.youtube || '').match(/@([^/?#]+)/)?.[1] || '').toLowerCase()
/** is this saved tab live per the keyed sets — each leg judged on its own platform */
function tabIsLiveFromSets(ch) {
  const tw = ch.twitch?.toLowerCase()
  const ki = ch.kick?.toLowerCase()
  const yt = tabYtHandle(ch)
  return (
    isChannelLive(tw, 'twitch') ||
    isChannelLive(ki, 'kick') ||
    isChannelLive(yt, 'youtube') ||
    (!tw && !ki && !ch.youtube && isChannelLive(ch.id?.toLowerCase(), 'twitch'))
  )
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
let currentSub = null // active cell of the 2nd row (null = tab has none)
const lastSubByTab = {} // last cell used per tab, restored on return
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
  // The pane's rows are NEVER shed on hide. They used to be trimmed to 100 and
  // rebuilt on return, which made a half-empty pane a reachable state: any
  // guard that skipped the rebuild (a scroll-pause the trim itself caused, an
  // open panel, a throw) stranded the reader at the shed rows until a reload.
  // The rows are the render of buffers already held in memory; keeping them
  // costs a few MB while hidden and removes the state entirely.
  // Catch up after a hidden stretch: one render replaces the N per-message
  // appends we skipped. renderMessages self-guards for the settings tab and
  // open profile cards, so no state checks needed here.
  if (!document.hidden && _hiddenSkippedAppend) {
    _hiddenSkippedAppend = false
    try {
      renderMessages(currentTab)
    } catch (e) {
      hsDiagLog('vis-render-error', { err: String(e?.message || e) })
    }
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

// Per-tab platform view filter: { [tabId]: { twitch, kick, youtube } }, a platform
// set to false is hidden on that tab. Device-local (chrome.storage.local
// 'platform_filters', never synced), flipped from the tab's right-click menu.
let platformFilters = {}
async function loadPlatformFilters() {
  try {
    const stored = (await cachedUiOverflow()).platform_filters
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      // drop entries for tabs that no longer exist — bounded growth
      const knownIds = new Set((config.channels || []).map((c) => c.id))
      const pruned = {}
      for (const [id, val] of Object.entries(stored)) {
        if ((!knownIds.size || knownIds.has(id)) && val && typeof val === 'object') pruned[id] = val
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
// Hot path (every rendered row): one object lookup before anything else.
function isPlatformHiddenInTab(m, tabId) {
  const f = platformFilters[tabId]
  if (!f) return false
  // twitch rows carry no platform (see buildMessageDiv's `!m.platform` convention); notices
  // and system lines carry neither a platform nor a user, so they are never filtered
  const p = m.platform || (m.user && !m.type ? 'twitch' : '')
  return !!p && f[p] === false
}

// Content-warning filters live entirely in the settings registry (schema
// entries with a `cw` sub-shape); _mcStorageListener's generic local-key
// loop keeps the cache + visible pills coherent cross-tab.

// Channel point redeem title cache: rewardId → { title, cost }
const redeemTitleMap = new Map()

// Buffers
const mentionsBuffer = []
const MAX_BUFFER = 500

// Mod-action log: history of ban/timeout/unban/delete notices (self + observed,
// all channels), for the streamer/mod popout view. Recorded at the irc/kick
// 'message' chokepoints (below) so it survives chat-buffer cycling, and kept in
// chrome.storage.local so it survives a reload too (newest 500 per channel).
// Pure logic + dedup/cap + the storage half live in mod-log.js (unit-tested).
const modActionLog = []
const modLogStore = createModLogStore({
  log: modActionLog,
  storage: () => (chrome?.runtime?.id ? chrome.storage.local : null),
  setTimer: (fn, ms) => cleanup.setPageTimeout(fn, ms),
  clearTimer: (t) => cleanup.clearTimeout(t),
})

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
const DOM_RENDER_CAP = 500

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

// First paint of a cold list: the newest FIRST_PAINT_ROWS now, the older rows in chunks right after, so
// the chat is on screen and live in one short task instead of one 500-row build. _paintFor names the tab
// whose list is still filling; _paintCap is how many rows it may show so far.
const FIRST_PAINT_ROWS = 100
const FIRST_PAINT_STEP = 100
let _paintFor = null
let _paintCap = 0
function growFirstPaint(id) {
  cleanup.setTimeout(() => {
    if (_paintFor !== id) return
    const el = document.getElementById('hs-mc-messages')
    if (!el || currentTab !== id) {
      _paintFor = null
      return
    }
    const h0 = el.scrollHeight
    const top0 = el.scrollTop
    _paintCap += FIRST_PAINT_STEP
    renderMessages(id)
    // overflow-anchor is off on the list: older rows landing above a scrolled-up viewer would move it
    if (isScrolledUp) el.scrollTop = top0 + (el.scrollHeight - h0)
    if (_paintCap >= Math.min(DOM_RENDER_CAP + _scrollbackWindow, SCROLLBACK_MAX)) _paintFor = null
    else growFirstPaint(id)
  }, 0)
}
// Leaving a tab with its list half filled: finish now, so what is cached for it is the whole list in order.
function finishFirstPaint() {
  if (_paintFor === null) return
  const id = _paintFor
  _paintCap = SCROLLBACK_MAX
  if (currentTab === id) renderMessages(id)
  _paintFor = null
}

// A tab coming back from the cache used to mount all of its rows at once and pay the whole layout bill
// (500 rows, hundreds of ms on slow hardware) before it could be seen. Now only the newest
// FIRST_PAINT_ROWS mount; the older ones wait detached in _heldOlder, with their keys already indexed,
// and go back above them in chunks right after. Anything that reads or rewrites the whole list calls
// flushHeldOlder() first, so the DOM it sees is always the full ordered list.
let _heldOlder = null // { id, frag }
function holdOlderRows(tabId, frag) {
  const kids = frag.children
  if (kids.length <= FIRST_PAINT_ROWS + 20) return
  const range = document.createRange()
  range.setStartBefore(frag.firstChild)
  range.setEndBefore(kids[kids.length - FIRST_PAINT_ROWS])
  _heldOlder = { id: tabId, frag: range.extractContents() }
  range.detach?.()
}
// Put the newest `count` held rows back above the mounted ones, keeping what the reader sees where it is.
function _mountHeldChunk(count) {
  const held = _heldOlder
  const el = document.getElementById('hs-mc-messages')
  if (!held || !el) return false
  const kids = held.frag.children
  if (kids.length === 0) {
    _heldOlder = null
    return false
  }
  const h0 = el.scrollHeight
  const top0 = el.scrollTop
  let chunk = held.frag
  if (count < kids.length) {
    const range = document.createRange()
    range.setStartBefore(kids[kids.length - count])
    range.setEndAfter(held.frag.lastChild)
    chunk = range.extractContents()
    range.detach?.()
  } else {
    _heldOlder = null
  }
  el.insertBefore(chunk, el.firstChild)
  // overflow-anchor is off on the list: rows landing above the viewport would move it. Pinned to
  // the bottom, go to the bottom: a tab restored from the cache pins a frame later than its
  // first chunk lands, and following the growth from a not-yet-pinned offset made the list
  // wander between the two for a moment.
  if (isScrolledUp || hoverHeld) el.scrollTop = top0 + (el.scrollHeight - h0)
  else scrollMsgsToBottom(el)
  return _heldOlder !== null
}
function growHeldOlder(id) {
  cleanup.setTimeout(() => {
    if (!_heldOlder || _heldOlder.id !== id) return
    if (currentTab !== id) return // switchTab flushes on the way out
    if (_mountHeldChunk(FIRST_PAINT_STEP)) growHeldOlder(id)
    else applyMcMutes()
  }, 0)
}
function flushHeldOlder() {
  if (!_heldOlder) return
  const mounted = document.getElementById('hs-mc-messages')
  if (mounted && currentTab === _heldOlder.id) {
    _mountHeldChunk(Infinity)
    applyMcMutes()
  }
  _heldOlder = null
}

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
// YouTube's own chat stays the one on screen only when the user switched hs chat off for youtube.
// A premiere or scheduled stream is NOT a case: its chat frame relays into the overlay exactly like a
// live stream's (verified on a real premiere), so it gets the full multichat. The one place this is
// decided — the panel, the frame hide and the css all follow it, so they cannot disagree.
const ytOwnsChat = () => gateAtBoot('chat-youtube') === false
// A premiere or scheduled stream (the player shows YouTube's offline slate): nothing server-side feeds or
// sends its chat, so YouTube's own chat frame IS the feed and the send path. It stays loaded — hidden,
// never collapsed (collapsing makes YouTube unload the frame and the relay inside it goes with it).
const ytFrameIsTheFeed = () => {
  const slate = document.querySelector('#movie_player .ytp-offline-slate')
  return !!slate && slate.getClientRects().length > 0
}

// Scoped emote wrapper query (avoids full-document scan).
// Includes the reply-stack overlays — they're appended to <body>, not inside
// #hs-mc-overlay, so without these roots the hover-highlight never lands on
// overlay-rendered emotes (and same-name cross-highlight misses overlay copies).
function queryEmoteWrappers(emoteName) {
  const esc = CSS.escape(emoteName)
  const sel = `.hs-mc-emote-wrapper[data-emote-name="${esc}"]`
  // Emotes a logs surface draws (card recent lines, chat-logs panel) are bare
  // <img>s with no wrapper; they take part in the same highlight/block/flash.
  const logSel = `.hs-card-log-body img[alt="${esc}"], .hs-cl-list img.hs-cl-emote[alt="${esc}"]`
  const main = document.getElementById('hs-mc-overlay')
  const stackUp = document.getElementById('hs-mc-reply-stack')
  const stackDown = document.getElementById('hs-mc-reply-stack-down')
  if (!main && !stackUp && !stackDown) return document.querySelectorAll(`${sel}, ${logSel}`)
  const out = []
  if (main) for (const w of main.querySelectorAll(`${sel}, ${logSel}`)) out.push(w)
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
  const mentions = div._hsMentionEls || div.querySelectorAll('a.hs-mc-mention[data-uid], a.hs-mc-reply-user[data-uid]')
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
  _heldOlder = null // held rows are indexed by the maps being cleared
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
// Where a cache-restore render spent its time; read by switchTab's slow-switch
// diag line so a laggy tab says which step it was, not just that it was slow.
let _restoreParts = null

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
  flushHeldOlder() // never carry another tab's held rows into this one
  holdOlderRows(tabId, cache.frag)
  msgsEl.appendChild(cache.frag)
  _heldOlder && growHeldOlder(tabId)
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
        newBtn.append(arrow, ` ${t('mc_new_messages', [String(newMessageCount)])}`)
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
    postId: m.postId || undefined,
    kind: m.kind || undefined,
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

// Heatsync account the saved mentions belong to — a mention of the previous
// account must never be restored under the next one.
let mentionsOwner = ''

function _writeMentionsNow() {
  try {
    if (!chrome?.runtime?.id) return
    const msgs = mentionsBuffer.slice(-PERSIST_MAX_MENTIONS).map(_serializePersistMsg)
    const p = chrome.storage.local.set({ hs_mentions_v2: { msgs, ts: Date.now(), owner: mentionsOwner } })
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
  // Server-backed like mentions/whispers: every other tab and device clears too.
  if (!mcIsReservedTab(tabId)) pushTabSeen(tabId, tabSeenAt[tabId])
}

// Remote read marks (boot GET, tabseen:update frame). Max-merge into
// tabSeenAt, then re-derive each advanced tab's red state from its buffer —
// not a blind clear, so a message that landed here after the read elsewhere
// keeps the tab lit. After a boot GET, anything we hold NEWER than the server
// (a POST that never landed) is sent up, so a lost write heals itself.
function applyRemoteTabSeenMarks(remote, reconcile) {
  let advanced = false
  for (const [k, v] of Object.entries(remote)) {
    if (typeof v !== 'number' || !(v > (tabSeenAt[k] || 0))) continue
    tabSeenAt[k] = v
    advanced = true
    const tabEl = tabBarElement?.querySelector(`.hs-mc-tab[data-tab="${CSS.escape(k)}"]`)
    if (!tabEl) continue
    tabEl.classList.remove('has-mentions', 'has-new', 'has-stream-event')
    clearTabUnread(k)
    refreshTabCounter(k)
    applyUnreadIndicatorForTab(tabEl)
  }
  if (advanced) _persistTabSeenSoon()
  if (!reconcile) return
  for (const [k, v] of Object.entries(tabSeenAt)) {
    if (typeof v === 'number' && v > (Number(remote[k]) || 0) && !mcIsReservedTab(k)) pushTabSeen(k, v)
  }
}
setTabSeenSink(applyRemoteTabSeenMarks)

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
    modLogStore.flush()
  } catch {}
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
    const seenRes = await browser.storage.local.get('hs_tab_seen_v1')
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

    // the mod log: merge what the last session kept into the (still empty) in-memory one
    await modLogStore.load()
    // …and keep it current with what another tab of this browser writes, so the
    // write that tab-close does carries both sides
    try {
      cleanup.addListener(chrome.storage.onChanged, (changes, area) => {
        if (area === 'local' && changes[MOD_LOG_KEY]) modLogStore.absorb(changes[MOD_LOG_KEY].newValue)
      })
    } catch {}

    let mChrome = null
    try {
      const r = await browser.storage.local.get(['hs_mentions_v2', 'user_info'])
      mentionsOwner = String(r.user_info?.username || '').toLowerCase()
      if (
        r.hs_mentions_v2?.msgs?.length > 0 &&
        Date.now() - r.hs_mentions_v2.ts < 86400000 &&
        (r.hs_mentions_v2.owner || '') === mentionsOwner
      ) {
        mChrome = r.hs_mentions_v2.msgs
      }
    } catch {}
    // Legacy residue: older builds mirrored cross-platform mentions to
    // host-page localStorage (readable by the host site + co-resident
    // extensions). chrome.storage.local (hs_mentions_v2) is authoritative, so
    // purge the old copy for good. It carries no owner, so it is never
    // restored — it could belong to another account.
    try {
      localStorage.removeItem('hs_mentions_sync')
    } catch {}
    if (mChrome) {
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
      const merged = [...byId.values(), ...noId].sort((a, b) => (a.time || 0) - (b.time || 0))
      for (const m of merged) {
        m.isHistory = true
        mentionsBuffer.push(m)
      }
      if (mentionsBuffer.length > PERSIST_MAX_MENTIONS) {
        mentionsBuffer.splice(0, mentionsBuffer.length - PERSIST_MAX_MENTIONS)
      }
      log('Restored mentions:', mentionsBuffer.length)
    }

    try {
      // Key enumeration only — getKeys (Chrome 130+/FF 134+) avoids
      // materializing every stored value (cosmetics caches, error rings,
      // seen-state — MBs) on the mount-blocking path just to find hs_yt_*
      // buffers. get(null) survives solely as the legacy-browser fallback.
      const allKeys =
        typeof chrome.storage.local.getKeys === 'function'
          ? await browser.storage.local.getKeys()
          : Object.keys(await browser.storage.local.get(null))
      const ytKeys = allKeys.filter((k) => k.startsWith('hs_yt_') && !k.startsWith('hs_yt_sync_'))
      const all = ytKeys.length ? await browser.storage.local.get(ytKeys) : {}
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
          await browser.storage.local.remove(staleYtIds.map((id) => `hs_yt_${id}`))
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
  for (const tabEl of tabBarElement.querySelectorAll('.hs-mc-tab[data-tab]')) applyUnreadIndicatorForTab(tabEl)
}

function applyUnreadIndicatorForTab(tabEl) {
  {
    const tabId = tabEl.dataset.tab
    if (!tabId || tabId === currentTab) return
    if (new Set(mcReservedTabIds()).has(tabId)) return
    const seen = tabSeenAt[tabId] || 0
    if (!seen) return // first-time view of this tab — don't spuriously light up
    const ch = getChannelById(tabId)
    if (!ch) return
    let maxTime = 0
    let hasMention = false
    const scan = (arr) => {
      if (!arr) return
      for (const m of arr) {
        // OP/RE rows, receipts and other inline notices are put into every
        // channel's buffer; nobody said anything in this chat, so they never
        // make a tab unread.
        if (m.inlineNotifType) continue
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
// Names whose knownColors entry is their real TWITCH color (heard speaking on
// twitch, or twitch's own chat color). A kick color, a heatsync pick or a
// hash fallback never overwrites it: one username, one color, and a twitch
// line keeps twitch's color (same rule as the site's resolveNameColor).
const _nativeTwitchColor = new Set()
// A twitch line with no color tag arrives as white; that is "unset", not a pick.
const _isUnsetWhite = (c) => /^#f{3}(f{3})?$/i.test(String(c))
// 'platform:login' -> the colour that login was last seen wearing in THAT
// platform's chat. knownColors is one slot per login, so a kick "alice" and a
// twitch "alice" overwrite each other there; a stream-event row asks this one.
const platSeenColors = new Map()
function setKnownColor(user, color, userId, platform, native = platform === 'twitch' && !_isUnsetWhite(color)) {
  if ((platform === 'kick' || platform === 'twitch') && user && color && !_isUnsetWhite(color)) {
    platSeenColors.set(`${platform}:${user}`, color)
    if (platSeenColors.size > 2000) platSeenColors.delete(platSeenColors.keys().next().value)
  }
  // Your own name is your twitch color everywhere. A kick/pick/hash color for the
  // same login (your kick account, say) must not stand in for it while twitch's
  // is still unheard — it rendered your @mentions in the wrong color until you spoke.
  if (!native && user && user === currentUsername) return
  if (native || !_nativeTwitchColor.has(user)) {
    const changed = native && knownColors.get(user) !== color
    knownColors.set(user, color)
    if (native) _nativeTwitchColor.add(user)
    // Your own earlier lines were drawn before this color was known (or in the
    // color you used to have); redraw just those. History replays oldest to
    // newest, so the last color heard is the current one.
    if (changed && user === currentUsername) {
      recolorOwnLines(user)
      persistOwnColor(user, color)
    }
  }
  if (knownColors.size > 2000) {
    const iter = knownColors.keys()
    for (let i = 0; i < 500; i++) {
      const k = iter.next().value
      knownColors.delete(k)
      _nativeTwitchColor.delete(k)
    }
  }
  // Only a twitch line carries a twitch id. A kick line's userId is kick's own
  // numeric id; filed here it painted replies/@mentions with a stranger's
  // twitch cosmetics. Kick/yt names get their RESOLVED twitch id from the
  // cosmetics lookups (flushKickNameLookups / flushYtNameLookups).
  if (userId && platform === 'twitch') {
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

// Your own twitch color, from twitch itself, once per page. History replay and
// lines sent from this panel carry no color tag, so without this your name
// stays white until you happen to chat live. Same unauthed GQL lookup the
// @mention colors use; anything unexpected leaves the name as it was.
// Twitch's own page already knows how it draws your name — including the
// default color it gives an account that never picked one, which no API
// reports. Copy what the native chat actually shows; it wins over everything
// else we could learn, so the panel and Twitch agree.
function probeNativeOwnColor(me) {
  try {
    const el = document.querySelector(`.chat-line__message .chat-author__display-name[data-a-user="${CSS.escape(me)}"]`)
    const c = el && getComputedStyle(el).color
    const m = c && /^rgb\((\d+), (\d+), (\d+)\)$/.exec(c)
    if (!m) return false
    const hex = `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`
    if (_ownColorFromTwitch === me || _isUnsetWhite(hex)) return _ownColorFromTwitch === me
    setKnownColor(me, hex, undefined, 'twitch', true)
    return true
  } catch {
    return false
  }
}

// A color twitch's lookup reports is one the account really picked (/color,
// twitch settings): it beats the native page, which until your first message
// can still draw the random default it gave you before you chose one.
let _ownColorFromTwitch = ''

async function seedOwnTwitchColor() {
  const me = currentUsername
  if (!me) return
  // The native chat list renders a beat after we mount: look a few times.
  let probes = 0
  const probe = () => {
    if (_ownColorFromTwitch === me || probeNativeOwnColor(me) || ++probes >= 6) return
    cleanup.setTimeout(probe, 2500)
  }
  cleanup.setTimeout(probe, 1000)
  try {
    const resp = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko' },
      body: JSON.stringify({
        query: 'query($login:String!){user(login:$login){chatColor}}',
        variables: { login: me },
      }),
    })
    if (resp.ok) {
      const color = (await resp.json())?.data?.user?.chatColor
      if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) {
        _ownColorFromTwitch = me
        setKnownColor(me, color.toLowerCase(), undefined, 'twitch', true)
        return
      }
    }
  } catch {}
  if (_nativeTwitchColor.has(me)) return
  // No color picked on twitch: the last one this browser heard you speak with
  // is the answer on every reload after the first time you chat.
  try {
    const saved = (await browser.storage.local.get('hs_own_twitch_color')).hs_own_twitch_color
    if (saved?.user === me && /^#[0-9a-f]{6}$/i.test(saved.color) && !_nativeTwitchColor.has(me)) {
      setKnownColor(me, saved.color, undefined, 'twitch', true)
    }
  } catch {}
}

function persistOwnColor(user, color) {
  try {
    browser.storage.local.set({ hs_own_twitch_color: { user, color } }).catch(() => {})
  } catch {}
}

// Redraw the viewer's own twitch lines once their real color is known.
function recolorOwnLines(lower) {
  const reset = (buf) => {
    if (!buf || typeof buf[Symbol.iterator] !== 'function') return
    for (const x of buf) {
      if (x && x.user?.toLowerCase() === lower) x._renderedHtml = null
    }
  }
  if (irc?.channels) for (const ch of irc.channels.keys()) reset(irc.getMessages(ch))
  // Rows already on screen are kept, not rebuilt: repaint the name in place.
  // A painted name (extra class) owns its own fill and is left alone.
  const color = sanitizeColor(knownColors.get(lower) || '#fff')
  for (const a of document.querySelectorAll(`#hs-mc-messages .hs-mc-user[data-platform="twitch"]`)) {
    if (a.dataset.username === lower && a.className === 'hs-mc-user') a.style.color = color
  }
  // one redraw per burst: a history replay can change the color several times
  if (_ownRecolorQueued) return
  _ownRecolorQueued = true
  cleanup.setTimeout(() => {
    _ownRecolorQueued = false
    try {
      renderMessages(currentTab)
    } catch {}
  }, 0)
}
let _ownRecolorQueued = false
if (!_onceGuardsMain.profileColorListener) {
  _onceGuardsMain.profileColorListener = true
  try {
    cleanup.addListener(chrome.runtime?.onMessage, (msg) => {
      if (msg?.type === 'follows_changed') return void pcRefreshAfterFollowChange()
      if (msg?.type !== 'profile_color') return
      applyLiveProfileColor(msg.usernames, msg.color)
      // the open card shows that account's color too: re-ask it
      if (msg.userId != null) pcRefreshCardFor([msg.userId])
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
      if (msg?.type === 'bookmark_changed') return void feedOnBookmarkPush(msg)
      if (msg?.type === 'mention_rules_changed') return void mrOnPush()
      if (msg?.type !== 'cosmetic_changed') return
      invalidateHsCosmetics(msg.ids)
      // the same push covers flair, badges, display name and avatar
      hsMarksRefreshIds(msg.ids)
      pcRefreshCardFor(msg.ids)
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
    const stored = await browser.storage.local.get(['hs_stale_emotes_v1'])
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
// background.js's get_sender_emotes handler truncates to 30 keys
// (`.slice(0, 30)`) — this is the real ceiling, not an arbitrary choice.
// Was 15, which under a busy channel's chatter churn hit the immediate-
// flush branch in queueSenderEmoteFetch below every couple new chatters,
// largely defeating the point of batching. Doubling it to the server's
// actual cap halves how often that branch fires for the same churn rate.
const SENDER_EMOTE_BATCH = 30
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
    // by kick_username only — tap/relay messages carry a numeric kick
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
  // on a 50ms tick instead of the steady-state window so the correction
  // lands before the eye settles. Only ever SHORTENS an armed timer;
  // batching is unaffected because same-tick renders queue their keys
  // before any timer fires.
  const urgent = !fetchedAt && !!(known && known.size > 0)
  if (senderEmoteTimer && urgent && !senderEmoteTimerUrgent) {
    cleanup.clearTimeout(senderEmoteTimer)
    senderEmoteTimer = null
  }
  if (!senderEmoteTimer) {
    senderEmoteTimerUrgent = urgent
    // 2s steady-state window — was 250ms, which on a busy channel's chatter
    // churn meant a fresh get_sender_emotes request every ~250ms-1s even
    // outside the immediate-flush-at-cap branch above. Sender emote sets
    // don't change mid-message; a 2s delay before an unseen chatter's
    // custom emotes resolve is invisible next to the 2min refetch TTL
    // (SENDER_EMOTE_REFETCH_MS) that governs freshness overall.
    senderEmoteTimer = cleanup.setPageTimeout(
      () => {
        senderEmoteTimer = null
        senderEmoteTimerUrgent = false
        flushSenderEmoteBatch()
      },
      urgent ? 50 : 2000,
    )
  }
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
      const vers = resp?.vers || {}
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
        // CDN-stale snapshot (older than a version already seen): keep the
        // current set. The v-busted push refetch is the fresh path, so queue
        // nothing; stamp so renders don't loop on it.
        if (senderSetIsStale(key, vers[key])) {
          markSenderEmoteFetched(key, now)
          continue
        }
        noteSenderVer(key, vers[key])
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
    senderEmoteTimer = cleanup.setPageTimeout(() => {
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

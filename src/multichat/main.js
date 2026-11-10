/**
 * Heatsync MultiChat - FFZ-style React-aware implementation
 *
 * KEY PRINCIPLE: Work WITHIN React, not around it.
 * - Never manipulate DOM after React renders
 * - Hook into React components and modify render output
 * - Use forceUpdate() to trigger re-renders
 * - Inject UI as React children, not DOM insertions
 */

// part 8 of 8 of the multichat main body — init and startup.
// one scope with the other main-*.js parts and main.js at bundle time (build.js MAIN_PARTS, in list order).
// no wrapper here: the IIFE is the bundle's.

// ============================================
// MAIN INITIALIZATION
// ============================================

let mcInitialized = false
// Re-arm the __live_yt_auto__ binding for the CURRENT yt video/channel page.
// Called from yt soft-nav (spa-nav.js), which unsubscribes the previous
// video's binding on every navigation — init()'s auto-join sibling below
// (~12240) only runs on full page load, so without this, SPA-navigating
// into a live stream left the multichat dead until refresh. Video-page +
// /channel/<id>/live subset only: the channel-mirror (explicit yt link)
// case stays init-time.
function autoYtSubscribeForPage() {
  if (hostPlatform !== 'yt') return
  if (gateAtBoot('chat-youtube') === false) return
  const vid = getCurrentChannel()
  if (!vid) return
  // getCurrentChannel() returns the raw UC channel id on /channel/<id>/live —
  // that's not a videoId, so it needs the /channel/.../live URL form
  // (ytSubscribe's own channel-shaped-URL branch resolves it to a concrete
  // videoId via the BG, same as an @handle URL).
  const isChannelId = parseYoutubeChannelType(location.pathname, location.search) === 'channel'
  const handleLiveUrl = ytHandleLiveUrl(location.pathname)
  if (!isChannelId && !handleLiveUrl && !/\/watch|\/live\//.test(location.pathname + location.search)) return
  const autoYtUrl = isChannelId
    ? `https://www.youtube.com/channel/${vid}/live`
    : handleLiveUrl || `https://youtube.com/watch?v=${vid}`
  ytSubscribedUrls.set('__live_yt_auto__', autoYtUrl)
  ytChanLastSeen.set('__live_yt_auto__', Date.now())
  // Concrete on-page videoId — open the render gate now (same rationale as
  // the init-time sibling: the poller's 'connected' echo is missed on
  // already-polled popular streams). No id yet for the channel-id case —
  // defers to ytSubscribe's own resolve echo, same as an @handle URL.
  if (!isChannelId && !handleLiveUrl) _autoYtVideoId = vid
  ytSubscribe('__live_yt_auto__', autoYtUrl, vid)
}

// The tab to activate on mount: the last one used; with none saved, the first channel tab; with no
// tabs at all, "live" (the stream on screen). A youtube popout is one stream — always "live".
// MODULE scope — tryHookReact()'s mount passes call this too; defining it
// inside init() made every twitch react-hook mount throw a ReferenceError
// and strand fresh viewers on the empty saved tab.
const bootActiveTab = () => {
  // A saved tab that is now HIDDEN (or whose subsystem was switched off) is
  // not restorable — you land on a tab that isn't in the bar, so nothing
  // looks selected ("I'm on no tab") while the composer quietly points at
  // that invisible surface. loadActiveTab validates the id against
  // BUILTIN_TABS + channels but runs before hiddenTabs is known, and
  // applyHiddenTabs' own correction only fires if it runs AFTER this restore
  // — on a cold boot it doesn't.
  _liveSyncArmed = true
  // 'live' saved means "the page's channel": liveTarget() says which tab that is now.
  const want = _savedActiveTab === 'live' ? liveTarget() : _savedActiveTab
  const restorable =
    want && !hiddenTabs.has(mcRowOwner(want)) && !(_TAB_SUBSYSTEM[want] && !isEnabled(_TAB_SUBSYSTEM[want]))
  // one stream: the temp tab, or the saved tab covering it (liveTarget says which)
  if (isYtPopout) return liveTarget()
  if (restorable) return want
  // Nothing restorable but channel tabs exist: land on the first one.
  const firstTab = config.channels?.find((c) => c?.id && !hiddenTabs.has(mcRowOwner(c.id)))
  return firstTab ? firstTab.id : liveTarget()
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
      'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#000000; border: 1px solid #ffff00;color:#ffff00;' +
      'font:600 12px/1.4 monospace;padding:6px 10px;text-align:center;'
    banner.textContent = msg ? `heatsync: ${reason} — ${msg}` : `heatsync: ${reason}`
    ;(document.body || document.documentElement).appendChild(banner)
  } catch (_) {}
}

async function init() {
  // BG-created send-bridge tab (#hs-bridge: the yt live_chat url, kick's
  // privacy page): stay completely silent. Booting the multichat here rebound
  // the single __live_yt_auto__ WS slot to the bridge's videoId (killing the
  // watch tab's live feed on reconnect) and its popout overlay hid the native
  // chat — the tab BG activates for youtube sign-in showed no login UI.
  // youtube-content.js / content.js (the actual relays) run regardless of this guard.
  if (location.hash.includes('hs-bridge')) return
  _initMarks = [['init', Math.round(performance.now())]]
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
    isPopout = /^\/(?:popout|embed)\/[a-zA-Z0-9_-]+\/chat/.test(location.pathname)
  } else {
    // Twitch: persistent overlay across every URL — directory, settings,
    // videos, etc. all keep the panel mounted. getOrCreateHsContainer
    // body-mounts when no .chat-shell exists; CSS squeezes twitch content.
    isPopout = !!location.pathname.match(/^\/(popout|embed)\/[a-zA-Z0-9_-]+\/chat/)
  }
  // Per-site "hs off" — decided before a single watcher, listener or style exists, so an off site is
  // left exactly as the page made it. (Re-snapshotted below, where the later gates need it.)
  await snapshotGates()
  if (!overlayEnabledHere(_gatesAtBoot)) {
    // Switched off for this site: take down the prepaint if one got up before this ran, mount nothing.
    document.getElementById('hs-early-layout')?.remove()
    document.documentElement.classList.remove('hs-prepaint-active', 'hs-prepaint-fade')
    return
  }
  if (mcInitialized) return
  mcInitialized = true
  cleanup.setInterval(renderStallCheck, 2500)
  cleanup.setInterval(ingestGapCheck, 1000)
  cleanup.setInterval(domThrashCheck, 2000)
  cleanup.addEventListener(document, 'keydown', (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyD') dumpPaneState()
  })
  watchLongFrames()

  // Inject CSS before ANYTHING that awaits. injectStyles has zero settings
  // deps, and a <style> tag is inert until our DOM mounts — but the health
  // round-trip below pays a full cold-SW wake (whole background.js eval)
  // when the worker is asleep, and the stylesheet has no reason to queue
  // behind that. Styles being present also means the kill-switch banner
  // itself paints styled instead of unstyled-then-styled.
  injectStyles()

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
  _initMark('health')
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
    showKillSwitchBanner(t('mc_main_kill_active'), _hsHealth?.msg)
    return
  }
  if (Array.isArray(_hsHealth?.disabled) && _hsHealth.disabled.includes('multichat')) {
    log('multichat disabled by server health flag')
    showKillSwitchBanner(t('mc_main_kill_disabled'), _hsHealth?.msg)
    return
  }
  const _curVer = chrome.runtime.getManifest?.().version || '0.0.0'
  if (_hsHealth?.ext_hard_min && _hsSemverLt(_curVer, _hsHealth.ext_hard_min)) {
    log('extension below ext_hard_min', _curVer, '<', _hsHealth.ext_hard_min)
    showKillSwitchBanner(t('mc_main_kill_update', [String(_hsHealth.ext_hard_min)]), _hsHealth?.msg)
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
  // (CSS already injected above, ahead of the health round-trip.)
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
  const _localPrime = chrome.storage.local.get([STORAGE_KEY, 'user_info', 'muted_users', 'blocked_users'])
  // Before loadConfig — it is the first thing that consults a subsystem gate.
  await snapshotGates()
  _initMark('gates')
  await loadConfig()
  _initMark('config')
  if (!config.enabled) return
  // Hover tooltips are document-level delegates that read their settings at event time, so they need only the
  // config gate above — registering them here, not after settings hydration, makes names and emotes hoverable
  // as soon as the first rows paint.
  setupEmoteTooltipHandlers()
  setupUserTooltipHandlers()
  setupTagCardHandlers()
  setupLinkTooltipHandlers()
  // The restored mentions/YT buffers need only the config just loaded, and are three storage round
  // trips in a row — start them now so they run under the settings hydration instead of after it.
  const _buffersP = restorePersistedBuffers()
  // Lite / emotes-only mode is fully removed — overlay always boots.
  log('Initializing...')
  if (hostPlatform === 'twitch') seedOwnTwitchColor()

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
  // Blocked users — shared with content.js via background's `blocked_users`. Rides the same prefetch as
  // the keys above: its own round trip here was a second storage wait in the boot path.
  try {
    const bd = await _localPrime
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
      hydrateHsCosmetics(),
      hydrateMcCosmetics(),
      hydrateEmoteBoxWidths(),
      hydrateTwitchBadges(),
    ].map((p) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, 5000))])),
  )
  repairTwitchOnlyTab() // not awaited: a network lookup must not hold boot
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
  await hideSecondaryTabsOnce()
  _initMark('settings')
  // Init done — drop the cache so subsequent reads see fresh data.
  invalidateUiSettingsCache()
  // Freeze the subsystem gates for the rest of init — a mid-init storage
  // write can't half-apply a subsystem. Live reads still use isEnabled().

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
          if (attempt < 8) cleanup.setTimeout(() => loadChannelEmotes(attempt + 1), Math.min(500 * (attempt + 1), 3000))
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
        const ffz = new BadgeIndex(resp?.ffzBadges)
        const chat = new BadgeIndex(resp?.chatterinoBadges)
        if (bttv.length + ffz.size + chat.size === 0) {
          if (attempt < 8) cleanup.setTimeout(() => loadBulkBadges(attempt + 1), Math.min(500 * (attempt + 1), 3000))
          return
        }
        mcBttvBadgeMap = new Map(bttv)
        mcFfzBadgeMap = ffz
        mcChatterinoBadgeMap = chat
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
      // channel (chatFilterRules) land in their
      // chrome.storage.local overflow keys instead — never chrome.storage.sync
      // (8KB ceiling). DEVICE_LOCAL_KEYS (platformFilters) are dropped — a
      // foreign device's per-tab layout would be meaningless here.
      const syncState = {}
      const localOverflow = {}
      for (const k in remote) {
        if (!Object.hasOwn(remote, k)) continue
        if (DEVICE_LOCAL_KEYS.has(k) || RETIRED_UI_KEYS.has(k)) continue
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
        await browser.storage.local.set(localOverflow)
      }
    } catch (e) {
      log('ui-state seed failed:', e?.message)
    } finally {
      retireSettings()
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
  await _buffersP
  _initMark('buffers')
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
    //
    // gKick, matching the twitch tap two blocks up. The module gates itself on
    // its OWN toggle (kick-native-tap) but never checked whether kick chat is
    // enabled at all, so switching the chat-kick subsystem off skipped
    // kickChat.connect() and left this running — and because this tap is
    // designed to be inert only WHILE the relay delivers, turning kick off did
    // not merely leak, it woke the fallback up. A control that does not cover
    // what it claims to is worse than no control.
    if (gKick && hostPlatform === 'kick') {
      try {
        initKickNativeTap()
      } catch (_) {}
    }
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
      if (typeof initPinBar === 'function') initPinBar()
      if (typeof __HS_DEV_BUILD__ !== 'undefined' && __HS_DEV_BUILD__)
        document.documentElement.dataset.hsAutomodInit = 'done'
    } catch (e) {
      log('automod init failed:', e?.message)
      try {
        document.documentElement.dataset.hsAutomodInit = `err:${e?.message || 'unknown'}`
      } catch (_) {}
    }

    // First-run tour card (tour.js): reads its seen flag, then draws on the next render
    try {
      if (typeof initTour === 'function') initTour()
    } catch (e) {
      log('tour init failed:', e?.message)
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
      // Also join the URL channel name if different, on the HOST platform
      // only (native messages for the page we are on). On the other platform
      // the url name is just the same-name guess an override or a verified
      // identity has already replaced — joining it too pulls a stranger's
      // (or a dead) channel into the tab.
      if (gTwitch && hostPlatform === 'twitch' && urlChFallback && twitchCh !== urlChFallback)
        trackJoin('live', irc.join(urlChFallback))
      if (gKick && hostPlatform === 'kick' && urlChFallback && kickCh !== urlChFallback)
        trackJoin('live', kickChat.join(urlChFallback))

      // Subscribe YouTube. On a YT watch/live URL getCurrentChannel returns the
      // 11-char videoId — feeding that to `@${id}/live` produces a bogus
      // @<videoId>/live URL that the server can't resolve. Use the actual
      // /watch?v=<id> form whenever we're on a YT video page so the server has
      // something concrete to bind to. The previous `length > 20` check never
      // matched (videoIds are 11), so YT-tab subs were silently broken.
      // On /channel/<id>/live, getCurrentChannel returns the raw UC channel
      // id instead — that goes through the channel-URL form, same as an
      // @handle URL (ytSubscribe's own channel-shaped-URL branch resolves
      // it to a concrete videoId via the BG).
      const isYtChannelId = hostPlatform === 'yt' && /^UC[\w-]{20,}$/.test(currentChannel || '')
      // /@handle/live: the page is the stream, but there's no videoId in the URL yet
      const handleLiveUrl = hostPlatform === 'yt' ? ytHandleLiveUrl(location.pathname) : ''
      const onYtVideoPage =
        hostPlatform === 'yt' && !handleLiveUrl && /\/watch|\/live\//.test(location.pathname + location.search)
      const autoYtUrl = isYtChannelId
        ? `https://www.youtube.com/channel/${currentChannel}/live`
        : handleLiveUrl
          ? handleLiveUrl
          : onYtVideoPage
            ? `https://youtube.com/watch?v=${currentChannel}`
            : ytUrl
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
      }
      // Zero-config cross-platform: resolve the page channel's heatsync
      // identity — a verified kick/twitch handle that differs from the
      // same-name guess, and the linked youtube when no explicit link is
      // stored (social.js).
      if (hostPlatform !== 'yt') autoResolveLiveIdentity()
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

  // Saved inline [OP]/[RE] rows go back after the channel buffers have
  // joined; the second pass catches slower joins (restore skips what's there).
  for (const delay of [1500, 8000]) {
    cleanup.setTimeout(() => {
      restoreInlineNotifs().then((added) => {
        if (!added) return
        const active = currentTab
        if (active === 'live' || config.channels.some((ch) => ch.id === active)) renderMessages(active)
      })
    }, delay)
  }

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
        markClearedRow(
          row,
          msg.banDuration ? t('mc_mod_label_timed_out', [String(msg.banDuration)]) : t('mc_mod_label_banned'),
        )
      }
    } else if (msg.noticeType === 'delete_message_success' && msg.targetMsgId) {
      const safe = CSS.escape ? CSS.escape(msg.targetMsgId) : msg.targetMsgId.replace(/"/g, '\\"')
      const row = msgsEl.querySelector(`.hs-mc-msg[data-msg-id="${safe}"]`)
      if (row) {
        markClearedRow(row, t('mc_mod_label_deleted'))
      }
    } else if (msg.noticeType === 'unban_success' && msg.targetUser) {
      // Lift a prior ban/timeout dim (not a delete) when the user is unbanned.
      const targetLc = msg.targetUser.toLowerCase()
      for (const row of msgsEl.querySelectorAll('.hs-mc-msg[data-msg-user]')) {
        if ((row.dataset.msgUser || '').toLowerCase() !== targetLc || !samePlat(row)) continue
        const why = row.dataset.clearedReason || ''
        if (why === 'banned' || /timed out/.test(why)) {
          row.classList.remove('hs-mc-msg-cleared')
          delete row.dataset.clearedReason
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
    chatLogsLive(msg)
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
    modLogStore.record(msg)
    // CLEARCHAT/CLEARMSG → live-dim already-rendered DOM rows from the offender.
    // Buffer entries were already flagged with `cleared=true` inside the IRC client,
    // so future re-renders pick it up via the renderer; this just patches the visible DOM.
    _applyModNoticeDim(msg)
    if (msg.resolvedHolds) {
      const msgsEl = document.getElementById('hs-mc-messages')
      for (const id of msg.resolvedHolds) {
        const safe = CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"')
        msgsEl?.querySelector(`.hs-mc-msg[data-msg-id="${safe}"]`)?.remove()
      }
    }
    // Track sub tenure from IRC badge-info
    if (msg.subMonths && msg.channel) {
      trackSubTenure(msg.channel, msg.user, msg.subMonths)
    }
    // Cache own badges for optimistic display. Per-channel + global mirror —
    // synthetic celebrations stamp the right sub badge tier when injected on
    // a channel where the user has previously sent at least once.
    if (isSelf(msg, 'twitch') && msg.badges) {
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
    // Filter rules: drop messages a hide rule matches. Own msgs exempt.
    const _frOwnTw = isSelf(msg, 'twitch')
    let _frTw = null
    if (!_frOwnTw) {
      _frTw = evaluateFilterRules(msg, getChannelLookup().twitch.get(msg.channel)?.id)
      if (_frTw.hide) return
    }
    // Highlight-rule audio cue — once, on live arrival (this path is live-only;
    // history replay doesn't reach here). Own/hidden already returned above.
    if (_frTw?.sound && typeof playFilterRuleSound === 'function') playFilterRuleSound(_frTw)
    // a highlight rule's "also notify me" lands in the mentions tab too, no login needed
    const _mentReal = isMention(msg)
    const _mentRule = !_mentReal && ruleAlertsMention(msg, _frTw)
    const isMent = _mentReal || _mentRule
    bumpStreamStats(msg.channel, msg, _mentReal)
    if (isMent) {
      mentionsBuffer.push(msg)
      if (mentionsBuffer.length > MAX_BUFFER + 50) mentionsBuffer.splice(0, mentionsBuffer.length - MAX_BUFFER)
      persistMentions()
      notifyMention(msg, _mentRule)
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
    chatLogsLive(msg)
    // Record Kick mod-action notices into the mod-action log (no-op otherwise).
    modLogStore.record(msg)
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
    // queueKickNameToCosmetics (kickNameResolved/pending). msg.userId is
    // the raw numeric kick id (pusher/relay) — threading it through skips
    // the kick.com username→id lookup on the hot per-message path.
    if (msg.user) queueKickNameToCosmetics(msg.user, msg.userId || null)
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
    const _frOwnKi = isSelf(msg, 'kick')
    let _frKi = null
    if (!_frOwnKi) {
      _frKi = evaluateFilterRules(msg, getChannelLookup().kick.get(msg.channel)?.id)
      if (_frKi.hide) return
    }
    // Highlight-rule audio cue — once, on live kick arrival.
    if (_frKi?.sound && typeof playFilterRuleSound === 'function') playFilterRuleSound(_frKi)
    // a highlight rule's "also notify me" lands in the mentions tab too, no login needed
    const _mentReal = isMention(msg)
    const _mentRule = !_mentReal && ruleAlertsMention(msg, _frKi)
    const isMent = _mentReal || _mentRule
    bumpStreamStats(msg.channel, msg, _mentReal)
    if (isMent) {
      mentionsBuffer.push(msg)
      if (mentionsBuffer.length > MAX_BUFFER + 50) mentionsBuffer.splice(0, mentionsBuffer.length - MAX_BUFFER)
      persistMentions()
      notifyMention(msg, _mentRule)
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

  // One go-live arrives as stream:update (the game, no previous one)
  // plus stream:online ("went live — X"). Pair them per channel (shared with
  // the site, see createGoLivePairing): the go-live shows, its starting-game
  // twin does not, and a real switch still passes straight through.
  const withGoLivePairing = (type, handle) => {
    const pairing = createGoLivePairing({
      emit: (_channel, kind, e) => {
        if (kind === 'update') handle(e)
      },
    })
    return (msg) => {
      const channel = msg.type === type ? msg.channel?.toLowerCase() : null
      if (channel) {
        if (msg.eventType === 'stream:update') return pairing.update(channel, msg)
        if (msg.eventType === 'stream:online') pairing.online(channel, msg)
        else if (msg.eventType === 'stream:offline') pairing.offline(channel)
      }
      return handle(msg)
    }
  }

  // Handle stream events (game switch, online/offline) from HeatSync WS
  if (!_onceGuardsMain.streamEventListener) {
    _onceGuardsMain.streamEventListener = true
    cleanup.addListener(
      chrome.runtime?.onMessage,
      withGoLivePairing('stream_event', (msg) => {
        if (msg.type !== 'stream_event') return
        const channel = msg.channel?.toLowerCase()
        if (!channel) return

        // Build inline notification
        let text = '',
          eventClass = ''
        if (msg.eventType === 'stream:update' && streamEventBody('update', msg)) {
          if (!hermesToggles?.gameSwitch) return
          text = `[${channel}] \u25C6 ${streamEventBody('update', msg)}`
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
          text = `[${channel}] \u25C6 ${streamEventBody('online', msg)}`
          eventClass = 'event-online'
        } else if (msg.eventType === 'stream:offline') {
          sessionWentLiveSeen.delete(channel) // genuine re-go-live can resurface
          try {
            markStreamEnded(channel)
          } catch (_) {}
          if (!hermesToggles?.offline) return
          text = `[${channel}] \u25C6 ${streamEventBody('offline', msg)}`
          eventClass = 'event-offline'
        } else if (msg.eventType === 'stream:redeem') {
          if (!hermesToggles?.redeem) return
          text = `\u25C6 ${t('mc_main_ev_redeemed', [String(msg.title ?? '')])}`
          if (msg.cost) text += ` (${msg.cost})`
          eventClass = 'event-redeem'
        } else if (msg.eventType === 'stream:raid') {
          if (!hermesToggles?.raid) return
          text = `[${channel}] \u25C6 ${t('mc_main_ev_raid_out', [String(msg.target ?? ''), String(msg.viewers || 0)])}`
          eventClass = 'event-raid'
        } else if (msg.eventType === 'stream:raid-in') {
          if (!hermesToggles?.raid) return
          text = `[${channel}] \u25C6 ${t('mc_main_ev_raid_in', [String(msg.from ?? ''), String(msg.viewers || 0)])}`
          eventClass = 'event-raid'
        } else if (msg.eventType === 'stream:poll-start') {
          if (!hermesToggles?.poll) return
          text = `[${channel}] \u25C6 ${msg.title ? t('mc_main_ev_poll_titled', [String(msg.title)]) : t('mc_main_ev_poll')}`
          eventClass = 'event-poll'
        } else if (msg.eventType === 'stream:hype-start') {
          if (!hermesToggles?.hype) return
          text = `[${channel}] \u25C6 ${t('mc_main_ev_hype_start')}`
          eventClass = 'event-hype'
        } else if (msg.eventType === 'stream:hype-end') {
          if (!hermesToggles?.hype) return
          text = `[${channel}] \u25C6 ${t('mc_main_ev_hype_end', [String(msg.level || 0)])}`
          eventClass = 'event-hype'
        } else if (msg.eventType === 'stream:sub-gift') {
          if (!hermesToggles?.sub) return
          text = `[${channel}] \u25C6 ${t('mc_main_ev_gifted_subs', [String(msg.user ?? ''), String(msg.count || 0)])}`
          eventClass = 'event-sub'
        }
        if (!text) return

        // Dedup: skip if same event was shown in last 60s. Key by channel too —
        // redeem text carries no channel, so a global text key would drop an
        // identical reward redeemed in a different channel as a false duplicate.
        const now = Date.now()
        const dedupKey = `${channel}\0${text}`
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
        const evt = {
          type: 'stream-event',
          eventClass,
          text,
          channel,
          actor,
          time: Date.now(),
          color: msg.color || '',
          userId: streamEventUserId(msg.platform, msg.userId),
          ...eventPlatformField(msg.platform),
        }

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
          if (!existing.some((m) => m.type === 'stream-event' && m.text === evt.text && !m.histWentLive)) {
            liveBuffer.push(evt)
            saveStreamEvent(evt)
          }
        }

        // Also push into the matching channel buffer if different from live
        if (channel !== liveChannel) {
          const chBuffer = irc?.channels?.get(channel) || kickChat?.channels?.get(channel)
          if (chBuffer) {
            const existing = chBuffer.getAll()
            if (!existing.some((m) => m.type === 'stream-event' && m.text === evt.text && !m.histWentLive)) {
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
      }),
    )
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
        text = `[${channel}] \u25C6 ${t('mc_main_ev_raid_out', [String(data.target ?? ''), String(Number(data.viewers) || 0)])}`
      } else if (eventType === 'hype-train-start') {
        toggleKey = 'hype'
        eventClass = 'event-hype'
        text = `[${channel}] \u25C6 ${t('mc_main_ev_hype_start')}`
        if (typeof onHypeTrainStart === 'function') onHypeTrainStart(data.level)
      } else if (eventType === 'hype-train-end') {
        toggleKey = 'hype'
        eventClass = 'event-hype'
        text = `[${channel}] \u25C6 ${t('mc_main_ev_hype_end', [String(Number(data.level) || 0)])}`
        if (typeof onHypeTrainEnd === 'function') onHypeTrainEnd()
      } else if (eventType === 'sub-gift') {
        toggleKey = 'sub'
        eventClass = 'event-sub'
        text = `[${channel}] \u25C6 ${t('mc_irc_gift_subs', [String(data.user ?? ''), String(Number(data.count) || 0), channel])}`
      } else if (eventType === 'redeem') {
        toggleKey = 'redeem'
        eventClass = 'event-redeem'
        text = `\u25C6 ${t('mc_main_ev_redeemed', [String(data.title ?? '')])}`
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
              eventType === 'pin'
                ? (pinBy ? t('mc_main_ev_pinned_by', [pinBy, pinText]) : t('mc_main_ev_pinned', [pinText])).trim()
                : t('mc_main_ev_unpinned'),
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
        text = `[${channel}] ◆ ${data?.title ? t('mc_main_ev_pred_titled', [String(data.title)]) : t('mc_main_ev_pred')}`
      } else if (eventType === 'poll-start') {
        toggleKey = 'poll'
        eventClass = 'event-poll'
        text = `[${channel}] ◆ ${data?.title ? t('mc_main_ev_poll_titled', [String(data.title)]) : t('mc_main_ev_poll')}`
      } else return

      if (!hermesToggles[toggleKey]) return

      const actor = eventType === 'redeem' ? data.user : null
      const evt = { type: 'stream-event', eventClass, text, channel, actor, time: Date.now() }

      // Push into relevant buffers — only the channel the event belongs to
      const liveChannel = getLiveChannel()
      const chBuffer = irc?.channels?.get(channel)
      if (chBuffer) {
        const existing = chBuffer.getAll()
        if (!existing.some((m) => m.type === 'stream-event' && m.text === evt.text && !m.histWentLive)) {
          chBuffer.push(evt)
          saveStreamEvent(evt)
        }
      }
      // Also push into live buffer if this event's channel IS the live channel
      if (channel === liveChannel) {
        const liveBuffer = irc?.channels?.get(liveChannel)
        if (liveBuffer && liveBuffer !== chBuffer) {
          const existing = liveBuffer.getAll()
          if (!existing.some((m) => m.type === 'stream-event' && m.text === evt.text && !m.histWentLive)) {
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
    cleanup.addListener(
      chrome.runtime?.onMessage,
      withGoLivePairing('follow_stream_event', (msg) => {
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
        if (msg.eventType === 'stream:update' && streamEventBody('update', msg)) {
          if (!hermesToggles?.gameSwitch) return
          text = `[${channel}] \u25C6 ${streamEventBody('update', msg)}`
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
          const _alreadyLive = isChannelLive(channel)
          const _inGrace = Date.now() - mcStartedAt < 90000
          sessionWentLiveSeen.add(channel)
          // The service worker already vetted it as a real off->on transition
          // (msg.fresh) — and its snapshot broadcast lands just before this
          // event, so _alreadyLive is true for EVERY genuine go-live. Only an
          // unvetted event (older worker) falls back on the guesses above.
          if (!msg.fresh && (_alreadyLive || _inGrace)) return
          text = `[${channel}] \u25C6 ${streamEventBody('online', msg)}`
          eventClass = 'event-follow event-online'
        } else if (msg.eventType === 'stream:offline') {
          sessionWentLiveSeen.delete(channel) // genuine re-go-live can resurface
          if (!hermesToggles?.offline) return
          text = `[${channel}] \u25C6 ${streamEventBody('offline', msg)}`
          eventClass = 'event-follow event-offline'
        }
        if (!text) return

        // Dedup: skip if same text was shown in last 60s (same dedup map as stream_event)
        const now = Date.now()
        if (streamEventDedup.has(text) && now - streamEventDedup.get(text) < 60000) return
        streamEventDedup.set(text, now)

        log('[FollowStream]', channel, text)
        notifyStreamEvent(channel, msg.eventType, msg.game, msg.platform)
        const evt = {
          type: 'stream-event',
          eventClass,
          text,
          channel,
          time: Date.now(),
          color: msg.color || '',
          userId: streamEventUserId(msg.platform, msg.userId),
          ...eventPlatformField(msg.platform),
        }

        // Push into the live channel buffer (dedup by text)
        const liveChannel = getLiveChannel()
        const liveBuffer = liveChannel ? irc?.channels?.get(liveChannel) : null
        if (liveBuffer) {
          const existing = liveBuffer.getAll()
          if (!existing.some((m) => m.type === 'stream-event' && m.text === evt.text && !m.histWentLive)) {
            liveBuffer.push(evt)
            saveStreamEvent(evt)
          }
        }

        // Also push into matching channel buffer if different from live
        if (channel !== liveChannel) {
          const chBuffer = irc?.channels?.get(channel)
          if (chBuffer) {
            const existing = chBuffer.getAll()
            if (!existing.some((m) => m.type === 'stream-event' && m.text === evt.text && !m.histWentLive)) {
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

        // A followed streamer going live / switching game is for whichever chat
        // you're reading, not just the streamer's own tab (you have none open —
        // that's why it's a follow event). The live tab already holds it via
        // liveBuffer; a channel tab needs it in its own buffer or the next
        // repaint drops the row.
        const activeTab = currentTab
        if (activeTab !== 'live') {
          const tabCh = getChannelById(activeTab)
          const tabBufs = [
            irc?.channels?.get(tabCh?.twitch?.toLowerCase()),
            kickChat?.channels?.get(tabCh?.kick?.toLowerCase()),
          ]
          for (const buf of tabBufs) {
            if (!buf || buf === liveBuffer) continue
            if (!buf.getAll().some((m) => m.type === 'stream-event' && m.text === evt.text && !m.histWentLive))
              buf.push(evt)
          }
        }
        if (!appendMessage(evt, activeTab)) renderMessages(activeTab)
      }),
    )
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
      if (e.type === 'follow:stream:update' && streamEventBody('update', e)) {
        if (!hermesToggles?.gameSwitch) continue
        text = `[${channel}] \u25C6 ${streamEventBody('update', e)}`
        eventClass = 'event-follow event-update'
      } else if (e.type === 'follow:stream:online') {
        if (!hermesToggles?.online) continue
        text = `[${channel}] \u25C6 ${streamEventBody('online', e)}`
        eventClass = 'event-follow event-online'
      } else if (e.type === 'follow:stream:offline') {
        if (!hermesToggles?.offline) continue
        text = `[${channel}] \u25C6 ${streamEventBody('offline', e)}`
        eventClass = 'event-follow event-offline'
      }
      if (!text) continue

      // Skip a row the realtime listeners just showed. Read-only: a replayed row
      // is old news, and marking its text seen would drop the real thing — the
      // server replays history on every connect, so yesterday's "went live —
      // World of Warcraft" landed a second before today's identical one and ate it.
      if (streamEventDedup.has(text) && now - streamEventDedup.get(text) < 60000) continue

      const evt = {
        type: 'stream-event',
        eventClass,
        text,
        channel,
        time: e.time,
        color: e.color || '',
        userId: streamEventUserId(e.platform, e.userId),
        ...eventPlatformField(e.platform),
      }
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
        browser.runtime.sendMessage({ type: 'youtube_ws_unsubscribe', channelId }).catch(() => {})
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
      browser.runtime.sendMessage({ type: 'ping' }).catch(() => {
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
        bootSwitch()
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
    // Platform app root when one exists (#root twitch, #__next kick) is a
    // stable ancestor present well before this call, and narrower than
    // documentElement — youtube has neither, so it falls back to body,
    // still narrower than documentElement (no <head> mutation noise).
    const mountRoot = document.getElementById('root') || document.getElementById('__next') || document.body
    obs.observe(mountRoot, { childList: true, subtree: true })
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
      bootSwitch()
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
    // Kick mounts only on a channel / chatroom / popout route (allowlist in
    // src/lib/reserved-paths.js). Everything else — oauth, settings, browse,
    // the home page — gets no overlay. A later SPA nav onto a channel finds
    // no container and re-inits through fullSpaReinit.
    if (!isKickChannelRoute(location.pathname)) {
      log('Kick non-channel route, no overlay:', location.pathname)
    } else if (document.body.classList.contains('hs-popout')) {
      _runOverlayMountPass('kick popout body-mount', () => {
        ensureUIElements()
        bootSwitch()
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
        bootSwitch()
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
        bootSwitch()
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
        bootSwitch()
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
      if (RESERVED_PATHS.has(slug)) return
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

// SPA nav detection + full re-init glue — split out of main.js (2026-07-04).
// handleMcNav (path/search-change detection, dispatches to soft-nav per
// platform) + fullSpaReinit (destroy+rebuild fallback path). The listener
// registrations that DRIVE these (message listener, yt-navigate-finish,
// Kick pre-emptive migrate, the init()-body mount branching, and the
// STARTUP trigger) stay in main.js — too interwoven with boot glue to cut
// cleanly; only the two self-contained nav/reinit functions moved.

// SPA navigation handler — event-driven via early-inject-main.js history hooks
let lastPath = location.pathname
// For YT: /watch?v=A → /watch?v=B keeps the same pathname so we also track
// the full search string to catch video-to-video hops.
let lastSearch = location.search
let spaReinitializing = false
// softTwitchNav moved to twitch-host.js (platform module)

// softKickNav moved to kick-host.js (platform module)

function handleMcNav() {
  // On YouTube, /watch?v=A → /watch?v=B keeps the same pathname — detect
  // the video change via the `v` param so the YT soft-nav block runs and
  // swaps the WS subscription to the new video. YT-only: Twitch (?t=, clip
  // params) and Kick (?category=) churn search via replaceState without a
  // channel change — comparing search there would fire spurious soft-navs
  // (part+join on the live channel) on every param flip.
  //
  // Compare only `v`, not the full search string: YouTube's own &pp=/&list=/
  // &index= replaceState churn (autoplay tracking, playlist position) fires
  // mid-stream on the SAME video and was triggering a full unsub/resub loop —
  // a dropped WS subscription is worse than a missed reinit.
  const newSearch = location.search
  const sameVideo = hostPlatform !== 'yt' || ytSameVideoSearch(newSearch, lastSearch)
  if (location.pathname === lastPath && sameVideo) return
  // Bug #3: capture the old live channel before updating lastPath so
  // soft-nav can part it and avoid an unbounded irc.channels accumulation.
  // NON_CHANNEL_PATHS filter mirrors getCurrentChannel — without it a nav
  // away from /settings would call irc.part('settings').
  const prevLiveCh = (() => {
    try {
      const m = lastPath.match(/^\/(?:popout\/|embed\/)?([a-zA-Z0-9_-]+)/)
      const slug = m?.[1]?.toLowerCase() || null
      return slug && !NON_CHANNEL_PATHS.has(slug) ? slug : null
    } catch {
      return null
    }
  })()
  lastPath = location.pathname
  lastSearch = newSearch
  log('Navigation detected, reinitializing...')
  // Re-evaluate body-mount overlay state for the new URL before teardown so
  // CSS rules flip ahead of the panel reappearing on the new page.
  try {
    updateTwitchNoChannelClass()
  } catch (_) {}
  if (isKick) {
    try {
      updateKickNoChannelClass()
    } catch (_) {}
  }

  // Twitch SPA nav: skip the destroy+rebuild path entirely. The panel
  // (and IRC, and feed state) all survive intact — see softTwitchNav.
  // Popout chat is exempt since it never SPA-navigates between URLs.
  if (hostPlatform === 'twitch' && !document.body.classList.contains('hs-popout')) {
    softTwitchNav(prevLiveCh)
    return
  }

  // Kick SPA nav: same soft path as Twitch. Panel + kickChat persist;
  // body class refreshes for the new URL.
  if (isKick && !document.body.classList.contains('hs-popout')) {
    softKickNav(prevLiveCh)
    return
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
    document.body.classList.add('hs-mc-navigating')
    // Unsubscribe the auto-YT route for the previous page so the new
    // page gets a clean __live_yt_auto__ binding (videoId differs).
    // Capture videoId/url BEFORE nulling — the BG needs at least one of them
    // to send the server-side youtube:unsubscribe (channelId alone only
    // cleans local storage and leaves the old stream's poller running).
    const prevAutoVid = _autoYtVideoId
    const prevAutoUrl = ytSubscribedUrls.get('__live_yt_auto__')
    chrome.runtime
      .sendMessage({
        type: 'youtube_ws_unsubscribe',
        channelId: '__live_yt_auto__',
        videoId: prevAutoVid || '',
        url: prevAutoUrl || '',
      })
      .catch(() => {})
    clearYtPace('__live_yt_auto__')
    channelYtMessages.delete('__live_yt_auto__')
    // Bug #2: clear the watchdog entry for the old video so the 30s
    // interval does not keep force-reconnecting a subscription that no
    // longer exists (ended stream re-subscribe loop).
    ytChanLastSeen.delete('__live_yt_auto__')
    ytChanRejoinAttempts.delete('__live_yt_auto__')
    ytSubscribedUrls.delete('__live_yt_auto__')
    _autoYtVideoId = null
    // Re-arm for the NEW page. Teardown above without this left SPA-nav into
    // a live stream (channel page → click live) with the stream playing and a
    // dead multichat until a hard refresh — init() only auto-subscribes on
    // full page load. Delay one tick so location reflects the completed nav.
    cleanup.setTimeout(
      () => {
        try {
          autoYtSubscribeForPage()
        } catch (_) {}
      },
      50,
      'yt-soft-nav-resub',
    )
    // Re-apply layout so destructive overrides re-evaluate against the
    // new pathname (watch ↔ home).
    try {
      applyChatPosition()
    } catch {}
    try {
      applyYouTubeChatWidth()
    } catch {}
    // Nudge YT's responsive code so it recomputes --ytd-rich-grid-width
    // and #primary widths against the new page. Without this the home
    // grid stays clamped at the previous page's width until the user
    // wiggles the resize handle.
    try {
      window.dispatchEvent(new Event('resize'))
    } catch {}
    // Resume sticky-bottom on the persistent panel — without this the new
    // page inherits whatever scroll position the previous video left.
    isScrolledUp = false
    newMessageCount = 0
    const newBtn = document.getElementById('hs-mc-new-msgs')
    if (newBtn) newBtn.style.display = 'none'
    const msgsEl = document.getElementById('hs-mc-messages')
    if (msgsEl)
      try {
        scrollMsgsToBottom(msgsEl)
      } catch (_) {}
    cleanup.setTimeout(
      () => {
        document.body.classList.remove('hs-mc-navigating')
      },
      300,
      'yt-soft-nav-release',
    )
    return
  }

  fullSpaReinit()
}

// Full destroy+rebuild SPA path — shared by handleMcNav's fallback branch
// and softKickNav's null-container recovery so both tear down identically.
function fullSpaReinit() {
  // Flag prevents layout watcher from re-injecting elements we're about to remove
  spaReinitializing = true
  _layoutWatcherStarted = false

  // Every cached tab DOM belongs to the channel we're leaving. The soft-nav
  // paths drop the live cache before switching, but they hand off to this
  // fallback BEFORE reaching that call — without this, init()'s closing
  // switchTab() splices the previous channel's rows into the new channel's
  // freshly built list (and _cacheJustRestored tells the renderer to leave
  // them alone), so two channels' chat render interleaved.
  try {
    _dropAllTabCaches()
  } catch {}

  // Unsubscribe auto-YouTube from previous channel AND every per-channel
  // YT subscription so init() can cleanly re-subscribe each. Otherwise the
  // server sees duplicate youtube:subscribe events on every SPA navigation
  // and may re-deliver buffered messages.
  // Capture videoId/url BEFORE nulling — the BG needs at least one of them
  // to send the server-side youtube:unsubscribe (channelId alone only
  // cleans local storage and leaves the old stream's poller running).
  const prevAutoVid = _autoYtVideoId
  const prevAutoUrl = ytSubscribedUrls.get('__live_yt_auto__')
  chrome.runtime
    .sendMessage({
      type: 'youtube_ws_unsubscribe',
      channelId: '__live_yt_auto__',
      videoId: prevAutoVid || '',
      url: prevAutoUrl || '',
    })
    .catch(() => {})
  clearYtPace('__live_yt_auto__')
  channelYtMessages.delete('__live_yt_auto__')
  // Bug #2: clear watchdog entries for all unsubscribed YT channels so
  // the 30s watchdog doesn't keep force-reconnecting dead subscriptions.
  ytChanLastSeen.delete('__live_yt_auto__')
  ytChanRejoinAttempts.delete('__live_yt_auto__')
  ytSubscribedUrls.delete('__live_yt_auto__')
  _autoYtVideoId = null
  for (const ch of config.channels) {
    if (!ch.youtube) continue
    const link = youtubeLinks.get(ch.id)
    chrome.runtime
      .sendMessage({
        type: 'youtube_ws_unsubscribe',
        channelId: ch.id,
        url: ch.youtube,
        videoId: link?.videoId || '',
      })
      .catch(() => {})
    clearYtPace(ch.id)
    youtubeLinks.delete(ch.id)
    ytChanLastSeen.delete(ch.id)
    ytChanRejoinAttempts.delete(ch.id)
    ytSubscribedUrls.delete(ch.id)
  }

  // Close old read-only IRC to prevent zombie WebSocket reconnect loops
  // NOTE: auth IRC (for sending) is NOT killed here — it survives SPA navigation
  if (irc) {
    irc.destroy()
  }
  irc = null

  // Destroy old KickChat to prevent stale message listeners
  if (kickChat) {
    kickChat.destroy()
    kickChat = null
  }

  // Clean up — remove entire container (our elements are inside it)
  document.getElementById('hs-mc-container')?.remove()
  tabBarElement = null
  overlayElement = null
  inputBarElement = null
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  // Disconnect all tracked observers from previous channel to prevent accumulation
  _timers.observers.forEach((o) => {
    try {
      o.disconnect()
    } catch {}
  })
  _timers.observers.length = 0
  // Drain per-channel intervals/timeouts too. init() unconditionally re-registers
  // its pollers (offline 5s/1s, YT-live 1.5s, kick 10s, YT watchdog 30s, ctx-death
  // 1s, layout reinject 500ms) on every reinit; without this they stack one full
  // live set per channel hop and never stop firing (unbounded leak). Persistent
  // ids (module-load registrations: bootstrap's ctx-death detector, emotes'
  // DOM-scan poller) are kept — they're not re-registered by init(). The
  // spa-reinit setTimeout below is registered AFTER this drain, so it survives.
  _timers.intervals = _timers.intervals.filter((id) => {
    if (_timers.persistent.has(id)) return true
    try {
      clearInterval(id)
    } catch {}
    return false
  })
  _timers.timeouts = _timers.timeouts.filter((id) => {
    if (_timers.persistent.has(id)) return true
    try {
      clearTimeout(id)
    } catch {}
    return false
  })
  // Null the sentinels whose observers/timers were just disconnected/cleared
  // above. Their "already running" guards (if (columnObserver) return,
  // if (!mcCosmeticsTimer), if (_persistMentionsState.timer) return, etc.)
  // would otherwise stay truthy forever, so after the first channel switch
  // the column watcher, 7TV cosmetics flush, mention/YT persistence, and
  // resub-callout observer are never recreated. dirty Sets are intentionally
  // kept — the next message reschedules a flush that still includes pre-nav data.
  columnObserver = null
  _hsCalloutCloseObs = null
  mcCosmeticsTimer = null
  _persistMentionsState.timer = null
  _persistYtTimers.clear()
  _persistTabSeenTimer = null
  mcInitialized = false // Allow init() to run again

  // Reset social tab state (stale on nav)
  feedLoaded = false
  feedLoading = false
  feedMessages = []
  feedPage = 1
  feedHasMore = true
  feedLastFetch = 0
  activeThread = null
  _autoYtVideoId = null
  // Reset feed scroll listener flag (new DOM element)
  const oldMsgs = document.getElementById('hs-mc-messages')
  if (oldMsgs) oldMsgs._hsFeedScroll = false

  // Reinitialize after short delay
  cleanup.setTimeout(
    () => {
      spaReinitializing = false
      init()
    },
    1000,
    'spa-reinit',
  )
}

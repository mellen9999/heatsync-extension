// Twitch host UI/nav — extracted from main.js (bundled into twitch bundle only)

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
  const pp = hsQuery('twitch:persistent-player', '.persistent-player')
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
    try {
      applyPlatformPositionOverrides()
    } catch (_) {}
    return
  }
  if (theatreMode) return
  // Offline channel: Twitch shows a small recommended-VOD PiP mini-player
  // (~185×104) on the channel-home page. Pinning it top:0/left:0 makes it
  // float awkwardly in the corner instead of where Twitch positioned it.
  // Skip pinning when .channel-root--home is present.
  if (hsQuery('twitch:channel-root-home', '.channel-root--home')) {
    // Also clear any prior pin we may have applied before going offline.
    if (pp.style.top === '0px' || pp.style.left === '0px') {
      pp.style.removeProperty('top')
      pp.style.removeProperty('left')
    }
    return
  }
  // Browsing away from a live stream (e.g. clicking Browse/Following) puts
  // .persistent-player into Twitch's floating mini-player mode — no
  // .channel-root is present. Pinning top:0/left:0 breaks the mini-player
  // corner position; clear any stale overrides and let Twitch own it.
  if (!hsQuery('twitch:channel-root', '.channel-root, [class*="channel-root"]')) {
    if (pp.style.top === '0px') pp.style.removeProperty('top')
    if (pp.style.left === '0px') pp.style.removeProperty('left')
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
    if (_ttvPpStyleObserver) {
      try {
        cleanup.untrackObserver(_ttvPpStyleObserver)
      } catch (_) {}
      _ttvPpStyleObserver = null
    }
    _ttvPpStyleObserver = new MutationObserver(() => {
      if (chatPosition !== 'right' || theatreMode) return
      // Same offline guard inside the style observer — Twitch's React may
      // re-render mid-session (live → offline) and we'd otherwise re-pin.
      if (hsQuery('twitch:channel-root-home', '.channel-root--home')) return
      // Same mini-player guard as the mount path: browsing away from a live
      // stream floats the player bottom-right with Twitch's own top offset
      // (> 200px by design). Re-pinning it here shoved the mini-player above
      // the viewport, putting its close button out of reach. Clear any pin
      // we already applied so the float lands where Twitch wants it.
      if (!hsQuery('twitch:channel-root', '.channel-root, [class*="channel-root"]')) {
        if (pp.style.top === '0px') pp.style.removeProperty('top')
        if (pp.style.left === '0px') pp.style.removeProperty('left')
        return
      }
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
    if (_ttvPpDetachObs) {
      try {
        cleanup.untrackObserver(_ttvPpDetachObs)
      } catch (_) {}
      _ttvPpDetachObs = null
    }
    const pp = _ttvPpLastSeen
    const parent = pp?.parentElement
    if (!parent) {
      armBodyWatch()
      return
    }
    _ttvPpDetachObs = new MutationObserver(() => {
      if (pp?.isConnected) return
      try {
        cleanup.untrackObserver(_ttvPpDetachObs)
      } catch (_) {}
      _ttvPpDetachObs = null
      _ttvPpLastSeen = null
      armBodyWatch()
    })
    _ttvPpDetachObs.observe(parent, { childList: true })
    cleanup.trackObserver(_ttvPpDetachObs)
  }
  function armBodyWatch() {
    if (_ttvPpObserver) {
      try {
        cleanup.untrackObserver(_ttvPpObserver)
      } catch (_) {}
    }
    _ttvPpObserver = new MutationObserver(() => {
      if (_ttvPpLastSeen?.isConnected) {
        try {
          cleanup.untrackObserver(_ttvPpObserver)
        } catch (_) {}
        armDetachWatch()
        return
      }
      if (_ttvPpRaf) return
      _ttvPpRaf = requestAnimationFrame(() => {
        _ttvPpRaf = 0
        pinTwitchPersistentPlayer()
        if (_ttvPpLastSeen?.isConnected) {
          try {
            cleanup.untrackObserver(_ttvPpObserver)
          } catch (_) {}
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

// It auto-expands on wide viewports (>~1200px), and the user can also
// toggle it. chat-left layout subtracts this width from chatWidth to land
// the player flush with the HS panel — so the live value must be tracked,
// not assumed. Pushes --hs-twitch-sidenav-w for the CSS rules to consume,
// and re-runs applyPlatformPositionOverrides so JS-side arithmetic
// (persistent-player inset, channel-root padding) updates too.
function updateTwitchSideNavWidth() {
  if (hostPlatform !== 'twitch') return
  const nav = hsQuery('twitch:side-nav', '.side-nav')
  const w = nav?.getBoundingClientRect?.().width
  const next = w && w > 0 ? Math.round(w) : TWITCH_SIDE_NAV_WIDTH
  if (next === _twitchSideNavW) return
  _twitchSideNavW = next
  document.documentElement.style.setProperty('--hs-twitch-sidenav-w', `${next}px`)
  if (chatPosition === 'left') {
    try {
      applyPlatformPositionOverrides()
    } catch (_) {}
  }
}

let _twitchTopNavObs = null
// Twitch's top nav (.top-nav) is 50px tall and lives in a sibling DOM tree
// that paints above HS's chat container — even though HS has z-index 9999,
// the chat container is trapped inside .channel-root__right-column's z=1
// stacking context. Fight: don't compete on z-index, just offset chat down
// by the nav height when chat docks left/top so the rotate buttons aren't
// hidden under Following/Browse. Theatre mode hides .top-nav (height = 0),
// so the offset auto-collapses and chat reclaims the full viewport.
function updateTwitchTopNavHeight() {
  if (hostPlatform !== 'twitch') return
  const nav = hsQuery('twitch:top-nav', '.top-nav')
  let h = 0
  if (nav) {
    const r = nav.getBoundingClientRect()
    // height>0 AND visible — theatre mode collapses to 0 via display:none
    h = r.height > 0 && getComputedStyle(nav).display !== 'none' ? Math.round(r.height) : 0
  }
  if (h === _twitchTopNavH) return
  _twitchTopNavH = h
  document.documentElement.style.setProperty('--hs-twitch-topnav-h', `${h}px`)
  if (chatPosition === 'left' || chatPosition === 'top') {
    try {
      applyPlatformPositionOverrides()
    } catch (_) {}
  }
}

function setupTwitchTopNavObserver() {
  if (hostPlatform !== 'twitch') return
  document.documentElement.style.setProperty('--hs-twitch-topnav-h', `${_twitchTopNavH}px`)
  if (_twitchTopNavObs) {
    try {
      _twitchTopNavObs.disconnect()
    } catch (_) {}
    _twitchTopNavObs = null
  }
  const nav = hsQuery('twitch:top-nav', '.top-nav')
  if (nav && typeof ResizeObserver !== 'undefined') {
    _twitchTopNavObs = new ResizeObserver(() => updateTwitchTopNavHeight())
    _twitchTopNavObs.observe(nav)
    cleanup.trackObserver(_twitchTopNavObs)
  }
  updateTwitchTopNavHeight()
}

// Twitch SPA nav: zero-flicker soft refresh. Pre-emptively migrate the
// panel to <body> so twitch's chat-shell teardown doesn't take it down,
// refresh the body class for the new URL, and (if the new page is a
// channel page) reparent into the freshly-mounted chat-shell once it
// appears. IRC, kickChat, observers, feed state — none of it gets
// destroyed, so the visible panel keeps showing live messages without
// a single empty frame.
function softTwitchNav(prevLiveCh) {
  let container = document.getElementById('hs-mc-container')
  // Twitch commits the chat-shell unmount BEFORE pushState on channel →
  // /directory style transitions — by the time the nav event fires the panel
  // is already detached and getElementById can't see it. The module reference
  // still holds the live node (feed state, IRC, scroll pos intact): re-adopt
  // it onto body so this nav behaves like the normal pre-emptive migrate.
  if (!container && typeof _hsMcContainerNode !== 'undefined' && _hsMcContainerNode) {
    container = _hsMcContainerNode
    document.body.appendChild(container)
  }
  if (!container) {
    // No panel and no reference (never mounted on this page) — rebuild from
    // scratch, mirroring softKickNav's null-container fallback.
    try {
      fullSpaReinit()
    } catch (_) {}
    return
  }
  // SPA nav changes the URL channel — only the LIVE tab cache becomes
  // stale (it follows getLiveChannel()). Per-channel tab caches stay
  // valid since their data is keyed by channel buffer, not URL.
  try {
    _dropTabCache('live')
  } catch {}
  try {
    rearmLiveYtAuto()
  } catch (_) {}
  // Mark body for the entire transition window so the CSS guard hides any
  // native chat-shell children that paint during Twitch's teardown/remount.
  document.body.classList.add('hs-mc-navigating')
  // A player-geometry bail-out is scoped to the page it happened on: the new
  // channel gets a fresh player and deserves our layout back.
  try {
    resetPlayerGuard()
  } catch (_) {}
  // Step 1 — detach from doomed chat-shell ahead of twitch's teardown.
  if (container?.parentElement && container.parentElement !== document.body) {
    document.body.appendChild(container)
  }
  // Step 2 — flip CSS state to match the new URL's mount surface.
  try {
    updateTwitchNoChannelClass()
  } catch (_) {}

  // Step 3 — if the new page is a channel page, wait for its chat-shell to
  // mount, then reparent the panel back so theatre/persistent-player layout
  // continues to work. Single-shot observer; gives up after 4s on slow tabs.
  let done = false
  const finish = () => {
    // Re-apply hs-native-hidden to the new chat-shell + chat-room + stream-
    // chat. Without this the body.hs-mc-navigating guard would be the only
    // thing hiding native chat — once we drop that class native chat blooms.
    // Gated: skip re-hide when the user has chosen nativeVisible so they
    // keep native chat visible across SPA navigations.
    if (!nativeVisible)
      try {
        setNativeChatHidden(true)
      } catch (_) {}
    // Resume sticky-bottom on every channel switch — the panel persists
    // across SPA nav, so without this reset the new channel inherits the
    // previous channel's mid-scroll position and live messages stack
    // behind a "N new" pause indicator the user never asked for.
    isScrolledUp = false
    newMessageCount = 0
    _scrollbackWindow = 0 // new channel starts at the live tail
    // SPA nav changed the URL channel — re-join + repaint the live tab so the
    // new channel actually connects and renders. Without this the panel froze
    // on the previous channel until an unrelated render fired — a deadlock on
    // a quiet/offline target, the classic "broken or just needs a refresh?"
    // symptom. renderMessages('live') performs the lazy join itself.
    if (currentTab === 'live') {
      try {
        renderMessages('live')
      } catch (_) {}
    }
    const newBtn = document.getElementById('hs-mc-new-msgs')
    if (newBtn) newBtn.style.display = 'none'
    const msgsEl = document.getElementById('hs-mc-messages')
    if (msgsEl)
      try {
        scrollMsgsToBottom(msgsEl)
      } catch (_) {}
    // Join the new live channel so IRC delivers messages for it.
    // Without this the live tab shows nothing (and deadlocks on quiet
    // channels) because irc never subscribes to the new channel name.
    // Part the previous live channel first (Bug #3) so we don't accumulate
    // a 3000-msg CircularBuffer per visited channel over a long session.
    // Only part if it is not also a config-managed channel tab.
    try {
      const newCh = getCurrentChannel()?.toLowerCase()
      if (prevLiveCh && prevLiveCh !== newCh) {
        const isConfigCh = config.channels.some(
          (ch) => ch.twitch?.toLowerCase() === prevLiveCh || ch.kick?.toLowerCase() === prevLiveCh,
        )
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
      if (newCh && hostPlatform === 'twitch')
        try {
          startNativeTap(newCh)
        } catch (_) {}
      renderMessages('live')
    } catch (_) {}
    // Hold the nav guard for ~300ms so Twitch's render cycle + width
    // transitions on chat-shell ancestors complete entirely behind it.
    // Two rAFs (~32ms) was too short — the grey theme wrappers re-bled in
    // mid-transition. 300ms covers Twitch's full reflow on every machine
    // tested. Plus a chat-shell mutation observer continuously re-applies
    // hs-native-hidden in case React swaps the chat-room__content node.
    const reHide = new MutationObserver(() => {
      if (!nativeVisible)
        try {
          setNativeChatHidden(true)
        } catch (_) {}
    })
    const target = hsQuery('twitch:chat-shell', `.chat-shell, ${CONFIG.SELECTORS.TWITCH_CHAT_SHELL}`)
    if (target) {
      reHide.observe(target, { childList: true })
      cleanup.trackObserver(reHide)
    }
    cleanup.setTimeout(
      () => {
        cleanup.untrackObserver(reHide)
        document.body.classList.remove('hs-mc-navigating')
        // Bar tracks container.getBoundingClientRect — re-anchor now that the
        // container has moved out of its nav-guard fixed slot into chat-shell.
        try {
          positionChatResizeHandle()
        } catch (_) {}
      },
      300,
      'twitch-soft-nav-release',
    )
    // Twitch's right-column slide-in animation is 500ms. Re-check after it
    // settles so the clipped-chat detection in updateTwitchNoChannelClass
    // catches miniplayer→fullscreen layout breakage post-animation.
    cleanup.setTimeout(
      () => {
        try {
          updateTwitchNoChannelClass()
        } catch (_) {}
        try {
          positionChatResizeHandle()
        } catch (_) {}
      },
      700,
      'twitch-soft-nav-clipped-check',
    )
  }
  const tryReparent = () => {
    if (done) return true
    const chatShell = hsQuery('twitch:chat-shell', `.chat-shell, ${CONFIG.SELECTORS.TWITCH_CHAT_SHELL}`)
    const c = document.getElementById('hs-mc-container')
    if (chatShell && c && !chatShell.contains(c)) {
      chatShell.appendChild(c)
      try {
        updateTwitchNoChannelClass()
      } catch (_) {}
      done = true
      finish()
      return true
    }
    return false
  }
  if (tryReparent()) return
  const obs = new MutationObserver(() => {
    if (tryReparent()) cleanup.untrackObserver(obs)
  })
  obs.observe(document.documentElement, { childList: true, subtree: true })
  cleanup.trackObserver(obs)
  cleanup.setTimeout(
    () => {
      if (!done) {
        done = true
        cleanup.untrackObserver(obs)
        try {
          updateTwitchNoChannelClass()
        } catch (_) {}
        finish()
      }
    },
    4000,
    'twitch-soft-nav-finalize',
  )
}

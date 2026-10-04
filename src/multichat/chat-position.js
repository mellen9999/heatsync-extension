// chat dock position (C button), theatre-mode + platform side/top-nav tracking,
// scroll-wheel player volume, and the per-platform position overrides — split
// out of main.js (2026-10-04). pure move; loaded after resize.js (owns the
// TWITCH_SIDE_NAV_WIDTH / TWITCH_TOP_NAV_HEIGHT consts its lets read at load).

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
    // A no-channel page (directory/settings/search/…) with ZERO configured
    // chat tabs (no saved channels, no ephemeral auto-tabs from other open
    // browser tabs) has nothing to show — an empty 340px panel floating over
    // pure browsing, which is exactly the audit-1.7.75 finding. A user WITH
    // tabs keeps the real feature (watch your chats while browsing away from
    // them); only the genuinely-empty case hides.
    document.body.classList.toggle('hs-twitch-no-channel-empty', noChannel && config.channels.length === 0)
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

// YouTube host UI/nav — extracted from main.js (bundled into youtube bundle only)

// Compute the largest chat width that won't squash YouTube's video column.
// Bases on the watch-flexy container width (the actual flex-row that holds
// primary + secondary) when available, falling back to viewport. Keeps a
// YT_MIN_PRIMARY_WIDTH gutter for the player.
function getYtMaxChatWidth() {
  if (hostPlatform !== 'yt') return MAX_CHAT_WIDTH
  const flexy = hsQuery('yt:watch-flexy', 'ytd-watch-flexy:not([hidden])')
  const flexyW = flexy?.getBoundingClientRect?.().width || 0
  const vw = window.innerWidth || document.documentElement.clientWidth || 1280
  const available = flexyW > 0 ? Math.min(flexyW, vw) : vw
  return Math.max(MIN_CHAT_WIDTH, Math.min(MAX_CHAT_WIDTH, available - YT_MIN_PRIMARY_WIDTH))
}

// Re-apply layout whenever YT toggles theater/fullscreen so we release or
// restore our width overrides at the right moment.
function watchYtLayoutAttrs() {
  if (hostPlatform !== 'yt') return
  const flexy = hsQuery('yt:watch-flexy', 'ytd-watch-flexy:not([hidden])')
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
  if (hsQuery('yt:watch-flexy', 'ytd-watch-flexy:not([hidden])')) return // already there
  _ytFlexyMountObs = new MutationObserver(() => {
    if (!hsQuery('yt:watch-flexy', 'ytd-watch-flexy:not([hidden])')) return
    cleanup.untrackObserver(_ytFlexyMountObs)
    _ytFlexyMountObs = null
    try {
      applyChatPosition()
    } catch {}
    try {
      applyYouTubeChatWidth()
    } catch {}
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
      try {
        applyPlatformPositionOverrides()
      } catch {}
      // Re-run full layout reflow — viewport change (WM fullscreen, devtools
      // toggle, browser zoom) needs every position-dependent piece updated.
      // The orange resize bar uses inline px from container.getBoundingClientRect
      // and goes stale; the tab/input bars follow via _updateMcLayout's
      // ResizeObserver but only when the bars themselves resize, which doesn't
      // fire on pure viewport changes. Cheap calls — all early-bail when nothing
      // to reposition.
      try {
        positionChatResizeHandle()
      } catch {}
      try {
        _updateMcLayout()
      } catch {}
    }, 80)
  }
  window.addEventListener('resize', onResize, { signal: mcSignal })
}

/**
 * Setup resize handle for YouTube — left edge of #secondary sidebar
 */
function setupYouTubeResizeHandle() {
  const secondary = hsQuery('yt:secondary', '#secondary, ytd-watch-flexy #secondary')
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
    if (ghost) ghost.style.width = `${pendingWidth}px`
  }

  handle.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0) return
      isResizing = true
      activePointerId = e.pointerId
      try {
        handle.setPointerCapture(e.pointerId)
      } catch (_) {}
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
    },
    { signal: mcSignal },
  )

  handle.addEventListener(
    'pointermove',
    (e) => {
      if (!isResizing || e.pointerId !== activePointerId) return
      const delta = startX - e.clientX
      // Use the viewport-aware cap so a small window can't be dragged past the
      // point where the video column gets crushed.
      const ytMax = getYtMaxChatWidth()
      pendingWidth = Math.min(ytMax, Math.max(MIN_CHAT_WIDTH, startWidth + delta))
      if (!rafId) rafId = requestAnimationFrame(applyResize)
    },
    { signal: mcSignal },
  )

  function endDrag(e) {
    if (!isResizing || (e && e.pointerId !== activePointerId)) return
    isResizing = false
    activePointerId = -1
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    chatWidth = pendingWidth || chatWidth
    if (ghost) {
      ghost.remove()
      ghost = null
    }
    applyYouTubeChatWidth()
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    if (overlay) {
      overlay.remove()
      overlay = null
    }
    // Force YT's IMA SDK + html5 player to re-measure so a mid-ad resize
    // doesn't leave the ad video at its pre-drag dimensions.
    try {
      window.dispatchEvent(new Event('resize'))
    } catch (_) {}
    saveChatWidth()
  }
  handle.addEventListener('pointerup', endDrag, { signal: mcSignal })
  handle.addEventListener('pointercancel', endDrag, { signal: mcSignal })

  loadChatWidth().then(() => {
    applyYouTubeChatWidth()
  })
  loadChatHeight()
  watchYtViewportClamp()
  watchYtLayoutAttrs()
  watchYtFlexyMount()
}

// YT reflow: a ResizeObserver on #movie_player keeps --hs-yt-below-top in sync
// with the real video bottom. The rAF-based set in applyPlatformPositionOverrides
// is racy on fresh load (the player gets its size after our last run), leaving
// #below pinned at the fallback top over the video. The observer fires whenever
// the player sizes/resizes, so the var is always correct. Re-observes on SPA nav.
let _hsYtBelowRO = null,
  _hsYtBelowEl = null,
  _hsYtBelowPoll = null
// Clear any inline height we forced onto the full-bleed containers so YT's own
// layout takes back over (leaving theatre, hiding the panel, fullscreen).
function _hsClearYtFullBleed() {
  for (const sel of ['#full-bleed-container', '#player-full-bleed-container']) {
    const el = document.querySelector(sel)
    if (el?.style.height) el.style.removeProperty('height')
  }
}
function _hsSetYtBelowTop() {
  // Panel hidden (non-live, no opt-in) or non-side chat → hand layout back to YT.
  if (document.body.classList.contains('hs-offline') || (chatPosition !== 'left' && chatPosition !== 'right')) {
    document.documentElement.style.removeProperty('--hs-yt-below-top')
    _hsClearYtFullBleed()
    return
  }
  const flexy = hsQuery('yt:watch-flexy-any', 'ytd-watch-flexy')
  if (flexy?.hasAttribute('fullscreen')) {
    document.documentElement.style.removeProperty('--hs-yt-below-top')
    _hsClearYtFullBleed()
    return
  }
  const mp = hsQuery('yt:movie-player', ['#movie_player', '.html5-video-player'])
  const b = mp?.getBoundingClientRect()
  if (!b || b.height <= 0) return
  // THEATRE + side chat: YT keeps #full-bleed-container at the full-WIDTH 16:9
  // height while the real player is height-capped smaller, and the #below reflow
  // rule is :not([theater]) — so #below (static) drops below the reserved band,
  // a fat black gap under the video (only chat-left/top/bottom had a theatre fix,
  // never chat-right). Collapse the container to the real player height so the
  // metadata flows right under the video. The ResizeObserver + move-poll re-run
  // this whenever the player resizes, so it stays in sync.
  if (flexy?.hasAttribute('theater')) {
    document.documentElement.style.removeProperty('--hs-yt-below-top')
    const h = `${Math.round(b.height)}px`
    for (const sel of ['#full-bleed-container', '#player-full-bleed-container']) {
      const el = document.querySelector(sel)
      if (el && el.style.height !== h) el.style.height = h
    }
    return
  }
  // Non-theatre: CSS pins #below position:fixed at this var; no container surgery.
  _hsClearYtFullBleed()
  document.documentElement.style.setProperty('--hs-yt-below-top', `${Math.round(b.bottom)}px`)
}
// YT shifts the player's POSITION without changing its SIZE — theater masthead
// hide-on-scroll, description/comments panel expand-collapse, native miniplayer
// dock, and the multi-pass load reflow all move #movie_player's top/left while
// the ResizeObserver (size-only) stays silent, leaving the overlay stranded
// (the "must disable/enable chat to fix" report). Poll the rect and, on a real
// MOVE, run the SAME full recompute the manual chat hide/show ('\') runs — the
// known-good path that already fixes a drifted overlay. Cheap: one rect read +
// a two-number compare per tick, DOM work only on a >1px delta.
let _hsLastMpRect = null
let _hsSettlingUntil = 0
function _hsCheckYtPlayerMoved() {
  if (document.body.classList.contains('hs-offline')) {
    _hsLastMpRect = null // panel hidden — nothing to reposition
    return
  }
  const mp = hsQuery('yt:movie-player', ['#movie_player', '.html5-video-player'])
  const b = mp?.getBoundingClientRect()
  if (!b || b.height === 0) return
  const last = _hsLastMpRect
  _hsLastMpRect = { top: b.top, left: b.left } // always track, even while settling
  if (!last) return
  // applyChatPosition() dispatches delayed resize nudges (+0/100/500/1500ms) that
  // move the player themselves — during that settle window keep tracking the rect
  // but don't re-trigger, so our own relayout isn't re-detected as fresh drift.
  if (performance.now() < _hsSettlingUntil) return
  if (Math.abs(b.top - last.top) > 1 || Math.abs(b.left - last.left) > 1) {
    try {
      applyChatPosition()
    } catch (_) {}
    _hsSettlingUntil = performance.now() + 1700 // cover the +1500ms nudge tail
  }
}
function _hsEnsureYtBelowObserver(_tries) {
  const mp = hsQuery('yt:movie-player', '#movie_player')
  // On fresh load applyPlatformPositionOverrides often runs before #movie_player
  // exists; self-retry so the observer attaches once the player mounts (instead
  // of depending on the function happening to re-run after). ~12s ceiling.
  if (!mp) {
    if ((_tries || 0) < 30) cleanup.setTimeout(() => _hsEnsureYtBelowObserver((_tries || 0) + 1), 400)
    return
  }
  if (_hsYtBelowEl !== mp) {
    if (_hsYtBelowRO) cleanup.untrackObserver(_hsYtBelowRO)
    _hsYtBelowEl = mp
    _hsYtBelowRO = new ResizeObserver(_hsSetYtBelowTop)
    _hsYtBelowRO.observe(mp)
    cleanup.trackObserver(_hsYtBelowRO)
  }
  // ResizeObserver only fires on SIZE changes — but YT shifts the player's
  // POSITION without resizing it. The poll catches those pure moves and re-runs
  // the full layout recompute (which also republishes --hs-yt-below-top).
  // setIntervalIfVisible: a hidden tab has nothing painted to reposition —
  // twice-a-second querySelector + getBoundingClientRect forever in the
  // background is pure wasted work on low-end hardware.
  if (!_hsYtBelowPoll) _hsYtBelowPoll = cleanup.setIntervalIfVisible(_hsCheckYtPlayerMoved, 500)
  _hsSetYtBelowTop()
}

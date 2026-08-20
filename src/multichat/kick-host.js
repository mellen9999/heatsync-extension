// Kick host UI/nav — extracted from main.js (bundled into kick bundle only)

/**
 * Detect Kick's left sidebar at the current viewport width. Kick drops the
 * sidebar from the DOM at narrow widths (~< ~1000px). The padding-left we
 * apply to <main> needs to subtract the sidebar's effective width so the
 * video starts where our fixed panel ends — without leaving a gap when the
 * sidebar is present, and without overlapping the video when it isn't.
 */
function getKickSidebarWidth() {
  const el = hsQuery('kick:sidebar-collapsed-width', '[class*="sidebar-collapsed-width"]')
  if (!el) return 0
  const w = el.offsetWidth
  return w > 0 ? w : 0
}

function syncKickSidebarVar() {
  document.documentElement.style.setProperty('--hs-kick-sidebar-w', `${getKickSidebarWidth()}px`)
}

/**
 * Apply chat width to Kick's fixed #channel-chatroom panel
 */
function applyKickChatWidth() {
  const chatroom = document.getElementById('channel-chatroom')
  if (!chatroom) return
  chatWidth = Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, chatWidth))
  document.documentElement.style.setProperty('--hs-kick-chat-width', `${chatWidth}px`)
  document.documentElement.style.setProperty('--chat-width', `${chatWidth}px`)
  syncKickSidebarVar()
  // C button took chat off the right edge — chatroom is hidden via CSS,
  // skip restoring its width (would un-hide it visually as the shell still
  // claims layout when display is intercepted by the cascade).
  if (chatPosition && chatPosition !== 'right') return
  chatroom.style.setProperty('width', `${chatWidth}px`, 'important')
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
    },
    { signal: mcSignal },
  )

  handle.addEventListener(
    'pointermove',
    (e) => {
      if (!isResizing || e.pointerId !== activePointerId) return
      const delta = startX - e.clientX
      pendingWidth = Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, startWidth + delta))
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
    applyKickChatWidth()
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    if (overlay) {
      overlay.remove()
      overlay = null
    }
    // Force Kick's video.js player + any preroll/midroll ad layer to
    // re-measure so the ad video stops overlapping chat.
    try {
      window.dispatchEvent(new Event('resize'))
    } catch (_) {}
    saveChatWidth()
  }
  handle.addEventListener('pointerup', endDrag, { signal: mcSignal })
  handle.addEventListener('pointercancel', endDrag, { signal: mcSignal })

  loadChatWidth().then(() => {
    applyKickChatWidth()
  })
  loadChatHeight()
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
      try {
        positionChatResizeHandle()
      } catch {}
      try {
        _updateMcLayout()
      } catch {}
    }, 80)
  }
  window.addEventListener('resize', onResize, { signal: mcSignal })

  if (hsQuery('kick:injected-channel-player', '#injected-channel-player')) {
    // Player already mounted — apply now (early init call missed it).
    applyPlatformPositionOverrides()
  } else if (!_kickPlayerMountObs) {
    _kickPlayerMountObs = new MutationObserver(() => {
      if (hsQuery('kick:injected-channel-player', '#injected-channel-player')) {
        _kickPlayerMountObs.disconnect()
        _kickPlayerMountObs = null
        applyPlatformPositionOverrides()
      }
    })
    _kickPlayerMountObs.observe(document.body, { childList: true, subtree: true })
    cleanup.trackObserver(_kickPlayerMountObs)
  }
}

let _kickTopNavObs = null
let _kickTopNavH = 60 // matches --hs-kick-topnav-h CSS fallback

// Kick's top nav is position:fixed, ~60px tall (matches the CSS fallback).
// Mirrors the twitch pattern: measure once, track via ResizeObserver, push
// --hs-kick-topnav-h so CSS rules that offset the panel don't need to
// hard-code the height. Selector matches the <nav> used elsewhere in the
// codebase for kick nav height measurement.
function updateKickTopNavHeight() {
  if (!isKick) return
  const nav = hsQuery('kick:navbar', 'nav, [class*="navbar"]')
  let h = 60 // CSS fallback default
  if (nav) {
    const r = nav.getBoundingClientRect()
    h = r.height > 0 && getComputedStyle(nav).display !== 'none' ? Math.round(r.height) : 60
  }
  if (h === _kickTopNavH) return
  _kickTopNavH = h
  document.documentElement.style.setProperty('--hs-kick-topnav-h', `${h}px`)
}

function setupKickTopNavObserver() {
  if (!isKick) return
  document.documentElement.style.setProperty('--hs-kick-topnav-h', `${_kickTopNavH}px`)
  if (_kickTopNavObs) {
    try {
      _kickTopNavObs.disconnect()
    } catch (_) {}
    _kickTopNavObs = null
  }
  const nav = hsQuery('kick:navbar', 'nav, [class*="navbar"]')
  if (nav && typeof ResizeObserver !== 'undefined') {
    _kickTopNavObs = new ResizeObserver(() => updateKickTopNavHeight())
    _kickTopNavObs.observe(nav)
    cleanup.trackObserver(_kickTopNavObs)
  }
  updateKickTopNavHeight()
}

// Mirror of updateTwitchNoChannelClass for Kick. #channel-chatroom is
// present only on /<channel> pages; absent on /browse, /categories,
// /following, /search, /settings, etc. CSS keyed off this flips the
// panel to position:fixed overlay and squeezes <main> width/height.
function updateKickNoChannelClass() {
  if (!isKick) return
  try {
    injectStyles()
  } catch (_) {} // kick SPA navs — same sweep guard

  const onChannel = !!document.getElementById('channel-chatroom')
  const popout = document.body.classList.contains('hs-popout')
  document.body.classList.toggle('hs-kick-no-channel', !onChannel && !popout)
}

// Kick mirror of softTwitchNav — keep the panel mounted across SPA nav.
// Pre-emptively migrate to <body> so kick's React teardown of the
// #channel-chatroom region doesn't take it down, refresh the no-channel
// class for the new URL, and reparent into a freshly-mounted #channel-
// chatroom once it appears (channel pages).
function softKickNav(prevLiveCh) {
  const container = document.getElementById('hs-mc-container')
  // Bug #5: if the container is gone (e.g. back-button landed on a page
  // before our script had mounted it, or a prior nav already removed it),
  // run the full destroy+rebuild path rather than spinning a useless
  // MutationObserver that can never recover a null reference.
  if (!container) {
    fullSpaReinit()
    return
  }
  // Only invalidate live cache — per-channel tabs stay valid (their
  // buffers are keyed by channel name, unchanged by URL).
  try {
    _dropTabCache('live')
  } catch {}
  try {
    rearmLiveYtAuto()
  } catch (_) {}
  document.body.classList.add('hs-mc-navigating')
  if (container.parentElement && container.parentElement !== document.body) {
    document.body.appendChild(container)
  }
  try {
    updateKickNoChannelClass()
  } catch (_) {}
  let done = false
  const finish = () => {
    // Gated: skip re-hide when the user has chosen nativeVisible.
    if (!nativeVisible)
      try {
        setNativeChatHidden(true)
      } catch (_) {}
    isScrolledUp = false
    newMessageCount = 0
    _scrollbackWindow = 0 // new channel starts at the live tail
    // SPA nav changed the URL channel — re-join + repaint the live tab so the
    // new Kick channel connects and renders (otherwise the panel freezes on
    // the previous channel until an unrelated render fires).
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
    // Join the new live channel (Bug #1 for Kick path).
    // Part the previous live channel (Bug #3) to avoid buffer accumulation.
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
      renderMessages('live')
    } catch (_) {}
    const reHide = new MutationObserver(() => {
      if (!nativeVisible)
        try {
          setNativeChatHidden(true)
        } catch (e) {
          // Kick re-mounts its chatroom; this is what re-hides it. A throw
          // leaves the user looking at BOTH chats stacked. Fires per mutation,
          // so the count is the useful part, not any one occurrence.
          swallow(e, 'kick-native-rehide')
        }
    })
    const target = document.getElementById('channel-chatroom')
    if (target) {
      reHide.observe(target, { childList: true })
      cleanup.trackObserver(reHide)
    }
    cleanup.setTimeout(
      () => {
        cleanup.untrackObserver(reHide)
        document.body.classList.remove('hs-mc-navigating')
      },
      300,
      'kick-soft-nav-release',
    )
  }
  const tryReparent = () => {
    if (done) return true
    const chatRoom = document.getElementById('channel-chatroom')
    const c = document.getElementById('hs-mc-container')
    if (chatRoom && c && c.previousElementSibling !== chatRoom) {
      chatRoom.after(c)
      try {
        updateKickNoChannelClass()
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
          updateKickNoChannelClass()
        } catch (_) {}
        finish()
      }
    },
    4000,
    'kick-soft-nav-finalize',
  )
}

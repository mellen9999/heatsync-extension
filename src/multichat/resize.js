// ghost-resize, chat width/height, and yt sidebar-width cluster — split out
// of main.js (2026-07-04). twitch/kick/yt player-pin + layout-watch helpers
// already live in twitch-host.js/kick-host.js/youtube-host.js (platform
// modules) — see the "moved to X-host.js" markers below for the boundary.

// Chat width state
let chatWidth = 340 // Default width
// 10px floor ≈ the bar's invisible grab-zone (2px line + 4px each side) —
// chat can shrink to just the handle so the player nearly fills the
// viewport, but the handle stays grabbable to drag it back. No artificial
// "minimum usable size"
// — user explicitly wants pixel-level freedom.
const MIN_CHAT_WIDTH = 10
const MAX_CHAT_WIDTH = 800
// YouTube enforces #primary { min-width: 640px } — never let chat encroach
// on the video player. The +20px fudge covers column-gap and scrollbar
// gutter so we don't trip a 1px viewport overflow at the boundary.
const YT_MIN_PRIMARY_WIDTH = 660
// YT suggestions strip (opt-in ytShowSuggestions → body.hs-yt-suggestions):
// a fixed column beside the player on left/right dock. Single source of truth
// for both the player-sizing arithmetic below AND the stylesheet — published
// as --hs-yt-sugg-w so the CSS fallback (300px) is only a pre-JS placeholder.
const YT_SUGG_STRIP_W = 300
// Twitch: when .channel-root__main shrinks below this, Twitch flips to its
// narrow-stack layout — .persistent-player gets re-positioned absolute at
// the bottom of the about section (y > 2000px), so the video falls below
// the fold and the empty player slot at the top shows the "?" placeholder.
// Cap chat-col width so main stays above this threshold.
const TWITCH_MIN_MAIN_WIDTH = 600
const TWITCH_SIDE_NAV_WIDTH = 50 // left rail when collapsed; conservative
const TWITCH_TOP_NAV_HEIGHT = 50 // .top-nav strip; hidden in theatre mode

// getYtMaxChatWidth moved to youtube-host.js (platform module)

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
  const tabStrip = tabPosition === 'left' || tabPosition === 'right' ? 90 : 0
  const floor = chatPosition && chatPosition !== 'right' ? 300 : TWITCH_MIN_MAIN_WIDTH
  const navW = typeof _twitchSideNavW === 'number' && _twitchSideNavW > 0 ? _twitchSideNavW : TWITCH_SIDE_NAV_WIDTH
  const max = vw - navW - floor - tabStrip
  return Math.max(MIN_CHAT_WIDTH, Math.min(MAX_CHAT_WIDTH, max))
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
const buildGhostCss = (rect, w0) =>
  `position:fixed;top:${rect.top}px;right:0;height:${rect.height}px;width:${w0}px;background:rgba(255,255,255,0.06);border-left:3px solid #fff;pointer-events:none;z-index:99998;will-change:width;`
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
    if (ghost) ghost.style.width = `${pendingWidth + (isVertical() ? 90 : 0)}px`
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
    },
    { signal: mcSignal },
  )

  handle.addEventListener(
    'pointermove',
    (e) => {
      if (!isResizing || e.pointerId !== activePointerId) return
      const delta = startX - e.clientX
      const max = Math.min(MAX_CHAT_WIDTH, getTwitchMaxChatWidth())
      pendingWidth = Math.min(max, Math.max(MIN_CHAT_WIDTH, startWidth + delta))
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
    // Single real width commit — player reflows exactly once here
    applyChatWidth(rightCol)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    if (overlay) {
      overlay.remove()
      overlay = null
    }
    // Force Twitch's player + ad layer (.video-ad-display, IMA iframe) to
    // re-measure. Without this, ad video keeps its pre-resize dimensions.
    try {
      window.dispatchEvent(new Event('resize'))
    } catch (_) {}
    // Re-pin scroll: the single reflow shifts msgsEl.scrollHeight (taller
    // wrapped lines on shrink, shorter on expand). Without this, a
    // bottom-pinned user sees their viewport slide up after the drag.
    // Helper self-bails if isScrolledUp.
    const m = document.getElementById('hs-mc-messages')
    if (m)
      try {
        scrollMsgsToBottom(m)
      } catch (_) {}
    saveChatWidth()
  }
  handle.addEventListener('pointerup', endDrag, { signal: mcSignal })
  handle.addEventListener('pointercancel', endDrag, { signal: mcSignal })

  loadChatWidth()
  loadChatHeight()
}

function applyChatWidth(cachedRightCol) {
  // Native chat shown: don't resize the right-column (races native chat layout).
  if (typeof getSetting === 'function' && getSetting('nativeVisible')) return
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

  rightCol.style.setProperty('width', `${colWidth}px`, 'important')
  rightCol.style.setProperty('min-width', `${colWidth}px`, 'important')
  rightCol.style.setProperty('flex-shrink', '0', 'important')

  const innerCol = rightCol.querySelector('.channel-root__right-column')
  if (innerCol) {
    innerCol.style.setProperty('width', '100%', 'important')
  }
}

let _saveChatWidthTimer = null
function saveChatWidth() {
  // Mirror to localStorage immediately for early-layout.js to read at
  // document_start. chrome.storage write is debounced; localStorage isn't.
  try {
    localStorage.setItem('hs_layout_chatWidth', String(chatWidth))
  } catch {}
  if (_saveChatWidthTimer) cleanup.clearTimeout(_saveChatWidthTimer)
  _saveChatWidthTimer = cleanup.setTimeout(() => {
    _saveChatWidthTimer = null
    chrome.storage.local.set({ hs_chat_width: chatWidth })
    log('Saved chat width:', chatWidth)
  }, 250)
}

// ============================================
// CHAT HEIGHT — for top/bottom chatPosition. Persisted in chrome.storage
// alongside chatWidth so the C button's drag handle survives reloads.
// ============================================
const MIN_CHAT_HEIGHT = 10
function getMaxChatHeight() {
  return Math.max(MIN_CHAT_HEIGHT, window.innerHeight - 10)
}
// Clamp to MIN so a tiny window at module-load doesn't trap the user with
// a default below the legal range.
let chatHeight = Math.max(MIN_CHAT_HEIGHT, Math.round(window.innerHeight * 0.35))
let _saveChatHeightTimer = null
function saveChatHeight() {
  try {
    localStorage.setItem('hs_layout_chatHeight', String(chatHeight))
  } catch {}
  if (_saveChatHeightTimer) cleanup.clearTimeout(_saveChatHeightTimer)
  _saveChatHeightTimer = cleanup.setTimeout(() => {
    _saveChatHeightTimer = null
    chrome.storage.local.set({ hs_chat_height: chatHeight })
    log('Saved chat height:', chatHeight)
  }, 250)
}
async function loadChatHeight() {
  try {
    const data = await browser.storage.local.get(['hs_chat_height'])
    if (data.hs_chat_height) {
      chatHeight = Math.max(MIN_CHAT_HEIGHT, Math.min(getMaxChatHeight(), data.hs_chat_height))
      // Mirror loadChatWidth: push CSS var + reposition the unified handle so
      // the panel + orange bar render at the saved height on first paint.
      document.documentElement.style.setProperty('--hs-chat-h', `${chatHeight}px`)
      try {
        positionChatResizeHandle()
      } catch {}
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
// White #fff, 2px thin + invisible grab, no text — matches the
// --hs-resize-thickness token in styles.js (and heatsync.org's .hs-resizer).
// ============================================
const HS_RESIZE_PX = 4 // visible thickness — mirrors --hs-resize-thickness
let _isResizingC = false
let _cHandlePanelObs = null
let _cHandlePanelObsTarget = null
// Panel node reference — see getOrCreateHsContainer / softTwitchNav.
let _hsMcContainerNode = null
// Mount-retry: on hard loads of no-channel pages the first position pass can
// run before #hs-mc-container even EXISTS — the ResizeObserver has nothing to
// attach to, so nothing ever re-shows the bar. Bounded ladder re-polls until
// the panel mounts (or gives up on genuinely panel-less pages, e.g. logged out).
let _cHandleRetryTimer = null
let _cHandleRetryCount = 0
function _armCHandleMountRetry() {
  if (_cHandleRetryTimer || _cHandleRetryCount >= 20) return
  _cHandleRetryTimer = cleanup.setTimeout(
    () => {
      _cHandleRetryTimer = null
      _cHandleRetryCount++
      try {
        positionChatResizeHandle()
      } catch (_) {}
    },
    300,
    'c-handle-mount-retry',
  )
}
function ensureChatResizeHandle() {
  let handle = document.getElementById('hs-c-resize-handle')
  if (handle) return handle
  handle = document.createElement('div')
  handle.id = 'hs-c-resize-handle'
  // background/opacity/transition come from the #hs-c-resize-handle
  // stylesheet rule — inline copies here silently overrode stylesheet
  // changes (the 0.9-idle bump never applied to this handle).
  Object.assign(handle.style, {
    position: 'fixed',
    userSelect: 'none',
    touchAction: 'none',
    display: 'none',
    pointerEvents: 'auto',
  })
  // z-index: YT needs max-int to beat its own modal stacking contexts (chrome
  // bottom bar, settings menu). On twitch/kick the bar overlaps the panel's
  // left-edge pixels, and the no-channel panel is z-1500 — 999 painted the
  // bar BEHIND the panel (present but invisible). 1501 sits above the panel
  // and still below twitch's popup layers (balloon 2000 / overlay 3000 /
  // modal 5000), so it can't cover sign-in or toast modals.
  handle.style.setProperty('z-index', hostPlatform === 'yt' ? '2147483647' : '1501', 'important')
  document.body.appendChild(cleanup.trackNode(handle))
  handle.addEventListener('mouseenter', () => {
    handle.style.opacity = '1'
  })
  handle.addEventListener('mouseleave', () => {
    if (!_isResizingC) handle.style.opacity = '' // clear inline — stylesheet owns the idle value
  })

  // Window-level reflow: WM fullscreen (dwl mod-e, sway/i3 fullscreen),
  // browser zoom, devtools toggle all change viewport without firing the
  // platform-internal layout signals (Twitch theatre attr, YT flexy attr).
  // Without this the orange bar's inline px from getBoundingClientRect goes
  // stale and floats over wrong pixels until the user moves the cursor.
  // Suppressed during the live drag (drag dispatches resize itself for the
  // player to re-layout — we don't want recursion).
  let _resizeReflowTimer = null
  window.addEventListener(
    'resize',
    () => {
      if (_isResizingC) return
      if (_resizeReflowTimer) cleanup.clearTimeout(_resizeReflowTimer)
      _resizeReflowTimer = cleanup.setTimeout(() => {
        _resizeReflowTimer = null
        try {
          positionChatResizeHandle()
        } catch {}
        try {
          _updateMcLayout()
        } catch {}
      }, 60)
    },
    { passive: true, signal: mcSignal },
  )

  // Live drag: chat + player resize on every pointermove (rAF-throttled).
  // We suppress the YT window-resize dispatch during drag so IMA SDK / html5
  // player don't re-decode the video on every frame. CSS handles smooth
  // visual scaling; one final resize event fires on pointerup so the player
  // re-measures cleanly (and ad <video> elements snap to final dimensions).
  let startX = 0,
    startY = 0,
    startW = 0,
    startH = 0,
    axis = 'x',
    activePid = -1
  let pendingW = 0,
    pendingH = 0,
    overlay = null,
    ghost = null
  let liveRaf = 0
  // Panel anchor edges captured at pointerdown — the edges that DON'T
  // move during the drag. See positionChatResizeHandle for the static
  // (non-drag) equivalent that DOES read rect.
  let panelTop = 0,
    panelLeft = 0,
    panelRight = 0,
    panelBottom = 0
  handle.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0) return
      // Stop YT's player-level pointer handlers from also catching this
      // event. At narrow viewports the player extends under the chat
      // overlay (single-column layout) and YT's pointermove/down listeners
      // can intercept events even though our handle has higher z-index.
      e.stopImmediatePropagation()
      _isResizingC = true
      activePid = e.pointerId
      try {
        handle.setPointerCapture(e.pointerId)
      } catch (_) {}
      startX = e.clientX
      startY = e.clientY
      startW = chatWidth
      startH = chatHeight
      pendingW = chatWidth
      pendingH = chatHeight
      axis = chatPosition === 'left' || chatPosition === 'right' ? 'x' : 'y'
      // Capture the panel's actual rendered edges. Container is position:
      // fixed but transformed ancestors (Twitch top-nav) can shift it from
      // the viewport's true (0,0) origin — the bar must track the panel's
      // true edge, not raw chat dimensions.
      const cont = document.getElementById('hs-mc-container')
      const r = cont
        ? cont.getBoundingClientRect()
        : { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight }
      panelTop = r.top
      panelLeft = r.left
      panelRight = r.right
      panelBottom = r.bottom
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'
      handle.style.opacity = '1'
      // Full-viewport overlay: captures pointer events even when crossing
      // iframes (YT player iframe steals events otherwise).
      overlay = document.createElement('div')
      overlay.id = 'hs-c-resize-overlay'
      overlay.style.cssText = `position:fixed;inset:0;z-index:99998;cursor:${axis === 'x' ? 'col-resize' : 'row-resize'};`
      document.body.appendChild(overlay)
      // Ghost preview — fixed-positioned, pointer-events:none, will-change
      // for the compositor. Mirrors the per-platform handles' approach
      // (#hs-mc-resize-handle, #hs-kick-resize-handle, #hs-yt-resize-handle).
      // Memory rule: never touch the actual chat width/player layout during
      // the live drag — Twitch right-column has ~2500 React Layout nodes
      // and inline-style writes on YT player wrappers thrash IMA SDK.
      ghost = document.createElement('div')
      ghost.id = 'hs-c-resize-ghost'
      const baseStyle = 'position:fixed;background:rgba(255,255,255,0.06);pointer-events:none;z-index:99997;'
      if (chatPosition === 'right') {
        ghost.style.cssText =
          baseStyle +
          `top:${panelTop}px;right:0;height:${panelBottom - panelTop}px;width:${pendingW}px;border-left:3px solid #fff;will-change:width;`
      } else if (chatPosition === 'left') {
        ghost.style.cssText =
          baseStyle +
          `top:${panelTop}px;left:0;height:${panelBottom - panelTop}px;width:${pendingW}px;border-right:3px solid #fff;will-change:width;`
      } else if (chatPosition === 'top') {
        ghost.style.cssText = `${baseStyle}top:0;left:0;right:0;height:${pendingH}px;border-bottom:3px solid #fff;will-change:height;`
      } else if (chatPosition === 'bottom') {
        ghost.style.cssText = `${baseStyle}bottom:0;left:0;right:0;height:${pendingH}px;border-top:3px solid #fff;will-change:height;`
      }
      document.body.appendChild(ghost)
      e.preventDefault()
    },
    { signal: mcSignal },
  )
  handle.addEventListener(
    'pointermove',
    (e) => {
      if (!_isResizingC || e.pointerId !== activePid) return
      // Full pixel-freedom drag — bounded only by viewport-10 so the
      // handle stays grabbable on either extreme.
      const maxW = Math.max(MIN_CHAT_WIDTH, window.innerWidth - 10)
      if (chatPosition === 'right') {
        pendingW = Math.max(MIN_CHAT_WIDTH, Math.min(maxW, startW + (startX - e.clientX)))
      } else if (chatPosition === 'left') {
        pendingW = Math.max(MIN_CHAT_WIDTH, Math.min(maxW, startW + (e.clientX - startX)))
      } else if (chatPosition === 'top') {
        pendingH = Math.max(MIN_CHAT_HEIGHT, Math.min(getMaxChatHeight(), startH + (e.clientY - startY)))
      } else if (chatPosition === 'bottom') {
        pendingH = Math.max(MIN_CHAT_HEIGHT, Math.min(getMaxChatHeight(), startH + (startY - e.clientY)))
      }
      // Compositor-only update during drag — no layout, no React reconcile,
      // no inline-style writes on player wrappers. Just move the orange bar
      // and resize the ghost preview. Final commit happens on pointerup.
      if (!liveRaf) {
        liveRaf = requestAnimationFrame(() => {
          liveRaf = 0
          if (chatPosition === 'right') {
            handle.style.left = `${panelRight - pendingW}px`
            if (ghost) ghost.style.width = `${pendingW}px`
          } else if (chatPosition === 'left') {
            handle.style.left = `${panelLeft + pendingW - 10}px`
            if (ghost) ghost.style.width = `${pendingW}px`
          } else if (chatPosition === 'top') {
            handle.style.top = `${panelTop + pendingH - 10}px`
            if (ghost) ghost.style.height = `${pendingH}px`
          } else if (chatPosition === 'bottom') {
            handle.style.top = `${panelBottom - pendingH}px`
            if (ghost) ghost.style.height = `${pendingH}px`
          }
        })
      }
    },
    { signal: mcSignal },
  )
  const endDrag = (e) => {
    if (!_isResizingC || (e && e.pointerId !== activePid)) return
    _isResizingC = false
    activePid = -1
    if (liveRaf) {
      cancelAnimationFrame(liveRaf)
      liveRaf = 0
    }
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    handle.style.opacity = '' // clear inline — stylesheet owns the idle value
    if (overlay) {
      overlay.remove()
      overlay = null
    }
    if (ghost) {
      ghost.remove()
      ghost = null
    }
    // Final commit — single reflow for the player + React tree.
    if (axis === 'x') chatWidth = pendingW
    else chatHeight = pendingH
    document.documentElement.style.setProperty('--hs-chat-w', `${chatWidth}px`)
    document.documentElement.style.setProperty('--hs-chat-h', `${chatHeight}px`)
    applyChatPosition()
    requestAnimationFrame(() => {
      try {
        publishPanelWidth()
      } catch (_) {}
    })
    // applyChatPosition strips inline width on #secondary for YT chat-right
    // and relies on "next reflow" to repopulate it — force it now.
    if (hostPlatform === 'yt') {
      try {
        applyYouTubeChatWidth()
      } catch {}
    }
    // Force every platform's player (including ad layers — Twitch
    // .video-ad-display, YT IMA SDK, Kick video.js) to re-measure.
    try {
      window.dispatchEvent(new Event('resize'))
    } catch (_) {}
    // Re-pin scroll: width change re-wraps messages, scrollHeight shifts.
    // Helper self-bails if isScrolledUp.
    const m = document.getElementById('hs-mc-messages')
    if (m)
      try {
        scrollMsgsToBottom(m)
      } catch (_) {}
    saveChatWidth()
    saveChatHeight()
  }
  handle.addEventListener('pointerup', endDrag, { signal: mcSignal })
  handle.addEventListener('pointercancel', endDrag, { signal: mcSignal })
  return handle
}
function positionChatResizeHandle() {
  // Native chat shown: leave the resize handle alone — CSS hides it
  // (body.hs-native-visible). If we set display:none here during the collapse,
  // it'd persist as a stale inline style after toggling back to HS mode.
  if (typeof getSetting === 'function' && getSetting('nativeVisible')) return
  const handle = ensureChatResizeHandle()
  ;['top', 'bottom', 'left', 'right', 'width', 'height'].forEach((p) => {
    handle.style.removeProperty(p)
  })
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
      document.body.classList.contains('hs-twitch-no-channel') || document.body.classList.contains('hs-kick-no-channel')
    const platformAnchor = noChannelMode
      ? null
      : hostPlatform === 'kick'
        ? document.getElementById('channel-chatroom')
        : document.querySelector('.right-column.right-column--beside')
    if (platformAnchor) {
      handle.style.display = 'none'
      return
    }
  }
  // Anchor the bar to the panel container's ACTUAL rendered edges via
  // getBoundingClientRect. The handle is position:fixed on body, but
  // the panel container's own position:fixed can be shifted by a
  // transformed ancestor (Twitch's top-nav transforms put chat-top at
  // viewport y≈50 even though it's "fixed; top: 0"). Reading the rect
  // makes the bar track the panel's true edge regardless of those
  // offsets — otherwise the bar overlays tabbar/inputbar content.
  const cont = document.getElementById('hs-mc-container')
  if (cont) _cHandleRetryCount = 0 // panel exists — future mount-retries start fresh
  // On no-channel pages (twitch /directory, kick browse) this runs while the
  // panel is still 0×0 mid-mount, hides the bar via the rect guard below, and
  // nothing later re-triggers it — the bar stayed missing until a window
  // resize. Track the panel's rendered size and re-position on change.
  if (cont && typeof ResizeObserver !== 'undefined' && _cHandlePanelObsTarget !== cont) {
    if (_cHandlePanelObs) {
      try {
        _cHandlePanelObs.disconnect()
      } catch (_) {}
      cleanup.untrackObserver(_cHandlePanelObs)
    }
    _cHandlePanelObs = new ResizeObserver(() => {
      if (_isResizingC) return // drag owns geometry; endDrag re-positions
      try {
        positionChatResizeHandle()
      } catch (_) {}
    })
    _cHandlePanelObs.observe(cont)
    cleanup.trackObserver(_cHandlePanelObs)
    _cHandlePanelObsTarget = cont
  }
  const r = cont ? cont.getBoundingClientRect() : null
  // No chat panel (e.g. logged out → the platform's login modal): a null
  // rect would strand the bar at the viewport fallback (a full-height
  // orange line with no chat). Hide it until a real chat panel exists.
  if (!r || r.width < 2 || r.height < 2) {
    handle.style.display = 'none'
    _armCHandleMountRetry() // panel missing or pre-layout — re-check shortly
    return
  }
  handle.style.display = 'block'
  const cTop = r ? r.top : 0
  const cLeft = r ? r.left : 0
  const cRight = r ? r.right : window.innerWidth
  const cBottom = r ? r.bottom : window.innerHeight
  const cWidth = r ? r.width : window.innerWidth
  const cHeight = r ? r.height : window.innerHeight
  if (chatPosition === 'right') {
    handle.style.top = `${cTop}px`
    handle.style.left = `${cLeft}px`
    handle.style.height = `${cHeight}px`
    handle.style.width = `${HS_RESIZE_PX}px`
    handle.style.cursor = 'col-resize'
  } else if (chatPosition === 'left') {
    handle.style.top = `${cTop}px`
    handle.style.left = `${cRight - HS_RESIZE_PX}px`
    handle.style.height = `${cHeight}px`
    handle.style.width = `${HS_RESIZE_PX}px`
    handle.style.cursor = 'col-resize'
  } else if (chatPosition === 'top') {
    handle.style.top = `${cBottom - HS_RESIZE_PX}px`
    handle.style.left = `${cLeft}px`
    handle.style.width = `${cWidth}px`
    handle.style.height = `${HS_RESIZE_PX}px`
    handle.style.cursor = 'row-resize'
  } else if (chatPosition === 'bottom') {
    handle.style.top = `${cTop}px`
    handle.style.left = `${cLeft}px`
    handle.style.width = `${cWidth}px`
    handle.style.height = `${HS_RESIZE_PX}px`
    handle.style.cursor = 'row-resize'
  }
}
function hidePlatformResizeHandles(hide) {
  // hide=true: set display:none + mark as hidden-by-us. hide=false: only
  // restore display if we previously hid it (platforms like YT manage
  // their own display:none for theatre mode — don't clobber that).
  for (const id of ['hs-mc-resize-handle', 'hs-kick-resize-handle', 'hs-yt-resize-handle']) {
    const el = document.getElementById(id)
    if (!el) continue
    if (hide) {
      el.dataset._hsCHidden = '1'
      el.style.setProperty('display', 'none', 'important')
    } else if (el.dataset._hsCHidden === '1') {
      delete el.dataset._hsCHidden
      el.style.removeProperty('display')
    }
  }
}

async function loadChatWidth() {
  try {
    const data = await browser.storage.local.get(['hs_chat_width'])
    if (data.hs_chat_width) {
      chatWidth = data.hs_chat_width
      // Sync the CSS var driving every chat-position rule + reposition the
      // unified resize handle. Without this, the panel renders at the default
      // 340px until the first applyChatPosition fires (theatre toggle, drag
      // end, etc) — at which point the panel + bar visibly jump to the saved
      // width. That's the "first-load teleport" the user reports.
      document.documentElement.style.setProperty('--hs-chat-w', `${chatWidth}px`)
      applyChatWidth()
      try {
        positionChatResizeHandle()
      } catch {}
      log('Loaded chat width:', chatWidth)
    }
  } catch (e) {
    log('Error loading chat width:', e)
  }
}

// getKickSidebarWidth, syncKickSidebarVar, applyKickChatWidth, setupKickResizeHandle moved to kick-host.js (platform module)

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
  if (hostPlatform === 'yt') {
    try {
      _hsEnsureYtBelowObserver()
    } catch (_) {}
  }
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
  secondary.style.setProperty('width', `${chatWidth}px`, 'important')
  secondary.style.setProperty('min-width', `${chatWidth}px`, 'important')
  secondary.style.setProperty('max-width', `${chatWidth}px`, 'important')
  secondary.style.setProperty('flex', 'none', 'important')
  // Note: NOT setting width on #hs-mc-container — chat-right now uses
  // position:fixed via CSS (body.hs-platform-yt.hs-chat-right #hs-mc-container)
  // so the container's width is owned by var(--hs-chat-w). Setting inline
  // width here would beat that CSS and stretch chat across full viewport.
  const container = document.getElementById('hs-mc-container')
  if (container) container.style.removeProperty('width')
}

// pinTwitchPersistentPlayer, watchTwitchPersistentPlayer moved to twitch-host.js (platform module)

// watchYtLayoutAttrs, watchYtFlexyMount moved to youtube-host.js (platform module)

// watchYtViewportClamp moved to youtube-host.js (platform module)

// watchKickViewportClamp moved to kick-host.js (platform module)

// setupYouTubeResizeHandle moved to youtube-host.js (platform module)

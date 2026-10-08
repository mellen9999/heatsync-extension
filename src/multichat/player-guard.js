// player-guard.js — the extension must never cost you the stream.
//
// We position the host's video player ourselves (17-platform-position.css +
// applyPlatformPositionOverrides) so chat can dock top/bottom/left without
// covering it. Those rules race the platform's own layout code, which rewrites
// the player's inline width/height on ad breaks, theatre flips, SPA channel
// nav and resize. 17-platform-position.css documents that race being lost three
// separate times — "collapses to 0×0 and the video vanishes", "shrink-wraps to
// ~half width". When it collapses, what shows through is the host page's
// background: black on a dark theme, and a full white rectangle where the
// stream should be on a light one.
//
// Every previous fix answered a lost race with another !important rule. That is
// an arms race we cannot win from outside, because the platform ships new
// layout code whenever it likes. So this does not try to win it — it watches
// the outcome, and when the player has ended up unusable it takes our geometry
// off entirely and lets the platform lay itself out. Our docking is a nicety;
// the stream is the product.
//
// Failure mode after this: chat may sit somewhere less pretty. Never a blank
// player.

// Below this in either axis the player cannot be showing anything useful.
// Generous on purpose: a real 16:9 player is hundreds of px, and a mid-collapse
// player measured at, say, 40px wide is just as broken as one at 0.
const COLLAPSED_PX = 48

// The platform relayouts constantly (ads, theatre, resize). Only act once a
// player has stayed collapsed across this long, so a single transient frame
// mid-relayout never strips a perfectly good layout.
const CONFIRM_MS = 1200

let observer = null
let confirmTimer = null
let disengaged = false

function playerEl() {
  return (
    document.querySelector('.persistent-player') ||
    document.querySelector('[data-a-target="video-player"]') ||
    document.querySelector('#video-player') ||
    // YouTube: the <video>'s nearest div is .html5-video-container, which is
    // 0px tall by design (the video is absolutely positioned inside it), so
    // falling through to the generic <video> lookup flagged every healthy
    // watch page as collapsed and handed it back to native layout.
    document.querySelector('#movie_player') ||
    document.querySelector('video')?.closest('div')
  )
}

/**
 * Is a collapsed player actually a fault right now?
 *
 * Several states legitimately produce a zero-sized player and must never
 * trigger a bail-out: a hidden tab (the platform tears the player down), a
 * page with no player at all (directory/following), and fullscreen or
 * picture-in-picture, where the visible video is not this element.
 */
function shouldIgnore(el) {
  if (document.hidden) return true
  if (document.fullscreenElement) return true
  if (document.pictureInPictureElement) return true
  if (!el || !el.isConnected) return true
  // Mini-player while browsing away — the platform owns its geometry and our
  // rules are already gated off it.
  //
  // The class alone is NOT that state. main.js also sets it on a real channel
  // page when twitch's right column overflows off-screen, and there the guard
  // is the only thing standing between a lost layout race and a blank player —
  // so keying off the class blinded the safety net exactly where a player
  // exists. That is the same shape as the bug fixed in 9b061a9, which reached
  // this early-return through a different door. Ask for the absence of a
  // channel, which is what "browsing away" actually means; the overflow path
  // keeps its .channel-root and stays guarded.
  const noChannelClass = document.body?.classList?.contains('hs-twitch-no-channel')
  const onChannel = !!document.querySelector('.channel-root, [class*="channel-root"]')
  if (noChannelClass && !onChannel) return true
  return false
}

function isCollapsed(el) {
  const r = el.getBoundingClientRect()
  return r.width < COLLAPSED_PX || r.height < COLLAPSED_PX
}

/**
 * Stop overriding the player's geometry, for this page.
 *
 * body.hs-player-safe turns off every rule in 17-platform-position.css that
 * touches the player, and strips the inline geometry we wrote. Deliberately
 * one-way until the next navigation: re-engaging after a bail-out would put us
 * straight back into the race we just lost, and a player that flickers between
 * two layouts is worse than one that is merely docked wrong.
 */
function disengage(reason) {
  if (disengaged) return
  disengaged = true
  try {
    document.body.classList.add('hs-player-safe')
    const el = playerEl()
    if (el) {
      for (const p of ['top', 'bottom', 'left', 'right', 'width', 'height', 'max-width', 'max-height']) {
        el.style.removeProperty(p)
      }
    }
    // Loud on purpose: a silent bail-out would hide the underlying race, and
    // this is the breadcrumb a bug report needs.
    log('player-guard: released player geometry —', reason)
  } catch (_) {}
}

function check() {
  const el = playerEl()
  if (shouldIgnore(el)) {
    clearTimeout(confirmTimer)
    confirmTimer = null
    return
  }
  if (!isCollapsed(el)) {
    clearTimeout(confirmTimer)
    confirmTimer = null
    return
  }
  if (confirmTimer) return
  confirmTimer = setTimeout(() => {
    confirmTimer = null
    const now = playerEl()
    if (!shouldIgnore(now) && isCollapsed(now)) {
      const r = now.getBoundingClientRect()
      disengage(`player ${Math.round(r.width)}x${Math.round(r.height)} for ${CONFIRM_MS}ms`)
    }
  }, CONFIRM_MS)
}

/**
 * Start watching the player. Idempotent — safe to call on every SPA nav and
 * every re-assert of our position overrides.
 */
function installPlayerGuard() {
  try {
    if (typeof ResizeObserver !== 'function') return
    const el = playerEl()
    if (!el) return

    if (observer) observer.disconnect()
    observer = new ResizeObserver(check)
    observer.observe(el)
    if (typeof cleanup?.trackObserver === 'function') cleanup.trackObserver(observer)

    // A collapse can also arrive without a resize of the observed node (the
    // platform swapping the element out from under us), so re-check on the
    // events that accompany a relayout.
    check()
  } catch (_) {}
}

/** Has this page already bailed out? Read by applyPlatformPositionOverrides. */
function playerGuardDisengaged() {
  return disengaged
}

/** New page — the previous bail-out no longer applies. */
function resetPlayerGuard() {
  disengaged = false
  clearTimeout(confirmTimer)
  confirmTimer = null
  try {
    document.body.classList.remove('hs-player-safe')
  } catch (_) {}
}

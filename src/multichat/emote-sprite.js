// The sprite rung for chat rows — every copy of an animated emote on ONE frame.
//
// 2026-11-25, nl_kripp: two people posted the 7tv emote `67`, both rows drew the identical src,
// and scrolling up to them showed the two copies out of step. Two <img> with one src share a
// timeline only while both are alive and mounted together; here a row is parked on a static file
// when it leaves the screen (hsSwapRowEmotesForIdle) and put back when it returns, and rows are
// mounted at whatever moment their message lands. Each swap restarts that img's own clock, so the
// <img> alone can never promise the same frame — the browser does not offer to.
//
// The site solved this once, in client/cosmetics/animated-texture.js (copied byte for byte into
// lib/, embedded by build.js as `hsSpriteTexture`): decode the animated file ONCE into a strip,
// play it by moving the strip under a one-frame window, and take the phase from the wall clock,
// not from when a row happened to mount. This file is the extension's side of that contract —
// WHERE a sprite may sit and WHEN it comes and goes — and nothing about how one is built.
//
// The <img> stays underneath, as on the site: it keeps the reserved box, the hover plate and the
// click target, and it is today's behaviour for every source that cannot be a strip. A refused
// build (no ImageDecoder, a cdn that sends no CORS header, a single frame) leaves the row exactly
// as it was, and the module remembers the refusal so a busy room asks once per emote, not per row.
//
// Bytes: fetched from the content script itself, no background hop. Verified 2026-11-25 against
// the cdns' own headers: cdn.7tv.app, cdn.frankerfacez.com, static-cdn.jtvnw.net, files.kick.com
// and heatsync.org all answer `access-control-allow-origin: *`, which is all a cross-origin read
// from a page-world fetch needs. cdn.betterttv.net sends none, so its bytes are read through
// heatsync.org/api/emote-proxy (setCorsProxy below): the same bytes with that header, no new host
// permission. The strip is still keyed on the bttv url; the <img> under it parks on bttv's own
// static file.
//
// Hold-still reasons, same set as the site's: the setting (only 'always' animates), a hidden tab,
// and offscreen (the idle gate in emotes.js). Reduced-motion is NOT one — an emote is content
// someone sent, and animateEmotes is its only owner (styles/10-emotes.css says the same of the
// hs-fx modifiers). Excluded like the site's spriteHost: modifier emotes (a filter or an hs-fx
// class lives on the <img>, which a sprite drawn over it would not carry), overlays, stacks,
// cropped kick art, and anything that is not stamped animated.

const HS_SPRITE_HOSTS =
  /^https:\/\/(?:cdn\.7tv\.app|cdn\.frankerfacez\.com|cdn\.betterttv\.net|static-cdn\.jtvnw\.net|files\.kick\.com|heatsync\.org)\//

hsSpriteTexture.setCorsProxy('https://heatsync.org/api/emote-proxy')

/** Imgs a sprite is playing over. */
const hsSpriteLive = new Set()
/** Imgs that went hidden-tab with a sprite — put back, on the clock, when the tab returns. */
let hsSpriteParked = new Set()
/** url → imgs on screen that asked before the strip was built. */
const hsSpriteWaiting = new Map()

function hsSpriteWrapOf(img) {
  const wrap = img.parentElement
  if (!wrap?.classList?.contains('hs-mc-emote-wrapper')) return null
  if (wrap.dataset.animated !== '1' || wrap.dataset.hsMods) return null
  if (wrap.classList.contains('hs-kick-crop') || wrap.closest('.hs-mc-emote-stack')) return null
  if (img.classList.contains('hs-mc-overlay-emote') || /\bhs-fx-/.test(img.className)) return null
  // blocked and stale draw the img itself dimmed or struck (10-emotes.css); a sprite over it would not.
  if (wrap.dataset.state === 'blocked' || wrap.dataset.state === 'stale') return null
  return wrap
}

/** Take the sprite off one img. The img's own src is the idle gate's business, not this. */
function hsSpriteDrop(img, wrap) {
  hsSpriteLive.delete(img)
  hsSpriteParked.delete(img)
  const url = wrap?.dataset?.emoteUrl
  const asking = url && hsSpriteWaiting.get(url)
  if (asking) {
    asking.delete(img)
    if (!asking.size) hsSpriteWaiting.delete(url)
  }
  if (wrap) hsSpriteTexture.unmountSprite(wrap)
}

/** The setting left 'always': every sprite goes, and each img it was covering gets its own file back
 * (the gate's teardown only restores the rows it tracks). */
function hsSpriteDropAll() {
  for (const img of [...hsSpriteLive, ...hsSpriteParked]) {
    const wrap = img.parentElement
    hsSpriteDrop(img, wrap)
    const orig = wrap?.dataset?.emoteUrl
    if (orig && img.src !== orig) img.src = orig
  }
  hsSpriteWaiting.clear()
}

/**
 * Put a sprite over `img` if one may play there NOW. True when it is playing, so the caller leaves
 * the img on its static frame; false leaves the img to the caller (today's animated <img>). A
 * strip still being built is asked for and the img waits for hsSpriteTexture's onReady.
 */
function hsSpriteTry(img, wrap, orig) {
  if (emoteAnimationMode !== 'always' || document.hidden || !hsSpriteTexture.supported()) return false
  if (!HS_SPRITE_HOSTS.test(orig) || hsSpriteTexture.spriteRefused(orig)) return false
  const w = hsSpriteWrapOf(img)
  if (!w || w !== wrap) return false
  const strip = hsSpriteTexture.peekSprite(orig)
  if (!strip) {
    let asking = hsSpriteWaiting.get(orig)
    if (!asking) hsSpriteWaiting.set(orig, (asking = new Set()))
    asking.add(img)
    hsSpriteTexture.spriteFor(orig)
    return false
  }
  const fresh = !hsSpriteLive.has(img)
  hsSpriteTexture.mountSprite(wrap, strip)
  hsSpriteLive.add(img)
  // Under a running sprite the img only holds the box: park it on the cdn's own static file so it
  // is not a second decoder nobody can see. Never the heatsync proxy — that would put a server
  // request behind every visible kick emote that today costs none.
  const still = deriveStaticEmoteSrc(orig, true)
  if (still !== orig && !still.includes('/api/emote-proxy') && img.src !== still) img.src = still
  // The delay mountSprite writes is exact only if the animation starts in the frame it was read in;
  // this seeks it onto the clock once it really exists (lib/animation-phase.js).
  if (fresh && typeof anchorWhenStarted === 'function') anchorWhenStarted([wrap])
  if (hsSpriteLive.size > 600) hsSpritePrune()
  return true
}

/** Rows trimmed from the pane leave their imgs behind in the sets; forget them. */
function hsSpritePrune() {
  for (const img of hsSpriteLive) if (!img.isConnected) hsSpriteLive.delete(img)
  for (const [url, asking] of hsSpriteWaiting) {
    for (const img of asking) if (!img.isConnected) asking.delete(img)
    if (!asking.size) hsSpriteWaiting.delete(url)
  }
}

// A strip that finished after its rows rendered: the rows that asked are still showing the animated
// <img>, so switch each one over — if it is still on screen (leaving the screen drops it from here).
hsSpriteTexture.setOnReady((url) => {
  const asking = hsSpriteWaiting.get(url)
  hsSpriteWaiting.delete(url)
  if (!asking) return
  for (const img of asking) {
    if (!img.isConnected) continue
    const wrap = img.parentElement
    if (wrap?.dataset?.emoteUrl === url) hsSpriteTry(img, wrap, url)
  }
})

// A hidden tab renders nothing, so nothing is gained by keeping the sprites; and they return from
// the wall clock rather than from where they froze (a remount recomputes the delay).
if (typeof document !== 'undefined' && typeof cleanup?.addEventListener === 'function') {
  cleanup.addEventListener(document, 'visibilitychange', () => {
    if (document.hidden) {
      hsSpriteParked = new Set(hsSpriteLive)
      for (const img of hsSpriteParked) hsSpriteTexture.unmountSprite(img.parentElement)
      hsSpriteLive.clear()
      return
    }
    const back = hsSpriteParked
    hsSpriteParked = new Set()
    for (const img of back) {
      const wrap = img.parentElement
      if (img.isConnected && wrap?.dataset?.emoteUrl) hsSpriteTry(img, wrap, wrap.dataset.emoteUrl)
    }
  })
}

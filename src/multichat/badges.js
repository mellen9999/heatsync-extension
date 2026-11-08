// The heatsync badge mark beside a chatter's name.
//
// Which badge a user shows is decided server-side (the one they picked, else
// their best) and arrives as a single id on the same /api/paints batch as their
// paint, plus mark and colour — no request of its own. Glyph, colour and words
// are ours: lib/badge-catalogue.js (a verbatim copy of the site's list) plus the
// mc_badge_<id>_label / _how strings. An id this build does not know draws
// nothing, so a badge added later never shows a broken mark on an older build.
//
// Placement matches the plus mark: right after the sender's name, and after the
// plus mark when there is one. main.js bakes it at render time from the cache;
// applyHsPlusTenureToVisible (cosmetics.js) places it when it resolves late.
// Same 13px text-badge spec as every other text badge (styles/08-message-rows.css).

const HS_BADGE_CACHE_MAX = 500
const HS_BADGE_ID_RE = /^[a-z0-9_]{1,32}$/
const hsBadgeCache = new Map() // uid -> badge id | null (cached-negative)

/** Remember what a uid shows. Anything that is not a plain catalogue-shaped id is stored as "none". */
function setHsBadgeEntry(uid, id) {
  if (!hsBadgeCache.has(uid) && hsBadgeCache.size >= HS_BADGE_CACHE_MAX) {
    hsBadgeCache.delete(hsBadgeCache.keys().next().value)
  }
  hsBadgeCache.set(uid, typeof id === 'string' && HS_BADGE_ID_RE.test(id) ? id : null)
}

/** @returns {string|null} the badge id `uid` shows, null for none / not yet looked up. */
function getHsBadgeId(uid) {
  return hsBadgeCache.get(uid) ?? null
}

/** "name — how it is earned", in the viewer's language. */
function hsBadgeTitle(id) {
  return `${t(`mc_badge_${id}_label`)} — ${t(`mc_badge_${id}_how`)}`
}

/** The mark as HTML ('' for none / unknown). Only catalogue constants and a t() string reach the markup. */
function renderHsBadgeToken(id) {
  const b = badgeById(id)
  if (!b) return ''
  return `<span class="hs-badge" style="color:${b.color}" title="${escapeHtml(hsBadgeTitle(b.id))}" data-badge="${b.id}">${b.glyph}</span>`
}

/** The mark as an element (safe setters), null for none / unknown. */
function buildHsBadgeToken(id) {
  const b = badgeById(id)
  if (!b) return null
  const el = document.createElement('span')
  el.className = 'hs-badge'
  el.style.color = b.color
  el.title = hsBadgeTitle(b.id)
  el.dataset.badge = b.id
  el.textContent = b.glyph
  return el
}

/**
 * Put the right mark after `nameEl` (and after its plus mark). Idempotent;
 * replaces a changed badge and takes one off that went away.
 */
function placeHsBadgeToken(nameEl, id) {
  if (!nameEl) return
  let anchor = nameEl
  if (anchor.nextElementSibling?.classList?.contains('hs-plus-tenure')) anchor = anchor.nextElementSibling
  const cur = anchor.nextElementSibling?.classList?.contains('hs-badge') ? anchor.nextElementSibling : null
  if (cur && cur.dataset.badge === id) return
  cur?.remove()
  const token = id ? buildHsBadgeToken(id) : null
  if (token) anchor.insertAdjacentElement('afterend', token)
}

export { buildHsBadgeToken, getHsBadgeId, hsBadgeTitle, placeHsBadgeToken, renderHsBadgeToken, setHsBadgeEntry }

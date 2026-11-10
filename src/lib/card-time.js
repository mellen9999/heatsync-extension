/**
 * card-time.js — the one relative-time / account-age / tenure formatter for
 * every user card on every surface (site + extension).
 *
 * Before this there were 3 copies of the same compact-relative-time logic
 * (client/managers/utility-manager.js `getCompactRelativeTime`,
 * client/components/profile-card-lite.js `relTime`, and a bespoke same-day/
 * cross-day absolute formatter for the recent-logs strip in
 * client/events/hover-previews.js `_appendRecentLogs`) and 2 copies of
 * account-age (client/renderers/profile-renderer.js `getAccountAge`, which
 * diverged from the above — "1mo" vs "1m" for a 6-week-old account — and
 * utility-manager's own `getAccountAge`, a bare alias of its relative-time).
 *
 * Also the one "where does the underline go" split for a hotkey label
 * (`hsCardHotkeySplit`): the renderer and every host that repaints a card
 * button's label ask it, and it lives in this leaf because the boot path
 * already carries card-time while the renderer is a lazy chunk.
 *
 * Dependency-free leaf: no imports, no DOM, no `app`. Plain named exports,
 * globally-unique `hsCard`-prefixed top-level names, mirrored byte-for-byte
 * into the extension's non-ESM bundle.
 *
 * @module card/card-time
 */

/**
 * Ultra-compact relative time: "5s" / "12m" / "3h" / "6d" / "3w" / "11mo" / "3y".
 * The single canonical implementation — account age, "you follow since",
 * "sub 14mo", corpus "since 2024-02" all resolve through this.
 * @param {string|number|Date|null|undefined} timestamp
 * @returns {string} '???' when the timestamp is missing/unparseable
 */
export function hsCardRelativeTime(timestamp) {
  if (!timestamp) return '???'
  const date = new Date(timestamp)
  const diffMs = Date.now() - date.getTime()
  if (!Number.isFinite(diffMs)) return '???'

  const s = Math.floor(diffMs / 1000)
  const m = Math.floor(diffMs / 60000)
  const h = Math.floor(diffMs / 3600000)
  const d = Math.floor(diffMs / 86400000)
  const w = Math.floor(d / 7)
  const mo = Math.floor(d / 30)
  const y = Math.floor(d / 365)

  if (s < 60) return `${Math.max(0, s)}s`
  if (m < 60) return `${m}m`
  if (h < 24) return `${h}h`
  if (d < 7) return `${d}d`
  if (w < 5) return `${w}w`
  if (mo < 12) return `${Math.min(mo, 99)}mo`
  return `${Math.min(y, 99)}y`
}

/**
 * Account age is relative time from the creation date — kept as its own
 * named export (not a raw alias reference) so call sites read as intent,
 * not coincidence. Previously TWO divergent implementations existed; this
 * is now the only one.
 * @param {string|number|Date|null|undefined} createdAt
 * @returns {string|null} null (not '???') when there is nothing to show —
 *   callers use this to skip the sheet row entirely, unlike the visible
 *   in-card '???' fallback of hsCardRelativeTime.
 */
export function hsCardAccountAge(createdAt) {
  if (!createdAt) return null
  return hsCardRelativeTime(createdAt)
}

/**
 * Absolute timestamp for the recent-logs strip: "HH:MM" for today,
 * "MM-DD HH:MM" otherwise. Folds hover-previews.js's inline formatter — the
 * third "relative-time-adjacent" implementation the plan named for
 * consolidation, even though it's absolute, not relative.
 * @param {string|number|Date|null|undefined} timestamp
 * @param {{ now?: Date }} [opts] injectable "now" for tests
 * @returns {string} '' when unparseable
 */
export function hsCardLogTime(timestamp, { now = new Date() } = {}) {
  const ts = new Date(timestamp)
  if (Number.isNaN(ts.getTime())) return ''
  const sameDay = ts.toDateString() === now.toDateString()
  const hm = `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}`
  if (sameDay) return hm
  return `${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')} ${hm}`
}

/**
 * Channel sub-tenure in whole months (the shape the local IRC subTenureMap
 * carries — an integer, not a date) into "1y 2mo" / "3mo".
 * @param {number|null|undefined} months
 * @returns {string|null}
 */
export function hsCardTenureMonths(months) {
  if (!Number.isFinite(months) || months <= 0) return null
  const y = Math.floor(months / 12)
  const m = months % 12
  if (y <= 0) return `${months}mo`
  return m > 0 ? `${y}y ${m}mo` : `${y}y`
}

/**
 * Where a hotkey sits inside its label: [before, key, after], or null when the
 * label has no such character. The first occurrence, case-insensitive, by code
 * point. No occurrence means no underline and no key — the underline is never an
 * extra glyph, and a key the label cannot show is not bound. Every host that
 * repaints a label (the follow button's "unfollow", the extension's "unmute")
 * asks this, so the underline lands in one place.
 * @param {string} label
 * @param {string} [hotkey]
 * @returns {[string, string, string]|null}
 */
export function hsCardHotkeySplit(label, hotkey) {
  if (!hotkey) return null
  const cs = Array.from(String(label))
  const k = String(hotkey).toLowerCase()
  const at = cs.findIndex((c) => c.toLowerCase() === k)
  return at < 0 ? null : [cs.slice(0, at).join(''), cs[at], cs.slice(at + 1).join('')]
}

/**
 * plus-tenure.js — the HeatSync Plus tenure token.
 *
 * A small text badge shown next to an ACTIVE Plus member's name: the bare "+"
 * Plus mark. It's the paid-tier flex — the counterpart to paints. Tenure lives
 * in the COLOR (longer = brighter through neutral greys; orange is reserved for
 * the heat metric — landing palette doctrine, only 5y+ legends reach medal
 * gold) and the hover title — never in extra text, the mark stays one char.
 *
 * Data source: `plus_since` (users.plus_first_subscribed_at), which the server
 * exposes ONLY while the user is currently entitled (see server/routes/
 * profiles.ts + /api/auth/me). A null `since` means "not an active Plus member"
 * → no token. Inputs are date/number coerced, so the output needs no escaping.
 *
 * @module utils/plus-tenure
 */

const MONTH_MS = 2629746000 // average gregorian month (365.2425/12 days)

/** Whole months a member has been on Plus, from their first-subscribed date. */
export function plusTenureMonths(since) {
  if (!since) return 0
  const t = since instanceof Date ? since.getTime() : Date.parse(since)
  if (!Number.isFinite(t)) return 0
  return Math.max(0, Math.floor((Date.now() - t) / MONTH_MS))
}

/** Tenure ramp: dim→bright greyscale that earns medal gold at 5y+. Deliberately
 *  OFF the orange/heat ramp — orange is reserved for the heat metric (see
 *  landing.html palette doctrine), so tenure signals "longer = brighter" in
 *  neutral greys and rewards veterans with the premium --gold token instead of
 *  competing with heat for the same hue. */
export function plusTenureColor(months) {
  const m = Number(months) || 0
  if (m >= 60) return '#ffd700' // 5y+  — medal gold (premium/VIP token)
  if (m >= 36) return '#cccccc' // 3y+  — bright
  if (m >= 12) return '#aaaaaa' // 1y+  — mid
  if (m >= 6) return '#999999'  // 6mo+ — dim
  return '#777777'              // 1–5mo — dimmest (--dim)
}

/** Hover text, no middot. "3 years on heatsync plus" / "heatsync plus member". */
export function plusTenureTitle(months) {
  const m = Number(months) || 0
  if (m < 1) return 'heatsync plus member'
  if (m < 12) return `${m} month${m === 1 ? '' : 's'} on heatsync plus`
  const y = Math.floor(m / 12), r = m % 12
  const yr = `${y} year${y === 1 ? '' : 's'}`
  return r > 0 ? `${yr} ${r}mo on heatsync plus` : `${yr} on heatsync plus`
}

/**
 * The token, ready to drop beside a username. Empty string when `since` is
 * absent (not an active Plus member). The visible text is ALWAYS the bare "+"
 * Plus brand mark (see the plus page's "+ " feature bullets) — tenure is
 * carried by the ramp color and the hover title only. Injection-safe: only
 * date/number-derived text reaches the HTML.
 */
export function renderPlusTenureToken(since) {
  if (!since) return ''
  const m = plusTenureMonths(since)
  return `<span class="hs-plus-tenure" style="color:${plusTenureColor(m)}" title="${plusTenureTitle(m)}">+</span>`
}

/**
 * Same token as an HTMLElement, built via safe DOM setters (textContent/style/
 * title — never innerHTML). Use for live DOM injection so no HTML-string sink is
 * involved at all. Returns null when `since` is absent. Browser-only (uses
 * document); SSR uses renderPlusTenureToken above.
 */
export function buildPlusTenureToken(since) {
  if (!since) return null
  const m = plusTenureMonths(since)
  const el = document.createElement('span')
  el.className = 'hs-plus-tenure'
  el.style.color = plusTenureColor(m)
  el.title = plusTenureTitle(m)
  el.textContent = '+'
  return el
}

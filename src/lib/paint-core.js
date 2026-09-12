/**
 * paint-core — tiny pure helpers shared by the paint compiler
 * (paint-spec.js) and the scene compiler (scene-spec.js).
 *
 * Dependency-free and server-importable, same contract as paint-spec.js:
 * no DOM, no fetch, nothing user-typed ever passes through unclamped.
 * Split out so scene-spec.js never has to import paint-spec.js (which
 * imports scene-spec.js — this module breaks the cycle).
 */

export const HEX_RE = /^#[0-9a-fA-F]{6}$/

export const MIN_SPEED = 0.25
export const MAX_SPEED = 3

// WCAG 2.3.1 flashing-content guard, stricter than the 3Hz threshold: any
// effect that changes luminance must have a real-world animation period of
// at least 1s AFTER the user's speed multiplier is applied.
export const MIN_LUMINANCE_PERIOD_S = 1

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function isIntInRange(v, min, max) {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= min && v <= max
}

export function isNumInRange(v, min, max) {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
}

export function safeHex(color, fallback = '#e4e4e4') {
  return typeof color === 'string' && HEX_RE.test(color) ? color.toLowerCase() : fallback
}

export function safeSpeed(speed) {
  const n = Number(speed)
  return Number.isFinite(n) ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, n)) : 1
}

/** Real-world period in seconds for a layer at the given speed, with the
 * WCAG luminance floor applied when the layer changes luminance. */
export function periodSeconds(basePeriod, speed, luminance) {
  let seconds = basePeriod / safeSpeed(speed)
  if (luminance) seconds = Math.max(MIN_LUMINANCE_PERIOD_S, seconds)
  return Math.round(seconds * 1000) / 1000
}

// ── REDRAW RATE LIMITING ────────────────────────────────────────────────────
//
// An animation that changes a painted value re-rasters its element on every
// frame the display offers — 60 a second, for ambient motion nobody is tracking.
// `steps(n)` holds the computed value between steps, and a value that does not
// change is not repainted, so the same visible motion costs n redraws a second.
//
// Measured with `scripts/paint-perf.mjs --cost`, one painted name, 3s at 4x CPU,
// both scene planes animating:
//
//   linear (60/s) 501ms · 20/s 211ms · 12/s 124ms · 8/s 79ms
//
// Two rates, because the two populations are watched differently. A scene plane
// IS the motion you notice, so it keeps more of it. A fill sweeping through the
// glyphs is texture, and the person who reported the lag said outright that
// steppiness does not bother them — so it takes the cheaper end.
export const SCENE_STEPS_PER_SECOND = 12
export const FILL_STEPS_PER_SECOND = 8

/**
 * `steps()` timing that redraws `rate` times a second — or null when this
 * animation must not be quantised at all.
 *
 * **A luminance-changing animation is never stepped.** Quantising a smooth
 * brightness ramp turns it into `rate` brightness CHANGES a second, and at any
 * rate worth having for performance that is far past the 3Hz flashing threshold
 * MIN_LUMINANCE_PERIOD_S above already guards against — 2026-09-11 shipped
 * exactly that for `furnace`, `eclipse` and `storm` (lightning) before it was
 * caught. Stepping slower is not a fix either: ≤3/s still sits at the threshold
 * and looks worse than smooth. So luminance opts out entirely, and callers fall
 * back to their own timing function.
 *
 * `n` is derived from the animation's OWN period, never a fixed count: a flat
 * `steps(12)` is twelve steps across the period, which would quantise a 16s
 * plate to one jump every 1.3s and leave a 0.9s loop untouched — the same
 * requested rate meaning two different pictures.
 *
 * Only correct for SINGLE-INTERVAL keyframes. A CSS timing function applies per
 * keyframe interval, not per animation, so `steps(n)` on multi-stop keyframes
 * gives n steps *inside each interval* and multiplies the redraw rate instead of
 * capping it. Every caller here drives a one-interval `to{}` phase.
 *
 * @param {number} period - full cycle in seconds
 * @param {number} rate - target redraws per second
 * @param {{luminance?: boolean, oneWay?: boolean}} [opts] - `oneWay` uses
 *   `jump-none` so the final keyframe is actually shown; a one-way ramp under
 *   the default `jump-end` stops a step short of its end every cycle.
 * @returns {string|null} timing function, or null if it must not be stepped
 */
export function steppedTiming(period, rate, opts = {}) {
  if (opts.luminance) return null
  const n = Math.max(1, Math.round(period * rate))
  return opts.oneWay ? `steps(${n}, jump-none)` : `steps(${n})`
}

/** Phase-lock delay for a paint/scene animation. Elements carry `--hsp-t`
 * (their mount wall-time in seconds — see paintPhaseNow in paint-spec.js),
 * and mod() folds it onto this animation's full visual cycle, so every copy
 * of the same name lands on the same frame regardless of when it mounted.
 * `period` must be the FULL cycle: duration ×2 for alternate-direction
 * animations (odd iterations run reversed — duration alone would sync half
 * the copies mirror-phased). Elements without the var (or browsers without
 * mod()) resolve to 0s — per-mount unsynced, never a broken paint. */
export function syncDelayCalc(period) {
  const p = Math.round(period * 1000) / 1000
  return `calc(-1 * mod(var(--hsp-t, 0s), ${p}s))`
}

/** FNV-1a 32-bit hash, base36-encoded. Sync + dependency-free — stable
 * across processes/platforms, adequate for cosmetic CSS class/keyframe
 * naming (collisions are a visual dedup nit, not a security concern). */
export function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

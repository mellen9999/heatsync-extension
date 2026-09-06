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

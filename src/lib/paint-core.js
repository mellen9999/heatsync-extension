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
// RAISED 2026-09-16, from 8/12 to 16/24 — see THE CROWD DIAL below for the
// measurement. Doubling both keeps the fill/scene ratio (a scene plane is the
// motion you notice, so it still keeps more of it) and, because CROWD_TIERS is
// unchanged, doubles the redraw rate at EVERY tier uniformly: the new "chunky"
// lands where "full" used to sit, the new "chunkier" where "chunky" used to —
// nothing here is a new regime, the whole ladder just moved up one rung. This
// is also the direct fix for "fire rain is choppy": fire (a paint-slot fill,
// FILL_STEPS_PER_SECOND) and rain (a scene weather plane, SCENE_STEPS_PER_SECOND)
// quantise on two INDEPENDENT steps() schedules that were never going to phase-
// align, and at the old chunkier tier they fell to 2/s and 3/s respectively —
// coarse enough that the mismatch between them reads as stutter rather than
// texture. Raising the floor doesn't make them agree, it makes the disagreement
// small enough to stop being visible.
export const SCENE_STEPS_PER_SECOND = 24
export const FILL_STEPS_PER_SECOND = 16

/**
 * ── THE CROWD DIAL ──────────────────────────────────────────────────────────
 *
 * The rates above are what ONE name costs. When a lot is moving at once,
 * everything moves in coarser steps instead of anything stopping.
 * paint-cosmetics puts `hs-paint-chunky` / `hs-paint-chunkier` on <body> from
 * the on-screen animation weight it already measures, and the compiler emits a
 * matching `animation-timing-function` for each tier beside every animation it
 * writes. One class flip retimes every painted name and every scene plane on
 * the page together — which is the only sense in which identical animations can
 * be "linked", since the pixels cannot be.
 *
 * ── WHAT THE DIAL IS WORTH NOW, AND WHY IT IS NOT WHAT IT USED TO BE ────────
 *
 * This paragraph read "20 copies measure 3694ms of renderer per 3s" for months
 * after that stopped being true. That figure is the `background-clip:text` era,
 * when every glyph of every copy was its own re-rastering clip-text layer.
 * Scene planes moved onto composited transforms and the fill followed, and the
 * cost collapsed by a factor of sixty — while the sentence justifying the dial
 * stayed put. A stale measurement reads exactly like a current one.
 *
 * Measured 2026-09-16 with `paint-perf --dial` (heatpc), lava, 414x896 @ dpr3,
 * cpu 4x, renderer ms per 3s of a 3000ms budget, AT THE OLD RATES (8/12,
 * the numbers the raise above is measured against):
 *
 *   names    full    chunky   chunkier      of which raster
 *      3     42.1     24.0      20.8        2.5 / 1.4 / 0.6
 *      6     48.5     38.9      19.0        3.6 / 1.8 / 0.8
 *     12     61.6     46.5      35.1        5.5 / 2.6 / 1.2
 *     20     86.7     52.1      33.0        9.8 / 5.6 / 2.0
 *
 * So renderer time cannot justify keeping this low: 86.7ms of a 3000ms budget
 * is ~2.9% even at 20 names UNTHROTTLED, and doubling the redraw rate (the
 * change above) tracks sub-linearly with raster in this range (8/s->16/s
 * measured elsewhere as +1.75x cost, not +2x) — so the new "full" tier is
 * still comfortably under 1% of budget. CORRECTION to every prior version of
 * this comment: the harness is NOT blind to raster — `--dial`'s table above
 * has carried a raster column since the arm was written (RasterTask trace
 * events, real Chrome tracing, not a guess). What it cannot see is a real
 * mobile GPU's own compositing/submission cost, which is a narrower gap than
 * "blind to raster" claimed. The one real-user number this reasoning used to
 * lean on — mobile `inp_kb_presentation` — was separately investigated and
 * found to be noise at n=6-20/day, not a genuine paint-cost regression (see
 * project memory, 2026-09-14), so it is no longer a reason to hold this rate
 * down; the real pre-launch mobile number is LCP, unrelated to paint cost.
 *
 * To move this further: `paint-perf --dial` for the ratio, a real device or
 * Titan's real-user data for anything raster-adjacent it still can't see —
 * and write which one moved it here, with the date, so the next reader can
 * tell a measurement from a memory.
 *
 * NOT a divisor on the period, which would be slow motion. Same speed, fewer
 * redraws — "idc about steppy because bitmap and pixels".
 */
export const CROWD_TIERS = [['chunky', 2], ['chunkier', 4]]

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
  const s = steppedSteps(period, rate, opts)
  if (!s) return null
  return s.jumpNone ? `steps(${s.n}, jump-none)` : `steps(${s.n})`
}

/** The step grid behind steppedTiming — `{ n, jumpNone }`, or null when the
 * effect is luminance-flagged and must not be stepped at all.
 *
 * Separate because a caller that samples a curve into a `linear()` easing needs
 * the SAME grid steppedTiming would have imposed, not a second guess at it: the
 * sampled easing holds one value per step, so the two have to agree stop for
 * stop or the conversion is not the motion it replaced. */
export function steppedSteps(period, rate, opts = {}) {
  if (opts.luminance) return null
  return { n: Math.max(1, Math.round(period * rate)), jumpNone: !!opts.oneWay }
}

/**
 * The progress curves a fill can move along, as plain functions of 0→1
 * animation progress. They are the same cosines the compiler used to write as
 * calc() over an animated custom property, which is the point: sampling these
 * reproduces that motion rather than approximating it.
 */
export const EASING_CURVES = {
  /** there-and-back within one cycle — 0 at p=0, 1 at p=.5, 0 at p=1. */
  roundTrip: (p) => (1 - Math.cos(p * 2 * Math.PI)) / 2,
  /** one-way eased ramp — 0 at p=0, 1 at p=1. */
  oneWay: (p) => (1 - Math.cos(p * Math.PI)) / 2,
}

/** Segments in a smooth (unstepped) sampled easing. Only the luminance effects
 * reach that path — the rate cap deliberately exempts them — so their curve has
 * to be a polyline instead of a staircase. 64 segments put the worst-case
 * deviation from the true cosine at 6e-4 of the animated range: under half a
 * step of 8-bit colour, and under a subpixel of any fill position. */
const SMOOTH_EASING_POINTS = 64

/**
 * A progress curve as a CSS `linear()` easing, quantised to the same grid
 * `steppedTiming` would have imposed.
 *
 * This is what lets a cosine fill stop driving a custom property. The phase used
 * to be a registered `@property` ramping 0→1 with every real value derived from
 * it by calc() — a style-engine animation, and `inherits:true` dirties the
 * element and its whole subtree every frame (8.7x the style cost for the same
 * pixels, `paint-perf.mjs --phasevar`). The values it produced were not linear
 * in that phase, which is why two keyframes alone could not replace it:
 * `steps()` REPLACES a timing function, so two stops plus steps() space the held
 * values evenly in TIME where the phase ramp spaced them along the COSINE.
 *
 * An easing is the missing piece, and it is exact. `linear()` remaps progress to
 * any curve — including a non-monotonic one, so a there-and-back needs neither a
 * third keyframe nor `alternate`: the animation still runs A→B, and an easing
 * that rises to 1 at the half and returns to 0 makes that a round trip. Two
 * stops, one interval, the original period and direction, so one seek still
 * lands on one phase and the pixel gate can compare it.
 *
 * The staircase is what stops the redraw (REDRAW RATE LIMITING above): one
 * sampled value held flat across its whole interval. Those held values land on
 * exactly the phases `steps(n)` on the old ramp held — same n, same boundaries,
 * same pixels.
 *
 * Fails soft twice over. An engine without `linear()` (pre-2023) drops the
 * `animation-timing-function` declaration and every animation falls back to its
 * shorthand's own function — `ease-in-out`, the same shape spaced slightly
 * differently, never a frozen paint. And because the easing rides that
 * declaration rather than a keyframe, the crowd dial can still replace it: a
 * timing function named INSIDE a keyframe would outrank the dial's rule and
 * quietly make it inert.
 */
export function sampledEasing(curve, period, rate, opts = {}) {
  const f = EASING_CURVES[curve]
  if (!f) return null
  const r = (v) => String(Math.round(v * 1e5) / 1e5)
  const pct = (v) => `${Math.round(v * 1e4) / 1e4}%`
  const grid = steppedSteps(period, rate, opts)
  const out = []
  if (!grid) {
    for (let i = 0; i <= SMOOTH_EASING_POINTS; i++) {
      const q = i / SMOOTH_EASING_POINTS
      out.push(`${r(f(q))} ${pct(q * 100)}`)
    }
    return `linear(${out.join(',')})`
  }
  for (let k = 0; k < grid.n; k++) {
    // `jump-none` spreads n held values across BOTH endpoints (glint's sweep
    // has to show its final frame); the default `jump-end` holds n values from
    // the start and never shows the last. Same rule steppedTiming picks by.
    const q = grid.jumpNone ? (grid.n === 1 ? 0 : k / (grid.n - 1)) : k / grid.n
    // One entry, two input positions — the value is held flat between them.
    out.push(`${r(f(q))} ${pct(k * 100 / grid.n)} ${pct((k + 1) * 100 / grid.n)}`)
  }
  return `linear(${out.join(',')})`
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

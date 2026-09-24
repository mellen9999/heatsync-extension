/**
 * Paint authoring — the SAVE-TIME half of the paint spec: validation, the
 * legibility floor, effect-combination rules, the legacy shadow a fill stores
 * for old extension builds, and the builder's small arithmetic helpers.
 *
 * ── why this is not in paint-spec.js ──────────────────────────────────────
 * paint-spec.js is pinned into the `core` chunk by vite.config.js, because the
 * render path reaches it on every route: message-element and message-renderer
 * compile a paint for names that are on screen at first paint. Everything in
 * THIS file runs only when someone SAVES a paint — the builder, and the
 * server's PUT /api/user/paint gate. None of it has ever been reachable from a
 * rendered name, but while it lived in the same module it rode into the boot
 * closure anyway: a chunk is pinned as a whole, and rollup cannot split one.
 *
 * Measured 2026-09-23, the build that took the closure 15,909B over budget:
 * the fill series had grown paint-spec.js by 63KB of source, and 668 lines of
 * what was already there were save-time only. Moving them takes those bytes
 * off the high-priority preload of every route and into `settings`, which is
 * where the only client that calls them already lives.
 *
 * So the rule this file exists to keep: if a function is only ever called
 * before a paint is stored, it belongs here. If a rendered name can reach it,
 * it belongs in paint-spec.js. The import arrow points ONE way — authoring
 * imports from paint-spec, never the reverse, or the split does nothing.
 *
 * Pure data, like paint-spec: no DOM, no fetch, server-importable.
 */

import {
  HEX_RE, MIN_SPEED, MAX_SPEED,
  isPlainObject, isIntInRange, isNumInRange, safeSpeed,
} from './paint-core.js'
import { validateSceneSpec } from './scene-spec.js'
import {
  MAX_EFFECTS, EFFECTS, EFFECT_IDS,
  BASE_TYPES, GLOW_STRENGTHS, MIN_STOPS, MAX_STOPS,
  MIN_TILE_WIDTH, MAX_TILE_WIDTH, PAN_MIN_SCALE, PAN_MAX_SCALE,
  MIN_FILL_LAYERS, MAX_FILL_LAYERS, MIN_FILL_STOPS, MAX_FILL_STOPS,
  MIN_FILL_TILE_NAME, MAX_FILL_TILE_NAME, MIN_FILL_TILE_PX, MAX_FILL_TILE_PX,
  FILL_LAYER_KINDS, FILL_TILE_UNITS, FILL_MOTION_TYPES,
  isFillColor, repairStopCollisions, upgradeSpec, motionGroupKey,
  safeAngle, upgradePan, baseAsFillLayer,
} from './paint-spec.js'

// ── plus tier caps (single source — server save gate + builder UI) ────────
// Free = a single solid color (base.type 'solid', no glow, ZERO effect
// layers); plus = gradients + glow + up to MAX_EFFECTS animated layers.
// Gradient paints are a paid perk elsewhere (7tv sells them) — heatsync
// competes paid-vs-paid, never free-trumps. Rendering is never gated
// anywhere — these caps only apply to SAVING.
export const FREE_MAX_EFFECTS = 0
export const PLUS_MAX_EFFECTS = MAX_EFFECTS
// (WCAG luminance-period guard lives in paint-core.js — MIN_LUMINANCE_PERIOD_S.
//  That one bounds how fast a paint may CHANGE luminance, for photosensitivity.
//  The floor below is the other axis: whether it can be READ while static.)

// ── legibility floor ──────────────────────────────────────────────────────
// A paint is read at 13px, on near-black, beside twenty other names, in a feed
// that is moving. The binding constraint was never how much colour freedom to
// hand out — it is that an unreadable name degrades the room for EVERYONE, not
// just its owner, and a name nobody can read is not self-expression.
//
// So this is a save-time rule, not a hint: the builder dims sub-floor swatches
// and the server refuses a sub-floor spec. Rendering is never gated (same
// posture as the tier caps above), so paints saved before this existed keep
// working — the floor applies the next time someone saves one.
//
// 3.0 rather than WCAG's 4.5 for body copy: names render bold, and this is a
// nickname, not prose. It is still a floor, not a suggestion.
export const PAINT_BG = '#0a0a0a'
export const PAINT_MIN_CONTRAST = 3

/** WCAG 2.x relative luminance of an #rrggbb string. Internal — contrastRatio
 * is the one everything else wants. */
function relativeLuminance(hex) {
  const n = parseInt(hex.slice(1), 16)
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map(v => v / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

/** WCAG contrast ratio between two #rrggbb strings. Order-independent. */
export function contrastRatio(hexA, hexB) {
  const a = relativeLuminance(hexA)
  const b = relativeLuminance(hexB)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** True when a single colour clears the floor against the chat background. */
export function isLegiblePaintColor(hex, bg = PAINT_BG) {
  return HEX_RE.test(hex) && contrastRatio(hex, bg) >= PAINT_MIN_CONTRAST
}

/**
 * A gradient is only as readable as its DIMMEST stop, so the paint is scored by
 * the weakest one — averaging would let a bright stop launder a black one.
 * Returns null when there is nothing valid to score.
 */
export function paintContrast(stops, bg = PAINT_BG) {
  if (!Array.isArray(stops)) return null
  const ratios = stops
    .filter(s => isPlainObject(s) && typeof s.color === 'string' && HEX_RE.test(s.color))
    .map(s => contrastRatio(s.color, bg))
  return ratios.length ? Math.min(...ratios) : null
}

/** #rrggbb(aa) -> {r,g,b,a}, channels 0-255, alpha 0-1. Assumes a value
 * already passed isFillColor — callers that can't guarantee that go through
 * safeFillColor first (paint-spec's compiler-side "never trust the input"
 * contract). */
function parseFillColor(hex) {
  const h = hex.slice(1)
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
  }
}

/** src-over: `fg` (with alpha) painted onto an opaque `bg`. */
function compositeOver(fg, bg) {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
  }
}

function rgbToHex({ r, g, b }) {
  const h = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

/** A single layer's colour at `pos` (0-100), linearly interpolating between
 * its bracketing stops (colour AND alpha) — flat before the first stop and
 * after the last, same as the gradient itself paints. Stops need not be
 * pre-sorted. */
function layerColorAt(stops, pos) {
  const sorted = [...stops]
    .filter(s => isPlainObject(s) && isFillColor(s?.color) && isNumInRange(s?.pos, 0, 100))
    .sort((a, b) => a.pos - b.pos)
  if (!sorted.length) return { r: 0, g: 0, b: 0, a: 0 }
  if (pos <= sorted[0].pos) return parseFillColor(sorted[0].color)
  const last = sorted[sorted.length - 1]
  if (pos >= last.pos) return parseFillColor(last.color)
  for (let i = 1; i < sorted.length; i++) {
    if (pos > sorted[i].pos) continue
    const a = sorted[i - 1], b = sorted[i]
    const t = b.pos === a.pos ? 0 : (pos - a.pos) / (b.pos - a.pos)
    const ca = parseFillColor(a.color), cb = parseFillColor(b.color)
    return { r: ca.r + (cb.r - ca.r) * t, g: ca.g + (cb.g - ca.g) * t, b: ca.b + (cb.b - ca.b) * t, a: ca.a + (cb.a - ca.a) * t }
  }
  return parseFillColor(last.color)
}

/**
 * Worst-case (dimmest) contrast of a flattened fill layer stack against
 * `bg`, alpha-composited bottom to top — NOT scored per stop, because a stop
 * is only ever seen through the layers on top of it. A shine layer whose own
 * stops go transparent -> white -> transparent must not fail the floor at
 * its transparent ends: composited there, it's simply whatever the base
 * layer already painted (which the base's own stops already had to clear).
 *
 * Sampled at every stop position across the stack (plus 0/100), which is
 * exactly where the composite can change — linear interpolation between
 * samples can't introduce a new local extreme a stop position didn't already
 * bracket. Returns null if there is nothing valid to score.
 */
export function fillContrast(layers, bg = PAINT_BG) {
  if (!Array.isArray(layers) || !layers.length) return null
  const bgRgb = parseFillColor(bg)
  const positions = new Set([0, 100])
  for (const layer of layers) {
    if (!isPlainObject(layer) || !Array.isArray(layer.stops)) continue
    for (const s of layer.stops) {
      if (isPlainObject(s) && isNumInRange(s?.pos, 0, 100)) positions.add(Math.round(s.pos * 10) / 10)
    }
  }
  let worst = null
  for (const pos of positions) {
    let composite = { r: bgRgb.r, g: bgRgb.g, b: bgRgb.b }
    for (const layer of layers) {
      if (!isPlainObject(layer) || !Array.isArray(layer.stops) || !layer.stops.length) continue
      composite = compositeOver(layerColorAt(layer.stops, pos), composite)
    }
    const ratio = contrastRatio(rgbToHex(composite), bg)
    if (worst === null || ratio < worst) worst = ratio
  }
  return worst
}

/**
 * Why `id` cannot join `effects` — a string, or null when it can.
 *
 * Two motions that animate the same property on the same target clobber each
 * other outright (the later `animation-name` wins), so that pair is refused.
 * A paint effect that animates something other than the background (hue:
 * filter, pulse: opacity) is refused against any motion on that PROPERTY on
 * either target, because a paint effect follows the split: on a letter-split
 * name it lands on the spans, where a `letter:` motion already is.
 *
 * Shared by the validator (every save) and the builder (which dims the chips
 * that could not be saved) so the two never disagree about a combination.
 */
export function effectConflict(id, effects) {
  const meta = EFFECTS[id]
  if (!meta) return 'unknown effect'
  const others = (Array.isArray(effects) ? effects : []).filter(e => isPlainObject(e) && e.id !== id && EFFECTS[e.id])
  const prop = sig => sig.slice(sig.indexOf(':') + 1)
  for (const o of others) {
    const om = EFFECTS[o.id]
    if (meta.slot === 'paint' && om.slot === 'paint') return 'at most 1 paint-slot effect'
    if (!meta.sig || !om.sig) continue
    const bothMotion = meta.slot === 'motion' && om.slot === 'motion'
    if (bothMotion ? meta.sig === om.sig : prop(meta.sig) === prop(om.sig)) {
      return `"${id}" conflicts with "${o.id}" — both animate ${prop(meta.sig)}`
    }
  }
  return null
}

/**
 * Paints that read EVERY stop, not just the first — so a one-stop "solid"
 * base starves them. `pan` and `conic` force a gradient outright; `stripes`
 * bands whatever stops it finds. Picking one with a solid base used to
 * compile a gradient from a single colour (nothing to see) while the builder
 * hid both the angle and the "add stop" button behind that same solid base:
 * you picked movement and got a still name with no way to fix it.
 */
export function effectNeedsStops(id) {
  return id === 'pan' || id === 'conic' || id === 'stripes'
}

/**
 * Where a new stop should land: the midpoint of the largest gap between the
 * existing stops, sorted by position.
 *
 * The builder used to hardcode `pos:100` for every new stop, which collided
 * with the default gradient's own last stop (also at 100) — two stops at the
 * same position compile to a zero-width band, so the third colour a user
 * added was in the CSS and invisible. Fewer than 2 stops has no gap to split;
 * 50 is as good a first guess as any.
 */
export function midpointOfLargestGap(stops) {
  const sorted = [...(Array.isArray(stops) ? stops : [])].sort((a, b) => a.pos - b.pos)
  if (sorted.length < 2) return 50
  let bestGap = -1, bestMid = 50
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].pos - sorted[i - 1].pos
    if (gap > bestGap) { bestGap = gap; bestMid = Math.round((sorted[i - 1].pos + sorted[i].pos) / 2) }
  }
  return bestMid
}

const FILL_SHAPES = new Set(['circle', 'ellipse'])

const FILL_LOOPS = new Set(['wrap', 'bounce'])


/** `v` is a multiple of `step` within [min, max] — fill's stepped ranges
 * (0.5° angles/tilts, 0.1% positions) are numbers, not integers, so
 * isIntInRange doesn't fit and a plain range check would accept any
 * fractional value the builder's dial never offers. */
function isStepInRange(v, min, max, step) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return false
  const n = Math.round((v - min) / step)
  return Math.abs(min + n * step - v) < 1e-9
}

function validateFillCenter(center, path, errors) {
  if (!isPlainObject(center)) { errors.push(`${path}.center must be an object`); return }
  const allowed = new Set(['x', 'y'])
  for (const k of Object.keys(center)) if (!allowed.has(k)) errors.push(`${path}.center: unknown key "${k}"`)
  if (!isStepInRange(center.x, 0, 100, 0.1)) errors.push(`${path}.center.x must be a number 0-100 (0.1 step)`)
  if (!isStepInRange(center.y, 0, 100, 0.1)) errors.push(`${path}.center.y must be a number 0-100 (0.1 step)`)
}

function validateFillMotion(motion, path, errors) {
  if (!isPlainObject(motion)) { errors.push(`${path}.motion must be null or an object`); return }
  const allowed = new Set(['type', 'speed', 'reverse', 'loop'])
  for (const k of Object.keys(motion)) if (!allowed.has(k)) errors.push(`${path}.motion: unknown key "${k}"`)
  if (!FILL_MOTION_TYPES.has(motion.type)) errors.push(`${path}.motion.type must be "flow" or "spin"`)
  if (!isNumInRange(motion.speed, MIN_SPEED, MAX_SPEED)) errors.push(`${path}.motion.speed must be a number ${MIN_SPEED}-${MAX_SPEED}`)
  if (motion.reverse !== undefined && typeof motion.reverse !== 'boolean') errors.push(`${path}.motion.reverse must be a boolean`)
  if (motion.loop !== undefined && !FILL_LOOPS.has(motion.loop)) errors.push(`${path}.motion.loop must be "wrap" or "bounce"`)
}

function validateFillStop(s, layerPath, j, errors) {
  const path = `${layerPath}.stops[${j}]`
  if (!isPlainObject(s)) { errors.push(`${path} must be an object`); return }
  const allowed = new Set(['color', 'pos', 'hint'])
  for (const k of Object.keys(s)) if (!allowed.has(k)) errors.push(`${path}: unknown key "${k}"`)
  if (!isFillColor(s.color)) errors.push(`${path}.color must match #rrggbb or #rrggbbaa`)
  if (!isStepInRange(s.pos, 0, 100, 0.1)) errors.push(`${path}.pos must be a number 0-100 (0.1 step)`)
  // Duplicate positions are DELIBERATELY not checked here — a fill's own
  // hard edge (two stops at the same pos) is the user's, see module note in
  // the plan; repairStopCollisions/stopsWithWrap/repeatingBandsCss must
  // never touch fill.
  if (s.hint !== undefined && !isStepInRange(s.hint, 0, 100, 0.1)) errors.push(`${path}.hint must be a number 0-100 (0.1 step)`)
}

function validateFillLayer(layer, i, errors) {
  const path = `fill.layers[${i}]`
  if (!isPlainObject(layer)) { errors.push(`${path} must be an object`); return }
  const allowed = new Set(['kind', 'tilt', 'stops', 'repeat', 'tile', 'shape', 'center', 'motion'])
  for (const k of Object.keys(layer)) if (!allowed.has(k)) errors.push(`${path}: unknown key "${k}"`)
  if (!FILL_LAYER_KINDS.has(layer.kind)) errors.push(`${path}.kind must be one of linear|radial|conic`)
  if (layer.tilt !== undefined && !isStepInRange(layer.tilt, -180, 180, 0.5)) errors.push(`${path}.tilt must be a number -180..180 (0.5 step)`)

  if (!Array.isArray(layer.stops) || layer.stops.length < MIN_FILL_STOPS || layer.stops.length > MAX_FILL_STOPS) {
    errors.push(`${path}.stops must be an array of ${MIN_FILL_STOPS}-${MAX_FILL_STOPS} stops`)
  } else {
    layer.stops.forEach((s, j) => validateFillStop(s, path, j, errors))
  }

  if (layer.repeat !== undefined && typeof layer.repeat !== 'boolean') errors.push(`${path}.repeat must be a boolean`)
  if (layer.repeat === true) {
    if (!isPlainObject(layer.tile)) {
      errors.push(`${path}.tile is required when repeat is true`)
    } else {
      const allowedTile = new Set(['unit', 'size'])
      for (const k of Object.keys(layer.tile)) if (!allowedTile.has(k)) errors.push(`${path}.tile: unknown key "${k}"`)
      if (!FILL_TILE_UNITS.has(layer.tile.unit)) {
        errors.push(`${path}.tile.unit must be "name" or "px"`)
      } else if (layer.tile.unit === 'name') {
        if (!isNumInRange(layer.tile.size, MIN_FILL_TILE_NAME, MAX_FILL_TILE_NAME)) errors.push(`${path}.tile.size must be a number ${MIN_FILL_TILE_NAME}-${MAX_FILL_TILE_NAME} for unit "name"`)
      } else if (!isNumInRange(layer.tile.size, MIN_FILL_TILE_PX, MAX_FILL_TILE_PX)) {
        errors.push(`${path}.tile.size must be a number ${MIN_FILL_TILE_PX}-${MAX_FILL_TILE_PX} for unit "px"`)
      }
    }
  } else if (layer.tile !== undefined) {
    errors.push(`${path}.tile is only valid when repeat is true`)
  }

  if (layer.kind === 'radial') {
    if (layer.shape !== undefined && !FILL_SHAPES.has(layer.shape)) errors.push(`${path}.shape must be "circle" or "ellipse"`)
  } else if (layer.shape !== undefined) {
    errors.push(`${path}.shape is only valid for radial layers`)
  }

  if (layer.kind === 'radial' || layer.kind === 'conic') {
    if (layer.center !== undefined) validateFillCenter(layer.center, path, errors)
  } else if (layer.center !== undefined) {
    errors.push(`${path}.center is only valid for radial/conic layers`)
  }

  if (layer.motion !== null && layer.motion !== undefined) validateFillMotion(layer.motion, path, errors)
}

function validateFillModulator(mod, path, errors, hasDepth) {
  if (mod === null || mod === undefined) return
  if (!isPlainObject(mod)) { errors.push(`${path} must be null or an object`); return }
  const allowed = hasDepth ? new Set(['speed', 'depth']) : new Set(['speed'])
  for (const k of Object.keys(mod)) if (!allowed.has(k)) errors.push(`${path}: unknown key "${k}"`)
  if (!isNumInRange(mod.speed, MIN_SPEED, MAX_SPEED)) errors.push(`${path}.speed must be a number ${MIN_SPEED}-${MAX_SPEED}`)
  if (hasDepth && !isNumInRange(mod.depth, 0.1, 0.9)) errors.push(`${path}.depth must be a number 0.1-0.9`)
}

/**
 * Validate a `fill` block on its own — strict (unknown keys rejected at
 * every level), bounds per the plan's spec, no silent repair of stop
 * collisions (a fill's hard edges are user-placed). Contrast is scored on
 * the FLATTENED, alpha-composited layer stack (fillContrast), not per stop.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateFill(fill) {
  const errors = []
  if (!isPlainObject(fill)) return { ok: false, errors: ['fill must be an object'] }

  const allowedTop = new Set(['angle', 'layers', 'hue', 'breathe'])
  for (const k of Object.keys(fill)) if (!allowedTop.has(k)) errors.push(`fill: unknown key "${k}"`)
  if (!isStepInRange(fill.angle, 0, 360, 0.5)) errors.push('fill.angle must be a number 0-360 (0.5 step)')

  let layersOk = false
  if (!Array.isArray(fill.layers) || fill.layers.length < MIN_FILL_LAYERS || fill.layers.length > MAX_FILL_LAYERS) {
    errors.push(`fill.layers must be an array of ${MIN_FILL_LAYERS}-${MAX_FILL_LAYERS} layers`)
  } else {
    const before = errors.length
    fill.layers.forEach((layer, i) => validateFillLayer(layer, i, errors))
    layersOk = errors.length === before
  }

  validateFillModulator(fill.hue, 'fill.hue', errors, false)
  validateFillModulator(fill.breathe, 'fill.breathe', errors, true)

  // Legibility floor — only once the layers are structurally sound, so a
  // malformed fill reports its real problem instead of also being called
  // unreadable off garbage stops.
  if (layersOk) {
    const weakest = fillContrast(fill.layers)
    if (weakest !== null && weakest < PAINT_MIN_CONTRAST) {
      errors.push(
        `fill contrast ${weakest.toFixed(1)}:1 is below the ${PAINT_MIN_CONTRAST}:1 legibility floor against chat background — the darkest composited point is unreadable at name size`
      )
    }
  }

  return { ok: errors.length === 0, errors }
}

/**
 * Effect-budget cost of a fill block: one per DISTINCT motion group across
 * its layers, plus one each for `hue`/`breathe` — mirrors how a v1/v2 paint-
 * slot effect always cost exactly one animation. A free-tier fill (maxEffects
 * 0) therefore has to leave every layer's `motion` null and both modulators
 * null: static fill only, same free/plus line `base` already drew.
 */
export function fillEffectCount(fill) {
  if (!isPlainObject(fill)) return 0
  const groups = new Set()
  if (Array.isArray(fill.layers)) {
    for (const layer of fill.layers) {
      const key = isPlainObject(layer) ? motionGroupKey(layer.motion) : null
      if (key) groups.add(key)
    }
  }
  return groups.size + (isPlainObject(fill.hue) ? 1 : 0) + (isPlainObject(fill.breathe) ? 1 : 0)
}

// ── validation ───────────────────────────────────────────────────────────

/**
 * Validate a paint spec against v1 schema + safety rules.
 * @param {*} spec
 * @param {{ maxEffects?: number }} [opts] — optional tier cap on effect-layer
 *   count (defaults to the structural MAX_EFFECTS). Threaded from the server
 *   save gate (0 free / 3 plus) and the builder so both share one cap check.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validatePaintSpec(spec, opts = {}) {
  const errors = []
  const maxEffects = Number.isInteger(opts.maxEffects) && opts.maxEffects >= 0
    ? Math.min(opts.maxEffects, MAX_EFFECTS)
    : MAX_EFFECTS

  if (!isPlainObject(spec)) {
    return { ok: false, errors: ['spec must be an object'] }
  }
  if (spec.v !== 1 && spec.v !== 2) {
    errors.push('v must be 1 or 2')
  }

  // ── scene (v2 diorama block — see scene-spec.js) ──
  if (spec.scene !== null && spec.scene !== undefined) {
    if (spec.v !== 2) {
      errors.push('scene requires v: 2')
    } else {
      validateSceneSpec(spec.scene, errors)
    }
  }

  // ── base ──
  if (!isPlainObject(spec.base)) {
    errors.push('base must be an object')
  } else {
    const { type, angle, stops, tileWidth } = spec.base
    if (!BASE_TYPES.has(type)) {
      errors.push(`base.type must be one of solid|linear|conic|repeating-linear, got ${JSON.stringify(type)}`)
    }
    if (!isIntInRange(angle, 0, 360)) {
      errors.push('base.angle must be an integer 0-360')
    }
    // Only meaningful for the banded fill (matrix/holo/lava's replacement —
    // see repeatingBandsCss), but checked whenever it's PRESENT so a spec
    // can't carry a garbage value that only surfaces once someone switches
    // fill types onto it later.
    if (tileWidth !== undefined && !isIntInRange(tileWidth, MIN_TILE_WIDTH, MAX_TILE_WIDTH)) {
      errors.push(`base.tileWidth must be an integer ${MIN_TILE_WIDTH}-${MAX_TILE_WIDTH}`)
    }
    if (type === 'repeating-linear' && tileWidth === undefined) {
      errors.push('base.tileWidth is required when base.type is repeating-linear')
    }
    if (!Array.isArray(stops) || stops.length < MIN_STOPS || stops.length > MAX_STOPS) {
      errors.push(`base.stops must be an array of ${MIN_STOPS}-${MAX_STOPS} stops`)
    } else {
      stops.forEach((s, i) => {
        if (!isPlainObject(s) || typeof s.color !== 'string' || !HEX_RE.test(s.color)) {
          errors.push(`base.stops[${i}].color must match #rrggbb`)
        }
        if (!isIntInRange(s.pos, 0, 100)) {
          errors.push(`base.stops[${i}].pos must be an integer 0-100`)
        }
      })
      if (type === 'solid' && stops.length !== 1) {
        errors.push('base.type solid requires exactly 1 stop')
      }
      // Two stops at the same position compile to a zero-width band — no
      // visible run between them, and (for pan/conic, which append a wrap
      // duplicate of their own) a hard edge at the seam. Checked on the
      // rounded ints the compiler actually emits, not the raw input, so a
      // spec that only collides after rounding is still caught.
      const posCounts = new Map()
      stops.forEach(s => {
        if (isIntInRange(s.pos, 0, 100)) posCounts.set(s.pos, (posCounts.get(s.pos) || 0) + 1)
      })
      for (const [pos, count] of posCounts) {
        if (count > 1) errors.push(`base.stops has ${count} stops at pos ${pos} — two stops at the same position compile to a zero-width band`)
      }
      // Legibility floor — scored on the DIMMEST stop, because that is the
      // part of the name that disappears. Only runs once the stops are
      // structurally sound, so a malformed spec reports its real problem
      // instead of also being called unreadable.
      // Skipped under a fill: there `base` is the derived legacy shadow, and
      // the floor that matters is the fill's own, scored on its composited
      // stack (validateFill) — a dark stop beneath an opaque upper layer is
      // legible there and would be refused here for a picture nobody sees.
      const weakest = isPlainObject(spec.fill) ? null : paintContrast(stops)
      if (weakest !== null && weakest < PAINT_MIN_CONTRAST) {
        errors.push(
          `base.stops contrast ${weakest.toFixed(1)}:1 is below the ${PAINT_MIN_CONTRAST}:1 legibility floor against chat background — the darkest stop is unreadable at name size`
        )
      }
    }
  }

  // ── effects (fill's own motion/hue/breathe joins this SAME budget — see
  // fillEffectCount — since fill is the paint-slot effects' replacement, not
  // a second allowance alongside them) ──
  const hasFill = isPlainObject(spec.fill)
  const fillCount = hasFill ? fillEffectCount(spec.fill) : 0
  // With a fill, the paint-slot effect in `effects` is its legacy SHADOW (see
  // withLegacyShadow) — the compiler never runs it here, only an old extension
  // does. So it spends no budget and clashes with nothing: the fill's own
  // motion/hue/breathe already paid for what it stands in for.
  const isShadow = e => hasFill && isPlainObject(e) && EFFECTS[e.id]?.slot === 'paint'
  const liveEffectCount = Array.isArray(spec.effects) ? spec.effects.filter(e => !isShadow(e)).length : 0
  if (!Array.isArray(spec.effects)) {
    errors.push('effects must be an array')
  } else if (liveEffectCount + fillCount > maxEffects) {
    errors.push(maxEffects === 0
      ? 'effects require plus — free paints are static (0 effect layers)'
      : `effects must have at most ${maxEffects} ${maxEffects === 1 ? 'entry' : 'entries'}${fillCount ? ' (incl. fill motion/hue/breathe)' : ''}`)
  } else {
    const seenIds = new Set()
    let paintCount = 0
    let motionCount = 0
    let structurallyValid = true

    spec.effects.forEach((e, i) => {
      if (!isPlainObject(e)) {
        errors.push(`effects[${i}] must be an object`)
        structurallyValid = false
        return
      }
      if (!EFFECT_IDS.has(e.id)) {
        errors.push(`effects[${i}].id unknown: ${JSON.stringify(e.id)}`)
        structurallyValid = false
        return
      }
      if (!isNumInRange(e.speed, MIN_SPEED, MAX_SPEED)) {
        errors.push(`effects[${i}].speed must be a number ${MIN_SPEED}-${MAX_SPEED}`)
        structurallyValid = false
      }
      if (seenIds.has(e.id)) {
        errors.push(`duplicate effect id: ${e.id}`)
      }
      seenIds.add(e.id)

      // pan's three optional knobs — scale/loop/skew. Every other effect
      // ignores these keys if present (no other effect reads them), so they
      // are only checked on pan itself, and only when present: a bare
      // {id:'pan',speed} is still the whole valid spec it always was.
      if (e.id === 'pan') {
        if (e.scale !== undefined && !isIntInRange(e.scale, PAN_MIN_SCALE, PAN_MAX_SCALE)) {
          errors.push(`effects[${i}].scale must be an integer ${PAN_MIN_SCALE}-${PAN_MAX_SCALE}`)
        }
        if (e.loop !== undefined && e.loop !== 'wrap' && e.loop !== 'bounce') {
          errors.push(`effects[${i}].loop must be "wrap" or "bounce"`)
        }
        if (e.skew !== undefined && typeof e.skew !== 'boolean') {
          errors.push(`effects[${i}].skew must be a boolean`)
        }
      }

      const meta = EFFECTS[e.id]
      if (meta.slot === 'paint') paintCount++
      else motionCount++
      const clash = isShadow(e) ? null : effectConflict(e.id, spec.effects.slice(0, i).filter(o => !isShadow(o)))
      if (clash && !clash.startsWith('at most')) {
        errors.push(`effects: ${clash} — pick effects with different motion targets`)
      }
    })

    if (structurallyValid) {
      if (paintCount > 1) errors.push('at most 1 paint-slot effect allowed (paint effects are mutually exclusive)')
      if (motionCount > 2) errors.push('at most 2 motion-slot effects allowed')
    }
  }

  // ── fill (additive v1/v2 block) ──
  if (spec.fill !== null && spec.fill !== undefined) {
    const fillResult = validateFill(spec.fill)
    errors.push(...fillResult.errors)
  }

  // ── glow ──
  if (spec.glow !== null && spec.glow !== undefined) {
    if (!isPlainObject(spec.glow)) {
      errors.push('glow must be null or an object')
    } else {
      if (typeof spec.glow.color !== 'string' || !HEX_RE.test(spec.glow.color)) {
        errors.push('glow.color must match #rrggbb')
      }
      if (!GLOW_STRENGTHS.has(spec.glow.strength)) {
        errors.push('glow.strength must be 1 or 2')
      }
    }
  }

  return { ok: errors.length === 0, errors }
}

/** #rrggbbaa -> #rrggbb. Legacy stops (base/scene) never carry alpha. */
function stripFillAlpha(hex) {
  return typeof hex === 'string' && hex.length === 9 ? hex.slice(0, 7) : hex
}

/**
 * A v1/v2-valid base+effects APPROXIMATION of a fill block, so an old
 * extension build (which has never heard of `fill`) still renders something
 * sane instead of nothing: first layer's stops -> base linear/conic, its
 * motion -> pan/conic, hue/breathe -> hue/pulse. Only ever ONE paint-slot
 * effect (a valid spec allows at most one), so when a fill has a motion AND
 * a modulator, the motion wins — a moving shadow beats a modulated static
 * one for "still recognisably this paint".
 *
 * Legacy stops are plain #rrggbb (alpha stripped) and MAY NOT collide on
 * position (unlike fill's own, deliberately unchecked, hard edges) —
 * repaired here, for the shadow only, exactly like an already-saved
 * colliding spec is repaired at compile time elsewhere.
 * @param {object} fill
 * @returns {{ base: object, effects: object[], glow: null }}
 */
export function legacyShadowOf(fill) {
  const fallback = { base: { type: 'solid', angle: 0, stops: [{ color: '#e4e4e4', pos: 0 }] }, effects: [], glow: null }
  if (!isPlainObject(fill) || !Array.isArray(fill.layers) || !fill.layers.length) return fallback

  const first = fill.layers.find(isPlainObject) || null
  if (!first) return fallback

  const angle = safeAngle(Number(fill.angle) + Number(first.tilt || 0))
  const rawStops = Array.isArray(first.stops) ? first.stops.slice(0, MAX_STOPS) : []
  const repaired = repairStopCollisions(
    rawStops
      .filter(s => isPlainObject(s) && isFillColor(s?.color) && isNumInRange(s?.pos, 0, 100))
      .map(s => ({ color: stripFillAlpha(s.color), pos: Math.round(s.pos) }))
  )
  const legacyStops = repaired.length ? repaired : [{ color: '#e4e4e4', pos: 0 }]

  const kind = first.kind === 'conic' ? 'conic' : 'linear'
  const base = { type: kind, angle, stops: legacyStops }

  const effects = []
  if (isPlainObject(first.motion)) {
    effects.push(first.motion.type === 'spin'
      ? { id: 'conic', speed: safeSpeed(first.motion.speed) }
      : { id: 'pan', speed: safeSpeed(first.motion.speed), loop: first.motion.loop === 'bounce' ? 'bounce' : 'wrap' })
  } else if (isPlainObject(fill.hue)) {
    effects.push({ id: 'hue', speed: safeSpeed(fill.hue.speed) })
  } else if (isPlainObject(fill.breathe)) {
    effects.push({ id: 'pulse', speed: safeSpeed(fill.breathe.speed) })
  }

  return { base, effects, glow: null }
}

/**
 * A fill spec with its legacy `base` + paint-slot effect derived from the fill
 * (legacyShadowOf) — what gets STORED, so an old extension that has never heard
 * of `fill` still paints something recognisable. Motion-slot effects are the
 * user's and pass through untouched; any paint-slot effect already present is
 * replaced, never kept — it would be a stale shadow of a fill since edited.
 * Shared by the builder (what it validates and sends) and the save route
 * (which re-derives, so a client can never store a shadow that lies).
 * A spec with no fill comes back as-is.
 */
export function withLegacyShadow(spec) {
  if (!isPlainObject(spec) || !isPlainObject(spec.fill)) return spec
  const shadow = legacyShadowOf(spec.fill)
  const effects = (Array.isArray(spec.effects) ? spec.effects : []).filter(e => !(isPlainObject(e) && EFFECTS[e.id]?.slot === 'paint'))
  return { ...spec, base: shadow.base, effects: [...effects, ...shadow.effects] }
}

/**
 * The spec the builder EDITS: always a fill. A saved fill is itself; a legacy
 * paint takes its upgradeSpec form; one with no fill form at all (a solid or
 * static gradient, `reveal`, a wobbling `pan`) becomes its base as one layer.
 * `dropped` names what saving will lose — `reveal` has no fill equivalent and
 * a pan's wobble has no fill knob — so the builder can say so rather than
 * quietly deleting it on the first save.
 * @returns {{ spec: object, dropped: string|null }}
 */
export function editableFillSpec(spec) {
  if (!isPlainObject(spec) || isPlainObject(spec.fill)) return { spec, dropped: null }
  const base = isPlainObject(spec.base) ? spec.base : { type: 'solid', angle: 0, stops: [{ color: '#e4e4e4', pos: 0 }] }
  const effects = Array.isArray(spec.effects) ? spec.effects : []
  const paint = effects.find(e => isPlainObject(e) && EFFECTS[e.id]?.slot === 'paint') || null
  const angle = isIntInRange(base.angle, 0, 360) ? base.angle : 0
  const rest = effects.filter(e => e !== paint)
  if (paint?.id === 'pan' && paint.skew) {
    const built = upgradePan(base, paint)
    return { spec: { ...spec, effects: rest, fill: { angle, layers: built.layers, hue: null, breathe: null } }, dropped: 'wobble' }
  }
  const up = upgradeSpec(spec)
  if (up !== spec && isPlainObject(up.fill)) return { spec: up, dropped: null }
  const fill = { angle, layers: [baseAsFillLayer(base)], hue: null, breathe: null }
  return { spec: { ...spec, effects: rest, fill }, dropped: paint ? paint.id : null }
}
// ── builder copy ───────────────────────────────────────────────────────────
// The effect names and one-line descriptions the builder's chips and rows
// print. Deliberately NOT fields on paint-spec's EFFECTS table: that table is
// read by the compiler on the render path, so every byte of UI prose in it
// shipped in the boot closure of every route to be read by nobody — the
// renderer has never looked at a label. Keyed by the same ids; every EFFECTS
// id must have a row and no row may name an unknown id, which
// tests/client/paint-spec.test.js pins.
export const EFFECT_COPY = {
  pan: { label: 'gradient pan', desc: 'slides the gradient across the name' },
  conic: { label: 'conic sweep', desc: 'spins the gradient around the name' },
  hue: { label: 'hue cycle', desc: 'cycles the whole name through the colour wheel' },
  glint: { label: 'shimmer glint', desc: 'a bright streak sweeps across once per cycle' },
  reveal: { label: 'mask reveal', desc: 'a soft mask wipes the name in and out' },
  stripes: { label: 'barber stripes', desc: 'diagonal bands of your colours, rolling' },
  stardust: { label: 'stardust', desc: 'sparkle dots drifting over your fill' },
  pulse: { label: 'pulse', desc: 'the whole name breathes brighter and dimmer' },
  wave: { label: 'letter wave', desc: 'letters ripple in a wave, one after another' },
  ripple: { label: 'rainbow ripple', desc: 'letters cycle through the rainbow, one after another' },
  coin: { label: 'coin spin', desc: 'the whole name spins like a coin' },
  heli: { label: 'spin', desc: 'the whole name spins flat' },
  float: { label: 'zero-g float', desc: 'drifts gently up and down' },
  heart: { label: 'heartbeat', desc: 'pulses to a heartbeat rhythm' },
  wobble: { label: 'wobble stretch', desc: 'stretches and squashes rhythmically' },
  swing: { label: 'pendulum', desc: 'swings side to side like a pendulum' },
  tumble: { label: 'letter tumble', desc: 'letters flip end over end, one after another' },
  neon: { label: 'neon breathe', desc: 'the glow breathes brighter and dimmer' },
  glitch: { label: 'glitch', desc: 'the shadow flickers and jumps' },
  jitter: { label: 'jitter', desc: 'shakes with a nervous jitter' },
  hop: { label: 'letter hop', desc: 'letters hop up and down, one after another' },
  twirl: { label: 'letter twirl', desc: 'letters spin in place, one after another' },
  type: { label: 'typewriter', desc: 'letters type in and out like a typewriter' },
  flicker: { label: 'flicker', desc: 'fades in and out like a failing bulb' },
}

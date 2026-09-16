/**
 * Paint spec — structured JSON schema + compiler for animated username paints.
 *
 * Replaces the old free-text `username_css` column (migration 078, removed).
 * A paint is authored as data (base gradient + up to 3 effect layers + glow),
 * never as a raw CSS string, so it is injection-impossible by construction:
 * every color is regex-validated hex, every number is range-clamped, every
 * effect id is looked up against a fixed enum table — nothing user-typed is
 * ever concatenated into the compiled CSS string.
 *
 * Pure-data module — no DOM, no fetch. Shared between client (live preview +
 * chat-tile renderer) and server (PUT /api/user/paint validation) by design,
 * mirroring the client/settings/registry.js pattern already used for
 * server-side settings validation.
 *
 * Effect catalog ported from docs/paint-lab.html (34-effect reference lab).
 * Phase 1 ships 20 of those. That file is FROZEN provenance and has since
 * diverged from what renders here — matrix, chrome, fire and heli were all
 * changed after the port. docs/scene-lab.html is the live view; it compiles
 * through this module.
 *
 * ── layering model ──────────────────────────────────────────────────────
 * Every paint costs at most MAX_ANIMATED_LAYERS (3) live CSS animations. That
 * is now ENFORCED by compilePaintCss rather than merely claimed here: this
 * header promised 3 from v1, and the v2 scene block below then added 1-3
 * animations of its own that MAX_EFFECTS never counted, so a real name could
 * reach six. The cap is spent in priority order — paint-slot fill, backdrop,
 * weather, then motion effects in spec order — and an over-budget weather
 * renders STILL rather than vanishing.
 *
 * Note the two caps are different numbers about different things: MAX_EFFECTS
 * bounds how elaborate a spec may BE (a save-time rule, server-enforced), and
 * MAX_ANIMATED_LAYERS bounds what one name may COST to draw (a compile-time
 * rule, so paints saved before it existed get cheaper too).
 *
 *   - `base`   the resting gradient (solid / linear / conic). Always present,
 *              never animated by itself — 0 layers.
 *   - `effects[]` 0-3 animated layers, each in one of two slots:
 *       'paint'  — owns the background/color. At most ONE active (they are
 *                  mutually exclusive: you can't pan AND matrix-rain the
 *                  same text at once).
 *       'motion' — owns transform/filter/text-shadow, layered on top of
 *                  whatever the paint slot (or plain base) already painted.
 *                  Up to TWO active, but two effects that would animate the
 *                  exact same CSS property on the exact same element (e.g.
 *                  two `transform`-on-self effects) silently clobber each
 *                  other in real browsers, so the validator also rejects
 *                  same-signature combos — see motionSignature() below.
 *   - `glow`   optional constant text-shadow, independent of any effect.
 *
 * ── paint-slot color sourcing (design decision, see final report) ────────
 * pan / conic / hue / glint / reveal are "generic animators" — they animate
 * the user's own `base` gradient (pan/conic force linear/conic rendering
 * respectively since they need a directional/rotational gradient; hue/glint/
 * reveal are orthogonal to gradient type and always honor base as-is).
 * stripes / stardust / pulse are generic too (stripes bands the user's stops,
 * stardust drifts dots over them, pulse breathes the fill).
 * chrome / gold / fire / matrix / holo / rainbow / ice / lava are "themed presets" — faithful ports
 * of the lab's fixed palettes (that fixed palette IS the point of picking
 * "gold foil"), so they render their own built-in gradient and `base` is
 * visually superseded (still stored/validated normally so switching the
 * effect off reverts to the user's base).
 */

import {
  HEX_RE, MIN_SPEED, MAX_SPEED,
  isPlainObject, isIntInRange, isNumInRange,
  safeHex, safeSpeed, periodSeconds, syncDelayCalc, fnv1a,
  steppedTiming, FILL_STEPS_PER_SECOND,
} from './paint-core.js'
import {
  validateSceneSpec, normalizeSceneForHash, buildSceneCss,
  sceneHasBackdrop, SCENE_RIM_CSS, SCENE_RIM_FILTER_CSS, sceneAnimationCost,
  crowdTierRules, tierTimings, sceneBoxCounts, COMPOSITED_ANIM_PREFIX,
} from './scene-spec.js'

// ── enums ──────────────────────────────────────────────────────────────────

const BASE_TYPES = new Set(['solid', 'linear', 'conic'])
const GLOW_STRENGTHS = new Set([1, 2])

const MAX_EFFECTS = 3
// The rendered ceiling, not the saved one. MAX_EFFECTS bounds how elaborate a
// spec may BE; this bounds how many live CSS animations one name may COST, and
// the two are not the same number because a v2 scene adds 1-3 animations that
// MAX_EFFECTS never counted. 3 is the module's own documented layering model
// (see the header), enforced over the whole catalog by
// tests/client/paint-layer-cap.test.js — which is also what lets the mobile
// animation budget in chat/paint-cosmetics.js be a constant again: that
// constant went stale twice because the unit kept moving underneath it.
export const MAX_ANIMATED_LAYERS = 3

/**
 * Hard ceiling on plane boxes in one painted name.
 *
 * The catalog's widest band is 6 layers and a name has two bands, so 12 is the
 * real maximum and this is only ever a bound on a mode string that has been
 * tampered with or has drifted — paintNameHtmlFor repeats an element `n` times
 * from a value it parses out of a string, and a parser with no ceiling is a
 * denial of service waiting for the first bad cache entry.
 */
export const MAX_PLANE_BOXES = 16

/**
 * The element that holds the name's text, and only the name's text.
 *
 * NOT in the `hsp-` namespace, and that is load-bearing rather than taste.
 * `[class*="hsp-"]` is how the offscreen sweep finds painted names
 * (paint-cosmetics), how PAINT_ALL_SEL and the reduced-motion scope select
 * them, and `c.startsWith('hsp-')` is how a stale paint class is stripped. A
 * box named `hsp-n` would be matched by every one of those and gated,
 * measured and de-animated as if it were a second painted name per row.
 *
 * It is also why the compiled letter rules address `> span` UNDER this box
 * rather than any `${selector} span`, which would match the box itself.
 */
export const NAME_BOX_CLASS = 'hs-name'
const MIN_STOPS = 1
const MAX_STOPS = 8

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

/**
 * Effect metadata table — the single source of truth for slot assignment,
 * luminance classification, base (speed=1) animation period, and whether an
 * effect needs its target text split into per-letter spans.
 *
 * `sig` (motion effects only) is the (target, property) pair the effect's
 * keyframes animate. Two motion effects picked together must have distinct
 * `sig` values, or one silently overrides the other's computed value every
 * frame (a real CSS limitation — animations on the same property/element
 * don't compose, the later one in the animation-name list wins outright).
 */
const EFFECTS = {
  // ── paint slot — mutually exclusive, at most 1 ──────────────────────────
  // A paint effect owns background/color. The two that animate something
  // ELSE (hue: filter, pulse: opacity) carry a sig so the validator can keep
  // a motion off the same property — see effectConflict().
  pan:      { slot: 'paint', luminance: false, basePeriod: 5,   letterSplit: false, label: 'gradient pan', desc: 'slides the gradient across the name' },
  conic:    { slot: 'paint', luminance: false, basePeriod: 6,   letterSplit: false, label: 'conic sweep', desc: 'spins the gradient around the name' },
  hue:      { slot: 'paint', luminance: true,  basePeriod: 8,   letterSplit: false, label: 'hue cycle', sig: 'self:filter', desc: 'cycles the whole name through the colour wheel' },
  glint:    { slot: 'paint', luminance: false, basePeriod: 3.4, letterSplit: false, label: 'shimmer glint', desc: 'a bright streak sweeps across once per cycle' },
  chrome:   { slot: 'paint', luminance: false, basePeriod: 4.5, letterSplit: false, label: 'liquid chrome', desc: 'metallic sheen sweeping back and forth' },
  gold:     { slot: 'paint', luminance: false, basePeriod: 5,   letterSplit: false, label: 'gold foil', desc: 'foil sheen with a moving highlight band' },
  fire:     { slot: 'paint', luminance: false, basePeriod: 1.8, letterSplit: false, label: 'fire', desc: 'flame gradient licking upward' },
  matrix:   { slot: 'paint', luminance: false, basePeriod: 3.2, letterSplit: false, label: 'matrix rain', desc: 'falling phosphor scanlines' },
  holo:     { slot: 'paint', luminance: false, basePeriod: 2.8, letterSplit: false, label: 'hologram', desc: 'shifting rainbow scanlines' },
  reveal:   { slot: 'paint', luminance: false, basePeriod: 3,   letterSplit: false, label: 'mask reveal', desc: 'a soft mask wipes the name in and out' },
  rainbow:  { slot: 'paint', luminance: false, basePeriod: 4,   letterSplit: false, label: 'rainbow', desc: 'the full spectrum sweeps across' },
  ice:      { slot: 'paint', luminance: false, basePeriod: 4.5, letterSplit: false, label: 'ice', desc: 'frosted sheen sweeping back and forth' },
  lava:     { slot: 'paint', luminance: false, basePeriod: 3,   letterSplit: false, label: 'lava', desc: 'molten bands rolling upward' },
  stripes:  { slot: 'paint', luminance: false, basePeriod: 2.4, letterSplit: false, label: 'barber stripes', desc: 'diagonal bands of your colours, rolling' },
  stardust: { slot: 'paint', luminance: false, basePeriod: 3,   letterSplit: false, label: 'stardust', desc: 'sparkle dots drifting over your fill' },
  pulse:    { slot: 'paint', luminance: true,  basePeriod: 2.4, letterSplit: false, label: 'pulse', sig: 'self:opacity', desc: 'the whole name breathes brighter and dimmer' },

  // ── motion/glow slot — up to 2, distinct sig required ───────────────────
  wave:    { slot: 'motion', luminance: false, basePeriod: 1.6, letterSplit: true,  label: 'letter wave',   sig: 'letter:transform', desc: 'letters ripple in a wave, one after another' },
  ripple:  { slot: 'motion', luminance: true,  basePeriod: 2.4, letterSplit: true,  label: 'rainbow ripple', sig: 'letter:filter', desc: 'letters cycle through the rainbow, one after another' },
  coin:    { slot: 'motion', luminance: false, basePeriod: 5,   letterSplit: false, label: 'coin spin',     sig: 'self:transform', desc: 'the whole name spins like a coin' },
  heli:    { slot: 'motion', luminance: false, basePeriod: 2.2, letterSplit: false, label: 'spin',          sig: 'self:transform', desc: 'the whole name spins flat' },
  float:   { slot: 'motion', luminance: false, basePeriod: 5.5, letterSplit: false, label: 'zero-g float',  sig: 'self:transform', desc: 'drifts gently up and down' },
  heart:   { slot: 'motion', luminance: false, basePeriod: 1.3, letterSplit: false, label: 'heartbeat',     sig: 'self:transform', desc: 'pulses to a heartbeat rhythm' },
  wobble:  { slot: 'motion', luminance: false, basePeriod: 2.8, letterSplit: false, label: 'wobble stretch', sig: 'self:transform', desc: 'stretches and squashes rhythmically' },
  swing:   { slot: 'motion', luminance: false, basePeriod: 2.6, letterSplit: false, label: 'pendulum',      sig: 'self:transform', desc: 'swings side to side like a pendulum' },
  tumble:  { slot: 'motion', luminance: false, basePeriod: 3.4, letterSplit: true,  label: 'letter tumble', sig: 'letter:transform', desc: 'letters flip end over end, one after another' },
  neon:    { slot: 'motion', luminance: true,  basePeriod: 2.6, letterSplit: false, label: 'neon breathe',  sig: 'self:shadow', desc: 'the glow breathes brighter and dimmer' },
  glitch:  { slot: 'motion', luminance: false, basePeriod: 2.8, letterSplit: false, label: 'glitch',        sig: 'self:shadow', desc: 'the shadow flickers and jumps' },
  jitter:  { slot: 'motion', luminance: false, basePeriod: 3,   letterSplit: false, label: 'jitter',        sig: 'self:transform', desc: 'shakes with a nervous jitter' },
  hop:     { slot: 'motion', luminance: false, basePeriod: 2.2, letterSplit: true,  label: 'letter hop',    sig: 'letter:transform', desc: 'letters hop up and down, one after another' },
  twirl:   { slot: 'motion', luminance: false, basePeriod: 3.6, letterSplit: true,  label: 'letter twirl',  sig: 'letter:transform', desc: 'letters spin in place, one after another' },
  type:    { slot: 'motion', luminance: true,  basePeriod: 4,   letterSplit: true,  label: 'typewriter',    sig: 'letter:opacity', desc: 'letters type in and out like a typewriter' },
  flicker: { slot: 'motion', luminance: true,  basePeriod: 3,   letterSplit: false, label: 'flicker',       sig: 'self:opacity', desc: 'fades in and out like a failing bulb' },
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
 * Does this paint fill with YOUR colours, or does it bring its own?
 *
 * Half the paint slot (the themed presets — gold, fire, ice …) is a fixed
 * palette that ignores `base.stops` entirely, and nothing said so: you would
 * set five colours, tap "fire", and watch every one of them do nothing. The
 * builder splits the rail on this and says it out loud.
 *
 * Derived from THEMED_PAINT rather than duplicated as a flag, so a preset
 * added there can never disagree with the label the picker shows. A motion
 * effect answers true: it does not fill at all, so your colours still show.
 */
export function effectUsesBaseColors(id) {
  return !!EFFECTS[id] && !THEMED_PAINT[id]
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

const EFFECT_IDS = new Set(Object.keys(EFFECTS))
const LETTER_SPLIT_IDS = new Set(Object.entries(EFFECTS).filter(([, m]) => m.letterSplit).map(([id]) => id))

/**
 * Stable short hash of a spec — same spec (key order irrelevant, we
 * JSON.stringify a normalized/sorted form) → same hash.
 *
 * ── the contract, precisely ──
 * It hashes the SPEC. It does NOT hash the compiler. So `.hsp-<hash>` is
 * stable across deploys that change what that class RENDERS: the scene
 * compiler was rewritten from two planes to seven on 2026-08-16 and every
 * class name stayed byte-identical.
 *
 * That is safe only because of a property of today's CALLERS, not of the hash:
 * compiled CSS is either built client-side per page load, or inlined into an
 * SSR response that carries max-age 60-300 and gets its prefix purged by
 * deploy.sh. Nothing stores it durably.
 *
 * Anything that starts to — a redis key, localStorage, a long Cache-Control on
 * a route that ships compiled paint CSS — MUST carry its own version, because
 * this hash will not move to invalidate it. That is not hypothetical: the same
 * shape shipped stale payloads to prod from an un-bumped CACHE_VER on the
 * channel-stats route the same day. tests/client/paint-spec.test.js pins the
 * compiler's output so that whoever changes it is told this, at the moment
 * they change it, rather than finding out from a page.
 */
export function hashPaintSpec(spec) {
  return fnv1a(JSON.stringify(normalizeForHash(spec)))
}

function normalizeForHash(spec) {
  // Deterministic shape regardless of input key order.
  return {
    v: spec?.v,
    base: spec?.base && {
      type: spec.base.type,
      angle: spec.base.angle,
      stops: Array.isArray(spec.base.stops) ? spec.base.stops.map(s => ({ color: s?.color, pos: s?.pos })) : [],
    },
    effects: Array.isArray(spec?.effects) ? spec.effects.map(e => ({ id: e?.id, speed: e?.speed })) : [],
    glow: spec?.glow ? { color: spec.glow.color, strength: spec.glow.strength } : null,
    scene: normalizeSceneForHash(spec?.scene),
  }
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
    const { type, angle, stops } = spec.base
    if (!BASE_TYPES.has(type)) {
      errors.push(`base.type must be one of solid|linear|conic, got ${JSON.stringify(type)}`)
    }
    if (!isIntInRange(angle, 0, 360)) {
      errors.push('base.angle must be an integer 0-360')
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
      const weakest = paintContrast(stops)
      if (weakest !== null && weakest < PAINT_MIN_CONTRAST) {
        errors.push(
          `base.stops contrast ${weakest.toFixed(1)}:1 is below the ${PAINT_MIN_CONTRAST}:1 legibility floor against chat background — the darkest stop is unreadable at name size`
        )
      }
    }
  }

  // ── effects ──
  if (!Array.isArray(spec.effects)) {
    errors.push('effects must be an array')
  } else if (spec.effects.length > maxEffects) {
    errors.push(maxEffects === 0
      ? 'effects require plus — free paints are static (0 effect layers)'
      : `effects must have at most ${maxEffects} ${maxEffects === 1 ? 'entry' : 'entries'}`)
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

      const meta = EFFECTS[e.id]
      if (meta.slot === 'paint') paintCount++
      else motionCount++
      const clash = effectConflict(e.id, spec.effects.slice(0, i))
      if (clash && !clash.startsWith('at most')) {
        errors.push(`effects: ${clash} — pick effects with different motion targets`)
      }
    })

    if (structurallyValid) {
      if (paintCount > 1) errors.push('at most 1 paint-slot effect allowed (paint effects are mutually exclusive)')
      if (motionCount > 2) errors.push('at most 2 motion-slot effects allowed')
    }
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

/**
 * True if the spec animates individual glyphs — wave/ripple/tumble, the only
 * effects whose keyframes read `--i`/`--mid`. These are the ONLY specs that
 * may be chopped into one span per letter.
 */
export function paintNeedsPerLetter(spec) {
  return !!spec && Array.isArray(spec.effects) && spec.effects.some(e => LETTER_SPLIT_IDS.has(e?.id))
}

/** True if the painted name must carry `<span>` children at all — either
 * per-letter (above), or a scene under a clip-text fill. The latter is a
 * paint-order constraint, not a style choice: the plate pseudos carry
 * z-index:-1, and negative-z children paint ABOVE the element's own
 * background — which with background-clip:text IS the text fill. Spans
 * paint in the inline-content phase, above the pseudos, so wrapping is
 * what keeps a gradient/effect fill visible over its own scene. */
export function paintNeedsSpans(spec) {
  if (!spec) return false
  if (paintNeedsPerLetter(spec)) return true
  if (spec.v === 2 && isPlainObject(spec.scene)) {
    const hasPaintEffect = Array.isArray(spec.effects) &&
      spec.effects.some(e => EFFECTS[e?.id]?.slot === 'paint')
    return hasPaintEffect || spec.base?.type !== 'solid'
  }
  return false
}

// ── letter-split helpers (pure — shared by client renderer + server SSR) ───
//
// Lives here (not chat/paint-cosmetics.js) specifically so server routes can
// import it for free alongside compilePaintCss/paintNeedsSpans — this
// module is already server-shippable (see paint.ts's import), paint-cosmetics.js
// is not (DOM/settingsManager/fetch). paint-cosmetics.js re-exports both names
// so the existing client import path keeps working unchanged.

/** Minimal text-node HTML escape — matches what `div.textContent = x;
 * div.innerHTML` produces for plain text (only &, <, > need escaping outside
 * an attribute). Deliberately NOT the DOM-based escapeHtml in utils/helpers.js
 * (that one requires `document`), so this module stays dependency-free and
 * importable from server code. */
function escapeTextChar(ch) {
  return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch
}

function escapeTextHtml(s) {
  return String(s ?? '').replace(/[&<>]/g, escapeTextChar)
}

/**
 * Compute per-letter span data for a username: `{ mid, letters: [{ch, i}] }`.
 * mid = (length-1)/2, i = index. Pure — produces data only, no DOM.
 * @param {string} text
 */
export function computeLetterSpans(text) {
  const chars = [...String(text ?? '')]
  return {
    mid: (chars.length - 1) / 2,
    letters: chars.map((ch, i) => ({ ch, i })),
  }
}

/**
 * Build the innerHTML for a letter-split username: one <span> per glyph
 * with --i and --mid custom properties, matching computeLetterSpans().
 * Takes raw (unescaped) text — each glyph is HTML-escaped individually.
 * @param {string} rawText
 */
export function splitLettersHtml(rawText) {
  const { mid, letters } = computeLetterSpans(rawText)
  return letters.map(({ ch, i }) => `<span style="--i:${i};--mid:${mid}">${escapeTextHtml(ch)}</span>`).join('')
}

/**
 * THE inner HTML of a painted username element. Every renderer — live chat's
 * two paths, the message-element baker, the builder preview and all four SSR
 * surfaces — goes through this one function, because the markup and the
 * compiled CSS have to agree about what `${selector} span` will match and
 * nine copies of the same ternary is nine chances to disagree.
 *
 * Three shapes, in order:
 *   per-letter  one span per glyph carrying --i/--mid (wave/ripple/tumble).
 *   wrapped     ONE span around the whole name. A scene needs the fill to
 *               paint above the plate pseudo, and that is all it needs — it
 *               used to reuse the per-letter split for this, which handed
 *               every letter its own private copy of the gradient. A name
 *               with a horizontal gradient (or pan/glint/chrome/gold/reveal,
 *               which sweep along that axis) then showed six 7px-wide
 *               gradients firing in unison instead of one moving across the
 *               name — the single most-visible paint bug in the catalog, and
 *               it fired on the most obvious combination there is: put on a
 *               scene, keep your gradient.
 *   plain       escaped text, no spans.
 *
 * Takes RAW text and escapes it here — never hand it pre-escaped text.
 * @param {string} rawText
 * @param {object|null|undefined} spec
 */
export function paintNameHtml(rawText, spec) {
  return paintNameHtmlFor(rawText, paintMarkupMode(spec))
}

/** The markup shape a spec calls for: 'letters' | 'wrap' | 'none'. Renderers
 * that cache a resolved paint (message-element bakes className + shape onto
 * the message so an LRU eviction can't unpaint it) hold on to this string
 * instead of the spec object. */
export function paintMarkupMode(spec) {
  const shape = paintNeedsPerLetter(spec) ? 'letters' : paintNeedsSpans(spec) ? 'wrap' : 'none'
  // Plane boxes ride the MODE STRING rather than a second argument, because
  // renderers cache this string and call paintNameHtmlFor with it later —
  // message-element bakes it onto the message so an LRU eviction cannot
  // unpaint a row. A second argument would be one the cache never carried.
  //
  // A stale baked mode from before plane boxes existed is still a valid mode,
  // so it degrades to a name with no boxes rather than to broken markup: the
  // CSS targets `>i:nth-of-type(n)` and simply matches nothing.
  const n = spec?.v === 2 ? sceneBoxCounts(spec.scene).total : 0
  return n > 0 ? `${shape}+${n}` : shape
}

/** paintNameHtml with the shape already decided. Unknown modes fall through
 * to plain escaped text — a stale baked mode can never emit raw HTML.
 *
 * THE NAME GETS ITS OWN BOX, ALWAYS. `.hs-name` wraps the text and nothing else;
 * the scene planes are its siblings. Everything about the NAME — the fill, the
 * whole-name motion, the letter phase driver — is compiled against that box,
 * and the host is left holding only layout and the planes.
 *
 * Without it the two share one element, and a `transform` on an element
 * transforms its whole subtree: `coin` spun the backdrop and the weather along
 * with the glyphs, as did heli/float/heart/wobble/swing/jitter, while `flicker`
 * faded the entire diorama. The fill had already been pushed down onto the
 * spans for the same class of reason; the motion never was. Reported from a
 * phone as "the flip is flipping the scenery too and weather".
 *
 * It also bounds the inheriting `@property` phase driver: dirtying the name box
 * no longer dirties six absolutely-positioned plane elements per name. */
export function paintNameHtmlFor(rawText, mode) {
  const [shape, boxes] = String(mode ?? '').split('+')
  // The boxes come FIRST and carry no content. They are absolutely positioned
  // and z-ordered by the compiler, so document order decides nothing visual —
  // but an empty leading element contributes nothing to a copied selection
  // either, which keeps a painted name copyable as its own text.
  let planes = ''
  const n = Number(boxes)
  if (Number.isInteger(n) && n > 0 && n <= MAX_PLANE_BOXES) planes = "<i aria-hidden=\"true\"><b></b></i>".repeat(n)
  const body = shape === 'letters' ? splitLettersHtml(rawText) : escapeTextHtml(rawText)
  return `${planes}<span class="${NAME_BOX_CLASS}">${body}</span>`
}

// ── id-space safety (paint lookup key guard) ────────────────────────────────

/**
 * Resolve `id` to the users.id-space key safe to use as a paint lookup
 * against `/api/paints` — or `null` if this platform has no safe lookup.
 *
 * Paints are keyed by users.id. Twitch signup writes the Twitch numeric user
 * id AS the users.id PK, so a Twitch id IS that id space by construction —
 * same for heatsync-native accounts, so both resolve to themselves unchanged.
 * Kick ids are ALSO bare numerics, and Kick's id range (~1-50M) sits entirely
 * inside Twitch's (~1-1.5B) — so an un-namespaced Kick id can numerically
 * collide with an unrelated Twitch user's id and pull back THEIR paint onto
 * the wrong person (see heatsync_userid_collision_kick_twitch). Kick-origin
 * users.id rows are namespaced `kick_<id>` (migrations/200_kick_id_namespace.sql),
 * so a Kick id resolves to that namespaced form instead. YouTube channel ids
 * (`UC...`) aren't numeric so can't collide today, but are gated the same
 * way — an explicit platform allow-list, not a shape-guess — so a future
 * numeric-ish YouTube id can't slip through unnoticed either.
 *
 * Only 'twitch', 'heatsync' and 'kick' resolve today. A future YouTube paint
 * feature must mint its own namespaced id and teach this function about it —
 * never pass the raw platform id through.
 * @param {unknown} id
 * @param {unknown} platform
 * @returns {string|null}
 */
export function isPaintLookupSafeId(id, platform) {
  if (typeof id !== 'string' || id.length === 0) return null
  if (platform === 'twitch' || platform === 'heatsync') return id
  if (platform === 'kick') return `kick_${id}`
  // youtube: id = the author's UC… channel id (innertube authorExternalChannelId);
  // users.id for yt accounts is yt_<UCid> (google oauth mint, 4ecd0256)
  if (platform === 'youtube' && /^UC[A-Za-z0-9_-]{22}$/.test(id)) return `yt_${id}`
  return null
}

// ── compiler ─────────────────────────────────────────────────────────────

function safeAngle(angle) {
  const n = Math.round(Number(angle))
  return Number.isFinite(n) ? ((n % 360) + 360) % 360 : 0
}

function safePos(pos) {
  const n = Math.round(Number(pos))
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0
}

/**
 * Nudge any stops sharing a position apart into the smallest gap available,
 * preserving relative colour order and the caller's own array order (input
 * order is NOT assumed sorted by pos — the builder's array is insertion
 * order, e.g. a stop added last can sit anywhere in the gradient).
 *
 * Two passes over the pos-sorted view: forward, pushing each stop to at
 * least one more than the one before it (the common case — one duplicate at
 * the tail); then, only if that ran a stop past 100, backward from 100 doing
 * the mirror image. With at most MAX_STOPS (8) stops across a 0-100 range
 * there is always room for both — the two passes can never fight.
 *
 * Pure — returns a new array, same length and order as `stops`, reusing
 * unchanged stop objects and only cloning the ones whose position moved.
 *
 * validatePaintSpec refuses a spec with a collision outright (a save-time
 * rule — see its own doc), which is correct for anything arriving over the
 * wire. This is the other half: a spec that already collided when it was
 * saved (before that check existed) must never be HANDED to that validator
 * unrepaired by the one surface that authors specs — the builder repairs on
 * load, before the person sees it — and the compiler repairs its own working
 * copy so an already-saved colliding paint stops rendering a zero-width band
 * on every surface immediately, without waiting for anyone to open the
 * builder and re-save.
 */
export function repairStopCollisions(stops) {
  if (!Array.isArray(stops) || stops.length < 2) return stops
  const withIndex = stops.map((s, i) => ({ pos: s?.pos, i }))
  withIndex.sort((a, b) => a.pos - b.pos)
  for (let k = 1; k < withIndex.length; k++) {
    if (withIndex[k].pos <= withIndex[k - 1].pos) withIndex[k].pos = withIndex[k - 1].pos + 1
  }
  if (withIndex[withIndex.length - 1].pos > 100) {
    withIndex[withIndex.length - 1].pos = 100
    for (let k = withIndex.length - 2; k >= 0; k--) {
      if (withIndex[k].pos >= withIndex[k + 1].pos) withIndex[k].pos = withIndex[k + 1].pos - 1
    }
  }
  const posByIndex = new Array(stops.length)
  for (const { pos, i } of withIndex) posByIndex[i] = pos
  return stops.map((s, i) => (s?.pos === posByIndex[i] ? s : { ...s, pos: posByIndex[i] }))
}

function sortedStops(base) {
  const stops = Array.isArray(base?.stops) ? base.stops : []
  const cleaned = stops
    .filter(s => isPlainObject(s) && HEX_RE.test(s?.color) && isIntInRange(s.pos, 0, 100))
    .map(s => ({ color: safeHex(s.color), pos: safePos(s.pos) }))
    .sort((a, b) => a.pos - b.pos)
  // Repairs an already-saved colliding spec (predates validatePaintSpec's
  // collision check) so it renders correctly on every surface, immediately —
  // see repairStopCollisions' doc for why this lives here as well as in the
  // builder.
  return repairStopCollisions(cleaned)
}

/**
 * `stops` plus a duplicate of the first colour appended at 100% so a
 * `pan`/`conic` sweep loops without a visible seam.
 *
 * The real stops are compressed into 0-99 first, because a user's own last
 * stop routinely already sits at pos 100 (it's the default gradient's own
 * end). Appending the wrap duplicate there too used to put two stops at the
 * exact same position — 0% -> 100% -> 100% — which compiles to a zero-width
 * band: no visible run between them, i.e. a hard edge at the exact instant
 * the sweep wraps. Scaling preserves stop order and only shifts each
 * position by ~1%, invisible next to the bug it prevents.
 */
function stopsWithWrap(stops) {
  if (!stops.length) return stops
  const scaled = stops.map(s => ({ color: s.color, pos: Math.round(s.pos * 99 / 100) }))
  return [...scaled, { color: stops[0].color, pos: 100 }]
}

/** duration in seconds for an effect at the given speed, with the WCAG
 * luminance floor applied when the effect changes luminance. */
function effectDuration(effectId, speed) {
  const meta = EFFECTS[effectId]
  return periodSeconds(meta.basePeriod, speed, meta.luminance)
}

/** Inline stamp for `--hsp-t`: the element's mount wall-time in seconds.
 * Renderers put it in the username element's style so syncDelayCalc can
 * phase-lock every instance of a paint to the shared wall clock. */
/** Class prefix of a compiled heatsync paint — `hsp-<hash>`, see chat/paint-cosmetics.js.
 * Internal — hasHeatsyncPaint is the question callers actually have. */
const PAINT_CLASS_PREFIX = 'hsp-'

/**
 * Is this element already wearing a heatsync paint?
 *
 * The precedence rule every other name cosmetic obeys: a saved heatsync paint
 * is the user's explicit (paid) choice on a heatsync surface, so it owns the
 * fill — the picked name colour stands down (applyNameColorToVisible) and so
 * does a 7TV paint (chat/seventv-cosmetics.js). With no heatsync paint saved,
 * a 7TV paint renders free, so a 7TV subscription keeps its value in here.
 * @param {Element} el
 */
export function hasHeatsyncPaint(el) {
  for (const c of el.classList) if (c.startsWith(PAINT_CLASS_PREFIX)) return true
  return false
}

export function paintPhaseNow() {
  // ONE STAMP PER FRAME, and that is the whole correctness of the lock.
  //
  // The phase a copy lands on is (its animation's startTime − its own stamp).
  // A CSS animation starts at the frame's timeline time, so every element
  // created in one frame starts at the SAME instant — while a per-call
  // Date.now() gave each of them a DIFFERENT stamp. Measured on a phone: 24
  // painted rows carried 24 distinct stamps spread over 61ms but their
  // animations started in only 7 distinct frames, leaving every copy on its own
  // phase by up to 161ms. Visible as "on scroll up still making a 2nd
  // animation start time for the same paints".
  //
  // document.timeline.currentTime is constant for the whole frame and is the
  // exact value those animations will take as their startTime, so keying the
  // memo on it makes stamp and start move together instead of nearly together.
  // It still advances in step with the wall clock across frames, so copies
  // mounted in DIFFERENT frames stay locked to each other too.
  const frame = typeof document !== 'undefined' && document.timeline
    ? document.timeline.currentTime : null
  if (frame !== null && frame === phaseStampFrame) return phaseStamp
  phaseStamp = `${(Date.now() / 1000).toFixed(3)}s`
  phaseStampFrame = frame
  return phaseStamp
}
let phaseStamp = ''
/** The timeline time `phaseStamp` was taken in; null outside a document (SSR). */
let phaseStampFrame = null

function gradientStopsCss(stops) {
  return stops.map(s => `${s.color} ${s.pos}%`).join(', ')
}

/** Build the CSS for the resting `base` paint. Returns { decl, isClipText }. */
function buildBaseCss(base, stops) {
  if (base.type === 'solid') {
    const color = stops[0]?.color || '#e4e4e4'
    return { decl: `color:${color};`, isClipText: false, cssImage: `linear-gradient(${color}, ${color})` }
  }
  const angle = safeAngle(base.angle)
  const image = base.type === 'linear'
    ? `linear-gradient(${angle}deg, ${gradientStopsCss(stops)})`
    : `conic-gradient(from ${angle}deg, ${gradientStopsCss(stops)})`
  return {
    decl: `background:${image};-webkit-background-clip:text;background-clip:text;color:transparent;`,
    isClipText: true,
    cssImage: image,
  }
}

// ── themed paint presets (fixed palettes, faithful port of paint-lab.html) ──

// Every colour here clears PAINT_MIN_CONTRAST against PAINT_BG, and a test
// holds them to it. They did not: chrome bottomed out at 1.92:1, fire at
// 1.91:1 and matrix at 1.39:1 — while the validator refused to let a USER
// save a stop that dim. matrix was the worst of it: 60% of its pattern was
// #003300, so at name size the glyphs were near-black most of the time and
// the effect read as a row of faint dashes. Its bands are inverted now —
// bright phosphor with a thin dark scanline, instead of the reverse — which
// is also what a name-sized matrix should have looked like all along (the
// falling-glyph fantasy is the `glyphs` weather's job, not a six-glyph name).
// A curated set that ships an unreadable paint is worse than a free picker,
// because we chose it.
const THEMED_PAINT = {
  chrome: {
    gradient: 'linear-gradient(100deg, #6b7280, #e5e7eb 20%, #5a6678 38%, #f3f4f6 52%, #556173 70%, #d1d5db 88%, #6b7280)',
    size: '220% 100%',
    roundTrip: true,
    decl: ph => `background-position:${bounce(ph, '0%', '120%')} 0;`,
  },
  gold: {
    gradient:
      'repeating-linear-gradient(115deg, transparent 0 3px, #ffffff2e 3px 4px), ' +
      'linear-gradient(90deg, #7a5900, #ffd700 30%, #fff3b0 50%, #ffd700 70%, #7a5900)',
    size: '100% 100%, 200% 100%',
    roundTrip: true,
    decl: ph => `background-position:0 0, ${bounce(ph, '0%', '100%')} 0;`,
  },
  fire: {
    gradient: 'linear-gradient(0deg, #c00000, #d70000 35%, #ff8700 65%, #ffd700 90%)',
    size: '100% 300%',
    roundTrip: true,
    decl: ph => `background-position:0 ${bounce(ph, '100%', '40%')};transform:skewX(${bounce(ph, '0deg', '-1.5deg')});`,
  },
  matrix: {
    gradient: 'repeating-linear-gradient(0deg, #00ff87 0 5px, #00d700 5px 8px, #1a7a38 8px 10px)',
    size: '100% 340%',
    roundTrip: false,
    decl: ph => `background-position:0 ${wrap(ph, '0%', '340%')};`,
  },
  holo: {
    gradient: 'repeating-linear-gradient(0deg, #00e5ff 0 2px, #007a88 2px 4px)',
    size: '100% 200%',
    roundTrip: false,
    decl: ph => `background-position:0 ${wrap(ph, '0%', '200%')};`,
  },
  rainbow: {
    // The first stop repeated last, so the pan wraps without a seam.
    gradient: 'linear-gradient(90deg, #ff0000, #ff8700 14%, #ffff00 28%, #00ff00 42%, #00d7ff 57%, #875fff 71%, #ff00ff 85%, #ff0000)',
    size: '300% 100%',
    roundTrip: false,
    decl: ph => `background-position:${wrap(ph, '0%', '300%')} 0;`,
  },
  ice: {
    gradient: 'linear-gradient(100deg, #87d7ff, #ffffff 24%, #afd7ff 42%, #ffffff 58%, #87d7ff 76%, #d7ffff 100%)',
    size: '220% 100%',
    roundTrip: true,
    decl: ph => `background-position:${bounce(ph, '0%', '120%')} 0;`,
  },
  lava: {
    // Bright crust with darker seams rolling upward — every band clears the
    // floor, the seams included (a crust that was mostly black read as dashes,
    // the same lesson as matrix).
    gradient: 'repeating-linear-gradient(0deg, #ff5f00 0 4px, #ffaf00 4px 5px, #d70000 5px 7px)',
    size: '100% 300%',
    roundTrip: false,
    decl: ph => `background-position:0 ${wrap(ph, '0%', '-300%')};`,
  },
}

/** One linear 0→1 `@property` phase Animation, parent-scoped — the same
 * "one Animation, many dependent values" shape buildLetterMotionCss uses for
 * motion effects, extended to the paint slot. A paint-slot fill used to put
 * `animation:`/`animation-delay:` directly on `${selector} span` when the
 * name was letter-split, so a 12-letter gold/fire/pan/etc. name ran 12 live
 * Animation instances for that ONE layer alone — the exact "known remaining
 * gap" flagged when buildLetterMotionCss got this treatment (see its doc
 * comment): a paint fill combined with a letter-split name still animated
 * per-glyph. On mobile that's enough on its own to blow the whole page's
 * PAINT_ANIMATION_BUDGET (paint-cosmetics.js) off ONE multi-layer name,
 * which reads as "only one paint animating" even though every other visible
 * name is correctly configured — the budget froze them, not the compiler.
 * Every paint-slot effect below now drives its moving value(s) off this one
 * inherited phase via calc(), so a name's live-animation count from its
 * paint layer is 1 regardless of letter count or split. */
function paintPhaseDriver(effectId, period, hash, opts = {}) {
  const phaseVar = `--hsp-${hash}-${effectId}-ph`
  const animName = `hsp_${hash}_${effectId}`
  // ── RATE-LIMITED ──────────────────────────────────────────────────────────
  //
  // The fill is the one animation every painted name has, and what it moves is
  // a `background-position` / gradient angle / `mask-position` through
  // `background-clip:text` — pure raster, redrawn on every frame the display
  // offers. paint-core.steppedTiming caps that at FILL_STEPS_PER_SECOND.
  //
  // Correct here and ONLY here, among the name's animations, because these
  // keyframes are a single interval (`to{--ph:1}`). A CSS timing function
  // applies per keyframe INTERVAL, so `steps(n)` on the multi-stop whole-name
  // motions (buildMotionEffectCss — jitter alone has eight stops at 2%
  // intervals) would give n steps inside each interval and multiply the redraw
  // rate rather than cap it. Those keep their own timing; three of them already
  // use `steps(1,end)` deliberately to hold a resting frame.
  //
  // steppedTiming returns null for a luminance effect (hue, pulse) and it stays
  // smooth — a quantised brightness ramp is flashing, not drifting.
  const stepped = steppedTiming(period, FILL_STEPS_PER_SECOND, {
    luminance: !!EFFECTS[effectId]?.luminance,
    // A one-way ramp needs `jump-none` so its final keyframe is actually shown;
    // under the default `jump-end` glint would stop a step short of the end of
    // its sweep every cycle. The `wrap()` fills are cyclic (end is the start
    // again), so not showing the last step is invisible there.
    oneWay: !!opts.oneWay,
  })
  return {
    phaseVar,
    selfPart: {
      decls: '',
      animShorthand: `${animName} ${period}s ${stepped || 'linear'} infinite`,
      // What the crowd dial needs to re-time this one animation (see
      // CROWD_TIERS). `noStep` is carried, not inferred, so a part that must
      // never be quantised says so itself rather than the tier builder
      // re-deriving a rule that already lives in steppedTiming.
      tier: { period, luminance: !!EFFECTS[effectId]?.luminance, oneWay: !!opts.oneWay },
      delayExpr: syncDelayCalc(period),
      keyframes: `@property ${phaseVar}{syntax:'<number>';inherits:true;initial-value:0;}` +
        `@keyframes ${animName}{to{${phaseVar}:1;}}`,
    },
  }
}

// start→end once per phase cycle, then an instant jump back to start — the
// same discontinuous-but-seamless wrap a bare `to{}` keyframe produces
// (pan/rainbow/etc. already engineer their gradient to repeat seamlessly
// across that jump — see pan's own comment).
// ── PHASE DERIVATION ────────────────────────────────────────────────────────
//
// Each of these takes a phase and two endpoints and returns the value at that
// phase. The phase is EITHER a custom-property name (emit a calc() that reads
// it) OR a number (evaluate it here and emit a concrete value).
//
// The number form is what lets every effect below convert mechanically. An
// effect's `decl` is already a pure function of the phase, so calling it at
// 0 / 0.5 / 1 produces the keyframe stops for the very same motion — no
// per-effect rewrite, and no chance of one of sixteen being transcribed wrong.
//
// WHY IT MATTERS: an animated REGISTERED CUSTOM PROPERTY is a style-engine
// value. `inherits:true` means each frame dirties the element and its whole
// subtree, and `steps()` does not help — it bounds how often the derived value
// CHANGES (repaint), while the recalc happens on every frame the animation
// runs. A 25s profile of a real phone showed 1460 recalcs costing 8414ms
// against 31ms of script and zero layouts, from fourteen copies of one fill.
//
// Measured, `scripts/paint-perf.mjs --phasevar`, 20 names, per 3s at 4x CPU:
//
//   animated @property, value via calc()   style 150.4ms   paint 28.3ms
//   the same motion animated directly      style  17.3ms   paint 24.9ms
//
// Identical pixels, identical recalc COUNT, 8.7x the cost — and the @property
// form scales 12x with name count where the direct form scales 4x. Paint does
// not move, so this is not a trade.
const phaseNum = (v) => {
  const m = /^(-?\d*\.?\d+)(%|deg|px|rad|turn|em|)$/.exec(String(v).trim())
  return m ? { v: parseFloat(m[1]), u: m[2] } : null
}
/** `a` and `b` interpolated by `f` at phase `p`, as a concrete CSS value. */
const phaseAt = (p, a, b, f) => {
  const A = phaseNum(a), B = phaseNum(b)
  if (!A || !B) return null
  const u = A.u || B.u
  return `${Math.round(f(p, A.v, B.v) * 1e4) / 1e4}${u}`
}

// a linear sweep from start to end across one cycle
const wrap = (ph, start, end) => typeof ph === 'number'
  ? phaseAt(ph, start, end, (p, a, b) => a + (b - a) * p)
  : `calc(${start} + (${end} - ${start}) * var(${ph}))`

// a full there-and-back sweep within ONE phase cycle — replaces
// `ease-in-out infinite alternate` (paired with a doubled period, since one
// alternate round trip is 2 CSS animation durations). Same cosine
// substitution buildLetterMotionCss's `wave` case already uses.
const bounce = (ph, start, end) => typeof ph === 'number'
  ? phaseAt(ph, start, end, (p, a, b) => (a + b) / 2 + (a - b) / 2 * Math.cos(p * 2 * Math.PI))
  : `calc((${start} + ${end}) / 2 + (${start} - ${end}) / 2 * cos(var(${ph}) * 360deg))`

// one-way ease-in-out — half the cosine period of `bounce`, no return trip.
const ease = (ph, start, end) => typeof ph === 'number'
  ? phaseAt(ph, start, end, (p, a, b) => (a + b) / 2 - (b - a) / 2 * Math.cos(p * Math.PI))
  : `calc((${start} + ${end}) / 2 - (${end} - ${start}) / 2 * cos(var(${ph}) * 180deg))`

/**
 * Which way a `pan` sweeps, from the angle the user set.
 *
 * A pan slides the gradient IMAGE past the glyphs, and sliding it across its
 * own bands moves nothing you can see. The sweep was hard-coded to x, so a
 * `0deg`/`180deg` pan — horizontal bands, swept horizontally — was completely
 * STATIC: the one paint whose whole job is movement, frozen, for a third of
 * the angle dial. And at every angle that did move, it moved the same way
 * (right to left) no matter what the dial said, so "angle" only ever tilted
 * the bands and never chose a direction.
 *
 * Now the sweep follows the gradient's own axis, and the angle means what it
 * reads as: 90° flows left→right, 270° right→left, 0° bottom→top, 180°
 * top→bottom, with the diagonals leaning on whichever axis they favour.
 *
 * CSS gradient angles are clockwise from "to top", so the gradient's direction
 * in screen coordinates (x right, y down) is `(sin θ, -cos θ)`. A
 * `background-position` percentage moves an oversized image the OTHER way —
 * larger p pulls it left/up — hence the sign flips below. One axis only: two
 * axes would need the image to tile seamlessly in both, which a linear
 * gradient does not.
 */
function panSweep(angle, ph) {
  const rad = angle * Math.PI / 180
  const sin = Math.sin(rad), cos = Math.cos(rad)
  if (Math.abs(sin) >= Math.abs(cos)) {
    return { size: '300% 100%', x: wrap(ph, '0%', sin > 0 ? '-300%' : '300%'), y: '0' }
  }
  return { size: '100% 300%', x: '0', y: wrap(ph, '0%', cos > 0 ? '300%' : '-300%') }
}

/** Build the pieces for a `paint`-slot effect: { selfPart, decl }. `decl` is
 * a plain, unanimated declaration block (background/filter/opacity/mask, all
 * calc()-derived from the phase); `selfPart` is the one Animation driving it,
 * merged by the caller into compilePaintCss's shared self-animation
 * comma-list (same slot motion effects already share — two rules setting
 * `animation` on one selector clobber each other). Returns null for an
 * unknown effect id. */
function paintFillAt(effectId, speed, base, stops, hash, ph) {
  let __period = 0, __opts = {}, __usesPhaseVar = false
  const duration = effectDuration(effectId, speed)

  if (THEMED_PAINT[effectId]) {
    const t = THEMED_PAINT[effectId]
    const phaseVar = ph; __period = t.roundTrip ? duration * 2 : duration; __opts = {}
    const decl = `background:${t.gradient};background-size:${t.size};-webkit-background-clip:text;background-clip:text;color:transparent;${t.decl(phaseVar)}`
    return { decl, period: __period, opts: __opts, usesPhaseVar: __usesPhaseVar }
  }

  if (effectId === 'pan') {
    // Force linear rendering — pan is a directional positional sweep, and
    // needs the gradient axis a linear-gradient provides. Append the first
    // stop again so the pan wraps without a visible seam.
    const angle = safeAngle(base.angle)
    const wrapStops = stopsWithWrap(stops)
    const image = `linear-gradient(${angle}deg, ${gradientStopsCss(wrapStops)})`
    const phaseVar = ph; __period = duration; __opts = {}
    const { size, x, y } = panSweep(angle, phaseVar)
    const decl = `background:${image};background-size:${size};-webkit-background-clip:text;background-clip:text;color:transparent;background-position:${x} ${y};`
    return { decl, period: __period, opts: __opts, usesPhaseVar: __usesPhaseVar }
  }

  if (effectId === 'conic') {
    // Force conic rendering — rotates the whole wheel straight off the
    // shared phase var (0→1), no extra @property of its own needed.
    const angle = safeAngle(base.angle)
    const wrapStops = stopsWithWrap(stops)
    const phaseVar = ph; __period = duration; __opts = {}
    // THE ONE EFFECT THAT KEEPS ITS PHASE VARIABLE.
    //
    // conic's motion is a full rotation of the gradient itself, and a rotation
    // does not survive being sampled into keyframes: `from 0deg` and
    // `from 360deg` are the SAME angle, so the two stops are identical,
    // chromium normalises them and the animation becomes a no-op. Measured that
    // way — the resting frame matched and every frame after it was frozen,
    // which is exactly what a silent no-op looks like next to a working one.
    //
    // Splitting it into thirds would make each interval a real rotation, but
    // then the rendered value between stops depends on whether chromium
    // interpolates a conic gradient's angle or cross-fades the two images, and
    // guessing that is how a subtly wrong paint ships. One effect keeping the
    // custom property is a cost only conic's wearers pay; a wrong one is paid
    // by everybody.
    __usesPhaseVar = true
    const image = `conic-gradient(from calc(${angle}deg + 360deg * var(${phaseVar})), ${gradientStopsCss(wrapStops)})`
    // `background-image`, not the `background` SHORTHAND. conic is the one
    // effect whose moving value is the image itself, so the image is what ends
    // up in the keyframes — and a shorthand in a keyframe resets every longhand
    // it covers, including `background-clip:text`. That drops the glyph clip
    // for the whole animation and paints the gradient as a rectangle over the
    // name. Fenced below in partitionDecls so it cannot come back quietly.
    const decl = `background-image:${image};-webkit-background-clip:text;background-clip:text;color:transparent;`
    return { decl, period: __period, opts: __opts, usesPhaseVar: __usesPhaseVar }
  }

  if (effectId === 'hue') {
    // Orthogonal to gradient type — filter applies post-render regardless
    // of how base painted the text.
    const baseCss = buildBaseCss(base, stops)
    const phaseVar = ph; __period = duration; __opts = {}
    const decl = `${baseCss.decl}filter:hue-rotate(${wrap(phaseVar, '0deg', '360deg')});`
    return { decl, period: __period, opts: __opts, usesPhaseVar: __usesPhaseVar }
  }

  if (effectId === 'glint') {
    const baseCss = buildBaseCss(base, stops)
    const image = `linear-gradient(115deg, transparent 38%, #ffffffcc 50%, transparent 62%) no-repeat, ${baseCss.cssImage}`
    // `ease()` is a one-way sweep (210% → -110%), not a cyclic wrap, so the
    // stepped timing must show its final keyframe — see paintPhaseDriver.
    const phaseVar = ph; __period = duration; __opts = { oneWay: true }
    const decl = `background:${image};background-size:250% 100%, 100% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;background-position:${ease(phaseVar, '210%', '-110%')} 0, 0 0;`
    return { decl, period: __period, opts: __opts, usesPhaseVar: __usesPhaseVar }
  }

  if (effectId === 'stripes') {
    // Hard diagonal bands of the user's own stops (a solid gets white as its
    // second band), rolling like a barber pole. background-size is left at
    // the element's own box, so shifting the position by one period along x
    // — period × √2 for a 45° gradient — advances exactly one repeat.
    const BAND = 5
    const colors = stops.length > 1 ? stops.map(s => s.color) : [stops[0]?.color || '#e4e4e4', '#ffffff']
    const bands = colors.map((c, i) => `${c} ${i * BAND}px ${(i + 1) * BAND}px`).join(', ')
    const shift = (colors.length * BAND * Math.SQRT2).toFixed(2)
    const phaseVar = ph; __period = duration; __opts = {}
    const decl = `background:repeating-linear-gradient(45deg, ${bands});-webkit-background-clip:text;background-clip:text;color:transparent;background-position:${wrap(phaseVar, '0px', `${shift}px`)} 0;`
    return { decl, period: __period, opts: __opts, usesPhaseVar: __usesPhaseVar }
  }

  if (effectId === 'stardust') {
    // Two dot fields drifting across the user's own fill at different rates
    // (parallax, like the weathers), each advancing a whole number of tiles
    // per loop so the wrap is seamless.
    const baseCss = buildBaseCss(base, stops)
    const image = `radial-gradient(circle, #ffffff 0 .7px, transparent 1.1px) repeat, radial-gradient(circle, #ffffffaa 0 .5px, transparent .9px) repeat, ${baseCss.cssImage}`
    const phaseVar = ph; __period = duration; __opts = {}
    const pos1 = `${wrap(phaseVar, '0px', '-27px')} ${wrap(phaseVar, '0px', '21px')}`
    const pos2 = `${wrap(phaseVar, '4px', '-22px')} ${wrap(phaseVar, '3px', '25px')}`
    const decl = `background:${image};background-size:9px 7px, 13px 11px, 100% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;background-position:${pos1}, ${pos2}, 0 0;`
    return { decl, period: __period, opts: __opts, usesPhaseVar: __usesPhaseVar }
  }

  if (effectId === 'pulse') {
    // Breathes the whole fill — opacity, not filter, so it never lands on
    // the same property as hue. Luminance-flagged: the floor keeps it slow
    // (MIN_LUMINANCE_PERIOD_S, paint-core.js — a period guard, untouched by
    // the dip depth below).
    //
    // The dip was .45 — at name size, beside twenty other names in a moving
    // feed, that read as "not working" (reported: "what does pulse even
    // do/mean i think its not working for my paint"). .12 is a much more
    // legible breathe without ever hitting fully transparent, so the name
    // never disappears at the bottom of the cycle.
    //
    // Already a full round trip within one cycle (not CSS `alternate`), so
    // the phase period is the plain duration, same as `bounce`'s other uses
    // pair with a doubled one.
    const baseCss = buildBaseCss(base, stops)
    const phaseVar = ph; __period = duration; __opts = {}
    const decl = `${baseCss.decl}opacity:${bounce(phaseVar, '1', '.12')};`
    return { decl, period: __period, opts: __opts, usesPhaseVar: __usesPhaseVar }
  }

  if (effectId === 'reveal') {
    const baseCss = buildBaseCss(base, stops)
    const mask = 'linear-gradient(90deg, #000 30%, #0003 50%, #000 70%)'
    const phaseVar = ph; __period = duration; __opts = {}
    const pos = wrap(phaseVar, '130%', '-130%')
    const decl = `${baseCss.decl}-webkit-mask-image:${mask};mask-image:${mask};-webkit-mask-size:300% 100%;mask-size:300% 100%;-webkit-mask-position:${pos} 0;mask-position:${pos} 0;`
    return { decl, period: __period, opts: __opts, usesPhaseVar: __usesPhaseVar }
  }

  return null
}

/**
 * One paint-slot fill, as a static declaration plus the animation that moves it.
 *
 * The motion used to ride an animated registered custom property: one
 * `@property --hsp-<hash>-<fx>-ph` going 0 -> 1, with every real value derived
 * from it by `calc()`. That is a style-engine animation, and `inherits:true`
 * makes each frame dirty the element and its whole subtree — measured at 8.7x
 * the style cost of animating the same values directly, for the same pixels
 * (`scripts/paint-perf.mjs --phasevar`).
 *
 * So the phase is now sampled at compile time instead. `paintFillAt` is the
 * old builder with the phase as a parameter, so calling it at 0 / 0.5 / 1
 * yields the keyframe stops for exactly the motion the calc() described. No
 * effect was rewritten by hand and none can be transcribed wrong.
 *
 * Every shape ends up as TWO stops and ONE interval, so the rate cap applies
 * once and the period, direction and phase-lock delay are untouched. What
 * differs is only the timing function: `steps()` where the effect was already
 * linear in the phase, and a sampled `linear()` where it was a cosine — see
 * linearEasing, which is why a there-and-back needs neither a third stop nor
 * `alternate`.
 */
/** Properties whose keyframe would silently reset their own longhands. */
const SHORTHANDS = new Set(['background', 'mask', 'font', 'border', 'outline', 'flex', 'grid', 'animation', 'transition'])


/** `a:1;b:2;` -> [['a','1'],['b','2']]. Splits on top-level `;` only, so a
 *  value carrying commas or nested functions survives intact. */
function splitDecls(str) {
  const out = []
  let depth = 0, buf = ''
  for (const ch of String(str || '')) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ';' && depth === 0) { if (buf.trim()) out.push(buf.trim()); buf = ''; continue }
    buf += ch
  }
  if (buf.trim()) out.push(buf.trim())
  return out.map(d => { const i = d.indexOf(':'); return [d.slice(0, i).trim(), d.slice(i + 1).trim()] })
}

/**
 * Which declarations actually move across the sampled phases.
 *
 * Only those belong in the keyframes. The rest — the gradient image itself, the
 * clip, the transparent fill colour — are the same at every phase, and putting
 * them in every keyframe stop would have the animation re-declare a
 * repeating-linear-gradient on each one. Emitting a property in a keyframe
 * makes it animated, and animating an IMAGE is a different and far more
 * expensive thing than animating the position of one.
 */
function partitionDecls(samples) {
  const maps = samples.map(d => new Map(splitDecls(d)))
  const keys = [...maps[0].keys()]
  const statics = [], moving = []
  for (const k of keys) {
    const v0 = maps[0].get(k)
    if (maps.every(m => m.get(k) === v0)) statics.push(`${k}:${v0};`)
    else moving.push(k)
  }
  // A SHORTHAND must never be the thing that moves. Declaring one inside a
  // keyframe resets every longhand it covers to its initial value for the
  // duration of the animation — `background` takes `background-clip:text` with
  // it, which drops the glyph clip and paints the fill as a rectangle over the
  // name. conic shipped exactly that for the length of one bench run.
  for (const k of moving) {
    if (SHORTHANDS.has(k)) {
      throw new Error(`paint compiler: '${k}' is a shorthand and cannot be animated — `
        + `emit the longhand that actually moves (e.g. background-image), or its keyframes `
        + `will reset background-clip/color and the fill will stop being a glyph clip`)
    }
  }
  return { statics: statics.join(''), moving, at: (i) => moving.map(k => `${k}:${maps[i].get(k)};`).join('') }
}

function buildPaintPhaseCss(effectId, speed, base, stops, hash) {
  const at = (ph) => paintFillAt(effectId, speed, base, stops, hash, ph)
  const probeVar = `--hsp-${hash}-${effectId}-ph`
  const probe = paintFillAt(effectId, speed, base, stops, hash, probeVar)
  if (!probe) return null
  const a0 = at(0)
  const d1 = at(1).decl
  const dHalf = at(0.5).decl
  const { period, opts } = a0

  // ── WHICH EFFECTS CONVERT ───────────────────────────────────────────────
  //
  // All of them but one. Three shapes, each asked of the effect itself rather
  // than read off a list, so a new effect classifies itself:
  //
  //  - LINEAR in the phase (`wrap`) -> two stops and the timing function it
  //    already carried. Byte-identical; the pixel gate confirms by not moving.
  //  - ROUND TRIP (`bounce`: phase 1 renders as phase 0, phase .5 does not) ->
  //    two stops from phase 0 to phase .5, and a `linear()` easing that rises to
  //    1 at the half and returns to 0. The value therefore goes A -> B -> A
  //    within one interval. NOT `alternate`: the round trip belongs in the
  //    easing, so the period, the direction and the delay all stay exactly what
  //    they were, and one seek still lands on one phase.
  //  - ONE WAY (`ease`, glint) -> two stops and the same easing over half the
  //    cosine, ending where it arrives.
  //
  // conic is the one that stays on the driver, for its own reason: its motion is
  // a full rotation, and `from 0deg` and `from 360deg` are the same angle, so
  // sampled stops come out identical, chromium normalises them, and the
  // animation silently becomes a no-op. Measured exactly that — the resting
  // frame correct and every frame after it frozen.
  if (probe.usesPhaseVar) {
    const { selfPart } = paintPhaseDriver(effectId, probe.period, hash, probe.opts)
    // A driver animates an INHERITING custom property, so it has to run on an
    // ancestor of whatever reads it — the one part that must not follow the
    // fill down onto the spans.
    return { selfPart, decl: probe.decl, drivesPhaseVar: true }
  }

  const animName = `hsp_${hash}_${effectId}`
  const stepOpts = {
    luminance: !!EFFECTS[effectId]?.luminance,
    oneWay: !!opts.oneWay,
  }
  const roundTrip = d1 === a0.decl && dHalf !== a0.decl

  // The round trip's far end is phase .5 — phase 1 is where it came back to, so
  // sampling [0, 1] would find nothing moving at all.
  const parts = partitionDecls([a0.decl, roundTrip ? dHalf : d1])
  const curve = roundTrip ? 'roundTrip' : opts.oneWay ? 'oneWay' : null
  // The shorthand carries the FALLBACK function, never the sampled easing: a
  // `linear()` an engine rejects would invalidate the whole `animation`
  // shorthand and leave the paint frozen, where a rejected
  // `animation-timing-function` declaration just falls back to this.
  const timing = curve ? 'ease-in-out'
    : steppedTiming(period, FILL_STEPS_PER_SECOND, stepOpts) || 'linear'
  const keyframes = `@keyframes ${animName}{from{${parts.at(0)}}to{${parts.at(1)}}}`

  return {
    // The RESTING frame is the hero frame: what a static paint, an SSR page and
    // a reduced-motion surface all render, and what the animation starts from.
    // It carries the moving declarations at phase 0 too, so a static render is
    // the composition at rest rather than a name with no fill at all.
    decl: a0.decl,
    drivesPhaseVar: false,
    selfPart: {
      decls: '',
      animShorthand: `${animName} ${period}s ${timing} infinite`,
      tier: { period, luminance: !!EFFECTS[effectId]?.luminance, oneWay: !!opts.oneWay, curve, timing },
      delayExpr: syncDelayCalc(period),
      keyframes,
    },
  }
}

/** Put on the name box by the runtime once every glyph has a mask. Everything
 *  below is gated on it, so a browser without `mask-image`, a font that has not
 *  loaded, or a name the masker refused all keep exactly today's clip-text
 *  path. See client/cosmetics/glyph-mask.js. */
export const MASKED_CLASS = 'hs-masked'

/**
 * ── THE COMPOSITED FILL ─────────────────────────────────────────────────────
 *
 * The fill is the one animation every painted name has, and it was the last
 * cosmetic still on the repaint path: a `background-position` moving under
 * `background-clip:text` re-rasters its element every frame it changes, and a
 * split name puts that on one span per GLYPH. Measured on this compiler,
 * 414x896 @ dpr3, cpu 4x, renderer ms per 3s (`paint-perf --composited`):
 *
 *   background-clip:text   104.5ms @ 1 name    851.4ms @ 20    3704 paints
 *   masked + transform       1.1ms @ 1 name      6.8ms @ 20       1 paint
 *
 * Same trick as animated-texture.js and buildLetterMotionCss: stop moving a
 * painted value, move a static texture instead. The glyph's letterform becomes
 * a `mask-image` on the span (rasterised once per CHARACTER — the fill is
 * already per-glyph local, because the spans are inline-block, so
 * `background-size:300%` is 300% of ONE LETTER), and the gradient moves on a
 * `::before` under it with `transform` alone.
 *
 * A REAL CHILD ELEMENT, not `::before`, and that is the whole difference
 * between this working and not. The first cut used a pseudo — no markup change
 * at all, which was the appeal — and it removed the repaint exactly as designed
 * (3865 paint operations to 1) while costing MORE overall, because a pseudo's
 * animation forces a full style recalc of the element that owns it, every
 * frame. Same rules on an `<i>` instead, measured by the same arm at twenty
 * names (paint-perf --masked):
 *
 *   ::before   1100.3ms total, 141 style recalcs per 3s
 *   <i>           2.1ms total,   1 style recalc  per 3s
 *
 * The `<i>` is appended by the RUNTIME, never by paintNameHtml, so the compiler's
 * markup and everything resting on it are still untouched: the copyable-text
 * contract at paintNameHtmlFor, the pre-built `identity.nameHtml` that mentions
 * and reply heads depend on, and every markup test. It is out of flow and
 * carries no text, so selection, copy and find-in-page do not see it, and it is
 * `aria-hidden` like the scene planes. The span keeps its real text node at
 * `color:transparent`.
 *
 * ── THE GEOMETRY IS DERIVED, NOT AUTHORED ───────────────────────────────────
 *
 * `background-position: p%` resolves against (box - tile), so with a tile N
 * boxes wide the sweep 0 -> N*100% travels N(N-1) boxes — 6 boxes at N=3. A
 * transform cannot be handed that number directly and stay seamless: N(N-1)/N
 * = N-1 tiles is whole only when N is.
 *
 * So translate exactly ONE tile and scale the period to match the old speed.
 * One tile is seamless for any repeating background by definition, whatever N
 * is, and speed is preserved because the old sweep covered N-1 tiles in one
 * period. Everything is then a constant off N:
 *
 *   ::before size   (1 + N) * 100%      background-size   N/(1+N) * 100%
 *   translate       N/(1+N) * 100%      period            P / (N-1)
 *
 * ── WHAT IS NOT CONVERTED, AND WHY ──────────────────────────────────────────
 *
 * One-way (`wrap`) sweeps with a single moving layer — which is the table
 * above, and nothing else yet.
 *
 * `chrome` and `ice` are round trips: they have no seam to keep, so the tile
 * trick is unnecessary, but their motion lives in a sampled `linear()` easing
 * that this function would have to reproduce rather than approximate — a
 * `bounce` rendered as `ease-in-out` is a visibly different motion. `gold`,
 * `glint` and `stardust` comma-list a moving layer with one or two STATIC ones,
 * and want the static layers left on the span with only the moving one on the
 * pseudo. `fire` couples its position to a `skewX` in one declaration. `conic`
 * bakes rotation into the image string and keeps the phase driver for the
 * reason buildPaintPhaseCss documents. `hue` and `pulse` already animate
 * `filter` and `opacity`, which composite on their own. `reveal` is already
 * mask-based and collides with this mask outright.
 *
 * Anything absent from the table keeps the clip-text path unchanged, so this is
 * additive — no paint renders differently because of what is missing here.
 *
 * Anything absent from this table simply keeps the clip-text path, which is
 * why the table is the whole opt-in.
 */
/** Round to 4dp the way phaseAt does, so a percentage never carries float noise
 *  into the stylesheet. */
const pct = (n) => `${Math.round(n * 1e6) / 1e4}%`

/** Split a CSS comma list at depth 0. Every layer here is a gradient and every
 *  gradient is full of commas of its own, so a plain `split(',')` shreds them. */
function splitLayers(v) {
  if (!v) return []
  const out = []
  let depth = 0
  let start = 0
  for (let i = 0; i < v.length; i++) {
    const c = v[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) { out.push(v.slice(start, i).trim()); start = i + 1 }
  }
  out.push(v.slice(start).trim())
  return out.filter(Boolean)
}

/** One property's value out of a `a:b;c:d;` declaration block. Anchored on `;`
 *  or the start, so `background-size` cannot match a request for `background`. */
function cssValue(decl, prop) {
  const m = new RegExp(`(?:^|;)\\s*${prop}:([^;]*)`).exec(decl)
  return m ? m[1].trim() : ''
}

/** A percentage as a plain number — `200%` -> 200. NaN for anything else, which
 *  is how a px-sized layer declines to be converted. */
function posPct(v) {
  return /^-?[\d.]+%$/.test(String(v).trim()) ? parseFloat(v) : NaN
}

/** A percentage as a multiple of the box — `200%` -> 2. */
function sizeUnits(v) {
  return posPct(v) / 100
}

/**
 * Does this spec compile a composited fill?
 *
 * The runtime's gate: masking a name whose paint kept the clip-text path builds
 * a letterform nothing reads, on the render path, per row.
 *
 * Asked of the COMPILED CSS, not of the spec. Which effects convert is derived
 * per effect — from where its own declaration moves — rather than listed, so a
 * list here would be a second opinion about the first, and the two would drift
 * the way the crowd dial's thresholds drifted from their comment. The caller
 * compiles once per hash and remembers the answer, so this is read once too.
 */
export function compiledCssHasCompositedFill(css) {
  return typeof css === 'string' && css.includes(`.${MASKED_CLASS}>span>i{`)
}

/**
 * The composited form of a positional fill, or null if this effect keeps the
 * clip-text path.
 *
 * @returns {{spanDecl:string,beforeRule:string,keyframes:string,tier:object}|null}
 */
function buildCompositedFill(effectId, speed, base, stops, hash, nameBox) {
  const at = (ph) => paintFillAt(effectId, speed, base, stops, hash, ph)?.decl || ''
  const probe = paintFillAt(effectId, speed, base, stops, hash, 0)
  if (!probe) return null
  const d0 = probe.decl
  const dHalf = at(0.5)
  const d1 = at(1)

  // A declaration that moves anything BUT a background layer is not this
  // function's to convert, and silently converting it would drop whatever else
  // it animates. `fire` skews as it pans; `hue` and `pulse` drive filter and
  // opacity (already composited on their own); `reveal` moves a mask, which
  // would fight the glyph mask outright.
  if (/transform:|filter:|opacity:|mask-position:/.test(d0)) return null

  const images = splitLayers(cssValue(d0, 'background'))
  const sizes = splitLayers(cssValue(d0, 'background-size'))
  const p0 = splitLayers(cssValue(d0, 'background-position'))
  const pH = splitLayers(cssValue(dHalf, 'background-position'))
  if (!images.length || images.length !== sizes.length || p0.length !== images.length) return null
  if (pH.length !== p0.length) return null

  // WHICH LAYER MOVES — asked of the effect rather than read off a list, so a
  // new effect classifies itself. `conic` bakes its rotation into the image
  // string and never moves a position, so it falls out here with no special
  // case; `stardust` moves TWO layers, which needs a box each and is a second
  // shape, so it falls out too.
  const moving = p0.map((v, i) => (v === pH[i] ? -1 : i)).filter(i => i >= 0)
  if (moving.length !== 1) return null
  const m = moving[0]

  // At a NUMERIC phase every value is a plain `<len> <len>` — the calc() form
  // only appears when the phase is a variable — so a whitespace split is safe.
  const axisOf = (a, b) => {
    const [ax, ay] = a.trim().split(/\s+/)
    const [bx, by] = b.trim().split(/\s+/)
    if (ax !== bx) return { x: true, from: posPct(ax), to: posPct(bx) }
    if (ay !== by) return { x: false, from: posPct(ay), to: posPct(by) }
    return null
  }
  const half = axisOf(p0[m], pH[m])
  if (!half) return null
  const x = half.x
  const sz = sizes[m].trim().split(/\s+/)
  const N = sizeUnits(x ? sz[0] : sz[1])
  if (!(N > 1) || !Number.isFinite(half.from) || !Number.isFinite(half.to)) return null

  // `background-position:p%` resolves against (box - tile), and the tile is the
  // larger, so a RISING position moves the image LEFT/UP. That sign is why the
  // whole catalog would otherwise run mirror-image.
  const boxesPer = (dp) => (1 - N) * dp / 100

  // A round trip returns to phase 0 at phase 1 and is somewhere else at the
  // half — the same classification buildPaintPhaseCss makes.
  const roundTrip = d1 === d0 && dHalf !== d0
  let travel, period, curve
  if (roundTrip) {
    // No seam to keep: it comes back the way it went, so it travels exactly what
    // it always travelled, keeps its period, and keeps its sampled easing. That
    // easing is the motion — rendered as a plain `ease-in-out` it is visibly a
    // different animation.
    travel = boxesPer(half.to - half.from)
    period = probe.period
    curve = 'roundTrip'
  } else {
    // ONE TILE, and the period scaled by however many tiles the old sweep
    // covered. One tile is seamless for any N by definition; the sweep's own
    // distance is N-1 tiles, which is only whole when N is (matrix tiles at
    // 3.4, so its sweep lands mid-gradient).
    const full = axisOf(p0[m], splitLayers(cssValue(d1, 'background-position'))[m])
    if (!full) return null
    const swept = boxesPer(full.to - full.from)
    if (!swept) return null
    travel = Math.sign(swept) * N
    period = probe.period * Math.abs(travel / swept)
    curve = null
  }
  if (!travel || !Number.isFinite(period) || period <= 0) return null

  const extent = 1 + Math.abs(travel)
  const size = N / extent
  const shift = travel / extent

  const animName = `${COMPOSITED_ANIM_PREFIX}${hash}_${effectId}fill`
  const tier = { period, luminance: false, oneWay: false, curve, timing: curve ? 'ease-in-out' : 'linear' }
  // A sampled `linear()` cannot go in the shorthand — an engine that rejects it
  // would invalidate the whole declaration and freeze the fill — so it is stated
  // separately and the shorthand keeps a function that always parses. Same split,
  // and the same builder, animDecls uses.
  const timingDecl = curve ? `animation-timing-function:${tierTimings([tier], FILL_STEPS_PER_SECOND).join(', ')};` : ''
  const keyframes = `@keyframes ${animName}{to{transform:${x ? 'translateX' : 'translateY'}(${pct(shift)});}}`

  const beforeRule = `${nameBox}.${MASKED_CLASS}>span>i{position:absolute;top:0;left:0;`
    + `width:${x ? pct(extent) : '100%'};height:${x ? '100%' : pct(extent)};`
    + `background-image:${images[m]};`
    + `background-size:${x ? `${pct(size)} 100%` : `100% ${pct(size)}`};`
    + `background-repeat:${x ? 'repeat-x' : 'repeat-y'};`
    + `animation:${animName} ${period}s ${tier.timing} infinite;`
    + timingDecl
    + `animation-delay:${syncDelayCalc(period)};}`

  // THE LAYERS THAT DO NOT MOVE STAY ON THE SPAN. gold's diagonal sheen and
  // glint's base are painted once and never again, so they cost nothing where
  // they are — and moving them would need a second box each. The span keeps
  // `background-clip:text` for them, which clips to the same glyph the mask
  // does, so the two agree.
  //
  // No `mask-image` here: the letterform differs per glyph and arrives from the
  // per-character rule glyph-mask.js publishes. Deliberately not through a
  // custom property — substituting a multi-KB url() on every span on every style
  // recalc made each recalc 4-5x more expensive.
  const statics = images.map((img, i) => i === m ? null : i).filter(i => i !== null)
  const staticDecl = statics.length
    ? `background:${statics.map(i => images[i]).join(', ')};`
      + `background-size:${statics.map(i => sizes[i]).join(', ')};`
      + `background-position:${statics.map(i => p0[i]).join(', ')};`
      + `-webkit-background-clip:text;background-clip:text;`
    : 'background:none;'
  const spanDecl = `position:relative;${staticDecl}color:transparent;`
    + `-webkit-mask-size:100% 100%;mask-size:100% 100%;`
    + `-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;`

  return { spanDecl, beforeRule, keyframes, tier }
}

/**
 * The six per-letter motions, each as one declaration written against a phase.
 *
 * `decl(p)` takes `p` as a STRING and drops it into the formula, so the exact
 * same expression serves both ways of driving it: a `var()` reference, or a
 * literal number that CSS folds at parse time. That duality is what lets
 * buildLetterMotionCss sample a shape into keyframes without any effect being
 * transcribed by hand — the same trick `ease()` plays for the paint fills.
 *
 * `step` is the per-glyph stagger in seconds (negated by `back` for a wave that
 * travels the other way); `corners` are the phases where the formula changes
 * slope. A piecewise-linear shape sampled AT its corners is reproduced exactly
 * by linear interpolation between them, so they are listed next to the literals
 * they come from. `smooth` means there are no corners to hit and the curve is
 * sampled on an even grid instead.
 */
const LETTER_MOTIONS = {
  // Smooth up-down hump — a cosine reproduces the old ease-in-out 0/-4px/0
  // keyframe shape without needing a separate easing curve.
  wave: {
    step: 0.09, smooth: true,
    decl: p => `transform:translateY(calc(-4px * (1 - cos(${p} * 360deg)) / 2));`,
  },
  // Linear all the way round, so two stops reproduce it exactly.
  ripple: {
    step: 0.18, back: true, corners: [],
    decl: p => `filter:hue-rotate(calc(${p} * 360deg));`,
  },
  // A hop, not a wave: a single sharp triangular pulse (peak ~15% into the
  // cycle) beats a sinusoid at reproducing "up fast, land, rest". The pulse
  // turns at p*6.5-1 = ±1.
  hop: {
    step: 0.07, corners: [1 / 6.5, 2 / 6.5],
    decl: p => {
      const pulse = `clamp(0, 1 - abs(${p} * 6.5 - 1), 1)`
      return `transform-origin:50% 100%;`
        + `transform:translateY(calc(-5px * ${pulse})) scaleY(calc(1 + 0.06 * ${pulse}));`
    },
  },
  // Held flat for the first 64% of the cycle, one clean spin in the rest.
  twirl: {
    step: 0.08, corners: [0.64],
    decl: p => `transform:rotate(calc(360deg * clamp(0, (${p} - 0.64) / 0.36, 1)));`,
  },
  // Each glyph blinks out for a moment, in order — a cursor passing through the
  // name and retyping it. A 1%-wide window, which is exactly why it is sampled
  // at its own corners and not on a grid that would step straight over it.
  type: {
    step: 0.12, corners: [0.03, 0.04],
    decl: p => `opacity:calc(clamp(0, (${p} - 0.03) * 100, 1));`,
  },
  // Rest, then two 180deg flips back to back — two ramps summed reproduce the
  // old three-keyframe rotateX curve.
  tumble: {
    step: 0.12, corners: [0.60, 0.75, 0.90],
    decl: p => {
      const ramp1 = `clamp(0, (${p} - 0.60) / 0.15, 1)`
      const ramp2 = `clamp(0, (${p} - 0.75) / 0.15, 1)`
      return `transform-style:preserve-3d;transform:rotateX(calc(180deg * (${ramp1} + ${ramp2})));`
    },
    extraRule: selector => `${selector}{perspective:300px;}`,
  },
}

/** Stops for a smooth curve. 16 intervals holds a cosine to under a tenth of a
 *  pixel at this amplitude, which is well below one device pixel. */
const LETTER_SMOOTH_STOPS = 16

/** Build the pieces for a per-letter motion effect (wave/ripple/tumble/hop/
 * twirl/type) — { spanPart, extraRule }.
 *
 * ── WHY EACH GLYPH OWNS ITS ANIMATION AGAIN ────────────────────────────────
 *
 * This shape has now been all three ways, and the third is the one with a
 * number behind it in both columns.
 *
 * It began as `animation:` on `${selector} span`, which makes the browser
 * create one live Animation PER GLYPH — an `Animation` instance per matching
 * element is intrinsic to CSS Animations, sharing @keyframes does not share the
 * instance. Prod measured names carrying ~19 live animations each against the
 * module doc's "at most 3 layers", so d75a0d872 moved to ONE Animation on the
 * parent driving a registered `@property` phase that every span read back
 * through `calc()`/`var(--i)`.
 *
 * That traded the animation count for a worse cost, and it took a device trace
 * to see it: an animated custom property that INHERITS invalidates style for
 * the whole subtree on every frame, and the letters then recompute a calc() and
 * re-raster, because a letter-split name carries the clip-text gradient on the
 * SPANS (Chrome cannot paint a parent's background-clip:text into transformed
 * descendants — see `paintTarget`). So every glyph was its own clip-text layer
 * being restyled and repainted 60 times a second. On the phone that was the
 * single largest line in an 8s trace of real chat: UpdateLayoutTree 2059ms.
 *
 * Both arms benched at 20 names, 414x896 @ dpr3, cpu 4x, per 3s, with the fill
 * on the spans exactly as the compiler puts it (`--phasevar`):
 *
 *                       style      paint            raster   anims
 *   shared @property    128.3ms    3844 / 206.8ms    24.7ms      20
 *   per-glyph keyframes   0.0ms       0 /   0.0ms     0.0ms     160
 *
 * Zero, not "less": a transform/opacity/filter animation with literal keyframes
 * runs on the compositor and never touches the main thread. The animation count
 * is the thing that got worse, and it is the thing that does not cost anything
 * — which is precisely what COMPOSITED_ANIM_PREFIX already exists to record, so
 * these keyframes carry it and neither the layer cap nor the runtime animation
 * budget counts them. See its comment in scene-spec.js.
 *
 * The stagger stops being arithmetic and becomes what it always was: a time
 * offset. `mod(phase + i*s, 1)` where phase is linear in time is the SAME
 * motion shifted by `i*s` of a cycle, so it is expressed as a negative
 * `animation-delay` alongside the wall-clock phase lock, and the two add.
 *
 * ── AND THE EDGE-ON BUG CANNOT COME BACK ───────────────────────────────────
 *
 * The crowd dial used to rate-limit these with `steps()`, because they
 * repainted. tumble turns each letter about X, so twice a flip it passes
 * through 90deg where it has no width and paints nothing; at full rate that is
 * one frame and reads as the flip, but a step can LAND there and hold it, and
 * the letter is simply missing. Measured on "mellen", longest stretch one glyph
 * spent invisible: unstepped 0ms, steps(14) 243ms, steps(7) 971ms — against
 * 17ms for a frame. Reported as "the ll in my name disappears on name flip
 * animation". Nothing here repaints any more, so there is nothing to rate-limit
 * and no step count to get wrong.
 */
function buildLetterMotionCss(effectId, speed, selector, hash) {
  const shape = LETTER_MOTIONS[effectId]
  if (!shape) return null
  const duration = effectDuration(effectId, speed)
  // Prefixed as composited on purpose: what these animate (transform, opacity,
  // filter) the compositor owns outright, so one per glyph is not a cost. The
  // prefix is the ONLY thing that tells the two budgets so.
  const animName = `${COMPOSITED_ANIM_PREFIX}${hash}_${effectId}`

  // Sample the shape's own formula at fixed phases. The corners are where it
  // changes slope, so between them it is a straight line and the browser's
  // interpolation is exact; a genuinely smooth curve gets an even grid instead.
  const stops = shape.smooth
    ? Array.from({ length: LETTER_SMOOTH_STOPS + 1 }, (_, i) => i / LETTER_SMOOTH_STOPS)
    : [0, ...shape.corners, 1]
  // Nine decimals, not six: a corner is where a clamp() turns, and a phase
  // rounded SHORT of it leaves the clamp un-bitten — hop's rest phase came out
  // as 2e-6 of a pixel of travel rather than a flat zero.
  const samples = stops.map(q => shape.decl(String(Math.round(q * 1e9) / 1e9)))
  // Only what actually moves belongs in the keyframes — transform-origin and
  // transform-style are constant, and a property named in a keyframe is an
  // animated property.
  const parts = partitionDecls(samples)
  // The stop's POSITION needs the same precision as its value: a corner
  // rounded to four decimals of a percent sits a hair off where the formula
  // turns, and every sample after it interpolates from the wrong place.
  const body = stops
    .map((q, i) => `${Math.round(q * 1e9) / 1e7}%{${parts.at(i)}}`)
    .join('')

  // Glyph i runs AHEAD by i*step seconds, which is a delay that much more
  // negative. `back` walks the wave the other way. The fallback keeps the whole
  // declaration valid — and with it the phase lock — on a span that somehow has
  // no --i, rather than dropping the list at computed-value time.
  const per = Math.round((shape.back ? 1 : -1) * shape.step / safeSpeed(speed) * 1e6) / 1e6

  return {
    extraRule: shape.extraRule?.(selector),
    spanPart: {
      decls: parts.statics,
      animShorthand: `${animName} ${duration}s linear infinite`,
      delayExpr: `calc(${syncDelayCalc(duration)} + var(--i, 0) * ${per}s)`,
      // noStep because nothing repaints: see the doc comment above.
      tier: { period: duration, luminance: !!EFFECTS[effectId]?.luminance, noStep: true },
      keyframes: `@keyframes ${animName}{${body}}`,
    },
  }
}

/** Build the pieces for a whole-name `motion`-slot effect: { decls,
 * animShorthand, delayExpr, keyframes }. Applies on top of whatever the
 * base/paint layer already painted — never touches color/background.
 *
 * These used to emit a standalone `${selector}{animation:…}` rule each. Two
 * rules setting the `animation` shorthand on one selector do not compose —
 * the later wins outright — so a paint effect plus ANY of these (gold foil
 * + heartbeat, the most ordinary combination in the catalog) silently froze
 * the paint, and coin + neon ran only neon. compilePaintCss now merges every
 * self-level animation into one comma-listed rule, the same way the split
 * path always did for spans. wave/ripple/tumble/hop/twirl/type (per-letter)
 * are handled by buildLetterMotionCss instead. */
function buildMotionEffectCss(effectId, speed, hash, glow) {
  const duration = effectDuration(effectId, speed)
  const animName = `hsp_${hash}_${effectId}`
  const sync = syncDelayCalc(duration)
  // noStep: these are the MULTI-STOP whole-name motions. `steps()` applies per
  // keyframe INTERVAL, so quantising one of these multiplies its redraws
  // instead of capping them (jitter alone has eight stops at 2% intervals), and
  // three of them already use `steps(1,end)` deliberately to hold a resting
  // frame. The crowd dial must leave every one of them exactly as authored.
  const part = (timing, kf, decls = '') => ({ decls, animShorthand: `${animName} ${duration}s ${timing} infinite`, delayExpr: sync, keyframes: kf, tier: { period: duration, timing, noStep: true } })

  switch (effectId) {
    case 'coin':
      return part('cubic-bezier(.6,0,.4,1)',
        `@keyframes ${animName}{0%,55%{transform:rotateY(0);}75%{transform:rotateY(180deg);}95%,100%{transform:rotateY(360deg);}}`,
        'transform-style:preserve-3d;')
    case 'heli': {
      // A spin that RESTS, not a name that never stops turning.
      //
      // This used to be `to{rotate(360deg)}` on a linear loop: no rest frame at
      // any point in the cycle, so the name was mid-rotation ~always and
      // essentially unreadable at 13px. Every other motion effect either stays
      // within a few pixels/degrees or holds an identity frame for most of its
      // cycle (coin rests 55%, tumble 60%) — heli was the one exception, and
      // the honest evidence for that is that it had to be excluded from the
      // shuffle pool for being unrollable. Fixing it beat documenting it: the
      // rule is now universal, so the exception list is gone.
      return part('cubic-bezier(.5,0,.5,1)',
        `@keyframes ${animName}{0%,72%{transform:rotate(0);}100%{transform:rotate(360deg);}}`)
    }
    case 'float':
      return part('ease-in-out',
        `@keyframes ${animName}{0%,100%{transform:translateY(1.5px) rotate(-1.6deg);}50%{transform:translateY(-2.5px) rotate(1.6deg);}}`)
    case 'heart':
      return part('ease-out',
        `@keyframes ${animName}{0%,28%,100%{transform:scale(1);}10%{transform:scale(1.11);}20%{transform:scale(1.04);}}`)
    case 'wobble':
      return part('ease-in-out',
        `@keyframes ${animName}{0%,100%{transform:scaleX(1);}50%{transform:scaleX(1.09);}}`)
    case 'swing':
      return part('ease-in-out',
        `@keyframes ${animName}{0%,100%{transform:rotate(4.5deg);}50%{transform:rotate(-4.5deg);}}`,
        'transform-origin:50% -60%;')
    case 'jitter':
      // Still for four fifths of the cycle, then a burst of one-pixel shoves.
      return part('steps(1,end)',
        `@keyframes ${animName}{0%,80%,100%{transform:translate(0,0);}82%{transform:translate(-1px,1px);}84%{transform:translate(1px,-1px);}86%{transform:translate(-1px,-1px);}88%{transform:translate(1px,1px);}90%{transform:translate(-1px,0);}92%{transform:translate(1px,0);}}`)
    case 'glitch': {
      // Chromatic split — cyan and magenta ghosts thrown to either side for a
      // few frames, then clean. The resting frame is the user's own glow (or
      // none), so a glitch never switches a glow off for the rest of its cycle.
      const rest = glowShadowValue(glow) || 'none'
      return part('steps(1,end)',
        `@keyframes ${animName}{0%,86%,100%{text-shadow:${rest};}88%{text-shadow:-2px 0 #00ffff,2px 0 #ff00ff;}90%{text-shadow:2px 0 #00ffff,-2px 0 #ff00ff;}93%{text-shadow:-1px 0 #00ffff,1px 0 #ff00ff;}95%{text-shadow:${rest};}}`)
    }
    case 'flicker':
      // A tube with a loose contact: two dips inside half a second, then
      // steady. Two flashes per cycle at any speed — well under the 3/s line.
      return part('steps(1,end)',
        `@keyframes ${animName}{0%,70%,100%{opacity:1;}72%{opacity:.4;}74%{opacity:1;}84%{opacity:.55;}86%{opacity:1;}}`)
    case 'neon': {
      const color = glow && HEX_RE.test(glow.color) ? safeHex(glow.color) : '#ff40af'
      const scale = glow && glow.strength === 2 ? 1.6 : 1
      const r1 = Math.round(4 * scale), r2 = Math.round(11 * scale)
      const r1b = Math.round(6 * scale), r2b = Math.round(22 * scale), r3b = Math.round(40 * scale)
      return part('ease-in-out',
        `@keyframes ${animName}{0%,100%{text-shadow:0 0 ${r1}px ${color}80, 0 0 ${r2}px ${color}40;}50%{text-shadow:0 0 ${r1b}px ${color}cc, 0 0 ${r2b}px ${color}88, 0 0 ${r3b}px ${color}44;}}`)
    }
    default:
      return null
  }
}

/** The static glow's text-shadow value, or '' — shared by the glow rule and
 * by glitch, whose resting frame must be the glow rather than nothing. */
function glowShadowValue(glow) {
  if (!glow || !HEX_RE.test(glow.color)) return ''
  const color = safeHex(glow.color)
  const [r1, r2] = glow.strength === 2 ? [10, 26] : [6, 14]
  return `0 0 ${r1}px ${color}cc, 0 0 ${r2}px ${color}66`
}

function buildGlowCss(glow, selector) {
  const value = glowShadowValue(glow)
  return value ? `${selector}{text-shadow:${value};}` : ''
}

/**
 * Compile a validated paint spec to a CSS string scoped under `selector`
 * (e.g. `.hsp-<hash>`). Assumes `spec` already passed validatePaintSpec —
 * every value is still re-clamped/re-matched here for defense in depth, so
 * even a spec that reached this function unvalidated cannot inject anything:
 * unknown effect ids are silently skipped, non-hex colors fall back to a
 * neutral gray, out-of-range numbers are clamped.
 * @param {object} spec
 * @param {string} selector
 * @param {object} [opts]
 * @param {string} [opts.hash] - precomputed hashPaintSpec(spec), to avoid
 *   recomputing it when the caller already has it.
 * @param {boolean} [opts.static] - drop every effect layer (paint + motion),
 *   keeping only the resting base gradient + glow. Zero @keyframes/animation
 *   in the output — the viewer's "static" name-paint mode. Letter-split
 *   markup (if the raw spec calls for it) is left to the caller; it renders
 *   inert without the motion keyframes that would normally animate it.
 * @returns {string} css
 */
export function compilePaintCss(spec, selector, opts = {}) {
  if (!isPlainObject(spec) || typeof selector !== 'string' || !selector) return ''
  const hash = opts.hash || hashPaintSpec(spec)
  const base = isPlainObject(spec.base) ? spec.base : { type: 'solid', angle: 0, stops: [{ color: '#e4e4e4', pos: 0 }] }
  const stops = sortedStops(base)
  const effects = opts.static
    ? []
    : (Array.isArray(spec.effects) ? spec.effects.filter(e => isPlainObject(e) && EFFECT_IDS.has(e.id)) : [])

  // ── the layer cap ────────────────────────────────────────────────────────
  //
  // MAX_ANIMATED_LAYERS is spent here, in priority order, and what does not fit
  // is shed. This is the module's own layering model finally being enforced:
  // the header has promised "at most 3 layers" since v1, and the v2 scene block
  // quietly broke it by adding 1-3 animations outside MAX_EFFECTS' reach, which
  // is how a name reached SIX live animations.
  //
  // Enforced at COMPILE time, not at save time. validatePaintSpec counts
  // `effects` — already capped at 3 — and cannot see scene planes at all; and a
  // save-time rule would leave every paint stored before today rendering six
  // animations forever, which is the opposite of the point.
  //
  // ORDER: the name's own fill, then its motion, then the backdrop, then the
  // weather. Every slot spent on the name itself; the scene gets what's left,
  // and what doesn't fit is held STILL rather than deleted.
  //
  // The first version of this cap ran the opposite order — scene before the
  // name's motion — and it was measured wrong by a factor of six.
  // `scripts/paint-perf.mjs --cost` ablates one painted name and attributes the
  // renderer time; for the shape actually reported slow (conic fill + strength-2
  // glow + terminal plate + glyphs weather + letter wave, ONE of them on screen,
  // 3s at 4x CPU):
  //
  //   full 669ms · -weather 377 · -scene 289 · -backdrop 565 · -glow 660 ·
  //   linear base 667 · -fill effect 622 · static 0
  //
  // So the weather plane alone is ~292ms — 44% of the whole cost — the backdrop
  // ~104ms, the fill effect ~47ms, and the glow and the conic gradient are free
  // (they are painted once, not per frame). Paint is 507 of the 669: this is a
  // PAINT cost, which is exactly the phase real-user INP says dominates on the
  // phone, and the old order shed the letter wave — the cheapest animation in
  // the spec, a transform — to keep the single most expensive plane running.
  //
  // Holding the weather still instead saves that 44% and hands the slot back to
  // the name. A composition at rest is the same picture; a name that stopped
  // moving is a different name.
  const sceneOn = spec.v === 2 && isPlainObject(spec.scene)
  let layerBudget = MAX_ANIMATED_LAYERS

  const paintEffectRaw = effects.find(e => EFFECTS[e.id].slot === 'paint')
  const paintEffect = paintEffectRaw && layerBudget >= 1 ? paintEffectRaw : null
  if (paintEffect) layerBudget -= 1

  const motionEffects = []
  for (const e of effects) {
    if (EFFECTS[e.id].slot !== 'motion') continue
    if (layerBudget < 1) break
    motionEffects.push(e)
    layerBudget -= 1
  }

  // ── THE SCENE IS RATE-LIMITED, NOT SLOT-LIMITED ──────────────────────────
  //
  // Scene planes no longer spend the cap, because they no longer cost what a cap
  // slot prices. scene-spec.js quantises every plane to
  // SCENE_STEPS_PER_SECOND (12) redraws a second instead of the display's 60,
  // and `--cost` measured that at a 75% cut for the same visible drift: both
  // planes animating went 501ms → 124ms per 3s of one name.
  //
  // So the cap now bounds what it was always trying to price — animations
  // running at FULL frame rate, which is the name's own fill and motion. A
  // stepped plane costs about a fifth of one of those, and charging it a whole
  // slot is what forced the choice between a user's letter wave and the weather
  // behind it. Both, now, for less than the frozen version cost before.
  //
  // The still-flags remain for `sceneAnimationCost` callers and for a future
  // overflow rule; nothing currently sets them, and a scene with no animation at
  // all is still expressible through `opts.static`.
  const stillBackdrop = false
  const stillWeather = false

  // Reads the RAW spec on purpose: the markup shape is the caller's contract
  // (paintNameHtml is called separately with the same spec), so a name whose
  // motion effect the cap just shed still splits into spans — it simply renders
  // inert, exactly as it already does in static mode.
  const needsLetterSplit = paintNeedsSpans(spec)

  // Chrome cannot paint a parent's background-clip:text into TRANSFORMED
  // descendant layers — per-letter motion (wave/ripple/tumble) composites
  // each span, which silently blanks any parent-level clip-text gradient
  // (letters render transparent over nothing; only a hover background
  // clipped into the glyphs reveals them). When the name is letter-split,
  // ALL clip-text painting must live on the spans themselves.
  // The name's own box (paintNameHtmlFor emits it unconditionally). Everything
  // that belongs to the NAME compiles against this; the host keeps only layout
  // and the scene planes, which are this box's siblings. A transform applies to
  // an element's whole subtree, so a whole-name motion compiled against the
  // host spun the backdrop and the weather with the glyphs.
  // NAME_BOX_CLASS is deliberately outside the `hsp-` namespace — see its
  // declaration; the sweep selects painted names with `[class*="hsp-"]`.
  const nameBox = `${selector}>.${NAME_BOX_CLASS}`
  const perLetter = paintNeedsPerLetter(spec)
  const paintTarget = perLetter ? `${nameBox}>span` : nameBox
  const baseCss = paintEffect ? null : buildBaseCss(base, stops)

  // display:inline-block on BOTH: the host so the planes have a box to be
  // absolute against, the name box so a motion transform has something with
  // geometry to act on.
  let css = `${selector}{display:inline-block;}${nameBox}{display:inline-block;`
  if (baseCss && (!needsLetterSplit || !baseCss.isClipText)) css += baseCss.decl
  css += '}'

  // Every animation that lands on the ELEMENT ITSELF — the whole-name motions
  // always, and the paint effect when the name is not split — goes into one
  // rule with comma-listed animation/animation-delay. Two rules setting the
  // shorthand on the same selector do not compose (the later wins outright),
  // which is how gold foil + heartbeat used to run only the heartbeat.
  const selfParts = []
  for (const e of motionEffects) {
    if (EFFECTS[e.id].letterSplit) continue
    const m = buildMotionEffectCss(e.id, e.speed, hash, spec.glow)
    if (m) selfParts.push(m)
  }
  /** The animation half of a rule: one comma-list, never one rule per effect.
   *  Two rules setting the `animation` shorthand on the same selector do not
   *  compose — the later wins outright, which is how gold foil + heartbeat used
   *  to run only the heartbeat. Used for both surfaces a paint animates, the
   *  name box and (when a name is split into glyphs) the spans. */
  const animDecls = (parts) => {
    const tiers = parts.map(p => p.tier)
    // The timing list is emitted SEPARATELY from the shorthand, and built by the
    // same function the crowd tiers use, so the two can never disagree about
    // what an animation's function is. It also isolates the failure: a sampled
    // `linear()` an old engine rejects costs this one declaration, and each
    // animation falls back to the function its shorthand still carries, instead
    // of invalidating the shorthand and freezing the paint outright.
    // Only when something on this surface actually needs it: a sampled easing
    // cannot be written into the `animation` shorthand (see below), but every
    // other function already is, and re-stating those would be bytes saying
    // nothing on the majority of paints.
    const timingDecl = tiers.some(t => t.curve)
      ? `animation-timing-function:${tierTimings(tiers, FILL_STEPS_PER_SECOND).join(', ')};` : ''
    return parts.map(p => p.decls).join('')
      + `animation:${parts.map(p => p.animShorthand).join(', ')};`
      + timingDecl
      + `animation-delay:${parts.map(p => p.delayExpr).join(', ')};`
  }

  /** The crowd dial for one surface.
   *
   *  One timing list per tier, in the SAME order as that surface's `animation`
   *  shorthand — animation-timing-function is matched positionally to
   *  animation-name, so a composited entry still takes its slot in the list.
   *
   *  Skipped outright when NOTHING on the surface repaints: the dial lowers a
   *  redraw rate, and a transform over a background rastered once has none, so
   *  the rules would be a copy of `linear` at every tier. */
  const tierRules = (surface, parts) => {
    const tiers = parts.map(p => p.tier)
    if (!tiers.some(t => !t.noStep || t.curve)) return ''
    return crowdTierRules(surface, tiers, FILL_STEPS_PER_SECOND)
  }

  const emitSelfRule = () => {
    if (!selfParts.length) return
    css += `${nameBox}{${animDecls(selfParts)}}`
      // Unconditional on the name box: only a letter motion is composited, and
      // a letter motion never lands here. Routing it through tierRules would
      // silently drop the dial for neon and flicker, which set `noStep` for a
      // different reason — their own multi-stop keyframes.
      + crowdTierRules(nameBox, selfParts.map(p => p.tier), FILL_STEPS_PER_SECOND)
      + selfParts.map(p => p.keyframes).join('')
  }

  if (needsLetterSplit) {
    // The fill on a span is still a plain, unanimated calc() off the parent's
    // phase. The letter MOTIONS are not: each glyph carries its own composited
    // keyframe animation, staggered by a negative delay — see
    // buildLetterMotionCss for the two benches that moved it there and back.
    let spanDecls = ''
    const spanParts = []
    // Tracked apart from the motions so the composited variant below can emit a
    // span rule WITHOUT it — under a mask the fill moves to the pseudo, and a
    // leftover background-position animation on the span would repaint exactly
    // what this exists to stop repainting.
    let fillSpanPart = null

    if (baseCss?.isClipText) spanDecls += baseCss.decl

    if (paintEffect) {
      const p = buildPaintPhaseCss(paintEffect.id, paintEffect.speed, base, stops, hash)
      if (p) {
        // AN ANIMATION HAS TO RUN ON THE ELEMENT THAT CARRIES THE PROPERTY.
        //
        // When a name is split, its fill is on the SPANS — Chrome cannot paint
        // a parent's background-clip:text into transformed descendants. The
        // fill's animation used to be pushed onto the name box regardless,
        // where `background-position` (or mask-position, or opacity, or
        // filter) is not declared at all, so it animated nothing. Fifteen of
        // the sixteen paint-slot effects rendered a DEAD fill next to any
        // letter motion; only conic escaped, because a driver animates an
        // inheriting custom property and genuinely does belong on the ancestor.
        // Latent since the fills came off the driver.
        if (p.drivesPhaseVar) selfParts.push(p.selfPart)
        else { spanParts.push(p.selfPart); fillSpanPart = p.selfPart }
        spanDecls += p.decl
      }
    }
    for (const e of motionEffects) {
      if (!EFFECTS[e.id].letterSplit) continue
      const m = buildLetterMotionCss(e.id, e.speed, nameBox, hash)
      if (m) {
        spanParts.push(m.spanPart)
        if (m.extraRule) css += m.extraRule
      }
    }
    emitSelfRule()

    const spanRule = spanDecls + (spanParts.length ? animDecls(spanParts) : '')

    // `> span` under the name box, never `${selector} span`: the name box is
    // itself a span, and a descendant selector would apply every per-letter
    // declaration to it as well — with `var(--i)` unset, which makes the whole
    // property invalid at computed-value time.
    // Per-letter spans need their own inline-block to be transformable; the
    // wrap shape IS the name box, which the base rule already declared.
    if (perLetter) css += `${paintTarget}{display:inline-block;${spanRule}}`
    else if (spanRule) css += `${paintTarget}{${spanRule}}`

    css += spanParts.map(p => p.keyframes).join('')
      + tierRules(paintTarget, spanParts)

    // ── the composited variant, gated on the runtime's mask ──────────────
    //
    // Emitted ALONGSIDE the rules above, never instead of them: everything here
    // is behind `.hs-masked`, which the runtime only adds once every glyph has
    // a letterform to be masked by. A browser without mask-image, a webfont
    // still loading, or a character the masker refused all fall through to the
    // clip-text path that just compiled.
    if (perLetter && paintEffect) {
      const comp = buildCompositedFill(paintEffect.id, paintEffect.speed, base, stops, hash, nameBox)
      if (comp) {
        const motionParts = spanParts.filter(p => p !== fillSpanPart)
        const maskedSpan = `${nameBox}.${MASKED_CLASS}>span`
        css += `${maskedSpan}{${comp.spanDecl}`
          // The letter motions stay on the span and stay composited; the fill is
          // gone from this list because it now lives on the pseudo. With no
          // motions at all the shorthand still has to be reset, or the span
          // keeps animating the background-position it no longer declares.
          + (motionParts.length ? animDecls(motionParts) : 'animation:none;')
          + '}'
          + comp.beforeRule
          + comp.keyframes
        // NO crowd tier on the pseudo. The dial exists to buy back redraws from
        // an effect that costs one per frame; this one is a composited transform
        // that costs nothing at any rate, so stepping it would trade motion
        // quality for a saving that is not there. The dial still governs the
        // letter motions and the scene planes through the rules above.
      }
    }
  } else {
    if (paintEffect) {
      const p = buildPaintPhaseCss(paintEffect.id, paintEffect.speed, base, stops, hash)
      if (p) selfParts.unshift({ ...p.selfPart, decls: p.decl })
    }
    emitSelfRule()
  }

  // Static glow — skip if neon is active and sourced the same color (neon's
  // own keyframes already carry a shadow on every frame); otherwise layer
  // the constant shadow on so it doesn't require an active effect to show.
  const hasNeon = motionEffects.some(e => e.id === 'neon')
  if (spec.glow && !hasNeon) {
    css += buildGlowCss(spec.glow, selector)
  }

  // ── scene (v2 diorama — backdrop ::before / weather ::after) ──
  // Rides the exact same class/style-tag/--hsp-t pipeline as effects; static
  // mode renders each scene's designed hero frame.
  //
  // Every name over a plate gets a dark rim, and that rim is the whole
  // legibility contract: a fill that clears the 3:1 floor against the chat
  // background clears it against its own edge too, so the plate underneath can
  // be anything and the catalog never has to police which colour may sit on
  // which sky. It used to reach solid fills only — a text-shadow paints in
  // FRONT of a background-clip:text fill and would smother it — which left
  // exactly the showy paints (gradients, pan, chrome, gold) bare on the
  // brightest plates. drop-shadow() is built from rendered alpha, so it traces
  // a clipped glyph and paints behind it.
  //
  // Skipped for glow and neon, which carry their own halo, and for the two
  // effects a filter would break: ripple ANIMATES `filter`, so a static one
  // would be clobbered every frame, and tumble needs `transform-style:
  // preserve-3d`, which a filter flattens.
  if (sceneOn) {
    css += buildSceneCss(spec.scene, selector, hash, { static: !!opts.static, stillWeather, stillBackdrop })
    const clipTextFill = !!paintEffect || base.type !== 'solid'
    const filterHostile = motionEffects.some(e => e.id === 'ripple' || e.id === 'tumble')
    // An ANIMATED clip-text fill under the rim filter is the worst render
    // cell in the matrix: the gradient moves every frame beneath two stacked
    // drop-shadows, so the browser re-filters every visible copy of the name
    // per frame — measurable frame drops on phones. The rim is legibility
    // garnish; the frames are not. Static mode keeps it (nothing animates).
    const animatedFill = !!paintEffect && !opts.static
    if (sceneHasBackdrop(spec.scene) && !spec.glow && !hasNeon) {
      if (!clipTextFill) css += `${selector}{${SCENE_RIM_CSS}}`
      else if (!filterHostile && !animatedFill) css += `${paintTarget}{${SCENE_RIM_FILTER_CSS}}`
    }
  }

  return css
}

export { EFFECTS, EFFECT_IDS }

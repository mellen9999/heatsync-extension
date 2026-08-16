/**
 * Paint spec — structured JSON schema + compiler for animated username paints.
 *
 * SYNCED COPY of the heatsync monorepo's client/utils/paint-spec.js — keep
 * byte-close to the source of truth. Cross-repo auto-apply rule: a change to
 * either copy should be mirrored in the other (see feedback_cross_repo_posts_chats
 * in project memory). Only bundling-related adaptations belong here, never a
 * behavior fork — the ext must compile the exact same CSS the site does for
 * the exact same spec, or a paint would render differently across surfaces.
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
 * Phase 1 ships 20 of those — see EFFECTS below for the exact source line
 * each was ported from.
 *
 * ── layering model ──────────────────────────────────────────────────────
 * Every paint is at most 3 layers:
 *   - `base`   the resting gradient (solid / linear / conic). Always present.
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
 * chrome / gold / fire / matrix / holo are "themed presets" — faithful ports
 * of the lab's fixed palettes (that fixed palette IS the point of picking
 * "gold foil"), so they render their own built-in gradient and `base` is
 * visually superseded (still stored/validated normally so switching the
 * effect off reverts to the user's base).
 */

import {
  fnv1a,
  HEX_RE,
  isIntInRange,
  isNumInRange,
  isPlainObject,
  MAX_SPEED,
  MIN_SPEED,
  periodSeconds,
  safeHex,
  safeSpeed,
  syncDelayCalc,
} from './paint-core.js'
import {
  buildSceneCss,
  normalizeSceneForHash,
  SCENE_RIM_CSS,
  SCENE_RIM_FILTER_CSS,
  sceneHasBackdrop,
  validateSceneSpec,
} from './scene-spec.js'

// ── enums ──────────────────────────────────────────────────────────────────

const BASE_TYPES = new Set(['solid', 'linear', 'conic'])
const GLOW_STRENGTHS = new Set([1, 2])

const MAX_EFFECTS = 3
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

/** WCAG 2.x relative luminance of an #rrggbb string. */
export function relativeLuminance(hex) {
  const n = parseInt(hex.slice(1), 16)
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
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
    .filter((s) => isPlainObject(s) && typeof s.color === 'string' && HEX_RE.test(s.color))
    .map((s) => contrastRatio(s.color, bg))
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
  pan: { slot: 'paint', luminance: false, basePeriod: 5, letterSplit: false, label: 'gradient pan' },
  conic: { slot: 'paint', luminance: false, basePeriod: 6, letterSplit: false, label: 'conic sweep' },
  hue: { slot: 'paint', luminance: true, basePeriod: 8, letterSplit: false, label: 'hue cycle' },
  glint: { slot: 'paint', luminance: false, basePeriod: 3.4, letterSplit: false, label: 'shimmer glint' },
  chrome: { slot: 'paint', luminance: false, basePeriod: 4.5, letterSplit: false, label: 'liquid chrome' },
  gold: { slot: 'paint', luminance: false, basePeriod: 5, letterSplit: false, label: 'gold foil' },
  fire: { slot: 'paint', luminance: false, basePeriod: 1.8, letterSplit: false, label: 'fire' },
  matrix: { slot: 'paint', luminance: false, basePeriod: 3.2, letterSplit: false, label: 'matrix rain' },
  holo: { slot: 'paint', luminance: false, basePeriod: 2.8, letterSplit: false, label: 'hologram' },
  reveal: { slot: 'paint', luminance: false, basePeriod: 3, letterSplit: false, label: 'mask reveal' },

  // ── motion/glow slot — up to 2, distinct sig required ───────────────────
  wave: {
    slot: 'motion',
    luminance: false,
    basePeriod: 1.6,
    letterSplit: true,
    label: 'letter wave',
    sig: 'letter:transform',
  },
  ripple: {
    slot: 'motion',
    luminance: true,
    basePeriod: 2.4,
    letterSplit: true,
    label: 'rainbow ripple',
    sig: 'letter:filter',
  },
  coin: {
    slot: 'motion',
    luminance: false,
    basePeriod: 5,
    letterSplit: false,
    label: 'coin spin',
    sig: 'self:transform',
  },
  heli: {
    slot: 'motion',
    luminance: false,
    basePeriod: 2.2,
    letterSplit: false,
    label: 'helicopter',
    sig: 'self:transform',
  },
  float: {
    slot: 'motion',
    luminance: false,
    basePeriod: 5.5,
    letterSplit: false,
    label: 'zero-g float',
    sig: 'self:transform',
  },
  heart: {
    slot: 'motion',
    luminance: false,
    basePeriod: 1.3,
    letterSplit: false,
    label: 'heartbeat',
    sig: 'self:transform',
  },
  wobble: {
    slot: 'motion',
    luminance: false,
    basePeriod: 2.8,
    letterSplit: false,
    label: 'wobble stretch',
    sig: 'self:transform',
  },
  swing: {
    slot: 'motion',
    luminance: false,
    basePeriod: 2.6,
    letterSplit: false,
    label: 'pendulum',
    sig: 'self:transform',
  },
  tumble: {
    slot: 'motion',
    luminance: false,
    basePeriod: 3.4,
    letterSplit: true,
    label: 'letter tumble',
    sig: 'letter:transform',
  },
  neon: {
    slot: 'motion',
    luminance: true,
    basePeriod: 2.6,
    letterSplit: false,
    label: 'neon breathe',
    sig: 'self:shadow',
  },
}

const EFFECT_IDS = new Set(Object.keys(EFFECTS))
const LETTER_SPLIT_IDS = new Set(
  Object.entries(EFFECTS)
    .filter(([, m]) => m.letterSplit)
    .map(([id]) => id),
)

/** Stable short hash of a spec — same spec (same key order irrelevant,
 * we JSON.stringify a normalized/sorted form) → same hash. */
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
      stops: Array.isArray(spec.base.stops) ? spec.base.stops.map((s) => ({ color: s?.color, pos: s?.pos })) : [],
    },
    effects: Array.isArray(spec?.effects) ? spec.effects.map((e) => ({ id: e?.id, speed: e?.speed })) : [],
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
  const maxEffects =
    Number.isInteger(opts.maxEffects) && opts.maxEffects >= 0 ? Math.min(opts.maxEffects, MAX_EFFECTS) : MAX_EFFECTS

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
      // Legibility floor — scored on the DIMMEST stop, because that is the
      // part of the name that disappears. Only runs once the stops are
      // structurally sound, so a malformed spec reports its real problem
      // instead of also being called unreadable.
      const weakest = paintContrast(stops)
      if (weakest !== null && weakest < PAINT_MIN_CONTRAST) {
        errors.push(
          `base.stops contrast ${weakest.toFixed(1)}:1 is below the ${PAINT_MIN_CONTRAST}:1 legibility floor against chat background — the darkest stop is unreadable at name size`,
        )
      }
    }
  }

  // ── effects ──
  if (!Array.isArray(spec.effects)) {
    errors.push('effects must be an array')
  } else if (spec.effects.length > maxEffects) {
    errors.push(
      maxEffects === 0
        ? 'effects require plus — free paints are static (0 effect layers)'
        : `effects must have at most ${maxEffects} ${maxEffects === 1 ? 'entry' : 'entries'}`,
    )
  } else {
    const seenIds = new Set()
    let paintCount = 0
    const motionSigs = new Set()
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
      if (meta.slot === 'paint') {
        paintCount++
      } else {
        motionCount++
        if (motionSigs.has(meta.sig)) {
          errors.push(
            `effects: "${e.id}" conflicts with another selected effect animating the same property (${meta.sig}) — pick effects with different motion targets`,
          )
        }
        motionSigs.add(meta.sig)
      }
    })

    if (structurallyValid) {
      if (paintCount > 1)
        errors.push(
          'at most 1 paint-slot effect allowed (pan/conic/hue/glint/chrome/gold/fire/matrix/holo/reveal are mutually exclusive)',
        )
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
  return !!spec && Array.isArray(spec.effects) && spec.effects.some((e) => LETTER_SPLIT_IDS.has(e?.id))
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
    const hasPaintEffect = Array.isArray(spec.effects) && spec.effects.some((e) => EFFECTS[e?.id]?.slot === 'paint')
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
  if (paintNeedsPerLetter(spec)) return 'letters'
  if (paintNeedsSpans(spec)) return 'wrap'
  return 'none'
}

/** paintNameHtml with the shape already decided. Unknown modes fall through
 * to plain escaped text — a stale baked mode can never emit raw HTML. */
export function paintNameHtmlFor(rawText, mode) {
  if (mode === 'letters') return splitLettersHtml(rawText)
  if (mode === 'wrap') return `<span>${escapeTextHtml(rawText)}</span>`
  return escapeTextHtml(rawText)
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

function sortedStops(base) {
  const stops = Array.isArray(base?.stops) ? base.stops : []
  return stops
    .filter((s) => isPlainObject(s) && HEX_RE.test(s?.color) && isIntInRange(s.pos, 0, 100))
    .map((s) => ({ color: safeHex(s.color), pos: safePos(s.pos) }))
    .sort((a, b) => a.pos - b.pos)
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
/** Class prefix of a compiled heatsync paint — `hsp-<hash>`, see chat/paint-cosmetics.js. */
export const PAINT_CLASS_PREFIX = 'hsp-'

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
  return `${(Date.now() / 1000).toFixed(3)}s`
}

function gradientStopsCss(stops) {
  return stops.map((s) => `${s.color} ${s.pos}%`).join(', ')
}

/** Build the CSS for the resting `base` paint. Returns { decl, isClipText }. */
function buildBaseCss(base, stops) {
  if (base.type === 'solid') {
    const color = stops[0]?.color || '#e4e4e4'
    return { decl: `color:${color};`, isClipText: false, cssImage: `linear-gradient(${color}, ${color})` }
  }
  const angle = safeAngle(base.angle)
  const image =
    base.type === 'linear'
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
    gradient:
      'linear-gradient(100deg, #6b7280, #e5e7eb 20%, #5a6678 38%, #f3f4f6 52%, #556173 70%, #d1d5db 88%, #6b7280)',
    size: '220% 100%',
    timing: 'ease-in-out',
    direction: 'alternate',
    keyframes: (name) => `@keyframes ${name}{to{background-position:120% 0;}}`,
  },
  gold: {
    gradient:
      'repeating-linear-gradient(115deg, transparent 0 3px, #ffffff2e 3px 4px), ' +
      'linear-gradient(90deg, #7a5900, #ffd700 30%, #fff3b0 50%, #ffd700 70%, #7a5900)',
    size: '100% 100%, 200% 100%',
    timing: 'ease-in-out',
    direction: 'alternate',
    keyframes: (name) => `@keyframes ${name}{to{background-position:0 0, 100% 0;}}`,
  },
  fire: {
    gradient: 'linear-gradient(0deg, #c00000, #d70000 35%, #ff8700 65%, #ffd700 90%)',
    size: '100% 300%',
    timing: 'ease-in-out',
    direction: 'alternate',
    keyframes: (name) =>
      `@keyframes ${name}{from{background-position:0 100%;transform:skewX(0);}to{background-position:0 40%;transform:skewX(-1.5deg);}}`,
  },
  matrix: {
    gradient: 'repeating-linear-gradient(0deg, #00ff87 0 5px, #00d700 5px 8px, #1a7a38 8px 10px)',
    size: '100% 340%',
    timing: 'linear',
    direction: 'normal',
    keyframes: (name) => `@keyframes ${name}{to{background-position:0 340%;}}`,
  },
  holo: {
    gradient: 'repeating-linear-gradient(0deg, #00e5ff 0 2px, #007a88 2px 4px)',
    size: '100% 200%',
    timing: 'linear',
    direction: 'normal',
    keyframes: (name) => `@keyframes ${name}{to{background-position:0 200%;}}`,
  },
}

/** Build the pieces for a `paint`-slot effect: { decls, animShorthand, keyframes }.
 * `decls` never includes `animation` itself — the caller (compilePaintCss)
 * always appends that, either alone (non-split: one paint effect, one rule)
 * or combined with per-letter motion animations into a single comma-list
 * (letter-split: paint + motion share `${selector} span`, and two separate
 * `animation:` shorthand rules on the same selector would silently clobber
 * each other — see compilePaintCss). Returns null for an unknown effect id. */
function buildPaintEffectCss(effectId, speed, base, stops, hash) {
  const duration = effectDuration(effectId, speed)
  const animName = `hsp_${hash}_${effectId}`

  if (THEMED_PAINT[effectId]) {
    const t = THEMED_PAINT[effectId]
    const decls = `background:${t.gradient};background-size:${t.size};-webkit-background-clip:text;background-clip:text;color:transparent;`
    const sync = syncDelayCalc(t.direction === 'alternate' ? duration * 2 : duration)
    return {
      decls,
      animShorthand: `${animName} ${duration}s ${t.timing} infinite ${t.direction}`,
      sync,
      keyframes: t.keyframes(animName),
    }
  }

  if (effectId === 'pan') {
    // Force linear rendering — pan is a directional positional sweep, and
    // needs the gradient axis a linear-gradient provides. Append the first
    // stop again so the pan wraps without a visible seam.
    const angle = safeAngle(base.angle)
    const wrapStops = stops.length ? [...stops, { color: stops[0].color, pos: 100 }] : stops
    const image = `linear-gradient(${angle}deg, ${gradientStopsCss(wrapStops)})`
    const decls = `background:${image};background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;`
    const kf = `@keyframes ${animName}{to{background-position:300% 0;}}`
    return {
      decls,
      animShorthand: `${animName} ${duration}s linear infinite`,
      sync: syncDelayCalc(duration),
      keyframes: kf,
    }
  }

  if (effectId === 'conic') {
    // Force conic rendering — rotates the whole wheel via a namespaced
    // @property angle custom prop so two users' paints never collide.
    const angleVar = `--hsp-${hash}-ang`
    const angle = safeAngle(base.angle)
    const wrapStops = stops.length ? [...stops, { color: stops[0].color, pos: 100 }] : stops
    const image = `conic-gradient(from calc(${angle}deg + var(${angleVar})), ${gradientStopsCss(wrapStops)})`
    const decls = `background:${image};-webkit-background-clip:text;background-clip:text;color:transparent;`
    const kf =
      `@property ${angleVar}{syntax:"<angle>";initial-value:0deg;inherits:false;}` +
      `@keyframes ${animName}{to{${angleVar}:360deg;}}`
    return {
      decls,
      animShorthand: `${animName} ${duration}s linear infinite`,
      sync: syncDelayCalc(duration),
      keyframes: kf,
    }
  }

  if (effectId === 'hue') {
    // Orthogonal to gradient type — filter applies post-render regardless
    // of how base painted the text.
    const baseCss = buildBaseCss(base, stops)
    const kf = `@keyframes ${animName}{to{filter:hue-rotate(360deg);}}`
    return {
      decls: baseCss.decl,
      animShorthand: `${animName} ${duration}s linear infinite`,
      sync: syncDelayCalc(duration),
      keyframes: kf,
    }
  }

  if (effectId === 'glint') {
    const baseCss = buildBaseCss(base, stops)
    const image = `linear-gradient(115deg, transparent 38%, #ffffffcc 50%, transparent 62%) no-repeat, ${baseCss.cssImage}`
    const decls = `background:${image};background-size:250% 100%, 100% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;`
    const kf = `@keyframes ${animName}{0%{background-position:210% 0, 0 0;}100%{background-position:-110% 0, 0 0;}}`
    return {
      decls,
      animShorthand: `${animName} ${duration}s ease-in-out infinite`,
      sync: syncDelayCalc(duration),
      keyframes: kf,
    }
  }

  if (effectId === 'reveal') {
    const baseCss = buildBaseCss(base, stops)
    const mask = 'linear-gradient(90deg, #000 30%, #0003 50%, #000 70%)'
    const decls = `${baseCss.decl}-webkit-mask-image:${mask};mask-image:${mask};-webkit-mask-size:300% 100%;mask-size:300% 100%;`
    const kf = `@keyframes ${animName}{from{-webkit-mask-position:130% 0;mask-position:130% 0;}to{-webkit-mask-position:-130% 0;mask-position:-130% 0;}}`
    return {
      decls,
      animShorthand: `${animName} ${duration}s linear infinite`,
      sync: syncDelayCalc(duration),
      keyframes: kf,
    }
  }

  return null
}

/** Build the pieces for a per-letter motion effect (wave/ripple/tumble):
 * { decls, animShorthand, delayExpr, keyframes, extraRule }. These always
 * target `${selector} span` (one glyph per span), same as any active paint
 * effect on a letter-split name — so compilePaintCss combines them into one
 * `animation:`/`animation-delay:` comma-list rather than emitting separate
 * rules (which would clobber each other; see compilePaintCss). `extraRule`
 * is an optional standalone rule on the parent selector (tumble's
 * `perspective`), unrelated to the animation merge. */
function buildLetterMotionCss(effectId, speed, selector, hash) {
  const duration = effectDuration(effectId, speed)
  const animName = `hsp_${hash}_${effectId}`

  switch (effectId) {
    case 'wave': {
      const kf = `@keyframes ${animName}{0%,100%{transform:translateY(0);}50%{transform:translateY(-4px);}}`
      return {
        decls: '',
        animShorthand: `${animName} ${duration}s ease-in-out infinite`,
        delayExpr: `calc(var(--i) * ${(0.09 / safeSpeed(speed)).toFixed(4)}s - mod(var(--hsp-t, 0s), ${duration}s))`,
        keyframes: kf,
      }
    }
    case 'ripple': {
      const kf = `@keyframes ${animName}{to{filter:hue-rotate(360deg);}}`
      return {
        decls: '',
        animShorthand: `${animName} ${duration}s linear infinite`,
        delayExpr: `calc(var(--i) * -${(0.18 / safeSpeed(speed)).toFixed(4)}s - mod(var(--hsp-t, 0s), ${duration}s))`,
        keyframes: kf,
      }
    }
    case 'tumble': {
      const kf = `@keyframes ${animName}{0%,60%,100%{transform:rotateX(0);}75%{transform:rotateX(180deg);}90%{transform:rotateX(360deg);}}`
      return {
        decls: 'transform-style:preserve-3d;',
        animShorthand: `${animName} ${duration}s cubic-bezier(.5,0,.5,1) infinite`,
        delayExpr: `calc(var(--i) * ${(0.12 / safeSpeed(speed)).toFixed(4)}s - mod(var(--hsp-t, 0s), ${duration}s))`,
        keyframes: kf,
        extraRule: `${selector}{perspective:300px;}`,
      }
    }
    default:
      return null
  }
}

/** Build the CSS for a `motion`-slot effect. Applies on top of whatever the
 * base/paint layer already painted — never touches color/background. Only
 * the whole-name motions (coin/heli/float/heart/wobble/swing/neon) — they
 * always target the parent selector and never share it with a paint effect,
 * so they keep emitting a standalone rule. wave/ripple/tumble (per-letter)
 * are handled by buildLetterMotionCss instead. */
function buildMotionEffectCss(effectId, speed, selector, hash, glow) {
  const duration = effectDuration(effectId, speed)
  const animName = `hsp_${hash}_${effectId}`

  switch (effectId) {
    case 'coin': {
      const rule = `${selector}{animation:${animName} ${duration}s cubic-bezier(.6,0,.4,1) infinite;animation-delay:${syncDelayCalc(duration)};transform-style:preserve-3d;}`
      const kf = `@keyframes ${animName}{0%,55%{transform:rotateY(0);}75%{transform:rotateY(180deg);}95%,100%{transform:rotateY(360deg);}}`
      return rule + kf
    }
    case 'heli': {
      const rule = `${selector}{animation:${animName} ${duration}s linear infinite;animation-delay:${syncDelayCalc(duration)};}`
      const kf = `@keyframes ${animName}{to{transform:rotate(360deg);}}`
      return rule + kf
    }
    case 'float': {
      const rule = `${selector}{animation:${animName} ${duration}s ease-in-out infinite;animation-delay:${syncDelayCalc(duration)};}`
      const kf = `@keyframes ${animName}{0%,100%{transform:translateY(1.5px) rotate(-1.6deg);}50%{transform:translateY(-2.5px) rotate(1.6deg);}}`
      return rule + kf
    }
    case 'heart': {
      const rule = `${selector}{animation:${animName} ${duration}s ease-out infinite;animation-delay:${syncDelayCalc(duration)};}`
      const kf = `@keyframes ${animName}{0%,28%,100%{transform:scale(1);}10%{transform:scale(1.11);}20%{transform:scale(1.04);}}`
      return rule + kf
    }
    case 'wobble': {
      const rule = `${selector}{animation:${animName} ${duration}s ease-in-out infinite;animation-delay:${syncDelayCalc(duration)};}`
      const kf = `@keyframes ${animName}{0%,100%{transform:scaleX(1);}50%{transform:scaleX(1.09);}}`
      return rule + kf
    }
    case 'swing': {
      const rule = `${selector}{transform-origin:50% -60%;animation:${animName} ${duration}s ease-in-out infinite;animation-delay:${syncDelayCalc(duration)};}`
      const kf = `@keyframes ${animName}{0%,100%{transform:rotate(4.5deg);}50%{transform:rotate(-4.5deg);}}`
      return rule + kf
    }
    case 'neon': {
      const color = glow && HEX_RE.test(glow.color) ? safeHex(glow.color) : '#ff40af'
      const scale = glow && glow.strength === 2 ? 1.6 : 1
      const r1 = Math.round(4 * scale),
        r2 = Math.round(11 * scale)
      const r1b = Math.round(6 * scale),
        r2b = Math.round(22 * scale),
        r3b = Math.round(40 * scale)
      const rule = `${selector}{animation:${animName} ${duration}s ease-in-out infinite;animation-delay:${syncDelayCalc(duration)};}`
      const kf = `@keyframes ${animName}{0%,100%{text-shadow:0 0 ${r1}px ${color}80, 0 0 ${r2}px ${color}40;}50%{text-shadow:0 0 ${r1b}px ${color}cc, 0 0 ${r2b}px ${color}88, 0 0 ${r3b}px ${color}44;}}`
      return rule + kf
    }
    default:
      return ''
  }
}

function buildGlowCss(glow, selector) {
  if (!glow || !HEX_RE.test(glow.color)) return ''
  const color = safeHex(glow.color)
  const [r1, r2] = glow.strength === 2 ? [10, 26] : [6, 14]
  return `${selector}{text-shadow:0 0 ${r1}px ${color}cc, 0 0 ${r2}px ${color}66;}`
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
    : Array.isArray(spec.effects)
      ? spec.effects.filter((e) => isPlainObject(e) && EFFECT_IDS.has(e.id))
      : []
  const paintEffect = effects.find((e) => EFFECTS[e.id].slot === 'paint')
  const motionEffects = effects.filter((e) => EFFECTS[e.id].slot === 'motion')
  const needsLetterSplit = paintNeedsSpans(spec)

  // Chrome cannot paint a parent's background-clip:text into TRANSFORMED
  // descendant layers — per-letter motion (wave/ripple/tumble) composites
  // each span, which silently blanks any parent-level clip-text gradient
  // (letters render transparent over nothing; only a hover background
  // clipped into the glyphs reveals them). When the name is letter-split,
  // ALL clip-text painting must live on the spans themselves.
  const paintTarget = needsLetterSplit ? `${selector} span` : selector
  const baseCss = paintEffect ? null : buildBaseCss(base, stops)

  let css = `${selector}{display:inline-block;`
  if (baseCss && (!needsLetterSplit || !baseCss.isClipText)) css += baseCss.decl
  css += '}'

  if (needsLetterSplit) {
    // Every animation that lands on `${selector} span` (the paint effect,
    // when the name is split, plus any per-letter motion effects) must be
    // ONE rule with comma-listed `animation`/`animation-delay` — two
    // separate rules setting the `animation` shorthand on the same selector
    // don't compose, the later rule wins outright and blanks the earlier
    // one's animation-name entirely (see module-level comment + the
    // buildPaintEffectCss/buildLetterMotionCss doc comments).
    let spanDecls = ''
    const animList = []
    const delayList = []

    if (baseCss?.isClipText) spanDecls += baseCss.decl

    if (paintEffect) {
      const p = buildPaintEffectCss(paintEffect.id, paintEffect.speed, base, stops, hash)
      if (p) {
        spanDecls += p.decls
        animList.push(p.animShorthand)
        delayList.push(p.sync)
        css += p.keyframes
      }
    }
    for (const e of motionEffects) {
      if (EFFECTS[e.id].letterSplit) {
        const m = buildLetterMotionCss(e.id, e.speed, selector, hash)
        if (m) {
          spanDecls += m.decls
          animList.push(m.animShorthand)
          delayList.push(m.delayExpr)
          css += m.keyframes
          if (m.extraRule) css += m.extraRule
        }
      } else {
        css += buildMotionEffectCss(e.id, e.speed, selector, hash, spec.glow)
      }
    }

    css += `${selector} span{display:inline-block;${spanDecls}`
    if (animList.length) css += `animation:${animList.join(', ')};animation-delay:${delayList.join(', ')};`
    css += '}'
  } else {
    if (paintEffect) {
      const p = buildPaintEffectCss(paintEffect.id, paintEffect.speed, base, stops, hash)
      if (p) css += `${paintTarget}{${p.decls}animation:${p.animShorthand};animation-delay:${p.sync};}${p.keyframes}`
    }
    for (const e of motionEffects) {
      css += buildMotionEffectCss(e.id, e.speed, selector, hash, spec.glow)
    }
  }

  // Static glow — skip if neon is active and sourced the same color (neon's
  // own keyframes already carry a shadow on every frame); otherwise layer
  // the constant shadow on so it doesn't require an active effect to show.
  const hasNeon = motionEffects.some((e) => e.id === 'neon')
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
  if (spec.v === 2 && isPlainObject(spec.scene)) {
    css += buildSceneCss(spec.scene, selector, hash, { static: !!opts.static })
    const clipTextFill = !!paintEffect || base.type !== 'solid'
    const filterHostile = motionEffects.some((e) => e.id === 'ripple' || e.id === 'tumble')
    if (sceneHasBackdrop(spec.scene) && !spec.glow && !hasNeon) {
      if (!clipTextFill) css += `${selector}{${SCENE_RIM_CSS}}`
      else if (!filterHostile) css += `${paintTarget}{${SCENE_RIM_FILTER_CSS}}`
    }
  }

  return css
}

export { EFFECT_IDS, EFFECTS }

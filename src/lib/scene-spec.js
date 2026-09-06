/**
 * Scene spec — the diorama layer of a username paint (spec v2).
 *
 * A scene turns the name into a three-deep composition, all inside the ONE
 * element the renderer already paints (zero DOM changes, zero new classes):
 *
 *   ::before  backdrop — the scene plate: sky gradient + pixel silhouette
 *             strip (inline SVG data-URI) + one slow ambient drift.
 *             position:absolute; inset:-1px -4px; z-index:-1 — pure ink
 *             overflow, so row height and layout NEVER move.
 *   (text)    the existing v1 paint pipeline, untouched. When the plate is
 *             present and the user has no glow/neon, a dark text rim is
 *             added so the name always reads on any plate.
 *   ::after   weather — particles in front of the text: rain, blood rain,
 *             snow, fog, embers, glyph rain, storm. Tiled pixel SVG
 *             patterns; parallax comes from two copies of the tile at
 *             different scales advancing whole-tile multiples per loop
 *             (seamless by construction, no @property needed).
 *
 * Same doctrine as paint-spec.js: authored as data, never CSS. Every color
 * is regex-clamped hex, every number range-clamped, every id looked up in a
 * fixed catalog — nothing user-typed is concatenated into the output.
 * Animations phase-lock to `--hsp-t` exactly like paint effects, so every
 * copy of a name shows the same frame. Compiled with opts.static (viewer
 * static mode / SSR / reduced-motion) a scene renders its designed hero
 * frame: the resting background positions ARE the composition.
 *
 * Pure-data module — no DOM, no fetch. Server-importable (paint-spec.js
 * imports this for validation; shared with the builder UI for catalogs).
 */

import {
  HEX_RE, isPlainObject, isIntInRange, isNumInRange,
  MIN_SPEED, MAX_SPEED, safeSpeed, periodSeconds, syncDelayCalc,
} from './paint-core.js'

// ── plate geometry (single source — mirrored nowhere) ──────────────────────
const PLATE_INSET = '-1px -4px'
const PSEUDO_BASE = `content:'';position:absolute;inset:${PLATE_INSET};pointer-events:none;`

const DENSITIES = new Set([1, 2, 3])

function svgUrl(svg) {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

function svg(viewW, viewH, body, stretch = false) {
  // `stretch` drops the default xMidYMid meet fit so a tile can be sized
  // `<fixed>px <percent>` — a horizontal band whose width tiles in whole
  // pixels (so a scroll can advance exactly one tile) while its height
  // tracks the plate. Everything else keeps its aspect ratio.
  const par = stretch ? " preserveAspectRatio='none'" : ''
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${viewW} ${viewH}'${par}>${body}</svg>`
}

/**
 * Horizontally-tileable "hanging deck" path: solid from the top edge down to a
 * blocky bottom edge. `steps` is [[width, depth], …] read left to right; the
 * first and last depth must match or the tile shows a vertical seam where it
 * repeats (guarded by test).
 */
function deckPath(steps) {
  let d = `M0 ${steps[0][1]}`
  for (const [w, h] of steps) d += `V${h}h${w}`
  return `${d}V0H0Z`
}

/** Cloud deck tile — `steps` sums to `w`. Rendered stretched (see svg()). */
function cloudDeck(steps, w, color, opacity) {
  return {
    w,
    url: svgUrl(svg(w, 24, `<path fill='${color}' opacity='${opacity}' d='${deckPath(steps)}'/>`, true)),
  }
}

// Two overcast decks. FAR is shallower and narrower (so it advances less per
// loop = slower), NEAR hangs lower and wider — parallax by construction, same
// trick the weather tiles use. Widths are the sum of their own steps, and both
// are deliberately narrower than a typical name plate (~56px for a six-glyph
// name at 13px) so a whole deck of lumps is visible at once; wider tiles put
// two enormous rectangles across the name instead of a cloud line.
const CLOUD_FAR_STEPS = [[5, 7], [6, 10], [4, 6], [7, 11], [5, 8], [6, 12], [7, 7]]
const CLOUD_NEAR_STEPS = [[7, 6], [6, 10], [8, 5], [7, 12], [9, 8], [6, 13], [6, 7], [7, 6]]
const CLOUD_FAR_W = 40
const CLOUD_NEAR_W = 56

// ── pixel silhouettes (blocky on purpose — crisp at 13px Cozette scale) ────

const SIL = {
  dunes: (c) => svgUrl(svg(96, 20,
    `<path fill='${c}' d='M0 20v-8h6v-2h8v-2h10v2h8v2h10v4h6v-2h10v-4h8v-2h10v2h8v4h6v2h6v4z'/>`)),
  graveyard: (c) => svgUrl(svg(140, 26,
    `<path fill='${c}' d='M0 26v-2h140v2z` +
    // fence run (pickets + rail)
    ` M4 24v-7h2v7z M11 24v-7h2v7z M18 24v-7h2v7z M2 19h20v2H2z` +
    // headstone (stepped arch)
    ` M34 24v-6h2v-2h6v2h2v6z` +
    // cross
    ` M52 24v-8h-3v-2h3v-4h2v4h3v2h-3v8z` +
    // monument (stepped obelisk)
    ` M68 24v-2h-2v-2h2v-9h4v9h2v2h-2v2z` +
    // bare tree (trunk + two arms)
    ` M96 24v-10h-4v-2h4v-4h2v2h5v2h-5v12z` +
    // second headstone
    ` M116 24v-5h2v-2h5v2h2v5z` +
    // fence run
    ` M130 24v-7h2v7z M137 24v-7h2v7z M128 19h12v2h-12z'/>`)),
  reef: (c) => svgUrl(svg(90, 14,
    `<path fill='${c}' d='M0 14v-4h8v-2h10v2h10v2h10v-4h8v-2h8v2h8v4h10v-2h10v2h8v2z'/>`)),
  pines: (c) => svgUrl(svg(84, 24,
    `<path fill='${c}' d='M0 24v-3h84v3z` +
    ` M8 21v-3H5v-4h3v-4h2v-3h2v3h2v4h3v4h-3v3z` +
    ` M30 21v-2h-2v-4h2v-3h2v-3h2v3h2v3h2v4h-2v2z` +
    ` M52 21v-3h-3v-4h3v-4h2v-4h2v4h2v4h3v4h-3v3z` +
    ` M74 21v-2h-2v-3h2v-3h2v3h2v3h-2v2z'/>`)),
}

// ── weather tiles (pixel SVG, tiled + scrolled; drops stay inside bounds) ──

/**
 * One drop: a 2px-wide streak with a solid 3px head at the leading (lower)
 * end, slanted 12°.
 *
 * These were 1px hairlines at 55-60% opacity. A name plate is roughly 50x22
 * CSS px, so a 1px column of translucent colour is a smudge, not rain — the
 * whole weather layer read as texture noise and people asked where their
 * weather had gone. Two pixels wide with an opaque head is the smallest thing
 * that still reads as a falling drop at name size. Every drop stays inside the
 * tile box (the tile repeats, so anything crossing an edge is cut in half).
 */
function rainDrop(c, x, y, h) {
  return `<g transform='rotate(12 ${x + 1} ${y + h / 2})'>` +
    `<rect x='${x}' y='${y}' width='2' height='${h}' fill='${c}' opacity='.5'/>` +
    `<rect x='${x}' y='${y + h - 3}' width='2' height='3' fill='${c}' opacity='.95'/></g>`
}

// Tiles are much larger than the old 1px-drizzle ones for the same reason the
// drops are wider: two pixels of opaque colour carries far more ink than one
// translucent pixel, and every tile is ALSO painted a second time at 1.4x for
// parallax, so keeping the old tile sizes would have put ~25 fat drops across
// a six-glyph name and buried it.
function rainTile(c, density) {
  if (density >= 3) return { w: 20, h: 24, url: svgUrl(svg(20, 24,
    rainDrop(c, 2, 2, 9) + rainDrop(c, 10, 8, 9) + rainDrop(c, 15, 1, 8))) }
  if (density === 2) return { w: 28, h: 28, url: svgUrl(svg(28, 28,
    rainDrop(c, 4, 3, 10) + rainDrop(c, 18, 13, 10))) }
  return { w: 40, h: 32, url: svgUrl(svg(40, 32,
    rainDrop(c, 7, 4, 11) + rainDrop(c, 27, 16, 10))) }
}

function snowTile(c, density) {
  if (density >= 3) return { w: 14, h: 18, url: svgUrl(svg(14, 18,
    `<g fill='${c}'><circle cx='3' cy='3' r='1' opacity='.9'/>` +
    `<circle cx='10' cy='8' r='.7' opacity='.6'/>` +
    `<circle cx='6' cy='13' r='1' opacity='.8'/>` +
    `<circle cx='12' cy='15' r='.6' opacity='.5'/></g>`)) }
  if (density === 2) return { w: 18, h: 22, url: svgUrl(svg(18, 22,
    `<g fill='${c}'><circle cx='4' cy='5' r='1' opacity='.9'/>` +
    `<circle cx='12' cy='14' r='.7' opacity='.6'/>` +
    `<circle cx='8' cy='19' r='.6' opacity='.5'/></g>`)) }
  return { w: 24, h: 28, url: svgUrl(svg(24, 28,
    `<g fill='${c}'><circle cx='6' cy='6' r='1' opacity='.85'/>` +
    `<circle cx='16' cy='18' r='.7' opacity='.55'/></g>`)) }
}

function emberTile(c1, c2, density) {
  if (density >= 3) return { w: 14, h: 20, url: svgUrl(svg(14, 20,
    `<g><rect x='3' y='15' width='1' height='2' fill='${c1}' opacity='.9'/>` +
    `<rect x='9' y='9' width='1' height='1' fill='${c2}' opacity='.8'/>` +
    `<rect x='6' y='4' width='1' height='1' fill='${c1}' opacity='.5'/>` +
    `<rect x='12' y='17' width='1' height='1' fill='${c2}' opacity='.7'/></g>`)) }
  if (density === 2) return { w: 16, h: 24, url: svgUrl(svg(16, 24,
    `<g><rect x='4' y='18' width='1' height='2' fill='${c1}' opacity='.9'/>` +
    `<rect x='11' y='8' width='1' height='1' fill='${c2}' opacity='.7'/></g>`)) }
  return { w: 20, h: 28, url: svgUrl(svg(20, 28,
    `<g><rect x='5' y='21' width='1' height='2' fill='${c1}' opacity='.85'/>` +
    `<rect x='14' y='9' width='1' height='1' fill='${c2}' opacity='.6'/></g>`)) }
}

function glyphTile(c, density) {
  const col = (x, ys, head) =>
    ys.map(([y, h]) => `<rect x='${x}' y='${y}' width='1' height='${h}' fill='${c}' opacity='.28'/>`).join('') +
    `<rect x='${x}' y='${head}' width='1' height='4' fill='${c}' opacity='.95'/>`
  if (density >= 3) return { w: 12, h: 22, url: svgUrl(svg(12, 22,
    col(2, [[1, 3], [6, 2], [10, 3]], 15) + col(8, [[3, 2], [8, 3], [13, 2]], 17))) }
  if (density === 2) return { w: 14, h: 22, url: svgUrl(svg(14, 22,
    col(3, [[1, 3], [6, 2], [10, 3]], 15) + col(10, [[4, 2], [9, 3]], 16))) }
  return { w: 18, h: 24, url: svgUrl(svg(18, 24, col(5, [[2, 3], [8, 2], [13, 3]], 18))) }
}

// ── foreground silhouettes (the NEAR plane — painted in front of the name) ──
//
// Short and sparse on purpose. These occlude the bottom few pixels of the
// glyphs, which is what sells "the name is standing IN the scene" instead of
// "the name is pasted ON a picture" — but a 13px name has about 9px of cap
// height, so anything taller than a descender stops being depth and starts
// being damage. Nothing here rises past ~5px of a 22px plate.

const FG = {
  dunes: (c) => svgUrl(svg(64, 8,
    `<path fill='${c}' d='M0 8V6h6V4h10v2h8v2h8V6h10V4h8v2h6v2z'/>`)),
  graveyard: (c) => svgUrl(svg(72, 8,
    `<path fill='${c}' d='M0 8V7h72v1z` +
    // near headstone
    ` M8 7V3h2V1h5v2h2v4z` +
    // near cross
    ` M30 7V2h-2V0h2v-1h2v1h2v2h-2v5z` +
    // near picket run
    ` M50 7V3h2v4z M56 7V3h2v4z M62 7V3h2v4z M48 4h18v1H48z'/>`)),
  reef: (c) => svgUrl(svg(56, 6,
    `<path fill='${c}' d='M0 6V4h5V2h6v2h7v2h9V3h6v3h8V4h7v2h8z'/>`)),
  pines: (c) => svgUrl(svg(60, 9,
    `<path fill='${c}' d='M0 9V8h60v1z` +
    ` M9 8V5H7V3h2V1h2v2h2v2h-2v3z` +
    ` M33 8V6h-2V4h2V2h2v2h2v2h-2v2z` +
    ` M50 8V5h-2V3h2V2h2v1h2v2h-2v3z'/>`)),
}

// ── bottom-anchored bands (swells, ice shelves, skylines) ──────────────────
//
// The mirror of a cloud deck: solid from the BOTTOM edge up to a blocky top
// edge, tileable, rendered stretched so `<w>px <percent>` sizing scrolls it
// exactly one tile per loop. First and last depth must match or the seam
// shows (same guard as the decks).

function bandPath(steps, H) {
  let d = `M0 ${H}`
  for (const [w, h] of steps) d += `V${H - h}h${w}`
  return `${d}V${H}Z`
}

function band(steps, w, H, color, opacity, extra = '') {
  return { w, url: svgUrl(svg(w, H, `<path fill='${color}' opacity='${opacity}' d='${bandPath(steps, H)}'/>${extra}`, true)) }
}

// Skyline: a band of buildings with lit windows. Which windows are lit is a
// fixed arithmetic pattern, not a roll — a tile must render the same on every
// build or two copies of one name would show two different cities.
function cityDeck(steps, w, H, color, win) {
  let x = 0
  let rects = ''
  steps.forEach(([bw, bh], i) => {
    if (bh >= 8) {
      for (let y = H - bh + 2; y < H - 2; y += 3) {
        for (let wx = x + 1; wx < x + bw - 1; wx += 2) {
          if ((wx * 7 + y * 3 + i) % 5 < 2) rects += `<rect x='${wx}' y='${y}' width='1' height='1' fill='${win}' opacity='.85'/>`
        }
      }
    }
    x += bw
  })
  return band(steps, w, H, color, '1', rects)
}

// Swells: two bands, the near one narrower so it advances more per loop.
const SWELL_FAR_STEPS = [[4, 5], [5, 7], [4, 9], [5, 7], [4, 5], [5, 4], [4, 5], [5, 7], [4, 9], [4, 7], [4, 5]]
const SWELL_NEAR_STEPS = [[3, 4], [4, 6], [3, 8], [4, 6], [3, 4], [4, 3], [3, 4], [4, 6], [3, 8], [3, 6], [2, 4]]
const SWELL_FAR_W = 48
const SWELL_NEAR_W = 36
// Ice shelves, same idea.
const ICE_FAR_STEPS = [[6, 6], [5, 9], [4, 7], [7, 10], [5, 6], [6, 8], [5, 11], [4, 7], [6, 9], [4, 6]]
const ICE_NEAR_STEPS = [[5, 4], [4, 6], [5, 5], [4, 7], [5, 4], [4, 3], [5, 4], [4, 6], [4, 4]]
const ICE_FAR_W = 52
const ICE_NEAR_W = 40
// Skyline decks: FAR is short and narrow, NEAR is tall and wide.
const CITY_FAR_STEPS = [[6, 10], [2, 6], [7, 15], [3, 8], [8, 12], [2, 5], [6, 18], [4, 9], [7, 13], [3, 6], [6, 11], [2, 7], [8, 10]]
const CITY_NEAR_STEPS = [[8, 14], [3, 9], [10, 20], [4, 11], [9, 16], [3, 8], [11, 22], [5, 12], [8, 17], [3, 10], [10, 19], [6, 13], [8, 14]]
const CITY_FAR_W = 64
const CITY_NEAR_W = 88

// Sakura: a trunk with two arms and blocky blossom clusters, plus a small
// second tree — repeats every 120 units so a long name gets a grove.
SIL.sakura = (sil, bloom) => svgUrl(svg(120, 26,
  `<path fill='${sil}' d='M0 26v-2h120v2z` +
  ` M50 24v-9h-4v-2h4v-3h2v3h5v-2h3v2h-3v2h-5v9z` +
  ` M96 24v-6h-2v-2h2v-2h2v2h3v2h-3v6z'/>` +
  `<g fill='${bloom}'><circle cx='46' cy='11' r='3'/><circle cx='52' cy='8' r='3.4'/><circle cx='58' cy='11' r='3'/>` +
  `<circle cx='49' cy='15' r='2.2'/><circle cx='56' cy='15' r='2'/>` +
  `<circle cx='95' cy='14' r='2.2'/><circle cx='99' cy='12' r='2.4'/><circle cx='102' cy='16' r='1.8'/></g>`))
FG.sakura = (c) => svgUrl(svg(48, 6,
  `<path fill='${c}' d='M0 6V5h48v1z M6 5V3h2v2z M15 5V4h2v1z M27 5V3h2v2z M38 5V4h2v1z'/>`))
FG.swell = (c) => svgUrl(svg(36, 6,
  `<path fill='${c}' d='M0 6V4h4V2h4v2h4v2h6V3h4v3h6V4h4v2z'/>`))
FG.ice = (c) => svgUrl(svg(40, 6,
  `<path fill='${c}' d='M0 6V4h5V2h6v2h5v2h8V3h5v3h6V4h5v2z'/>`))
FG.roof = (c) => svgUrl(svg(64, 8,
  `<path fill='${c}' d='M0 8V7h64v1z` +
  // antenna mast + a water tower on legs
  ` M12 7V1h1v6z M10 3h5v1h-5z` +
  ` M40 7V4h-1V1h6v3h-1v3z M41 4h4v3h-4z'/>`))

// Weather tiles for the drifting/rising particles below.
function petalTile(c, density) {
  const p = (x, y, o) => `<rect x='${x}' y='${y}' width='2' height='1' fill='${c}' opacity='${o}'/>` +
    `<rect x='${x + 1}' y='${y + 1}' width='1' height='1' fill='${c}' opacity='${o}'/>`
  if (density >= 3) return { w: 16, h: 18, url: svgUrl(svg(16, 18, p(2, 2, '.9') + p(9, 7, '.7') + p(5, 12, '.85') + p(12, 15, '.6'))) }
  if (density === 2) return { w: 20, h: 22, url: svgUrl(svg(20, 22, p(4, 4, '.9') + p(13, 13, '.65') + p(8, 18, '.5'))) }
  return { w: 26, h: 28, url: svgUrl(svg(26, 28, p(6, 6, '.85') + p(17, 18, '.6'))) }
}

function bubbleTile(c, density) {
  const b = (cx, cy, r, o) => `<circle cx='${cx}' cy='${cy}' r='${r}' fill='none' stroke='${c}' stroke-width='1' opacity='${o}'/>`
  if (density >= 3) return { w: 14, h: 20, url: svgUrl(svg(14, 20, b(3, 4, 1.5, '.8') + b(10, 10, 1, '.6') + b(6, 16, 1.5, '.7'))) }
  if (density === 2) return { w: 18, h: 24, url: svgUrl(svg(18, 24, b(4, 5, 1.5, '.8') + b(13, 15, 1, '.55'))) }
  return { w: 22, h: 30, url: svgUrl(svg(22, 30, b(6, 7, 1.5, '.75') + b(16, 21, 1, '.5'))) }
}

function fireflyTile(c, density) {
  const f = (cx, cy, o) => `<circle cx='${cx}' cy='${cy}' r='2' fill='${c}' opacity='${(o * 0.3).toFixed(2)}'/>` +
    `<circle cx='${cx}' cy='${cy}' r='.8' fill='${c}' opacity='${o}'/>`
  if (density >= 3) return { w: 16, h: 20, url: svgUrl(svg(16, 20, f(3, 4, .95) + f(11, 9, .7) + f(6, 15, .85))) }
  if (density === 2) return { w: 20, h: 26, url: svgUrl(svg(20, 26, f(4, 6, .9) + f(14, 17, .65))) }
  return { w: 26, h: 32, url: svgUrl(svg(26, 32, f(7, 8, .9) + f(18, 22, .55))) }
}

// ── the second shelf of art (backdrops 13-22, weathers 10-15) ──────────────

// Mountains: one ridge is a bottom band with snow on every step tall enough to
// hold it. Which steps get a cap is arithmetic on the step, never a roll.
function ridge(steps, w, H, color, cap) {
  let x = 0, caps = ''
  for (const [bw, bh] of steps) {
    if (bh >= 9) caps += `<rect x='${x}' y='${H - bh}' width='${bw}' height='2' fill='${cap}' opacity='.9'/>`
    x += bw
  }
  return band(steps, w, H, color, '1', caps)
}

const PEAK_STEPS = [[4, 6], [4, 9], [4, 13], [4, 17], [4, 21], [4, 17], [4, 12], [4, 9], [4, 13], [4, 18], [4, 22], [4, 18], [4, 13], [4, 9], [4, 7], [4, 10], [4, 14], [4, 11], [4, 8], [4, 6], [4, 8], [4, 11], [4, 8], [4, 6]]
const PEAK_W = 96
const RIDGE_FAR_STEPS = [[5, 8], [5, 12], [5, 16], [5, 13], [5, 9], [5, 11], [5, 15], [5, 19], [5, 15], [5, 11], [5, 8], [5, 10], [5, 13], [5, 10], [5, 8]]
const RIDGE_FAR_W = 75
const RIDGE_NEAR_STEPS = [[4, 4], [4, 7], [4, 10], [4, 13], [4, 10], [4, 7], [4, 5], [4, 8], [4, 12], [4, 9], [4, 6], [4, 4], [4, 6], [4, 4]]
const RIDGE_NEAR_W = 56
// Castle: curtain wall with merlons, two towers, a keep — lit by cityDeck's
// window arithmetic exactly as a skyline is.
const CASTLE_STEPS = [[3, 7], [2, 9], [3, 7], [2, 9], [3, 7], [2, 9], [3, 7], [5, 15], [2, 18], [2, 15], [2, 18], [2, 15], [5, 15], [3, 7], [2, 9], [3, 7], [2, 9], [3, 7], [7, 21], [2, 24], [2, 21], [2, 24], [2, 21], [7, 21], [3, 7], [2, 9], [3, 7], [2, 9], [3, 7], [2, 9], [3, 7], [5, 13], [2, 16], [2, 13], [2, 16], [5, 13], [3, 7]]
const CASTLE_W = CASTLE_STEPS.reduce((a, [w]) => a + w, 0)
// Regolith: a low undulating band pocked with craters.
const MOON_STEPS = [[6, 5], [6, 6], [6, 5], [6, 7], [6, 6], [6, 5], [6, 6], [6, 7], [6, 6], [6, 5]]
const MOON_W = 60

function craters(color) {
  const c = (cx, cy, r) => `<circle cx='${cx}' cy='${cy}' r='${r}' fill='${color}' opacity='.55'/>` +
    `<path d='M${cx - r} ${cy}a${r} ${r} 0 0 1 ${2 * r} 0' fill='none' stroke='#ffffff' stroke-width='.6' opacity='.35'/>`
  return c(9, 12, 2.5) + c(27, 11.5, 1.6) + c(44, 12.5, 2.8) + c(54, 11.6, 1.2)
}

// Lava cracks down the flanks of the peaks.
function lavaCracks(color) {
  return [[17, 3, 9], [18, 8, 6], [41, 2, 10], [42, 9, 5], [66, 10, 6], [65, 13, 4]]
    .map(([x, y, h]) => `<rect x='${x}' y='${y}' width='1' height='${h}' fill='${color}' opacity='.9'/>`).join('')
}

SIL.reeds = (c) => svgUrl(svg(72, 22,
  `<path fill='${c}' d='M0 22v-1h72v1z` +
  // cattails: stalk + a fat head, several heights
  ` M6 21V9h1v12z M5 6h3v4H5z M15 21V12h1v9z M14 9h3v4h-3z M28 21V7h1v14z M27 4h3v4h-3z` +
  ` M39 21V13h1v8z M52 21V8h1v13z M51 5h3v4h-3z M62 21V11h1v10z M61 8h3v4h-3z'/>`))
SIL.bamboo = (c) => svgUrl(svg(40, 24,
  // segmented stalks: 5px culms with 1px nodes, two thick, one thin
  `<g fill='${c}'>` +
  [0, 6, 12, 18].map(y => `<rect x='7' y='${y}' width='3' height='5'/><rect x='24' y='${y + 2}' width='3' height='5'/><rect x='34' y='${y + 1}' width='2' height='5'/>`).join('') +
  `<rect x='7' y='0' width='3' height='24' opacity='.55'/><rect x='24' y='0' width='3' height='24' opacity='.55'/><rect x='34' y='0' width='2' height='24' opacity='.55'/>` +
  // leaves
  `<path d='M10 7h6v1h-4v1h-2z M22 14h-6v1h4v1h2z M36 10h5v1h-3v1h-2z'/></g>`))
SIL.pyramids = (c) => svgUrl(svg(120, 24,
  `<path fill='${c}' d='M0 24v-2h120v2z M18 22l26-19 26 19z M78 22l15-11 15 11z'/>`))

FG.rock = (c) => svgUrl(svg(48, 6,
  `<path fill='${c}' d='M0 6V5h48v1z M4 5V3h3V1h4v2h2v2z M22 5V2h5v3z M35 5V3h4V2h3v1h2v2z'/>`))
FG.reeds = (c) => svgUrl(svg(40, 7,
  `<path fill='${c}' d='M0 7V6h40v1z M5 6V1h1v5z M4 0h3v2H4z M17 6V2h1v4z M29 6V0h1v6z M28 -2h3v3h-3z M36 6V3h1v3z'/>`))
FG.wall = (c) => svgUrl(svg(48, 6,
  `<path fill='${c}' d='M0 6V3h3V1h3v2h4V1h3v2h4V1h3v2h4V1h3v2h4V1h3v2h4V1h3v2h4V1h3v2h1v3z'/>`))
FG.rocks = (c) => svgUrl(svg(40, 5,
  `<path fill='${c}' d='M0 5V4h40v1z M6 4V2h5v2z M19 4V3h3v1z M29 4V1h4v3z'/>`))
FG.grass = (c) => svgUrl(svg(32, 6,
  `<path fill='${c}' d='M0 6V5h32v1z M3 5V2h1v3z M7 5V3h1v2z M12 5V1h1v4z M17 5V3h1v2z M21 5V2h1v3z M26 5V3h1v2z M29 5V1h1v4z'/>`))

function leafTile(c, density) {
  // a three-pixel diagonal streak — reads as a falling leaf at name size
  const l = (x, y, o) => `<path fill='${c}' opacity='${o}' d='M${x} ${y}h1v1h2v1h1v1h-1v-1h-2v-1h-1z'/>`
  if (density >= 3) return { w: 16, h: 18, url: svgUrl(svg(16, 18, l(2, 2, '.9') + l(9, 8, '.7') + l(4, 13, '.85'))) }
  if (density === 2) return { w: 20, h: 22, url: svgUrl(svg(20, 22, l(4, 4, '.9') + l(13, 14, '.65'))) }
  return { w: 26, h: 28, url: svgUrl(svg(26, 28, l(6, 6, '.85') + l(17, 19, '.55'))) }
}

function sparkTile(c, density) {
  const sp = (x, y, o) => `<rect x='${x}' y='${y}' width='1' height='3' fill='${c}' opacity='${o}'/>`
  if (density >= 3) return { w: 12, h: 16, url: svgUrl(svg(12, 16, sp(2, 2, '.95') + sp(8, 7, '.7') + sp(5, 12, '.85'))) }
  if (density === 2) return { w: 16, h: 22, url: svgUrl(svg(16, 22, sp(3, 4, '.9') + sp(11, 14, '.65'))) }
  return { w: 22, h: 28, url: svgUrl(svg(22, 28, sp(6, 7, '.9') + sp(15, 20, '.55'))) }
}

function dustTile(c, density) {
  const d = (x, y, o) => `<rect x='${x}' y='${y}' width='1' height='1' fill='${c}' opacity='${o}'/>`
  if (density >= 3) return { w: 14, h: 14, url: svgUrl(svg(14, 14, d(2, 3, '.8') + d(9, 6, '.6') + d(5, 11, '.7') + d(12, 1, '.5'))) }
  if (density === 2) return { w: 18, h: 18, url: svgUrl(svg(18, 18, d(4, 5, '.8') + d(13, 12, '.55') + d(8, 16, '.45'))) }
  return { w: 24, h: 22, url: svgUrl(svg(24, 22, d(6, 7, '.75') + d(17, 16, '.5'))) }
}

function confettiTile(v, density) {
  const r = (x, y, c, o, tall) => `<rect x='${x}' y='${y}' width='${tall ? 1 : 2}' height='${tall ? 2 : 1}' fill='${c}' opacity='${o}'/>`
  if (density >= 3) return { w: 16, h: 18, url: svgUrl(svg(16, 18, r(2, 2, v.c1, '.95') + r(9, 6, v.c2, '.85', true) + r(5, 11, v.c3, '.9') + r(12, 15, v.c1, '.7', true))) }
  if (density === 2) return { w: 20, h: 22, url: svgUrl(svg(20, 22, r(4, 4, v.c1, '.95') + r(13, 12, v.c2, '.8', true) + r(8, 18, v.c3, '.85'))) }
  return { w: 26, h: 28, url: svgUrl(svg(26, 28, r(6, 6, v.c1, '.9') + r(17, 19, v.c2, '.7', true))) }
}

function meteorTile(c, density) {
  // a streak falling to the lower left, bright at the head
  const m = (x, y, o) => `<path d='M${x + 8} ${y}l-8 5' stroke='${c}' stroke-width='1' opacity='${(o * 0.55).toFixed(2)}'/>` +
    `<rect x='${x}' y='${y + 4}' width='2' height='2' fill='${c}' opacity='${o}'/>`
  if (density >= 3) return { w: 24, h: 20, url: svgUrl(svg(24, 20, m(2, 2, .95) + m(12, 11, .7))) }
  if (density === 2) return { w: 32, h: 26, url: svgUrl(svg(32, 26, m(4, 4, .9) + m(18, 16, .5))) }
  return { w: 40, h: 30, url: svgUrl(svg(40, 30, m(8, 8, .9))) }
}

function heartTile(c, density) {
  const h = (x, y, o) => `<path fill='${c}' opacity='${o}' d='M${x + 1} ${y}h1v1h1v-1h1v2h-1v1h-1v1h-1v-1h-1v-1h-1v-2h1z'/>`
  if (density >= 3) return { w: 16, h: 18, url: svgUrl(svg(16, 18, h(2, 2, '.9') + h(9, 8, '.7') + h(4, 13, '.85'))) }
  if (density === 2) return { w: 20, h: 22, url: svgUrl(svg(20, 22, h(4, 4, '.9') + h(13, 14, '.65'))) }
  return { w: 26, h: 28, url: svgUrl(svg(26, 28, h(6, 6, '.85') + h(17, 19, '.55'))) }
}

// ── layer model ─────────────────────────────────────────────────────────────
//
// A scene pseudo is a `background:` shorthand plus keyframes that animate
// `background-position`, and CSS matches those two lists POSITIONALLY. Building
// both as strings meant every catalog entry hand-wrote a comma list that had to
// agree with its own layer count, silently rendering wrong if it did not — and
// it made it impossible to COMPOSE, because nothing could add a layer to
// someone else's plate without editing their string.
//
// So a layer is data now:
//   img     the CSS <image>
//   repeat  background-repeat for this layer
//   size    background-size for this layer
//   from    resting position — also the hero frame a static paint renders
//   to      position at 100% of the loop (defaults to `from`: a still layer)
//   mid     optional 50% key, for the weathers that sway rather than fall
// and the compiler assembles both lists from the same array, so they cannot
// disagree.

const L = (img, repeat, size, from, to, mid) => ({ img, repeat, size, from, to, mid })

const layerCss = (l) => `${l.img} ${l.repeat} ${l.from}/${l.size}`
const positionsAt = (layers, key) => layers.map(l => l[key] ?? l.from).join(',')

function positionalKeyframes(name, layers) {
  const from = positionsAt(layers, 'from')
  const to = positionsAt(layers, 'to')
  if (layers.some(l => l.mid)) {
    return `@keyframes ${name}{0%{background-position:${from};}` +
      `50%{background-position:${positionsAt(layers, 'mid')};}` +
      `100%{background-position:${to};}}`
  }
  return `@keyframes ${name}{from{background-position:${from};}to{background-position:${to};}}`
}

// ── tint → palette ──────────────────────────────────────────────────────────
//
// A scene is drawn in ONE colour, and the user picks it from the same
// ANSI-256 palette their name is painted with. Hue and saturation are theirs;
// lightness is the scene's. That split is what makes a free tint safe: every
// plate keeps its designed mid-to-dark ladder under the text rim whatever is
// picked, a grey tint yields a grey scene instead of a broken one, and there
// is no curated variant list to outgrow.
//
// Accents — glows, rays, wisps, lit windows, particles — take the tint AS IS,
// so a dark pick reads as a dim scene and a bright one as a loud one. That is
// the one axis the ladder leaves to the user, on purpose.
//
// k(l, sat = 1, hue = 0) → #rrggbb at the tint's hue (+hue°), the tint's
//   saturation × sat, lightness l
// k.to(l, sat, target, amount) → the same, with the hue pulled toward
//   `target` by `amount` (0..1) along the shorter arc — how a warm horizon
//   still ends in a night-blue zenith
// k.tint → the picked colour, verbatim; k.l → its lightness

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  const l = (max + min) / 2
  if (!d) return [0, 0, l]
  const s = d / (1 - Math.abs(2 * l - 1))
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s, l]
}

function hslToHex(h, s, l) {
  s = Math.min(1, Math.max(0, s))
  l = Math.min(1, Math.max(0, l))
  const f = (n) => {
    const kk = (n + h / 30) % 12
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(kk - 3, 9 - kk, 1))
    return Math.round(c * 255).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

function tintKit(tint) {
  const [h, s, l] = hexToHsl(tint)
  const k = (lt, sat = 1, hue = 0) => hslToHex((h + hue + 360) % 360, s * sat, lt)
  k.to = (lt, sat, target, amount) => {
    const delta = ((target - h + 540) % 360) - 180
    return hslToHex((h + delta * amount + 360) % 360, s * sat, lt)
  }
  k.tint = tint
  k.l = l
  return k
}

// The zenith a lit horizon fades into — night blue, whatever the tint.
const NIGHT = 245

// ── backdrop catalog ────────────────────────────────────────────────────────
//
// build(k) returns { layers, alternate?, props?, keyframesBody?, fg? }.
// `layers` is back-to-front LAST-to-FIRST, exactly like the CSS shorthand:
// the first entry paints on top. `fg` is a single NEAR layer, painted in the
// front pseudo over the name. Backgrounds never escape the pseudo's box — no
// clipping, no overflow, no layout impact. Every plate is deliberately
// mid-to-dark so the shared text rim (see paint-spec.js) guarantees legibility
// on all of them.
//
// `legacy` is the tint each retired numbered variant is read as — a saved
// `{ variant: n }` keeps rendering, and [0] is the tint a fresh pick starts
// from. Nothing else in the catalog is preconfigured.

const BACKDROPS = {
  dawn: {
    label: 'desert dawn', luminance: false, basePeriod: 16,
    legacy: ['#ff8700', '#ff5f87', '#ffd700'],
    build(k) {
      const haze = k(.84), bloom = k(.69)
      return {
        layers: [
          L(SIL.dunes(k(.04, .8)), 'repeat-x', 'auto 42%', '0 100%', '0 100%'),
          L(`linear-gradient(90deg,transparent 0%,${haze}38 35%,${haze}55 50%,${haze}38 65%,transparent 100%)`,
            'no-repeat', '220% 58%', '200% 78%', '-100% 78%'),
          L(`radial-gradient(90% 90% at 50% 108%,${bloom}66 0%,${bloom}22 40%,transparent 70%)`, 'no-repeat', '100% 100%', '0 0'),
          L(`linear-gradient(0deg,${k(.5)} 0%,${k(.35)} 22%,${k.to(.33, .35, NIGHT, .55)} 55%,${k.to(.26, .3, NIGHT, .9)} 82%,${k.to(.19, .3, NIGHT, 1)} 100%)`, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.dunes(k(.02, .8)), 'repeat-x', 'auto 26%', '0 100%'),
      }
    },
  },

  graveyard: {
    // Overcast by construction: the sky is brightest at the horizon (the glow
    // the clouds are lit from) and darkest at the top, where two blocky cloud
    // decks hang down over it. The decks are LIGHTER than that top, because
    // an overcast lid lit from below by the same glow is what you actually
    // see at night.
    label: 'graveyard', luminance: false, basePeriod: 22,
    legacy: ['#808080', '#d70000', '#5f87ff'],
    build(k) {
      const near = cloudDeck(CLOUD_NEAR_STEPS, CLOUD_NEAR_W, k(.22, .3), '1')
      const far = cloudDeck(CLOUD_FAR_STEPS, CLOUD_FAR_W, k(.18, .35), '.9')
      return {
        layers: [
          L(SIL.graveyard(k(.04, .3)), 'repeat-x', 'auto 52%', '0 100%', '0 100%'),
          // Each deck advances exactly one own-tile width per loop — seamless
          // by construction, and the different widths ARE the parallax.
          L(near.url, 'repeat-x', `${near.w}px 58%`, '0 0', `-${near.w}px 0`),
          L(far.url, 'repeat-x', `${far.w}px 44%`, '0 0', `-${far.w}px 0`),
          L(`radial-gradient(45% 75% at 62% 6%,${k(.8, .5)}2e 0%,transparent 68%)`, 'no-repeat', '100% 100%', '0 0'),
          L(`linear-gradient(0deg,${k(.2, .35)} 0%,${k(.15, .35)} 40%,${k(.09, .35)} 75%,${k(.06, .35)} 100%)`, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.graveyard('#000000'), 'repeat-x', 'auto 30%', '0 100%'),
      }
    },
  },

  abyss: {
    label: 'abyss', luminance: false, basePeriod: 18,
    legacy: ['#00d7ff', '#00ffd7', '#875fff'],
    build(k) {
      const ray = k.tint
      return {
        layers: [
          L(SIL.reef(k(.02, .8)), 'repeat-x', 'auto 26%', '0 100%', '0 100%'),
          L(`linear-gradient(104deg,transparent 30%,${ray}14 42%,transparent 50%,${ray}0e 62%,transparent 72%)`,
            'no-repeat', '260% 100%', '-90% 0', '190% 0'),
          L(`radial-gradient(80% 60% at 50% -10%,${ray}20 0%,transparent 60%)`, 'no-repeat', '100% 100%', '0 0'),
          L(`linear-gradient(180deg,${k(.15)} 0%,${k(.09)} 45%,${k(.04)} 100%)`, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.reef(k(.01)), 'repeat-x', 'auto 22%', '0 100%'),
      }
    },
  },

  nightfall: {
    label: 'nightfall', luminance: false, basePeriod: 20,
    legacy: ['#00ff87', '#ff40af', '#87d7ff'],
    build(k) {
      // The curtain is the tint and a second band 40° along; the sky behind
      // it is night whatever the curtain's colour.
      const a1 = k.tint, a2 = k(k.l, 1, 40)
      return {
        layers: [
          L(SIL.pines(k.to(.03, .45, 240, .75)), 'repeat-x', 'auto 46%', '0 100%', '0 100%'),
          L(`linear-gradient(100deg,transparent 15%,${a1}30 35%,${a2}2e 50%,${a1}24 62%,transparent 82%)`,
            'no-repeat', '240% 90%', '-90% 0', '190% 0'),
          L('radial-gradient(circle,#ffffffcc 0 .5px,transparent 1px)', 'repeat', '17px 13px', '0 0'),
          L('radial-gradient(circle,#ffffff66 0 .5px,transparent 1px)', 'repeat', '23px 19px', '5px 7px'),
          L(`linear-gradient(0deg,${k.to(.06, .4, 240, .75)} 0%,${k.to(.12, .4, 240, .75)} 55%,${k.to(.07, .4, 240, .75)} 100%)`, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.pines(k.to(.01, 1, 240, .75)), 'repeat-x', 'auto 30%', '0 100%'),
      }
    },
  },

  terminal: {
    // No foreground: a CRT has no landscape to stand in front of.
    label: 'terminal', luminance: false, basePeriod: 9,
    legacy: ['#00ff5f', '#ffb000', '#c0c0c0'],
    build(k) {
      const ph = k.tint
      return {
        layers: [
          L(`linear-gradient(0deg,transparent 38%,${ph}16 50%,transparent 62%)`, 'no-repeat', '100% 300%', '0 0', '0 100%'),
          L(`repeating-linear-gradient(0deg,${ph}0d 0 1px,transparent 1px 3px)`, 'repeat', '100% auto', '0 0'),
          L(`linear-gradient(${k(.05, .55)},${k(.02, .55)})`, 'no-repeat', '100% 100%', '0 0'),
        ],
      }
    },
  },

  furnace: {
    label: 'furnace', luminance: true, basePeriod: 5,
    legacy: ['#ff3700', '#00afff', '#af5fff'],
    build(k, hash) {
      // Registered <color> custom prop so the underglow's alpha itself
      // interpolates (background-position can't express a breathe). The var is
      // hash-namespaced like conic's angle prop — no cross-user collision.
      // This is the one backdrop whose loop ALTERNATES, which is also why it
      // never hosts a far-weather plane: rain running backwards is not rain.
      const cv = `--hsb-${hash}`
      const glow = k.tint
      return {
        layers: [
          L(`radial-gradient(120% 90% at 50% 115%,var(${cv}) 0%,transparent 65%)`, 'no-repeat', '100% 100%', '0 0'),
          L(`linear-gradient(0deg,${k(.05)} 0%,${k(.03, .75)} 55%,#050505 100%)`, 'no-repeat', '100% 100%', '0 0'),
        ],
        alternate: true,
        props: `@property ${cv}{syntax:"<color>";initial-value:${glow}66;inherits:false;}`,
        keyframesBody: `{from{${cv}:${glow}55;}to{${cv}:${glow}a8;}}`,
      }
    },
  },

  ocean: {
    label: 'open sea', luminance: false, basePeriod: 14,
    legacy: ['#ff8700', '#5f87ff', '#00d7ff'],
    build(k) {
      // The water is sea-coloured under any sky: pulled most of the way to
      // teal, keeping only a cast of the tint.
      const near = band(SWELL_NEAR_STEPS, SWELL_NEAR_W, 12, k.to(.17, .7, 195, .8), '1')
      const far = band(SWELL_FAR_STEPS, SWELL_FAR_W, 16, k.to(.23, .65, 195, .8), '1')
      const bloom = k(.69), glit = k(.84)
      return {
        layers: [
          // Swells advance one own-tile per loop, opposite directions — the
          // near one faster because its tile is narrower. Seamless by construction.
          L(near.url, 'repeat-x', `${near.w}px 34%`, '0 100%', `-${near.w}px 100%`),
          L(far.url, 'repeat-x', `${far.w}px 46%`, '0 100%', `${far.w}px 100%`),
          // Sun path glitter — a broken line on the water that walks with the swell.
          L(`repeating-linear-gradient(90deg,transparent 0 3px,${glit}66 3px 4px,transparent 4px 7px)`, 'repeat-x', '100% 8%', '0 60%', '7px 60%'),
          L(`radial-gradient(70% 70% at 50% 62%,${bloom}88 0%,${bloom}22 35%,transparent 60%)`, 'no-repeat', '100% 100%', '0 0'),
          L(`linear-gradient(0deg,${k(.5)} 0%,${k.to(.49, .55, NIGHT, .25)} 24%,${k.to(.3, .4, NIGHT, .7)} 58%,${k.to(.19, .35, NIGHT, 1)} 100%)`, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.swell(k.to(.08, .7, 195, .8)), 'repeat-x', 'auto 22%', '0 100%'),
      }
    },
  },

  skyline: {
    label: 'city night', luminance: false, basePeriod: 26,
    legacy: ['#ff40af', '#ff8700', '#ff87af'],
    build(k) {
      // Lit windows are warm in every city; the tint is the glow the towers
      // stand against.
      const win = '#ffd75f', glow = k.tint
      const near = cityDeck(CITY_NEAR_STEPS, CITY_NEAR_W, 24, k(.05, .5), win)
      const far = cityDeck(CITY_FAR_STEPS, CITY_FAR_W, 24, k(.13, .5), win)
      return {
        layers: [
          L(near.url, 'repeat-x', `${near.w}px 78%`, '0 100%', `-${near.w}px 100%`),
          L(far.url, 'repeat-x', `${far.w}px 60%`, '0 100%', `-${far.w}px 100%`),
          L(`radial-gradient(80% 60% at 50% 100%,${glow}40 0%,${glow}14 40%,transparent 70%)`, 'no-repeat', '100% 100%', '0 0'),
          L(`linear-gradient(0deg,${k(.19, .65)} 0%,${k(.11, .65)} 40%,${k(.05, .6)} 100%)`, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.roof(k(.03, .5)), 'repeat-x', 'auto 30%', '0 100%'),
      }
    },
  },

  orbit: {
    // No foreground: nothing stands in front of a name in orbit.
    label: 'orbit', luminance: false, basePeriod: 30,
    legacy: ['#ff5f00', '#af5fff', '#00d7ff'],
    build(k) {
      const neb = k.tint, rim = k(.69)
      return {
        layers: [
          // A curved horizon with a lit rim — the planet is below the plate,
          // only its limb shows.
          L(`radial-gradient(160% 110% at 50% 168%,${k(.28, .7)} 0 44%,${rim}99 45%,transparent 50%)`, 'no-repeat', '100% 100%', '0 0'),
          // Star fields drift one own-tile per loop — seamless, and the two
          // tile widths are the parallax.
          L('radial-gradient(circle,#ffffffcc 0 .5px,transparent 1px)', 'repeat', '17px 13px', '0 0', '-17px 0'),
          L('radial-gradient(circle,#ffffff66 0 .5px,transparent 1px)', 'repeat', '23px 19px', '5px 7px', '-18px 7px'),
          L(`linear-gradient(100deg,transparent 20%,${neb}26 40%,${neb}14 52%,transparent 70%)`, 'no-repeat', '240% 100%', '-90% 0', '190% 0'),
          L(`linear-gradient(0deg,${k(.06, .4)} 0%,${k(.03, .4)} 100%)`, 'no-repeat', '100% 100%', '0 0'),
        ],
      }
    },
  },

  synth: {
    // No foreground: the grid IS the ground.
    label: 'outrun', luminance: false, basePeriod: 1.4,
    legacy: ['#ff40af', '#00e5ff', '#ffd700'],
    build(k) {
      const sun = k.tint, line = k(.6)
      return {
        layers: [
          // Sun + sky in ONE opaque top box: the disc is centred on the box's
          // bottom edge, so the horizon cuts it in half, and the box hides the
          // 5px the grid overlaps past the horizon (below) while it scrolls.
          L(`radial-gradient(circle at 50% 100%,${sun} 0 5px,${k(.16, .7)} 5.5px 14px,${k(.07, .75)} 100%)`, 'no-repeat', '100% 54%', '0 0'),
          // Horizontal grid lines roll toward the viewer: one 5px period per
          // loop, seamless. The box is 5px taller than the floor so a line is
          // never missing at the top mid-scroll.
          L(`repeating-linear-gradient(0deg,${line}cc 0 1px,transparent 1px 5px)`, 'repeat', '100% calc(46% + 5px)', '0 100%', '0 calc(100% + 5px)'),
          L(`repeating-linear-gradient(90deg,${line}55 0 1px,transparent 1px 9px)`, 'no-repeat', '100% 46%', '0 100%'),
          L(`linear-gradient(180deg,${k(.11, .7)} 0%,#000000 100%)`, 'no-repeat', '100% 46%', '0 100%'),
          L('linear-gradient(#000000,#000000)', 'no-repeat', '100% 100%', '0 0'),
        ],
      }
    },
  },

  glacier: {
    label: 'glacier', luminance: false, basePeriod: 28,
    legacy: ['#5f87af', '#af5f87', '#00afd7'],
    build(k) {
      const near = band(ICE_NEAR_STEPS, ICE_NEAR_W, 10, k(.38, .41), '1')
      const far = band(ICE_FAR_STEPS, ICE_FAR_W, 14, k(.28, .42), '1')
      const haze = k(.88), bloom = k(.94)
      return {
        layers: [
          L(near.url, 'repeat-x', `${near.w}px 32%`, '0 100%', `-${near.w}px 100%`),
          L(far.url, 'repeat-x', `${far.w}px 48%`, '0 100%', `-${far.w}px 100%`),
          L(`linear-gradient(90deg,transparent 0%,${haze}30 35%,${haze}4a 50%,${haze}30 65%,transparent 100%)`,
            'no-repeat', '220% 40%', '200% 60%', '-100% 60%'),
          L(`radial-gradient(60% 60% at 50% 70%,${bloom}55 0%,${bloom}18 40%,transparent 65%)`, 'no-repeat', '100% 100%', '0 0'),
          L(`linear-gradient(0deg,${k(.48, .3)} 0%,${k(.27, .37)} 35%,${k(.12, .4)} 100%)`, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.ice(k(.19, .47)), 'repeat-x', 'auto 22%', '0 100%'),
      }
    },
  },

  sakura: {
    label: 'sakura', luminance: false, basePeriod: 20,
    legacy: ['#ffafd7', '#ff87af', '#af5fff'],
    build(k) {
      const bloom = k(.92), haze = k(.92)
      return {
        layers: [
          L(SIL.sakura(k(.07, .45), bloom), 'repeat-x', 'auto 62%', '0 100%', '0 100%'),
          L(`linear-gradient(90deg,transparent 0%,${haze}2e 35%,${haze}44 50%,${haze}2e 65%,transparent 100%)`,
            'no-repeat', '220% 50%', '-100% 30%', '200% 30%'),
          L(`radial-gradient(50% 60% at 30% 20%,${bloom}55 0%,transparent 65%)`, 'no-repeat', '100% 100%', '0 0'),
          L(`linear-gradient(0deg,${k(.84)} 0%,${k(.64, .6)} 30%,${k.to(.33, .35, 250, .6)} 65%,${k.to(.19, .37, 250, 1)} 100%)`, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.sakura(k(.04, .45)), 'repeat-x', 'auto 22%', '0 100%'),
      }
    },
  },

  volcano: {
    label: 'volcano', luminance: false, basePeriod: 12,
    legacy: ['#ff5f00', '#ffd700', '#af5fff'],
    build(k) {
      // The tint is the lava; the sky and rock sit a little behind it on the
      // wheel, the way the glow of a vent is warmer than the smoke above it.
      const lava = k.tint, sil = k(.03, .5, -15)
      const peaks = band(PEAK_STEPS, PEAK_W, 24, sil, '1', lavaCracks(lava))
      return {
        layers: [
          L(peaks.url, 'repeat-x', `${peaks.w}px 58%`, '0 100%', '0 100%'),
          // ash drifting across the slopes
          L(`linear-gradient(90deg,transparent 0%,${sil}99 40%,${sil}bb 50%,${sil}99 60%,transparent 100%)`,
            'no-repeat', '220% 36%', '-100% 30%', '200% 30%'),
          L(`radial-gradient(80% 70% at 50% 110%,${lava}77 0%,${lava}22 40%,transparent 70%)`, 'no-repeat', '100% 100%', '0 0'),
          L(`linear-gradient(0deg,${k(.19, 1, -15)} 0%,${k(.09, .8, -15)} 30%,${k(.04, .6, -15)} 70%,${k(.02, .45, -15)} 100%)`, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.rock(k(.01, .6, -15)), 'repeat-x', 'auto 24%', '0 100%'),
      }
    },
  },

  alpine: {
    label: 'alpine', luminance: false, basePeriod: 24,
    legacy: ['#ffaf5f', '#87d7ff', '#ff5f87'],
    build(k) {
      // Ridges are the blue-grey of distance under any sky.
      const near = ridge(RIDGE_NEAR_STEPS, RIDGE_NEAR_W, 14, k.to(.18, .27, NIGHT, .85), '#ffffff')
      const far = ridge(RIDGE_FAR_STEPS, RIDGE_FAR_W, 20, k.to(.38, .25, NIGHT, .85), '#ffffff')
      const haze = k(.84)
      return {
        layers: [
          L(near.url, 'repeat-x', `${near.w}px 40%`, '0 100%', `-${near.w}px 100%`),
          L(far.url, 'repeat-x', `${far.w}px 62%`, '0 100%', `-${far.w}px 100%`),
          // a cloud line hanging at the far ridge's shoulders
          L(`linear-gradient(90deg,transparent 0%,${haze}40 35%,${haze}66 50%,${haze}40 65%,transparent 100%)`,
            'no-repeat', '220% 22%', '200% 48%', '-100% 48%'),
          L(`linear-gradient(0deg,${k(.69)} 0%,${k.to(.61, .6, NIGHT, .2)} 22%,${k.to(.45, .2, NIGHT, .9)} 55%,${k.to(.17, .35, NIGHT, 1)} 100%)`, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.pines(k.to(.06, .33, NIGHT, .9)), 'repeat-x', 'auto 30%', '0 100%'),
      }
    },
  },

  swamp: {
    label: 'swamp', luminance: false, basePeriod: 18,
    legacy: ['#87ff5f', '#5fd7ff', '#ffff5f'],
    build(k) {
      const wisp = k.tint, sil = k(.05, .4, 20), water = k(.07, .45, 30)
      return {
        layers: [
          L(SIL.reeds(sil), 'repeat-x', 'auto 60%', '0 100%', '0 100%'),
          // a will-o'-the-wisp wandering behind the reeds
          L(`radial-gradient(22% 60% at 50% 60%,${wisp}66 0%,${wisp}22 45%,transparent 70%)`,
            'no-repeat', '140% 100%', '-60% 0', '160% 0'),
          L(`linear-gradient(0deg,${water} 0%,${water} 60%,transparent 100%)`, 'no-repeat', '100% 22%', '0 100%'),
          L(`linear-gradient(90deg,transparent 0%,${sil}66 40%,${sil}88 50%,${sil}66 60%,transparent 100%)`,
            'no-repeat', '220% 40%', '200% 70%', '-100% 70%'),
          L(`linear-gradient(0deg,${k(.27, .4)} 0%,${k(.14, .35)} 35%,${k(.07, .3)} 75%,${k(.03, .25)} 100%)`, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.reeds(k(.02, .35)), 'repeat-x', 'auto 28%', '0 100%'),
      }
    },
  },

  castle: {
    label: 'castle', luminance: false, basePeriod: 26,
    legacy: ['#5f87ff', '#d70000', '#ffaf87'],
    build(k) {
      const keep = cityDeck(CASTLE_STEPS, CASTLE_W, 24, k(.06, .4), '#ffd75f')
      const near = cloudDeck(CLOUD_NEAR_STEPS, CLOUD_NEAR_W, k(.18, .4), '1')
      const far = cloudDeck(CLOUD_FAR_STEPS, CLOUD_FAR_W, k(.16, .45), '.9')
      const moon = k(.93)
      return {
        layers: [
          L(keep.url, 'repeat-x', `${keep.w}px 70%`, '0 100%', '0 100%'),
          L(near.url, 'repeat-x', `${near.w}px 40%`, '0 0', `-${near.w}px 0`),
          L(far.url, 'repeat-x', `${far.w}px 30%`, '0 0', `-${far.w}px 0`),
          L(`radial-gradient(circle at 70% 18%,${moon} 0 3px,${moon}44 3.5px 7px,transparent 12px)`, 'no-repeat', '100% 100%', '0 0'),
          L(`linear-gradient(0deg,${k(.27, .4)} 0%,${k(.18, .42)} 40%,${k(.1, .44)} 75%,${k(.05, .43)} 100%)`, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.wall(k(.04, .6)), 'repeat-x', 'auto 24%', '0 100%'),
      }
    },
  },

  moon: {
    label: 'moon', luminance: false, basePeriod: 30,
    legacy: ['#5fafff', '#87d7ff', '#ffd7af'],
    build(k) {
      // The tint is the earth in the sky; the regolith takes only a cast of it.
      const ground = band(MOON_STEPS, MOON_W, 14, k(.37, .25), '1', craters(k(.19, .3)))
      const earthB = k(.33, .65)
      return {
        layers: [
          L(ground.url, 'repeat-x', `${ground.w}px 44%`, '0 100%', '0 100%'),
          // earthrise: a lit disc at the upper right, half above the plate
          L(`radial-gradient(circle at 80% 0%,${k.tint} 0 3px,${earthB} 3.5px 6px,${earthB}44 6.5px 7px,transparent 7.5px)`, 'no-repeat', '100% 100%', '0 0'),
          L('radial-gradient(circle,#ffffffcc 0 .5px,transparent 1px)', 'repeat', '17px 13px', '0 0', '-17px 0'),
          L('radial-gradient(circle,#ffffff66 0 .5px,transparent 1px)', 'repeat', '23px 19px', '5px 7px', '-18px 7px'),
          L(`linear-gradient(0deg,${k(.04, .3)} 0%,${k(.02, .3)} 100%)`, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.rocks(k(.15, .25)), 'repeat-x', 'auto 20%', '0 100%'),
      }
    },
  },

  circuit: {
    // No foreground: a board has nothing standing on it.
    label: 'circuit', luminance: false, basePeriod: 4,
    legacy: ['#00ff5f', '#00afff', '#ffb000'],
    build(k) {
      const c = k.tint
      return {
        layers: [
          // two signals racing the traces in opposite directions
          L(`linear-gradient(90deg,transparent 0%,${c} 50%,transparent 100%)`, 'no-repeat', '40% 1px', '-40% 6px', '140% 6px'),
          L(`linear-gradient(90deg,transparent 0%,${c} 50%,transparent 100%)`, 'no-repeat', '40% 1px', '140% 18px', '-40% 18px'),
          L(`radial-gradient(circle,${c}55 0 .7px,transparent 1.1px)`, 'repeat', '18px 12px', '4px 3px'),
          L(`repeating-linear-gradient(0deg,${c}22 0 1px,transparent 1px 6px)`, 'repeat', '100% auto', '0 0'),
          L(`repeating-linear-gradient(90deg,${c}22 0 1px,transparent 1px 9px)`, 'repeat', 'auto 100%', '0 0'),
          L(`linear-gradient(${k(.06, .65)},${k(.04, .7)})`, 'no-repeat', '100% 100%', '0 0'),
        ],
      }
    },
  },

  eclipse: {
    // No foreground. The corona breathes, so this is the second alternating
    // plate (with furnace) — and like it, never hosts a far-weather plane.
    label: 'eclipse', luminance: true, basePeriod: 6,
    legacy: ['#ffd7af', '#ff5f5f', '#af87ff'],
    build(k, hash) {
      const cv = `--hsb-${hash}`
      const corona = k.tint
      return {
        layers: [
          L(`radial-gradient(circle at 50% 50%,#000000 0 6px,var(${cv}) 6.5px 8px,transparent 13px)`, 'no-repeat', '100% 100%', '0 0'),
          L('radial-gradient(circle,#ffffff99 0 .5px,transparent 1px)', 'repeat', '19px 15px', '3px 2px'),
          L(`linear-gradient(${k(.02, .45)},#000000)`, 'no-repeat', '100% 100%', '0 0'),
        ],
        alternate: true,
        props: `@property ${cv}{syntax:"<color>";initial-value:${corona}88;inherits:false;}`,
        keyframesBody: `{from{${cv}:${corona}66;}to{${cv}:${corona}cc;}}`,
      }
    },
  },

  arcade: {
    // No foreground: the floor IS the ground. Same construction as outrun —
    // the ceiling is an opaque top box over a floor that scrolls sideways one
    // tile per loop.
    label: 'arcade', luminance: false, basePeriod: 2,
    legacy: ['#ff40af', '#00e5ff', '#ffd700'],
    build(k) {
      const c = k.tint, c1 = k(.1, .72), c2 = k(.18, .68)
      return {
        layers: [
          L(`repeating-linear-gradient(90deg,${c} 0 3px,transparent 3px 7px)`, 'repeat-x', '7px 2px', '0 10%', '-7px 10%'),
          L(`linear-gradient(180deg,${c1} 0%,${c1} 100%)`, 'no-repeat', '100% 60%', '0 0'),
          L(`radial-gradient(80% 40% at 50% 60%,${c}55 0%,transparent 70%)`, 'no-repeat', '100% 100%', '0 0'),
          L(`repeating-conic-gradient(${c1} 0 25%,${c2} 0 50%)`, 'repeat', '8px 8px', '0 0', '-8px 0'),
          L(`linear-gradient(${k(.07, .75)},${c2})`, 'no-repeat', '100% 100%', '0 0'),
        ],
      }
    },
  },

  bamboo: {
    label: 'bamboo', luminance: false, basePeriod: 20,
    legacy: ['#5faf5f', '#5f87af', '#d7af87'],
    build(k) {
      const haze = k(.92)
      return {
        layers: [
          L(SIL.bamboo(k(.07, .45)), 'repeat-x', 'auto 100%', '0 0', '0 0'),
          L(`linear-gradient(90deg,transparent 0%,${haze}30 35%,${haze}4a 50%,${haze}30 65%,transparent 100%)`,
            'no-repeat', '220% 50%', '-100% 40%', '200% 40%'),
          L(`linear-gradient(0deg,${k(.45, .2)} 0%,${k(.3, .25)} 35%,${k(.15, .27)} 75%,${k(.07, .3)} 100%)`, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.grass(k(.03, .45)), 'repeat-x', 'auto 24%', '0 100%'),
      }
    },
  },

  giza: {
    label: 'pyramids', luminance: false, basePeriod: 22,
    legacy: ['#ff8700', '#5f87ff', '#d7af5f'],
    build(k) {
      const sun = k(.69, 1, 15), haze = k(.84)
      return {
        layers: [
          L(SIL.pyramids(k(.1, .65)), 'repeat-x', 'auto 70%', '0 100%', '0 100%'),
          L(`radial-gradient(circle at 74% 70%,${sun} 0 3px,${sun}44 3.5px 7px,transparent 10px)`, 'no-repeat', '100% 100%', '0 0'),
          L(`linear-gradient(90deg,transparent 0%,${haze}38 35%,${haze}55 50%,${haze}38 65%,transparent 100%)`,
            'no-repeat', '220% 40%', '200% 90%', '-100% 90%'),
          L(`linear-gradient(0deg,${k(.5)} 0%,${k.to(.46, .5, NIGHT, .2)} 28%,${k.to(.28, .35, NIGHT, .65)} 62%,${k.to(.19, .35, NIGHT, 1)} 100%)`, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.dunes(k(.03, .65)), 'repeat-x', 'auto 26%', '0 100%'),
      }
    },
  },

}

// ── weather catalog ─────────────────────────────────────────────────────────
//
// near(): layers for the FRONT pseudo, painted over the name. Falling and
// rising weathers are two copies of one pixel tile at 1x and 1.4x, advancing
// exactly one own-tile-height per loop — different distances in the same
// duration = parallax, seamless by construction.
//
// far(): ONE tile for the BACK pseudo, painted over the plate but under the
// name, so the same weather passes behind the letters as well as in front of
// them. It rides the BACKDROP's clock (a pseudo gets one background-position
// animation and the plate already owns it), so the compiler gives it a whole
// number of tile-heights per backdrop loop — seamless at any ratio. That is
// the entire depth trick: no extra element, no extra animation, and the name
// ends up inside the weather instead of under it.
//
// Particles are the tint verbatim — weather carries no text, so there is no
// ladder to hold, and a dark pick is simply a dim fall.

// Two copies of one tile, 1x and 1.4x, each advancing one own-tile per loop;
// `dir` is the axis sign (falling +y, rising -y), `sway` the optional
// mid-loop x offsets of the two copies.
function fallLayers(t, dir, sway) {
  const w2 = Math.round(t.w * 1.4), h2 = Math.round(t.h * 1.4)
  const mid = (x, h) => sway ? `${x}px ${dir * Math.round(h / 2)}px` : undefined
  return [
    L(t.url, 'repeat', `${t.w}px ${t.h}px`, '0 0', `0 ${dir * t.h}px`, sway && mid(sway[0], t.h)),
    L(t.url, 'repeat', `${w2}px ${h2}px`, '0 0', `0 ${dir * h2}px`, sway && mid(sway[1], h2)),
  ]
}
const triad = (k) => ({ c1: k.tint, c2: k(k.l, 1, 120), c3: k(k.l, 1, 240) })
const farPlane = (t, dir, opacity) => ({
  img: t.url, size: `${Math.round(t.w * 0.7)}px ${Math.round(t.h * 0.7)}px`, tile: dir * Math.round(t.h * 0.7), opacity,
})

const WEATHERS = {
  rain: {
    label: 'rain', luminance: false, basePeriod: 0.9,
    legacy: ['#9db4c9', '#d70000', '#87ff00'],
    near(k, density) {
      return { layers: fallLayers(rainTile(k.tint, density), 1) }
    },
    far(k, density) {
      // Smaller and dimmer than the near plane — that is what distance is.
      return farPlane(rainTile(k.tint, Math.min(3, density + 1)), 1, '.5')
    },
  },

  snow: {
    label: 'snow', luminance: false, basePeriod: 4.5,
    legacy: ['#ffffff', '#9e9e9e', '#ffd75f'],
    near(k, density) {
      return { layers: fallLayers(snowTile(k.tint, density), 1, [2, -3]) }
    },
    far(k, density) {
      return farPlane(snowTile(k.tint, Math.min(3, density + 1)), 1, '.55')
    },
  },

  fog: {
    // behindText, and the ONE weather with no far plane and no foreground:
    // fog IS the depth cue. It is an ambient volume, not particles — in front
    // it washes the name out on bright plates — so it takes the space between
    // the plate and the name, which is exactly where a foreground silhouette
    // would also want to be.
    label: 'fog (behind the name)', luminance: false, basePeriod: 16, behindText: true,
    legacy: ['#ffaf87', '#c0c8d0', '#87ff5f'],
    near(k, density) {
      const c = k.tint
      const a = density >= 3 ? ['80', '4d'] : density === 2 ? ['66', '38'] : ['40', '26']
      return {
        layers: [
          L(`radial-gradient(55% 130% at 50% 60%,${c}${a[0]} 0%,${c}${a[1]} 45%,transparent 72%)`,
            'no-repeat', '160% 100%', '-60% 40%', '160% 40%'),
          L(`radial-gradient(65% 150% at 50% 40%,${c}${a[1]} 0%,transparent 70%)`,
            'no-repeat', '200% 100%', '160% 70%', '-60% 70%'),
        ],
        alternate: true,
      }
    },
  },

  embers: {
    label: 'embers', luminance: false, basePeriod: 3.2,
    legacy: ['#ff8700', '#00d7ff', '#ff40af'],
    // The hot core of each ember is the tint lifted a step toward white.
    near(k, density) {
      return { layers: fallLayers(emberTile(k.tint, k(k.l + .2), density), -1, [2, -2]) }
    },
    far(k, density) {
      return farPlane(emberTile(k.tint, k(k.l + .2), Math.min(3, density + 1)), -1, '.6')
    },
  },

  glyphs: {
    label: 'glyph rain', luminance: false, basePeriod: 2.6,
    legacy: ['#00ff87', '#ffb000', '#00e5ff'],
    near(k, density) {
      const t = glyphTile(k.tint, density)
      const w2 = Math.round(t.w * 1.5), h2 = Math.round(t.h * 1.5)
      return {
        layers: [
          L(t.url, 'repeat', `${t.w}px ${t.h}px`, '0 0', `0 ${t.h}px`),
          L(t.url, 'repeat', `${w2}px ${h2}px`, '7px 0', `7px ${h2}px`),
        ],
      }
    },
    far(k, density) {
      return farPlane(glyphTile(k.tint, Math.min(3, density + 1)), 1, '.5')
    },
  },

  storm: {
    label: 'storm', luminance: true, basePeriod: 7,
    legacy: ['#9db4c9', '#d70000', '#87ff00'],
    near(k, density, hash, speed) {
      // Rain layers + a lightning wash carried by a registered <color> var —
      // a separate animation on a separate property, so it comma-lists next to
      // the rain's background-position loop without clobbering it. Two pops
      // inside a ~120ms window every cycle: far under the 3-flash/s WCAG line
      // even at max speed (the period floor is luminance-clamped below).
      const cv = `--hsw-${hash}`
      return {
        layers: [
          L(`linear-gradient(var(${cv}),var(${cv}))`, 'no-repeat', '100% 100%', '0 0'),
          ...fallLayers(rainTile(k.tint, density), 1),
        ],
        props: `@property ${cv}{syntax:"<color>";initial-value:#e8f4ff00;inherits:false;}`,
        keyframesBody: `{0%,82%,100%{${cv}:#e8f4ff00;}84%{${cv}:#e8f4ff4d;}86%{${cv}:#e8f4ff10;}88.5%{${cv}:#e8f4ff38;}91%{${cv}:#e8f4ff00;}}`,
        // The positional loop runs on the RAIN's clock, not the storm's, and
        // the compiler owns its keyframes — so prepending a foreground layer
        // extends both lists together.
        positionalAnim: { period: periodSeconds(WEATHERS.rain.basePeriod, speed, false), timing: 'linear' },
      }
    },
    far(k, density) {
      return farPlane(rainTile(k.tint, Math.min(3, density + 1)), 1, '.5')
    },
  },

  petals: {
    label: 'petals', luminance: false, basePeriod: 3.8,
    legacy: ['#ffafd7', '#ffffff', '#ffd75f'],
    near(k, density) {
      return { layers: fallLayers(petalTile(k.tint, density), 1, [4, -5]) }
    },
    far(k, density) {
      return farPlane(petalTile(k.tint, Math.min(3, density + 1)), 1, '.55')
    },
  },

  bubbles: {
    label: 'bubbles', luminance: false, basePeriod: 4,
    legacy: ['#ffffff', '#87ffd7', '#d7afff'],
    near(k, density) {
      return { layers: fallLayers(bubbleTile(k.tint, density), -1, [2, -3]) }
    },
    far(k, density) {
      return farPlane(bubbleTile(k.tint, Math.min(3, density + 1)), -1, '.5')
    },
  },

  fireflies: {
    label: 'fireflies', luminance: false, basePeriod: 6,
    legacy: ['#d7ff5f', '#ffd75f', '#87ffff'],
    near(k, density) {
      return { layers: fallLayers(fireflyTile(k.tint, density), -1, [5, -6]) }
    },
    far(k, density) {
      return farPlane(fireflyTile(k.tint, Math.min(3, density + 1)), -1, '.5')
    },
  },

  leaves: {
    label: 'leaves', luminance: false, basePeriod: 4.2,
    legacy: ['#ff8700', '#d70000', '#87ff5f'],
    near(k, density) {
      return { layers: fallLayers(leafTile(k.tint, density), 1, [5, -6]) }
    },
    far(k, density) {
      return farPlane(leafTile(k.tint, Math.min(3, density + 1)), 1, '.55')
    },
  },

  sparks: {
    label: 'sparks', luminance: false, basePeriod: 1.2,
    legacy: ['#ffffff', '#ffd75f', '#87d7ff'],
    near(k, density) {
      const t = sparkTile(k.tint, density)
      const w2 = Math.round(t.w * 1.4), h2 = Math.round(t.h * 1.4)
      return {
        layers: [
          L(t.url, 'repeat', `${t.w}px ${t.h}px`, '0 0', `0 -${t.h}px`),
          L(t.url, 'repeat', `${w2}px ${h2}px`, '3px 0', `3px -${h2}px`),
        ],
      }
    },
    far(k, density) {
      return farPlane(sparkTile(k.tint, Math.min(3, density + 1)), -1, '.5')
    },
  },

  dust: {
    // Sideways: the one weather that blows rather than falls or rises.
    label: 'dust', luminance: false, basePeriod: 5,
    legacy: ['#d7af87', '#9e9e9e', '#ffd75f'],
    near(k, density) {
      const t = dustTile(k.tint, density)
      const w2 = Math.round(t.w * 1.4), h2 = Math.round(t.h * 1.4)
      return {
        layers: [
          L(t.url, 'repeat', `${t.w}px ${t.h}px`, '0 0', `-${t.w}px 0`, `-${Math.round(t.w / 2)}px 1px`),
          L(t.url, 'repeat', `${w2}px ${h2}px`, '0 0', `-${w2}px 0`, `-${Math.round(w2 / 2)}px -1px`),
        ],
      }
    },
  },

  confetti: {
    label: 'confetti', luminance: false, basePeriod: 4,
    legacy: ['#ff5f87', '#ffffff', '#ff8700'],
    // A triad off the tint: the pick, and the two colours a third of the
    // wheel away from it.
    near(k, density) {
      return { layers: fallLayers(confettiTile(triad(k), density), 1, [4, -5]) }
    },
    far(k, density) {
      return farPlane(confettiTile(triad(k), Math.min(3, density + 1)), 1, '.55')
    },
  },

  meteors: {
    // Diagonal: each loop advances one tile in BOTH axes, so it wraps clean.
    label: 'meteors', luminance: false, basePeriod: 1.6,
    legacy: ['#ffffff', '#ffd75f', '#87ffff'],
    near(k, density) {
      const t = meteorTile(k.tint, density)
      const w2 = Math.round(t.w * 1.4), h2 = Math.round(t.h * 1.4)
      return {
        layers: [
          L(t.url, 'repeat', `${t.w}px ${t.h}px`, '0 0', `-${t.w}px ${t.h}px`),
          L(t.url, 'repeat', `${w2}px ${h2}px`, '9px 0', `${9 - w2}px ${h2}px`),
        ],
      }
    },
  },

  hearts: {
    label: 'hearts', luminance: false, basePeriod: 4.4,
    legacy: ['#ff5fd7', '#ff0000', '#ffffff'],
    near(k, density) {
      return { layers: fallLayers(heartTile(k.tint, density), -1, [3, -4]) }
    },
    far(k, density) {
      return farPlane(heartTile(k.tint, Math.min(3, density + 1)), -1, '.5')
    },
  },

}

const BACKDROP_IDS = new Set(Object.keys(BACKDROPS))
const WEATHER_IDS = new Set(Object.keys(WEATHERS))

// ── validation (called from validatePaintSpec — pushes into its errors) ────

// `tint` is any #rrggbb; `variant` is the retired numbered form, still read
// through the entry's `legacy` list so a saved scene never stops rendering.
function validateTint(layer, meta, path, errors) {
  if (layer.tint !== undefined && !(typeof layer.tint === 'string' && HEX_RE.test(layer.tint))) {
    errors.push(`${path}.tint must match #rrggbb`)
  }
  if (layer.variant !== undefined && !isIntInRange(layer.variant, 0, meta.legacy.length - 1)) {
    errors.push(`${path}.variant out of range`)
  }
}

/** The colour a scene layer is drawn in: its tint, else its legacy variant's,
 * else the entry's default. Never a user string that failed HEX_RE. */
export function sceneTint(meta, layer) {
  if (typeof layer?.tint === 'string' && HEX_RE.test(layer.tint)) return layer.tint.toLowerCase()
  const i = layer?.variant
  return meta.legacy[isIntInRange(i, 0, meta.legacy.length - 1) ? i : 0]
}

/** A scene with every layer's colour spelled out as `tint` and the retired
 * `variant` dropped — what the builder edits. Unknown ids pass through. */
export function resolveSceneTints(scene) {
  if (!isPlainObject(scene)) return scene
  const fix = (layer, catalog) => {
    if (!isPlainObject(layer) || !catalog[layer.id]) return layer
    const { variant, ...rest } = layer
    return { ...rest, tint: sceneTint(catalog[layer.id], layer) }
  }
  return { ...scene, backdrop: fix(scene.backdrop, BACKDROPS), weather: fix(scene.weather, WEATHERS) }
}

export function validateSceneSpec(scene, errors) {
  if (!isPlainObject(scene)) {
    errors.push('scene must be null or an object')
    return
  }
  const backdrop = scene.backdrop ?? null
  const weather = scene.weather ?? null
  if (backdrop === null && weather === null) {
    errors.push('scene must include a backdrop or weather (or be null)')
    return
  }
  if (weather !== null && backdrop === null) {
    // A particle layer over the bare row background has no contrast ground —
    // the plate IS what guarantees the composition reads on any theme.
    errors.push('scene.weather requires a scene.backdrop')
  }
  if (backdrop !== null) {
    if (!isPlainObject(backdrop) || !BACKDROP_IDS.has(backdrop.id)) {
      errors.push(`scene.backdrop.id unknown: ${JSON.stringify(backdrop?.id)}`)
    } else {
      validateTint(backdrop, BACKDROPS[backdrop.id], 'scene.backdrop', errors)
      if (backdrop.speed !== undefined && !isNumInRange(backdrop.speed, MIN_SPEED, MAX_SPEED)) {
        errors.push(`scene.backdrop.speed must be a number ${MIN_SPEED}-${MAX_SPEED}`)
      }
    }
  }
  if (weather !== null) {
    if (!isPlainObject(weather) || !WEATHER_IDS.has(weather.id)) {
      errors.push(`scene.weather.id unknown: ${JSON.stringify(weather?.id)}`)
    } else {
      validateTint(weather, WEATHERS[weather.id], 'scene.weather', errors)
      if (weather.density !== undefined && !DENSITIES.has(weather.density)) {
        errors.push('scene.weather.density must be 1, 2 or 3')
      }
      if (weather.speed !== undefined && !isNumInRange(weather.speed, MIN_SPEED, MAX_SPEED)) {
        errors.push(`scene.weather.speed must be a number ${MIN_SPEED}-${MAX_SPEED}`)
      }
    }
  }
}

/** Deterministic scene block for hashPaintSpec's normalized form. */
export function normalizeSceneForHash(scene) {
  if (!isPlainObject(scene)) return null
  return {
    backdrop: isPlainObject(scene.backdrop) && BACKDROPS[scene.backdrop.id]
      ? { id: scene.backdrop.id, tint: sceneTint(BACKDROPS[scene.backdrop.id], scene.backdrop), speed: scene.backdrop.speed ?? 1 }
      : null,
    weather: isPlainObject(scene.weather) && WEATHERS[scene.weather.id]
      ? { id: scene.weather.id, tint: sceneTint(WEATHERS[scene.weather.id], scene.weather), density: scene.weather.density ?? 2, speed: scene.weather.speed ?? 1 }
      : null,
  }
}

// ── compiler ────────────────────────────────────────────────────────────────

/**
 * Emit one pseudo-element rule from a layer list.
 *
 * `anims` is a list of { name, period, timing, alternate, body } — `body` null
 * means "positional", and those keyframes are generated HERE from the same
 * layer array the shorthand came from, which is what makes the two lists
 * impossible to disagree about.
 */
function pseudoRule(selector, pseudo, zIndex, layers, anims, isStatic) {
  let css = `${selector}::${pseudo}{${PSEUDO_BASE}z-index:${zIndex};background:${layers.map(layerCss).join(',')};`
  let keyframes = ''
  if (!isStatic && anims.length) {
    const names = [], delays = []
    for (const a of anims) {
      const dir = a.alternate ? ' alternate' : ''
      names.push(`${a.name} ${a.period}s ${a.alternate ? 'ease-in-out' : a.timing || 'linear'} infinite${dir}`)
      delays.push(syncDelayCalc(a.alternate ? a.period * 2 : a.period))
      keyframes += a.body ? `@keyframes ${a.name}${a.body}` : positionalKeyframes(a.name, layers)
    }
    css += `animation:${names.join(',')};animation-delay:${delays.join(',')};`
  }
  return css + '}' + keyframes
}

/**
 * Compile a scene block to CSS scoped under `selector`.
 *
 * The stack it builds, back to front, is the whole point:
 *
 *   ::before   sky → clouds/rays → far silhouette → FAR WEATHER
 *   (text)     the name
 *   ::after    NEAR WEATHER → foreground silhouette
 *
 * so the same rain falls behind the letters as well as across them, and a
 * near gravestone stands in front of their descenders. Seven planes around a
 * 13px name, out of two pseudo-elements and no extra DOM, because both planes
 * are just background-layer lists and a pseudo can carry as many as it likes.
 *
 * The far plane rides the BACKDROP's clock (one background-position animation
 * per element, and the plate already owns it), so it is given a whole number
 * of tile-heights per backdrop loop — seamless at any ratio, and it lands at
 * roughly the weather's own apparent speed.
 *
 * Same defense-in-depth contract as compilePaintCss: assumes validation
 * passed, but unknown ids are silently skipped and every number re-clamped —
 * an unvalidated spec cannot inject anything (the only user string that reaches
 * the output is a tint, and only after it matched HEX_RE).
 * @param {object} scene
 * @param {string} selector
 * @param {string} hash - hashPaintSpec(spec) of the OWNING spec
 * @param {{ static?: boolean }} [opts] - static drops all animation; the
 *   resting positions are each scene's designed hero frame.
 * @returns {string} css
 */
export function buildSceneCss(scene, selector, hash, opts = {}) {
  if (!isPlainObject(scene) || typeof selector !== 'string' || !selector) return ''
  const backdrop = isPlainObject(scene.backdrop) && BACKDROP_IDS.has(scene.backdrop.id) ? scene.backdrop : null
  const weather = isPlainObject(scene.weather) && WEATHER_IDS.has(scene.weather.id) ? scene.weather : null
  if (!backdrop && !weather) return ''
  const isStatic = !!opts.static

  // The plate needs the element to anchor absolutely-positioned pseudos and to
  // fence ::before's z-index:-1 inside its own stacking context (so the
  // backdrop can sit behind the text but never behind the chat row).
  let css = `${selector}{position:relative;isolation:isolate;}`

  const bMeta = backdrop ? BACKDROPS[backdrop.id] : null
  const bBuilt = bMeta ? bMeta.build(tintKit(sceneTint(bMeta, backdrop)), hash) : null
  const bPeriod = bMeta ? periodSeconds(bMeta.basePeriod, backdrop.speed ?? 1, bMeta.luminance) : 0

  const wMeta = weather ? WEATHERS[weather.id] : null
  const wDensity = weather && DENSITIES.has(weather.density) ? weather.density : 2
  const wSpeed = weather ? safeSpeed(weather.speed ?? 1) : 1
  const wKit = wMeta ? tintKit(sceneTint(wMeta, weather)) : null
  const wBuilt = wMeta ? wMeta.near(wKit, wDensity, hash, wSpeed) : null
  const wPeriod = wMeta ? periodSeconds(wMeta.basePeriod, wSpeed, wMeta.luminance) : 0

  // ── back pseudo: the plate, plus the far weather plane on top of it ──
  if (bBuilt) {
    const layers = [...bBuilt.layers]
    if (wMeta?.far && !wMeta.behindText) {
      const far = wMeta.far(wKit, wDensity)
      // The far plane rides the plate's own loop, so it is given a whole
      // number of tile-heights per backdrop period: seamless at any ratio,
      // and it lands at roughly the weather's apparent speed.
      //
      // Held STILL on a plate whose loop alternates (furnace, whose underglow
      // breathes) — rain running backwards is not rain. A still far plane is
      // still depth, which is why this drops the motion rather than the layer.
      // Static mode keeps it for the same reason: the resting frame is the
      // composition, and a composition missing a plane is a different picture.
      const cycles = Math.max(1, Math.round(bPeriod / Math.max(0.2, wPeriod)))
      const travel = bBuilt.alternate || isStatic ? '0 0' : `0 ${far.tile * cycles}px`
      layers.unshift(L(far.img, 'repeat', far.size, '0 0', travel))
    }
    const anims = []
    if (!isStatic) {
      anims.push({
        name: `hss_${hash}_b`, period: bPeriod, timing: 'linear',
        alternate: !!bBuilt.alternate, body: bBuilt.keyframesBody || null,
      })
    }
    // The @property registration is NOT animation — it is what gives the
    // plate's `var()` a value at all. Dropping it in static mode made the whole
    // background shorthand invalid at computed-value time, so furnace and
    // eclipse rendered as nothing on every static surface (chips, SSR,
    // reduced-motion) instead of at their resting glow.
    css += bBuilt.props || ''
    css += pseudoRule(selector, 'before', -1, layers, anims, isStatic)
  }

  // ── front pseudo: near weather, and the foreground silhouette over it ──
  // fog is the exception on both counts: it is an ambient volume that belongs
  // BEHIND the name, which is the same slot a foreground would want.
  const frontLayers = []
  const frontAnims = []
  const fgLayer = bBuilt && !wMeta?.behindText ? bBuilt.fg : null
  if (fgLayer) frontLayers.push(fgLayer)
  if (wBuilt) {
    frontLayers.push(...wBuilt.layers)
    if (!isStatic) {
      frontAnims.push({
        name: `hss_${hash}_w`, period: wPeriod,
        timing: 'linear', alternate: !!wBuilt.alternate,
        body: wBuilt.keyframesBody || null,
      })
      if (wBuilt.positionalAnim) {
        frontAnims.push({
          name: `hss_${hash}_wr`, period: wBuilt.positionalAnim.period,
          timing: wBuilt.positionalAnim.timing, alternate: false, body: null,
        })
      }
    }
  }
  if (frontLayers.length) {
    css += wBuilt?.props || ''
    css += pseudoRule(selector, 'after', wMeta?.behindText ? -1 : 1, frontLayers, frontAnims, isStatic)
  }

  return css
}

/** True if this scene block should add the legibility rim (the caller skips
 * it when the user's own glow/neon already halos the text). */
export function sceneHasBackdrop(scene) {
  return isPlainObject(scene) && isPlainObject(scene.backdrop) && BACKDROP_IDS.has(scene.backdrop.id)
}

/** Dark text rim — uniform across all plates (every backdrop is designed
 * mid-to-dark specifically so ONE rim rule guarantees legibility). */
export const SCENE_RIM_CSS = 'text-shadow:0 1px 1px #000d,0 0 2px #000a;'

/**
 * The same rim for a fill that text-shadow cannot reach.
 *
 * With `background-clip:text` the glyph colour IS the element's background and
 * the text itself is transparent, so a text-shadow paints in FRONT of the fill
 * and smothers it — which is why gradient and effect-filled names used to get
 * no rim at all, and were left to fend for themselves on whatever plate they
 * sat on. A `drop-shadow()` filter is built from the element's rendered ALPHA,
 * so on a clip-text fill it traces the glyph outline and paints behind it.
 *
 * This is what lets the plates stay free: a name that clears the 3:1 floor
 * against the chat background clears it against its own dark edge too, on any
 * backdrop, without the catalog having to police which colour may sit on which
 * sky.
 */
export const SCENE_RIM_FILTER_CSS = 'filter:drop-shadow(0 1px 1px #000d) drop-shadow(0 0 2px #000a);'

// ── builder-UI metadata (labels + the tint a fresh pick starts from) ──────
//
// No colour CSS leaves here any more: a scene's colour is the user's tint, and
// the builder's palette is the picker. `tint` is the entry's default.

export const SCENE_BACKDROPS_META = Object.fromEntries(
  Object.entries(BACKDROPS).map(([id, m]) => [id, { label: m.label, tint: m.legacy[0] }]))

export const SCENE_WEATHERS_META = Object.fromEntries(
  Object.entries(WEATHERS).map(([id, m]) => [id, { label: m.label, tint: m.legacy[0] }]))

export { BACKDROP_IDS as SCENE_BACKDROP_IDS, WEATHER_IDS as SCENE_WEATHER_IDS }

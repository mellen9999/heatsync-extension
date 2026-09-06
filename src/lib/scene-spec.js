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
  isPlainObject, isIntInRange, isNumInRange,
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

// ── backdrop catalog ────────────────────────────────────────────────────────
//
// build() returns { layers, alternate?, props?, keyframesBody?, fg? }.
// `layers` is back-to-front LAST-to-FIRST, exactly like the CSS shorthand:
// the first entry paints on top. `fg` is a single NEAR layer, painted in the
// front pseudo over the name. Backgrounds never escape the pseudo's box — no
// clipping, no overflow, no layout impact. Every plate is deliberately
// mid-to-dark so the shared text rim (see paint-spec.js) guarantees legibility
// on all of them.

const BACKDROPS = {
  dawn: {
    label: 'desert dawn', luminance: false, basePeriod: 16,
    variants: [
      { name: 'ember', sky: 'linear-gradient(0deg,#ff8700 0%,#b34700 22%,#6e3a52 55%,#3a2f55 82%,#23233f 100%)', haze: '#ffd7af', bloom: '#ffaf5f', sil: '#140a02', fg: '#0a0501' },
      { name: 'rose', sky: 'linear-gradient(0deg,#ff5f87 0%,#a03562 26%,#5f2d55 60%,#2e2345 100%)', haze: '#ffc7d7', bloom: '#ff87af', sil: '#170812', fg: '#0c0409' },
      { name: 'gold', sky: 'linear-gradient(0deg,#ffd700 0%,#af7800 24%,#5f4a3a 58%,#39304a 100%)', haze: '#fff3b0', bloom: '#ffe75f', sil: '#141002', fg: '#0a0801' },
    ],
    build(v) {
      return {
        layers: [
          L(SIL.dunes(v.sil), 'repeat-x', 'auto 42%', '0 100%', '0 100%'),
          L(`linear-gradient(90deg,transparent 0%,${v.haze}38 35%,${v.haze}55 50%,${v.haze}38 65%,transparent 100%)`,
            'no-repeat', '220% 58%', '200% 78%', '-100% 78%'),
          L(`radial-gradient(90% 90% at 50% 108%,${v.bloom}66 0%,${v.bloom}22 40%,transparent 70%)`, 'no-repeat', '100% 100%', '0 0'),
          L(v.sky, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.dunes(v.fg), 'repeat-x', 'auto 26%', '0 100%'),
      }
    },
  },

  graveyard: {
    // Overcast by construction: the sky is brightest at the horizon (the glow
    // the clouds are lit from) and darkest at the top, where two blocky cloud
    // decks hang down over it.
    label: 'graveyard', luminance: false, basePeriod: 22,
    variants: [
      // Sky runs bright at the horizon (0% is the BOTTOM at 0deg) to near-black
      // at the top; the decks are LIGHTER than that top, because an overcast
      // lid lit from below by the same glow is what you actually see at night.
      { name: 'ash', sky: 'linear-gradient(0deg,#2e2e36 0%,#22222a 40%,#15151a 75%,#0e0e13 100%)', near: '#33333d', far: '#292933', moon: '#c6c6d2', sil: '#08080a', fg: '#000000' },
      { name: 'blood', sky: 'linear-gradient(0deg,#4a2428 0%,#301a1e 40%,#1c1114 75%,#120b0d 100%)', near: '#3d2126', far: '#33191e', moon: '#e0a0a0', sil: '#0a0608', fg: '#000000' },
      { name: 'moonlit', sky: 'linear-gradient(0deg,#33435f 0%,#222d44 40%,#141c2b 75%,#0d1220 100%)', near: '#2b3750', far: '#232e44', moon: '#dce8ff', sil: '#060810', fg: '#000105' },
    ],
    build(v) {
      const near = cloudDeck(CLOUD_NEAR_STEPS, CLOUD_NEAR_W, v.near, '1')
      const far = cloudDeck(CLOUD_FAR_STEPS, CLOUD_FAR_W, v.far, '.9')
      return {
        layers: [
          L(SIL.graveyard(v.sil), 'repeat-x', 'auto 52%', '0 100%', '0 100%'),
          // Each deck advances exactly one own-tile width per loop — seamless
          // by construction, and the different widths ARE the parallax.
          L(near.url, 'repeat-x', `${near.w}px 58%`, '0 0', `-${near.w}px 0`),
          L(far.url, 'repeat-x', `${far.w}px 44%`, '0 0', `-${far.w}px 0`),
          L(`radial-gradient(45% 75% at 62% 6%,${v.moon}2e 0%,transparent 68%)`, 'no-repeat', '100% 100%', '0 0'),
          L(v.sky, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.graveyard(v.fg), 'repeat-x', 'auto 30%', '0 100%'),
      }
    },
  },

  abyss: {
    label: 'abyss', luminance: false, basePeriod: 18,
    variants: [
      { name: 'blue', sky: 'linear-gradient(180deg,#00344e 0%,#001d2e 45%,#000a12 100%)', ray: '#00d7ff', sil: '#010508', fg: '#000103' },
      { name: 'teal', sky: 'linear-gradient(180deg,#00443b 0%,#00251f 45%,#000d0a 100%)', ray: '#00ffd7', sil: '#010806', fg: '#000302' },
      { name: 'void', sky: 'linear-gradient(180deg,#1e0f38 0%,#100822 45%,#05030e 100%)', ray: '#875fff', sil: '#040208', fg: '#020004' },
    ],
    build(v) {
      return {
        layers: [
          L(SIL.reef(v.sil), 'repeat-x', 'auto 26%', '0 100%', '0 100%'),
          L(`linear-gradient(104deg,transparent 30%,${v.ray}14 42%,transparent 50%,${v.ray}0e 62%,transparent 72%)`,
            'no-repeat', '260% 100%', '-90% 0', '190% 0'),
          L(`radial-gradient(80% 60% at 50% -10%,${v.ray}20 0%,transparent 60%)`, 'no-repeat', '100% 100%', '0 0'),
          L(v.sky, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.reef(v.fg), 'repeat-x', 'auto 22%', '0 100%'),
      }
    },
  },

  nightfall: {
    label: 'nightfall', luminance: false, basePeriod: 20,
    variants: [
      { name: 'aurora', sky: 'linear-gradient(0deg,#0a0a16 0%,#12122a 55%,#0a0a18 100%)', a1: '#00ff87', a2: '#00d7ff', sil: '#04040a', fg: '#000004' },
      { name: 'magenta', sky: 'linear-gradient(0deg,#120a16 0%,#1c122a 55%,#100a18 100%)', a1: '#ff40af', a2: '#875fff', sil: '#08040a', fg: '#030004' },
      { name: 'ice', sky: 'linear-gradient(0deg,#0a0e16 0%,#101a2a 55%,#0a0e18 100%)', a1: '#87d7ff', a2: '#d7ffff', sil: '#04060c', fg: '#000206' },
    ],
    build(v) {
      return {
        layers: [
          L(SIL.pines(v.sil), 'repeat-x', 'auto 46%', '0 100%', '0 100%'),
          L(`linear-gradient(100deg,transparent 15%,${v.a1}30 35%,${v.a2}2e 50%,${v.a1}24 62%,transparent 82%)`,
            'no-repeat', '240% 90%', '-90% 0', '190% 0'),
          L('radial-gradient(circle,#ffffffcc 0 .5px,transparent 1px)', 'repeat', '17px 13px', '0 0'),
          L('radial-gradient(circle,#ffffff66 0 .5px,transparent 1px)', 'repeat', '23px 19px', '5px 7px'),
          L(v.sky, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.pines(v.fg), 'repeat-x', 'auto 30%', '0 100%'),
      }
    },
  },

  terminal: {
    // No foreground: a CRT has no landscape to stand in front of.
    label: 'terminal', luminance: false, basePeriod: 9,
    variants: [
      { name: 'phosphor', ph: '#00ff5f', plate: 'linear-gradient(#0c0c0c,#060606)' },
      { name: 'amber', ph: '#ffb000', plate: 'linear-gradient(#0e0a04,#070502)' },
      { name: 'paper', ph: '#c0c0c0', plate: 'linear-gradient(#101010,#0a0a0a)' },
    ],
    build(v) {
      return {
        layers: [
          L(`linear-gradient(0deg,transparent 38%,${v.ph}16 50%,transparent 62%)`, 'no-repeat', '100% 300%', '0 0', '0 100%'),
          L(`repeating-linear-gradient(0deg,${v.ph}0d 0 1px,transparent 1px 3px)`, 'repeat', '100% auto', '0 0'),
          L(v.plate, 'no-repeat', '100% 100%', '0 0'),
        ],
      }
    },
  },

  furnace: {
    label: 'furnace', luminance: true, basePeriod: 5,
    variants: [
      { name: 'coal', glow: '#ff3700', plate: 'linear-gradient(0deg,#1c0300 0%,#0d0202 55%,#050505 100%)' },
      { name: 'ion', glow: '#00afff', plate: 'linear-gradient(0deg,#001030 0%,#020818 55%,#040404 100%)' },
      { name: 'hex', glow: '#af5fff', plate: 'linear-gradient(0deg,#14001c 0%,#0a0212 55%,#050505 100%)' },
    ],
    build(v, hash) {
      // Registered <color> custom prop so the underglow's alpha itself
      // interpolates (background-position can't express a breathe). The var is
      // hash-namespaced like conic's angle prop — no cross-user collision.
      // This is the one backdrop whose loop ALTERNATES, which is also why it
      // never hosts a far-weather plane: rain running backwards is not rain.
      const cv = `--hsb-${hash}`
      return {
        layers: [
          L(`radial-gradient(120% 90% at 50% 115%,var(${cv}) 0%,transparent 65%)`, 'no-repeat', '100% 100%', '0 0'),
          L(v.plate, 'no-repeat', '100% 100%', '0 0'),
        ],
        alternate: true,
        props: `@property ${cv}{syntax:"<color>";initial-value:${v.glow}66;inherits:false;}`,
        keyframesBody: `{from{${cv}:${v.glow}55;}to{${cv}:${v.glow}a8;}}`,
      }
    },
  },
  ocean: {
    label: 'open sea', luminance: false, basePeriod: 14,
    variants: [
      { name: 'sunset', sky: 'linear-gradient(0deg,#ff8700 0%,#c04a3a 24%,#6a2e5a 58%,#26203f 100%)', water: '#0d3a4a', far: '#164e60', bloom: '#ffb05f', glit: '#ffd7af', fg: '#061a22' },
      { name: 'midnight', sky: 'linear-gradient(0deg,#1e3a6e 0%,#10224a 40%,#080f24 100%)', water: '#06182a', far: '#0b2438', bloom: '#c8d8ff', glit: '#e8f0ff', fg: '#030b14' },
      { name: 'tropic', sky: 'linear-gradient(0deg,#00d7ff 0%,#0090c0 30%,#2a4a8a 70%,#1c2450 100%)', water: '#00485a', far: '#006070', bloom: '#ffffff', glit: '#d7ffff', fg: '#002a34' },
    ],
    build(v) {
      const near = band(SWELL_NEAR_STEPS, SWELL_NEAR_W, 12, v.water, '1')
      const far = band(SWELL_FAR_STEPS, SWELL_FAR_W, 16, v.far, '1')
      return {
        layers: [
          // Swells advance one own-tile per loop, opposite directions — the
          // near one faster because its tile is narrower. Seamless by construction.
          L(near.url, 'repeat-x', `${near.w}px 34%`, '0 100%', `-${near.w}px 100%`),
          L(far.url, 'repeat-x', `${far.w}px 46%`, '0 100%', `${far.w}px 100%`),
          // Sun path glitter — a broken line on the water that walks with the swell.
          L(`repeating-linear-gradient(90deg,transparent 0 3px,${v.glit}66 3px 4px,transparent 4px 7px)`, 'repeat-x', '100% 8%', '0 60%', '7px 60%'),
          L(`radial-gradient(70% 70% at 50% 62%,${v.bloom}88 0%,${v.bloom}22 35%,transparent 60%)`, 'no-repeat', '100% 100%', '0 0'),
          L(v.sky, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.swell(v.fg), 'repeat-x', 'auto 22%', '0 100%'),
      }
    },
  },

  skyline: {
    label: 'city night', luminance: false, basePeriod: 26,
    variants: [
      { name: 'neon', sky: 'linear-gradient(0deg,#3a1050 0%,#1a0a2e 40%,#0a0616 100%)', glow: '#ff40af', win: '#00e5ff', near: '#0a0612', far: '#1c1030', fg: '#05030a' },
      { name: 'sodium', sky: 'linear-gradient(0deg,#2a1a08 0%,#120a04 45%,#070402 100%)', glow: '#ff8700', win: '#ffb000', near: '#0c0804', far: '#1f1408', fg: '#050302' },
      { name: 'dusk', sky: 'linear-gradient(0deg,#2c3a6e 0%,#182040 45%,#0a0e1e 100%)', glow: '#ff87af', win: '#ffd75f', near: '#0a0c18', far: '#1a2040', fg: '#04050c' },
    ],
    build(v) {
      const near = cityDeck(CITY_NEAR_STEPS, CITY_NEAR_W, 24, v.near, v.win)
      const far = cityDeck(CITY_FAR_STEPS, CITY_FAR_W, 24, v.far, v.win)
      return {
        layers: [
          L(near.url, 'repeat-x', `${near.w}px 78%`, '0 100%', `-${near.w}px 100%`),
          L(far.url, 'repeat-x', `${far.w}px 60%`, '0 100%', `-${far.w}px 100%`),
          L(`radial-gradient(80% 60% at 50% 100%,${v.glow}40 0%,${v.glow}14 40%,transparent 70%)`, 'no-repeat', '100% 100%', '0 0'),
          L(v.sky, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.roof(v.fg), 'repeat-x', 'auto 30%', '0 100%'),
      }
    },
  },

  orbit: {
    // No foreground: nothing stands in front of a name in orbit.
    label: 'orbit', luminance: false, basePeriod: 30,
    variants: [
      { name: 'mars', sky: 'linear-gradient(0deg,#160a0a 0%,#08050a 100%)', planet: '#7a2e14', rim: '#ff875f', neb: '#ff5f00' },
      { name: 'nebula', sky: 'linear-gradient(0deg,#100a1c 0%,#05040c 100%)', planet: '#1e1440', rim: '#af5fff', neb: '#d787ff' },
      { name: 'ice', sky: 'linear-gradient(0deg,#08121c 0%,#04070c 100%)', planet: '#0e2a3a', rim: '#87d7ff', neb: '#00d7ff' },
    ],
    build(v) {
      return {
        layers: [
          // A curved horizon with a lit rim — the planet is below the plate,
          // only its limb shows.
          L(`radial-gradient(160% 110% at 50% 168%,${v.planet} 0 44%,${v.rim}99 45%,transparent 50%)`, 'no-repeat', '100% 100%', '0 0'),
          // Star fields drift one own-tile per loop — seamless, and the two
          // tile widths are the parallax.
          L('radial-gradient(circle,#ffffffcc 0 .5px,transparent 1px)', 'repeat', '17px 13px', '0 0', '-17px 0'),
          L('radial-gradient(circle,#ffffff66 0 .5px,transparent 1px)', 'repeat', '23px 19px', '5px 7px', '-18px 7px'),
          L(`linear-gradient(100deg,transparent 20%,${v.neb}26 40%,${v.neb}14 52%,transparent 70%)`, 'no-repeat', '240% 100%', '-90% 0', '190% 0'),
          L(v.sky, 'no-repeat', '100% 100%', '0 0'),
        ],
      }
    },
  },

  synth: {
    // No foreground: the grid IS the ground.
    label: 'outrun', luminance: false, basePeriod: 1.4,
    variants: [
      { name: 'magenta', sun: '#ff40af', skyA: '#12041e', skyB: '#3a0c46', line: '#ff5fd7', floor: '#180830' },
      { name: 'cyan', sun: '#00e5ff', skyA: '#04101e', skyB: '#0a2a46', line: '#00d7ff', floor: '#061a30' },
      { name: 'gold', sun: '#ffd700', skyA: '#1a0a04', skyB: '#4a1e08', line: '#ffaf00', floor: '#241004' },
    ],
    build(v) {
      return {
        layers: [
          // Sun + sky in ONE opaque top box: the disc is centred on the box's
          // bottom edge, so the horizon cuts it in half, and the box hides the
          // 5px the grid overlaps past the horizon (below) while it scrolls.
          L(`radial-gradient(circle at 50% 100%,${v.sun} 0 5px,${v.skyB} 5.5px 14px,${v.skyA} 100%)`, 'no-repeat', '100% 54%', '0 0'),
          // Horizontal grid lines roll toward the viewer: one 5px period per
          // loop, seamless. The box is 5px taller than the floor so a line is
          // never missing at the top mid-scroll.
          L(`repeating-linear-gradient(0deg,${v.line}cc 0 1px,transparent 1px 5px)`, 'repeat', '100% calc(46% + 5px)', '0 100%', '0 calc(100% + 5px)'),
          L(`repeating-linear-gradient(90deg,${v.line}55 0 1px,transparent 1px 9px)`, 'no-repeat', '100% 46%', '0 100%'),
          L(`linear-gradient(180deg,${v.floor} 0%,#000000 100%)`, 'no-repeat', '100% 46%', '0 100%'),
          L('linear-gradient(#000000,#000000)', 'no-repeat', '100% 100%', '0 0'),
        ],
      }
    },
  },

  glacier: {
    label: 'glacier', luminance: false, basePeriod: 28,
    variants: [
      { name: 'polar', sky: 'linear-gradient(0deg,#5a7a9a 0%,#2c4560 35%,#131c2c 100%)', ice: '#3a6a8a', far: '#2a4a66', bloom: '#dff3ff', haze: '#c0e0ff', fg: '#1a3448' },
      { name: 'dusk', sky: 'linear-gradient(0deg,#8a4a6e 0%,#3c2a52 40%,#141224 100%)', ice: '#4a4a7a', far: '#36305a', bloom: '#ffb0d0', haze: '#ffc0e0', fg: '#221a3a' },
      { name: 'night', sky: 'linear-gradient(0deg,#1c3a4a 0%,#0c1e2c 40%,#050a12 100%)', ice: '#1e4a5e', far: '#163a4a', bloom: '#87ffd7', haze: '#5fd7c0', fg: '#0a2430' },
    ],
    build(v) {
      const near = band(ICE_NEAR_STEPS, ICE_NEAR_W, 10, v.ice, '1')
      const far = band(ICE_FAR_STEPS, ICE_FAR_W, 14, v.far, '1')
      return {
        layers: [
          L(near.url, 'repeat-x', `${near.w}px 32%`, '0 100%', `-${near.w}px 100%`),
          L(far.url, 'repeat-x', `${far.w}px 48%`, '0 100%', `-${far.w}px 100%`),
          L(`linear-gradient(90deg,transparent 0%,${v.haze}30 35%,${v.haze}4a 50%,${v.haze}30 65%,transparent 100%)`,
            'no-repeat', '220% 40%', '200% 60%', '-100% 60%'),
          L(`radial-gradient(60% 60% at 50% 70%,${v.bloom}55 0%,${v.bloom}18 40%,transparent 65%)`, 'no-repeat', '100% 100%', '0 0'),
          L(v.sky, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.ice(v.fg), 'repeat-x', 'auto 22%', '0 100%'),
      }
    },
  },

  sakura: {
    label: 'sakura', luminance: false, basePeriod: 20,
    variants: [
      { name: 'blossom', sky: 'linear-gradient(0deg,#ffafd7 0%,#d76e9e 30%,#6a3a6e 65%,#2e1f44 100%)', bloom: '#ffd7e8', sil: '#1a0a14', haze: '#ffd7e8', fg: '#0e0509' },
      { name: 'dusk', sky: 'linear-gradient(0deg,#ff87af 0%,#8a3a7a 32%,#3a2058 66%,#181030 100%)', bloom: '#ffafd7', sil: '#140812', haze: '#d7afff', fg: '#0a040a' },
      { name: 'night', sky: 'linear-gradient(0deg,#3a2050 0%,#1c1030 45%,#0a0818 100%)', bloom: '#ff87c0', sil: '#06040a', haze: '#ffafd7', fg: '#030204' },
    ],
    build(v) {
      return {
        layers: [
          L(SIL.sakura(v.sil, v.bloom), 'repeat-x', 'auto 62%', '0 100%', '0 100%'),
          L(`linear-gradient(90deg,transparent 0%,${v.haze}2e 35%,${v.haze}44 50%,${v.haze}2e 65%,transparent 100%)`,
            'no-repeat', '220% 50%', '-100% 30%', '200% 30%'),
          L(`radial-gradient(50% 60% at 30% 20%,${v.bloom}55 0%,transparent 65%)`, 'no-repeat', '100% 100%', '0 0'),
          L(v.sky, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.sakura(v.fg), 'repeat-x', 'auto 22%', '0 100%'),
      }
    },
  },

  volcano: {
    label: 'volcano', luminance: false, basePeriod: 12,
    variants: [
      { name: 'magma', sky: 'linear-gradient(0deg,#5f0000 0%,#2a0505 30%,#100404 70%,#080303 100%)', lava: '#ff5f00', hot: '#ffaf00', sil: '#0d0404', fg: '#050101' },
      { name: 'sulfur', sky: 'linear-gradient(0deg,#5f4a00 0%,#2a2005 30%,#121006 70%,#080704 100%)', lava: '#ffd700', hot: '#ffff5f', sil: '#0d0a02', fg: '#050400' },
      { name: 'hex', sky: 'linear-gradient(0deg,#3a0a5f 0%,#1c0830 30%,#0c0416 70%,#060208 100%)', lava: '#af5fff', hot: '#d7afff', sil: '#08040d', fg: '#030105' },
    ],
    build(v) {
      const peaks = band(PEAK_STEPS, PEAK_W, 24, v.sil, '1', lavaCracks(v.lava))
      return {
        layers: [
          L(peaks.url, 'repeat-x', `${peaks.w}px 58%`, '0 100%', '0 100%'),
          // ash drifting across the slopes
          L(`linear-gradient(90deg,transparent 0%,${v.sil}99 40%,${v.sil}bb 50%,${v.sil}99 60%,transparent 100%)`,
            'no-repeat', '220% 36%', '-100% 30%', '200% 30%'),
          L(`radial-gradient(80% 70% at 50% 110%,${v.lava}77 0%,${v.lava}22 40%,transparent 70%)`, 'no-repeat', '100% 100%', '0 0'),
          L(v.sky, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.rock(v.fg), 'repeat-x', 'auto 24%', '0 100%'),
      }
    },
  },

  alpine: {
    label: 'alpine', luminance: false, basePeriod: 24,
    variants: [
      { name: 'sunrise', sky: 'linear-gradient(0deg,#ffaf5f 0%,#d75f5f 22%,#5f5f87 55%,#1c1c3a 100%)', far: '#4a4a7a', near: '#22223a', cap: '#ffffff', haze: '#ffd7af', fg: '#0a0a14' },
      { name: 'day', sky: 'linear-gradient(0deg,#87d7ff 0%,#5fafd7 30%,#1c5f8a 70%,#0c2a4a 100%)', far: '#3a6a8a', near: '#1c3a52', cap: '#ffffff', haze: '#d7ffff', fg: '#081420' },
      { name: 'dusk', sky: 'linear-gradient(0deg,#ff5f87 0%,#8a3a6e 28%,#3a2a5f 62%,#12102a 100%)', far: '#4a3a6e', near: '#221a3a', cap: '#ffd7ff', haze: '#ffafd7', fg: '#0a0614' },
    ],
    build(v) {
      const near = ridge(RIDGE_NEAR_STEPS, RIDGE_NEAR_W, 14, v.near, v.cap)
      const far = ridge(RIDGE_FAR_STEPS, RIDGE_FAR_W, 20, v.far, v.cap)
      return {
        layers: [
          L(near.url, 'repeat-x', `${near.w}px 40%`, '0 100%', `-${near.w}px 100%`),
          L(far.url, 'repeat-x', `${far.w}px 62%`, '0 100%', `-${far.w}px 100%`),
          // a cloud line hanging at the far ridge's shoulders
          L(`linear-gradient(90deg,transparent 0%,${v.haze}40 35%,${v.haze}66 50%,${v.haze}40 65%,transparent 100%)`,
            'no-repeat', '220% 22%', '200% 48%', '-100% 48%'),
          L(v.sky, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.pines(v.fg), 'repeat-x', 'auto 30%', '0 100%'),
      }
    },
  },

  swamp: {
    label: 'swamp', luminance: false, basePeriod: 18,
    variants: [
      { name: 'bog', sky: 'linear-gradient(0deg,#3a5f2a 0%,#1c3018 35%,#0c160c 75%,#060a06 100%)', water: '#0a1a10', wisp: '#87ff5f', sil: '#08120a', fg: '#030603' },
      { name: 'blackwater', sky: 'linear-gradient(0deg,#2a3a5f 0%,#141c30 35%,#0a0e18 75%,#050708 100%)', water: '#080e1a', wisp: '#5fd7ff', sil: '#060a12', fg: '#020306' },
      { name: 'sulfur', sky: 'linear-gradient(0deg,#5f5f1c 0%,#30300c 35%,#161606 75%,#0a0a04 100%)', water: '#14140a', wisp: '#ffff5f', sil: '#101006', fg: '#050502' },
    ],
    build(v) {
      return {
        layers: [
          L(SIL.reeds(v.sil), 'repeat-x', 'auto 60%', '0 100%', '0 100%'),
          // a will-o'-the-wisp wandering behind the reeds
          L(`radial-gradient(22% 60% at 50% 60%,${v.wisp}66 0%,${v.wisp}22 45%,transparent 70%)`,
            'no-repeat', '140% 100%', '-60% 0', '160% 0'),
          L(`linear-gradient(0deg,${v.water} 0%,${v.water} 60%,transparent 100%)`, 'no-repeat', '100% 22%', '0 100%'),
          L(`linear-gradient(90deg,transparent 0%,${v.sil}66 40%,${v.sil}88 50%,${v.sil}66 60%,transparent 100%)`,
            'no-repeat', '220% 40%', '200% 70%', '-100% 70%'),
          L(v.sky, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.reeds(v.fg), 'repeat-x', 'auto 28%', '0 100%'),
      }
    },
  },

  castle: {
    label: 'castle', luminance: false, basePeriod: 26,
    variants: [
      { name: 'moonlit', sky: 'linear-gradient(0deg,#2c3a5f 0%,#1a2240 40%,#0e1224 75%,#080a14 100%)', wall: '#0a0c16', win: '#ffd75f', near: '#1c2440', far: '#16203a', moon: '#dce8ff', fg: '#040610' },
      { name: 'blood', sky: 'linear-gradient(0deg,#5f1c24 0%,#361018 40%,#1c0a0e 75%,#0e0508 100%)', wall: '#100608', win: '#ff8700', near: '#3a1820', far: '#2e1218', moon: '#ff8787', fg: '#060203' },
      { name: 'dawn', sky: 'linear-gradient(0deg,#ffaf87 0%,#af5f6e 30%,#4a3a5f 65%,#1c1a30 100%)', wall: '#14101c', win: '#ffd7af', near: '#3a2e4a', far: '#2c2440', moon: '#fff3d7', fg: '#08060c' },
    ],
    build(v) {
      const keep = cityDeck(CASTLE_STEPS, CASTLE_W, 24, v.wall, v.win)
      const near = cloudDeck(CLOUD_NEAR_STEPS, CLOUD_NEAR_W, v.near, '1')
      const far = cloudDeck(CLOUD_FAR_STEPS, CLOUD_FAR_W, v.far, '.9')
      return {
        layers: [
          L(keep.url, 'repeat-x', `${keep.w}px 70%`, '0 100%', '0 100%'),
          L(near.url, 'repeat-x', `${near.w}px 40%`, '0 0', `-${near.w}px 0`),
          L(far.url, 'repeat-x', `${far.w}px 30%`, '0 0', `-${far.w}px 0`),
          L(`radial-gradient(circle at 70% 18%,${v.moon} 0 3px,${v.moon}44 3.5px 7px,transparent 12px)`, 'no-repeat', '100% 100%', '0 0'),
          L(v.sky, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.wall(v.fg), 'repeat-x', 'auto 24%', '0 100%'),
      }
    },
  },

  moon: {
    label: 'moon', luminance: false, basePeriod: 30,
    variants: [
      { name: 'regolith', sky: 'linear-gradient(0deg,#0a0a0c 0%,#040406 100%)', ground: '#5f5f5f', crater: '#303030', earth: '#5fafff', earthB: '#1c5f8a', fg: '#262626' },
      { name: 'blue hour', sky: 'linear-gradient(0deg,#0a1020 0%,#04060c 100%)', ground: '#4a5a7a', crater: '#26304a', earth: '#87d7ff', earthB: '#2a6ab0', fg: '#1c2436' },
      { name: 'sepia', sky: 'linear-gradient(0deg,#140e08 0%,#080604 100%)', ground: '#7a6a4a', crater: '#3a3020', earth: '#ffd7af', earthB: '#af7a4a', fg: '#302818' },
    ],
    build(v) {
      const ground = band(MOON_STEPS, MOON_W, 14, v.ground, '1', craters(v.crater))
      return {
        layers: [
          L(ground.url, 'repeat-x', `${ground.w}px 44%`, '0 100%', '0 100%'),
          // earthrise: a lit disc at the upper right, half above the plate
          L(`radial-gradient(circle at 80% 0%,${v.earth} 0 3px,${v.earthB} 3.5px 6px,${v.earthB}44 6.5px 7px,transparent 7.5px)`, 'no-repeat', '100% 100%', '0 0'),
          L('radial-gradient(circle,#ffffffcc 0 .5px,transparent 1px)', 'repeat', '17px 13px', '0 0', '-17px 0'),
          L('radial-gradient(circle,#ffffff66 0 .5px,transparent 1px)', 'repeat', '23px 19px', '5px 7px', '-18px 7px'),
          L(v.sky, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.rocks(v.fg), 'repeat-x', 'auto 20%', '0 100%'),
      }
    },
  },

  circuit: {
    // No foreground: a board has nothing standing on it.
    label: 'circuit', luminance: false, basePeriod: 4,
    variants: [
      { name: 'green', c: '#00ff5f', plate: 'linear-gradient(#061a0c,#03100a)' },
      { name: 'blue', c: '#00afff', plate: 'linear-gradient(#04101c,#020a14)' },
      { name: 'amber', c: '#ffb000', plate: 'linear-gradient(#1a1204,#100a02)' },
    ],
    build(v) {
      return {
        layers: [
          // two signals racing the traces in opposite directions
          L(`linear-gradient(90deg,transparent 0%,${v.c} 50%,transparent 100%)`, 'no-repeat', '40% 1px', '-40% 6px', '140% 6px'),
          L(`linear-gradient(90deg,transparent 0%,${v.c} 50%,transparent 100%)`, 'no-repeat', '40% 1px', '140% 18px', '-40% 18px'),
          L(`radial-gradient(circle,${v.c}55 0 .7px,transparent 1.1px)`, 'repeat', '18px 12px', '4px 3px'),
          L(`repeating-linear-gradient(0deg,${v.c}22 0 1px,transparent 1px 6px)`, 'repeat', '100% auto', '0 0'),
          L(`repeating-linear-gradient(90deg,${v.c}22 0 1px,transparent 1px 9px)`, 'repeat', 'auto 100%', '0 0'),
          L(v.plate, 'no-repeat', '100% 100%', '0 0'),
        ],
      }
    },
  },

  eclipse: {
    // No foreground. The corona breathes, so this is the second alternating
    // plate (with furnace) — and like it, never hosts a far-weather plane.
    label: 'eclipse', luminance: true, basePeriod: 6,
    variants: [
      { name: 'solar', corona: '#ffd7af', plate: 'linear-gradient(#050505,#000000)' },
      { name: 'blood', corona: '#ff5f5f', plate: 'linear-gradient(#080303,#000000)' },
      { name: 'void', corona: '#af87ff', plate: 'linear-gradient(#050308,#000000)' },
    ],
    build(v, hash) {
      const cv = `--hsb-${hash}`
      return {
        layers: [
          L(`radial-gradient(circle at 50% 50%,#000000 0 6px,var(${cv}) 6.5px 8px,transparent 13px)`, 'no-repeat', '100% 100%', '0 0'),
          L('radial-gradient(circle,#ffffff99 0 .5px,transparent 1px)', 'repeat', '19px 15px', '3px 2px'),
          L(v.plate, 'no-repeat', '100% 100%', '0 0'),
        ],
        alternate: true,
        props: `@property ${cv}{syntax:"<color>";initial-value:${v.corona}88;inherits:false;}`,
        keyframesBody: `{from{${cv}:${v.corona}66;}to{${cv}:${v.corona}cc;}}`,
      }
    },
  },

  arcade: {
    // No foreground: the floor IS the ground. Same construction as outrun —
    // the ceiling is an opaque top box over a floor that scrolls sideways one
    // tile per loop.
    label: 'arcade', luminance: false, basePeriod: 2,
    variants: [
      { name: 'magenta', c: '#ff40af', c1: '#1c0830', c2: '#3a1050', plate: 'linear-gradient(#12041e,#3a1050)' },
      { name: 'cyan', c: '#00e5ff', c1: '#04101e', c2: '#0a2a46', plate: 'linear-gradient(#04101e,#0a2a46)' },
      { name: 'yellow', c: '#ffd700', c1: '#1a1204', c2: '#3a2a08', plate: 'linear-gradient(#1a1204,#3a2a08)' },
    ],
    build(v) {
      return {
        layers: [
          L(`repeating-linear-gradient(90deg,${v.c} 0 3px,transparent 3px 7px)`, 'repeat-x', '7px 2px', '0 10%', '-7px 10%'),
          L(`linear-gradient(180deg,${v.c1} 0%,${v.c1} 100%)`, 'no-repeat', '100% 60%', '0 0'),
          L(`radial-gradient(80% 40% at 50% 60%,${v.c}55 0%,transparent 70%)`, 'no-repeat', '100% 100%', '0 0'),
          L(`repeating-conic-gradient(${v.c1} 0 25%,${v.c2} 0 50%)`, 'repeat', '8px 8px', '0 0', '-8px 0'),
          L(v.plate, 'no-repeat', '100% 100%', '0 0'),
        ],
      }
    },
  },

  bamboo: {
    label: 'bamboo', luminance: false, basePeriod: 20,
    variants: [
      { name: 'grove', sky: 'linear-gradient(0deg,#5f875f 0%,#3a5f3a 35%,#1c301c 75%,#0c160c 100%)', sil: '#0a1a0a', haze: '#d7ffd7', fg: '#040a04' },
      { name: 'mist', sky: 'linear-gradient(0deg,#5f7a87 0%,#3a4a5f 35%,#1c2430 75%,#0c1016 100%)', sil: '#0a1216', haze: '#d7e4ff', fg: '#040608' },
      { name: 'dusk', sky: 'linear-gradient(0deg,#af875f 0%,#6e4a3a 35%,#30221c 75%,#16100c 100%)', sil: '#160c08', haze: '#ffd7af', fg: '#080402' },
    ],
    build(v) {
      return {
        layers: [
          L(SIL.bamboo(v.sil), 'repeat-x', 'auto 100%', '0 0', '0 0'),
          L(`linear-gradient(90deg,transparent 0%,${v.haze}30 35%,${v.haze}4a 50%,${v.haze}30 65%,transparent 100%)`,
            'no-repeat', '220% 50%', '-100% 40%', '200% 40%'),
          L(v.sky, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.grass(v.fg), 'repeat-x', 'auto 24%', '0 100%'),
      }
    },
  },

  giza: {
    label: 'pyramids', luminance: false, basePeriod: 22,
    variants: [
      { name: 'dusk', sky: 'linear-gradient(0deg,#ff8700 0%,#af4a3a 28%,#5f2e5a 62%,#26203f 100%)', sun: '#ffd75f', sil: '#2a1408', haze: '#ffd7af', fg: '#0e0803' },
      { name: 'night', sky: 'linear-gradient(0deg,#1c2a5f 0%,#101a40 40%,#080c20 100%)', sun: '#dce8ff', sil: '#0a0e1c', haze: '#afc0ff', fg: '#04060c' },
      { name: 'sandstorm', sky: 'linear-gradient(0deg,#d7a05f 0%,#a0703a 35%,#5f4a30 70%,#302418 100%)', sun: '#fff3b0', sil: '#3a2410', haze: '#ffd7af', fg: '#120a04' },
    ],
    build(v) {
      return {
        layers: [
          L(SIL.pyramids(v.sil), 'repeat-x', 'auto 70%', '0 100%', '0 100%'),
          L(`radial-gradient(circle at 74% 70%,${v.sun} 0 3px,${v.sun}44 3.5px 7px,transparent 10px)`, 'no-repeat', '100% 100%', '0 0'),
          L(`linear-gradient(90deg,transparent 0%,${v.haze}38 35%,${v.haze}55 50%,${v.haze}38 65%,transparent 100%)`,
            'no-repeat', '220% 40%', '200% 90%', '-100% 90%'),
          L(v.sky, 'no-repeat', '100% 100%', '0 0'),
        ],
        fg: L(FG.dunes(v.fg), 'repeat-x', 'auto 26%', '0 100%'),
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

const WEATHERS = {
  rain: {
    label: 'rain', luminance: false, basePeriod: 0.9,
    variants: [
      { name: 'silver', c: '#9db4c9' },
      { name: 'blood', c: '#d70000' },
      { name: 'acid', c: '#87ff00' },
    ],
    near(v, density) {
      const t = rainTile(v.c, density)
      const w2 = Math.round(t.w * 1.4), h2 = Math.round(t.h * 1.4)
      return {
        layers: [
          L(t.url, 'repeat', `${t.w}px ${t.h}px`, '0 0', `0 ${t.h}px`),
          L(t.url, 'repeat', `${w2}px ${h2}px`, '0 0', `0 ${h2}px`),
        ],
      }
    },
    far(v, density) {
      // Smaller and dimmer than the near plane — that is what distance is.
      const t = rainTile(v.c, Math.min(3, density + 1))
      return { img: t.url, size: `${Math.round(t.w * 0.7)}px ${Math.round(t.h * 0.7)}px`, tile: Math.round(t.h * 0.7), opacity: '.5' }
    },
  },

  snow: {
    label: 'snow', luminance: false, basePeriod: 4.5,
    variants: [
      { name: 'white', c: '#ffffff' },
      { name: 'ash', c: '#9e9e9e' },
      { name: 'gold', c: '#ffd75f' },
    ],
    near(v, density) {
      const t = snowTile(v.c, density)
      const w2 = Math.round(t.w * 1.4), h2 = Math.round(t.h * 1.4)
      return {
        layers: [
          L(t.url, 'repeat', `${t.w}px ${t.h}px`, '0 0', `0 ${t.h}px`, `2px ${Math.round(t.h / 2)}px`),
          L(t.url, 'repeat', `${w2}px ${h2}px`, '0 0', `0 ${h2}px`, `-3px ${Math.round(h2 / 2)}px`),
        ],
      }
    },
    far(v, density) {
      const t = snowTile(v.c, Math.min(3, density + 1))
      return { img: t.url, size: `${Math.round(t.w * 0.7)}px ${Math.round(t.h * 0.7)}px`, tile: Math.round(t.h * 0.7), opacity: '.55' }
    },
  },

  fog: {
    // behindText, and the ONE weather with no far plane and no foreground:
    // fog IS the depth cue. It is an ambient volume, not particles — in front
    // it washes the name out on bright plates — so it takes the space between
    // the plate and the name, which is exactly where a foreground silhouette
    // would also want to be.
    label: 'fog (behind the name)', luminance: false, basePeriod: 16, behindText: true,
    variants: [
      // sunglow used to be #ffd7af — the exact hex of the desert-dawn plate's
      // own haze band, so the most obvious pairing in the catalog rendered a
      // fog bank that was invisible by construction.
      { name: 'sunglow', c: '#ffaf87' },
      { name: 'mist', c: '#c0c8d0' },
      { name: 'miasma', c: '#87ff5f' },
    ],
    near(v, density) {
      const a = density >= 3 ? ['80', '4d'] : density === 2 ? ['66', '38'] : ['40', '26']
      return {
        layers: [
          L(`radial-gradient(55% 130% at 50% 60%,${v.c}${a[0]} 0%,${v.c}${a[1]} 45%,transparent 72%)`,
            'no-repeat', '160% 100%', '-60% 40%', '160% 40%'),
          L(`radial-gradient(65% 150% at 50% 40%,${v.c}${a[1]} 0%,transparent 70%)`,
            'no-repeat', '200% 100%', '160% 70%', '-60% 70%'),
        ],
        alternate: true,
      }
    },
  },

  embers: {
    label: 'embers', luminance: false, basePeriod: 3.2,
    variants: [
      { name: 'fire', c1: '#ff8700', c2: '#ffd700' },
      { name: 'ion', c1: '#00d7ff', c2: '#87ffff' },
      { name: 'rose', c1: '#ff40af', c2: '#ff87d7' },
    ],
    near(v, density) {
      const t = emberTile(v.c1, v.c2, density)
      const w2 = Math.round(t.w * 1.4), h2 = Math.round(t.h * 1.4)
      return {
        layers: [
          L(t.url, 'repeat', `${t.w}px ${t.h}px`, '0 0', `0 -${t.h}px`, `2px -${Math.round(t.h / 2)}px`),
          L(t.url, 'repeat', `${w2}px ${h2}px`, '0 0', `0 -${h2}px`, `-2px -${Math.round(h2 / 2)}px`),
        ],
      }
    },
    far(v, density) {
      const t = emberTile(v.c1, v.c2, Math.min(3, density + 1))
      return { img: t.url, size: `${Math.round(t.w * 0.7)}px ${Math.round(t.h * 0.7)}px`, tile: -Math.round(t.h * 0.7), opacity: '.6' }
    },
  },

  glyphs: {
    label: 'glyph rain', luminance: false, basePeriod: 2.6,
    variants: [
      { name: 'green', c: '#00ff87' },
      { name: 'amber', c: '#ffb000' },
      { name: 'cyan', c: '#00e5ff' },
    ],
    near(v, density) {
      const t = glyphTile(v.c, density)
      const w2 = Math.round(t.w * 1.5), h2 = Math.round(t.h * 1.5)
      return {
        layers: [
          L(t.url, 'repeat', `${t.w}px ${t.h}px`, '0 0', `0 ${t.h}px`),
          L(t.url, 'repeat', `${w2}px ${h2}px`, '7px 0', `7px ${h2}px`),
        ],
      }
    },
    far(v, density) {
      const t = glyphTile(v.c, Math.min(3, density + 1))
      return { img: t.url, size: `${Math.round(t.w * 0.7)}px ${Math.round(t.h * 0.7)}px`, tile: Math.round(t.h * 0.7), opacity: '.5' }
    },
  },

  storm: {
    label: 'storm', luminance: true, basePeriod: 7,
    variants: [
      { name: 'silver', c: '#9db4c9' },
      { name: 'blood', c: '#d70000' },
      { name: 'acid', c: '#87ff00' },
    ],
    near(v, density, hash, speed) {
      // Rain layers + a lightning wash carried by a registered <color> var —
      // a separate animation on a separate property, so it comma-lists next to
      // the rain's background-position loop without clobbering it. Two pops
      // inside a ~120ms window every cycle: far under the 3-flash/s WCAG line
      // even at max speed (the period floor is luminance-clamped below).
      const t = rainTile(v.c, density)
      const w2 = Math.round(t.w * 1.4), h2 = Math.round(t.h * 1.4)
      const cv = `--hsw-${hash}`
      return {
        layers: [
          L(`linear-gradient(var(${cv}),var(${cv}))`, 'no-repeat', '100% 100%', '0 0'),
          L(t.url, 'repeat', `${t.w}px ${t.h}px`, '0 0', `0 ${t.h}px`),
          L(t.url, 'repeat', `${w2}px ${h2}px`, '0 0', `0 ${h2}px`),
        ],
        props: `@property ${cv}{syntax:"<color>";initial-value:#e8f4ff00;inherits:false;}`,
        keyframesBody: `{0%,82%,100%{${cv}:#e8f4ff00;}84%{${cv}:#e8f4ff4d;}86%{${cv}:#e8f4ff10;}88.5%{${cv}:#e8f4ff38;}91%{${cv}:#e8f4ff00;}}`,
        // The positional loop runs on the RAIN's clock, not the storm's, and
        // the compiler owns its keyframes — so prepending a foreground layer
        // extends both lists together.
        positionalAnim: { period: periodSeconds(WEATHERS.rain.basePeriod, speed, false), timing: 'linear' },
      }
    },
    far(v, density) {
      const t = rainTile(v.c, Math.min(3, density + 1))
      return { img: t.url, size: `${Math.round(t.w * 0.7)}px ${Math.round(t.h * 0.7)}px`, tile: Math.round(t.h * 0.7), opacity: '.5' }
    },
  },
  petals: {
    label: 'petals', luminance: false, basePeriod: 3.8,
    variants: [
      { name: 'pink', c: '#ffafd7' },
      { name: 'white', c: '#ffffff' },
      { name: 'gold', c: '#ffd75f' },
    ],
    near(v, density) {
      const t = petalTile(v.c, density)
      const w2 = Math.round(t.w * 1.4), h2 = Math.round(t.h * 1.4)
      return {
        layers: [
          L(t.url, 'repeat', `${t.w}px ${t.h}px`, '0 0', `0 ${t.h}px`, `4px ${Math.round(t.h / 2)}px`),
          L(t.url, 'repeat', `${w2}px ${h2}px`, '0 0', `0 ${h2}px`, `-5px ${Math.round(h2 / 2)}px`),
        ],
      }
    },
    far(v, density) {
      const t = petalTile(v.c, Math.min(3, density + 1))
      return { img: t.url, size: `${Math.round(t.w * 0.7)}px ${Math.round(t.h * 0.7)}px`, tile: Math.round(t.h * 0.7), opacity: '.55' }
    },
  },

  bubbles: {
    label: 'bubbles', luminance: false, basePeriod: 4,
    variants: [
      { name: 'air', c: '#ffffff' },
      { name: 'teal', c: '#87ffd7' },
      { name: 'violet', c: '#d7afff' },
    ],
    near(v, density) {
      const t = bubbleTile(v.c, density)
      const w2 = Math.round(t.w * 1.4), h2 = Math.round(t.h * 1.4)
      return {
        layers: [
          L(t.url, 'repeat', `${t.w}px ${t.h}px`, '0 0', `0 -${t.h}px`, `2px -${Math.round(t.h / 2)}px`),
          L(t.url, 'repeat', `${w2}px ${h2}px`, '0 0', `0 -${h2}px`, `-3px -${Math.round(h2 / 2)}px`),
        ],
      }
    },
    far(v, density) {
      const t = bubbleTile(v.c, Math.min(3, density + 1))
      return { img: t.url, size: `${Math.round(t.w * 0.7)}px ${Math.round(t.h * 0.7)}px`, tile: -Math.round(t.h * 0.7), opacity: '.5' }
    },
  },

  fireflies: {
    label: 'fireflies', luminance: false, basePeriod: 6,
    variants: [
      { name: 'green', c: '#d7ff5f' },
      { name: 'gold', c: '#ffd75f' },
      { name: 'cyan', c: '#87ffff' },
    ],
    near(v, density) {
      const t = fireflyTile(v.c, density)
      const w2 = Math.round(t.w * 1.4), h2 = Math.round(t.h * 1.4)
      return {
        layers: [
          L(t.url, 'repeat', `${t.w}px ${t.h}px`, '0 0', `0 -${t.h}px`, `5px -${Math.round(t.h / 2)}px`),
          L(t.url, 'repeat', `${w2}px ${h2}px`, '0 0', `0 -${h2}px`, `-6px -${Math.round(h2 / 2)}px`),
        ],
      }
    },
    far(v, density) {
      const t = fireflyTile(v.c, Math.min(3, density + 1))
      return { img: t.url, size: `${Math.round(t.w * 0.7)}px ${Math.round(t.h * 0.7)}px`, tile: -Math.round(t.h * 0.7), opacity: '.5' }
    },
  },

  leaves: {
    label: 'leaves', luminance: false, basePeriod: 4.2,
    variants: [
      { name: 'autumn', c: '#ff8700' },
      { name: 'maple', c: '#d70000' },
      { name: 'green', c: '#87ff5f' },
    ],
    near(v, density) {
      const t = leafTile(v.c, density)
      const w2 = Math.round(t.w * 1.4), h2 = Math.round(t.h * 1.4)
      return {
        layers: [
          L(t.url, 'repeat', `${t.w}px ${t.h}px`, '0 0', `0 ${t.h}px`, `5px ${Math.round(t.h / 2)}px`),
          L(t.url, 'repeat', `${w2}px ${h2}px`, '0 0', `0 ${h2}px`, `-6px ${Math.round(h2 / 2)}px`),
        ],
      }
    },
    far(v, density) {
      const t = leafTile(v.c, Math.min(3, density + 1))
      return { img: t.url, size: `${Math.round(t.w * 0.7)}px ${Math.round(t.h * 0.7)}px`, tile: Math.round(t.h * 0.7), opacity: '.55' }
    },
  },

  sparks: {
    label: 'sparks', luminance: false, basePeriod: 1.2,
    variants: [
      { name: 'white', c: '#ffffff' },
      { name: 'gold', c: '#ffd75f' },
      { name: 'blue', c: '#87d7ff' },
    ],
    near(v, density) {
      const t = sparkTile(v.c, density)
      const w2 = Math.round(t.w * 1.4), h2 = Math.round(t.h * 1.4)
      return {
        layers: [
          L(t.url, 'repeat', `${t.w}px ${t.h}px`, '0 0', `0 -${t.h}px`),
          L(t.url, 'repeat', `${w2}px ${h2}px`, '3px 0', `3px -${h2}px`),
        ],
      }
    },
    far(v, density) {
      const t = sparkTile(v.c, Math.min(3, density + 1))
      return { img: t.url, size: `${Math.round(t.w * 0.7)}px ${Math.round(t.h * 0.7)}px`, tile: -Math.round(t.h * 0.7), opacity: '.5' }
    },
  },

  dust: {
    // Sideways: the one weather that blows rather than falls or rises.
    label: 'dust', luminance: false, basePeriod: 5,
    variants: [
      { name: 'sand', c: '#d7af87' },
      { name: 'ash', c: '#9e9e9e' },
      { name: 'pollen', c: '#ffd75f' },
    ],
    near(v, density) {
      const t = dustTile(v.c, density)
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
    variants: [
      { name: 'party', c1: '#ff5f87', c2: '#ffd700', c3: '#00d7ff' },
      { name: 'ice', c1: '#ffffff', c2: '#87d7ff', c3: '#d7afff' },
      { name: 'heat', c1: '#ff8700', c2: '#ff0000', c3: '#ffd700' },
    ],
    near(v, density) {
      const t = confettiTile(v, density)
      const w2 = Math.round(t.w * 1.4), h2 = Math.round(t.h * 1.4)
      return {
        layers: [
          L(t.url, 'repeat', `${t.w}px ${t.h}px`, '0 0', `0 ${t.h}px`, `4px ${Math.round(t.h / 2)}px`),
          L(t.url, 'repeat', `${w2}px ${h2}px`, '0 0', `0 ${h2}px`, `-5px ${Math.round(h2 / 2)}px`),
        ],
      }
    },
    far(v, density) {
      const t = confettiTile(v, Math.min(3, density + 1))
      return { img: t.url, size: `${Math.round(t.w * 0.7)}px ${Math.round(t.h * 0.7)}px`, tile: Math.round(t.h * 0.7), opacity: '.55' }
    },
  },

  meteors: {
    // Diagonal: each loop advances one tile in BOTH axes, so it wraps clean.
    label: 'meteors', luminance: false, basePeriod: 1.6,
    variants: [
      { name: 'white', c: '#ffffff' },
      { name: 'gold', c: '#ffd75f' },
      { name: 'cyan', c: '#87ffff' },
    ],
    near(v, density) {
      const t = meteorTile(v.c, density)
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
    variants: [
      { name: 'pink', c: '#ff5fd7' },
      { name: 'red', c: '#ff0000' },
      { name: 'white', c: '#ffffff' },
    ],
    near(v, density) {
      const t = heartTile(v.c, density)
      const w2 = Math.round(t.w * 1.4), h2 = Math.round(t.h * 1.4)
      return {
        layers: [
          L(t.url, 'repeat', `${t.w}px ${t.h}px`, '0 0', `0 -${t.h}px`, `3px -${Math.round(t.h / 2)}px`),
          L(t.url, 'repeat', `${w2}px ${h2}px`, '0 0', `0 -${h2}px`, `-4px -${Math.round(h2 / 2)}px`),
        ],
      }
    },
    far(v, density) {
      const t = heartTile(v.c, Math.min(3, density + 1))
      return { img: t.url, size: `${Math.round(t.w * 0.7)}px ${Math.round(t.h * 0.7)}px`, tile: -Math.round(t.h * 0.7), opacity: '.5' }
    },
  },

}

const BACKDROP_IDS = new Set(Object.keys(BACKDROPS))
const WEATHER_IDS = new Set(Object.keys(WEATHERS))

// ── validation (called from validatePaintSpec — pushes into its errors) ────

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
      if (!isIntInRange(backdrop.variant ?? 0, 0, BACKDROPS[backdrop.id].variants.length - 1)) {
        errors.push('scene.backdrop.variant out of range')
      }
      if (backdrop.speed !== undefined && !isNumInRange(backdrop.speed, MIN_SPEED, MAX_SPEED)) {
        errors.push(`scene.backdrop.speed must be a number ${MIN_SPEED}-${MAX_SPEED}`)
      }
    }
  }
  if (weather !== null) {
    if (!isPlainObject(weather) || !WEATHER_IDS.has(weather.id)) {
      errors.push(`scene.weather.id unknown: ${JSON.stringify(weather?.id)}`)
    } else {
      if (!isIntInRange(weather.variant ?? 0, 0, WEATHERS[weather.id].variants.length - 1)) {
        errors.push('scene.weather.variant out of range')
      }
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
    backdrop: isPlainObject(scene.backdrop)
      ? { id: scene.backdrop.id, variant: scene.backdrop.variant ?? 0, speed: scene.backdrop.speed ?? 1 }
      : null,
    weather: isPlainObject(scene.weather)
      ? { id: scene.weather.id, variant: scene.weather.variant ?? 0, density: scene.weather.density ?? 2, speed: scene.weather.speed ?? 1 }
      : null,
  }
}

// ── compiler ────────────────────────────────────────────────────────────────

/** Resolve a catalog entry's variant, clamped. */
function pickVariant(meta, index) {
  const i = isIntInRange(index ?? 0, 0, meta.variants.length - 1) ? (index ?? 0) : 0
  return meta.variants[i]
}

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
 * an unvalidated spec cannot inject anything (no user string ever reaches the
 * output; colors and tiles come exclusively from the catalog).
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
  const bBuilt = bMeta ? bMeta.build(pickVariant(bMeta, backdrop.variant), hash) : null
  const bPeriod = bMeta ? periodSeconds(bMeta.basePeriod, backdrop.speed ?? 1, bMeta.luminance) : 0

  const wMeta = weather ? WEATHERS[weather.id] : null
  const wDensity = weather && DENSITIES.has(weather.density) ? weather.density : 2
  const wSpeed = weather ? safeSpeed(weather.speed ?? 1) : 1
  const wVariant = wMeta ? pickVariant(wMeta, weather.variant) : null
  const wBuilt = wMeta ? wMeta.near(wVariant, wDensity, hash, wSpeed) : null
  const wPeriod = wMeta ? periodSeconds(wMeta.basePeriod, wSpeed, wMeta.luminance) : 0

  // ── back pseudo: the plate, plus the far weather plane on top of it ──
  if (bBuilt) {
    const layers = [...bBuilt.layers]
    if (wMeta?.far && !wMeta.behindText) {
      const far = wMeta.far(wVariant, wDensity)
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

// ── builder-UI metadata (labels, variant names, one swatch per variant) ────
//
// `swatches` is the one piece of CSS that does leave here: a variant's sky (or
// plate, or particle colour) as a plain background value, so the builder can
// show a variant as a colour chip instead of a word. It is catalog data, never
// user input, and it is only ever used as a background — nothing else escapes.

export const SCENE_BACKDROPS_META = Object.fromEntries(
  Object.entries(BACKDROPS).map(([id, m]) => [id, {
    label: m.label,
    variants: m.variants.map(v => v.name),
    swatches: m.variants.map(v => v.sky || v.plate || v.skyB || '#000'),
  }]))

export const SCENE_WEATHERS_META = Object.fromEntries(
  Object.entries(WEATHERS).map(([id, m]) => [id, {
    label: m.label,
    variants: m.variants.map(v => v.name),
    swatches: m.variants.map(v => v.c || v.c1 || '#fff'),
  }]))

export { BACKDROP_IDS as SCENE_BACKDROP_IDS, WEATHER_IDS as SCENE_WEATHER_IDS }

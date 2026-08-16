/**
 * SYNCED COPY of the heatsync monorepo's client/utils/scene-spec.js — keep
 * byte-close to the source of truth; mirror changes in both repos. Only
 * bundling adaptations belong here, never a behavior fork.
 *
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
  isIntInRange,
  isNumInRange,
  isPlainObject,
  MAX_SPEED,
  MIN_SPEED,
  periodSeconds,
  safeSpeed,
  syncDelayCalc,
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
const CLOUD_FAR_STEPS = [
  [5, 7],
  [6, 10],
  [4, 6],
  [7, 11],
  [5, 8],
  [6, 12],
  [7, 7],
]
const CLOUD_NEAR_STEPS = [
  [7, 6],
  [6, 10],
  [8, 5],
  [7, 12],
  [9, 8],
  [6, 13],
  [6, 7],
  [7, 6],
]
const CLOUD_FAR_W = 40
const CLOUD_NEAR_W = 56

// ── pixel silhouettes (blocky on purpose — crisp at 13px Cozette scale) ────

const SIL = {
  dunes: (c) =>
    svgUrl(svg(96, 20, `<path fill='${c}' d='M0 20v-8h6v-2h8v-2h10v2h8v2h10v4h6v-2h10v-4h8v-2h10v2h8v4h6v2h6v4z'/>`)),
  graveyard: (c) =>
    svgUrl(
      svg(
        140,
        26,
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
          ` M130 24v-7h2v7z M137 24v-7h2v7z M128 19h12v2h-12z'/>`,
      ),
    ),
  reef: (c) =>
    svgUrl(svg(90, 14, `<path fill='${c}' d='M0 14v-4h8v-2h10v2h10v2h10v-4h8v-2h8v2h8v4h10v-2h10v2h8v2z'/>`)),
  pines: (c) =>
    svgUrl(
      svg(
        84,
        24,
        `<path fill='${c}' d='M0 24v-3h84v3z` +
          ` M8 21v-3H5v-4h3v-4h2v-3h2v3h2v4h3v4h-3v3z` +
          ` M30 21v-2h-2v-4h2v-3h2v-3h2v3h2v3h2v4h-2v2z` +
          ` M52 21v-3h-3v-4h3v-4h2v-4h2v4h2v4h3v4h-3v3z` +
          ` M74 21v-2h-2v-3h2v-3h2v3h2v3h-2v2z'/>`,
      ),
    ),
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
  return (
    `<g transform='rotate(12 ${x + 1} ${y + h / 2})'>` +
    `<rect x='${x}' y='${y}' width='2' height='${h}' fill='${c}' opacity='.5'/>` +
    `<rect x='${x}' y='${y + h - 3}' width='2' height='3' fill='${c}' opacity='.95'/></g>`
  )
}

// Tiles are much larger than the old 1px-drizzle ones for the same reason the
// drops are wider: two pixels of opaque colour carries far more ink than one
// translucent pixel, and every tile is ALSO painted a second time at 1.4x for
// parallax, so keeping the old tile sizes would have put ~25 fat drops across
// a six-glyph name and buried it.
function rainTile(c, density) {
  if (density >= 3)
    return {
      w: 20,
      h: 24,
      url: svgUrl(svg(20, 24, rainDrop(c, 2, 2, 9) + rainDrop(c, 10, 8, 9) + rainDrop(c, 15, 1, 8))),
    }
  if (density === 2) return { w: 28, h: 28, url: svgUrl(svg(28, 28, rainDrop(c, 4, 3, 10) + rainDrop(c, 18, 13, 10))) }
  return { w: 40, h: 32, url: svgUrl(svg(40, 32, rainDrop(c, 7, 4, 11) + rainDrop(c, 27, 16, 10))) }
}

function snowTile(c, density) {
  if (density >= 3)
    return {
      w: 14,
      h: 18,
      url: svgUrl(
        svg(
          14,
          18,
          `<g fill='${c}'><circle cx='3' cy='3' r='1' opacity='.9'/>` +
            `<circle cx='10' cy='8' r='.7' opacity='.6'/>` +
            `<circle cx='6' cy='13' r='1' opacity='.8'/>` +
            `<circle cx='12' cy='15' r='.6' opacity='.5'/></g>`,
        ),
      ),
    }
  if (density === 2)
    return {
      w: 18,
      h: 22,
      url: svgUrl(
        svg(
          18,
          22,
          `<g fill='${c}'><circle cx='4' cy='5' r='1' opacity='.9'/>` +
            `<circle cx='12' cy='14' r='.7' opacity='.6'/>` +
            `<circle cx='8' cy='19' r='.6' opacity='.5'/></g>`,
        ),
      ),
    }
  return {
    w: 24,
    h: 28,
    url: svgUrl(
      svg(
        24,
        28,
        `<g fill='${c}'><circle cx='6' cy='6' r='1' opacity='.85'/>` +
          `<circle cx='16' cy='18' r='.7' opacity='.55'/></g>`,
      ),
    ),
  }
}

function emberTile(c1, c2, density) {
  if (density >= 3)
    return {
      w: 14,
      h: 20,
      url: svgUrl(
        svg(
          14,
          20,
          `<g><rect x='3' y='15' width='1' height='2' fill='${c1}' opacity='.9'/>` +
            `<rect x='9' y='9' width='1' height='1' fill='${c2}' opacity='.8'/>` +
            `<rect x='6' y='4' width='1' height='1' fill='${c1}' opacity='.5'/>` +
            `<rect x='12' y='17' width='1' height='1' fill='${c2}' opacity='.7'/></g>`,
        ),
      ),
    }
  if (density === 2)
    return {
      w: 16,
      h: 24,
      url: svgUrl(
        svg(
          16,
          24,
          `<g><rect x='4' y='18' width='1' height='2' fill='${c1}' opacity='.9'/>` +
            `<rect x='11' y='8' width='1' height='1' fill='${c2}' opacity='.7'/></g>`,
        ),
      ),
    }
  return {
    w: 20,
    h: 28,
    url: svgUrl(
      svg(
        20,
        28,
        `<g><rect x='5' y='21' width='1' height='2' fill='${c1}' opacity='.85'/>` +
          `<rect x='14' y='9' width='1' height='1' fill='${c2}' opacity='.6'/></g>`,
      ),
    ),
  }
}

function glyphTile(c, density) {
  const col = (x, ys, head) =>
    ys.map(([y, h]) => `<rect x='${x}' y='${y}' width='1' height='${h}' fill='${c}' opacity='.28'/>`).join('') +
    `<rect x='${x}' y='${head}' width='1' height='4' fill='${c}' opacity='.95'/>`
  if (density >= 3)
    return {
      w: 12,
      h: 22,
      url: svgUrl(
        svg(
          12,
          22,
          col(
            2,
            [
              [1, 3],
              [6, 2],
              [10, 3],
            ],
            15,
          ) +
            col(
              8,
              [
                [3, 2],
                [8, 3],
                [13, 2],
              ],
              17,
            ),
        ),
      ),
    }
  if (density === 2)
    return {
      w: 14,
      h: 22,
      url: svgUrl(
        svg(
          14,
          22,
          col(
            3,
            [
              [1, 3],
              [6, 2],
              [10, 3],
            ],
            15,
          ) +
            col(
              10,
              [
                [4, 2],
                [9, 3],
              ],
              16,
            ),
        ),
      ),
    }
  return {
    w: 18,
    h: 24,
    url: svgUrl(
      svg(
        18,
        24,
        col(
          5,
          [
            [2, 3],
            [8, 2],
            [13, 3],
          ],
          18,
        ),
      ),
    ),
  }
}

// ── backdrop catalog ────────────────────────────────────────────────────────
//
// Each build() returns { decls, keyframes } for the ::before pseudo.
// `decls` carries background layers + sizes + the RESTING positions (the
// hero frame); keyframes animate background-position lists only, so
// opts.static = simply omitting the animation. Backgrounds never escape the
// pseudo's box — no clipping needed, no overflow, no layout impact.
// Every plate is deliberately mid-to-dark so the shared dark text rim
// (see buildSceneCss) guarantees legibility on all of them.

const BACKDROPS = {
  dawn: {
    label: 'desert dawn',
    luminance: false,
    basePeriod: 16,
    variants: [
      {
        name: 'ember',
        sky: 'linear-gradient(0deg,#ff8700 0%,#b34700 22%,#6e3a52 55%,#3a2f55 82%,#23233f 100%)',
        haze: '#ffd7af',
        bloom: '#ffaf5f',
        sil: '#140a02',
      },
      {
        name: 'rose',
        sky: 'linear-gradient(0deg,#ff5f87 0%,#a03562 26%,#5f2d55 60%,#2e2345 100%)',
        haze: '#ffc7d7',
        bloom: '#ff87af',
        sil: '#170812',
      },
      {
        name: 'gold',
        sky: 'linear-gradient(0deg,#ffd700 0%,#af7800 24%,#5f4a3a 58%,#39304a 100%)',
        haze: '#fff3b0',
        bloom: '#ffe75f',
        sil: '#141002',
      },
    ],
    build(v, animName) {
      const layers =
        `${SIL.dunes(v.sil)} repeat-x 0 100%/auto 42%,` +
        `linear-gradient(90deg,transparent 0%,${v.haze}38 35%,${v.haze}55 50%,${v.haze}38 65%,transparent 100%) no-repeat 50% 78%/220% 58%,` +
        `radial-gradient(90% 90% at 50% 108%,${v.bloom}66 0%,${v.bloom}22 40%,transparent 70%) no-repeat 0 0/100% 100%,` +
        `${v.sky} no-repeat 0 0/100% 100%`
      const kf = `@keyframes ${animName}{from{background-position:0 100%,200% 78%,0 0,0 0;}to{background-position:0 100%,-100% 78%,0 0,0 0;}}`
      return { decls: `background:${layers};`, keyframes: kf }
    },
  },

  graveyard: {
    // Overcast by construction: the sky is brightest at the horizon (the glow
    // the clouds are lit from) and darkest at the top, where two blocky cloud
    // decks hang down over it. The decks are what makes it read as weather
    // rather than a gradient — the two soft radial washes this used to carry
    // were under 5% alpha and invisible at name size.
    label: 'graveyard',
    luminance: false,
    basePeriod: 22,
    variants: [
      // Sky runs bright at the horizon (0% is the BOTTOM at 0deg) to near-black
      // at the top; the decks are LIGHTER than that top, because an overcast
      // lid lit from below by the same glow is what you actually see at night.
      // Dark-on-dark clouds are just a black bar.
      {
        name: 'ash',
        sky: 'linear-gradient(0deg,#2e2e36 0%,#22222a 40%,#15151a 75%,#0e0e13 100%)',
        near: '#33333d',
        far: '#292933',
        moon: '#c6c6d2',
        sil: '#08080a',
      },
      {
        name: 'blood',
        sky: 'linear-gradient(0deg,#4a2428 0%,#301a1e 40%,#1c1114 75%,#120b0d 100%)',
        near: '#3d2126',
        far: '#33191e',
        moon: '#e0a0a0',
        sil: '#0a0608',
      },
      {
        name: 'moonlit',
        sky: 'linear-gradient(0deg,#33435f 0%,#222d44 40%,#141c2b 75%,#0d1220 100%)',
        near: '#2b3750',
        far: '#232e44',
        moon: '#dce8ff',
        sil: '#060810',
      },
    ],
    build(v, animName) {
      const near = cloudDeck(CLOUD_NEAR_STEPS, CLOUD_NEAR_W, v.near, '1')
      const far = cloudDeck(CLOUD_FAR_STEPS, CLOUD_FAR_W, v.far, '.9')
      const layers =
        `${SIL.graveyard(v.sil)} repeat-x 0 100%/auto 52%,` +
        `${near.url} repeat-x 0 0/${near.w}px 58%,` +
        `${far.url} repeat-x 0 0/${far.w}px 44%,` +
        `radial-gradient(45% 75% at 62% 6%,${v.moon}2e 0%,transparent 68%) no-repeat 0 0/100% 100%,` +
        `${v.sky} no-repeat 0 0/100% 100%`
      // Each deck advances exactly one own-tile width per loop — seamless by
      // construction, and the different widths ARE the parallax.
      const kf =
        `@keyframes ${animName}{from{background-position:0 100%,0 0,0 0,0 0,0 0;}` +
        `to{background-position:0 100%,-${near.w}px 0,-${far.w}px 0,0 0,0 0;}}`
      return { decls: `background:${layers};`, keyframes: kf }
    },
  },

  abyss: {
    label: 'abyss',
    luminance: false,
    basePeriod: 18,
    variants: [
      {
        name: 'blue',
        sky: 'linear-gradient(180deg,#00344e 0%,#001d2e 45%,#000a12 100%)',
        ray: '#00d7ff',
        sil: '#010508',
      },
      {
        name: 'teal',
        sky: 'linear-gradient(180deg,#00443b 0%,#00251f 45%,#000d0a 100%)',
        ray: '#00ffd7',
        sil: '#010806',
      },
      {
        name: 'void',
        sky: 'linear-gradient(180deg,#1e0f38 0%,#100822 45%,#05030e 100%)',
        ray: '#875fff',
        sil: '#040208',
      },
    ],
    build(v, animName) {
      const layers =
        `${SIL.reef(v.sil)} repeat-x 0 100%/auto 26%,` +
        `linear-gradient(104deg,transparent 30%,${v.ray}14 42%,transparent 50%,${v.ray}0e 62%,transparent 72%) no-repeat 50% 0/260% 100%,` +
        `radial-gradient(80% 60% at 50% -10%,${v.ray}20 0%,transparent 60%) no-repeat 0 0/100% 100%,` +
        `${v.sky} no-repeat 0 0/100% 100%`
      const kf = `@keyframes ${animName}{from{background-position:0 100%,-90% 0,0 0,0 0;}to{background-position:0 100%,190% 0,0 0,0 0;}}`
      return { decls: `background:${layers};`, keyframes: kf }
    },
  },

  nightfall: {
    label: 'nightfall',
    luminance: false,
    basePeriod: 20,
    variants: [
      {
        name: 'aurora',
        sky: 'linear-gradient(0deg,#0a0a16 0%,#12122a 55%,#0a0a18 100%)',
        a1: '#00ff87',
        a2: '#00d7ff',
        sil: '#04040a',
      },
      {
        name: 'magenta',
        sky: 'linear-gradient(0deg,#120a16 0%,#1c122a 55%,#100a18 100%)',
        a1: '#ff40af',
        a2: '#875fff',
        sil: '#08040a',
      },
      {
        name: 'ice',
        sky: 'linear-gradient(0deg,#0a0e16 0%,#101a2a 55%,#0a0e18 100%)',
        a1: '#87d7ff',
        a2: '#d7ffff',
        sil: '#04060c',
      },
    ],
    build(v, animName) {
      const layers =
        `${SIL.pines(v.sil)} repeat-x 0 100%/auto 46%,` +
        `linear-gradient(100deg,transparent 15%,${v.a1}30 35%,${v.a2}2e 50%,${v.a1}24 62%,transparent 82%) no-repeat 50% 0/240% 90%,` +
        `radial-gradient(circle,#ffffffcc 0 .5px,transparent 1px) 0 0/17px 13px,` +
        `radial-gradient(circle,#ffffff66 0 .5px,transparent 1px) 5px 7px/23px 19px,` +
        `${v.sky} no-repeat 0 0/100% 100%`
      const kf = `@keyframes ${animName}{from{background-position:0 100%,-90% 0,0 0,5px 7px,0 0;}to{background-position:0 100%,190% 0,0 0,5px 7px,0 0;}}`
      return { decls: `background:${layers};`, keyframes: kf }
    },
  },

  terminal: {
    label: 'terminal',
    luminance: false,
    basePeriod: 9,
    variants: [
      { name: 'phosphor', ph: '#00ff5f', plate: 'linear-gradient(#0c0c0c,#060606)' },
      { name: 'amber', ph: '#ffb000', plate: 'linear-gradient(#0e0a04,#070502)' },
      { name: 'paper', ph: '#c0c0c0', plate: 'linear-gradient(#101010,#0a0a0a)' },
    ],
    build(v, animName) {
      const layers =
        `linear-gradient(0deg,transparent 38%,${v.ph}16 50%,transparent 62%) no-repeat 0 0/100% 300%,` +
        `repeating-linear-gradient(0deg,${v.ph}0d 0 1px,transparent 1px 3px) 0 0/100% auto,` +
        `${v.plate} no-repeat 0 0/100% 100%`
      const kf = `@keyframes ${animName}{from{background-position:0 0,0 0,0 0;}to{background-position:0 100%,0 0,0 0;}}`
      return { decls: `background:${layers};`, keyframes: kf }
    },
  },

  furnace: {
    label: 'furnace',
    luminance: true,
    basePeriod: 5,
    variants: [
      { name: 'coal', glow: '#ff3700', plate: 'linear-gradient(0deg,#1c0300 0%,#0d0202 55%,#050505 100%)' },
      { name: 'ion', glow: '#00afff', plate: 'linear-gradient(0deg,#001030 0%,#020818 55%,#040404 100%)' },
      { name: 'hex', glow: '#af5fff', plate: 'linear-gradient(0deg,#14001c 0%,#0a0212 55%,#050505 100%)' },
    ],
    build(v, animName, hash) {
      // Registered <color> custom prop so the underglow's alpha itself
      // interpolates (background-position can't express a breathe). The var
      // is hash-namespaced like conic's angle prop — no cross-user collision.
      const cv = `--hsb-${hash}`
      const layers =
        `radial-gradient(120% 90% at 50% 115%,var(${cv}) 0%,transparent 65%) no-repeat 0 0/100% 100%,` +
        `${v.plate} no-repeat 0 0/100% 100%`
      const kf =
        `@property ${cv}{syntax:"<color>";initial-value:${v.glow}66;inherits:false;}` +
        `@keyframes ${animName}{from{${cv}:${v.glow}55;}to{${cv}:${v.glow}a8;}}`
      return { decls: `background:${layers};`, keyframes: kf, alternate: true }
    },
  },
}

// ── weather catalog ─────────────────────────────────────────────────────────
//
// Each build() returns { decls, keyframes, extraAnim? } for the ::after
// pseudo. Falling/rising weathers are two copies of one pixel tile at 1x and
// 1.4x, advancing exactly one own-tile-height per loop — different distances
// in the same duration = parallax, seamless by construction. Sway returns to
// x=0 at 100% so the loop never jumps.

const WEATHERS = {
  rain: {
    label: 'rain',
    luminance: false,
    basePeriod: 0.9,
    variants: [
      { name: 'silver', c: '#9db4c9' },
      { name: 'blood', c: '#d70000' },
      { name: 'acid', c: '#87ff00' },
    ],
    build(v, density, animName) {
      const t = rainTile(v.c, density)
      const decls = `background:${t.url} 0 0/${t.w}px ${t.h}px,${t.url} 0 0/${Math.round(t.w * 1.4)}px ${Math.round(t.h * 1.4)}px;`
      const kf = `@keyframes ${animName}{from{background-position:0 0,0 0;}to{background-position:0 ${t.h}px,0 ${Math.round(t.h * 1.4)}px;}}`
      return { decls, keyframes: kf }
    },
  },

  snow: {
    label: 'snow',
    luminance: false,
    basePeriod: 4.5,
    variants: [
      { name: 'white', c: '#ffffff' },
      { name: 'ash', c: '#9e9e9e' },
      { name: 'gold', c: '#ffd75f' },
    ],
    build(v, density, animName) {
      const t = snowTile(v.c, density)
      const h2 = Math.round(t.h * 1.4)
      const decls = `background:${t.url} 0 0/${t.w}px ${t.h}px,${t.url} 0 0/${Math.round(t.w * 1.4)}px ${h2}px;`
      const kf = `@keyframes ${animName}{0%{background-position:0 0,0 0;}50%{background-position:2px ${Math.round(t.h / 2)}px,-3px ${Math.round(h2 / 2)}px;}100%{background-position:0 ${t.h}px,0 ${h2}px;}}`
      return { decls, keyframes: kf }
    },
  },

  fog: {
    // behindText: fog is an ambient volume, not particles — in front it
    // washes the name out on bright plates (dawn). Painted between the
    // plate and the text instead: ::after with z-index:-1 still paints
    // above ::before (tree order breaks the tie inside the negative band).
    label: 'fog (behind the name)',
    luminance: false,
    basePeriod: 16,
    behindText: true,
    variants: [
      // sunglow used to be #ffd7af — the exact hex of the desert-dawn plate's
      // own haze band, so the single most obvious pairing in the catalog
      // (dawn + sunglow) rendered a fog bank that was invisible by
      // construction. Warmer and denser now, and the alphas below are roughly
      // double: fog paints BEHIND the name, so it can afford to be seen.
      { name: 'sunglow', c: '#ffaf87' },
      { name: 'mist', c: '#c0c8d0' },
      { name: 'miasma', c: '#87ff5f' },
    ],
    build(v, density, animName) {
      const a = density >= 3 ? ['80', '4d'] : density === 2 ? ['66', '38'] : ['40', '26']
      const decls =
        `background:radial-gradient(55% 130% at 50% 60%,${v.c}${a[0]} 0%,${v.c}${a[1]} 45%,transparent 72%) no-repeat 30% 40%/160% 100%,` +
        `radial-gradient(65% 150% at 50% 40%,${v.c}${a[1]} 0%,transparent 70%) no-repeat 70% 70%/200% 100%;`
      const kf = `@keyframes ${animName}{from{background-position:-60% 40%,160% 70%;}to{background-position:160% 40%,-60% 70%;}}`
      return { decls, keyframes: kf, alternate: true }
    },
  },

  embers: {
    label: 'embers',
    luminance: false,
    basePeriod: 3.2,
    variants: [
      { name: 'fire', c1: '#ff8700', c2: '#ffd700' },
      { name: 'ion', c1: '#00d7ff', c2: '#87ffff' },
      { name: 'rose', c1: '#ff40af', c2: '#ff87d7' },
    ],
    build(v, density, animName) {
      const t = emberTile(v.c1, v.c2, density)
      const h2 = Math.round(t.h * 1.4)
      const decls = `background:${t.url} 0 0/${t.w}px ${t.h}px,${t.url} 0 0/${Math.round(t.w * 1.4)}px ${h2}px;`
      const kf = `@keyframes ${animName}{0%{background-position:0 0,0 0;}50%{background-position:2px -${Math.round(t.h / 2)}px,-2px -${Math.round(h2 / 2)}px;}100%{background-position:0 -${t.h}px,0 -${h2}px;}}`
      return { decls, keyframes: kf }
    },
  },

  glyphs: {
    label: 'glyph rain',
    luminance: false,
    basePeriod: 2.6,
    variants: [
      { name: 'green', c: '#00ff87' },
      { name: 'amber', c: '#ffb000' },
      { name: 'cyan', c: '#00e5ff' },
    ],
    build(v, density, animName) {
      const t = glyphTile(v.c, density)
      const h2 = Math.round(t.h * 1.5)
      const decls = `background:${t.url} 0 0/${t.w}px ${t.h}px,${t.url} 7px 0/${Math.round(t.w * 1.5)}px ${h2}px;`
      const kf = `@keyframes ${animName}{from{background-position:0 0,7px 0;}to{background-position:0 ${t.h}px,7px ${h2}px;}}`
      return { decls, keyframes: kf }
    },
  },

  storm: {
    label: 'storm',
    luminance: true,
    basePeriod: 7,
    variants: [
      { name: 'silver', c: '#9db4c9' },
      { name: 'blood', c: '#d70000' },
      { name: 'acid', c: '#87ff00' },
    ],
    build(v, density, animName, hash, speed) {
      // Rain layers + a lightning wash carried by a registered <color> var —
      // a separate animation on a separate property, so it comma-lists next
      // to the rain's background-position loop without clobbering it. Two
      // pops inside a ~120ms window every cycle: far under the 3-flash/s
      // WCAG line even at max speed (period floor is basePeriod/MAX_SPEED,
      // luminance-clamped in buildSceneCss).
      const t = rainTile(v.c, density)
      const cv = `--hsw-${hash}`
      const rainPeriod = periodSeconds(WEATHERS.rain.basePeriod, speed, false)
      const rainName = `${animName}r`
      const decls =
        `background:linear-gradient(var(${cv}),var(${cv})) no-repeat 0 0/100% 100%,` +
        `${t.url} 0 0/${t.w}px ${t.h}px,${t.url} 0 0/${Math.round(t.w * 1.4)}px ${Math.round(t.h * 1.4)}px;`
      const kf =
        `@property ${cv}{syntax:"<color>";initial-value:#e8f4ff00;inherits:false;}` +
        `@keyframes ${animName}{0%,82%,100%{${cv}:#e8f4ff00;}84%{${cv}:#e8f4ff4d;}86%{${cv}:#e8f4ff10;}88.5%{${cv}:#e8f4ff38;}91%{${cv}:#e8f4ff00;}}` +
        `@keyframes ${rainName}{from{background-position:0 0,0 0,0 0;}to{background-position:0 0,0 ${t.h}px,0 ${Math.round(t.h * 1.4)}px;}}`
      return { decls, keyframes: kf, extraAnim: { name: rainName, period: rainPeriod, timing: 'linear' } }
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
      ? {
          id: scene.weather.id,
          variant: scene.weather.variant ?? 0,
          density: scene.weather.density ?? 2,
          speed: scene.weather.speed ?? 1,
        }
      : null,
  }
}

// ── compiler ────────────────────────────────────────────────────────────────

/**
 * Compile a scene block to CSS scoped under `selector`. Same defense-in-depth
 * contract as compilePaintCss: assumes validation passed, but unknown ids are
 * silently skipped and every number re-clamped — an unvalidated spec cannot
 * inject anything (no user string ever reaches the output; colors/tiles come
 * exclusively from the catalog).
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

  // The plate needs the element to anchor absolutely-positioned pseudos and
  // to fence ::before's z-index:-1 inside its own stacking context (so the
  // backdrop can sit behind the text but never behind the chat row).
  let css = `${selector}{position:relative;isolation:isolate;}`

  if (backdrop) {
    const meta = BACKDROPS[backdrop.id]
    const variant =
      meta.variants[isIntInRange(backdrop.variant ?? 0, 0, meta.variants.length - 1) ? (backdrop.variant ?? 0) : 0]
    const animName = `hss_${hash}_b`
    const built = meta.build(variant, animName, hash)
    css += `${selector}::before{${PSEUDO_BASE}z-index:-1;${built.decls}`
    if (!opts.static) {
      const period = periodSeconds(meta.basePeriod, backdrop.speed ?? 1, meta.luminance)
      const dir = built.alternate ? ' alternate' : ''
      css += `animation:${animName} ${period}s ${built.alternate ? 'ease-in-out' : 'linear'} infinite${dir};`
      css += `animation-delay:${syncDelayCalc(built.alternate ? period * 2 : period)};`
    }
    css += '}'
    if (!opts.static) css += built.keyframes
  }

  if (weather) {
    const meta = WEATHERS[weather.id]
    const variant =
      meta.variants[isIntInRange(weather.variant ?? 0, 0, meta.variants.length - 1) ? (weather.variant ?? 0) : 0]
    const density = DENSITIES.has(weather.density) ? weather.density : 2
    const speed = safeSpeed(weather.speed ?? 1)
    const animName = `hss_${hash}_w`
    const built = meta.build(variant, density, animName, hash, speed)
    css += `${selector}::after{${PSEUDO_BASE}z-index:${meta.behindText ? -1 : 1};${built.decls}`
    if (!opts.static) {
      const period = periodSeconds(meta.basePeriod, speed, meta.luminance)
      const dir = built.alternate ? ' alternate' : ''
      const anims = [`${animName} ${period}s ${built.alternate ? 'ease-in-out' : 'linear'} infinite${dir}`]
      const delays = [syncDelayCalc(built.alternate ? period * 2 : period)]
      if (built.extraAnim) {
        anims.push(`${built.extraAnim.name} ${built.extraAnim.period}s ${built.extraAnim.timing} infinite`)
        delays.push(syncDelayCalc(built.extraAnim.period))
      }
      css += `animation:${anims.join(',')};animation-delay:${delays.join(',')};`
    }
    css += '}'
    if (!opts.static) css += built.keyframes
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

// ── builder-UI metadata (labels + variant names only — no CSS leaks out) ───

export const SCENE_BACKDROPS_META = Object.fromEntries(
  Object.entries(BACKDROPS).map(([id, m]) => [id, { label: m.label, variants: m.variants.map((v) => v.name) }]),
)

export const SCENE_WEATHERS_META = Object.fromEntries(
  Object.entries(WEATHERS).map(([id, m]) => [id, { label: m.label, variants: m.variants.map((v) => v.name) }]),
)

export { BACKDROP_IDS as SCENE_BACKDROP_IDS, WEATHER_IDS as SCENE_WEATHER_IDS }

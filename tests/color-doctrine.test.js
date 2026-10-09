import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * VT320 doctrine: eight colours and nothing else.
 *
 *   #000000 #ff0000 #00ff00 #ffff00 #8888ff #ff00ff #00ffff #ffffff
 *
 * Emphasis is bold / underline / reverse video / blink — never a grey, a shade,
 * a partial alpha or a glow. Mirrors heatsync.org (css/core/variables.css,
 * client/config/colors.js). #ff8700 survives ONLY as the [H] heatsync platform
 * tag — --hs-plat-hs in 00-palette.css and HS_PLAT_COLORS.heatsync in
 * lib/palette.js — so nothing else can borrow it.
 *
 * Every colour literal in a shipped source file (hex 3/4/6/8, rgb/rgba/hsl/hsla,
 * and CSS named colours in stylesheets) must be one of the eight. What is NOT
 * ours to recolour is listed below, explicitly and with the reason: user
 * content, paid cosmetics, platform data. A new exemption is a new line here,
 * reviewed — not a silent drift.
 */

const ROOT = join(import.meta.dir, '..')
const STYLES = join(ROOT, 'src', 'multichat', 'styles')

const PALETTE = new Set(['000000', 'ff0000', '00ff00', 'ffff00', '8888ff', 'ff00ff', '00ffff', 'ffffff'])
const ORANGE = 'ff8700'
// twitch's light purple: the [T] platform colour. Like #ff8700 for [H], it is spelled in ONE
// place — lib/palette.js (HS_PLAT_COLORS) and the 00-palette.css token. Everything else
// (content scripts, the schema, the tooltip map) reads HS_PLAT_COLORS. 20-card.css is the
// single exception: a byte-synced site copy, covered by the site's own token.
const TWITCH = 'c8a8ff'
// Single-definition hexes. Moderator green is Twitch's real mod badge colour; dim gray is for exactly
// two roles (the reply-context line, and a fully-read chat tab) and nothing else. Each is spelled once
// per layer: the CSS token, and (mod green) the JS constant.
const SINGLE = new Map([
  ['00ad03', new Set(['src/multichat/styles/00-palette.css', 'src/lib/palette.js'])],
  ['808080', new Set(['src/multichat/styles/00-palette.css'])],
  ['bcbcbc', new Set(['src/multichat/styles/00-palette.css'])],
])
const TWITCH_FILES = new Set([
  'src/multichat/styles/00-palette.css',
  'src/lib/palette.js',
  'src/multichat/styles/20-card.css',
])

/** Whole files that are not ours to recolour. */
const EXEMPT_FILES = new Map([
  ['src/lib/paint-core.js', 'name-paint compiler, byte-synced from the site'],
  ['src/lib/scene-spec.js', 'name-paint compiler, byte-synced from the site'],
  ['src/lib/paint-spec.js', 'name-paint compiler, byte-synced from the site'],
  ['src/lib/paint-authoring.js', 'name-paint compiler, byte-synced from the site'],
  ['src/lib/animation-phase.js', 'name-paint compiler, byte-synced from the site'],
  ['src/lib/fill-layers.js', 'name-paint compiler, byte-synced from the site'],
  ['src/lib/glyph-mask.js', 'name-paint compiler, byte-synced from the site'],
  ['src/lib/plus-tenure.js', 'byte-synced from the site (sync-paint-compiler.sh)'],
  ['src/lib/stv-paint-css.js', '7TV paint colours — paid/user content, byte-synced from the site'],
  ['src/multichat/paints.js', 'HS_USERNAME_PALETTE — user name colours, byte-identical with the site'],
  ['src/multichat/cosmetics.js', '7TV/BTTV/FFZ cosmetics — paid/user content'],
  ['src/multichat/irc.js', 'platform default name colours — user-name content'],
  ['src/multichat/kick-native-tap.js', 'kick default name colour — user-name content'],
])

/** Per-file hexes that are platform DATA, not our chrome. */
const EXEMPT_HEX = new Map([
  [
    'chrome/background.js',
    new Set([
      '53fc18', // kick default name colour
      'e62117',
      'e91e63',
      'ff6d00',
      'ffd600',
      '00c853',
      '00bfa5',
      '1565c0', // youtube super chat tiers (parity with server SC_TIERS)
    ]),
  ],
  [
    'src/multichat/input.js',
    new Set([
      // twitch's named default name colours + IRC tag fixtures for /sim
      '0000ff',
      '008000',
      'b22222',
      'ff7f50',
      '9acd32',
      'ff4500',
      '2e8b57',
      'daa520',
      'd2691e',
      '5f9ea0',
      '1e90ff',
      'ff69b4',
      '8a2be2',
      '00ff7f',
      '5f87ff',
      'ffd700',
    ]),
  ],
])

/** Built output and generated data — not source. */
const SKIP = (rel) =>
  /(^|\/)(_locales|node_modules|dist|fonts)\//.test(rel) ||
  /(^|\/)(multichat-core|multichat-twitch|emoji-data(\.iso)?)\.js$/.test(rel) ||
  /\.(png|webp|json)$/.test(rel)

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|css|html)$/.test(name)) out.push(p)
  }
  return out
}

const FILES = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'chrome'))]
  .map((p) => ({ path: p, rel: relative(ROOT, p) }))
  .filter((f) => !SKIP(f.rel))

/** Drop inline `hs-exempt-start … hs-exempt-end` regions (user-chosen colour pickers), then comments. */
function code(text, rel) {
  // the zebra stripe and the mention fill are the allowed off-palette values, and only as these tokens
  let t = text
    .replace(/--hs-zebra:\s*#444444;/g, '')
    .replace(/--hs-mention-bg:\s*#5f0000;/g, '')
    .replace(/--hs-mention-bg-stripe:\s*#870000;/g, '')
    .replace(/hs-exempt-start[\s\S]*?hs-exempt-end/g, '')
  t = t.replace(/\/\*[\s\S]*?\*\//g, '')
  if (!rel.endsWith('.css')) t = t.replace(/(^|[^:'"`(\\])\/\/[^\n]*/g, '$1')
  if (rel.endsWith('.html')) t = t.replace(/<!--[\s\S]*?-->/g, '')
  return t
}

const HEX = /(?<![&\w])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])/g
const FUNC = /\b(rgba?|hsla?)\(([^)]*)\)/g

const expand = (h) => {
  const s = h.toLowerCase()
  if (s.length <= 4) return [...s].map((c) => c + c).join('')
  return s
}

/** [{ lit, hex }] for every colour literal in the text, normalised to 6 digits (alpha folded to a flag). */
function literals(t) {
  const out = []
  for (const m of t.matchAll(HEX)) {
    const h = expand(m[1])
    const alpha = h.length === 8 ? h.slice(6) : 'ff'
    if (alpha === '00') continue // fully transparent is "no colour", not a shade
    out.push({ lit: m[0], hex: h.slice(0, 6), partial: alpha !== 'ff' })
  }
  for (const m of t.matchAll(FUNC)) {
    if (m[2].includes('$')) continue // painted from data (paints, cosmetics) — see EXEMPT_FILES
    const nums = m[2].match(/[\d.]+%?/g) || []
    if (m[1].startsWith('hsl')) {
      out.push({ lit: m[0], hex: 'hsl', partial: true })
      continue
    }
    const [r, g, b] = nums.slice(0, 3).map(Number)
    const a = nums[3] === undefined ? 1 : nums[3].endsWith('%') ? Number.parseFloat(nums[3]) / 100 : Number(nums[3])
    if (a === 0) continue // transparent
    const hex = [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
    out.push({ lit: m[0], hex, partial: a < 1 })
  }
  return out
}

const NAMED = [
  'aliceblue',
  'antiquewhite',
  'aqua',
  'aquamarine',
  'azure',
  'beige',
  'bisque',
  'blanchedalmond',
  'blueviolet',
  'brown',
  'burlywood',
  'cadetblue',
  'chartreuse',
  'chocolate',
  'coral',
  'cornflowerblue',
  'cornsilk',
  'crimson',
  'darkblue',
  'darkcyan',
  'darkgoldenrod',
  'darkgray',
  'darkgreen',
  'darkgrey',
  'darkkhaki',
  'darkmagenta',
  'darkolivegreen',
  'darkorange',
  'darkorchid',
  'darkred',
  'darksalmon',
  'darkseagreen',
  'darkslateblue',
  'darkslategray',
  'darkturquoise',
  'darkviolet',
  'deeppink',
  'deepskyblue',
  'dimgray',
  'dimgrey',
  'dodgerblue',
  'firebrick',
  'floralwhite',
  'forestgreen',
  'gainsboro',
  'ghostwhite',
  'gold',
  'goldenrod',
  'gray',
  'grey',
  'green',
  'greenyellow',
  'honeydew',
  'hotpink',
  'indianred',
  'indigo',
  'ivory',
  'khaki',
  'lavender',
  'lavenderblush',
  'lawngreen',
  'lemonchiffon',
  'lightblue',
  'lightcoral',
  'lightcyan',
  'lightgoldenrodyellow',
  'lightgray',
  'lightgreen',
  'lightgrey',
  'lightpink',
  'lightsalmon',
  'lightseagreen',
  'lightskyblue',
  'lightslategray',
  'lightsteelblue',
  'lightyellow',
  'limegreen',
  'linen',
  'maroon',
  'mediumaquamarine',
  'mediumblue',
  'mediumorchid',
  'mediumpurple',
  'mediumseagreen',
  'mediumslateblue',
  'mediumspringgreen',
  'mediumturquoise',
  'mediumvioletred',
  'midnightblue',
  'mintcream',
  'mistyrose',
  'moccasin',
  'navajowhite',
  'oldlace',
  'olive',
  'olivedrab',
  'orange',
  'orangered',
  'orchid',
  'palegoldenrod',
  'palegreen',
  'paleturquoise',
  'palevioletred',
  'papayawhip',
  'peachpuff',
  'peru',
  'pink',
  'plum',
  'powderblue',
  'purple',
  'rebeccapurple',
  'rosybrown',
  'royalblue',
  'saddlebrown',
  'salmon',
  'sandybrown',
  'seagreen',
  'seashell',
  'sienna',
  'silver',
  'skyblue',
  'slateblue',
  'slategray',
  'snow',
  'springgreen',
  'steelblue',
  'tan',
  'teal',
  'thistle',
  'tomato',
  'turquoise',
  'violet',
  'wheat',
  'whitesmoke',
  'yellowgreen',
]
const NAMED_RE = new RegExp(
  `(?:^|[;{\\s])(?:color|background(?:-color)?|border(?:-[a-z]+)*|outline(?:-color)?|fill|stroke|caret-color)\\s*:[^;{}]*(?<![-\\w])(${NAMED.join('|')})(?![-\\w])`,
  'gi',
)

describe('colour doctrine — 8 colours', () => {
  test('reads the source tree at all', () => {
    expect(FILES.length).toBeGreaterThan(40)
    expect(FILES.some((f) => f.rel === 'src/multichat/styles/00-palette.css')).toBe(true)
    expect(FILES.some((f) => f.rel === 'chrome/content.js')).toBe(true)
  })

  test('the exempt list names real files', () => {
    for (const rel of EXEMPT_FILES.keys()) expect(statSync(join(ROOT, rel)).isFile(), rel).toBe(true)
    for (const rel of EXEMPT_HEX.keys()) expect(statSync(join(ROOT, rel)).isFile(), rel).toBe(true)
  })

  test('every colour literal in our chrome is one of the eight', () => {
    const offenders = []
    for (const { path, rel } of FILES) {
      if (EXEMPT_FILES.has(rel)) continue
      const allowed = EXEMPT_HEX.get(rel)
      const t = code(readFileSync(path, 'utf8'), rel)
      for (const { lit, hex, partial } of literals(t)) {
        if (hex === ORANGE) continue // judged by the [H]-only test below
        if (SINGLE.has(hex) && !partial) {
          if (!SINGLE.get(hex).has(rel)) offenders.push(`${rel}: ${lit} (single-definition colour outside its token)`)
          continue
        }
        if (hex === TWITCH && !partial) {
          if (!TWITCH_FILES.has(rel)) offenders.push(`${rel}: ${lit} (twitch purple outside its scopes)`)
          continue
        }
        if (allowed?.has(hex)) continue
        if (!PALETTE.has(hex) || partial) offenders.push(`${rel}: ${lit}`)
      }
    }
    expect(offenders, 'off-palette colour — use one of the eight (or add a reasoned exemption)').toEqual([])
  })

  test('no CSS named colour outside the eight', () => {
    const offenders = []
    for (const { path, rel } of FILES) {
      if (EXEMPT_FILES.has(rel) || !(rel.endsWith('.css') || rel.endsWith('.html'))) continue
      const t = code(readFileSync(path, 'utf8'), rel)
      for (const m of t.matchAll(NAMED_RE)) offenders.push(`${rel}: ${m[1]}`)
    }
    expect(offenders).toEqual([])
  })

  test('#ff8700 is the [H] platform tag and nothing else', () => {
    const where = []
    for (const { path, rel } of FILES) {
      if (EXEMPT_FILES.has(rel)) continue
      const t = code(readFileSync(path, 'utf8'), rel)
      for (const line of t.split('\n')) {
        if (/#ff8700\b/i.test(line) || /rgba?\(\s*255\s*,\s*135\s*,\s*0/i.test(line))
          where.push(`${rel}: ${line.trim()}`)
      }
    }
    const allowed = [
      ['src/multichat/styles/00-palette.css', '--hs-plat-hs'],
      ['src/lib/palette.js', 'heatsync:'],
    ]
    const stray = where.filter((w) => !allowed.some(([f, needle]) => w.startsWith(`${f}:`) && w.includes(needle)))
    expect(stray, 'orange is only ever the [H] tag').toEqual([])
    expect(where.length, 'both [H] definitions must exist').toBe(allowed.length)
  })

  test('the palette tokens are the eight (+ the [H] orange)', () => {
    const css = readFileSync(join(STYLES, '00-palette.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const bad = []
    for (const m of css.matchAll(/(--hs-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
      const h = expand(m[2].slice(1))
      const ONE = {
        '--hs-plat-twitch': TWITCH,
        '--hs-zebra': '444444',
        '--hs-mention-bg': '5f0000',
        '--hs-mention-bg-stripe': '870000',
        '--hs-plat-hs': ORANGE,
        '--hs-mod': '00ad03',
        '--hs-dim': '808080',
        '--hs-dim-stripe': 'bcbcbc',
      }
      if (m[1] in ONE ? h !== ONE[m[1]] : !PALETTE.has(h)) bad.push(`${m[1]}: ${m[2]}`)
    }
    expect(bad).toEqual([])
  })

  test('platform tags: [T] twitch purple, [K] green, [Y] red, [H] orange', () => {
    const css = readFileSync(join(STYLES, '00-palette.css'), 'utf8')
    const tok = (n) => css.match(new RegExp(`${n}:\\s*(#[0-9a-fA-F]+)`))?.[1].toLowerCase()
    expect(tok('--hs-plat-twitch')).toBe('#c8a8ff')
    expect(tok('--hs-plat-kick')).toBe('#00ff00')
    expect(tok('--hs-plat-youtube')).toBe('#ff0000')
    expect(tok('--hs-plat-hs')).toBe('#ff8700')
    const js = readFileSync(join(ROOT, 'src', 'lib', 'palette.js'), 'utf8')
    for (const [k, v] of [
      ['twitch', '#c8a8ff'],
      ['kick', '#00ff00'],
      ['youtube', '#ff0000'],
      ['heatsync', '#ff8700'],
    ])
      expect(js).toMatch(new RegExp(`${k}:\\s*'${v}'`))
  })

  test('the palette is actually used', () => {
    let uses = 0
    for (const f of readdirSync(STYLES).filter((x) => x.endsWith('.css'))) {
      uses += (readFileSync(join(STYLES, f), 'utf8').match(/var\(--hs-/g) || []).length
    }
    expect(uses).toBeGreaterThan(600)
  })
})

describe('single-definition colours', () => {
  test('mod green and dim gray are each spelled exactly once per layer', () => {
    const css = readFileSync(join(STYLES, '00-palette.css'), 'utf8')
    expect(css.match(/#00ad03/gi)).toHaveLength(1)
    expect(css.match(/#808080/gi)).toHaveLength(1)
    expect(css.match(/#bcbcbc/gi)).toHaveLength(1)
    const js = readFileSync(join(ROOT, 'src', 'lib', 'palette.js'), 'utf8')
    expect(js).toMatch(/HS_MOD_GREEN = '#00ad03'/)
  })

  test('dim gray is used for exactly two roles: reply-context and fully-read tabs', () => {
    const users = []
    for (const f of readdirSync(STYLES).filter((x) => x.endsWith('.css'))) {
      const css = readFileSync(join(STYLES, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*var\(--hs-dim\)[^{}]*)\}/g))
        users.push(m[1].trim().replace(/\s+/g, ' '))
    }
    // readdirSync order is filesystem-defined (tmpfs ≠ btrfs) — compare as a set
    expect(users.sort()).toEqual(['.hs-mc-reply-ctx', '.hs-mc-tab'])
    expect(readFileSync(join(STYLES, '08-message-rows.css'), 'utf8')).toMatch(
      /\.hs-mc-zebra \.hs-mc-reply-ctx[^{]*\{\s*color: var\(--hs-dim-stripe\)/,
    )
  })
})

// @ts-check
// BTTV/FFZ-style emote modifier system — single source of truth.
// Bundled into every content script via build.js readLib(). The site's twin is
// client/utils/hs-modifiers.js: the tables and the rule are the same there
// (the site's tests compare them), the comments are not.
//
// What the words add up to and which emote a word changes is one rule for every
// app, as data: emote-mods.vectors.json (the site's shared/ copy is the source).
// - A BetterTTV-shaped word (`w!`) changes the emote AFTER it, a FrankerFaceZ
//   word (`ffzX`) the one BEFORE it; each falls back to the other side (hsModSide)
// - Scale mods compound: "Kappa w! w!" → 4× wide (clamped ±MAX_SCALE)
// - Rotations add: "l! l!" → -180°
// - Animated effects (party/shake/rainbow/bounce/jam/spin/slide/arrive/leave)
//   emit a `hs-fx-*` CLASS whose @keyframes live in the emote CSS
// - Chained shorthand: "w!h!ffzX" peels into [wide, flipH, flipH]
// - Color: "c!#888" tints via hue-rotate (peel-friendly: "w!c!#888h!")
// - Prefix completion: "w" → "w!", "ffzrai" → "ffzRainbow"

// canonical effect name → how it renders
const HS_FX = Object.freeze({
  wide: { scale: [2, 1] },
  tall: { scale: [1, 2] },
  flipH: { scale: [-1, 1] },
  flipV: { scale: [1, -1] },
  rotateL: { rotate: -90 },
  rotateR: { rotate: 90 },
  cursed: { filter: 'grayscale(1) brightness(0.7) contrast(2.5)' },
  hyper: { filter: 'brightness(0.2) sepia(1) brightness(2.2) contrast(3) saturate(8)', anim: 'hyper' },
  // rainbow/party drive hue via a registered custom prop referenced INSIDE the
  // composed filter, so the animated hue STACKS with a static filter (cursed)
  // instead of the keyframe replacing it. Defaults to 0deg until animated.
  party: { filter: 'sepia(0.5) saturate(2.5) hue-rotate(var(--hs-fx-hue,0deg))', anim: 'party' },
  shake: { anim: 'shake' },
  rainbow: { filter: 'hue-rotate(var(--hs-fx-hue,0deg))', anim: 'rainbow' },
  bounce: { anim: 'bounce' },
  jam: { anim: 'jam' },
  spin: { anim: 'spin' },
  slide: { anim: 'slide' },
  arrive: { anim: 'arrive' },
  leave: { anim: 'leave' },
  zeroWidth: { zero: true },
})

// No prototype: a word is looked up here as typed, and `constructor`, `toString` or
// `valueOf` after an emote read as a modifier and left the line.
const HS_MOD_TOKENS = Object.freeze(
  Object.assign(Object.create(null), {
    // BTTV `!` modifiers
    'w!': 'wide',
    'h!': 'flipH',
    'v!': 'flipV',
    'z!': 'zeroWidth',
    'c!': 'cursed',
    'l!': 'rotateL',
    'r!': 'rotateR',
    'p!': 'party',
    's!': 'shake',
    'x!': 'flipH',
    'y!': 'flipV',
    // FFZ effect emotes (static)
    ffzX: 'flipH',
    ffzY: 'flipV',
    ffzW: 'wide',
    ffzWide: 'wide',
    ffzTall: 'tall',
    ffzCursed: 'cursed',
    // FFZ effect emotes (animated)
    ffzHyper: 'hyper',
    ffzRainbow: 'rainbow',
    ffzBounce: 'bounce',
    ffzJam: 'jam',
    ffzSlide: 'slide',
    ffzArrive: 'arrive',
    ffzLeave: 'leave',
    ffzSpin: 'spin',
  }),
)

const HS_MOD_TOKEN_KEYS = Object.keys(HS_MOD_TOKENS)
const HS_MOD_KEYS_BY_LEN = HS_MOD_TOKEN_KEYS.slice().sort((a, b) => b.length - a.length)

const HS_MOD_CLASS_TO_TOKEN = Object.freeze({
  wide: 'w!',
  tall: 'ffzTall',
  flipH: 'h!',
  flipV: 'v!',
  rotateL: 'l!',
  rotateR: 'r!',
  cursed: 'c!',
  hyper: 'ffzHyper',
  party: 'p!',
  shake: 's!',
  rainbow: 'ffzRainbow',
  bounce: 'ffzBounce',
  jam: 'ffzJam',
  spin: 'ffzSpin',
  slide: 'ffzSlide',
  arrive: 'ffzArrive',
  leave: 'ffzLeave',
  zeroWidth: 'z!',
})

const HS_MOD_C_HEX_RE = /^c!#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const HS_MOD_C_HEX_PEEL_RE = /^c!#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})/
const HS_MOD_MAX_SCALE = 4

const HS_FX_ANIM_CLASSES = Object.freeze(
  [
    ...new Set(
      Object.values(HS_FX)
        .map((f) => /** @type {{anim?: string}} */ (f).anim)
        .filter(Boolean),
    ),
  ].map((a) => `hs-fx-${a}`),
)

function hsModHexToHue(hex) {
  if (hex.length === 3)
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('')
  const r = parseInt(hex.slice(0, 2), 16) / 255
  const g = parseInt(hex.slice(2, 4), 16) / 255
  const b = parseInt(hex.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min
  let h = 0
  if (d) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return Math.round(h)
}

function hsModResolvePrefix(word) {
  if (!word) return null
  if (HS_MOD_TOKENS[word]) return word
  if (HS_MOD_C_HEX_RE.test(word)) return word
  const lower = word.toLowerCase()
  for (const tok of HS_MOD_TOKEN_KEYS) {
    if (tok.toLowerCase() === lower) return tok
  }
  const matches = HS_MOD_TOKEN_KEYS.filter((k) => k.toLowerCase().startsWith(lower))
  return matches.length === 1 ? matches[0] : null
}

function hsModPeelChain(word) {
  if (!word) return null
  const mods = []
  const words = []
  let hue = null
  let rem = word
  while (rem.length > 0) {
    const cm = rem.match(HS_MOD_C_HEX_PEEL_RE)
    if (cm) {
      hue = hsModHexToHue(cm[1])
      words.push(cm[0])
      rem = rem.slice(cm[0].length)
      continue
    }
    let matched = false
    for (const k of HS_MOD_KEYS_BY_LEN) {
      if (rem.startsWith(k)) {
        mods.push(HS_MOD_TOKENS[k])
        words.push(k)
        rem = rem.slice(k.length)
        matched = true
        break
      }
    }
    if (matched) continue
    return null
  }
  return mods.length || hue != null ? { mods, hue, words } : null
}

function hsModClassify(word, opts) {
  if (!word) return { kind: 'plain' }
  const allowPrefix = opts?.allowPrefix
  const exact = HS_MOD_TOKENS[word]
  if (exact) return { kind: 'modifier', mods: [exact], hue: null, words: [word] }
  const cm = word.match(HS_MOD_C_HEX_RE)
  if (cm) return { kind: 'modifier', mods: [], hue: hsModHexToHue(cm[1]), words: [word] }
  const peeled = hsModPeelChain(word)
  if (peeled) return { kind: 'modifier', ...peeled }
  if (allowPrefix) {
    const resolved = hsModResolvePrefix(word)
    if (resolved && resolved !== word) {
      const r2 = hsModClassify(resolved)
      if (r2.kind === 'modifier') return Object.assign({}, r2, { resolvedFrom: word })
    }
  }
  return { kind: 'plain' }
}

// Which emote a modifier word changes: 'next', 'last', or null when it stays as
// typed. Each provider's own direction first, so a line means here what it means
// to that provider's users: a BetterTTV-shaped word (`w!`, a tint, a chain led by
// one) takes the emote after it, a FrankerFaceZ one (`ffzX`) the emote before it.
// The other side is only the fallback. `emoteNext` answers whether an emote
// follows with nothing but modifiers between: a modifier never reaches over text.
function hsModSide(word, hasLast, emoteNext) {
  if (word[1] === '!' ? emoteNext() : !hasLast && emoteNext()) return 'next'
  return hasLast ? 'last' : null
}

// A chip as words: the emote's name with its modifier words where each one is
// its own whatever stands beside the chip. BetterTTV-shaped words go before the
// name and FrankerFaceZ ones after, the side hsModSide reads first: `Kappa w!`
// followed by another emote would be read as that emote's. An emote whose own
// name is a modifier word (`ffzX`) is only ever an emote with nothing ahead of
// it to bind to, so its words all follow it.
function hsModChipText(name, words) {
  const list = typeof words === 'string' ? words.split(/\s+/).filter(Boolean) : words || []
  if (!name || !list.length) return name || ''
  if (hsModClassify(name).kind === 'modifier') return [name, ...list].join(' ')
  return [...list.filter((w) => w[1] === '!'), name, ...list.filter((w) => w[1] !== '!')].join(' ')
}

function hsModComposeAll(mods, hue) {
  let sx = 1,
    sy = 1,
    rotate = 0,
    zero = false
  const filters = []
  const anims = []
  if (mods)
    for (const m of mods) {
      const fx = HS_FX[m]
      if (!fx) continue
      if (fx.scale) {
        sx *= fx.scale[0]
        sy *= fx.scale[1]
      }
      if (fx.rotate) rotate += fx.rotate
      if (fx.filter) filters.push(fx.filter)
      if (fx.anim && !anims.includes(fx.anim)) anims.push(fx.anim)
      if (fx.zero) zero = true
    }
  sx = Math.min(Math.max(sx, -HS_MOD_MAX_SCALE), HS_MOD_MAX_SCALE)
  sy = Math.min(Math.max(sy, -HS_MOD_MAX_SCALE), HS_MOD_MAX_SCALE)
  if (hue != null) filters.push(`hue-rotate(${hue}deg) saturate(1.6)`)
  return { sx, sy, rotate, filter: filters.join(' ').trim(), anims, zero }
}

function hsModComposeTransform(mods) {
  const { sx, sy, rotate } = hsModComposeAll(mods, null)
  return { sx, sy, rotate }
}

function hsModComposeFilter(mods, hue) {
  return hsModComposeAll(mods, hue).filter
}

function hsModComposeAnimClasses(mods) {
  return hsModComposeAll(mods, null).anims.map((a) => `hs-fx-${a}`)
}

function hsModRead(el) {
  if (!el?.dataset) return { mods: [], hue: null, words: [] }
  return {
    mods: el.dataset.hsMods ? el.dataset.hsMods.split(',').filter(Boolean) : [],
    hue: el.dataset.hsHue != null && el.dataset.hsHue !== '' ? Number(el.dataset.hsHue) : null,
    words: el.dataset.hsWords ? el.dataset.hsWords.split(/\s+/).filter(Boolean) : [],
  }
}

function hsModTransformStr(sx, sy, rotate) {
  let t = ''
  if (sx !== 1 || sy !== 1) t += `scale(${sx}, ${sy})`
  if (rotate) t += `${t ? ' ' : ''}rotate(${rotate}deg)`
  return t
}

function hsModApplyToImg(img, addMods, addHue, addWords, opts) {
  if (!img) return
  const additive = opts?.additive !== false
  const cur = hsModRead(img)
  const finalMods = additive ? cur.mods.concat(addMods || []) : addMods || []
  const finalWords = additive ? cur.words.concat(addWords || []) : addWords || []
  let finalHue = addHue
  if (finalHue == null && additive) finalHue = cur.hue
  img.dataset.hsMods = finalMods.join(',')
  img.dataset.hsWords = finalWords.join(' ')
  if (finalHue != null) img.dataset.hsHue = String(finalHue)
  else delete img.dataset.hsHue
  const { sx, sy, rotate, filter, anims, zero } = hsModComposeAll(finalMods, finalHue)
  const transform = hsModTransformStr(sx, sy, rotate)
  if (transform) {
    img.style.setProperty('transform', transform, 'important')
    img.style.setProperty('transform-origin', 'center', 'important')
    const fx = Math.abs(sx)
    img.style.setProperty('margin', `0 calc(0.5em * ${Math.max(0, fx - 1)})`, 'important')
  } else {
    img.style.removeProperty('transform')
    img.style.removeProperty('transform-origin')
    img.style.removeProperty('margin')
  }
  if (filter) img.style.setProperty('filter', filter, 'important')
  else img.style.removeProperty('filter')
  for (const c of HS_FX_ANIM_CLASSES) img.classList.remove(c)
  for (const a of anims) img.classList.add(`hs-fx-${a}`)
  img.classList.toggle('hs-fx-zero', zero)
}

function hsModBuildStyleAttr(mods, hue) {
  const { sx, sy, rotate, filter } = hsModComposeAll(mods, hue)
  const transform = hsModTransformStr(sx, sy, rotate)
  let style = ''
  if (transform) {
    style += `transform:${transform} !important;transform-origin:center !important;`
    const fx = Math.abs(sx),
      fy = Math.abs(sy)
    if (fx > 1) {
      const halfX = `calc(var(--hs-emote-width,28px) * ${(fx - 1) / 2})`
      style += `margin-left:${halfX} !important;margin-right:${halfX} !important;`
    }
    if (fy > 1) {
      const halfY = `calc(var(--hs-emote-height,28px) * ${(fy - 1) / 2})`
      style += `margin-top:${halfY} !important;margin-bottom:${halfY} !important;`
    }
  }
  if (filter) style += `filter:${filter} !important;`
  return style
}

// The `hs-fx-*` animation classes to add to a rendered emote img className (for
// the string-render path, which can't carry an inline style-only animation).
function hsModAnimClassAttr(mods) {
  const classes = hsModComposeAnimClasses(mods)
  return classes.length ? ` ${classes.join(' ')}` : ''
}

// Used by multichat string-render to attach modifier styles to emote wrappers.
function hsModInjectWrapperStyle(html, styleStr) {
  if (!styleStr) return html
  return html.replace(/^(<span[^>]*?)(\sstyle="([^"]*)")?(>)/, (_m, p1, _full, existing, gt) => {
    if (existing) return `${p1} style="${existing};${styleStr}"${gt}`
    return `${p1} style="${styleStr}"${gt}`
  })
}

// Convert mod-class array back to wire tokens for sending. Hue lossy → c!#hex
// can't recover original hex (we only stored degrees). Recipient still tints.
function hsModWordsFromState(mods, hue) {
  const out = []
  for (const m of mods || []) {
    out.push(HS_MOD_CLASS_TO_TOKEN[m] || `?${m}`)
  }
  if (hue != null) {
    const h = ((hue % 360) + 360) % 360
    const c = 1
    const x = 1 - Math.abs(((h / 60) % 2) - 1)
    let r = 0,
      g = 0,
      b = 0
    if (h < 60) {
      r = c
      g = x
      b = 0
    } else if (h < 120) {
      r = x
      g = c
      b = 0
    } else if (h < 180) {
      r = 0
      g = c
      b = x
    } else if (h < 240) {
      r = 0
      g = x
      b = c
    } else if (h < 300) {
      r = x
      g = 0
      b = c
    } else {
      r = c
      g = 0
      b = x
    }
    const hex =
      '#' +
      [r, g, b]
        .map((v) =>
          Math.round(v * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')
    out.push(`c!${hex}`)
  }
  return out
}

export {
  HS_FX_ANIM_CLASSES,
  HS_MOD_CLASS_TO_TOKEN,
  HS_MOD_MAX_SCALE,
  HS_MOD_TOKENS,
  hsModAnimClassAttr,
  hsModApplyToImg,
  hsModBuildStyleAttr,
  hsModChipText,
  hsModClassify,
  hsModComposeAll,
  hsModComposeAnimClasses,
  hsModComposeFilter,
  hsModComposeTransform,
  hsModHexToHue,
  hsModInjectWrapperStyle,
  hsModPeelChain,
  hsModRead,
  hsModResolvePrefix,
  hsModSide,
  hsModTransformStr,
  hsModWordsFromState,
}

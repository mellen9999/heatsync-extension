import { describe, expect, test } from 'bun:test'
import {
  HS_FX_ANIM_CLASSES,
  HS_MOD_CLASS_TO_TOKEN,
  HS_MOD_MAX_SCALE,
  HS_MOD_TOKENS,
  hsModAnimClassAttr,
  hsModBuildStyleAttr,
  hsModClassify,
  hsModComposeAll,
  hsModComposeAnimClasses,
  hsModComposeFilter,
  hsModComposeTransform,
  hsModHexToHue,
  hsModInjectWrapperStyle,
  hsModPeelChain,
  hsModResolvePrefix,
  hsModWordsFromState,
} from '../src/lib/modifiers.js'

// ── HS_MOD_TOKENS — canonical BTTV `!` + FFZ effect emotes ────────────────────

describe('HS_MOD_TOKENS', () => {
  test('w! → wide', () => expect(HS_MOD_TOKENS['w!']).toBe('wide'))
  test('h! → flipH (BTTV: flip-horizontal, NOT tall)', () => expect(HS_MOD_TOKENS['h!']).toBe('flipH'))
  test('v! → flipV', () => expect(HS_MOD_TOKENS['v!']).toBe('flipV'))
  test('l! → rotateL (BTTV: rotate-left)', () => expect(HS_MOD_TOKENS['l!']).toBe('rotateL'))
  test('r! → rotateR (BTTV: rotate-right)', () => expect(HS_MOD_TOKENS['r!']).toBe('rotateR'))
  test('c! → cursed', () => expect(HS_MOD_TOKENS['c!']).toBe('cursed'))
  test('z! → zeroWidth (BTTV: zero-space)', () => expect(HS_MOD_TOKENS['z!']).toBe('zeroWidth'))
  test('p! → party', () => expect(HS_MOD_TOKENS['p!']).toBe('party'))
  test('s! → shake', () => expect(HS_MOD_TOKENS['s!']).toBe('shake'))
  test('x! → flipH, y! → flipV', () => {
    expect(HS_MOD_TOKENS['x!']).toBe('flipH')
    expect(HS_MOD_TOKENS['y!']).toBe('flipV')
  })
  test('ffzX → flipH, ffzY → flipV, ffzW → wide, ffzCursed → cursed', () => {
    expect(HS_MOD_TOKENS.ffzX).toBe('flipH')
    expect(HS_MOD_TOKENS.ffzY).toBe('flipV')
    expect(HS_MOD_TOKENS.ffzW).toBe('wide')
    expect(HS_MOD_TOKENS.ffzCursed).toBe('cursed')
  })
  test('animated FFZ effect emotes', () => {
    expect(HS_MOD_TOKENS.ffzHyper).toBe('hyper')
    expect(HS_MOD_TOKENS.ffzRainbow).toBe('rainbow')
    expect(HS_MOD_TOKENS.ffzBounce).toBe('bounce')
    expect(HS_MOD_TOKENS.ffzJam).toBe('jam')
    expect(HS_MOD_TOKENS.ffzSlide).toBe('slide')
    expect(HS_MOD_TOKENS.ffzArrive).toBe('arrive')
    expect(HS_MOD_TOKENS.ffzLeave).toBe('leave')
    expect(HS_MOD_TOKENS.ffzSpin).toBe('spin')
  })
  test('is frozen', () => expect(Object.isFrozen(HS_MOD_TOKENS)).toBe(true))
})

describe('HS_MOD_CLASS_TO_TOKEN', () => {
  test('wide → w!', () => expect(HS_MOD_CLASS_TO_TOKEN.wide).toBe('w!'))
  test('flipH → h!', () => expect(HS_MOD_CLASS_TO_TOKEN.flipH).toBe('h!'))
  test('flipV → v!', () => expect(HS_MOD_CLASS_TO_TOKEN.flipV).toBe('v!'))
  test('rotateL → l!, rotateR → r!', () => {
    expect(HS_MOD_CLASS_TO_TOKEN.rotateL).toBe('l!')
    expect(HS_MOD_CLASS_TO_TOKEN.rotateR).toBe('r!')
  })
  test('cursed → c!, party → p!, shake → s!', () => {
    expect(HS_MOD_CLASS_TO_TOKEN.cursed).toBe('c!')
    expect(HS_MOD_CLASS_TO_TOKEN.party).toBe('p!')
    expect(HS_MOD_CLASS_TO_TOKEN.shake).toBe('s!')
  })
  test('is frozen', () => expect(Object.isFrozen(HS_MOD_CLASS_TO_TOKEN)).toBe(true))
})

test('HS_MOD_MAX_SCALE is 4', () => expect(HS_MOD_MAX_SCALE).toBe(4))

// ── hsModHexToHue ─────────────────────────────────────────────────────────────

describe('hsModHexToHue', () => {
  test('pure red → 0°', () => expect(hsModHexToHue('ff0000')).toBe(0))
  test('pure green → 120°', () => expect(hsModHexToHue('00ff00')).toBe(120))
  test('pure blue → 240°', () => expect(hsModHexToHue('0000ff')).toBe(240))
  test('achromatic → 0°', () => {
    expect(hsModHexToHue('000000')).toBe(0)
    expect(hsModHexToHue('ffffff')).toBe(0)
  })
  test('3-char shorthand equals 6-char', () => {
    expect(hsModHexToHue('f00')).toBe(hsModHexToHue('ff0000'))
    expect(hsModHexToHue('0f0')).toBe(hsModHexToHue('00ff00'))
  })
  test('integer in [0,359]', () => {
    for (const hex of ['ff8700', 'aabbcc', '123456', 'fedcba']) {
      const h = hsModHexToHue(hex)
      expect(Number.isInteger(h)).toBe(true)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(359)
    }
  })
})

// ── hsModResolvePrefix ────────────────────────────────────────────────────────

describe('hsModResolvePrefix', () => {
  test('exact tokens resolve to self', () => {
    expect(hsModResolvePrefix('w!')).toBe('w!')
    expect(hsModResolvePrefix('ffzX')).toBe('ffzX')
  })
  test('case-insensitive', () => {
    expect(hsModResolvePrefix('ffzx')).toBe('ffzX')
    expect(hsModResolvePrefix('ffzrainbow')).toBe('ffzRainbow')
  })
  test('unique prefix', () => {
    expect(hsModResolvePrefix('w')).toBe('w!')
    expect(hsModResolvePrefix('ffzrai')).toBe('ffzRainbow')
    expect(hsModResolvePrefix('ffzbo')).toBe('ffzBounce')
  })
  test('ambiguous prefix → null', () => expect(hsModResolvePrefix('ffz')).toBeNull())
  test('empty/null/no-match → null', () => {
    expect(hsModResolvePrefix('')).toBeNull()
    expect(hsModResolvePrefix(null)).toBeNull()
    expect(hsModResolvePrefix('Kappa')).toBeNull()
  })
  test('valid c!#hex passes through', () => expect(hsModResolvePrefix('c!#ff8700')).toBe('c!#ff8700'))
})

// ── hsModPeelChain ────────────────────────────────────────────────────────────

describe('hsModPeelChain', () => {
  test('single token', () => {
    expect(hsModPeelChain('w!')).toEqual({ mods: ['wide'], hue: null, words: ['w!'] })
  })
  test('two-token flip chain h!v!', () => {
    const r = hsModPeelChain('h!v!')
    expect(r.mods).toEqual(['flipH', 'flipV'])
    expect(r.words).toEqual(['h!', 'v!'])
  })
  test('chain w!c!ffzSpin', () => {
    const r = hsModPeelChain('w!c!ffzSpin')
    expect(r.mods).toContain('wide')
    expect(r.mods).toContain('cursed')
    expect(r.mods).toContain('spin')
  })
  test('c!#hex color modifier', () => {
    const r = hsModPeelChain('c!#ff8700')
    expect(r.mods).toEqual([])
    expect(typeof r.hue).toBe('number')
    expect(r.words).toEqual(['c!#ff8700'])
  })
  test('c!#hex hue matches hsModHexToHue', () => {
    expect(hsModPeelChain('c!#ff8700').hue).toBe(hsModHexToHue('ff8700'))
  })
  test('w!c!#ff8700 → wide + color, no cursed', () => {
    const r = hsModPeelChain('w!c!#ff8700')
    expect(r.mods).toContain('wide')
    expect(r.mods).not.toContain('cursed')
    expect(r.hue).not.toBeNull()
  })
  test('c!#ff8700h! → color + flipH', () => {
    const r = hsModPeelChain('c!#ff8700h!')
    expect(r.mods).toContain('flipH')
    expect(r.mods).not.toContain('cursed')
  })
  test('bare c! → cursed, hue null', () => {
    const r = hsModPeelChain('c!')
    expect(r.mods).toContain('cursed')
    expect(r.hue).toBeNull()
  })
  test('rotate chain l!r!', () => {
    expect(hsModPeelChain('l!r!').mods).toEqual(['rotateL', 'rotateR'])
  })
  test('c! followed by non-hex → null', () => expect(hsModPeelChain('c!xyz')).toBeNull())
  test('plain/empty/null → null', () => {
    expect(hsModPeelChain('Kappa')).toBeNull()
    expect(hsModPeelChain('')).toBeNull()
    expect(hsModPeelChain(null)).toBeNull()
    expect(hsModPeelChain('w!Kappa')).toBeNull()
  })
})

// ── hsModClassify ─────────────────────────────────────────────────────────────

describe('hsModClassify', () => {
  test('plain/null → plain', () => {
    expect(hsModClassify('Kappa').kind).toBe('plain')
    expect(hsModClassify(null).kind).toBe('plain')
  })
  test('w! → [wide]', () => expect(hsModClassify('w!').mods).toEqual(['wide']))
  test('h! → [flipH]', () => expect(hsModClassify('h!').mods).toEqual(['flipH']))
  test('l! → [rotateL], r! → [rotateR]', () => {
    expect(hsModClassify('l!').mods).toEqual(['rotateL'])
    expect(hsModClassify('r!').mods).toEqual(['rotateR'])
  })
  test('v! → [flipV], c! → [cursed]', () => {
    expect(hsModClassify('v!').mods).toEqual(['flipV'])
    expect(hsModClassify('c!').mods).toContain('cursed')
  })
  test('ffzX → [flipH], ffzSpin → [spin], ffzRainbow → [rainbow]', () => {
    expect(hsModClassify('ffzX').mods).toEqual(['flipH'])
    expect(hsModClassify('ffzSpin').mods).toEqual(['spin'])
    expect(hsModClassify('ffzRainbow').mods).toEqual(['rainbow'])
  })
  test('c!#hex → modifier with hue', () => {
    const r = hsModClassify('c!#ff8700')
    expect(r.kind).toBe('modifier')
    expect(r.mods).toEqual([])
    expect(typeof r.hue).toBe('number')
  })
  test('allowPrefix resolves w → w!', () => {
    const r = hsModClassify('w', { allowPrefix: true })
    expect(r.kind).toBe('modifier')
    expect(r.resolvedFrom).toBe('w')
  })
  test('no allowPrefix → plain', () => expect(hsModClassify('w').kind).toBe('plain'))
})

// ── hsModComposeTransform / hsModComposeAll ───────────────────────────────────

describe('hsModComposeTransform', () => {
  test('empty/null → identity', () => {
    expect(hsModComposeTransform([])).toEqual({ sx: 1, sy: 1, rotate: 0 })
    expect(hsModComposeTransform(null)).toEqual({ sx: 1, sy: 1, rotate: 0 })
  })
  test('wide/tall scale', () => {
    expect(hsModComposeTransform(['wide'])).toEqual({ sx: 2, sy: 1, rotate: 0 })
    expect(hsModComposeTransform(['tall'])).toEqual({ sx: 1, sy: 2, rotate: 0 })
  })
  test('flipH/flipV negate', () => {
    expect(hsModComposeTransform(['flipH'])).toEqual({ sx: -1, sy: 1, rotate: 0 })
    expect(hsModComposeTransform(['flipV'])).toEqual({ sx: 1, sy: -1, rotate: 0 })
  })
  test('rotateL/rotateR add degrees', () => {
    expect(hsModComposeTransform(['rotateL']).rotate).toBe(-90)
    expect(hsModComposeTransform(['rotateR']).rotate).toBe(90)
    expect(hsModComposeTransform(['rotateL', 'rotateL']).rotate).toBe(-180)
  })
  test('wide compounds + clamps at MAX_SCALE', () => {
    expect(hsModComposeTransform(['wide', 'wide']).sx).toBe(4)
    expect(hsModComposeTransform(Array(10).fill('wide')).sx).toBe(4)
    expect(hsModComposeTransform(['flipH', 'flipH'])).toEqual({ sx: 1, sy: 1, rotate: 0 })
    expect(hsModComposeTransform(['wide', 'flipH'])).toEqual({ sx: -2, sy: 1, rotate: 0 })
  })
  test('cursed/anim mods do not scale', () => {
    expect(hsModComposeTransform(['cursed', 'rainbow'])).toEqual({ sx: 1, sy: 1, rotate: 0 })
  })
})

// ── hsModComposeFilter — canonical recipes ────────────────────────────────────

describe('hsModComposeFilter', () => {
  test('empty → ""', () => expect(hsModComposeFilter([], null)).toBe(''))
  test('cursed → grayscale/brightness/contrast (canonical)', () => {
    const f = hsModComposeFilter(['cursed'], null)
    expect(f).toContain('grayscale(1)')
    expect(f).toContain('brightness(0.7)')
    expect(f).toContain('contrast(2.5)')
  })
  test('hue → hue-rotate + saturate', () => {
    const f = hsModComposeFilter([], 120)
    expect(f).toContain('hue-rotate(120deg)')
    expect(f).toContain('saturate(1.6)')
  })
  test('wide alone → ""', () => expect(hsModComposeFilter(['wide'], null)).toBe(''))
  test('trimmed', () => {
    const f = hsModComposeFilter(['cursed'], null)
    expect(f).toBe(f.trim())
  })
})

// ── animated effects ──────────────────────────────────────────────────────────

describe('animated effects', () => {
  test('emits hs-fx-* classes', () => {
    expect(hsModComposeAnimClasses(['rainbow'])).toEqual(['hs-fx-rainbow'])
    expect(hsModComposeAnimClasses(['party'])).toEqual(['hs-fx-party'])
    expect(hsModComposeAnimClasses(['bounce', 'jam'])).toEqual(['hs-fx-bounce', 'hs-fx-jam'])
  })
  test('hsModAnimClassAttr formats a leading-space class string', () => {
    expect(hsModAnimClassAttr(['spin'])).toBe(' hs-fx-spin')
    expect(hsModAnimClassAttr(['wide'])).toBe('')
  })
  test('hyper = filter + shake anim', () => {
    const r = hsModComposeAll(['hyper'], null)
    expect(r.filter).toContain('sepia(1)')
    expect(r.anims).toContain('hyper')
  })
  test('rainbow var-hue STACKS with cursed static filter', () => {
    const r = hsModComposeAll(['cursed', 'rainbow'], null)
    expect(r.filter).toContain('grayscale(1)')
    expect(r.filter).toContain('hue-rotate(var(--hs-fx-hue,0deg))')
    expect(r.anims).toContain('rainbow')
  })
  test('static mods emit no anim classes', () => {
    expect(hsModComposeAnimClasses(['wide', 'flipH', 'cursed'])).toEqual([])
  })
  test('z! sets zero flag', () => {
    expect(hsModComposeAll(['zeroWidth'], null).zero).toBe(true)
    expect(hsModComposeAll(['wide'], null).zero).toBe(false)
  })
  test('HS_FX_ANIM_CLASSES lists animations', () => {
    expect(HS_FX_ANIM_CLASSES).toContain('hs-fx-rainbow')
    expect(HS_FX_ANIM_CLASSES).toContain('hs-fx-slide')
  })
})

// ── hsModBuildStyleAttr ───────────────────────────────────────────────────────

describe('hsModBuildStyleAttr', () => {
  test('empty → ""', () => expect(hsModBuildStyleAttr([], null)).toBe(''))
  test('wide → transform:scale(2, 1)', () => {
    expect(hsModBuildStyleAttr(['wide'], null)).toContain('transform:scale(2, 1)')
  })
  test('flipH → scale(-1, 1)', () => {
    expect(hsModBuildStyleAttr(['flipH'], null)).toContain('transform:scale(-1, 1)')
  })
  test('rotateR → rotate(90deg)', () => {
    expect(hsModBuildStyleAttr(['rotateR'], null)).toContain('rotate(90deg)')
  })
  test('cursed → grayscale filter, no transform', () => {
    const s = hsModBuildStyleAttr(['cursed'], null)
    expect(s).toContain('grayscale(1)')
    expect(s).not.toContain('transform:')
  })
  test('hue → filter', () => expect(hsModBuildStyleAttr([], 120)).toContain('hue-rotate(120deg)'))
})

// ── hsModInjectWrapperStyle ───────────────────────────────────────────────────

describe('hsModInjectWrapperStyle', () => {
  test('empty styleStr → unchanged', () => {
    const html = '<span class="hs-emote">img</span>'
    expect(hsModInjectWrapperStyle(html, '')).toBe(html)
  })
  test('injects into span without style', () => {
    const out = hsModInjectWrapperStyle('<span class="hs-emote">img</span>', 'transform:scale(2, 1) !important;')
    expect(out).toContain('style="transform:scale(2, 1) !important;"')
  })
  test('merges with existing style', () => {
    const out = hsModInjectWrapperStyle(
      '<span class="hs-emote" style="color:red">img</span>',
      'transform:scale(2, 1) !important;',
    )
    expect(out).toContain('color:red')
    expect(out).toContain('transform:scale(2, 1)')
  })
  test('no double style attr', () => {
    const twice = hsModInjectWrapperStyle(hsModInjectWrapperStyle('<span>img</span>', 'x:1;'), 'y:2;')
    expect((twice.match(/style=/g) || []).length).toBe(1)
  })
})

// ── hsModWordsFromState ───────────────────────────────────────────────────────

describe('hsModWordsFromState', () => {
  test('empty → []', () => expect(hsModWordsFromState([], null)).toEqual([]))
  test('canonical effects → shortest token', () => {
    expect(hsModWordsFromState(['wide'], null)).toEqual(['w!'])
    expect(hsModWordsFromState(['flipH'], null)).toEqual(['h!'])
    expect(hsModWordsFromState(['flipV'], null)).toEqual(['v!'])
    expect(hsModWordsFromState(['rotateL'], null)).toEqual(['l!'])
    expect(hsModWordsFromState(['cursed'], null)).toEqual(['c!'])
    expect(hsModWordsFromState(['rainbow'], null)).toEqual(['ffzRainbow'])
  })
  test('hue → c!#hex', () => {
    const words = hsModWordsFromState([], 0)
    expect(words.length).toBe(1)
    expect(words[0]).toMatch(/^c!#[0-9a-f]{6}$/)
  })
  test('wide + hue → [w!, c!#hex]', () => {
    const words = hsModWordsFromState(['wide'], 120)
    expect(words[0]).toBe('w!')
    expect(words[1]).toMatch(/^c!#/)
  })
  test('unknown mod → ?prefixed', () => {
    expect(hsModWordsFromState(['unknownMod'], null)[0]).toBe('?unknownMod')
  })
  test('hue round-trips within ±1°', () => {
    const words = hsModWordsFromState([], 120)
    const hex = words[0].slice(2).replace('#', '')
    expect(Math.abs(hsModHexToHue(hex) - 120)).toBeLessThanOrEqual(1)
  })
})

// ── end-to-end pipeline ───────────────────────────────────────────────────────

describe('end-to-end modifier pipeline', () => {
  test('w! classify → transform → style', () => {
    const c = hsModClassify('w!')
    const { sx, sy } = hsModComposeTransform(c.mods)
    expect(sx).toBe(2)
    expect(sy).toBe(1)
    expect(hsModBuildStyleAttr(c.mods, c.hue)).toContain('scale(2, 1)')
  })
  test('w!h!ffzX: wide × flipH × flipH → two flips cancel', () => {
    // h!=flipH (-1), ffzX=flipH (-1), wide (2) → 2 × -1 × -1 = 2
    const r = hsModClassify('w!h!ffzX')
    const { sx, sy } = hsModComposeTransform(r.mods)
    expect(sx).toBe(2)
    expect(sy).toBe(1)
  })
  test('w! w! multiset → 4x', () => {
    const combined = [...hsModClassify('w!').mods, ...hsModClassify('w!').mods]
    expect(hsModComposeTransform(combined).sx).toBe(4)
  })
  test('ffzSpin classifies + composes to spin anim', () => {
    const r = hsModClassify('ffzSpin')
    expect(hsModComposeAnimClasses(r.mods)).toEqual(['hs-fx-spin'])
  })
})

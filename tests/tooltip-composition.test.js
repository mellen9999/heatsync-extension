// Hovering a stacked/modified emote used to show a flat, uncoloured
// "A + B + C" of names — no indication of WHICH modifiers were applied, in what
// ORDER, or which provider each piece came from. The tooltip now renders the
// whole recipe. Two things have to hold for that to be truthful:
//   1. modifier ORDER survives into the DOM (only the composed transform/filter
//      did before, and "wide then cursed" can't be read back out of a matrix)
//   2. provider is inferable from the token so the colours mean something
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const MODS = readFileSync(join(ROOT, 'src', 'lib', 'modifiers.js'), 'utf8')
const EMOTES = readFileSync(join(ROOT, 'src', 'multichat', 'emotes.js'), 'utf8')
const TIPS = readFileSync(join(ROOT, 'src', 'multichat', 'tooltips.js'), 'utf8')

const modsApi = new Function(
  `${MODS.slice(0, MODS.indexOf('export {') === -1 ? undefined : MODS.indexOf('export {'))}
   return { hsModWordsFromState }`,
)()

describe('modifier order survives as tokens', () => {
  test('order is preserved, not normalised or sorted', () => {
    expect(modsApi.hsModWordsFromState(['cursed', 'wide'], null)).toEqual(['c!', 'w!'])
    expect(modsApi.hsModWordsFromState(['wide', 'cursed'], null)).toEqual(['w!', 'c!'])
  })
  test('ffz-only effects keep their ffz spelling', () => {
    expect(modsApi.hsModWordsFromState(['flipH', 'flipV', 'spin'], null)).toEqual(['h!', 'v!', 'ffzSpin'])
  })
  test('a hue becomes a c!#hex token so the chip can tint itself', () => {
    expect(modsApi.hsModWordsFromState([], 200)).toEqual(['c!#00aaff'])
  })
  test('hue rides after the effects it was typed with', () => {
    expect(modsApi.hsModWordsFromState(['wide'], 200)).toEqual(['w!', 'c!#00aaff'])
  })
})

describe('the wrapper carries the recipe', () => {
  test('_hsMcApplyMods stamps data-hs-mods', () => {
    const fn = EMOTES.slice(
      EMOTES.indexOf('function _hsMcApplyMods'),
      EMOTES.indexOf('\n}', EMOTES.indexOf('function _hsMcApplyMods')),
    )
    expect(fn).toContain('data-hs-mods')
    expect(fn).toContain('hsModWordsFromState')
    expect(fn).toContain('escapeHtml') // attribute value is user-derived
  })
  test('the attribute is injected on the wrapper span, not the img', () => {
    expect(EMOTES).toContain('out.replace(/^(<span\\b)/')
  })
})

describe('provider colouring', () => {
  const api = new Function(
    `${TIPS.slice(TIPS.indexOf('const HS_TT_PROVIDER_COLOR'), TIPS.indexOf('/** One coloured chip'))}
     return { HS_TT_PROVIDER_COLOR, hsTtModProvider }`,
  )()

  test('every real BTTV token colours as bttv', () => {
    for (const t of ['c!', 'h!', 'l!', 'p!', 'r!', 's!', 'v!', 'w!', 'z!']) {
      expect(api.hsTtModProvider(t), t).toBe('bttv')
    }
  })
  test('ffz effects colour as ffz', () => {
    for (const t of ['ffzX', 'ffzW', 'ffzCursed', 'ffzSpin']) {
      expect(api.hsTtModProvider(t), t).toBe('ffz')
    }
  })
  test('the c!#hex tint token is still bttv-shaped', () => {
    expect(api.hsTtModProvider('c!#00aaff')).toBe('bttv')
  })
  test('brand colours match the source chips used elsewhere', () => {
    expect(api.HS_TT_PROVIDER_COLOR['7tv']).toBe('#00ffff')
    expect(api.HS_TT_PROVIDER_COLOR.bttv).toBe('#ff0000')
    expect(api.HS_TT_PROVIDER_COLOR.ffz).toBe('#ffffff')
  })
})

describe('both hover paths render the composition', () => {
  test('the stack path gathers mods from every piece', () => {
    expect(TIPS).toContain('for (const w of stackEmotes.children) for (const m of hsTtModsOf(w)) stackMods.push(m)')
  })
  test('a lone modified emote shows its effects too', () => {
    expect(TIPS).toContain('const soloMods = hsTtModsOf(hoveredImg)')
  })
  test('an unmodified emote keeps the plain name (no empty separator)', () => {
    expect(TIPS).toContain('else nameEl.textContent = emoteName')
  })
})

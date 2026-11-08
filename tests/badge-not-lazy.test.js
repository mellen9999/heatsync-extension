/**
 * Badge <img>s must NOT be loading="lazy". They're 18px and always at the row
 * start next to visible text; when the async channel-badge fetch lands and the
 * retro-paint swaps the green text fallback for an img, a lazy img won't paint
 * until the next reflow — the mod/vip/sub badge then vanishes until a new
 * message or channel switch (the reported bug). Emotes/stickers/avatars keep
 * lazy (numerous / can be off-screen). Source-level guard: these render paths
 * are in the non-module content bundle, not independently importable.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainSource } from './main-src.js'

const API = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'twitch-api.js'), 'utf8')
const MAIN = mainSource()
// _patchBadgesInRoot / updateThirdPartyBadgesInPlace live in cosmetics.js (split out of main.js)
const COSMETICS = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'cosmetics.js'), 'utf8')

// every line that builds a badge img (class hs-mc-badge-img) must not carry lazy
function badgeImgLines(src) {
  return src
    .split('\n')
    .filter((l) => l.includes('hs-mc-badge-img') && (l.includes('<img') || l.includes('createElement')))
}

describe('badge imgs are never lazy', () => {
  test('twitch-api.js badge img strings drop loading="lazy"', () => {
    const lines = badgeImgLines(API).filter((l) => l.includes('<img'))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l).not.toContain('loading="lazy"')
  })

  test('main.js badge img string drops loading="lazy"', () => {
    const lines = badgeImgLines(MAIN).filter((l) => l.includes('<img'))
    for (const l of lines) expect(l).not.toContain('loading="lazy"')
  })

  test('the retro-paint createElement badge imgs are not set lazy', () => {
    // _patchBadgesInRoot + updateThirdPartyBadgesInPlace build hs-mc-badge-img
    // via createElement — ensure neither block sets img.loading = 'lazy'
    for (const marker of ['function _patchBadgesInRoot', 'function updateThirdPartyBadgesInPlace']) {
      const start = COSMETICS.indexOf(marker)
      expect(start).toBeGreaterThan(-1)
      const block = COSMETICS.slice(start, start + 2600)
      // if it builds a badge img here, it must not mark it lazy
      if (block.includes("className = 'hs-mc-badge-img") || block.includes("'hs-mc-badge-img '")) {
        expect(block).not.toContain("img.loading = 'lazy'")
      }
    }
  })

  test('emotes still keep lazy (untouched)', () => {
    expect(MAIN).toContain('class="hs-mc-emote" loading="lazy"')
  })
})

// badgeBgStyle: native (non-FFZ) known badges must get a semantic background so
// the 18px slot shows the badge color even before/without the image (the
// "history mod badge has no green bg" fix). FFZ stays a padded chip.
const badgeBgStyle = (() => {
  const s = API.indexOf('function badgeBgStyle(')
  const e = API.indexOf('\n}', s) + 2
  const BADGE_STYLES = { moderator: { bg: '#00ad03' }, vip: { bg: '#e005b9' }, subscriber: { bg: '#8205b4' } }
  return new Function('BADGE_STYLES', `${API.slice(s, e)}; return badgeBgStyle`)(BADGE_STYLES)
})()

describe('badgeBgStyle — semantic bg fallback', () => {
  test('native mod badge gets green bg (no padding), so history is never blank', () => {
    const css = badgeBgStyle('moderator', false)
    expect(css).toContain('background:#00ad03')
    expect(css).not.toContain('padding')
  })
  test('FFZ mod badge keeps the padded chip (square — no border-radius)', () => {
    expect(badgeBgStyle('moderator', true)).toBe('background:#00ad03;padding:1px;')
  })
  test('unknown/third-party badge type gets no bg', () => {
    expect(badgeBgStyle('bttv-custom', false)).toBe('')
  })
  test('both render paths route through badgeBgStyle', () => {
    expect(API).toContain('badgeBgStyle(name, isFFZ)')
    expect(COSMETICS).toContain('badgeBgStyle(name, isFFZ)')
  })
})

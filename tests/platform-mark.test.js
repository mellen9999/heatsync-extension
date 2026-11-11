/**
 * One platform → mark function (platformMark in lib/palette.js); every surface
 * that shows [T]/[K]/[Y]/[H] goes through it. No hand-rolled letter or colour
 * ternaries at call sites, and an unknown platform is [?], never a silent [T].
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HS_PLAT_COLORS, platformMark, platformMarkHtml } from '../src/lib/palette.js'

const MC = join(import.meta.dir, '..', 'src', 'multichat')
const src = (f) => readFileSync(join(MC, f), 'utf8')

describe('platformMark', () => {
  test.each([
    ['twitch', '[T]', 'twitch'],
    ['kick', '[K]', 'kick'],
    ['youtube', '[Y]', 'yt'],
    ['heatsync', '[H]', 'heatsync'],
  ])('%s', (p, label, cls) => {
    const m = platformMark(p)
    expect(m.label).toBe(label)
    expect(m.cls).toBe(cls)
    expect(m.color).toBe(HS_PLAT_COLORS[p])
  })

  test('aliases fold at the helper, not at call sites', () => {
    expect(platformMark('yt').label).toBe('[Y]')
    expect(platformMark('YouTube').label).toBe('[Y]')
    expect(platformMark('Twitch').label).toBe('[T]')
    expect(platformMark('k').label).toBe('[K]')
  })

  test('missing or unknown is [?], never [T]', () => {
    for (const p of [undefined, null, '', 'mixer', 'x']) expect(platformMark(p).label).toBe('[?]')
  })
})

describe('platformMarkHtml', () => {
  test('setting off hides only the page own platform, for every platform alike', () => {
    for (const [host, plat] of [
      ['twitch', 'twitch'],
      ['kick', 'kick'],
      ['yt', 'youtube'],
      ['yt', 'yt'],
    ])
      expect(platformMarkHtml(plat, { enabled: false, host })).toBe('')
    expect(platformMarkHtml('youtube', { enabled: false, host: 'kick' })).toContain('[Y]')
    expect(platformMarkHtml('heatsync', { enabled: false, host: 'twitch' })).toContain('[H]')
    expect(platformMarkHtml('kick', { enabled: true, host: 'kick' })).toContain('[K]')
  })
})

describe('no call site hand-rolls a mark', () => {
  const body = (f) => src(f).replace(/\/\/.*$/gm, '')
  test('chat + event rows', () => {
    const s = body('main-messages.js')
    expect(/\[T\]|\[K\]|\[Y\]|\[HS\]|\[H\]/.test(s)).toBe(false)
    expect(s.includes('PLAT_COLORS[')).toBe(false)
    expect(/\bevtBadge\b/.test(s)).toBe(false)
  })
  test('whispers', () => {
    const s = body('whispers.js')
    expect(/platColor|platTag|\[HS\]/.test(s)).toBe(false)
  })
  test('feed posts', () => {
    expect(/'\[[KYT]\]'/.test(body('social.js'))).toBe(false)
  })
  test('discover post chips', () => {
    expect(/: 'h'/.test(body('social.js'))).toBe(false)
  })
  test('the simulcast fold re-marks through the helper', () => {
    expect(body('input.js').includes("textContent = '[H]'")).toBe(false)
  })
})

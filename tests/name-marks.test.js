import { describe, expect, test } from 'bun:test'
import {
  hsMarksBar,
  hsMarksFlair,
  hsMarksHtml,
  hsMarksImageOk,
  hsMarksScore,
  hsMarksValidLogin,
  hsMarksWear,
} from '../src/multichat/name-marks.js'
import { bgSource } from './bg-src.js'
import { mainSource } from './main-src.js'

describe('heat bar tiers (heatsync-chat contract)', () => {
  const ladder = [
    [0, null],
    [4, null],
    [5, ['▎', 'w']],
    [19, ['▎', 'w']],
    [20, ['▍', 'w']],
    [49, ['▍', 'w']],
    [50, ['▍', 'y']],
    [99, ['▍', 'y']],
    [100, ['▌', 'y']],
    [200, ['▌', 'y']],
    [500, ['▌', 'y']],
    [999, ['▌', 'y']],
    [1000, ['▊', 'r']],
    [5000, ['▊', 'r']],
    [1e12, ['▊', 'r']],
  ]
  for (const [heat, want] of ladder) {
    test(`heat ${heat}`, () => {
      const b = hsMarksBar(heat)
      expect(b ? [b.glyph, b.ink] : null).toEqual(want)
    })
  }
  test('scores off the wire are bounded', () => {
    for (const bad of [-1, Number.NaN, Infinity, '9', null, undefined, {}]) expect(hsMarksScore(bad)).toBe(0)
    expect(hsMarksScore(7.9)).toBe(7)
    expect(hsMarksScore(1e12)).toBe(1e9)
  })
})

describe('who wears what', () => {
  test('the flame never sits with a bar', () => {
    for (const f of [false, true])
      for (const b of [false, true])
        for (const k of [false, true])
          for (const mine of [false, true])
            for (const h of [0, 4, 5, 49, 50, 999, 1000, 5000]) {
              const w = hsMarksWear(f, b, k, mine, h)
              expect(w.flame && w.bar).toBeFalsy()
            }
  })
  test('cases', () => {
    expect(hsMarksWear(true, true, true, false, 3)).toEqual({ flame: true, bar: null })
    expect(hsMarksWear(true, true, true, false, 7).flame).toBe(false)
    expect(hsMarksWear(true, true, true, false, 7).bar).not.toBeNull()
    expect(hsMarksWear(true, true, false, false, 0)).toEqual({ flame: false, bar: null })
    // your own line wears it too, even before your emote set is known (2026-11-05)
    expect(hsMarksWear(true, true, true, true, 3).flame).toBe(true)
    expect(hsMarksWear(true, true, false, true, 0).flame).toBe(true)
    expect(hsMarksWear(false, true, false, true, 0).flame).toBe(false)
    expect(hsMarksWear(true, true, true, true, 300).bar).not.toBeNull()
    expect(hsMarksWear(true, false, true, false, 300).flame).toBe(true)
    expect(hsMarksWear(false, false, true, false, 300)).toEqual({ flame: false, bar: null })
  })
})

describe('logins and flair rows are validated', () => {
  test('logins', () => {
    for (const ok of ['a', 'ennortix', 'user_01', 'x'.repeat(25)]) expect(hsMarksValidLogin(ok)).toBe(true)
    for (const bad of ['', 'Ennortix', 'a b', 'a-b', 'é', 'x'.repeat(26), 'a\n', 5, null])
      expect(hsMarksValidLogin(bad)).toBe(false)
  })
  test('image allowlist', () => {
    expect(hsMarksImageOk('https://static-cdn.jtvnw.net/badges/v1/a/1')).toBe(true)
    expect(hsMarksImageOk('https://cdn.7tv.app/x')).toBe(true)
    for (const bad of [
      'http://static-cdn.jtvnw.net/a',
      'https://evil.example/a',
      'https://user@cdn.7tv.app/x',
      'https://kick.com:@evil.com/x',
      'https://evil7tv.app/x',
      'https://7tv.app.evil.com/x',
      'https://cdn.7tv.app:8443/x',
      'https://cdn.7tv.app/x\n',
      `https://static-cdn.jtvnw.net/${'a'.repeat(512)}`,
      '',
      5,
    ])
      expect(hsMarksImageOk(bad)).toBe(false)
  })
  test('flair rows', () => {
    const sub = (badge_url, who) => ({ flair_type: 'twitch_sub', broadcaster_login: who, badge_url })
    expect(hsMarksFlair(sub('https://static-cdn.jtvnw.net/b/1', 'streamer'))).toEqual({
      url: 'https://static-cdn.jtvnw.net/b/1',
      title: 'streamer sub',
    })
    expect(hsMarksFlair(sub('https://static-cdn.jtvnw.net/b/1', 'we ird\n<b>')).title).toBe('weirdb sub')
    expect(hsMarksFlair(sub('https://static-cdn.jtvnw.net/b/1', '')).title).toBe('sub')
    expect(hsMarksFlair(sub('https://evil.example/a', 'x'))).toBeNull()
    expect(hsMarksFlair({ flair_type: 'other', badge_url: 'https://static-cdn.jtvnw.net/a' })).toBeNull()
    for (const bad of [null, 5, 'x', []]) expect(hsMarksFlair(bad)).toBeNull()
  })
})

describe('markup', () => {
  test('order: flair, flame, bar; escaped; no flame beside a bar', () => {
    const flair = { url: 'https://static-cdn.jtvnw.net/a"b', title: 'x" onerror="y sub' }
    const html = hsMarksHtml(flair, hsMarksWear(true, true, true, false, 120))
    expect(html.indexOf('hs-mark-flair')).toBeLessThan(html.indexOf('hs-mark-heat'))
    expect(html).not.toContain('"b')
    expect(html).not.toContain('onerror="y')
    expect(html).not.toContain('\u{1F525}')
    expect(hsMarksHtml(null, hsMarksWear(true, true, true, false, 2))).toContain('\u{1F525}')
    expect(hsMarksHtml(null, hsMarksWear(true, true, false, false, 2))).toBe('')
  })
})

describe('wiring', () => {
  const read = (p) => require('node:fs').readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
  test('the pure module is import-free (the site vendors it byte for byte)', () => {
    expect(read('src/multichat/name-marks.js')).not.toMatch(/^\s*import\s/m)
  })
  test('bundled before main.js, after name-style', () => {
    const b = read('build.js')
    const at = (f) => b.indexOf(`'${f}'`)
    expect(at('name-style.js')).toBeLessThan(at('name-marks.js'))
    expect(at('name-marks.js')).toBeLessThan(at('name-marks-data.js'))
    expect(at('name-marks-data.js')).toBeLessThan(at('mod-toolbar.js'))
  })
  test('twitch rows carry the marks span after the badges, before the avatar', () => {
    const m = mainSource()
    expect(m).toContain("plat === 'twitch' ? hsMarksRowHtml(")
    expect(m).toContain('${badges}${marksHtml}${avatarHtml}')
  })
  test('three switches, on by default', () => {
    const s = read('src/lib/settings-schema.js')
    for (const k of ['subFlair', 'flame', 'heatBars']) expect(s).toContain(`'${k}'`)
  })
  test('the background relay validates what it forwards', () => {
    const bg = bgSource()
    expect(bg).toContain("message.type === 'fetch_name_marks'")
    expect(bg).toContain('/api/users/flair?ids=')
  })
})

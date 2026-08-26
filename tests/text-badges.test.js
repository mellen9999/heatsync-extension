/**
 * `textBadges` — mod/vip/sub badges as terse text chips instead of images.
 *
 * These render paths live in the non-module content bundle (one concatenated
 * IIFE), so they aren't independently importable — source-level guards, same
 * shape as badge-not-lazy.test.js and badge-refresh-race.test.js.
 *
 * The invariant that actually matters: the setting has to hold on BOTH paths.
 * renderBadges draws the chip, and cosmetics.js's _patchBadgesInRoot exists
 * purely to replace a chip with an image once the badge fetch lands — so if
 * only the first were gated, the chips would silently revert to images a second
 * after every render.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = (...p) => join(import.meta.dir, '..', ...p)
const API = readFileSync(dir('src', 'multichat', 'twitch-api.js'), 'utf8')
const COSMETICS = readFileSync(dir('src', 'multichat', 'cosmetics.js'), 'utf8')
const MAIN = readFileSync(dir('src', 'multichat', 'main.js'), 'utf8')
const SCHEMA = readFileSync(dir('src', 'lib', 'settings-schema.js'), 'utf8')
const EN = JSON.parse(readFileSync(dir('src', '_locales', 'en', 'messages.json'), 'utf8'))

/** Parse a `const NAME = { ... }` object literal's keys out of source. */
function literalKeys(src, name) {
  const start = src.indexOf(`const ${name} = {`)
  if (start < 0) return []
  const end = src.indexOf('\n}', start)
  const body = src.slice(start, end)
  return [...body.matchAll(/^\s{2}'?([A-Za-z0-9_-]+)'?:/gm)].map((m) => m[1])
}

function literalPairs(src, name) {
  const start = src.indexOf(`const ${name} = {`)
  const end = src.indexOf('\n}', start)
  const body = src.slice(start, end)
  return [...body.matchAll(/^\s{2}'?([A-Za-z0-9_-]+)'?:\s*'([^']*)',/gm)].map((m) => [m[1], m[2]])
}

describe('the setting is declared and reachable', () => {
  test('settings-schema carries textBadges with a runtimeVar main.js bridges', () => {
    expect(SCHEMA).toContain("key: 'textBadges'")
    expect(SCHEMA).toContain("runtimeVar: 'textBadgesEnabled'")
    expect(MAIN).toContain('let textBadgesEnabled = false')
    expect(MAIN).toContain('textBadgesEnabled: {')
  })

  test('rerender is set, so flipping it repaints the rows already on screen', () => {
    const i = SCHEMA.indexOf("key: 'textBadges'")
    const entry = SCHEMA.slice(i, SCHEMA.indexOf('\n  },', i))
    expect(entry).toContain('rerender: true')
  })

  test('its label and tip resolve to real en strings', () => {
    expect(EN.mc_settings_text_badges?.message).toBeTruthy()
    expect(EN.mc_settings_text_badges_desc?.message).toBeTruthy()
  })
})

describe('both badge paths honour it', () => {
  test('renderBadges skips the image lookup entirely in text mode', () => {
    const start = API.indexOf('function renderBadges(')
    const body = API.slice(start, API.indexOf('\nfunction renderThirdPartyBadges', start))
    expect(body).toContain('textBadgesEnabled ? null : resolveBadgeImageUrl(')
  })

  test('_patchBadgesInRoot returns before touching the DOM in text mode', () => {
    const start = COSMETICS.indexOf('function _patchBadgesInRoot(')
    expect(start).toBeGreaterThan(-1)
    const head = COSMETICS.slice(start, start + 400)
    expect(head).toContain('if (textBadgesEnabled) return')
    // ...and the guard has to precede the loop it is guarding.
    expect(head.indexOf('if (textBadgesEnabled) return')).toBeLessThan(head.indexOf('querySelectorAll'))
  })
})

describe('the short-label table', () => {
  const short = literalPairs(API, 'BADGE_SHORT')
  const styleKeys = literalKeys(API, 'BADGE_STYLES')

  test('parses, and covers the twitch/kick/youtube globals', () => {
    const map = Object.fromEntries(short)
    expect(short.length).toBeGreaterThan(20)
    for (const n of [
      'broadcaster',
      'moderator',
      'vip',
      'subscriber',
      'founder',
      'staff',
      'admin',
      'partner',
      'verified',
      'member',
      'turbo',
      'og',
      'premium',
      'bits',
      'sub-gifter',
      'sub_gifter',
      'predictions',
      'hype-train',
      'no_audio',
      'no_video',
      'first-msg',
    ]) {
      expect(map[n], n).toBeTruthy()
    }
  })

  test('every label is lowercase and short enough for a chat row', () => {
    for (const [name, text] of short) {
      expect(text, name).toBe(text.toLowerCase())
      expect(text.length, name).toBeLessThanOrEqual(5)
      expect(text.length, name).toBeGreaterThan(0)
    }
  })

  test('every styled badge has a short label, so none falls back to SHOUTING', () => {
    // badgeChipText lowercases the style label as a fallback, which is fine for
    // most names but wrong for broadcaster (label 'LIVE' — that reads as "the
    // stream is live", not "this is the broadcaster"). Forcing a decision here
    // means a badge added to BADGE_STYLES later can't quietly pick up a bad one.
    const map = Object.fromEntries(short)
    expect(styleKeys.length).toBeGreaterThan(10)
    for (const k of styleKeys) expect(map[k], k).toBeTruthy()
  })

  test('the chip text is escaped on the way into the DOM', () => {
    const start = API.indexOf('function renderBadges(')
    const body = API.slice(start, API.indexOf('\nfunction renderThirdPartyBadges', start))
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this IS the literal
    // source substring being asserted — renderBadges builds its HTML with a
    // template literal, and the point of the test is that `text` goes through
    // escapeHtml on the way in.
    expect(body).toContain('${escapeHtml(text)}</span>')
  })
})

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { SETTINGS } from '../src/lib/settings-schema.js'
import { RETIRED_UI_KEYS } from '../src/lib/utils.js'

// bttv, ffz and chatterino badges were three switches for one question: show
// other tools' badges on chatters? One switch now; a viewer who turned any of
// the three off wanted fewer badges, so that carries over as off.
const def = SETTINGS.find((d) => d.key === 'thirdPartyBadges')
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('one switch, the three retired', () => {
  expect(def.type).toBe('bool')
  expect(def.default).toBe(true)
  for (const k of ['bttvBadges', 'ffzBadges', 'chatterinoBadges']) {
    expect(SETTINGS.some((d) => d.key === k)).toBe(false)
    expect(RETIRED_UI_KEYS.has(k)).toBe(true)
  }
})

test('any old switch turned off carries over as off', () => {
  expect(def.legacy({ ffzBadges: false }, {})).toBe(false)
  expect(def.legacy({ bttvBadges: true, ffzBadges: true, chatterinoBadges: true }, {})).toBe(true)
  expect(def.legacy({}, {})).toBeUndefined()
})

test('both badge renderers read the one switch', () => {
  for (const p of ['src/multichat/cosmetics.js', 'src/multichat/twitch-api.js']) {
    const src = read(p)
    expect(src).toContain("getSetting('thirdPartyBadges')")
    expect(src).not.toMatch(/getSetting\('(bttv|ffz|chatterino)Badges'\)/)
  }
})

/**
 * Keys the code asks for must exist in every locale (a missing key silently
 * falls back to english): the off-twitch mod relay errors, /announce on a
 * non-twitch tab, and the prediction view's close button.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'

const DIR = new URL('../src/_locales/', import.meta.url).pathname
const KEYS = ['mc_mod_no_twitch_tab', 'mc_mod_stale_twitch_tab', 'mc_input_announce_twitch_only', 'common_close']
const API = readFileSync(new URL('../src/multichat/twitch-api.js', import.meta.url), 'utf8')

describe('locale gap keys', () => {
  const locs = readdirSync(DIR)
  test('34 locales', () => expect(locs.length).toBe(34))
  for (const loc of locs) {
    test(`${loc} has them`, () => {
      const d = JSON.parse(readFileSync(`${DIR}${loc}/messages.json`, 'utf8'))
      for (const k of KEYS) expect(d[k]?.message?.length).toBeGreaterThan(0)
    })
  }
  test('the mod relay errors are looked up, not hardcoded english', () => {
    expect(API).toContain("t('mc_mod_no_twitch_tab')")
    expect(API).toContain("t('mc_mod_stale_twitch_tab')")
    expect(API).not.toContain("'open a twitch.tv tab to use mod actions'")
  })
})

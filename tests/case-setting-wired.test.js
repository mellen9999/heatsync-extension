/**
 * The user's caseInsensitiveEmotes setting reaches the emote-refs probe, live.
 * (src/multichat/main-settings.js wires it; src/lib/emote-refs.js stays a byte copy)
 */
import { afterEach, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildEmoteRefs, setCaseInsensitiveProbe } from '../src/lib/emote-refs.js'
import { SETTINGS } from '../src/lib/settings-schema.js'

const ROOT = join(import.meta.dir, '..')
const SRC = readFileSync(join(ROOT, 'src', 'multichat', 'main-settings.js'), 'utf8')
afterEach(() => setCaseInsensitiveProbe(null))

test('the setting exists, off by default, with its words in every locale', () => {
  const def = SETTINGS.find((d) => d.key === 'caseInsensitiveEmotes')
  expect(def?.default).toBe(false)
  for (const code of readdirSync(join(ROOT, 'src', '_locales'))) {
    const loc = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', code, 'messages.json'), 'utf8'))
    expect(loc[def.labelKey]?.message, `${code} label`).toBeTruthy()
    expect(loc[def.tipKey]?.message, `${code} tip`).toBeTruthy()
  }
})

test('main-settings hands the probe the live setting, not a snapshot', () => {
  const m = /setCaseInsensitiveProbe\(\(\) => getSetting\('caseInsensitiveEmotes'\) === true\)/.exec(SRC)
  expect(m).not.toBeNull()
  // run the exact line against a mutable store: flipping the value flips the builder's answer
  let on = false
  setCaseInsensitiveProbe(
    new Function('getSetting', `return () => getSetting('caseInsensitiveEmotes') === true`)(() => on),
  )
  const map = new Map([
    ['kekw', { hash: 'h', url: 'https://cdn.heatsync.org/e/1.webp', provider: 'inventory', name: 'kekw' }],
  ])
  const keys = () => Object.keys(buildEmoteRefs('KEKW', map, new Map()) || {})
  expect(keys()).toEqual([])
  on = true
  expect(keys()).toEqual(['KEKW'])
})

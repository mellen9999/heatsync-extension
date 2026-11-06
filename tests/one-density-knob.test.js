import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { SETTINGS } from '../src/lib/settings-schema.js'
import { RETIRED_UI_KEYS } from '../src/lib/utils.js'

// messageDensity and lineHeight both set how tight a chat row sits. One knob
// stays — messageDensity, the one heatsync.org shares — and a stored
// lineHeight maps onto it when density was never set.
const density = SETTINGS.find((d) => d.key === 'messageDensity')

test('lineHeight is gone and retired', () => {
  expect(SETTINGS.some((d) => d.key === 'lineHeight')).toBe(false)
  expect(RETIRED_UI_KEYS.has('lineHeight')).toBe(true)
})

test('a taller line height maps to cozy, the default to nothing', () => {
  expect(density.legacy({ lineHeight: '26' }, {})).toBe('cozy')
  expect(density.legacy({ lineHeight: '22' }, {})).toBe('cozy')
  expect(density.legacy({ lineHeight: '20' }, {})).toBeUndefined()
  expect(density.legacy({}, {})).toBeUndefined()
})

test('the density applier no longer reads a line height setting', () => {
  const main = readFileSync(new URL('../src/multichat/main.js', import.meta.url), 'utf8')
  expect(main).not.toContain("getSetting('lineHeight')")
})

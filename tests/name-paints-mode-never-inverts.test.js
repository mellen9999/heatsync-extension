import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { coerceSettingValue, SETTINGS } from '../src/lib/settings-schema.js'
import { namePaintsOn } from '../src/lib/utils.js'

// heatsync.org stores showNamePaints as a mode (full/static/off); the
// extension stores a bool. A site value reaching the extension raw used to
// coerce with !!v, so 'off' turned paints ON. Only false and 'off' are off.
const def = SETTINGS.find((d) => d.key === 'showNamePaints')

test('the site modes coerce without inverting', () => {
  expect(coerceSettingValue(def, 'off')).toBe(false)
  expect(coerceSettingValue(def, 'static')).toBe(true)
  expect(coerceSettingValue(def, 'full')).toBe(true)
  expect(coerceSettingValue(def, false)).toBe(false)
  expect(coerceSettingValue(def, true)).toBe(true)
})

test('namePaintsOn reads both shapes', () => {
  expect(namePaintsOn('off')).toBe(false)
  expect(namePaintsOn(false)).toBe(false)
  expect(namePaintsOn('static')).toBe(true)
  expect(namePaintsOn(undefined)).toBe(true)
})

test('content.js reads the raw ui_settings value through namePaintsOn', () => {
  const src = readFileSync(new URL('../chrome/content.js', import.meta.url), 'utf8')
  expect(src).toContain('hsPaintsEnabled = namePaintsOn(settings.showNamePaints)')
  expect(src).not.toContain('settings.showNamePaints !== false')
})

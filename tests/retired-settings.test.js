import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { SETTINGS } from '../src/lib/settings-schema.js'
import { RETIRED_UI_KEYS } from '../src/lib/utils.js'

// Keys the settings pass removed keep arriving for months — from old builds,
// from the server's ui_state, from chrome.storage.sync blobs written before
// the update. They are never adopted from the server, and once this device
// has migrated their values the stored blob drops them (8 KB sync quota).
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const BG = read('chrome/background.js')
const MAIN = read('src/multichat/main.js')

function extractFn(name) {
  const start = BG.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`${name} not found in background.js`)
  return BG.slice(start, BG.indexOf('\n}', start) + 2)
}
const between = BG.slice(BG.indexOf('const UI_SYNC_BLOCKLIST ='), BG.indexOf('function splitIncomingUiState('))
const { splitIncomingUiState } = new Function(
  `${between}\n${extractFn('splitIncomingUiState')}\nreturn { splitIncomingUiState }`,
)()

test('a retired key is no longer a setting', () => {
  const keys = new Set(SETTINGS.map((d) => d.key))
  for (const k of RETIRED_UI_KEYS) expect(keys.has(k)).toBe(false)
})

test('the presets store is retired', () => {
  expect(RETIRED_UI_KEYS.has('customPresets')).toBe(true)
})

test('server state never brings a retired key back', () => {
  const state = { zebra: true }
  for (const k of RETIRED_UI_KEYS) state[k] = 'x'
  expect(splitIncomingUiState(state).sync).toEqual({ zebra: true })
})

test('the boot seed skips retired keys too', () => {
  const seed = MAIN.slice(MAIN.indexOf("apiFetch('/api/user/ui-state')"))
  expect(seed.slice(0, 2500)).toContain('RETIRED_UI_KEYS.has(k)')
})

test('the stored blob drops them after the server has spoken, through the service worker', () => {
  const seed = MAIN.slice(MAIN.indexOf("apiFetch('/api/user/ui-state')"))
  expect(seed.slice(0, 3500)).toMatch(/finally \{\s*retireSettings\(\)/)
  const fn = MAIN.slice(MAIN.indexOf('async function retireSettings('))
  expect(fn.slice(0, 2500)).toContain('dropRetired: true')
  const at = BG.indexOf("message.type === 'ui_settings_rmw'")
  expect(BG.slice(at, at + 1500)).toContain('if (message.dropRetired === true) for (const k of RETIRED_UI_KEYS) delete next[k]')
})

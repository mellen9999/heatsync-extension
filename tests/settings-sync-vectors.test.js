/**
 * shared/settings-sync.vectors.json is the registry's account-synced settings as data, the file the
 * desktop app (and the site's guards) check themselves against. It is built from src/lib/settings-schema.js
 * and utils.js, never edited by hand: when the registry changes this goes red until the file is rewritten
 *   bun scripts/dump-settings-sync-vectors.js shared/settings-sync.vectors.json
 * and carried to the site (shared/, with a line in its .history ledger) and to the desktop app.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { catalogText, syncCatalog } from '../scripts/lib/settings-sync-catalog.js'
import { lintSettings, SETTINGS, validateSettingValue } from '../src/lib/settings-schema.js'
import { UI_SYNC_BLOCKLIST } from '../src/lib/utils.js'

const PATH = resolve(import.meta.dir, '..', 'shared', 'settings-sync.vectors.json')
const text = readFileSync(PATH, 'utf8')
const file = JSON.parse(text)

describe('settings-sync vectors', () => {
  test('the file is the registry as it is now, byte for byte', () => {
    expect(
      text === catalogText(),
      'run: bun scripts/dump-settings-sync-vectors.js shared/settings-sync.vectors.json',
    ).toBe(true)
  })
  test('the file says what it must: the synced keys, and the lists an app must not touch', () => {
    expect(Object.keys(file).sort()).toEqual([
      'about',
      'deviceLocal',
      'largeKeyMax',
      'largeKeys',
      'local',
      'retired',
      'synced',
    ])
    expect(Object.keys(file.synced).length).toBeGreaterThanOrEqual(60)
    expect(file.local).toContain('hs_checkin')
    expect(file.largeKeys).toEqual(['chatFilterRules'])
  })
  test('a key is in exactly one place', () => {
    const lists = [Object.keys(file.synced), file.local, file.retired]
    const all = lists.flat()
    expect(all.length).toBe(new Set(all).size)
    for (const k of file.deviceLocal) expect(UI_SYNC_BLOCKLIST.has(k)).toBe(true)
  })
  test('every synced default is a value the registry accepts', () => {
    for (const d of SETTINGS.filter((d) => d.scope !== 'local')) {
      expect(validateSettingValue(d, file.synced[d.key].default), d.key).toBe(true)
    }
    expect(lintSettings(UI_SYNC_BLOCKLIST)).toEqual([])
    expect(syncCatalog().synced).toEqual(file.synced)
  })
})

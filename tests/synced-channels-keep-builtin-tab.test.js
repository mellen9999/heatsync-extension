import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainSource } from './main-src.js'

/**
 * Saved channels changed in another tab (or on another device) reach every open panel. A reader
 * whose channel tab was removed is moved to the stream's tab. The check for "was it removed" named
 * four built-in tabs by hand, so a reader on settings, the + form, discover, pinned or the mod log
 * was moved too: half a channel name typed into the + form was gone (real twitch, 11-17).
 * tabRemovedBySync runs for real against the real tab list.
 */
const REG = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'tab-registry.js'), 'utf8')
const SRC = mainSource()
const s = SRC.indexOf('function tabRemovedBySync(')
const FN = SRC.slice(s, SRC.indexOf('\n}', s) + 2)
const { removed, MC_TABS } = new Function(`${REG}\n${FN}\nreturn { removed: tabRemovedBySync, MC_TABS }`)()

const saved = new Set(['xqc', 'shroud'])

test('no built-in tab is ever taken for a removed channel', () => {
  const builtins = MC_TABS.filter((t) => !t.util).map((t) => t.id)
  expect(builtins).toEqual(
    expect.arrayContaining(['feed', 'discover', 'whispers', 'mentions', 'pinned', 'modlog', 'live', 'add', 'settings']),
  )
  for (const id of builtins) expect([id, removed(id, saved)]).toEqual([id, false])
})

test('a channel tab that is still saved stays, one that is gone moves', () => {
  expect(removed('xqc', saved)).toBe(false)
  expect(removed('summit1g', saved)).toBe(true)
  expect(removed('xqc', new Set())).toBe(true)
})

test('the storage listener asks it, with no tab list of its own', () => {
  const at = SRC.indexOf('// If current tab was removed, fall back')
  const body = SRC.slice(at, SRC.indexOf('Config synced from another tab/device', at))
  expect(body).toContain('if (tabRemovedBySync(currentTab, newIds)) switchTab(liveTarget())')
  expect(body).not.toMatch(/currentTab !== '/)
})

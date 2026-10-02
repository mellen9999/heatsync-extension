/**
 * MC_TABS is the one list of tabs; the 2nd row and every reserved-id check
 * read it. Evaluated from real source (the bundle shares one scope, so there
 * is nothing to import).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'tab-registry.js'), 'utf8')
const api = new Function(
  `${SRC}\nreturn { MC_TABS, mcReservedTabIds, mcIsReservedTab, mcSubCells, mcResolveSub, mcDefaultHiddenTabs, mcRestorableTabs }`,
)()

describe('tab registry', () => {
  test('ids are unique', () => {
    const ids = api.MC_TABS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('a channel can never take a page-tab id, utility buttons are not pages', () => {
    for (const id of ['live', 'feed', 'mentions', 'whispers', 'discover', 'pinned', 'modlog', 'add', 'settings']) {
      expect(api.mcIsReservedTab(id)).toBe(true)
    }
    expect(api.mcIsReservedTab('xqc')).toBe(false)
    expect(api.mcIsReservedTab('popout')).toBe(false)
  })

  test('fresh installs hide the login-walled tabs, feed stays', () => {
    expect(api.mcDefaultHiddenTabs().sort()).toEqual(['mentions', 'modlog', 'pinned', 'whispers'])
    expect(api.mcRestorableTabs()).not.toContain('discover')
    expect(api.mcRestorableTabs()).not.toContain('settings')
  })
})

describe('mcResolveSub', () => {
  test('a tab with no cells has no 2nd row', () => {
    expect(api.mcSubCells('settings')).toEqual([])
    expect(api.mcResolveSub('settings', 'x', {})).toBeNull()
  })

  test('a channel tab and live share chat · summary · logs · status, chat is home', () => {
    for (const id of ['xqc', 'live']) {
      expect(api.mcSubCells(id).map((c) => c.id)).toEqual(['chat', 'summary', 'logs', 'status'])
    }
  })

  test('asked cell wins, else the last used, else the first', () => {
    expect(api.mcResolveSub('xqc', 'logs', {})).toBe('logs')
    expect(api.mcResolveSub('xqc', undefined, { xqc: 'logs' })).toBe('logs')
    expect(api.mcResolveSub('xqc', undefined, {})).toBe('chat')
  })

  test('an unknown cell never sticks', () => {
    expect(api.mcResolveSub('xqc', 'nope', { xqc: 'gone' })).toBe('chat')
  })
})

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
  `${SRC}\nreturn { MC_TABS, mcReservedTabIds, mcIsReservedTab, mcSubCells, mcResolveSub, mcDefaultHiddenTabs, mcRestorableTabs, mcCanonTab, mcCellAddress, mcRowOwner, mcHasOwnRow }`,
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
    expect(api.mcRestorableTabs()).toContain('discover') // feed's 2nd cell restores on reload
    expect(api.mcRestorableTabs()).not.toContain('settings')
  })
})

describe('feed › discover', () => {
  test('feed has feed · discover, and the two spellings land on one place', () => {
    expect(api.mcSubCells('feed').map((c) => c.id)).toEqual(['feed', 'discover'])
    expect(api.mcSubCells('discover').map((c) => c.id)).toEqual(['feed', 'discover'])
    expect(api.mcCanonTab('feed', 'discover')).toEqual({ id: 'discover', sub: undefined })
    expect(api.mcCanonTab('discover', 'feed')).toEqual({ id: 'feed', sub: undefined })
    expect(api.mcCanonTab('xqc', 'logs')).toEqual({ id: 'xqc', sub: 'logs' })
    expect(api.mcCellAddress('discover')).toEqual({ tab: 'feed', sub: 'discover' })
    expect(api.mcCellAddress('live')).toEqual({ tab: 'live', sub: undefined })
  })

  test('the feed button owns discover, and discover is always on its own cell', () => {
    expect(api.mcRowOwner('discover')).toBe('feed')
    expect(api.mcResolveSub('discover', undefined, {})).toBe('discover')
    expect(api.mcResolveSub('feed', undefined, {})).toBe('feed')
  })
})

describe('settings › help', () => {
  test('settings has one row of its own, and help is its last cell', () => {
    const ids = api.mcSubCells('settings').map((c) => c.id)
    expect(ids[0]).toBe('display')
    expect(ids.at(-1)).toBe('help')
    expect(api.mcHasOwnRow('settings')).toBe(true)
    expect(api.mcHasOwnRow('feed')).toBe(false)
    expect(api.mcResolveSub('settings', 'help', {})).toBe('help')
  })
})

describe('mcResolveSub', () => {
  test('a tab with no cells has no 2nd row', () => {
    expect(api.mcSubCells('pinned')).toEqual([])
    expect(api.mcResolveSub('pinned', 'x', {})).toBeNull()
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

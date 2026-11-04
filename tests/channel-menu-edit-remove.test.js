import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (f) => readFileSync(new URL(`../src/multichat/${f}`, import.meta.url), 'utf8')
const src = read('main.js')
const mgmt = read('channel-mgmt.js')
const menu = src.slice(
  src.indexOf('// Channel tabs get edit/remove context menu'),
  src.indexOf('return container', src.indexOf('// Channel tabs get edit/remove context menu')),
)
const form = mgmt.slice(mgmt.indexOf('function showEditChannelForm('))

describe('channel tab right-click menu: exactly edit + remove', () => {
  test('only two items', () => {
    const items = [...menu.matchAll(/mkItem\(t\('([^']+)'\)/g)].map((m) => m[1])
    expect(items).toEqual(['mc_ctx_edit', 'mc_ctx_remove'])
    expect(menu).toContain("mkItem(t('mc_ctx_remove'), 'var(--hs-danger)'")
  })

  test('the old controls are gone from the menu', () => {
    for (const gone of ['send to', 'platforms', 'copy layout link', 'channelSubLinks', 'togglePlatformFilter'])
      expect(menu).not.toContain(gone)
  })

  test('items are square, white on hover/focus, keyboard reachable', () => {
    expect(menu).toContain('border-radius:0')
    expect(menu).toContain("item.style.background = '#ffffff'")
    expect(menu).toContain('item.tabIndex = 0')
    expect(menu).toContain("ev.key === 'Enter'")
  })
})

describe('edit form: send to', () => {
  test('is in the form, never empties the targets, persists', () => {
    expect(form).toContain('makeSendTargetsRow(ch)')
    expect(mgmt).toContain('if (!next) return')
    expect(mgmt).toContain('ch.sendTargets = next')
    expect(mgmt).toContain('saveConfig()')
  })
})

describe('edit form: show (platform view filter)', () => {
  test('is in the form, toggles the filter, refuses to hide the last platform', () => {
    expect(form).toContain('makePlatformFilterRow(ch)')
    expect(mgmt).toContain('togglePlatformFilter(tabId, key)')
    expect(mgmt).toContain('renderMessages(tabId)')
    expect(mgmt).toContain('if (cur[key] && !stillOn.length) return')
  })

  test('the render path drops rows from a muted platform, twitch rows included', () => {
    expect(src).toContain('if (isPlatformHiddenInTab(m, tabId)) return null')
    expect(src).toContain("m.platform || (m.user && !m.type ? 'twitch' : '')")
  })

  test('the filter is stored device-locally and reloaded at boot', () => {
    expect(src).toContain('loadPlatformFilters(),')
    expect(src).toContain("saveUiSetting('platformFilters', platformFilters)")
    expect(src).toContain('changes.platform_filters')
  })
})

describe('edit form: sub links', () => {
  test('sub links live in the form', () => {
    expect(form).toContain('makeSubLinksRow(ch)')
    expect(mgmt).toContain('channelSubLinks(ch)')
  })
})

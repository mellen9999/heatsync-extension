import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/multichat/main.js', import.meta.url), 'utf8')
const menu = src.slice(src.indexOf('// Channel tabs get edit/remove context menu'))

describe('channel tab right-click menu: send to', () => {
  test('carries the send-to section as green / red buttons', () => {
    expect(menu).toContain("hdr.textContent = 'send to'")
    expect(menu).toContain("on ? '#00ff00' : '#ff0000'")
  })

  test('shows for any tab with a linked platform and never empties the targets', () => {
    expect(menu).toContain('Object.values(linked).some(Boolean)')
    expect(menu).toContain('if (!next) return')
  })

  test('persists the change', () => {
    expect(menu).toContain('ch.sendTargets = next')
    expect(menu).toContain('saveConfig()')
  })
})

describe('channel tab right-click menu: platforms', () => {
  test('has a platforms view filter with the same green / red buttons', () => {
    expect(menu).toContain("pHdr.textContent = 'platforms'")
    expect(menu).toContain('togglePlatformFilter(tabId, key)')
    expect(menu).toContain('renderMessages(tabId)')
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

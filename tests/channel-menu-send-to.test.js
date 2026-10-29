import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/multichat/main.js', import.meta.url), 'utf8')
const menu = src.slice(src.indexOf('// Channel tabs get edit/remove context menu'))

describe('channel tab right-click menu', () => {
  test('carries the send-to section as green / red buttons', () => {
    expect(menu).toContain("hdr.textContent = 'send to'")
    expect(menu).toContain("on ? '#00ff00' : '#ff0000'")
  })

  test('only shows with 2+ linked platforms and never empties the targets', () => {
    expect(menu).toContain('.filter(Boolean).length > 1')
    expect(menu).toContain('if (!next) return')
  })

  test('persists the change', () => {
    expect(menu).toContain('ch.sendTargets = next')
    expect(menu).toContain('saveConfig()')
  })
})

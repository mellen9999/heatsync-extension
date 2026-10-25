// "heatsync on <site>" off means heatsync does not mount there at all and the page keeps its own chat.
// One decision at the top of init, before any watcher, listener or style exists — so there is nothing
// to hide and nothing to give back. The mirror keeps the document_start scripts (early-layout prepaint,
// pcard-early's swallow of the native user card) out of an off site too. Host-page code can't be
// imported, so this is a source-level guard.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const main = readFileSync(join(root, 'src', 'multichat', 'main.js'), 'utf8')
const early = readFileSync(join(root, 'chrome', 'early-layout.js'), 'utf8')
const schema = readFileSync(join(root, 'src', 'lib', 'settings-schema.js'), 'utf8')

describe('per-site overlay off', () => {
  test('one pill per site, on by default', () => {
    for (const site of ['twitch', 'kick', 'youtube']) {
      expect(schema).toContain(`value: 'overlay-${site}'`)
      expect(schema).toContain(`'overlay-${site}': true`)
    }
  })

  test('decided before anything else in init mounts', () => {
    const gate = main.indexOf('if (!overlayEnabledHere(_gatesAtBoot))')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(main.indexOf('mcInitialized = true'))
    expect(gate).toBeLessThan(main.lastIndexOf('injectStyles()\n'))
  })

  test('the document_start scripts follow the same switch', () => {
    expect(main).toContain("localStorage.setItem('hs_gate_overlay'")
    expect(main).toContain("localStorage.setItem('hs_gate_profile-cards', '0')")
    expect(early).toContain("localStorage.getItem('hs_gate_overlay') === '0'")
  })
})

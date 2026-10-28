import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The emote tooltip's source chip ("Heatsync", "7TV"...) wears its provider's
 * colours whenever it names a provider. An emote right-clicked out of the
 * inventory drops to state `unadded`, which named the provider but wore no
 * `src-` class, so the chip fell back to the plain white-on-black-text look.
 */
const root = join(import.meta.dir, '..', 'src', 'multichat')
const js = readFileSync(join(root, 'tooltips.js'), 'utf8')
const css = readFileSync(join(root, 'styles', '10-emotes.css'), 'utf8')

describe('tooltip source chip', () => {
  test('any state that names a provider gets that provider class, not just global/channel/sub', () => {
    const line = js.slice(js.indexOf('const srcClass'), js.indexOf('stateEl.className'))
    expect(line).toContain("state !== 'owned' && state !== 'blocked' && source")
    expect(line).not.toContain("state === 'global' || state === 'channel'")
  })

  test('the heatsync chip is black with the brand border', () => {
    const rule =
      css.match(/\.tooltip-source\.src-heatsync,\s*#hs-emote-tooltip \.tooltip-source\.src-hs\s*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).toContain('background: #000000')
  })
})

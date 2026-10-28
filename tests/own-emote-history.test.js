/**
 * Your own chat lines keep the heatsync emote that was in your inventory when
 * you sent them — removing it, blocking, unblocking or re-adding it never
 * rewrites history — and a line sent while you did NOT own it stays text.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as mods from '../src/lib/modifiers.js'

globalThis.cleanup = { setIntervalIfVisible: () => {}, persistInterval: () => {}, setTimeout: () => 0 }
globalThis.HS_MOD_TOKENS = mods.HS_MOD_TOKENS
globalThis.hsModClassify = mods.hsModClassify
globalThis.hsModBuildStyleAttr = mods.hsModBuildStyleAttr
globalThis.hsModInjectWrapperStyle = mods.hsModInjectWrapperStyle
globalThis.hsModComposeFilter = mods.hsModComposeFilter
globalThis.hsModHexToHue = mods.hsModHexToHue
globalThis.HS_MOD_C_HEX_RE = /^c!#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
globalThis.getSetting = () => undefined
globalThis.currentTab = 'chan-a'
globalThis.getCurrentChannel = () => 'chan-a'
globalThis.getLiveChannel = () => 'chan-a'

const { pastOwnership, pastOwnershipAt } = await import('../src/multichat/emotes.js')
const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8')

const H = 3_600_000 // hours, so the 2-minute clock-skew pad never blurs a boundary
const T = { before: 1 * H, owned: 2 * H, gap: 4 * H, again: 6 * H }
const interval = {
  url: 'https://cdn.7tv.app/emote/ass23/2x.webp',
  source: '7tv',
  zeroWidth: false,
  from: 1.5 * H,
  to: 3 * H,
}

beforeEach(() => pastOwnership.clear())

describe('own lines and a closed ownership interval', () => {
  test('a line sent while it was owned resolves to the emote, after it is gone', () => {
    pastOwnership.set('ass23', [interval])
    expect(pastOwnershipAt('ass23', T.owned)?.url).toBe(interval.url)
  })

  test('a line sent before it was owned, or in the gap after removal, stays text', () => {
    pastOwnership.set('ass23', [interval])
    expect(pastOwnershipAt('ass23', T.before)).toBeNull()
    expect(pastOwnershipAt('ass23', T.gap)).toBeNull()
  })

  test('a second stretch of ownership does not erase the first', () => {
    pastOwnership.set('ass23', [interval, { ...interval, from: 5 * H, to: 7 * H }])
    expect(pastOwnershipAt('ass23', T.owned)).not.toBeNull()
    expect(pastOwnershipAt('ass23', T.again)).not.toBeNull()
    expect(pastOwnershipAt('ass23', T.gap)).toBeNull()
  })

  test('an unknown time or name resolves to nothing', () => {
    pastOwnership.set('ass23', [interval])
    expect(pastOwnershipAt('ass23', undefined)).toBeNull()
    expect(pastOwnershipAt('nope', T.owned)).toBeNull()
  })
})

describe('wiring', () => {
  test('removing an emote records its interval, and own-line lookup consults it', () => {
    expect(SRC).toContain('rememberPastOwnership(emoteName, _re, Date.now())')
    expect(SRC).toContain('(_rf ? pastOwnershipAt(raw, msgTime) : null)')
  })
})

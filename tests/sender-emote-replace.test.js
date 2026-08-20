/**
 * Unit tests for src/multichat/emotes.js sender-set lifecycle — authoritative
 * replace (drop reporting), name-drop fanout, and persisted-blob versioning.
 *
 * Same standalone-import pattern as emote-precedence.test.js: emotes.js runs
 * concatenated in the real bundle, so bundle-globals (cleanup, log, safeUrl,
 * chrome, main.js tab state) are stubbed on globalThis before import.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import * as mods from '../src/lib/modifiers.js'

globalThis.cleanup = {
  setIntervalIfVisible: () => {},
  persistInterval: () => {},
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
}
globalThis.HS_MOD_TOKENS = mods.HS_MOD_TOKENS
globalThis.hsModClassify = mods.hsModClassify
globalThis.hsModBuildStyleAttr = mods.hsModBuildStyleAttr
globalThis.hsModInjectWrapperStyle = mods.hsModInjectWrapperStyle
globalThis.hsModComposeFilter = mods.hsModComposeFilter
globalThis.hsModHexToHue = mods.hsModHexToHue
// Duplicated (not exported by modifiers.js) — same precedent as emote-precedence.test.js.
globalThis.HS_MOD_C_HEX_RE = /^c!#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
globalThis.log = () => {}
// Real safeUrl lives in src/lib/utils.js (bundle-global) — mirror its contract:
// http(s) only.
globalThis.safeUrl = (u) => /^https?:\/\//i.test(u)
globalThis.currentTab = 'chan-a'
globalThis.getCurrentChannel = () => 'chan-a'
globalThis.getLiveChannel = () => 'chan-a'

// chrome.storage.local stub with an inspectable backing store.
//
// PUT BACK WHAT WAS THERE. bun runs every test file in one process, so this
// global outlives the file — and these stubs are promise-returning, while
// src/lib/browser-api.js promisifies chrome's storage by passing a CALLBACK
// that a promise-returning stub never invokes. Any file loading browser-api
// after this one therefore awaited a promise that could not settle: four
// browser-api tests timed out and the whole `bun test` process hung, which on
// CI meant the release job sat until github's 6h cap and shipped nothing
// (v1.7.59 and v1.7.60 both died that way). File order is the only reason it
// passed locally.
const _chromeBeforeThisFile = globalThis.chrome
const storageData = {}
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const out = {}
        for (const k of Array.isArray(keys) ? keys : [keys]) {
          if (k in storageData) out[k] = storageData[k]
        }
        return out
      },
      set: async (obj) => Object.assign(storageData, obj),
      remove: async (keys) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete storageData[k]
      },
    },
  },
}

const { dropEmoteFromAllSenders, loadSenderEmoteSets, mergeSenderEmotes, replaceSenderEmotes, senderEmoteSets } =
  await import('../src/multichat/emotes.js')

const E = (url = 'https://cdn.heatsync.org/e/x.webp') => ({ url, state: 'live', source: 'heatsync' })

beforeEach(() => {
  senderEmoteSets.clear()
  for (const k of Object.keys(storageData)) delete storageData[k]
})

describe('replaceSenderEmotes', () => {
  test('reports dropped when a cached name is absent from the fresh set', () => {
    mergeSenderEmotes('twitch:1', { Stale: E(), Kept: E() })
    const r = replaceSenderEmotes('twitch:1', { Kept: E() })
    expect(r.changed).toBe(true)
    expect(r.dropped).toBe(true)
    expect(senderEmoteSets.get('twitch:1').has('Stale')).toBe(false)
    expect(senderEmoteSets.get('twitch:1').has('Kept')).toBe(true)
  })

  test('empty authoritative response drops everything (the flip-bug case)', () => {
    mergeSenderEmotes('twitch:1', { Ghost: E() })
    const r = replaceSenderEmotes('twitch:1', {})
    expect(r).toEqual({ changed: true, dropped: true })
    expect(senderEmoteSets.get('twitch:1').size).toBe(0)
  })

  test('identical replace reports no change and no drop', () => {
    replaceSenderEmotes('twitch:1', { Same: E() })
    const r = replaceSenderEmotes('twitch:1', { Same: E() })
    expect(r).toEqual({ changed: false, dropped: false })
  })

  test('pure addition changes without dropping', () => {
    replaceSenderEmotes('twitch:1', { A: E() })
    const r = replaceSenderEmotes('twitch:1', { A: E(), B: E() })
    expect(r).toEqual({ changed: true, dropped: false })
  })

  test('unsafe-url rejection drops a previously cached name', () => {
    replaceSenderEmotes('twitch:1', { Evil: E() })
    const r = replaceSenderEmotes('twitch:1', { Evil: E('javascript:alert(1)') })
    expect(r.dropped).toBe(true)
    expect(senderEmoteSets.get('twitch:1').has('Evil')).toBe(false)
  })

  test('missing senderKey is a no-op with the object shape', () => {
    expect(replaceSenderEmotes(null, { A: E() })).toEqual({ changed: false, dropped: false })
  })
})

describe('dropEmoteFromAllSenders', () => {
  test('tombstones the name in every cached set (entry kept, removedAt stamped)', () => {
    mergeSenderEmotes('twitch:1', { Gone: E(), Stays: E() })
    mergeSenderEmotes('kick:bob', { Gone: E() })
    expect(dropEmoteFromAllSenders('Gone')).toBe(true)
    // Interval semantics: the entry survives with removedAt so already-owned
    // history keeps rendering; _sGate blocks it for messages after the stamp.
    expect(senderEmoteSets.get('twitch:1').get('Gone').removedAt).toBeGreaterThan(0)
    expect(senderEmoteSets.get('twitch:1').get('Stays').removedAt).toBeUndefined()
    expect(senderEmoteSets.get('kick:bob').get('Gone').removedAt).toBeGreaterThan(0)
    // Already-tombstoned entries report no change (keeps the original stamp)
    expect(dropEmoteFromAllSenders('Gone')).toBe(false)
  })

  test('refetch after tombstone restores the entry (innocent-sender recovery)', () => {
    mergeSenderEmotes('twitch:1', { Shared: E() })
    dropEmoteFromAllSenders('Shared')
    expect(senderEmoteSets.get('twitch:1').get('Shared').removedAt).toBeGreaterThan(0)
    // Fresh authoritative data for this sender still contains the name —
    // the merge clears the tombstone so their emote renders again.
    mergeSenderEmotes('twitch:1', { Shared: E() })
    expect(senderEmoteSets.get('twitch:1').get('Shared').removedAt).toBeUndefined()
  })
})

describe('inventory-interval carry', () => {
  test('replace keeps a stamped (addedAt) entry as a tombstone instead of deleting', () => {
    replaceSenderEmotes('twitch:1', { Owned: { ...E(), addedAt: 1000 }, Provider: E() })
    const r = replaceSenderEmotes('twitch:1', {})
    expect(r).toEqual({ changed: true, dropped: true })
    // Stamped heatsync entry → tombstoned (history stays rendered)
    expect(senderEmoteSets.get('twitch:1').get('Owned').removedAt).toBeGreaterThan(0)
    // Unstamped provider entry → old delete semantics
    expect(senderEmoteSets.get('twitch:1').has('Provider')).toBe(false)
  })

  test('re-collect keeps the EARLIEST addedAt so old rows never un-render', () => {
    mergeSenderEmotes('twitch:1', { Back: { ...E(), addedAt: 1000 } })
    dropEmoteFromAllSenders('Back')
    mergeSenderEmotes('twitch:1', { Back: { ...E(), addedAt: 99999 } })
    const e = senderEmoteSets.get('twitch:1').get('Back')
    expect(e.addedAt).toBe(1000)
    expect(e.removedAt).toBeUndefined()
  })
})

describe('loadSenderEmoteSets versioning', () => {
  test('unversioned (pre-v2) blob is discarded and removed from storage', async () => {
    storageData.sender_emote_sets = { 'twitch:1': { Bleed: E() } }
    await loadSenderEmoteSets()
    expect(senderEmoteSets.size).toBe(0)
    expect('sender_emote_sets' in storageData).toBe(false)
  })

  test('v2 blob loads normally', async () => {
    storageData.sender_emote_sets = { 'twitch:1': { Good: E() } }
    storageData.sender_emote_sets_v = 2
    await loadSenderEmoteSets()
    expect(senderEmoteSets.get('twitch:1').get('Good').url).toBe(E().url)
  })

  test('missing blob is a clean no-op regardless of version key', async () => {
    await loadSenderEmoteSets()
    expect(senderEmoteSets.size).toBe(0)
  })
})

afterAll(() => {
  if (_chromeBeforeThisFile === undefined) delete globalThis.chrome
  else globalThis.chrome = _chromeBeforeThisFile
})

/**
 * Owner flow (2026-10-09): tap an emote someone used in a chat row (a CHANNEL
 * emote: ffz/7tv/bttv, state 'channel'), send it later - maybe from another
 * channel's tab. Send must add it to the inventory exactly once (so it renders
 * for the sender and survives a reload) and seed the own-echo, and must never
 * spend a slot on emotes the viewer owns or on server-refused globals.
 *
 * Carved from the content-script bundle source (same rationale as
 * click-paste-autoadd.test.js): registerClickPasteForAutoAdd -> recent map ->
 * autoAddInputEmotes -> addEmoteToInventory.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
const a0 = SRC.indexOf('const recentRemoteCompletions = new Map()')
const a1 = SRC.indexOf('// Native twitch chat parity:')
const b0 = SRC.indexOf('function autoAddInputEmotes(text)')
const b1 = SRC.indexOf('// Sticky-focus window after a send')
if ([a0, a1, b0, b1].some((i) => i === -1) || a1 <= a0 || b1 <= b0) throw new Error('carve markers not found')

const FFZ = 'https://cdn.frankerfacez.com/emote/593143/1'

function rig({ inventory = [], cache = new Map(), ok = true } = {}) {
  const added = []
  const viewerPersonalEmotes = new Map()
  const inventoryEmotes = new Set(inventory)
  const env = {
    lookupEmoteRenderOrder: () => null,
    senderEmoteSets: new Map(),
    zeroWidthForSameAsset: () => false,
    _hsEmoteAssetId: () => null,
    blockedEmoteNames: new Set(),
    inventoryEmotes,
    pendingEmoteOps: new Set(),
    emoteCache: cache,
    viewerPersonalEmotes,
    addEmoteToInventory: async (...args) => {
      added.push(args)
      return ok
    },
  }
  const names = Object.keys(env)
  const api = new Function(
    ...names,
    `${SRC.slice(a0, a1)}\n${SRC.slice(b0, b1)}; return { registerClickPasteForAutoAdd, autoAddInputEmotes }`,
  )(...names.map((k) => env[k]))
  return { ...api, added, viewerPersonalEmotes }
}

describe('a tapped channel emote joins the inventory on send', () => {
  test('added once, with url + source, and the own-echo is seeded', () => {
    const { registerClickPasteForAutoAdd, autoAddInputEmotes, added, viewerPersonalEmotes } = rig()
    registerClickPasteForAutoAdd('GoodLuck', FFZ, 'ffz') // row emote click (state channel)
    autoAddInputEmotes('gl GoodLuck GoodLuck')
    expect(added.length).toBe(1)
    expect(added[0].slice(0, 3)).toEqual(['GoodLuck', FFZ, 'ffz'])
    expect(viewerPersonalEmotes.get('GoodLuck')).toMatchObject({ url: FFZ, source: 'ffz', state: 'owned' })
  })

  test('a failed add rolls the optimistic entry back', async () => {
    const { registerClickPasteForAutoAdd, autoAddInputEmotes, viewerPersonalEmotes } = rig({ ok: false })
    registerClickPasteForAutoAdd('GoodLuck', FFZ, 'ffz')
    autoAddInputEmotes('GoodLuck')
    await new Promise((r) => setTimeout(r, 0))
    expect(viewerPersonalEmotes.has('GoodLuck')).toBe(false)
  })

  test('already in the inventory: no add', () => {
    const { registerClickPasteForAutoAdd, autoAddInputEmotes, added } = rig({ inventory: ['GoodLuck'] })
    registerClickPasteForAutoAdd('GoodLuck', FFZ, 'ffz')
    autoAddInputEmotes('GoodLuck')
    expect(added.length).toBe(0)
  })

  test('a server-refused global (emoteCache state global): no add', () => {
    const cache = new Map([['GoodLuck', { url: FFZ, source: 'ffz', state: 'global' }]])
    const { registerClickPasteForAutoAdd, autoAddInputEmotes, added } = rig({ cache })
    registerClickPasteForAutoAdd('GoodLuck', FFZ, 'ffz')
    autoAddInputEmotes('GoodLuck')
    expect(added.length).toBe(0)
  })

  test('typed word that was never tapped: no add', () => {
    const { autoAddInputEmotes, added } = rig()
    autoAddInputEmotes('GoodLuck')
    expect(added.length).toBe(0)
  })
})

/**
 * Emotes that share a name — the channel's IDK and another IDK from the catalog
 * (src/multichat/input.js, src/multichat/emotes.js).
 *
 * Regression anchor (nl_kripp, 2026-11): the channel has a 7tv IDK; a heatsync user
 * tabbed through completion to use a DIFFERENT IDK from the catalog and everyone,
 * him included, kept seeing the channel's. Four holes, one per describe below:
 *   1. the Tab cycle dropped a catalog hit whose NAME matched a local candidate, so
 *      the other IDK was never offered. Dedupe is by PICTURE now (a twin is the same
 *      emote, not merely the same name).
 *   2. cycling back onto the local IDK (or a native one) left the catalog pick
 *      registered, so the send added an emote the box no longer showed.
 *   3. typing the whole name registered the catalog's variant even though the
 *      channel's emote answers to that name.
 *   4. auto-add on send skipped any name you already own, so a different IDK never
 *      replaced yours; it now swaps (remove, then add, in that order) — but only for
 *      a deliberate catalog pick, never for tabbing onto the channel's own emote.
 *
 * Carved out of the non-module content-script bundle and evaluated standalone
 * (same rationale as tab-cycle-pagination.test.js).
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')
const INPUT = read('input.js')
const EMOTES = read('emotes.js')
const slice = (src, from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  if (a === -1 || b === -1) throw new Error(`carve markers not found: ${from} .. ${to}`)
  return src.slice(a, b)
}

const REGISTRY = slice(INPUT, 'const recentRemoteCompletions = new Map()', '// Native twitch chat parity:')
const FETCH = slice(INPUT, 'let _acRemoteAbort = null', '// Colon-triggered dropdown state')
const AUTO_ADD = slice(INPUT, 'function autoAddInputEmotes(text)', '// Sticky-focus window after a send')
const CYCLE_META = slice(INPUT, 'function emoteCycleMeta(m)', 'function showCycleTooltip()')
const SWAP = slice(EMOTES, '// Swap what you own under a name', '// Sync block/unblock to heatsync.org API')
const REMOVE = slice(EMOTES, '// Resolves true when the server dropped it', '// Re-run the hover on whatever')

const seven = (id, size = '2x.webp') => `https://cdn.7tv.app/emote/${id}/${size}`
const CHAN = seven('01CHANNELIDK00000000000000')
const OTHER = seven('01OTHERIDK000000000000000')
const OTHER2 = seven('01OTHERIDK200000000000000')
const OWNED = seven('01OWNEDIDK000000000000000')

// the channel's IDK, as findEmoteMatches hands it to the cycle (tier 0)
const channelIdk = () => ({ name: 'IDK', url: CHAN, source: '7tv', type: 'emote', tier: 0, priority: 0 })
const hit = (name, url, provider = '7tv') => ({ name, url, provider, id: url.split('/')[4] })

// One scope holding the registry, the catalog fetch and the send-time commit, so a
// pick travels the same path it does in the bundle: fetch -> track -> autoAdd.
function rig({
  matches = [],
  search = 'idk',
  stv = [],
  inventory = [],
  personal = {},
  blocked = [],
  cache,
  swapOk = true,
} = {}) {
  const calls = { add: [], swap: [] }
  const acState = {
    active: true,
    matches,
    index: 0,
    search,
    remoteDone: false,
    remotePending: false,
    _remotePage: 0,
    _remoteExhausted: null,
    _aiSeq: 0,
  }
  const env = {
    acState,
    hsModClassify: () => ({ kind: 'word' }),
    showCycleTooltip: () => {},
    mcSearchFfzApi: async () => [],
    mcSearchBttvApi: async () => [],
    mcSearch7tvApi: async (_q, _s, o) => (o.page === 1 ? stv : []),
    emoteCache: cache || new Map(),
    inventoryEmotes: new Set(inventory),
    viewerPersonalEmotes: new Map(Object.entries(personal)),
    blockedEmoteNames: new Set(blocked),
    pendingEmoteOps: new Set(),
    addEmoteToInventory: async (...a) => {
      calls.add.push(a)
      return true
    },
    swapEmoteInInventory: async (...a) => {
      calls.swap.push(a)
      return swapOk
    },
    zeroWidthForSameAsset: () => false,
    lookupEmoteRenderOrder: () => null,
    senderEmoteSets: new Map(),
    _hsEmoteAssetId: () => null,
  }
  const names = Object.keys(env)
  const api = new Function(
    ...names,
    `function insertCompletionKeepOpen(m) { trackCompletionForAutoAdd(m) }
     ${REGISTRY}
     ${FETCH}
     ${AUTO_ADD}
     return { fetchRemoteEmoteMatches, recentRemoteCompletions, trackCompletionForAutoAdd, autoAddInputEmotes, insertCompletionKeepOpen }`,
  )(...names.map((k) => env[k]))
  return { ...api, acState, calls, env }
}

describe('1. the cycle offers another emote under a name a local already has', () => {
  test('a catalog IDK of a different picture joins the channel IDK (partial query)', async () => {
    const r = rig({ search: 'id', matches: [channelIdk()], stv: [hit('IDK', OTHER)] })
    await r.fetchRemoteEmoteMatches('id')
    expect(r.acState.matches.map((m) => [m.name, m.url, !!m.remote])).toEqual([
      ['IDK', CHAN, false],
      ['IDK', OTHER, true],
    ])
  })

  test('the channel IDK itself coming back from the catalog is a twin, in any size or format', async () => {
    const r = rig({
      search: 'id',
      matches: [channelIdk()],
      stv: [hit('IDK', seven('01CHANNELIDK00000000000000', '1x.avif')), hit('IDK', OTHER)],
    })
    await r.fetchRemoteEmoteMatches('id')
    // the twin is dropped and does not shadow the real variant behind it
    expect(r.acState.matches.map((m) => m.url)).toEqual([CHAN, OTHER])
  })

  test('typed in full: every other upload is its own entry, the twin is not', async () => {
    const r = rig({
      matches: [channelIdk()],
      stv: [hit('IDK', CHAN), hit('IDK', OTHER), hit('IDK', OTHER2)],
    })
    await r.fetchRemoteEmoteMatches('idk')
    expect(r.acState.matches.map((m) => m.url)).toEqual([CHAN, OTHER, OTHER2])
  })

  test('a partial query still collapses the catalog own same-name uploads to one', async () => {
    const r = rig({ search: 'id', matches: [channelIdk()], stv: [hit('IDK', OTHER), hit('IDK', OTHER2)] })
    await r.fetchRemoteEmoteMatches('id')
    expect(r.acState.matches.map((m) => m.url)).toEqual([CHAN, OTHER])
  })

  test('the same name in another case is another emote too, unless it is the same picture', async () => {
    const r = rig({ search: 'id', matches: [channelIdk()], stv: [hit('idk', CHAN), hit('idk', OTHER)] })
    await r.fetchRemoteEmoteMatches('id')
    expect(r.acState.matches.map((m) => [m.name, m.url])).toEqual([
      ['IDK', CHAN],
      ['idk', OTHER],
    ])
  })

  test('a name the globals own is not offered a second emote (the server would refuse the add)', async () => {
    const cache = new Map([['Kappa', { url: 'https://static-cdn.jtvnw.net/k', state: 'global' }]])
    const r = rig({
      search: 'ka',
      cache,
      matches: [{ name: 'Kappa', url: 'https://static-cdn.jtvnw.net/k', source: 'twitch', type: 'emote', tier: 2 }],
      stv: [hit('Kappa', OTHER), hit('Kaplan', OTHER2)],
    })
    await r.fetchRemoteEmoteMatches('ka')
    expect(r.acState.matches.map((m) => m.name)).toEqual(['Kappa', 'Kaplan'])
  })

  test('a local that is a different picture from the catalog hit of another name changes nothing', async () => {
    const r = rig({ search: 'sad', matches: [channelIdk()], stv: [hit('SadgeX', OTHER)] })
    await r.fetchRemoteEmoteMatches('sad')
    expect(r.acState.matches.map((m) => m.name)).toEqual(['IDK', 'SadgeX'])
  })
})

describe('3. typing the whole name does not register a variant the channel already answers to', () => {
  test('channel IDK in the cycle: nothing registers, so sending "IDK" adds nothing', async () => {
    const r = rig({ matches: [channelIdk()], stv: [hit('IDK', OTHER)] })
    await r.fetchRemoteEmoteMatches('idk')
    expect(r.acState.matches.length).toBe(2) // the other IDK is still on offer
    expect(r.recentRemoteCompletions.has('IDK')).toBe(false)
    r.autoAddInputEmotes('IDK')
    expect(r.calls.add).toEqual([])
    expect(r.calls.swap).toEqual([])
  })

  test('with nothing local under that name the exact catalog hit still registers (as a variant)', async () => {
    const r = rig({ matches: [], stv: [hit('IDK', OTHER)] })
    await r.fetchRemoteEmoteMatches('idk')
    expect(r.recentRemoteCompletions.get('IDK')).toMatchObject({ url: OTHER, source: '7tv', variant: true })
  })

  test('a local of a DIFFERENT name does not count as answering', async () => {
    const r = rig({ matches: [{ ...channelIdk(), name: 'IDKw' }], stv: [hit('idk', OTHER)], search: 'idk' })
    await r.fetchRemoteEmoteMatches('idk')
    expect(r.recentRemoteCompletions.get('idk')?.url).toBe(OTHER)
  })
})

describe('2. the box shows the pick; cycling back to the local one un-picks the catalog one', () => {
  const variant = { name: 'IDK', url: OTHER, source: '7tv', type: 'emote', remote: true }

  test('tabbing onto the catalog IDK registers it as a variant', () => {
    const r = rig()
    r.insertCompletionKeepOpen(variant)
    expect(r.recentRemoteCompletions.get('IDK')).toEqual({ url: OTHER, source: '7tv', zeroWidth: false, variant: true })
  })

  test('back onto the channel IDK: the registry holds the channel one, not a variant', () => {
    const r = rig()
    r.insertCompletionKeepOpen(variant)
    r.insertCompletionKeepOpen(channelIdk())
    expect(r.recentRemoteCompletions.get('IDK')).toEqual({ url: CHAN, source: '7tv', zeroWidth: false })
  })

  test('back onto a native twitch/kick IDK (never registers): the catalog pick is dropped anyway', () => {
    for (const source of ['twitch', 'kick']) {
      const r = rig()
      r.insertCompletionKeepOpen(variant)
      r.insertCompletionKeepOpen({ name: 'IDK', url: 'https://x/y.png', source, type: 'emote', tier: 0 })
      expect(r.recentRemoteCompletions.has('IDK')).toBe(false)
    }
  })

  test('another name does not disturb the pick', () => {
    const r = rig()
    r.insertCompletionKeepOpen(variant)
    r.insertCompletionKeepOpen({ name: 'IDKw', url: CHAN, source: '7tv', type: 'emote', tier: 0 })
    expect(r.recentRemoteCompletions.get('IDK')?.url).toBe(OTHER)
  })

  test('the catalog label names the provider; a local one still says where it lives', () => {
    const { emoteCycleMeta } = new Function(`${CYCLE_META}; return { emoteCycleMeta }`)()
    expect(emoteCycleMeta({ type: 'emote', remote: true, source: '7tv' }).cat).toBe('catalog · 7tv')
    expect(emoteCycleMeta({ type: 'emote', remote: true, source: 'ffz' }).cat).toBe('catalog · ffz')
    expect(emoteCycleMeta({ type: 'emote', source: '7tv', tier: 0 }).cat).toBe('channel')
  })
})

describe('4. sending a picked variant', () => {
  const variantRec = { url: OTHER, source: '7tv', zeroWidth: false, variant: true }

  test('a variant of a name the channel has (and you do not own) is simply added', () => {
    const r = rig()
    r.recentRemoteCompletions.set('IDK', variantRec)
    r.autoAddInputEmotes('lol IDK')
    expect(r.calls.add.map((a) => a.slice(0, 3))).toEqual([['IDK', OTHER, '7tv']])
    expect(r.calls.swap).toEqual([])
  })

  test('a variant of a name you own with a DIFFERENT emote swaps, and does not plain-add', () => {
    const r = rig({ inventory: ['IDK'], personal: { IDK: { url: OWNED, source: 'heatsync', state: 'owned' } } })
    r.recentRemoteCompletions.set('IDK', variantRec)
    r.autoAddInputEmotes('IDK')
    expect(r.calls.swap).toEqual([['IDK', OTHER, '7tv', false]])
    expect(r.calls.add).toEqual([])
  })

  test('the very emote you own (even in another size or format) is left alone', () => {
    const r = rig({ inventory: ['IDK'], personal: { IDK: { url: seven('01OTHERIDK000000000000000', '1x.avif') } } })
    r.recentRemoteCompletions.set('IDK', variantRec)
    r.autoAddInputEmotes('IDK')
    expect(r.calls.swap).toEqual([])
    expect(r.calls.add).toEqual([])
  })

  test('tabbing onto the channel own IDK never replaces the one you own', () => {
    const r = rig({ inventory: ['IDK'], personal: { IDK: { url: OWNED } } })
    r.insertCompletionKeepOpen(channelIdk()) // a local pick: registered, but not a variant
    r.autoAddInputEmotes('IDK')
    expect(r.calls.swap).toEqual([])
    expect(r.calls.add).toEqual([])
  })

  test('an owned emote whose picture cannot be read is never swapped blind', () => {
    const r = rig({ inventory: ['IDK'] })
    r.recentRemoteCompletions.set('IDK', variantRec)
    r.autoAddInputEmotes('IDK')
    expect(r.calls.swap).toEqual([])
  })

  test('blocked names and global names are still skipped', () => {
    const blockedRig = rig({ blocked: ['IDK'] })
    blockedRig.recentRemoteCompletions.set('IDK', variantRec)
    blockedRig.autoAddInputEmotes('IDK')
    expect(blockedRig.calls.add).toEqual([])
    const globalRig = rig({ cache: new Map([['IDK', { state: 'global' }]]) })
    globalRig.recentRemoteCompletions.set('IDK', variantRec)
    globalRig.autoAddInputEmotes('IDK')
    expect(globalRig.calls.add).toEqual([])
  })

  test('a swap that fails leaves your old one standing', async () => {
    const r = rig({ inventory: ['IDK'], personal: { IDK: { url: OWNED } }, swapOk: false })
    r.recentRemoteCompletions.set('IDK', variantRec)
    const done = r.autoAddInputEmotes('IDK')
    expect(done).not.toBeNull()
    expect(await done).toEqual([])
    expect(r.env.viewerPersonalEmotes.get('IDK').url).toBe(OWNED) // still in inventory: not rolled back
  })
})

describe('4b. swapEmoteInInventory: remove first, then add, never leaves you with neither', () => {
  function swapRig({
    removeOk = true,
    addResults = [true],
    old = { url: OWNED, source: 'heatsync', zeroWidth: true },
  } = {}) {
    const log = []
    const toasts = []
    const viewerPersonalEmotes = new Map(old ? [['IDK', old]] : [])
    const adds = [...addResults]
    let removalDone = false
    const env = {
      viewerPersonalEmotes,
      removeEmoteFromInventory: async (name, _el, opts) => {
        log.push(['remove', name, opts])
        // the real one clears the local entry synchronously, before it first awaits
        viewerPersonalEmotes.delete(name)
        await new Promise((r) => setTimeout(r, 5)) // the server round trip
        removalDone = true
        if (!removeOk) viewerPersonalEmotes.set(name, old)
        return removeOk
      },
      addEmoteToInventory: async (name, url, source, _el, zw, silent) => {
        log.push(['add', name, url, source, zw, silent, removalDone])
        await Promise.resolve()
        return adds.length ? adds.shift() : false
      },
      showToast: (text, kind) => toasts.push([text, kind]),
      t: (key, args) => `${key}:${args?.join(',')}`,
    }
    const names = Object.keys(env)
    const { swapEmoteInInventory } = new Function(...names, `${SWAP}; return { swapEmoteInInventory }`)(
      ...names.map((k) => env[k]),
    )
    return { swapEmoteInInventory, log, toasts, viewerPersonalEmotes }
  }

  test('removes the old one, THEN adds the new one, and says so plainly', async () => {
    const r = swapRig()
    expect(await r.swapEmoteInInventory('IDK', OTHER, '7tv', false)).toBe(true)
    expect(r.log.map((l) => l[0])).toEqual(['remove', 'add'])
    expect(r.log[1][6]).toBe(true) // the server had already dropped the old one when the add went out
    expect(r.log[0][2]).toEqual({ silent: true }) // the swap speaks once, not "removed" then "added"
    expect(r.toasts).toEqual([['mc_emote_swapped:IDK', 'success']])
  })

  test('the new one is seeded locally at once, so the line you send right now draws it', async () => {
    const r = swapRig()
    const done = r.swapEmoteInInventory('IDK', OTHER, '7tv', false)
    // synchronously after the call: the old entry is gone, the new one stands in
    expect(r.viewerPersonalEmotes.get('IDK')).toMatchObject({ url: OTHER, state: 'owned' })
    await done
  })

  test('a removal the server refuses ends the swap: nothing is added', async () => {
    const r = swapRig({ removeOk: false })
    expect(await r.swapEmoteInInventory('IDK', OTHER, '7tv', false)).toBe(false)
    expect(r.log.map((l) => l[0])).toEqual(['remove'])
    expect(r.viewerPersonalEmotes.get('IDK').url).toBe(OWNED) // put back
  })

  test('a refused new emote brings the old one back, and says it did', async () => {
    const r = swapRig({ addResults: [false, true] })
    expect(await r.swapEmoteInInventory('IDK', OTHER, '7tv', false)).toBe(false)
    expect(r.log.map((l) => l[0])).toEqual(['remove', 'add', 'add'])
    expect(r.log[2].slice(1, 5)).toEqual(['IDK', OWNED, 'heatsync', true]) // the old emote, zeroWidth kept
    expect(r.toasts).toEqual([['mc_emote_swap_failed:IDK', 'error']])
  })

  test('when even the restore fails it stays loud (the add already toasted its own reason)', async () => {
    const r = swapRig({ addResults: [false, false] })
    expect(await r.swapEmoteInInventory('IDK', OTHER, '7tv', false)).toBe(false)
    expect(r.toasts).toEqual([])
  })

  test('nothing to swap out: no calls', async () => {
    const r = swapRig({ old: null })
    expect(await r.swapEmoteInInventory('IDK', OTHER, '7tv', false)).toBe(false)
    expect(r.log).toEqual([])
  })
})

describe('4c. removeEmoteFromInventory reports the outcome and can stay quiet', () => {
  function removeRig({ response }) {
    const toasts = []
    const undone = []
    const env = {
      pendingEmoteOps: new Set(),
      inventoryHashes: new Map([['IDK', 'hash1']]),
      emoteHashes: new Map(),
      lookupEmote: () => null,
      applyLocalRemoval: () => () => undone.push('undo'),
      chrome: {
        runtime: { lastError: null, sendMessage: (_m, cb) => cb(response) },
      },
      showToast: (text, kind) => toasts.push([text, kind]),
      t: (key) => key,
    }
    const names = Object.keys(env)
    const { removeEmoteFromInventory } = new Function(...names, `${REMOVE}; return { removeEmoteFromInventory }`)(
      ...names.map((k) => env[k]),
    )
    return { removeEmoteFromInventory, toasts, undone, env }
  }

  test('success: true, with its "removed" toast unless silent', async () => {
    const loud = removeRig({ response: { success: true } })
    expect(await loud.removeEmoteFromInventory('IDK', null)).toBe(true)
    expect(loud.toasts).toEqual([['mc_emote_removed', 'success']])
    const quiet = removeRig({ response: { success: true } })
    expect(await quiet.removeEmoteFromInventory('IDK', null, { silent: true })).toBe(true)
    expect(quiet.toasts).toEqual([])
  })

  test('refusal: false, local state put back, the reason shown even when silent', async () => {
    const r = removeRig({ response: { success: false, error: 'nope' } })
    expect(await r.removeEmoteFromInventory('IDK', null, { silent: true })).toBe(false)
    expect(r.undone).toEqual(['undo'])
    expect(r.toasts).toEqual([['nope', 'error']])
    expect(r.env.pendingEmoteOps.size).toBe(0)
  })
})

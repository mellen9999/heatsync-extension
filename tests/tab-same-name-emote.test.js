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
 *      replaced yours; it now swaps (one add carrying replace) — but only for
 *      a deliberate catalog pick, never for tabbing onto the channel's own emote.
 *
 * Carved out of the non-module content-script bundle and evaluated standalone
 * (same rationale as tab-cycle-pagination.test.js).
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bgSource } from './bg-src.js'
import { t } from './t-stub.js'

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

  test('the same name in another case is another emote (dedupe is on the exact name)', async () => {
    const r = rig({ search: 'id', matches: [channelIdk()], stv: [hit('idk', CHAN), hit('idk', OTHER)] })
    await r.fetchRemoteEmoteMatches('id')
    expect(r.acState.matches.map((m) => [m.name, m.url])).toEqual([
      ['IDK', CHAN],
      ['idk', CHAN],
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
    const { emoteCycleMeta } = new Function('t', `${CYCLE_META}; return { emoteCycleMeta }`)(t)
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

const ADD = slice(EMOTES, '// Add emote to inventory (click-to-add', '// Swap what you own under a name')
const BG = bgSource()
const BG_ADD = slice(BG, 'async function addToInventory(', '// Coalesce concurrent removes')

describe('4b. swapEmoteInInventory: ONE add carrying replace, rolled back on refusal', () => {
  function swapRig({
    addResults = [true],
    old = { url: OWNED, source: 'heatsync', zeroWidth: true, hash: 'oldhash' },
  } = {}) {
    const log = []
    const toasts = []
    const viewerPersonalEmotes = new Map(old ? [['IDK', old]] : [])
    const hashToName = new Map([['oldhash', 'IDK']])
    const adds = [...addResults]
    const env = {
      viewerPersonalEmotes,
      hashToName,
      removeEmoteFromInventory: async () => {
        throw new Error('swap must not remove first')
      },
      addEmoteToInventory: async (name, url, source, _el, zw, silent, replace) => {
        log.push(['add', name, url, source, zw, silent, replace, viewerPersonalEmotes.get(name)?.url])
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
    return { swapEmoteInInventory, log, toasts, viewerPersonalEmotes, hashToName }
  }

  test('one silent add with replace:true, no removal, and says so plainly', async () => {
    const r = swapRig()
    expect(await r.swapEmoteInInventory('IDK', OTHER, '7tv', false)).toBe(true)
    expect(r.log.length).toBe(1)
    expect(r.log[0].slice(0, 7)).toEqual(['add', 'IDK', OTHER, '7tv', false, true, true])
    expect(r.toasts).toEqual([['mc_emote_swapped:IDK', 'success']])
    expect(r.hashToName.has('oldhash')).toBe(false)
  })

  test('the new one is seeded locally before the add goes out, so the line you send right now draws it', async () => {
    const r = swapRig()
    const done = r.swapEmoteInInventory('IDK', OTHER, '7tv', false)
    expect(r.viewerPersonalEmotes.get('IDK')).toMatchObject({ url: OTHER, state: 'owned' })
    await done
    expect(r.log[0][7]).toBe(OTHER)
  })

  test('a refused swap rolls back to the old entry (no extra toast: the add said why)', async () => {
    const r = swapRig({ addResults: [false] })
    expect(await r.swapEmoteInInventory('IDK', OTHER, '7tv', false)).toBe(false)
    expect(r.log.length).toBe(1)
    expect(r.viewerPersonalEmotes.get('IDK')).toMatchObject({ url: OWNED, hash: 'oldhash' })
    expect(r.toasts).toEqual([])
    expect(r.hashToName.get('oldhash')).toBe('IDK')
  })

  test('nothing to swap out: no calls', async () => {
    const r = swapRig({ old: null })
    expect(await r.swapEmoteInInventory('IDK', OTHER, '7tv', false)).toBe(false)
    expect(r.log).toEqual([])
  })
})

describe('4b2. addEmoteToInventory carries replace to the background and names an upload refusal', () => {
  function addRig(resp) {
    const sent = []
    const toasts = []
    const env = {
      mcRemoteEmoteIndex: new Map(),
      zeroWidthFromAnyCache: () => false,
      emoteBlockKey: (_n, u, h) => h || btoa(u),
      showToast: (text, kind) => toasts.push([text, kind]),
      t: (key, args) => `${key}:${args?.join(',')}`,
      pendingEmoteOps: new Set(),
      chrome: {
        runtime: {
          lastError: null,
          sendMessage: (msg, cb) => {
            sent.push(msg)
            cb(resp)
          },
        },
      },
      blockedEmoteNames: new Set(),
      removedEmoteFallback: new Map(),
      persistRemovedFallback() {},
      blockedEmoteFallback: new Map(),
      persistBlockedFallback() {},
      localRemovals: new Map(),
      inventoryEmotes: new Set(),
      inventoryHashes: new Map(),
      viewerPersonalEmotes: new Map(),
      emoteCache: new Map(),
      emoteHashes: new Map(),
      hashToName: new Map(),
      queryEmoteWrappers: () => [],
      refreshEmoteTooltip() {},
      flashAllEmotes() {},
      log() {},
    }
    const names = Object.keys(env)
    const { addEmoteToInventory } = new Function(...names, `${ADD}; return { addEmoteToInventory }`)(
      ...names.map((k) => env[k]),
    )
    return { addEmoteToInventory, sent, toasts }
  }

  test('replace=true puts replace:true on the add_to_inventory message', async () => {
    const r = addRig({ success: true, hash: 'h2', slot: 3 })
    expect(await r.addEmoteToInventory('IDK', OTHER, '7tv', null, false, true, true)).toBe(true)
    expect(r.sent.length).toBe(1)
    expect(r.sent[0]).toMatchObject({ type: 'add_to_inventory', emoteName: 'IDK', emoteUrl: OTHER, replace: true })
  })

  test('a plain add never sends replace', async () => {
    const r = addRig({ success: true, hash: 'h2', slot: 3 })
    await r.addEmoteToInventory('IDK', OTHER, '7tv', null, false, true)
    expect('replace' in r.sent[0]).toBe(false)
  })

  test('the upload 409 under replace gets the plain "your upload keeps the name" toast', async () => {
    const r = addRig({ success: false, error: 'name held by your upload' })
    expect(await r.addEmoteToInventory('IDK', OTHER, '7tv', null, false, true, true)).toBe(false)
    expect(r.toasts).toEqual([['mc_emote_swap_upload:IDK', 'error']])
  })
})

describe('4b3. background addToInventory puts replace in the POST body and drops the replaced entry', () => {
  async function bgRig({ replace, ok = true, data = { hash: 'h2', slot: 3, replaced: true } }) {
    const bodies = []
    const store = {
      emoteInventory: [
        { name: 'IDK', hash: 'oldhash', url: OWNED },
        { name: 'Other', hash: 'x', url: CHAN },
      ],
    }
    const env = {
      getAuthCookie: async () => 'tok',
      broadcastToTabs() {},
      log() {},
      API_URL: 'https://x.test',
      fetchWithTimeout: async (_url, init) => {
        bodies.push(JSON.parse(init.body))
        return { ok, status: ok ? 200 : 409, json: async () => data }
      },
      browser: { storage: { local: { set: async () => {} } } },
    }
    const names = Object.keys(env)
    const { addToInventory, inv } = new Function(
      ...names,
      `let emoteInventory = ${JSON.stringify(store.emoteInventory)}
${BG_ADD}
return { addToInventory, inv: () => emoteInventory }`,
    )(...names.map((k) => env[k]))
    const res = await (replace === undefined
      ? addToInventory('IDK', 'h2', OTHER, false)
      : addToInventory('IDK', 'h2', OTHER, false, replace))
    return { bodies, res, inv: inv() }
  }

  test('replace=true: body carries replace:true and the old entry under the name is dropped', async () => {
    const r = await bgRig({ replace: true })
    expect(r.bodies[0].replace).toBe(true)
    expect(r.res.success).toBe(true)
    expect(r.inv.map((e) => e.hash).sort()).toEqual(['h2', 'x'])
  })

  test('no replace: body has no replace key', async () => {
    const r = await bgRig({ replace: undefined, data: { hash: 'h2', slot: 3 } })
    expect('replace' in r.bodies[0]).toBe(false)
  })

  test('the 409 for an upload comes back as the error text', async () => {
    const r = await bgRig({ replace: true, ok: false, data: { error: 'name held by your upload' } })
    expect(r.res).toEqual({ success: false, error: 'name held by your upload' })
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

describe('4b3. an added emote carries the per-emote key, not a truncated url', () => {
  test('the add message sends the full url key', async () => {
    const sent = []
    const url = `https://cdn.7tv.app/emote/${'a'.repeat(30)}/2x.webp`
    const env = {
      mcRemoteEmoteIndex: new Map(),
      zeroWidthFromAnyCache: () => false,
      emoteBlockKey: (_n, u, h) => h || btoa(u),
      showToast() {},
      t: (k) => k,
      pendingEmoteOps: new Set(),
      chrome: {
        runtime: {
          lastError: null,
          sendMessage: (m, cb) => {
            sent.push(m)
            cb({ success: true, hash: 'h', slot: 1 })
          },
        },
      },
      blockedEmoteNames: new Set(),
      removedEmoteFallback: new Map(),
      persistRemovedFallback() {},
      blockedEmoteFallback: new Map(),
      persistBlockedFallback() {},
      localRemovals: new Map(),
      inventoryEmotes: new Set(),
      inventoryHashes: new Map(),
      viewerPersonalEmotes: new Map(),
      emoteCache: new Map(),
      emoteHashes: new Map(),
      hashToName: new Map(),
      queryEmoteWrappers: () => [],
      refreshEmoteTooltip() {},
      flashAllEmotes() {},
      log() {},
    }
    const names = Object.keys(env)
    const { addEmoteToInventory } = new Function(...names, `${ADD}; return { addEmoteToInventory }`)(
      ...names.map((k) => env[k]),
    )
    await addEmoteToInventory('IDK', url, '7tv', null, false, true)
    expect(sent[0].emoteHash).toBe(btoa(url))
    expect(sent[0].emoteHash.length).toBeGreaterThan(32)
  })
})

/**
 * Emotes that share a name — the channel's IDK and another IDK from the catalog
 * (src/multichat/input.js, src/multichat/emotes.js).
 *
 * Regression anchor (nl_kripp, 2026-11): the channel has a 7tv IDK; a heatsync user
 * tabbed through completion to use a DIFFERENT IDK from the catalog and everyone,
 * him included, kept seeing the channel's. Four holes, one per describe below:
 *   1. which IDK the cycle offers. The emote law's offer answers it now (emote-law-offer.js):
 *      a name something loaded answers to keeps its loaded copies (the room's, then yours,
 *      then the global) and the catalog adds no other picture under it. Another IDK is
 *      picked in the picker's search, which shows every upload of a name.
 *   2. cycling back onto the local IDK (or a native one) left the catalog pick
 *      registered, so the send added an emote the box no longer showed.
 *   3. a fetched catalog page registers nothing by itself: only the hit the box shows
 *      (a Tab step, or the first hit when nothing loaded matched) is a pick.
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
import { heldPick, pinPickedEmote, putBackPick } from '../src/lib/emote-refs.js'
import { bgSource } from './bg-src.js'
import { lawOfferRig } from './helpers/law-offer-rig.js'
import { pickRig } from './helpers/pick-rig.js'
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
const AUTO_ADD = slice(INPUT, 'function autoAddInputEmotes(text', '// Sticky-focus window after a send')
const CYCLE_META = slice(INPUT, 'function emoteCycleMeta(m)', 'function showCycleTooltip()')
const PIN_STEP = slice(INPUT, 'function acPinStep(match, box)', '// Insert completion and keep cycling state')
const SWAP = slice(EMOTES, '// Swap what you own under a name', '// Sync block/unblock to heatsync.org API')
const REMOVE = slice(EMOTES, '// Resolves true when the server dropped it', '// Re-run the hover on whatever')
// the line every emote result says: in the bundle it is in scope, here it binds to each rig's own t
const NOTICE = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'emote-notice.js'), 'utf8').replace(
  /^export /gm,
  '',
)

const seven = (id, size = '2x.webp') => `https://cdn.7tv.app/emote/${id}/${size}`
const CHAN = seven('01CHANNELIDK00000000000000')
const OTHER = seven('01OTHERIDK000000000000000')
const OTHER2 = seven('01OTHERIDK200000000000000')
const OWNED = seven('01OWNEDIDK000000000000000')

// the channel's IDK, as its cache holds it
const channelIdk = () => ({ IDK: { url: CHAN, source: '7tv', state: 'global' } })
// and as Tab's list hands it to the cycle (tier 0)
const channelMatch = () => ({ name: 'IDK', url: CHAN, source: '7tv', type: 'emote', tier: 0, priority: 0 })
const hit = (name, url, provider = '7tv') => ({ name, url, provider, id: url.split('/')[4] })

// One scope holding the registry, the catalog fetch and the send-time commit, so a
// pick travels the same path it does in the bundle: fetch -> track -> autoAdd.
function rig({
  room = {},
  search = 'idk',
  stv = [],
  inventory = [],
  personal = {},
  blocked = [],
  cache,
  swapOk = true,
} = {}) {
  const calls = { add: [], swap: [] }
  // Tab's own list over the room's loaded emotes and the globals (the emote law's offer)
  const offer = lawOfferRig({
    emoteCache: cache || new Map(),
    channelEmoteCaches: { 'chan-a': new Map(Object.entries(room)) },
  })
  const acState = {
    active: true,
    matches: offer.findEmoteMatches(search),
    index: 0,
    search,
    remoteDone: false,
    remotePending: false,
    _remotePage: 0,
    _remoteExhausted: null,
    _catalog: null,
  }
  const env = {
    ...pickRig(),
    findEmoteMatches: offer.findEmoteMatches,
    lawCatalogEmote: offer.lawCatalogEmote,
    putBackPick,
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
    `${PIN_STEP}
     function insertCompletionKeepOpen(m) { acPinStep(m, lawBox()); trackCompletionForAutoAdd(m) }
     ${REGISTRY}
     ${FETCH}
     ${AUTO_ADD}
     return { fetchRemoteEmoteMatches, recentRemoteCompletions, trackCompletionForAutoAdd, autoAddInputEmotes, insertCompletionKeepOpen }`,
  )(...names.map((k) => env[k]))
  return { ...api, acState, calls, env }
}

describe('1. the cycle and a name something loaded already answers to', () => {
  test('a catalog IDK does not join the channel IDK: the name keeps its loaded copy', async () => {
    const r = rig({ search: 'id', room: channelIdk(), stv: [hit('IDK', OTHER), hit('IDK', OTHER2)] })
    await r.fetchRemoteEmoteMatches('id')
    expect(r.acState.matches.map((m) => [m.name, m.url, !!m.remote])).toEqual([['IDK', CHAN, false]])
  })

  test('typed in full it is the same: the room IDK, and no other picture under the name', async () => {
    const r = rig({ room: channelIdk(), stv: [hit('IDK', CHAN), hit('IDK', OTHER), hit('IDK', OTHER2)] })
    await r.fetchRemoteEmoteMatches('idk')
    expect(r.acState.matches.map((m) => m.url)).toEqual([CHAN])
  })

  test('the same name in another case is another emote (one copy of it joins)', async () => {
    const r = rig({ search: 'id', room: channelIdk(), stv: [hit('idk', CHAN), hit('idk', OTHER)] })
    await r.fetchRemoteEmoteMatches('id')
    expect(r.acState.matches.map((m) => [m.name, m.url])).toEqual([
      ['IDK', CHAN],
      ['idk', CHAN],
    ])
  })

  test('a name the globals own is not offered a second emote (the server would refuse the add)', async () => {
    const cache = new Map([['Kappa', { url: 'https://static-cdn.jtvnw.net/k', source: 'twitch', state: 'global' }]])
    const r = rig({ search: 'ka', cache, stv: [hit('Kappa', OTHER), hit('Kaplan', OTHER2)] })
    await r.fetchRemoteEmoteMatches('ka')
    expect(r.acState.matches.map((m) => m.name)).toEqual(['Kappa', 'Kaplan'])
  })

  test('a catalog hit of another name joins after the loaded one', async () => {
    const r = rig({ search: 'id', room: channelIdk(), stv: [hit('IDKwhat', OTHER)] })
    await r.fetchRemoteEmoteMatches('id')
    expect(r.acState.matches.map((m) => m.name)).toEqual(['IDK', 'IDKwhat'])
  })
})

describe('3. a fetched page registers nothing the box does not show', () => {
  test('channel IDK in the cycle: nothing registers, so sending "IDK" adds nothing', async () => {
    const r = rig({ room: channelIdk(), stv: [hit('IDK', OTHER)] })
    await r.fetchRemoteEmoteMatches('idk')
    expect(r.acState.matches.length).toBe(1)
    expect(r.recentRemoteCompletions.has('IDK')).toBe(false)
    r.autoAddInputEmotes('IDK')
    expect(r.calls.add).toEqual([])
    expect(r.calls.swap).toEqual([])
  })

  test('with nothing loaded matching, the exact catalog hit completes the word and registers (as a variant)', async () => {
    const r = rig({ stv: [hit('IDKother', OTHER2), hit('IDK', OTHER)] })
    await r.fetchRemoteEmoteMatches('idk')
    expect(r.acState.matches[0]).toMatchObject({ name: 'IDK', url: OTHER })
    expect(r.recentRemoteCompletions.get('IDK')).toMatchObject({ url: OTHER, source: '7tv', variant: true })
    expect(r.recentRemoteCompletions.has('IDKother')).toBe(false)
  })

  test('a loaded emote of another name holds the box: the exact catalog name is one Tab away, not registered', async () => {
    const r = rig({ room: { IDKw: { url: CHAN, source: '7tv', state: 'global' } }, stv: [hit('idk', OTHER)] })
    await r.fetchRemoteEmoteMatches('idk')
    expect(r.acState.matches.map((m) => m.name)).toEqual(['IDKw', 'idk'])
    expect(r.recentRemoteCompletions.has('idk')).toBe(false)
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
    r.insertCompletionKeepOpen(channelMatch())
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

  test("a copy the platform's own emote of that name will hide says so, and still says where it lives", () => {
    const { emoteCycleMeta } = new Function('t', `${CYCLE_META}; return { emoteCycleMeta }`)(t)
    const meta = emoteCycleMeta({ type: 'emote', source: '7tv', tier: 0, shadowed: true })
    expect(meta.cat).toBe('channel')
    expect(meta.vis).toEqual({ t: "won't show here", c: 'var(--hs-danger)', k: 'wont' })
  })
})

describe('2b. a step only looked at leaves its name as it found it', () => {
  const catalogIdk = { type: 'emote', name: 'IDK', url: OTHER, source: '7tv', remote: true }
  const other = { type: 'emote', name: 'IDKW', url: OTHER2, source: '7tv', remote: true }
  const pick = (r, name) => heldPick(name, r.env.lawBox())[0]

  test('cycling past the catalog IDK onto another name un-picks IDK', () => {
    const r = rig()
    r.insertCompletionKeepOpen(catalogIdk)
    expect(pick(r, 'IDK').url).toBe(OTHER)
    r.insertCompletionKeepOpen(other)
    expect(pick(r, 'IDK')).toBeUndefined()
    expect(pick(r, 'IDKW').url).toBe(OTHER2)
  })

  test('an IDK picked earlier in this message is still that pick after a later cycle looks at another IDK', () => {
    const r = rig()
    pinPickedEmote({ name: 'IDK', url: CHAN, provider: '7tv' }, r.env.lawBox()) // picked two words ago
    r.insertCompletionKeepOpen(catalogIdk) // a new cycle passes over the catalog's
    r.insertCompletionKeepOpen(other) // and lands elsewhere
    expect(pick(r, 'IDK').url).toBe(CHAN)
  })

  test('the step the cycle stops on stays: the next cycle does not undo it', () => {
    const r = rig()
    r.insertCompletionKeepOpen(catalogIdk)
    r.acState._pinStep = null // hideAutocomplete: the cycle is over
    r.insertCompletionKeepOpen(other)
    expect(pick(r, 'IDK').url).toBe(OTHER)
  })

  test('two IDKs in a row within one cycle: the last one looked at is the pick', () => {
    const r = rig()
    r.insertCompletionKeepOpen(channelMatch())
    r.insertCompletionKeepOpen(catalogIdk)
    expect(pick(r, 'IDK').url).toBe(OTHER)
  })

  // one name is one picture in a line: an IDK already in the box is read again when the name's
  // answer changes (render case x holds the box itself; here, that every change asks)
  test('a step that pins asks for the box to be read again', () => {
    const r = rig()
    r.insertCompletionKeepOpen(catalogIdk)
    expect(r.env.followPicks.asked).toBe(1)
  })

  test('so does a step that only gives a name back: on to an emoji, which pins nothing', () => {
    const r = rig()
    r.insertCompletionKeepOpen(catalogIdk)
    const before = r.env.followPicks.asked
    r.insertCompletionKeepOpen({ type: 'emoji', name: 'smile', char: '🙂' })
    expect(pick(r, 'IDK')).toBeUndefined()
    expect(r.env.followPicks.asked).toBe(before + 1)
  })
})

describe('4. sending a picked variant', () => {
  // a deliberate catalog pick, made the way the composer makes it: Tab lands on the catalog's IDK
  const pickVariant = (r) =>
    r.insertCompletionKeepOpen({ type: 'emote', name: 'IDK', url: OTHER, source: '7tv', remote: true })

  test('a variant of a name the channel has (and you do not own) is simply added', () => {
    const r = rig()
    pickVariant(r)
    r.autoAddInputEmotes('lol IDK')
    expect(r.calls.add.map((a) => a.slice(0, 3))).toEqual([['IDK', OTHER, '7tv']])
    expect(r.calls.swap).toEqual([])
  })

  test('a variant of a name you own with a DIFFERENT emote swaps, and does not plain-add', () => {
    const r = rig({ inventory: ['IDK'], personal: { IDK: { url: OWNED, source: 'heatsync', state: 'owned' } } })
    pickVariant(r)
    r.autoAddInputEmotes('IDK')
    expect(r.calls.swap).toEqual([['IDK', OTHER, '7tv', false]])
    expect(r.calls.add).toEqual([])
  })

  test('the very emote you own (even in another size or format) is left alone', () => {
    const r = rig({ inventory: ['IDK'], personal: { IDK: { url: seven('01OTHERIDK000000000000000', '1x.avif') } } })
    pickVariant(r)
    r.autoAddInputEmotes('IDK')
    expect(r.calls.swap).toEqual([])
    expect(r.calls.add).toEqual([])
  })

  test('tabbing onto the channel own IDK never replaces the one you own', () => {
    const r = rig({ inventory: ['IDK'], personal: { IDK: { url: OWNED } } })
    r.insertCompletionKeepOpen(channelMatch()) // a local pick: registered, but not a variant
    r.autoAddInputEmotes('IDK')
    expect(r.calls.swap).toEqual([])
    expect(r.calls.add).toEqual([])
  })

  test('an owned emote whose picture cannot be read is never swapped blind', () => {
    const r = rig({ inventory: ['IDK'] })
    pickVariant(r)
    r.autoAddInputEmotes('IDK')
    expect(r.calls.swap).toEqual([])
  })

  test('blocked names and global names are still skipped', () => {
    const blockedRig = rig({ blocked: ['IDK'] })
    pickVariant(blockedRig)
    blockedRig.autoAddInputEmotes('IDK')
    expect(blockedRig.calls.add).toEqual([])
    const globalRig = rig({ cache: new Map([['IDK', { state: 'global' }]]) })
    pickVariant(globalRig)
    globalRig.autoAddInputEmotes('IDK')
    expect(globalRig.calls.add).toEqual([])
  })

  test('a swap that fails leaves your old one standing', async () => {
    const r = rig({ inventory: ['IDK'], personal: { IDK: { url: OWNED } }, swapOk: false })
    pickVariant(r)
    const done = r.autoAddInputEmotes('IDK')
    expect(done).not.toBeNull()
    expect(await done).toEqual([])
    expect(r.env.viewerPersonalEmotes.get('IDK').url).toBe(OWNED) // still in inventory: not rolled back
  })

  test('a variant picked in an earlier message is not this message: the name typed by hand swaps nothing', () => {
    const r = rig({ inventory: ['IDK'], personal: { IDK: { url: OWNED, source: 'heatsync', state: 'owned' } } })
    pickVariant(r)
    r.env.endDraftPicks(r.env.lawBox()) // that message left the box, sent or cleared
    r.autoAddInputEmotes('IDK')
    expect(r.calls.swap).toEqual([])
    expect(r.calls.add).toEqual([])
  })

  test('a pick whose chip was deleted is over: the name typed back by hand adds nothing', () => {
    const r = rig()
    pickVariant(r)
    r.env.keepPicksIn('lol', r.env.lawBox()) // the chip is gone from the box
    r.env.keepPicksIn('lol IDK', r.env.lawBox()) // the name typed back by hand
    r.autoAddInputEmotes('lol IDK')
    expect(r.calls.add).toEqual([])
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
    const { swapEmoteInInventory } = new Function(...names, `${NOTICE}\n${SWAP}; return { swapEmoteInInventory }`)(
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
    const { addEmoteToInventory } = new Function(...names, `${NOTICE}\n${ADD}; return { addEmoteToInventory }`)(
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
    const r = addRig({ success: false, status: 409, error: 'name held by your upload' })
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

  test('the 409 for an upload comes back with its status, and the error text for the log', async () => {
    const r = await bgRig({ replace: true, ok: false, data: { error: 'name held by your upload' } })
    expect(r.res).toEqual({ success: false, status: 409, error: 'name held by your upload' })
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
    const { removeEmoteFromInventory } = new Function(
      ...names,
      `${NOTICE}\n${REMOVE}; return { removeEmoteFromInventory }`,
    )(...names.map((k) => env[k]))
    return { removeEmoteFromInventory, toasts, undone, env }
  }

  test('success: true, with its "removed" toast unless silent', async () => {
    const loud = removeRig({ response: { success: true } })
    expect(await loud.removeEmoteFromInventory('IDK', null)).toBe(true)
    expect(loud.toasts).toEqual([['cs_removed', 'success']])
    const quiet = removeRig({ response: { success: true } })
    expect(await quiet.removeEmoteFromInventory('IDK', null, { silent: true })).toBe(true)
    expect(quiet.toasts).toEqual([])
  })

  test('refusal: false, local state put back, the reason shown even when silent', async () => {
    const r = removeRig({ response: { success: false, status: 500, error: 'nope' } })
    expect(await r.removeEmoteFromInventory('IDK', null, { silent: true })).toBe(false)
    expect(r.undone).toEqual(['undo'])
    // the contract's line for the status, never the server's own words
    expect(r.toasts).toEqual([['mc_emote_remove_failed', 'error']])
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
    const { addEmoteToInventory } = new Function(...names, `${NOTICE}\n${ADD}; return { addEmoteToInventory }`)(
      ...names.map((k) => env[k]),
    )
    await addEmoteToInventory('IDK', url, '7tv', null, false, true)
    expect(sent[0].emoteHash).toBe(btoa(url))
    expect(sent[0].emoteHash.length).toBeGreaterThan(32)
  })
})

/**
 * Tab-cycle catalog pagination — fetchRemoteEmoteMatches (src/multichat/input.js).
 *
 * Regression anchor: cycling 20/20 wrapped back to 1/20 with the catalog
 * "searched". Page 1 of 7TV sorted by TOP_ALL_TIME is mostly emotes the user
 * already has loaded locally — every hit was a name already held, nothing was added,
 * remoteDone flipped true, and the cycle wrapped as if the catalog had nothing
 * (967 real hits for "kap"). Fix: page through providers, chasing all-duplicate
 * pages a bounded number of times; remoteDone flips only when every provider is
 * exhausted (short page / error) or the cycle hits its size cap.
 *
 * Carved out of the non-module content-script bundle and evaluated standalone
 * (same rationale as tab-cycle-wrap.test.js).
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lawOfferRig } from './helpers/law-offer-rig.js'

const INPUT_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
const start = INPUT_SRC.indexOf('let _acRemoteAbort = null')
const end = INPUT_SRC.indexOf('// Colon-triggered dropdown state')
if (start === -1 || end === -1 || end <= start) throw new Error('fetchRemoteEmoteMatches carve markers not found')

// Build the carved module over a real emote-law offer (law-offer-rig): `locals` are the room's
// loaded emotes, the cycle starts as Tab's own list for `search`. Providers are injected per-test;
// ffz/bttv return [] (immediately exhausted) unless overridden.
function build({ stv, ffz, bttv, locals = [], index = 0, search = 'kap' } = {}) {
  const rig = lawOfferRig({
    channelEmoteCaches: {
      'chan-a': new Map(locals.map((e) => [e.name, { url: e.url, source: '7tv', state: 'global' }])),
    },
  })
  const acState = {
    active: true,
    matches: rig.findEmoteMatches(search),
    index,
    search,
    remoteDone: false,
    remotePending: false,
    _remotePage: 0,
    _remoteExhausted: null,
    _catalog: null,
  }
  const fns = new Function(
    'hsModClassify',
    'recentRemoteCompletions',
    'REMOTE_COMPLETION_CAP',
    'findEmoteMatches',
    'lawCatalogEmote',
    'insertCompletionKeepOpen',
    'showCycleTooltip',
    'acState',
    'mcSearchFfzApi',
    'mcSearchBttvApi',
    'mcSearch7tvApi',
    `${INPUT_SRC.slice(start, end)}; return { fetchRemoteEmoteMatches }`,
  )(
    () => ({ kind: 'word' }),
    new Map(),
    300,
    rig.findEmoteMatches,
    rig.lawCatalogEmote,
    () => {},
    () => {},
    acState,
    ffz || (async () => []),
    bttv || (async () => []),
    stv || (async () => []),
  )
  return { acState, fetch: fns.fetchRemoteEmoteMatches }
}

const stvEmote = (name) => ({ name, url: `https://cdn.7tv.app/${name}/1x.avif`, id: name, provider: '7tv' })
const fullPage = (prefix, n = 60) => Array.from({ length: n }, (_, i) => stvEmote(`${prefix}${i}`))
// a loaded emote: a catalog hit of a name something loaded answers to is never offered again
const local = (name) => ({ name, url: `https://cdn.7tv.app/local-${name}/1x.avif` })

describe('catalog pagination — the 20/20 dead-end', () => {
  test('all-duplicate page 1 chases to page 2 and appends its new hits', async () => {
    // 60 locals that mirror 7TV page 1 (the popular-prefix case): every hit is a name already held.
    const locals = fullPage('kap')
    const pages = { 1: fullPage('kap'), 2: fullPage('kapNew') }
    const calls = []
    const { acState, fetch } = build({
      locals,
      index: 59,
      stv: async (_q, _signal, opts) => {
        calls.push(opts.page)
        return pages[opts.page] || []
      },
    })
    await fetch('kap')
    expect(calls).toEqual([1, 2])
    expect(acState.matches.length).toBe(120) // 60 locals + 60 page-2 hits
    expect(acState.remoteDone).toBe(false) // page 2 was full — more may exist
    expect(acState._remotePage).toBe(2)
    expect(acState.remotePending).toBe(false)
  })

  test('short page exhausts the provider and flips remoteDone', async () => {
    const { acState, fetch } = build({
      locals: [local('kappa')],
      stv: async () => [stvEmote('kapNew1'), stvEmote('kapNew2')], // 2 < 60 → drained
    })
    await fetch('kap')
    expect(acState.matches.length).toBe(3)
    expect(acState.remoteDone).toBe(true) // all three providers exhausted
  })

  test('chase gives up after its page budget but leaves the catalog resumable', async () => {
    let page = 0
    const { acState, fetch } = build({
      locals: fullPage('kap'),
      stv: async (_q, _s, opts) => {
        page = opts.page
        return fullPage('kap') // every page full duplicates
      },
    })
    await fetch('kap')
    expect(page).toBe(4) // AC_REMOTE_CHASE_PAGES
    expect(acState.remoteDone).toBe(false) // not exhausted — next trigger resumes
    expect(acState.remotePending).toBe(false) // never left stuck on
    await fetch('kap')
    expect(acState._remotePage).toBe(8) // resumed from page 5
  })

  test('provider error marks it exhausted instead of retrying forever', async () => {
    const { acState, fetch } = build({
      stv: async () => {
        throw new Error('7tv 503')
      },
    })
    await fetch('kap')
    expect(acState.remoteDone).toBe(true)
    expect(acState.remotePending).toBe(false)
  })

  test('cycle size cap flips remoteDone', async () => {
    const locals = Array.from({ length: 995 }, (_, i) => local(`kapLocal${i}`))
    const { acState, fetch } = build({
      locals,
      stv: async () => fullPage('kapMore'),
    })
    await fetch('kap')
    expect(acState.matches.length).toBe(1000) // capped
    expect(acState.remoteDone).toBe(true)
  })

  test('page-2 merge keeps the cycling user pinned on their current chip', async () => {
    // 60 locals mirroring page 1 (all dups, full page → chase continues);
    // page 2 brings new hits. The user is mid-cycle on locals[1].
    const locals = fullPage('kap')
    const pages = { 1: fullPage('kap'), 2: [stvEmote('kapNew')] }
    const { acState, fetch } = build({
      locals,
      index: 1,
      stv: async (_q, _s, opts) => pages[opts.page] || [],
    })
    const onChip = acState.matches[acState.index]
    await fetch('kap')
    expect(acState.matches.length).toBe(61)
    expect(acState.matches[acState.index]).toBe(onChip)
  })
})

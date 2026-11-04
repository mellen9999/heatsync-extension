/**
 * Tab-cycle catalog pagination — fetchRemoteEmoteMatches (src/multichat/input.js).
 *
 * Regression anchor: cycling 20/20 wrapped back to 1/20 with the catalog
 * "searched". Page 1 of 7TV sorted by TOP_ALL_TIME is mostly emotes the user
 * already has loaded locally — the dedupe dropped every hit, add.length was 0,
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

const INPUT_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
const start = INPUT_SRC.indexOf('let _acRemoteAbort = null')
const end = INPUT_SRC.indexOf('// Colon-triggered dropdown state')
if (start === -1 || end === -1 || end <= start) throw new Error('fetchRemoteEmoteMatches carve markers not found')

// Build the carved module with stubbed collaborators. Providers are injected
// per-test; ffz/bttv return [] (immediately exhausted) unless overridden.
function build({ stv, ffz, bttv, matches = [], index = 0, search = 'kap' } = {}) {
  const acState = {
    active: true,
    matches,
    index,
    search,
    remoteDone: false,
    remotePending: false,
    _remotePage: 0,
    _remoteExhausted: null,
    _aiSeq: 0,
  }
  const recentRemoteCompletions = new Map()
  // Remote-last, then fetch order — the shape compareAcMatches guarantees.
  const compareAcMatches = (a, b) => (a.remote ? 1 : 0) - (b.remote ? 1 : 0) || (a._ai || 0) - (b._ai || 0)
  const fns = new Function(
    'hsModClassify',
    'recentRemoteCompletions',
    'REMOTE_COMPLETION_CAP',
    'compareAcMatches',
    'insertCompletionKeepOpen',
    'showCycleTooltip',
    'acState',
    'mcSearchFfzApi',
    'mcSearchBttvApi',
    'mcSearch7tvApi',
    `${INPUT_SRC.slice(start, end)}; return { fetchRemoteEmoteMatches }`,
  )(
    () => ({ kind: 'word' }),
    recentRemoteCompletions,
    300,
    compareAcMatches,
    () => {},
    () => {},
    acState,
    ffz || (async () => []),
    bttv || (async () => []),
    stv || (async () => []),
  )
  return { acState, fetch: fns.fetchRemoteEmoteMatches }
}

const stvEmote = (name) => ({ name, url: `https://cdn.7tv.app/${name}/1x.avif`, provider: '7tv' })
const fullPage = (prefix, n = 60) => Array.from({ length: n }, (_, i) => stvEmote(`${prefix}${i}`))
// A local that IS the catalog's emote shares its picture (url): dedupe is by picture, not name,
// so a mirror must carry the hit's url. Defaults to a picture no catalog hit has.
const local = (name, url = 'u') => ({ name, url, source: '7tv', type: 'emote' })
const mirror = (e) => local(e.name, e.url)

describe('catalog pagination — the 20/20 dead-end', () => {
  test('all-duplicate page 1 chases to page 2 and appends its new hits', async () => {
    // 60 locals that exactly mirror 7TV page 1 (the popular-prefix case): same name, same picture.
    const locals = fullPage('kap').map(mirror)
    const pages = { 1: fullPage('kap'), 2: fullPage('kapNew') }
    const calls = []
    const { acState, fetch } = build({
      matches: [...locals],
      index: 59,
      stv: async (q, signal, opts) => {
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
      matches: [local('kappa')],
      stv: async () => [stvEmote('kapNew1'), stvEmote('kapNew2')], // 2 < 60 → drained
    })
    await fetch('kap')
    expect(acState.matches.length).toBe(3)
    expect(acState.remoteDone).toBe(true) // all three providers exhausted
  })

  test('chase gives up after its page budget but leaves the catalog resumable', async () => {
    let page = 0
    const { acState, fetch } = build({
      matches: fullPage('kap').map(mirror),
      stv: async (q, s, opts) => {
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
      matches: locals,
      stv: async () => fullPage('kapMore'),
    })
    await fetch('kap')
    expect(acState.matches.length).toBe(1000) // capped
    expect(acState.remoteDone).toBe(true)
  })

  test('page-2 merge keeps the cycling user pinned on their current chip', async () => {
    // 60 locals mirroring page 1 (all dups, full page → chase continues);
    // page 2 brings new hits. The user is mid-cycle on locals[1].
    const locals = fullPage('kap').map(mirror)
    const pages = { 1: fullPage('kap'), 2: [stvEmote('kapNew')] }
    const { acState, fetch } = build({
      matches: [...locals],
      index: 1,
      stv: async (q, s, opts) => pages[opts.page] || [],
    })
    const onChip = acState.matches[acState.index]
    await fetch('kap')
    expect(acState.matches.length).toBe(61)
    expect(acState.matches[acState.index]).toBe(onChip)
  })
})

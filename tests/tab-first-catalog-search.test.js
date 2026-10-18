/**
 * First-Tab catalog search + auto-add-on-send scope (src/multichat/input.js).
 *
 * Two linked behaviours:
 *
 * 1. The 7TV/BTTV/FFZ search starts on the FIRST Tab, even when local matches
 *    exist. It used to fire lazily — only once you cycled within LOOKAHEAD of
 *    the last local hit — so with a handful of channel emotes matching, Tab
 *    never touched the catalog and the search looked broken.
 *
 * 2. Because it now fires on every first Tab, the auto-add-on-send registry
 *    must NOT swallow the whole fetched page. It used to register every emote
 *    the fetch returned, which meant any word in a sent message that happened
 *    to appear anywhere in a catalog search this session got silently added to
 *    the viewer's inventory. Only two things may register: what the user
 *    cycles onto (insertCompletionKeepOpen → trackCompletionForAutoAdd) and
 *    the emote whose name they literally typed.
 *
 * Carved out of the non-module content-script bundle and evaluated standalone
 * (same rationale as tab-cycle-pagination.test.js).
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const INPUT_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
const start = INPUT_SRC.indexOf('let _acRemoteAbort = null')
const end = INPUT_SRC.indexOf('// Colon-triggered dropdown state')
if (start === -1 || end === -1 || end <= start) throw new Error('fetchRemoteEmoteMatches carve markers not found')

function build({ stv, matches = [], search = 'kap' } = {}) {
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
  const recentRemoteCompletions = new Map()
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
    async () => [],
    async () => [],
    stv || (async () => []),
  )
  return { acState, recentRemoteCompletions, fetch: fns.fetchRemoteEmoteMatches }
}

const stvEmote = (name) => ({ name, url: `https://cdn.7tv.app/${name}/1x.avif`, provider: '7tv' })
const local = (name) => ({ name, url: 'u', source: '7tv', type: 'emote' })

describe('first Tab starts the catalog search', () => {
  const firstTabBlock = (() => {
    const s = INPUT_SRC.indexOf('// First Tab - find matches.')
    expect(s).toBeGreaterThan(-1)
    return INPUT_SRC.slice(s, s + 2200)
  })()

  test('the fetch is not gated behind "no local matches"', () => {
    // The old shape was `if (matches.length > 0) { ...insert... } else { fetch }`
    // — the fetch lived in the else. It must now run on both paths.
    const insertAt = firstTabBlock.indexOf('insertCompletionKeepOpen(matches[0])')
    const fetchAt = firstTabBlock.indexOf('fetchRemoteEmoteMatches(word)')
    expect(insertAt).toBeGreaterThan(-1)
    expect(fetchAt).toBeGreaterThan(insertAt)
    // Nothing between the local insert and the fetch may open an else-branch.
    expect(firstTabBlock.slice(insertAt, fetchAt)).not.toContain('else')
  })

  test('the fetch runs before the tooltip so it can read "searching 7tv…"', () => {
    // fetchRemoteEmoteMatches flips remotePending synchronously; the tooltip
    // renders that flag. Fetch after tooltip = a first Tab that never shows it.
    const fetchAt = firstTabBlock.indexOf('fetchRemoteEmoteMatches(word)')
    const tipAt = firstTabBlock.indexOf('showCycleTooltip()', fetchAt)
    expect(tipAt).toBeGreaterThan(fetchAt)
  })

  test('catalog hits append AFTER the local matches, never reordering them', async () => {
    const locals = [local('kappa'), local('kapChannel')]
    const { acState, fetch } = build({
      matches: [...locals],
      stv: async () => [stvEmote('kapRemote1'), stvEmote('kapRemote2')],
    })
    await fetch('kap')
    expect(acState.matches.map((m) => m.name)).toEqual(['kappa', 'kapChannel', 'kapRemote1', 'kapRemote2'])
    expect(acState.matches.slice(0, 2).every((m) => !m.remote)).toBe(true)
  })
})

describe('auto-add-on-send registry scope', () => {
  test('a fetched page does not register emotes the user never landed on', async () => {
    const { recentRemoteCompletions, fetch } = build({
      matches: [local('kappa')],
      stv: async () => [stvEmote('kapOne'), stvEmote('kapTwo'), stvEmote('kapThree')],
    })
    await fetch('kap')
    expect([...recentRemoteCompletions.keys()]).toEqual([])
  })

  test('the exact typed name registers — it is the one the user can send untabbed', async () => {
    const { recentRemoteCompletions, fetch } = build({
      matches: [],
      stv: async () => [stvEmote('kapOther'), stvEmote('kap')],
    })
    await fetch('kap')
    expect([...recentRemoteCompletions.keys()]).toEqual(['kap'])
    expect(recentRemoteCompletions.get('kap').source).toBe('7tv')
  })

  test('exact-name match is case-insensitive, like emote names are in practice', async () => {
    const { recentRemoteCompletions, fetch } = build({
      matches: [],
      search: 'sadge',
      stv: async () => [stvEmote('Sadge')],
    })
    await fetch('sadge')
    expect([...recentRemoteCompletions.keys()]).toEqual(['Sadge'])
  })
})

describe('plain-text (wysiwyg off) still commits the emote at send', () => {
  test('insertCompletionKeepOpen registers BEFORE it branches on wysiwygEnabled', () => {
    // With wysiwyg off the composer holds the emote NAME as text, so nothing
    // downstream can sniff a chip — the registration is the only record that
    // the emote was completed. It has to happen on both branches, which means
    // above the `if (wysiwygEnabled) { ...; return }` early-out.
    const s = INPUT_SRC.indexOf('function insertCompletionKeepOpen(')
    expect(s).toBeGreaterThan(-1)
    const body = INPUT_SRC.slice(s, s + 1400)
    const trackAt = body.indexOf('trackCompletionForAutoAdd(match)')
    const branchAt = body.indexOf('if (wysiwygEnabled) {')
    expect(trackAt).toBeGreaterThan(-1)
    expect(branchAt).toBeGreaterThan(trackAt)
  })

  test('sendMessage commits the registry against the outgoing text unconditionally', () => {
    const s = INPUT_SRC.indexOf('async function sendMessage()')
    expect(s).toBeGreaterThan(-1)
    const body = INPUT_SRC.slice(s, s + 900)
    expect(body).toContain('autoAddInputEmotes(text)')
    // No wysiwyg gate between reading the text and committing it.
    const textAt = body.indexOf('getInputText()')
    const addAt = body.indexOf('autoAddInputEmotes(text)')
    expect(addAt).toBeGreaterThan(textAt)
    expect(body.slice(textAt, addAt)).not.toContain('wysiwyg')
  })
})

describe('same-name uploads stay separate once the name is typed in full', () => {
  const id = (n) => `01GPTQQTDR0001F90QP9X30T5${n}`.slice(0, 26)
  const up = (n) => ({ name: 'shrujj', url: `https://cdn.7tv.app/emote/${id(n)}/1x.avif`, provider: '7tv', id: id(n) })

  test('exact name keeps every upload, top one first', async () => {
    const { acState, fetch } = build({ search: 'shrujj', stv: async () => [up('A'), up('B'), up('C')] })
    await fetch('shrujj')
    expect(acState.matches.map((m) => m.id)).toEqual([id('A'), id('B'), id('C')])
  })

  test('only the top upload registers for auto-add-on-send', async () => {
    const { recentRemoteCompletions, fetch } = build({ search: 'shrujj', stv: async () => [up('A'), up('B')] })
    await fetch('shrujj')
    expect(recentRemoteCompletions.get('shrujj').url).toContain(id('A'))
  })

  test('an upload already in the cycle is not listed twice', async () => {
    const owned = { name: 'shrujj', url: up('B').url, source: '7tv', type: 'emote' }
    const { acState, fetch } = build({ search: 'shrujj', matches: [owned], stv: async () => [up('A'), up('B')] })
    await fetch('shrujj')
    expect(acState.matches.map((m) => m.url)).toEqual([owned.url, up('A').url])
  })

  test('a partial query still merges same-name uploads into one', async () => {
    const { acState, fetch } = build({ search: 'shru', stv: async () => [up('A'), up('B')] })
    await fetch('shru')
    expect(acState.matches.length).toBe(1)
  })
})

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
 * 2. Because it now fires on every first Tab, a fetched page must register
 *    NOTHING for auto-add-on-send. It used to register every emote the fetch
 *    returned, so any word in a sent message that appeared anywhere in a
 *    catalog search this session was silently added to the viewer's inventory.
 *    Only what the user lands on registers (insertCompletionKeepOpen →
 *    trackCompletionForAutoAdd): a Tab step, or the first catalog hit when
 *    nothing local matched (the exact typed name leads that list).
 *
 * 3. The catalog joins the cycle through the emote law's offer: one copy of a
 *    name (the most carried), none of a name something loaded answers to. The
 *    picker's search is where every upload of a name is shown.
 *
 * Carved out of the non-module content-script bundle and evaluated standalone
 * (same rationale as tab-cycle-pagination.test.js).
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lawOfferRig } from './helpers/law-offer-rig.js'

const INPUT_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
const start = INPUT_SRC.indexOf('let _acRemoteAbort = null')
const end = INPUT_SRC.indexOf('// Colon-triggered dropdown state')
if (start === -1 || end === -1 || end <= start) throw new Error('fetchRemoteEmoteMatches carve markers not found')

function build({ stv, locals = [], search = 'kap' } = {}) {
  const rig = lawOfferRig({
    channelEmoteCaches: {
      'chan-a': new Map(locals.map((e) => [e.name, { url: e.url, source: '7tv', state: 'global' }])),
    },
  })
  const acState = {
    active: true,
    matches: rig.findEmoteMatches(search),
    index: 0,
    search,
    remoteDone: false,
    remotePending: false,
    _remotePage: 0,
    _remoteExhausted: null,
    _catalog: null,
  }
  const recentRemoteCompletions = new Map()
  const inserted = []
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
    recentRemoteCompletions,
    300,
    rig.findEmoteMatches,
    rig.lawCatalogEmote,
    (m) => inserted.push(m),
    () => {},
    acState,
    async () => [],
    async () => [],
    stv || (async () => []),
  )
  return { acState, recentRemoteCompletions, inserted, fetch: fns.fetchRemoteEmoteMatches }
}

const stvEmote = (name, more = {}) => ({
  name,
  url: `https://cdn.7tv.app/${name}/1x.avif`,
  id: name,
  provider: '7tv',
  ...more,
})
const local = (name) => ({ name, url: `https://cdn.7tv.app/local-${name}/1x.avif` })

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

  test('catalog hits join AFTER the local matches, and the chip the user is on never moves', async () => {
    const { acState, fetch } = build({
      locals: [local('kappa'), local('kapChannel')],
      stv: async () => [stvEmote('kapRemote1'), stvEmote('kapRemote2')],
    })
    const onChip = acState.matches[0]
    await fetch('kap')
    expect(acState.matches.map((m) => m.name)).toEqual(['kappa', 'kapChannel', 'kapRemote1', 'kapRemote2'])
    expect(acState.matches[0]).toBe(onChip)
    expect(acState.matches.map((m) => !!m.remote)).toEqual([false, false, true, true])
  })
})

describe('auto-add-on-send registry scope', () => {
  test('a fetched page registers nothing and inserts nothing while a local hit holds the box', async () => {
    const { recentRemoteCompletions, inserted, fetch } = build({
      locals: [local('kappa')],
      stv: async () => [stvEmote('kapOne'), stvEmote('kapTwo'), stvEmote('kapThree')],
    })
    await fetch('kap')
    expect([...recentRemoteCompletions.keys()]).toEqual([])
    expect(inserted).toEqual([])
  })

  test('nothing local matched: the exact typed name is the hit that completes the word', async () => {
    const { inserted, fetch } = build({ stv: async () => [stvEmote('kapOther'), stvEmote('kap')] })
    await fetch('kap')
    expect(inserted.map((m) => m.name)).toEqual(['kap'])
    expect(inserted[0]).toMatchObject({ source: '7tv', remote: true, type: 'emote' })
  })

  test('the spelling typed leads its case twin', async () => {
    const { acState, fetch } = build({ search: 'sadge', stv: async () => [stvEmote('Sadge'), stvEmote('sadge')] })
    await fetch('sadge')
    expect(acState.matches.map((m) => m.name)).toEqual(['sadge', 'Sadge'])
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
    const s = INPUT_SRC.indexOf('async function sendMessage(retry)')
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

describe('same-name uploads in the cycle', () => {
  const id = (n) => `01GPTQQTDR0001F90QP9X30T5${n}`.slice(0, 26)
  const up = (n, uses = 0) => ({
    name: 'shrujj',
    url: `https://cdn.7tv.app/emote/${id(n)}/1x.avif`,
    provider: '7tv',
    id: id(n),
    uses,
  })

  test('one upload of a name joins the cycle: the most carried', async () => {
    const { acState, fetch } = build({ search: 'shrujj', stv: async () => [up('A', 3), up('B', 40), up('C', 7)] })
    await fetch('shrujj')
    expect(acState.matches.map((m) => m.id)).toEqual([id('B')])
  })

  test('a name something loaded answers to keeps the loaded one: the catalog adds no second copy', async () => {
    const { acState, fetch } = build({
      search: 'shrujj',
      locals: [local('shrujj')],
      stv: async () => [up('A'), up('B')],
    })
    await fetch('shrujj')
    expect(acState.matches.map((m) => m.url)).toEqual([local('shrujj').url])
  })
})

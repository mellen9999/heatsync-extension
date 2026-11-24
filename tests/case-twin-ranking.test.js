import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lawOfferRig } from './helpers/law-offer-rig.js'

// Rule 5 in search + Tab: KEKW and kekw are two candidates, the twin spelled like the typed word
// leads, dedupe is on the exact name, and only the prefix match stays case-insensitive.
const read = (...p) => readFileSync(join(import.meta.dir, '..', ...p), 'utf8')
const e = (id, source = '7tv') => ({ url: `https://cdn.test/${source}/${id}.webp`, source, id, state: 'global' })
const rank = (room, globals, typed) =>
  lawOfferRig({
    emoteCache: new Map(Object.entries(globals)),
    channelEmoteCaches: { 'chan-a': new Map(Object.entries(room)) },
  })
    .findEmoteMatches(typed)
    .map((m) => m.name)

describe("multichat Tab (the emote law's offer)", () => {
  test('the twin spelled like the typed word leads, whatever the tier', () => {
    expect(rank({ KEKW: e('a') }, { kekw: e('b', 'bttv') }, 'kekw')).toEqual(['kekw', 'KEKW'])
    expect(rank({ kekw: e('a') }, { KEKW: e('b', 'bttv') }, 'KEKW')).toEqual(['KEKW', 'kekw'])
  })
  test('neither spelled like it: both stay, channel leads', () => {
    expect(rank({ KEKW: e('a') }, { kekw: e('b', 'bttv') }, 'KeKw')).toEqual(['KEKW', 'kekw'])
  })
})

describe('multichat catalog keeps case twins apart', () => {
  test('a catalog kekw joins a loaded KEKW: they are two names', () => {
    const rig = lawOfferRig({ channelEmoteCaches: { 'chan-a': new Map([['KEKW', e('a')]]) } })
    const before = rig.findEmoteMatches('kekw')
    const cat = [rig.lawCatalogEmote({ name: 'kekw', url: 'https://cdn.test/7tv/c.webp', id: 'c', provider: '7tv' })]
    const after = rig.findEmoteMatches('kekw', { catalog: cat, prev: before, cursor: 0 })
    expect(after.map((m) => m.name)).toEqual(['KEKW', 'kekw'])
  })
})

describe('native bridges', () => {
  // the native boxes rank nothing: they ask the law's offer, where the twin spelled like the typed word
  // leads and dedupe is on the exact name (tests/native-offer-is-the-laws-list.test.js runs it)
  test('twitch and kick hooks ask the offer, no comparator of their own', () => {
    expect(read('src', 'content', 'autocomplete-hook.js')).toContain('lawRows(actualInput)')
    expect(read('src', 'content', 'kick-autocomplete-hook.js')).toContain('window.heatsyncNativeOffer')
  })
  test('twitch remote merge orders the typed spelling before a case twin', () => {
    expect(read('src', 'content', 'autocomplete-hook.js')).toContain("(a.name || '') === search ? 0")
  })
})

describe('picker search', () => {
  test('fuzzyScore puts the twin spelled as typed above its case twin', () => {
    const s = read('src', 'content', 'heatsync-button.js')
    const m = s.match(/function fuzzyScore\(query, name\) \{[\s\S]*?\n {4}\}\n/)
    const score = new Function('searchTyped', `${m[0]}; return fuzzyScore`)('kekw')
    expect(score('kekw', 'kekw')).toBeGreaterThan(score('kekw', 'KEKW'))
    expect(score('kekw', 'KEKW')).toBeGreaterThan(0)
  })
})

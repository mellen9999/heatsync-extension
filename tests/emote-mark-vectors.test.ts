/**
 * Runs shared/emote-mark.vectors.json against shared/emote-mark.ts: who sees a picker tile's picture
 * if you send it from this room, and whether the tile is offered at all. (The site's file and
 * module, byte for byte: tests/site-copy-parity.test.js holds the copies to the site's.)
 *
 * The same file is copied into the extension, the desktop app and the terminal client, and each runs
 * it against its own code. Every case runs under several shuffles of every list in its world: an
 * answer that depends on what loaded first fails here.
 *
 * A kind or a field this runner does not know is a failure, never a skip.
 */
import { describe, it, expect } from 'bun:test'
import { MARK_VERSION, tileSays, audience, samePicture } from '../shared/emote-mark'
import type { SendCtx } from '../shared/emote-law'
import { buildWorld, rng, type RawEmote, type RawWorld } from './helpers/emote-world'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// read as data, never imported
const file = JSON.parse(readFileSync(resolve(process.cwd(), 'shared/emote-mark.vectors.json'), 'utf8')) as {
  version: number
  emotes: Record<string, RawEmote>
  worlds: Record<string, RawWorld>
  cases: Record<string, any>[]
}

const SHUFFLES = [1, 7, 1337, 90210, 424242]
const CASE = ['kind', 'name', 'world', 'room', 'legs', 'who', 'tile', 'tier', 'fold', 'expect']
const EXPECT = ['offered', 'mark', 'kind', 'as', 'tier']
const KINDS = ['tile']

function known(obj: object, allowed: readonly string[], where: string) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new Error(`${where}: field "${k}" is not one this runner understands`)
}

function run(c: Record<string, any>, seed: number) {
  if (!KINDS.includes(c.kind)) throw new Error(`case kind "${c.kind}" is not one this runner understands`)
  known(c, CASE, c.name)
  known(c.expect, EXPECT, `${c.name} expect`)
  const raw = file.worlds[c.world]
  if (!raw) throw new Error(`unknown world: ${c.world}`)
  const w = buildWorld(file.emotes, raw, rng(seed))
  const own = w.person(c.who)
  if (!own) throw new Error('a tile is read for a person')
  const ctx: SendCtx = { room: w.room(c.room), legs: c.legs ? (c.legs as string[]).map(id => w.room(id)!) : undefined, own, globals: w.globals, picks: null, fold: !!c.fold }
  const got = tileSays(ctx, w.emote(c.tile), c.tier)
  return { offered: got.offered, mark: got.mark, kind: got.kind, as: got.as, tier: got.tier }
}

describe('emote-mark.vectors.json', () => {
  it('is a version this runner knows', () => expect(file.version).toBe(MARK_VERSION))
  it('has the cases the rules need (every rule in docs/emote-law.md has one)', () => expect(file.cases.length).toBeGreaterThanOrEqual(40))
  for (const c of file.cases) {
    it(c.name, () => {
      for (const seed of SHUFFLES) expect(run(c, seed), `${c.name} (shuffle ${seed})`).toEqual(c.expect)
    })
  }
})

describe('a tile is judged by what its word sends', () => {
  it('a pick in the box never changes the answer: the context\'s picks are not read', () => {
    const c = file.cases.find(x => x.name.startsWith('nl_kripp has 7tv SusgeBinoculars'))!
    const w = buildWorld(file.emotes, file.worlds[c.world], rng(1))
    const base: SendCtx = { room: w.room(c.room), own: w.person(c.who)!, globals: w.globals, picks: null }
    const tile = w.emote(c.tile)
    const picks = new Map([[tile.name, tile]])
    expect(tileSays({ ...base, picks }, tile, c.tier)).toEqual(tileSays(base, tile, c.tier))
    expect(tileSays({ ...base, picks }, tile, c.tier).offered).toBe(false)
  })
})

describe('the classifier a readout shares', () => {
  it('names the audience of a provider where it sits, with no room', () => {
    expect(audience('7tv', 'room')).toEqual({ kind: 'ext', mark: '7', as: '7tv' })
    expect(audience('twitch', 'own')).toEqual({ kind: 'everyone', mark: 'T', as: 'twitch' })
    expect(audience('inventory', 'global')).toEqual({ kind: 'heatsync', mark: 'H', as: 'hs' })
    expect(audience('7tv', 'catalog')).toEqual({ kind: 'heatsync', mark: 'H', as: 'hs' })
    expect(audience('7tv', 'own')).toEqual({ kind: 'heatsync', mark: 'H', as: 'hs' })
    expect(audience(undefined, 'room')).toEqual({ kind: 'ext', mark: '', as: 'ext' })
  })
  it('a provider named like an object property is an unknown provider, never a letter', () => {
    for (const p of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(audience(p, 'room')).toEqual({ kind: 'ext', mark: '', as: p })
  })
})

describe('one picture', () => {
  const e = (key: string, extra: object = {}) => ({ key, name: 'x', provider: 'hs' as const, id: key, ...extra })
  it('is the same key, the same pic, or the same upload hash', () => {
    expect(samePicture(e('a'), e('a'))).toBe(true)
    expect(samePicture(e('a'), e('b'))).toBe(false)
    expect(samePicture(e('a', { pic: 'p' }), e('b', { pic: 'p' }))).toBe(true)
    expect(samePicture(e('a', { pic: 'p' }), e('p'))).toBe(true)
    expect(samePicture(e('a', { hash: 'h' }), e('b', { hash: 'h' }))).toBe(true)
    expect(samePicture(e('a', { hash: '' }), e('b', { hash: '' }))).toBe(false)
  })
})

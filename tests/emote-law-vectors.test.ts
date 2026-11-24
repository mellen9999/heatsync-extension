/**
 * Runs shared/emote-law.vectors.json against shared/emote-law.ts.
 *
 * The same file is copied into the extension, the desktop app and the terminal
 * client, and each runs it against its own code. Every case runs under several
 * shuffles of every list in its world: an answer that depends on what loaded
 * first fails here.
 *
 * A kind or a field this runner does not know is a failure, never a skip — a
 * client that silently ignored a new rule would pass while breaking it.
 */
import { describe, it, expect } from 'bun:test'
import {
  LAW_VERSION, readLine, sendLine, sendWord, editLine, offer, extendOffer, browse,
  type Emote, type OfferCtx, type Ref, type SendCtx, type Token,
} from '../shared/emote-law'
import { buildWorld, cpToUnit, unitToCp, rng, type RawEmote, type RawWorld, type World } from './helpers/emote-world'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// read as data, never imported: an import turns the file into an object literal,
// where a key spelled __proto__ sets a prototype instead of naming an emote
const vectors: unknown = JSON.parse(readFileSync(resolve(process.cwd(), 'shared/emote-law.vectors.json'), 'utf8'))

type Case = Record<string, any>
const file = vectors as unknown as { version: number; emotes: Record<string, RawEmote>; worlds: Record<string, RawWorld>; cases: Case[] }

const SHUFFLES = [1, 7, 1337, 90210, 424242]

const KNOWN: Record<string, readonly string[]> = {
  read: ['kind', 'name', 'world', 'room', 'sender', 'text', 'tokens', 'refs', 'fold', 'expect'],
  session: ['kind', 'name', 'world', 'who', 'steps'],
  offer: ['kind', 'name', 'world', 'room', 'who', 'typed', 'catalog', 'emoji', 'usage', 'pop', 'blocked', 'suggestOwn', 'favorites', 'emojiFirst', 'limit', 'expect'],
  extend: ['kind', 'name', 'world', 'who', 'typed', 'cursor', 'prev', 'next', 'limit', 'expect'],
  browse: ['kind', 'name', 'world', 'room', 'who', 'recents', 'usage', 'blocked', 'suggestOwn', 'favorites', 'expect'],
}
const STEP = ['room', 'legs', 'picks', 'stored', 'fold', 'text', 'textRepeat', 'expect']
const STEP_EXPECT = ['from', 'refs', 'tokens', 'wire', 'wireIsText', 'chips']
const OFFER_PART = ['room', 'catalog', 'emoji', 'usage', 'pop', 'blocked', 'suggestOwn', 'favorites', 'emojiFirst']

function known(obj: object, allowed: readonly string[], where: string) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new Error(`${where}: field "${k}" is not one this runner understands`)
}

const refsIn = (w: World, raw: Record<string, string> | undefined): Record<string, Ref> | null => {
  if (!raw) return null
  return Object.fromEntries(Object.entries(raw).map(([k, v]): [string, Ref] => [k, v === 'gone' ? { gone: true } : w.emote(v)]))
}
const refsOut = (w: World, refs: Record<string, Ref>) =>
  Object.fromEntries(Object.entries(refs).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, 'gone' in v ? 'gone' : w.alias(v as Emote)]))
const sortKeys = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)))
const tokensIn = (w: World, text: string, raw: { cp: [number, number]; emote: string }[] | undefined): Token[] =>
  (raw || []).map(t => ({ start: cpToUnit(text, t.cp[0]), end: cpToUnit(text, t.cp[1]), emote: w.emote(t.emote) }))
const tokensOut = (w: World, text: string, tokens: readonly Token[]) =>
  tokens.map(t => ({ cp: [unitToCp(text, t.start), unitToCp(text, t.end)], emote: w.alias(t.emote) }))

function offerCtx(w: World, who: string | null, part: Case): OfferCtx {
  known(part, [...OFFER_PART, 'kind', 'name', 'world', 'who', 'typed', 'limit', 'expect', 'recents', 'cursor', 'prev', 'next'], 'offer')
  const person = w.person(who)
  if (!person) throw new Error('an offer needs a person')
  const usage: Record<string, number> = part.usage || {}
  const pop: Record<string, number> | undefined = part.pop
  const blocked = new Set<string>((part.blocked || []).map((a: string) => w.emote(a).key))
  return {
    room: w.room(part.room),
    own: person,
    globals: w.globals,
    catalog: part.catalog ? part.catalog.map((a: string) => w.emote(a)) : null,
    emoji: part.emoji ? part.emoji.map((a: string) => w.emote(a)) : null,
    usage: name => (Object.prototype.hasOwnProperty.call(usage, name) ? usage[name] : 0),
    pop: pop ? lower => (Object.prototype.hasOwnProperty.call(pop, lower) ? pop[lower] : undefined) : null,
    blocked: key => blocked.has(key),
    suggestOwn: part.suggestOwn,
    favorites: part.favorites ? part.favorites.map((a: string) => w.emote(a)) : null,
    emojiFirst: part.emojiFirst,
  }
}

const offered = (w: World, list: ReturnType<typeof offer>) =>
  list.map(c => (c.shadowed ? { emote: w.alias(c.emote), tier: c.tier, match: c.match, shadowed: true } : { emote: w.alias(c.emote), tier: c.tier, match: c.match }))

function run(c: Case, seed: number): unknown {
  const raw = file.worlds[c.world]
  if (!raw) throw new Error(`unknown world: ${c.world}`)
  const rand = rng(seed)
  const w = buildWorld(file.emotes, raw, rand)
  if (!KNOWN[c.kind]) throw new Error(`case kind "${c.kind}" is not one this runner understands`)
  known(c, KNOWN[c.kind], c.name)

  if (c.kind === 'read') {
    const drawn = readLine(c.text, tokensIn(w, c.text, c.tokens), { room: w.room(c.room), refs: refsIn(w, c.refs), sender: w.person(c.sender), globals: w.globals, fold: !!c.fold })
    return drawn.map(d => ({ word: d.word, emote: w.alias(d.emote), from: d.from, overlay: d.overlay }))
  }

  if (c.kind === 'session') {
    const own = w.person(c.who)
    if (!own) throw new Error('a session needs a person')
    return (c.steps as Case[]).map((s, i) => {
      known(s, STEP, `${c.name} step ${i}`)
      known(s.expect, STEP_EXPECT, `${c.name} step ${i} expect`)
      const text: string = s.textRepeat ? Array.from({ length: s.textRepeat[1] }, () => s.textRepeat[0]).join(' ') : s.text
      const picks = s.picks ? new Map(Object.entries(s.picks as Record<string, string>).map(([k, v]) => [k, w.emote(v)])) : null
      const ctx: SendCtx = { room: w.room(s.room), legs: s.legs ? (s.legs as string[]).map(id => w.room(id)!) : undefined, own, globals: w.globals, picks, fold: !!s.fold }
      const shipped = s.stored ? editLine(refsIn(w, s.stored), text, ctx) : sendLine(text, ctx)
      const got: Case = {}
      if (s.expect.from) got.from = Object.fromEntries(Object.keys(s.expect.from).map(word => [word, sendWord(word, ctx)?.from ?? null]))
      got.refs = refsOut(w, shipped.refs)
      got.tokens = tokensOut(w, text, shipped.tokens)
      if (s.expect.wire) got.wire = sortKeys(shipped.wire)
      if (s.expect.wireIsText) got.wireIsText = (s.expect.wireIsText as string[]).filter(p => (shipped.wire as Record<string, string>)[p] === text)
      got.chips = shipped.chips.map(d => ({ word: d.word, emote: w.alias(d.emote), overlay: d.overlay }))
      return got
    })
  }

  if (c.kind === 'offer') return offered(w, offer(c.typed, offerCtx(w, c.who, c), c.limit))

  if (c.kind === 'extend') {
    known(c.prev, OFFER_PART, `${c.name} prev`)
    known(c.next, OFFER_PART, `${c.name} next`)
    const prev = offer(c.typed, offerCtx(w, c.who, c.prev))
    return offered(w, extendOffer(prev, c.cursor, c.typed, offerCtx(w, c.who, c.next), c.limit))
  }

  // browse
  const b = browse(offerCtx(w, c.who, c), (c.recents as string[]).map(a => w.emote(a).key))
  const names = (l: typeof b.recent) => l.map(x => w.alias(x.emote))
  // tiers travel with a favorite: one nothing here holds is a catalog copy (a pick that ships a ref)
  const favorite = b.favorite.map(x => ({ emote: w.alias(x.emote), tier: x.tier }))
  return { favorite, recent: names(b.recent), room: names(b.room), own: names(b.own), global: names(b.global) }
}

function expected(c: Case): unknown {
  if (c.kind !== 'session') return c.expect
  return (c.steps as Case[]).map(s => {
    const e: Case = { ...s.expect }
    if (e.refs) e.refs = sortKeys(e.refs)
    if (e.wire) e.wire = sortKeys(e.wire)
    const out: Case = {}
    for (const k of ['from', 'refs', 'tokens', 'wire', 'wireIsText', 'chips']) if (e[k] !== undefined) out[k] = e[k]
    return out
  })
}

describe('emote law — the vector file', () => {
  it('is the version this code implements', () => {
    expect(file.version).toBe(LAW_VERSION)
  })

  it('names every case once', () => {
    const names = file.cases.map(c => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('covers every job', () => {
    const kinds = new Set(file.cases.map(c => c.kind))
    expect([...kinds].sort()).toEqual(['browse', 'extend', 'offer', 'read', 'session'])
  })

  for (const c of file.cases) {
    it(`${c.kind}: ${c.name}`, () => {
      const want = expected(c)
      for (const seed of SHUFFLES) expect(run(c, seed), `shuffle ${seed}`).toEqual(want)
    })
  }

  it('refuses a case it does not understand instead of skipping it', () => {
    expect(() => run({ kind: 'rank', name: 'x', world: 'main' }, 1)).toThrow(/not one this runner understands/)
    expect(() => run({ kind: 'read', name: 'x', world: 'main', room: null, sender: null, text: 'a', viewer: 'me', expect: [] }, 1)).toThrow(/field "viewer"/)
  })
})

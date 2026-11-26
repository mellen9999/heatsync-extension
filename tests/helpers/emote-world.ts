/**
 * Builds emote-law inputs from the vector file's plain data, and generates
 * seeded random worlds for the property tests. Everything random here comes
 * from one seed, so a failing world is reproduced by its number.
 */
import {
  buildGlobals, buildOwn, buildRoom, emoteKey,
  type Emote, type NameIndex, type OwnSets, type Platform, type Provider, type Room,
} from '../../shared/emote-law'

export interface RawEmote { p: string; id: string; name: string; zw?: boolean; pop?: number; pic?: string; hash?: string }
export interface RawRoom { owner?: string[]; third?: string[]; native?: string[]; loaded?: boolean }
export interface RawPerson { inventory?: string[]; personal?: string[]; native?: Partial<Record<Platform, string[]>> }
export interface RawWorld { rooms: Record<string, RawRoom>; globals: string[]; people: Record<string, RawPerson> }

export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffled<T>(list: readonly T[] | undefined, rand: () => number): T[] {
  const out = (list || []).slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const t = out[i]; out[i] = out[j]; out[j] = t
  }
  return out
}

export const toEmote = (r: RawEmote): Emote => {
  const e: Emote = { key: emoteKey(r.p, r.id), name: r.name, provider: r.p as Provider, id: r.id }
  if (r.zw) e.zeroWidth = true
  if (r.pop !== undefined) e.pop = r.pop
  if (r.pic !== undefined) e.pic = r.pic
  if (r.hash !== undefined) e.hash = r.hash
  return e
}

export interface World {
  emote: (alias: string) => Emote
  alias: (e: Emote | null | undefined) => string | null
  room: (id: string | null | undefined) => Room | null
  person: (who: string | null | undefined) => OwnSets | null
  globals: NameIndex
}

/** `rand` shuffles every list before it is indexed: the law must not care. */
export function buildWorld(emotes: Record<string, RawEmote>, raw: RawWorld, rand: () => number): World {
  const byAlias = new Map<string, Emote>()
  const byKey = new Map<string, string>()
  for (const [alias, r] of Object.entries(emotes)) {
    const e = toEmote(r)
    if (byKey.has(e.key)) throw new Error(`two aliases for one picture: ${byKey.get(e.key)} and ${alias}`)
    byAlias.set(alias, e)
    byKey.set(e.key, alias)
  }
  const emote = (alias: string) => {
    const e = byAlias.get(alias)
    if (!e) throw new Error(`unknown emote alias: ${alias}`)
    return e
  }
  const list = (aliases: string[] | undefined) => shuffled(aliases, rand).map(emote)
  const rooms = new Map<string, Room>()
  for (const id of shuffled(Object.keys(raw.rooms), rand)) {
    const r = raw.rooms[id]
    const cut = id.indexOf(':')
    rooms.set(id, buildRoom(id.slice(0, cut) as Platform, id.slice(cut + 1), { owner: list(r.owner), third: list(r.third), native: list(r.native) }, r.loaded !== false))
  }
  const people = new Map<string, OwnSets>()
  for (const who of shuffled(Object.keys(raw.people), rand)) {
    const p = raw.people[who]
    const native: Partial<Record<Platform, Emote[]>> = {}
    for (const plat of shuffled(Object.keys(p.native || {}) as Platform[], rand)) native[plat] = list(p.native?.[plat])
    people.set(who, buildOwn({ inventory: list(p.inventory), personal: list(p.personal), native }))
  }
  return {
    emote,
    alias: e => (e ? byKey.get(e.key) ?? `?${e.key}` : null),
    room: (id) => {
      if (id == null) return null
      const r = rooms.get(id)
      if (!r) throw new Error(`unknown room: ${id}`)
      return r
    },
    person: (who) => {
      if (who == null) return null
      const p = people.get(who)
      if (!p) throw new Error(`unknown person: ${who}`)
      return p
    },
    globals: buildGlobals(list(raw.globals)),
  }
}

/** code point offset -> utf-16 offset */
export function cpToUnit(text: string, cp: number): number {
  let unit = 0
  let seen = 0
  for (const ch of text) {
    if (seen === cp) return unit
    unit += ch.length
    seen++
  }
  return unit
}

export function unitToCp(text: string, unit: number): number {
  return Array.from(text.slice(0, unit)).length
}

// ── random worlds ────────────────────────────────────────────────────────────

/** few names, many owners: every tier collides with every other */
export const NAMES = ['KEKW', 'kekw', 'Kekw', 'KEKW0', 'Pog', 'Pog0', 'PogU', 'catJAM', 'SadCat', 'Kappa', 'LUL', 'lul', 'xD', 'RainTime']
const THIRD: Provider[] = ['ffz', '7tv', 'bttv']
const GLOBAL: Provider[] = ['7tv', 'bttv', 'ffz', 'twitch', 'hs']
export const ROOM_IDS = ['twitch:a', 'twitch:b', 'kick:x', 'youtube:y']

export interface Generated { emotes: Record<string, RawEmote>; world: RawWorld }

export function generate(seed: number): Generated {
  const rand = rng(seed)
  const emotes: Record<string, RawEmote> = {}
  let n = 0
  const pick = <T>(l: readonly T[]) => l[Math.floor(rand() * l.length)]
  const make = (p: string, name = pick(NAMES)) => {
    const alias = `e${n}`
    emotes[alias] = { p, id: `i${n}`, name }
    if (rand() < 0.1) emotes[alias].zw = true
    n++
    return alias
  }
  const some = (max: number, p: () => string) => Array.from({ length: Math.floor(rand() * (max + 1)) }, () => make(p()))
  const world: RawWorld = { rooms: {}, globals: some(8, () => pick(GLOBAL)), people: {} }
  for (const id of ROOM_IDS) {
    const platform = id.slice(0, id.indexOf(':'))
    world.rooms[id] = { owner: some(3, () => 'hs'), third: some(8, () => pick(THIRD)), native: platform === 'kick' ? some(3, () => 'kick') : [] }
  }
  for (const who of ['me', 'other']) {
    world.people[who] = {
      inventory: some(6, () => pick(['hs', '7tv', 'bttv', 'ffz'])),
      personal: some(3, () => '7tv'),
      native: { twitch: some(3, () => 'twitch'), kick: some(2, () => 'kick') },
    }
  }
  return { emotes, world }
}

export function randomText(rand: () => number, words = 6): string {
  const filler = ['hi', 'the', 'gg', 'nope0', 'KEK']
  const out: string[] = []
  const count = 1 + Math.floor(rand() * words)
  for (let i = 0; i < count; i++) {
    const r = rand()
    const base = r < 0.75 ? NAMES[Math.floor(rand() * NAMES.length)] : filler[Math.floor(rand() * filler.length)]
    out.push(rand() < 0.12 ? `${base}0` : base)
  }
  return out.join(' ')
}

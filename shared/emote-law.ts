/**
 * The emote law — the one answer to "which emote is this word".
 *
 * docs/emote-law.md is the prose. shared/emote-law.vectors.json is the contract:
 * the site, the extension, the desktop app and the terminal client all run it
 * against their own implementation, so a client that answers differently fails
 * its own tests.
 *
 * Three jobs:
 *   READ   what a word draws on a line            readWord / readLine
 *   SEND   what a hand-typed word ships            sendWord / sendLine / editLine
 *   OFFER  what Tab, `:` and picker search list    offer / extendOffer / browse
 *
 * An emote is its PICTURE (`provider:id`). A name is only a label, so nothing
 * here is ever keyed by name alone except the lookups the law itself defines.
 *
 * Pure: no DOM, no clock, no I/O, no module state. The same inputs give the
 * same answer in any load order — every builder sorts before it indexes, and
 * every tie ends in code point order, never in insertion or locale order.
 *
 * A viewer's own emotes are not an input to reading someone else's line. That
 * is how "your emotes never draw someone else's word" is enforced: there is no
 * parameter to pass them in.
 */
import { matchBucket, BUCKET_EXACT, BUCKET_PREFIX, BUCKET_NONE } from './emote-rank'

export const LAW_VERSION = 1

export type Platform = 'twitch' | 'kick' | 'youtube'
export type Provider = 'hs' | '7tv' | 'bttv' | 'ffz' | 'twitch' | 'kick' | 'youtube' | 'emoji'
/** `${provider}:${id}` — the picture. */
export type EmoteKey = string

export interface Emote {
  key: EmoteKey
  name: string
  provider: Provider
  id: string
  url?: string
  zeroWidth?: boolean
  animated?: boolean
  width?: number
  height?: number
  /** channels carrying it (catalog hits only) */
  pop?: number
}

/** exact name -> the one emote that name means in this set */
export type NameIndex = ReadonlyMap<string, Emote>

/** A line's room: the row's OWN platform + channel, never the open tab. */
export interface Room {
  platform: Platform
  channel: string
  /** false while the set is still loading: the row draws without it and repaints, it never borrows another room */
  loaded: boolean
  /** owner's heatsync set, then ffz, 7tv, bttv, then the platform's channel emotes — already resolved to one emote per name */
  names: NameIndex
}

export interface OwnSets {
  /** heatsync inventory */
  inventory: NameIndex
  /** 7tv personal set */
  personal: NameIndex
  /** platform emotes this person can use natively there (twitch globals + held subs, kick emotes) */
  native: Partial<Record<Platform, NameIndex>>
}

/** a withdrawn pick (take-down): the word is text, never a look-alike */
export type Ref = Emote | { gone: true }

export const emoteKey = (provider: string, id: string): EmoteKey => `${provider}:${id}`

// ── order ────────────────────────────────────────────────────────────────────

/** Code point order. Not `<` (UTF-16 units) and never localeCompare: a rust port must agree byte for byte. */
export function cmpCp(a: string, b: string): number {
  if (a === b) return 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i), y = b.charCodeAt(i)
    if (x === y) continue
    const xs = x >= 0xd800 && x <= 0xdfff, ys = y >= 0xd800 && y <= 0xdfff
    if (xs !== ys) return xs ? 1 : -1
    return x < y ? -1 : 1
  }
  return a.length < b.length ? -1 : 1
}

export const CHANNEL_ORDER: readonly string[] = ['ffz', '7tv', 'bttv']
export const GLOBAL_ORDER: readonly string[] = ['7tv', 'bttv', 'ffz', 'twitch', 'hs']
const rankIn = (order: readonly string[], p: string) => { const i = order.indexOf(p); return i === -1 ? order.length : i }

const EMPTY: NameIndex = new Map()

/** One emote per exact name. Two of one name in the same list: the lower id wins, whatever order they arrived in. */
export function buildIndex(list: readonly Emote[] | null | undefined, order?: readonly string[]): NameIndex {
  if (!list?.length) return EMPTY
  const sorted = list.filter(e => e?.name).slice().sort((a, b) =>
    (order ? rankIn(order, a.provider) - rankIn(order, b.provider) || (rankIn(order, a.provider) === order.length ? cmpCp(a.provider, b.provider) : 0) : 0)
    || cmpCp(a.name, b.name) || cmpCp(a.id, b.id))
  const out = new Map<string, Emote>()
  for (const e of sorted) if (!out.has(e.name)) out.set(e.name, e)
  return out
}

export function buildRoom(platform: Platform, channel: string, lists: { owner?: readonly Emote[]; third?: readonly Emote[]; native?: readonly Emote[] }, loaded = true): Room {
  const names = new Map<string, Emote>()
  for (const idx of [buildIndex(lists.owner), buildIndex(lists.third, CHANNEL_ORDER), buildIndex(lists.native)]) {
    for (const [n, e] of idx) if (!names.has(n)) names.set(n, e)
  }
  return { platform, channel, loaded, names }
}

export const buildGlobals = (list: readonly Emote[] | null | undefined): NameIndex => buildIndex(list, GLOBAL_ORDER)

export function buildOwn(lists: { inventory?: readonly Emote[]; personal?: readonly Emote[]; native?: Partial<Record<Platform, readonly Emote[]>> } = {}): OwnSets {
  const native: Partial<Record<Platform, NameIndex>> = {}
  for (const p of ['twitch', 'kick', 'youtube'] as const) if (lists.native?.[p]?.length) native[p] = buildIndex(lists.native[p])
  return { inventory: buildIndex(lists.inventory), personal: buildIndex(lists.personal), native }
}

// ── lookup ───────────────────────────────────────────────────────────────────

const folded = new WeakMap<object, Map<string, Emote>>()
/** lowercase name -> the twin whose spelling sorts first. Only consulted after an exact-case miss in every tier. */
function foldIndex(idx: NameIndex): Map<string, Emote> {
  let f = folded.get(idx)
  if (f) return f
  f = new Map()
  for (const name of [...idx.keys()].sort(cmpCp)) {
    const l = name.toLowerCase()
    if (!f.has(l)) f.set(l, idx.get(name) as Emote)
  }
  folded.set(idx, f)
  return f
}

const pick = (idx: NameIndex | null | undefined, word: string, fold: boolean): Emote | undefined =>
  !idx || idx.size === 0 ? undefined : fold ? foldIndex(idx).get(word.toLowerCase()) : idx.get(word)

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
/** file under a name, whatever the name is: a plain `o[k] = v` loses an emote called `__proto__` */
const put = <T>(o: Record<string, T>, k: string, v: T) => { Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }) }
/** a ref is an object; anything else in a stored map is junk and reads as no ref */
const isRef = (r: unknown): r is Ref => !!r && typeof r === 'object' && !Array.isArray(r)

function refFor(refs: Readonly<Record<string, Ref>> | null | undefined, word: string, fold: boolean): Ref | undefined {
  if (!refs) return undefined
  if (!fold) return own(refs, word) && isRef(refs[word]) ? refs[word] : undefined
  const l = word.toLowerCase()
  let best: string | undefined
  for (const k of Object.keys(refs)) if (k.toLowerCase() === l && isRef(refs[k]) && (best === undefined || cmpCp(k, best) < 0)) best = k
  return best === undefined ? undefined : refs[best]
}

/** exact literal, then the overlay reading (strip one trailing 0), then — only with the case setting on — both again folded */
function passes<T>(word: string, fold: boolean | undefined, chain: (w: string, folded: boolean, stripped: boolean) => T | null): { hit: T; stripped: boolean; base: string } | null {
  const base = word.length > 1 && word.endsWith('0') ? word.slice(0, -1) : null
  for (const f of fold ? [false, true] : [false]) {
    const a = chain(word, f, false)
    if (a) return { hit: a, stripped: false, base: word }
    if (base) {
      const b = chain(base, f, true)
      if (b) return { hit: b, stripped: true, base }
    }
  }
  return null
}

// ── READ ─────────────────────────────────────────────────────────────────────

export type From = 'token' | 'pick' | 'personal' | 'room' | 'sender' | 'global'

export interface ReadCtx {
  /** the row's own room; null on roomless surfaces (DMs, posts, replies) */
  room: Room | null
  /** what the sender's app shipped with the line */
  refs?: Readonly<Record<string, Ref>> | null
  /** the SENDER's sets (the viewer's own only when the viewer is the sender) */
  sender?: OwnSets | null
  globals: NameIndex
  /** the viewer's case-insensitive setting */
  fold?: boolean
}

export interface WordHit { emote: Emote | null; from: From; overlay: boolean }

/** What one word draws. `emote: null` = a withdrawn pick: draw the word as text. null = not an emote. */
export function readWord(word: string, ctx: ReadCtx): WordHit | null {
  const r = passes<{ emote: Emote | null; from: From }>(word, ctx.fold, (w, f) => {
    const ref = refFor(ctx.refs, w, f)
    if (ref) return 'gone' in ref ? { emote: null, from: 'pick' } : { emote: ref, from: 'pick' }
    let e = pick(ctx.sender?.personal, w, f)
    if (e) return { emote: e, from: 'personal' }
    e = pick(ctx.room?.names, w, f)
    if (e) return { emote: e, from: 'room' }
    e = pick(ctx.sender?.inventory, w, f)
    if (e) return { emote: e, from: 'sender' }
    e = pick(ctx.globals, w, f)
    return e ? { emote: e, from: 'global' } : null
  })
  if (!r) return null
  const { emote, from } = r.hit
  return { emote, from, overlay: !!emote && (r.stripped || !!emote.zeroWidth) }
}

/** a platform-marked span (twitch tag range, kick token, youtube emoji). UTF-16 offsets, end exclusive. */
export interface Token { start: number; end: number; emote: Emote }
export interface Drawn { start: number; end: number; word: string; emote: Emote | null; from: From; overlay: boolean }

const WORD = /\S+/g
const blank = (s: string) => s.trim() === ''

/**
 * Every emote on a line, in order. A platform token owns its span — nothing with
 * the same name replaces it and its text is never read again. An overlay only
 * stacks on an emote directly before it; alone it draws inline.
 */
export function readLine(text: string, tokens: readonly Token[] | null | undefined, ctx: ReadCtx): Drawn[] {
  const out: Drawn[] = []
  const spans = (tokens || []).filter(t => t && t.emote && t.start >= 0 && t.end > t.start && t.end <= text.length)
    .slice().sort((a, b) => a.start - b.start || a.end - b.end)
  let at = 0
  let prevEnd = -1
  let prevEmote = false
  const push = (d: Drawn) => {
    if (d.overlay && !(prevEmote && blank(text.slice(prevEnd, d.start)))) d.overlay = false
    out.push(d)
    prevEnd = d.end
    prevEmote = !!d.emote
  }
  const words = (from: number, to: number) => {
    WORD.lastIndex = 0
    const seg = text.slice(from, to)
    for (let m = WORD.exec(seg); m; m = WORD.exec(seg)) {
      const hit = readWord(m[0], ctx)
      const start = from + m.index
      if (hit) push({ start, end: start + m[0].length, word: m[0], ...hit })
      else { prevEmote = false; prevEnd = start + m[0].length }
    }
  }
  for (const t of spans) {
    if (t.start < at) continue
    words(at, t.start)
    push({ start: t.start, end: t.end, word: text.slice(t.start, t.end), emote: t.emote, from: 'token', overlay: false })
    at = t.end
  }
  words(at, text.length)
  return out
}

// ── SEND ─────────────────────────────────────────────────────────────────────

export type SendFrom = 'pick' | 'native' | 'personal' | 'room' | 'own' | 'global'

export interface SendCtx {
  /** the room the line goes to; for a fan-out, the first leg (twitch, else kick, else youtube). null = roomless. */
  room: Room | null
  /** every leg of a fan-out, for the per-platform wire text */
  legs?: readonly Room[]
  own: OwnSets
  globals: NameIndex
  /** picks made in THIS draft only (Tab, picker, chip), one per name. Gone once sent. */
  picks?: ReadonlyMap<string, Emote> | null
  fold?: boolean
}

export interface SendHit { emote: Emote; from: SendFrom; overlay: boolean; key: string }

const KICK_MAX = 500

/** the platform will mark this one itself: it needs no ref, and the echo predicts the token */
const platformMarks = (hit: { emote: Emote; from: SendFrom }, room: Room | null) =>
  hit.from === 'native' || (!!room && room.platform === 'kick' && hit.emote.provider === 'kick' && hit.from === 'room')

/**
 * What a hand-typed word ships: the platform's own emote where the platform
 * marks it by itself (twitch, youtube — a pick of a same-name copy could never
 * show there), this draft's pick, kick's own emote, your 7tv personal emote,
 * the room's, yours, a global.
 * `key` is the name the ref is filed under: the word as typed, minus an overlay 0.
 */
export function sendWord(word: string, ctx: SendCtx): SendHit | null {
  return resolve(word, ctx, true)
}

function resolve(word: string, ctx: SendCtx, native: boolean): SendHit | null {
  const room = ctx.room
  const auto = !!room && room.platform !== 'kick'
  const r = passes<{ emote: Emote; from: SendFrom }>(word, ctx.fold, (w, f, stripped) => {
    // a platform marks its emote on the exact word only (a plain get, so never folded) and never on `name0`
    const nat = native && room && !stripped ? ctx.own.native[room.platform]?.get(w) : undefined
    if (nat && auto) return { emote: nat, from: 'native' }
    let e = pick(ctx.picks, w, f)
    if (e) return { emote: e, from: 'pick' }
    if (nat) return { emote: nat, from: 'native' }
    e = pick(ctx.own.personal, w, f)
    if (e) return { emote: e, from: 'personal' }
    e = pick(room?.names, w, f)
    if (e) return { emote: e, from: 'room' }
    e = pick(ctx.own.inventory, w, f)
    if (e) return { emote: e, from: 'own' }
    e = pick(ctx.globals, w, f)
    return e ? { emote: e, from: 'global' } : null
  })
  if (!r) return null
  return { ...r.hit, overlay: r.stripped || !!r.hit.emote.zeroWidth, key: r.base }
}

export interface Shipped {
  /** what travels with the line */
  refs: Record<string, Ref>
  /** spans the platform will mark itself — the echo draws them before the platform's answer arrives */
  tokens: Token[]
  /** the text each platform receives */
  wire: Partial<Record<Platform, string>>
  /** what the composer shows; equal to what your own row draws */
  chips: Drawn[]
}

/**
 * kick only draws its emotes from `[emote:id:name]`; a line that would not fit
 * with them goes out as plain words. On a leg that is not the line's own room,
 * a word the line already answered stays a bare word — its ref carries the one
 * meaning — and only a word that meant nothing there can be kick's.
 */
function kickWire(text: string, leg: Room, ctx: SendCtx): string {
  const legCtx: SendCtx = { ...ctx, room: leg }
  const side = leg !== ctx.room
  WORD.lastIndex = 0
  const out = text.replace(WORD, (w) => {
    if (side && resolve(w, ctx, true)) return w
    const hit = resolve(w, legCtx, true)
    return hit && platformMarks(hit, leg) && !hit.overlay ? `[emote:${hit.emote.id}:${hit.emote.name}]` : w
  })
  return out.length > KICK_MAX ? text : out
}

function rowCtx(ctx: SendCtx, refs: Record<string, Ref>): ReadCtx {
  return { room: ctx.room, refs, sender: ctx.own, globals: ctx.globals, fold: ctx.fold }
}

/** One draft in, everything the send needs out. The chip, the shipped ref and your own row are this one answer. */
export function sendLine(text: string, ctx: SendCtx): Shipped {
  const wire: Partial<Record<Platform, string>> = {}
  for (const leg of ctx.legs?.length ? ctx.legs : ctx.room ? [ctx.room] : []) {
    if (wire[leg.platform] === undefined) wire[leg.platform] = leg.platform === 'kick' ? kickWire(text, leg, ctx) : text
  }
  // kick got plain words (nothing of its own in the line, or it would not fit): nothing is marked there, so nothing is kick's to answer
  const marked = !(ctx.room?.platform === 'kick' && wire.kick === text)
  const refs: Record<string, Ref> = {}
  const tokens: Token[] = []
  WORD.lastIndex = 0
  for (let m = WORD.exec(text); m; m = WORD.exec(text)) {
    const hit = resolve(m[0], ctx, marked)
    if (!hit) continue
    if (marked && platformMarks(hit, ctx.room) && !hit.overlay) tokens.push({ start: m.index, end: m.index + m[0].length, emote: hit.emote })
    else if (!own(refs, hit.key)) put(refs, hit.key, hit.emote)
  }
  return { refs, tokens, wire, chips: readLine(text, tokens, rowCtx(ctx, refs)) }
}

/**
 * An edit keeps the picture of every word still in the text — stored refs
 * (take-downs included) win over a fresh resolve. Only words new to the text
 * resolve, and refs for words that left are dropped.
 */
export function editLine(stored: Readonly<Record<string, Ref>> | null | undefined, text: string, ctx: SendCtx): Shipped {
  const fresh = sendLine(text, ctx)
  if (!stored) return fresh
  const refs: Record<string, Ref> = {}
  const kept = new Set<string>()
  WORD.lastIndex = 0
  for (let m = WORD.exec(text); m; m = WORD.exec(text)) {
    const w = m[0]
    // a pick made in this edit answers its word however the word reaches it (`name0`, the case setting)
    if (ctx.picks?.size && resolve(w, ctx, true)?.from === 'pick') continue
    const base = w.length > 1 && w.endsWith('0') ? w.slice(0, -1) : null
    const k = own(stored, w) && isRef(stored[w]) ? w : base && own(stored, base) && isRef(stored[base]) ? base : null
    if (k) { put(refs, k, stored[k]); kept.add(w) }
  }
  for (const k of Object.keys(fresh.refs)) if (!own(refs, k)) put(refs, k, fresh.refs[k])
  const tokens = fresh.tokens.filter(t => !kept.has(text.slice(t.start, t.end)))
  return { refs, tokens, wire: fresh.wire, chips: readLine(text, tokens, rowCtx(ctx, refs)) }
}

// ── OFFER ────────────────────────────────────────────────────────────────────

export type Tier = 'room' | 'own' | 'global' | 'catalog' | 'emoji'

export interface OfferCtx {
  room: Room | null
  own: OwnSets
  globals: NameIndex
  /** emotes not loaded anywhere yet (server search hits) */
  catalog?: readonly Emote[] | null
  emoji?: readonly Emote[] | null
  /** the person's own decayed usage of a name; a snapshot taken when the cycle starts */
  usage?: ((name: string) => number) | null
  /** channels carrying a name, by lowercase name */
  pop?: ((nameLower: string) => number | undefined) | null
  blocked?: ((key: EmoteKey) => boolean) | null
  /** false = the "suggest my emotes" setting is off */
  suggestOwn?: boolean
  /** pictures the person pinned, in their order. whole records: a favorite goes where they go, loaded here or not */
  favorites?: readonly Emote[] | null
}

export interface Candidate {
  emote: Emote
  tier: Tier
  /** 0 exact, 1 starts-with, 2 word-start, 3 inside, 4 no name match (catalog tag hit) */
  match: number
  /** a same-name copy that will not show where this is going, because the platform's own emote of that name wins there */
  shadowed?: true
}

const TIER_RANK: Record<Tier, number> = { room: 0, own: 1, global: 2, catalog: 3, emoji: 4 }

/** pin: place in the person's favorites, -1 none. hit: a search answered with this name (a catalog copy only) */
interface Cand extends Candidate { copy: number; use: number; pop: number; pin: number; hit: boolean }
const NOT_PINNED = 1e9

function gather(ctx: OfferCtx): Cand[] {
  const seen = new Set<string>()
  const names = new Set<string>()
  const out: Cand[] = []
  const pins = new Map<string, number>()
  const favorites = ctx.favorites || []
  favorites.forEach((e, i) => { if (e?.name && !pins.has(e.key)) pins.set(e.key, i) })
  const hits = new Set<string>()
  const add = (idx: Iterable<Emote> | null | undefined, tier: Tier, copy: number, local: boolean) => {
    if (!idx) return
    for (const e of idx) {
      if (!e?.name || seen.has(e.key)) continue
      seen.add(e.key)
      // a name you can reach here is held even when its emote is blocked: blocking hides, it never lets a search look-alike in
      if (local) names.add(e.name)
      if (ctx.blocked?.(e.key)) continue
      out.push({ emote: e, tier, match: BUCKET_NONE, copy, use: 0, pop: 0, pin: pins.get(e.key) ?? -1, hit: local || hits.has(e.name) })
    }
  }
  // copy order = send order, so the copy a hand-typed word would ship is the one a name keeps first
  add(ctx.room ? ctx.own.native[ctx.room.platform]?.values() : null, 'own', 0, true)
  add(ctx.own.personal.values(), 'own', 1, true)
  add(ctx.room?.names.values(), 'room', 2, true)
  if (ctx.suggestOwn !== false) add(ctx.own.inventory.values(), 'own', 3, true)
  // not suggested is not gone: typing the name still sends yours, so no search look-alike may take it
  else for (const e of ctx.own.inventory.values()) if (e?.name) names.add(e.name)
  add(ctx.globals.values(), 'global', 4, true)
  // one catalog copy per name (the most carried); a name already held locally keeps its local copy
  const best = new Map<string, Emote>()
  for (const e of ctx.catalog || []) {
    if (!e?.name || names.has(e.name) || ctx.blocked?.(e.key)) continue
    hits.add(e.name)
    const p = best.get(e.name)
    if (!p || (e.pop || 0) > (p.pop || 0) || ((e.pop || 0) === (p.pop || 0) && cmpCp(e.id, p.id) < 0)) best.set(e.name, e)
  }
  // a favorite nothing here holds is offered like a search answer, and is the copy its name gets
  // (the first pinned, when two share a name). a name held here keeps its own: no look-alike
  const pinnedName = new Set<string>()
  for (const e of favorites) {
    if (!e?.name || seen.has(e.key) || names.has(e.name) || pinnedName.has(e.name) || ctx.blocked?.(e.key)) continue
    pinnedName.add(e.name)
    best.set(e.name, e)
  }
  add(best.values(), 'catalog', 5, false)
  add(ctx.emoji, 'emoji', 6, false)
  return out
}

/**
 * Tab, the `:` list and picker search: one ranked list.
 *   the exact name (the spelling typed leads its case twin)
 *   your favorites, in your order, then names you use — only when the name starts with what you typed
 *   the room · yours · globals · not loaded yet · emoji
 * Inside a tier: starts-with, word-start, inside; then ones you use, more carried, shorter, a-z.
 * Copies of one name always sit in send order wherever they land.
 */
export function offer(typed: string, ctx: OfferCtx, limit?: number): Candidate[] {
  return offerSeams(typed, ctx, limit).list
}

/**
 * The offer, and the two places a client may set something that is not an emote (the room's people)
 * into it: `exact` candidates are the exact name; the first `room` are those, the names you use and
 * the room's. The law ranks emotes only, but it alone knows where its groups end: a tier says where
 * an emote came from, not which group it stands in.
 */
export interface Offered { list: Candidate[]; exact: number; room: number }

export function offerSeams(typed: string, ctx: OfferCtx, limit?: number): Offered {
  const q = typed.toLowerCase()
  if (!q) return { list: [], exact: 0, room: 0 }
  const pool: Cand[] = []
  for (const c of gather(ctx)) {
    c.match = matchBucket(c.emote.name, q)
    // a search may answer by tag, so its copy needs no name match; a favorite no search asked for does
    if (c.match === BUCKET_NONE && !(c.tier === 'catalog' && c.hit)) continue
    c.use = Math.max(0, ctx.usage?.(c.emote.name) || 0)
    c.pop = Math.max(0, Math.floor(ctx.pop?.(c.emote.name.toLowerCase()) ?? c.emote.pop ?? 0))
    pool.push(c)
  }
  const bestCopy = new Map<string, number>()
  for (const c of pool) bestCopy.set(c.emote.name, Math.min(bestCopy.get(c.emote.name) ?? 99, c.copy))
  const group = (c: Cand) =>
    c.match === BUCKET_EXACT ? 0
      : c.match === BUCKET_NONE ? 9
        : (c.use > 0 || c.pin >= 0) && c.match === BUCKET_PREFIX ? 1
          : 2 + TIER_RANK[c.tier]
  const tail = (a: Cand, b: Cand) => a.emote.name.length - b.emote.name.length || cmpCp(a.emote.name, b.emote.name) || a.copy - b.copy || cmpCp(a.emote.key, b.emote.key)
  pool.sort((a, b) => {
    const ga = group(a), gb = group(b)
    if (ga !== gb) return ga - gb
    if (ga === 0) {
      return Number(a.emote.name !== typed) - Number(b.emote.name !== typed)
        || (bestCopy.get(a.emote.name) as number) - (bestCopy.get(b.emote.name) as number)
        || cmpCp(a.emote.name, b.emote.name) || a.copy - b.copy || cmpCp(a.emote.key, b.emote.key)
    }
    if (ga === 1) return (a.pin < 0 ? NOT_PINNED : a.pin) - (b.pin < 0 ? NOT_PINNED : b.pin) || b.use - a.use || TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.pop - a.pop || tail(a, b)
    if (ga === 9) return b.pop - a.pop || tail(a, b)
    return a.match - b.match || b.use - a.use || b.pop - a.pop || tail(a, b)
  })
  // counted by slot, before copies trade places inside the slots their name earned
  let exact = 0, room = 0
  for (const c of pool) { const g = group(c); if (g === 0) exact++; if (g <= 2) room++ }
  // copies of one name keep the slots they earned, but stand in send order within them
  const slots = new Map<string, number[]>()
  pool.forEach((c, i) => { const l = slots.get(c.emote.name); if (l) l.push(i); else slots.set(c.emote.name, [i]) })
  for (const idx of slots.values()) {
    if (idx.length < 2) continue
    const copies = idx.map(i => pool[i]).sort((a, b) => a.copy - b.copy || cmpCp(a.emote.key, b.emote.key))
    const native = copies[0].copy === 0 && ctx.room?.platform !== 'kick'
    idx.forEach((i, n) => { pool[i] = copies[n]; if (native && n > 0) pool[i].shadowed = true })
  }
  const list = limit && limit > 0 ? pool.slice(0, limit) : pool
  return {
    list: list.map(c => (c.shadowed ? { emote: c.emote, tier: c.tier, match: c.match, shadowed: true } : { emote: c.emote, tier: c.tier, match: c.match })),
    exact: Math.min(exact, list.length), room: Math.min(room, list.length),
  }
}

/**
 * Something arrived mid-cycle (a room set, a catalog answer). Everything up to
 * the cursor stays exactly where it is; the rest is the fresh ranking minus it.
 * cursor -1 = nothing chosen yet.
 */
export function extendOffer(prev: readonly Candidate[], cursor: number, typed: string, ctx: OfferCtx, limit?: number): Candidate[] {
  const head = prev.slice(0, Math.max(0, cursor + 1))
  const have = new Set(head.map(c => c.emote.key))
  const tail = offer(typed, ctx).filter(c => !have.has(c.emote.key))
  const out = [...head, ...tail]
  return limit && limit > 0 ? out.slice(0, limit) : out
}

export interface Browse { favorite: Candidate[]; recent: Candidate[]; room: Candidate[]; own: Candidate[]; global: Candidate[] }

/**
 * The picker with nothing typed. Recents are pictures, not names: one you can no longer reach here is
 * simply absent. A favorite is never absent: one nothing here holds is a `catalog` copy, picked like a
 * search answer. A blocked one is hidden.
 */
export function browse(ctx: OfferCtx, recents: readonly EmoteKey[] = []): Browse {
  const all = gather({ ...ctx, catalog: null, emoji: null, favorites: null })
  const byKey = new Map(all.map(c => [c.emote.key, c]))
  const order = (a: Cand, b: Cand) =>
    (ctx.usage?.(b.emote.name) || 0) - (ctx.usage?.(a.emote.name) || 0)
    || cmpCp(a.emote.name.toLowerCase(), b.emote.name.toLowerCase()) || cmpCp(a.emote.name, b.emote.name) || cmpCp(a.emote.key, b.emote.key)
  const plain = (c: Cand): Candidate => ({ emote: c.emote, tier: c.tier, match: BUCKET_NONE })
  const of = (t: Tier) => all.filter(c => c.tier === t).sort(order).map(plain)
  const seen = new Set<string>()
  const recent: Candidate[] = []
  for (const k of recents) {
    const c = byKey.get(k)
    if (c && !seen.has(k)) { seen.add(k); recent.push(plain(c)) }
  }
  const favorite: Candidate[] = []
  const pinned = new Set<string>()
  for (const e of ctx.favorites || []) {
    if (!e?.name || pinned.has(e.key) || ctx.blocked?.(e.key)) continue
    pinned.add(e.key)
    const c = byKey.get(e.key)
    favorite.push(c ? plain(c) : { emote: e, tier: 'catalog', match: BUCKET_NONE })
  }
  return { favorite, recent, room: of('room'), own: of('own'), global: of('global') }
}

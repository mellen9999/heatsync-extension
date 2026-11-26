/**
 * Who sees a picker tile's picture if you send it from this room — the one answer behind a tile's
 * corner mark, the words that say it, and whether the tile is offered at all.
 *
 * docs/emote-law.md (offer: one name, one picture, one tile; the tile mark) is the prose.
 * shared/emote-mark.vectors.json is the contract: the site, the extension, the desktop app and the
 * terminal client run it against their own code, so a tile cannot say one thing in one app and
 * another in the next.
 *
 *   MARK    none = everyone · T K Y = that platform's viewers · 7 B F = that addon's users · H = heatsync users
 *   OFFER   a room answers a typed word with ONE picture: every other picture under that name is not a tile
 *
 * The mark describes what SENDING the tile from this room ships, as the law's send answers it: a
 * click pins the tile's own picture, so your copy of the room's own 7tv picture goes out as the
 * room's (7) and a different picture under the room's name is no tile at all.
 *
 * Pure: no DOM, no clock, no I/O, no module state. It reads the law's own send context.
 */
import { sendWord, type Emote, type SendCtx } from './emote-law'

export const MARK_VERSION = 1

export type Mark = '' | 'T' | 'K' | 'Y' | '7' | 'B' | 'F' | 'H'
/** everyone: a platform's own emote, emoji, chatters · ext: an addon's users · heatsync: heatsync users only */
export type Kind = 'everyone' | 'ext' | 'heatsync'

export interface Audience {
  kind: Kind
  mark: Mark
  /** whose picture it goes out as: the provider the words name ("all twitch", "7tv users"); `hs` = heatsync users only */
  as: string
}

export interface TileSays extends Audience {
  /** false = this room answers the tile's word with another picture: the tile is not drawn, in the picker or in Tab */
  offered: boolean
  /** where what it ships sits (room, own, global, catalog, emoji, people): the answer's tier, the tile's own when its word has no answer. The readout says it ("channel", "global") */
  tier: string
}

// a client's own names for our uploads and your saved copies
const ALIAS = new Map([['heatsync', 'hs'], ['inventory', 'hs']])
const NATIVE = new Map<string, Mark>([['twitch', 'T'], ['kick', 'K'], ['youtube', 'Y']])
const ADDON = new Map<string, Mark>([['7tv', '7'], ['bttv', 'B'], ['ffz', 'F']])
const HEATSYNC: Audience = { kind: 'heatsync', mark: 'H', as: 'hs' }

const canon = (provider: string | undefined): string => ALIAS.get(provider ?? '') ?? provider ?? ''
const silent = (p: string) => p === 'emoji' || p === 'chatter'

/**
 * Who sees a picture of `provider` that sits in `tier` (where the law's offer found it), with no
 * room to answer for it. The Tab readout asks this alone; a tile asks `tileSays`, which first
 * finds what the room would really send.
 *   emoji, chatters           everyone, no mark
 *   not loaded here           heatsync users only (a search answer, a favorite from another room)
 *   a platform's own emote    that platform's viewers
 *   yours, or a heatsync one  heatsync users only
 *   an addon's emote          that addon's users (an unknown provider: an addon's, with no letter)
 */
export function audience(provider: string | undefined, tier?: string): Audience {
  const p = canon(provider)
  if (silent(p)) return { kind: 'everyone', mark: '', as: p }
  if (tier === 'catalog') return HEATSYNC
  const native = NATIVE.get(p)
  if (native) return { kind: 'everyone', mark: native, as: p }
  if (tier === 'own' || p === 'hs') return HEATSYNC
  return { kind: 'ext', mark: ADDON.get(p) ?? '', as: p || 'ext' }
}

/** one picture: the same `pic` (default `key`), or the same upload by its hash */
export const samePicture = (a: Emote, b: Emote): boolean =>
  (a.pic ?? a.key) === (b.pic ?? b.key) || (!!a.hash && a.hash === b.hash)

/**
 * where the answer to a typed word sits, as a tier. A platform's own emote you may use (native) sits
 * where the tile does, except a tile this room does not hold (catalog: a favorite from elsewhere, a
 * search answer): the room answers it from your set, so it is no longer "not loaded here"
 */
const SHIPPED_TIER = new Map([['room', 'room'], ['global', 'global'], ['own', 'own'], ['personal', 'own']])
const sits = (from: string, tier: string) => (from === 'native' ? (tier === 'catalog' ? 'own' : tier) : (SHIPPED_TIER.get(from) ?? tier))

/**
 * What a tile says. `ctx` is the law's send context for the box the line is written in (its room,
 * every leg, your sets, the globals; picks are never read: a tile is judged by what its word sends).
 * `tier` is where the law's offer found the tile.
 *   offered   no room, or the room's answer for the word is this very picture (or the word has no answer)
 *   mark      that answer's class, never the copy the tile happens to be: your copy of the room's own
 *             picture is the room's; an answer from your own set ships as yours (H)
 *   a platform's own emote is drawn only on that platform: where the send reaches none of its legs
 *   it travels as a picture and only heatsync users see it
 */
export function tileSays(ctx: SendCtx, e: Emote, tier: string): TileSays {
  if (silent(canon(e.provider))) return { offered: true, tier, ...audience(e.provider) }
  const legs = ctx.legs?.length ? ctx.legs : ctx.room ? [ctx.room] : []
  const hit = ctx.room && e.name ? sendWord(e.name, ctx.picks ? { ...ctx, picks: null } : ctx) : null
  const same = !!hit && samePicture(hit.emote, e)
  let says: Audience
  let at = tier
  if (hit && same) {
    at = sits(hit.from, tier)
    says = hit.from === 'own' || hit.from === 'personal' ? HEATSYNC : audience(hit.emote.provider, at)
  } else says = audience(e.provider, tier)
  if (says.kind === 'everyone' && NATIVE.has(says.as) && legs.length && !legs.some(r => r.platform === says.as)) says = HEATSYNC
  return { offered: !hit || same, tier: at, ...says }
}

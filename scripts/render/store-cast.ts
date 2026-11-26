import { EMOTE_NAMES, emotePng } from './store-art'
import type { EmoteRec } from './store-stage'

export { emotePng }

/**
 * Everyone and everything in a store shot is invented here: the channels, the chatters, the lines
 * they say, and every emote picture (store-art.ts). Nothing is read from a real stream or person.
 */

// ── emotes ──────────────────────────────────────────────────────────────────────────────────────
// a picture is served from whichever host its source really uses, so the panel takes it for what it
// is (a 7tv emote, a kick one) and draws its own letter on it. The picture itself is always ours.
export type Source = '7tv' | 'bttv' | 'ffz' | 'twitch' | 'kick' | 'heatsync'
const idx = (art: string) => EMOTE_NAMES.indexOf(art)

const URL_OF: Record<Source, (art: string) => string> = {
  '7tv': (a) => `https://cdn.7tv.app/emote/${`01PX${a}`.padEnd(26, '0')}/2x.webp`,
  bttv: (a) => `https://cdn.betterttv.net/emote/${`px${a.toLowerCase()}`.padEnd(24, '0')}/2x.webp`,
  ffz: (a) => `https://cdn.frankerfacez.com/emote/${9000 + idx(a)}/2`,
  twitch: (a) => `https://static-cdn.jtvnw.net/emoticons/v2/${700000 + idx(a)}/default/dark/2.0`,
  kick: (a) => `https://files.kick.com/emotes/${800000 + idx(a)}/fullsize`,
  heatsync: (a) => `https://cdn.heatsync.org/emote/${a}.png`,
}

/** which of our pictures a request is for; null for anything that is not one of them */
export function artOfUrl(url: string): string | null {
  const byIdx = (n: string, base: number) => EMOTE_NAMES[Number(n) - base] ?? null
  let m: RegExpMatchArray | null
  if ((m = url.match(/cdn\.7tv\.app\/emote\/01PX([A-Z]+)0+\//))) return m[1]
  if ((m = url.match(/cdn\.betterttv\.net\/emote\/px([a-z]+)0+\//))) return EMOTE_NAMES.find((a) => a.toLowerCase() === m![1]) ?? null
  if ((m = url.match(/cdn\.frankerfacez\.com\/emote\/(\d+)\//))) return byIdx(m[1], 9000)
  if ((m = url.match(/static-cdn\.jtvnw\.net\/emoticons\/v2\/(\d+)\//))) return byIdx(m[1], 700000)
  if ((m = url.match(/files\.kick\.com\/emotes\/(\d+)\//))) return byIdx(m[1], 800000)
  if ((m = url.match(/cdn\.heatsync\.org\/emote\/([A-Z]+)\.png/))) return m[1]
  return null
}

/** one emote of the room (or the viewer's set): its word, its picture's art, where it comes from */
export const emote = (name: string, art: string, source: Source): EmoteRec => ({
  name,
  url: URL_OF[source](art),
  source,
  hash: `px-${source}-${name}`,
})

// ── people ──────────────────────────────────────────────────────────────────────────────────────
export const ANSI = { red: '#ff0000', green: '#00ff00', yellow: '#ffff00', blue: '#8888ff', magenta: '#ff00ff', cyan: '#00ffff', white: '#ffffff' }

/** the viewer: a login that exists nowhere */
export const VIEWER = 'tinwhistle'

/** a youtube author id (UC + 22) made from the name, so the same chatter is the same person every run */
export const ytId = (name: string) => `UC${name.padEnd(22, 'A').slice(0, 22)}`

// who says what, and in which colour: the panel draws a name in the colour its platform sends, and
// asks for a chosen one on youtube (store-stage.ts answers that from YT_COLORS)
export const TW = {
  quillbyte: ANSI.yellow,
  velvetmoth: ANSI.magenta,
  tinrobin: ANSI.green,
  ashkettle: ANSI.cyan,
  mossgate: ANSI.blue,
  dunebloom: ANSI.white,
}
export const KK = {
  marblefox: ANSI.cyan,
  pebblejay: ANSI.green,
  lanternoat: ANSI.yellow,
  wrenfield: ANSI.magenta,
  saltpine: ANSI.blue,
}
export const YT = {
  copperwren: ANSI.cyan,
  tallowmint: ANSI.green,
  harbornoon: ANSI.yellow,
  plumline: ANSI.magenta,
}
export const YT_COLORS: Record<string, string> = Object.fromEntries(Object.entries(YT).map(([n, c]) => [ytId(n), c]))

// ── the room ────────────────────────────────────────────────────────────────────────────────────
/** the streamer the shots are about (a name nobody has) and the other tabs beside it */
export const CHANNEL = 'pixelharbor'
export const OTHER_TABS = [
  { id: 'mossbyte', twitch: 'mossbyte' },
  { id: 'quillcast', kick: 'quillcast' },
]
export const MERGED = { id: CHANNEL, twitch: CHANNEL, kick: CHANNEL, youtube: `@${CHANNEL}` }

/** the room's emotes: addon sets (7tv, bttv, ffz) and the platforms' own */
export const ROOM: EmoteRec[] = [
  emote('pxLOL', 'LOL', '7tv'),
  emote('pxPOG', 'POG', '7tv'),
  emote('pxSKULL', 'SKULL', '7tv'),
  emote('pxGHOST', 'GHOST', '7tv'),
  emote('pxGG', 'GG', '7tv'),
  emote('pxCRY', 'CRY', 'bttv'),
  emote('pxSTAR', 'STAR', 'bttv'),
  emote('pxEYES', 'EYES', 'bttv'),
  emote('pxHEART', 'HEART', 'ffz'),
  emote('pxCAT', 'CAT', 'ffz'),
  emote('pxBOLT', 'BOLT', 'ffz'),
  emote('phCROWN', 'CROWN', 'twitch'),
  emote('phCHECK', 'CHECK', 'twitch'),
  emote('khSTAR', 'STAR', 'kick'),
  emote('khCAT', 'CAT', 'kick'),
]

import { deflateSync } from 'node:zlib'

/**
 * Our own emote art for the store screenshots: 16x16 pixel pictures drawn here in code, in the
 * ansi palette, rendered to real PNG files. No picture in a store shot comes from anyone else's
 * emote set, so there is nothing to credit, license or take down.
 */

// the only colours a store shot may carry: ansi 0-7, the two greys, and the empty cell
const PALETTE: Record<string, [number, number, number] | null> = {
  '.': null,
  K: [0x00, 0x00, 0x00],
  R: [0xff, 0x00, 0x00],
  G: [0x00, 0xff, 0x00],
  Y: [0xff, 0xff, 0x00],
  B: [0x88, 0x88, 0xff],
  M: [0xff, 0x00, 0xff],
  C: [0x00, 0xff, 0xff],
  W: [0xff, 0xff, 0xff],
  D: [0x44, 0x44, 0x44],
  g: [0x80, 0x80, 0x80],
}

const N = 16
type Grid = string[][]
const blank = (): Grid => Array.from({ length: N }, () => Array.from({ length: N }, () => '.'))
const put = (g: Grid, x: number, y: number, c: string) => {
  if (x >= 0 && y >= 0 && x < N && y < N) g[y][x] = c
}
const rect = (g: Grid, x0: number, y0: number, x1: number, y1: number, c: string) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(g, x, y, c)
}
const disc = (g: Grid, c: string, cx = 7.5, cy = 7.5, r = 7.4) => {
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) put(g, x, y, c)
}
/** rows of a picture drawn as text; '.' leaves the cell alone */
const stamp = (g: Grid, x0: number, y0: number, rows: string[]) => {
  rows.forEach((row, dy) => [...row].forEach((c, dx) => c !== '.' && put(g, x0 + dx, y0 + dy, c)))
}

const face = (): Grid => {
  const g = blank()
  disc(g, 'Y')
  return g
}

const DRAW: Record<string, () => Grid> = {
  // laughing: squinting eyes, wide open mouth with teeth
  LOL() {
    const g = face()
    stamp(g, 2, 4, ['.KK..', '..KKK', '.KK..'])
    stamp(g, 9, 4, ['..KK.', 'KKK..', '..KK.'])
    rect(g, 3, 8, 12, 12, 'K')
    rect(g, 4, 8, 11, 9, 'W')
    rect(g, 5, 11, 10, 12, 'R')
    return g
  },
  // wide eyes, round open mouth
  POG() {
    const g = face()
    rect(g, 3, 3, 6, 7, 'W')
    rect(g, 9, 3, 12, 7, 'W')
    rect(g, 5, 5, 6, 7, 'K')
    rect(g, 9, 5, 10, 7, 'K')
    rect(g, 6, 9, 9, 13, 'K')
    rect(g, 7, 10, 8, 12, 'R')
    return g
  },
  // tears running down
  CRY() {
    const g = face()
    rect(g, 4, 5, 5, 6, 'K')
    rect(g, 10, 5, 11, 6, 'K')
    rect(g, 3, 7, 4, 13, 'C')
    rect(g, 11, 7, 12, 13, 'C')
    stamp(g, 5, 10, ['KKKKKK', 'K....K'])
    return g
  },
  HEART() {
    const g = blank()
    stamp(g, 0, 1, [
      '..RRRR....RRRR..',
      '.RRRRRR..RRRRRR.',
      'RRRWWRRRRRRRRRRR',
      'RRWWRRRRRRRRRRRR',
      'RRRRRRRRRRRRRRRR',
      'RRRRRRRRRRRRRRRR',
      '.RRRRRRRRRRRRRR.',
      '..RRRRRRRRRRRR..',
      '...RRRRRRRRRR...',
      '....RRRRRRRR....',
      '.....RRRRRR.....',
      '......RRRR......',
      '.......RR.......',
    ])
    return g
  },
  SKULL() {
    const g = blank()
    disc(g, 'W', 7.5, 6.5, 6.4)
    rect(g, 4, 11, 11, 14, 'W')
    rect(g, 3, 5, 6, 8, 'K')
    rect(g, 9, 5, 12, 8, 'K')
    rect(g, 7, 9, 8, 10, 'K')
    rect(g, 5, 12, 5, 14, 'K')
    rect(g, 7, 12, 7, 14, 'K')
    rect(g, 9, 12, 9, 14, 'K')
    rect(g, 11, 12, 11, 14, 'K')
    return g
  },
  STAR() {
    const g = blank()
    stamp(g, 0, 0, [
      '.......YY.......',
      '.......YY.......',
      '......YYYY......',
      '......YYYY......',
      'YYYYYYYYYYYYYYYY',
      '.YYYYYYYYYYYYYY.',
      '..YYYYYYYYYYYY..',
      '...YYYYYYYYYY...',
      '....YYYYYYYY....',
      '....YYYYYYYY....',
      '...YYYYYYYYYY...',
      '...YYYY..YYYY...',
      '..YYYY....YYYY..',
      '..YYY......YYY..',
    ])
    return g
  },
  // a cyan cat's head
  CAT() {
    const g = blank()
    disc(g, 'C', 7.5, 9, 6.6)
    stamp(g, 3, 1, ['C..', 'CC.', 'CCC'])
    stamp(g, 10, 1, ['..C', '.CC', 'CCC'])
    rect(g, 4, 7, 5, 9, 'K')
    rect(g, 10, 7, 11, 9, 'K')
    rect(g, 7, 10, 8, 10, 'M')
    stamp(g, 5, 11, ['K...K'])
    stamp(g, 6, 12, ['KKK'])
    return g
  },
  GHOST() {
    const g = blank()
    disc(g, 'W', 7.5, 6.5, 6.4)
    rect(g, 1, 7, 14, 14, 'W')
    // a ragged hem
    for (const x of [2, 5, 8, 11, 14]) rect(g, x - 1, 13, x, 14, '.')
    rect(g, 4, 5, 5, 8, 'K')
    rect(g, 10, 5, 11, 8, 'K')
    rect(g, 7, 10, 8, 11, 'B')
    return g
  },
  BOLT() {
    const g = blank()
    stamp(g, 0, 0, [
      '.........YYYYY..',
      '........YYYYY...',
      '.......YYYYY....',
      '......YYYYY.....',
      '.....YYYYYYYYY..',
      '....YYYYYYYYY...',
      '........YYYY....',
      '.......YYYY.....',
      '......YYYY......',
      '.....YYY........',
      '.....YY.........',
      '....YY..........',
      '....Y...........',
    ])
    return g
  },
  EYES() {
    const g = blank()
    for (const x0 of [0, 8]) {
      rect(g, x0 + 1, 3, x0 + 6, 12, 'W')
      rect(g, x0, 5, x0 + 7, 10, 'W')
      rect(g, x0 + 3, 7, x0 + 5, 10, 'K')
    }
    return g
  },
  CROWN() {
    const g = blank()
    stamp(g, 0, 2, [
      '.Y......YY......',
      '.YY....YYYY....Y',
      '.YYY..YYYYYY..YY',
      '.YYYYYYYYYYYYYYY',
      '.YYYYYYYYYYYYYYY',
      '.YYYYYYYYYYYYYYY',
      '.YYYYYYYYYYYYYYY',
      '.YYYYYYYYYYYYYYY',
      '.YYYYYYYYYYYYYYY',
    ])
    rect(g, 4, 8, 4, 8, 'R')
    rect(g, 8, 8, 8, 8, 'B')
    rect(g, 12, 8, 12, 8, 'R')
    return g
  },
  CHECK() {
    const g = blank()
    rect(g, 0, 1, 15, 14, 'G')
    rect(g, 1, 2, 14, 13, 'K')
    stamp(g, 3, 5, [
      '.........GG.',
      '........GGG.',
      '.......GGG..',
      'GG....GGG...',
      'GGG..GGG....',
      '.GGGGGG.....',
      '..GGGG......',
    ])
    return g
  },
  // the two letters, drawn by hand
  GG() {
    const g = blank()
    rect(g, 0, 1, 15, 14, 'G')
    rect(g, 1, 2, 14, 13, 'K')
    const G = ['.GGGG.', 'GG..GG', 'GG....', 'GG.GGG', 'GG..GG', 'GG..GG', '.GGGG.']
    stamp(g, 1, 4, G)
    stamp(g, 8, 4, G)
    return g
  },
}

export const EMOTE_NAMES = Object.keys(DRAW)

// every picture is drawn once and served at every size the panel asks for: each grid cell is 8x8
// pixels, so the 2x-density screenshot scales it by exactly one half and the edges stay clean
const CELL = 8

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(w: number, h: number, rgba: Buffer) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  const head = Buffer.alloc(13)
  head.writeUInt32BE(w, 0)
  head.writeUInt32BE(h, 4)
  head.set([8, 6, 0, 0, 0], 8) // 8 bit, rgba
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const cache = new Map<string, Buffer>()
/** the PNG of one of our emotes; throws on a name that was never drawn */
export function emotePng(name: string): Buffer {
  const hit = cache.get(name)
  if (hit) return hit
  const draw = DRAW[name]
  if (!draw) throw new Error(`no emote art for ${name}`)
  const g = draw()
  const px = N * CELL
  const rgba = Buffer.alloc(px * px * 4)
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const c = PALETTE[g[Math.floor(y / CELL)][Math.floor(x / CELL)]]
      if (!c) continue
      rgba.set([c[0], c[1], c[2], 255], (y * px + x) * 4)
    }
  }
  const png = encodePng(px, px, rgba)
  cache.set(name, png)
  return png
}

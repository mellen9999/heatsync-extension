/**
 * The five store screenshots, 1280x800, shot on fixture data against the BUILT extension.
 *
 *   bun run build.js chrome --minify && bun scripts/render-store-shots.ts      (bun run shots:store)
 *
 * Also the two promo tiles the chrome and edge stores show: small-440x280.png and marquee-1400x560.png
 * (the icon, the name and one line; the marquee adds a crop of the panel as shot in 01).
 *
 * Writes store-assets/cws-ready-2026-11/01..05-*.png (OUT=<dir> to put them elsewhere; ONLY=3 or
 * ONLY=3,4 or ONLY=small,marquee to redo some). The order is the store listing's order (docs/STORE-LISTING.md): the claim
 * each picture proves is the line above it.
 *
 * Everything on screen is invented: the channel, the chatters, their lines, and every emote picture
 * (scripts/render/store-art.ts draws them). The panel is the real one, popped out to fill the window
 * and drawn at 2x so its text reads at thumbnail size; a caption strip sits above it. Each picture is
 * checked after it is written: exact size, 24-bit rgb (no alpha, as the chrome store asks), and no
 * orange anywhere but heatsync's own brand marks (BRAND below).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertBuilt } from './lib/chromium'
import { KK, MERGED, OTHER_TABS, ROOM, TW, VIEWER, YT, YT_COLORS, emote, ytId } from './render/store-cast'
import { CAP_H, SCALE, SHOT_H, SHOT_W, bootStage, type Stage, type StageOpts } from './render/store-stage'

const OUT = process.env.OUT || join(import.meta.dir, '..', 'store-assets', 'cws-ready-2026-11')
// the one orange there is: heatsync's own mark (--hs-plat-hs, the [H] tag) and its icon on the picker button
const BRAND = '#hs-mc-emote-btn img, .hs-mc-src-chip[data-src="hs"], .hs-mc-pb-heatsync'
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean)

const tabs = [MERGED, ...OTHER_TABS]
const base: Pick<StageOpts, 'channels' | 'room' | 'viewer' | 'ytColors'> = { channels: tabs, room: ROOM, viewer: VIEWER, ytColors: YT_COLORS }

interface Shot {
  file: string
  caption: string
  opts?: Partial<StageOpts>
  run: (s: Stage) => Promise<void>
}

const yt = (s: Stage, who: keyof typeof YT, text: string) => s.yt(who, ytId(who), text)

const SHOTS: Shot[] = [
  {
    file: '01-one-panel.png',
    caption: 'twitch, kick and youtube chat in one window',
    async run(s) {
      await s.tw('quillbyte', TW.quillbyte, 'the new level is huge')
      await s.kick('marblefox', KK.marblefox, 'just got here, what did i miss')
      await yt(s, 'copperwren', 'hello from youtube, the chat is so alive')
      await s.tw('velvetmoth', TW.velvetmoth, 'the whole intro, rewind is on')
      await yt(s, 'tallowmint', 'that jump should not have worked')
      await s.tw('tinrobin', TW.tinrobin, 'yes it is, forty minutes of map')
      await s.kick('lanternoat', KK.lanternoat, 'the music in this stage though')
      await yt(s, 'harbornoon', 'can someone link the soundtrack')
      await s.tw('ashkettle', TW.ashkettle, 'five more minutes then we call it')
      await s.kick('saltpine', KK.saltpine, 'best stream of the week so far')
      await yt(s, 'plumline', 'first time here, followed. good stream')
      await s.tw('dunebloom', TW.dunebloom, 'welcome in, stay a while')
      await s.kick('wrenfield', KK.wrenfield, 'that was the last boss, right?')
    },
  },
  {
    file: '02-emotes-on-kick-and-youtube.png',
    caption: '7tv, bttv, ffz emotes on kick and youtube',
    async run(s) {
      await s.kick('marblefox', KK.marblefox, 'that clutch was pxPOG pxPOG')
      await yt(s, 'copperwren', 'pxLOL the face he made')
      await s.kick('pebblejay', KK.pebblejay, 'pxCRY why did it have to end')
      await yt(s, 'tallowmint', 'pxHEART best part of my day')
      await s.kick('saltpine', KK.saltpine, 'pxCAT pxCAT the whole chat right now')
      await yt(s, 'harbornoon', 'pxEYES did you see that')
      // a word and Tab: the emote's picture goes into the box, and a space takes the word as it is
      await s.p.keyboard.type('see you all tomorrow pxHE', { delay: 40 })
      await s.p.keyboard.press('Tab')
      await s.p.keyboard.type(' pxPOG', { delay: 40 })
      await s.p.keyboard.press('Tab')
      await s.p.keyboard.type(' ', { delay: 40 })
      await s.p.waitForTimeout(800)
    },
  },
  {
    file: '03-who-sees-it.png',
    caption: 'a corner letter says who sees each emote',
    opts: {
      inventory: [emote('myPixel', 'STAR', 'heatsync'), emote('myBolt', 'BOLT', 'heatsync'), emote('myCat', 'CAT', 'heatsync')],
    },
    async run(s) {
      await s.tw('quillbyte', TW.quillbyte, 'the new level is huge')
      await s.kick('marblefox', KK.marblefox, 'just got here, what did i miss')
      await s.p.click('#hs-mc-emote-btn')
      await s.p.waitForSelector('#hs-mc-emote-picker.visible')
      await s.p.waitForTimeout(800)
    },
  },
  {
    file: '04-big-emote-lines.png',
    caption: 'emote-only lines draw twice as big',
    async run(s) {
      await s.tw('quillbyte', TW.quillbyte, 'pxPOG')
      await s.kick('marblefox', KK.marblefox, 'pxLOL pxLOL pxLOL')
      await yt(s, 'copperwren', 'pxCAT')
      await s.tw('velvetmoth', TW.velvetmoth, 'what a clutch pxPOG')
      await s.kick('pebblejay', KK.pebblejay, 'pxHEART pxHEART pxHEART pxHEART pxHEART')
      await yt(s, 'tallowmint', 'pxSKULL pxSKULL pxSKULL pxSKULL pxSKULL pxSKULL')
      await s.tw('tinrobin', TW.tinrobin, 'pxGG')
      await s.kick('lanternoat', KK.lanternoat, 'pxGHOST pxGHOST')
    },
  },
  {
    file: '05-events-and-mentions.png',
    caption: 'subs, raids and mentions get their own color',
    async run(s) {
      await s.tw('quillbyte', TW.quillbyte, 'the new level is huge')
      await s.notice('mossgate', TW.mossgate, 'msg-id=raid;msg-param-displayName=mossgate;msg-param-viewerCount=84', 'mossgate is raiding with a party of 84')
      await s.kick('marblefox', KK.marblefox, 'welcome raiders')
      await s.notice('tinrobin', TW.tinrobin, 'msg-id=sub;msg-param-sub-plan=1000', 'tinrobin subscribed at Tier 1.')
      await s.notice('velvetmoth', TW.velvetmoth, 'msg-id=resub;msg-param-cumulative-months=12;msg-param-sub-plan=1000', 'velvetmoth subscribed at Tier 1. They have subscribed for 12 months!', 'a year already, thanks for the good times')
      await s.notice('ashkettle', TW.ashkettle, 'msg-id=subgift;msg-param-recipient-display-name=dunebloom;msg-param-sub-plan=1000;msg-param-recipient-user-name=dunebloom', 'ashkettle gifted a Tier 1 sub to dunebloom!')
      await s.tw('dunebloom', TW.dunebloom, 'hi everyone, first time chatting here', ';first-msg=1')
      await s.tw('mossgate', TW.mossgate, `@${VIEWER} nice stream, the level design is great`)
      await yt(s, 'harbornoon', 'what is the plan for tonight')
      await s.notice('quillbyte', TW.quillbyte, 'msg-id=announcement;msg-param-color=PRIMARY', '', 'giveaway tonight at nine, stay tuned')
      await s.kick('lanternoat', KK.lanternoat, 'see you at nine')
    },
  },
]

// ── compose: the panel under a caption strip, 1280x800 ──────────────────────────────────────────
async function compose(s: Stage, panel: Buffer, caption: string) {
  const page = await s.c.newPage()
  await page.setViewportSize({ width: SHOT_W / SCALE, height: SHOT_H / SCALE })
  const css = (px: number) => `${px / SCALE}px`
  await page.setContent(
    `<!doctype html><html><head><style>
      html,body{margin:0;background:#000;color:#fff}
      #cap{box-sizing:border-box;height:${css(CAP_H)};padding:0 ${css(20)};display:flex;align-items:center;border-bottom:1px solid #fff;font:700 ${css(28)}/1 monospace;letter-spacing:0;white-space:nowrap;overflow:hidden}
      img{display:block;width:${SHOT_W / SCALE}px;height:${(SHOT_H - CAP_H) / SCALE}px}
    </style></head><body><div id="cap"></div><img src="data:image/png;base64,${panel.toString('base64')}"></body></html>`,
  )
  await page.evaluate((t: string) => {
    document.getElementById('cap')!.textContent = t
  }, caption)
  await page.evaluate(() => (document.querySelector('img') as HTMLImageElement).decode())
  const png = await page.screenshot({ type: 'png' })
  await page.close()
  return png
}


// ── promo tiles: icon + name + one line, black, white text; the marquee adds a crop of the panel ─
const TAGLINE = 'twitch, kick and youtube chat in one panel'
const icon = (f: string) => `data:image/png;base64,${readFileSync(join(import.meta.dir, '..', 'chrome', f)).toString('base64')}`

interface Tile {
  file: string
  w: number
  h: number
  /** the panel crop on the right, 1 device px per px (marquee only) */
  panel?: boolean
}
const TILES: Tile[] = [
  { file: 'small-440x280.png', w: 440, h: 280 },
  { file: 'marquee-1400x560.png', w: 1400, h: 560, panel: true },
]

async function composeTile(s: Stage, t: Tile, panel: Buffer | null) {
  const page = await s.c.newPage()
  await page.setViewportSize({ width: t.w, height: t.h })
  const small = !panel
  const ic = small ? 96 : 128
  const name = small ? 48 : 96
  const line = small ? 22 : 36
  const left = small ? 0 : 640
  await page.setContent(
    `<!doctype html><html><head><style>
      html,body{margin:0;background:#000;color:#fff;overflow:hidden}
      body{width:${t.w}px;height:${t.h}px;position:relative;font-family:monospace;text-transform:lowercase}
      #copy{position:absolute;left:${small ? 24 : 56}px;top:0;width:${small ? t.w - 48 : 560}px;height:${t.h}px;display:flex;flex-direction:column;justify-content:center;gap:${small ? 14 : 28}px}
      #row{display:flex;align-items:center;gap:${small ? 14 : 24}px}
      #ic{width:${ic}px;height:${ic}px;image-rendering:pixelated;display:block}
      #nm{font-size:${name}px;font-weight:700;line-height:1}
      #ln{font-size:${line}px;line-height:1.25}
      #pn{position:absolute;left:${left}px;top:0;width:${t.w - left}px;height:${t.h}px;overflow:hidden;border-left:1px solid #fff;box-sizing:border-box}
      #pn img{position:absolute;left:0;top:0;display:block;width:1280px;height:744px}
    </style></head><body>
      <div id="copy"><div id="row"><img id="ic" src="${icon(small ? 'icon-96.png' : 'icon-128.png')}"><div id="nm">heatsync</div></div><div id="ln">${TAGLINE}</div></div>
      ${panel ? `<div id="pn"><img src="data:image/png;base64,${panel.toString('base64')}"></div>` : ''}
    </body></html>`,
  )
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())))
  const brand: Box[] = await page.evaluate(() => {
    const r = document.getElementById('ic')!.getBoundingClientRect()
    return [{ x: Math.floor(r.left) - 2, y: Math.floor(r.top) - 2, w: Math.ceil(r.width) + 4, h: Math.ceil(r.height) + 4 }]
  })
  const png = await page.screenshot({ type: 'png', scale: 'css' })
  await page.close()
  return { png, brand }
}

// ── check what was written ──────────────────────────────────────────────────────────────────────
type Box = { x: number; y: number; w: number; h: number }
async function check(s: Stage, png: Buffer, brand: Box[], file: string, W = SHOT_W, H = SHOT_H) {
  const w = png.readUInt32BE(16)
  const h = png.readUInt32BE(20)
  if (w !== W || h !== H) throw new Error(`${file}: ${w}x${h}, not ${W}x${H}`)
  if (png[25] !== 2) throw new Error(`${file}: png colour type ${png[25]}, not 2 (24-bit rgb with no alpha)`)
  const page = await s.c.newPage()
  const orange = await page.evaluate(
    async ([b64, boxes]: [string, Box[]]) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const cv = document.createElement('canvas')
      cv.width = img.width
      cv.height = img.height
      const cx = cv.getContext('2d')!
      cx.drawImage(img, 0, 0)
      const d = cx.getImageData(0, 0, cv.width, cv.height).data
      let n = 0
      for (let y = 0; y < cv.height; y++) {
        for (let x = 0; x < cv.width; x++) {
          if (boxes.some((k) => x >= k.x && x < k.x + k.w && y >= k.y && y < k.y + k.h)) continue
          const i = (y * cv.width + x) * 4
          const [r, g, bl] = [d[i], d[i + 1], d[i + 2]]
          // orange is hue 10-50 at real strength: the retired accent, and anything blended toward it
          const mx = Math.max(r, g, bl)
          const mn = Math.min(r, g, bl)
          if (mx < 150 || (mx - mn) / mx < 0.5) continue
          const hue = mx === r ? (60 * (g - bl)) / (mx - mn) : mx === g ? 120 + (60 * (bl - r)) / (mx - mn) : 240 + (60 * (r - g)) / (mx - mn)
          if (((hue % 360) + 360) % 360 >= 10 && ((hue % 360) + 360) % 360 <= 50) n++
        }
      }
      return n
    },
    [png.toString('base64'), brand] as [string, Box[]],
  )
  await page.close()
  if (orange > 0) throw new Error(`${file}: ${orange} orange pixels outside the heatsync brand marks`)
}

async function main() {
  assertBuilt()
  mkdirSync(OUT, { recursive: true })
  const wantTiles = TILES.filter((t) => !ONLY.length || ONLY.some((o) => t.file.startsWith(o)))
  const todo = SHOTS.filter((x, i) => !ONLY.length || ONLY.includes(String(i + 1)) || ONLY.includes(x.file))
  for (const shot of todo) {
    console.log(`\n── ${shot.file} ──`)
    const s = await bootStage({ ...base, ...shot.opts } as StageOpts)
    try {
      await shot.run(s)
      await s.settle()
      // the heatsync icon on the picker button is the brand mark, the one orange the shots may carry
      const brand = await s.p.evaluate(
        ([sel, sc, dy]: [string, number, number]) =>
          [...document.querySelectorAll(sel)].map((e) => {
            const r = e.getBoundingClientRect()
            return { x: Math.floor(r.left * sc) - 2, y: Math.floor(r.top * sc) - 2 + dy, w: Math.ceil(r.width * sc) + 4, h: Math.ceil(r.height * sc) + 4 }
          }),
        [BRAND, SCALE, CAP_H] as [string, number, number],
      )
      const panel = await s.p.screenshot({ type: 'png' })
      const png = await compose(s, panel, shot.caption)
      try {
        await check(s, png, brand, shot.file)
      } catch (e) {
        // FORCE=1 keeps a picture that failed its check, to look at it
        if (!process.env.FORCE) throw e
        console.log(`! ${(e as Error).message} (kept: FORCE=1)`)
      }
      if (s.errors.length) throw new Error(`${shot.file}: page errors: ${s.errors.join(' | ')}`)
      writeFileSync(join(OUT, shot.file), png)
      console.log(`✓ ${shot.file}  "${shot.caption}"`)
    } finally {
      await s.stop()
    }
  }
  if (wantTiles.length) {
    // the marquee's panel is shot the way 01 is, alone, then cropped
    const s = await bootStage({ ...base, ...SHOTS[0].opts } as StageOpts)
    try {
      await SHOTS[0].run(s)
      await s.settle()
      const brand: Box[] = await s.p.evaluate(
        ([sel, sc]: [string, number]) =>
          [...document.querySelectorAll(sel)].map((e) => {
            const r = e.getBoundingClientRect()
            return { x: Math.floor(r.left * sc) - 2 + 640, y: Math.floor(r.top * sc) - 2, w: Math.ceil(r.width * sc) + 4, h: Math.ceil(r.height * sc) + 4 }
          }),
        [BRAND, SCALE] as [string, number],
      )
      const panel = await s.p.screenshot({ type: 'png' })
      for (const t of wantTiles) {
        console.log(`\n── ${t.file} ──`)
        const r = await composeTile(s, t, t.panel ? panel : null)
        await check(s, r.png, [...r.brand, ...(t.panel ? brand : [])], t.file, t.w, t.h)
        if (s.errors.length) throw new Error(`${t.file}: page errors: ${s.errors.join(' | ')}`)
        writeFileSync(join(OUT, t.file), r.png)
        console.log(`✓ ${t.file}  "${TAGLINE}"`)
      }
    } finally {
      await s.stop()
    }
  }
  console.log(`\n✓ ${todo.length} store shot(s) + ${wantTiles.length} tile(s) in ${OUT}`)
}

try {
  await main()
  process.exit(0)
} catch (e) {
  console.error(`\n✗ store shots FAILED: ${(e as Error).message}`)
  process.exit(1)
}

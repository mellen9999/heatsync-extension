/**
 * An emote's centre is the text's centre, whatever height it draws at (parity with heatsync.org's
 * tests/e2e/emote-centre-on-text.spec.ts), in a real browser against the BUILT extension (twitch is
 * never contacted: raw lines come over a local wss mock, every picture is a local stand-in).
 *
 *   bun run build.js chrome --minify && bun scripts/render-emote-centre.ts
 *
 * Measured per case: the picture's rect centre minus the username text's rect centre, in px (must be
 * within 1), and the row's height (must be a whole number of pixels: the bitmap font smears otherwise).
 * Cases: 32/28/21px emote (the emote-size setting), 64px (a big emote-only line), a youtube member
 * emoji (a bare img, as processYtEmotes writes it), a zero-width stack, a unicode emoji; at 13 and 15px text.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from './lib/chromium'
import { startMockIrc } from './lib/mock-irc'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
// four 16x16 frames, 250ms each: the strip the sprite rung plays
const GIF = Buffer.from(
  'R0lGODlhEAAQAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAGQAAACwAAAAAEAAQAAAIHQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFgQEBACH5BAEZAAEALAAAAAAQABAAgQD/AAAAAAAAAAAAAAgdAAEIHEiwoMGDCBMqXMiwocOHECNKnEixosWBAQEAIfkEARkAAQAsAAAAABAAEACBAAD/AAAAAAAAAAAACB0AAQgcSLCgwYMIEypcyLChw4cQI0qcSLGixYEBAQAh+QQBGQABACwAAAAAEAAQAIH//wAAAAAAAAAAAAAIHQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFgQEBADs=',
  'base64',
)
// an 800x32 grey bar: twice as big would be wider than any chat
const WIDE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAyAAAAAgCAYAAADqmBz1AAAArklEQVR42u3XMREAAAgDsUqvc3DBMWSIgd8+bQcAAOBCRAAAAAwIAABgQAAAAAwIAABgQAAAAAwIAABgQAAAAAMCAABgQAAAAAMCAABgQAAAAAMCAAAYEAAAAAMCAAAYEAAAAAMCAAAYEAAAwIAAAAAYEAAAwIAAAAAYEAAAwIAAAAAGBAAAwIAAAAAGBAAAwIAAAAAGBAAAMCBCAAAABgQAADAgAAAABgQAAPhtAZNxqphPe4EfAAAAAElFTkSuQmCC',
  'base64',
)
const CORS = { 'access-control-allow-origin': '*' }
const html =
  '<!doctype html><html><head><title>fixture</title></head><body style="margin:0"><div id="host-content" style="height:100vh">host page</div><div class="right-column right-column--beside" id="rcol"></div></body></html>'
const E = (id: string, rung = '2x') => `https://cdn.7tv.app/emote/${id}/${rung}.webp`

const failures: string[] = []
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failures.push(msg)
}
async function until(p: any, f: () => Promise<boolean>, ms = 20_000) {
  for (let w = 0; w < ms; w += 300) {
    if (await f()) return true
    await p.waitForTimeout(300)
  }
  return false
}

const irc = startMockIrc()
if (!irc) {
  console.log('SKIPPED — openssl missing, no cert for the mock irc server')
  process.exit(0)
}
const prof = mkdtempSync(join(tmpdir(), 'hs-ext-centre-'))
const c = await launchWithExtension(prof, [
  '--window-size=1500,1100',
  `--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1:${irc.port}`,
  '--ignore-certificate-errors',
  '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
])
const errors: string[] = []
try {
  await c.route('https://heatsync.org/**', (r: any) => r.abort())
  for (const h of ['https://api.frankerfacez.com/**', 'https://7tv.io/**', 'https://api.7tv.app/**', 'https://api.betterttv.net/**'])
    await c.route(h, (r: any) => r.abort())
  // the animated picture is a real four-frame gif (any rung of it), the wide one a bar, every other a pixel
  await c.route('https://cdn.7tv.app/**', (r: any) => {
    const u = r.request().url()
    if (u.includes('/SPIN')) return r.fulfill({ status: 200, contentType: 'image/gif', body: GIF, headers: CORS })
    return r.fulfill({ status: 200, contentType: 'image/png', body: u.includes('/WIDE') ? WIDE : PNG, headers: CORS })
  })
  await c.route('https://www.twitch.tv/**', (r: any) => r.fulfill({ status: 200, contentType: 'text/html', body: html }))
  await c.addCookies([
    { name: 'auth-token', value: 'harnesstoken0000', domain: '.twitch.tv', path: '/', secure: true },
    { name: 'login', value: 'probeuser', domain: '.twitch.tv', path: '/', secure: true },
  ])
  let sw = c.serviceWorkers()[0]
  if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 20_000 })
  const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
  const store = await c.newPage()
  await store.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
  await store.evaluate(async () => {
    // @ts-ignore — extension page
    await chrome.storage.local.set({
      heatsync_multichat: { channels: [{ id: 'probechan', twitch: 'probechan', kick: '', youtube: '' }] },
      user_info: { username: 'probeuser' },
      global_emotes: [],
    })
  })
  const room = [
    { name: 'Wlol', url: E('WLOL01'), source: '7tv', hash: 'wlol' },
    { name: 'Wave', url: E('WAVE01'), source: '7tv', hash: 'wave' },
    { name: 'Zap', url: E('ZAP001'), source: '7tv', hash: 'zap', zeroWidth: true },
  ]
  const seedRoom = (tell: boolean) =>
    sw.evaluate(async ([emotes, tell]: [unknown[], boolean]) => {
      // @ts-ignore — service worker globals
      channelEmotesMap['twitch/probechan'] = emotes
      // @ts-ignore
      channelEmotesFetchedAt['twitch/probechan'] = Date.now()
      // @ts-ignore
      await bgPersistChannelEmotes('twitch/probechan')
      // @ts-ignore
      if (tell) broadcastToTabs({ type: 'channel_emotes_update', channelOwner: 'probechan', platform: 'twitch', emotes })
    }, [room, tell] as [unknown[], boolean])
  await seedRoom(false)

  const p = await c.newPage()
  p.on('pageerror', (e: unknown) => errors.push(String(e).slice(0, 300)))
  await p.goto('https://www.twitch.tv/probechan', { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('#hs-mc-messages', { timeout: 30_000 })
  await until(p, async () => irc.frames.some((f) => f.startsWith('JOIN')))
  // every provider fetch is refused, so the background settles on an empty set: hand it the room again
  await p.waitForTimeout(2500)
  await seedRoom(true)
  await p.waitForTimeout(1500)

  let n = 0
  const line = (who: string, text: string, tags = '') =>
    irc.push(
      `@badges=;color=#00FF00;display-name=${who};id=${who}-${++n};room-id=1;tmi-sent-ts=${Date.now()};user-id=${100 + n}${tags} :${who.toLowerCase()}!${who.toLowerCase()}@${who.toLowerCase()}.tmi.twitch.tv PRIVMSG #probechan :${text}\r\n`,
    )
  const idOf = (who: string) => `${who}-${n}`
  const ids: Record<string, string> = {}
  const say = (key: string, who: string, text: string, tags = '') => {
    line(who, text, tags)
    ids[key] = idOf(who)
  }
  await store.evaluate(async () => {
    // @ts-ignore — extension page
    const cur = (await chrome.storage.sync.get('ui_settings')).ui_settings || {}
    // @ts-ignore
    await chrome.storage.sync.set({ ui_settings: { ...cur, bigEmoteLinesOptIn: true } })
  })
  await p.waitForTimeout(1500)
  say('plain', 'Zed', 'hello there')
  say('word', 'Bob', 'hi Wlol')
  say('one', 'Alice', 'Wlol')
  say('stack', 'Carol', 'hi Wlol Zap')
  say('emoji', 'Erin', 'lol 😂')
  say('emojiBig', 'Fred', '😂')
  const rowOf = (key: string) => `#hs-mc-messages .hs-mc-msg[data-msg-id="${ids[key]}"]`
  for (let w = 0; w < 25_000 && !(await p.$(rowOf('emojiBig'))); w += 400) await p.waitForTimeout(400)
  await p.waitForTimeout(2500)

  const plainRow = rowOf('plain')
  type Case = { name: string; key: string; px: number; pic: string; setup?: string }
  const CASES: Case[] = [
    { name: '32px emote', key: 'word', px: 32, pic: '.hs-mc-text .hs-mc-emote-wrapper > img.hs-mc-emote' },
    { name: '28px emote', key: 'word', px: 28, pic: '.hs-mc-text .hs-mc-emote-wrapper > img.hs-mc-emote', setup: '28px' },
    { name: '21px emote', key: 'word', px: 21, pic: '.hs-mc-text .hs-mc-emote-wrapper > img.hs-mc-emote', setup: '21px' },
    { name: '64px big emote-only line', key: 'one', px: 64, pic: '.hs-mc-text .hs-mc-emote-wrapper > img.hs-mc-emote' },
    { name: 'youtube member emoji', key: 'word', px: 32, pic: 'img.yt-probe', setup: 'yt' },
    { name: 'zero-width stack', key: 'stack', px: 32, pic: '.hs-mc-emote-stack .hs-mc-emote-stack-emotes > .hs-mc-emote-wrapper:first-child > img.hs-mc-emote' },
    { name: 'unicode emoji', key: 'emoji', px: 0, pic: '.hs-mc-emoji' },
    { name: 'big emoji-only line', key: 'emojiBig', px: 0, pic: '.hs-mc-emoji' },
  ]
  for (const font of [10, 13, 15, 20, 26]) {
    for (const cs of CASES) {
      const r = await p.evaluate(
        ([sel, pic, font, setup, plainSel]: [string, string, number, string, string]) => {
          const row = document.querySelector(sel) as HTMLElement
          row.style.setProperty('--hs-chat-font', `${font}px`)
          if (setup.endsWith('px')) row.style.setProperty('--hs-emote-size', setup)
          let yt: HTMLImageElement | null = null
          if (setup === 'yt') {
            yt = document.createElement('img')
            yt.className = 'hs-mc-emote yt-probe'
            yt.alt = ':x:'
            yt.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
            row.querySelector('.hs-mc-text')!.append(' ', yt)
          }
          const plain = document.querySelector(plainSel) as HTMLElement
          plain.style.setProperty('--hs-chat-font', `${font}px`)
          void row.offsetHeight
          const name = row.querySelector('.hs-mc-user')!
          const rg = document.createRange()
          rg.selectNodeContents(name)
          const t = rg.getBoundingClientRect()
          const el = row.querySelector(pic) as HTMLElement
          const i = el.getBoundingClientRect()
          // an img carries 2px of padding (content-box): the picture is the content
          const cs = getComputedStyle(el)
          const padT = el.tagName === 'IMG' ? parseFloat(cs.paddingTop) : 0
          const h = el.tagName === 'IMG' ? parseFloat(cs.height) : i.height
          const out = { d: i.top + padT + h / 2 - (t.top + t.height / 2), h, rowH: row.getBoundingClientRect().height, plainH: plain.getBoundingClientRect().height }
          yt?.remove()
          plain.style.removeProperty('--hs-chat-font')
          row.style.removeProperty('--hs-chat-font')
          row.style.removeProperty('--hs-emote-size')
          return out
        },
        [rowOf(cs.key), cs.pic, font, cs.setup ?? '', plainRow] as [string, string, number, string, string],
      )
      console.log(`  ${cs.name} @${font}px: d=${r.d.toFixed(2)} h=${r.h} row=${r.rowH}`)
      if (cs.px) check(Math.abs(r.h - cs.px) <= 0.5, `${cs.name} @${font}px: the picture is the height under test (${r.h}px, want ${cs.px})`)
      check(Math.abs(r.d) <= 1, `${cs.name} @${font}px: centre sits ${r.d.toFixed(2)}px from the text centre`)
      // an emote row is its emote's whole pixels; a row the TEXT is taller than (a 21px emote at 26px text)
      // keeps the text row's own fraction. Never a fraction the emote added.
      const frac = (n: number) => Math.abs(n - Math.round(n))
      check(frac(r.rowH) < 0.01 || frac(r.rowH - r.plainH) < 0.01, `${cs.name} @${font}px: row is a whole number of pixels (${r.rowH}px, a plain row ${r.plainH}px)`)
    }
  }
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`)
} finally {
  try {
    await Promise.race([c.close(), new Promise((r) => setTimeout(r, 8000))])
  } catch (_) {}
  irc.stop()
  rmSync(prof, { recursive: true, force: true })
}
if (failures.length) {
  console.error(`\n✗ ${failures.length} emote centre check(s) failed`)
  process.exit(1)
}
console.log('\n✓ emote centre checks passed')
process.exit(0)

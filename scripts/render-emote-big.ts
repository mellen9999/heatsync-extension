/**
 * Big emote-only lines, in a real browser, against the BUILT extension (twitch is never contacted:
 * raw lines come over a local wss mock, every picture is a local stand-in).
 *
 *   bun run build.js chrome --minify && bun scripts/render-emote-big.ts
 *
 * The rule is shared/emote-only.ts (every app runs its vectors); this is the extension drawing it:
 *   a. one emote on a plain line: its img is 2x the height of the same emote in a line with a word,
 *      at the next rung up (1x file -> 2x file)
 *   b. five emotes are big, six are not; an emoji-only line draws its emoji twice as big
 *   c. a reply's body and a /me line are plain rows: big
 *   d. a first-message row (filled) and a resub with a message (filled) stay normal
 *   e. a very wide emote never runs past the row
 *   f. one clock: a big animated emote and the same emote at normal size are on the same frame at the
 *      same instant, sampled several times while it plays (and the frame does move)
 *   g. the setting off: every one of those lines is drawn as it was (no mark, no scale, 1x file)
 *   h. the setting back on: big again
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
const prof = mkdtempSync(join(tmpdir(), 'hs-ext-big-'))
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
    { name: 'Wide', url: E('WIDE01'), source: '7tv', hash: 'wide' },
    { name: 'Spin', url: E('SPIN01'), source: '7tv', hash: 'spin', animated: true },
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
  say('one', 'Alice', 'Wlol')
  say('word', 'Bob', 'hi Wlol')
  say('five', 'Carol', 'Wlol Wave Wlol Wave Wlol')
  say('six', 'Dave', 'Wlol Wave Wlol Wave Wlol Wave')
  say('emoji', 'Erin', '😂😂😂')
  say('emojiWord', 'Fred', 'lol 😂')
  say('first', 'Gina', 'Wlol', ';first-msg=1')
  say('reply', 'Hank', 'Wlol', ';reply-parent-msg-id=x1;reply-parent-user-id=7;reply-parent-user-login=bob;reply-parent-display-name=Bob;reply-parent-msg-body=hello\\sthere')
  say('me', 'Iris', '\u0001ACTION Wlol\u0001')
  say('wide', 'Jack', 'Wide')
  say('spinBig', 'Kate', 'Spin')
  say('spinNormal', 'Liam', 'hi Spin')
  // a resub that carries a line its sender typed: a filled event row, then their line under it
  irc.push(
    `@badges=;color=#00FF00;display-name=Resubber;login=resubber;msg-id=resub;msg-param-cumulative-months=7;msg-param-sub-plan=1000;system-msg=Resubber\\ssubscribed\\sat\\sTier\\s1.;user-id=902;id=resub-1;room-id=1;tmi-sent-ts=${Date.now()} :tmi.twitch.tv USERNOTICE #probechan :Wlol\r\n`,
  )
  ids.resub = 'resub-1'
  const rowOf = (key: string) => `#hs-mc-messages .hs-mc-msg[data-msg-id="${ids[key]}"]`
  const here = async (key: string) => !!(await p.$(rowOf(key)))
  for (let w = 0; w < 25_000 && !(await here('spinNormal')) ; w += 400) await p.waitForTimeout(400)
  await p.waitForTimeout(2500)

  const read = (key: string) =>
    p.evaluate((sel: string) => {
      const row = document.querySelector(sel) as HTMLElement | null
      if (!row) return null
      const img = row.querySelector('.hs-mc-text .hs-mc-emote-wrapper > img.hs-mc-emote') as HTMLImageElement | null
      const wrap = img?.parentElement as HTMLElement | null
      const emoji = row.querySelector('.hs-mc-text .hs-mc-emoji') as HTMLElement | null
      const rowRect = row.getBoundingClientRect()
      return {
        big: row.classList.contains('hs-emote-big'),
        scale: row.style.getPropertyValue('--hs-big'),
        filled: row.classList.contains('hs-filled'),
        imgs: row.querySelectorAll('.hs-mc-text .hs-mc-emote-wrapper > img.hs-mc-emote').length,
        imgH: img ? parseFloat(getComputedStyle(img).height) : 0,
        wrapH: wrap ? wrap.getBoundingClientRect().height : 0,
        wrapW: wrap ? wrap.getBoundingClientRect().width : 0,
        url: wrap?.dataset.emoteUrl || '',
        pinned: wrap?.style.width || '',
        emojiPx: emoji ? parseFloat(getComputedStyle(emoji).fontSize) : 0,
        rowW: rowRect.width,
      }
    }, rowOf(key))
  const R: Record<string, any> = {}
  const readAll = async () => {
    for (const k of Object.keys(ids)) R[k] = await read(k)
  }
  await readAll()
  for (const k of Object.keys(ids)) if (!R[k]) check(false, `${k}: the row never arrived`)

  // a. one emote on a plain line vs the same emote beside a word
  const one = R.one
  const word = R.word
  check(!!one && !!word, 'a. both rows are on screen')
  check(one.big && one.scale === '2', `a. the one-emote line carries the mark (class ${one.big}, scale ${JSON.stringify(one.scale)})`)
  check(!word.big && word.scale === '', 'a. the line with a word carries none')
  check(word.imgH === 32 && one.imgH === 2 * word.imgH, `a. its img is twice as tall: ${one.imgH}px vs ${word.imgH}px`)
  check(one.wrapH === 2 * (word.wrapH - 4) + 4, `a. its reserved box is twice as tall (plus the same 4px of padding): ${one.wrapH}px vs ${word.wrapH}px`)
  check(one.url.includes('/WLOL01/') && word.url.includes('/WLOL01/'), 'a. both draw the same emote')
  check(word.url.endsWith('/1x.webp') && one.url.endsWith('/2x.webp'), `a. the big one takes the next rung up (${word.url.split('/').pop()} -> ${one.url.split('/').pop()})`)
  // the box width is learned from the normal copy once it has loaded: then it is reserved at exactly twice
  // (the padding does not scale); before that it is left to the img, as a normal first sighting is
  check(
    [R.one, R.five].every((r) => r.pinned === '' || r.pinned === `${2 * (word.wrapW - 4) + 4}px`),
    `a. a big box is unpinned or reserved at exactly twice the normal one (got ${JSON.stringify([R.one.pinned, R.five.pinned])}, normal ${word.wrapW}px)`,
  )

  // b. five and six; emoji
  check(R.five.big && R.five.imgs === 5 && R.five.imgH === 64, `b. five emotes are big (img ${R.five.imgH}px)`)
  check(!R.six.big && R.six.imgs === 6 && R.six.imgH === 32, `b. six emotes stay normal (img ${R.six.imgH}px)`)
  check(R.emoji.big && R.emoji.emojiPx === 2 * R.emojiWord.emojiPx && R.emojiWord.emojiPx > 0, `b. an emoji-only line draws its emoji twice as big (${R.emoji.emojiPx}px vs ${R.emojiWord.emojiPx}px)`)

  // c. a reply's body and a /me line are plain rows
  check(R.reply.big && R.reply.imgH === 64, `c. a reply's body is big (img ${R.reply.imgH}px)`)
  check(R.me.big && R.me.imgH === 64, `c. a /me line is big (img ${R.me.imgH}px)`)

  // d. filled rows
  check(R.first.filled && !R.first.big && R.first.imgH === 32, `d. a first-message row (filled) is normal (img ${R.first.imgH}px, filled ${R.first.filled})`)
  check(R.resub.filled && !R.resub.big && R.resub.imgH === 32, `d. a resub with a typed line (filled) is normal (img ${R.resub.imgH}px, filled ${R.resub.filled})`)

  // e. a wide emote is held to the row
  check(R.wide.big && R.wide.wrapW > 0 && R.wide.wrapW <= R.wide.rowW, `e. a very wide big emote stays inside its row (${Math.round(R.wide.wrapW)}px in ${Math.round(R.wide.rowW)}px)`)

  // f. one clock. A frame is read off the running strip: its column and row of the grid.
  const frames = () =>
    p.evaluate(([big, normal]: [string, string]) => {
      const frameOf = (sel: string) => {
        const wrap = document.querySelector(`${sel} .hs-mc-text .hs-mc-emote-wrapper`) as HTMLElement | null
        const i = wrap?.querySelector('.hs-sprite > i') as HTMLElement | null
        if (!wrap || !i) return null
        const cols = +i.style.getPropertyValue('--hs-sp-cols')
        const rows = +i.style.getPropertyValue('--hs-sp-rows')
        const tx = new DOMMatrixReadOnly(getComputedStyle(i).transform === 'none' ? undefined : getComputedStyle(i).transform).m41
        const ty = parseFloat((getComputedStyle(i).translate || '0 0').split(' ')[1] || '0') || 0
        const col = Math.round((-tx / i.offsetWidth) * cols)
        const row = Math.round((-ty / i.offsetHeight) * rows)
        return { frame: row * cols + col, cols, rows, w: Math.round(wrap.getBoundingClientRect().width), animated: wrap.dataset.animated === '1' }
      }
      return { big: frameOf(big), normal: frameOf(normal) }
    }, [rowOf('spinBig'), rowOf('spinNormal')])
  const mounted = await until(p, async () => {
    const f = await frames()
    return !!f.big && !!f.normal
  }, 25_000)
  check(mounted, 'f. both copies of the animated emote are playing a strip')
  if (mounted) {
    const first = await frames()
    check(first.big.w === 2 * (first.normal.w - 4) + 4, `f. the big copy's box is twice the normal one (${first.big.w}px vs ${first.normal.w}px)`)
    const seen = new Set<number>()
    let same = 0
    const SAMPLES = 24
    for (let k = 0; k < SAMPLES; k++) {
      const f = await frames()
      seen.add(f.big.frame)
      if (f.big.frame === f.normal.frame) same++
      await p.waitForTimeout(110)
    }
    check(same === SAMPLES, `f. the big and the normal copy are on the same frame at the same instant (${same} of ${SAMPLES} samples)`)
    check(seen.size >= 3, `f. and the frame moves: ${seen.size} different frames seen over ${SAMPLES} samples`)
  }
  if (process.env.SHOT) await p.locator('#hs-mc-messages').screenshot({ path: process.env.SHOT })

  // g. the setting off: every line drawn as it was
  const setIt = async (on: boolean) => {
    await store.evaluate(async (on: boolean) => {
      // @ts-ignore — extension page
      const cur = (await chrome.storage.sync.get('ui_settings')).ui_settings || {}
      // @ts-ignore
      await chrome.storage.sync.set({ ui_settings: { ...cur, bigEmoteLines: on } })
    }, on)
  }
  await setIt(false)
  const settled = await until(p, async () => !(await read('one'))?.big, 15_000)
  check(settled, 'g. turning the setting off takes the mark off the rows already on screen')
  await readAll()
  const off = R
  check(
    ['one', 'five', 'reply', 'me', 'wide'].every((k) => !off[k].big && off[k].scale === '') && off.one.imgH === 32 && off.five.imgH === 32 && off.reply.imgH === 32 && off.me.imgH === 32,
    `g. every line is drawn at one size again (img ${['one', 'five', 'reply', 'me'].map((k) => off[k].imgH).join('/')}px)`,
  )
  check(off.one.url.endsWith('/1x.webp') && off.one.wrapH === word.wrapH, `g. at the normal rung and the normal box (${off.one.url.split('/').pop()}, ${off.one.wrapH}px)`)
  check(off.emoji.emojiPx === off.emojiWord.emojiPx, `g. emoji at one size (${off.emoji.emojiPx}px vs ${off.emojiWord.emojiPx}px)`)

  // h. back on
  await setIt(true)
  const back = await until(p, async () => !!(await read('one'))?.big, 15_000)
  await readAll()
  check(back && R.one.imgH === 64 && R.five.imgH === 64 && !R.six.big, `h. back on: big again (img ${R.one.imgH}px), six still normal`)
  // by now the normal copy has loaded and its box is learned: the rebuilt big row reserves exactly twice of it
  check(R.one.pinned === `${2 * (R.word.wrapW - 4) + 4}px`, `h. the rebuilt big box is reserved at twice the learned normal one (${R.one.pinned} for ${R.word.wrapW}px)`)
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`)
} finally {
  try {
    await Promise.race([c.close(), new Promise((r) => setTimeout(r, 8000))])
  } catch (_) {}
  irc.stop()
  rmSync(prof, { recursive: true, force: true })
}
if (failures.length) {
  console.error(`\n✗ ${failures.length} big emote line check(s) failed`)
  process.exit(1)
}
console.log('\n✓ big emote line checks passed')
process.exit(0)

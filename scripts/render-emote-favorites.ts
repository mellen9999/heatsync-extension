/**
 * Favorite emotes, in a real browser, against the BUILT extension.
 *
 *   bun run test:emotes   (builds dist/chrome in THIS checkout, then runs this after the collision checks)
 *
 * A signed-in viewer whose account list already holds one picture this channel has never heard of
 * (AwayFav). heatsync.org is unreachable for the whole run, so every pin is the offline case: kept
 * on this device and marked unsent.
 *   a. the picker opens on favorites, and the away favorite is there, drawn from its record; a tile's
 *      hover text says who sees it
 *   b. shift + right-click a channel emote -> "add to favorites" -> it joins the section, after AwayFav
 *   c. the pin is on this device, marked unsent (the account could not be reached)
 *   d. "Awa" + Tab -> the away favorite leads, and the chip is its picture
 *   e. clicking the away tile puts its picture in the box and asks the server for nothing
 *   f. sending that line draws the picture on the viewer's own row, and only then asks to add it
 *   g. the favorite's own menu unpins it
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from './lib/chromium'
import { startMockIrc } from './lib/mock-irc'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
const E = (n: string) => `https://cdn.heatsync.org/emote/${n}.png`
// one 7tv picture the room holds and the viewer owns too
const BIGDOG = 'https://cdn.7tv.app/emote/01BIGDOGBIGDOGBIGDOGBIGD/2x.webp'
// twitch's own picture the room draws, and the same picture in your set at another size
const KAPPA = 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0'
const body = '<div id="host-content" style="height:100vh">host page</div><div class="right-column right-column--beside" id="rcol"></div>'
const html = `<!doctype html><html><head><title>fixture</title></head><body style="margin:0">${body}</body></html>`

const failures: string[] = []
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failures.push(msg)
}
async function until(p: any, f: () => Promise<boolean>, ms = 20_000) {
  for (let w = 0; w < ms; w += 400) {
    if (await f()) return true
    await p.waitForTimeout(400)
  }
  return false
}

const irc = startMockIrc()
if (!irc) {
  console.log('SKIPPED — openssl missing, no cert for the mock irc server')
  process.exit(0)
}
const prof = mkdtempSync(join(tmpdir(), 'hs-ext-fav-'))
const c = await launchWithExtension(prof, [
  '--window-size=1500,900',
  // heatsync.org resolves nowhere: nothing in this run can reach the real site
  `--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1:${irc.port}, MAP heatsync.org 127.0.0.1:9`,
  '--ignore-certificate-errors',
  '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
])
const errors: string[] = []
// every request to add an emote to the viewer's set, whoever makes it
const adds: string[] = []
try {
  await c.route('https://heatsync.org/**', (r: any) => {
    const req = r.request()
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/user/emotes') adds.push(req.postData() || '')
    return r.abort()
  })
  for (const h of ['https://api.frankerfacez.com/**', 'https://7tv.io/**', 'https://api.7tv.app/**', 'https://api.betterttv.net/**'])
    await c.route(h, (r: any) => r.abort())
  await c.route('https://cdn.7tv.app/**', (r: any) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await c.route('https://cdn.heatsync.org/**', (r: any) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await c.route('https://static-cdn.jtvnw.net/**', (r: any) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
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
  const stored = (keys: string[]) =>
    store.evaluate(async (k: string[]) => {
      // @ts-ignore — extension page
      return await chrome.storage.local.get(k)
    }, keys)
  await store.evaluate(async (u: Record<string, string>) => {
    // @ts-ignore — extension page
    await chrome.storage.local.set({
      heatsync_multichat: { channels: [{ id: 'probechan', twitch: 'probechan', kick: '', youtube: '' }] },
      // signed in, as the overlay reads it; the list is this account's
      auth_token: 'harnesstoken0000',
      user_info: { id: 7, username: 'probeuser' },
      emote_favorites: [{ name: 'AwayFav', url: u.Away_fav, provider: 'hs' }],
      emote_favorites_owner: '7',
      global_emotes: [],
      // BigDog is in the room's 7tv set AND your own set, as one picture (two sizes of it)
      emote_inventory: [
        { name: 'Mine', url: u.Mine_inv, source: 'heatsync', hash: 'minehash' },
        { name: 'BigDog', url: u.BigDog_inv, source: '7tv', hash: 'bigdoghash' },
        { name: 'KappaNat', url: u.Kappa_inv, source: 'twitch', hash: 'kappaownhash' },
      ],
    })
  }, { ...Object.fromEntries(['Away_fav', 'Mine_inv'].map((n) => [n, E(n)])), BigDog_inv: BIGDOG.replace('2x', '1x'), Kappa_inv: KAPPA.replace('2.0', '1.0') })
  const room = [
    { name: 'Wlol', url: E('Wlol_room'), source: '7tv', hash: 'wlolroomhash' },
    { name: 'Awake', url: E('Awake_room'), source: '7tv', hash: 'awakeroomhash' },
    { name: 'KappaNat', url: KAPPA, source: 'twitch', hash: 'kapparoomhash' },
    { name: 'BigDog', url: BIGDOG, source: '7tv', id: '01BIGDOGBIGDOGBIGDOGBIGD' },
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
  // what you sent last: BigDog's picture, drawn in the recents row too
  await p.addInitScript(() => localStorage.setItem('hs-mc-recent-emotes', JSON.stringify(['BigDog\ncdn.7tv.app/01BIGDOGBIGDOGBIGDOGBIGD'])))
  await p.goto('https://www.twitch.tv/probechan', { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('#hs-mc-input', { timeout: 25_000 })
  await until(p, async () => irc.frames.some((f) => f.startsWith('JOIN')))
  // every provider fetch is refused, so the background settles on an empty set: hand it the room again
  await p.waitForTimeout(2500)
  await seedRoom(true)
  await p.waitForTimeout(1500)

  const PICKER = '#hs-mc-emote-picker'
  const openPicker = async () => {
    if (!(await p.$(`${PICKER}.visible`))) await p.click('#hs-mc-emote-btn', { timeout: 5000 })
    await p.waitForSelector(`${PICKER}.visible`, { timeout: 10_000 })
  }
  const closePicker = async () => {
    if (await p.$(`${PICKER}.visible`)) await p.click('#hs-mc-emote-btn', { timeout: 5000 }).catch(() => {})
    await until(p, async () => !(await p.$(`${PICKER}.visible`)), 5000)
  }
  const sections = () => p.$$eval(`${PICKER} [data-section-key]`, (els: HTMLElement[]) => els.map((x) => x.dataset.sectionKey))
  const favs = () =>
    p.$$eval(`${PICKER} [data-section-key="favorite"] .hs-mc-picker-emote-wrap img`, (els: HTMLImageElement[]) =>
      els.map((x) => `${x.alt} ${(x.getAttribute('src') || '').split('/').pop()} ${x.dataset.state}`),
    )
  // a row's name is its label: the digit beside it is a key hint for the eye
  const menu = () => p.$$eval('#hs-mc-msg-ctx [role="menuitem"] .hs-mc-em-label', (els: HTMLElement[]) => els.map((x) => (x.textContent || '').trim()))
  const pickMenu = async (label: string) => {
    await until(p, async () => (await menu()).includes(label), 5000)
    await p.click(`#hs-mc-msg-ctx [role="menuitem"] .hs-mc-em-label:text-is("${label}")`, { timeout: 5000 })
  }

  // a. the account's list leads the picker, and a picture this channel has never had is still there
  await openPicker()
  await until(p, async () => (await favs()).length > 0, 8000)
  check((await sections())[0] === 'favorite', `a. favorites are the picker's first section (got ${JSON.stringify(await sections())})`)
  const a = await favs()
  check(a.length === 1 && a[0] === 'AwayFav Away_fav.png remote', `a. the away favorite is drawn from its record (got ${JSON.stringify(a)})`)

  // b. pin the channel's Wlol from its menu
  const roomTile = `${PICKER} .hs-mc-picker-section:not([data-section-key="favorite"]) .hs-mc-picker-emote-wrap img[alt="Wlol"]`
  await p.waitForSelector(roomTile, { timeout: 8000 })
  // a tile's hover text says who sees it: the room's 7tv emote, and a picture not loaded in this room
  const tip = (sel: string) => p.$eval(sel, (x: HTMLImageElement) => x.title)
  const roomTip = await tip(roomTile)
  check(roomTip === 'Wlol (7tv · 7tv users)', `a. the room's tile says who sees it (got ${JSON.stringify(roomTip)})`)
  const awayTip = await tip(`${PICKER} [data-section-key="favorite"] .hs-mc-picker-emote-wrap img[alt="AwayFav"]`)
  check(awayTip.endsWith(' · heatsync only)'), `a. the away favorite's tile says heatsync only (got ${JSON.stringify(awayTip)})`)
  // and wears the corner mark for it: 7 on the room's 7tv tile, H on the heatsync-only favorite, drawn
  // white on a black cutout by the one ::after rule
  const markOf = (sel: string) =>
    p.$eval(sel, (x: Element) => {
      const w = x.closest('.hs-mc-picker-emote-wrap') as HTMLElement
      const c = getComputedStyle(w, '::after')
      return { mark: w.dataset.mark ?? null, content: c.content, color: c.color, bg: c.backgroundColor, radius: c.borderTopLeftRadius }
    })
  const roomMark = await markOf(roomTile)
  check(roomMark.mark === '7' && roomMark.content === '"7"', `a. the room's 7tv tile is marked 7 (got ${JSON.stringify(roomMark)})`)
  check(roomMark.color === 'rgb(255, 255, 255)' && roomMark.bg === 'rgb(0, 0, 0)' && roomMark.radius === '0px', `a. the mark is white on black, square (got ${JSON.stringify(roomMark)})`)
  const awayMark = await markOf(`${PICKER} [data-section-key="favorite"] .hs-mc-picker-emote-wrap img[alt="AwayFav"]`)
  check(awayMark.mark === 'H', `a. the heatsync-only favorite is marked H (got ${JSON.stringify(awayMark)})`)
  // the law: sending BigDog here ships the room's 7tv picture, and your own copy of it is that same picture,
  // so every BigDog tile says 7 (7tv users), never H
  const bigMarks = await p.$$eval(`${PICKER} .hs-mc-picker-emote-wrap img[alt="BigDog"]`, (els: HTMLImageElement[]) =>
    els.map((x) => (x.closest('.hs-mc-picker-emote-wrap') as HTMLElement).dataset.mark ?? null),
  )
  check(bigMarks.length > 0 && bigMarks.every((m: string | null) => m === '7'), `a. every BigDog tile (room + yours, one picture) is marked 7 (got ${JSON.stringify(bigMarks)})`)
  // a platform's own emote wears its platform's letter: twitch's tile says T, in the same white-on-black corner
  const natMark = await markOf(`${PICKER} .hs-mc-picker-emote-wrap img[alt="KappaNat"]`)
  check(natMark.mark === 'T' && natMark.content === '"T"' && natMark.bg === 'rgb(0, 0, 0)', `a. a twitch-native tile is marked T (got ${JSON.stringify(natMark)})`)
  // one picture, one mark in every section: BigDog is in the recents row and the room,
  // twitch's own picture in the room and your set at another size: T in each
  const bigWhere = await p.$$eval(`${PICKER} .hs-mc-picker-emote-wrap img[alt="BigDog"]`, (els: HTMLImageElement[]) =>
    els.map((x) => x.closest('[data-section-key]')?.getAttribute('data-section-key')),
  )
  check(bigWhere.includes('recent') && bigWhere.includes('channel'), `a. BigDog is drawn in recents and the room (got ${JSON.stringify(bigWhere)})`)
  const natMarks = await p.$$eval(`${PICKER} .hs-mc-picker-emote-wrap img[alt="KappaNat"]`, (els: HTMLImageElement[]) =>
    els.map((x) => (x.closest('.hs-mc-picker-emote-wrap') as HTMLElement).dataset.mark ?? null),
  )
  check(natMarks.length >= 1 && natMarks.every((m: string | null) => m === 'T'), `a. every KappaNat tile is marked T, your copy at another size is no won't-show cross (got ${JSON.stringify(natMarks)})`)
  const mineMark = await markOf(`${PICKER} .hs-mc-picker-emote-wrap img[alt="Mine"]`)
  check(mineMark.mark === 'H', `a. a name only your set has stays H (got ${JSON.stringify(mineMark)})`)
  await p.click(roomTile, { button: 'right', modifiers: ['Shift'] })
  const m1 = await (await until(p, async () => (await menu()).length > 0, 5000), menu())
  check(m1[0] === 'add to favorites', `b. the emote menu leads with the pin row (got ${JSON.stringify(m1.slice(0, 3))})`)
  await pickMenu('add to favorites')
  await closePicker()
  await openPicker()
  await until(p, async () => (await favs()).length === 2, 8000)
  const b = await favs()
  check(
    b.length === 2 && b[0].startsWith('AwayFav ') && b[1].startsWith('Wlol Wlol_room') && !b[1].endsWith(' remote'),
    `b. the pinned emote joins the section after the earlier favorite, as the channel's own tile (got ${JSON.stringify(b)})`,
  )

  // c. kept on this device, and marked as not yet on the account
  const kept = await stored(['emote_favorites', 'emote_favorites_unsent'])
  check(
    (kept.emote_favorites || []).map((f: any) => `${f.name} ${f.url}`).join('|') === `AwayFav ${E('Away_fav')}|Wlol ${E('Wlol_room')}`,
    `c. the list on this device holds both, each at its real url (got ${JSON.stringify(kept.emote_favorites)})`,
  )
  check(kept.emote_favorites_unsent === true, 'c. the account was unreachable, so the pin is marked unsent')
  await closePicker()

  // d. Tab: the favorite leads the room's emote that also starts with it
  const chipSrc = () => p.evaluate(() => (document.querySelector('#hs-mc-input img') as HTMLImageElement | null)?.getAttribute('src') || '')
  const typeLine = async (text: string) => {
    await p.click('#hs-mc-input', { timeout: 5000 })
    await p.keyboard.press('Control+A')
    await p.keyboard.press('Backspace')
    await p.keyboard.type(text, { delay: 30 })
  }
  await typeLine('fav1 Awa')
  await p.keyboard.press('Tab')
  await until(p, async () => !!(await chipSrc()), 5000)
  const d = await chipSrc()
  check(d.includes('Away_fav'), `d. "Awa" + Tab starts at the favorite, over the room's Awake (got ${d || 'no chip'})`)
  await typeLine('')

  // e. a click on the away tile is a pick, never an add
  await openPicker()
  await until(p, async () => (await favs()).length === 2, 8000)
  const before = adds.length
  await p.click(`${PICKER} [data-section-key="favorite"] .hs-mc-picker-emote-wrap img[alt="AwayFav"]`, { timeout: 5000 })
  await until(p, async () => (await chipSrc()).includes('Away_fav'), 5000)
  check((await chipSrc()).includes('Away_fav'), `e. the click put the favorite's picture in the box (got ${(await chipSrc()) || 'no chip'})`)
  await p.waitForTimeout(1500)
  check(adds.length === before, `e. the click asked the server to add nothing (${adds.length - before} request(s))`)
  await closePicker()

  // f. the line ships the picture; the add is asked for as it leaves
  await p.click('#hs-mc-input', { timeout: 5000 })
  await p.keyboard.press('End')
  await p.keyboard.type(' fav2', { delay: 30 })
  await p.keyboard.press('Enter')
  const rowSrc = () =>
    p.evaluate(() => {
      const row = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].find((r) => (r.textContent || '').includes('fav2'))
      return (row?.querySelector('.hs-mc-emote-wrapper img, img.hs-mc-emote') as HTMLImageElement | null)?.getAttribute('src') || ''
    })
  await until(p, async () => !!(await rowSrc()), 10_000)
  check(irc.frames.some((f) => f.startsWith('PRIVMSG #probechan') && f.includes('AwayFav')), 'f. the line went out with the bare word')
  check((await rowSrc()).includes('Away_fav'), `f. the viewer's own row draws the favorite (got ${(await rowSrc()) || 'nothing'})`)
  await until(p, async () => adds.length > before, 8000)
  check(adds.length > before && adds[adds.length - 1].includes('AwayFav'), `f. sending the line is what asks to add it (${adds.length - before} request(s))`)

  // g. unpin from the favorite's own tile
  await openPicker()
  await until(p, async () => (await favs()).length === 2, 8000)
  await p.click(`${PICKER} [data-section-key="favorite"] .hs-mc-picker-emote-wrap img[alt="Wlol"]`, { button: 'right', modifiers: ['Shift'] })
  await pickMenu('remove from favorites')
  await closePicker()
  await openPicker()
  await until(p, async () => (await favs()).length === 1, 8000)
  const g = await favs()
  check(g.length === 1 && g[0].startsWith('AwayFav '), `g. the unpinned emote left the section (got ${JSON.stringify(g)})`)
  const left = await stored(['emote_favorites'])
  check((left.emote_favorites || []).length === 1, `g. and the list on this device (got ${JSON.stringify(left.emote_favorites)})`)

  if (errors.length) failures.push(`page errors: ${errors.join(' | ')}`)
} finally {
  try {
    await Promise.race([c.close(), new Promise((r) => setTimeout(r, 8000))])
  } catch (_) {}
  irc.stop()
  rmSync(prof, { recursive: true, force: true })
}
if (failures.length) {
  console.error(`\n✗ ${failures.length} favorites check(s) failed`)
  process.exit(1)
}
console.log('\n✓ favorites checks passed')
process.exit(0)

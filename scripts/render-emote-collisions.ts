/**
 * Same-name emote collisions, in a real browser, against the BUILT extension.
 *
 *   bun run test:emotes   (builds dist/chrome in THIS checkout, then runs this)
 *
 * The word W exists in the channel (ffz + 7tv + bttv: three pictures), in globals and in the
 * viewer's inventory — six distinct urls. Raw PRIVMSGs come over a local wss mock (twitch is
 * never contacted). What a line draws (the emote law, read):
 *   a. another chatter's bare W             -> the channel ffz W
 *   b. a line with an IRC emotes= tag on W  -> the twitch emote
 *   c. a chatter who owns a W of their own  -> still the channel's W (their set is below the room)
 *   d. that chatter's Solo, which the room has no emote for -> their picture
 * and three lines already in the channel's history when the tab opens:
 *   i. one whose sender picked a W of their own (the server's record) -> their pick, not the channel's
 *   j. one whose picked W was taken down since                      -> the word, no emote
 *   k. one with no record                                          -> the channel's W
 * then the kick channel of the same name loads a W of its own and a KiOnly: a twitch row still
 * draws twitch's W, and KiOnly is text there (each platform's row reads its own emotes).
 * What the viewer sends (the emote law, send + offer), with Wlol in the channel AND in their
 * inventory as two pictures:
 *   e. Wlol typed by hand                   -> the chip and the sent row are the channel's
 *   f. Wlol + Tab, Tab                      -> the second copy is theirs; it ships and their row draws it
 *   g. Wlol typed by hand in the next line  -> the channel's again: a pick dies with its message
 *   h. the picker's recents                 -> both pictures of Wlol, as sent, the last one first
 * A right-click on an emote in the box acts on the picture the box shows, as it does on a chat line:
 *   n. the channel's Wlol typed in the box (a name the viewer also owns) -> that picture is
 *      blocked, the viewer's own Wlol is NOT removed; a second right-click unblocks it
 *   o. blocking the channel's Wlol on a chat line never dashes a box chip of the viewer's own Wlol
 *   p. the viewer's own Wlol in the box -> removed from their set; the chip is read again and is
 *      the channel's, which is what the line then ships
 *   q. an emote only the viewer has, removed from the box -> the word is text again (as it ships)
 *   r. the channel's W changes while its chip sits in the box -> the row sent is the picture the
 *      box showed at enter, whichever that was
 * Modifiers (shared/emote-mods.vectors.json is the rule): one emote changes, the same one in the
 * box, on the wire and on the row:
 *   s. a chatter's `Wlol w! Wlol` widens the second, `Wlol ffzX Wlol` flips the first, a word
 *      never reaches over text, `constructor` after an emote stays on the line
 *   t. `Wlol w! ` typed in the box widens that chip; another emote typed after it keeps its own
 *      look; the line goes out `w! Wlol Wlol` and the row is what the box showed
 *   u. `w! Wlol ` typed in the box widens the emote after the word
 *   v. a word with no emote beside it stays as typed
 *   w. 40 seeded random lines (HS_RANDOM_LINES for more) of the room's emotes, modifier words
 *      and ordinary words, typed a key at a time: each row is the rule's reading of the text
 *      that went out, and what the box showed at enter. every other one is sent straight after
 *      its last word, before the box has taken it
 * then right-click another chatter's W: it is blocked, the viewer's own W is NOT removed, and
 * only that exact emote hides.
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
const prof = mkdtempSync(join(tmpdir(), 'hs-ext-collide-'))
const c = await launchWithExtension(prof, [
  '--window-size=1500,900',
  `--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1:${irc.port}`,
  '--ignore-certificate-errors',
  '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
])
const errors: string[] = []
try {
  await c.route('https://heatsync.org/**', (r: any) => r.abort())
  // the viewer is signed in (the auth cookie below), so a block or an unblock is the server's to
  // take: it says yes, as it does for a signed-in viewer
  await c.route('https://heatsync.org/api/user/emotes/block', (r: any) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' }))
  await c.route('https://heatsync.org/api/user/emotes/blocked/**', (r: any) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' }))
  // the sender set for chatter 222: their own W (a name the room has) and Solo (a name it has not)
  await c.route('https://heatsync.org/api/users/emotes/batch**', (r: any) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sets: {
          'twitch:222': [
            { name: 'W', url: E('W_sender'), hash: 'senderhash', added_at: '2020-01-01T00:00:00Z', source: 'extension' },
            { name: 'Solo', url: E('Solo_sender'), hash: 'solohash', added_at: '2020-01-01T00:00:00Z', source: 'extension' },
          ],
        },
        vers: {},
      }),
    }),
  )
  // the channel's history, as heatsync serves it: the lines, and beside them what each sender's app shipped
  const hist = (who: string, uid: number, mid: string, text: string) =>
    `@display-name=${who};color=#00FF00;user-id=${uid};id=${mid};tmi-sent-ts=${Date.now() - 120_000} :${who}!${who}@${who}.tmi.twitch.tv PRIVMSG #probechan :${text}`
  await c.route('https://heatsync.org/api/recent-messages/probechan**', (r: any) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        messages: [hist('histy', 444, 'h1', 'zeta W'), hist('histy', 444, 'h2', 'eta W'), hist('histy', 444, 'h3', 'theta W')],
        emote_refs: {
          h1: { W: { p: 'hs', id: 'histpickhash', url: E('W_histpick') } },
          h2: { W: { p: 'hs', id: 'histgonehash', gone: true } },
        },
      }),
    }),
  )
  for (const h of ['https://api.frankerfacez.com/**', 'https://7tv.io/**', 'https://api.7tv.app/**', 'https://api.betterttv.net/**'])
    await c.route(h, (r: any) => r.abort())
  await c.route('https://cdn.heatsync.org/**', (r: any) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await c.route('https://static-cdn.jtvnw.net/**', (r: any) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await c.route('https://www.twitch.tv/**', (r: any) => r.fulfill({ status: 200, contentType: 'text/html', body: html }))
  await c.addCookies([
    { name: 'auth-token', value: 'harnesstoken0000', domain: '.twitch.tv', path: '/', secure: true },
    { name: 'login', value: 'probeuser', domain: '.twitch.tv', path: '/', secure: true },
    // signed in to heatsync too. without it the background reads "no auth cookie" on its second
    // inventory poll, calls the viewer signed out and empties the seeded inventory, a minute or two
    // in: every later case would then run for a viewer who owns nothing. with it the poll's fetch is
    // refused like every other heatsync request here, and a refused fetch keeps what it holds
    { name: 'auth', value: 'harnessauth0000', domain: 'heatsync.org', path: '/', secure: true, httpOnly: true },
  ])

  let sw = c.serviceWorkers()[0]
  if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 20_000 })
  const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
  const seed = await c.newPage()
  await seed.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
  await seed.evaluate(async (u: Record<string, string>) => {
    // @ts-ignore — extension page
    await chrome.storage.local.set({
      heatsync_multichat: {
        channels: [
          { id: 'probechan', twitch: 'probechan', kick: '', youtube: '' },
          // a second tab with its own Wlol: the box is read against the tab it is in (case l)
          { id: 'probechan2', twitch: 'probechan2', kick: '', youtube: '' },
        ],
      },
      user_info: { username: 'probeuser' },
      global_emotes: [{ name: 'W', url: u.W_global, source: '7tv', hash: 'globalhash' }],
      emote_inventory: [
        { name: 'W', url: u.W_inv, source: 'heatsync', hash: 'invhash' },
        { name: 'Wlol', url: u.Wlol_inv, source: 'heatsync', hash: 'wlolinvhash' },
        // a name nothing else has: removed from the box, its word is text (case q)
        { name: 'Mine', url: u.Mine_inv, source: 'heatsync', hash: 'mineinvhash' },
      ],
    })
  }, Object.fromEntries(['W_global', 'W_inv', 'Wlol_inv', 'Mine_inv', 'W_bttv', 'W_7tv', 'W_ffz'].map((n) => [n, E(n)])))
  // Seed the channel's sets the way the background holds them after a real fetch: in its memory
  // and in its IndexedDB (never storage.local, which every tab would hear). It answers a tab's
  // cold-start pull (get_channel_emotes_map) from there.
  await sw.evaluate(async ([key, emotes]: [string, unknown[]]) => {
    // @ts-ignore — service worker globals
    channelEmotesMap[key] = emotes
    // @ts-ignore
    channelEmotesFetchedAt[key] = Date.now()
    // @ts-ignore
    await bgPersistChannelEmotes(key)
  }, ['twitch/probechan', [
    { name: 'W', url: E('W_bttv'), source: 'bttv', hash: 'bttvhash' },
    { name: 'W', url: E('W_7tv'), source: '7tv', hash: 'stvhash' },
    { name: 'W', url: E('W_ffz'), source: 'ffz', hash: 'ffzhash' },
    { name: 'Wlol', url: E('Wlol_room'), source: '7tv', hash: 'wlolroomhash' },
  ]] as [string, unknown[]])

  await seed.close()

  const p = await c.newPage()
  p.on('pageerror', (e: unknown) => errors.push(String(e).slice(0, 300)))
  await p.goto('https://www.twitch.tv/probechan', { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('#hs-mc-input', { timeout: 25_000 })
  await until(p, async () => irc.frames.some((f) => f.startsWith('JOIN')))

  // Every channel provider fetch is refused above, so the background settles on an empty set and
  // overwrites the seed. Hand it the channel's three W pictures the way a real fetch ends: one
  // channel_emotes_update, deliberately in the OLD (bttv, 7tv, ffz) order so the winner is the
  // extension's decision, not array order.
  await p.waitForTimeout(2500)
  await sw.evaluate(async (u: Record<string, string>) => {
    const emotes = [
      { name: 'W', url: u.W_bttv, source: 'bttv', hash: 'bttvhash' },
      { name: 'W', url: u.W_7tv, source: '7tv', hash: 'stvhash' },
      { name: 'W', url: u.W_ffz, source: 'ffz', hash: 'ffzhash' },
      { name: 'Wlol', url: u.Wlol_room, source: '7tv', hash: 'wlolroomhash' },
    ]
    // the panel's cold start asks the background for its sets, so the background has to agree
    // @ts-ignore — service worker globals
    channelEmotesMap['twitch/probechan'] = emotes
    // @ts-ignore
    channelEmotesFetchedAt['twitch/probechan'] = Date.now()
    // @ts-ignore
    await bgPersistChannelEmotes('twitch/probechan')
    // @ts-ignore — service worker globals
    broadcastToTabs({
      type: 'channel_emotes_update',
      channelOwner: 'probechan',
      platform: 'twitch',
      emotes,
    })
  }, Object.fromEntries(['W_bttv', 'W_7tv', 'W_ffz', 'Wlol_room'].map((n) => [n, E(n)])))
  await sw.evaluate(async (url: string) => {
    const emotes = [{ name: 'Wlol', url, source: '7tv', hash: 'wlolroom2hash' }]
    // @ts-ignore — service worker globals
    channelEmotesMap['twitch/probechan2'] = emotes
    // @ts-ignore
    channelEmotesFetchedAt['twitch/probechan2'] = Date.now()
    // @ts-ignore
    await bgPersistChannelEmotes('twitch/probechan2')
    // @ts-ignore
    broadcastToTabs({ type: 'channel_emotes_update', channelOwner: 'probechan2', platform: 'twitch', emotes })
  }, E('Wlol_room2'))
  await p.waitForTimeout(1500)

  const now = Date.now()
  const line = (name: string, uid: number, mid: string, text: string, extra = '') =>
    irc.push(
      `@display-name=${name};color=#FF0000;user-id=${uid};id=${mid};tmi-sent-ts=${now}${extra} :${name}!${name}@${name}.tmi.twitch.tv PRIVMSG #probechan :${text}\r\n`,
    )
  line('alice', 111, 'ca', 'alpha W')
  line('bobtag', 333, 'cb', 'beta W', ';emotes=555:5-5')
  line('carol', 222, 'cc', 'gamma W')
  line('carol', 222, 'cd', 'delta Solo')
  await until(p, async () => (await p.evaluate(() => document.getElementById('hs-mc-messages')?.textContent || '')).includes('delta'))
  await p.waitForTimeout(2500) // sender-set batch fetch + re-render

  const imgOf = (word: string) =>
    p.evaluate((w: string) => {
      const row = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].find((r) => (r.textContent || '').includes(w))
      const img = row?.querySelector('.hs-mc-emote-wrapper img, img.hs-mc-emote') as HTMLImageElement | null
      const wr = row?.querySelector('.hs-mc-emote-wrapper') as HTMLElement | null
      return { src: img?.getAttribute('src') || '', state: wr?.dataset.state || '', has: !!row }
    }, word)

  const a = await imgOf('alpha')
  check(a.src.includes('W_ffz'), `a. another chatter's bare W draws the channel ffz W (got ${a.src || 'nothing'})`)
  const b = await imgOf('beta')
  check(b.src.includes('/555/'), `b. the IRC-tag W draws the twitch emote (got ${b.src || 'nothing'})`)
  const cc = await imgOf('gamma')
  check(cc.src.includes('W_ffz'), `c. a chatter's own W, never picked, still draws the channel's W (got ${cc.src || 'nothing'})`)
  const dd = await imgOf('delta')
  check(dd.src.includes('Solo_sender'), `d. their Solo, a name the room has no emote for, draws their picture (got ${dd.src || 'nothing'})`)

  const hi = await imgOf('zeta')
  check(hi.src.includes('W_histpick'), `i. a history line draws the W its sender picked, not the channel's (got ${hi.src || (hi.has ? 'no emote' : 'no row')})`)
  const hj = await imgOf('eta W')
  check(hj.has && !hj.src, `j. a history line whose picked W was taken down since draws the word, no emote (got ${hj.src || (hj.has ? 'no emote' : 'no row')})`)
  const hk = await imgOf('theta')
  check(hk.src.includes('W_ffz'), `k. a history line with no record draws the channel's W (got ${hk.src || (hk.has ? 'no emote' : 'no row')})`)

  check(a.state !== 'owned' && cc.state !== 'owned', `other chatters' W are not labelled yours (states ${a.state}, ${cc.state})`)

  // ── the kick channel of the same name has a W of its own and a name twitch has none of ──
  await sw.evaluate(async (u: Record<string, string>) => {
    const emotes = [
      { name: 'W', url: u.W_kick, source: '7tv', hash: 'kickwhash' },
      { name: 'KiOnly', url: u.KiOnly, source: '7tv', hash: 'kionlyhash' },
    ]
    // @ts-ignore — service worker globals
    channelEmotesMap['kick/probechan'] = emotes
    // @ts-ignore
    channelEmotesFetchedAt['kick/probechan'] = Date.now()
    // @ts-ignore
    broadcastToTabs({ type: 'channel_emotes_update', channelOwner: 'probechan', platform: 'kick', emotes })
  }, { W_kick: E('W_kick'), KiOnly: E('KiOnly') })
  await p.waitForTimeout(1500)
  line('erin', 444, 'ce', 'epsilon W KiOnly')
  await until(p, async () => (await p.evaluate(() => document.getElementById('hs-mc-messages')?.textContent || '')).includes('epsilon'))
  await p.waitForTimeout(1500)
  const eps: string[] = await p.evaluate(() => {
    const row = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].find((r) => (r.textContent || '').includes('epsilon'))
    return [...(row?.querySelectorAll('.hs-mc-emote-wrapper img, img.hs-mc-emote') || [])].map((i) => i.getAttribute('src') || '')
  })
  check(
    eps.length === 1 && eps[0].includes('W_ffz'),
    `a twitch row draws twitch's W and leaves kick's KiOnly as text once the kick channel's emotes load (got ${eps.join(', ') || 'nothing'})`,
  )

  // ── what the viewer sends: the room has a Wlol, their inventory has another ──
  const chipSrc = () => p.evaluate(() => (document.querySelector('#hs-mc-input img') as HTMLImageElement | null)?.getAttribute('src') || '')
  const typeLine = async (text: string) => {
    await p.click('#hs-mc-input', { timeout: 5000 })
    await p.keyboard.press('Control+A')
    await p.keyboard.press('Backspace')
    await p.keyboard.type(text, { delay: 30 })
  }
  const sent = (text: string) => irc.frames.some((f) => f.startsWith('PRIVMSG #probechan') && f.includes(text))
  const rowHas = (word: string) => until(p, async () => (await imgOf(word)).has, 10_000)

  await typeLine('own1 Wlol ')
  await until(p, async () => !!(await chipSrc()), 5000)
  const chip1 = await chipSrc()
  check(chip1.includes('Wlol_room'), `e. Wlol typed by hand: the chip is the channel's (got ${chip1 || 'no chip'})`)
  await p.keyboard.press('Enter')
  await rowHas('own1')
  const own1 = await imgOf('own1')
  check(sent('own1 Wlol'), 'e. the line went out as the bare word')
  check(own1.src.includes('Wlol_room'), `e. the viewer's own row draws the channel's Wlol (got ${own1.src || 'nothing'})`)

  await typeLine('own2 Wlol')
  await p.keyboard.press('Tab')
  await until(p, async () => !!(await chipSrc()), 5000)
  const tab1 = await chipSrc()
  check(tab1.includes('Wlol_room'), `f. Tab's first answer for the typed name is what typing it sends: the channel's (got ${tab1 || 'no chip'})`)
  await p.keyboard.press('Tab')
  await until(p, async () => (await chipSrc()).includes('Wlol_inv'), 5000)
  const tab2 = await chipSrc()
  check(tab2.includes('Wlol_inv'), `f. the second Tab is the viewer's own copy of the name (got ${tab2 || 'no chip'})`)
  await p.keyboard.press('Enter')
  await rowHas('own2')
  await p.waitForTimeout(800)
  const own2 = await imgOf('own2')
  check(sent('own2 Wlol'), 'f. the picked line went out as the bare word too')
  check(own2.src.includes('Wlol_inv'), `f. the picked copy is what the viewer's own row draws (got ${own2.src || (own2.has ? 'a row with no emote' : 'no row')})`)

  await typeLine('own3 Wlol ')
  await until(p, async () => !!(await chipSrc()), 5000)
  const chip3 = await chipSrc()
  check(chip3.includes('Wlol_room'), `g. the next line, Wlol typed by hand: the channel's again, the pick died with its message (got ${chip3 || 'no chip'})`)
  await p.keyboard.press('Enter')
  await rowHas('own3')
  const own3 = await imgOf('own3')
  check(own3.src.includes('Wlol_room'), `g. and that row draws the channel's Wlol (got ${own3.src || 'nothing'})`)
  const own2Still = await imgOf('own2')
  check(own2Still.src.includes('Wlol_inv'), `g. the earlier row keeps the picture it was sent with (got ${own2Still.src || 'nothing'})`)

  // the picker's recents are the pictures those three lines shipped, the last one first
  await p.click('#hs-mc-emote-btn', { timeout: 5000 })
  await p.waitForSelector('#hs-mc-emote-picker.visible', { timeout: 10_000 })
  const recentPics = () =>
    p.$$eval('#hs-mc-emote-picker [data-section-key="recent"] .hs-mc-picker-emote-wrap img', (els: HTMLImageElement[]) =>
      els.map((x) => `${x.alt} ${x.getAttribute('src') || ''}`),
    )
  await until(p, async () => (await recentPics()).length >= 2, 5000)
  const rec = await recentPics()
  check(
    rec.length === 2 && rec[0].includes('Wlol_room') && rec[1].includes('Wlol_inv'),
    `h. recents hold both pictures of Wlol that were sent, the last sent first (got ${JSON.stringify(rec)})`,
  )
  await p.click('#hs-mc-emote-btn', { timeout: 5000 }).catch(() => {})
  await p.keyboard.press('Escape').catch(() => {})

  // ── a word left in the box when the tab changes is read against the tab it will be sent in ──
  await typeLine('own4 Wlol ')
  await until(p, async () => (await chipSrc()).includes('Wlol_room'), 5000)
  await p.click('.hs-mc-tab[data-tab="probechan2"]', { timeout: 5000 })
  await until(p, async () => (await chipSrc()).includes('Wlol_room2'), 5000)
  const chipB = await chipSrc()
  check(chipB.includes('Wlol_room2'), `l. the box carried to another tab shows that tab's Wlol, the one a send from there ships (got ${chipB || 'no chip'})`)
  const boxText = await p.evaluate(() => {
    const el = document.getElementById('hs-mc-input')
    return [...(el?.childNodes || [])].map((n) => ((n as HTMLElement).dataset?.emoteName ? (n as HTMLElement).dataset.emoteName : n.textContent)).join('')
  })
  check(boxText.replace(/\s+/g, ' ').trim() === 'own4 Wlol', `l. and its words are all still there, in order (got ${JSON.stringify(boxText)})`)
  await p.click('.hs-mc-tab[data-tab="probechan"]', { timeout: 5000 })
  await until(p, async () => { const s = await chipSrc(); return s.includes('Wlol_room') && !s.includes('Wlol_room2') }, 5000)
  const chipA = await chipSrc()
  check(chipA.includes('Wlol_room') && !chipA.includes('Wlol_room2'), `l. back in the first tab it is that tab's Wlol again (got ${chipA || 'no chip'})`)
  await p.click('#hs-mc-input', { timeout: 5000 })
  await p.keyboard.press('Control+A')
  await p.keyboard.press('Backspace')

  // ── a line brought back with the up arrow keeps the copy chosen in it ──
  await p.keyboard.press('ArrowUp') // own3: Wlol typed by hand
  await until(p, async () => (await chipSrc()).includes('Wlol_room'), 5000)
  await p.keyboard.press('ArrowUp') // own2: the viewer's own Wlol, picked with a second Tab
  await until(p, async () => (await chipSrc()).includes('Wlol_inv'), 5000)
  const back = await chipSrc()
  check(back.includes('Wlol_inv'), `m. the line sent with your own Wlol comes back with your own Wlol, not the channel's (got ${back || 'no chip'})`)
  await p.keyboard.type(' again', { delay: 30 })
  await p.keyboard.press('Enter')
  await rowHas('again')
  await p.waitForTimeout(800)
  const again = await imgOf('again')
  check(sent('own2 Wlol again'), 'm. the recalled line went out')
  check(again.src.includes('Wlol_inv'), `m. and its row draws the copy that was picked (got ${again.src || (again.has ? 'a row with no emote' : 'no row')})`)
  // a Tab that took the channel's own emote is no choice: recalled in another tab it is THAT tab's
  await typeLine('own5 Wlol')
  await p.keyboard.press('Tab')
  await until(p, async () => (await chipSrc()).includes('Wlol_room'), 5000)
  await p.keyboard.press('Enter')
  await rowHas('own5')
  await p.click('.hs-mc-tab[data-tab="probechan2"]', { timeout: 5000 })
  await p.click('#hs-mc-input', { timeout: 5000 })
  await p.keyboard.press('ArrowUp')
  await until(p, async () => (await chipSrc()).includes('Wlol_room2'), 5000)
  const far = await chipSrc()
  check(far.includes('Wlol_room2'), `m. a Tab-completed line recalled in another tab shows that tab's Wlol, never the first channel's (got ${far || 'no chip'})`)
  await p.keyboard.press('Control+A')
  await p.keyboard.press('Backspace')
  await p.click('.hs-mc-tab[data-tab="probechan"]', { timeout: 5000 })

  // ── modifiers: one emote changes, the same one in the box, on the wire and on the row ──
  // each emote of a row with the effects stamped on it, in order
  const fxOf = (word: string): Promise<string[]> =>
    p.evaluate((w: string) => {
      const row = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].find((r) => (r.textContent || '').includes(w))
      return [...(row?.querySelectorAll('.hs-mc-emote-wrapper') || [])].map((el) => `${(el as HTMLElement).dataset.emoteName}:${(el as HTMLElement).dataset.hsMods || ''}`)
    }, word)
  const boxNow = () =>
    p.evaluate(() => {
      const el = document.getElementById('hs-mc-input')
      return {
        chips: [...(el?.querySelectorAll('img.hs-input-emote') || [])].map((i) => `${(i as HTMLElement).dataset.emoteName}:${(i as HTMLElement).dataset.hsWords || ''}`),
        text: [...(el?.childNodes || [])].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim(),
      }
    })
  line('dana', 555, 'cs1', 'sigma Wlol w! Wlol')
  line('dana', 555, 'cs2', 'tau Wlol ffzX Wlol')
  line('dana', 555, 'cs3', 'upsilon w! hello Wlol constructor')
  await until(p, async () => (await p.evaluate(() => document.getElementById('hs-mc-messages')?.textContent || '')).includes('upsilon'))
  await p.waitForTimeout(800)
  const s1 = await fxOf('sigma')
  check(s1.join(' ') === 'Wlol: Wlol:w!', `s. \`Wlol w! Wlol\` on a chatter's line widens the emote after the word (got ${JSON.stringify(s1)})`)
  const s2 = await fxOf('tau')
  check(s2.join(' ') === 'Wlol:h! Wlol:', `s. \`Wlol ffzX Wlol\` flips the emote before the word (got ${JSON.stringify(s2)})`)
  const s3 = await fxOf('upsilon')
  const s3text = await p.evaluate(() => [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].find((r) => (r.textContent || '').includes('upsilon'))?.textContent || '')
  check(s3.join(' ') === 'Wlol:' && s3text.includes('w!') && s3text.includes('constructor'), `s. a word never reaches over text, and an ordinary word after an emote stays on the line (got ${JSON.stringify(s3)} in ${JSON.stringify(s3text.slice(-60))})`)

  await typeLine('mod1 Wlol w! ')
  await until(p, async () => (await boxNow()).chips[0] === 'Wlol:w!', 5000)
  const t1 = await boxNow()
  check(t1.chips.join(' ') === 'Wlol:w!' && !t1.text.includes('w!'), `t. \`Wlol w! \` typed in the box widens the chip and the word leaves the box (got ${JSON.stringify(t1)})`)
  await p.keyboard.type('Wlol tail', { delay: 30 })
  await until(p, async () => (await boxNow()).chips.length === 2, 5000)
  const t2 = await boxNow()
  check(t2.chips.join(' ') === 'Wlol:w! Wlol:' && t2.text === 'mod1 tail', `t. a second emote typed after it keeps its own look, and the caret stayed where typing goes on (got ${JSON.stringify(t2)})`)
  await p.keyboard.press('Enter')
  await rowHas('mod1')
  await p.waitForTimeout(800)
  check(sent('mod1 w! Wlol Wlol tail'), `t. the line went out with the word where it stays the first emote's own (frames: ${JSON.stringify(irc.frames.filter((f) => f.includes('mod1')).map((f) => f.slice(0, 80)))})`)
  const t3 = await fxOf('mod1')
  check(t3.join(' ') === 'Wlol:w! Wlol:', `t. and the row is what the box showed (got ${JSON.stringify(t3)})`)

  await typeLine('mod2 w! Wlol ')
  await until(p, async () => (await boxNow()).chips[0] === 'Wlol:w!', 5000)
  const u1 = await boxNow()
  check(u1.chips.join(' ') === 'Wlol:w!' && !u1.text.includes('w!'), `u. a word typed BEFORE an emote is that emote's in the box, as on the row (got ${JSON.stringify(u1)})`)
  await p.keyboard.press('Enter')
  await rowHas('mod2')
  await p.waitForTimeout(800)
  const u2 = await fxOf('mod2')
  check(sent('mod2 w! Wlol') && u2.join(' ') === 'Wlol:w!', `u. sent as typed, drawn wide (got ${JSON.stringify(u2)})`)

  await typeLine('mod3 w! then')
  await p.waitForTimeout(400)
  const v1 = await boxNow()
  check(v1.chips.length === 0 && v1.text === 'mod3 w! then', `v. with no emote beside it the word stays the word that was typed (got ${JSON.stringify(v1)})`)
  await p.keyboard.press('Control+A')
  await p.keyboard.press('Backspace')

  // ── w. the box is the row under lines nobody thought of ──
  // seeded random lines of the room's two emotes, modifier words and ordinary words, typed a key
  // at a time. my row must be what every other app draws for the text that went out (the rule,
  // shared/emote-mods.vectors.json) and, once the box has taken the last word (a space after
  // it), what the box showed. every other line is sent straight after its last word.
  {
    const WORDS = ['Wlol', 'Wlol', 'W', 'Wlol', 'w!', 'h!', 'v!', 'ffzX', 'ffzY', 'w!h!', 'w!', 'ffzX', 'hi', 'w', 'ffz', 'constructor']
    const MOD = /^(w!|h!|v!|ffzX|ffzY|w!h!)$/
    const isEmote = (w: string) => w === 'Wlol' || w === 'W'
    // one spelling per effect: a row keeps the effect, a chip the word that was typed
    const canon = (list: string[]) => list.flatMap((w) => w.match(/w!|h!|v!|ffzX|ffzY/g) ?? []).map((w) => (w === 'ffzX' ? 'h!' : w === 'ffzY' ? 'v!' : w)).sort().join(',')
    const norm = (cells: string[]) => cells.map((c) => `${c.slice(0, c.indexOf(':'))}:${canon(c.slice(c.indexOf(':') + 1).split(/[ ,]+/))}`)
    const ruleRow = (wire: string): string[] => {
      const words = wire.split(/\s+/).filter(Boolean)
      const on = new Map<number, string[]>()
      let last = -1
      words.forEach((w, i) => {
        if (!MOD.test(w)) { last = isEmote(w) ? i : -1; return }
        let next = -1
        for (let j = i + 1; j < words.length; j++) {
          if (MOD.test(words[j])) continue
          next = isEmote(words[j]) ? j : -1
          break
        }
        const to = w[1] === '!' ? (next >= 0 ? next : last) : last >= 0 ? last : next
        if (to >= 0) on.set(to, [...(on.get(to) ?? []), w])
      })
      return words.flatMap((w, i) => (isEmote(w) ? [`${w}:${canon(on.get(i) ?? [])}`] : []))
    }
    let seedState = 0
    const rand = () => {
      seedState = (seedState + 0x6d2b79f5) | 0
      let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const LINES = Number(process.env.HS_RANDOM_LINES || 40)
    let done = 0
    let changed = 0
    for (let seed = 1; done < LINES && seed < 600; seed++) {
      seedState = seed
      const words = Array.from({ length: 2 + Math.floor(rand() * 5) }, () => WORDS[Math.floor(rand() * WORDS.length)])
      if (!words.some(isEmote) || !words.some((w) => MOD.test(w))) continue
      done++
      const settled = done % 2 === 1
      const mark = `rq${seed}x`
      const said = `w. seed ${seed} ${JSON.stringify(words.join(' '))}${settled ? '' : ' (sent straight after the last word)'}`
      await typeLine(`${mark} ${words.join(' ')}${settled ? ' ' : ''}`)
      let before = ''
      await until(p, async () => { const now = JSON.stringify(await boxNow()); const same = now === before; before = now; return same }, 5000)
      await p.waitForTimeout(150)
      const box = await boxNow()
      if (settled && box.chips.some((c) => !c.endsWith(':'))) changed++
      await p.keyboard.press('Enter')
      await rowHas(mark)
      await p.waitForTimeout(500)
      const frame = irc.frames.find((f) => f.startsWith('PRIVMSG #probechan') && f.includes(mark)) || ''
      const wire = frame.slice(frame.indexOf(' :') + 2)
      const row = norm(await fxOf(mark))
      const want = ruleRow(wire)
      if (row.join(' ') !== want.join(' ')) check(false, `${said}: my row is what everyone else draws for the text that went out (wire ${JSON.stringify(wire)}, row ${JSON.stringify(row)}, the rule ${JSON.stringify(want)})`)
      if (settled && norm(box.chips).join(' ') !== row.join(' ')) check(false, `${said}: the row is what the box showed (box ${JSON.stringify(box)}, row ${JSON.stringify(row)}, wire ${JSON.stringify(wire)})`)
    }
    check(done === LINES && changed > LINES / 8, `w. ${done} random lines typed into the box: each row is the rule's reading of its wire text, and what the box showed (${changed} carried a modifier on a chip)`)
    await p.keyboard.press('Control+A')
    await p.keyboard.press('Backspace')
  }

  // ── a right-click on an emote in the box acts on the picture the box shows ──
  const chip = () =>
    p.evaluate(() => {
      const i = document.querySelector('#hs-mc-input img.hs-input-emote') as HTMLImageElement | null
      return i ? { pic: i.dataset.hsUrl || '', src: i.getAttribute('src') || '', blocked: i.dataset.hsInputBlocked === '1' } : null
    })
  const inventory = async (): Promise<string[]> => {
    const pg = await c.newPage()
    await pg.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    const names: string[] = await pg.evaluate(async () => {
      // @ts-ignore — extension page
      const st = await chrome.storage.local.get('emote_inventory')
      return (st.emote_inventory || []).map((e: any) => e.name)
    })
    await pg.close()
    await p.bringToFront()
    return names
  }
  const rightClickChip = () => p.click('#hs-mc-input img.hs-input-emote', { button: 'right' })

  await typeLine('box1 Wlol ')
  await until(p, async () => (await chipSrc()).includes('Wlol_room'), 5000)
  await rightClickChip()
  await until(p, async () => !!(await chip())?.blocked, 5000)
  const n1 = await chip()
  check(!!n1?.blocked && n1.pic.includes('Wlol_room'), `n. right-click the channel's Wlol in the box: that picture is blocked (got ${JSON.stringify(n1)})`)
  const invN = await inventory()
  check(invN.includes('Wlol'), `n. and the viewer's own Wlol was not removed (inventory: ${JSON.stringify(invN)})`)
  await p.waitForTimeout(1200) // the block's own storage write re-reads the box
  const n2 = await chip()
  check(!!n2?.blocked && !n2.src.includes('Wlol_inv'), `n. the blocked chip stays a dashed box, never a look-alike of the name (got ${JSON.stringify(n2)})`)
  await rightClickChip()
  await until(p, async () => (await chip())?.blocked === false, 5000)
  const n3 = await chip()
  check(n3?.blocked === false && n3.src.includes('Wlol_room'), `n. a second right-click unblocks it and the picture is back (got ${JSON.stringify(n3)})`)

  await typeLine('box2 Wlol')
  await p.keyboard.press('Tab')
  await p.keyboard.press('Tab')
  await until(p, async () => (await chipSrc()).includes('Wlol_inv'), 5000)
  await p.evaluate(() => {
    const row = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].find((r) => (r.textContent || '').includes('own1'))
    ;(row?.querySelector('.hs-mc-emote-wrapper') as HTMLElement | null)?.setAttribute('data-hs-probe', 'own1')
  })
  await p.click('[data-hs-probe="own1"]', { button: 'right' })
  await until(p, async () => (await imgOf('own1')).state === 'blocked', 5000)
  const o1 = await chip()
  check((await imgOf('own1')).state === 'blocked', "o. the channel's Wlol is blocked on a chat line")
  check(!!o1 && !o1.blocked && o1.src.includes('Wlol_inv'), `o. a box chip of the viewer's OWN Wlol is not dashed by it (got ${JSON.stringify(o1)})`)
  // a blocked emote is its dashed box: the click lands on the wrapper, as a viewer's does
  await p.click('[data-hs-probe="own1"]', { button: 'right' })
  await until(p, async () => (await imgOf('own1')).state !== 'blocked', 5000)
  const o2 = await imgOf('own1')
  check(o2.state !== 'blocked' && o2.src.includes('Wlol_room'), `o. a right-click on its dashed box unblocks it: the row draws the channel's Wlol again (got ${JSON.stringify(o2)})`)

  // the server call cannot be made here (heatsync.org is refused): the background's remove answers yes
  await sw.evaluate(() => {
    // @ts-ignore — service worker globals
    removeFromInventory = async (_hash: string, name: string) => {
      // @ts-ignore
      const st = await chrome.storage.local.get('emote_inventory')
      // @ts-ignore
      emoteInventory = (st.emote_inventory || []).filter((e: any) => e.name !== name)
      // @ts-ignore
      await chrome.storage.local.set({ emote_inventory: emoteInventory })
      return { success: true }
    }
  })
  await rightClickChip()
  await until(p, async () => (await chipSrc()).includes('Wlol_room'), 5000)
  const p1 = await chip()
  const invP = await inventory()
  check(!invP.includes('Wlol') && invP.includes('W'), `p. right-click the viewer's own Wlol in the box: it is removed from their set, nothing else is (inventory: ${JSON.stringify(invP)})`)
  check(!!p1 && !p1.blocked && p1.src.includes('Wlol_room'), `p. the chip is read again: the channel's Wlol, not the copy just removed (got ${JSON.stringify(p1)})`)
  await p.click('#hs-mc-input', { timeout: 5000 })
  await p.keyboard.press('Control+End')
  await p.keyboard.press('Enter')
  await rowHas('box2')
  await p.waitForTimeout(800)
  const box2 = await imgOf('box2')
  check(box2.src.includes('Wlol_room'), `p. and the line ships what the box showed (got ${box2.src || (box2.has ? 'a row with no emote' : 'no row')})`)

  await typeLine('box3 Mine ')
  await until(p, async () => (await chipSrc()).includes('Mine_inv'), 5000)
  check((await chipSrc()).includes('Mine_inv'), 'q. setup: an emote only the viewer has is a chip as typed')
  await rightClickChip()
  await until(p, async () => !(await chip()), 5000)
  const q1 = await p.evaluate(() => {
    const el = document.getElementById('hs-mc-input')
    return { imgs: el?.querySelectorAll('img').length ?? -1, text: (el?.textContent || '').replace(/\s+/g, ' ').trim() }
  })
  check(q1.imgs === 0 && q1.text === 'box3 Mine', `q. removed, with no other emote of the name: the word is text again, as it ships (got ${JSON.stringify(q1)})`)
  await p.click('#hs-mc-input', { timeout: 5000 })
  await p.keyboard.press('Control+A')
  await p.keyboard.press('Backspace')

  // ── enter ships what the box shows, even when the channel's set moves under a chip ──
  const roomSet = (w: string) =>
    sw.evaluate(async ([wUrl, lolUrl]: string[]) => {
      const emotes = [
        { name: 'W', url: wUrl, source: 'ffz', hash: 'ffzhash' },
        { name: 'Wlol', url: lolUrl, source: '7tv', hash: 'wlolroomhash' },
      ]
      // @ts-ignore — service worker globals
      channelEmotesMap['twitch/probechan'] = emotes
      // @ts-ignore
      channelEmotesFetchedAt['twitch/probechan'] = Date.now()
      // @ts-ignore
      await bgPersistChannelEmotes('twitch/probechan')
      // @ts-ignore
      broadcastToTabs({ type: 'channel_emotes_update', channelOwner: 'probechan', platform: 'twitch', emotes })
    }, [E(w), E('Wlol_room')])
  const picOf = (src: string) => src.match(/emote\/([A-Za-z0-9_]+)\.png/)?.[1] || src
  await typeLine('box4 W ')
  await until(p, async () => (await chipSrc()).includes('W_ffz'), 5000)
  await roomSet('W_moved')
  await p.waitForTimeout(1500)
  const shown = picOf((await chip())?.pic || '')
  check(shown === 'W_ffz' || shown === 'W_moved', `r. setup: the box still holds a W chip after the channel's W changed (got ${shown || 'no chip'})`)
  await p.click('#hs-mc-input', { timeout: 5000 })
  await p.keyboard.press('Control+End')
  await p.keyboard.press('Enter')
  await rowHas('box4')
  await p.waitForTimeout(800)
  const box4 = picOf((await imgOf('box4')).src)
  check(!!shown && box4 === shown, `r. the row sent is the picture the box showed at enter (box ${shown || 'nothing'}, row ${box4 || 'nothing'})`)
  await roomSet('W_ffz')
  await p.waitForTimeout(1500)

  // right-click alice's W: blocked, inventory untouched, other emotes unaffected
  await p.evaluate(() => {
    const row = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].find((r) => (r.textContent || '').includes('alpha'))
    ;(row?.querySelector('.hs-mc-emote-wrapper img') as HTMLElement | null)?.setAttribute('data-hs-probe', 'alice')
  })
  await p.click('[data-hs-probe="alice"]', { button: 'right' })
  await p.waitForTimeout(2500)
  const after = {
    a: await imgOf('alpha'),
    b: await imgOf('beta'),
    c: await imgOf('gamma'),
    d: await imgOf('delta'),
  }
  check(after.a.state === 'blocked', `right-click blocks the clicked W (state ${after.a.state})`)
  check(after.c.state === 'blocked', `the same channel W on another chatter's line hides with it (state ${after.c.state})`)
  check(after.b.state !== 'blocked', `the IRC-tag W (a different emote) is not hidden (state ${after.b.state})`)
  check(after.d.state !== 'blocked', `another emote entirely is not hidden (state ${after.d.state})`)
  const dbg = await c.newPage()
  await dbg.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
  const invNames: string[] = await dbg.evaluate(async () => {
    // @ts-ignore
    const s = await chrome.storage.local.get('emote_inventory')
    return (s.emote_inventory || []).map((e: any) => e.name)
  })
  await dbg.close()
  check(invNames.includes('W'), `your own inventory W was never removed (inventory: ${JSON.stringify(invNames)})`)
  if (errors.length) failures.push(`page errors: ${errors.join(' | ')}`)
} finally {
  try {
    await Promise.race([c.close(), new Promise((r) => setTimeout(r, 8000))])
  } catch (_) {}
  irc.stop()
  rmSync(prof, { recursive: true, force: true })
}
if (failures.length) {
  console.error(`\n✗ ${failures.length} collision check(s) failed`)
  process.exit(1)
}
console.log('\n✓ collision checks passed')
process.exit(0)

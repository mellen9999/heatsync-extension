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
 * then the kick channel of the same name loads a W of its own and a KiOnly: a twitch row still
 * draws twitch's W, and KiOnly is text there (each platform's row reads its own emotes).
 * What the viewer sends (the emote law, send + offer), with Wlol in the channel AND in their
 * inventory as two pictures:
 *   e. Wlol typed by hand                   -> the chip and the sent row are the channel's
 *   f. Wlol + Tab, Tab                      -> the second copy is theirs; it ships and their row draws it
 *   g. Wlol typed by hand in the next line  -> the channel's again: a pick dies with its message
 *   h. the picker's recents                 -> both pictures of Wlol, as sent, the last one first
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
  for (const h of ['https://api.frankerfacez.com/**', 'https://7tv.io/**', 'https://api.7tv.app/**', 'https://api.betterttv.net/**'])
    await c.route(h, (r: any) => r.abort())
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
  const seed = await c.newPage()
  await seed.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
  await seed.evaluate(async (u: Record<string, string>) => {
    // @ts-ignore — extension page
    await chrome.storage.local.set({
      heatsync_multichat: { channels: [{ id: 'probechan', twitch: 'probechan', kick: '', youtube: '' }] },
      user_info: { username: 'probeuser' },
      global_emotes: [{ name: 'W', url: u.W_global, source: '7tv', hash: 'globalhash' }],
      emote_inventory: [
        { name: 'W', url: u.W_inv, source: 'heatsync', hash: 'invhash' },
        { name: 'Wlol', url: u.Wlol_inv, source: 'heatsync', hash: 'wlolinvhash' },
      ],
    })
  }, Object.fromEntries(['W_global', 'W_inv', 'Wlol_inv', 'W_bttv', 'W_7tv', 'W_ffz'].map((n) => [n, E(n)])))
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

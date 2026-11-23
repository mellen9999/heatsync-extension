/**
 * NATIVE kick rows (overlay off): same-name emote collisions, in a real browser, against the BUILT extension.
 *
 *   bun run test:emotes   (builds dist/chrome in THIS checkout, then runs this)
 *
 * Rows are injected into a fixture kick.com page (see the stand-ins below); the overlay is off.
 *   a. another chatter's bare W          -> the channel ffz W   (rules 3, 4)
 *   b. kick's own emote img on W         -> left alone          (rule 1: the platform token is exact)
 *   c. a chatter who saved their own W   -> still the channel ffz W: a typed word is the room's
 *   d. her Solo, which the channel has not -> her Solo           (the sender's own; sender key kick:<name>)
 *   e. her app says she PICKED her W     -> her W on that line; her earlier line keeps the channel's
 *   f. a row that beat its pick here     -> redrawn with the pick when it lands
 * (the emote law: the site's docs/emote-law.md; src/content/native-emote-law.js)
 * then right-click: only that exact emote's key is stored, the viewer's own W is untouched (rules 9, 10).
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
// Stand-ins for real kick structure (the content script keys on ids, attributes and class names only):
//  #chatroom-messages                  = the scrolling list kick's react app renders chat rows into
//  div[data-index]                     = one row (kick has no numeric user id in the DOM: the sender key is kick:<name>)
//  button.inline.font-bold             = the sender name button
//  span.font-normal                    = a text run; <img src=files.kick.com/emotes/ID/fullsize alt=W> = kick's own emote img
//                                        (the [emote:id:name] token is what kick's chat stream carries; the DOM has already
//                                        turned it into that img, so "the token wins" is: the img is left alone)
const body = '<div id="host-content" style="height:100vh"><div id="chatroom-messages"><div class="no-scrollbar" id="list"></div></div></div>'
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
const prof = mkdtempSync(join(tmpdir(), 'hs-ext-kick-'))
const c = await launchWithExtension(prof, [
  '--window-size=1500,900',
  `--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1:${irc.port}`,
  '--ignore-certificate-errors',
  '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
])
const errors: string[] = []
try {
  await c.route('https://heatsync.org/**', (r: any) => r.abort())
  // the sender set for carol: her own W (a name the channel has) and her Solo (one it has not)
  await c.route('https://heatsync.org/api/users/emotes/batch**', (r: any) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sets: {
          'kick:carol': [
            { name: 'W', url: E('W_sender'), hash: 'senderhash', added_at: '2020-01-01T00:00:00Z', source: 'extension' },
            { name: 'Solo', url: E('Solo_sender'), hash: 'solohash', added_at: '2020-01-01T00:00:00Z', source: 'extension' },
          ],
        },
        vers: {},
      }),
    }),
  )
  for (const h of ['https://api.frankerfacez.com/**', 'https://7tv.io/**', 'https://api.betterttv.net/**'])
    await c.route(h, (r: any) => r.abort())
  await c.route('https://cdn.heatsync.org/**', (r: any) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await c.route('https://files.kick.com/**', (r: any) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await c.route('https://kick.com/**', (r: any) => r.fulfill({ status: 200, contentType: 'text/html', body: html }))
  await c.addCookies([
    { name: 'auth-token', value: 'harnesstoken0000', domain: '.kick.com', path: '/', secure: true },
    { name: 'login', value: 'probeuser', domain: '.kick.com', path: '/', secure: true },
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
      emote_inventory: [{ name: 'W', url: u.W_inv, source: 'heatsync', hash: 'invhash' }],
    })
  }, Object.fromEntries(['W_global', 'W_inv', 'W_bttv', 'W_7tv', 'W_ffz'].map((n) => [n, E(n)])))
  // the per-site "hs off" lives in storage.sync (ui_settings.subsystems), read once at boot
  await seed.evaluate(async () => {
    // @ts-ignore — extension page
    await chrome.storage.sync.set({ ui_settings: { subsystems: { 'overlay-kick': false } } })
  })
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
  }, ['kick/probechan', [
    { name: 'W', url: E('W_bttv'), source: 'bttv', hash: 'bttvhash' },
    { name: 'W', url: E('W_7tv'), source: '7tv', hash: 'stvhash' },
    { name: 'W', url: E('W_ffz'), source: 'ffz', hash: 'ffzhash' },
  ]] as [string, unknown[]])

  await seed.close()

  const p = await c.newPage()
  p.on('pageerror', (e: unknown) => errors.push(String(e).slice(0, 300)))
  await p.goto('https://kick.com/probechan', { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(5000)
  check(await p.evaluate(() => !document.getElementById('hs-mc-container')), 'overlay is off (native rows are processed)')
  const chans = [
    { name: 'W', url: E('W_bttv'), source: 'bttv', hash: 'bttvhash' },
    { name: 'W', url: E('W_7tv'), source: '7tv', hash: 'stvhash' },
    { name: 'W', url: E('W_ffz'), source: 'ffz', hash: 'ffzhash' },
  ]
  await sw.evaluate(async (emotes: any[]) => {
    // @ts-ignore — service worker globals
    channelEmotesMap['kick/probechan'] = emotes
    // @ts-ignore
    channelEmotesFetchedAt['kick/probechan'] = Date.now()
    // @ts-ignore
    await bgPersistChannelEmotes('kick/probechan')
    // @ts-ignore
    broadcastToTabs({ type: 'channel_emotes_update', channelOwner: 'probechan', platform: 'kick', emotes })
  }, chans)
  await p.waitForTimeout(1500)

  await p.evaluate(() => {
    const add = (user: string, uid: number, pre: string, native: boolean) => {
      const row = document.createElement('div')
      row.setAttribute('data-index', String(uid))
      row.innerHTML = `<button class="inline font-bold">${user}</button>: <span class="font-normal">${pre} ${native ? '<img alt="W" data-emote-id="555" src="https://files.kick.com/emotes/555/fullsize">' : 'W'}</span>`
      document.getElementById('list')!.appendChild(row)
    }
    ;(window as any).__add = add
    add('alice', 111, 'alpha', false)
    add('bobtag', 333, 'beta', true)
    add('carol', 222, 'gamma', false)
    const solo = document.createElement('div')
    solo.setAttribute('data-index', '223')
    solo.innerHTML = '<button class="inline font-bold">carol</button>: <span class="font-normal">delta Solo</span>'
    document.getElementById('list')!.appendChild(solo)
  })
  await p.waitForTimeout(4000)

  const imgOf = (word: string) =>
    p.evaluate((w: string) => {
      const row = [...document.querySelectorAll('#chatroom-messages [data-index]')].find((r) => (r.textContent || '').includes(w))
      const wr = row?.querySelector('.heatsync-emote-wrapper') as HTMLElement | null
      const img = (wr?.querySelector('img') || row?.querySelector('img')) as HTMLImageElement | null
      return { src: img?.getAttribute('src') || '', state: (wr?.className.match(/emote-overlay-(\w+)/)?.[1] || ''), wrapped: !!wr, hidden: !!img && getComputedStyle(img).display === 'none' }
    }, word)
  const a = await imgOf('alpha')
  check(a.src.includes('W_ffz'), `a. another chatter's bare W draws the channel ffz W (got ${a.src || 'nothing'})`)
  const b = await imgOf('beta')
  check(b.src.includes('/emotes/555/') && !b.wrapped, `b. kick's own emote img is left alone (got ${b.src || 'nothing'}, wrapped ${b.wrapped})`)
  let cc = await imgOf('gamma')
  check(cc.src.includes('W_ffz'), `c. a chatter's saved W does not take the channel's name: her typed W is the channel ffz W (got ${cc.src || 'nothing'})`)
  const dd = await imgOf('delta')
  check(dd.src.includes('Solo_sender'), `d. her Solo, a name the channel has not, draws her picture (got ${dd.src || 'nothing'})`)
  check(a.state !== 'owned' && cc.state !== 'owned', `other chatters' W are not labelled yours (states ${a.state}, ${cc.state})`)

  // e. her app announces a pick: the line that comes with it draws her W, the earlier one keeps the channel's
  const announce = (username: string, hash: string, pic: string) =>
    sw.evaluate(([u, h, url]: string[]) => {
      // @ts-ignore — service worker globals
      broadcastToTabs({ type: 'emote_broadcast', username: u, emoteName: 'W', emoteData: { url, hash: h } })
    }, [username, hash, E(pic)])
  await announce('carol', 'senderhash', 'W_sender')
  await p.evaluate(() => (window as any).__add('carol', 224, 'epsilon', false))
  await until(p, async () => (await imgOf('epsilon')).wrapped, 6000)
  const ee = await imgOf('epsilon')
  check(ee.src.includes('W_sender'), `e. a W she picked on purpose draws her W on that line (got ${ee.src || 'nothing'})`)
  cc = await imgOf('gamma')
  check(cc.src.includes('W_ffz'), `e. her earlier hand-typed W keeps the channel's picture (got ${cc.src || 'nothing'})`)

  // f. the row lands first, the pick a moment later
  await p.evaluate(() => (window as any).__add('dave', 444, 'zeta', false))
  await until(p, async () => (await imgOf('zeta')).wrapped, 6000)
  const before = await imgOf('zeta')
  await announce('dave', 'davehash', 'W_dave')
  await until(p, async () => (await imgOf('zeta')).src.includes('W_dave'), 4000)
  const ff = await imgOf('zeta')
  check(before.src.includes('W_ffz') && ff.src.includes('W_dave'), `f. a row that beat its pick is redrawn with it (before ${before.src || 'nothing'}, after ${ff.src || 'nothing'})`)

  const rc = async (word: string, tag: string) => {
    await p.evaluate(([w, t]: string[]) => {
      const row = [...document.querySelectorAll('#chatroom-messages [data-index]')].find((r) => (r.textContent || '').includes(w))
      row?.querySelector('.heatsync-emote-wrapper img')?.setAttribute('data-hs-probe', t)
    }, [word, tag])
    await p.click(`[data-hs-probe="${tag}"]`, { button: 'right' })
    // optimistic state only: the block call to the (refused) server rolls back after a moment
    await p.waitForTimeout(150)
  }
  const blockedNow = async () => {
    const pg = await c.newPage()
    await pg.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    const v: string[] = await pg.evaluate(async () => {
      // @ts-ignore
      const s = await chrome.storage.local.get('local_blocked_emotes')
      return s.local_blocked_emotes || []
    })
    await pg.close()
    return v
  }
  await rc('alpha', 'alice')
  let bl = await blockedNow()
  check(bl.includes('ffzhash'), `right-click on alice's W stores that emote's own key (blocked: ${JSON.stringify(bl)})`)
  check(!bl.includes('bttvhash') && !bl.includes('invhash') && !bl.includes('senderhash'), 'no other W was blocked by it')
  // the blocked emote shows the blocked placeholder; it never falls through to another same-name picture
  const blockedA = await imgOf('alpha')
  check(blockedA.state === 'blocked' && blockedA.src.includes('W_ffz'), `alice's blocked W stays the blocked ffz W, no fall-through (state ${blockedA.state}, src ${blockedA.src})`)
  const mid = await imgOf('beta')
  check(mid.src.includes('/emotes/555/'), 'the kick emote still shows')
  await rc('epsilon', 'carol')
  bl = await blockedNow()
  check(bl.includes('senderhash'), `right-click on the W carol picked (shares your W's name) blocks her emote (blocked: ${JSON.stringify(bl)})`)
  check(!bl.includes('invhash'), 'your own inventory W is not blocked')
  const blockedC = await imgOf('epsilon')
  check(blockedC.state === 'blocked' && blockedC.src.includes('W_sender'), `carol's blocked W stays the W she picked (state ${blockedC.state}, src ${blockedC.src})`)
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

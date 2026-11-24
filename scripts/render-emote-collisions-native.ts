/**
 * NATIVE twitch rows (overlay off): same-name emote collisions, in a real browser, against the BUILT extension.
 *
 *   bun run test:emotes   (builds dist/chrome in THIS checkout, then runs this)
 *
 * The word W exists in the channel (ffz + 7tv + bttv: three pictures), in globals and in the
 * viewer's inventory — six distinct urls. Raw PRIVMSGs come over a local wss mock (twitch is
 * never contacted):
 *   a. another chatter's bare W            -> the channel ffz W   (the room)
 *   b. a line with an IRC emotes= tag on W -> the twitch emote    (a platform token)
 *   c. a chatter who saved their own W     -> still the channel ffz W: a typed word is the room's
 *   d. her Solo, which the channel has not -> her Solo             (the sender's own, below the room)
 *   e. her app says she PICKED her W       -> her W on that line; her earlier line keeps the channel's
 *   f. a row that beat its pick here       -> redrawn with the pick when it lands
 *   g. you type "W Mine" in the site's box -> the room is told Mine only, never your saved W
 *   h. the streamer's own heatsync emote   -> draws, and leads a 7tv emote of its name
 *   j. `W w! W`, `W ffzX W`, `w! then W`   -> the emote after, the emote before, and a word left alone
 *   k. `w! <twitch emote>`, `<twitch emote> ffzX` -> twitch's own emote changes and the word leaves the line
 * (the emote law: the site's docs/emote-law.md; src/content/native-emote-law.js)
 * then right-click another chatter's W: it is blocked, the viewer's own W is NOT removed, and
 * only that exact emote hides (rules 9, 10).
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
// Stand-ins for real twitch structure (the content script keys on class names + attributes only):
//  .chat-scrollable-area__message-container  = the scrolling list react renders chat rows into
//  .chat-line__message[data-user-id]         = one row; real twitch has the id stamped by early-inject-main.js
//                                              (MAIN world, reads the react fiber) - fixture sets the attribute directly
//  .chat-author__display-name                = the sender name span
//  span.text-fragment                        = react's text run; <img.chat-image alt=W> = twitch's own emote img
//  [data-a-target="chat-input"]            = twitch's own box (a contenteditable)
const body =
  '<div id="host-content" style="height:100vh"><div class="chat-scrollable-area__message-container" id="list"></div>' +
  '<div data-a-target="chat-input" contenteditable="true" id="box" style="position:fixed;bottom:0;left:0;width:400px;height:30px;background:#222;color:#fff"></div></div>'
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
const prof = mkdtempSync(join(tmpdir(), 'hs-ext-native-'))
const c = await launchWithExtension(prof, [
  '--window-size=1500,900',
  `--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1:${irc.port}`,
  '--ignore-certificate-errors',
  '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
])
const errors: string[] = []
try {
  await c.route('https://heatsync.org/**', (r: any) => r.abort())
  // the sender set for chatter 222: her own W (a name the channel has) and her Solo (one it has not)
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
  for (const h of ['https://api.frankerfacez.com/**', 'https://7tv.io/**', 'https://api.betterttv.net/**'])
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
        { name: 'Mine', url: u.Mine_inv, source: 'heatsync', hash: 'minehash' },
      ],
    })
  }, Object.fromEntries(['W_global', 'W_inv', 'Mine_inv', 'W_bttv', 'W_7tv', 'W_ffz'].map((n) => [n, E(n)])))
  // the per-site "hs off" lives in storage.sync (ui_settings.subsystems), read once at boot
  await seed.evaluate(async () => {
    // @ts-ignore — extension page
    await chrome.storage.sync.set({ ui_settings: { subsystems: { 'overlay-twitch': false } } })
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
  }, ['twitch/probechan', [
    { name: 'W', url: E('W_bttv'), source: 'bttv', hash: 'bttvhash' },
    { name: 'W', url: E('W_7tv'), source: '7tv', hash: 'stvhash' },
    { name: 'W', url: E('W_ffz'), source: 'ffz', hash: 'ffzhash' },
    // the streamer's own heatsync emotes: no `source`, as the background maps them (mapChannelOwnerEmote)
    { name: 'Own', url: E('Own_streamer'), hash: 'ownerhash', provider: 'heatsync' },
    { name: 'Dup', url: E('Dup_streamer'), hash: 'dupownerhash', provider: 'heatsync' },
    { name: 'Dup', url: E('Dup_7tv'), source: '7tv', hash: 'dup7tvhash' },
  ]] as [string, unknown[]])

  await seed.close()

  const p = await c.newPage()
  p.on('pageerror', (e: unknown) => errors.push(String(e).slice(0, 300)))
  await p.goto('https://www.twitch.tv/probechan', { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(5000)
  check(await p.evaluate(() => !document.getElementById('hs-mc-container')), 'overlay is off (native rows are processed)')
  const chans = [
    { name: 'W', url: E('W_bttv'), source: 'bttv', hash: 'bttvhash' },
    { name: 'W', url: E('W_7tv'), source: '7tv', hash: 'stvhash' },
    { name: 'W', url: E('W_ffz'), source: 'ffz', hash: 'ffzhash' },
    // the streamer's own heatsync emotes: no `source`, as the background maps them (mapChannelOwnerEmote)
    { name: 'Own', url: E('Own_streamer'), hash: 'ownerhash', provider: 'heatsync' },
    { name: 'Dup', url: E('Dup_streamer'), hash: 'dupownerhash', provider: 'heatsync' },
    { name: 'Dup', url: E('Dup_7tv'), source: '7tv', hash: 'dup7tvhash' },
  ]
  await sw.evaluate(async (emotes: any[]) => {
    // @ts-ignore — service worker globals
    channelEmotesMap['twitch/probechan'] = emotes
    // @ts-ignore
    channelEmotesFetchedAt['twitch/probechan'] = Date.now()
    // @ts-ignore
    await bgPersistChannelEmotes('twitch/probechan')
    // @ts-ignore
    broadcastToTabs({ type: 'channel_emotes_update', channelOwner: 'probechan', platform: 'twitch', emotes })
  }, chans)
  await p.waitForTimeout(1500)

  await p.evaluate(() => {
    const add = (user: string, uid: number, pre: string, native: boolean) => {
      const row = document.createElement('div')
      row.className = 'chat-line__message'
      row.setAttribute('data-user-id', String(uid))
      row.innerHTML = `<span class="chat-author__display-name">${user}</span>: <span class="text-fragment">${pre} ${native ? '' : 'W'}</span>` +
        (native ? '<span class="text-fragment"><img class="chat-image" alt="W" src="https://static-cdn.jtvnw.net/emoticons/v2/555/default/dark/1.0"></span>' : '')
      document.getElementById('list')!.appendChild(row)
    }
    ;(window as any).__add = add
    add('alice', 111, 'alpha', false)
    add('bobtag', 333, 'beta', true)
    add('carol', 222, 'gamma', false)
    add('alice', 111, 'omega Own Dup then', false)
    const solo = document.createElement('div')
    solo.className = 'chat-line__message'
    solo.setAttribute('data-user-id', '222')
    solo.innerHTML = '<span class="chat-author__display-name">carol</span>: <span class="text-fragment">delta Solo</span>'
    document.getElementById('list')!.appendChild(solo)
  })
  await p.waitForTimeout(4000)

  const imgOf = (word: string) =>
    p.evaluate((w: string) => {
      const row = [...document.querySelectorAll('.chat-line__message')].find((r) => (r.textContent || '').includes(w))
      const wr = row?.querySelector('.heatsync-emote-wrapper') as HTMLElement | null
      const img = (wr?.querySelector('img') || row?.querySelector('img')) as HTMLImageElement | null
      return { src: img?.getAttribute('src') || '', state: (wr?.className.match(/emote-overlay-(\w+)/)?.[1] || ''), wrapped: !!wr, hidden: !!img && getComputedStyle(img).display === 'none' }
    }, word)
  const a = await imgOf('alpha')
  check(a.src.includes('W_ffz'), `a. another chatter's bare W draws the channel ffz W (got ${a.src || 'nothing'})`)
  const b = await imgOf('beta')
  check(b.src.includes('/555/') && !b.wrapped, `b. twitch's own emote img is left alone (got ${b.src || 'nothing'}, wrapped ${b.wrapped})`)
  let cc = await imgOf('gamma')
  check(cc.src.includes('W_ffz'), `c. a chatter's saved W does not take the channel's name: her typed W is the channel ffz W (got ${cc.src || 'nothing'})`)
  const dd = await imgOf('delta')
  check(dd.src.includes('Solo_sender'), `d. her Solo, a name the channel has not, draws her picture (got ${dd.src || 'nothing'})`)
  const hh: string[] = await p.evaluate(() => {
    const row = [...document.querySelectorAll('.chat-line__message')].find((r) => (r.textContent || '').includes('omega'))
    return [...(row?.querySelectorAll('.heatsync-emote-wrapper > img:first-child') || [])].map((i) => i.getAttribute('src') || '')
  })
  check(hh.length === 3 && hh[0].includes('Own_streamer') && hh[1].includes('Dup_streamer') && hh[2].includes('W_ffz'), `h. the streamer's own emotes draw and lead a 7tv emote of the same name (got ${JSON.stringify(hh)})`)
  check(a.state !== 'owned' && cc.state !== 'owned', `other chatters' W are not labelled yours (states ${a.state}, ${cc.state})`)

  // n. twitch's box (autocomplete-hook.js, MAIN world) asks content.js for the law's list across the worlds, in one
  // tick: the typed word goes into the bridge, `heatsync-law-offer` fires, the rows are there when it returns.
  // Every copy of W is offered, the room's first, then yours, then the global (the hook folded them to one).
  const offer = (word: string, native = '') =>
    p.evaluate(([w, n]: string[]) => {
      const b = document.getElementById('heatsync-emote-bridge')!
      b.dataset.offerNative = n
      b.dataset.offerQ = w
      b.dataset.offer = '[]'
      document.dispatchEvent(new Event('heatsync-law-offer'))
      return JSON.parse(b.dataset.offer || '[]').map((r: any) => `${r.name}:${(r.url || '').split('/').pop()}`)
    }, [word, native])
  const ws = await offer('w')
  check(JSON.stringify(ws) === JSON.stringify(['W:W_ffz.png', 'W:W_inv.png', 'W:W_global.png', 'Own:Own_streamer.png']),
    `n. the bridge offers the room's W, then yours, then the global's (got ${JSON.stringify(ws)})`)
  const kx = await offer('kappax', JSON.stringify([{ name: 'KappaX', hash: '99', url: 'https://static-cdn.jtvnw.net/emoticons/v2/99/default/dark/1.0', sub: false }]))
  check(JSON.stringify(kx) === JSON.stringify(['KappaX:1.0']), `n. the emotes twitch lets you use ride along (got ${JSON.stringify(kx)})`)

  // modifiers on a native row bind by the overlay's rule (shared/emote-mods.vectors.json): this
  // drawer reached back first, and a word with no emote beside it left the line
  await p.evaluate(() => {
    ;(window as any).__add('erin', 666, 'modone W w!', false) // "modone W w! W"
    ;(window as any).__add('erin', 666, 'modtwo W ffzX', false) // "modtwo W ffzX W"
    ;(window as any).__add('erin', 666, 'modthree w! then', false) // "modthree w! then W"
  })
  await p.waitForTimeout(3000)
  const wide = (word: string): Promise<{ scaled: boolean[]; text: string }> =>
    p.evaluate((w: string) => {
      const row = [...document.querySelectorAll('.chat-line__message')].find((r) => (r.textContent || '').includes(w))
      const scaled = [...(row?.querySelectorAll('.heatsync-emote-wrapper') || [])].map((el) => /scale\(/.test(`${(el as HTMLElement).style.transform} ${(el.querySelector('img') as HTMLElement | null)?.style.transform || ''}`))
      return { scaled, text: row?.textContent || '' }
    }, word)
  const m1 = await wide('modone')
  check(JSON.stringify(m1.scaled) === '[false,true]' && !m1.text.includes('w!'), `j. \`W w! W\` on a native row widens the emote after the word, as the overlay does (got ${JSON.stringify(m1)})`)
  const m2 = await wide('modtwo')
  check(JSON.stringify(m2.scaled) === '[true,false]' && !m2.text.includes('ffzX'), `j. \`W ffzX W\` flips the emote before the word (got ${JSON.stringify(m2)})`)
  const m3 = await wide('modthree')
  check(JSON.stringify(m3.scaled) === '[false]' && m3.text.includes('w!'), `j. a word with text between it and the emote stays on the line and changes nothing (got ${JSON.stringify(m3)})`)

  // k. a word beside twitch's OWN emote (another dom node): bound by the same rule, and off the line
  await p.evaluate(() => {
    const tw = '<span class="text-fragment"><img class="chat-image" alt="Kappa" src="https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0"></span>'
    const row = (user: string, html: string) => {
      const el = document.createElement('div')
      el.className = 'chat-line__message'
      el.setAttribute('data-user-id', '777')
      el.innerHTML = `<span class="chat-author__display-name">${user}</span>: ${html}`
      document.getElementById('list')!.appendChild(el)
    }
    row('fay', `<span class="text-fragment">modfour w! </span>${tw}<span class="text-fragment"> tail</span>`)
    row('fay', `<span class="text-fragment">modfive </span>${tw}<span class="text-fragment"> ffzX tail</span>`)
    row('fay', `<span class="text-fragment">modsix </span>${tw}<span class="text-fragment"> hello w!</span>`)
  })
  await p.waitForTimeout(3000)
  const own = (word: string): Promise<{ tf: string; text: string }> =>
    p.evaluate((w: string) => {
      const row = [...document.querySelectorAll('.chat-line__message')].find((r) => (r.textContent || '').includes(w))
      const img = row?.querySelector('img.chat-image') as HTMLElement | null
      return { tf: img?.style.transform || '', text: (row?.textContent || '').replace(/\s+/g, ' ').trim() }
    }, word)
  const k1 = await own('modfour')
  check(k1.tf.includes('scale(2, 1)') && !k1.text.includes('w!'), `k. \`w!\` before twitch's own emote widens it and leaves the line (got ${JSON.stringify(k1)})`)
  const k2 = await own('modfive')
  check(k2.tf.includes('scale(-1, 1)') && !k2.text.includes('ffzX') && k2.text.includes('tail'), `k. \`ffzX\` after twitch's own emote flips it and leaves the line (got ${JSON.stringify(k2)})`)
  const k3 = await own('modsix')
  check(!k3.tf && k3.text.includes('hello w!'), `k. with text between, the word stays and the emote is untouched (got ${JSON.stringify(k3)})`)

  // e. her app announces a pick (what a send does when she chose her own W on purpose): the line
  // that comes with it draws her W; the line she sent before, by hand, keeps the channel's
  const announce = (username: string, hash: string, pic: string) =>
    sw.evaluate(([u, h, url]: string[]) => {
      // @ts-ignore — service worker globals
      broadcastToTabs({ type: 'emote_broadcast', username: u, emoteName: 'W', emoteData: { url, hash: h } })
    }, [username, hash, E(pic)])
  await announce('carol', 'senderhash', 'W_sender')
  await p.evaluate(() => (window as any).__add('carol', 222, 'epsilon', false))
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

  // g. the viewer types into the site's own box: W is the channel's (told to nobody), Mine is
  // theirs and the channel has none (told). The old send told the room about both.
  await sw.evaluate(() => {
    // @ts-ignore — service worker globals
    globalThis.__told = []
    // @ts-ignore
    broadcastEmoteUsage = (name: string, hash: string) => (globalThis.__told.push(`${name}=${hash}`), { success: true })
  })
  await p.click('#box')
  await p.keyboard.type('W Mine hi W')
  await p.keyboard.press('Enter')
  await p.waitForTimeout(800)
  // @ts-ignore — service worker globals
  const told: string[] = await sw.evaluate(() => globalThis.__told)
  check(JSON.stringify(told) === JSON.stringify(['Mine=minehash']), `g. typing "W Mine hi W" tells the room about Mine only (told: ${JSON.stringify(told)})`)

  const rc = async (word: string, tag: string) => {
    await p.evaluate(([w, t]: string[]) => {
      const row = [...document.querySelectorAll('.chat-line__message')].find((r) => (r.textContent || '').includes(w))
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
  check(mid.src.includes('/555/'), 'the twitch emote still shows')
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
  // i. the streamer adds an emote while you watch: the push every socket gets re-reads their set
  // (not at the 30 minute TTL), and the next row that says the word draws it
  let ownerReads = 0
  await c.route('https://heatsync.org/api/emotes/user/probechan**', (r: any) => {
    ownerReads++
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        emotes: [
          { name: 'Own', url: E('Own_streamer'), hash: 'ownerhash', provider: 'heatsync' },
          { name: 'Live', url: E('Live_streamer'), hash: 'livehash', provider: 'heatsync' },
        ],
      }),
    })
  })
  const inUse: boolean = await sw.evaluate(() => {
    // @ts-ignore — service worker globals: the id twitch gave for the channel, as a join resolves it
    twitchIdCache.set('probechan', '999')
    // @ts-ignore
    const open = [...tabChannels.values()].some((e) => e?.channel === 'twitch/probechan')
    // someone else changed their emotes: nothing is read
    // @ts-ignore
    handleWSMessage({ type: 'emote:added', username: 'stranger', emoteName: 'Live', senderKeys: ['twitch:123', 'kick:probechan'], ver: 6 })
    return open
  })
  check(inUse, 'i. the tab on twitch.tv/probechan is a channel in use')
  await p.waitForTimeout(2500)
  check(ownerReads === 0, `i. a stranger's emote change reads no streamer's set (reads: ${ownerReads})`)
  await sw.evaluate(() => {
    // @ts-ignore — the streamer's own push, as the server sends it
    handleWSMessage({ type: 'emote:added', username: 'probechan', emoteName: 'Live', senderKeys: ['twitch:999'], ver: 7 })
  })
  let held = false
  for (let i = 0; i < 40 && !held; i++) {
    await p.waitForTimeout(250)
    held = await sw.evaluate(() => {
      // @ts-ignore
      const list = channelEmotesMap['twitch/probechan']
      return Array.isArray(list) && list.some((e: any) => e.name === 'Live')
    })
  }
  check(held && ownerReads === 1, `i. the streamer's push re-reads their set once (held ${held}, reads ${ownerReads})`)
  await p.evaluate(() => (window as any).__add('alice', 111, 'sigma Live then', false))
  let live = { src: '' } as { src: string }
  for (let i = 0; i < 24 && !live.src.includes('Live_streamer'); i++) {
    await p.waitForTimeout(250)
    live = await imgOf('sigma')
  }
  check(live.src.includes('Live_streamer'), `i. a row after the streamer added Live draws it, with no reload (got ${live.src || 'nothing'})`)
  const kept = await sw.evaluate(() => {
    // @ts-ignore
    const list = channelEmotesMap['twitch/probechan'] as any[]
    return ['bttvhash', 'stvhash', 'ffzhash'].filter((h) => list.some((e) => e.hash === h)).length
  })
  check(kept === 3, `i. the channel's other emotes are still there after the re-read, providers unreachable (kept ${kept} of 3)`)

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

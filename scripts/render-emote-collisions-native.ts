/**
 * NATIVE twitch rows (overlay off): same-name emote collisions, in a real browser, against the BUILT extension.
 *
 *   bun run test:emotes   (builds dist/chrome in THIS checkout, then runs this)
 *
 * The word W exists in the channel (ffz + 7tv + bttv: three pictures), in globals and in the
 * viewer's inventory — six distinct urls. Raw PRIVMSGs come over a local wss mock (twitch is
 * never contacted):
 *   a. another chatter's bare W            -> the channel ffz W   (rules 3, 4)
 *   b. a line with an IRC emotes= tag on W -> the twitch emote    (rule 1)
 *   c. a line whose sender set holds W=X   -> X                   (rule 2)
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
const body = '<div id="host-content" style="height:100vh"><div class="chat-scrollable-area__message-container" id="list"></div></div>'
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
  // the sender set for chatter 222 (rule 2): their W is the picture X
  await c.route('https://heatsync.org/api/users/emotes/batch**', (r: any) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sets: { 'twitch:222': [{ name: 'W', url: E('W_sender'), hash: 'senderhash', added_at: '2020-01-01T00:00:00Z', source: 'extension' }] },
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
      emote_inventory: [{ name: 'W', url: u.W_inv, source: 'heatsync', hash: 'invhash' }],
      channel_emotes_map: {
        'twitch/probechan': [
          { name: 'W', url: u.W_bttv, source: 'bttv', hash: 'bttvhash' },
          { name: 'W', url: u.W_7tv, source: '7tv', hash: 'stvhash' },
          { name: 'W', url: u.W_ffz, source: 'ffz', hash: 'ffzhash' },
        ],
      },
    })
  }, Object.fromEntries(['W_global', 'W_inv', 'W_bttv', 'W_7tv', 'W_ffz'].map((n) => [n, E(n)])))
  // the per-site "hs off" lives in storage.sync (ui_settings.subsystems), read once at boot
  await seed.evaluate(async () => {
    // @ts-ignore — extension page
    await chrome.storage.sync.set({ ui_settings: { subsystems: { 'overlay-twitch': false } } })
  })
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
  ]
  await sw.evaluate(async (emotes: any[]) => {
    // @ts-ignore
    await chrome.storage.local.set({ channel_emotes_map: { 'twitch/probechan': emotes } })
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
    add('alice', 111, 'alpha', false)
    add('bobtag', 333, 'beta', true)
    add('carol', 222, 'gamma', false)
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
  const cc = await imgOf('gamma')
  check(cc.src.includes('W_sender'), `c. the sender-set W draws the sender's picture (got ${cc.src || 'nothing'})`)
  check(a.state !== 'owned' && cc.state !== 'owned', `other chatters' W are not labelled yours (states ${a.state}, ${cc.state})`)

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
  // note: a native wrapper keeps every same-name picture as a hidden sibling, so after a block the
  // line may fall to the next one (reported as a divergence from multichat's placeholder) - what
  // rule 9 pins is WHICH key is stored, so that is what is asserted.
  await rc('alpha', 'alice')
  let bl = await blockedNow()
  check(bl.includes('ffzhash'), `right-click on alice's W stores that emote's own key (blocked: ${JSON.stringify(bl)})`)
  check(!bl.includes('bttvhash') && !bl.includes('invhash') && !bl.includes('senderhash'), 'no other W was blocked by it')
  const mid = await imgOf('beta')
  check(mid.src.includes('/555/'), 'the twitch emote still shows')
  await rc('gamma', 'carol')
  bl = await blockedNow()
  check(bl.includes('senderhash'), `right-click on carol's W (shares your W's name) blocks her emote (blocked: ${JSON.stringify(bl)})`)
  check(!bl.includes('invhash'), 'your own inventory W is not blocked')
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

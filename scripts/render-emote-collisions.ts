/**
 * Same-name emote collisions, in a real browser, against the BUILT extension.
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
    ]
    // the panel's loadEmotes() re-reads storage on every update, so the storage has to agree
    // @ts-ignore — service worker globals
    await chrome.storage.local.set({ channel_emotes_map: { 'twitch/probechan': emotes } })
    // @ts-ignore — service worker globals
    broadcastToTabs({
      type: 'channel_emotes_update',
      channelOwner: 'probechan',
      platform: 'twitch',
      emotes,
    })
  }, Object.fromEntries(['W_bttv', 'W_7tv', 'W_ffz'].map((n) => [n, E(n)])))
  await p.waitForTimeout(1500)

  const now = Date.now()
  const line = (name: string, uid: number, mid: string, text: string, extra = '') =>
    irc.push(
      `@display-name=${name};color=#FF0000;user-id=${uid};id=${mid};tmi-sent-ts=${now}${extra} :${name}!${name}@${name}.tmi.twitch.tv PRIVMSG #probechan :${text}\r\n`,
    )
  line('alice', 111, 'ca', 'alpha W')
  line('bobtag', 333, 'cb', 'beta W', ';emotes=555:5-5')
  line('carol', 222, 'cc', 'gamma W')
  await until(p, async () => (await p.evaluate(() => document.getElementById('hs-mc-messages')?.textContent || '')).includes('gamma'))
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
  check(cc.src.includes('W_sender'), `c. the sender-set W draws the sender's picture (got ${cc.src || 'nothing'})`)

  // right-click alice's W: blocked, inventory untouched, other W emotes unaffected
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
  }
  check(after.a.state === 'blocked', `right-click blocks the clicked W (state ${after.a.state})`)
  check(after.b.state !== 'blocked', `the IRC-tag W (a different emote) is not hidden (state ${after.b.state})`)
  check(after.c.state !== 'blocked', `the sender-set W (a different emote) is not hidden (state ${after.c.state})`)
  // carol's W is yours-by-name too (you own a W) but it is NOT your emote: right-click must block it,
  // and your own W must still be in your inventory afterwards
  await p.evaluate(() => {
    const row = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].find((r) => (r.textContent || '').includes('gamma'))
    ;(row?.querySelector('.hs-mc-emote-wrapper img') as HTMLElement | null)?.setAttribute('data-hs-probe', 'carol')
  })
  await p.click('[data-hs-probe="carol"]', { button: 'right' })
  await p.waitForTimeout(2500)
  const afterCarol = { c: await imgOf('gamma'), b: await imgOf('beta'), a: await imgOf('alpha') }
  check(afterCarol.c.state === 'blocked', `right-click on a W that merely shares your W's name blocks it (state ${afterCarol.c.state})`)
  check(afterCarol.b.state !== 'blocked', `... and the IRC-tag W still shows (state ${afterCarol.b.state})`)
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

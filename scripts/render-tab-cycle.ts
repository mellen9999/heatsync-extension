/**
 * Tab cycles through emote candidates, from a real keyboard, in the panel composer:
 * a prefix that matches three emotes, Tab x3 gives three different ones in order,
 * Shift+Tab walks back. Twice: on heatsync's own files, and on 7tv-shaped ones (the box draws a
 * 7tv avif as its webp twin, and a chip drawn from the raw url read as a different picture, so the
 * box redrew it and the cycle lost its place: Tab once, then nothing).
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
const E7 = (n: string) => `https://cdn.7tv.app/emote/${n}/1x.avif`
const NAMES = ['Zork1', 'Zork2', 'Zork3', 'Zork4']
const NAMES7 = ['Zap1', 'Zap2', 'Zap3']
const body = '<div id="host-content" style="height:100vh">host page</div><div class="right-column right-column--beside" id="rcol"></div>'
const html = `<!doctype html><html><head><title>fixture</title></head><body style="margin:0">${body}</body></html>`

const failures: string[] = []
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failures.push(msg)
}

const irc = startMockIrc()
if (!irc) {
  console.log('SKIPPED — openssl missing, no cert for the mock irc server')
  process.exit(0)
}
const prof = mkdtempSync(join(tmpdir(), 'hs-ext-tabcycle-'))
const c = await launchWithExtension(prof, [
  '--window-size=1500,900',
  `--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1:${irc.port}`,
  '--ignore-certificate-errors',
  '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
])
try {
  await c.route('https://heatsync.org/**', (r: any) => r.abort())
  for (const h of ['https://api.frankerfacez.com/**', 'https://7tv.io/**', 'https://api.7tv.app/**', 'https://api.betterttv.net/**'])
    await c.route(h, (r: any) => r.abort())
  await c.route('https://cdn.heatsync.org/**', (r: any) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await c.route('https://cdn.7tv.app/**', (r: any) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await c.route('https://static-cdn.jtvnw.net/**', (r: any) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await c.route('https://www.twitch.tv/**', (r: any) => r.fulfill({ status: 200, contentType: 'text/html', body: html }))
  await c.addCookies([
    { name: 'auth-token', value: 'harnesstoken0000', domain: '.twitch.tv', path: '/', secure: true },
    { name: 'login', value: 'probeuser', domain: '.twitch.tv', path: '/', secure: true },
    { name: 'auth', value: 'harnessauth0000', domain: 'heatsync.org', path: '/', secure: true, httpOnly: true },
  ])
  let sw = c.serviceWorkers()[0]
  if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 20_000 })
  const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
  const seed = await c.newPage()
  await seed.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
  await seed.evaluate(async () => {
    // @ts-ignore — extension page
    await chrome.storage.local.set({
      heatsync_multichat: { channels: [{ id: 'probechan', twitch: 'probechan', kick: '', youtube: '' }] },
      user_info: { username: 'probeuser' },
    })
  })
  await seed.close()
  const emotes = [
    ...NAMES.map((n) => ({ name: n, url: E(n), source: '7tv', hash: `${n}hash` })),
    ...NAMES7.map((n) => ({ name: n, url: E7(n), source: '7tv', hash: n })),
  ]
  const p = await c.newPage()
  await p.goto('https://www.twitch.tv/probechan', { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('#hs-mc-input', { timeout: 25_000 })
  await p.waitForTimeout(2500)
  await sw.evaluate(async (list: unknown[]) => {
    // @ts-ignore — service worker globals
    channelEmotesMap['twitch/probechan'] = list
    // @ts-ignore
    channelEmotesFetchedAt['twitch/probechan'] = Date.now()
    // @ts-ignore
    await bgPersistChannelEmotes('twitch/probechan')
    // @ts-ignore
    broadcastToTabs({ type: 'channel_emotes_update', channelOwner: 'probechan', platform: 'twitch', emotes: list })
  }, emotes)
  await p.waitForTimeout(1500)

  const chips = () =>
    p.evaluate(() => [...document.querySelectorAll<HTMLImageElement>('#hs-mc-input img')].map((i) => i.dataset.emoteName))
  await p.click('#hs-mc-input')
  await p.keyboard.type('Zor', { delay: 30 })
  const seen: string[] = []
  for (let i = 0; i < 3; i++) {
    await p.keyboard.press('Tab')
    await p.waitForTimeout(250)
    seen.push((await chips()).join(','))
  }
  check(new Set(seen).size === 3 && seen.every(Boolean), `panel: three Tabs give three different emotes (got ${seen.join(' | ')})`)
  await p.keyboard.press('Shift+Tab')
  await p.waitForTimeout(250)
  const back = (await chips()).join(',')
  check(back === seen[1], `panel: Shift+Tab goes back one (got ${back}, want ${seen[1]})`)

  await p.keyboard.press('Escape')
  await p.evaluate(() => {
    const box = document.getElementById('hs-mc-input') as HTMLElement
    box.textContent = ''
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await p.keyboard.type('Zap', { delay: 30 })
  const seen7: string[] = []
  for (let i = 0; i < 3; i++) {
    await p.keyboard.press('Tab')
    await p.waitForTimeout(250)
    seen7.push((await chips()).join(','))
  }
  check(new Set(seen7).size === 3 && seen7.every(Boolean), `panel, 7tv files: three Tabs give three different emotes (got ${seen7.join(' | ')})`)
  await p.close()
} finally {
  await c.close().catch(() => {})
  irc.close?.()
  rmSync(prof, { recursive: true, force: true })
}
if (failures.length) {
  console.log(`\n${failures.length} failed`)
  process.exit(1)
}
console.log('\nall held')
process.exit(0)

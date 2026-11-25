/**
 * Tab cycles through emote candidates in kick's own chat box, from a real keyboard: a prefix that matches
 * four emotes, Tab x3 gives three different ones in order, Shift+Tab goes back one. (the list kick's hook
 * draws under the box took the first Tab and left the cycle nothing to step: Tab stuck on the first emote)
 * the panel's twin is render-tab-cycle.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from './lib/chromium'
import { startMockIrc } from './lib/mock-irc'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const E = (n: string) => `https://cdn.heatsync.org/emote/${n}.png`
const NAMES = ['Zork1', 'Zork2', 'Zork3', 'Zork4']
const html = `<!doctype html><html><head><title>fixture</title></head><body style="margin:0"><div id="host-content" style="height:100vh"><div id="chatroom-messages"><div id="list"></div></div><div class="editor-input" contenteditable="true" style="position:fixed;bottom:0;left:0;width:600px;height:40px;background:#000;color:#fff"></div></div></body></html>`
const failures: string[] = []
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failures.push(msg)
}
const irc = startMockIrc()
if (!irc) process.exit(0)
const prof = mkdtempSync(join(tmpdir(), 'hs-ext-tabcyk-'))
const c = await launchWithExtension(prof, ['--window-size=1500,900', `--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1:${irc.port}`, '--ignore-certificate-errors'])
try {
  await c.route('https://heatsync.org/**', (r: any) => r.abort())
  for (const h of ['https://api.frankerfacez.com/**', 'https://7tv.io/**', 'https://api.betterttv.net/**']) await c.route(h, (r: any) => r.abort())
  await c.route('https://cdn.heatsync.org/**', (r: any) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await c.route('https://kick.com/**', (r: any) => r.fulfill({ status: 200, contentType: 'text/html', body: html }))
  await c.addCookies([{ name: 'login', value: 'probeuser', domain: '.kick.com', path: '/', secure: true }])
  let sw = c.serviceWorkers()[0]
  if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 20_000 })
  const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
  const seed = await c.newPage()
  await seed.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
  await seed.evaluate(async () => {
    // @ts-ignore
    await chrome.storage.local.set({ heatsync_multichat: { channels: [{ id: 'probechan', twitch: 'probechan', kick: '', youtube: '' }] }, user_info: { username: 'probeuser' } })
    // @ts-ignore
    await chrome.storage.sync.set({ ui_settings: { subsystems: { 'overlay-kick': false } } })
  })
  await seed.close()
  const emotes = NAMES.map((n) => ({ name: n, url: E(n), source: '7tv', hash: `${n}hash` }))
  const push = async () =>
    sw.evaluate(async (list: any[]) => {
      // @ts-ignore
      channelEmotesMap['kick/probechan'] = list
      // @ts-ignore
      channelEmotesFetchedAt['kick/probechan'] = Date.now()
      // @ts-ignore
      await bgPersistChannelEmotes('kick/probechan')
      // @ts-ignore
      broadcastToTabs({ type: 'channel_emotes_update', channelOwner: 'probechan', platform: 'kick', emotes: list })
    }, emotes)
  await push()
  const p = await c.newPage()
  await p.goto('https://kick.com/probechan', { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(5000)
  await push()
  await p.waitForTimeout(1500)
  const text = () => p.evaluate(() => (document.querySelector('div.editor-input') as HTMLElement).textContent || '')
  await p.click('div.editor-input')
  await p.keyboard.type('Zor', { delay: 30 })
  await p.waitForTimeout(300)
  const seen: string[] = []
  for (let i = 0; i < 3; i++) {
    await p.keyboard.press('Tab')
    await p.waitForTimeout(250)
    seen.push((await text()).trim())
  }
  check(new Set(seen).size === 3 && seen.every(Boolean), `kick: three Tabs give three different emotes (got ${seen.join(' | ')})`)
  await p.keyboard.press('Shift+Tab')
  await p.waitForTimeout(250)
  const back = (await text()).trim()
  check(back === seen[1], `kick: Shift+Tab goes back one (got ${back}, want ${seen[1]})`)
} finally {
  await c.close().catch(() => {})
  rmSync(prof, { recursive: true, force: true })
}
process.exit(failures.length ? 1 : 0)

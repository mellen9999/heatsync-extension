/**
 * An event row that carries a line its sender typed, in a real browser, against the BUILT
 * extension (twitch is never contacted: raw USERNOTICEs come over a local wss mock).
 *
 *   bun run build.js chrome --minify && bun scripts/render-notice-lines.ts
 *
 *   a. a shared watch streak with a typed line -> two lines: the event, then "name: line"
 *   b. a resub with a message                  -> the same two lines
 *   c. a sub with no message                   -> one line, the whole row its label
 * and on a and b the typed line is body text (white), the event keeps the fill's label colour.
 * It was one long run: "Rilout watched 255 consecutive streams …![T]Rilout: soviHii".
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from './lib/chromium'
import { startMockIrc } from './lib/mock-irc'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const html =
  '<!doctype html><html><head><title>fixture</title></head><body style="margin:0"><div id="host-content" style="height:100vh">host page</div><div class="right-column right-column--beside" id="rcol"></div></body></html>'

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
const prof = mkdtempSync(join(tmpdir(), 'hs-ext-notice-'))
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
  await seed.evaluate(async () => {
    // @ts-ignore — extension page
    await chrome.storage.local.set({
      heatsync_multichat: { channels: [{ id: 'probechan', twitch: 'probechan', kick: '', youtube: '' }] },
      user_info: { username: 'probeuser' },
    })
  })
  await seed.close()
  const p = await c.newPage()
  await p.goto('https://www.twitch.tv/probechan', { waitUntil: 'load' })
  await p.waitForSelector('#hs-mc-messages', { timeout: 30_000 })
  await p.waitForTimeout(3000)

  const notice = (who: string, uid: number, mid: string, tags: string, system: string, said = '') =>
    irc.push(
      `@badges=;color=#00FF00;display-name=${who};login=${who.toLowerCase()};${tags};system-msg=${system.replace(/ /g, '\\s')};user-id=${uid};id=${mid};room-id=1;tmi-sent-ts=${Date.now()} :tmi.twitch.tv USERNOTICE #probechan${said ? ` :${said}` : ''}\r\n`,
    )
  notice('Rilout', 901, 'n1', 'msg-id=viewermilestone;msg-param-category=watch-streak;msg-param-value=255', 'Rilout watched 255 consecutive streams and sparked a watch streak!', 'streakline hello')
  notice('Resubber', 902, 'n2', 'msg-id=resub;msg-param-cumulative-months=7;msg-param-sub-plan=1000', 'Resubber subscribed at Tier 1. They have subscribed for 7 months!', 'resubline hello')
  notice('Newsub', 903, 'n3', 'msg-id=sub;msg-param-sub-plan=1000', 'Newsub subscribed at Tier 1.')
  const seen = async () => (await p.evaluate(() => document.getElementById('hs-mc-messages')?.textContent || '')).includes('Newsub subscribed')
  for (let w = 0; w < 20_000 && !(await seen()); w += 400) await p.waitForTimeout(400)
  await p.waitForTimeout(1500)

  const read = (word: string) =>
    p.evaluate((w: string) => {
      const row = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].find((r) => (r.textContent || '').includes(w)) as HTMLElement | undefined
      if (!row) return null
      const sys = row.querySelector('.hs-mc-system-text') as HTMLElement | null
      const name = row.querySelector('.hs-mc-user') as HTMLElement | null
      const text = row.querySelector('.hs-mc-text') as HTMLElement | null
      const top = (el: Element | null) => (el ? Math.round(el.getBoundingClientRect().top) : -1)
      const bottom = (el: Element | null) => (el ? Math.round(el.getBoundingClientRect().bottom) : -1)
      return {
        filled: row.classList.contains('hs-filled'),
        wholeLabel: row.classList.contains('hs-row-label'),
        sysTop: top(sys),
        sysBottom: bottom(sys),
        nameTop: top(name),
        sysColor: sys ? getComputedStyle(sys).color : '',
        textColor: text ? getComputedStyle(text).color : '',
        lines: Math.round(row.getBoundingClientRect().height / parseFloat(getComputedStyle(row).lineHeight || '20')),
        said: text?.textContent || '',
      }
    }, word)

  for (const [tag, word, what] of [
    ['a', 'streakline', 'a shared watch streak with a typed line'],
    ['b', 'resubline', 'a resub with a message'],
  ]) {
    const r = await read(word)
    check(!!r?.filled, `${tag}. ${what} is a filled event row (got ${JSON.stringify(r)})`)
    check(!!r && r.nameTop >= r.sysBottom - 1, `${tag}. its sender's line starts under the event text, not beside it (event ${r?.sysTop}–${r?.sysBottom}, name at ${r?.nameTop})`)
    check(!!r && !r.wholeLabel && r.textColor === 'rgb(255, 255, 255)', `${tag}. the typed line is body text, white (got ${r?.textColor})`)
    check(!!r && r.sysColor !== 'rgb(255, 255, 255)' && r.sysColor !== '', `${tag}. the event text keeps the fill's label colour (got ${r?.sysColor})`)
  }
  // SHOT=<file.png> keeps a picture of the rows, to look at
  if (process.env.SHOT) await p.locator('#hs-mc-messages').screenshot({ path: process.env.SHOT })
  const n = await read('Newsub subscribed')
  check(!!n?.filled && !!n.wholeLabel && n.nameTop === -1, `c. a sub with no message is one label line, no sender line (got ${JSON.stringify(n)})`)
} finally {
  try {
    await Promise.race([c.close(), new Promise((r) => setTimeout(r, 8000))])
  } catch (_) {}
  irc.stop()
  rmSync(prof, { recursive: true, force: true })
}
if (failures.length) {
  console.error(`\n✗ ${failures.length} notice line check(s) failed`)
  process.exit(1)
}
console.log('\n✓ notice line checks passed')
process.exit(0)

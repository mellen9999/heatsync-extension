/**
 * Right-to-left mirroring, asserted in a real browser.
 *
 *   bun run test:rtl
 *
 * Loads the BUILT extension on a twitch channel fixture twice, once with the
 * ui locale forced to arabic and once to english, and checks that the panel
 * (tab bar, overlay, composer, context menu, reply pill) mirrors in rtl and is
 * untouched in ltr. Separate from render-extension.ts on purpose: that file
 * owns geometry, this one owns direction.
 *
 * Network is dead except the fixture and the mock irc; the locale file is read
 * by the content script straight from the extension, so it is let through.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertBuilt, launchWithExtension } from './lib/chromium'
import { startMockIrc } from './lib/mock-irc'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAIAAAD9b0jDAAAAGklEQVR4nGP8z0A9wEQ9AAYGBqNhGDYMAAAhsQEEIXIdMQAAAABJRU5ErkJggg==',
  'base64',
)
const BODY =
  '<div id="host-content" style="height:100vh">host page</div><div class="right-column right-column--beside" id="rcol"></div>'

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`)
}

async function run(locale: 'ar' | 'en') {
  const rtl = locale === 'ar'
  const dir = rtl ? 'rtl' : 'ltr'
  const irc = startMockIrc()
  if (!irc) throw new Error('no openssl, no mock irc')
  const prof = mkdtempSync(join(tmpdir(), 'hs-rtl-'))
  const c = await launchWithExtension(prof, [
    '--window-size=1500,900',
    `--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1:${irc.port}`,
    '--ignore-certificate-errors',
    '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
  ])
  try {
    await c.route('**/*', (r: any) => {
      const u = r.request().url()
      if (u.startsWith('chrome-extension:')) return r.continue()
      if (/\.(png|webp|gif|jpg|jpeg|avif)(\?|$)/i.test(u)) return r.fulfill({ status: 200, contentType: 'image/png', body: PNG })
      return r.abort()
    })
    await c.route('https://www.twitch.tv/**', (r: any) =>
      r.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><head><title>fixture</title></head><body style="margin:0">${BODY}</body></html>`,
      }),
    )
    await c.addCookies([
      { name: 'auth-token', value: 'harnesstoken0000', domain: '.twitch.tv', path: '/', secure: true },
      { name: 'login', value: 'probeuser', domain: '.twitch.tv', path: '/', secure: true },
    ])
    let sw = c.serviceWorkers()[0]
    if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 30_000 })
    const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
    if (!id) throw new Error('no extension id')

    const seed = await c.newPage()
    await seed.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    await seed.evaluate(async (loc: string) => {
      // @ts-ignore
      await chrome.storage.local.set({
        heatsync_multichat: {
          channels: [
            { id: 'probechan', twitch: 'probechan', kick: '', youtube: '' },
            { id: 'otherchan', twitch: 'otherchan', kick: '', youtube: '' },
          ],
        },
        user_info: { username: 'probeuser' },
        hs_ui_locale: loc === 'en' ? '' : loc,
      })
    }, locale)
    await seed.close()

    const p = await c.newPage()
    await p.setViewportSize({ width: 1500, height: 900 })
    await p.goto('https://www.twitch.tv/probechan', { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-input', { timeout: 40_000 })
    await p.waitForTimeout(2500) // the irc socket must be up before anything is pushed at it
    const T = 1762600000000
    irc.push(
      `@display-name=Alice;color=#FF0000;user-id=11;id=rtl-1;tmi-sent-ts=${T};room-id=9999 :alice!alice@alice.tmi.twitch.tv PRIVMSG #probechan :hello chat\r\n`,
    )
    irc.push(
      `@display-name=Dave;color=#FFFF00;user-id=14;id=rtl-2;tmi-sent-ts=${T + 1000};room-id=9999;reply-parent-msg-id=rtl-1;reply-parent-user-id=11;reply-parent-user-login=alice;reply-parent-display-name=Alice;reply-parent-msg-body=hello\\schat :dave!dave@dave.tmi.twitch.tv PRIVMSG #probechan :@alice hi\r\n`,
    )
    await p.waitForSelector('#hs-mc-messages .hs-mc-reply-ctx', { timeout: 15_000 })

    const css = (sel: string, prop: string) =>
      p.evaluate(([s, pr]: string[]) => {
        const el = document.querySelector(s)
        return el ? getComputedStyle(el).getPropertyValue(pr) : 'missing'
      }, [sel, prop])
    const x = (sel: string) =>
      p.evaluate((s: string) => document.querySelector(s)?.getBoundingClientRect().left ?? Number.NaN, sel)

    for (const sel of ['#hs-mc-container', '#hs-mc-tabbar', '#hs-mc-overlay', '#hs-mc-inputbar']) {
      const d = await css(sel, 'direction')
      check(`${locale}: ${sel} direction ${dir}`, d === dir, `got ${d}`)
    }

    // composer: the emote button sits on the far side of the input from where the text starts
    const input = await x('#hs-mc-input')
    const emote = await x('#hs-mc-emote-btn')
    check(`${locale}: emote button ${rtl ? 'left' : 'right'} of the input`, rtl ? emote < input : emote > input, `emote ${emote} input ${input}`)

    // tabs: channel order runs from the start edge
    const a = await x('#hs-mc-tabbar [data-tab="probechan"]')
    const b = await x('#hs-mc-tabbar [data-tab="otherchan"]')
    check(`${locale}: tab order runs from the ${rtl ? 'right' : 'left'}`, rtl ? a > b : a < b, `probechan ${a} otherchan ${b}`)

    // the reply pill follows what it quotes in rtl, and is plain ltr behaviour in ltr
    const bidi = await css('#hs-mc-messages .hs-mc-reply-ctx', 'unicode-bidi')
    check(`${locale}: reply pill unicode-bidi ${rtl ? 'plaintext' : 'normal'}`, bidi === (rtl ? 'plaintext' : 'normal'), `got ${bidi}`)

    // the unified context menu is a body-level popup: it must carry the dir too
    await p.locator('#hs-mc-messages .hs-mc-msg').last().click({ button: 'right', position: { x: 60, y: 8 } })
    await p.waitForSelector('#hs-mc-msg-ctx', { timeout: 5000 })
    const m = await css('#hs-mc-msg-ctx', 'direction')
    check(`${locale}: context menu direction ${dir}`, m === dir, `got ${m}`)
  } finally {
    irc.stop()
    await Promise.race([c.close(), new Promise((r) => setTimeout(r, 15_000))]).catch(() => {})
    rmSync(prof, { recursive: true, force: true })
  }
}

assertBuilt()
await run('en')
await run('ar')
console.log(failed ? `\n${failed} check(s) failed` : '\nall rtl checks passed')
process.exit(failed ? 1 : 0)

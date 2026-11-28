import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from '../lib/chromium'
import { startMockIrc } from '../lib/mock-irc'
import { PLATFORMS, closeContext, errors, fail, fixtureHtml, ok, until } from './lib'

/**
 * Hovering someone's line in a room you moderate shows the mod bar (delete /
 * timeout / ban); never on your own line, never in a room you do not moderate.
 * Twitch is a real socket (mock irc). Standing is told two ways: the twitch
 * graphql answer, and the viewer's own USERSTATE badge (graphql down).
 * Also: hovering a row shows no » / permalink / reply button (hoverReply is off).
 */
const CH = 'modroom'

async function scenario(name: string, { gqlMod, userstateBadge }: { gqlMod: boolean | null; userstateBadge: string }) {
  console.log(`\n── mod hover bar: ${name} ──`)
  const irc = startMockIrc()
  if (!irc) {
    console.log('  ! SKIPPED — openssl not available; the mod hover bar is going UNVERIFIED in this run.')
    return
  }
  const { frames, push } = irc
  const prof = mkdtempSync(join(tmpdir(), 'hs-ext-modhover-'))
  const c = await launchWithExtension(prof, [
    '--window-size=1500,900',
    `--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1:${irc.port}`,
    '--ignore-certificate-errors',
    '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
  ])
  try {
    await c.route('https://heatsync.org/**', (r: any) => r.abort())
    await c.route('https://kick.com/**', (r: any) => r.abort())
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' }
    await c.route('https://gql.twitch.tv/**', (r: any) => {
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors })
      if (gqlMod === null) return r.abort()
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: cors,
        body: JSON.stringify({ data: { user: { self: { isModerator: gqlMod } } } }),
      })
    })
    await c.route(PLATFORMS[0].glob, (r: any) =>
      r.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml(PLATFORMS[0].body) }),
    )
    await c.addCookies([
      { name: 'auth-token', value: 'harnesstoken0000', domain: '.twitch.tv', path: '/', secure: true },
      { name: 'login', value: 'probeuser', domain: '.twitch.tv', path: '/', secure: true },
    ])
    let sw = c.serviceWorkers()[0]
    if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 20_000 })
    const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
    if (!id) fail('could not resolve the extension id for the mod hover check')
    const ep = await c.newPage()
    await ep.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    await ep.evaluate(async (ch: string) => {
      // @ts-ignore — extension page
      await chrome.storage.local.set({
        heatsync_multichat: { channels: [{ id: ch, twitch: ch }] },
        user_info: { username: 'probeuser' },
      })
    }, CH)
    const p = await c.newPage()
    p.on('pageerror', (e: unknown) => errors.push(`mod-hover: ${String(e).slice(0, 300)}`))
    await p.goto(`https://www.twitch.tv/${CH}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-messages', { timeout: 25_000 })
    if (!(await until(p, () => frames.some((f) => f === `JOIN #${CH}`)))) fail('the channel was never joined')
    push(`@badges=${userstateBadge};color=#FF8700;display-name=probeuser;user-id=1 :tmi.twitch.tv USERSTATE #${CH}\r\n`)
    push(`@display-name=chatterbox;color=#00FFFF;user-id=900;id=m-1 :chatterbox!s@s.tmi.twitch.tv PRIVMSG #${CH} :hello from a viewer\r\n`)
    push(`@display-name=probeuser;color=#FF8700;user-id=1;id=m-2 :probeuser!s@s.tmi.twitch.tv PRIVMSG #${CH} :my own line\r\n`)
    const rowOf = (txt: string) => `#hs-mc-messages .hs-mc-msg:has-text("${txt}")`
    await p.waitForSelector(rowOf('hello from a viewer'), { timeout: 15_000 })
    await p.waitForSelector(rowOf('my own line'), { timeout: 15_000 })
    const shown = async (txt: string) => {
      await p.mouse.move(5, 5)
      await p.waitForTimeout(150)
      await p.hover(rowOf(txt))
      return until(p, async () => (await p.locator(`${rowOf(txt)} .hs-mod-toolbar .hs-mc-btn-x, ${rowOf(txt)} .hs-mod-toolbar .hs-mod-btn:visible`).count()) > 0, 6000)
    }
    const expectMod = gqlMod === true || userstateBadge.includes('moderator')
    // let the first answer land, hover again: standing is cached by the second pass
    await shown('hello from a viewer')
    const got = await shown('hello from a viewer')
    if (got === expectMod) ok(`mod bar on a viewer's line is ${expectMod ? 'shown' : 'absent'}`)
    else fail(`mod bar on a viewer's line: expected ${expectMod ? 'shown' : 'absent'}, got ${got ? 'shown' : 'absent'}`)
    if (await shown('my own line')) fail('the mod bar shows on your own line')
    ok('no mod bar on your own line')
    // no hover-only » / permalink / reply button on a row (hoverReply is off by default)
    await p.mouse.move(5, 5)
    await p.hover(rowOf('hello from a viewer'))
    await p.waitForTimeout(300)
    const btns = await p.locator(rowOf('hello from a viewer')).evaluate((row: HTMLElement) =>
      [...row.querySelectorAll('button')]
        .filter((b) => !b.closest('.hs-mod-toolbar') && getComputedStyle(b).display !== 'none')
        .map((b) => b.className),
    )
    if (btns.length) fail(`hovering a row draws a button (hoverReply is off): ${JSON.stringify(btns)}`)
    ok('hover draws no » / permalink / reply button')
  } finally {
    await closeContext(c, 'mod-hover', prof)
    irc.stop()
  }
}

export async function modHoverCheck() {
  await scenario('graphql says mod', { gqlMod: true, userstateBadge: 'subscriber/1' })
  await scenario('graphql down, userstate badge says mod', { gqlMod: null, userstateBadge: 'moderator/1' })
  await scenario('not a mod', { gqlMod: false, userstateBadge: 'subscriber/1' })
}

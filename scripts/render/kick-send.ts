import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from '../lib/chromium'
import { closeContext, errors, fail, fixtureHtml, ok, retryUntil, stable } from './lib'

/**
 * Kick send: overlay composer -> background -> a kick.com tab -> POST.
 *
 * The channel lookup deliberately answers with DIFFERENT ids for the channel
 * (111) and its chatroom (222), because which one ends up in the URL is a
 * silent-failure trap the source comments record from a live incident: a send
 * to the CHANNEL id returns 200 and broadcasts to nobody. A test that used the
 * same number for both would pass either way.
 *
 * Every kick.com request is fulfilled locally, so the real kick is never
 * contacted — including the background's own fetch, which playwright does
 * intercept (routes are matched last-registered-first, hence the ordering).
 */
export async function kickSendCheck() {
  console.log('\n── send on kick, for real ──')
  const prof = mkdtempSync(join(tmpdir(), 'hs-ext-ksend-'))
  const c = await launchWithExtension(prof, ['--window-size=1400,900'])
  const posts: Array<{ url: string, body: string, headers: Record<string, string> }> = []
  try {
    const body =
      '<div id="host-content" style="height:100vh">kick</div>' +
      '<div id="channel-chatroom"><div id="chatroom-messages"><div class="no-scrollbar"></div></div>' +
      '<div id="chatwrap"><div class="editor-input" contenteditable="true"></div></div></div>'

    await c.route('https://heatsync.org/**', (r: any) => r.abort())
    await c.route('https://kick.com/**', (r: any) => {
      const u = r.request().url()
      if (u.includes('/api/')) return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      r.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml(body) })
    })
    await c.route('https://kick.com/api/v2/channels/**', (r: any) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 111, chatroom: { id: 222 } }),
      }),
    )
    await c.route('https://kick.com/api/v2/messages/send/**', (r: any) => {
      const req = r.request()
      posts.push({ url: req.url(), body: req.postData() || '', headers: req.headers() })
      r.fulfill({ status: 200, contentType: 'application/json', body: '{"status":{"code":200}}' })
    })
    // The background reads these through the cookies API before it will relay.
    await c.addCookies([
      { name: 'XSRF-TOKEN', value: 'harness-xsrf', domain: '.kick.com', path: '/', secure: true },
      { name: 'session_token', value: 'harness-session', domain: '.kick.com', path: '/', secure: true },
    ])

    let sw = c.serviceWorkers()[0]
    if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 20_000 })
    const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
    if (!id) fail('could not resolve the extension id for the kick send check')
    const seed = await c.newPage()
    await seed.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    await seed.evaluate(async () => {
      // @ts-ignore — extension page
      await chrome.storage.local.set({
        heatsync_multichat: { channels: [{ id: 'kchan', twitch: '', kick: 'kchan', youtube: '' }] },
        user_info: { username: 'probeuser' },
      })
    })
    await seed.close()

    const p = await c.newPage()
    p.on('pageerror', (e: unknown) => errors.push(`kick-send: ${String(e).slice(0, 300)}`))
    await p.goto('https://kick.com/kchan', { waitUntil: 'domcontentloaded' })
    await p
      .waitForSelector('#hs-mc-input', { timeout: 25_000 })
      .catch(() => fail('the overlay composer never appeared on a kick channel page'))
    if (!(await stable(p, '#hs-mc-input', 1000))) fail('the composer never held still after mounting')

    // The background may not have registered this tab yet, and a send before that is dropped without a
    // word. Type it again (the box is cleared first, so the body stays exactly one message) until the
    // POST shows up, instead of guessing how long boot takes.
    await retryUntil(
      p,
      async () => {
        await p.click('#hs-mc-input')
        await p.keyboard.press('Control+A')
        await p.keyboard.press('Backspace')
        await p.keyboard.type('hello from the harness')
        await p.keyboard.press('Enter')
      },
      () => posts.length > 0,
      { every: 3000 },
    )

    if (!posts.length) {
      fail(
        'pressing Enter on kick sent no POST at all — the chain is composer -> background ' +
          '-> cookies -> kick.com tab -> fetch, and one of those links is broken',
      )
    }
    const post = posts[0]
    if (!post.url.endsWith('/messages/send/222')) {
      fail(
        `the kick send went to ${post.url}. it must carry the CHATROOM id (222), not the ` +
          'channel id (111): a channel-id send answers 200 and broadcasts to nobody, so this ' +
          'fails silently in production and looks fine from the client.',
      )
    }
    ok('kick sends to the chatroom id, not the channel id')

    const parsed = JSON.parse(post.body || '{}')
    if (parsed.content !== 'hello from the harness' || parsed.type !== 'message') {
      fail(`the kick send body is wrong: ${post.body}`)
    }
    ok(`kick send body is what was typed (${post.body})`)

    if (post.headers['x-xsrf-token'] !== 'harness-xsrf') fail('the kick send lost its X-XSRF-TOKEN header')
    if (post.headers.authorization !== 'Bearer harness-session') {
      fail(
        `the kick send lost its bearer token (got ${JSON.stringify(post.headers.authorization)}) — ` +
          'kick 403s "User is not authenticated" without it',
      )
    }
    ok('kick send carries both the xsrf token and the session bearer')
  } finally {
    await closeContext(c, 'kick send', prof)
    rmSync(prof, { recursive: true, force: true })
  }
}
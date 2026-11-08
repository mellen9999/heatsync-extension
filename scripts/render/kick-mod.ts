import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from '../lib/chromium'
import { closeContext, errors, fail, fixtureHtml, ok, stable, until } from './lib'

/**
 * Kick mod tools: /kickmod -> panel -> background -> a kick.com tab -> web.kick.com.
 *
 * kick.com and web.kick.com are both answered locally (the real kick is never
 * contacted). The channel lookup gives the CHANNEL id 111 and the chatroom id
 * 222 on purpose: the moderation routes key on the channel id, and a wrong id
 * here would silently moderate nothing. The viewer is a moderator via the
 * lookup's chatroom_user, which is what unlocks the command.
 */
export async function kickModCheck() {
  console.log('\n── kick mod tools, for real ──')
  const prof = mkdtempSync(join(tmpdir(), 'hs-ext-kmod-'))
  const c = await launchWithExtension(prof, ['--window-size=1400,900'])
  const calls: Array<{ method: string, url: string, body: string, headers: Record<string, string> }> = []
  const words = [{ word: 'seedword', permission: 'PUBLIC' }]
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
        body: JSON.stringify({ id: 111, chatroom: { id: 222 }, chatroom_user: { role: 'moderator' } }),
      }),
    )
    const cors = {
      'access-control-allow-origin': 'https://kick.com',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, PUT, OPTIONS',
    }
    await c.route('https://web.kick.com/**', (r: any) => {
      const req = r.request()
      if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors })
      calls.push({ method: req.method(), url: req.url(), body: req.postData() || '', headers: req.headers() })
      const json = (data: unknown) =>
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: cors,
          body: JSON.stringify({ data, message: 'success' }),
        })
      if (req.url().endsWith('/banned-words')) {
        if (req.method() === 'PUT') {
          const b = JSON.parse(req.postData() || '{}')
          for (const w of b.additions || []) words.push(w)
          return json({})
        }
        return json({ channel_id: 111, words })
      }
      return json({})
    })
    await c.addCookies([
      { name: 'XSRF-TOKEN', value: 'harness-xsrf', domain: '.kick.com', path: '/', secure: true },
      { name: 'session_token', value: 'harness-session', domain: '.kick.com', path: '/', secure: true },
    ])

    let sw = c.serviceWorkers()[0]
    if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 20_000 })
    const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
    if (!id) fail('could not resolve the extension id for the kick mod check')
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
    p.on('pageerror', (e: unknown) => errors.push(`kick-mod: ${String(e).slice(0, 300)}`))
    await p.goto('https://kick.com/kchan', { waitUntil: 'domcontentloaded' })
    await p
      .waitForSelector('#hs-mc-input', { timeout: 25_000 })
      .catch(() => fail('the overlay composer never appeared on a kick channel page'))
    if (!(await stable(p, '#hs-mc-input', 1000))) fail('the composer never held still after mounting')

    await p.click('#hs-mc-input')
    await p.keyboard.type('/kickmod')
    // the first enter can land on the slash suggestion list (it completes the
    // name); press until the composer has taken the command
    for (let i = 0; i < 3; i++) {
      await p.keyboard.press('Enter')
      if (await until(p, async () => !(await p.evaluate(() => document.getElementById('hs-mc-input')?.textContent)), 1200)) break
    }
    await p
      .waitForSelector('.hs-ms-row .hs-ms-text', { timeout: 15_000 })
      .catch(() => fail('/kickmod on a kick channel opened no panel with the blocked words in it'))

    const read = calls.find((x) => x.method === 'GET' && x.url.endsWith('/banned-words'))
    if (!read) return fail('the panel never asked web.kick.com for the banned words')
    if (!read.url.includes('/channels/111/')) {
      fail(`the banned words were read from ${read.url}. the route keys on the CHANNEL id (111), not the chatroom id (222)`)
    }
    ok('kick banned words are read from the channel id')
    if (read.headers.authorization !== 'Bearer harness-session') {
      fail(`the read lost its bearer (got ${JSON.stringify(read.headers.authorization)})`)
    }
    if (read.headers['x-xsrf-token']) fail('the web.kick.com read carried an xsrf header kick does not send there')
    ok('kick mod read carries the session bearer and nothing extra')

    const shown = await p.evaluate(() => [...document.querySelectorAll('.hs-ms-row .hs-ms-text')].map((n) => n.textContent))
    if (!shown.includes('seedword')) fail(`the panel shows ${JSON.stringify(shown)}, not the channel's word list`)
    ok('the panel lists the channel blocked words')

    await p.keyboard.press('/')
    await p.keyboard.type('harnessword')
    await p.keyboard.press('Enter')
    await until(p, () => calls.some((x) => x.method === 'PUT'))
    const put = calls.find((x) => x.method === 'PUT')
    if (!put) return fail('adding a word sent no PUT')
    const sent = JSON.parse(put.body || '{}')
    if (
      !put.url.endsWith('/channels/111/chat/banned-words') ||
      sent.additions?.[0]?.word !== 'harnessword' ||
      sent.additions?.[0]?.permission !== 'PUBLIC' ||
      (sent.removals || []).length
    ) {
      fail(`the add went out as ${put.method} ${put.url} ${put.body}`)
    }
    ok('adding a blocked word PUTs additions/removals to the channel id')

    await p
      .waitForFunction(
        () => [...document.querySelectorAll('.hs-ms-row .hs-ms-text')].some((n) => n.textContent === 'harnessword'),
        null,
        { timeout: 8000 },
      )
      .catch(() => fail('the new word never showed in the list after kick said yes'))
    ok('the new word shows once kick agrees')
  } finally {
    await closeContext(c, 'kick mod tools', prof)
    rmSync(prof, { recursive: true, force: true })
  }
}
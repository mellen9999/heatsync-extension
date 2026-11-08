import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from '../lib/chromium'
import { startMockIrc } from '../lib/mock-irc'
import { PLATFORMS, closeContext, errors, fail, fixtureHtml, ok, until } from './lib'

/**
 * Send a message for real: type in the overlay composer, press Enter, assert the
 * exact PRIVMSG leaves on the wire, echo it back as twitch would, and assert the
 * row renders. Compose -> wire -> back -> screen, the product's core loop.
 *
 * irc-ws.chat.twitch.tv is redirected to a local wss server with
 * --host-resolver-rules, so twitch is never contacted and the check works with
 * no network at all. Chrome's private-network blocking has to be off for a
 * public-origin page to reach 127.0.0.1, and the cert is self-signed, so both
 * of those flags are set for THIS context only.
 *
 * Requires openssl for a throwaway cert. Nothing is committed: the key lives in
 * a temp dir for the length of the run.
 */
export async function twitchIrcCheck({ dim, full }: { dim: boolean, full: boolean }) {
  console.log(`\n── the twitch chat loop, over a socket (dim timeouts: ${dim ? 'on' : 'off'}) ──`)
  const irc = startMockIrc()
  if (!irc) {
    console.log('  ! SKIPPED — openssl not available, so the mock irc server has no cert.')
    console.log('    the send path is the core loop and is going UNVERIFIED in this run.')
    return
  }
  const { frames, push } = irc

  const prof = mkdtempSync(join(tmpdir(), 'hs-ext-send-'))
  const c = await launchWithExtension(prof, [
    '--window-size=1500,900',
    `--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1:${irc.port}`,
    '--ignore-certificate-errors',
    '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
  ])
  try {
    await c.route('https://heatsync.org/**', (r: any) => r.abort())
    // The cosmetics batch (paint + plus + colour + badge in one reply). Registered
    // after the abort above because routes match last-registered-first. Only user
    // 77 has a badge: the badge check below proves a row shows it and others don't.
    await c.route(/^https:\/\/heatsync\.org\/api\/paints\?/, (r: any) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ paints: {}, plus: {}, colors: {}, badges: { '77': 'plus_12m' } }),
      }),
    )
    await c.route(PLATFORMS[0].glob, (r: any) =>
      r.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml(PLATFORMS[0].body) }),
    )
    // getTwitchAuthToken() reads document.cookie; the value is nonsense and only
    // ever reaches the local mock.
    await c.addCookies([
      { name: 'auth-token', value: 'harnesstoken0000', domain: '.twitch.tv', path: '/', secure: true },
      { name: 'login', value: 'probeuser', domain: '.twitch.tv', path: '/', secure: true },
    ])

    let sw = c.serviceWorkers()[0]
    if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 20_000 })
    const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
    if (!id) fail('could not resolve the extension id for the send check')

    const seed = await c.newPage()
    await seed.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    await seed.evaluate(async (d: boolean) => {
      // @ts-ignore — extension page
      await chrome.storage.local.set({
        heatsync_multichat: { channels: [{ id: 'probechan', twitch: 'probechan', kick: '', youtube: '' }] },
        user_info: { username: 'probeuser' },
        hs_dim_timeouts: d,
      })
    }, dim)
    await seed.close()

    const p = await c.newPage()
    p.on('pageerror', (e: unknown) => errors.push(`send: ${String(e).slice(0, 300)}`))
    await p.goto('https://www.twitch.tv/probechan', { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-input', { timeout: 25_000 })

    // Poll rather than sleep. The authed connection needs a username, which
    // arrives from storage asynchronously in a fixture with no twitch DOM to
    // read one from, so a fixed wait sometimes checked before it landed and
    // failed on the handshake for reasons that had nothing to do with the code
    // under test.
    const handshook = await until(p, () => frames.some((f) => f.startsWith('PASS oauth:')))

    if (!handshook) {
      fail(
        `the authenticated irc connection never handshook (frames: ${JSON.stringify(frames.slice(0, 8))}) — ` +
          'without it nothing below can send',
      )
    }
    if (full) ok('the authenticated irc connection handshakes and joins')

    await p.click('#hs-mc-input')
    await p.keyboard.type('hello from the harness')
    await p.keyboard.press('Enter')
    await until(p, () => frames.some((f) => f.startsWith('PRIVMSG')))

    const privmsg = frames.filter((f) => f.startsWith('PRIVMSG'))
    if (!privmsg.length) {
      fail(
        'pressing Enter in the composer put NOTHING on the irc wire — the input cleared and the ' +
          `message went nowhere (frames: ${JSON.stringify(frames.slice(-6))})`,
      )
    }
    if (privmsg[0] !== 'PRIVMSG #probechan :hello from the harness') {
      fail(`the wrong line went out: ${JSON.stringify(privmsg[0])}`)
    }
    if (full) ok(`Enter sends the right line: ${JSON.stringify(privmsg[0])}`)

    await until(p, async () =>
      (await p.evaluate(() => document.getElementById('hs-mc-messages')?.textContent || '')).includes(
        'hello from the harness',
      ),
    )
    const rows: string[] = await p.evaluate(() =>
      [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].map((r) => (r.textContent || '').trim()),
    )
    if (!rows.some((r) => r.includes('hello from the harness'))) {
      fail(
        `the echoed message never rendered (rows: ${JSON.stringify(rows.slice(0, 4))}) — ` +
          'twitch echoes your own PRIVMSG back and that echo is what puts it on screen',
      )
    }
    if (full) ok('the echo comes back through the parser and renders — compose, wire, back, screen')

    // ── the heatsync badge, from the cosmetics batch ───────────────────────
    // The first line from user 77 renders before the batch answers, so its badge
    // arrives through the in-place pass; the second renders after, so it is baked
    // at render time. Both must show the same mark in the same place, and a
    // chatter the batch says nothing about must show none.
    if (full) {
      const say = (user: string, uid: number, id: string, text: string) =>
        push(`@display-name=${user};color=#FFFF00;user-id=${uid};id=${id} :${user}!x@x.tmi.twitch.tv PRIVMSG #probechan :${text}\r\n`)
      say('badged', 77, 'b1', 'first badge line')
      say('plainone', 78, 'b2', 'no badge here')
      await until(p, async () =>
        (await p.evaluate(() => !!document.querySelector('#hs-mc-messages .hs-mc-user + .hs-badge[data-badge="plus_12m"]'))),
      )
      say('badged', 77, 'b3', 'second badge line')
      await until(p, async () =>
        (await p.evaluate(() => document.getElementById('hs-mc-messages')?.textContent || '')).includes('second badge line'),
      )
      const badgeRows: Array<{ text: string, marks: string[], glyph: string, title: string, size: string, after: boolean }> =
        await p.evaluate(() =>
          [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')]
            .filter((r) => /badge line|no badge here/.test(r.textContent || ''))
            .map((r) => {
              const b = r.querySelector('.hs-badge') as HTMLElement | null
              return {
                text: (r.textContent || '').trim(),
                marks: [...r.querySelectorAll('.hs-badge')].map((m) => (m as HTMLElement).dataset.badge || ''),
                glyph: b?.textContent || '',
                title: b?.title || '',
                size: b ? getComputedStyle(b).fontSize : '',
                after: !!b && b.previousElementSibling?.classList.contains('hs-mc-user') === true,
              }
            }),
        )
      const withBadge = badgeRows.filter((r) => /badge line/.test(r.text))
      const without = badgeRows.filter((r) => /no badge here/.test(r.text))
      if (withBadge.length !== 2 || withBadge.some((r) => r.marks.join() !== 'plus_12m')) {
        fail(`both lines from the badged user should show exactly one plus_12m badge: ${JSON.stringify(badgeRows)}`)
      }
      if (without.length !== 1 || without[0].marks.length) fail(`a chatter with no badge got one: ${JSON.stringify(without)}`)
      const b0 = withBadge[0]
      if (!b0.after) fail('the badge is not directly after the name')
      if (b0.glyph !== '★') fail(`wrong glyph: ${JSON.stringify(b0.glyph)}`)
      if (/mc_badge_/.test(b0.title) || !b0.title.includes(' — ')) fail(`the hover text is not "name — how": ${JSON.stringify(b0.title)}`)
      if (b0.size !== '13px') fail(`badge text must be the fixed 13px, got ${b0.size}`)
      ok('a badge from the cosmetics batch shows after the name, in place and at render, and only on the right chatter')
    }

    // ── moderation, from a raw CLEARCHAT off the wire ──────────────────────
    // The dim/hide decision is the one behaviour changed today, and until now
    // it was only covered by a source pin and a hand-written double.
    push(
      '@display-name=victim;color=#FF0000;user-id=42;id=m1 ' +
        ':victim!v@v.tmi.twitch.tv PRIVMSG #probechan :please dont ban me\r\n',
    )
    push(
      '@display-name=bystander;color=#00FF00;user-id=43;id=m2 ' +
        ':bystander!b@b.tmi.twitch.tv PRIVMSG #probechan :unrelated chatter\r\n',
    )
    await until(p, async () =>
      (await p.evaluate(() => document.getElementById('hs-mc-messages')?.textContent || '')).includes(
        'unrelated chatter',
      ),
    )
    const seen: string[] = await p.evaluate(() =>
      [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].map((r) => (r.textContent || '').trim()),
    )
    if (!seen.some((r) => r.includes('please dont ban me')) || !seen.some((r) => r.includes('unrelated chatter'))) {
      fail(`the two victim/bystander messages did not both render: ${JSON.stringify(seen)}`)
    }

    push('@ban-duration=600;target-user-id=42 :tmi.twitch.tv CLEARCHAT #probechan :victim\r\n')
    await p.waitForTimeout(1500)
    // A live channel re-renders constantly; one more message stands in for that.
    push(
      '@display-name=third;color=#00FFFF;user-id=44;id=m3 ' +
        ':third!t@t.tmi.twitch.tv PRIVMSG #probechan :after the ban\r\n',
    )
    await until(p, async () =>
      (await p.evaluate(() => document.getElementById('hs-mc-messages')?.textContent || '')).includes('after the ban'),
    )

    const modRows: Array<{ text: string, cleared: boolean }> = await p.evaluate(() =>
      [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].map((r) => ({
        text: (r.textContent || '').trim(),
        cleared: r.classList.contains('hs-mc-msg-cleared'),
      })),
    )
    const victim = modRows.find((r) => r.text.includes('please dont ban me'))
    const bystander = modRows.find((r) => r.text.includes('unrelated chatter'))

    if (!bystander || bystander.cleared) {
      fail(`a CLEARCHAT for one user touched an unrelated message: ${JSON.stringify(modRows.map((r) => r.text))}`)
    }
    if (!modRows.some((r) => /timed out/i.test(r.text))) {
      fail('the timeout produced no system notice — the mod action happened invisibly')
    }

    if (dim) {
      if (!victim) fail('with dim ON the banned message should stay on screen, dimmed — it is gone')
      if (!victim.cleared) {
        fail('with dim ON the banned message rendered as if nothing happened — no hs-mc-msg-cleared')
      }
      ok('CLEARCHAT dims the banned user and leaves everyone else alone')
    } else {
      if (victim) {
        fail(
          'with dim OFF the banned message is still on screen. that is the bug fixed today: ' +
            '"50% opacity instead of hiding" offered two treatments and only the dim existed.',
        )
      }
      ok('CLEARCHAT with dim off removes the banned message instead of leaving it readable')
    }
  } finally {
    // Sockets first: the browser has nothing left to wait on when it closes.
    irc.stop()
    await closeContext(c, `twitch irc (dim ${dim ? 'on' : 'off'})`, prof)
    rmSync(prof, { recursive: true, force: true })
  }
}
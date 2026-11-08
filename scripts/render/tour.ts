import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from '../lib/chromium'
import { PLATFORMS, closeContext, errors, fail, fixtureHtml, ok, until } from './lib'

/**
 * The first-run tour card, as a person meets it: a fresh profile opens a chat, the card is there
 * on its first of six cards; next walks them; it remembers where the viewer stopped across a
 * reload; the last card's switches change the real chat; it closes for good. Then settings › ?
 * shows the "sending" checklist (which sites are signed in) and the sign-in button opens the site.
 *
 * Source tests cannot answer "does turning on timestamps in the card put a time
 * on the rows", "does the card cover the composer", or "does it come back after
 * a reload" — the card is a thin skin over the real settings, so the proof is
 * the settings acting, in a real page. Fresh profile = first run, nothing seeded
 * but one channel.
 *
 * The mod row is not driven here: it needs twitch's own answer to "do I mod this
 * channel" and the harness never contacts twitch. It is asserted HIDDEN for a
 * non-mod; the shown path is covered by tests/tour.test.js with the mod caches.
 */
export async function tourCheck() {
  console.log('\n── the first-run tour ──')
  const prof = mkdtempSync(join(tmpdir(), 'hs-ext-tour-'))
  const c = await launchWithExtension(prof, ['--window-size=1400,900'])
  try {
    await c.route('https://heatsync.org/**', (r: any) => r.abort())
    await c.route(PLATFORMS[0].glob, (r: any) =>
      r.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml(PLATFORMS[0].body) }),
    )
    let sw = c.serviceWorkers()[0]
    if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 20_000 })
    const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
    if (!id) fail('could not resolve the extension id for the tour check')

    // ── the welcome page: how to start comes first, signing in is optional and last ──
    {
      const wp = await c.newPage()
      await wp.setViewportSize({ width: 360, height: 700 }) // a phone-width window: nothing may spill
      await wp.goto(`chrome-extension://${id}/welcome.html`, { waitUntil: 'load' })
      await wp.waitForTimeout(500)
      const w = await wp.evaluate(() => {
        const q = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[]
        const links = q('.steps > li:first-child a')
        const signIn = document.querySelector('a[href="https://heatsync.org/login"]') as HTMLElement | null
        const small = q('main *')
          .filter((el) => el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()))
          .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 13)
          .map((el) => el.textContent?.slice(0, 30))
        return {
          steps: q('.steps > li h2').map((h) => h.textContent || ''),
          hosts: links.map((a) => new URL((a as HTMLAnchorElement).href).hostname),
          rawKeys: q('[data-i18n]').filter((el) => /^welcome_|^mc_/.test(el.textContent || '')).length,
          overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          signInAfterLinks: !!signIn && !!links.length && signIn.getBoundingClientRect().top > links[links.length - 1].getBoundingClientRect().bottom,
          signInPrimary: signIn?.classList.contains('cta') ?? true,
          small,
        }
      })
      if (w.steps.length !== 3) fail(`the welcome page should have three steps, it has ${w.steps.length}`)
      if (w.hosts.join() !== 'www.twitch.tv,kick.com,www.youtube.com') fail(`step 1 links are wrong: ${w.hosts.join()}`)
      if (w.rawKeys) fail('the welcome page shows a raw catalog key somewhere')
      if (w.overflowX) fail('the welcome page scrolls sideways at phone width')
      if (!w.signInAfterLinks) fail('the sign-in button must come after the stream links')
      if (w.signInPrimary) fail('sign-in must not be styled as the primary button')
      if (w.small.length) fail(`welcome text under 13px: ${w.small.join(' | ')}`)
      ok('the welcome page leads with how to start (stream links first), sign-in is last and quiet, and it fits a phone-width window')
      await wp.close()
    }

    // an extension page: storage reads, and the message wire into the tab
    const ep = await c.newPage()
    await ep.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    await ep.evaluate(async () => {
      // @ts-ignore — extension page
      await chrome.storage.local.set({
        heatsync_multichat: { channels: [{ id: 'tourchan', twitch: 'tourchan', kick: '', youtube: '' }] },
      })
    })
    const readLocal = (key: string) =>
      ep.evaluate(
        (k: string) =>
          // @ts-ignore — extension page
          new Promise((res) => chrome.storage.local.get(k, (v: any) => res(v?.[k]))),
        key,
      )
    const readSynced = (key: string) =>
      ep.evaluate(
        (k: string) =>
          // @ts-ignore — extension page
          new Promise((res) => chrome.storage.sync.get('ui_settings', (v: any) => res(v?.ui_settings?.[k]))),
        key,
      )

    const p = await c.newPage()
    p.on('pageerror', (e: unknown) => errors.push(`tour: ${String(e).slice(0, 300)}`))
    await p.goto('https://www.twitch.tv/tourchan', { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-messages', { timeout: 25_000 })

    const sendRow = (msgId: string, text: string) =>
      ep.evaluate(
        ([mid, txt]: string[]) =>
          new Promise((res) => {
            // @ts-ignore — extension page
            chrome.tabs.query({}, (tabs: any[]) => {
              const t = tabs.find((x) => (x.url || '').includes('twitch.tv'))
              if (!t) return res('no twitch tab')
              // @ts-ignore
              chrome.tabs.sendMessage(t.id, {
                type: 'bg_irc_msg',
                msg: { id: mid, user: 'viewer', text: txt, channel: 'tourchan', color: '#00ffff', badges: '', time: Date.now() },
              })
              res('sent')
            })
          }),
        [msgId, text],
      )
    const rowCount = () => p.evaluate(() => document.querySelectorAll('#hs-mc-messages .hs-mc-msg').length)
    const tsCount = () => p.evaluate(() => document.querySelectorAll('#hs-mc-messages .hs-mc-msg .hs-mc-ts').length)
    const state = (key: string) =>
      p.evaluate(
        (k: string) => document.querySelector(`#hs-mc-tour [data-tour-key="${k}"]`)?.getAttribute('aria-checked') ?? null,
        key,
      )
    const cardShown = () =>
      p.evaluate(() => {
        const n = document.getElementById('hs-mc-tour') as HTMLElement | null
        return !!n && !n.hidden && n.getBoundingClientRect().height > 0
      })

    const reading = () =>
      p.evaluate(() => ({
        n: document.querySelector('#hs-mc-tour .hs-mc-tour-n')?.textContent || '',
        title: document.querySelector('#hs-mc-tour .hs-mc-tour-t')?.textContent || '',
        line: (document.querySelector('#hs-mc-tour .hs-mc-tour-d') as HTMLElement | null)?.hidden
          ? ''
          : document.querySelector('#hs-mc-tour .hs-mc-tour-d')?.textContent || '',
      }))
    const next = async () => {
      await p.click('#hs-mc-tour .hs-mc-tour-next')
    }

    // a row to look at, delivered the way real chat is
    for (let i = 0; i < 20 && (await sendRow('TOUR1', 'tour probe row')) !== 'sent'; i++) await p.waitForTimeout(500)
    if (!(await until(p, async () => (await rowCount()) > 0))) fail('no chat row ever rendered in the tour fixture')

    // ── first open: the card is there ────────────────────────────────────
    if (!(await until(p, cardShown))) fail('first open on a fresh profile: the tour card never appeared')
    // before any click: the card appearing must not pull focus out of the composer
    if (await p.evaluate(() => !!document.activeElement?.closest('#hs-mc-tour'))) fail('the tour card took focus on its own')
    ok('first open on a fresh profile shows the tour card')

    // ── six cards, one idea each ─────────────────────────────────────────
    const first = await reading()
    if (first.n !== '1/6' || !/right-click/.test(first.title)) fail(`card 1 should be the row menu, got ${JSON.stringify(first)}`)
    const wanted = [/right-click/, /\//, /find/, /channel/, /settings/, /start off/]
    for (let i = 0; i < 6; i++) {
      const r = await reading()
      if (r.n !== `${i + 1}/6`) fail(`card ${i + 1} reads "${r.n}"`)
      if (!wanted[i].test(r.title)) fail(`card ${i + 1} title is "${r.title}"`)
      if (i < 5 && r.line.length < 20) fail(`card ${i + 1} has no line of words under its title`)
      if (i < 5) await next()
    }
    ok('next walks all six cards in order, each with its own title and plain line')

    // a reload in the middle comes back to where the viewer stopped
    await p.click('#hs-mc-tour .hs-mc-tour-back')
    await p.click('#hs-mc-tour .hs-mc-tour-back')
    await p.click('#hs-mc-tour .hs-mc-tour-back')
    if ((await reading()).n !== '3/6') fail('back did not return to card 3')
    if (!(await until(p, async () => (await readLocal('hs_tour_step')) === 2, 4000))) {
      fail('the step was never saved, so a reload would start the tour over')
    }
    await p.reload({ waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-messages', { timeout: 25_000 })
    if (!(await until(p, cardShown, 15_000))) fail('the tour card did not come back after a reload mid-tour')
    if ((await reading()).n !== '3/6') fail(`after a reload the tour should resume on card 3, it shows "${(await reading()).n}"`)
    ok('a reload mid-tour resumes on the card the viewer stopped at')
    // the reload cleared the chat: put a row back for the switch checks below
    for (let i = 0; i < 20 && (await sendRow('TOUR1', 'tour probe row')) !== 'sent'; i++) await p.waitForTimeout(500)
    if (!(await until(p, async () => (await rowCount()) > 0))) fail('no chat row after the reload')
    for (let i = 0; i < 3; i++) await next()
    if ((await reading()).n !== '6/6') fail('could not reach the last card')

    const rows: string[] = await p.evaluate(() =>
      [...document.querySelectorAll('#hs-mc-tour .hs-mc-tour-row')]
        .filter((b) => !(b as HTMLElement).hidden)
        .map((b) => (b as HTMLElement).dataset.tourKey || ''),
    )
    if (rows.join() !== 'timestamps,hoverReply,viMode') {
      fail(`the card should offer timestamps, reply button and vi keys to a non-mod, got: ${rows.join()}`)
    }
    for (const k of rows) {
      if ((await state(k)) !== 'false') fail(`"${k}" should start off — the defaults are unchanged`)
    }
    ok('the last card offers three switches to a non-mod (the mod row stays hidden), all starting off')

    // ── it covers nothing and takes nothing ──────────────────────────────
    const g = await p.evaluate(() => {
      const r = (id: string) => document.getElementById(id)?.getBoundingClientRect()
      const tour = r('hs-mc-tour')
      const msgs = r('hs-mc-messages')
      const overlay = r('hs-mc-overlay')
      const input = r('hs-mc-inputbar')
      if (!tour || !msgs || !overlay || !input) return null
      const hit = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
      return {
        aboveRows: tour.bottom <= msgs.top + 1,
        insideOverlay: tour.top >= overlay.top - 1 && tour.bottom <= overlay.bottom + 1,
        coversComposer: hit(tour, input),
        paneLeft: Math.round(msgs.height),
      }
    })
    if (!g) fail('could not measure the tour card against the pane and composer')
    else {
      if (!g.aboveRows) fail('the tour card overlaps the message rows')
      if (!g.insideOverlay) fail('the tour card spills outside the overlay')
      if (g.coversComposer) fail('the tour card covers the composer')
      if (g.paneLeft < 120) fail(`the card leaves only ${g.paneLeft}px for chat`)
      ok(`the card sits above the rows, clear of the composer, with ${g.paneLeft}px of chat left and no focus taken`)
    }

    // ── a switch changes the real chat ───────────────────────────────────
    if ((await tsCount()) !== 0) fail('rows already showed timestamps before the switch was touched')
    await p.click('#hs-mc-tour [data-tour-key="timestamps"]')
    if (!(await until(p, async () => (await tsCount()) > 0, 8000))) {
      fail('switching timestamps on in the card put no timestamp on the existing rows')
    }
    if ((await state('timestamps')) !== 'true') fail('the timestamps switch did not show itself as on')
    if (!(await until(p, async () => (await readSynced('timestamps')) === true, 8000))) {
      fail('the card flipped the row but never wrote ui_settings.timestamps — it would not survive a reload')
    }
    ok('the timestamps switch puts times on the rows and writes the real setting')

    // ── and it is the same switch as the one in settings, both ways ───────
    await p.click('#hs-mc-tabbar [data-tab="settings"]')
    await p.waitForSelector('.hs-mc-settings-panel [data-set-key="timestamps"]', { timeout: 10_000 })
    const pillOn = await p.evaluate(() =>
      document.querySelector('.hs-mc-settings-panel [data-set-key="timestamps"]')?.classList.contains('active'),
    )
    if (!pillOn) fail('settings shows timestamps off while the card turned it on')
    if (!(await cardShown())) fail('the card vanished when the settings tab opened')
    await p.click('.hs-mc-settings-panel [data-set-key="timestamps"]')
    if (!(await until(p, async () => (await state('timestamps')) === 'false', 8000))) {
      fail('turning timestamps off in settings left the card saying on')
    }
    ok('card and settings are one switch: flipped in either place, the other follows')

    // ── the settings way back to the tour is below; first, the keyboard ───
    await p.click('#hs-mc-tabbar [data-tab="tourchan"]')
    await p.waitForTimeout(500)
    // the pointer resting over the panel is the case where a bare space is claimed as typing
    const box = await (await p.$('#hs-mc-messages'))!.boundingBox()
    await p.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await p.focus('#hs-mc-tour [data-tour-key="hoverReply"]')
    await p.keyboard.press('Space')
    if (!(await until(p, async () => (await state('hoverReply')) === 'true', 4000))) {
      fail('Space on a focused switch did not turn it on')
    }
    if (!(await until(p, async () => (await readSynced('hoverReply')) === true, 8000))) {
      fail('the reply switch did not write ui_settings.hoverReply')
    }
    await p.keyboard.press('Enter')
    if (!(await until(p, async () => (await state('hoverReply')) === 'false', 4000))) {
      fail('Enter on a focused switch did not turn it back off')
    }
    const typed = await p.evaluate(() => (document.getElementById('hs-mc-input')?.textContent || '').length)
    if (typed !== 0) fail('Space meant for a switch was typed into the composer')
    ok('Space and Enter toggle a focused switch, once each, and nothing leaks into the composer')

    // ── Esc is "got it": closed for good ──────────────────────────────────
    await p.focus('#hs-mc-tour [data-tour-key="viMode"]')
    await p.keyboard.press('Escape')
    if (!(await until(p, async () => !(await cardShown()), 4000))) fail('Esc did not close the card')
    if (!(await until(p, async () => (await readLocal('hs_tour_seen')) === true, 4000))) {
      fail('closing the card did not record it as seen — it would come back')
    }
    ok('Esc closes the card and records it as seen')

    // ── a fresh page load: never again ────────────────────────────────────
    await p.reload({ waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-messages', { timeout: 25_000 })
    await p.waitForTimeout(4000)
    if (await cardShown()) fail('the tour came back after a reload')
    ok('after a reload the card stays gone')

    // ── settings › ? brings it back, and "got it" ends it again ───────────
    await p.click('#hs-mc-tabbar [data-tab="settings"]')
    await p.waitForSelector('.hs-mc-set-subtab[data-set-subtab="help"]', { timeout: 10_000 })
    await p.click('.hs-mc-set-subtab[data-set-subtab="help"]')
    await p.waitForSelector('[data-action="show-tour"]', { timeout: 10_000 })
    await p.click('[data-action="show-tour"]')
    if (!(await until(p, cardShown, 4000))) fail('"show the tour again" did not bring the card back')
    const focusedCls = await p.evaluate(() => (document.activeElement as HTMLElement | null)?.className || '')
    if (!/hs-mc-tour-next/.test(focusedCls)) fail(`reopening should put focus on the next button, it is on "${focusedCls}"`)
    if ((await reading()).n !== '1/6') fail('reopening should start over on card 1')
    ok('settings › ? › "show the tour again" brings the card back on card 1, focus on its next button')

    // the arrow keys move between cards from inside the card
    await p.keyboard.press('ArrowRight')
    if ((await reading()).n !== '2/6') fail('ArrowRight did not go to the next card')
    await p.keyboard.press('ArrowLeft')
    if ((await reading()).n !== '1/6') fail('ArrowLeft did not go back')
    ok('← → move between cards from the keyboard')

    await p.click('#hs-mc-tour .hs-mc-tour-done')
    if (!(await until(p, async () => !(await cardShown()), 4000))) fail('"skip" did not close the reopened card')
    if (!(await until(p, async () => (await readLocal('hs_tour_seen')) === true, 4000))) {
      fail('"skip" on the reopened card did not record it as seen')
    }
    if ((await readLocal('hs_tour_step')) !== undefined) fail('skipping left a saved step behind')
    ok('"skip" on any card closes it again for good and forgets the step')

    // ── settings › ?: the sending checklist ──────────────────────────────
    // settings › ? is still the open pane from the replay step above
    await p.waitForSelector('[data-send-row="kick"]', { timeout: 10_000 })
    const verdict = async (id: string) =>
      p.evaluate(
        (i: string) => document.querySelector(`[data-send-row="${i}"] .hs-mc-send-state`)?.className.replace('hs-mc-send-state ', '') || '',
        id,
      )
    if (!(await until(p, async () => (await verdict('kick')) === 'out', 15_000))) {
      fail(`a fresh profile has no kick session: the kick row should say not signed in, it says "${await verdict('kick')}"`)
    }
    if ((await verdict('twitch')) !== 'out') fail('no twitch cookie: the twitch row should say not signed in')
    const goes = await p.evaluate(() => [...document.querySelectorAll('.hs-mc-send-go')].map((b) => (b as HTMLElement).dataset.plat))
    if (goes.join() !== 'twitch,kick,youtube') fail(`all three are signed out, so all three need a sign-in button, got: ${goes.join()}`)
    const rowsBox = await p.evaluate(() => {
      const r = (document.querySelector('.hs-mc-send-group') as HTMLElement).getBoundingClientRect()
      const pane = (document.getElementById('hs-mc-messages') as HTMLElement).getBoundingClientRect()
      return { inside: r.left >= pane.left - 1 && r.right <= pane.right + 1, h: Math.round(r.height) }
    })
    if (!rowsBox.inside) fail('the sending checklist spills outside the pane')
    ok(`settings › ? shows the sending checklist (${rowsBox.h}px): all three signed out, each with a sign-in button`)

    // one click opens the right sign-in page, in a new tab
    await c.route('https://kick.com/**', (r: any) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>kick</title>' }))
    const popup = c.waitForEvent('page', { timeout: 10_000 })
    await p.click('.hs-mc-send-go[data-plat="kick"]')
    const kickPage = await popup
    await kickPage.waitForLoadState('domcontentloaded').catch(() => {})
    if (!/^https:\/\/kick\.com\//.test(kickPage.url())) fail(`the kick sign-in button opened ${kickPage.url()}`)
    await kickPage.close()
    ok('the kick sign-in button opens kick.com in a new tab')

    // a youtube login cookie turns that row into a tick without a reload (what the background reads)
    await c.addCookies([{ name: 'LOGIN_INFO', value: 'x', domain: '.youtube.com', path: '/', secure: true, httpOnly: false, sameSite: 'None' }])
    await p.evaluate(() => window.dispatchEvent(new Event('focus')))
    if (!(await until(p, async () => (await verdict('youtube')) === 'in', 15_000))) {
      fail(`a youtube login cookie is there: the row should turn to signed in, it says "${await verdict('youtube')}"`)
    }
    ok('after signing in over there, coming back turns the youtube row into a tick')
  } finally {
    await closeContext(c, 'tour', prof)
    rmSync(prof, { recursive: true, force: true })
  }
}
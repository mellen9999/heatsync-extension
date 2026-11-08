import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from '../lib/chromium'
import { PLATFORMS, closeContext, errors, fail, fixtureHtml, observe, ok, stable, until } from './lib'

/**
 * The first-run tour card, as a person meets it: a fresh profile opens a chat,
 * the card is there; a switch on it changes the real chat; it closes for good.
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

    // a row to look at, delivered the way real chat is
    await until(p, async () => (await sendRow('TOUR1', 'tour probe row')) === 'sent', 10_000)
    if (!(await until(p, async () => (await rowCount()) > 0))) fail('no chat row ever rendered in the tour fixture')

    // ── first open: the card is there ────────────────────────────────────
    if (!(await until(p, cardShown))) fail('first open on a fresh profile: the tour card never appeared')
    ok('first open on a fresh profile shows the tour card')

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
    ok('three switches for a non-mod (the mod row stays hidden), all starting off')

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
        focusInCard: !!document.activeElement?.closest('#hs-mc-tour'),
      }
    })
    if (!g) fail('could not measure the tour card against the pane and composer')
    else {
      if (!g.aboveRows) fail('the tour card overlaps the message rows')
      if (!g.insideOverlay) fail('the tour card spills outside the overlay')
      if (g.coversComposer) fail('the tour card covers the composer')
      if (g.focusInCard) fail('the tour card took focus on its own')
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
    await p.waitForSelector('#hs-mc-tabbar [data-tab="tourchan"].active', { timeout: 8000 })
    await stable(p, '#hs-mc-messages', 300, 8000)
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
    await observe(p, 4000, 'the card is decided once storage has been read; it must not appear after that')
    if (await cardShown()) fail('the tour came back after a reload')
    ok('after a reload the card stays gone')

    // ── settings › ? brings it back, and "got it" ends it again ───────────
    await p.click('#hs-mc-tabbar [data-tab="settings"]')
    await p.waitForSelector('.hs-mc-set-subtab[data-set-subtab="help"]', { timeout: 10_000 })
    await p.click('.hs-mc-set-subtab[data-set-subtab="help"]')
    await p.waitForSelector('[data-action="show-tour"]', { timeout: 10_000 })
    await p.click('[data-action="show-tour"]')
    if (!(await until(p, cardShown, 4000))) fail('"show the tour again" did not bring the card back')
    const focusedKey = await p.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.tourKey || '')
    if (focusedKey !== 'timestamps') fail(`reopening should put focus on the first switch, it is on "${focusedKey}"`)
    ok('settings › ? › "show the tour again" brings the card back, focus on its first switch')

    await p.click('#hs-mc-tour .hs-mc-tour-done')
    if (!(await until(p, async () => !(await cardShown()), 4000))) fail('"got it" did not close the reopened card')
    if (!(await until(p, async () => (await readLocal('hs_tour_seen')) === true, 4000))) {
      fail('"got it" on the reopened card did not record it as seen')
    }
    ok('"got it" closes it again for good')
  } finally {
    await closeContext(c, 'tour', prof)
    rmSync(prof, { recursive: true, force: true })
  }
}
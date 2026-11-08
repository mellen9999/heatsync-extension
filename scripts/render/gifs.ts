import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from '../lib/chromium'
import { PLATFORMS, closeContext, errors, fail, fixtureHtml, ok, until } from './lib'

/** A 1x1 transparent gif, so a tile's fetch resolves without leaving the box. */
const ONE_PX_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/**
 * The gifs tab, hovered and clicked in a real browser.
 *
 * The one thing no source test can answer: does the grid actually PAINT STILLS?
 * The markup carries the still in `src` and the animated rendition in a data
 * attribute, and exactly one tile may ever hold the animated url — but whether
 * that survives the render, the hover swap and the un-hover is a question about
 * a live DOM. Twenty-four animated gifs decoding at once, over a video player,
 * is the failure this is here to catch.
 *
 * The search is served locally: heatsync.org is blocked in this harness, so
 * /api/gifs/top is fulfilled with a fixture and the giphy CDN with a 1x1 gif.
 * Nothing leaves the box, and the urls still read like the real corpus.
 */
export async function gifsTabCheck() {
  console.log('\n── the gifs tab, hovered and clicked ──')
  const media = (id: string, rend: string) => `https://media.giphy.com/media/${id}/${rend}`
  const GIFS = ['aaa1', 'bbb2', 'ccc3'].map((id, i) => ({
    id,
    url: media(id, 'giphy.gif'),
    preview: media(id, '200_s.gif'),
    animated: media(id, '200.gif'),
    label: `probe gif ${i + 1}`,
    uses: 10 - i,
  }))

  const prof = mkdtempSync(join(tmpdir(), 'hs-ext-gifs-'))
  const c = await launchWithExtension(prof, ['--window-size=1500,900'])
  try {
    // Routes match last-registered-first: the blanket heatsync.org abort goes
    // down first so the gifs route registered after it wins.
    await c.route('https://heatsync.org/**', (r: any) => r.abort())
    await c.route('https://heatsync.org/api/gifs/**', (r: any) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ gifs: GIFS, library: { state: 'ready', indexed: 3 } }),
      }),
    )
    await c.route('https://media.giphy.com/**', (r: any) =>
      r.fulfill({ status: 200, contentType: 'image/gif', body: ONE_PX_GIF }),
    )
    await c.route(PLATFORMS[0].glob, (r: any) =>
      r.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml(PLATFORMS[0].body) }),
    )

    let sw = c.serviceWorkers()[0]
    if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 20_000 })
    const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
    if (!id) fail('could not resolve the extension id for the gifs check')

    const seed = await c.newPage()
    await seed.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    await seed.evaluate(async () => {
      // @ts-ignore — extension page
      await chrome.storage.local.set({
        heatsync_multichat: { channels: [{ id: 'probechan', twitch: 'probechan', kick: '', youtube: '' }] },
      })
    })
    await seed.close()

    const p = await c.newPage()
    p.on('pageerror', (e: unknown) => errors.push(`gifs: ${String(e).slice(0, 300)}`))
    await p.goto('https://www.twitch.tv/probechan', { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-input', { timeout: 25_000 })
    // The composer starts hidden; the emote button lives in its bar.
    await p.click('#hs-mc-input')
    await p.waitForSelector('#hs-mc-emote-btn', { timeout: 10_000 })
    await p.click('#hs-mc-emote-btn')
    await p.waitForSelector('#hs-mc-emote-picker.visible', { timeout: 10_000 })

    const tabs = await p.$$eval('#hs-mc-emote-picker .hs-mc-picker-tab', (els: any[]) =>
      els.map((e) => e.dataset.tab),
    )
    if (JSON.stringify(tabs) !== JSON.stringify(['emotes', 'emoji', 'gifs', 'twitch'])) {
      fail(`the picker's tab bar is ${JSON.stringify(tabs)} — expected emotes, emoji, gifs, twitch on a twitch page`)
    }
    ok(`the tab bar carries all three tabs (${tabs.join(', ')})`)

    await p.click('#hs-mc-emote-picker .hs-mc-picker-tab[data-tab="gifs"]')
    if (!(await until(p, () => p.$$eval('.hs-mc-gif', (els: any[]) => els.length >= 3), 15_000))) {
      fail('the gifs tab never painted its three fixture tiles')
    }

    /** What every tile is actually showing, resolved the way the browser did. */
    const srcs = () => p.$$eval('.hs-mc-gif img', (els: any[]) => els.map((e) => e.src))

    const painted = await srcs()
    if (painted.length !== 3) fail(`the gifs tab painted ${painted.length} tiles, expected 3`)
    const animatedNow = painted.filter((s: string) => s.endsWith('/200.gif'))
    if (animatedNow.length) {
      fail(
        `${animatedNow.length} tile(s) rendered the ANIMATED rendition: ${animatedNow.join(', ')}. ` +
          'the grid must paint stills — this is the check that exists to stop a picker becoming a space heater.',
      )
    }
    ok(`all ${painted.length} tiles painted stills, none animated`)

    await p.hover('.hs-mc-gif:nth-of-type(2)')
    await until(p, async () => (await srcs()).some((s: string) => s.endsWith('/200.gif')), 5000)
    const hovered = await srcs()
    const moving = hovered.filter((s: string) => s.endsWith('/200.gif'))
    if (moving.length !== 1) fail(`hover left ${moving.length} tiles animated, expected exactly 1`)
    if (!moving[0].includes('bbb2')) fail(`hover animated the wrong tile: ${moving[0]}`)
    ok('hover animates exactly the tile under the pointer')

    await p.click('.hs-mc-gif:nth-of-type(2)')
    await until(p, () => p.evaluate(() => !document.getElementById('hs-mc-emote-picker')?.classList.contains('visible')), 5000)
    const closed = await p.evaluate(
      () => !document.getElementById('hs-mc-emote-picker')?.classList.contains('visible'),
    )
    if (!closed) fail('picking a gif left the panel open over the composer')
    const typed = await p.evaluate(() => document.getElementById('hs-mc-input')?.textContent || '')
    if (!typed.includes(media('bbb2', 'giphy.gif'))) {
      fail(`picking a gif put ${JSON.stringify(typed)} in the composer, not the direct media url`)
    }
    ok(`a gif pick closes the panel and inserts its url (${JSON.stringify(typed.trim())})`)

    // ── the keyboard, which is the whole point of the tab ──────────────────
    // Focus never leaves the search input: type-to-focus.js yanks focus to the
    // composer on any printable key and bails only while an INPUT is focused,
    // so "normal mode" is the input going readOnly rather than losing focus.
    // That is exactly the kind of claim a source test can only paraphrase.
    await p.evaluate(() => {
      const i = document.getElementById('hs-mc-input')
      if (i) i.innerHTML = ''
    })
    await p.click('#hs-mc-input')
    await p.click('#hs-mc-emote-btn')
    await p.waitForSelector('#hs-mc-emote-picker.visible', { timeout: 10_000 })
    await p.click('#hs-mc-emote-picker .hs-mc-picker-tab[data-tab="gifs"]')
    // Reopening shows RECENTS — the gif just picked, drawn from storage with no
    // request at all. Type to get the full listing back under the cursor.
    if (!(await until(p, () => p.$$eval('.hs-mc-gif', (els: any[]) => els.length === 1), 10_000))) {
      fail('reopening the tab did not show the single gif that was just picked as a recent')
    }
    ok('reopening the tab redraws recents from storage, no request')
    await p.fill('#hs-mc-gif-search', 'probe')
    if (!(await until(p, () => p.$$eval('.hs-mc-gif', (els: any[]) => els.length >= 3), 15_000))) {
      fail('typing a query never brought the listing back')
    }

    const modeState = () =>
      p.evaluate(() => {
        const input = document.getElementById('hs-mc-gif-search') as HTMLInputElement | null
        return {
          line: document.getElementById('hs-mc-gif-mode')?.textContent || '',
          readOnly: !!input?.readOnly,
          focused: document.activeElement === input,
          sel: document.querySelector('.hs-mc-gif[data-sel="1"] img')?.getAttribute('data-still') || '',
        }
      })

    const insert = await modeState()
    if (!insert.line.includes('insert') || insert.readOnly) fail(`the tab did not open in insert mode: ${insert.line}`)
    if (!insert.sel.includes('aaa1')) fail(`the first tile was not selected on render (${insert.sel})`)

    await p.keyboard.press('Escape')
    const normal = await modeState()
    if (!normal.readOnly) fail('Escape did not put the search input into readOnly — normal mode is not armed')
    if (!normal.focused) {
      fail(
        'normal mode moved focus off the search input. every global key guard bails only while an INPUT is ' +
          'focused, so this is how j/k get stolen by row-nav before the panel ever sees them.',
      )
    }
    if (!normal.line.includes('normal')) fail(`normal mode was not announced: ${normal.line}`)
    // The panel must have eaten that Escape — the document handler closes the picker.
    const stillOpen = await p.evaluate(() =>
      !!document.getElementById('hs-mc-emote-picker')?.classList.contains('visible'),
    )
    if (!stillOpen) fail('Escape closed the whole picker instead of entering normal mode')
    ok('Escape arms normal mode: readOnly, still focused, still open, and it says so')

    await p.keyboard.press('l')
    await until(p, async () => (await modeState()).sel.includes('bbb2'), 5000)
    const moved = await modeState()
    if (!moved.sel.includes('bbb2')) fail(`l did not move the cursor (${moved.sel})`)
    await p.keyboard.press('Enter')
    if (
      !(await until(
        p,
        () => p.evaluate(() => (document.getElementById('hs-mc-input')?.textContent || '').includes('bbb2')),
        5000,
      ))
    ) {
      fail('Enter in normal mode inserted nothing')
    }
    const viaKeyboard = await p.evaluate(() => document.getElementById('hs-mc-input')?.textContent || '')
    if (!viaKeyboard.includes(media('bbb2', 'giphy.gif'))) {
      fail(`l then Enter inserted ${JSON.stringify(viaKeyboard)} instead of the second gif`)
    }
    ok('l moves the cursor and Enter inserts it, without the mouse')
  } finally {
    await closeContext(c, 'gifs tab', prof)
    rmSync(prof, { recursive: true, force: true })
  }
}
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from '../lib/chromium'
import { closeContext, errors, fail, fixtureHtml, observe, ok, stable, until } from './lib'

/**
 * Youtube send: overlay composer -> background -> a /live_chat tab, which types
 * into youtube's OWN input and clicks youtube's OWN send button. There is no
 * heatsync API call to watch, so the fixture stands in for youtube: a real
 * contenteditable, a real button, and a list that gains a row on click — which
 * is the echo the relay waits for before it reports success.
 */
export async function youtubeSendCheck() {
  console.log('\n── send on youtube, for real ──')
  const VID = 'YTSENDVIDEO'
  const prof = mkdtempSync(join(tmpdir(), 'hs-ext-ytsend-'))
  const c = await launchWithExtension(prof, ['--window-size=1400,900'])
  try {
    const body =
      '<yt-live-chat-item-list-renderer><div id="items"></div></yt-live-chat-item-list-renderer>' +
      '<yt-live-chat-text-input-field-renderer><div id="input" contenteditable="true"></div>' +
      '<div id="send-button"><button aria-label="send">send</button></div>' +
      '</yt-live-chat-text-input-field-renderer>' +
      '<script>window.__ytClicks=0;' +
      "document.querySelector('#send-button button').addEventListener('click',()=>{" +
      'window.__ytClicks++;' +
      "const i=document.querySelector('yt-live-chat-text-input-field-renderer div#input');" +
      "const t=(i.textContent||'').trim(); if(!t) return;" +
      "const row=document.createElement('yt-live-chat-text-message-renderer');" +
      "row.innerHTML='<span id=\"message\">'+t+'</span>';" +
      "document.querySelector('#items').appendChild(row); i.textContent='';});<\/script>"

    await c.route('https://heatsync.org/**', (r: any) => r.abort())
    await c.route('https://www.youtube.com/**', (r: any) =>
      r.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml(body) }),
    )

    let sw = c.serviceWorkers()[0]
    if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 20_000 })
    const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
    if (!id) fail('could not resolve the extension id for the youtube send check')
    const seed = await c.newPage()
    await seed.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    await seed.evaluate(async (vid: string) => {
      // @ts-ignore — extension page
      await chrome.storage.local.set({
        heatsync_multichat: {
          channels: [{ id: 'ytchan', twitch: '', kick: '', youtube: `https://www.youtube.com/watch?v=${vid}` }],
        },
        user_info: { username: 'probeuser' },
      })
    }, VID)
    await seed.close()

    const p = await c.newPage()
    p.on('pageerror', (e: unknown) => errors.push(`yt-send: ${String(e).slice(0, 300)}`))
    await p.goto(`https://www.youtube.com/live_chat?v=${VID}`, { waitUntil: 'domcontentloaded' })
    await p
      .waitForSelector('#hs-mc-input', { timeout: 25_000 })
      .catch(() => fail('the overlay composer never appeared on a youtube live_chat page'))
    // the overlay has mounted and stopped laying itself out: the click below lands on a still box
    if (!(await stable(p, '#hs-mc-input', 1000))) fail('the composer never held still after mounting')

    // A real click, not $eval — a composer playwright can't hit is the product
    // bug (something covering it, zero-size, hidden). The one recorded flake
    // here timed out with no geometry to reason from, so on failure dump the
    // boxes that decide clickability before failing.
    await p.click('#hs-mc-input', { timeout: 15_000 }).catch(async (e: Error) => {
      const geo = await p
        .evaluate(() => {
          const rect = (sel: string) => {
            const el = document.querySelector(sel)
            if (!el) return null
            const r = el.getBoundingClientRect()
            const s = getComputedStyle(el)
            return {
              x: r.x, y: r.y, w: r.width, h: r.height,
              display: s.display, vis: s.visibility,
              cls: (el as HTMLElement).className,
            }
          }
          const bar = document.getElementById('hs-mc-inputbar')
          const input = document.getElementById('hs-mc-input')
          const br = input?.getBoundingClientRect()
          const cover = br
            ? document.elementFromPoint(br.x + br.width / 2, br.y + br.height / 2)
            : null
          return {
            overlay: rect('#hs-mc-overlay'),
            inputbar: rect('#hs-mc-inputbar'),
            input: rect('#hs-mc-input'),
            barHidden: bar?.classList.contains('hs-hidden') ?? null,
            coveredBy: cover ? `${cover.tagName}#${cover.id}.${(cover as HTMLElement).className}`.slice(0, 120) : null,
          }
        })
        .catch(() => 'geometry probe itself failed')
      fail(`composer not clickable: ${e.message.split('\n')[0]}\n  geometry: ${JSON.stringify(geo)}`)
    })
    await p.keyboard.type('hello from the harness')
    await p.keyboard.press('Enter')
    await until(p, async () => (await p.evaluate(() => (window as any).__ytClicks || 0)) > 0)
    // A beat past the first click, so a SECOND one would be caught too.
    await observe(p, 1500, 'a second click would be a double post')

    const state: { clicks: number, items: string[] } = await p.evaluate(() => ({
      clicks: (window as any).__ytClicks || 0,
      items: [...document.querySelectorAll('#items #message')].map((e) => e.textContent || ''),
    }))
    if (!state.clicks) {
      fail(
        "pressing Enter never clicked youtube's send button — the relay types into youtube's own " +
          'composer and clicks it, so a selector change here breaks sending with no error anywhere',
      )
    }
    if (!state.items.some((t) => t.includes('hello from the harness'))) {
      fail(`the message never reached youtube's chat list (items: ${JSON.stringify(state.items)})`)
    }
    if (state.clicks > 1) fail(`youtube's send button was clicked ${state.clicks} times — a double post`)
    ok("youtube send types into youtube's composer and clicks send exactly once")
  } finally {
    await closeContext(c, 'youtube send', prof)
    rmSync(prof, { recursive: true, force: true })
  }
}
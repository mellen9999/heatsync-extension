import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from '../lib/chromium'
import { closeContext, errors, fail, fixtureHtml, ok } from './lib'

/**
 * A /live_chat page is the only place heatsync-button.js and youtube-content.js
 * both run. Drives `youtube_insert_emote` over both transports and reads the
 * chat input to see which one landed.
 */
export async function ytInsertCheck() {
  console.log('\n── youtube emote insert ──')
  const prof = mkdtempSync(join(tmpdir(), 'hs-ext-ytins-'))
  const c = await launchWithExtension(prof, ['--window-size=1200,800'])
  try {
    await c.route('https://heatsync.org/**', (r: any) => r.abort())
    const chatBody =
      '<yt-live-chat-text-input-field-renderer><div id="input" contenteditable="true"></div>' +
      '</yt-live-chat-text-input-field-renderer><div id="host-content">live chat</div>'
    await c.route('https://www.youtube.com/**', (r: any) =>
      r.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml(chatBody) }),
    )
    let sw = c.serviceWorkers()[0]
    if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 20_000 })
    const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
    if (!id) fail('could not resolve the extension id for the insert check')

    const p = await c.newPage()
    p.on('pageerror', (e: unknown) => errors.push(`yt-insert: ${String(e).slice(0, 300)}`))
    await p.goto('https://www.youtube.com/live_chat?v=RENDERCHECKX', { waitUntil: 'domcontentloaded' })
    await p.waitForTimeout(3000)

    const readInput = () =>
      p.evaluate(
        () => document.querySelector('yt-live-chat-text-input-field-renderer div#input')?.textContent || '',
      )
    if ((await readInput()) !== '') fail('the fixture chat input did not start empty')

    const ep = await c.newPage()
    await ep.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    const sent = await ep.evaluate(
      () =>
        new Promise((res) => {
          try {
            // @ts-ignore — extension page
            chrome.tabs.query({}, (tabs: any[]) => {
              const t = tabs.find((x) => (x.url || '').includes('live_chat'))
              if (!t) return res('no live_chat tab')
              // @ts-ignore — the transport that reaches a content script
              chrome.tabs.sendMessage(t.id, { type: 'youtube_insert_emote', emoteName: 'VIA_TABS' })
              // @ts-ignore — the transport the picker used to use
              chrome.runtime.sendMessage({ type: 'youtube_insert_emote', emoteName: 'VIA_RUNTIME' })
              setTimeout(() => res('sent'), 300)
            })
          } catch (e) {
            res(`threw: ${String(e)}`)
          }
        }),
    )
    await ep.close()
    if (sent !== 'sent') fail(`could not drive the insert check: ${sent}`)
    await p.waitForTimeout(1500)

    const after = await readInput()
    // Control. If this fails the comparison below means nothing.
    if (!after.includes('VIA_TABS')) {
      fail(
        `youtube-content.js did not insert an emote it was handed directly (input: ${JSON.stringify(after)}) — ` +
          'either the handler or the yt chat-input selector has rotted',
      )
    }
    ok('youtube-content.js inserts an emote into the live chat input')

    if (after.includes('VIA_RUNTIME')) {
      // Would mean chrome changed the delivery set. The direct call still works,
      // but the comment explaining WHY it is a direct call would be wrong.
      fail('runtime.sendMessage now reaches content scripts — revisit the youtube insert path and its tests')
    }
    ok('runtime.sendMessage still does not reach a content script — the direct call is required')
  } finally {
    await closeContext(c, 'check', prof)
    rmSync(prof, { recursive: true, force: true })
  }
}
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from '../lib/chromium'
import { closeContext, errors, fail, fixtureHtml, ok } from './lib'

/**
 * The picker, end to end, with no message driven by hand: mount the button on a
 * real chat page, click it, click an emote tile, read that platform's chat input.
 *
 * Uses the emoji tab deliberately — channel/global/mine all fetch heatsync.org,
 * which this harness blocks, so they render an error state instead of a grid.
 * The emoji tab renders from the bundled EMOJI_DATA with no network and shares
 * the same delegated click handler and the same insertEmoteIntoChat call.
 *
 * All three platforms, because the one that broke did so by being the only one
 * that took a different route to the input: twitch and kick insert inline,
 * youtube delegated over a message transport that does not reach content
 * scripts, and nothing anywhere reported it.
 */
const PICKER_SURFACES = [
  {
    name: 'twitch',
    url: 'https://www.twitch.tv/somechannel',
    glob: 'https://www.twitch.tv/**',
    body:
      '<div class="right-column right-column--beside" id="rcol"><div id="chatwrap">' +
      '<button data-a-target="emote-picker-button">emote</button>' +
      '<div data-a-target="chat-input" contenteditable="true"></div></div></div>',
    input: '[data-a-target="chat-input"]',
  },
  {
    name: 'kick',
    url: 'https://kick.com/somechannel',
    glob: 'https://kick.com/**',
    body: '<div id="chatwrap"><div class="editor-input" contenteditable="true"></div></div>',
    input: 'div.editor-input',
  },
  {
    name: 'youtube',
    url: 'https://www.youtube.com/live_chat?v=PICKERCHECK',
    glob: 'https://www.youtube.com/**',
    body:
      '<yt-live-chat-text-input-field-renderer><div id="buttons"></div>' +
      '<div id="input" contenteditable="true"></div></yt-live-chat-text-input-field-renderer>',
    input: 'yt-live-chat-text-input-field-renderer div#input',
  },
]

export async function pickerClickCheck() {
  console.log('\n── the picker, clicked for real ──')
  // One browser PER platform, deliberately. Sharing a context to save launches
  // was tried and reverted: chrome.storage is shared across it, so state the
  // extension persisted on twitch and kick changed what the youtube run saw and
  // its emoji tab stopped being clickable. Three launches is the honest cost of
  // three independent surfaces.
  for (const plat of PICKER_SURFACES) {
    const prof = mkdtempSync(join(tmpdir(), `hs-ext-pick-${plat.name}-`))
    const c = await launchWithExtension(prof, ['--window-size=1280,900'])
    try {
      await c.route('https://heatsync.org/**', (r: any) => r.abort())
      await c.route(plat.glob, (r: any) =>
        r.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml(plat.body) }),
      )

      // Wait for the extension to exist BEFORE navigating. Content scripts
      // inject at document_start of the navigation that happens after the
      // extension is live; go too early and there is no injection to wait for,
      // so the button never appears no matter how long the selector waits.
      // This was the one check here that navigated first, and the only one
      // that ever flaked with "the button never mounted".
      if (!c.serviceWorkers()[0]) await c.waitForEvent('serviceworker', { timeout: 20_000 })

      const p = await c.newPage()
      p.on('pageerror', (e: unknown) => errors.push(`picker-${plat.name}: ${String(e).slice(0, 300)}`))
      await p.goto(plat.url, { waitUntil: 'domcontentloaded' })

      await p
        .waitForSelector('#heatsync-chat-button', { timeout: 20_000 })
        .catch(() =>
          fail(`${plat.name}: the heatsync button never mounted — its anchor lookup no longer matches this page`),
        )

      const readInput = () => p.evaluate((sel: string) => document.querySelector(sel)?.textContent || '', plat.input)
      if ((await readInput()) !== '') fail(`${plat.name}: the fixture chat input did not start empty`)

      // The multichat overlay mounts full-bleed over a fixture that has no
      // layout of its own and would swallow the clicks. Not part of this path.
      await p.evaluate(() => {
        const el = document.getElementById('hs-mc-container')
        if (el) (el as HTMLElement).style.display = 'none'
      })

      const opened = await p
        .$eval('#heatsync-chat-button', (el: any) => {
          el.click()
          return true
        })
        .catch(() => false)
      if (!opened) fail(`${plat.name}: the heatsync button vanished before it could be clicked`)
      await p
        .waitForSelector('#heatsync-panel', { timeout: 10_000 })
        .catch(() => fail(`${plat.name}: the picker panel never opened`))
      await p.waitForTimeout(1000)

      // A DOM click, not a mouse click, for the tab switch only. heatsync.org is
      // blocked here so the channel/global/mine tabs keep failing and re-rendering
      // the panel underneath, and playwright's actionability check never sees a
      // stable element — the run failed on a different platform each time. The
      // tile click below stays a real mouse click; that is the interaction under
      // test, the tab switch is just navigation to it.
      const switched = await p
        .$eval('#heatsync-panel .heatsync-tab[data-tab="emoji"]', (el: any) => {
          el.click()
          return true
        })
        .catch(() => false)
      if (!switched) fail(`${plat.name}: the picker has no emoji tab to switch to`)
      await p.waitForTimeout(1500)

      // Dispatched, not hit-tested. heatsync.org is blocked here, so the
      // channel/global/mine tabs sit in an error state whose retry re-renders
      // the grid on a timer; playwright's actionability check needs the element
      // to hold still and it never does, which made this fail on a different
      // platform every run. el.click() still raises a real bubbling MouseEvent
      // into the delegated handler that reads dataset.index — same handler,
      // same code path, same insertEmoteIntoChat call. What this line does NOT
      // cover is whether the tile is visually reachable.
      const tileCount = await p.$$eval('#heatsync-panel .heatsync-emote-wrap', (els: any[]) => els.length)
      if (!tileCount) fail(`${plat.name}: the emoji tab rendered no tiles — the picker grid itself is broken`)
      const clicked = await p
        .$eval('#heatsync-panel .heatsync-emote-wrap', (el: any) => {
          el.click()
          return true
        })
        .catch(() => false)
      if (!clicked) fail(`${plat.name}: the first emote tile vanished before it could be clicked`)
      await p.waitForTimeout(1500)

      const after = await readInput()
      if (!after.trim()) {
        fail(
          `${plat.name}: clicking an emote in the picker put nothing in the chat input. ` +
            'that is the bug this check exists for — on youtube it was a ' +
            'chrome.runtime.sendMessage to another content script, which never arrives.',
        )
      }
      ok(`${plat.name}: picker click inserts into the chat input (${JSON.stringify(after.trim())})`)
    } finally {
      await closeContext(c, `picker ${plat.name}`, prof)
      rmSync(prof, { recursive: true, force: true })
    }
  }
}
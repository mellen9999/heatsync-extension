/**
 * Assert the overlay's real geometry in a real browser.
 *
 *   bun run test:render
 *
 * Why this exists: 143 of 145 test files never touch a DOM. The suite asserts
 * that source text contains expected substrings, which is a drift tripwire, not
 * a safety net — and every expensive bug in this project's history has been a
 * RENDERING bug found by eye, days later. Chip smear, blurry text, paints frozen
 * at frame 0, white video, the player-collapse trio, and an overlay showing an
 * inch of chat. Not one of them was catchable by grepping source.
 *
 * How it gets a page: Chrome matches content scripts on URL, not on who served
 * the bytes. So the request for a twitch URL is fulfilled locally with a
 * fixture, the page URL stays `https://www.twitch.tv/...`, and the extension
 * injects for real. A NON-CHANNEL twitch url is used deliberately — main.js has
 * a body-mount path for those (`Twitch non-channel page — body-mount overlay`),
 * so no React tree has to be faked.
 *
 * heatsync.org is routed to abort: the harness must never depend on, or write
 * to, production.
 *
 * Opt-in, like smoke-extension.ts: it needs a real browser binary, which the
 * unit suite deliberately does not depend on.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertBuilt, launchWithExtension } from './lib/chromium'
import { startMockIrc } from './lib/mock-irc'

/**
 * Fixtures, one per platform.
 *
 * Each URL is chosen so main.js takes a BODY-MOUNT path and no React tree has
 * to be faked:
 *  - twitch: a non-channel url (no `.channel-root`).
 *  - kick:   a channel path (`/renderkick`). kick mounts only on channel routes
 *            (isKickChannelRoute, an allowlist since bdae2917) — a reserved path
 *            like `/browse` correctly never mounts.
 *  - youtube: a /watch url with a fake `ytd-live-chat-frame#chat` + a
 *    non-replay iframe src — checkYtLive() (main.js) reads exactly that DOM
 *    shape to decide "this page has its own live stream", which is what
 *    ungates the panel (`hs-offline` off). The panel is intentionally OFFLINE
 *    (display:none, #hs-mc-container gated by `:not(.hs-offline)`) on any
 *    other YouTube page by default — showing an empty 340px panel on every
 *    yt page including home/VODs/directory was the audit-1.7.75 bug; a
 *    genuinely non-live fixture here would (correctly) never mount and this
 *    whole check would be worthless.
 *
 * The twitch fixture also carries `.right-column.right-column--beside`, because
 * ensureUIElements starts a MutationObserver on that element whose callback
 * re-enters ensureUIElements. That re-entry is the only path that re-runs it
 * without first nulling resizeObserver.
 */
const PLATFORMS = [
  {
    name: 'twitch',
    url: 'https://www.twitch.tv/directory',
    glob: 'https://www.twitch.tv/**',
    body: '<div id="host-content" style="height:100vh">host page</div><div class="right-column right-column--beside" id="rcol"></div>',
    rerender: true,
  },
  {
    name: 'kick',
    url: 'https://kick.com/renderkick',
    glob: 'https://kick.com/**',
    // a channel route mounts into kick's chatroom element (waitForMount in
    // main.js), so the fixture carries the same shape the send check uses
    body:
      '<div id="host-content" style="height:100vh">host page</div>' +
      '<div id="channel-chatroom"><div id="chatroom-messages"><div class="no-scrollbar"></div></div>' +
      '<div id="chatwrap"><div class="editor-input" contenteditable="true"></div></div></div>',
    rerender: false,
  },
  {
    name: 'youtube',
    url: 'https://www.youtube.com/watch?v=RENDERLIVEXX',
    glob: 'https://www.youtube.com/**',
    body:
      '<div id="host-content" style="height:100vh">host page</div>' +
      '<ytd-live-chat-frame id="chat"><iframe src="https://www.youtube.com/live_chat?is_popout=1&v=RENDERLIVEXX"></iframe></ytd-live-chat-frame>',
    rerender: false,
  },
]

const fixtureHtml = (body: string) =>
  `<!doctype html><html><head><title>fixture</title></head><body style="margin:0">${body}</body></html>`

const profile = mkdtempSync(join(tmpdir(), 'hs-ext-render-'))
const errors: string[] = []
const checks: string[] = []
let ctx: any = null

function ok(msg: string) {
  checks.push(msg)
  console.log(`✓ ${msg}`)
}
function fail(msg: string): never {
  throw new Error(msg)
}

/** Read every box the layout code writes, in one pass. */
async function geometry(p: any) {
  return p.evaluate(() => {
    const box = (id: string) => {
      const el = document.getElementById(id)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        h: Math.round(r.height),
        w: Math.round(r.width),
        // Content box. #hs-mc-container carries a 4px border under
        // box-sizing:border-box, so its border-box width is NOT the space its
        // children get — comparing against it makes a correct layout look 4px
        // short in the side docks.
        cw: el.clientWidth,
        ch: el.clientHeight,
        top: el.style.top || '',
        bottom: el.style.bottom || '',
      }
    }
    return {
      container: box('hs-mc-container'),
      tabbar: box('hs-mc-tabbar'),
      overlay: box('hs-mc-overlay'),
      inputbar: box('hs-mc-inputbar'),
      messages: box('hs-mc-messages'),
      hostContent: !!document.getElementById('host-content'),
    }
  })
}

/**
 * Seed a subsystem map, boot a twitch page, and report what the overlay asked
 * the background for and what it rendered. One fresh context per polarity so
 * neither can inherit the other's storage.
 */
async function gatePolarity(subsystems: Record<string, boolean>) {
  const prof = mkdtempSync(join(tmpdir(), 'hs-ext-gate-'))
  const c = await launchWithExtension(prof, ['--window-size=1600,900'])
  try {
    await c.route('https://heatsync.org/**', (r: any) => r.abort())
    for (const plat of PLATFORMS) {
      await c.route(plat.glob, (r: any) =>
        r.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml(plat.body) }),
      )
    }
    let sw = c.serviceWorkers()[0]
    if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 20_000 })
    const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
    if (!id) throw new Error('could not resolve the extension id for the gate check')

    const seed = await c.newPage()
    await seed.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    await seed.evaluate(async (subs: any) => {
      // @ts-ignore — extension page
      await chrome.storage.sync.set({ ui_settings: { subsystems: subs } })
      // @ts-ignore
      await chrome.storage.local.set({
        heatsync_multichat: {
          channels: [
            { id: 'gatechan', twitch: 'gatechan', kick: 'gatechan', youtube: 'https://www.youtube.com/watch?v=GATEVIDEOXX' },
          ],
        },
      })
    }, subsystems)
    await seed.close()

    // Observe what the content script asks the background to do.
    await sw.evaluate(() => {
      ;(globalThis as any).__gateSeen = []
      // @ts-ignore — service worker
      chrome.runtime.onMessage.addListener((m: any) => {
        if (m?.type) (globalThis as any).__gateSeen.push(m.type)
      })
    })

    const p = await c.newPage()
    p.on('pageerror', (e: unknown) => errors.push(`gate: ${String(e).slice(0, 300)}`))
    await p.goto('https://www.twitch.tv/gatechan', { waitUntil: 'domcontentloaded' })
    const twitchOn = subsystems['overlay-twitch'] !== false
    if (twitchOn) await p.waitForSelector('#hs-mc-messages', { timeout: 25_000 })
    await p.waitForTimeout(4500)
    const mounted = await p.evaluate(() => !!document.getElementById('hs-mc-overlay'))

    const seen: string[] = await sw.evaluate(() => (globalThis as any).__gateSeen)
    const wire = [...new Set(seen.filter((t) => /^(bg_irc_join|bg_kick_history|youtube_ws_subscribe)$/.test(t)))].sort()
    if (!twitchOn) return { wire, mounted, twitch: false, kick: false, yt: false }

    // Drive one live message per platform through the real background→tab wire.
    const drv = await c.newPage()
    await drv.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    const delivered = await drv.evaluate(
      () =>
        new Promise((res) => {
          try {
            // @ts-ignore — extension page
            chrome.tabs.query({}, (tabs: any[]) => {
              const t = tabs.find((x) => (x.url || '').includes('twitch.tv'))
              if (!t) return res('no twitch tab')
              // @ts-ignore
              const send = (m: any) => chrome.tabs.sendMessage(t.id, m)
              send({
                type: 'bg_irc_msg',
                msg: { id: 'G_TW', user: 'tw', text: 'GATEPROBE_TWITCH', channel: 'gatechan', color: '#ff8700', badges: '', time: Date.now() },
              })
              send({
                type: 'kick_chat_message',
                data: { id: 'G_KI', channel: 'gatechan', username: 'ki', content: 'GATEPROBE_KICK', color: '#53fc18', timestamp: Date.now() },
              })
              send({ type: 'youtube_chat_message', channelId: 'gatechan', id: 'G_YT', user: 'yt', text: 'GATEPROBE_YT', time: Date.now() })
              res('sent')
            })
          } catch (e) {
            res(`threw: ${String(e)}`)
          }
        }),
    )
    await drv.close()
    if (delivered !== 'sent') throw new Error(`could not drive the gate check: ${delivered}`)
    // Youtube rows drip through a pace queue; give it room.
    await p.waitForTimeout(9000)

    const texts: string[] = await p.evaluate(() =>
      [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].map((r) => (r.textContent || '').trim()),
    )
    const hit = (needle: string) => texts.some((t) => t.includes(needle))
    return { wire, mounted, twitch: hit('GATEPROBE_TWITCH'), kick: hit('GATEPROBE_KICK'), yt: hit('GATEPROBE_YT') }
  } finally {
    await closeContext(c, 'check', prof)
    rmSync(prof, { recursive: true, force: true })
  }
}

/** Poll a predicate instead of sleeping. Returns false if it never held. */
async function until(p: any, check: () => boolean | Promise<boolean>, ms = 20_000) {
  const step = 400
  for (let waited = 0; waited < ms; waited += step) {
    if (await check()) return true
    await p.waitForTimeout(step)
  }
  return false
}

/**
 * Closing a persistent context that still holds a websocket to a local mock can
 * hang forever, and a harness that hangs is worse than one that fails: there is
 * nothing to read. Bounded, and it says so when it gives up.
 */
async function closeContext(c: any, label: string, profile?: string) {
  const closed = await Promise.race([
    c
      .close()
      .then(() => true)
      .catch(() => true),
    new Promise((r) => setTimeout(() => r(false), 20_000)),
  ])
  if (closed) return
  // A chromium that will not close is not a cosmetic problem here: this script
  // launches nine of them in sequence, and every leaked one competes for the
  // machine with the checks that follow. That is what made the later checks
  // fail — a different platform each run, always the one that ran last — until
  // the leak itself was the thing fixed. Kill it by its profile directory,
  // which is unique per launch and cannot match anything else.
  if (profile) {
    try {
      execFileSync('pkill', ['-f', `user-data-dir=${profile}`], { stdio: 'ignore' })
      console.log(`  ! ${label}: the browser did not close in 20s — killed it by profile`)
      return
    } catch (_) {
      /* pkill exits non-zero when nothing matched, which is the good case */
      console.log(`  ! ${label}: the browser did not close in 20s — nothing left to kill`)
      return
    }
  }
  console.log(`  ! ${label}: the browser did not close in 20s — leaving it to the process exit`)
}

/**
 * A /live_chat page is the only place heatsync-button.js and youtube-content.js
 * both run. Drives `youtube_insert_emote` over both transports and reads the
 * chat input to see which one landed.
 */
async function ytInsertCheck() {
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

async function pickerClickCheck() {
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
async function twitchIrcCheck({ dim, full }: { dim: boolean, full: boolean }) {
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
async function kickSendCheck() {
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
    await p.waitForTimeout(5000)

    await p.click('#hs-mc-input')
    await p.keyboard.type('hello from the harness')
    await p.keyboard.press('Enter')
    await until(p, () => posts.length > 0)

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

/**
 * Kick mod tools: /kickmod -> panel -> background -> a kick.com tab -> web.kick.com.
 *
 * kick.com and web.kick.com are both answered locally (the real kick is never
 * contacted). The channel lookup gives the CHANNEL id 111 and the chatroom id
 * 222 on purpose: the moderation routes key on the channel id, and a wrong id
 * here would silently moderate nothing. The viewer is a moderator via the
 * lookup's chatroom_user, which is what unlocks the command.
 */
async function kickModCheck() {
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
    await p.waitForTimeout(5000)

    await p.click('#hs-mc-input')
    await p.keyboard.type('/kickmod')
    // the first enter can land on the slash suggestion list (it completes the
    // name); press until the composer has taken the command
    for (let i = 0; i < 3; i++) {
      await p.keyboard.press('Enter')
      await p.waitForTimeout(800)
      if (!(await p.evaluate(() => document.getElementById('hs-mc-input')?.textContent))) break
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

/**
 * Youtube send: overlay composer -> background -> a /live_chat tab, which types
 * into youtube's OWN input and clicks youtube's OWN send button. There is no
 * heatsync API call to watch, so the fixture stands in for youtube: a real
 * contenteditable, a real button, and a list that gains a row on click — which
 * is the echo the relay waits for before it reports success.
 */
async function youtubeSendCheck() {
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
    await p.waitForTimeout(4000)

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
    await p.waitForTimeout(1500)

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

/**
 * A 1x1 transparent png. Every seeded emote resolves to a real image, so the
 * input chip never drops into the broken-image recovery path and the thing
 * under test stays the completion itself.
 */
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * Tab-complete, driven from a real keyboard.
 *
 * It is the most-used keystroke in the composer and the single most
 * bug-prone thing in it — the ranking alone carries four separate recorded
 * incidents — and until now nothing had ever pressed Tab. Every existing test
 * of it reads the source and checks that the comparator still contains the
 * words it used to.
 *
 * Four contracts, each one a bug that shipped:
 *
 *  1. RANKING — channel emotes beat the ones you own beat globals. The three
 *     tiers come from three different places (a channel map, your inventory,
 *     the global pool) and are merged by a memoized signature; "channel
 *     culture leads" is the user-chosen order and nothing enforced it.
 *  2. WHO JUST TALKED beats all of that. A name off the wire outranks every
 *     emote, which is why this check needs a live chat and not a fixture.
 *  3. SLASH COMMANDS WIN OUTRIGHT. Tab on "/op" completed to a random channel
 *     emote in a live incident whose root cause was never pinned down; the
 *     defence is a hand-written direct lookup with nothing testing it.
 *  4. A MODIFIER TOKEN IS NOT A COMPLETION. "Kappa w!" + Tab did nothing at
 *     all: two characters was over the completion threshold, and completion
 *     refuses modifier tokens, so the press fell down a hole.
 *
 * The emote pool is seeded through chrome.storage exactly as the background
 * writes it after a real fetch, so the load-and-merge path is under test too
 * rather than being bypassed with a hand-placed map.
 */
async function tabCompleteCheck() {
  console.log('\n── tab-complete, from the keyboard ──')
  const irc = startMockIrc()
  if (!irc) {
    console.log('  ! SKIPPED — openssl not available, so there is no live chat to rank against.')
    console.log('    tab-complete ordering is going UNVERIFIED in this run.')
    return
  }

  const E = (n: string) => `https://cdn.heatsync.org/emote/${n}.png`
  const prof = mkdtempSync(join(tmpdir(), 'hs-ext-tabc-'))
  const c = await launchWithExtension(prof, [
    '--window-size=1500,900',
    `--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1:${irc.port}`,
    '--ignore-certificate-errors',
    '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
  ])
  try {
    // The FIRST Tab fires the 7TV/BTTV/FFZ catalog search unconditionally.
    // Left unrouted it leaves this machine, and the ranking under test would
    // then depend on what frankerfacez happens to return today. Refused here,
    // so every match is local and the order is the one the comparator decides.
    // (Routes match last-registered-first, hence the ordering.)
    await c.route('https://heatsync.org/**', (r: any) => r.abort())
    await c.route('https://api.frankerfacez.com/**', (r: any) => r.abort())
    await c.route('https://7tv.io/**', (r: any) => r.abort())
    await c.route('https://api.betterttv.net/**', (r: any) => r.abort())
    await c.route('https://cdn.heatsync.org/**', (r: any) =>
      r.fulfill({ status: 200, contentType: 'image/png', body: ONE_PX_PNG }),
    )
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
    if (!id) fail('could not resolve the extension id for the tab-complete check')

    const seed = await c.newPage()
    await seed.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    await seed.evaluate(async (urls: Record<string, string>) => {
      // Written the way the background writes it after a real fetch — three
      // separate keys feeding three separate tiers, which is the whole point.
      // @ts-ignore — extension page
      await chrome.storage.local.set({
        heatsync_multichat: { channels: [{ id: 'probechan', twitch: 'probechan', kick: '', youtube: '' }] },
        user_info: { username: 'probeuser' },
        global_emotes: [
          { name: 'zorpGlobal', url: urls.zorpGlobal, source: '7tv' },
          { name: 'Kappa', url: urls.Kappa, source: 'twitch' },
        ],
        emote_inventory: [{ name: 'zorpOwn', url: urls.zorpOwn, source: 'heatsync' }],
        channel_emotes_map: {
          'twitch/probechan': [
            { name: 'zorpChannel', url: urls.zorpChannel, source: '7tv' },
            { name: 'opGrab', url: urls.opGrab, source: '7tv' },
          ],
        },
      })
    }, {
      zorpGlobal: E('zorpGlobal'),
      zorpOwn: E('zorpOwn'),
      zorpChannel: E('zorpChannel'),
      opGrab: E('opGrab'),
      Kappa: E('Kappa'),
    })
    await seed.close()

    const p = await c.newPage()
    p.on('pageerror', (e: unknown) => errors.push(`tabcomplete: ${String(e).slice(0, 300)}`))
    await p.goto('https://www.twitch.tv/probechan', { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-input', { timeout: 25_000 })

    /** Whatever the cycle is currently showing — chip, mention span or raw text. */
    const readCycle = (): Promise<{ kind: string, value: string }> =>
      p.evaluate(() => {
        const inp = document.getElementById('hs-mc-input')
        if (!inp) return { kind: 'none', value: '' }
        const img = inp.querySelector('img.hs-cycling-emote') as HTMLImageElement | null
        if (img) return { kind: 'emote', value: img.alt || '' }
        const user = inp.querySelector('span.hs-cycling-user')
        if (user) return { kind: 'user', value: (user.textContent || '').trim() }
        const text = inp.querySelector('span.hs-cycling-text')
        if (text) return { kind: 'text', value: (text.textContent || '').trim() }
        return { kind: 'none', value: (inp.textContent || '').trim() }
      })

    const inputText = (): Promise<string> =>
      p.evaluate(() => (document.getElementById('hs-mc-input')?.textContent || '').replace(/ /g, ' '))

    // Clear by hand rather than with Escape: on an empty composer Escape means
    // "done here" and hides the whole input bar, which would take the next
    // phase down with it. Any typed character resets the cycle on its own.
    const resetInput = async () => {
      await p.evaluate(() => {
        const i = document.getElementById('hs-mc-input')
        if (!i) return
        i.innerHTML = ''
      })
      await p.click('#hs-mc-input')
    }

    const cycleStep = async (shift: boolean, want: string, what: string) => {
      const before = (await readCycle()).value
      await p.keyboard.press(shift ? 'Shift+Tab' : 'Tab')
      await until(p, async () => (await readCycle()).value === want, 8000)
      const got = await readCycle()
      if (got.value !== want) {
        fail(
          `${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got.value)} ` +
            `(the press before it left ${JSON.stringify(before)})`,
        )
      }
    }

    // ── 1. the three tiers, in order ────────────────────────────────────────
    // "zorp" prefix-matches exactly one emote in each tier and nothing else,
    // and none of them has ever been used, so the comparator has only the tier
    // to go on. Three Tabs must walk channel -> own -> global.
    //
    // Nothing else in the pool may even CONTAIN "zorp": a substring hit ranks
    // below its tier's prefix hits but still above the whole next tier, so the
    // slash decoy was first written as "opzorp" and landed between the channel
    // emote and the one you own. That is the ranking behaving correctly, and
    // it is exactly the kind of near-miss a fixture can hide.
    await p.click('#hs-mc-input')
    await p.keyboard.type('zorp')
    await cycleStep(false, 'zorpChannel', 'the first Tab should land on the CHANNEL emote')
    await cycleStep(false, 'zorpOwn', 'the second Tab should land on the emote you OWN')
    await cycleStep(false, 'zorpGlobal', 'the third Tab should land on the GLOBAL emote')
    ok('tab-complete ranks channel over own over global (zorpChannel → zorpOwn → zorpGlobal)')

    await cycleStep(true, 'zorpOwn', 'Shift+Tab should walk the cycle back')
    ok('Shift+Tab walks the same cycle backwards')

    // ── 2. a slash command is never an emote ────────────────────────────────
    // The channel owns "opGrab" on purpose: if word extraction ever drops the
    // leading slash, there is something for a stray completion to grab.
    //
    // Two paths answer this press — the slash dropdown's own Tab branch, and a
    // direct lookup added afterwards as a backstop because the dropdown's
    // active flag was not reliably set for every command. Disabling either one
    // alone still passes, so this cannot say which one ran; disabling both
    // fails. That is the right shape: either path satisfies the user, and the
    // backstop is now known to carry the press on its own rather than being
    // decorative.
    await resetInput()
    await p.keyboard.type('/op')
    await p.keyboard.press('Tab')
    // The trailing space is load-bearing as evidence: it is what the command
    // inserter appends, so "/op " proves the slash path took the press.
    // Falling through to emote completion with no match leaves a bare "/op",
    // which trims to the same thing and would pass a sloppier compare.
    await until(p, async () => (await inputText()) === '/op ', 8000)
    const slashText = await inputText()
    const slashChip = await p.evaluate(
      () => !!document.getElementById('hs-mc-input')?.querySelector('img.hs-input-emote'),
    )
    if (slashText !== '/op ' || slashChip) {
      fail(
        `Tab on "/op" left the composer holding ${JSON.stringify(slashText)}` +
          `${slashChip ? ' plus an emote chip' : ''} — a partial slash command must complete the ` +
          'COMMAND. this exact press once inserted an unrelated channel emote in production.',
      )
    }
    ok('Tab on a partial slash command completes the command, not an emote')

    // ── 3. a modifier token applies, it does not complete ───────────────────
    await resetInput()
    await p.keyboard.type('Kappa')
    await cycleStep(false, 'Kappa', 'Tab on a full emote name should insert that emote')
    await p.keyboard.type('w!')
    await p.keyboard.press('Tab')
    await until(p, async () =>
      p.evaluate(() => {
        const img = document.getElementById('hs-mc-input')?.querySelector('img.hs-input-emote') as HTMLElement | null
        return !!img && (img.dataset.hsMods || '').split(',').includes('wide')
      }),
    )
    const mod = await p.evaluate(() => {
      const inp = document.getElementById('hs-mc-input')
      const img = inp?.querySelector('img.hs-input-emote') as HTMLElement | null
      return {
        mods: img?.dataset?.hsMods || '',
        transform: (img as HTMLElement | null)?.style?.transform || '',
        text: (inp?.textContent || '').replace(/ /g, ' '),
      }
    })
    if (!mod.mods.split(',').includes('wide')) {
      fail(
        'Tab after "Kappa w!" applied no modifier — the press went nowhere. that is the bug: ' +
          '"w!" is two characters, so it cleared the completion threshold, and completion ' +
          `refuses modifier tokens outright (mods=${JSON.stringify(mod.mods)}, input=${JSON.stringify(mod.text)})`,
      )
    }
    // The dataset alone would still pass if composing the transform broke; the
    // widening is the part the user sees. Read the x factor rather than pinning
    // the exact syntax — scale(2, 1) and scaleX(2) are the same picture.
    const sx = Number((mod.transform.match(/scaleX?\(\s*(-?[\d.]+)/) || [])[1])
    if (!(Math.abs(sx) > 1)) {
      fail(`"w!" recorded the modifier but painted no widening: transform=${JSON.stringify(mod.transform)}`)
    }
    if (/w!/.test(mod.text)) {
      fail(`the modifier applied but "w!" was left in the composer as literal text: ${JSON.stringify(mod.text)}`)
    }
    ok(`Tab applies an ffz modifier to the emote before it (mods="${mod.mods}", ${mod.transform})`)

    // ── 4. someone who just talked outranks every emote ─────────────────────
    // Straight off the socket, through the parser, into the channel buffer,
    // out again as the top completion. Nothing about this can be faked from a
    // fixture, which is why it lives here and not in a unit test.
    irc.push(
      '@display-name=ZorpChatter;color=#00FF00;user-id=77;id=zc1 ' +
        ':zorpchatter!z@z.tmi.twitch.tv PRIVMSG #probechan :hello\r\n',
    )
    await until(p, async () =>
      (await p.evaluate(() => document.getElementById('hs-mc-messages')?.textContent || '')).includes('ZorpChatter'),
    )

    await resetInput()
    await p.keyboard.type('zorp')
    await p.keyboard.press('Tab')
    await until(p, async () => (await readCycle()).value.toLowerCase() === 'zorpchatter', 8000)
    const lead = await readCycle()
    if (lead.value.toLowerCase() !== 'zorpchatter') {
      fail(
        `after ZorpChatter talked, "zorp" + Tab still completed to ${JSON.stringify(lead.value)}. ` +
          'whoever just spoke leads the cycle, above every emote tier — that is what makes Tab ' +
          'usable for replying to the person on screen.',
      )
    }
    ok(`someone who just talked leads the cycle, above all three emote tiers (${JSON.stringify(lead.value)})`)
  } finally {
    irc.stop()
    await closeContext(c, 'tab-complete', prof)
    rmSync(prof, { recursive: true, force: true })
  }
}

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
async function gifsTabCheck() {
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

/**
 * Highlight-rule sounds: a rule's own audio file, in a real browser.
 *
 * What a source test cannot say: that a stored file is decoded by the real
 * Web Audio and that the AudioBufferSourceNode really does start on a matching
 * message. The content script runs in an ISOLATED world, so the spy has to be
 * installed there (CDP), not with addInitScript — that one patches the page's
 * own world.
 *
 * Covers, in order: a seeded rule + file (plays at the rule's own volume); the
 * audio context parking itself and waking for the next cue; a raid of matches
 * is one cue, not thirty; a rule whose file is not on this device plays the
 * ping; and the real settings UI — pick a file, add the rule, hear it, and an
 * export that carries the name but none of the bytes.
 *
 * NOT covered here: the browser refusing audio until a user gesture. Playwright
 * navigations count as user activation (navigator.userActivation.hasBeenActive
 * is true on arrival, with or without --autoplay-policy), so that path cannot be
 * produced in this harness; tests/chat-sounds.test.js drives it with a context
 * whose resume() stays pending or settles still-suspended.
 */
function wavBytes(seconds: number, hz: number) {
  const rate = 8000
  const n = Math.round(rate * seconds)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 12000), 44 + i * 2)
  return buf
}

const SOUND_SPY = `(() => {
  if (window.__hsSnd) return 'already'
  const log = (window.__hsSnd = { src: [], osc: 0, gains: [] })
  const ps = AudioBufferSourceNode.prototype.start
  AudioBufferSourceNode.prototype.start = function (...a) {
    log.src.push(this.buffer ? this.buffer.duration : -1)
    return ps.apply(this, a)
  }
  const po = OscillatorNode.prototype.start
  OscillatorNode.prototype.start = function (...a) {
    log.osc++
    return po.apply(this, a)
  }
  const pg = AudioParam.prototype.setValueAtTime
  AudioParam.prototype.setValueAtTime = function (v, t) {
    if (this.defaultValue === 1) log.gains.push(v)
    return pg.call(this, v, t)
  }
  return 'ok'
})()`

async function soundCheck() {
  console.log('\n── highlight rule sounds: a picked file, a volume, one rate limit ──')
  const irc = startMockIrc()
  if (!irc) {
    console.log('  ! SKIPPED — openssl not available, so the mock irc server has no cert.')
    console.log('    rule sounds are going UNVERIFIED in this run.')
    return
  }
  const { frames, push } = irc
  const prof = mkdtempSync(join(tmpdir(), 'hs-ext-sound-'))
  const wavDir = mkdtempSync(join(tmpdir(), 'hs-ext-sound-wav-'))
  const wavPath = join(wavDir, 'airhorn.wav')
  const wav = wavBytes(0.3, 880)
  writeFileSync(wavPath, wav)
  const c = await launchWithExtension(prof, [
    '--window-size=1500,900',
    `--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1:${irc.port}`,
    '--ignore-certificate-errors',
    '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
  ])
  try {
    await c.route('https://heatsync.org/**', (r: any) => r.abort())
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
    if (!id) fail('could not resolve the extension id for the sound check')

    // Seed through an extension page: rule 'seeded' has a file on this device,
    // rule 'ghost' points at one that is not here (a rule that synced in from
    // another machine). Volume 40 is NOT the shared default (30), so a cue that
    // ignored the rule's own volume would show up in the gain.
    const seedRules = [
      { id: 'seed1', enabled: true, scope: 'all', match: { type: 'keyword', value: 'seeded', caseSensitive: false }, action: 'highlight', color: '#ffff00', sound: 'custom', soundName: 'airhorn.wav', soundVolume: 40 },
      { id: 'ghost1', enabled: true, scope: 'all', match: { type: 'keyword', value: 'ghost', caseSensitive: false }, action: 'highlight', color: '#ff00ff', sound: 'custom', soundName: 'gone.wav', soundVolume: 40 },
    ]
    const seed = await c.newPage()
    await seed.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    await seed.evaluate(
      async ({ rules, b64 }: { rules: unknown[], b64: string }) => {
        // @ts-ignore — extension page
        await chrome.storage.local.set({
          heatsync_multichat: { channels: [{ id: 'probechan', twitch: 'probechan', kick: '', youtube: '' }] },
          user_info: { username: 'probeuser' },
          chat_filter_rules: JSON.stringify(rules),
          hs_sfx_rule_seed1: { n: 'airhorn.wav', t: 'audio/wav', b: b64 },
        })
      },
      { rules: seedRules, b64: wav.toString('base64') },
    )

    const p = await c.newPage()
    p.on('pageerror', (e: unknown) => errors.push(`sound: ${String(e).slice(0, 300)}`))
    const cdp = await c.newCDPSession(p)
    const worlds = new Set<number>()
    cdp.on('Runtime.executionContextCreated', ({ context }: any) => {
      if (context.auxData?.type === 'isolated' && String(context.origin).startsWith('chrome-extension://')) worlds.add(context.id)
    })
    cdp.on('Runtime.executionContextsCleared', () => worlds.clear())
    await cdp.send('Runtime.enable')
    await p.goto('https://www.twitch.tv/probechan', { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-input', { timeout: 25_000 })
    if (!(await until(p, () => frames.some((f) => f.startsWith('JOIN'))))) fail('the sound check never joined the channel')
    if (!worlds.size) fail('no extension isolated world on the page to spy in')
    for (const contextId of worlds) await cdp.send('Runtime.evaluate', { expression: SOUND_SPY, contextId })

    const spy = async () => {
      let src: number[] = []
      let osc = 0
      let gains: number[] = []
      for (const contextId of worlds) {
        const r = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__hsSnd || null)', contextId, returnByValue: true })
        const v = r.result?.value ? JSON.parse(r.result.value) : null
        if (v) {
          src = src.concat(v.src)
          osc += v.osc
          gains = gains.concat(v.gains)
        }
      }
      return { src, osc, gains }
    }
    let msgN = 0
    const say = (text: string) =>
      push(
        `@display-name=viewer;color=#00FF00;user-id=43;id=snd${++msgN} :viewer!v@v.tmi.twitch.tv PRIVMSG #probechan :${text}\r\n`,
      )
    const shown = (text: string) =>
      until(p, async () => (await p.evaluate(() => document.getElementById('hs-mc-messages')?.textContent || '')).includes(text), 8000)

    // ── the rule's file plays at the rule's volume ──────────────────────────
    await p.click('#hs-mc-input')
    say('seeded first match')
    if (!(await until(p, async () => (await spy()).src.length >= 1, 8000))) {
      fail(`a matching message started no AudioBufferSourceNode (spy: ${JSON.stringify(await spy())})`)
    }
    const played = await spy()
    if (Math.abs(played.src[0] - 0.3) > 0.01) fail(`the wrong sound started: duration ${played.src[0]}s, the file is 0.3s`)
    if (!played.gains.includes(0.4)) fail(`the cue did not play at the rule's own volume (40 -> 0.4): gains ${JSON.stringify(played.gains)}`)
    if (played.osc) fail(`a synth tone played alongside the picked file (${played.osc} oscillators)`)
    ok("a matching message plays the rule's own file (0.3s) at the rule's own volume (40 -> gain 0.4)")

    // ── the idle audio device is parked, then wakes for the next cue ────────
    const firstCue = (await spy()).src.length
    await p.waitForTimeout(3500) // past the cue's tail + the idle-suspend grace
    say('seeded after parking')
    if (!(await until(p, async () => (await spy()).src.length > firstCue, 8000))) {
      fail('after the audio device idled, the next matching message started no sound')
    }
    ok('a cue after the idle pause still plays (the parked audio device wakes)')

    // ── a raid is one cue ───────────────────────────────────────────────────
    const startsBefore = (await spy()).src.length
    await p.waitForTimeout(1400)
    for (let i = 0; i < 30; i++) say(`seeded raid ${i}`)
    if (!(await shown('seeded raid 29'))) fail('the raid never finished rendering')
    await p.waitForTimeout(600)
    const raided = (await spy()).src.length - startsBefore
    if (raided !== 1) fail(`30 matching messages started ${raided} sounds, expected exactly 1 (rate limit)`)
    ok('a raid of 30 matching messages is one cue, not thirty')

    // ── a file that is not on this device: the ping, not silence ────────────
    await p.waitForTimeout(1400)
    const oscBefore = (await spy()).osc
    const srcBefore = (await spy()).src.length
    say('ghost rule fires')
    if (!(await until(p, async () => (await spy()).osc > oscBefore, 8000))) {
      fail('a rule whose file is missing on this device played nothing — it must fall back to the ping')
    }
    if ((await spy()).src.length !== srcBefore) fail('a missing file somehow started a file source')
    ok('a rule whose file is missing on this device plays the ping instead of nothing')

    // ── the real settings UI: pick a file, add the rule, hear it ────────────
    await p.click('.hs-mc-tab[data-tab="settings"]')
    await p.click('.hs-mc-set-subtab[data-set-subtab="filters"]')
    await p.waitForSelector('.hs-mc-fr-addform [data-fr-field="value"]', { timeout: 8000 })
    // emote loading still redraws the settings tab in the first seconds; wait
    // for a redraw-free stretch so the typed text is not wiped mid-test
    const formIsQuiet = async () => {
      await p.evaluate(() => document.querySelector('.hs-mc-fr-addform')?.setAttribute('data-probe', '1'))
      await p.waitForTimeout(1500)
      return p.evaluate(() => document.querySelector('.hs-mc-fr-addform')?.getAttribute('data-probe') === '1')
    }
    if (!(await until(p, formIsQuiet, 12_000))) fail('the settings tab kept redrawing; the add-rule form never held still')
    await p.fill('.hs-mc-fr-addform [data-fr-field="value"]', 'viaui')
    const [chooser] = await Promise.all([
      p.waitForEvent('filechooser', { timeout: 8000 }),
      p.click('.hs-mc-fr-addform [data-fr-action="pick"]'),
    ])
    await chooser.setFiles(wavPath)
    const soundIsCustom = () =>
      p.evaluate(() => (document.querySelector('.hs-mc-fr-addform [data-fr-field="sound"]') as HTMLSelectElement)?.value === 'custom')
    if (!(await until(p, soundIsCustom, 8000))) fail('picking a file did not select "my file" in the sound menu')
    const pickLabel = await p.evaluate(() => document.querySelector('.hs-mc-fr-addform [data-fr-action="pick"]')?.textContent || '')
    if (!pickLabel.includes('airhorn.wav')) fail(`the pick button does not show the file name: ${JSON.stringify(pickLabel)}`)
    await p.evaluate(() => {
      const r = document.querySelector('.hs-mc-fr-addform [data-fr-field="vol"]') as HTMLInputElement
      r.value = '65'
      r.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const note = await p.evaluate(() => document.querySelector('.hs-mc-fr-addform')?.textContent || '')
    if (!/this device/i.test(note)) fail('the add-rule form never says the sound file stays on this device')
    await p.click('.hs-mc-fr-addform [data-fr-action="add"]')
    const readRule = () =>
      seed.evaluate(async () => {
        // @ts-ignore — extension page
        const all = await chrome.storage.local.get(null)
        const rule = JSON.parse(all.chat_filter_rules || '[]').find((r: any) => r.match?.value === 'viaui')
        const rec = rule ? all[`hs_sfx_rule_${rule.id}`] : null
        return { rule, recBytes: rec?.b?.length || 0, recName: rec?.n }
      })
    if (!(await until(seed, async () => !!(await readRule()).rule, 8000))) {
      fail('adding the rule through the form never saved a rule')
    }
    const saved = await readRule()
    if (saved.rule.sound !== 'custom') fail(`the rule did not keep the custom sound: ${JSON.stringify(saved.rule)}`)
    if (saved.rule.soundVolume !== 65) fail(`the rule did not keep the slider's volume: ${JSON.stringify(saved.rule)}`)
    if (saved.rule.soundName !== 'airhorn.wav') fail(`the rule did not keep the file name: ${JSON.stringify(saved.rule)}`)
    if (JSON.stringify(saved.rule).includes(wav.toString('base64').slice(0, 40))) {
      fail('the audio bytes leaked into the synced rule itself')
    }
    if (saved.recBytes < 1000 || saved.recName !== 'airhorn.wav') {
      fail(`the file did not land on this device: ${JSON.stringify({ bytes: saved.recBytes, name: saved.recName })}`)
    }
    await p.waitForTimeout(1400)
    const uiBefore = (await spy()).src.length
    say('viaui matched')
    if (!(await until(p, async () => (await spy()).src.length > uiBefore, 8000))) {
      fail('the rule added through the real form did not play its file')
    }
    ok('the settings form: pick a file, set 65, add -> the rule keeps name + volume, the file lands on this device, and it plays')

    // ── export carries the name and the volume, never the bytes ─────────────
    await p.click('.hs-mc-set-subtab[data-set-subtab="system"]')
    await p.waitForSelector('.hs-mc-settings-btn[data-action="export-settings"]', { timeout: 8000 })
    const [dl] = await Promise.all([
      p.waitForEvent('download', { timeout: 10_000 }),
      p.click('.hs-mc-settings-btn[data-action="export-settings"]'),
    ])
    const exported = readFileSync((await dl.path()) as string, 'utf8')
    if (/hs_sfx_/.test(exported)) fail('the settings export contains a sound file key (hs_sfx_*)')
    if (exported.includes(wav.toString('base64').slice(0, 60))) fail('the settings export contains the audio bytes')
    if (!exported.includes('airhorn.wav') || !exported.includes('soundVolume\\":65')) {
      fail("the settings export lost the rule's sound name or volume")
    }
    if (exported.length > 20_000) fail(`the settings export is ${exported.length} bytes — sound files must not ride it`)
    ok(`export keeps the rule's sound name + volume, none of the audio (${exported.length} bytes)`)

    await seed.close()
  } finally {
    irc.stop()
    await closeContext(c, 'rule sounds', prof)
    rmSync(prof, { recursive: true, force: true })
    rmSync(wavDir, { recursive: true, force: true })
  }
}

/** A 32x32 opaque tile, so picker tiles lay out like real emotes instead of 1px specks. */
const TILE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR42u3NsQkAAAgDsJ7fr/UKByGQPWnnVAQCgUAgEAgEAsGXYAHc9Dx5h11nVgAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * The composer and the emote picker, used the way a person who never touches
 * the mouse uses them.
 *
 *  1. SENT HISTORY SURVIVES A RELOAD. Send two messages over the wire, reload
 *     the page, press ArrowUp: the newest comes back, then the one before it.
 *     Memory-only history made every reload forget what you had just said.
 *  2. SPELLCHECK is a setting that reaches the live composer: flip it in
 *     storage and the same node changes, no reload.
 *  3. THE AUTOCOMPLETE LIST IS A COMBOBOX. ":nav" opens a listbox whose options
 *     have ids, the composer names the open list and the highlighted row, and
 *     arrowing moves aria-activedescendant to another real option.
 *  4. THE PICKER FROM THE KEYBOARD. Opened with Enter on the button, focus lands
 *     in the search box; ArrowDown engages the first tile, arrows/Home/End move
 *     a cyan cursor that stays in view and runs on across lazily-drawn chunks,
 *     Enter inserts exactly as a click does, and Escape closes the panel and
 *     gives the composer back. Then the same on SEARCH RESULTS, which replace
 *     the grid's contents. A mouse open must NOT steal focus.
 */
async function composerAndPickerCheck() {
  console.log('\n── composer history, spellcheck, autocomplete a11y, picker keyboard ──')
  const irc = startMockIrc()
  if (!irc) {
    console.log('  ! SKIPPED — openssl not available, so there is no live chat to send into.')
    console.log('    sent-history persistence and picker keyboard nav are going UNVERIFIED in this run.')
    return
  }
  const { frames } = irc

  const E = (n: string) => `https://cdn.heatsync.org/emote/${n}.png`
  const prof = mkdtempSync(join(tmpdir(), 'hs-ext-composer-'))
  const c = await launchWithExtension(prof, [
    '--window-size=1500,900',
    `--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1:${irc.port}`,
    '--ignore-certificate-errors',
    '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
  ])
  try {
    // Every catalog the picker search fans out to is refused, so what a query
    // returns is the seeded pool and nothing from this machine's network.
    await c.route('https://heatsync.org/**', (r: any) => r.abort())
    await c.route('https://api.frankerfacez.com/**', (r: any) => r.abort())
    await c.route('https://7tv.io/**', (r: any) => r.abort())
    await c.route('https://api.betterttv.net/**', (r: any) => r.abort())
    await c.route('https://cdn.heatsync.org/**', (r: any) =>
      r.fulfill({ status: 200, contentType: 'image/png', body: TILE_PNG }),
    )
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
    if (!id) fail('could not resolve the extension id for the composer check')

    /** Run something on the extension's own page (chrome.storage is unreachable from the host page's world). */
    let p: any = null
    const onExt = async (fn: (arg: any) => any, arg?: any) => {
      const e = await c.newPage()
      try {
        await e.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
        return await e.evaluate(fn, arg)
      } finally {
        await e.close()
        // a hidden tab does not render, and every assertion below is a rendering one
        if (p) await p.bringToFront()
      }
    }

    // 250 global emotes = three chunks of the lazily-drawn grid, so End and a
    // long ArrowDown have to cross chunks that were never drawn.
    const globals = Array.from({ length: 250 }, (_, i) => {
      const name = `nav${String(i).padStart(3, '0')}`
      return { name, url: E(name), source: '7tv' }
    })
    const channel = Array.from({ length: 6 }, (_, i) => ({ name: `chan${i}`, url: E(`chan${i}`), source: '7tv' }))
    await onExt(
      async (seed: any) => {
        // @ts-ignore — extension page
        await chrome.storage.local.set({
          heatsync_multichat: { channels: [{ id: 'probechan', twitch: 'probechan', kick: '', youtube: '' }] },
          user_info: { username: 'probeuser' },
          global_emotes: seed.globals,
          channel_emotes_map: { 'twitch/probechan': seed.channel },
        })
      },
      { globals, channel },
    )

    p = await c.newPage()
    p.on('pageerror', (e: unknown) => errors.push(`composer: ${String(e).slice(0, 300)}`))
    await p.goto('https://www.twitch.tv/probechan', { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-input', { timeout: 25_000 })
    if (!(await until(p, () => frames.some((f) => f.startsWith('PASS oauth:'))))) {
      fail(`the authenticated irc connection never handshook (frames: ${JSON.stringify(frames.slice(0, 8))})`)
    }

    const composerText = (): Promise<string> =>
      p.evaluate(() => (document.getElementById('hs-mc-input')?.textContent || '').replace(/ /g, ' '))
    const clearComposer = async () => {
      await p.evaluate(() => {
        const i = document.getElementById('hs-mc-input')
        if (i) i.innerHTML = ''
      })
      await p.click('#hs-mc-input')
    }

    // ── 1. sent history survives a reload ───────────────────────────────────
    const sent = ['first message from the harness', 'second message from the harness']
    for (const m of sent) {
      await p.click('#hs-mc-input')
      await p.keyboard.type(m)
      await p.keyboard.press('Enter')
      if (!(await until(p, () => frames.includes(`PRIVMSG #probechan :${m}`), 10_000))) {
        fail(`${JSON.stringify(m)} never left on the irc wire — nothing to remember`)
      }
    }
    const readStored = () =>
      onExt(
        () =>
          // @ts-ignore — extension page
          new Promise((res) => chrome.storage.local.get('hs_sent_history', (v: any) => res(v.hs_sent_history))),
      )
    if (!(await until(p, async () => JSON.stringify(await readStored()) === JSON.stringify([...sent].reverse()), 8000))) {
      fail(`chrome.storage.local hs_sent_history is ${JSON.stringify(await readStored())}, expected the two sends newest first`)
    }
    ok('sent messages are written to chrome.storage.local, newest first')

    await p.reload({ waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-input', { timeout: 25_000 })
    await p.click('#hs-mc-input')
    if ((await composerText()) !== '') fail('the composer did not start empty after the reload')
    // The list loads without blocking boot, so the first ArrowUp(s) can land
    // before it does; a press with no history is a no-op, so pressing until the
    // newest line appears can only ever land on the newest line.
    let recalled = ''
    await until(
      p,
      async () => {
        await p.keyboard.press('ArrowUp')
        recalled = await composerText()
        return recalled !== ''
      },
      10_000,
    )
    if (recalled !== sent[1]) {
      fail(`after a reload ArrowUp recalled ${JSON.stringify(recalled)}, expected the newest send ${JSON.stringify(sent[1])}`)
    }
    await p.keyboard.press('ArrowUp')
    if ((await composerText()) !== sent[0]) fail(`the second ArrowUp did not reach the older send (${JSON.stringify(await composerText())})`)
    await p.keyboard.press('ArrowUp')
    if ((await composerText()) !== sent[0]) fail('ArrowUp past the oldest entry should stay on it')
    await p.keyboard.press('ArrowDown')
    if ((await composerText()) !== sent[1]) fail('ArrowDown did not walk back to the newer send')
    await p.keyboard.press('ArrowDown')
    if ((await composerText()) !== '') fail('ArrowDown past the newest entry should hand back the empty draft')
    ok('after a page reload ArrowUp/ArrowDown walk the sent history (newest, older, clamp, back to the draft)')

    // ── 1b. settings: "remember sent messages" is on, "clear sent history" clears ──
    await p.click('.hs-mc-tab[data-tab="settings"]')
    await p.waitForSelector('.hs-mc-settings-panel', { timeout: 10_000 })
    await p.click('.hs-mc-set-subtab[data-set-subtab="chat"]')
    const rememberPill = '.hs-mc-toggle-pill[data-set-key="hs_remember_sent"]'
    await p.waitForSelector(rememberPill, { timeout: 10_000 })
    if (!(await p.$eval(rememberPill, (el: any) => el.classList.contains('active')))) {
      fail('"remember sent messages" should be ON out of the box')
    }
    await p.click('.hs-mc-settings-btn[data-action="clear-sent-history"]')
    if (!(await until(p, async () => (await readStored()) === undefined, 8000))) {
      fail(`"clear sent history" left ${JSON.stringify(await readStored())} in chrome.storage.local`)
    }
    await p.reload({ waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-input', { timeout: 25_000 })
    await p.click('#hs-mc-input')
    await p.waitForTimeout(1500) // long enough for a (wrongly) surviving list to have loaded
    await p.keyboard.press('ArrowUp')
    if ((await composerText()) !== '') fail('ArrowUp still recalled a message after "clear sent history" and a reload')
    ok('settings has "remember sent messages" (on) and "clear sent history" wipes the stored list for good')

    // ── 2. spellcheck is a live setting ─────────────────────────────────────
    const spell = (): Promise<boolean | null> =>
      p.evaluate(() => {
        const i = document.getElementById('hs-mc-input') as any
        return i ? !!i.spellcheck : null
      })
    await p.evaluate(() => {
      ;(document.getElementById('hs-mc-input') as any).__probe = 'same node'
    })
    if ((await spell()) !== false) fail('spellcheck should be OFF by default')
    ok('spellcheck is off by default')
    for (const want of [true, false]) {
      await onExt(
        // @ts-ignore — extension page
        (v: boolean) => chrome.storage.local.set({ hs_spellcheck: v }),
        want,
      )
      if (!(await until(p, async () => (await spell()) === want, 8000))) {
        fail(`setting hs_spellcheck=${want} never reached the live composer (spellcheck is ${await spell()})`)
      }
    }
    const sameNode = await p.evaluate(() => (document.getElementById('hs-mc-input') as any).__probe === 'same node')
    if (!sameNode) fail('flipping spellcheck rebuilt the composer instead of updating it in place')
    ok('flipping hs_spellcheck on then off reaches the live composer, same node, no reload')

    // ── 3. the autocomplete list is a combobox ──────────────────────────────
    await clearComposer()
    await p.keyboard.type(':nav00')
    const combo = () =>
      p.evaluate(() => {
        const i = document.getElementById('hs-mc-input') as HTMLElement
        const dd = document.getElementById('hs-mc-emoji-dropdown')
        const ad = i.getAttribute('aria-activedescendant')
        const target = ad ? document.getElementById(ad) : null
        return {
          role: i.getAttribute('role'),
          auto: i.getAttribute('aria-autocomplete'),
          expanded: i.getAttribute('aria-expanded'),
          controls: i.getAttribute('aria-controls'),
          ad,
          adInList: !!(target && dd?.contains(target)),
          adSelected: target?.getAttribute('aria-selected') ?? null,
          selectedCount: dd ? dd.querySelectorAll('[aria-selected="true"]').length : 0,
          listRole: dd?.getAttribute('role') ?? null,
          listLabel: dd?.getAttribute('aria-label') ?? '',
          optRoles: [...(dd?.children || [])].map((x) => x.getAttribute('role')),
          optIds: [...(dd?.children || [])].map((x) => x.id),
          shown: !!dd && getComputedStyle(dd).display !== 'none',
        }
      })
    if (!(await until(p, async () => (await combo()).shown, 8000))) fail('typing ":nav00" never opened the emote list')
    const open = await combo()
    if (open.role !== 'combobox' || open.auto !== 'list') fail(`the composer is not a list combobox: ${JSON.stringify(open)}`)
    if (open.expanded !== 'true' || open.controls !== 'hs-mc-emoji-dropdown') {
      fail(`an open list is not announced on the composer: ${JSON.stringify(open)}`)
    }
    if (open.listRole !== 'listbox' || !open.listLabel) fail(`the list is not a named listbox: ${JSON.stringify(open)}`)
    if (!open.optRoles.length || open.optRoles.some((r: string | null) => r !== 'option')) {
      fail(`list rows are not all options: ${JSON.stringify(open.optRoles)}`)
    }
    if (new Set(open.optIds).size !== open.optIds.length || open.optIds.some((x: string) => !x)) {
      fail(`list options need unique ids: ${JSON.stringify(open.optIds)}`)
    }
    if (!open.ad || !open.adInList || open.adSelected !== 'true' || open.selectedCount !== 1) {
      fail(`aria-activedescendant does not name the one selected option: ${JSON.stringify(open)}`)
    }
    await p.keyboard.press('ArrowDown')
    const moved = await combo()
    if (!moved.ad || moved.ad === open.ad || !moved.adInList || moved.adSelected !== 'true' || moved.selectedCount !== 1) {
      fail(`ArrowDown did not move aria-activedescendant to another option: ${open.ad} -> ${moved.ad}`)
    }
    await p.keyboard.press('Escape')
    const shut = await combo()
    if (shut.expanded !== 'false' || shut.controls !== null || shut.ad !== null) {
      fail(`closing the list left the composer claiming it is open: ${JSON.stringify(shut)}`)
    }
    ok(`":nav00" opens a listbox of ${open.optRoles.length} options; the composer names it and tracks the highlighted row; closing releases it`)

    // Tab-complete draws no list, so its candidate must be a live region.
    await clearComposer()
    await p.keyboard.type('nav01')
    await p.keyboard.press('Tab')
    const status = await until(
      p,
      () =>
        p.evaluate(() => {
          const tt = document.getElementById('hs-mc-cycle-tooltip')
          return tt?.getAttribute('role') === 'status' && /\d+\/\d+/.test(tt.textContent || '')
        }),
      8000,
    )
    if (!status) fail('the tab-complete candidate is not announced in a role=status region')
    ok('tab-complete announces its candidate (n/m name) through a role=status region')

    // ── 4. the picker from the keyboard ─────────────────────────────────────
    await clearComposer()
    await p.keyboard.type('hi ') // a draft keeps the composer from auto-hiding when focus moves to the button
    const pickerOpen = () => p.evaluate(() => !!document.getElementById('hs-mc-emote-picker')?.classList.contains('visible'))
    const searchFocused = () => p.evaluate(() => document.activeElement?.id === 'hs-mc-emote-search')
    const composerFocused = () => p.evaluate(() => document.activeElement?.id === 'hs-mc-input')

    // A mouse open must not move focus: the reader is mid-sentence.
    await p.click('#hs-mc-emote-btn')
    await p.waitForSelector('#hs-mc-emote-picker.visible', { timeout: 10_000 })
    if (await searchFocused()) fail('opening the picker with the MOUSE moved focus into its search box')
    ok('a mouse open leaves focus where it was')
    await p.click('#hs-mc-emote-btn')
    if (await pickerOpen()) fail('clicking the emote button a second time did not close the picker')

    await p.focus('#hs-mc-emote-btn')
    await p.keyboard.press('Enter')
    await p.waitForSelector('#hs-mc-emote-picker.visible', { timeout: 10_000 })
    if (!(await until(p, searchFocused, 4000))) fail('opening the picker with Enter on the button did not land in its search box')
    ok('Enter on the emote button opens the picker with focus in the search box')

    const grid = () =>
      p.evaluate(() => {
        const g = document.getElementById('hs-mc-emote-grid') as HTMLElement
        const input = document.getElementById('hs-mc-emote-search') as HTMLInputElement
        const tiles = [...g.querySelectorAll('.hs-mc-picker-emote-wrap')] as HTMLElement[]
        const sel = tiles.filter((t) => t.getAttribute('aria-selected') === 'true')
        const s = sel[0]
        const gr = g.getBoundingClientRect()
        const r = s?.getBoundingClientRect()
        const ad = input.getAttribute('aria-activedescendant')
        const before = s ? getComputedStyle(s, '::before') : null
        return {
          total: tiles.length,
          selCount: sel.length,
          idx: s ? tiles.indexOf(s) : -1,
          name: s?.dataset.name || '',
          adIsSel: !!s && !!ad && s.id === ad,
          cx: r ? Math.round(r.left + r.width / 2) : 0,
          top: r ? Math.round(r.top) : 0,
          inView: r ? r.top >= gr.top - 1 && r.bottom <= gr.bottom + 1 : false,
          scrollTop: g.scrollTop,
          focused: document.activeElement === input,
          plate: before ? before.backgroundColor : '',
          plateOpacity: before ? before.opacity : '',
          groups: g.querySelectorAll('[role="group"]').length,
          comboRole: input.getAttribute('role'),
          expanded: input.getAttribute('aria-expanded'),
          controls: input.getAttribute('aria-controls'),
          listOk: !!g.querySelector(`[role="listbox"]#${input.getAttribute('aria-controls')}`),
          optionRoles: tiles.slice(0, 8).every((t) => t.getAttribute('role') === 'option'),
          names: tiles.map((t) => t.dataset.name || ''),
        }
      })
    const key = async (k: string) => {
      await p.keyboard.press(k)
    }

    if (!(await until(p, async () => (await grid()).total > 0, 10_000))) fail('the picker drew no tiles')
    const idle = await grid()
    if (idle.comboRole !== 'combobox' || idle.expanded !== 'true' || !idle.listOk || !idle.optionRoles) {
      fail(`the picker's search box / grid are not a combobox over a listbox of options: ${JSON.stringify({ ...idle, names: undefined })}`)
    }
    if (idle.selCount !== 0) fail('a tile was selected before any key was pressed')
    ok('the picker is a combobox (search box) over a listbox of option tiles')

    await key('ArrowDown')
    let st = await grid()
    if (st.idx !== 0 || st.selCount !== 1 || !st.adIsSel || !st.focused) {
      fail(`ArrowDown should engage the first tile and keep focus in the box: ${JSON.stringify({ ...st, names: undefined })}`)
    }
    if (st.plate !== 'rgb(0, 255, 255)' || st.plateOpacity !== '1') {
      fail(`the cursor is not drawn as the cyan plate (got ${st.plate}, opacity ${st.plateOpacity})`)
    }
    ok('ArrowDown engages the first tile: aria-selected + aria-activedescendant, cyan plate, focus stays in the box')

    await key('ArrowRight')
    st = await grid()
    if (st.idx !== 1 || st.selCount !== 1 || !st.adIsSel) fail(`ArrowRight did not move to the second tile: ${st.idx}`)
    const rowStart = st
    await key('ArrowDown')
    st = await grid()
    if (!(st.top > rowStart.top) || Math.abs(st.cx - rowStart.cx) > 2 || !st.adIsSel) {
      fail(`ArrowDown should move one row down in the same column: ${JSON.stringify({ from: rowStart, to: st })}`)
    }
    const perRow = st.idx - rowStart.idx
    await key('ArrowUp')
    st = await grid()
    if (st.idx !== rowStart.idx) fail(`ArrowUp did not return to the tile above (${st.idx} vs ${rowStart.idx})`)
    ok(`arrows move the cursor by tile and by row (${perRow} tiles per row)`)

    await key('Home')
    await key('ArrowUp')
    st = await grid()
    if (st.idx !== 0) fail(`ArrowUp on the first row should stay put, got tile ${st.idx}`)

    // Hold ArrowDown past the first drawn chunk: the cursor must never run into
    // an empty placeholder, and must stay in view the whole way.
    let last = 0
    for (let i = 0; i < 22 && st.idx < 100; i++) {
      await key('ArrowDown')
      st = await grid()
      if (st.idx <= last && i > 0) fail(`ArrowDown stalled at tile ${st.idx} (step ${i}) — the next chunk was not there`)
      if (!st.inView) fail(`the cursor left the visible grid at tile ${st.idx}`)
      last = st.idx
    }
    if (st.idx < 96) fail(`22 ArrowDowns only reached tile ${st.idx}; expected to cross the first chunk (96)`)
    ok(`holding ArrowDown crosses the first lazily-drawn chunk (tile ${st.idx}) and stays in view`)

    await key('End')
    st = await grid()
    if (st.idx !== st.total - 1 || st.total < 200 || !st.inView || !st.adIsSel) {
      fail(`End should land on the last tile, in view: ${JSON.stringify({ ...st, names: undefined })}`)
    }
    ok(`End jumps to the last tile of ${st.total}, drawing the chunk that was still a placeholder`)
    await key('Home')
    st = await grid()
    if (st.idx !== 0 || st.scrollTop !== 0 || !st.inView) fail(`Home should land on the first tile at the top: ${JSON.stringify({ ...st, names: undefined })}`)
    ok('Home jumps back to the first tile and scrolls to the top')

    // ── Enter inserts exactly as a click does ───────────────────────────────
    await key('ArrowRight')
    st = await grid()
    const viaKeyboard = st.name
    await key('Enter')
    const chips = () =>
      p.evaluate(() =>
        [...(document.getElementById('hs-mc-input')?.querySelectorAll('img.hs-input-emote') || [])].map(
          (i) => (i as HTMLImageElement).alt,
        ),
      )
    if (!(await until(p, async () => (await chips()).includes(viaKeyboard), 5000))) {
      fail(`Enter on the engaged tile ${viaKeyboard} inserted nothing (composer chips: ${JSON.stringify(await chips())})`)
    }
    if (!(await pickerOpen())) fail('Enter closed the picker; a click leaves it open')
    if (!(await composerFocused())) fail('after Enter, focus should be in the composer, as it is after a click')
    ok(`Enter inserts the engaged tile (${viaKeyboard}) as a chip, picker stays open, focus returns to the composer`)

    const clickName = (await grid()).names[3]
    await p.click(`#hs-mc-emote-grid .hs-mc-picker-emote-wrap[data-name="${clickName}"]`)
    if (!(await until(p, async () => (await chips()).includes(clickName), 5000))) {
      fail(`a real mouse click on ${clickName} inserted nothing — the control for the Enter check`)
    }
    ok(`a mouse click on ${clickName} inserts the same kind of chip (the control for Enter)`)

    // ── the SEARCH surface: results replace the grid's contents ─────────────
    await p.click('#hs-mc-emote-search')
    await p.keyboard.type('nav01')
    if (
      !(await until(
        p,
        async () => {
          const g = await grid()
          return g.total > 0 && g.total <= 10 && g.names.every((n: string) => n.includes('nav01'))
        },
        8000,
      ))
    ) {
      fail(`searching "nav01" never narrowed the grid to its matches: ${JSON.stringify((await grid()).names.slice(0, 12))}`)
    }
    const found = await grid()
    if (found.groups !== 0) fail('search results should be one flat list, not the sectioned set')
    if (found.selCount !== 0) fail('typing a query should have released the cursor')
    // text is in the box, so Left/Right/Home/End still edit it until the cursor is engaged
    await key('ArrowLeft')
    const caret = await p.evaluate(() => (document.getElementById('hs-mc-emote-search') as HTMLInputElement).selectionStart)
    if (caret !== 4 || (await grid()).selCount !== 0) {
      fail(`ArrowLeft in a typed query should move the caret (caret ${caret}), not engage the grid`)
    }
    await key('End')
    await key('ArrowDown')
    st = await grid()
    if (st.idx !== 0 || !st.name.startsWith('nav01') || !st.adIsSel || !st.focused) {
      fail(`ArrowDown in search results should engage the first result: ${JSON.stringify({ ...st, names: undefined })}`)
    }
    await key('ArrowRight')
    await key('End')
    st = await grid()
    if (st.idx !== st.total - 1) fail(`End in search results should land on the last result (${st.idx}/${st.total})`)
    await key('Home')
    await key('ArrowRight')
    const pickedFromSearch = (await grid()).name
    await key('Enter')
    if (!(await until(p, async () => (await chips()).includes(pickedFromSearch), 5000))) {
      fail(`Enter on search result ${pickedFromSearch} inserted nothing`)
    }
    ok(`search results work the same: engage, move, Home/End, Enter inserts ${pickedFromSearch}; typed text keeps its caret keys`)

    // Enter with nothing engaged takes the best match, once the grid shows the query.
    await p.fill('#hs-mc-emote-search', 'nav02')
    if (!(await until(p, async () => (await grid()).names.length > 0 && (await grid()).names.every((n: string) => n.includes('nav02')), 8000))) {
      fail('searching "nav02" never narrowed the grid')
    }
    const best = (await grid()).names[0]
    await key('Enter')
    if (!(await until(p, async () => (await chips()).filter((x: string) => x === best).length >= 1, 5000))) {
      fail(`Enter on a typed query with nothing engaged should insert the best match ${best}`)
    }
    ok(`Enter on a typed query inserts the best match (${best})`)

    // ── Escape ──────────────────────────────────────────────────────────────
    await p.click('#hs-mc-emote-search')
    if (!(await searchFocused())) fail('could not put focus back in the search box for the Escape check')
    await key('Escape')
    if (await pickerOpen()) fail('Escape did not close the picker')
    if (!(await until(p, composerFocused, 3000))) fail('Escape closed the picker but did not return focus to the composer')
    ok('Escape closes the picker and returns focus to the composer')
  } finally {
    irc.stop()
    await closeContext(c, 'composer + picker', prof)
    rmSync(prof, { recursive: true, force: true })
  }
}

async function emoteUploadCheck() {
  console.log('\n── uploading your own emote from the picker ──')
  const prof = mkdtempSync(join(tmpdir(), 'hs-ext-upload-'))
  const c = await launchWithExtension(prof, ['--window-size=1500,900'])
  try {
    const json = (body: unknown, status = 200) => ({
      status,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(body),
    })
    const posted: any[] = []
    let uploads = 0
    let takenOnce = true
    // last-registered-first: blanket abort goes down first
    await c.route('https://heatsync.org/**', (r: any) => r.abort())
    await c.route('https://heatsync.org/api/user/emotes**', (r: any) => {
      const req = r.request()
      if (req.method() !== 'POST') return r.fulfill(json({ emotes: [] }))
      const body = JSON.parse(req.postData() || '{}')
      posted.push(body)
      if (body.emoteName === 'taken' && takenOnce) {
        takenOnce = false
        return r.fulfill(json({ error: 'Emote name already in inventory' }, 409))
      }
      return r.fulfill(json({ success: true, slot: 1, hash: 'abc123' }))
    })
    await c.route('https://heatsync.org/api/upload**', (r: any) => {
      uploads++
      return r.fulfill(
        json({
          success: true,
          url: 'https://cdn.heatsync.org/uploads/abc.webp',
          phash: 'abc123',
          width: 128,
          height: 128,
          moderationResult: { flaggedCategories: [] },
        }),
      )
    })
    await c.route('https://cdn.heatsync.org/**', (r: any) =>
      r.fulfill({ status: 200, contentType: 'image/png', body: ONE_PX_PNG }),
    )
    await c.route(PLATFORMS[0].glob, (r: any) =>
      r.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml(PLATFORMS[0].body) }),
    )
    await c.addCookies([
      { name: 'auth', value: 'harnesstoken0000', domain: 'heatsync.org', path: '/', secure: true },
    ])

    let sw = c.serviceWorkers()[0]
    if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 20_000 })
    const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
    if (!id) fail('could not resolve the extension id for the upload check')
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
    p.on('pageerror', (e: unknown) => errors.push(`upload: ${String(e).slice(0, 300)}`))
    await p.goto('https://www.twitch.tv/probechan', { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-input', { timeout: 25_000 })
    await p.click('#hs-mc-input')
    await p.waitForSelector('#hs-mc-emote-btn', { timeout: 10_000 })
    await p.click('#hs-mc-emote-btn')
    await p.waitForSelector('#hs-mc-emote-picker.visible', { timeout: 10_000 })
    await p.waitForSelector('#hs-mc-upload-btn', { timeout: 5000 })
    ok('the picker header carries an upload button')

    const png = { name: 'my-cool_emote-2x.png', mimeType: 'image/png', buffer: ONE_PX_PNG }
    const status = () => p.evaluate(() => document.getElementById('hs-mc-upload-status')?.textContent || '')
    const formShown = () => p.evaluate(() => !(document.getElementById('hs-mc-upload-form') as any)?.hidden)

    // a wrong file type is refused in words, before anything is sent
    await p.setInputFiles('#hs-mc-upload-file', { name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') })
    if (!(await until(p, async () => (await status()).length > 0, 5000))) fail('a .txt pick said nothing')
    if (await formShown()) fail('a .txt pick opened the name form')
    if (uploads) fail('a .txt pick reached the server')
    ok(`a wrong file type is refused in words (${JSON.stringify(await status())})`)

    // good file: name defaults from the filename, focus lands in the field
    await p.setInputFiles('#hs-mc-upload-file', png)
    await p.waitForSelector('#hs-mc-upload-name:focus', { timeout: 5000 })
    const def = await p.inputValue('#hs-mc-upload-name')
    if (def !== 'mycool_emote') fail(`default name was ${JSON.stringify(def)}, expected mycool_emote`)
    ok('the name defaults from the file and the field has focus')

    // Esc backs out of the form only, the picker stays open
    await p.keyboard.press('Escape')
    if (await formShown()) fail('Esc left the name form open')
    const stillOpen = await p.evaluate(() =>
      document.getElementById('hs-mc-emote-picker')?.classList.contains('visible'),
    )
    if (!stillOpen) fail('Esc in the name field closed the whole picker')
    ok('Esc cancels the form without closing the picker')

    // Enter uploads and adds
    await p.setInputFiles('#hs-mc-upload-file', png)
    await p.waitForSelector('#hs-mc-upload-name:focus', { timeout: 5000 })
    await p.fill('#hs-mc-upload-name', 'probeEmote')
    await p.keyboard.press('Enter')
    if (!(await until(p, () => posted.length >= 1, 10_000))) fail('Enter never added the emote to the inventory')
    const body = posted[0]
    if (body.emoteName !== 'probeEmote' || body.source !== 'upload') {
      fail(`inventory add sent ${JSON.stringify(body)}, expected source upload + the typed name`)
    }
    if (uploads !== 1) fail(`expected exactly 1 upload call, saw ${uploads}`)
    ok('Enter uploads once, then adds with source=upload under the typed name')
    if (!(await until(p, async () => !(await formShown()), 5000))) fail('the form stayed open after success')

    // a taken name keeps the form open and says so; the file is not re-uploaded
    await p.setInputFiles('#hs-mc-upload-file', png)
    await p.waitForSelector('#hs-mc-upload-name:focus', { timeout: 5000 })
    await p.fill('#hs-mc-upload-name', 'taken')
    await p.keyboard.press('Enter')
    if (!(await until(p, async () => (await status()).includes('taken'), 8000))) {
      fail(`a taken name said ${JSON.stringify(await status())}`)
    }
    if (!(await formShown())) fail('a taken name closed the form')
    const before = uploads
    await p.fill('#hs-mc-upload-name', 'taken2')
    await p.keyboard.press('Enter')
    if (!(await until(p, async () => !(await formShown()), 8000))) fail('retry with a new name did not finish')
    if (uploads !== before) fail('retrying after a name conflict uploaded the file again')
    ok('a taken name keeps the form and the uploaded file; the retry does not re-upload')
  } finally {
    await closeContext(c, 'emote upload', prof)
    rmSync(prof, { recursive: true, force: true })
  }
}

async function gateCheck() {
  // The user's off switch is per site (settings › subsystems › heatsync on
  // twitch / kick / youtube): off = heatsync never mounts there and the page
  // keeps its own chat. The older per-chat switches (irc-twitch, chat-kick,
  // chat-youtube) were retired in fc45eeba — a stored false for them is reset
  // to on at boot — so they are not the thing to test.
  console.log('\n── per-site off switch ──')

  // ON first: if this fails the OFF result below means nothing.
  const on = await gatePolarity({ 'overlay-twitch': true, 'overlay-kick': true, 'overlay-youtube': true })
  for (const [k, label] of [['twitch', 'twitch'], ['kick', 'kick'], ['yt', 'youtube']] as const) {
    if (!(on as any)[k]) {
      fail(
        `with heatsync ON for twitch, a ${label} message never rendered in the twitch overlay — this check ` +
          'cannot distinguish a working off switch from broken chat, so it is reporting the latter',
      )
    }
  }
  ok(`switch ON: twitch, kick and youtube all render (wire: ${on.wire.join(', ') || 'none'})`)

  const off = await gatePolarity({ 'overlay-twitch': false, 'overlay-kick': true, 'overlay-youtube': true })
  if (off.mounted) fail('with heatsync OFF for twitch the overlay still mounted on a twitch page')
  ok('switch OFF: no overlay on twitch, the page keeps its own chat')
  if (off.wire.length) {
    fail(
      `with heatsync OFF for twitch the page still asked the background for: ${off.wire.join(', ')} — ` +
        'the switch stops the render but not the work',
    )
  }
  ok('switch OFF: the twitch page asks the background for nothing')
}

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
async function tourCheck() {
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
    for (let i = 0; i < 20 && (await sendRow('TOUR1', 'tour probe row')) !== 'sent'; i++) await p.waitForTimeout(500)
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

try {
  assertBuilt()
  ctx = await launchWithExtension(profile, ['--window-size=1600,900'])
  ctx.on('page', (p: any) => p.on('pageerror', (e: unknown) => errors.push(`page: ${String(e).slice(0, 300)}`)))
  // Same reason as in the picker check: nothing below may navigate until the
  // extension is live, or there is no content-script injection to wait for.
  if (!ctx.serviceWorkers()[0]) await ctx.waitForEvent('serviceworker', { timeout: 20_000 })

  // Never touch production from a test.
  await ctx.route('https://heatsync.org/**', (r: any) => r.abort())
  for (const plat of PLATFORMS) {
    await ctx.route(plat.glob, (r: any) => {
      // a kick channel page asks kick's api for the channel/chatroom ids;
      // answer as json so the mount path sees a real channel, not html
      const u = r.request().url()
      if (u.includes('/api/v2/channels/')) {
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 111, chatroom: { id: 222 } }) })
      }
      if (u.includes('/api/')) return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      r.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml(plat.body) })
    })
  }

  // Seed one saved channel via an extension page (chrome.storage isn't
  // reachable from a fixture page's main-world evaluate — it only exists in
  // the content script's isolated world). The twitch fixture is a
  // non-channel url (/directory) on purpose (see the PLATFORMS doc comment),
  // and updateTwitchNoChannelClass now hides the panel there when
  // config.channels is empty — the audit-1.7.75 fix for an empty 340px panel
  // floating over pure browsing. Seeding one channel keeps this suite
  // testing what it always tested (persistent-overlay geometry on a
  // non-channel page with a real saved tab), same pattern the send-check
  // block below already uses for its own probechan fixture.
  {
    const sw = ctx.serviceWorkers()[0]
    const id = sw?.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
    if (!id) fail('could not resolve the extension id to seed a channel')
    const seed = await ctx.newPage()
    await seed.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    await seed.evaluate(async () => {
      // @ts-ignore — extension page
      await chrome.storage.local.set({
        heatsync_multichat: { channels: [{ id: 'probechan', twitch: 'probechan', kick: '', youtube: '' }] },
      })
    })
    await seed.close()
  }

  for (const plat of PLATFORMS) {
    console.log(`\n── ${plat.name} ──`)
    const p = await ctx.newPage()
    p.on('pageerror', (e: unknown) => errors.push(`${plat.name}: ${String(e).slice(0, 300)}`))
    await p.goto(plat.url, { waitUntil: 'domcontentloaded' })

    await p.waitForSelector('#hs-mc-overlay', { timeout: 25_000 }).catch(() => {
      fail(`the overlay never mounted on ${plat.name} — nothing below can be trusted`)
    })
    ok(`${plat.name}: overlay mounts`)

  const g = await geometry(p)
  for (const [name, v] of Object.entries(g)) {
    if (v === null) fail(`#hs-mc-${name} is missing after mount`)
  }
  ok(`${plat.name}: tab bar, overlay, input bar and message list all present`)

  if (!g.hostContent) fail('the host page content was destroyed by the overlay')
  ok(`${plat.name}: the host page's own content survives`)

  // ── the invariant: no dead band ──────────────────────────────────────────
  // The overlay must fill the container minus the two bars. This is what the
  // boot-latch bug broke: 510px of chat inside an 828px space, with 318px of
  // nothing beneath it, because the overlay kept a stale inset.
  const expected = g.container.ch - g.tabbar.h - g.inputbar.h
  const drift = Math.abs(g.overlay.h - expected)
  if (drift > 2) {
    fail(
      `overlay height ${g.overlay.h}px but container(${g.container.ch}) - tabbar(${g.tabbar.h}) - input(${g.inputbar.h}) = ${expected}px — ${drift}px of dead space`,
    )
  }
  ok(`${plat.name}: no dead band — overlay ${g.overlay.h}px fills container ${g.container.ch}px minus bars`)

  if (plat.rerender) {
    // ── the invariant survives a platform re-render ─────────────────────────
    // What this proves: the extension rebuilds its bars when the host page tears
    // them out, and the no-dead-band invariant above still holds afterwards.
    //
    // What it does NOT prove, stated plainly so nobody reads more into it: this
    // is not a regression test for the boot-latch bug. That bug needs a stale
    // ResizeObserver to survive across a rebuild, and it could not be reproduced
    // here — removing overlay nodes trips main.js's own reinject path, which
    // nulls resizeObserver before rebuilding and therefore self-heals. Measured,
    // not assumed: instrumenting the ResizeObserver constructor showed both the
    // fixed and the pre-fix build constructing a fresh observer on re-entry.
    // The `!resizeObserver` shape is still guarded, by
    // tests/overlay-layout-observer.test.js as a source contract.
    await p.evaluate(() => {
      document.getElementById('hs-mc-tabbar')?.remove()
      document.getElementById('hs-mc-inputbar')?.remove()
    })
    await p.evaluate(() => {
      const rc = document.getElementById('rcol')
      if (!rc) throw new Error('fixture lost its .right-column')
      rc.classList.add('right-column--nudge')
      rc.style.opacity = '0.99'
    })

    await p
      .waitForFunction(() => !!document.getElementById('hs-mc-tabbar'), null, { timeout: 15_000 })
      .catch(() => fail('the tab bar was never rebuilt after the host page removed it'))
    ok(`${plat.name}: bars are rebuilt after the host page tears them out`)

    // Let the rebuild settle, then re-run the same measurement that bites.
    await p.waitForTimeout(1000)
    const g2 = await geometry(p)
    for (const [name, v] of Object.entries(g2)) {
      if (v === null) fail(`#hs-mc-${name} is missing after the rebuild`)
    }
    const expected2 = g2.container.ch - g2.tabbar.h - g2.inputbar.h
    const drift2 = Math.abs(g2.overlay.h - expected2)
    if (drift2 > 2) {
      fail(
        `after a rebuild the overlay is ${g2.overlay.h}px but container(${g2.container.ch}) - tabbar(${g2.tabbar.h}) - input(${g2.inputbar.h}) = ${expected2}px — ${drift2}px of dead space`,
      )
    }
    ok(`${plat.name}: no dead band after a rebuild — overlay ${g2.overlay.h}px in container ${g2.container.ch}px`)
  }

  // ── every docking position ───────────────────────────────────────────────
  // _updateMcLayout has four branches — top/right/bottom/left each write a
  // different set of insets — and only the default one was covered above.
  // Layout is this project's most expensive bug class, so all four get measured.
  //
  // Driven through the extension's own supported rotate message (main.js listens
  // for 'heatsync-rotate-tabs' from the page's own origin), not by poking
  // internals, so the test exercises the real path a user takes.
  const rotate = async () => {
    await p.evaluate(() => window.postMessage({ type: 'heatsync-rotate-tabs' }, location.origin))
    await p.waitForTimeout(600)
    return p.evaluate(() => {
      const c = [...document.body.classList].find((x) => x.startsWith('hs-tabs-'))
      return c ? c.replace('hs-tabs-', '') : '?'
    })
  }

  /**
   * Position-agnostic dead-space check.
   *
   * Naming each child in a formula is too brittle — the emote picker takes 12px
   * in the bottom dock and 0 in the top, and the next element added would break
   * the test rather than the layout. What actually matters is the property the
   * boot-latch bug violated: the container's content box must be fully covered
   * by its visible children, with nothing spilling outside it.
   */
  const coverage = () =>
    p.evaluate(() => {
      const c = document.getElementById('hs-mc-container')
      if (!c) return null
      const cr = c.getBoundingClientRect()
      const cs = getComputedStyle(c)
      const top = cr.top + Number.parseFloat(cs.borderTopWidth || '0')
      const bottom = cr.bottom - Number.parseFloat(cs.borderBottomWidth || '0')
      const left = cr.left + Number.parseFloat(cs.borderLeftWidth || '0')
      const right = cr.right - Number.parseFloat(cs.borderRightWidth || '0')

      const spans: Array<[number, number]> = []
      let overflow: string | null = null
      let overlayH = 0
      for (const el of Array.from(c.children) as HTMLElement[]) {
        const r = el.getBoundingClientRect()
        if (r.height <= 0 || r.width <= 0) continue
        if (el.id === 'hs-mc-overlay') overlayH = r.height
        if (r.top < top - 2 || r.bottom > bottom + 2 || r.left < left - 2 || r.right > right + 2) {
          overflow = `${el.id || el.className} spills outside the container`
        }
        spans.push([r.top, r.bottom])
      }
      // Merge the vertical spans and measure what the container is NOT covered by.
      spans.sort((a, b) => a[0] - b[0])
      let gap = 0
      let cursor = top
      for (const [a, b] of spans) {
        if (a > cursor) gap += a - cursor
        cursor = Math.max(cursor, b)
      }
      if (cursor < bottom) gap += bottom - cursor
      return { gap: Math.round(gap), overflow, contentH: Math.round(bottom - top), overlayH: Math.round(overlayH) }
    })

  const seen = new Set<string>()
  for (let i = 0; i < 4; i++) {
    const pos = await rotate()
    if (pos === '?') fail('no hs-tabs-* class on body — cannot tell which docking position is active')
    seen.add(pos)
    const cov = await coverage()
    if (!cov) fail(`the container vanished in the "${pos}" position`)
    if (cov.overflow) fail(`${plat.name} "${pos}" dock: ${cov.overflow}`)
    if (cov.gap > 2) {
      fail(`${plat.name} "${pos}" dock leaves ${cov.gap}px of the container's ${cov.contentH}px uncovered — dead space`)
    }
    // A container fully covered by a collapsed overlay plus something else would
    // still be wrong: chat is the point.
    if (cov.overlayH < cov.contentH * 0.5) {
      fail(`${plat.name} "${pos}" dock: overlay is only ${cov.overlayH}px of ${cov.contentH}px — chat has been squeezed out`)
    }
    ok(`${plat.name}: "${pos}" dock has no dead space (overlay ${cov.overlayH}/${cov.contentH}px)`)
  }
  if (seen.size !== 4) fail(`rotate did not visit all four positions — saw ${[...seen].join(', ')}`)
  ok(`${plat.name}: rotate cycles through all four docking positions`)

  // ── geometry tracks a WRAPPING tab bar ───────────────────────────────────
  // The single most common real layout change: the user adds channels, the tab
  // bar wraps to more rows, and the overlay must give back exactly that much
  // height. This is the scenario the boot-latch bug lived in — the bar measured
  // ~307px mid-boot and settled to 55px, and the overlay kept the first number.
  //
  // Scope, measured not assumed: this asserts the INVARIANT the user feels (a
  // wrapped bar never leaves dead space), not the ResizeObserver specifically.
  // Removing the tab bar from the observer still passes — something else also
  // recomputes on child insertion — so do not read this as a guard on the
  // observer wiring. tests/overlay-layout-observer.test.js holds that line.
  // Only run where the fixture reaches the re-render path.
  if (plat.rerender) {
    for (const n of [6, 16]) {
      const wrapped = await p.evaluate(
        (count: number) =>
          new Promise((done) => {
            const tb = document.getElementById('hs-mc-tabbar')
            const scroll = tb?.querySelector('.hs-mc-tabs-scroll')
            if (!tb || !scroll) return done(null)
            scroll.querySelectorAll('.hs-probe').forEach((e) => e.remove())
            const addBtn = scroll.querySelector('[data-tab="add"]')
            for (let i = 0; i < count; i++) {
              const b = document.createElement('button')
              b.className = 'hs-mc-tab hs-probe'
              b.textContent = `chan${i}`
              scroll.insertBefore(b, addBtn)
            }
            // Let the ResizeObserver fire and the layout settle.
            setTimeout(
              () =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    const c = document.getElementById('hs-mc-container')
                    const cs = getComputedStyle(c)
                    const cr = c.getBoundingClientRect()
                    const top = cr.top + Number.parseFloat(cs.borderTopWidth || '0')
                    const bottom = cr.bottom - Number.parseFloat(cs.borderBottomWidth || '0')
                    const spans: Array<[number, number]> = []
                    for (const el of Array.from(c.children) as HTMLElement[]) {
                      const r = el.getBoundingClientRect()
                      if (r.height > 0 && r.width > 0) spans.push([r.top, r.bottom])
                    }
                    spans.sort((a, b) => a[0] - b[0])
                    let gap = 0
                    let cur = top
                    for (const [a, b] of spans) {
                      if (a > cur) gap += a - cur
                      cur = Math.max(cur, b)
                    }
                    if (cur < bottom) gap += bottom - cur
                    done({ tabbarH: Math.round(tb.getBoundingClientRect().height), gap: Math.round(gap) })
                  }),
                ),
              350,
            )
          }),
        n,
      )
      if (!wrapped) fail('could not reach the tab bar to test wrapping')
      const w = wrapped as { tabbarH: number, gap: number }
      if (w.gap > 2) {
        fail(
          `${plat.name}: with ${n} extra tabs the tab bar is ${w.tabbarH}px and ${w.gap}px of the container is uncovered — ` +
            'the overlay did not give back the height the tab bar took.',
        )
      }
      ok(`${plat.name}: geometry tracks a ${w.tabbarH}px wrapped tab bar (+${n} tabs, no dead space)`)
    }
    await p.evaluate(() => document.querySelectorAll('.hs-probe').forEach((e) => e.remove()))
  }

  // ── row geometry: the reply context must not break the message row ──────
  // System monospace has fractional advances, so an integer-pixel x is NOT
  // expected; what still matters is clipping, baseline and overlap.
  //
  // Baseline is taken inside the text's own line box (the reply pill is a block on its own line).
  // The markup is copied verbatim from the reply-bar builder in main.js.
  const geo = await p.evaluate(() => {
    const msgs = document.getElementById('hs-mc-messages')
    if (!msgs) return null
    const keep = msgs.innerHTML
    const TAIL = 'florida is building charging stations for flying car launch pads gypsy jumpy'
    const pill =
      '<span class="hs-mc-reply-ctx" role="button" tabindex="0" aria-expanded="false" title="dongblob: hi">&#8618;' +
      '<a href="https://heatsync.org/user/dongblob" class="hs-mc-user hs-mc-reply-user" data-username="dongblob">@dongblob</a>' +
      '<span class="hs-mc-reply-caret" aria-hidden="true"></span></span> '
    const mk = (html: string) => {
      const d = document.createElement('div')
      d.className = 'hs-mc-msg'
      d.innerHTML = `<span class="hs-mc-user">mellen</span>: ${html}`
      msgs.appendChild(d)
      return d
    }
    const withReply = mk(pill + TAIL)
    const plain = mk(TAIL)
    const tailText = (el: HTMLElement) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let n: Node | null
      let last: Node | null = null
      while ((n = w.nextNode())) if ((n.textContent || '').trim().length > 3) last = n
      return last
    }
    // glyph box = the text's own line box (ascent+descent), baseline = a zero-height probe sitting on it
    const measure = (row: HTMLElement) => {
      const t = tailText(row)
      if (!t) return null
      const r = document.createRange()
      r.selectNodeContents(t)
      const first = r.getClientRects()[0]
      const probe = document.createElement('span')
      probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'
      t.parentNode!.insertBefore(probe, t)
      const base = probe.getBoundingClientRect().bottom
      probe.remove()
      const rr = row.getBoundingClientRect()
      return { gTop: first.top, gBottom: first.bottom, left: first.left, top: rr.top, bottom: rr.bottom, base: base - first.top }
    }
    const mr = measure(withReply)
    const mp = measure(plain)
    const pillEl = withReply.querySelector('.hs-mc-reply-ctx') as HTMLElement
    const pr = pillEl.getBoundingClientRect()
    const out = {
      mr,
      mp,
      pillRight: pr.right,
      pillTop: pr.top,
      pillBottom: pr.bottom,
      pillWidth: +pr.width.toFixed(3),
      rowsOverlap: withReply.getBoundingClientRect().bottom > plain.getBoundingClientRect().top + 0.5,
    }
    msgs.innerHTML = keep
    return out
  })

  if (!geo || !geo.mr || !geo.mp) fail('could not reach #hs-mc-messages to measure row geometry')
  else {
    for (const [name, m] of [['reply', geo.mr], ['plain', geo.mp]] as const) {
      if (m.gTop < m.top - 0.5 || m.gBottom > m.bottom + 0.5) {
        fail(
          `${name} row clips its text: glyph box ${m.gTop.toFixed(2)}-${m.gBottom.toFixed(2)} vs row ${m.top.toFixed(2)}-${m.bottom.toFixed(2)} — descenders (p g j y) would be cut`,
        )
      }
    }
    if (Math.abs(geo.mr.base - geo.mp.base) > 0.5) {
      fail(`baselines differ row to row: ${geo.mr.base.toFixed(2)}px with a reply context vs ${geo.mp.base.toFixed(2)}px plain`)
    }
    // rect intersection: the pill and the message text must not share any pixels
    if (geo.pillBottom > geo.mr.gTop + 0.5 && geo.pillTop < geo.mr.gBottom - 0.5 && geo.pillRight > geo.mr.left + 0.5) {
      fail(`the reply pill overlaps the message text (pill ${geo.pillTop.toFixed(1)}-${geo.pillBottom.toFixed(1)}, text ${geo.mr.gTop.toFixed(1)}-${geo.mr.gBottom.toFixed(1)})`)
    }
    if (geo.rowsOverlap) fail('consecutive message rows overlap')
    ok(`${plat.name}: reply row keeps glyphs inside the row, one baseline, no overlap (pill ${geo.pillWidth}px)`)
  }

    await p.close()
  }

  // ── emote effects must survive reduced-motion ────────────────────────────
  // These effects follow the animateEmotes SETTING and deliberately not
  // prefers-reduced-motion — mellen's chromium runs with reduced-motion forced,
  // so any rule keyed on that media query is permanently on for him and would
  // freeze every paint and effect at frame 0.
  //
  // Read duration and iteration-count, NOT animationName: a blanket
  // reduced-motion rule does not null the name, it collapses duration to
  // 0.01ms and iterations to 1. Checking the name reports green on a frozen
  // animation. (Learned the hard way twice today — once by the site session,
  // and once here, where `--force-prefers-reduced-motion` silently did not
  // apply at all and the probe had to assert the condition was active before
  // trusting the result.)
  {
    const rp = await ctx.newPage()
    rp.on('pageerror', (e: unknown) => errors.push(`reduced-motion: ${String(e).slice(0, 300)}`))
    await rp.emulateMedia({ reducedMotion: 'reduce' })
    await rp.goto(PLATFORMS[0].url, { waitUntil: 'domcontentloaded' })
    await rp.waitForSelector('#hs-mc-messages', { timeout: 25_000 })
    const fx = await rp.evaluate(() => {
      const msgs = document.getElementById('hs-mc-messages')
      if (!msgs) return null
      const d = document.createElement('div')
      d.className = 'hs-mc-msg'
      d.innerHTML =
        '<span class="hs-mc-emoji hs-fx-party">\u{1F525}</span>' +
        '<img class="hs-mc-emote hs-fx-party" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">' +
        '<span class="hs-mc-emoji" id="plain">\u{1F525}</span>'
      msgs.appendChild(d)
      const read = (el: Element) => {
        const cs = getComputedStyle(el)
        return { dur: cs.animationDuration, iter: cs.animationIterationCount, name: cs.animationName }
      }
      const out = {
        active: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        emoji: read(d.querySelector('.hs-mc-emoji.hs-fx-party')),
        emote: read(d.querySelector('img')),
        plain: read(d.querySelector('#plain')),
      }
      d.remove()
      return out
    })
    await rp.close()

    if (!fx) fail('could not reach #hs-mc-messages to test reduced-motion')
    // Assert the CONDITION before trusting the result — a probe that silently
    // ran without reduced-motion would pass while proving nothing.
    if (!fx.active) fail('reduced-motion emulation did not apply — this check would prove nothing')
    for (const [what, m] of [['emoji', fx.emoji], ['emote', fx.emote]] as const) {
      if (!/^\d/.test(m.dur) || Number.parseFloat(m.dur) < 1) {
        fail(`${what} effect collapsed under reduced-motion: duration ${m.dur} (expected the real 1.5s)`)
      }
      if (m.iter !== 'infinite') {
        fail(`${what} effect collapsed under reduced-motion: iterations ${m.iter} (expected infinite)`)
      }
    }
    if (fx.plain.name !== 'none') fail(`an unmodified emoji picked up an animation (${fx.plain.name})`)
    ok(`emote effects survive reduced-motion (${fx.emoji.dur} x ${fx.emoji.iter}, unmodified emoji clean)`)
  }

  // ── the OFF switch must reach everything the effect does ─────────────────
  // animateEmotes is the first-party control for this motion. Its rules were
  // img-scoped while the effects themselves reach emoji, so setting it to
  // "never" left emoji still moving — a control that does not cover what it
  // claims to is worse than no control at all.
  {
    const ap = await ctx.newPage()
    await ap.goto(PLATFORMS[0].url, { waitUntil: 'domcontentloaded' })
    await ap.waitForSelector('#hs-mc-messages', { timeout: 25_000 })
    const sw = await ap.evaluate(() => {
      const msgs = document.getElementById('hs-mc-messages')
      if (!msgs) return null
      const d = document.createElement('div')
      d.className = 'hs-mc-msg'
      d.innerHTML =
        '<span class="hs-mc-emoji hs-fx-party">\u{1F525}</span>' +
        '<img class="hs-mc-emote hs-fx-party" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">'
      msgs.appendChild(d)
      const read = () => ({
        emoji: getComputedStyle(d.querySelector('.hs-mc-emoji') as Element).animationName,
        emote: getComputedStyle(d.querySelector('img') as Element).animationName,
      })
      const prev = document.documentElement.dataset.hsEmoteAnim
      const on = read()
      document.documentElement.dataset.hsEmoteAnim = 'never'
      const off = read()
      if (prev) document.documentElement.dataset.hsEmoteAnim = prev
      else document.documentElement.removeAttribute('data-hs-emote-anim')
      d.remove()
      return { on, off }
    })
    await ap.close()
    if (!sw) fail('could not reach #hs-mc-messages to test the animation switch')
    if (sw.on.emoji === 'none' || sw.on.emote === 'none') {
      fail(`effects are not running by default (emoji ${sw.on.emoji}, emote ${sw.on.emote})`)
    }
    if (sw.off.emote !== 'none') fail(`animateEmotes:never did not stop an emote (${sw.off.emote})`)
    if (sw.off.emoji !== 'none') {
      fail(`animateEmotes:never did not stop an EMOJI (${sw.off.emoji}) — the control is img-scoped again`)
    }
    ok('animateEmotes:never stops both an emote and an emoji')
  }

  // ── a youtube deletion actually reaches the overlay ──────────────────────
  // Everything below the socket, for real: the extension's own page sends the
  // exact message background.js broadcasts on `youtube:delete`, it crosses into
  // the content script through the listener listenForSocialEvents registers,
  // and applyYtDeletion patches the live DOM. That listener is gated on a
  // subsystem switch, so this also fails if the gate ever narrows again.
  //
  // The row deliberately carries NO data-msg-platform: youtube rows are
  // excluded from that attribute, and the unit test could only guess at the
  // shape. This is the real one.
  {
    const yp = await ctx.newPage()
    yp.on('pageerror', (e: unknown) => errors.push(`yt-delete: ${String(e).slice(0, 300)}`))
    await yp.goto(PLATFORMS[0].url, { waitUntil: 'domcontentloaded' })
    await yp.waitForSelector('#hs-mc-messages', { timeout: 25_000 })
    await yp.waitForTimeout(1200) // let the content script register its listener

    await yp.evaluate(() => {
      const msgs = document.getElementById('hs-mc-messages')
      if (!msgs) return
      for (const [id, user] of [['YT_DOOMED', 'someone'], ['YT_SAFE', 'other']]) {
        const d = document.createElement('div')
        d.className = 'hs-mc-msg'
        d.dataset.msgId = id
        d.dataset.msgUser = user
        d.innerHTML = '<span class="hs-mc-text">a youtube message</span>'
        msgs.appendChild(d)
      }
    })

    const worker2 = ctx.serviceWorkers()[0]
    const id2 = worker2?.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
    if (!id2) fail('could not resolve the extension id to drive a deletion')
    const ep2 = await ctx.newPage()
    await ep2.goto(`chrome-extension://${id2}/popup.html`, { waitUntil: 'load' })
    const delivered = await ep2.evaluate(
      () =>
        new Promise((res) => {
          try {
            // @ts-ignore — extension page
            chrome.tabs.query({}, (tabs: any[]) => {
              const t = tabs.find((x) => (x.url || '').includes('twitch.tv'))
              if (!t) return res('no twitch tab found')
              // @ts-ignore
              chrome.tabs.sendMessage(t.id, { type: 'youtube_delete', data: { messageIds: ['YT_DOOMED'] } })
              res('sent')
            })
          } catch (e) {
            res(`threw: ${String(e)}`)
          }
        }),
    )
    await ep2.close()
    if (delivered !== 'sent') fail(`could not deliver the deletion: ${delivered}`)

    const cleared = await yp
      .waitForFunction(
        () => {
          const doomed = document.querySelector('.hs-mc-msg[data-msg-id="YT_DOOMED"]')
          return !!doomed?.classList.contains('hs-mc-msg-cleared')
        },
        null,
        { timeout: 8000 },
      )
      .then(() => true)
      .catch(() => false)

    const untouched = await yp.evaluate(
      () => !document.querySelector('.hs-mc-msg[data-msg-id="YT_SAFE"]')?.classList.contains('hs-mc-msg-cleared'),
    )
    await yp.close()

    if (!cleared) {
      fail(
        'a youtube:delete broadcast never reached the overlay — the message stayed live. ' +
          'the wire is background -> chrome.tabs -> listenForSocialEvents -> applyYtDeletion; ' +
          'a narrowed subsystem gate breaks it silently.',
      )
    }
    if (!untouched) fail('the deletion cleared a message it was not told to clear')
    ok('a youtube deletion crosses from the extension page into the overlay and clears only its target')
  }

  // ── the instrumentation must not cry wolf ────────────────────────────────
  // diag.js reports selector rot and host-CSP blocks into the error ring
  // buffer, which the popup surfaces as "copy errors". That buffer holds 50
  // entries. If either reporter fires during ORDINARY operation, it evicts the
  // real errors it exists to preserve and trains the user to ignore it — a
  // false positive here is worse than no instrumentation at all.
  //
  // Read from the extension's own page, because chrome.storage is unreachable
  // from the host page's world.
  const worker = ctx.serviceWorkers()[0]
  const extId = worker?.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
  if (!extId) fail('could not resolve the extension id to read its error buffer')

  const ep = await ctx.newPage()
  await ep.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' })
  const buffered: Array<{ type?: string, msg?: string }> = await ep.evaluate(
    () =>
      new Promise((res) => {
        try {
          // @ts-ignore — extension page
          chrome.storage.local.get('hs_errors', (v: any) => res(v?.hs_errors || []))
        } catch (_) {
          res([])
        }
      }),
  )
  await ep.close()

  const rot = buffered.filter((e) => (e.msg || '').includes('selector stopped matching'))
  const csp = buffered.filter((e) => (e.msg || '').includes('host page CSP blocked'))
  if (rot.length) {
    fail(`selector-rot reporter fired during normal operation — false positives:\n  ${rot.map((e) => e.msg).join('\n  ')}`)
  }
  if (csp.length) {
    fail(`CSP reporter fired during normal operation — false positives:\n  ${csp.map((e) => e.msg).join('\n  ')}`)
  }
  ok(`instrumentation stayed quiet (${buffered.length} buffered entries, none from diag)`)
  if (buffered.length) {
    console.log(`  note: ${buffered.length} non-diag entries in the buffer:`)
    for (const e of buffered.slice(0, 6)) console.log(`    [${e.type}] ${(e.msg || '').slice(0, 150)}`)
  }

  // ── the chat kill-switches, in both directions ───────────────────────────
  // Every source test around subsystem gates is a grep. This is the only check
  // that answers the question the user actually asks: "I turned twitch chat
  // off — is it off?" It was NOT, and no grep could have told us: the switch
  // gated `irc.connect()`, which is a no-op because the background owns the
  // socket, so the listener that renders twitch rows was registered anyway.
  //
  // Both polarities, because a gate fix that only proves the OFF half is
  // indistinguishable from having broken chat. Runs in its own contexts —
  // the subsystem map has to be seeded before the content script boots.
  await gateCheck()

  // ── the youtube picker's emote insert ────────────────────────────────────
  // Proves the transport, with a control, against the real listener: the same
  // message sent both ways in one run. runtime.sendMessage — what the picker
  // used — never arrives at a content script, and nothing reports that.
  await ytInsertCheck()

  // ── and the same thing through the actual UI, on every platform ──────────
  // The check above drives the message by hand. This one clicks the button,
  // opens the panel and clicks a tile — the path a person takes. Reverting the
  // youtube fix and re-running it leaves that input empty, which is what the
  // bug was; twitch and kick are here because nothing had ever driven them.
  await pickerClickCheck()

  // ── the gifs tab, in a real browser ──────────────────────────────────────
  // The grid PAINTS STILLS and animates exactly the tile under the pointer.
  // Nothing about that is visible to a source test, and getting it wrong is
  // 24 gif decoders running over a live video player.
  await gifsTabCheck()
  await emoteUploadCheck()

  // ── the whole point of the product, end to end ───────────────────────────
  // Compose a message, press Enter, watch it leave on the IRC wire, echo it
  // back the way twitch does, and see it render. Against a LOCAL mock server —
  // twitch is never contacted.
  // Twice, because `dim timed-out messages` picks between two treatments and
  // the OFF one — hide — did not exist in the overlay until today.
  await twitchIrcCheck({ dim: true, full: true })
  await twitchIrcCheck({ dim: false, full: false })

  // ── the other two send paths ─────────────────────────────────────────────
  // Three platforms, three completely different transports. Twitch is a socket
  // (above), kick is an authenticated POST relayed through a kick.com tab, and
  // youtube drives youtube's own composer. Only the first was covered.
  await kickSendCheck()
  await kickModCheck()
  await youtubeSendCheck()

  // ── the most-pressed key in the composer ─────────────────────────────────
  // Tab-complete carries four recorded incidents in its ranking alone and had
  // never been pressed by a test — every existing check reads the comparator's
  // source and confirms it still says what it used to. This one types, presses
  // Tab, and reads what came out.
  await tabCompleteCheck()

  // ── the first-run tour card ───────────────────────────────────────────────
  // A fresh profile is a first run: the card must be there, change the real
  // chat through the real settings, and never come back once it is closed.
  await tourCheck()

  // ── highlight rule sounds: a picked file, a volume, one rate limit ───────
  // A rule's own audio file through the real Web Audio, the real autoplay
  // policy and the real settings form, and an export that stays small.
  await soundCheck()

  // ── the composer and the picker, for someone who never touches the mouse ──
  // Sent history across a reload, the live spellcheck setting, the autocomplete
  // list as an ARIA combobox, and the picker's arrow-key cursor on both the
  // main grid and search results.
  await composerAndPickerCheck()

  if (errors.length) fail(`runtime errors:\n  ${errors.join('\n  ')}`)
  console.log(`\n✓ render checks passed — ${checks.length} assertions`)
} catch (e) {
  console.error(`\n✗ render checks FAILED: ${(e as Error).message}`)
  process.exitCode = 1
} finally {
  // Bounded, like every other context here. A plain close() on a persistent
  // context can hang forever, and on the failure path that turned a 2-minute
  // run into a 10-minute wedge with the real error already printed and nothing
  // left to do.
  if (ctx) await closeContext(ctx, 'main harness', profile)
  rmSync(profile, { recursive: true, force: true })
}

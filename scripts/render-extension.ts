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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertBuilt, launchWithExtension } from './lib/chromium'

/**
 * Fixtures, one per platform.
 *
 * Each URL is chosen so main.js takes a BODY-MOUNT path and no React tree has
 * to be faked:
 *  - twitch: a non-channel url (no `.channel-root`).
 *  - kick:   a RESERVED path (`/browse`), which main.js treats as non-channel.
 *  - youtube: any url — the yt panel body-mounts on every page by design.
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
    url: 'https://kick.com/browse',
    glob: 'https://kick.com/**',
    body: '<div id="host-content" style="height:100vh">host page</div>',
    rerender: false,
  },
  {
    name: 'youtube',
    url: 'https://www.youtube.com/feed/subscriptions',
    glob: 'https://www.youtube.com/**',
    body: '<div id="host-content" style="height:100vh">host page</div>',
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
    await p.waitForSelector('#hs-mc-messages', { timeout: 25_000 })
    await p.waitForTimeout(4500)

    const seen: string[] = await sw.evaluate(() => (globalThis as any).__gateSeen)
    const wire = [...new Set(seen.filter((t) => /^(bg_irc_join|bg_kick_history|youtube_ws_subscribe)$/.test(t)))].sort()

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
    return { wire, twitch: hit('GATEPROBE_TWITCH'), kick: hit('GATEPROBE_KICK'), yt: hit('GATEPROBE_YT') }
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
 * A local wss server that speaks just enough IRC for the extension's twitch
 * transport: the handshake, the join, and — the part that matters — echoing
 * your own PRIVMSG back the way twitch does, which is what actually puts a
 * sent message on screen.
 *
 * Shared by every check that needs a live twitch chat. It is the one piece of
 * this harness that makes the whole twitch loop testable with no network at
 * all: irc-ws.chat.twitch.tv is pointed at 127.0.0.1 with
 * --host-resolver-rules, so twitch is never contacted.
 *
 * Returns null when openssl is missing — there is no cert to serve TLS with,
 * and the caller has to say out loud what is going unverified rather than
 * quietly passing.
 */
function startMockIrc(): {
  port: number
  frames: string[]
  push: (raw: string) => void
  stop: () => void
} | null {
  const certDir = mkdtempSync(join(tmpdir(), 'hs-ext-irc-cert-'))
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'),
       '-days', '1', '-nodes', '-subj', '/CN=irc-ws.chat.twitch.tv'],
      { stdio: 'ignore' },
    )
  } catch (_) {
    rmSync(certDir, { recursive: true, force: true })
    return null
  }

  const frames: string[] = []
  const sockets = new Set<any>()
  const server = Bun.serve({
    port: 0,
    tls: { key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) },
    fetch(req: Request, srv: any) {
      if (srv.upgrade(req)) return undefined as any
      return new Response('no', { status: 400 })
    },
    websocket: {
      open(ws: any) {
        sockets.add(ws)
      },
      close(ws: any) {
        sockets.delete(ws)
      },
      message(ws: any, msg: any) {
        for (const line of String(msg).split('\r\n')) {
          if (!line) continue
          frames.push(line)
          if (line.startsWith('NICK')) {
            ws.send(`:tmi.twitch.tv 001 ${line.slice(5).trim() || 'probeuser'} :Welcome, GLOBALUSERSTATE\r\n`)
          } else if (line.startsWith('JOIN')) {
            ws.send(`:probeuser!p@p.tmi.twitch.tv JOIN ${line.slice(5).trim()}\r\n`)
          } else if (line.startsWith('PRIVMSG')) {
            // Twitch echoes your own PRIVMSG back; that echo is what renders it.
            const m = line.match(/^PRIVMSG (#\S+) :(.*)$/)
            if (m) {
              const echo =
                `@display-name=probeuser;color=#FF8700;user-id=1;id=echo-1 ` +
                `:probeuser!p@p.tmi.twitch.tv PRIVMSG ${m[1]} :${m[2]}\r\n`
              for (const c of sockets) {
                try {
                  c.send(echo)
                } catch (_) {}
              }
            }
          }
        }
      },
    },
  })

  return {
    port: server.port,
    frames,
    push(raw: string) {
      for (const c of sockets) {
        try {
          c.send(raw)
        } catch (_) {}
      }
    },
    stop() {
      server.stop(true)
      rmSync(certDir, { recursive: true, force: true })
    },
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

    await p.click('#hs-mc-input')
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

async function gateCheck() {
  console.log('\n── subsystem kill-switches ──')

  // ON first: if this fails the OFF result below means nothing.
  const on = await gatePolarity({ 'irc-twitch': true, 'chat-kick': true, 'chat-youtube': true })
  for (const [k, label] of [['twitch', 'twitch'], ['kick', 'kick'], ['yt', 'youtube']] as const) {
    if (!(on as any)[k]) {
      fail(
        `with every chat subsystem ON, a ${label} message never rendered — this check cannot ` +
          'distinguish a working kill-switch from broken chat, so it is reporting the latter',
      )
    }
  }
  ok(`switches ON: twitch, kick and youtube all render (wire: ${on.wire.join(', ') || 'none'})`)

  const off = await gatePolarity({ 'irc-twitch': false, 'chat-kick': false, 'chat-youtube': false })
  if (off.wire.length) {
    fail(
      `with every chat subsystem OFF the overlay still asked the background for: ${off.wire.join(', ')} — ` +
        'the switch stops the render but not the work',
    )
  }
  ok('switches OFF: the overlay asks the background for nothing')

  const leaked = (['twitch', 'kick', 'yt'] as const).filter((k) => (off as any)[k])
  if (leaked.length) {
    fail(
      `with every chat subsystem OFF these still rendered: ${leaked.join(', ')} — ` +
        'a kill-switch that does not kill is worse than no switch',
    )
  }
  ok('switches OFF: nothing renders on any of the three platforms')
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
    await ctx.route(plat.glob, (r: any) =>
      r.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml(plat.body) }),
    )
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

  // ── bitmap crispness: the reply context must not smear the message ───────
  // CozetteVector is a 6x13 bitmap cell. It is crisp only when a glyph starts
  // on a whole pixel, so anything inline BEFORE the message text leaks its
  // advance into every glyph after it. The reply pill is an inline-block, so a
  // fractional child made the pill fractional and put the entire message on a
  // sub-pixel x — measured 0.625 with a reply, 0 without. That is invisible to
  // every other kind of test in this repo: the DOM is correct, the CSS is
  // correct, and the only symptom is that the letters look soft.
  //
  // The markup is copied verbatim from the reply-bar builder in main.js, and
  // the assertion below pins that it has not drifted from the renderer.
  const smear = await p.evaluate(() => {
    const msgs = document.getElementById('hs-mc-messages')
    if (!msgs) return null
    const keep = msgs.innerHTML
    const TAIL = 'florida is building charging stations for flying car launch pads'
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
    const tailFrac = (el: HTMLElement) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let n: Node | null
      let last: Node | null = null
      while ((n = w.nextNode())) if ((n.textContent || '').trim().length > 3) last = n
      if (!last) return null
      const r = document.createRange()
      r.setStart(last, 0)
      r.setEnd(last, 1)
      return +(r.getBoundingClientRect().x % 1).toFixed(3)
    }
    const caret = withReply.querySelector('.hs-mc-reply-caret') as HTMLElement
    const pillEl = withReply.querySelector('.hs-mc-reply-ctx') as HTMLElement
    const out = {
      withReply: tailFrac(withReply),
      plain: tailFrac(plain),
      pillWidth: +pillEl.getBoundingClientRect().width.toFixed(3),
      caretWidth: +caret.getBoundingClientRect().width.toFixed(3),
      caretPx: getComputedStyle(caret).fontSize,
      pillPx: getComputedStyle(pillEl).fontSize,
    }
    msgs.innerHTML = keep
    return out
  })

  if (!smear) fail('could not reach #hs-mc-messages to measure bitmap crispness')
  if (smear.plain !== 0) {
    fail(`plain message text is already off the pixel grid (x-fraction ${smear.plain}) — the baseline is broken`)
  }
  if (smear.withReply !== 0) {
    fail(
      `a reply context smears the message: text starts at x-fraction ${smear.withReply} (plain text is ${smear.plain}). ` +
        `Reply pill is ${smear.pillWidth}px, caret ${smear.caretWidth}px at ${smear.caretPx}. ` +
        'CozetteVector is a bitmap face — a fractional advance before the text makes every glyph after it soft.',
    )
  }
  if (smear.caretWidth % 1 !== 0) {
    fail(`the reply caret has a fractional advance (${smear.caretWidth}px at ${smear.caretPx}) — it will smear whatever follows it`)
  }
  ok(`${plat.name}: reply context keeps the message on the pixel grid (pill ${smear.pillWidth}px, caret ${smear.caretWidth}px)`)

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
  await youtubeSendCheck()

  // ── the most-pressed key in the composer ─────────────────────────────────
  // Tab-complete carries four recorded incidents in its ranking alone and had
  // never been pressed by a test — every existing check reads the comparator's
  // source and confirms it still says what it used to. This one types, presses
  // Tab, and reads what came out.
  await tabCompleteCheck()

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

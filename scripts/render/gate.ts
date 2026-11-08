import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from '../lib/chromium'
import { PLATFORMS, closeContext, errors, fail, fixtureHtml, ok } from './lib'

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

export async function gateCheck() {
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

/**
 * s9 — the s2 navigation chains in real Firefox, the built MV2 add-on (dist/firefox, or
 * E2E_FF_EXT) through geckodriver. Firefox injects into the page differently (no MAIN-world
 * content scripts, Xray wrappers, its own timers in background tabs), so a chain that holds in
 * chromium can still break here, and nothing else drove kick or youtube in firefox.
 *
 *   bun run build.js firefox --no-test && bun scripts/e2e/run.ts --only s9
 *
 * Invariants after every hop, as in s2: a live channel shows its chat flowing and the live tab
 * names it; kick's browse reads as no channel with the panel usable; an offline kick channel
 * reads offline; a youtube vod or home shows no chat from the stream before it; the overlay's
 * watchdogs stay quiet. Needs firefox + geckodriver.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { launchFirefox } from '../lib/firefox'
import {
  bad,
  info,
  liveChannels,
  liveYtVideo,
  ok,
  panel,
  ROOT,
  ringSince,
  rowsFlow,
  scenario,
  sleep,
  YT_VOD,
} from './lib'

const FF_EXT = process.env.E2E_FF_EXT || join(ROOT, 'dist', 'firefox')
type FF = Awaited<ReturnType<typeof launchFirefox>>
type Page = ReturnType<FF['asPage']>

async function waitPanel(ff: FF, ms = 30_000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(1000))
    if (await ff.page<boolean>(`return !!document.getElementById('hs-mc-container')`).catch(() => false)) return true
  return false
}

/** A fresh load: panel mounted, the tab the shown one, chat flowing. */
async function land(ff: FF, p: Page, url: string, label: string) {
  await ff.goto(url)
  if (!(await waitPanel(ff))) return bad(`${label}: panel never mounted`), false
  if (!(await ff.ensureVisible())) info(`${label}: headless firefox still reads the tab hidden`)
  return flows(p, label)
}

async function flows(p: Page, label: string, expect?: string) {
  const flowing = await rowsFlow(p, 45_000)
  const st: any = await panel(p)
  const live = (st.tabs || []).find((t: string) => t.startsWith('live='))
  info(`${label}: ${JSON.stringify({ url: st.url?.slice(0, 60), rows: st.rows, offline: st.offline, live })}`)
  if (!flowing) bad(`${label}: chat did not flow in the panel within 45s`, st)
  else if (expect && live && !live.toLowerCase().includes(expect.slice(0, 10))) bad(`${label}: live tab names "${live}"`)
  else ok(`${label}: chat flows`)
  return flowing
}

async function twitch(ff: FF, p: Page) {
  const [a] = await liveChannels('twitch', 1)
  if (!(await land(ff, p, `https://www.twitch.tv/${a}`, `ff tw-${a}`))) return
  const to = await ff.page<string>(`
    const a = [...document.querySelectorAll('a.side-nav-card__link')].find((x) => (x.getAttribute('href') || '').toLowerCase() !== '/${a}')
    a?.click()
    return (a?.getAttribute('href') || '').slice(1).toLowerCase()`)
  if (!to) return info('ff twitch: no side-nav channel to hop to')
  await sleep(4000)
  await flows(p, `ff tw-hop-${to}`, to)
}

async function kick(ff: FF, p: Page) {
  const [a] = await liveChannels('kick', 1)
  if (!(await land(ff, p, `https://kick.com/${a}`, `ff kick-${a}`))) return
  // kick's own socket opens in a frame of the background page (kick refuses the add-on's origin)
  await ff.page(`document.dispatchEvent(new Event('hs-dbg-kick-tap')); return 1`)
  await sleep(1000)
  const tap = JSON.parse((await ff.page<string>('return document.documentElement.dataset.hsDbgKickTap || "{}"').catch(() => '{}')) || '{}')
  const last = (tap.tap || []).find(([s]: [string]) => s === a)?.[1]?.lastAt || 0
  if (!tap.net?.connects || Date.now() - last > 30_000) bad(`ff kick: kick's own chat socket never delivered ${a}`, { net: tap.net, tap: tap.tap })
  else ok(`ff kick: kick's own chat socket delivers ${a}`)
  await ff.page(`document.querySelector('a[href="/browse"], a[href^="/browse"]')?.click(); return 1`)
  await sleep(8000)
  const br = await ff.page<{ path: string; noChannel: boolean; h: number }>(`
    const r = document.getElementById('hs-mc-container')?.getBoundingClientRect()
    return { path: location.pathname, noChannel: document.body.classList.contains('hs-kick-no-channel'), h: r ? Math.round(r.height) : -1 }`)
  if (!br.path.startsWith('/browse')) info(`ff kick: browse link did not navigate (${br.path})`)
  else if (!br.noChannel || (br.h >= 0 && br.h < 150))
    bad('ff kick: browse reached in-page reads as a channel page or squeezes the panel', br)
  else ok('ff kick: browse reads as no channel, panel usable')
  const to = await ff.page<string>(`
    const h = [...document.querySelectorAll('a[href^="/"]')].map((x) => x.getAttribute('href') || '')
      .filter((h) => /^\\/[A-Za-z0-9_-]{3,}$/.test(h) && !/^\\/(browse|categories|following|search|login|signup|terms|privacy|dmca)/.test(h) && h.slice(1).toLowerCase() !== '${a}')[0]
    if (h) document.querySelector('a[href="' + h + '"]').click()
    return (h || '').slice(1).toLowerCase()`)
  if (!to) bad('ff kick: no channel card on browse')
  else {
    await sleep(4000)
    await flows(p, `ff kick-hop-${to}`, to)
  }
  const off = 'mellen'
  const offline = await ff
    .pageAsync<boolean>(
      `const done = arguments[arguments.length - 1]
       fetch('/api/v2/channels/${off}').then((r) => r.json()).then((j) => done(!j.livestream)).catch(() => done(false))`,
    )
    .catch(() => false)
  if (!offline) return info(`ff kick offline check skipped: ${off} is live or the channel api did not answer`)
  await ff.page(`window.next?.router?.push('/${off}'); return 1`)
  await sleep(15_000)
  const dot = await ff.page<string>(`return document.querySelector('.hs-mc-tab[data-tab="live"]')?.dataset.live`)
  if (dot === 'true') bad(`ff kick: offline channel ${off} reached in-page reads live`)
  else ok('ff kick: offline channel reached in-page reads offline')
}

async function youtube(ff: FF, p: Page) {
  const live = await liveYtVideo()
  if (!live) return
  const url = `https://www.youtube.com/watch?v=${live.id}`
  if (!(await land(ff, p, url, `ff yt-live-${live.handle}`))) return
  await ff.goto(`https://www.youtube.com/watch?v=${YT_VOD}`)
  await sleep(20_000)
  const vod: any = await panel(p)
  if (vod.err) bad('ff yt: the vod page could not be read', vod.err)
  else if (vod.rows > 0 && !vod.offline) bad('ff yt: a vod opened after a livestream shows chat rows and a live panel', vod)
  else ok('ff yt: typed vod after a livestream: no stream chat, panel down')
  if (!(await land(ff, p, url, 'ff yt-live-again'))) return
  await ff.page(`document.querySelector('a#logo, ytd-topbar-logo-renderer a')?.click(); return 1`)
  await sleep(8000)
  const home: any = await panel(p)
  if (home.err) bad('ff yt: the home page could not be read', home.err)
  else if (!home.offline && home.rows > 0) bad('ff yt: home after a livestream still shows a live chat panel', home)
  else ok('ff yt: home (in-page) after a livestream: panel down')
  await ff.page('history.back(); return 1')
  await sleep(6000)
  if ((await ff.page<string>('return location.href')).includes(live.id)) await flows(p, 'ff yt-back-to-live')
  else info('ff yt: back did not return to the stream')
}

export async function s9Firefox() {
  scenario('s9 firefox spa chains')
  if (!existsSync(join(FF_EXT, 'manifest.json'))) return bad(`no firefox build at ${FF_EXT}`)
  const ff = await launchFirefox()
  const p = ff.asPage()
  const t0 = Date.now()
  try {
    info(`firefox ${ff.version}, add-on ${await ff.install(FF_EXT)}`)
    for (const [site, run] of [
      ['twitch', twitch],
      ['kick', kick],
      ['youtube', youtube],
    ] as const) {
      try {
        await run(ff, p)
      } catch (e) {
        bad(`ff ${site} chain crashed: ${String((e as Error)?.message || e).slice(0, 200)}`)
      }
      const ring = await ringSince(p, t0)
      if (ring.bad.length) bad(`ff ${site}: overlay watchdogs fired`, ring.bad.slice(0, 6))
    }
    const errs = await ff.addonErrors()
    if (errs.length) bad('ff: the add-on logged errors', errs.slice(0, 6))
  } finally {
    await ff.close()
  }
}

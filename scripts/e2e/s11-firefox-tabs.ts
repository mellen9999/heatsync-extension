/**
 * s11 — s1 in real Firefox: a twitch, a kick and a youtube stream in three tabs of one window,
 * the front tab changing every minute or so, the twitch and kick streams saved as one merged channel. Unlike headless chromium, firefox really hides a
 * background tab (visibilityState hidden, no frames), and the overlay skips all drawing there
 * and rebuilds when the tab is shown. This is the scenario that drives that hidden → shown
 * catch-up, in the browser the firefox reports come from.
 *
 *   bun run build.js firefox --no-test && bun scripts/e2e/run.ts --only s11
 *
 * Invariants on every rotation:
 *   - the tab brought to the front shows what was said while it was hidden: on a chat that kept
 *     talking, a burst of new rows lands within 2s of showing, not one row at a time
 *   - a hidden tab draws next to nothing; the rows land on the flip
 *   - its chat keeps moving after that
 *   - each tab's live tab names its own stream, never another tab's
 *   - the overlay's watchdogs stay quiet in every tab
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { launchFirefox } from '../lib/firefox'
import { bad, info, liveChannels, liveYtVideo, ok, panel, ROOT, ringSince, rowsFlow, scenario, sleep } from './lib'

const FF_EXT = process.env.E2E_FF_EXT || join(ROOT, 'dist', 'firefox')

/**
 * In-page recorder: counts rows the panel adds while the tab is visible (the chat's rate), and
 * for every hidden → shown flip, how many new rows land in the 2s after it and when the first.
 */
const RECORDER = `
  if (window.__s11) return 1
  const r = (window.__s11 = { rate: 0, rateWin: 0, hidAt: 0, shows: [] })
  const keys = () => [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].map((e) => e.dataset.msgKey).filter(Boolean)
  const seen = new Set(keys())
  let visFrom = performance.now()
  let visAdded = 0
  let hidAdded = 0
  new MutationObserver(() => {
    let n = 0
    for (const k of keys()) if (!seen.has(k)) seen.add(k), n++
    if (!n) return
    const s = r.shows.at(-1)
    const dt = s ? performance.now() - s.at : 1e9
    // the chat's own pace leaves out the catch-up burst right after a flip
    // and every bulk render (a flip, a channel the page moved to): only live appends are pace
    if (!document.hidden && dt > 3000 && n <= 10) visAdded += n
    if (document.hidden) hidAdded += n
    if (!s) return
    if (dt <= 2000) s.newIn2s += n
    if (s.first < 0) s.first = Math.round(dt)
    if (dt <= 10000 && s.trace.length < 12) s.trace.push([Math.round(dt), n])
  }).observe(document.getElementById('hs-mc-container'), { childList: true, subtree: true })
  // capture on window: runs before the overlay's own listener, whose catch-up render (and the
  // mutation callback it triggers) must count toward this flip, not the one before
  window.addEventListener('visibilitychange', () => {
    const now = performance.now()
    if (document.hidden) {
      r.rateWin = Math.round((now - visFrom - 3000) / 1000)
      r.rate = visAdded / Math.max(1, r.rateWin)
      r.hidAt = now
      hidAdded = 0
    } else {
      r.shows.push({ at: now, hiddenS: Math.round((now - r.hidAt) / 1000), rate: r.rate, rateWin: r.rateWin, first: -1, newIn2s: 0, hidAdded, foc: document.hasFocus(), trace: [] })
      visFrom = now
      visAdded = 0
    }
  }, true)
  return 1`

export async function s11FirefoxTabs() {
  scenario('s11 firefox three sites in three tabs')
  if (!existsSync(join(FF_EXT, 'manifest.json'))) return bad(`no firefox build at ${FF_EXT}`)
  const [tw] = await liveChannels('twitch', 1)
  const [kk] = await liveChannels('kick', 1)
  const yt = await liveYtVideo()
  const minutes = Number(process.env.E2E_S11_MIN || 6)
  const ff = await launchFirefox()
  const p = ff.asPage()
  try {
    const id = await ff.install(FF_EXT)
    info(`firefox ${ff.version}, add-on ${id}`)
    // the twitch and the kick stream saved as one channel, as a simulcast is: both tabs then read
    // it merged, the render path that kept drawing in background tabs (11-16)
    await ff.storageSet(id, {
      heatsync_multichat: { channels: [{ id: 'merged', twitch: tw, kick: kk, youtube: '' }] },
    })
    const tabs = [
      { name: `twitch ${tw}`, url: `https://www.twitch.tv/${tw}`, own: tw, handle: '' },
      { name: `kick ${kk}`, url: `https://kick.com/${kk}`, own: kk, handle: '' },
      ...(yt
        ? [{ name: `youtube ${yt.handle}`, url: `https://www.youtube.com/watch?v=${yt.id}`, own: '', handle: '' }]
        : []),
    ]
    // a webdriver switch selects the tab (and hides the one before it)
    const front = async (i: number) => {
      await ff.wd('POST', '/window', { handle: tabs[i].handle })
      if ((await ff.page<string>('return document.visibilityState')) !== 'visible') await ff.ensureVisible()
    }
    for (let i = 0; i < tabs.length; i++) {
      tabs[i].handle = i
        ? (await ff.wd<{ handle: string }>('POST', '/window/new', { type: 'tab' })).handle
        : await ff.wd<string>('GET', '/window')
      await ff.wd('POST', '/window', { handle: tabs[i].handle })
      await ff.goto(tabs[i].url)
      await front(i)
      if (!(await rowsFlow(p, 45_000))) bad(`${tabs[i].name}: chat never flowed on load`, await panel(p))
      await ff.page(RECORDER).catch((e) => bad(`${tabs[i].name}: recorder did not install`, String(e)))
    }
    await sleep(15_000)
    const ytLive = yt ? ((await panel(p)).tabs || []).find((x: string) => x.startsWith('live=')) : ''
    if (yt) info(`youtube live tab: ${ytLive}`)

    const t0 = Date.now()
    const end = t0 + minutes * 60_000
    for (let rot = 0; Date.now() < end; rot++) {
      const i = rot % tabs.length
      await front(i)
      await sleep(2500)
      const s = await ff.page<any>('return window.__s11?.shows.at(-1) || null')
      const expected = s ? s.rate * s.hiddenS : 0
      const st: any = await panel(p)
      info(`rotation ${rot}: ${tabs[i].name} ${JSON.stringify({ ...s, rate: s && +s.rate.toFixed(2), expected: Math.round(expected) })}`)
      // judged only on a pace read over 30s+ of a chat that said 40+ lines while hidden; the
      // pane holds at most what it shows, so a flood is judged against that
      const solid = s && s.rateWin >= 30 && expected >= 40
      const owed = Math.min(expected, st.rows || 0)
      if (!s) info(`rotation ${rot}: ${tabs[i].name} saw no hidden → shown flip`)
      else if (s.first > 2000) bad(`rotation ${rot}: ${tabs[i].name} drew nothing for ${s.first}ms after showing`)
      else if (!solid) ok(`rotation ${rot}: ${tabs[i].name} back after ${s.hiddenS}s, chat too thin to judge the catch-up`)
      // what was said while hidden shows at once on return; a pane that only appends what
      // arrives after the flip shows a handful and leaves the gap above
      else if (s.newIn2s + s.hidAdded < owed * 0.3)
        bad(
          `rotation ${rot}: ${tabs[i].name} came back after ${s.hiddenS}s showing old chat — ${s.newIn2s} new rows in 2s, ~${Math.round(expected)} were said`,
          st,
        )
      // and it is drawn on the flip, not while nobody can see it: a background tab that keeps
      // rebuilding its pane burns the cpu of every tab left open (11-16)
      else if (s.hidAdded > owed * 0.5)
        bad(`rotation ${rot}: ${tabs[i].name} kept drawing while hidden — ${s.hidAdded} rows in ${s.hiddenS}s`)
      else ok(`rotation ${rot}: ${tabs[i].name} back after ${s.hiddenS}s, ${s.newIn2s} new rows on the flip`)
      // a thin chat can say nothing for 30s; only one with a pace must keep moving
      if (!(await rowsFlow(p, 30_000))) {
        if (solid || (s && s.rateWin >= 30 && s.rate >= 0.5))
          bad(`rotation ${rot}: ${tabs[i].name}'s chat stopped after it came back`, st)
        else info(`rotation ${rot}: ${tabs[i].name} said nothing for 30s after it came back (thin chat)`)
      }
      const live = (st.tabs || []).find((x: string) => x.startsWith('live=')) || ''
      // the stream the page shows now: a raid or an ended stream can move twitch and kick on
      const here = new URL(st.url || tabs[i].url).pathname.split('/')[1]?.toLowerCase() || ''
      const own = tabs[i].own && here ? here : tabs[i].own
      if (own !== tabs[i].own) info(`rotation ${rot}: ${tabs[i].name}'s page moved on to ${here}`)
      const foreign = tabs
        .filter((_, k) => k !== i)
        .map((t) => t.own)
        .filter((o) => o && live.toLowerCase().includes(o.toLowerCase()))
      if (own && !live.toLowerCase().includes(own.slice(0, 10).toLowerCase()))
        bad(`rotation ${rot}: ${tabs[i].name}'s live tab reads "${live}"`, st.tabs)
      if (foreign.length) bad(`rotation ${rot}: ${tabs[i].name}'s live tab names another tab's stream (${foreign})`)
      if (!own && ytLive && live !== ytLive) bad(`rotation ${rot}: the youtube live tab changed to "${live}"`)
      await sleep(Math.min(60_000, Math.max(0, end - Date.now())))
    }
    for (let i = 0; i < tabs.length; i++) {
      await ff.wd('POST', '/window', { handle: tabs[i].handle })
      const ring = await ringSince(p, t0)
      info(`${tabs[i].name}: ring ${JSON.stringify(ring.counts)}`)
      const notable = ring.recent.filter((e: any) => e.e !== 'vis').map((e: any) => ({ ...e, t: Math.round((e.t - t0) / 1000) }))
      if (notable.length) info(`${tabs[i].name}: ${JSON.stringify(notable.slice(0, 12))}`)
      if (ring.bad.length) bad(`${tabs[i].name}: overlay watchdogs fired`, ring.bad.slice(0, 6))
    }
    const errs = await ff.addonErrors()
    if (errs.length) bad('ff: the add-on logged errors', errs.slice(0, 6))
  } finally {
    await ff.close()
  }
}

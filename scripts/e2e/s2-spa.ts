/**
 * s2 — navigation chains inside each site, the way people browse: real clicks on the
 * site's own links (single-page navigation), plus the full-load hop a typed url makes.
 *
 * Bugs of this shape that shipped: a vod opened after a livestream showed that stream's
 * chat (769adbb7), the next playlist video lost its playlist (5013a387), timers outliving
 * a channel switch (846badda), a tab whose channel the page dropped froze (1e50992c).
 *
 * Invariants after every hop:
 *   - the panel follows the page: a live channel shows its chat flowing; a vod / home
 *     shows no chat rows from the stream before it
 *   - the overlay's watchdogs logged no stall / gap / thrash
 *   - listeners on the page do not pile up as the same kind of page is revisited
 */
import {
  bad,
  dbg,
  domCounters,
  type Env,
  info,
  launch,
  liveChannels,
  liveYtVideo,
  ok,
  panel,
  ringSince,
  rowsFlow,
  scenario,
  shot,
  sleep,
  waitPanel,
  watchErrors,
  YT_VOD,
} from './lib'

async function clickFirst(p: any, selectors: string[], label: string) {
  for (const sel of selectors) {
    for (const el of await p.$$(sel)) {
      if (!(await el.isVisible().catch(() => false))) continue
      await el.click({ timeout: 10_000 }).catch(() => {})
      return sel
    }
  }
  throw new Error(`no clickable ${label} (${selectors.join(' | ')})`)
}

async function hopCheck(env: Env, p: any, label: string, t0: number, expect: 'chat' | 'quiet') {
  const flowing = expect === 'chat' ? await rowsFlow(p, 45_000) : false
  const st = await panel(p)
  const ring = await ringSince(p, t0)
  info(
    `${label}: ${JSON.stringify({ url: st.url?.slice(0, 70), rows: st.rows, offline: st.offline, active: st.activeTab, tabs: st.tabs?.filter((t: string) => !/^(feed|discover|whispers|mentions|pinned)=/.test(t)) })}`,
  )
  if (expect === 'chat' && !flowing) {
    bad(`${label}: chat did not flow in the panel within 45s`, st)
    await shot(p, `s2-${label}`)
  } else if (expect === 'chat') ok(`${label}: chat flows`)
  if (ring.bad.length) bad(`${label}: overlay watchdogs fired`, ring.bad.slice(0, 6))
  return st
}

export async function s2Twitch() {
  scenario('s2 twitch spa chain')
  const [a] = await liveChannels('twitch', 1)
  const env = await launch()
  const errs: string[] = []
  try {
    const p = await env.ctx.newPage()
    watchErrors(p, 'twitch', errs)
    let t0 = Date.now()
    await p.goto(`https://www.twitch.tv/${a}`, { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(p))) return bad('panel never mounted on a live twitch channel')
    await hopCheck(env, p, `tw-${a}`, t0, 'chat')
    const base = await domCounters(env.ctx, p)

    const counts: any[] = []
    for (let round = 0; round < 3; round++) {
      // channel → directory (top nav browse link)
      t0 = Date.now()
      await clickFirst(
        p,
        ['a[data-a-target="browse-link"]', 'a[href="/directory"]', 'a[href^="/directory"]'],
        'browse link',
      )
      await p.waitForURL(/\/directory/, { timeout: 15_000 }).catch(() => {})
      await sleep(6000)
      const dir = await panel(p)
      if (!dir.mounted) bad(`round ${round}: panel gone on the directory after spa nav`, dir)
      // directory → a live channel from the side nav (a different one each round)
      t0 = Date.now()
      const side = await p.$$('a.side-nav-card__link')
      const pickEl = side[round] || side[0]
      if (!pickEl) throw new Error('no side-nav channel link on the directory')
      await pickEl.click({ timeout: 10_000 })
      await sleep(4000)
      const ch = new URL(p.url()).pathname.split('/')[1]?.toLowerCase()
      const st = await hopCheck(env, p, `tw-round${round}-${ch}`, t0, 'chat')
      // the live tab must name the channel on screen, not the one before it
      const liveLabel = (st.tabs || []).find((t: string) => t.startsWith('live='))
      if (ch && liveLabel && !liveLabel.toLowerCase().includes(ch.slice(0, 10))) {
        bad(`round ${round}: live tab names "${liveLabel}" while the page shows ${ch}`)
      }
      counts.push(await domCounters(env.ctx, p))
    }
    info(`dom counters: start ${JSON.stringify(base)} rounds ${JSON.stringify(counts)}`)
    // same kind of page each round: listeners must not climb round over round
    const growth = counts[2].listeners - counts[0].listeners
    if (growth > 400) bad('listeners climb with every channel → directory → channel round', { base, counts })
    else ok(`listeners flat across rounds (Δ${growth})`)
    const d = await dbg(p)
    if (d.err) info(`dbg: ${d.err}`)
    else info(`irc buffers: ${JSON.stringify(d.irc).slice(0, 200)}`)
    if (errs.length) bad('page errors', errs.slice(0, 5))
  } finally {
    await env.close()
  }
}

export async function s2Youtube() {
  scenario('s2 youtube chain')
  const live = await liveYtVideo()
  if (!live) return
  const env = await launch()
  const errs: string[] = []
  try {
    const p = await env.ctx.newPage()
    watchErrors(p, 'yt', errs)
    let t0 = Date.now()
    await p.goto(`https://www.youtube.com/watch?v=${live.id}`, { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(p))) return bad('panel never mounted on a live youtube stream')
    await hopCheck(env, p, `yt-live-${live.handle}`, t0, 'chat')

    // typed url to a plain upload in the same tab (full load): no chat from the stream before
    t0 = Date.now()
    await p.goto(`https://www.youtube.com/watch?v=${YT_VOD}`, { waitUntil: 'domcontentloaded' })
    await sleep(20_000)
    const vod = await panel(p)
    info(`vod (typed): ${JSON.stringify({ rows: vod.rows, offline: vod.offline, box: vod.box })}`)
    if (vod.rows > 0 && !vod.offline) bad('a vod opened after a livestream shows chat rows and a live panel', vod)
    else ok('typed vod after a livestream: no stream chat, panel down')

    // back to the live stream, then single-page hops: logo → home, search → vod
    await p.goto(`https://www.youtube.com/watch?v=${live.id}`, { waitUntil: 'domcontentloaded' })
    await waitPanel(p)
    await hopCheck(env, p, 'yt-live-again', Date.now(), 'chat')
    t0 = Date.now()
    await clickFirst(p, ['a#logo', 'ytd-topbar-logo-renderer a'], 'youtube logo')
    await sleep(8000)
    const home = await panel(p)
    info(`home (spa): ${JSON.stringify({ url: home.url?.slice(0, 40), rows: home.rows, offline: home.offline })}`)
    if (!home.offline && home.rows > 0) bad('youtube home after a livestream still shows a live chat panel', home)
    else ok('home after a livestream: panel down')
    await p.fill('input[name="search_query"], input#search', 'me at the zoo').catch(() => {})
    await p.keyboard.press('Enter')
    await p.waitForSelector('ytd-video-renderer a#video-title', { timeout: 20_000 }).catch(() => {})
    await clickFirst(p, ['ytd-video-renderer a#video-title'], 'search result')
    await sleep(15_000)
    const vod2 = await panel(p)
    info(`vod (spa): ${JSON.stringify({ url: vod2.url?.slice(0, 60), rows: vod2.rows, offline: vod2.offline })}`)
    if (vod2.rows > 0 && !vod2.offline)
      bad('a vod reached by search after a livestream shows chat rows and a live panel', vod2)
    else ok('spa vod after a livestream: no stream chat, panel down')
    // history back to the live stream: chat comes back
    t0 = Date.now()
    for (let i = 0; i < 4 && !p.url().includes(live.id); i++) {
      await p.goBack().catch(() => {})
      await sleep(2000)
    }
    if ((await p.url()).includes(live.id)) await hopCheck(env, p, 'yt-back-to-live', t0, 'chat')
    else info(`back landed on ${p.url().slice(0, 60)}`)
    const ring = await ringSince(p, 0)
    if (ring.bad.length) bad('overlay watchdogs fired during the youtube chain', ring.bad.slice(0, 6))
    if (errs.length) bad('page errors', errs.slice(0, 5))
  } finally {
    await env.close()
  }
}

export async function s2Kick() {
  scenario('s2 kick chain')
  const [a] = await liveChannels('kick', 1)
  const env = await launch()
  const errs: string[] = []
  try {
    const p = await env.ctx.newPage()
    watchErrors(p, 'kick', errs)
    let t0 = Date.now()
    await p.goto(`https://kick.com/${a}`, { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(p))) return bad('panel never mounted on a live kick channel')
    await hopCheck(env, p, `kick-${a}`, t0, 'chat')
    for (let round = 0; round < 2; round++) {
      t0 = Date.now()
      await clickFirst(p, ['a[href="/browse"]', 'a[href^="/browse"]'], 'browse link')
      await p.waitForURL(/\/browse/, { timeout: 15_000 }).catch(() => {})
      await sleep(6000)
      // kick keeps the channel page it left hidden in the DOM: browse must still read as a
      // no-channel page, the panel floating over it, not squeezed into a strip (11-16)
      const br = await p.evaluate(() => {
        const r = document.getElementById('hs-mc-container')?.getBoundingClientRect()
        return { noChannel: document.body.classList.contains('hs-kick-no-channel'), h: r ? Math.round(r.height) : -1 }
      })
      if (!br.noChannel || (br.h >= 0 && br.h < 150)) {
        bad(`round ${round}: kick browse reached in-page reads as a channel page or squeezes the panel`, br)
        await shot(p, `s2-kick-browse-${round}`)
      }
      const cards = await p.$$eval('a[href^="/"]', (as: Element[]) =>
        as
          .map((x) => (x as HTMLAnchorElement).getAttribute('href') || '')
          .filter(
            (h) =>
              /^\/[A-Za-z0-9_-]{3,}$/.test(h) &&
              !/^\/(browse|categories|following|search|login|signup|terms|privacy|dmca)/.test(h),
          ),
      )
      const target = cards[round + 1] || cards[0]
      if (!target) {
        bad(`round ${round}: no channel card on kick browse`)
        break
      }
      t0 = Date.now()
      await p.click(`a[href="${target}"]`, { timeout: 10_000 }).catch(() => {})
      await sleep(4000)
      await hopCheck(env, p, `kick-round${round}-${target.slice(1)}`, t0, 'chat')
    }
    if (errs.length) bad('page errors', errs.slice(0, 5))
  } finally {
    await env.close()
  }
}

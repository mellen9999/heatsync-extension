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
 *   - a tab the reader picked keeps its own chat when the page moves to another channel: the
 *     pane never shows the new channel's chat under the picked tab
 */
import {
  bad,
  dbg,
  domCounters,
  type Env,
  UA,
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
  swState,
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

/**
 * The reader picks the saved tab `saved`, then the page moves to another channel (`nav`). The
 * pick stands, and the pane keeps that tab's chat: an in-page observer reads the pane after every
 * change for 8s, and no read may show the picked tab over another channel's rows or over an empty
 * "connecting" pane (a repaint of the page's channel into the picked tab, 11-16).
 */
async function pickHolds(p: any, label: string, saved: string, nav: () => Promise<unknown>) {
  const tab = `.hs-mc-tab[data-tab="${saved}"]`
  if (!(await p.$(tab))) return info(`${label}: no saved tab ${saved} to pick`)
  await p.click(tab, { timeout: 5000 }).catch(() => {})
  await sleep(1500)
  const sv = saved.toLowerCase()
  const armed = await p.evaluate((sv: string) => {
    const w = window as any
    const read = () => {
      const act = document.querySelector('.hs-mc-tab.active, .hs-mc-tab[aria-selected="true"]') as HTMLElement | null
      const rows = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')] as HTMLElement[]
      const foreign = rows.map((r) => (r.dataset.msgChannel || '').toLowerCase()).filter((c) => c && c !== sv)
      return {
        active: (act?.dataset.tab || '').toLowerCase(),
        rows: rows.length,
        foreign: foreign.length,
        from: [...new Set(foreign)].slice(0, 3),
        empty: !!document.querySelector('#hs-mc-messages > .hs-mc-empty'),
      }
    }
    const rec = (w.__pick = { t0: 0, wrong: [] as any[], last: read() })
    if (rec.last.active !== sv) return rec.last.active
    const mo = new MutationObserver(() => {
      const r = read()
      rec.last = r
      if (rec.t0 && r.active === sv && (r.foreign >= 3 || r.empty) && rec.wrong.length < 5)
        rec.wrong.push({ ms: Math.round(performance.now() - rec.t0), ...r })
    })
    mo.observe(document.getElementById('hs-mc-container') || document.body, { childList: true, subtree: true })
    w.__pickStop = () => mo.disconnect()
    return sv
  }, sv)
  if (armed !== sv) return info(`${label}: the pick of ${saved} did not take (${armed})`)
  await p.evaluate(() => {
    ;(window as any).__pick.t0 = performance.now()
  })
  await nav()
  await sleep(8000)
  const rec = await p.evaluate(() => {
    const w = window as any
    w.__pickStop?.()
    return w.__pick
  })
  if (rec.last.active !== sv) bad(`${label}: the page moved and took the picked tab ${saved} away (now ${rec.last.active})`)
  else if (rec.wrong.length)
    bad(`${label}: the page moved and the picked tab ${saved} showed another channel's chat`, rec.wrong.slice(0, 3))
  else ok(`${label}: the picked tab ${saved} kept its chat through the nav (${rec.last.rows} rows)`)
  // back to following the page, as the chain expects
  await p.click('.hs-mc-tab[data-tab="live"]', { timeout: 5000 }).catch(() => {})
}

async function hopCheck(env: Env, p: any, label: string, t0: number, expect: 'chat' | 'quiet') {
  const flowing = expect === 'chat' ? await rowsFlow(p, 45_000) : false
  const st = await panel(p)
  const ring = await ringSince(p, t0)
  info(
    `${label}: ${JSON.stringify({ url: st.url?.slice(0, 70), rows: st.rows, offline: st.offline, active: st.activeTab, tabs: st.tabs?.filter((t: string) => !/^(feed|discover|whispers|mentions|pinned)=/.test(t)) })}`,
  )
  if (expect === 'chat' && !flowing) {
    const sw: any = await swState(env)
    bad(`${label}: chat did not flow in the panel within 45s`, { ...st, extras: sw.extras, swTabs: sw.tabs, kick: sw.kick, ring: ring.counts })
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
      // the pick round needs a channel other than the saved one
      const others = []
      for (const el of side) if (((await el.getAttribute('href')) || '').toLowerCase() !== `/${a.toLowerCase()}`) others.push(el)
      const pickEl = round === 2 ? others[0] || side[0] : side[round] || side[0]
      if (!pickEl) throw new Error('no side-nav channel link on the directory')
      // last round: the reader is on the saved tab when they click through
      if (round === 2) await pickHolds(p, `tw-round${round}`, a, () => pickEl.click({ timeout: 10_000 }))
      else await pickEl.click({ timeout: 10_000 })
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

/** Past livestreams of channels that stream often, newest first: ids youtube lists as "Streamed … ago". */
async function pastYtStreams(handles = ['ThePrimeTimeagen', 'NASA', 'SpaceX', 'LofiGirl']): Promise<string[]> {
  const ids: string[] = []
  for (const h of handles) {
    const res = await fetch(`https://www.youtube.com/@${h}/streams`, {
      headers: { 'user-agent': UA, 'accept-language': 'en', cookie: 'SOCS=CAI' },
    }).catch(() => null)
    const html = res?.ok ? await res.text() : ''
    for (const m of html.matchAll(/Streamed \d+ (?:hour|day|week|month)s? ago/g)) {
      const id = [...html.slice(Math.max(0, m.index - 6000), m.index).matchAll(/"videoId":"([\w-]{11})"/g)].at(-1)?.[1]
      if (id && !ids.includes(id)) ids.push(id)
      if (ids.length >= 6) return ids
    }
  }
  return ids
}

/**
 * On a past stream youtube shows its chat replay (some channels turn it off: the frame then
 * carries youtube's own hide-chat-frame). Ours to check: nothing of ours hides the frame, and
 * where youtube shows it, it is on screen.
 */
async function pastStreamKeepsReplay(p: any) {
  const ids = await pastYtStreams()
  if (!ids.length) return info('skipped: no past youtube stream found for the chat replay check')
  let weak = ''
  for (const id of ids.slice(0, 4)) {
    await p.goto(`https://www.youtube.com/watch?v=${id}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('ytd-live-chat-frame', { state: 'attached', timeout: 20_000 }).catch(() => {})
    await sleep(8000)
    const f = await p.evaluate(() => {
      const el = document.querySelector('ytd-live-chat-frame') as HTMLElement | null
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        ytHides: el.hasAttribute('hide-chat-frame'),
        ours: !!el.dataset.hsHidden || el.style.display === 'none',
        display: getComputedStyle(el).display,
        box: [Math.round(r.width), Math.round(r.height)],
        offline: document.body.classList.contains('hs-offline'),
      }
    })
    if (!f) continue
    if (!f.offline) {
      info(`past stream ${id}: the panel is up there (still live, or chat on every page), not a replay page`)
      continue
    }
    if (f.ours) return bad(`past stream ${id}: we hide youtube's chat replay though our panel is down`, f)
    if (f.ytHides) {
      weak = id // youtube hides this one itself: only "nothing of ours on it" can be said
      continue
    }
    if (f.display === 'none' || f.box[0] < 100 || f.box[1] < 40)
      return bad(`past stream ${id}: youtube's chat replay is not on screen`, f)
    return ok(`past stream ${id}: youtube's chat replay is on screen (${f.box.join('x')}), our panel down`)
  }
  if (weak) ok(`past stream ${weak}: nothing of ours on the replay frame (youtube hides this one itself)`)
  else info('skipped: no past stream with a chat frame found')
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

    // a past stream: our panel is down, so its chat replay is youtube's to show. The panel's
    // container sits on every youtube page and its native-chat hide took the replay with it.
    await pastStreamKeepsReplay(p)

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
  const busy = await liveChannels('kick', 12).catch(() => liveChannels('kick', 1))
  const [a] = busy
  const seen: string[] = []
  const env = await launch()
  const errs: string[] = []
  try {
    const p = await env.ctx.newPage()
    watchErrors(p, 'kick', errs)
    let t0 = Date.now()
    await p.goto(`https://kick.com/${a}`, { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(p))) return bad('panel never mounted on a live kick channel')
    await hopCheck(env, p, `kick-${a}`, t0, 'chat')
    // kick's own socket, not only the server relay: from 11-10 to 11-17 it was refused on every
    // connect (kick takes a kick.com origin only) and nothing noticed
    const k = (await swState(env) as any).kick
    if (!k?.net?.connects || !(k.tapAgoS?.[a] <= 30)) bad(`kick's own chat socket never delivered ${a}`, k)
    else ok(`kick's own chat socket delivers ${a} (${k.tapAgoS[a]}s ago)`)
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
      // a card from the busiest live channels when browse shows one, so 45s of silence is never a
      // quiet channel (a 196-viewer card went 45s without a line, 11-16)
      const here = new URL(p.url()).pathname.slice(1).toLowerCase()
      const fresh = [...new Set(cards)].filter((h) => ![a, here, ...seen].includes(h.slice(1).toLowerCase()))
      const target = fresh.find((h) => busy.includes(h.slice(1).toLowerCase())) || fresh[0] || cards[0]
      if (!target) {
        bad(`round ${round}: no channel card on kick browse`)
        break
      }
      seen.push(target.slice(1).toLowerCase())
      t0 = Date.now()
      // kick keeps the page it left in the DOM, hidden: the first match can be that copy. a visible
      // card, and if none takes the click (seen on the nightly runner, 11-17) the
      // same in-page nav through kick's router, so the hop is still single-page
      const go = async () => {
        await p.locator(`a[href="${target}"]:visible`).first().click({ timeout: 10_000 }).catch(() => {})
        const there = () => new URL(p.url()).pathname.toLowerCase() === target.toLowerCase()
        for (let i = 0; i < 10 && !there(); i++) await sleep(500)
        if (!there()) {
          info(`round ${round}: the ${target} card took no click; kick's router goes there`)
          await p.evaluate((t: string) => (window as any).next?.router?.push(t), target).catch(() => {})
          await p.waitForURL((u: URL) => u.pathname.toLowerCase() === target.toLowerCase(), { timeout: 10_000 }).catch(() => {})
        }
      }
      if (round === 1) await pickHolds(p, `kick-round${round}`, a, go)
      else await go()
      await sleep(4000)
      await hopCheck(env, p, `kick-round${round}-${target.slice(1)}`, t0, 'chat')
    }
    // kick keeps a hidden ad player on every channel page and the old page's player in a hidden
    // copy: an offline channel reached in-page must not read live (11-16)
    const off = 'mellen'
    const offline = await p
      .evaluate((s: string) => fetch(`/api/v2/channels/${s}`).then((r) => r.json()).then((j) => !j.livestream), off)
      .catch(() => false)
    if (!offline) info(`kick offline check skipped: ${off} is live or the channel api did not answer`)
    else {
      await p.evaluate((t: string) => (window as any).next?.router?.push(t), `/${off}`)
      // the hop itself has to land: on a slow runner kick's router was not there yet, the page
      // stayed on the live channel and its lit dot read as "offline channel reads live" (nightly 11-17)
      const arrived = await p
        .waitForFunction((t: string) => location.pathname === t, `/${off}`, { timeout: 20_000 })
        .then(() => true)
        .catch(() => false)
      if (!arrived) {
        await p.evaluate((t: string) => (window as any).next?.router?.push(t), `/${off}`)
        await p.waitForFunction((t: string) => location.pathname === t, `/${off}`, { timeout: 20_000 }).catch(() => {})
      }
      await sleep(15_000)
      // the live tab's dot, the video kick draws, and the tab the panel is on
      const look = () =>
        p.evaluate(() => {
          const live = document.querySelector('.hs-mc-tab[data-tab="live"]') as HTMLElement | null
          const shown = [...document.querySelectorAll('video')].filter((v) => v.getClientRects().length && !v.closest('#hs-mc-container'))
          return {
            dot: live?.dataset.live,
            label: live?.textContent,
            videos: shown.length,
            active: document.querySelector('.hs-mc-tab.active')?.getAttribute('data-tab'),
            path: location.pathname,
          }
        })
      const now = await look()
      if (now.path !== `/${off}`) info(`kick offline check skipped: the in-page hop to /${off} never landed (still ${now.path})`)
      else if (now.dot === 'true') {
        await sleep(20_000)
        bad(`offline kick channel ${off} reached in-page reads live`, { at15s: now, at35s: await look() })
      } else ok('offline kick channel reached in-page reads offline')
    }
    if (errs.length) bad('page errors', errs.slice(0, 5))
  } finally {
    await env.close()
  }
}

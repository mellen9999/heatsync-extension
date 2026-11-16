/**
 * s1 — three sites open at once (a twitch, a kick and a youtube stream, one tab each)
 * with six saved channels across the three, the front tab changing every couple of
 * minutes, the way someone watches one and keeps the others open.
 *
 * Bugs of this shape that shipped: storage fan-out between tabs (each write cloned to
 * every tab, the firefox ram climb, #3), one tab's channel showing in another tab's
 * live tab, a tab brought back to the front with a frozen list.
 *
 * Invariants on every rotation:
 *   - each tab's live tab names its own stream, never another tab's
 *   - the tab brought to the front has chat flowing; watchdogs stay quiet in every tab
 */
import {
  bad,
  info,
  launch,
  liveChannels,
  liveYtVideo,
  ok,
  panel,
  ringSince,
  rowsFlow,
  saveChannels,
  scenario,
  shot,
  sleep,
  waitPanel,
  watchErrors,
} from './lib'

export async function s1Tabs() {
  scenario('s1 three sites in three tabs')
  const tw = await liveChannels('twitch', 3)
  const kk = await liveChannels('kick', 3)
  const yt = await liveYtVideo()
  const minutes = Number(process.env.E2E_S1_MIN || 6)
  const env = await launch()
  const errs: string[] = []
  try {
    await saveChannels(env, [
      { id: tw[1], twitch: tw[1] },
      { id: tw[2], twitch: tw[2] },
      { id: `k-${kk[1]}`, kick: kk[1] },
      { id: `k-${kk[2]}`, kick: kk[2] },
      { id: 'yt-lofi', youtube: yt.handle },
      { id: `mix-${tw[0]}`, twitch: tw[0], kick: kk[0] },
    ])
    const tabs = [
      { name: `twitch ${tw[0]}`, url: `https://www.twitch.tv/${tw[0]}`, own: tw[0] },
      { name: `kick ${kk[0]}`, url: `https://kick.com/${kk[0]}`, own: kk[0] },
      { name: `youtube ${yt.handle}`, url: `https://www.youtube.com/watch?v=${yt.id}`, own: '' },
    ]
    const pages: any[] = []
    for (const t of tabs) {
      const p = await env.ctx.newPage()
      watchErrors(p, t.name, errs)
      await p.goto(t.url, { waitUntil: 'domcontentloaded' })
      if (!(await waitPanel(p))) bad(`${t.name}: panel never mounted`)
      pages.push(p)
    }
    // the youtube live tab names the channel, which the page shows: read it once settled
    await sleep(15_000)
    const ytLive = ((await panel(pages[2])).tabs || []).find((x: string) => x.startsWith('live='))
    info(`youtube live tab: ${ytLive}`)

    const t0 = Date.now()
    const end = t0 + minutes * 60_000
    let rot = 0
    while (Date.now() < end) {
      const i = rot % 3
      const p = pages[i]
      await p.bringToFront()
      const flowing = await rowsFlow(p, 45_000)
      if (flowing) ok(`rotation ${rot}: ${tabs[i].name} in front, chat flows`)
      else {
        bad(`rotation ${rot}: ${tabs[i].name} came to the front with its chat still`, await panel(p))
        await shot(p, `s1-rot${rot}`)
      }
      for (let j = 0; j < 3; j++) {
        const st = await panel(pages[j])
        const live = (st.tabs || []).find((x: string) => x.startsWith('live=')) || ''
        const own = tabs[j].own
        const foreign = tabs
          .filter((_, k) => k !== j)
          .map((t) => t.own)
          .filter((o) => o && live.toLowerCase().includes(o.toLowerCase()))
        if (own && !live.toLowerCase().includes(own.slice(0, 10).toLowerCase()))
          bad(`rotation ${rot}: ${tabs[j].name}'s live tab reads "${live}"`, st.tabs)
        if (foreign.length)
          bad(`rotation ${rot}: ${tabs[j].name}'s live tab names another tab's stream (${foreign})`, st.tabs)
        if (j === 2 && ytLive && live !== ytLive) bad(`rotation ${rot}: the youtube live tab changed to "${live}"`)
      }
      rot++
      await sleep(Math.min(120_000, Math.max(0, end - Date.now())))
    }
    for (let j = 0; j < 3; j++) {
      const ring = await ringSince(pages[j], t0)
      if (ring.bad.length) bad(`${tabs[j].name}: overlay watchdogs fired`, ring.bad.slice(0, 6))
    }
    if (errs.length) bad('page errors', errs.slice(0, 5))
  } finally {
    await env.close()
  }
}

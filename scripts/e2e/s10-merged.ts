/**
 * s10 — one saved channel on two platforms, read as one merged chat: a twitch stream with a kick
 * channel linked to it, the way a streamer who simulcasts is saved (mellen reads kripp so). The
 * merged tab renders through its own path (scheduleMergedRender, simulcast folding), which no
 * other scenario drives.
 *
 * Invariants, on the twitch stream's page and then on the kick channel's, while it is on screen:
 *   - rows from both platforms keep arriving; the newest row never sits still for 15s
 *   - the overlay's watchdogs stay quiet, render_stall and dom_quiet included
 */
import {
  BAD_RING,
  bad,
  info,
  launch,
  liveChannels,
  ok,
  ringSince,
  rowsFlow,
  saveChannels,
  scenario,
  shot,
  sleep,
  waitPanel,
  watchErrors,
} from './lib'

const WATCH_MS = 90_000
const STUCK_MS = 15_000

async function watchMerged(p: any, label: string) {
  const t0 = Date.now()
  const seen = new Set<string>()
  let last = ''
  let lastChange = Date.now()
  let worstStill = 0
  while (Date.now() - t0 < WATCH_MS) {
    await sleep(3000)
    const s = await p.evaluate(() => {
      const rows = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].slice(-60) as HTMLElement[]
      return {
        newest: rows.at(-1)?.dataset.msgKey || '',
        // twitch rows carry no platform (it is the default); system rows have no sender
        plats: [
          ...new Set(
            rows.filter((r) => r.querySelector('.hs-mc-user')).map((r) => r.dataset.msgPlatform || 'twitch'),
          ),
        ],
      }
    })
    for (const x of s.plats) seen.add(x)
    if (s.newest !== last) {
      last = s.newest
      lastChange = Date.now()
    }
    worstStill = Math.max(worstStill, Date.now() - lastChange)
  }
  const ring = await ringSince(p, t0)
  const quiet = ring.recent.filter((e: any) => e.e === 'dom_quiet' || e.e === 'render_stall' || e.e === 'unpinned')
  info(`${label}: platforms ${[...seen].join('+') || 'none'}, longest still ${Math.round(worstStill / 1000)}s, ring ${JSON.stringify(ring.counts)}`)
  if (!seen.has('twitch') || !seen.has('kick')) bad(`${label}: the merged chat did not show both platforms`, [...seen])
  else ok(`${label}: twitch and kick rows both arrive`)
  if (worstStill > STUCK_MS) {
    bad(`${label}: the newest row sat still for ${Math.round(worstStill / 1000)}s on two busy chats`)
    await shot(p, `s10-${label}-still`)
  } else ok(`${label}: the newest row kept moving`)
  const watchdogs = [...ring.bad, ...quiet.filter((e: any) => !(BAD_RING as readonly string[]).includes(e.e))]
  if (watchdogs.length) bad(`${label}: overlay watchdogs fired`, watchdogs.slice(0, 6))
}

export async function s10Merged() {
  scenario('s10 merged twitch + kick channel')
  const [tw] = await liveChannels('twitch', 1)
  const [kk] = await liveChannels('kick', 1)
  const env = await launch()
  const errs: string[] = []
  try {
    await saveChannels(env, [{ id: 'merged', twitch: tw, kick: kk }])
    const p = await env.ctx.newPage()
    watchErrors(p, 'merged', errs)
    await p.goto(`https://www.twitch.tv/${tw}`, { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(p))) return bad('panel never mounted')
    if (!(await rowsFlow(p, 45_000))) return bad('chat never flowed')
    const active = await p.evaluate(() => document.querySelector('.hs-mc-tab.active')?.getAttribute('data-tab'))
    if (active !== 'merged') info(`on the saved channel's own page the active tab is ${active}`)
    await watchMerged(p, 'on twitch')
    // the same saved channel from its kick side
    await p.goto(`https://kick.com/${kk}`, { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(p)) || !(await rowsFlow(p, 45_000))) return bad('kick side: chat never flowed')
    await watchMerged(p, 'on kick')
    if (errs.length) bad('page errors', errs.slice(0, 5))
  } finally {
    await env.close()
  }
}

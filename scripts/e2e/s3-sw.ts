/**
 * s3 — the service worker dies mid-session, the way chrome stops an idle one, while a
 * twitch tab and a kick tab are live.
 *
 * Bugs of this shape that shipped: a restarted worker never re-joined an older tab's
 * channel, so that tab went silent (bg_irc_interest re-assert), and emotes turning to
 * text once the worker's in-memory sets were gone (cold-sw hydration race).
 *
 * Invariants after each stop:
 *   - a new worker boots to the end (__hsBootOk) and logs nothing to hs_errors
 *   - both tabs' chat flows again within 45s, and the overlay's watchdogs stay quiet
 *   - the new worker knows both tabs' channels again and holds an emote set for each
 */
import {
  bad,
  type Env,
  info,
  launch,
  liveChannels,
  ok,
  panel,
  ringSince,
  rowsFlow,
  scenario,
  shot,
  sleep,
  swState,
  waitPanel,
  watchErrors,
} from './lib'

async function stopWorker(env: Env, p: any) {
  // a marker on the running worker's global: a restarted worker comes up without it
  await env
    .worker()
    .evaluate(() => {
      // @ts-ignore
      self.__e2eMark = 1
    })
    .catch(() => {})
  const cdp = await env.ctx.newCDPSession(p)
  try {
    await cdp.send('ServiceWorker.enable')
    await cdp.send('ServiceWorker.stopAllWorkers')
  } finally {
    await cdp.detach().catch(() => {})
  }
}

export async function s3Sw() {
  scenario('s3 service worker stopped mid-session')
  const [tw] = await liveChannels('twitch', 1)
  const [kk] = await liveChannels('kick', 1)
  const env = await launch()
  const errs: string[] = []
  try {
    const pt = await env.ctx.newPage()
    watchErrors(pt, 'twitch', errs)
    await pt.goto(`https://www.twitch.tv/${tw}`, { waitUntil: 'domcontentloaded' })
    const pk = await env.ctx.newPage()
    watchErrors(pk, 'kick', errs)
    await pk.goto(`https://kick.com/${kk}`, { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(pt)) || !(await waitPanel(pk))) return bad('panel never mounted on a live channel')
    if (!(await rowsFlow(pt, 45_000)) || !(await rowsFlow(pk, 45_000)))
      return bad('chat never flowed before the worker was stopped — nothing to compare against')
    const before = await swState(env)
    info(
      `before: ${JSON.stringify({ boot: before.boot, sets: Object.keys(before.sets || {}).length, tabs: before.tabs, errs: before.errs?.length })}`,
    )
    const errsBefore = before.errs?.length || 0

    for (let round = 0; round < 2; round++) {
      const t0 = Date.now()
      await stopWorker(env, pt)
      // chrome restarts it on the next event: a tab message, the keepalive alarm
      await sleep(5000)
      for (const [p, label] of [
        [pt, `tw-${tw}`],
        [pk, `kick-${kk}`],
      ] as const) {
        if (await rowsFlow(p, 45_000)) ok(`round ${round}: ${label} chat flows again after the worker stopped`)
        else {
          bad(`round ${round}: ${label} chat stayed silent after the worker stopped`, await panel(p))
          await shot(p, `s3-r${round}-${label}`)
        }
        const ring = await ringSince(p, t0)
        if (ring.bad.length) bad(`round ${round}: ${label} overlay watchdogs fired`, ring.bad.slice(0, 6))
      }
      const after: any = await swState(env)
      // @ts-ignore
      const fresh = await env
        .worker()
        .evaluate(() => !self.__e2eMark)
        .catch(() => false)
      info(`round ${round} after: ${JSON.stringify({ fresh, boot: after.boot, sets: after.sets, tabs: after.tabs })}`)
      if (!fresh) info(`round ${round}: the worker did not restart (stop was a no-op) — round proves nothing`)
      if (!after.boot) bad(`round ${round}: the restarted worker did not boot to the end`, after)
      const newErrs = (after.errs || []).slice(errsBefore)
      if (newErrs.length) bad(`round ${round}: the worker logged errors`, newErrs.slice(0, 5))
      const tabChans = (after.tabs || []).map((t: any[]) => String(t[1] || '').toLowerCase())
      for (const ch of [tw, kk])
        if (!tabChans.some((c: string) => c.includes(ch.toLowerCase())))
          bad(`round ${round}: the restarted worker lost which tab shows ${ch}`, after.tabs)
      const keys = Object.keys(after.sets || {}).map((k) => k.toLowerCase())
      for (const ch of [tw, kk])
        if (!keys.some((k) => k.includes(ch.toLowerCase())))
          bad(`round ${round}: the restarted worker holds no emote set for ${ch}`, Object.keys(after.sets || {}))
      await sleep(20_000)
    }
    if (errs.length) bad('page errors', errs.slice(0, 5))
  } finally {
    await env.close()
  }
}

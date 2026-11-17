/**
 * s5 — every emote provider (7tv, bttv, ffz, heatsync) goes dark mid-session, then
 * comes back.
 *
 * Bugs of this shape that shipped: a refresh that failed wiped the channel's set and
 * its emotes turned to text for the rest of the session (the per-provider salvage),
 * a heatsync 429 starved the third-party fetch, a failed cold join was never retried
 * while the tab sat idle (hs-emote-refetch).
 *
 * The outage is real for both halves: the worker's own fetch rejects the way an
 * unreachable host does, and the page's emote images are aborted at the network.
 *
 * Invariants:
 *   - chat keeps flowing through the outage; nothing throws, watchdogs stay quiet
 *   - a channel whose set was loaded keeps it through a refresh that fails
 *   - a channel first opened during the outage gets a full set once the providers are
 *     back, without the user doing anything, within two retry windows (2 × 90s)
 *   - rows that arrive after the outage show their emote images loaded, not broken
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
  waitPanel,
  watchErrors,
} from './lib'

const API_HOSTS = ['7tv.io', '7tv.app', 'betterttv.net', 'frankerfacez.com', 'heatsync.org']
const CDN = /^https:\/\/(cdn\.7tv\.app|cdn\.betterttv\.net|cdn\.frankerfacez\.com|cdn\.heatsync\.org)\//

/** Make the worker's fetch reject for the provider hosts (or stop doing so). */
async function workerOutage(env: Env, on: boolean) {
  await env.worker().evaluate(
    ({ on, hosts }) => {
      const g = self as any
      g.__e2eFetch ||= g.fetch
      g.fetch = on
        ? function (input: any, init?: any) {
            const u = String(input?.url || input)
            if (hosts.some((h: string) => new URL(u, 'https://x/').hostname.endsWith(h)))
              return Promise.reject(new TypeError('Failed to fetch'))
            return g.__e2eFetch.call(this, input, init)
          }
        : g.__e2eFetch
    },
    { on, hosts: API_HOSTS },
  )
}

async function channelSet(env: Env, key: string) {
  return env
    .worker()
    .evaluate((k: string) => {
      // @ts-ignore — worker globals
      const set = channelEmotesMap[k]
      // @ts-ignore
      const at = channelEmotesFetchedAt[k] || 0
      const bySource: Record<string, number> = {}
      if (Array.isArray(set))
        for (const e of set) bySource[e?.source || 'heatsync'] = (bySource[e?.source || 'heatsync'] || 0) + 1
      return { state: Array.isArray(set) ? 'set' : String(set), n: Array.isArray(set) ? set.length : 0, bySource, at }
    }, key)
    .catch((e: unknown) => ({ state: `err ${e}`, n: 0, bySource: {}, at: 0 }))
}

/** Emote images in rows that arrived after `afterKey`: how many loaded, how many are broken. */
async function newRowImages(p: any, afterKey: string) {
  return p.evaluate((k: string) => {
    const rows = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')] as HTMLElement[]
    const i = rows.findIndex((r) => r.dataset.msgKey === k)
    const fresh = i >= 0 ? rows.slice(i + 1) : rows.slice(-30)
    let loaded = 0
    let broken = 0
    for (const r of fresh)
      for (const img of r.querySelectorAll('img.hs-mc-emote') as NodeListOf<HTMLImageElement>) {
        if (!img.complete) continue
        if (img.naturalWidth > 0) loaded++
        else broken++
      }
    return { rows: fresh.length, loaded, broken }
  }, afterKey)
}

export async function s5Outage() {
  scenario('s5 emote providers go dark, then come back')
  const [a, b] = await liveChannels('twitch', 2)
  const env = await launch()
  const errs: string[] = []
  let cdnDown = false
  try {
    await env.ctx.route(CDN, (r: any) => (cdnDown ? r.abort('internetdisconnected') : r.continue()))
    const p = await env.ctx.newPage()
    watchErrors(p, 'twitch', errs)
    await p.goto(`https://www.twitch.tv/${a}`, { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(p))) return bad('panel never mounted on a live twitch channel')
    if (!(await rowsFlow(p, 45_000))) return bad('chat never flowed before the outage')
    await sleep(10_000)
    const keyA = `twitch/${a.toLowerCase()}`
    const keyB = `twitch/${b.toLowerCase()}`
    // a cold fetch is bounded but serial (ids, then each provider, 7tv falling back to the proxy,
    // then the flags): ~40s worst case on a slow line. Only a set still loading after that is stuck
    let setA0 = await channelSet(env, keyA)
    for (let i = 0; i < 25 && setA0.state === 'loading'; i++) {
      await sleep(2000)
      setA0 = await channelSet(env, keyA)
    }
    info(`${keyA} before: ${JSON.stringify(setA0)}`)
    if (setA0.state !== 'set' || !setA0.n) return bad(`${keyA} had no emote set before the outage`, setA0)

    // ── outage ──
    const t0 = Date.now()
    info(`outage on (${API_HOSTS.join(', ')} + their cdns)`)
    await workerOutage(env, true)
    cdnDown = true
    // a refresh of a loaded channel during the outage: the 30-min ttl, brought forward
    await env.worker().evaluate((k: string) => {
      // @ts-ignore
      channelEmotesFetchedAt[k] = 1
    }, keyA)
    // a channel opened for the first time while everything is down
    await p.goto(`https://www.twitch.tv/${b}`, { waitUntil: 'domcontentloaded' })
    await waitPanel(p)
    if (await rowsFlow(p, 45_000)) ok('chat flows through the outage')
    else {
      bad('chat stopped during the provider outage', await panel(p))
      await shot(p, 's5-outage')
    }
    const setB1 = await channelSet(env, keyB)
    info(`${keyB} during: ${JSON.stringify(setB1)}`)
    // back to the loaded channel: its refresh fails, its set must survive
    await p.goBack().catch(() => {})
    await sleep(15_000)
    const setA1 = await channelSet(env, keyA)
    info(`${keyA} after a failed refresh: ${JSON.stringify(setA1)}`)
    for (const [src, n] of Object.entries(setA0.bySource))
      if ((setA1.bySource[src] || 0) < n)
        bad(`${keyA}: a failed refresh dropped ${src} emotes (${n} → ${setA1.bySource[src] || 0})`, setA1)
    if (setA1.n >= setA0.n) ok(`${keyA} kept its ${setA0.n} emotes through a failed refresh`)

    // past one retry window with the providers still down: the retry must re-arm
    await sleep(Math.max(0, 100_000 - (Date.now() - t0)))
    // ── restore ──
    await workerOutage(env, false)
    cdnDown = false
    const restoredAt = Date.now()
    const lastKey = await p.evaluate(
      () =>
        (document.querySelector('#hs-mc-messages .hs-mc-msg:last-of-type') as HTMLElement | null)?.dataset.msgKey || '',
    )
    // forward again to the channel first seen during the outage, then leave it idle
    await p.goForward().catch(() => {})
    let setB2 = await channelSet(env, keyB)
    // judged by the set, not its stamp: a fetch where one provider is merely slow (ffz takes 10s+
    // at times) is stamped early on purpose so it retries, yet holds everything that answered
    const grew = (s: typeof setB2) => s.state === 'set' && s.n > setB1.n
    while (Date.now() - restoredAt < 200_000 && !grew(setB2)) {
      await sleep(10_000)
      setB2 = await channelSet(env, keyB)
    }
    info(`${keyB} after restore: ${JSON.stringify(setB2)} (${Math.round((Date.now() - restoredAt) / 1000)}s)`)
    if (grew(setB2)) ok(`${keyB} got its emotes once the providers came back (${setB1.n} → ${setB2.n})`)
    else bad(`${keyB} never got its emotes within 200s of the providers coming back`, setB2)

    const imgs = await newRowImages(p, lastKey)
    info(`emote images in rows after the restore: ${JSON.stringify(imgs)}`)
    if (imgs.broken) bad(`${imgs.broken} emote images in rows that arrived after the outage are broken`, imgs)
    const ring = await ringSince(p, t0)
    if (ring.bad.length) bad('overlay watchdogs fired across the outage', ring.bad.slice(0, 6))
    if (errs.length) bad('page errors', errs.slice(0, 5))
  } finally {
    await env.close()
  }
}

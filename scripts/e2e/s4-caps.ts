/**
 * s4 — more channels than the caches hold: 25 saved channels (twitch and kick), every
 * one opened from the panel's tab strip in turn, while one stream stays on screen.
 *
 * Bugs of this shape that shipped: the channel emote cache (20 sets) evicted in insertion
 * order, so the stream watched longest lost its set and its emotes turned back into text
 * "after a while" (96a04361, #5).
 *
 * Invariants, checked each time the reader comes back to the stream:
 *   - the stream's emote set is still in the worker
 *   - its rows draw that set's emotes as images, not as their names in text
 *   - the cache holds 20 sets, or the ones in use when more are (never evicts a shown one)
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
  type SavedChannel,
  saveChannels,
  scenario,
  shot,
  sleep,
  waitPanel,
  watchErrors,
} from './lib'

async function cacheState(env: Env, key: string) {
  return env
    .worker()
    .evaluate((k: string) => {
      // @ts-ignore — worker globals
      const m = channelEmotesMap
      const keys = Object.keys(m).filter((x) => Array.isArray(m[x]))
      const set = Array.isArray(m[k]) ? m[k] : null
      // names only an emote would have: 4+ chars with a capital or digit after the first. twitch's
      // own (sub) emotes draw only with the line's emote tag, so a name alone proves nothing
      const names = set
        ? set
            .filter((e: any) => e?.source !== 'twitch')
            .map((e: any) => String(e?.name || ''))
            .filter((n: string) => n.length >= 4 && /.[A-Z0-9]/.test(n))
        : []
      // @ts-ignore
      const inUse = new Set(
        [...joinedExtraChannels, ...[...tabChannels.values()].map((t: any) => t?.channel)].filter(Boolean),
      )
      return { held: keys.length, inUse: inUse.size, has: !!set, n: set ? set.length : 0, names }
    }, key)
    .catch((e: unknown) => ({ held: -1, inUse: 0, has: false, n: 0, names: [] as string[], err: String(e) }))
}

/** In the newest rows: set names drawn as images vs left as plain text. */
async function emoteText(p: any, names: string[]) {
  return p.evaluate((list: string[]) => {
    const set = new Set(list)
    const rows = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].slice(-150) as HTMLElement[]
    let asImg = 0
    let asText = 0
    const sample: string[] = []
    for (const r of rows) {
      const body = r.querySelector('.hs-mc-text')
      if (!body) continue
      for (const img of body.querySelectorAll('img')) if (set.has(img.getAttribute('alt') || '')) asImg++
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode())
        for (const w of (n.textContent || '').split(/\s+/))
          if (set.has(w)) {
            asText++
            if (sample.length < 6) sample.push(w)
          }
    }
    return { rows: rows.length, asImg, asText, sample }
  }, names)
}

export async function s4Caps() {
  scenario('s4 more channels than the caches hold')
  const tw = await liveChannels('twitch', 18)
  const kk = await liveChannels('kick', 7)
  let watched = tw[0]
  const saved: SavedChannel[] = [
    ...tw.map((t) => ({ id: t, twitch: t })),
    ...kk.map((k) => ({ id: `k-${k}`, kick: k })),
  ]
  const env = await launch()
  const errs: string[] = []
  try {
    await saveChannels(env, saved)
    const p = await env.ctx.newPage()
    watchErrors(p, 'twitch', errs)
    await p.goto(`https://www.twitch.tv/${watched}`, { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(p))) return bad('panel never mounted on the watched stream')
    if (!(await rowsFlow(p, 45_000))) return bad('the watched stream never flowed')
    await sleep(15_000)
    // watch the busiest channel with the biggest set: a 17-emote channel proves nothing
    const sizes: Record<string, number> = await env.worker().evaluate(
      (names: string[]) => {
        const out: Record<string, number> = {}
        // @ts-ignore — worker global
        for (const n of names)
          out[n] = Array.isArray(channelEmotesMap[`twitch/${n}`]) ? channelEmotesMap[`twitch/${n}`].length : 0
        return out
      },
      tw.slice(0, 6),
    )
    const best = Object.entries(sizes).sort((a, b) => b[1] - a[1])[0]?.[0]
    if (best && best !== watched) {
      watched = best
      await p.goto(`https://www.twitch.tv/${watched}`, { waitUntil: 'domcontentloaded' })
      if (!(await waitPanel(p)) || !(await rowsFlow(p, 45_000))) return bad(`${watched} never flowed`)
      await sleep(15_000)
    }
    const key = `twitch/${watched}`
    info(`watching ${watched} (sets: ${JSON.stringify(sizes)})`)
    let s0 = await cacheState(env, key)
    if (!s0.has) {
      // slow or never: a set that lands within a minute is a slow first fetch (25 channels join at
      // once), one that never lands is lost
      const t = Date.now()
      while (!s0.has && Date.now() - t < 60_000) {
        await sleep(5000)
        s0 = await cacheState(env, key)
      }
      info(`${key}: no set 15s after its chat flowed; ${s0.has ? `landed ${Math.round((Date.now() - t) / 1000)}s later` : 'still none after 60s more'} (sets then: ${JSON.stringify(sizes)})`)
    }
    const e0 = await emoteText(p, s0.names)
    info(`start: ${JSON.stringify({ held: s0.held, set: s0.n, ...e0 })}`)
    if (!s0.has) return bad(`${key} has no emote set at the start`, s0)
    // history drawn before the set landed must have picked it up by now (history-rows-take-late-emotes)
    if (e0.asText > 2) bad(`the watched stream shows ${e0.asText} of its emote names as text at the start`, e0)
    const t0 = Date.now()

    const others = saved.filter((c) => c.id !== watched)
    for (let lap = 0; lap < Number(process.env.E2E_S4_LAPS || 2); lap++) {
      for (let i = 0; i < others.length; i++) {
        const tab = await p.$(`.hs-mc-tab[data-tab="${others[i].id}"]`)
        if (!tab) {
          if (lap === 0 && i === 0)
            info(
              `no tab for ${others[i].id} in the strip — tabs: ${(await p.$$eval('.hs-mc-tab[data-tab]', (t: Element[]) => t.map((x) => (x as HTMLElement).dataset.tab))).join(',')}`,
            )
          continue
        }
        await tab.click().catch(() => {})
        await sleep(6000)
        // back to the stream every few channels, the way a reader glances back
        if (i % 6 === 5 || i === others.length - 1) {
          // the stream's own saved tab: the live tab hides under a saved tab that covers it, and a
          // click on a hidden tab leaves the reader where they were
          const back = (await p.$(`.hs-mc-tab[data-tab="${watched}"]`)) ? watched : 'live'
          await p.click(`.hs-mc-tab[data-tab="${back}"]`, { timeout: 5000 }).catch(() => {})
          await sleep(3000)
          const on = (await panel(p)).activeTab
          if (on !== back) info(`lap ${lap}: the click back to ${back} landed on ${on}`)
          if (!(await rowsFlow(p, 30_000))) {
            bad(`lap ${lap}: back on the stream after ${i + 1} other channels, its chat is still`, await panel(p))
            await shot(p, `s4-still-lap${lap}-${i}`)
          }
          const s = await cacheState(env, key)
          const e = await emoteText(p, s.names.length ? s.names : s0.names)
          info(
            `lap ${lap} after ${i + 1}: ${JSON.stringify({ held: s.held, set: s.n, img: e.asImg, text: e.asText, sample: e.sample })}`,
          )
          if (!s.has) bad(`lap ${lap}: ${key} lost its emote set after ${i + 1} other channels opened`, s)
          if (e.asText > 2) {
            bad(`lap ${lap}: the watched stream shows emote names as text`, e)
            await shot(p, `s4-text-lap${lap}-${i}`)
          }
          if (s.held > Math.max(20, s.inUse) + 2)
            bad(`lap ${lap}: the emote cache holds ${s.held} sets (cap 20, ${s.inUse} in use)`)
        }
      }
    }
    const end = await cacheState(env, key)
    if (end.has)
      ok(
        `${key} kept its emote set through ${Number(process.env.E2E_S4_LAPS || 2)} laps of ${others.length} other channels (cache held ${end.held})`,
      )
    const ring = await ringSince(p, t0)
    if (ring.bad.length) bad('overlay watchdogs fired during the churn', ring.bad.slice(0, 6))
    if (errs.length) bad('page errors', errs.slice(0, 5))
  } finally {
    await env.close()
  }
}

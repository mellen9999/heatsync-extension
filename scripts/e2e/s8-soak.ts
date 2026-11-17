/**
 * s8 — an hour with three sites open: s1's tabs left running, the front tab changing every
 * few minutes, the way a long evening of watching goes. The bugs ennortix hit mostly showed
 * up hours in, past anything a fixture test or a 6-minute scenario runs.
 *
 * Sampled every 5 minutes; growth is judged from the end of a 10-minute warm-up:
 *   - the tab brought to the front has chat flowing
 *   - watchdogs stay quiet in every tab, the worker's hs_errors stays empty
 *   - the worker's heap after a full gc stops growing (read over the browser's devtools port)
 *   - the panel's listeners, and the page's window/document listeners, stay flat
 *   - the panel's nodes per row stay flat (a slow chat fills to the row cap: count alone grows)
 *   The extension process's memory is logged as context, not judged: playwright attaches to the
 *   worker, and devtools then keeps every fetch it makes (NetworkResourcesData, blink_gc/workers,
 *   ~3MB/min with busy tabs). Unattached, the same tabs hold it flat (11-16: 1.1→1.3MB in 22 min).
 *   Chrome's own breakdown (memory-infra) still names the allocator if something else grows.
 *
 *   E2E_S8_MIN=60 bun scripts/e2e/run.ts --only s8   # inside heavy, under a MemoryMax scope
 */
import { readdirSync, readFileSync } from 'node:fs'
import {
  bad,
  type Env,
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
  swState,
  waitPanel,
  watchErrors,
} from './lib'

const WARMUP_MS = 10 * 60_000
const EVERY_MS = 5 * 60_000

/** A process's own memory (proportional share), in MB; 0 once it is gone. */
function pssMb(pid: number) {
  try {
    const m = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))
    return m ? Math.round(Number(m[1]) / 1024) : 0
  } catch {
    return 0
  }
}

/** This run's chromium tree: the browser holding our profile, and its extension process. */
function chromeProcs(profile: string) {
  const all: { pid: number; ppid: number; cmd: string }[] = []
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    try {
      const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8').replaceAll('\0', ' ')
      const ppid = Number(readFileSync(`/proc/${d}/stat`, 'utf8').split(') ')[1]?.split(' ')[1])
      all.push({ pid: Number(d), ppid, cmd })
    } catch {}
  }
  const root = all.find((p) => p.cmd.includes(`--user-data-dir=${profile}`) && !p.cmd.includes('--type='))
  if (!root) return { tree: 0, ext: 0, extPid: 0 }
  const mine = new Set([root.pid])
  for (let grew = true; grew; ) {
    grew = false
    for (const p of all)
      if (!mine.has(p.pid) && mine.has(p.ppid)) {
        mine.add(p.pid)
        grew = true
      }
  }
  const ext = all.find((p) => mine.has(p.pid) && p.cmd.includes('--extension-process'))
  let tree = 0
  for (const pid of mine) tree += pssMb(pid)
  return { tree, ext: ext ? pssMb(ext.pid) : 0, extPid: ext?.pid || 0 }
}

/** The worker's history rings and emote sets: each should stay bounded however long it runs. */
async function swRings(env: Env) {
  return env
    .worker()
    .evaluate(() => {
      const n = (m: any) => (m?.channels instanceof Map ? m.channels.size : -1)
      const rows = (m: any) => {
        let s = 0
        if (m?.channels instanceof Map) for (const b of m.channels.values()) s += b?.size || 0
        return s
      }
      // @ts-ignore — worker globals
      const g = { irc: BG_IRC, kick: BG_KICK, yt: BG_YT }
      return {
        rooms: { irc: n(g.irc), kick: n(g.kick), yt: n(g.yt) },
        rows: rows(g.irc) + rows(g.kick) + rows(g.yt),
        // @ts-ignore
        sets: Object.keys(channelEmotesMap).length,
      }
    })
    .catch((e: unknown) => ({ err: String(e) }))
}

/** The panel's nodes per row: rows are capped, and each row's markup should not grow. */
async function nodesPerRow(p: any) {
  return p
    .evaluate(() => {
      const ct = document.getElementById('hs-mc-container')
      const rows = document.querySelectorAll('#hs-mc-messages .hs-mc-msg').length
      return ct && rows ? Math.round((ct.getElementsByTagName('*').length / rows) * 10) / 10 : -1
    })
    .catch(() => -1)
}

/** Listeners on the panel's subtree (ours alone), and on window + document (shared with the site). */
async function listenerCounts(env: Env, p: any) {
  const s = await env.ctx.newCDPSession(p)
  const count = async (expr: string, depth: number) => {
    const { result } = await s.send('Runtime.evaluate', { expression: expr })
    if (!result?.objectId) return -1
    const { listeners } = await s.send('DOMDebugger.getEventListeners', { objectId: result.objectId, depth, pierce: true })
    return listeners.length
  }
  try {
    const panel = await count(`document.getElementById('hs-mc-container')`, -1)
    const host = (await count('window', 0)) + (await count('document', 0))
    return { panel, host }
  } catch {
    return { panel: -1, host: -1 }
  } finally {
    await s.detach().catch(() => {})
  }
}

/** A raw devtools socket: the browser's own endpoint or one target's. */
async function cdp(env: Env, pick: (port: string) => Promise<string | undefined>) {
  const port = readFileSync(`${env.profile}/DevToolsActivePort`, 'utf8').split('\n')[0]
  const url = await pick(port)
  if (!url) return null
  const ws = new WebSocket(url)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let id = 0
  const on = (method: string, cb: (params: any) => void) =>
    ws.addEventListener('message', (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data))
      if (m.method === method) cb(m.params)
    })
  const call = (method: string, params: object = {}) =>
    new Promise<any>((res) => {
      const my = ++id
      ws.addEventListener('message', function got(ev: MessageEvent) {
        const m = JSON.parse(String(ev.data))
        if (m.id !== my) return
        ws.removeEventListener('message', got)
        res(m.result)
      })
      ws.send(JSON.stringify({ id: my, method, params }))
    })
  return { call, on, close: () => ws.close() }
}

/** The worker's js heap after a full gc, in MB. */
async function workerHeapMb(env: Env): Promise<number> {
  try {
    const w = await cdp(env, async (port) => {
      const list: any[] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      return list.find((x) => x.type === 'service_worker' && x.url.includes(env.extId))?.webSocketDebuggerUrl
    })
    if (!w) return -1
    await w.call('HeapProfiler.enable')
    await w.call('HeapProfiler.collectGarbage')
    const r = await w.call('Runtime.getHeapUsage')
    w.close()
    return Math.round((r.usedSize / 1048576) * 10) / 10
  } catch {
    return -1
  }
}

/**
 * Chrome's own memory breakdown for one process (a memory-infra dump): its footprint and
 * each allocator's size in MB (malloc, partition_alloc, v8, blink_gc, ...), two levels deep.
 * What tells "v8 keeps freed pages" from a leak outside the js heap.
 */
async function memoryBreakdown(env: Env, pid: number): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const b = await cdp(env, async (port) => (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl).catch(() => null)
  if (!b || !pid) return out
  try {
    const events: any[] = []
    b.on('Tracing.dataCollected', (p) => events.push(...p.value))
    const done = new Promise((res) => b.on('Tracing.tracingComplete', res))
    await b.call('Tracing.start', {
      traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], memoryDumpConfig: { triggers: [] } },
      transferMode: 'ReportEvents',
    })
    await b.call('Tracing.requestMemoryDump', { deterministic: true, levelOfDetail: 'detailed' })
    await b.call('Tracing.end')
    await Promise.race([done, sleep(20_000)])
    const mb = (hex: unknown) => Math.round((Number.parseInt(String(hex), 16) / 1048576) * 10) / 10
    for (const e of events) {
      if (e.ph !== 'v' || e.pid !== pid) continue
      const d = e.args?.dumps
      if (d?.process_totals?.private_footprint_bytes) out.footprint = mb(d.process_totals.private_footprint_bytes)
      for (const [name, node] of Object.entries<any>(d?.allocators || {})) {
        const v = node?.attrs?.size?.value
        // shared_memory's children are one per segment id: noise, the parent carries the total
        if (v && name.split('/').length <= 2 && !name.startsWith('shared_memory/')) out[name] = mb(v)
      }
    }
  } finally {
    b.close()
  }
  return out
}

/** The allocators that grew most between two breakdowns. */
function grewMost(a: Record<string, number>, b: Record<string, number>, n = 8) {
  return Object.keys(b)
    .map((k) => [k, Math.round((b[k] - (a[k] || 0)) * 10) / 10] as const)
    .filter(([, d]) => d > 1)
    .sort((x, y) => y[1] - x[1])
    .slice(0, n)
    .map(([k, d]) => `${k} +${d}`)
}

/** Lowest of the first and last three samples: one GC landing late moves neither. */
function growth(xs: number[]) {
  const v = xs.filter((x) => x > 0)
  if (v.length < 4) return null
  const from = Math.min(...v.slice(0, 3))
  const to = Math.min(...v.slice(-3))
  return { from, to, pct: Math.round(((to - from) / from) * 100) }
}

export async function s8Soak() {
  scenario('s8 an hour with three sites open')
  const tw = await liveChannels('twitch', 3)
  const kk = await liveChannels('kick', 3)
  const yt = await liveYtVideo()
  const minutes = Number(process.env.E2E_S8_MIN || 60)
  const env = await launch({ args: ['--remote-debugging-port=0'] })
  const errs: string[] = []
  try {
    await saveChannels(env, [
      { id: tw[1], twitch: tw[1] },
      { id: tw[2], twitch: tw[2] },
      { id: `k-${kk[1]}`, kick: kk[1] },
      { id: `k-${kk[2]}`, kick: kk[2] },
      ...(yt ? [{ id: 'yt-lofi', youtube: yt.handle }] : []),
      { id: `mix-${tw[0]}`, twitch: tw[0], kick: kk[0] },
    ])
    const tabs = [
      { name: `twitch ${tw[0]}`, url: `https://www.twitch.tv/${tw[0]}` },
      { name: `kick ${kk[0]}`, url: `https://kick.com/${kk[0]}` },
      ...(yt ? [{ name: `youtube ${yt.handle}`, url: `https://www.youtube.com/watch?v=${yt.id}` }] : []),
    ]
    const pages: any[] = []
    for (const t of tabs) {
      const p = await env.ctx.newPage()
      watchErrors(p, t.name, errs)
      await p.goto(t.url, { waitUntil: 'domcontentloaded' })
      if (!(await waitPanel(p))) bad(`${t.name}: panel never mounted`)
      pages.push(p)
    }

    const t0 = Date.now()
    const end = t0 + minutes * 60_000
    const ext: number[] = []
    const tree: number[] = []
    const heap: number[] = []
    let firstDump: Record<string, number> | null = null
    let lastDump: Record<string, number> = {}
    const ours: number[][] = pages.map(() => [])
    const host: number[][] = pages.map(() => [])
    const perRow: number[][] = pages.map(() => [])
    let extPid = 0
    let rot = 0
    let still = 0
    while (Date.now() < end) {
      const i = rot % pages.length
      await pages[i].bringToFront()
      // a thin youtube chat (lofi at night: ~5 lines a minute) can say nothing for 45s; nothing in
      // 105s is a stop
      if (!(await rowsFlow(pages[i], 45_000)) && !(await rowsFlow(pages[i], 60_000))) {
        still++
        bad(`minute ${Math.round((Date.now() - t0) / 60_000)}: ${tabs[i].name} came to the front with its chat still`, await panel(pages[i]))
        await shot(pages[i], `s8-still-${rot}`)
      }
      if (Date.now() - t0 >= WARMUP_MS) {
        const mem = chromeProcs(env.profile)
        if (extPid && mem.extPid && mem.extPid !== extPid) {
          info(`the extension process changed (${extPid} → ${mem.extPid}): the worker restarted, growth restarts from here`)
          ext.length = 0
          heap.length = 0
        }
        extPid = mem.extPid || extPid
        ext.push(mem.ext)
        tree.push(mem.tree)
        heap.push(await workerHeapMb(env))
        lastDump = await memoryBreakdown(env, mem.extPid)
        firstDump ??= lastDump
        for (let j = 0; j < pages.length; j++) {
          const c = await listenerCounts(env, pages[j])
          ours[j].push(c.panel)
          host[j].push(c.host)
          perRow[j].push(await nodesPerRow(pages[j]))
        }
        const sw = await swRings(env)
        info(
          `minute ${Math.round((Date.now() - t0) / 60_000)}: worker heap ${heap.at(-1)}MB (process ${mem.ext}MB, footprint ${lastDump.footprint ?? '?'}MB), chromium ${mem.tree}MB, panel listeners ${ours.map((l) => l.at(-1)).join('/')}, window+document ${host.map((l) => l.at(-1)).join('/')}, nodes/row ${perRow.map((n) => n.at(-1)).join('/')}, worker ${JSON.stringify(sw)}`,
        )
      }
      rot++
      await sleep(Math.min(EVERY_MS, Math.max(0, end - Date.now())))
    }

    if (!still) ok(`every tab had chat flowing each time it came to the front (${rot} rotations)`)
    const h = growth(heap)
    if (!h) bad('too few samples of the worker heap to judge its growth', { heap })
    else if (h.to - h.from > 15 && h.pct > 25) bad(`the worker heap grew ${h.from}→${h.to}MB (+${h.pct}%) after warm-up`, heap)
    else ok(`the worker heap held ${h.from}→${h.to}MB after warm-up`)
    const e = growth(ext)
    if (e) info(`the extension process ${e.from}→${e.to}MB (+${e.pct}%)`)
    if (firstDump) info(`extension process, chrome's breakdown grew most: ${grewMost(firstDump, lastDump).join(', ') || 'nothing over 1MB'}`)
    const t = growth(tree)
    if (t) info(`chromium as a whole ${t.from}→${t.to}MB (+${t.pct}%, mostly the sites' own pages)`)
    for (let j = 0; j < pages.length; j++) {
      const l = growth(ours[j])
      if (l && l.to - l.from > 50 && l.pct > 50) bad(`${tabs[j].name}: the panel's listeners grew ${l.from}→${l.to}`, ours[j])
      const w = growth(host[j])
      if (w && w.to - w.from > 50 && w.pct > 50) bad(`${tabs[j].name}: window+document listeners grew ${w.from}→${w.to}`, host[j])
      const n = growth(perRow[j])
      if (n && n.pct > 50) bad(`${tabs[j].name}: the panel's nodes per row grew ${n.from}→${n.to}`, perRow[j])
      const ring = await ringSince(pages[j], t0)
      if (ring.bad.length) bad(`${tabs[j].name}: overlay watchdogs fired`, ring.bad.slice(0, 6))
    }
    const st: any = await swState(env)
    if (st.errs?.length) bad('the worker logged errors', st.errs.slice(0, 5))
    if (errs.length) bad('page errors', errs.slice(0, 5))
  } finally {
    await env.close()
  }
}

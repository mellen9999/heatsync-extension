/**
 * How smooth is the chat resize drag on a REAL twitch channel page?
 *
 *   bun run build.js chrome --minify && CHROMIUM_BIN=/usr/bin/chromium bun scripts/drag-bench.ts [channel=primevideo] [cpu=1]
 *
 * interaction-ext.ts runs on a fixture page; the resize drag's cost is mostly
 * twitch's own tree reacting, so this one loads the live channel. Real input
 * (CDP mouse), same 40-step drag as a hand, frame gaps read in-page, compared
 * against the same window of idle frames.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertBuilt, launchWithExtension, withTimeout } from './lib/chromium'

assertBuilt()

/** Self and total time per function, extension frames first. */
function dumpProfile(p: any) {
  const byId = new Map(p.nodes.map((n: any) => [n.id, n]))
  const parent = new Map<number, number>()
  for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id)
  const self = new Map<number, number>()
  for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i], (self.get(p.samples[i]) || 0) + (p.timeDeltas[i] || 0) / 1000)
  const key = (n: any) => `${n.callFrame.functionName || '(anon)'} ${String(n.callFrame.url).split("/").pop()}:${n.callFrame.lineNumber}:${n.callFrame.columnNumber}`
  const selfBy: Record<string, number> = {}
  const totalBy: Record<string, number> = {}
  for (const [id, ms] of self) {
    const n: any = byId.get(id)
    selfBy[key(n)] = (selfBy[key(n)] || 0) + ms
    const seen = new Set<string>()
    for (let cur: any = n; cur; cur = byId.get(parent.get(cur.id)!)) {
      const k = key(cur)
      if (!seen.has(k)) totalBy[k] = (totalBy[k] || 0) + ms
      seen.add(k)
    }
  }
  const top = (o: Record<string, number>, f: (k: string) => boolean) => Object.entries(o).filter(([k]) => f(k)).sort((a, b) => b[1] - a[1]).slice(0, 18)
  console.log('profile self ms (all):')
  for (const [k, ms] of top(selfBy, () => true)) console.log(`  ${ms.toFixed(1).padStart(8)}  ${k}`)
  console.log('profile total ms (extension):')
  for (const [k, ms] of top(totalBy, (k) => k.includes('multichat-core'))) console.log(`  ${ms.toFixed(1).padStart(8)}  ${k}`)
}

/** Top trace events by self-ish duration on the renderer main thread in the release window. */
async function dumpTrace(cdp: any) {
  const done = new Promise<string>((res) => cdp.once('Tracing.tracingComplete', (e: any) => res(e.stream)))
  await cdp.send('Tracing.end')
  const stream = await done
  let buf = ''
  for (;;) {
    const r = await cdp.send('IO.read', { handle: stream })
    buf += r.base64Encoded ? Buffer.from(r.data, 'base64').toString() : r.data
    if (r.eof) break
  }
  const evs = (JSON.parse(buf).traceEvents || buf) as any[]
  const main = evs.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain')
  const agg: Record<string, [number, number]> = {}
  for (const e of evs) {
    if (e.ph !== 'X' || !e.dur || (main && (e.pid !== main.pid || e.tid !== main.tid))) continue
    const k = e.name + (e.args?.data?.url ? ' ' + String(e.args.data.url).split('/').pop()?.slice(0, 40) : '') + (e.args?.data?.functionName ? ' ' + e.args.data.functionName : '')
    const a = (agg[k] ||= [0, 0])
    a[0] += e.dur / 1000
    a[1]++
  }
  console.log('release trace — main thread, top by total ms:')
  for (const [k, [ms, n]] of Object.entries(agg).sort((a, b) => b[1][0] - a[1][0]).slice(0, 25)) console.log(`  ${ms.toFixed(1).padStart(8)}ms x${n}  ${k}`)
}
const CHANNEL = process.argv[2] || 'primevideo'
const CPU = Number(process.argv[3] || 1)
const profile = mkdtempSync(join(tmpdir(), 'hs-drag-bench-'))
const ctx = await launchWithExtension(profile, ['--window-size=1600,1000'])
try {
  const page = ctx.pages()[0] || (await ctx.newPage())
  await page.setViewportSize({ width: 1600, height: 1000 })
  const cdp = await ctx.newCDPSession(page)
  await page.goto(`https://www.twitch.tv/${CHANNEL}`, { waitUntil: 'domcontentloaded' })
  await withTimeout(page.waitForSelector('#hs-mc-resize-handle', { timeout: 60_000 }), 70_000, 'handle')
  await page.waitForTimeout(8000)
  // the extension opens its welcome tab on install, which backgrounds this one
  // and throttles rAF to 1Hz
  for (const p of ctx.pages()) if (p !== page) await p.close()
  await page.bringToFront()
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU })

  // frame gaps + long-frame attribution, tagged by phase
  await page.evaluate(() => {
    const w = window as any
    w.__ph = 'warm'
    w.__frames = []
    w.__loaf = []
    let last = performance.now()
    const tick = (t: number) => {
      w.__frames.push([w.__ph, t - last])
      last = t
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as any[]) {
        const ext = (e.scripts || []).filter((s: any) => /chrome-extension/.test(s.sourceURL)).reduce((a: number, s: any) => a + s.duration, 0)
        const all = (e.scripts || []).reduce((a: number, s: any) => a + s.duration, 0)
        w.__loaf.push([w.__ph, e.duration, ext, all - ext, e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0])
      }
    }).observe({ type: 'long-animation-frame' })
  })
  const phase = (p: string) => page.evaluate((x) => ((window as any).__ph = x), p)
  const box = (await page.locator('#hs-mc-resize-handle').boundingBox())!
  const x0 = box.x + box.width / 2
  const y = box.y + 300

  const sweep = async (from: number, dx: number) => {
    for (let i = 1; i <= 40; i++) {
      await page.mouse.move(from + (dx * i) / 40, y)
      await page.waitForTimeout(16)
    }
  }

  for (let run = 0; run < 3; run++) {
    await phase('idle')
    await page.mouse.move(x0 - 200, y)
    await page.waitForTimeout(700)
    await page.mouse.move(x0, y)
    await phase('drag')
    await page.mouse.down()
    await sweep(x0, -150)
    await phase('release')
    const trace = process.env.TRACE && run === 2
    if (process.env.PROF && run === 2) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start') }
    if (trace) await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,v8.execute,blink.user_timing,cc,viz', transferMode: 'ReturnAsStream' })
    await page.mouse.up()
    await page.waitForTimeout(800)
    if (trace) await dumpTrace(cdp)
    if (process.env.PROF && run === 2) dumpProfile((await cdp.send('Profiler.stop')).profile)
    // put the width back
    await phase('restore')
    await page.mouse.move(x0 - 150, y)
    await page.mouse.down()
    await sweep(x0 - 150, 150)
    await page.mouse.up()
    await page.waitForTimeout(600)
  }

  const { frames, loaf } = await page.evaluate(() => ({ frames: (window as any).__frames, loaf: (window as any).__loaf }))
  const pct = (v: number[], q: number) => (v.length ? [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * q))] : 0)
  console.log(`${CHANNEL} cpu x${CPU} — frame gap ms (p50 / p95 / max, frames>33ms) and long-frame ms (ext script / twitch script / style+layout)`)
  for (const ph of ['idle', 'drag', 'release']) {
    const g = frames.filter((f: any) => f[0] === ph).map((f: any) => f[1])
    const l = loaf.filter((f: any) => f[0] === ph)
    const sum = (i: number) => Math.round(l.reduce((a: number, f: any) => a + f[i], 0))
    console.log(
      `${ph.padEnd(8)} n=${String(g.length).padStart(4)}  ${pct(g, 0.5).toFixed(1)} / ${pct(g, 0.95).toFixed(1)} / ${Math.max(0, ...g).toFixed(1)}  >33:${g.filter((d: number) => d > 33).length}   long=${l.length} ext=${sum(2)} twitch=${sum(3)} layout=${sum(4)}`,
    )
  }
} finally {
  await ctx.close()
  rmSync(profile, { recursive: true, force: true })
}

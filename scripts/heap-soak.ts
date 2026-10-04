/**
 * Does a live channel tab retain memory with the extension on?
 *
 *   bun run test:heap [channel] [--no-ext] [--visible] [--minutes N]
 *
 * Opt-in, like e2e-live.ts: a real browser against a real busy channel. Every
 * 30s it reads the JS heap, forces a GC, and reads it again — pre is what a
 * user's tab really holds, post is what is RETAINED. A big pre/post gap is
 * allocation churn the collector hasn't reached yet, not a leak. Run once with
 * and once with --no-ext on the same channel; the post-GC difference is ours.
 *
 * Background tabs are the case that matters (a twitch tab sits behind others
 * for hours), but headless chromium never reports a tab hidden. So by default
 * the extension's own world is told it is hidden: document.hidden/hasFocus are
 * overridden in its isolated world only and a visibilitychange is fired, which
 * drives exactly the extension's hidden-tab path while twitch renders normally.
 * --visible skips that.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertBuilt, CHROME_BIN, launchWithExtension, loadChromium, withTimeout } from './lib/chromium'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const minutesAt = args.indexOf('--minutes')
const minutes = minutesAt >= 0 ? Number(args[minutesAt + 1]) : 5
const channel = args.find((a, i) => !a.startsWith('--') && (minutesAt < 0 || i !== minutesAt + 1)) || 'zackrawrr'
const noExt = flag('--no-ext')
const extHidden = !noExt && !flag('--visible')
const SAMPLE_MS = 30_000
const CDP_TIMEOUT_MS = 60_000

const HIDE_EXT_WORLD = `(() => {
  Object.defineProperty(document, 'hidden', { get: () => true, configurable: true })
  Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true })
  document.hasFocus = () => false
  document.dispatchEvent(new Event('visibilitychange'))
  return true
})()`

const profile = mkdtempSync(join(tmpdir(), 'hs-heap-soak-'))
let ctx: any
let code = 0
try {
  if (noExt) {
    const chromium = await loadChromium()
    ctx = await chromium.launchPersistentContext(profile, {
      executablePath: CHROME_BIN,
      headless: false,
      args: ['--headless=new', '--no-sandbox', '--window-size=1600,900'],
    })
  } else {
    assertBuilt()
    ctx = await launchWithExtension(profile, ['--window-size=1600,900'])
    if (!ctx.serviceWorkers()[0]) await ctx.waitForEvent('serviceworker', { timeout: 20_000 })
  }

  const p = await ctx.newPage()
  const cdp = await ctx.newCDPSession(p)
  // Runtime before navigating, or the extension's executionContextCreated is missed.
  const extContexts = new Set<number>()
  cdp.on('Runtime.executionContextCreated', ({ context }: any) => {
    if (context.auxData?.type === 'isolated' && String(context.origin).startsWith('chrome-extension://')) {
      extContexts.add(context.id)
    }
  })
  cdp.on('Runtime.executionContextsCleared', () => extContexts.clear())
  await withTimeout(cdp.send('Runtime.enable'), CDP_TIMEOUT_MS, 'Runtime.enable')
  await withTimeout(cdp.send('Performance.enable'), CDP_TIMEOUT_MS, 'Performance.enable')
  await p.goto(`https://www.twitch.tv/${channel}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await new Promise((r) => setTimeout(r, 15_000))

  if (extHidden) {
    if (!extContexts.size) throw new Error('no extension isolated world on the page — did the content script inject?')
    for (const contextId of extContexts) {
      await withTimeout(
        cdp.send('Runtime.evaluate', { expression: HIDE_EXT_WORLD, contextId }),
        CDP_TIMEOUT_MS,
        'hide ext world',
      )
    }
  }

  const metrics = async () => {
    const { metrics: m } = await withTimeout(cdp.send('Performance.getMetrics'), CDP_TIMEOUT_MS, 'getMetrics')
    return (n: string) => m.find((x: any) => x.name === n)?.value ?? 0
  }
  const overlayCount = () =>
    withTimeout(
      p.evaluate(() => document.querySelectorAll('#hs-mc-overlay *').length),
      CDP_TIMEOUT_MS,
      'overlay count',
    )

  console.log(`heap-soak: #${channel} ext=${!noExt} extHidden=${extHidden} ${minutes}min, every ${SAMPLE_MS / 1000}s`)
  console.log('t_s\tpre_gc_mb\tpost_gc_mb\tscript_s\tnodes\toverlay')
  const t0 = Date.now()
  const rows: { t: number; post: number }[] = []
  let lastScript = (await metrics())('ScriptDuration')
  while (Date.now() - t0 <= minutes * 60_000) {
    const pre = (await metrics())('JSHeapUsedSize') / 1e6
    await withTimeout(cdp.send('HeapProfiler.collectGarbage'), CDP_TIMEOUT_MS, 'collectGarbage')
    const get = await metrics()
    const post = get('JSHeapUsedSize') / 1e6
    const script = get('ScriptDuration') - lastScript
    lastScript = get('ScriptDuration')
    const t = Math.round((Date.now() - t0) / 1000)
    rows.push({ t, post })
    console.log(`${t}\t${pre.toFixed(1)}\t${post.toFixed(1)}\t${script.toFixed(2)}\t${get('Nodes')}\t${await overlayCount()}`)
    await new Promise((r) => setTimeout(r, SAMPLE_MS))
  }
  // Least-squares slope, so one GC that lands late doesn't decide the verdict.
  const n = rows.length
  const mt = rows.reduce((a, r) => a + r.t, 0) / n
  const mh = rows.reduce((a, r) => a + r.post, 0) / n
  const den = rows.reduce((a, r) => a + (r.t - mt) ** 2, 0)
  const slope = den ? rows.reduce((a, r) => a + (r.t - mt) * (r.post - mh), 0) / den : 0
  console.log(`retained slope: ${(slope * 60).toFixed(2)} MB/min (post-GC)`)
} catch (e) {
  console.error(`✗ ${(e as Error).message}`)
  code = 1
} finally {
  await withTimeout(ctx?.close() ?? Promise.resolve(), 20_000, 'browser close').catch(() => {})
  rmSync(profile, { recursive: true, force: true })
}
process.exit(code)

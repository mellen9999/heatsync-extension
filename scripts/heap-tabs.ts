/**
 * Does closing stream tabs give the memory back?
 *
 *   bun run test:heap-tabs [--tabs N] [--settle S] [ch1 ch2 ...]
 *
 * Opt-in, like heap-soak.ts: a real browser against real busy channels (the
 * top live twitch channels when none are named). Opens N stream tabs, lets
 * them settle, measures, closes all but the first, waits out the release
 * grace, measures again.
 *
 * What it checks, after the close:
 *   - the service worker holds a buffer only for the channel still open
 *     (it used to keep every channel watched in the last day, 3000 msgs each,
 *     still JOINed and still persisting every 1.5s)
 *   - the surviving tab shows no auto-tab for a stream that is gone (each
 *     tab's auto-tab join counted as "open", so they kept each other alive)
 * Then it stops the service worker: the woken SW holds no rings (they are
 * read per join), so the surviving tab must re-assert its channel, or its
 * chat goes silent.
 * Any renderer crash fails the run too. Exit 1 on any.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertBuilt, launchWithExtension, withTimeout } from './lib/chromium'

const args = process.argv.slice(2)
const opt = (name: string, dflt: number) => {
  const i = args.indexOf(name)
  return i >= 0 ? Number(args[i + 1]) : dflt
}
const nTabs = opt('--tabs', 4)
const settleS = opt('--settle', 90)
const optVals = new Set(['--tabs', '--settle'].map((f) => args[args.indexOf(f) + 1]).filter(Boolean))
let channels = args.filter((a) => !a.startsWith('--') && !optVals.has(a))
// past the SW's release grace + the open-channel broadcast debounce
const AFTER_CLOSE_MS = 100_000
const CDP_TIMEOUT_MS = 60_000

if (!channels.length) {
  const r = await fetch('https://heatsync.org/api/live/top?platform=twitch&limit=20')
  const j = (await r.json()) as { streams?: { username: string }[] }
  channels = (j.streams || []).map((s) => s.username.toLowerCase())
}
channels = channels.slice(0, nTabs)
if (channels.length < 2) throw new Error('need at least 2 live channels')

const profile = mkdtempSync(join(tmpdir(), 'hs-heap-tabs-'))
let ctx: any
let code = 0
let crashes = 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const swState = async () => {
  const sw = ctx.serviceWorkers()[0]
  if (!sw) return null
  return withTimeout(
    sw.evaluate(() => {
      // @ts-expect-error top-level const of the SW's classic script
      const s = BG_IRC
      let msgs = 0
      for (const b of s.channels.values()) msgs += b.size || 0
      return {
        buffers: [...s.channels.keys()].sort(),
        msgs,
        interest: [...s.channelTabs.keys()].sort(),
        // @ts-expect-error marker set below, to tell a restarted SW apart
        restarted: !globalThis.__hsHeapTabsMark,
      }
    }),
    CDP_TIMEOUT_MS,
    'sw state',
  )
}

const tabState = async (p: any) => {
  // a background tab's renderer can sit on CDP calls until it is fronted
  await p.bringToFront()
  const cdp = await ctx.newCDPSession(p)
  await withTimeout(cdp.send('HeapProfiler.enable'), CDP_TIMEOUT_MS, 'HeapProfiler.enable')
  await withTimeout(cdp.send('HeapProfiler.collectGarbage'), CDP_TIMEOUT_MS, 'collectGarbage')
  await cdp.send('Performance.enable')
  const { metrics } = await withTimeout(cdp.send('Performance.getMetrics'), CDP_TIMEOUT_MS, 'getMetrics')
  const heap = (metrics.find((x: any) => x.name === 'JSHeapUsedSize')?.value ?? 0) / 1e6
  const autoTabs = await p.evaluate(() =>
    // auto-tab ids are `auto_<channel>`; the label also carries an unread count
    [...document.querySelectorAll<HTMLElement>('.hs-mc-tab-auto')].map((t) => (t.dataset.tab || '').replace(/^auto_/, '')),
  )
  await cdp.detach()
  return { heap, autoTabs }
}

const report = async (label: string, pages: any[]) => {
  console.log(`\n── ${label}`)
  for (const [i, p] of pages.entries()) {
    const s = await tabState(p)
    console.log(`tab #${channels[i]}\theap ${s.heap.toFixed(1)}MB\tauto-tabs ${s.autoTabs.length} [${s.autoTabs.join(' ')}]`)
  }
  const sw = await swState()
  console.log(`sw buffers ${sw?.buffers.length} (${sw?.msgs} msgs) [${sw?.buffers.join(' ')}]`)
  console.log(`sw interest [${sw?.interest.join(' ')}]`)
  return sw
}

try {
  assertBuilt()
  ctx = await launchWithExtension(profile, ['--window-size=1600,900', '--mute-audio'])
  // No video: chat is what's measured. (ttvnw.net is the video edge only —
  // emotes/avatars come from jtvnw.net.) Playwright passes
  // --disable-dev-shm-usage, so chromium's shared memory lives in /tmp — a
  // nearly-full /tmp quota kills every renderer's compositor at once.
  await ctx.route(/ttvnw\.net/, (r: any) => r.abort())
  if (!ctx.serviceWorkers()[0]) await ctx.waitForEvent('serviceworker', { timeout: 20_000 })
  console.log(`heap-tabs: ${channels.map((c) => `#${c}`).join(' ')} — settle ${settleS}s`)

  const pages: any[] = []
  for (const ch of channels) {
    const p = await ctx.newPage()
    const t0 = Date.now()
    p.on('crash', () => {
      crashes++
      console.log(`✗ renderer for #${ch} crashed ${Math.round((Date.now() - t0) / 1000)}s after open`)
    })
    await p.goto(`https://www.twitch.tv/${ch}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    pages.push(p)
  }
  await sleep(settleS * 1000)
  await report(`${pages.length} tabs open`, pages)

  for (const p of pages.slice(1)) await p.close()
  await sleep(AFTER_CLOSE_MS)
  const sw = await report(`closed all but #${channels[0]}, waited ${AFTER_CLOSE_MS / 1000}s`, [pages[0]])

  const gone = new Set(channels.slice(1))
  const leftBuffers = (sw?.buffers || []).filter((c: string) => gone.has(c))
  const leftAuto = (await tabState(pages[0])).autoTabs.filter((t: string) => gone.has(t))
  console.log('')
  if (leftBuffers.length) console.log(`✗ sw still buffers closed streams: ${leftBuffers.join(' ')}`)
  if (leftAuto.length) console.log(`✗ surviving tab still shows auto-tabs for closed streams: ${leftAuto.join(' ')}`)
  if (leftBuffers.length || leftAuto.length) code = 1
  else console.log('✓ closed streams released')

  // @ts-expect-error marker on the current SW's global
  await ctx.serviceWorkers().at(-1).evaluate(() => (globalThis.__hsHeapTabsMark = 1))
  const cdp = await ctx.newCDPSession(pages[0])
  await withTimeout(cdp.send('ServiceWorker.enable'), CDP_TIMEOUT_MS, 'ServiceWorker.enable')
  await withTimeout(cdp.send('ServiceWorker.stopAllWorkers'), CDP_TIMEOUT_MS, 'stopAllWorkers')
  await sleep(30_000) // the keepalive alarm / any tab message wakes it
  const woke = await report('service worker stopped, waited 30s', [pages[0]])
  if (!woke?.restarted) console.log('✗ the service worker never restarted — check not run')
  else if (!woke.buffers.includes(channels[0]) || !woke.interest.includes(channels[0])) {
    console.log(`✗ restarted SW never got #${channels[0]} back — that tab's chat is silent`)
  } else console.log(`✓ restarted SW re-joined #${channels[0]}`)
  if (!woke?.restarted || !woke.buffers.includes(channels[0]) || !woke.interest.includes(channels[0])) code = 1
  if (crashes) code = 1
} catch (e) {
  console.error(`✗ ${(e as Error).message}`)
  code = 1
} finally {
  await withTimeout(ctx?.close() ?? Promise.resolve(), 20_000, 'browser close').catch(() => {})
  rmSync(profile, { recursive: true, force: true })
}
process.exit(code)

/**
 * Is the extension featherweight? Measured against hard budgets, in a real
 * browser, on real busy channels.
 *
 *   bun run test:heap-budget [--minutes 60] [--warmup 15] [--seed 12]
 *   bun run test:heap-budget:quick     # non-chat pages only, ~3min, no live channels
 *
 * 1. non-chat pages (twitch /directory, youtube /): the ext's JS heap cost,
 *    ext-on minus ext-off on the same page.
 * 2. lived-in: one tab walks N top channels first (fills the SW's emote map,
 *    caches, inventory — a fresh profile hides all of that), then two busy
 *    channel tabs soak for M minutes. Sampled every minute: each tab's retained
 *    heap, the SW's retained heap, shared memory per process role.
 *
 * Fails (exit 1) on any budget miss or any renderer crash. Budgets sit next to
 * the value they were set from; raise one only with the measurement that
 * justifies it. Opt-in: ~(M + 4) minutes, needs the network.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertBuilt, CHROME_BIN, launchWithExtension, loadChromium, withTimeout } from './lib/chromium'
import { procCpu, shmByRole, slopePerMin, swHeapMB, tabHeapMB } from './lib/heap'

const BUDGET = {
  nonChatMB: 5, // ext heap on a page with no chat
  swHeapMB: 15, // SW retained heap after the lived-in walk
  swShmMB: 20, // shared memory the SW process holds (was 1,800 on 10-13)
  tabSlopeMBPerMin: 0.1, // retained-heap growth per chat tab
  swSlopeMBPerMin: 0.05,
}

const args = process.argv.slice(2)
const opt = (name: string, dflt: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : dflt)
const quick = args.includes('--quick')
const minutes = opt('--minutes', 60)
// growth is judged after this: a busy channel's chat buffer (3000 msgs) fills
// for its first minutes — that rise is the cap being reached, not a leak
const warmup = opt('--warmup', 15)
const seedN = opt('--seed', 12)
if (minutes <= warmup) throw new Error('--minutes must exceed --warmup')
// bounds a whole probe child, launch to close
const PROBE_MS = 3 * 60_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const fails: string[] = []
const check = (label: string, value: number, max: number, unit = 'MB') => {
  const ok = value <= max
  console.log(`${ok ? '✓' : '✗'} ${label}: ${value.toFixed(2)}${unit} (budget ${max}${unit})`)
  if (!ok) fails.push(label)
}

const top = quick
  ? []
  : (((await (await fetch('https://heatsync.org/api/live/top?platform=twitch&limit=40')).json()) as any).streams.map(
      (s: any) => String(s.username).toLowerCase(),
    ) as string[])
if (!quick && top.length < seedN + 2) throw new Error(`need ${seedN + 2} live channels, got ${top.length}`)

let crashes = 0
const watch = (p: any, label: string) =>
  p.on('crash', () => {
    crashes++
    console.log(`✗ renderer crashed: ${label}`)
  })

// the second devtools transport (--remote-debugging-port) exists only for the
// SW heap probe, which the lived-in soak alone reads
async function launch(ext: boolean, profile: string, swProbe = false) {
  const ctx = ext
    ? await launchWithExtension(profile, swProbe ? ['--mute-audio', '--remote-debugging-port=0'] : ['--mute-audio'])
    : await (await loadChromium()).launchPersistentContext(profile, {
        executablePath: CHROME_BIN,
        headless: false,
        args: ['--headless=new', '--no-sandbox', '--mute-audio'],
      })
  // no video decoders: twitch's player memory is not what's measured
  await ctx.route(/ttvnw\.net|googlevideo\.com/, (r: any) => r.abort())
  if (ext && !ctx.serviceWorkers()[0]) await ctx.waitForEvent('serviceworker', { timeout: 20_000 })
  return ctx
}

const NON_CHAT_URLS = ['https://www.twitch.tv/directory', 'https://www.youtube.com/']

/** One probe: its own browser, one page, one number. Runs as a child (--probe). */
async function probe(ext: boolean, url: string) {
  const profile = mkdtempSync(join(tmpdir(), 'hs-budget-'))
  const ctx = await launch(ext, profile)
  try {
    const p = await withTimeout(ctx.newPage(), 30_000, 'newPage')
    watch(p, url)
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await sleep(30_000)
    try {
      return await tabHeapMB(ctx, p)
    } catch (e) {
      await hangReport(profile, p, url, ctx)
      throw e
    }
  } finally {
    await withTimeout(ctx.close(), 30_000, 'ctx.close').catch(() => {})
    rmSync(profile, { recursive: true, force: true })
  }
}

/**
 * Every probe is its own process. Four probes in one bun process lost the
 * ext-on browser each night on the hosted runner: its devtools pipe hit EOF
 * (chromium: "Connection terminated while reading from pipe", then a clean
 * exit) seconds after the first ext-on page closed, and every later call
 * talked to a corpse until bringToFront timed out. The same sequence in one
 * process stays alive when run alone, so the cause is cross-probe state in the
 * driver; separate processes share none, and a dead probe fails alone and fast.
 */
async function nonChatHeaps(ext: boolean) {
  const out: Record<string, number> = {}
  for (const url of NON_CHAT_URLS) {
    const child = Bun.spawn([process.execPath, import.meta.path, '--probe', ext ? 'on' : 'off', url], {
      stdout: 'pipe',
      stderr: 'inherit',
    })
    const killer = setTimeout(() => child.kill(), PROBE_MS)
    const text = await new Response(child.stdout).text()
    clearTimeout(killer)
    const code = await child.exited
    const mb = Number(text.match(/^HEAP (\S+)$/m)?.[1])
    process.stdout.write(text.replace(/^HEAP .*\n/m, ''))
    if (code !== 0 || !Number.isFinite(mb)) throw new Error(`probe ${ext ? 'ext on' : 'ext off'} ${url} failed (exit ${code})`)
    out[url] = mb
    console.log(`  ${ext ? 'ext on ' : 'ext off'}  ${url}  ${mb.toFixed(2)}MB`)
  }
  return out
}

/** A probe hung: say which chromium process was burning cpu, what was open, and whether the page answers. */
async function hangReport(profile: string, p: any, url: string, ctx: any) {
  const a = procCpu(profile)
  await sleep(5_000)
  const b = procCpu(profile)
  console.log(`  hang on ${url} — ${b.length} chromium process(es); cpu over 5s:`)
  for (const x of b) {
    const d = x.cpuS - (a.find((y) => y.pid === x.pid)?.cpuS ?? x.cpuS)
    console.log(`    ${x.role} ${x.pid}  ${d.toFixed(2)}s cpu  ${x.rssMB.toFixed(0)}MB rss  ${x.state} ${x.threads}t`)
  }
  console.log(`    pages: ${JSON.stringify(ctx.pages().map((x: any) => x.url()))}`)
  const state = await withTimeout(p.title(), 5_000, 'page.title').catch(() => 'not answering')
  console.log(`    page: ${state}`)
}

const probeAt = args.indexOf('--probe')
if (probeAt >= 0) {
  try {
    console.log(`HEAP ${await probe(args[probeAt + 1] === 'on', args[probeAt + 2])}`)
    process.exit(0)
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`)
    process.exit(1)
  }
}

let code = 0
try {
  assertBuilt()
  console.log('── non-chat pages')
  // a probe is ~45s healthy; the bound kills a wedged one into a ✗ and exit 1.
  // A hang left to the job timeout reports `cancelled`, which pages nobody.
  const off = await nonChatHeaps(false)
  const on = await nonChatHeaps(true)
  for (const url of Object.keys(off)) check(`ext heap on ${url}`, on[url] - off[url], BUDGET.nonChatMB)

  if (!quick) await livedIn()
  if (crashes) fails.push(`${crashes} renderer crash(es)`)
  console.log(fails.length ? `\n✗ over budget: ${fails.join(', ')}` : quick ? '\n✓ non-chat quick check' : '\n✓ featherweight')
  if (fails.length) code = 1
} catch (e) {
  console.error(`✗ ${(e as Error).message}`)
  code = 1
}
process.exit(code)

async function livedIn() {
  console.log(`── lived-in: walk ${seedN} channels, then soak 2 for ${minutes}min`)
  const profile = mkdtempSync(join(tmpdir(), 'hs-budget-'))
  const ctx = await launch(true, profile, true)
  try {
    const walker = await ctx.newPage()
    watch(walker, 'walker')
    for (const ch of top.slice(2, 2 + seedN)) {
      await walker.goto(`https://www.twitch.tv/${ch}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
      await sleep(15_000)
    }
    await walker.close()
    const tabs: { ch: string; p: any; rows: { t: number; y: number }[] }[] = []
    for (const ch of top.slice(0, 2)) {
      const p = await ctx.newPage()
      watch(p, ch)
      await p.goto(`https://www.twitch.tv/${ch}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
      tabs.push({ ch, p, rows: [] })
    }
    await sleep(60_000) // history hydrates, emotes land
    const sw: { t: number; y: number }[] = []
    let swShmMax = 0
    const t0 = Date.now()
    console.log('t_s\tsw_mb\tsw_shm\t' + tabs.map((t) => `#${t.ch}_mb`).join('\t') + '\trenderer_shm')
    for (;;) {
      const t = (Date.now() - t0) / 1000
      const swMb = (await swHeapMB(profile)) ?? Number.NaN
      const shm = shmByRole(profile)
      swShmMax = Math.max(swShmMax, shm.sw ?? 0)
      sw.push({ t, y: swMb })
      const heaps = []
      for (const tab of tabs) {
        const y = await tabHeapMB(ctx, tab.p)
        tab.rows.push({ t, y })
        heaps.push(y.toFixed(1))
      }
      console.log(`${Math.round(t)}\t${swMb.toFixed(1)}\t${(shm.sw ?? 0).toFixed(0)}\t${heaps.join('\t')}\t${(shm.renderer ?? 0).toFixed(0)}`)
      if (t >= minutes * 60) break
      await sleep(60_000)
    }
    check('sw heap (lived-in)', sw[sw.length - 1].y, BUDGET.swHeapMB)
    check('sw shared memory (peak)', swShmMax, BUDGET.swShmMB)
    const settled = (rows: { t: number; y: number }[]) => rows.filter((r) => r.t >= warmup * 60)
    check('sw heap growth', slopePerMin(settled(sw)), BUDGET.swSlopeMBPerMin, 'MB/min')
    for (const tab of tabs) check(`#${tab.ch} heap growth`, slopePerMin(settled(tab.rows)), BUDGET.tabSlopeMBPerMin, 'MB/min')
  } finally {
    await ctx.close().catch(() => {})
    rmSync(profile, { recursive: true, force: true })
  }
}

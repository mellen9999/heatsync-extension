/**
 * Cost of a busy merged tab (twitch + kick + youtube on one tab), in a real
 * browser, and proof that what the fast path leaves on screen is what a full
 * render would.
 *
 *   bun run build.js chrome --minify && bun scripts/merged-tab-bench.ts
 *   bun scripts/merged-tab-bench.ts --seconds 30 --twitch 30 --kick 6 --yt 3
 *   bun scripts/merged-tab-bench.ts --budget scripts/merged-tab-budget.json   # the nightly: fails over the limit
 *
 * Why it exists: a merged tab used to repaint the whole pane (the diff render,
 * up to 500 rows) once per frame while any platform was talking. This feeds a
 * busy tab through the real background-to-tab wire and reports what the page's
 * main thread spent per message (Chrome's own counters: script, layout, style,
 * total task time), plus long tasks and how many rows the browser added and
 * removed from the pane.
 *
 * Then the part that matters more than speed: it asks the overlay for a full
 * render (a setting that re-renders flips) and compares the rows on screen
 * before and after. The full render is the oracle — if the fast path left a
 * different set of rows, or a different order, the two snapshots differ and
 * the run fails.
 *
 * Opt-in like render-extension.ts: it needs a real browser binary. Nothing here
 * touches the network (heatsync.org is aborted) or a real profile.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertBuilt, launchWithExtension } from './lib/chromium'

const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? Number(process.argv[i + 1]) : dflt
}
const SECONDS = arg('seconds', 30)
const RATE = { twitch: arg('twitch', 30), kick: arg('kick', 6), yt: arg('yt', 3) }
const JSON_OUT = process.argv.includes('--json')
const PROFILE = process.argv.includes('--profile') // where the script time goes, by function
// a gate, not just a report: --budget scripts/merged-tab-budget.json fails the run when the main-thread
// time per message is over the file's limit (the baseline measured on a quiet machine, plus headroom)
const BUDGET_FILE = process.argv.includes('--budget') ? process.argv[process.argv.indexOf('--budget') + 1] : null

const CHAN = 'benchchan'
const fixture =
  '<!doctype html><html><head><title>fixture</title></head><body style="margin:0">' +
  '<div id="host-content" style="height:100vh">host page</div></body></html>'

function log(msg: string) {
  if (!JSON_OUT) console.log(msg)
}

assertBuilt()
const profile = mkdtempSync(join(tmpdir(), 'hs-ext-merged-bench-'))
const c = await launchWithExtension(profile, ['--window-size=1600,900'])
const pageErrors: string[] = []

try {
  await c.route('https://heatsync.org/**', (r: any) => r.abort())
  await c.route('https://www.twitch.tv/**', (r: any) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: fixture }),
  )
  let sw = c.serviceWorkers()[0]
  if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 20_000 })
  const extId = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
  if (!extId) throw new Error('could not resolve the extension id')

  // one saved channel linked on all three platforms, so the tab merges them
  const seed = await c.newPage()
  await seed.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' })
  await seed.evaluate(async (chan: string) => {
    // @ts-ignore — extension page
    await chrome.storage.local.set({
      heatsync_multichat: {
        channels: [{ id: chan, twitch: chan, kick: chan, youtube: 'https://www.youtube.com/watch?v=BENCHVID123' }],
      },
    })
  }, CHAN)
  await seed.close()

  const page = await c.newPage()
  page.on('pageerror', (e: unknown) => pageErrors.push(String(e).slice(0, 300)))
  await page.goto(`https://www.twitch.tv/${CHAN}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#hs-mc-messages', { timeout: 25_000 })
  await page.waitForTimeout(3000)

  // the driver lives in the extension's service worker and sends what the
  // background sends. A second tab would put the page under test in the
  // background, where its frames stop and the cost looks nothing like a viewer's.
  await page.bringToFront()
  const drv = sw
  await drv.evaluate(
    ({ chan }: { chan: string }) => {
      const w = globalThis as any
      const words = 'chat pog lets go nice one that was clean again no way real gg ez clip it wow hype run first try'.split(' ')
      const names = Array.from({ length: 240 }, (_, i) => `viewer${i}`)
      let seq = 0
      const text = () => {
        const n = 3 + (seq % 7)
        let s = ''
        for (let i = 0; i < n; i++) s += `${words[(seq * 7 + i * 3) % words.length]} `
        return `${s.trim()} #${seq}`
      }
      const build = {
        twitch: () => {
          seq++
          return {
            type: 'bg_irc_msg',
            msg: {
              id: `bt${seq}`,
              user: names[seq % names.length],
              text: text(),
              channel: chan,
              color: '#8888ff',
              badges: '',
              time: Date.now(),
            },
          }
        },
        kick: () => {
          seq++
          return {
            type: 'kick_chat_message',
            data: {
              id: `bk${seq}`,
              channel: chan,
              username: names[(seq * 3) % names.length],
              content: text(),
              color: '#00ff00',
              timestamp: Date.now(),
            },
          }
        },
        yt: () => {
          seq++
          return {
            type: 'youtube_chat_message',
            channelId: chan,
            id: `by${seq}`,
            user: names[(seq * 5) % names.length],
            text: text(),
            time: Date.now(),
          }
        },
      } as Record<string, () => any>
      w.__drive = (rates: Record<string, number>, ms: number) =>
        new Promise<Record<string, number>>((resolve) => {
          // @ts-ignore — service worker
          chrome.tabs.query({}, (tabs: any[]) => {
            const tab = tabs.find((x) => (x.url || '').includes('twitch.tv'))
            if (!tab) return resolve({ error: -1 })
            const sent: Record<string, number> = { twitch: 0, kick: 0, yt: 0 }
            const t0 = performance.now()
            const tick = () => {
              const el = performance.now() - t0
              for (const k of Object.keys(rates)) {
                const due = Math.floor((rates[k] * Math.min(el, ms)) / 1000)
                while (sent[k] < due) {
                  sent[k]++
                  // @ts-ignore
                  chrome.tabs.sendMessage(tab.id, build[k]())
                }
              }
              if (el >= ms) return resolve(sent)
              setTimeout(tick, 4)
            }
            tick()
          })
        })
    },
    { chan: CHAN },
  )

  // fill all three buffers past the render cap so the window is full and every
  // later message has to push an older one out
  log('warming up: filling the buffers past the render cap')
  await drv.evaluate(() => (globalThis as any).__drive({ twitch: 400, kick: 150, yt: 40 }, 2500))
  await page.waitForTimeout(6000) // the youtube pacer drips; let it drain
  const rowsAfterWarm = await page.evaluate(() => document.querySelectorAll('#hs-mc-messages .hs-mc-msg').length)
  log(`  rows on screen after warm-up: ${rowsAfterWarm}`)

  // churn: rows the browser added/removed, to tell a repaint from an append
  await page.evaluate(() => {
    const el = document.getElementById('hs-mc-messages')!
    const w = window as any
    w.__churn = { added: 0, removed: 0, batches: 0 }
    w.__tasks = []
    new MutationObserver((recs) => {
      w.__churn.batches++
      for (const r of recs) {
        w.__churn.added += r.addedNodes.length
        w.__churn.removed += r.removedNodes.length
      }
    }).observe(el, { childList: true })
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__tasks.push(Math.round(e.duration))
    }).observe({ type: 'longtask', buffered: false })
  })

  const cdp = await c.newCDPSession(page)
  await cdp.send('Performance.enable')
  const metrics = async () => {
    const { metrics: m } = await cdp.send('Performance.getMetrics')
    const o: Record<string, number> = {}
    for (const x of m) o[x.name] = x.value
    return o
  }

  if (PROFILE) {
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
    await cdp.send('Profiler.start')
  }
  await page.waitForTimeout(1500)
  log(`measuring: ${SECONDS}s at twitch ${RATE.twitch}/s, kick ${RATE.kick}/s, youtube ${RATE.yt}/s`)
  const m0 = await metrics()
  const sent: Record<string, number> = await drv.evaluate(
    ({ rates, ms }: any) => (globalThis as any).__drive(rates, ms),
    { rates: RATE, ms: SECONDS * 1000 },
  )
  await page.waitForTimeout(1500) // the last frame and the youtube drip
  const m1 = await metrics()
  const total = sent.twitch + sent.kick + sent.yt
  if (PROFILE) {
    const { profile } = await cdp.send('Profiler.stop')
    const self = new Map<string, number>()
    const dt = profile.timeDeltas as number[]
    const byId = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]))
    profile.samples.forEach((id: number, i: number) => {
      const f = byId.get(id).callFrame
      const k = `${f.functionName || '(anon)'} ${String(f.url).split('/').pop()}:${f.lineNumber}`
      self.set(k, (self.get(k) || 0) + (dt[i] || 0))
    })
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)
    log('\nscript time by function (self, ms over the whole run):')
    for (const [k, us] of top) log(`  ${(us / 1000).toFixed(0).padStart(6)}  ${k}`)
  }
  const d = (k: string) => (m1[k] - m0[k]) * 1000 // ms
  const churn = await page.evaluate(() => (window as any).__churn)
  const tasks: number[] = await page.evaluate(() => (window as any).__tasks)

  // the oracle: a full render, then the same question again
  const snapshot = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('#hs-mc-messages > .hs-mc-msg')].map((r) => (r as HTMLElement).dataset.msgKey),
    )
  await page.waitForTimeout(800)
  const before: string[] = await snapshot()
  await drv.evaluate(async () => {
    // @ts-ignore — flip a setting whose change re-renders the pane
    const cur = (await chrome.storage.sync.get('ui_settings')).ui_settings || {}
    // @ts-ignore
    await chrome.storage.sync.set({ ui_settings: { ...cur, messageDensity: cur.messageDensity === 'cozy' ? 'compact' : 'cozy' } })
  })
  await page.waitForTimeout(1500)
  const after: string[] = await snapshot()
  const sameSet = before.length === after.length && new Set(before).size === new Set(after).size && before.every((k) => new Set(after).has(k))
  const sameOrder = before.length === after.length && before.every((k, i) => k === after[i])
  const dupes = before.length - new Set(before).size

  const result = {
    seconds: SECONDS,
    sent,
    total,
    perMessageMs: {
      task: +(d('TaskDuration') / total).toFixed(3),
      script: +(d('ScriptDuration') / total).toFixed(3),
      layout: +(d('LayoutDuration') / total).toFixed(3),
      style: +(d('RecalcStyleDuration') / total).toFixed(3),
    },
    totalMs: {
      task: Math.round(d('TaskDuration')),
      script: Math.round(d('ScriptDuration')),
      layout: Math.round(d('LayoutDuration')),
      style: Math.round(d('RecalcStyleDuration')),
    },
    longTasks: { count: tasks.length, maxMs: tasks.length ? Math.max(...tasks) : 0 },
    domChurn: churn,
    rows: { beforeFullRender: before.length, afterFullRender: after.length },
    equivalence: { sameSet, sameOrder, dupes },
    pageErrors,
  }
  if (JSON_OUT) console.log(JSON.stringify(result))
  else {
    log('')
    log(`messages fed: ${total} (twitch ${sent.twitch}, kick ${sent.kick}, youtube ${sent.yt})`)
    log(
      `main thread per message: task ${result.perMessageMs.task}ms  script ${result.perMessageMs.script}ms  layout ${result.perMessageMs.layout}ms  style ${result.perMessageMs.style}ms`,
    )
    log(
      `main thread total: task ${result.totalMs.task}ms  script ${result.totalMs.script}ms  layout ${result.totalMs.layout}ms  style ${result.totalMs.style}ms`,
    )
    log(`long tasks (>=50ms): ${result.longTasks.count}, worst ${result.longTasks.maxMs}ms`)
    log(`pane churn: ${churn.added} rows added, ${churn.removed} removed, in ${churn.batches} dom batches`)
    log(`rows on screen: ${before.length} before a full render, ${after.length} after`)
    log(`fast path vs full render: same rows ${sameSet}, same order ${sameOrder}, duplicates ${dupes}`)
    if (pageErrors.length) log(`page errors: ${pageErrors.join(' | ')}`)
  }
  if (!sameSet || !sameOrder || dupes || pageErrors.length) {
    console.error('FAIL: the pane differs from a full render, or the page threw')
    process.exitCode = 1
  }
  if (BUDGET_FILE) {
    const budget = JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) as { baseline: number; limit: number; headroom: number }
    const got = result.perMessageMs.task
    // a run that fed nothing measures nothing: NaN > limit is false, which would read as a pass
    const wanted = (RATE.twitch + RATE.kick + RATE.yt) * SECONDS
    if (!Number.isFinite(got) || total < wanted * 0.5) {
      console.error(`FAIL: the bench fed ${total} of ~${wanted} messages, so its timing means nothing`)
      process.exitCode = 1
    } else if (got > budget.limit) {
      console.error(
        `FAIL: ${got}ms of main thread per message is over the budget of ${budget.limit}ms (baseline ${budget.baseline}ms + ${Math.round(budget.headroom * 100)}%). ` +
          'a slower runner is not a regression: re-measure per the note in the budget file before raising it',
      )
      process.exitCode = 1
    } else {
      log(`budget: ${got}ms per message, under ${budget.limit}ms (baseline ${budget.baseline}ms + ${Math.round(budget.headroom * 100)}%)`)
    }
  }
} finally {
  await Promise.race([c.close(), new Promise((r) => setTimeout(r, 15_000))])
  rmSync(profile, { recursive: true, force: true })
}
process.exit(process.exitCode ?? 0)

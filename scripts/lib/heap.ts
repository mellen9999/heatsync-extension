/**
 * Memory probes for the opt-in browser rigs (heap-budget.ts).
 *
 * Three places the extension's memory lives, and each needs its own probe:
 *   - a tab's JS heap: CDP Performance.getMetrics after a forced GC
 *   - the service worker's JS heap: playwright can't open a CDP session on a
 *     worker, so the browser is launched with --remote-debugging-port=0 and the
 *     SW target is reached over its own websocket
 *   - shared memory (decoded images, tiles, network pipes): off every JS heap.
 *     Playwright passes --disable-dev-shm-usage, so chromium keeps it in /tmp as
 *     unlinked files — counted per process through /proc/<pid>/fd. This is what
 *     caught the SW pinning 1.8GB of unread fetch replies (2026-10-13); no heap
 *     number moved.
 */
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { withTimeout } from './chromium'

const CDP_TIMEOUT_MS = 60_000

/** A tab's retained JS heap, MB (forces a GC first). */
export async function tabHeapMB(ctx: any, page: any): Promise<number> {
  await page.bringToFront()
  const cdp = await ctx.newCDPSession(page)
  try {
    await withTimeout(cdp.send('HeapProfiler.enable'), CDP_TIMEOUT_MS, 'HeapProfiler.enable')
    await withTimeout(cdp.send('HeapProfiler.collectGarbage'), CDP_TIMEOUT_MS, 'collectGarbage')
    await cdp.send('Performance.enable')
    const { metrics } = await withTimeout(cdp.send('Performance.getMetrics'), CDP_TIMEOUT_MS, 'getMetrics')
    return (metrics.find((m: any) => m.name === 'JSHeapUsedSize')?.value ?? 0) / 1e6
  } finally {
    await cdp.detach().catch(() => {})
  }
}

/** The extension service worker's retained JS heap, MB. Needs --remote-debugging-port=0. */
export async function swHeapMB(profile: string): Promise<number | null> {
  const portFile = join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 50 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100))
  const port = readFileSync(portFile, 'utf8').split('\n')[0]
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[]
  const target = list.find((t) => t.type === 'service_worker' && String(t.url).startsWith('chrome-extension://'))
  if (!target) return null
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await withTimeout(
    new Promise((res, rej) => {
      ws.onopen = res
      ws.onerror = rej
    }),
    10_000,
    'sw websocket',
  )
  const pending = new Map<number, (m: any) => void>()
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data))
    pending.get(m.id)?.(m)
    pending.delete(m.id)
  }
  let id = 0
  const call = (method: string) =>
    withTimeout(
      new Promise<any>((res) => {
        const i = ++id
        pending.set(i, res)
        ws.send(JSON.stringify({ id: i, method }))
      }),
      CDP_TIMEOUT_MS,
      `sw ${method}`,
    )
  try {
    await call('HeapProfiler.collectGarbage')
    const r = await call('Runtime.getHeapUsage')
    return (r.result?.usedSize ?? 0) / 1e6
  } finally {
    ws.close()
  }
}

/** Shared memory held per chromium process of this profile, MB, keyed by role. */
export function shmByRole(profile: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    let cmd = ''
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    } catch {
      continue
    }
    if (!cmd.includes(profile)) continue
    const role = cmd.includes('--extension-process')
      ? 'sw'
      : (cmd.match(/--type=([a-z-]+)/)?.[1] ?? 'browser').replace('gpu-process', 'gpu')
    let bytes = 0
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        const p = `/proc/${pid}/fd/${fd}`
        try {
          const link = readlinkSync(p)
          if (link.startsWith('/tmp/') && link.endsWith('(deleted)')) bytes += statSync(p).size
        } catch {}
      }
    } catch {
      continue
    }
    out[role] = (out[role] ?? 0) + bytes / 1e6
  }
  return out
}

/** Least-squares slope of y over t (seconds), per minute — one late GC can't decide it. */
export function slopePerMin(rows: { t: number; y: number }[]): number {
  const n = rows.length
  if (n < 2) return 0
  const mt = rows.reduce((a, r) => a + r.t, 0) / n
  const my = rows.reduce((a, r) => a + r.y, 0) / n
  const den = rows.reduce((a, r) => a + (r.t - mt) ** 2, 0)
  return den ? (rows.reduce((a, r) => a + (r.t - mt) * (r.y - my), 0) / den) * 60 : 0
}

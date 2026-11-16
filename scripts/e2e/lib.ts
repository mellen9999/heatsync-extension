/**
 * Real-site end-to-end plumbing: launch the built extension in chromium against live
 * twitch, kick and youtube, find who is live right now, and read the extension's own
 * health signals as the pass/fail oracle.
 *
 * Read-only on the platforms: navigation, clicks on links and the panel's own UI, never
 * a send, never a login. Every scenario runs in a throwaway profile.
 *
 * Oracles (no new instrumentation — what the extension already records):
 *   page   localStorage.hs_diag_ring — render_stall / ingest_gap / dom_thrash / long_frame
 *          events from the overlay's watchdogs (main-messages.js). It self-heals, so a
 *          stall leaves a fine-looking DOM: count events, never trust the final picture.
 *   page   hs-dbg-probe → documentElement.dataset.hsDbg (dev builds only): buffers per
 *          channel, currentTab, saved channels.
 *   sw     hs_errors, channelEmotesMap, tabChannels, __hsBootOk — read in the worker.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHROME_BIN, loadChromium } from '../lib/chromium'

export const ROOT = join(import.meta.dir, '..', '..')
export const EXT = process.env.E2E_EXT || join(ROOT, 'dist', 'chrome')
export const OUT = process.env.E2E_OUT || join(tmpdir(), `hs-e2e-${Date.now()}`)
export const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── verdicts ─────────────────────────────────────────────────────────────────
export type Finding = { scenario: string; what: string; detail?: unknown }
export const findings: Finding[] = []
export const passes: string[] = []
let _scenario = ''
export function scenario(name: string) {
  _scenario = name
  console.log(`\n── ${name} ──`)
}
export function ok(msg: string) {
  passes.push(`${_scenario}: ${msg}`)
  console.log(`  ✓ ${msg}`)
}
export function bad(what: string, detail?: unknown) {
  findings.push({ scenario: _scenario, what, detail })
  console.log(`  ✗ ${what}${detail === undefined ? '' : `\n      ${JSON.stringify(detail).slice(0, 600)}`}`)
}
export function info(msg: string) {
  console.log(`    · ${msg}`)
}

// ── launch ───────────────────────────────────────────────────────────────────
export async function launch(opts: { width?: number; height?: number; scale?: number; args?: string[] } = {}) {
  if (!existsSync(join(EXT, 'manifest.json'))) throw new Error(`no built extension at ${EXT}`)
  const chromium = await loadChromium()
  const profile = mkdtempSync(join(tmpdir(), 'hs-e2e-prof-'))
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME_BIN,
    headless: false,
    viewport: { width: opts.width ?? 1600, height: opts.height ?? 900 },
    deviceScaleFactor: opts.scale ?? 1,
    locale: 'en-US',
    userAgent: UA,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--headless=new',
      '--no-sandbox',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      ...(opts.args ?? []),
    ],
  })
  // youtube's consent wall would otherwise sit over every page
  await ctx.addCookies([{ name: 'SOCS', value: 'CAI', domain: '.youtube.com', path: '/' }])
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 20_000 }))
  const extId = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1] as string
  // the install tab (welcome page) is not part of any scenario
  await sleep(2500)
  for (const pg of ctx.pages()) if (pg.url().includes('welcome')) await pg.close().catch(() => {})
  const close = async () => {
    await ctx.close().catch(() => {})
    rmSync(profile, { recursive: true, force: true })
  }
  return { ctx, extId, close, worker: () => ctx.serviceWorkers()[0] || sw }
}
export type Env = Awaited<ReturnType<typeof launch>>

/**
 * Errors the sites throw with the extension off (checked in a clean chromium, 11-15):
 * twitch's keyboard-layout read from a cross-origin frame. youtube's "Unsafe attempt to
 * load URL" flood is console, not pageerror, so it never reaches here.
 */
const HOST_OWN = [/getLayoutMap\(\) must be called from a top-level browsing context/]

/** Watch a page's own errors, minus the ones the site throws without us. */
export function watchErrors(p: any, label: string, sink: string[]) {
  p.on('pageerror', (e: unknown) => {
    const msg = String(e)
    if (!HOST_OWN.some((re) => re.test(msg))) sink.push(`${label} pageerror: ${msg.slice(0, 300)}`)
  })
}

/** Write chrome.storage from an extension page — the way the popup/settings do it. */
export async function extStorage(env: Env, fn: (arg: any) => Promise<unknown>, arg?: unknown) {
  const s = await env.ctx.newPage()
  try {
    await s.goto(`chrome-extension://${env.extId}/popup.html`, { waitUntil: 'load' })
    return await s.evaluate(fn, arg)
  } finally {
    await s.close().catch(() => {})
  }
}

export type SavedChannel = { id: string; twitch?: string; kick?: string; youtube?: string }
export async function saveChannels(env: Env, channels: SavedChannel[]) {
  await extStorage(
    env,
    // @ts-ignore — extension page
    async (chs) => chrome.storage.local.set({ heatsync_multichat: { channels: chs } }),
    channels.map((c) => ({ twitch: '', kick: '', youtube: '', ...c })),
  )
}
export async function setUiSetting(env: Env, key: string, value: unknown) {
  await extStorage(
    env,
    async ([k, v]: [string, unknown]) => {
      // @ts-ignore — extension page
      const cur = (await chrome.storage.sync.get('ui_settings')).ui_settings || {}
      // @ts-ignore
      await chrome.storage.sync.set({ ui_settings: { ...cur, [k]: v } })
    },
    [key, value],
  )
}

// ── live channels ────────────────────────────────────────────────────────────
type Stream = { username: string; platform: string; viewerCount?: number }
let _top: Stream[] | null = null
async function top(): Promise<Stream[]> {
  if (_top) return _top
  const r = await fetch('https://heatsync.org/api/live/top?limit=100')
  if (!r.ok) throw new Error(`heatsync.org/api/live/top ${r.status}`)
  _top = ((await r.json()) as { streams: Stream[] }).streams
  return _top
}
/** The n busiest live channels on a platform — busy, so silence is never mistaken for a stall. */
export async function liveChannels(platform: 'twitch' | 'kick', n: number): Promise<string[]> {
  let names = (await top())
    .filter((s) => s.platform === platform)
    .sort((a, b) => (b.viewerCount ?? 0) - (a.viewerCount ?? 0))
    .map((s) => s.username.toLowerCase())
  if (platform === 'kick' && names.length < n) {
    const r = await fetch('https://kick.com/stream/livestreams/en?page=1&limit=25&sort=desc', {
      headers: { 'user-agent': UA },
    }).catch(() => null)
    const j: any = r?.ok ? await r.json().catch(() => null) : null
    for (const d of j?.data ?? []) if (d?.channel?.slug) names.push(String(d.channel.slug).toLowerCase())
    names = [...new Set(names)]
  }
  if (names.length < n) throw new Error(`only ${names.length} live ${platform} channels found, wanted ${n}`)
  return names.slice(0, n)
}
/** A youtube video that is live right now (24/7 streams; canonical url of the handle's /live). */
export async function liveYtVideo(handles = ['LofiGirl', 'lofigirl', 'chillhopmusic', 'SpaceVideosHD']) {
  for (const h of handles) {
    const res = await fetch(`https://www.youtube.com/@${h}/live`, {
      headers: { 'user-agent': UA, 'accept-language': 'en', cookie: 'SOCS=CAI' },
    }).catch(() => null)
    const html = res?.ok ? await res.text() : ''
    const id = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/)?.[1]
    if (id && /"isLiveNow":true|"isLive":true/.test(html)) return { handle: h, id }
  }
  throw new Error('no live youtube stream found')
}
export const YT_VOD = 'jNQXAC9IVRw' // "me at the zoo" — a plain upload, never live

// ── page oracles ─────────────────────────────────────────────────────────────
export const BAD_RING = ['render_stall', 'ingest_gap', 'dom_thrash', 'zebra_flicker', 'vis-render-error'] as const

/** Ring events since t0 (all tabs of this origin share the ring; each entry names its tab). */
export async function ringSince(p: any, t0: number) {
  const arr: any[] = await p
    .evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem('hs_diag_ring') || '[]')
      } catch {
        return []
      }
    })
    .catch(() => [])
  const recent = arr.filter((e) => e.t >= t0)
  const counts: Record<string, number> = {}
  for (const e of recent) counts[e.e] = (counts[e.e] || 0) + 1
  // ingest_gap fires on any 3s+ pause after a burst. Its probe asks the worker right after:
  // the worker holding newer lines than the tab = delivery died (ours); not = nothing was
  // said upstream either (a chat that paused). With no probe, only a 10s+ gap counts (the
  // overlay's own outage line).
  const delivered = (e: any) => {
    if (e.e !== 'ingest_gap') return true
    const probe = recent.find((x) => x.e === 'ingest_gap_probe' && x.ch === e.ch && x.t >= e.t && x.t - e.t < 5000)
    return probe ? probe.bgAheadS >= 2 : e.gapS >= 10
  }
  const bad = recent.filter((e) => (BAD_RING as readonly string[]).includes(e.e) && delivered(e))
  return { recent, counts, bad }
}

/** dev-build probe: buffers per channel, currentTab, saved channels. */
export async function dbg(p: any): Promise<any> {
  return p
    .evaluate(() => {
      delete document.documentElement.dataset.hsDbg
      document.dispatchEvent(new CustomEvent('hs-dbg-probe'))
      const raw = document.documentElement.dataset.hsDbg
      if (!raw) return { err: 'no probe answer (minified build?)' }
      try {
        return JSON.parse(raw)
      } catch {
        return { err: raw }
      }
    })
    .catch((e: unknown) => ({ err: String(e) }))
}

/** What the panel shows right now. */
export async function panel(p: any) {
  return p
    .evaluate(() => {
      const ct = document.getElementById('hs-mc-container') as HTMLElement | null
      const r = ct?.getBoundingClientRect()
      const rows = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')] as HTMLElement[]
      const tabEls = [...document.querySelectorAll('.hs-mc-tab[data-tab]')] as HTMLElement[]
      const active =
        tabEls.find((t) => t.classList.contains('active') || t.getAttribute('aria-selected') === 'true') || null
      const tail = rows.slice(-40)
      return {
        mounted: !!ct,
        box: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null,
        offline: document.body.classList.contains('hs-offline'),
        rows: rows.length,
        activeTab: active?.dataset.tab || null,
        tabs: tabEls.map((t) => `${t.dataset.tab}=${(t.textContent || '').trim().slice(0, 24)}`),
        tailImgs: tail.reduce((n, r) => n + r.querySelectorAll('img').length, 0),
        lastRowText: (tail.at(-1)?.textContent || '').trim().slice(0, 80),
        url: location.href,
      }
    })
    .catch((e: unknown) => ({ err: String(e) }))
}

/** Rows keep arriving: the newest row's text changes within `ms`. */
export async function rowsFlow(p: any, ms = 30_000) {
  const first = await panel(p)
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    await sleep(2000)
    const now = await panel(p)
    if (now.rows && (now.lastRowText !== first.lastRowText || now.rows !== first.rows)) return true
  }
  return false
}

export async function waitPanel(p: any, ms = 30_000) {
  return p
    .waitForSelector('#hs-mc-container', { timeout: ms, state: 'attached' })
    .then(() => true)
    .catch(() => false)
}

/** Listener + node counts on the page's document/window through CDP (leak signal across navigations). */
export async function domCounters(ctx: any, p: any) {
  const s = await ctx.newCDPSession(p)
  try {
    await s.send('HeapProfiler.collectGarbage').catch(() => {})
    const c = await s.send('Memory.getDOMCounters')
    return { listeners: c.jsEventListeners, nodes: c.nodes, documents: c.documents }
  } finally {
    await s.detach().catch(() => {})
  }
}

// ── service worker oracles ───────────────────────────────────────────────────
export async function swState(env: Env) {
  const w = env.worker()
  return w
    .evaluate(async () => {
      // @ts-ignore — service worker globals (plain top-level bindings of a classic script)
      const map = typeof channelEmotesMap !== 'undefined' ? channelEmotesMap : {}
      const sets: Record<string, number | string> = {}
      for (const k of Object.keys(map)) sets[k] = Array.isArray(map[k]) ? map[k].length : String(map[k])
      // @ts-ignore
      const tabs =
        typeof tabChannels !== 'undefined' ? [...tabChannels.entries()].map(([id, v]) => [id, v?.channel]) : []
      // @ts-ignore
      const extras = typeof joinedExtraChannels !== 'undefined' ? [...joinedExtraChannels] : []
      // @ts-ignore
      const errs = ((await chrome.storage.local.get('hs_errors')).hs_errors || []).map((e: any) =>
        String(e?.msg || e?.message || JSON.stringify(e)).slice(0, 200),
      )
      // @ts-ignore
      return { boot: self.__hsBootOk === true, sets, tabs, extras, errs }
    })
    .catch((e: unknown) => ({ err: String(e) }))
}

// ── artifacts ────────────────────────────────────────────────────────────────
export async function shot(p: any, name: string) {
  mkdirSync(OUT, { recursive: true })
  await p.screenshot({ path: join(OUT, `${name}.png`) }).catch(() => {})
}
export function writeReport(extra: Record<string, unknown> = {}) {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ passes, findings, ...extra }, null, 1))
}

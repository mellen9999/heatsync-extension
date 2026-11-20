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
const EXT_DEFAULT = EXT
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
export async function launch(
  opts: {
    width?: number
    height?: number
    scale?: number
    args?: string[]
    /** keep the install tab (the welcome page) open and hand it back as env.welcome */
    keepWelcome?: boolean
    /** called for every page the browser opens, from the first moment: listeners attached here miss nothing */
    onPage?: (pg: any) => void
    /** reuse this profile dir (kept on close) instead of making a throwaway one */
    profile?: string
    /** load the extension from this dir instead of EXT */
    ext?: string
    /** browser ui language (chrome's own, what chrome.i18n follows), e.g. 'de'; default en-US */
    lang?: string
  } = {},
) {
  const EXT = opts.ext ?? EXT_DEFAULT
  if (!existsSync(join(EXT, 'manifest.json'))) throw new Error(`no built extension at ${EXT}`)
  const chromium = await loadChromium()
  const profile = opts.profile ?? mkdtempSync(join(tmpdir(), 'hs-e2e-prof-'))
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME_BIN,
    headless: false,
    viewport: { width: opts.width ?? 1600, height: opts.height ?? 900 },
    deviceScaleFactor: opts.scale ?? 1,
    locale: opts.lang ?? 'en-US',
    userAgent: UA,
    // chrome on linux reads its ui language from LANGUAGE, --lang alone is not always enough
    ...(opts.lang ? { env: { ...process.env, LANGUAGE: opts.lang } } : {}),
    args: [
      ...(opts.lang ? [`--lang=${opts.lang}`] : []),
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--headless=new',
      '--no-sandbox',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      ...(opts.args ?? []),
    ],
  })
  if (opts.onPage) {
    ctx.on('page', opts.onPage)
    for (const pg of ctx.pages()) opts.onPage(pg)
  }
  // E2E_CPU_SLOW=4: every page runs on a cpu four times slower, the way a ci runner does
  const slow = Number(process.env.E2E_CPU_SLOW || 0)
  if (slow > 1)
    ctx.on('page', (pg: any) => {
      ctx
        .newCDPSession(pg)
        .then((c: any) => c.send('Emulation.setCPUThrottlingRate', { rate: slow }))
        .catch(() => {})
    })
  // youtube's consent wall would otherwise sit over every page
  await ctx.addCookies([{ name: 'SOCS', value: 'CAI', domain: '.youtube.com', path: '/' }])
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 20_000 }))
  const extId = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1] as string
  // the install tab (welcome page) is not part of any scenario
  await sleep(2500)
  if (!opts.keepWelcome) for (const pg of ctx.pages()) if (pg.url().includes('welcome')) await pg.close().catch(() => {})
  const welcome = opts.keepWelcome ? ctx.pages().find((pg: any) => pg.url().includes('welcome')) : undefined
  const close = async () => {
    await ctx.close().catch(() => {})
    if (!opts.profile) rmSync(profile, { recursive: true, force: true })
  }
  return { ctx, extId, profile, close, welcome, worker: () => ctx.serviceWorkers()[0] || sw }
}
export type Env = Awaited<ReturnType<typeof launch>>

/**
 * Errors the sites throw with the extension off (checked in a clean chromium, 11-15):
 * twitch's keyboard-layout read from a cross-origin frame. youtube's "Unsafe attempt to
 * load URL" flood is console, not pageerror, so it never reaches here.
 */
const HOST_OWN = [
  /getLayoutMap\(\) must be called from a top-level browsing context/,
  // kick's own rpc client, a request cut by a reload or a dropped line: the rejection is thrown
  // from kick's chunk and nobody there catches it (s21 on github's runner, 11-18)
  /ConnectError: \[unknown\] Failed to fetch/,
]

/** Watch a page's own errors, minus the ones the site throws without us. */
export function watchErrors(p: any, label: string, sink: string[]) {
  p.on('pageerror', (e: unknown) => {
    const msg = String(e)
    // where it threw: an extension frame is ours, a site frame is the site's
    const at = String((e as Error)?.stack || '')
      .split('\n')
      .find((l) => /^\s+at /.test(l))
      ?.trim()
    // a twitch panel extension's iframe (*.ext-twitch.tv) is a third party's code, not ours
    // so is the ad player the site loads from google (kick, 11-18: ima3.js threw inside itself)
    if (/\.ext-twitch\.tv\/|\/\/imasdk\.googleapis\.com\//.test(at || '')) return
    if (!HOST_OWN.some((re) => re.test(msg)))
      sink.push(`${label} pageerror: ${msg.slice(0, 300)}${at ? ` (${at.slice(0, 160)})` : ''}`)
  })
}

/**
 * Errors a page threw with the extension loaded that the page may throw by itself: the same url
 * is loaded in a browser with no extension, and what it throws there too is taken out of `errs`
 * and said as a note. What only shows with the extension stays, as ours.
 *
 * Kick's pop-out throws react's hydration error #418 on github's runner in every run and never
 * on a desk (0 of 12 loads, cpu 6x slower, 11-18). We broke that hydration once (b8ff6c3a), so
 * it is not waved through by name: the bare browser on the same machine is the judge.
 */
export async function minusHostOwn(
  errs: string[],
  re: RegExp,
  url: string,
  what: string,
  view = { width: 1600, height: 900 },
  loads = 3,
): Promise<string[]> {
  const mine = errs.filter((e) => re.test(e))
  if (!mine.length) return errs
  const chromium = await loadChromium()
  const profile = mkdtempSync(join(tmpdir(), 'hs-e2e-bare-'))
  let alone = 0
  let ran = 0
  try {
    const bare = await chromium.launchPersistentContext(profile, {
      executablePath: CHROME_BIN,
      headless: false,
      viewport: view,
      userAgent: UA,
      args: ['--headless=new', '--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
    })
    try {
      for (; ran < loads && !alone; ran++) {
        const p = await bare.newPage()
        p.on('pageerror', (e: unknown) => {
          if (re.test(String(e))) alone++
        })
        await p.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {})
        await sleep(20_000)
        await p.close().catch(() => {})
      }
    } finally {
      await bare.close().catch(() => {})
    }
  } catch (e) {
    info(`${what}: the no-extension control could not run (${String(e).slice(0, 100)}): the error stays ours`)
    return errs
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
  if (!alone) {
    info(`${what}: ${ran} loads with no extension threw nothing like it: the error is ours`)
    return errs
  }
  info(`${what}: the page throws it with no extension too (load ${ran} of the control): not ours, ${mine.length} dropped — ${mine[0].slice(0, 110)}`)
  return errs.filter((e) => !re.test(e))
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
  // youtube serves datacenter ips (the nightly's runner) no live page: there the youtube legs
  // are skipped out loud; on a home line no live stream is a broken scenario
  if (process.env.CI) {
    info('skipped: youtube shows this ip no live stream, youtube legs not run')
    return null
  }
  throw new Error('no live youtube stream found')
}
export const YT_VOD = 'jNQXAC9IVRw' // "me at the zoo" — a plain upload, never live

// ── page oracles ─────────────────────────────────────────────────────────────
export const BAD_RING = ['render_stall', 'ingest_gap', 'dom_thrash', 'zebra_flicker', 'vis-render-error', 'index_desync'] as const

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
  // And one hitch under 10s is a hitch: a loaded machine holds a tab's timers that long once
  // (a 4s one on a ci runner's first twitch load, nightly 11-18). The overlay itself only acts
  // at 10s. A second one on the same channel, or one of 10s, is a finding.
  const gaps = recent.filter((x) => x.e === 'ingest_gap')
  const probeOf = (e: any) => recent.find((x) => x.e === 'ingest_gap_probe' && x.ch === e.ch && x.t >= e.t && x.t - e.t < 5000)
  const delivered = (e: any) => {
    if (e.e !== 'ingest_gap') return true
    if (e.gapS >= 10) return true
    const probe = probeOf(e)
    return !!probe && probe.bgAheadS >= 2 && gaps.filter((x) => x.ch === e.ch).length > 1
  }
  // render_stall says why the newest line is not drawn when something of the reader's is in the
  // way (a card over the list, a form, a reader scrolled up): that one is the list doing as told.
  const blocked = (e: any) => e.e === 'render_stall' && (e.editing || e.panel || e.card || e.scrolledUp)
  // a gap carries its probe: the worker ahead of the tab is our delivery, both quiet is the chat
  const bad = recent
    .filter((e) => (BAD_RING as readonly string[]).includes(e.e) && delivered(e) && !blocked(e))
    .map((e) => (e.e === 'ingest_gap' ? { ...e, probe: probeOf(e) || 'none' } : e))
  return { recent, counts, bad }
}

/** dev-build probe: buffers per channel, currentTab, saved channels. */
/**
 * Is the chat list at its tail and following? Looked at from inside the page every 10ms: a look
 * from outside can land between a row's append and its pin a frame later, and a window nobody
 * can see (covered, unfocused) pins in lumps up to a second apart. A list that follows is at its
 * tail at some look in the second half of the window; one that stopped is behind in all of them.
 */
export function tailFollows(p: any, ms = 2500, within = 24): Promise<{ ok: boolean; min: number; max: number; looks: number; top: [number, number] }> {
  return p.evaluate(
    ({ ms, within }: { ms: number; within: number }) =>
      new Promise((res) => {
        const l = document.getElementById('hs-mc-messages') as HTMLElement
        const t0 = performance.now()
        const top0 = l.scrollTop
        let min = Number.POSITIVE_INFINITY
        let max = 0
        let looks = 0
        let okAt = -1
        const id = setInterval(() => {
          const g = l.scrollHeight - l.scrollTop - l.clientHeight
          const at = performance.now() - t0
          looks++
          min = Math.min(min, g)
          max = Math.max(max, g)
          if (g <= within) okAt = at
          if (at < ms) return
          clearInterval(id)
          res({ ok: okAt >= ms / 2, min: Math.round(min), max: Math.round(max), looks, top: [Math.round(top0), Math.round(l.scrollTop)] })
        }, 10)
      }),
    { ms, within },
  )
}

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

/** Null when a pointer can reach the panel's tab bar; else what sits over it and how the page is laid out.
 *  (Twitch read as "no channel" off a page not drawn yet put the bar under twitch's own top bar, 11-18.) */
export async function tabBarHit(p: any): Promise<null | Record<string, unknown>> {
  return p.evaluate(() => {
    const t = document.querySelector('#hs-mc-tabbar .hs-mc-tab.active, #hs-mc-tabbar .hs-mc-tab') as HTMLElement | null
    const lay = () => {
      const c = document.getElementById('hs-mc-container')
      const cr = c?.getBoundingClientRect()
      return {
        body: document.body.className.split(/\s+/).filter((x) => x.startsWith('hs-')).join(' '),
        container: cr ? [cr.left, cr.top, cr.width, cr.height].map(Math.round) : null,
        parent: c?.parentElement ? `${c.parentElement.tagName.toLowerCase()}.${String(c.parentElement.className).split(/\s+/).slice(-2).join('.')}` : null,
        navVar: document.documentElement.style.getPropertyValue('--hs-twitch-topnav-h') || document.documentElement.style.getPropertyValue('--hs-kick-topnav-h'),
      }
    }
    if (!t) return { why: 'no tab in the bar', ...lay() }
    const r = t.getBoundingClientRect()
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) as HTMLElement | null
    if (at && t.contains(at)) return null
    return { why: 'covered', over: at ? `${at.tagName.toLowerCase()}#${at.id}.${String(at.className).slice(0, 50)}` : 'nothing (off screen)', tab: [r.left, r.top, r.width, r.height].map(Math.round), ...lay() }
  })
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
      // kick's own socket: which rooms it holds and how long since each one last delivered
      const ago = (m: Map<string, any>) => Object.fromEntries([...m].map(([k, e]) => [k, Math.round((Date.now() - e.lastAt) / 1000)]))
      // @ts-ignore
      const kst = typeof _kickSrcStats !== 'undefined' ? _kickSrcStats : null
      const kick = kst && {
        // @ts-ignore
        rooms: typeof _kpChannels !== 'undefined' ? [..._kpChannels.keys()] : [],
        // @ts-ignore
        sock: typeof _kpWs !== 'undefined' ? (_kpWs?.readyState ?? null) : null,
        tapAgoS: ago(kst.tap),
        relayAgoS: ago(kst.relay),
        net: { stopped: kst.net.stopped, streak: kst.net.streak, why: kst.net.lastReason, connects: kst.net.connects },
      }
      // @ts-ignore
      return { boot: self.__hsBootOk === true, sets, tabs, extras, errs, kick }
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

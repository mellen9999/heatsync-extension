/**
 * s20 — the chat list's scroll: pause, the "N new" pill, back to the tail, older rows, reload.
 *
 *   bun scripts/e2e/run.ts --only s20
 *
 * On a busy live channel on each of twitch, kick and youtube (signed out, nothing is sent):
 *   - wheel up pauses the list: the newest row on screen and the scroll position stay put
 *     while chat keeps arriving
 *   - the "N new" pill shows, with a number that fits the rows that really arrived
 *   - the pill, the End key and a wheel to the bottom each bring the list back to the tail:
 *     pill gone, last row in view, rows flowing again
 *   - scrolled to the top, older rows load above: the row at the top stays where it was, no
 *     row twice, never more rows than the cap
 *   - a reload keeps the tab and the panel width, draws history before the live rows, and no
 *     row moves or repeats while it fills
 * Throughout: no page errors, no console errors from our code, a quiet watchdog ring.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bad,
  dbg,
  info,
  launch,
  liveChannels,
  liveYtVideo,
  ok,
  panel,
  ringSince,
  ROOT,
  rowsFlow,
  scenario,
  setUiSetting,
  shot,
  sleep,
  waitPanel,
  watchErrors,
} from './lib'

const EN = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8'))
const NEW_RE = new RegExp(`^▼?\\s*${String(EN.mc_new_messages.message).replace('$COUNT$', '(\\d+)')}$`)
const ROW_CAP = 1500 // SCROLLBACK_MAX: the most rows the list ever holds
const LIVE_CAP = 500 // DOM_RENDER_CAP: the most at the live tail

type View = {
  rows: number
  keys: string[]
  scrollTop: number
  atTail: boolean
  pillShown: boolean
  pillText: string
  newest: string | null
  anchor: { key: string; dy: number } | null
}

const view = (p: any): Promise<View> =>
  p.evaluate(() => {
    const ct = document.getElementById('hs-mc-messages') as HTMLElement
    const box = ct.getBoundingClientRect()
    const rows = [...ct.querySelectorAll('.hs-mc-msg[data-msg-key]')] as HTMLElement[]
    const pill = document.getElementById('hs-mc-new-msgs') as HTMLElement | null
    const seen = rows.filter((r) => {
      const b = r.getBoundingClientRect()
      return b.top >= box.top - 1 && b.bottom <= box.bottom + 1
    })
    const first = seen[0]
    return {
      rows: rows.length,
      keys: rows.map((r) => r.dataset.msgKey as string),
      scrollTop: Math.round(ct.scrollTop),
      atTail: ct.scrollHeight - ct.scrollTop - ct.clientHeight <= 3,
      pillShown: !!pill && getComputedStyle(pill).display !== 'none',
      pillText: (pill?.textContent || '').trim(),
      newest: seen.at(-1)?.dataset.msgKey || null,
      anchor: first ? { key: first.dataset.msgKey as string, dy: Math.round(first.getBoundingClientRect().top - box.top) } : null,
    }
  })

const pillCount = (v: View) => (v.pillShown ? Number(v.pillText.match(NEW_RE)?.[1] ?? NaN) : 0)
const dupes = (keys: string[]) => keys.length - new Set(keys).size

async function aimAtList(p: any) {
  const b = await p.evaluate(() => {
    const r = (document.getElementById('hs-mc-messages') as HTMLElement).getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await p.mouse.move(b.x, b.y)
}
async function wheel(p: any, dy: number) {
  await aimAtList(p)
  await p.mouse.wheel(0, dy)
  await sleep(400)
}
/** Wheel up until the pause shows, or the list cannot scroll. */
async function pause(p: any) {
  await wheel(p, -400)
  await sleep(1500) // the wheel scrolls smoothly: read the position once it has landed
  return view(p)
}
/** Rows the extension holds in its buffers for this page's channel (the page shows at most the cap of them). */
async function buffered(p: any) {
  const d = await dbg(p)
  return [d.irc, d.kick].reduce((n, c) => n + (c && typeof c === 'object' ? Object.values<any>(c).reduce((m, x) => m + (x?.count || 0), 0) : 0), 0)
}
/** The newest row changes within `ms`. */
async function newestMoves(p: any, from: string | undefined, ms: number) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(1000)) if ((await view(p)).keys.at(-1) !== from) return true
  return false
}
/** Back at the tail with the pill gone, given a few seconds: the wheel scrolls smoothly and a fast chat keeps adding rows below. */
async function atTailSoon(p: any, secs = 6) {
  let v = await view(p)
  for (let i = 0; i < secs && !(v.atTail && !v.pillShown); i++) {
    await sleep(1000)
    v = await view(p)
  }
  return v
}
/** Rows, the keys the list holds and the scroll position, settled: the first-paint chunks have all landed. */
async function settled(p: any) {
  let last = -1
  for (let i = 0; i < 20; i++) {
    const v = await view(p)
    if (v.rows === last) return v
    last = v.rows
    await sleep(1500)
  }
  return view(p)
}

/** A leg that finds the chat too quiet to judge returns 'quiet'; the caller tries the next channel. */
async function leg(env: any, name: string, url: string, errs: string[], cons: string[]): Promise<'done' | 'quiet'> {
  const t0 = Date.now()
  const errs0 = errs.length
  const cons0 = cons.length
  const p = await env.ctx.newPage()
  watchErrors(p, name, errs)
  p.on('console', (m: any) => {
    const text = String(m.text())
    if (m.type() === 'error' && /heatsync|Error in event handler/i.test(text) && !/Unsafe attempt to load URL/.test(text)) cons.push(`${name}: ${text.slice(0, 160)}`)
  })
  const check = (what: string, fails: string[], detail?: unknown) =>
    fails.length ? bad(`${name}: ${what}: ${fails.join('; ')}`, detail) : ok(`${name}: ${what}`)
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(p)) || !(await rowsFlow(p, 45_000))) {
      bad(`${name}: chat never flowed`, await panel(p))
      return 'done'
    }
    const start = await settled(p)
    if (start.rows < 30) {
      info(`${name}: only ${start.rows} rows on this channel, too quiet to judge`)
      return 'quiet'
    }

    // ── 1 pause ──
    const a = await pause(p)
    await sleep(6000)
    let b = await view(p)
    for (let i = 0; i < 4 && pillCount(b) < 3; i++) {
      await sleep(5000)
      b = await view(p)
    }
    if (pillCount(b) < 3) {
      info(`${name}: ${pillCount(b)} new rows in 26s, too quiet to judge`)
      return 'quiet'
    }
    check(
      'wheel up pauses: the newest row on screen and the scroll position hold while chat arrives',
      [
        ...(a.newest && a.newest === b.newest ? [] : ['the newest row on screen changed']),
        ...(Math.abs(a.scrollTop - b.scrollTop) <= 2 ? [] : [`scrollTop ${a.scrollTop} → ${b.scrollTop}`]),
        ...(pillCount(b) >= pillCount(a) ? [] : ['the incoming count went down']),
      ],
      { a, b: { ...b, keys: b.keys.length } },
    )

    // ── 2 the pill ──
    const n = pillCount(b)
    check(
      'the pill shows "N new" with a real number',
      [...(b.pillShown ? [] : ['no pill']), ...(Number.isInteger(n) && n > 0 ? [] : [`the pill reads "${b.pillText}"`])],
      b.pillText,
    )

    // ── 3a click the pill ──
    await p.click('#hs-mc-new-msgs')
    const c = await atTailSoon(p)
    const paused = c.keys.includes(a.newest as string)
    const arrived = c.keys.length - (c.keys.indexOf(a.newest as string) + 1)
    check(
      'the pill returns to the tail: pill gone, last row in view',
      [...(c.pillShown ? ['the pill is still there'] : []), ...(c.atTail ? [] : ['the list is not at the bottom'])],
      c,
    )
    check(
      'the pill number fits the rows that arrived while paused',
      [
        // a fast chat trims the row we paused on off the top before we look: then there is nothing to count against
        ...(!paused || n <= arrived ? [] : [`pill said ${n}, only ${arrived} rows came`]),
        ...(!paused || arrived <= n * 10 ? [] : [`pill said ${n}, but ${arrived} rows came`]),
      ],
      { pill: n, arrived },
    )
    const kept = c.keys.at(-1)
    check('rows flow again after the pill', (await newestMoves(p, kept, 60_000)) ? [] : ['the newest row never changed in 60s'])

    // ── 3b End ──
    await pause(p)
    await sleep(3000)
    const e0 = await view(p)
    // a click in the list (on the row's own edge, nothing to open) is how a viewer puts the keyboard there
    const edge = await p.evaluate(() => {
      const box = (document.getElementById('hs-mc-messages') as HTMLElement).getBoundingClientRect()
      const mid = box.top + box.height / 2
      const near = (r: Element) => Math.abs(r.getBoundingClientRect().top + r.getBoundingClientRect().height / 2 - mid)
      const row = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].sort((x, y) => near(x) - near(y))[0]
      const b = row.getBoundingClientRect()
      return { x: b.right - 3, y: b.top + b.height / 2 }
    })
    await p.mouse.click(edge.x, edge.y)
    await p.keyboard.press('End')
    const e1 = await atTailSoon(p, 3)
    check(
      'End returns to the tail: pill gone, last row in view',
      [
        ...(e0.pillShown ? [] : ['the pause never showed the pill']),
        ...(e1.pillShown ? ['the pill is still there'] : []),
        ...(e1.atTail ? [] : ['the list is not at the bottom']),
      ],
      { before: e0, after: e1 },
    )

    // ── 3c wheel to the bottom ──
    await pause(p)
    await sleep(3000)
    await wheel(p, 100_000)
    const w = await atTailSoon(p)
    check(
      'a wheel to the bottom returns to the tail: pill gone, last row in view',
      [...(w.pillShown ? ['the pill is still there'] : []), ...(w.atTail ? [] : ['the list is not at the bottom'])],
      w,
    )
    const k2 = w.keys.at(-1)
    check('rows flow again after the wheel', (await newestMoves(p, k2, 60_000)) ? [] : ['the newest row never changed in 60s'])

    // ── 4 older rows ──
    // older rows are painted from the buffer: with nothing beyond the 500 on screen there is nothing to load
    let held = name === 'youtube' ? 0 : await buffered(p)
    for (let i = 0; i < 9 && held < LIVE_CAP + 150 && name !== 'youtube'; i++) {
      await sleep(10_000)
      held = await buffered(p)
    }
    await pause(p)
    let top = await view(p)
    const before = top.rows
    let anchor = top.anchor
    for (let i = 0; i < 60 && top.scrollTop > 0 && top.rows === before; i++) {
      anchor = top.anchor
      await wheel(p, -1200)
      top = await view(p)
    }
    await sleep(1500)
    const after = await view(p)
    const row = after.keys.indexOf(anchor?.key as string)
    const olderExist = held >= LIVE_CAP + 100
    if (!olderExist) info(`${name}: the buffer holds ${held} rows, nothing older than the screen to load`)
    check(
      'scrolled to the top, older rows load above',
      [
        ...(olderExist && after.rows <= before ? [`no older rows came, the buffer holds ${held}`] : []),
        ...(dupes(after.keys) ? [`${dupes(after.keys)} rows twice`] : []),
        ...(after.rows <= ROW_CAP ? [] : [`${after.rows} rows, cap is ${ROW_CAP}`]),
      ],
      { before, after: after.rows },
    )
    if (after.rows > before)
      check(
        'the row at the top stays where it was while older rows load',
        [
          ...(row >= 0 ? [] : ['the row we were looking at is gone']),
          ...(row >= after.rows - before ? [] : ['it moved above the new rows']),
        ],
        { anchor, rows: [before, after.rows] },
      )
    await wheel(p, 1_000_000)
    const back = await atTailSoon(p)
    check(
      'back at the bottom, the extra rows are dropped and chat flows',
      [...(back.atTail && !back.pillShown ? [] : ['not at the tail']), ...(back.rows <= ROW_CAP ? [] : [`${back.rows} rows`])],
      back,
    )

    // ── 5 reload ──
    const tab = await panel(p)
    await p.addInitScript(() => {
      const snaps: string[][] = []
      let sig = ''
      const tick = () => {
        const keys = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg[data-msg-key]')].map(
          (r) => (r as HTMLElement).dataset.msgKey as string,
        )
        const s = `${keys.length}:${keys.at(-1)}:${keys[0]}`
        if (keys.length && s !== sig && snaps.length < 150) {
          sig = s
          snaps.push(keys)
        }
        ;(window as any).__hsSnaps = snaps
      }
      setInterval(tick, 150)
    })
    await p.reload({ waitUntil: 'domcontentloaded' })
    await waitPanel(p)
    await sleep(15_000)
    const snaps: string[][] = await p.evaluate(() => (window as any).__hsSnaps || [])
    const fin = snaps.at(-1) || []
    const reorder = snaps.filter((s) => {
      const pos = new Map(fin.map((k, i) => [k, i]))
      const seen = s.filter((k) => pos.has(k)).map((k) => pos.get(k) as number)
      return seen.some((x, i) => i && x < seen[i - 1])
    }).length
    const stamps: string[] = await p.evaluate(() =>
      [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg .hs-mc-ts')].map((e) => e.textContent || ''),
    )
    const mins = stamps.map((s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)))
    const backwards = mins.filter((m, i) => i && m < mins[i - 1] && mins[i - 1] - m < 720).length
    const now = await panel(p)
    check(
      'a reload keeps the tab and the panel width',
      [
        ...(now.activeTab === tab.activeTab ? [] : [`tab ${tab.activeTab} → ${now.activeTab}`]),
        ...(now.box && tab.box && now.box[2] === tab.box[2] ? [] : [`width ${tab.box?.[2]} → ${now.box?.[2]}`]),
      ],
      { tab: tab.activeTab, box: tab.box, now: [now.activeTab, now.box] },
    )
    check(
      'after a reload history is drawn first: no row twice, none moves, times only go forward',
      [
        ...(snaps.length ? [] : ['no rows ever drew']),
        ...(snaps.some((s) => dupes(s)) ? ['a row showed twice'] : []),
        ...(reorder ? [`${reorder} frames had rows in another order than the end`] : []),
        ...(backwards ? [`${backwards} rows are older than the row above`] : []),
        ...(stamps.length ? [] : ['no timestamps to read']),
      ],
      { frames: snaps.length, rows: fin.length },
    )
    const flows = await rowsFlow(p, 30_000)
    check('chat flows after the reload', flows ? [] : ['the newest row never changed'])

    // ── 6 the whole leg ──
    const ring = await ringSince(p, t0)
    check(
      'no page errors, no console errors, a quiet watchdog',
      [
        ...(errs.length > errs0 ? errs.slice(errs0, errs0 + 2) : []),
        ...(cons.length > cons0 ? cons.slice(cons0, cons0 + 2) : []),
        ...ring.bad.filter((e) => !e.scrolledUp).slice(0, 3).map((e) => `${e.e} ${JSON.stringify(e).slice(0, 120)}`),
      ],
    )
    return 'done'
  } finally {
    await shot(p, `s20-${name}`)
    await p.close().catch(() => {})
  }
}

export async function s20Scroll() {
  scenario('s20 chat list scroll: pause, new pill, tail, older rows, reload')
  const tw = await liveChannels('twitch', 3)
  const kk = await liveChannels('kick', 3)
  const yt = await liveYtVideo()
  const env = await launch()
  const errs: string[] = []
  const cons: string[] = []
  try {
    await setUiSetting(env, 'timestamps', true)
    const legs: [string, string[]][] = [
      ['twitch', tw.map((c) => `https://www.twitch.tv/${c}`)],
      ['kick', kk.map((c) => `https://kick.com/${c}`)],
    ]
    if (yt) legs.push(['youtube', [`https://www.youtube.com/watch?v=${yt.id}`]])
    else info('youtube leg not run: no live video')
    for (const [name, urls] of legs)
      for (const [i, url] of urls.entries()) {
        const res = await leg(env, name, url, errs, cons).catch((e) => {
          bad(`${name}: the leg crashed: ${String(e?.message || e).slice(0, 200)}`)
          return 'done' as const
        })
        if (res === 'done') break
        info(`${name}: ${i + 1 < urls.length ? 'trying the next channel' : 'no channel busy enough'}`)
        if (i + 1 === urls.length) bad(`${name}: no channel was busy enough to judge the scroll`)
      }
  } finally {
    await env.close()
  }
}

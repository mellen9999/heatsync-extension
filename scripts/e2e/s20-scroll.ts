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
const TRIM_SLACK = 50 // appends run past the cap by a few rows before the next trim
const LATE_MS = 4000 // 2 × LIVE_WEAVE_SKEW_MS: how far behind the newest row a live line still counts as "now"

type View = {
  rows: number
  keys: string[]
  scrollTop: number
  atTail: boolean
  pillShown: boolean
  pillText: string
  newest: string | null
  anchor: { key: string; dy: number } | null
  tops: Record<string, number>
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
      // every row with a pixel on screen and where its top is: one row can be followed from look to look
      tops: Object.fromEntries(
        rows
          .map((r) => [r.dataset.msgKey as string, r.getBoundingClientRect()] as const)
          .filter(([, b]) => b.bottom > box.top && b.top < box.bottom)
          .map(([k, b]) => [k, Math.round((b.top - box.top) * 10) / 10]),
      ) as Record<string, number>,
    }
  })

// a pause with nothing new yet reads "resume": zero
const pillCount = (v: View) => (v.pillShown ? Number(v.pillText.match(NEW_RE)?.[1] ?? 0) : 0)
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

/** Rows drawn under a row more than 5s newer than they are: [how many, the first few as "index:seconds behind"].
 *  A live line may sit a couple of seconds out of order by design (it never moves a shown row); a row
 *  the list was given back (older rows, a refill after a card) belongs where its time puts it. */
async function outOfOrder(p: any): Promise<[number, string[]]> {
  return p.evaluate(() => {
    const o = ([...document.querySelectorAll('#hs-mc-messages > .hs-mc-msg[data-msg-key]')] as HTMLElement[]).map((r) => Number(r.dataset.hsOrd || r.dataset.msgTime || 0))
    let max = 0
    const late: string[] = []
    o.forEach((v, i) => {
      if (v && max - v > 5000) late.push(`${i}:${Math.round((max - v) / 1000)}s`)
      if (v > max) max = v
    })
    return [late.length, late.slice(0, 5)] as [number, string[]]
  })
}
const orderFails = ([n, first]: [number, string[]]) => (n ? [`${n} rows sit under rows newer than they are (${first.join(' ')})`] : [])

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
    // what the list does while the reader is paused, for the day the view moves: rows in and
    // out (with where they were), every scroll, and the first row in view whenever it changes
    await p.evaluate(() => {
      const l = document.getElementById('hs-mc-messages') as HTMLElement
      const w = window as any
      const log: unknown[] = (w.__hsPauseLog = [])
      const t0 = performance.now()
      const at = () => Math.round(performance.now() - t0)
      const idx = (n: Node) => [...l.children].indexOf(n as Element)
      const mo = new MutationObserver((recs) => {
        for (const r of recs) {
          for (const n of r.addedNodes) log.push([at(), '+', (n as HTMLElement).dataset?.msgKey?.slice(0, 6) || (n as HTMLElement).className, idx(n), l.children.length])
          for (const n of r.removedNodes) log.push([at(), '-', (n as HTMLElement).dataset?.msgKey?.slice(0, 6) || (n as HTMLElement).className, idx(r.nextSibling || l), l.children.length])
        }
      })
      mo.observe(l, { childList: true })
      const onScroll = (e: Event) => log.push([at(), e.type, Math.round(l.scrollTop), l.scrollHeight])
      l.addEventListener('scroll', onScroll, { passive: true })
      l.addEventListener('scrollend', onScroll, { passive: true })
      let was = ''
      const loop = () => {
        if (log.length > 400) return
        const top = l.getBoundingClientRect().top
        const first = ([...l.children] as HTMLElement[]).find((r) => r.getBoundingClientRect().bottom > top)
        const now = first ? `${first.dataset.msgKey?.slice(0, 6)}@${Math.round(first.getBoundingClientRect().top - top)}h${first.offsetHeight}` : ''
        if (now !== was) log.push([at(), 'top', now, Math.round(l.scrollTop), l.scrollHeight])
        was = now
        if (w.__hsPauseLog === log) requestAnimationFrame(loop)
      }
      loop()
      w.__hsPauseEnd = () => {
        mo.disconnect()
        l.removeEventListener('scroll', onScroll)
        l.removeEventListener('scrollend', onScroll)
        w.__hsPauseLog = null
        return log.slice(0, 120)
      }
    })
    await sleep(6000)
    let b = await view(p)
    for (let i = 0; i < 4 && pillCount(b) < 3; i++) {
      await sleep(5000)
      b = await view(p)
    }
    const pauseLog = await p.evaluate(() => (window as any).__hsPauseEnd?.())
    if (pillCount(b) < 3) {
      info(`${name}: ${pillCount(b)} new rows in 26s, too quiet to judge`)
      return 'quiet'
    }
    if (Math.abs(a.scrollTop - b.scrollTop) > 2) info(`${name}: rows above the screen changed height while paused (scrollTop ${a.scrollTop} → ${b.scrollTop})`)
    // the row at the top of the screen is what a reader sees hold: the same row is followed from the
    // first look to the second. the scroll number itself moves when rows above the screen grow (late
    // pictures) and the view is kept where it was; a row on screen growing pushes the ones under it
    const topKey = a.anchor?.key || ''
    const topNow = b.tops[topKey]
    const topMoved = topNow === undefined ? null : Math.round((topNow - a.tops[topKey]) * 10) / 10
    const topHeld = topMoved !== null && Math.abs(topMoved) <= 2
    if (topHeld && a.newest !== b.newest) info(`${name}: the top row held (${topMoved}px) and the last row on screen changed: a row on screen changed height`)
    check(
      'wheel up pauses: the newest row on screen and the scroll position hold while chat arrives',
      [
        ...(a.newest && (topHeld || a.newest === b.newest) ? [] : ['the newest row on screen changed']),
        ...(topHeld ? [] : [topMoved === null ? `the row at the top (${topKey.slice(0, 6)}) left the screen; now there: ${b.anchor?.key.slice(0, 6)} at ${b.anchor?.dy}px` : `the row at the top moved ${topMoved}px (${a.tops[topKey]} → ${topNow})`]),
        ...(pillCount(b) >= pillCount(a) ? [] : ['the incoming count went down']),
      ],
      { a: { ...a, keys: a.keys.length }, b: { ...b, keys: b.keys.length }, log: pauseLog },
    )

    // ── 2 the pill ──
    const n = pillCount(b)
    check(
      'the pill shows "N new" with a real number',
      [...(b.pillShown ? [] : ['no pill']), ...(Number.isInteger(n) && n > 0 ? [] : [`the pill reads "${b.pillText}"`])],
      b.pillText,
    )

    // ── 3a click the pill ──
    // a click that cannot land says why: is the pill there, is the page answering (github's runner,
    // 11-18: 30s with the pill never found, right after it was read as showing)
    await p.click('#hs-mc-new-msgs', { timeout: 15_000 }).catch(async (e: unknown) => {
      const st = await Promise.race([
        p.evaluate(() => {
          const b = document.getElementById('hs-mc-new-msgs') as HTMLElement | null
          const r = b?.getBoundingClientRect()
          const top = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null
          return {
            pill: b ? { display: getComputedStyle(b).display, text: b.textContent, box: r && [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] } : null,
            onTop: top ? `${top.tagName.toLowerCase()}#${top.id}.${String(top.className).slice(0, 60)}` : null,
            panel: !!document.getElementById('hs-mc-container'),
            url: location.href,
            hidden: document.hidden,
          }
        }),
        sleep(8000).then(() => 'the page did not answer in 8s'),
      ]).catch((x: unknown) => `evaluate threw: ${String(x).slice(0, 120)}`)
      info(`${name}: the pill click failed; the page says ${JSON.stringify(st).slice(0, 600)}`)
      throw e
    })
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
    // Nothing new drawn in 60s is a finding only if lines arrived and were held, and held lines
    // show on the pill ("N new"): at the tail with no pill, the channel went quiet, not the list.
    const flowsOrQuiet = async (what: string, from: string | undefined) => {
      if (await newestMoves(p, from, 60_000)) return check(what, [])
      const q = await view(p)
      if (q.atTail && !q.pillShown) info(`${name}: ${what}: no line arrived for 60s, too quiet to tell`)
      else check(what, [`the newest row never changed in 60s and the list reads paused (pill "${q.pillText}")`], q)
    }
    await flowsOrQuiet('rows flow again after the pill', kept)

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

    // ── 3b' End from the empty composer ──
    // where the keyboard is most of the time: End has no caret to move in an empty composer
    await pause(p)
    await sleep(3000)
    const c0 = await view(p)
    const typed = await p.evaluate(() => {
      const i = document.getElementById('hs-mc-input') as HTMLElement | null
      if (!i || !i.offsetParent) return null
      i.focus()
      return (i.textContent || (i as any).value || '').trim()
    })
    if (typed === '') {
      await p.keyboard.press('End')
      const c1 = await atTailSoon(p, 3)
      check(
        'End in the empty composer returns to the tail too',
        [...(c0.pillShown ? [] : ['the pause never showed the pill']), ...(c1.pillShown ? ['the pill is still there'] : []), ...(c1.atTail ? [] : ['the list is not at the bottom'])],
        { before: c0, after: c1 },
      )
      await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
    } else info(`${name}: no empty composer to press End in (${typed === null ? 'none shown' : 'it holds text'})`)

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
    await flowsOrQuiet('rows flow again after the wheel', k2)

    // ── 3d a card over the list ──
    // A card takes the whole pane. Scrolling inside it is not scrolling the chat, and a reader
    // who was scrolled up when they opened it is put back on the row they were reading.
    const cardUp = () => p.evaluate(() => document.documentElement.classList.contains('hs-mc-fill-on'))
    const openCard = async () => {
      for (let i = 0; i < 4 && !(await cardUp()); i++) {
        const at = await p.evaluate(() => {
          const ct = document.getElementById('hs-mc-messages') as HTMLElement
          const box = ct.getBoundingClientRect()
          const names = [...ct.querySelectorAll('.hs-mc-msg[data-msg-key] .hs-mc-user')] as HTMLElement[]
          const mid = box.top + box.height / 2
          const seen = names.map((n) => n.getBoundingClientRect()).filter((b) => b.width > 0 && b.top > box.top + 4 && b.bottom < box.bottom - 4)
          const b = seen.sort((x, y) => Math.abs(x.top - mid) - Math.abs(y.top - mid))[0]
          return b ? { x: b.left + Math.min(8, b.width / 2), y: b.top + b.height / 2 } : null
        })
        if (!at) break
        await p.mouse.click(at.x, at.y)
        await sleep(700)
      }
      return cardUp()
    }
    const closeCard = async () => {
      await p.keyboard.press('Escape')
      for (let i = 0; i < 10 && (await cardUp()); i++) await sleep(300)
      return !(await cardUp())
    }
    // the rows at the top of the view, each by its key and how far under the top edge it sits
    const topRows = () =>
      p.evaluate(() => {
        const ct = document.getElementById('hs-mc-messages') as HTMLElement
        const top = ct.getBoundingClientRect().top
        return ([...ct.querySelectorAll(':scope > .hs-mc-msg[data-msg-key]')] as HTMLElement[])
          .filter((r) => r.getBoundingClientRect().bottom > top)
          .slice(0, 6)
          .map((r) => `${(r.dataset.msgKey as string).slice(0, 6)}@${Math.round(r.getBoundingClientRect().top - top)}h${Math.round(r.getBoundingClientRect().height)}o${(r.dataset.hsOrd || r.dataset.msgTime || '').slice(-6)}`)
      })
    if (!(await openCard())) info(`${name}: no card opened from a name in view: the card step is not run`)
    else {
      await wheel(p, -300)
      await wheel(p, 200)
      await sleep(3000)
      const shut = await closeCard()
      const c = await atTailSoon(p)
      check(
        'a card opened at the tail, scrolled inside, closed: the chat is at its tail and not paused',
        [...(shut ? [] : ['Escape did not close the card']), ...(c.pillShown ? [`a "${c.pillText}" pill is up`] : []), ...(c.atTail ? [] : ['the list is not at the bottom'])],
        c,
      )
      await sleep(1500) // the list refills in steps after the card
      check('after the card the list is in order, oldest to newest', orderFails(await outOfOrder(p)))
      if (!shut) await p.keyboard.press('Escape')
      const read = await pause(p)
      const topWas = await topRows()
      if (!read.pillShown || !read.anchor) info(`${name}: the list did not pause (${read.rows} rows): the paused card step is not run`)
      else if (!(await openCard())) info(`${name}: no card opened from the paused list`)
      else {
        const keptAt = (await dbg(p)).reader?.kept
        await wheel(p, -300)
        await sleep(5000) // chat goes on behind the card
        // what the pane does from the close on, frame by frame: evidence for a red check below
        await p.evaluate((key: string) => {
          const ct = document.getElementById('hs-mc-messages') as HTMLElement
          const log: any[] = []
          ;(window as any).__hsCardLog = log
          const t0 = performance.now()
          const at = () => Math.round(performance.now() - t0)
          const mo = new MutationObserver((ms) => {
            let add = 0
            let del = 0
            for (const m of ms) {
              if (m.target !== ct) continue
              add += m.addedNodes.length
              del += m.removedNodes.length
            }
            if (add || del) log.push({ t: at(), rows: [add, del] })
            // the rows as the redraw left them, before any picture in them has loaded: a frame
            // comes too late for that (the first one after a 500-row draw is 100ms and more on)
            if (add > 1 && !drawn) {
              const kids = [...ct.children] as HTMLElement[]
              const row = kids.find((r) => r.dataset?.msgKey === key)
              const top = ct.getBoundingClientRect().top
              drawn = new Map(kids.map((r) => [r, r.getBoundingClientRect().height]))
              log.push({ t: at(), drawn: kids.length, st: Math.round(ct.scrollTop), dy: row ? Math.round(row.getBoundingClientRect().top - top) : null, pending: kids.reduce((n, r) => n + [...r.querySelectorAll('img')].filter((i) => !(i as HTMLImageElement).complete).length, 0) })
            }
          })
          let drawn: Map<HTMLElement, number> | null = null
          mo.observe(ct, { childList: true })
          const onScroll = () => log.push({ t: at(), scroll: Math.round(ct.scrollTop) })
          ct.addEventListener('scroll', onScroll)
          let last = ''
          let h0: Map<HTMLElement, number> | null = null
          let told = false
          const tick = () => {
            const row = ([...ct.children] as HTMLElement[]).find((r) => r.dataset?.msgKey === key)
            const kids = [...ct.children] as HTMLElement[]
            // which rows change height after they are drawn, and what is in them
            if (!h0 && kids.length > 1) h0 = new Map(kids.map((r) => [r, r.getBoundingClientRect().height]))
            if (h0 && !told && at() > 1500) {
              told = true
              // …and against the rows as drawn: what grew before the first frame
              if (drawn) {
                const idx = row ? kids.indexOf(row) : -1
                const early = kids
                  .map((r, i) => ({ r, i, from: drawn?.get(r), to: r.getBoundingClientRect().height }))
                  .filter((x) => x.from !== undefined && Math.abs(x.to - (x.from as number)) > 2)
                log.push({
                  t: at(),
                  grewSinceDrawn: early.length,
                  aboveKept: Math.round(early.filter((x) => x.i < idx).reduce((n, x) => n + x.to - (x.from as number), 0)),
                  sample: early.slice(0, 4).map((x) => ({ from: Math.round(x.from as number), to: Math.round(x.to), imgs: [...x.r.querySelectorAll('img')].map((e) => `${e.className.split(' ')[0]}[${e.getAttribute('width') || '-'}x${e.getAttribute('height') || '-'}→${(e as HTMLImageElement).width}x${(e as HTMLImageElement).height}]`).slice(0, 4) })),
                })
              }
              const grew = kids
                .filter((r) => h0?.has(r) && Math.abs(r.getBoundingClientRect().height - (h0.get(r) as number)) > 2)
                .slice(0, 6)
                .map((r) => ({
                  from: Math.round(h0?.get(r) as number),
                  to: Math.round(r.getBoundingClientRect().height),
                  cls: r.className.slice(0, 80),
                  parts: [...r.querySelectorAll('*')].map((e) => `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).split(' ')[0]}${e instanceof HTMLImageElement ? `[${e.getAttribute('width') || '-'}x${e.getAttribute('height') || '-'}→${e.width}x${e.height}]` : ''}`).slice(0, 14),
                }))
              log.push({ t: at(), grew })
            }
            const above = row ? kids.slice(Math.max(0, kids.indexOf(row) - 4), kids.indexOf(row)).map((r) => Math.round(r.getBoundingClientRect().height)) : []
            const s = JSON.stringify({ st: Math.round(ct.scrollTop), sh: ct.scrollHeight, kids: kids.length, dy: row ? Math.round(row.getBoundingClientRect().top - ct.getBoundingClientRect().top) : null, above })
            if (s !== last && log.length < 80) log.push({ t: at(), ...JSON.parse(s) })
            last = s
            if (at() < 8000) requestAnimationFrame(tick)
            else {
              mo.disconnect()
              ct.removeEventListener('scroll', onScroll)
            }
          }
          tick()
        }, keptAt?.key || read.anchor.key)
        await closeCard()
        await sleep(1200)
        const b2 = await view(p)
        // the row itself, by its key: the list is rebuilt in message order, so a neighbour that
        // arrived out of order may sit on the other side of it now
        const dyNow = await p.evaluate((key: string) => {
          const ct = document.getElementById('hs-mc-messages') as HTMLElement
          const row = ([...ct.querySelectorAll('.hs-mc-msg[data-msg-key]')] as HTMLElement[]).find((r) => r.dataset.msgKey === key)
          return row ? Math.round(row.getBoundingClientRect().top - ct.getBoundingClientRect().top) : null
        }, read.anchor.key)
        const had = new Set(read.keys)
        const newer = b2.keys.filter((k) => !had.has(k))
        // lines stamped with the same instant as the newest row on screen come with the redraw
        // (kick stamps to the second): a few, and only ever beside rows of that same instant
        const ordOf: Record<string, number> = await p.evaluate(() =>
          Object.fromEntries(
            ([...document.querySelectorAll('#hs-mc-messages .hs-mc-msg[data-msg-key]')] as HTMLElement[]).map((r) => [r.dataset.msgKey, Number(r.dataset.hsOrd || r.dataset.msgTime || 0)]),
          ),
        )
        const newestHad = Math.max(0, ...b2.keys.filter((k) => had.has(k)).map((k) => ordOf[k] || 0))
        // a rebuild draws in message order, so a line that came a moment late (stamped up to
        // LATE_MS before a row already shown, the window the live path treats as "now") takes its
        // place among those last rows. Anything older appearing among the rows is a finding.
        const behind = newer.map((k) => newestHad - (ordOf[k] || 0)).filter((d) => d > 0)
        const among = behind.filter((d) => d > LATE_MS)
        // The redraw is in message order, the live list is in arrival order: a line that came in
        // a beat late sat under rows a little newer than itself, and the redraw puts it above
        // them. So rows inside the late window may change sides of the row being read (and push
        // it by their height); a row from further away changing sides is the list out of order.
        // The same goes for the row the list holds on to (the one cut by the top edge): a late line
        // that sat above it and now sits under it pushes the row being read by its height
        // (twitch 11-18: stamped 7ms after the held row, drawn above it, 41px).
        const a = read.anchor.key
        const [iB, iA] = [read.keys.indexOf(a), b2.keys.indexOf(a)]
        const sides = (ref: string) => {
          const [b, n] = [read.keys.indexOf(ref), b2.keys.indexOf(ref)]
          return b < 0 || n < 0 ? [] : b2.keys.filter((k) => k !== ref && had.has(k) && read.keys.indexOf(k) > b !== b2.keys.indexOf(k) > n)
        }
        const farOf = (ref: string, ks: string[]) => ks.filter((k) => Math.abs((ordOf[k] || 0) - (ordOf[ref] || 0)) > LATE_MS)
        const [crossedA, crossedK] = [sides(a), keptAt?.key && keptAt.key !== a ? sides(keptAt.key) : []]
        const crossed = [...new Set([...crossedA, ...crossedK])]
        const far = [...new Set([...farOf(a, crossedA), ...farOf(keptAt?.key || a, crossedK)])]
        const moved = dyNow === null ? 0 : dyNow - read.anchor.dy
        if (crossed.length && !far.length) info(`${name}: ${crossed.length} late lines took their place around the row being read (it moved ${moved}px)`)
        // the row the list itself held on to (the one cut by the top edge) must not move at all
        const keptNow = keptAt?.key
          ? await p.evaluate((key: string) => {
              const ct = document.getElementById('hs-mc-messages') as HTMLElement
              const row = ([...ct.querySelectorAll('.hs-mc-msg[data-msg-key]')] as HTMLElement[]).find((r) => r.dataset.msgKey === key)
              return row ? row.getBoundingClientRect().top - ct.getBoundingClientRect().top : null
            }, keptAt.key)
          : null
        check(
          'a card opened by a reader who had scrolled up, closed: the row they were on is where it was, still paused, nothing newer drawn',
          [
            ...(dyNow === null ? ['the row being read is gone'] : Math.abs(moved) > 3 && !crossed.length ? [`the row moved ${moved}px`] : []),
            ...(far.length ? [`${far.length} rows from outside the late window changed sides of the row being read`] : []),
            ...(keptAt?.key && keptNow !== null && Math.abs(keptNow - keptAt.dy) > 3 ? [`the row at the top edge moved ${Math.round(keptNow - keptAt.dy)}px`] : []),
            ...(b2.pillShown ? [] : ['the pause is gone']),
            ...(among.length ? [`${among.length} rows that were not on screen before were drawn among the ones that were`] : []),
            ...(newer.length > 60 ? [`${newer.length} rows newer than the ones being read were drawn below them`] : []),
            ...orderFails(await outOfOrder(p)),
          ],
          { before: read.anchor, after: dyNow, pill: b2.pillText, rows: [read.rows, b2.rows], newer: newer.slice(0, 3), behind, crossed: crossed.map((k) => `${k.slice(0, 6)}:${read.keys.indexOf(k) - iB}>${b2.keys.indexOf(k) - iA}o${(ordOf[k] || 0) - (ordOf[a] || 0)}`).slice(0, 30), top: [topWas, await topRows()], kept: keptAt, frames: await p.evaluate(() => (window as any).__hsCardLog) },
        )
      }
      await wheel(p, 1_000_000)
      await atTailSoon(p)
    }

    // ── 4 older rows ──
    // older rows are painted from the buffer: with nothing beyond the 500 on screen there is nothing to load
    let held = name === 'youtube' ? 0 : await buffered(p)
    for (let i = 0; i < 9 && held < LIVE_CAP + 150 && name !== 'youtube'; i++) {
      await sleep(10_000)
      held = await buffered(p)
    }
    // what the list sorts by, read off the rows: the newest value on screen, and the row that holds it
    const ords = () =>
      p.evaluate(() => {
        const rows = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg[data-msg-key]')] as HTMLElement[]
        let max = 0
        let at = -1
        rows.forEach((r, i) => {
          const o = Number(r.dataset.hsOrd || r.dataset.msgTime || 0)
          if (o > max) {
            max = o
            at = i
          }
        })
        const r = rows[at]
        return { max, at, of: rows.length, cls: r?.className.slice(0, 60), text: (r?.textContent || '').trim().slice(0, 60), now: Date.now() }
      })
    await pause(p)
    let top = await view(p)
    const before = top.rows
    const ordsBefore = await ords()
    let anchor = top.anchor
    let anchorAt = top.keys.indexOf(anchor?.key as string)
    let keysWere: string[] = top.keys
    for (let i = 0; i < 60 && top.scrollTop > 0 && top.rows === before; i++) {
      anchor = top.anchor
      anchorAt = top.keys.indexOf(anchor?.key as string)
      keysWere = top.keys
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
        ...(olderExist && before >= LIVE_CAP - 20 && after.rows <= LIVE_CAP ? [`still ${after.rows} rows, never past ${LIVE_CAP}`] : []),
        ...(dupes(after.keys) ? [`${dupes(after.keys)} rows twice`] : []),
        ...(after.rows <= ROW_CAP ? [] : [`${after.rows} rows, cap is ${ROW_CAP}`]),
      ],
      { before, after: after.rows },
    )
    // A channel live on two sites is one list with two histories of unequal depth: a quiet kick
    // side reaches back a day, the twitch side eight minutes. The rows at the very top are then
    // older than anything a load brings, and the older rows land under them, in time order
    // (real twitch+kick channel, 11-18). Told apart by what the list sorts by.
    let underOlder = 0
    if (olderExist && after.rows > before && row >= 0 && row <= anchorAt) {
      const had = new Set(keysWere)
      const ordOf: Record<string, number> = await p.evaluate(() =>
        Object.fromEntries(
          ([...document.querySelectorAll('#hs-mc-messages .hs-mc-msg[data-msg-key]')] as HTMLElement[]).map((r) => [r.dataset.msgKey, Number(r.dataset.hsOrd || r.dataset.msgTime || 0)]),
        ),
      )
      const came = after.keys.filter((k) => !had.has(k))
      const at = ordOf[anchor?.key as string] || 0
      if (at && came.length && came.every((k) => (ordOf[k] || 0) >= at)) underOlder = came.length
      if (underOlder) info(`${name}: the row at the top is older than all ${underOlder} rows the load brought (two histories in one list): they landed under it`)
    }
    // with nothing older to load, the rows that grew the list are the ones that arrived below
    if (olderExist && after.rows > before)
      check(
        'the row at the top stays where it was while older rows load',
        [
          ...(row >= 0 ? [] : ['the row we were looking at is gone']),
          // rows that came in while paused are drawn at the bottom by the same redraw, so the count
          // above is not the whole difference: what must hold is that the new rows above are above it
          ...(row > anchorAt || underOlder ? [] : [`no row was added above it (row ${anchorAt} before, ${row} after)`]),
          ...orderFails(await outOfOrder(p)),
        ],
        { anchor, at: [anchorAt, row], rows: [before, after.rows], ords: [ordsBefore, await ords()], reader: (await dbg(p)).reader },
      )
    await wheel(p, 1_000_000)
    let back = await atTailSoon(p)
    // the extra rows go with the next row that arrives, not with the scroll itself
    for (let i = 0; i < 15 && back.rows > LIVE_CAP + TRIM_SLACK; i++) {
      await sleep(1000)
      back = await view(p)
    }
    // the drop and the pin that follows it are two frames: read the tail once both have happened
    if (!back.atTail) back = await atTailSoon(p)
    check(
      'back at the bottom, the extra rows are dropped and chat flows',
      [...(back.atTail && !back.pillShown ? [] : ['not at the tail']), ...(back.rows <= LIVE_CAP + TRIM_SLACK ? [] : [`${back.rows} rows, the live tail holds at most ${LIVE_CAP}`])],
      back,
    )

    // ── 5 reload ──
    // whether chat was arriving before the reload: a stream nobody talks in cannot show that it flows after one
    const flowedBefore = await rowsFlow(p, 30_000)
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
    // a clock time has no day in it: a row from yesterday noon above one from this morning is
    // in order (a quiet kick side of a two-site channel), so the clock only counts where what
    // the list sorts by went backwards too
    const stamped: { ts: string; ord: number }[] = await p.evaluate(() =>
      ([...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')] as HTMLElement[])
        .filter((r) => r.querySelector('.hs-mc-ts'))
        .map((r) => ({ ts: r.querySelector('.hs-mc-ts')?.textContent || '', ord: Number(r.dataset.hsOrd || r.dataset.msgTime || 0) })),
    )
    const stamps = stamped.map((r) => r.ts)
    const mins = stamps.map((s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)))
    const backAt = mins
      .map((m, i) => (i && m < mins[i - 1] && mins[i - 1] - m < 720 && !(stamped[i].ord && stamped[i].ord >= stamped[i - 1].ord) ? i : -1))
      .filter((i) => i > 0)
    const backwards = backAt.length
    // which rows: the pair, what kind of row each is and where in the list it sits
    const backRows = backwards
      ? await p.evaluate((at: number[]) => {
          const rows = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].filter((r) => r.querySelector('.hs-mc-ts'))
          const one = (r: Element | undefined) =>
            r && {
              ts: r.querySelector('.hs-mc-ts')?.textContent,
              key: (r as HTMLElement).dataset.msgKey,
              cls: r.className.replace(/hs-mc-msg\s*/, '').slice(0, 80),
              text: (r.textContent || '').slice(0, 70),
            }
          return at.slice(0, 3).map((i) => ({ at: i, of: rows.length, above: one(rows[i - 1]), row: one(rows[i]), below: one(rows[i + 1]) }))
        }, backAt)
      : []
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
        ...orderFails(await outOfOrder(p)),
        ...(stamps.length ? [] : ['no timestamps to read']),
      ],
      { frames: snaps.length, rows: fin.length, backRows },
    )
    const flows = await rowsFlow(p, 30_000)
    if (!flows && !flowedBefore) info(`${name}: no line arrived for 30s before the reload or after it: too quiet to tell that chat flows`)
    else check('chat flows after the reload', flows ? [] : ['the newest row never changed'])

    // ── 6 the whole leg ──
    const ring = await ringSince(p, t0)
    check(
      'no page errors, no console errors, a quiet watchdog',
      [
        ...(errs.length > errs0 ? errs.slice(errs0, errs0 + 2) : []),
        ...(cons.length > cons0 ? cons.slice(cons0, cons0 + 2) : []),
        ...ring.bad.slice(0, 3).map((e) => `${e.e} ${JSON.stringify(e).slice(0, 300)}`),
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
          bad(`${name}: the leg crashed: ${String(e?.message || e).replace(/\u001b\[\d+m/g, '').slice(0, 700)}`)
          return 'done' as const
        })
        if (res === 'done') break
        info(`${name}: ${i + 1 < urls.length ? 'trying the next channel' : 'no channel busy enough'}`)
        // twitch and kick always have a busy channel: none there is a broken scenario. youtube's
        // stand-in streams are 24/7 radios whose chat sleeps at night: said out loud, not failed
        // (that youtube rows arrive at all is s5's and s25's to prove)
        if (i + 1 === urls.length && name !== 'youtube') bad(`${name}: no channel was busy enough to judge the scroll`)
      }
  } finally {
    await env.close()
  }
}

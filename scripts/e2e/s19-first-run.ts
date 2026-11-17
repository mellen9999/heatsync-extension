/**
 * s19 — a brand-new user's first five minutes, on a fresh profile, signed out. Everything a
 * person meets before they have set anything up, in the order they meet it:
 *   1 the welcome page that opens by itself on install: renders clean, every link and button
 *     does what it says, no raw translation keys, the page writes nothing it shouldn't
 *   2 the first stream on each site: the panel mounts, the tour shows on the FIRST site only,
 *     every card sits fully on screen with its arrow on a real, visible target, the tour is
 *     once per device (seen flag in storage; not back after a reload or on the other sites)
 *   3 the signed-out tabs: feed, discover, saved draw something (rows or an explicit state,
 *     never a blank pane or a spinner left up), no broken pictures, a post opens its thread and
 *     back returns, a picture opens full size and Esc closes it, a #tag shows its card; then
 *     back on the live chat rows flow
 *   4 the toolbar popup page: its controls, each toggled and toggled back to the exact value
 *   5 throughout: page errors, console errors from our code, the add-on's error log, the
 *     watchdog ring since the start
 *
 *   bun scripts/e2e/run.ts --only s19
 *
 * Nothing is sent, posted or signed in. The popup's feedback send is never pressed.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bad,
  extStorage,
  info,
  launch,
  liveChannels,
  liveYtVideo,
  ok,
  panel,
  ROOT,
  ringSince,
  rowsFlow,
  scenario,
  shot,
  sleep,
  waitPanel,
  watchErrors,
} from './lib'

const RAW_KEY = /\b(mc|lib|btn|content|hsbtn|welcome|popup|common)_[a-z0-9_]{3,}\b/
const MSG = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8'))
const L = (k: string): string => MSG[k]?.message ?? k
const TOUR_IDS = ['menu', 'cmd', 'find', 'tabs', 'settings', 'switches']
// tabs that are not a chat: whatever else is visible is the stream's own tab
const NOT_CHAT = new Set(['feed', 'discover', 'whispers', 'mentions', 'pinned', 'modlog', 'add', 'settings', 'popout', 'collapse', 'actions', 'subscribe'])

const stored = (env: any, keys: string | string[]) =>
  // @ts-ignore — extension page
  extStorage(env, async (k: any) => chrome.storage.local.get(k), keys) as Promise<Record<string, any>>
const syncUi = (env: any) =>
  // @ts-ignore — extension page
  extStorage(env, async () => (await chrome.storage.sync.get('ui_settings')).ui_settings || {}) as Promise<Record<string, any>>

/** Poll until fn() is truthy; returns its last value either way. */
async function until<T>(fn: () => Promise<T>, ms: number, every = 300): Promise<T> {
  const t0 = Date.now()
  let v = await fn()
  while (!v && Date.now() - t0 < ms) {
    await sleep(every)
    v = await fn()
  }
  return v
}

export async function s19FirstRun() {
  scenario('s19 first run: welcome, the tour, the signed-out tabs, the popup')
  const t0 = Date.now()
  const [tw] = await liveChannels('twitch', 1)
  const [kk] = await liveChannels('kick', 1)
  const yt = await liveYtVideo()
  if (!yt) info('skipped: no live youtube stream for this ip, youtube leg not run')

  const errs: string[] = []
  const cons: string[] = []
  const extErrs = new Map<any, string[]>() // per page: errors an extension page threw
  const env = await launch({
    keepWelcome: true,
    onPage: (pg: any) => {
      const mine: string[] = []
      extErrs.set(pg, mine)
      pg.on('pageerror', (e: unknown) => mine.push(`pageerror: ${String(e).slice(0, 200)}`))
      pg.on('console', (m: any) => {
        if (m.type() === 'error') mine.push(`console.error: ${String(m.text()).slice(0, 200)}`)
      })
    },
  })
  // "X never happens" needs a recorder that lives through navigations, not a poll: the tour card
  // un-hidden at any moment, or its arrow drawn
  await env.ctx.addInitScript(() => {
    // @ts-ignore
    window.__tourSeen = 0
    // @ts-ignore
    window.__arrowSeen = 0
    const look = () => {
      const n = document.getElementById('hs-mc-tour')
      // @ts-ignore
      if (n && !n.hidden) window.__tourSeen = 1
      // @ts-ignore
      if (document.getElementById('hs-mc-tour-arrow')) window.__arrowSeen = 1
    }
    new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] })
  })
  try {
    // ── 1 welcome ──────────────────────────────────────────────────────────────
    const w = env.welcome
    if (!w) return bad('the install did not open the welcome page by itself', env.ctx.pages().map((p: any) => p.url()))
    ok('welcome page opened by itself on install')
    await w.waitForLoadState('load')
    await w.reload({ waitUntil: 'load' }) // the first load's errors were caught by the hook; this one proves a second
    await sleep(1000)
    const wp = await w.evaluate(() => {
      const keyed = [...document.querySelectorAll('[data-i18n]')] as HTMLElement[]
      return {
        title: document.title,
        text: document.body.innerText,
        // a translated element still showing its own key, or empty
        untranslated: keyed
          .filter((e) => !e.hidden && (e.textContent || '').trim() === (e.dataset.i18n || '') || !(e.textContent || '').trim())
          .map((e) => e.dataset.i18n),
        links: [...document.querySelectorAll('a[href]')]
          .filter((a) => (a as HTMLElement).offsetParent)
          .map((a) => ({ href: (a as HTMLAnchorElement).href, target: (a as HTMLAnchorElement).target, rel: (a as HTMLAnchorElement).rel, text: (a.textContent || '').trim() })),
        dir: document.documentElement.dir,
      }
    })
    const raw = wp.text.match(RAW_KEY) || RAW_KEY.exec(wp.title)
    if (raw || wp.untranslated.length) bad('welcome shows a raw translation key', { raw: raw?.[0], untranslated: wp.untranslated, text: wp.text.slice(0, 300) })
    else ok(`welcome text is words (title "${wp.title}", ${wp.links.length} links)`)
    if (!wp.links.length) bad('welcome has no visible links', wp.text.slice(0, 200))
    const mine = extErrs.get(w) || []
    if (mine.length) bad('welcome threw', mine)
    else ok('welcome: no page errors, no console errors')
    // what the page and the install wrote (read before any link opens a site: a site's panel consumes the flag)
    const st0 = await stored(env, ['hs_fresh_install_hidden_tabs', 'hs_tour_seen', 'hs_tour_step', 'auth_token_encrypted'])
    if (st0.hs_tour_seen !== undefined || st0.hs_tour_step !== undefined) bad('welcome marked the tour seen/stepped', st0)
    else ok('welcome did not touch the tour flags')
    if (st0.hs_fresh_install_hidden_tabs !== true) bad('install did not stamp hs_fresh_install_hidden_tabs', st0)
    // every link: a click opens the place it names, in a new tab, never in the welcome tab
    const DOMAINS = ['twitch.tv', 'kick.com', 'youtube.com', 'heatsync.org', 'github.com']
    for (const l of wp.links) {
      const dom = DOMAINS.find((d) => new URL(l.href).hostname.endsWith(d))
      if (!dom || l.target !== '_blank' || !/noopener/.test(l.rel)) {
        bad(`welcome link "${l.text}" is not a safe new-tab link to a known site`, l)
        continue
      }
      const [pop] = await Promise.all([env.ctx.waitForEvent('page', { timeout: 10_000 }).catch(() => null), w.click(`a[href="${l.href.replace(/"/g, '\\"')}"]`)])
      if (!pop) {
        bad(`welcome link "${l.text}" opened nothing`, l)
        continue
      }
      await pop.waitForURL((u: URL) => u.toString() !== 'about:blank', { timeout: 15_000 }).catch(() => {})
      const got = pop.url()
      if (!new URL(got || 'about:blank').hostname.endsWith(dom)) bad(`welcome link "${l.text}" went to ${got}`, l)
      else ok(`welcome link "${l.text}" → ${new URL(got).hostname}`)
      await pop.close().catch(() => {})
    }
    if (!w.url().includes('welcome')) bad('a welcome link navigated the welcome tab away', w.url())
    // the live success state: the sign-in link swaps for "you're in" when a token lands, and back
    const swap = async (v: boolean) => {
      await w.evaluate(
        // @ts-ignore — extension page
        async (on: boolean) => (on ? chrome.storage.local.set({ auth_token_encrypted: 'e2e-fake' }) : chrome.storage.local.remove('auth_token_encrypted')),
        v,
      )
      return until(
        () => w.evaluate((on: boolean) => {
          const vis = (s: string) => !!(document.querySelector(s) as HTMLElement | null)?.offsetParent
          return vis('[data-when="in"]') === on && vis('[data-when="out"]') === !on
        }, v),
        4000,
      )
    }
    const errCount = async () => ((await stored(env, 'hs_errors')).hs_errors || []).length
    const e0 = await errCount()
    if (await swap(true)) ok('welcome swaps to "you\'re in" when a token lands')
    else bad('welcome did not swap sign-in for "you\'re in"', await w.evaluate(() => document.body.innerText))
    if (await swap(false)) ok('welcome swaps back to sign in when the token goes')
    else bad('welcome did not swap back to sign in', await w.evaluate(() => document.body.innerText))
    await sleep(1500)
    if ((await stored(env, 'auth_token_encrypted')).auth_token_encrypted !== undefined) bad('the test token is still in storage (something rewrote it)')
    if ((await errCount()) > e0) bad('a token appearing and going logged add-on errors', (await stored(env, 'hs_errors')).hs_errors?.slice(-3))
    await w.click('#hs-close-btn')
    if (await until(async () => w.isClosed(), 3000)) ok('welcome close button closes the tab')
    else bad('welcome close button did not close the tab', extErrs.get(w))

    // ── 2 the first stream on each site, and the tour ───────────────────────────
    const open = async (name: string, url: string) => {
      const p = await env.ctx.newPage()
      watchErrors(p, name, errs)
      p.on('console', (m: any) => {
        const text = String(m.text())
        if (m.type() === 'error' ? /heatsync|Error in event handler/i.test(text) : m.type() === 'warning' && /^\[heatsync\].*(fail|threw|error|exception)/i.test(text))
          cons.push(`${name} ${m.type()}: ${text.slice(0, 160)}`)
      })
      await p.goto(url, { waitUntil: 'domcontentloaded' })
      if (!(await waitPanel(p))) {
        bad(`${name}: the panel never mounted`, await panel(p))
        return null
      }
      return p
    }
    const tourState = (p: any) =>
      p.evaluate(() => ({
        // @ts-ignore
        shown: window.__tourSeen as number,
        // @ts-ignore
        arrow: window.__arrowSeen as number,
      }))
    const p1 = await open('twitch', `https://www.twitch.tv/${tw}`)
    if (!p1) return
    ok('twitch: panel mounted')
    if (!(await rowsFlow(p1, 45_000))) bad('twitch: chat rows never flowed', await panel(p1))
    // the tour, card by card
    const card = (p: any) =>
      p.evaluate((ids: string[]) => {
        const q = (s: string) => document.querySelector(s) as HTMLElement | null
        const vw = innerWidth
        const vh = innerHeight
        const inView = (r: DOMRect) => r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh
        const n = q('#hs-mc-tour')
        if (!n || n.hidden) return null
        const cr = n.getBoundingClientRect()
        const num = q('.hs-mc-tour-n')?.textContent || ''
        const idx = Number.parseInt(num, 10) - 1
        const id = ids[idx]
        // the same things tour.js points at
        const sel: Record<string, string> = { cmd: '#hs-mc-input', find: '#hs-mc-search-bar', tabs: '.hs-mc-tabs-scroll .hs-mc-tab.active', settings: '#hs-mc-tabbar [data-tab="settings"]' }
        let tgt: DOMRect | null = null
        if (id === 'menu') {
          const rows = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')] as HTMLElement[]
          const r = rows.reverse().find((x) => x.getBoundingClientRect().height > 0)
          tgt = r ? r.getBoundingClientRect() : null
        } else if (sel[id]) tgt = (q(sel[id]) || (id === 'tabs' ? q('.hs-mc-tabs-scroll') : null))?.getBoundingClientRect() || null
        const a = q('#hs-mc-tour-arrow')
        const ar = a?.getBoundingClientRect()
        const hit = ar && !(ar.right <= cr.left || ar.left >= cr.right || ar.bottom <= cr.top || ar.top >= cr.bottom)
        return {
          num,
          idx,
          id,
          title: q('.hs-mc-tour-t')?.textContent || '',
          line: q('.hs-mc-tour-d')?.hidden ? '' : q('.hs-mc-tour-d')?.textContent || '',
          cardRect: [Math.round(cr.left), Math.round(cr.top), Math.round(cr.right), Math.round(cr.bottom)],
          cardIn: inView(cr),
          viewport: [vw, vh],
          target: tgt ? inView(tgt) || (tgt.width > 0 && tgt.height > 0) : null,
          tgtRect: tgt && [Math.round(tgt.left), Math.round(tgt.top), Math.round(tgt.width), Math.round(tgt.height)],
          arrow: ar ? { glyph: a?.textContent, in: inView(ar), onCard: !!hit, rect: [Math.round(ar.left), Math.round(ar.top)] } : null,
          rows: [...n.querySelectorAll('.hs-mc-tour-row')].filter((r) => (r as HTMLElement).offsetParent).map((r) => (r.textContent || '').trim()),
          text: n.innerText,
          next: !!q('.hs-mc-tour-next')?.offsetParent,
          back: !!q('.hs-mc-tour-back')?.offsetParent,
          done: !!q('.hs-mc-tour-done')?.offsetParent,
        }
      }, TOUR_IDS)
    if (!(await p1.waitForSelector('#hs-mc-tour:not([hidden])', { timeout: 30_000 }).then(() => true, () => false)))
      return bad('twitch: the tour did not show on the first stream of a fresh install', { ...(await tourState(p1)), panel: await panel(p1) })
    ok('twitch: the tour shows on the first site')
    let resumed = false
    for (let i = 0; i < TOUR_IDS.length; i++) {
      const id = TOUR_IDS[i]
      await p1.waitForFunction((n: string) => document.querySelector('.hs-mc-tour-n')?.textContent === n, `${i + 1}/${TOUR_IDS.length}`, { timeout: 5000 }).catch(() => {})
      // the arrow is drawn by an observer a frame or two after the card
      const c: any = await until(async () => {
        const s: any = await card(p1)
        return s && (id === 'switches' || s.arrow) ? s : null
      }, 4000, 200) || (await card(p1))
      if (!c) {
        bad(`tour card ${i + 1}/${TOUR_IDS.length} (${id}) vanished`, await tourState(p1))
        break
      }
      const where = `tour ${c.num} ${id}`
      if (c.idx !== i) bad(`${where}: expected card ${i + 1}`, c.num)
      if (!c.cardIn) bad(`${where}: the card is not fully on screen`, { card: c.cardRect, viewport: c.viewport })
      if (RAW_KEY.test(c.text) || !c.title.trim() || (id !== 'switches' && !c.line.trim())) bad(`${where}: card text is raw or empty`, c.text)
      if (id !== 'switches') {
        if (!c.target) bad(`${where}: the thing it points at is not on screen`, { tgt: c.tgtRect })
        else if (!c.arrow) bad(`${where}: the target is there but no arrow is drawn`, { tgt: c.tgtRect, card: c.cardRect })
        else if (!c.arrow.in || c.arrow.onCard) bad(`${where}: the arrow is off screen or on top of the card`, { arrow: c.arrow, card: c.cardRect })
        else ok(`${where}: card on screen, arrow ${c.arrow.glyph} on its target`)
      } else {
        if (c.rows.length < 3) bad(`${where}: the switches card shows ${c.rows.length} switches (want 3+)`, c.rows)
        else ok(`${where}: switches shown (${c.rows.length}), card on screen`)
        if (c.arrow) bad(`${where}: the last card points an arrow though it has no target`, c.arrow)
      }
      if (i === 2 && !resumed) {
        // progress is kept: a reload resumes where the viewer stopped
        resumed = true
        const step = await until(async () => (await stored(env, 'hs_tour_step')).hs_tour_step === 2, 4000)
        if (!step) bad('tour: the step was not saved at card 3', await stored(env, ['hs_tour_step', 'hs_tour_seen']))
        await p1.reload({ waitUntil: 'domcontentloaded' })
        const back = await p1.waitForFunction(() => document.querySelector('.hs-mc-tour-n')?.textContent === '3/6' && !(document.getElementById('hs-mc-tour') as HTMLElement).hidden, null, { timeout: 30_000 }).then(() => true, () => false)
        if (back) ok('tour: a reload mid-tour resumes at card 3')
        else bad('tour: a reload mid-tour did not resume at card 3', await card(p1))
      }
      if (i < TOUR_IDS.length - 1) {
        if (!c.next) {
          bad(`${where}: no visible next button`)
          break
        }
        await p1.click('.hs-mc-tour-next', { timeout: 5000 })
      }
    }
    await p1.click('.hs-mc-tour-done', { timeout: 5000 }).catch((e: Error) => bad('tour: the final button is not clickable', String(e).slice(0, 160)))
    const seen = await until(async () => (await stored(env, 'hs_tour_seen')).hs_tour_seen === true, 4000)
    const left = await stored(env, 'hs_tour_step')
    if (!seen) bad('tour: finishing did not store hs_tour_seen=true', await stored(env, ['hs_tour_seen', 'hs_tour_step']))
    else ok('tour: finishing stores hs_tour_seen=true')
    if (left.hs_tour_step !== undefined) bad('tour: the saved step is still there after finishing', left)
    if (await p1.$('#hs-mc-tour:not([hidden])')) bad('tour: the card is still up after finishing')
    if (await p1.$('#hs-mc-tour-arrow')) bad('tour: the arrow is still up after finishing')
    // once per device
    await p1.reload({ waitUntil: 'domcontentloaded' })
    await waitPanel(p1)
    await sleep(8000)
    const again = await tourState(p1)
    if (again.shown || again.arrow) bad('tour: it came back after a reload', again)
    else ok('tour: not back after a reload')
    const others: any[] = []
    for (const [name, url] of [
      ['kick', `https://kick.com/${kk}`],
      ...(yt ? [['youtube', `https://www.youtube.com/watch?v=${yt.id}`]] : []),
    ] as [string, string][]) {
      const p = await open(name, url)
      if (!p) continue
      ok(`${name}: panel mounted`)
      await sleep(10_000)
      const s = await tourState(p)
      if (s.shown || s.arrow) bad(`tour: it showed again on ${name}`, s)
      else ok(`tour: not shown on ${name}`)
      others.push(p)
    }

    // ── 3 the signed-out tabs ───────────────────────────────────────────────────
    await p1.bringToFront()
    const tabsNow = () => p1.$$eval('.hs-mc-tab[data-tab]', (t: Element[]) => t.filter((x) => (x as HTMLElement).offsetParent).map((x) => (x as HTMLElement).dataset.tab || ''))
    const vis = await tabsNow()
    info(`tabs a fresh install sees: ${vis.join(', ')} (hiddenTabs=${JSON.stringify((await syncUi(env)).hiddenTabs)})`)
    if (!vis.includes('feed')) bad('a fresh install shows no feed tab', vis)
    // discover and saved ship hidden until asked for; a person asks in settings › tabs, which saves this
    await extStorage(
      env,
      async () => {
        // @ts-ignore — extension page
        const cur = (await chrome.storage.sync.get('ui_settings')).ui_settings || {}
        // @ts-ignore
        await chrome.storage.sync.set({ ui_settings: { ...cur, hiddenTabs: ['whispers', 'mentions', 'modlog'] } })
      },
    )
    const shown = await until(async () => {
      const v = await tabsNow()
      return v.includes('discover') && v.includes('pinned')
    }, 10_000)
    if (!shown) bad('turning discover and saved on in tab settings did not show them', await tabsNow())
    const click = async (id: string) => {
      await p1.locator(`.hs-mc-tab[data-tab="${id}"]:visible`).first().click({ timeout: 5000 })
    }
    // what a pane holds, and whether it is done loading
    const pane = () =>
      p1.evaluate((loadingTxt: string) => {
        const m = document.getElementById('hs-mc-messages') as HTMLElement | null
        const empties = [...(m?.querySelectorAll('.hs-mc-empty, .hs-mc-empty-card') || [])].map((e) => (e.textContent || '').trim())
        return {
          feedRows: m?.querySelectorAll('.hs-feed-msg').length || 0,
          discover: !!m?.querySelector('.hs-discover-root'),
          pinnedRows: m?.querySelectorAll('.hs-pinned-row').length || 0,
          empties,
          loading: empties.some((e) => e === loadingTxt),
          text: (m?.innerText || '').trim(),
          kids: m?.children.length || 0,
        }
      }, L('mc_social_loading_feed'))
    const settle = async (tab: string) => {
      await click(tab)
      let s: any = await pane()
      const t1 = Date.now()
      while (Date.now() - t1 < 15_000) {
        s = await pane()
        if (!s.loading && (s.feedRows || s.discover || s.pinnedRows || s.empties.length)) break
        await sleep(500)
      }
      if (s.loading) bad(`${tab}: still on "loading..." after 15s`, s)
      else if (!s.kids || !s.text) bad(`${tab}: blank pane`, s)
      else if (RAW_KEY.test(s.text)) bad(`${tab}: raw translation key in the pane`, s.text.match(RAW_KEY)?.[0])
      else ok(`${tab}: drew ${s.feedRows ? `${s.feedRows} posts` : s.discover ? 'the discover page' : s.pinnedRows ? `${s.pinnedRows} saved rows` : `a state: "${s.empties[0]?.slice(0, 60)}"`}`)
      return s
    }
    // pictures that finished loading with no width are broken
    const broken = async (tab: string) => {
      await sleep(4000)
      const b = await p1.$$eval('#hs-mc-messages img', (imgs: Element[]) =>
        (imgs as HTMLImageElement[]).filter((i) => i.src && i.complete && i.naturalWidth === 0 && i.offsetParent).map((i) => i.src.slice(0, 120)),
      )
      if (b.length) bad(`${tab}: ${b.length} broken picture(s)`, b.slice(0, 4))
      else ok(`${tab}: no broken pictures`)
    }
    // a tag: the card shows (a tag the server does not know shows nothing, by design: ask the server)
    let tagDone = false
    const tagCheck = async (where: string) => {
      if (tagDone) return
      const tags: string[] = await p1.$$eval('#hs-mc-messages .hs-hashtag', (a: Element[]) => [...new Set(a.map((x) => (x as HTMLElement).dataset.tag || ''))].filter(Boolean).slice(0, 3))
      if (!tags.length) return info(`${where}: no #tag on screen, tag card not tried`)
      for (const tag of tags) {
        const known = await fetch(`https://heatsync.org/api/tags/${encodeURIComponent(tag.toLowerCase())}/card`).then((r) => r.status).catch(() => 0)
        await p1.locator(`#hs-mc-messages .hs-hashtag[data-tag="${tag}"]`).first().hover({ timeout: 5000 }).catch(() => {})
        const got = await until(
          () => p1.evaluate((t: string) => [...document.querySelectorAll('.hs-card-name')].some((e) => (e as HTMLElement).offsetParent && e.textContent === `#${t}`), tag),
          4000,
        )
        if (known === 200 && !got) bad(`${where}: hovering #${tag} shows no card though the server knows it`, { api: known })
        else if (known === 200) ok(`${where}: hovering #${tag} shows its card`)
        else info(`${where}: #${tag} unknown to the server (${known}), no card is right`)
        if (known === 200) tagDone = true
        await p1.mouse.move(5, 5)
        if (tagDone) break
      }
    }
    const feed = await settle('feed')
    await broken('feed')
    if (feed.feedRows) {
      // a picture: opens full size, Esc closes it
      const pic = await p1.$('#hs-mc-messages img.hs-feed-media-img, #hs-mc-messages img.hs-feed-media-item')
      if (pic) {
        await pic.scrollIntoViewIfNeeded()
        await pic.click({ timeout: 5000 })
        const iv = await p1.waitForSelector('.hs-iv-img', { timeout: 5000 }).then(() => true, () => false)
        if (!iv) bad('feed: clicking a picture did not open the full-size view', await pane())
        else {
          const dims = await until(() => p1.$eval('.hs-iv-img', (i: HTMLImageElement) => (i.complete && i.naturalWidth ? [i.naturalWidth, i.getBoundingClientRect().width] : null)), 8000)
          if (!dims) {
            // a picture that will not load closes the view by itself: that is the designed way out
            if (await p1.$('.hs-iv-img')) bad('feed: the full-size picture never loaded and never closed itself')
            else info('feed: the picture would not load; the view closed itself (designed)')
          } else {
            await p1.keyboard.press('Escape')
            const gone = await until(async () => !(await p1.$('.hs-iv-img')), 3000)
            const back = await pane()
            if (!gone) bad('feed: Esc did not close the full-size picture')
            else if (!back.feedRows) bad('feed: after Esc the feed did not come back', back)
            else ok('feed: a picture opens full size and Esc returns to the feed')
          }
        }
      } else info('feed: no picture in these posts, picture view not tried')
      await tagCheck('feed')
      // a post: its thread opens, back returns
      const link = p1.locator('#hs-mc-messages .hs-feed-msg .hs-thread-toggle:visible').first()
      if (await link.count()) {
        await link.scrollIntoViewIfNeeded()
        await link.click({ timeout: 5000 })
        const open = await until(
          () =>
            p1.evaluate((back: string) => {
              const f = document.querySelector('.hs-mc-tab[data-tab="feed"]') as HTMLElement | null
              const m = document.getElementById('hs-mc-messages')
              return (f?.textContent || '').trim() === back && !!m?.querySelector('.hs-feed-msg')
            }, L('mc_social_back')),
          15_000,
        )
        // the cached OP paints at once; the replies' spinner must go within 15s
        const th: any = open ? await until(async () => ((s) => (s.loading ? null : s))(await pane()), 15_000, 500) || (await pane()) : await pane()
        if (!open) bad('feed: clicking a post did not open its thread', { ...th, tabs: await tabsNow() })
        else if (th.loading || th.empties.some((e: string) => /fail|not found|error/i.test(e))) bad('feed: the thread opened to an error or a spinner', th.empties)
        else {
          ok('feed: a post opens its thread')
          await click('feed') // the tab reads "<- back" while a thread is open
          const out = await until(async () => (await pane()).feedRows > 1, 8000)
          const label = await p1.$eval('.hs-mc-tab[data-tab="feed"]', (e: HTMLElement) => (e.textContent || '').trim())
          if (!out) bad('feed: back did not return to the feed list', await pane())
          else if (label !== L('mc_tab_feed')) bad('feed: the tab still reads back after returning', label)
          else ok('feed: back returns to the feed list')
        }
      } else info('feed: no post with a thread link visible')
    }
    await settle('discover')
    await tagCheck('discover')
    await broken('discover')
    await settle('pinned')
    // back to the live chat: rows flow again
    const chatTab = (await tabsNow()).find((t) => !NOT_CHAT.has(t))
    if (!chatTab) bad('no chat tab to go back to', await tabsNow())
    else {
      await click(chatTab)
      const before = await panel(p1)
      if (!before.rows) bad('back on the chat tab: no rows drawn', before)
      else if (!(await rowsFlow(p1, 45_000))) bad('back on the chat tab: rows stopped flowing', await panel(p1))
      else ok(`back on the chat tab (${chatTab}): rows flow again`)
    }
    await shot(p1, 's19-after-tabs')

    // ── 4 the popup page ────────────────────────────────────────────────────────
    const pop = await env.ctx.newPage()
    watchErrors(pop, 'popup', errs)
    const popErrs: string[] = []
    pop.on('console', (m: any) => m.type() === 'error' && popErrs.push(String(m.text()).slice(0, 200)))
    await pop.goto(`chrome-extension://${env.extId}/popup.html`, { waitUntil: 'load' })
    await sleep(1000)
    const pt = await pop.evaluate(() => document.body.innerText)
    if (RAW_KEY.test(pt)) bad('popup shows a raw translation key', pt.match(RAW_KEY)?.[0])
    else ok('popup text is words')
    // per-site switches. The click path (popup → worker) cannot run from a tab: the worker refuses
    // any message with a tab behind it ("unauthorized sender"; the toolbar popup has none) and
    // playwright cannot reach the toolbar popup. So: the click is made and must say so out loud,
    // and the page's read of the stored value is checked both ways, each restored exactly.
    const subsRaw = async () => JSON.stringify((await syncUi(env)).subsystems ?? null)
    const setSubs = (subs: unknown) =>
      extStorage(
        env,
        async (v: any) => {
          // @ts-ignore — extension page
          const cur = (await chrome.storage.sync.get('ui_settings')).ui_settings || {}
          if (v === null) delete cur.subsystems
          else cur.subsystems = v
          // @ts-ignore
          await chrome.storage.sync.set({ ui_settings: cur })
        },
        subs,
      )
    const pressedOf = (gate: string) => pop.$eval(`#site-pick .plat[data-gate="${gate}"]`, (b: Element) => b.getAttribute('aria-pressed'))
    const rawBefore = await subsRaw()
    const subsBefore = JSON.parse(rawBefore)
    for (const gate of ['overlay-twitch', 'overlay-kick', 'overlay-youtube']) {
      await setSubs({ ...(subsBefore || {}), [gate]: false })
      await pop.reload({ waitUntil: 'load' })
      await sleep(500)
      const off = await pressedOf(gate)
      const othersOn = (await Promise.all(['overlay-twitch', 'overlay-kick', 'overlay-youtube'].filter((g) => g !== gate).map(pressedOf))).every((v) => v === 'true')
      if (off !== 'false' || !othersOn) bad(`popup: ${gate} stored off but the page shows ${off} (others on: ${othersOn})`)
      else ok(`popup: ${gate} stored off → the switch reads off, the others stay on`)
      await setSubs(subsBefore)
      await pop.reload({ waitUntil: 'load' })
      await sleep(500)
      const back = await pressedOf(gate)
      if (back !== 'true' || (await subsRaw()) !== rawBefore) bad(`popup: ${gate} not restored exactly`, { back, raw: await subsRaw(), want: rawBefore })
      else ok(`popup: ${gate} restored exactly (${rawBefore})`)
    }
    {
      await pop.click('#site-pick .plat[data-gate="overlay-twitch"]')
      await sleep(1500)
      const note = await pop.$eval('#site-note', (n: Element) => (n.textContent || '').trim())
      info(`popup: a click from a tab (no toolbar) leaves stored=${await subsRaw()} and says "${note}"`)
      if ((await subsRaw()) !== rawBefore) await setSubs(subsBefore)
    }
    // the popout form: a pasted url picks its platform, a bare name keeps the chosen one
    await pop.fill('#popout-input', `https://kick.com/${kk}`)
    const plat = await until(() => pop.$eval('#plat-pick .plat[data-plat="kick"]', (b: Element) => b.getAttribute('aria-selected') === 'true'), 2000)
    if (!plat) bad('popup: pasting a kick url did not select kick')
    else ok('popup: a pasted kick url selects kick')
    for (const p of ['twitch', 'youtube', 'twitch']) {
      await pop.click(`#plat-pick .plat[data-plat="${p}"]`)
      if ((await pop.$eval(`#plat-pick .plat[data-plat="${p}"]`, (b: Element) => b.getAttribute('aria-selected'))) !== 'true') bad(`popup: ${p} did not select`)
    }
    ok('popup: twitch / youtube / twitch selectors select')
    // feedback pane opens and closes; nothing is sent
    await pop.click('#link-feedback')
    const fbOpen = await pop.$eval('#fb-pane', (e: HTMLElement) => !e.hidden)
    await pop.click('#fb-kind .plat[data-kind="bug"]')
    const bug = await pop.$eval('#fb-kind .plat[data-kind="bug"]', (b: Element) => b.getAttribute('aria-selected'))
    await pop.click('#link-feedback')
    const fbShut = await pop.$eval('#fb-pane', (e: HTMLElement) => e.hidden)
    if (!fbOpen || bug !== 'true' || !fbShut) bad('popup: feedback link/kind did not open, switch and close', { fbOpen, bug, fbShut })
    else ok('popup: feedback opens, switches kind, closes (nothing sent)')
    // the error count reads the log
    const logLen = ((await stored(env, 'hs_errors')).hs_errors || []).length
    const linkTxt = await pop.$eval('#link-errors', (e: Element) => (e.textContent || '').trim())
    if (!linkTxt.includes(String(logLen))) bad('popup: the errors link does not show the log length', { linkTxt, logLen })
    else ok(`popup: errors link reads "${linkTxt}"`)
    // footer links are real
    const foot = await pop.$$eval('.footer a[href^="https://"]', (a: Element[]) => a.map((x) => (x as HTMLAnchorElement).href))
    if (foot.length !== 2) bad('popup: footer has not both https links', foot)
    // popout: the button opens the chat window for the typed channel
    await pop.fill('#popout-input', tw)
    const [win] = await Promise.all([env.ctx.waitForEvent('page', { timeout: 10_000 }).catch(() => null), pop.click('#popout-btn')])
    if (!win) bad('popup: popout chat opened nothing')
    else {
      await win.waitForURL((u: URL) => u.toString() !== 'about:blank', { timeout: 10_000 }).catch(() => {})
      if (win.url() !== `https://www.twitch.tv/popout/${tw}/chat`) bad('popup: popout opened the wrong page', win.url())
      else ok('popup: popout chat opens the channel\'s popout')
      await win.close().catch(() => {})
    }
    if (popErrs.length) bad('popup logged console errors', popErrs)
    await pop.close().catch(() => {})

    // ── 5 the whole run ─────────────────────────────────────────────────────────
    const hs = (await stored(env, 'hs_errors')).hs_errors || []
    if (hs.length) bad(`the add-on's error log holds ${hs.length}`, hs.slice(-3).map((e: any) => e?.msg || e?.message || e))
    else ok("the add-on's error log is empty")
    if (errs.length) bad(`${errs.length} page error(s)`, errs.slice(0, 5))
    else ok('no page errors on any site')
    if (cons.length) bad(`${cons.length} console error(s) from our code`, cons.slice(0, 5))
    else ok('no console errors from our code')
    const bads: string[] = []
    for (const p of [p1, ...others]) {
      const r = await ringSince(p, t0)
      for (const e of r.bad) bads.push(`${new URL(p.url()).hostname}: ${e.e} ${JSON.stringify(e).slice(0, 140)}`)
    }
    if (bads.length) bad('watchdog events during the run', bads.slice(0, 6))
    else ok('the watchdog ring stayed quiet')
    const own = [...extErrs.entries()].filter(([pg]) => String(pg.url()).startsWith('chrome-extension://')).flatMap(([, e]) => e)
    if (own.length) bad('an extension page threw or logged errors', own.slice(0, 5))
  } finally {
    await env.close()
  }
}

/**
 * s27 — every locale reads right on the real thing. The browser is launched in a language
 * (chrome's own ui language, which chrome.i18n follows) and the extension is read the way a
 * person in that country reads it, signed out, nothing sent:
 *   welcome page, popup, then on one live twitch stream: the first-run tour (every card), the
 *   tab bar + second row + composer, the right-click menu on a row and on a name, the profile
 *   card, the add-channel form, every settings category with every section open.
 *
 *   bun scripts/e2e/run.ts --only s27
 *   E2E_S27_LOCALES=de,ar   just those
 *
 * Languages: de, ja, ar (right to left), ru, and the one with the longest strings: el (greek,
 * 52337 characters over all messages; the next are tl 51813, de 50743; english is 42345),
 * computed from src/_locales at run time.
 *
 * Per language and surface:
 *   a no raw message key and no unresolved placeholder in what is on screen
 *   b no label cut: a control whose text is clipped by its own box or by a box that hides
 *     overflow (the scrollers below are on purpose and exempt)
 *   c nothing sticks out past the panel's edges (menus, the tour card and the floating card
 *     are held to the window), and no two buttons in one row overlap
 *   d (ar) what direction the panel and the extension pages draw in: info only
 *   e english leaking in: a string identical to the english message of a key the language
 *     file translates differently (a hard-coded literal or the wrong lookup)
 *   f page errors and the watchdog ring quiet
 * A screenshot of every language + surface goes to the run's out dir (s27-<lang>-<surface>.png).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bad,
  info,
  launch,
  liveChannels,
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

const LOCALES_DIR = join(ROOT, 'src', '_locales')
const load = (l: string): Record<string, { message: string }> =>
  JSON.parse(readFileSync(join(LOCALES_DIR, l, 'messages.json'), 'utf8'))
const EN = load('en')

/** the locale whose messages add up to the most characters */
function longestLocale() {
  const sizes = readdirSync(LOCALES_DIR)
    .filter((l) => l !== 'en')
    .map((l) => [l, Object.values(load(l)).reduce((n, m) => n + m.message.length, 0)] as const)
    .sort((a, b) => b[1] - a[1])
  return sizes[0]
}

// keys start with a short family word (mc_, common_, popup_ ...): derived, so none is missed
const FAMILIES = (() => {
  const n = new Map<string, number>()
  for (const k of Object.keys(EN)) n.set(k.split('_')[0], (n.get(k.split('_')[0]) || 0) + 1)
  return [...n].filter(([, c]) => c >= 3).map(([f]) => f)
})()
const RAW_KEY = `\\b(?:${FAMILIES.join('|')})_[a-z0-9_]{3,}\\b`
const PLACEHOLDER = '\\$\\d\\b|\\$[A-Z][A-Z0-9_]*\\$|\\{\\d+\\}|%s|%\\d\\$s'

// scrollers and lists that are not findings when their content runs past their box
// the profile card's action and nav buttons stay english in every language on purpose: the
// underlined letter teaches the keyboard hotkey (src/multichat/card-l10n.js header, "Deliberately
// left english"). Exempt from the english-leak oracle only; they are counted as info.
const CARD_ENGLISH = '.hs-card-action, .hs-card-label, .hs-mc-dest'

const EXEMPT: [string, string][] = [
  ['.hs-mc-tabs-scroll', 'the channel tabs scroll sideways on purpose'],
]

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

type Hit = { sel: string; text: string; a?: number; b?: number; why?: string }
type Look = {
  texts: string[]
  where: Record<string, string>
  byDesign: number
  raw: string[]
  clipped: Hit[]
  outside: Hit[]
  overlap: Hit[]
  exempted: number
  align: { sel: string; textAlign: string; gapStart: number; gapEnd: number } | null
}

/** In the page: everything the oracles read, for the roots named. */
const lookIn = ([roots, viewportRoots, rawSrc, phSrc, exempt, panelSel, cardEn]: [string, string, string, string, string[], string, string]) => {
  const raw = new RegExp(rawSrc)
  const ph = new RegExp(phSrc)
  const rootEls = [...document.querySelectorAll(roots)] as HTMLElement[]
  const short = (e: Element) => {
    const h = e as HTMLElement
    const id = h.id ? `#${h.id}` : ''
    const cls = [...h.classList].slice(0, 2).map((c) => `.${c}`).join('')
    const data = h.dataset.tab ? `[data-tab=${h.dataset.tab}]` : h.dataset.setKey ? `[data-set-key=${h.dataset.setKey}]` : h.dataset.setSubtab ? `[data-set-subtab=${h.dataset.setSubtab}]` : ''
    return `${h.tagName.toLowerCase()}${id}${cls}${data}`
  }
  const exempted = (e: Element) => exempt.some((s) => e.matches(s))
  const shown = (e: HTMLElement) => {
    const r = e.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    for (let x: HTMLElement | null = e; x && x !== document.documentElement; x = x.parentElement) {
      const cs = getComputedStyle(x)
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0' || x.hidden) return false
    }
    return true
  }
  const out: Look = { texts: [], where: {}, byDesign: 0, raw: [], clipped: [], outside: [], overlap: [], exempted: 0, align: null }
  const seenText = new Set<string>()
  let cur = ''
  let curEl: HTMLElement | null = null
  const addText = (t: string) => {
    const s = t.replace(/\s+/g, ' ').trim()
    if (!s || seenText.has(s)) return
    seenText.add(s)
    out.where[s] = cur
    if (curEl?.closest(cardEn)) out.byDesign++
    else out.texts.push(s)
    if (raw.test(s) || ph.test(s)) out.raw.push(s.slice(0, 120))
  }
  const rangeOf = (e: HTMLElement) => {
    const rg = document.createRange()
    let any = false
    for (const n of e.childNodes)
      if (n.nodeType === 3 && (n.textContent || '').trim()) {
        rg.selectNodeContents(n)
        any = true
        break
      }
    if (!any) return null
    // the union of this element's own text nodes
    const rects: DOMRect[] = []
    for (const n of e.childNodes)
      if (n.nodeType === 3 && (n.textContent || '').trim()) {
        const r2 = document.createRange()
        r2.selectNodeContents(n)
        rects.push(...(r2.getClientRects() as any))
      }
    if (!rects.length) return null
    return {
      left: Math.min(...rects.map((r) => r.left)),
      right: Math.max(...rects.map((r) => r.right)),
      top: Math.min(...rects.map((r) => r.top)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
    }
  }
  for (const root of rootEls) {
    const all = [root, ...root.querySelectorAll('*')] as HTMLElement[]
    for (const e of all) {
      // other people's words (chat rows, a chatter's logged lines, a name) are not ours to translate or fit
      if (e.closest('.hs-mc-msg') || e.closest('.hs-card-name') || e.closest('.hs-card-log-body')) continue
      if (['SCRIPT', 'STYLE', 'OPTION'].includes(e.tagName)) continue
      if (!shown(e)) continue
      // strings: own text nodes, placeholders
      cur = short(e)
      curEl = e
      for (const n of e.childNodes) if (n.nodeType === 3) addText(n.textContent || '')
      for (const a of ['placeholder', 'data-placeholder']) {
        const v = e.getAttribute(a)
        if (v) addText(v)
      }
      if (e.tagName === 'SELECT') for (const o of (e as HTMLSelectElement).options) addText(o.textContent || '')
      const own = [...e.childNodes].some((n) => n.nodeType === 3 && (n.textContent || '').trim())
      if (!own && !['INPUT', 'SELECT'].includes(e.tagName)) continue
      // a lone symbol (+ ⚙ ⛶ $) is not language: it measures the same in every locale
      if (!/\p{L}|\p{N}/u.test(e.textContent || '') && !['INPUT', 'SELECT'].includes(e.tagName)) continue
      const label = (e.textContent || (e as HTMLInputElement).placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 60)
      // b: cut by its own box
      const cs = getComputedStyle(e)
      if (own || e.tagName === 'SELECT') {
        const cutX = (cs.overflowX === 'hidden' || cs.overflowX === 'clip') && e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0
        const cutY = (cs.overflowY === 'hidden' || cs.overflowY === 'clip') && e.scrollHeight > e.clientHeight + 1 && e.clientHeight > 0
        if ((cutX || cutY) && !exempted(e)) out.clipped.push({ sel: short(e), text: label, a: cutX ? e.scrollWidth : e.scrollHeight, b: cutX ? e.clientWidth : e.clientHeight, why: cutX ? 'wider than its box' : 'taller than its box' })
        else if ((cutX || cutY) && exempted(e)) out.exempted++
      }
      // b: its text runs past an ancestor that hides overflow
      const rr = own ? rangeOf(e) : null
      if (rr) {
        for (let p = e.parentElement; p && p !== document.documentElement; p = p.parentElement) {
          const pc = getComputedStyle(p)
          // a box that scrolls (a <pre> of commands) shows all of it: not cut
          if (pc.overflowX === 'auto' || pc.overflowX === 'scroll') break
          const hidesX = pc.overflowX === 'hidden' || pc.overflowX === 'clip'
          if (!hidesX) continue
          if (exempted(p)) {
            out.exempted++
            break
          }
          const pr = p.getBoundingClientRect()
          if (rr.right > pr.right + 1 || rr.left < pr.left - 1) {
            out.clipped.push({ sel: short(e), text: label, a: Math.round(rr.right - rr.left), b: Math.round(pr.width), why: `cut by ${short(p)}` })
            break
          }
        }
      }
    }
  }
  // c: past the panel's edges (not through a box that clips or scrolls it: that is b's, or on purpose)
  const pan = document.querySelector(panelSel) as HTMLElement | null
  if (pan) {
    const pr = pan.getBoundingClientRect()
    for (const root of rootEls) {
      if (!pan.contains(root)) continue
      for (const e of [root, ...root.querySelectorAll('*')] as HTMLElement[]) {
        if (e.closest('.hs-mc-msg')) continue
        if (!shown(e)) continue
        const r = e.getBoundingClientRect()
        if (r.right <= pr.right + 1 && r.left >= pr.left - 1) continue
        let held = false
        for (let p = e.parentElement; p && p !== pan; p = p.parentElement) {
          const c = getComputedStyle(p)
          if (c.overflowX !== 'visible' || c.position === 'fixed') held = true
        }
        if (!held) out.outside.push({ sel: short(e), text: (e.textContent || '').trim().slice(0, 40), a: Math.round(r.left - pr.left), b: Math.round(r.right - pr.right), why: 'past the panel edge' })
      }
    }
  }
  // c: overlays held to the window
  for (const e of document.querySelectorAll(viewportRoots) as NodeListOf<HTMLElement>) {
    if (!shown(e)) continue
    const r = e.getBoundingClientRect()
    if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1)
      out.outside.push({ sel: short(e), text: (e.textContent || '').trim().slice(0, 40), a: Math.round(r.right), b: Math.round(r.bottom), why: `outside the window ${innerWidth}x${innerHeight}` })
  }
  // c: two buttons of one row sitting on each other
  const kids = new Map<Element, HTMLElement[]>()
  for (const root of rootEls)
    for (const b of root.querySelectorAll('button, [role=tab], [role=menuitem], .hs-mc-toggle-pill') as NodeListOf<HTMLElement>) {
      if (b.closest('.hs-mc-msg') || !shown(b) || !b.parentElement) continue
      kids.set(b.parentElement, [...(kids.get(b.parentElement) || []), b])
    }
  for (const list of kids.values())
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i].getBoundingClientRect()
        const b = list[j].getBoundingClientRect()
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        if (w > 2 && h > 2) out.overlap.push({ sel: `${short(list[i])} x ${short(list[j])}`, text: `${(list[i].textContent || '').trim().slice(0, 20)} | ${(list[j].textContent || '').trim().slice(0, 20)}`, a: Math.round(w), b: Math.round(h) })
      }
  // d: where the first readable text sits against its box
  for (const root of rootEls) {
    const t = ([...root.querySelectorAll('p, label, li, h1, h2, h3, div, span')] as HTMLElement[]).find(
      (e) => shown(e) && !e.closest('.hs-mc-msg') && [...e.childNodes].some((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 12) && e.getBoundingClientRect().width > 120,
    )
    if (t?.parentElement) {
      const rr = rangeOf(t)
      const pr = t.getBoundingClientRect()
      if (rr) out.align = { sel: short(t), textAlign: getComputedStyle(t).textAlign, gapStart: Math.round(rr.left - pr.left), gapEnd: Math.round(pr.right - rr.right) }
      break
    }
  }
  return out
}

export async function s27Locale() {
  scenario('s27 every locale reads right')
  const [longest, chars] = longestLocale()
  info(`longest strings: ${longest} (${chars} characters over ${Object.keys(EN).length} messages; en is ${Object.values(EN).reduce((n, m) => n + m.message.length, 0)})`)
  const want = (process.env.E2E_S27_LOCALES || '').split(',').filter(Boolean)
  const langs = want.length ? want : [...new Set(['de', 'ja', 'ar', 'ru', longest])]
  const [tw] = await liveChannels('twitch', 1)
  for (const lang of langs) await oneLocale(lang, tw)
}

async function oneLocale(lang: string, tw: string) {
  const LOC = load(lang)
  const dir = (lang === 'ar' || lang === 'he') ? 'rtl' : 'ltr'
  const L = (k: string) => LOC[k]?.message ?? ''
  // en text -> a leak when the language file has a different message for that key and no key anywhere says this text
  const enTexts = new Map<string, string[]>()
  for (const [k, v] of Object.entries(EN)) {
    const s = norm(v.message)
    if (s.length < 3 || /\$|\{/.test(s)) continue
    enTexts.set(s, [...(enTexts.get(s) || []), k])
  }
  const locTexts = new Set(Object.values(LOC).map((v) => norm(v.message)))
  const leaks = new Map<string, { key: string; surface: string; el: string }>()
  let t0 = Date.now()
  const errs: string[] = []
  const extErrs = new Map<any, string[]>()
  const env = await launch({
    lang,
    keepWelcome: true,
    onPage: (pg: any) => {
      const mine: string[] = []
      extErrs.set(pg, mine)
      pg.on('pageerror', (e: unknown) => mine.push(`pageerror: ${String(e).slice(0, 200)}`))
    },
  })
  const tag = `${lang}`
  try {
    // ── the language really took ──
    const w0 = env.worker()
    const ui: string = await w0.evaluate(() => (globalThis as any).chrome.i18n.getUILanguage())
    const sample = await w0.evaluate(() => (globalThis as any).chrome.i18n.getMessage('mc_input_send_message'))
    if (!ui.toLowerCase().startsWith(lang.toLowerCase().split('_')[0]) || sample !== L('mc_input_send_message')) {
      bad(`${tag}: the browser did not take the language (ui "${ui}", send-box message "${String(sample).slice(0, 40)}", wanted "${L('mc_input_send_message').slice(0, 40)}")`)
      return
    }
    ok(`${tag}: browser ui language is ${ui}`)

    // ── one look at a surface ──
    const surfacesDone: string[] = []
    const look = async (pg: any, surface: string, roots: string, viewportRoots = '.hs-mc-ctx, #hs-mc-tour, #hs-pcard-floating', panelSel = '#hs-mc-container') => {
      const r: Look = await pg.evaluate(lookIn, [roots, viewportRoots, RAW_KEY, PLACEHOLDER, EXEMPT.map((e) => e[0]), panelSel, CARD_ENGLISH])
      await shot(pg, `s27-${lang}-${surface.replace(/[^a-z0-9]+/gi, '-')}`)
      surfacesDone.push(surface)
      const where = `${tag} ${surface}`
      let clean = true
      if (!r.texts.length) {
        clean = false
        bad(`${where}: nothing readable on the surface (roots ${roots})`)
      }
      if (r.raw.length) {
        clean = false
        bad(`${where}: raw key or unresolved placeholder on screen: ${r.raw.slice(0, 4).join(' | ')}`)
      }
      if (r.clipped.length) {
        clean = false
        bad(`${where}: ${r.clipped.length} label(s) cut`, r.clipped.slice(0, 6))
      }
      if (r.outside.length) {
        clean = false
        bad(`${where}: ${r.outside.length} control(s) past the edge`, r.outside.slice(0, 6))
      }
      if (r.overlap.length) {
        clean = false
        bad(`${where}: ${r.overlap.length} buttons on top of each other`, r.overlap.slice(0, 6))
      }
      if (clean) ok(`${where}: ${r.texts.length} strings, no raw key, nothing cut, nothing past the edge`)
      if (r.byDesign) info(`${where}: ${r.byDesign} card button label(s) english on purpose (card-l10n.js)`)
      if (r.exempted) info(`${where}: ${r.exempted} clip(s) in an exempt scroller`)
      if (lang === 'ar' && r.align) info(`${where}: first text ${r.align.sel} text-align=${r.align.textAlign}, gap to the start ${r.align.gapStart}px, to the end ${r.align.gapEnd}px`)
      for (const s of r.texts) {
        const n = norm(s)
        const keys = enTexts.get(n)
        if (keys && !locTexts.has(n) && !leaks.has(n)) leaks.set(n, { key: keys[0], surface, el: r.where[s] })
      }
    }
    const dirInfo = async (pg: any, what: string) => {
      const d = await pg.evaluate((sel: string) => {
        const el = (sel ? document.querySelector(sel) : document.documentElement) as HTMLElement | null
        return el ? { attr: el.getAttribute('dir') || '', computed: getComputedStyle(el).direction } : null
      }, what.startsWith('#') ? what : '')
      return d
    }

    // ── 1 welcome ──
    const wp = env.welcome
    if (!wp) return bad(`${tag}: no welcome page opened on install`)
    await wp.waitForLoadState('load')
    await wp.reload({ waitUntil: 'load' })
    await sleep(800)
    await look(wp, 'welcome', 'body')
    if (lang === 'ar') info(`${tag} welcome: html dir="${(await dirInfo(wp, ''))?.attr}" computed ${(await dirInfo(wp, ''))?.computed}`)

    // ── 2 popup (its real width is 300px, set in its own css) ──
    const pop = await env.ctx.newPage()
    await pop.goto(`chrome-extension://${env.extId}/popup.html`, { waitUntil: 'load' })
    await sleep(800)
    await look(pop, 'popup', 'body')
    if (lang === 'ar') {
      const pdir = await dirInfo(pop, '')
      info(`${tag} popup: html dir="${pdir?.attr}" computed ${pdir?.computed}`)
      // the welcome page already follows the language's direction; the popup must too
      if (pdir?.computed !== 'rtl') bad(`${tag} popup: draws ${pdir?.computed} (dir="${pdir?.attr}") in a right-to-left language`)
    }
    // every setting, not only the day-one ones
    // @ts-ignore — extension page
    await pop.evaluate(() => chrome.storage.local.set({ hs_set_show_all: true }))
    for (const [pg, label] of [[wp, 'welcome'], [pop, 'popup']] as [any, string][]) {
      const mine = extErrs.get(pg) || []
      if (mine.length) bad(`${tag} ${label}: page threw`, mine)
    }
    await pop.close()

    // ── 3 the stream ──
    t0 = Date.now()
    const p = await env.ctx.newPage()
    watchErrors(p, `${tag} twitch`, errs)
    await p.goto(`https://www.twitch.tv/${tw}`, { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(p)) || !(await rowsFlow(p, 45_000))) return bad(`${tag}: chat never flowed`, await panel(p))
    ok(`${tag}: panel mounted, chat flows`)
    const place = await p.evaluate(() => document.getElementById('hs-mc-input')?.getAttribute('data-placeholder') || '')
    // signed out the box says to sign in first: whichever line it shows must be this language's own words
    if (!locTexts.has(norm(place)) || (lang !== 'en' && enTexts.has(norm(place)) && !locTexts.has(norm(place))))
      bad(`${tag}: the composer's placeholder "${place}" is not a message of the ${lang} file`)
    if (lang === 'ar') {
      const pd = await p.evaluate(() => {
        const c = document.getElementById('hs-mc-container') as HTMLElement
        const bar = document.getElementById('hs-mc-tabbar') as HTMLElement | null
        return { panelAttr: c.getAttribute('dir') || '', panelComputed: getComputedStyle(c).direction, barAttr: bar?.getAttribute('dir') || '', barComputed: bar ? getComputedStyle(bar).direction : '', page: getComputedStyle(document.documentElement).direction }
      })
      info(`${tag} panel: dir="${pd.panelAttr}" computed ${pd.panelComputed}; tab bar dir="${pd.barAttr}" computed ${pd.barComputed}; host page ${pd.page}`)
    } else if (dir === 'ltr') {
      const d = await p.evaluate(() => getComputedStyle(document.getElementById('hs-mc-container') as HTMLElement).direction)
      if (d !== 'ltr') bad(`${tag}: the panel draws ${d}`)
    }

    // the first-run tour: every card
    if (!(await p.waitForSelector('#hs-mc-tour:not([hidden])', { timeout: 30_000 }).then(() => true, () => false)))
      bad(`${tag}: the first-run tour never showed`)
    else {
      for (let i = 1; i <= 6; i++) {
        await sleep(500)
        await look(p, `tour card ${i}`, '#hs-mc-tour', '#hs-mc-tour')
        const next = await p.$('.hs-mc-tour-next')
        if (next && (await next.isVisible())) await next.click({ timeout: 5000 }).catch(() => {})
        else break
      }
      await p.click('.hs-mc-tour-done', { timeout: 5000 }).catch(() => bad(`${tag}: the tour's last button is not clickable`))
      await sleep(600)
    }

    // the panel itself: tab bar, second row, composer (chat rows are other people's words)
    await look(p, 'panel tab bar, second row, composer', '#hs-mc-tabbar, #hs-mc-subrow, #hs-mc-inputbar')

    // the right-click menus: a row, a name
    const aim = (what: 'row' | 'name') =>
      p.evaluate((what: string) => {
        const list = document.getElementById('hs-mc-messages') as HTMLElement
        const box = list.getBoundingClientRect()
        const rows = [...list.querySelectorAll('.hs-mc-msg[data-msg-key]')].slice(0, -3).reverse() as HTMLElement[]
        for (const row of rows) {
          if (row.dataset.msgSelf) continue
          const a = row.querySelector('.hs-mc-user:not(.hs-mc-reply-user)') as HTMLElement | null
          const rb = row.getBoundingClientRect()
          if (!a || rb.top < box.top + 30 || rb.bottom > box.bottom - 30) continue
          if (what === 'name') {
            const r = a.getBoundingClientRect()
            const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
            if (at && a.contains(at)) return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
            continue
          }
          for (const f of [0.55, 0.75, 0.35, 0.9]) {
            const x = rb.left + rb.width * f
            const y = rb.top + rb.height / 2
            const at = document.elementFromPoint(x, y)
            if (at && at.closest('.hs-mc-msg') === row && !at.closest('a, img, button, .hs-mc-user, .hs-mc-emote-wrapper, .hs-mc-link, .hs-mc-reply-ctx')) return { x, y }
          }
        }
        return null
      }, what)
    // a fast chat slides rows under the pointer: aim again (up to 3 times) until the thing asked for opened
    for (const what of ['row', 'name'] as const) {
      let seen = false
      for (let tries = 0; tries < 3 && !seen; tries++) {
        const at = await aim(what)
        if (!at) {
          await sleep(1500)
          continue
        }
        await p.mouse.move(at.x, at.y)
        await p.mouse.click(at.x, at.y, { button: 'right' })
        await sleep(700)
        seen = !!(await p.$('.hs-mc-ctx .hs-mc-em-label'))
        if (seen) await look(p, `${what} menu`, '.hs-mc-ctx')
        await p.keyboard.press('Escape')
        await sleep(400)
      }
      if (!seen) bad(`${tag}: right-click on a ${what} opened no menu with items in 3 tries`)
    }

    // the profile card: a name's left click (re-aimed like the menus)
    {
      let up = false
      for (let tries = 0; tries < 3 && !up; tries++) {
        const at = await aim('name')
        if (!at) {
          await sleep(1500)
          continue
        }
        await p.mouse.move(at.x, at.y)
        await p.mouse.click(at.x, at.y)
        up = await p.waitForSelector('#hs-mc-messages .hs-card', { timeout: 10_000 }).then(() => true, () => false)
      }
      if (up) {
        await sleep(2500)
        await look(p, 'profile card', '#hs-mc-container')
      } else bad(`${tag}: no profile card in 3 tries of clicking a name`)
      await p.keyboard.press('Escape')
      await sleep(600)
    }

    // the add-channel form
    await p.click('.hs-mc-tab[data-tab="add"]', { timeout: 8000 }).catch(() => {})
    if (await p.waitForSelector('.hs-mc-add-pane', { timeout: 6000 }).then(() => true, () => false)) await look(p, 'add-channel form', '#hs-mc-container')
    else bad(`${tag}: the + tab opened no add-channel form`)
    await p.keyboard.press('Escape')
    await sleep(300)
    await p.evaluate(() => (document.querySelector('#hs-mc-tabbar .hs-mc-tabs-scroll .hs-mc-tab[data-tab]:not([data-tab="add"]):not([data-tab="feed"]):not([data-tab="discover"])') as HTMLElement | null)?.click())
    await sleep(500)

    // settings: every category, every section open (the same walk as s15)
    await p.click('.hs-mc-tab[data-tab="settings"]', { timeout: 10_000 }).catch(() => {})
    await sleep(1500)
    const subs: string[] = await p.$$eval('.hs-mc-set-subtab[data-set-subtab]', (b: Element[]) => b.map((x) => (x as HTMLElement).dataset.setSubtab || '').filter(Boolean))
    if (subs.length < 5) bad(`${tag}: only ${subs.length} settings categories found`, subs)
    for (const sub of subs) {
      if (!(await p.$('.hs-mc-tab[data-tab="settings"].active'))) await p.click('.hs-mc-tab[data-tab="settings"]').catch(() => {})
      await p.click(`.hs-mc-set-subtab[data-set-subtab="${sub}"]`, { timeout: 5000 }).catch(() => {})
      await sleep(600)
      for (let i = 0; i < 40; i++) {
        const folded = await p.$('.hs-mc-settings-group-title[data-set-fold]:text-matches("^▸")')
        if (!folded) break
        await folded.click().catch(() => {})
        await sleep(250)
      }
      await look(p, `settings ${sub}`, '#hs-mc-container')
    }

    // ── f: quiet ──
    const mine = errs.filter((e) => e.startsWith(`${tag} `))
    if (mine.length) bad(`${tag}: the page threw`, mine.slice(0, 4))
    else ok(`${tag}: no page errors`)
    const ring = await ringSince(p, t0)
    if (ring.bad.length) bad(`${tag}: overlay watchdogs fired`, ring.bad.slice(0, 5))
    else ok(`${tag}: watchdog ring quiet`)

    // ── e: english in a translated language ──
    if (leaks.size) {
      bad(
        `${tag}: ${leaks.size} string(s) in english although the ${lang} file translates them`,
        [...leaks].slice(0, 10).map(([s, v]) => ({ text: s.slice(0, 60), key: v.key, surface: v.surface, el: v.el, loc: L(v.key).slice(0, 40) })),
      )
    } else ok(`${tag}: no english leaking in (${surfacesDone.length} surfaces)`)
  } finally {
    await env.close()
  }
}

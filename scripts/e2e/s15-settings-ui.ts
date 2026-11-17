/**
 * s15 — the settings page inside the panel, clicked the way a person clicks it. s13 writes
 * storage the way the settings page would; this one drives the page itself: every category,
 * every section unfolded, every switch, size button and list a person can reach, each changed
 * and changed back, with a second tab on another site open the whole time.
 *
 *   bun scripts/e2e/run.ts --only s15
 *   E2E_S15_CATS=filters,chat  just those categories
 *
 * For each control:
 *   - the click is saved: the stored value is the one clicked, and changing it back restores
 *     the value before (a switch whose handler is wired wrong saves nothing, or the wrong thing)
 *   - the settings page is still drawn after the click, the control still on it
 *   - nothing threw on either tab: page errors, the console, the add-on's error log
 * At the end: both tabs' chat flows, every watchdog stayed quiet.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS } from '../../src/lib/settings-schema.js'
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
import { HIDES_PANEL } from './s13-settings-sweep'

type Def = { key: string; type: string; scope?: string; default: unknown; apply?: string }
const DEFS = new Map((SETTINGS as Def[]).map((d) => [d.key, d]))
// choices that need something outside the page (a font or sound file to pick)
const SKIP_VALUES: Record<string, string[]> = { fontFamily: ['custom'], mentionSound: ['custom'] }
// the content toggles save to the heatsync account; this browser is signed out, so each click
// must roll back and say to sign in (never a "try again" that can't work)
const SIGNIN = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8')).mc_main_cw_signin.message

export async function s15SettingsUi() {
  scenario('s15 the settings page clicked through')
  const [tw] = await liveChannels('twitch', 1)
  const [kk] = await liveChannels('kick', 1)
  const env = await launch()
  const errs: string[] = []
  const cons: string[] = []
  try {
    const pages: any[] = []
    for (const [name, url] of [
      ['twitch', `https://www.twitch.tv/${tw}`],
      ['kick', `https://kick.com/${kk}`],
    ]) {
      const p = await env.ctx.newPage()
      watchErrors(p, name, errs)
      p.on('console', (m: any) => {
        const text = String(m.text())
        if (m.type() === 'error' ? /heatsync|Error in event handler/i.test(text) : m.type() === 'warning' && /^\[heatsync\].*(fail|threw|error|exception)/i.test(text))
          cons.push(`${name} ${m.type()}: ${text.slice(0, 160)}`)
      })
      await p.goto(url, { waitUntil: 'domcontentloaded' })
      if (!(await waitPanel(p)) || !(await rowsFlow(p, 45_000))) return bad(`${name}: chat never flowed`, await panel(p))
      pages.push(p)
    }
    const [p] = pages
    const ext = await env.ctx.newPage()
    await ext.goto(`chrome-extension://${env.extId}/popup.html`, { waitUntil: 'load' })
    // every setting, not only the day-one ones
    // @ts-ignore — extension page
    await ext.evaluate(() => chrome.storage.local.set({ hs_set_show_all: true }))
    const stored = (key: string) =>
      ext.evaluate(
        async ([k, local]: [string, boolean]) => {
          // @ts-ignore — extension page
          if (local) return (await chrome.storage.local.get(k))[k]
          // @ts-ignore
          return ((await chrome.storage.sync.get('ui_settings')).ui_settings || {})[k]
        },
        [key, DEFS.get(key)?.scope === 'local'],
      )
    const value = async (key: string) => {
      const v = await stored(key)
      return v === undefined ? DEFS.get(key)?.default : v
    }
    // @ts-ignore — extension page
    const hsErrors = () => ext.evaluate(async () => ((await chrome.storage.local.get('hs_errors')).hs_errors || []).length)

    await p.bringToFront()
    await p.click('.hs-mc-tab[data-tab="settings"]', { timeout: 10_000 })
    await sleep(1500)
    const cats = (process.env.E2E_S15_CATS || '').split(',').filter(Boolean)
    const subtabs: string[] = await p.$$eval(
      '.hs-mc-set-subtab[data-set-subtab]',
      (b: Element[], cats: string[]) =>
        b.map((x) => (x as HTMLElement).dataset.setSubtab || '').filter((x) => x && x !== 'help' && (!cats.length || cats.includes(x))),
      cats,
    )
    // to a category with every section open. The gear closes the settings page when it is
    // already open: only click it when it isn't
    const toCategory = async (sub: string) => {
      if (!(await p.$('.hs-mc-tab[data-tab="settings"].active'))) await p.click('.hs-mc-tab[data-tab="settings"]').catch(() => {})
      await p.click(`.hs-mc-set-subtab[data-set-subtab="${sub}"]`, { timeout: 5000 }).catch(() => {})
      await sleep(600)
      // a fold re-renders the page: one at a time
      for (let i = 0; i < 40; i++) {
        const folded = await p.$('.hs-mc-settings-group-title[data-set-fold]:text-matches("^▸")')
        if (!folded) break
        await folded.click().catch(() => {})
        await sleep(250)
      }
    }
    // the settings page as drawn: which tab is in front, how many settings and chat rows it holds
    const state = () =>
      p.evaluate(() => {
        const m = document.getElementById('hs-mc-messages')
        return {
          tab: document.querySelector('.hs-mc-tab.active')?.getAttribute('data-tab'),
          settings: m?.querySelectorAll('[data-set-key]').length || 0,
          rows: m?.querySelectorAll('.hs-mc-msg').length || 0,
        }
      })
    info(`settings categories: ${subtabs.join(', ')}`)
    const t0 = Date.now()
    let errBase = await hsErrors()
    let acted = 0
    const broke: string[] = []
    const seen = new Set<string>()

    for (const sub of subtabs) {
      await toCategory(sub)
      const controls: { key: string; tag: string; val: string; pill: boolean }[] = await p.$$eval(
        '#hs-mc-messages [data-set-key]',
        (els: Element[]) =>
          els.map((e) => {
            const h = e as HTMLElement
            return {
              key: h.dataset.setKey || '',
              tag: h.tagName,
              val: h.dataset.setValue ?? '',
              pill: h.classList.contains('hs-mc-toggle-pill'),
            }
          }),
      )
      for (const c of controls) {
        const def = DEFS.get(c.key)
        if (!def || !['bool', 'enum'].includes(def.type)) continue
        const id = `${c.key}|${c.tag === 'SELECT' ? '' : c.val}`
        if (seen.has(id)) continue
        seen.add(id)
        const before = await value(c.key)
        const account = def.apply === 'cwServerPatch'
        const sel = c.tag === 'SELECT' ? `select[data-set-key="${c.key}"]` : c.val ? `[data-set-key="${c.key}"][data-set-value="${c.val}"]` : `[data-set-key="${c.key}"]`
        // what this click should save
        let want: unknown
        let opts: string[] = []
        if (c.pill) want = !before
        else if (c.tag === 'SELECT') {
          opts = await p.$$eval(`${sel} option`, (o: Element[]) => o.map((x) => (x as HTMLOptionElement).value))
          want = opts.find((o) => o !== String(before) && !(SKIP_VALUES[c.key] || []).includes(o))
        } else want = c.val
        if (want === undefined || String(want) === String(before) || (SKIP_VALUES[c.key] || []).includes(String(want))) continue
        if (HIDES_PANEL[c.key] === want) continue
        const label = `${c.key}=${JSON.stringify(want)}`
        const pe = errs.length
        const ce = cons.length
        const act = async (v: unknown) => {
          const el = await p.$(sel)
          if (!el) return false
          await el.scrollIntoViewIfNeeded().catch(() => {})
          if (c.tag === 'SELECT') await p.selectOption(sel, String(v)).catch(() => {})
          else if (c.pill || String(v) === c.val) await el.click({ timeout: 5000 }).catch(() => {})
          else await p.click(`[data-set-key="${c.key}"][data-set-value="${String(v)}"]`, { timeout: 5000 }).catch(() => {})
          return true
        }
        const why: string[] = []
        if (!(await act(want))) {
          why.push('control gone before the click')
        } else {
          await sleep(800)
          const got = await value(c.key)
          if (account) {
            if (String(got) !== String(before)) why.push(`signed out, yet saved ${JSON.stringify(got)}`)
            const told = await p.evaluate((s: string) => document.body.innerText.includes(s), SIGNIN)
            if (!told) why.push('signed out, and nothing said to sign in')
          } else if (String(got) !== String(want)) why.push(`saved ${JSON.stringify(got)}, not ${JSON.stringify(want)}`)
          const st = await state()
          if (st.tab !== 'settings') why.push(`the click left the settings page (now ${st.tab})`)
          else if (st.rows) why.push(`${st.rows} chat rows drawn into the settings page`)
          const drawn = await p.evaluate((s: string) => !!document.querySelector(`#hs-mc-messages ${s}`), sel)
          // a choice that re-lays out the page (a language) may leave its row elsewhere: back to
          // this category and look again
          if (!drawn) await toCategory(sub)
          if (!(await p.$(sel))) why.push('the settings page lost the control after the click')
          // and back (a signed-out account toggle never moved)
          if (account) {
            // nothing to undo
          } else if (c.pill || c.tag === 'SELECT') await act(before)
          else await p.click(`[data-set-key="${c.key}"][data-set-value="${String(before)}"]`, { timeout: 5000 }).catch(() => {})
          await sleep(700)
          const back = await value(c.key)
          if (String(back) !== String(before)) why.push(`changing it back saved ${JSON.stringify(back)}, not ${JSON.stringify(before)}`)
        }
        acted++
        const nowErr = await hsErrors()
        if (errs.length > pe) why.push(`page error: ${errs.at(-1)?.slice(0, 140)}`)
        if (cons.length > ce) why.push(`console: ${cons.slice(ce, ce + 2).join(' | ')}`)
        if (nowErr > errBase) why.push(`${nowErr - errBase} add-on error(s)`)
        errBase = nowErr
        if (why.length) {
          broke.push(label)
          bad(`${sub} ${label}: ${why.join('; ')}`, await state())
          await shot(p, `s15-${c.key}`)
          // a page left somewhere else: back to this category for the next control
          await toCategory(sub)
        }
      }
    }
    info(`${acted} controls clicked and back`)
    if (!cats.length && acted < 40) bad(`only ${acted} controls reached: the walk through the settings page broke`)
    else if (!broke.length) ok(`all ${acted} controls saved what was clicked and changed back, nothing threw`)

    // close the settings page the way a person does: the gear (now an ✕) goes back to the tab before
    if (await p.$('.hs-mc-tab[data-tab="settings"].active')) await p.click('.hs-mc-tab[data-tab="settings"]').catch(() => {})
    for (const [i, pg] of pages.entries()) {
      await pg.bringToFront()
      const name = i ? 'kick' : 'twitch'
      if (!(await rowsFlow(pg, 60_000))) bad(`${name}: chat stopped after the settings walk`, await panel(pg))
      else ok(`${name}: chat flows after the settings walk`)
      const ring = await ringSince(pg, t0)
      if (ring.bad.length) bad(`${name}: overlay watchdogs fired during the walk`, ring.bad.slice(0, 6))
    }
  } finally {
    await env.close()
  }
}

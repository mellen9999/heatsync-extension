/**
 * s13 — every setting, flipped and flipped back, on a live twitch, kick and youtube stream (each
 * host lays the panel out its own way): each on/off setting to
 * its other value, each choice setting through every choice (a handful of ui languages). s6
 * checks that the panel follows eight high-traffic settings exactly; this one asks less of each
 * and asks it of all of them, the way a person clicks around the settings page.
 *
 * After each change, and again after setting it back:
 *   - nothing threw: no page error, nothing new in the add-on's own error log (hs_errors), no
 *     error or failure warning on the console (a throw inside a chrome.* listener, or an applier
 *     the settings loop caught, reaches neither of the others)
 *   - the panel is still mounted and on screen, and still draws rows
 * At the end: chat still flows, the overlay's watchdogs stayed quiet.
 */
import { SETTINGS } from '../../src/lib/settings-schema.js'
import {
  bad,
  info,
  launch,
  liveChannels,
  liveYtVideo,
  ok,
  panel,
  ringSince,
  rowsFlow,
  scenario,
  shot,
  sleep,
  waitPanel,
  watchErrors,
} from './lib'

type Def = { key: string; type: string; scope?: string; default: unknown; options?: { value: unknown }[] }

// choices that need something outside the page (a custom font or sound file) or that hide the
// panel by design are left out; ui languages are sampled: one right-to-left, one cjk, back to auto
const SKIP_VALUES: Record<string, unknown[]> = { fontFamily: ['custom'], mentionSound: ['custom'] }
const ONLY_VALUES: Record<string, unknown[]> = { hs_ui_locale: ['ar', 'ja'] }
export const HIDES_PANEL: Record<string, unknown> = { chatPosition: 'hidden' }

export function steps(): { key: string; scope: string; value: unknown; back: unknown }[] {
  const out: { key: string; scope: string; value: unknown; back: unknown }[] = []
  for (const d of SETTINGS as Def[]) {
    const scope = d.scope || 'sync'
    if (scope !== 'sync' && scope !== 'local') continue
    if (d.type === 'bool') out.push({ key: d.key, scope, value: !d.default, back: d.default })
    else if (d.type === 'enum') {
      const vals = ONLY_VALUES[d.key] || (d.options || []).map((o) => o.value)
      for (const v of vals)
        if (v !== d.default && !(SKIP_VALUES[d.key] || []).includes(v))
          out.push({ key: d.key, scope, value: v, back: d.default })
    }
  }
  return out
}

export async function s13SettingsSweep() {
  scenario('s13 every setting flipped and back')
  const [tw] = await liveChannels('twitch', 1)
  const [kk] = await liveChannels('kick', 1)
  const yt = await liveYtVideo()
  const hosts: [string, string][] = [
    ['twitch', `https://www.twitch.tv/${tw}`],
    ['kick', `https://kick.com/${kk}`],
    ...(yt ? ([['youtube', `https://www.youtube.com/watch?v=${yt.id}`]] as [string, string][]) : []),
  ]
  // E2E_S13_HOSTS=kick sweeps one host (a full sweep is ~4 min a host)
  const pick = (process.env.E2E_S13_HOSTS || '').split(',').filter(Boolean)
  for (const [host, url] of hosts) if (!pick.length || pick.includes(host)) await sweep(host, url)
}

async function sweep(host: string, url: string) {
  const env = await launch()
  const errs: string[] = []
  try {
    const p = await env.ctx.newPage()
    watchErrors(p, host, errs)
    // the console of every world on the page, the content scripts' included
    const cons: string[] = []
    p.on('console', (m: any) => {
      const t = m.type()
      const text = String(m.text())
      if (t === 'error' ? /heatsync|Error in event handler/i.test(text) : t === 'warning' && /^\[heatsync\].*(fail|threw|error|exception)/i.test(text))
        cons.push(`${t}: ${text.slice(0, 160)}`)
    })
    await p.goto(url, { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(p))) return bad(`${host}: panel never mounted`)
    if (!(await rowsFlow(p, 45_000))) return bad(`${host}: chat never flowed`)
    // one extension page writes every change, the way the settings page does
    const ext = await env.ctx.newPage()
    await ext.goto(`chrome-extension://${env.extId}/popup.html`, { waitUntil: 'load' })
    await p.bringToFront()
    const write = (key: string, scope: string, value: unknown) =>
      ext.evaluate(
        async ([k, s, v]: [string, string, unknown]) => {
          // @ts-ignore — extension page
          if (s === 'local') return chrome.storage.local.set({ [k]: v })
          // @ts-ignore
          const cur = (await chrome.storage.sync.get('ui_settings')).ui_settings || {}
          // @ts-ignore
          return chrome.storage.sync.set({ ui_settings: { ...cur, [k]: v } })
        },
        [key, scope, value],
      )
    const hsErrors = () =>
      // @ts-ignore — extension page
      ext.evaluate(async () => ((await chrome.storage.local.get('hs_errors')).hs_errors || []).length as number)
    const look = () =>
      p.evaluate(() => ({
        // mounted and on screen: a panel left in the page with no box is gone to the reader
        mounted: (() => {
          const r = document.getElementById('hs-mc-container')?.getBoundingClientRect()
          return !!r && r.width >= 120 && r.height >= 120
        })(),
        rows: document.querySelectorAll('#hs-mc-messages .hs-mc-msg').length,
        // what an empty pane says (connecting, no messages), for the record
        empty: document.querySelector('#hs-mc-messages > .hs-mc-empty')?.textContent || '',
        tab: (document.querySelector('.hs-mc-tab.active') as HTMLElement | null)?.dataset.tab || '',
      }))

    const t0 = Date.now()
    let errBase = await hsErrors()
    // E2E_S13_KEYS=flame,heatBars runs just those settings
    const keys = (process.env.E2E_S13_KEYS || '').split(',').filter(Boolean)
    const all = steps().filter((s) => !keys.length || keys.includes(s.key))
    info(`${host}: ${all.length} changes across ${new Set(all.map((s) => s.key)).size} settings`)
    const broke: string[] = []
    for (const s of all) {
      const label = `${s.key}=${JSON.stringify(s.value)}`
      const pageErrs = errs.length
      const consErrs = cons.length
      await write(s.key, s.scope, s.value)
      await sleep(1200)
      const on = await look()
      // an empty pane: what it holds, and how long until rows are back
      let emptyFor: any = null
      if (on.mounted && !on.rows && HIDES_PANEL[s.key] !== s.value) {
        emptyFor = await p.evaluate(async () => {
          const m = document.getElementById('hs-mc-messages')
          const kids = [...(m?.children || [])].slice(0, 4).map((c) => `${c.tagName}.${String(c.className).slice(0, 40)}`)
          const t = performance.now()
          while (performance.now() - t < 8000 && !document.querySelector('#hs-mc-messages .hs-mc-msg'))
            await new Promise((r) => setTimeout(r, 100))
          let ring: any[] = []
          try {
            ring = JSON.parse(localStorage.getItem('hs_diag_ring') || '[]').slice(-4)
          } catch (_) {}
          return { children: m?.children.length ?? -1, kids, backAfterMs: Math.round(performance.now() - t), ring }
        })
      }
      await write(s.key, s.scope, s.back)
      await sleep(900)
      const off = await look()
      const nowErr = await hsErrors()
      const why: string[] = []
      if (errs.length > pageErrs) why.push(`page error: ${errs.at(-1)?.slice(0, 120)}`)
      if (nowErr > errBase) why.push(`${nowErr - errBase} add-on error(s)`)
      if (cons.length > consErrs) why.push(`console: ${cons.slice(consErrs, consErrs + 2).join(' | ')}`)
      if (!on.mounted && HIDES_PANEL[s.key] !== s.value) why.push('panel gone while set')
      // (a stream that ends mid-sweep empties for a moment as the page goes offline: judged on
      // the set-back look too, which must have rows again)
      if (on.mounted && !on.rows && HIDES_PANEL[s.key] !== s.value) why.push(`no rows while set (tab ${on.tab}, pane says "${on.empty}") ${JSON.stringify(emptyFor)}`)
      if (!off.mounted || !off.rows) why.push(`set back: ${off.mounted ? 'no rows' : 'panel gone'}`)
      errBase = nowErr
      if (why.length) {
        broke.push(label)
        bad(`${host} ${label}: ${why.join('; ')}`)
        await shot(p, `s13-${host}-${s.key}`)
      }
    }
    if (!broke.length) ok(`${host}: all ${all.length} changes, nothing threw, the panel stayed and drew rows`)
    // what the add-on logged, for the record (the per-change counts above judged it)
    if (errBase) {
      const last = await ext.evaluate(async () =>
        // @ts-ignore
        ((await chrome.storage.local.get('hs_errors')).hs_errors || [])
          .slice(-5)
          .map((e: any) => String(e?.msg || e?.message || '').slice(0, 160)),
      )
      info(`${host} hs_errors tail: ${JSON.stringify(last)}`)
    }
    // (a thin youtube chat can say nothing for 30s: a minute and a half of silence is a stop)
    if (!(await rowsFlow(p, 90_000))) bad(`${host}: chat stopped after the sweep`, await panel(p))
    else ok(`${host}: chat still flows after the sweep`)
    // a settings repaint is not thrash (11-16): every watchdog counts here
    const ring = await ringSince(p, t0)
    const fired = ring.bad
    if (fired.length) bad(`${host}: overlay watchdogs fired during the sweep`, fired.slice(0, 6))
  } finally {
    await env.close()
  }
}

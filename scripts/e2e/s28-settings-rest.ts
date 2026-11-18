/**
 * s28 — the rest of the settings: what s13/s15 (on/off switches and choices) leave out, and
 * everything around the settings page. Signed out; nothing is ever sent to any chat.
 *
 *   bun scripts/e2e/run.ts --only s28
 *
 * On a live twitch stream (kick and youtube repeat the cheap parts):
 *   1 every other control type changed through the real control: choices (select / size buttons),
 *     sliders, the text boxes, the lists of switches (tabs, mod toolbar) and the grouped switches
 *     (inline notices, event toasts, subsystems). The stored value is what was set, the control
 *     shows it after the settings page is closed and opened again and after a page reload, a slider
 *     is never stored outside its range, and the effect shows where it is cheap to see (font size,
 *     12h clock)
 *   2 slash commands typed in the real composer: /set (a switch, a number, a text, a bad key, a bad
 *     value), /tab, /status, /layout. Each is handled inside the page (input.js handleSlashCommand
 *     returns true before any send path), and the browser is watched for anything that looks like
 *     a chat send
 *   3 reset this page, then reset all: stored values are the defaults again, the controls show them,
 *     and what is not a setting (saved tabs, mutes, blocks, the hide rules) is still there
 *   4 export → reset all → import that file through the file picker: every stored value is back
 *     exactly; then three bad files (not json, json of the wrong shape, wrong types for real keys)
 *     change nothing and say so
 * kick and youtube (same browser, same stored mix): the controls show the mix, one change of each
 * kind is saved there, and /set works from their composer.
 */
import { readFileSync } from 'node:fs'
import { SETTINGS } from '../../src/lib/settings-schema.js'
import { bad, info, launch, liveChannels, liveYtVideo, ok, panel, ringSince, rowsFlow, scenario, setUiSetting, shot, sleep, waitPanel, watchErrors } from './lib'

type Def = {
  key: string
  type: string
  scope?: string
  mirrorKey?: string
  category: string
  default: unknown
  control?: string
  noReset?: boolean
  displayScale?: number
  options?: any
  invertDisplay?: boolean
  apply?: string
  hosts?: string[]
}
const DEFS = SETTINGS as Def[]
const BY = new Map(DEFS.map((d) => [d.key, d]))

// ── what is left out, each with its reason ──────────────────────────────────────────────────────
// choices that cannot be driven from here
const SKIP_VALUES: Record<string, unknown[]> = {
  fontFamily: ['custom'], // driven on its own below (it opens the font-name box)
  mentionSound: ['custom'], // needs a sound file picked
  chatPosition: ['hidden'], // hides the panel by design (s13 does the same)
}
// the whole setting: the ui language rewrites every word the checks below read (s27 owns it)
const SKIP_KEYS = new Set(['hs_ui_locale', 'customFontName'])
// grouped switches whose off state removes the panel itself
const SKIP_SUBS = new Set(['subsystems:overlay-twitch'])
// the set-to value where the first non-default one would not show the effect asked for
const PICK: Record<string, unknown> = { fontSize: 18, timestampFormat: '12h' }

/**
 * Keys of the backup file that may differ between the file and the storage after an import, each
 * with its reason read from src/. Never a pattern: a pattern could hide real loss.
 */
const VOLATILE: Record<string, string> = {
  'local.hs_badge_art_v1': 'cache of badge art titles, re-stamped on every refetch (multichat/twitch-api.js)',
  'local.hs_cosmetics_7tv_v1': 'cache of 7tv cosmetics, re-stamped on every refetch (multichat/cosmetics.js)',
  'local.hs_cosmetics_v1': 'cache of heatsync cosmetics, re-stamped on every refetch (multichat/paints.js)',
  'local.hs_emote_boxw_v1': 'cache of measured emote widths, re-stamped on every write (multichat/emotes.js)',
  'local.hs_diag_page': "the page's own health note, rewritten with a timestamp on every page (background/08-diag-push.js)",
  'local.hs_health_at': 'timestamp of the last health write (background/01-core.js)',
  'local.hs_tab_seen_v1': 'last-seen time per tab, moves every visit (multichat/main-state.js)',
  'local.hs_user_color_cache': 'name → colour cache that gains a chatter per row (multichat/input.js)',
  'local.hs_ws_debug': 'ring of the last socket connect lines (background/05-ws.js)',
  'local.hs_stream_events': 'the stream notice history, gains a line per event (multichat/main-settings.js STREAM_EVENTS_KEY)',
  'ui.activeTab': 'which tab the panel was on: state, rewritten as the page reopens its tab (registry noReset, section state)',
  'ui.liveChannel': 'the live tab override, state like activeTab (registry noReset, section state)',
  'ui.chatPositionPrevious': 'last dock side, state (registry noReset, section state)',
}
/** the local keys a backup file carries (settings-ui.js _exportAllSettings): same filter, same private list */
const PRIVATE_RE = /^hs_(mentions_v2|user_notes|errors|irc_|kick_|yt_|whisper|sfx_|sent_history|modlog)/
const MIRRORS = new Set(DEFS.filter((d) => d.mirrorKey).map((d) => d.mirrorKey as string))
const inBackup = (k: string) => (k.startsWith('hs_') || k.startsWith('viewer_') || MIRRORS.has(k)) && !PRIVATE_RE.test(k)

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  )
const same = (a: unknown, b: unknown) => stable(a) === stable(b)

const SEND_URL = /twitch\.tv\/gql|kick\.com\/api\/v\d\/messages\/send|youtube\.com\/youtubei\/v1\/live_chat\/send_message/
const SEND_BODY = /sendchatmessage|sendmessage|send_message/i
// only these may ever be typed and sent with Enter here: each is handled inside the page
const LOCAL_CMD = /^\/(set|tab|status|layout)\b/

type Store = { ui: Record<string, any>; local: Record<string, any> }
/** the stored value of a setting (undefined = never written) */
const raw = (d: Def, s: Store) => (d.scope === 'sync' || !d.scope ? s.ui[d.key] : s.local[d.mirrorKey || d.key])
/** what the product shows for it: the stored value, the default when none, a grouped switch merged over its defaults */
function eff(d: Def, s: Store) {
  const r = raw(d, s)
  if (r === undefined) return d.default
  if (d.type === 'boolmap') return { ...(d.default as object), ...r }
  return r
}

export async function s28SettingsRest() {
  scenario('s28 the other settings, reset, export / import and the local slash commands')
  const [tw, tw2] = await liveChannels('twitch', 2)
  const [kk] = await liveChannels('kick', 1)
  const yt = await liveYtVideo()
  const env = await launch()
  const errs: string[] = []
  const cons: string[] = []
  const sent: string[] = []
  const t0 = Date.now()
  try {
    // anything that looks like a chat send, from any page or the worker, is a failure of "nothing is sent"
    env.ctx.on('request', (r: any) => {
      try {
        if (r.method() === 'POST' && SEND_URL.test(r.url()) && SEND_BODY.test(r.postData() || r.url())) sent.push(`${r.method()} ${r.url().split('?')[0]}`)
      } catch {}
    })
    const listen = (pg: any, label: string) => {
      watchErrors(pg, label, errs)
      pg.on('console', (m: any) => {
        const text = String(m.text())
        // youtube's own flood about a url it will not load (checked with the add-on off, 11-15): not ours
        if (/^Unsafe attempt to load URL/.test(text)) return
        if (m.type() === 'error' ? /heatsync|Error in event handler/i.test(text) : m.type() === 'warning' && /^\[heatsync\].*(fail|threw|error|exception)/i.test(text))
          cons.push(`${label} ${m.type()}: ${text.slice(0, 160)}`)
      })
      pg.on('websocket', (ws: any) => ws.on('framesent', (f: any) => /PRIVMSG/.test(String(f.payload)) && sent.push(`ws ${ws.url().split('?')[0]}`)))
    }
    const p = await env.ctx.newPage()
    listen(p, 'twitch')
    await p.goto(`https://www.twitch.tv/${tw}`, { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(p)) || !(await rowsFlow(p, 45_000))) return bad('twitch: chat never flowed', await panel(p))

    const ext = await env.ctx.newPage()
    await ext.goto(`chrome-extension://${env.extId}/popup.html`, { waitUntil: 'load' })
    // @ts-ignore — extension page
    await ext.evaluate(() => chrome.storage.local.set({ hs_set_show_all: true }))
    await setUiSetting(env, 'timestamps', true)
    await p.bringToFront()

    // ── storage ──
    const readAll = (): Promise<Store> =>
      // @ts-ignore — extension page
      ext.evaluate(async () => ({ ui: (await chrome.storage.sync.get('ui_settings')).ui_settings || {}, local: await chrome.storage.local.get(null) }))
    const readDef = (d: Def): Promise<Store> =>
      ext.evaluate(
        async (k: string) => ({
          // @ts-ignore
          ui: (await chrome.storage.sync.get('ui_settings')).ui_settings || {},
          // @ts-ignore
          local: await chrome.storage.local.get(k),
        }),
        d.mirrorKey || d.key,
      )
    const writeLocal = (o: Record<string, unknown>) =>
      // @ts-ignore
      ext.evaluate((x: Record<string, unknown>) => chrome.storage.local.set(x), o)
    // @ts-ignore
    const hsErrors = (): Promise<number> => ext.evaluate(async () => ((await chrome.storage.local.get('hs_errors')).hs_errors || []).length)
    let errBase = await hsErrors()

    /** where the panel is, for a step that threw: the open tab and page, and how many settings it draws */
    const where = (pg: any): Promise<string> =>
      pg
        .evaluate(() => {
          const sub = document.querySelector('.hs-mc-set-subtab.active, .hs-mc-set-subtab[aria-selected="true"]')
          const keys = [...document.querySelectorAll('#hs-mc-messages [data-set-key]')].length
          return `tab ${document.querySelector('.hs-mc-tab.active')?.getAttribute('data-tab')}, page ${sub?.getAttribute('data-set-subtab')}, ${keys} controls`
        })
        .catch(() => 'page unreadable')
    /** one checked step: its list of problems, plus anything that threw on a page, the console or the add-on's own log */
    const step = async (what: string, fn: () => Promise<string[]>, pg: any = p) => {
      const pe = errs.length
      const ce = cons.length
      const why = await fn().catch(async (e) => [`threw: ${String(e?.message || e).split('\n')[0].slice(0, 160)} [${await where(pg)}]`])
      const nowErr = await hsErrors()
      if (errs.length > pe) why.push(`page error: ${errs.at(-1)?.slice(0, 160)}`)
      if (cons.length > ce) why.push(`console: ${cons.slice(ce, ce + 2).join(' | ')}`)
      if (nowErr > errBase) why.push(`${nowErr - errBase} add-on error(s)`)
      errBase = nowErr
      if (sent.length) why.push(`looked like a chat send: ${sent.splice(0).join(', ')}`)
      if (why.length) {
        bad(`${what}: ${why.join('; ')}`)
        await shot(pg, `s28-${what.replace(/\W+/g, '-').slice(0, 50)}`)
      } else ok(what)
    }

    // ── the settings page, driven the way a person drives it ──
    const openSettings = async (pg: any = p) => {
      if (!(await pg.$('.hs-mc-tab[data-tab="settings"].active'))) await pg.click('.hs-mc-tab[data-tab="settings"]', { timeout: 10_000 })
      await sleep(700)
    }
    const closeSettings = async (pg: any = p) => {
      if (await pg.$('.hs-mc-tab[data-tab="settings"].active')) await pg.click('.hs-mc-tab[data-tab="settings"]').catch(() => {})
      await sleep(500)
    }
    const toCategory = async (cat: string, pg: any = p) => {
      await openSettings(pg)
      await pg.click(`.hs-mc-set-subtab[data-set-subtab="${cat}"]`, { timeout: 5000 }).catch(() => {})
      await sleep(500)
      // the page starts on the day-one rows; "show all" is its own button, the way a person gets every setting
      const all = await pg.$('[data-set-scope-hint] .hs-mc-set-scope-btn')
      if (all) {
        await all.click().catch(() => {})
        await sleep(500)
      }
      // a fold re-renders the page: one at a time
      for (let i = 0; i < 40; i++) {
        const folded = await pg.$('.hs-mc-settings-group-title[data-set-fold]:text-matches("^▸")')
        if (!folded) break
        await folded.click().catch(() => {})
        await sleep(200)
      }
    }
    /** wait for a control, going back to its category when a re-render moved the page */
    const find = async (cat: string, sel: string, pg: any = p) => {
      let el = await pg.$(sel)
      if (!el) {
        await toCategory(cat, pg)
        el = await pg.$(sel)
      }
      return el
    }

    // ── 1 the controls ──
    type Rec = { d: Def; kind: 'select' | 'btn' | 'range' | 'text' | 'pill'; sel: string; want: unknown; sub?: string }
    const recs: Rec[] = []
    const kinds: Record<string, number> = {}
    const note = (r: Rec) => {
      recs.push(r)
      kinds[`${r.d.type}`] = (kinds[`${r.d.type}`] || 0) + 1
    }
    await p.bringToFront()
    await openSettings()
    const eligible = DEFS.filter((d) => ['sync', 'local'].includes(d.scope || 'sync') && d.type !== 'bool' && d.type !== 'json' && d.control !== 'custom' && !d.noReset && !SKIP_KEYS.has(d.key))
    const cats = [...new Set(eligible.map((d) => d.category))]
    info(`non-bool settings to drive: ${eligible.length} in ${cats.length} categories`)
    for (const cat of cats) {
      await toCategory(cat)
      for (const d of eligible.filter((x) => x.category === cat)) {
        const subs: { sel: string; sub?: string; value?: unknown }[] = []
        if (d.type === 'enum') {
          const opts = (d.options || []) as { value: unknown }[]
          const before = eff(d, await readDef(d))
          const want = d.key in PICK ? PICK[d.key] : opts.map((o) => o.value).find((v) => !same(v, before) && !(SKIP_VALUES[d.key] || []).includes(v))
          if (want === undefined) continue
          const isSel = !!(await p.$(`select[data-set-key="${d.key}"]`))
          subs.push({ sel: isSel ? `select[data-set-key="${d.key}"]` : `button[data-set-key="${d.key}"][data-set-value="${String(want)}"]`, value: want })
        } else if (d.type === 'range') subs.push({ sel: `input[type="range"][data-set-key="${d.key}"]`, value: 0.4 })
        else if (d.type === 'text') subs.push({ sel: `textarea[data-set-key="${d.key}"], input.hs-mc-set-text-input[data-set-key="${d.key}"]`, value: 'e2e one two' })
        else if (d.type === 'multiselect')
          for (const o of (d.options as { value: string }[]).slice(0, 2)) subs.push({ sel: `button[data-set-key="${d.key}"][data-set-value="${o.value}"]`, sub: o.value })
        else if (d.type === 'boolmap')
          for (const o of (d.options as { value: string }[]).filter((o) => !SKIP_SUBS.has(`${d.key}:${o.value}`)).slice(0, 2))
            subs.push({ sel: `button[data-set-key="${d.key}"][data-set-sub="${o.value}"]`, sub: o.value })
        for (const s of subs) {
          const label = `${d.key}${s.sub ? `/${s.sub}` : ''}`
          if (!(await find(cat, s.sel))) {
            info(`${label}: not on the page here (host or depends-on), left out`)
            continue
          }
          await step(`${d.type} ${label} set through its control is stored`, async () => {
            const el = await find(cat, s.sel)
            if (!el) return ['control gone before the click']
            await el.scrollIntoViewIfNeeded().catch(() => {})
            const prev = eff(d, await readDef(d))
            let want: unknown
            let kind: Rec['kind'] = 'pill'
            if (d.type === 'enum') {
              want = s.value
              if (s.sel.startsWith('select')) {
                kind = 'select'
                await p.selectOption(s.sel, String(want))
              } else {
                kind = 'btn'
                await p.click(s.sel, { timeout: 5000 })
              }
            } else if (d.type === 'range') {
              kind = 'range'
              want = s.value
              await p.fill(s.sel, String(Math.round((s.value as number) * (d.displayScale || 1))))
            } else if (d.type === 'text') {
              kind = 'text'
              want = s.value
              await p.fill(s.sel, String(want))
            } else {
              await p.click(s.sel, { timeout: 5000 })
              if (d.type === 'boolmap') want = { ...(prev as object), [s.sub as string]: !(prev as any)[s.sub as string] }
              else {
                const had = (prev as string[]).includes(s.sub as string)
                want = had ? (prev as string[]).filter((x) => x !== s.sub) : [...(prev as string[]), s.sub]
              }
            }
            await sleep(d.type === 'text' ? 1100 : 900)
            const got = eff(d, await readDef(d))
            const ok2 = d.type === 'multiselect' ? same([...(got as string[])].sort(), [...(want as string[])].sort()) : same(got, want)
            if (!ok2) return [`stored ${JSON.stringify(got)}, set ${JSON.stringify(want)}`]
            // a switch for a whole site's panel is flipped back at once: off, kick and youtube would not mount for the legs below
            if (d.key === 'subsystems') {
              await find(cat, s.sel)
              await p.click(s.sel, { timeout: 5000 })
              await sleep(900)
              const back = eff(d, await readDef(d))
              if (!same(back, prev)) return [`flipped back, stored ${JSON.stringify(back)}, had ${JSON.stringify(prev)}`]
              want = prev
            }
            note({ d, kind, sel: s.sel, want, sub: s.sub })
            return []
          })
        }
      }
    }
    for (const type of ['enum', 'range', 'text', 'multiselect', 'boolmap'])
      if (!kinds[type]) bad(`no ${type} control reached on the settings page: the walk through it broke`)

    // the text box that only exists with the "custom" font: its select, then the box, then back
    await step('text customFontName (opened by font = custom) is stored', async () => {
      await toCategory('display')
      // three choices: drawn as buttons, not a drop-down
      await p.click('button[data-set-key="fontFamily"][data-set-value="custom"]', { timeout: 5000 })
      await sleep(900)
      const box = await find('display', 'input.hs-mc-set-text-input[data-set-key="customFontName"]')
      if (!box) return ['the font name box did not open with font = custom']
      await p.fill('input.hs-mc-set-text-input[data-set-key="customFontName"]', 'DejaVu Sans Mono')
      await sleep(1100)
      const d = BY.get('customFontName') as Def
      const got = eff(d, await readDef(d))
      // back to the choice set above ('twitch'), which the later checks expect
      await find('display', 'button[data-set-key="fontFamily"][data-set-value="twitch"]')
      await p.click('button[data-set-key="fontFamily"][data-set-value="twitch"]', { timeout: 5000 })
      await sleep(800)
      return got === 'DejaVu Sans Mono' ? [] : [`stored ${JSON.stringify(got)}`]
    })

    // a slider never stores a value outside its range: typed far outside, a person gets the end of it
    for (const [typed, expect] of [['500', 1], ['-30', 0]] as const)
      await step(`range mentionSoundVolume typed ${typed} is stored inside 0–1 (${expect})`, async () => {
        const d = BY.get('mentionSoundVolume') as Def
        const sel = 'input[type="range"][data-set-key="mentionSoundVolume"]'
        if (!(await find(d.category, sel))) return ['the slider is not on the page']
        // the slider itself keeps a typed value inside its ends (the browser's own rule); a script sets it the way a drag would
        await p.$eval(
          sel,
          (e: any, v: string) => {
            e.value = v
            e.dispatchEvent(new Event('input', { bubbles: true }))
            e.dispatchEvent(new Event('change', { bubbles: true }))
          },
          typed,
        )
        await sleep(900)
        const got = eff(d, await readDef(d))
        return typeof got === 'number' && got >= 0 && got <= 1 && got === expect ? [] : [`stored ${JSON.stringify(got)}`]
      })
    // and left at the mix value for the rest
    {
      const d = BY.get('mentionSoundVolume') as Def
      await find(d.category, 'input[type="range"][data-set-key="mentionSoundVolume"]')
      await p.fill('input[type="range"][data-set-key="mentionSoundVolume"]', '40')
      await sleep(900)
    }

    // ── what each control shows ──
    const shown = async (pg: any, r: Rec): Promise<string | null> => {
      const el = await find(r.d.category, r.sel, pg)
      if (!el) return 'control not on the page'
      const d = r.d
      const v: any = await el.evaluate((e: any) => ({ value: e.value, active: e.classList.contains('active') }))
      if (r.kind === 'select') return String(v.value) === String(r.want) ? null : `shows ${v.value}`
      if (r.kind === 'btn') return v.active ? null : 'button not marked active'
      if (r.kind === 'range') return Number(v.value) === Math.round((r.want as number) * (d.displayScale || 1)) ? null : `shows ${v.value}`
      if (r.kind === 'text') return v.value === r.want ? null : `shows ${JSON.stringify(v.value)}`
      const on = d.type === 'boolmap' ? !!(r.want as any)[r.sub as string] : (r.want as string[]).includes(r.sub as string)
      return v.active === (d.invertDisplay ? !on : on) ? null : `pill ${v.active ? 'on' : 'off'}`
    }
    const showAll = async (what: string) =>
      step(`every control shows its value ${what}`, async () => {
        const why: string[] = []
        for (const cat of cats) {
          await toCategory(cat)
          for (const r of recs.filter((x) => x.d.category === cat)) {
            // the mention volume was left at 0.4 above, whatever its record says
            const bad1 = await shown(p, r)
            if (bad1) why.push(`${r.d.key}${r.sub ? `/${r.sub}` : ''}: ${bad1}`)
          }
        }
        return why.slice(0, 6)
      })
    // the volume record carries 0.4 already; the loop above left it at 0.4 too
    await closeSettings()
    // the effects that are cheap to see, on the chat itself
    await step('effect: font size 18 gives 18px chat text', async () => {
      await sleep(600)
      const px = await p.evaluate(() => {
        const e = document.querySelector('#hs-mc-messages .hs-mc-msg .hs-mc-text') || document.querySelector('#hs-mc-messages .hs-mc-msg')
        return e ? getComputedStyle(e).fontSize : ''
      })
      return px === '18px' ? [] : [`rows read ${px || 'no rows'}`]
    })
    await step('effect: clock 12h gives am/pm on every row', async () => {
      const ts = await p.$$eval('#hs-mc-messages .hs-mc-msg .hs-mc-ts', (e: Element[]) => e.map((x) => (x.textContent || '').trim()))
      const wrong = ts.filter((x) => !/^\d{1,2}:\d\d(am|pm)$/.test(x))
      return !ts.length ? ['no timestamps on rows'] : wrong.length ? [`${wrong.length}/${ts.length} rows read like "${wrong[0]}"`] : []
    })
    await openSettings()
    await showAll('after the settings page was closed and opened again')
    await closeSettings()
    await p.reload({ waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(p))) return bad('twitch: panel never mounted after the reload')
    await sleep(2500)
    await showAll('after a page reload')
    await closeSettings()

    // ── 2 slash commands ──
    const toastsNow = (pg: any): Promise<string[]> => pg.$$eval('.hs-notif-toast-text', (e: Element[]) => e.map((x) => (x.textContent || '').trim()))
    const sampleToasts = async (pg: any, ms: number) => {
      const seen = new Set<string>()
      for (const t1 = Date.now(); Date.now() - t1 < ms; ) {
        for (const x of await toastsNow(pg).catch(() => [])) seen.add(x)
        await sleep(120)
      }
      return [...seen]
    }
    const typeIn = async (pg: any, text: string) => {
      await pg.click('#hs-mc-input', { timeout: 5000 })
      await pg.keyboard.press('Control+A')
      await pg.keyboard.press('Backspace')
      await pg.keyboard.type(text, { delay: 25 })
    }
    const inputLeft = (pg: any): Promise<string> => pg.evaluate(() => (document.getElementById('hs-mc-input')?.textContent || '').trim())
    /** type a local command, Enter, and return what the page said (toasts) and what stayed in the box */
    const cmd = async (pg: any, text: string) => {
      if (!LOCAL_CMD.test(text)) throw new Error(`refusing to send "${text.slice(0, 20)}": not a local command`)
      // let the last command's toast go so this one's is the only one read
      for (let i = 0; i < 30 && (await toastsNow(pg)).length; i++) await sleep(300)
      await typeIn(pg, text)
      await pg.keyboard.press('Enter')
      // a toast can be replaced by the next one within a second: every one seen counts
      const said = await sampleToasts(pg, 1600)
      return { said, left: await inputLeft(pg) }
    }
    const val = async (key: string) => eff(BY.get(key) as Def, await readDef(BY.get(key) as Def))
    const says = (said: string[], re: RegExp) => said.some((s) => re.test(s))

    // back on a chat tab with a composer
    await closeSettings()
    const sets: [string, string, RegExp, (v: unknown) => boolean][] = [
      ['a switch off', '/set timestamps off', /timestamps = false/, (v) => v === false],
      ['a switch on, with a yes word', '/set timestamps yes', /timestamps = true/, (v) => v === true],
      ['a number', '/set mentionSoundVolume 0.55', /mentionSoundVolume = 0\.55/, (v) => v === 0.55],
      ['a text', '/set modBanReasons spam, bots', /modBanReasons = spam, bots/, (v) => v === 'spam, bots'],
      ['a choice', '/set timestampFormat 24h', /timestampFormat = 24h/, (v) => v === '24h'],
    ]
    const keyOf = (c: string) => c.split(/\s+/)[1]
    for (const [what, text, re, isIt] of sets)
      await step(`/set ${what}: "${text}" says so and is stored`, async () => {
        const { said, left } = await cmd(p, text)
        const got = await val(keyOf(text))
        const why: string[] = []
        if (!says(said, re)) why.push(`toasts [${said.join(' | ')}]`)
        if (!isIt(got)) why.push(`stored ${JSON.stringify(got)}`)
        if (left) why.push(`"${left}" left in the box`)
        return why
      })
    const bads: [string, string, RegExp, string][] = [
      ['a bad key', '/set nosuchthing 1', /unknown setting: nosuchthing/, ''],
      ['a bad switch word', '/set timestamps maybe', /use on\/off for timestamps/, 'timestamps'],
      ['a bad number', '/set mentionSoundVolume loud', /invalid value for mentionSoundVolume/, 'mentionSoundVolume'],
      ['a bad choice', '/set timestampFormat 99h', /invalid value for timestampFormat/, 'timestampFormat'],
      ['a list setting (panel only)', '/set hiddenTabs feed', /change that one in the settings panel/, 'hiddenTabs'],
      ['no value at all', '/set timestamps', /\/set/, 'timestamps'],
    ]
    for (const [what, text, re, key] of bads)
      await step(`/set ${what}: "${text}" is refused and nothing changes`, async () => {
        const before = key ? await val(key) : null
        const { said, left } = await cmd(p, text)
        const why: string[] = []
        if (!says(said, re)) why.push(`toasts [${said.join(' | ')}]`)
        if (key && !same(await val(key), before)) why.push(`stored value moved to ${JSON.stringify(await val(key))}`)
        if (!left) why.push('the text left the box though the command failed')
        return why
      })
    // a number typed outside the range: the slider shows 0–100, /set takes 0–1 (its own hint says so)
    await step('/set mentionSoundVolume 40 (the slider\'s number) says what was stored', async () => {
      const { said } = await cmd(p, '/set mentionSoundVolume 40')
      const got = await val('mentionSoundVolume')
      const why: string[] = []
      if (typeof got !== 'number' || got < 0 || got > 1) why.push(`stored ${JSON.stringify(got)}`)
      // the toast must not claim a value that was not stored
      const claim = said.join(' ').match(/mentionSoundVolume = ([\d.]+)/)?.[1]
      if (claim !== undefined && Number(claim) !== got) why.push(`toast says ${claim}, stored ${got}`)
      return why
    })
    await cmd(p, '/set mentionSoundVolume 0.4')
    // the mix values back (the export below starts from them)
    for (const c of ['/set timestampFormat 12h', '/set timestamps on', '/set modBanReasons e2e one two']) await cmd(p, c)

    // /layout adds saved tabs; /tab and /status move around
    await step(`/layout t:${tw2}: a saved tab is added`, async () => {
      const { said } = await cmd(p, `/layout t:${tw2}`)
      await sleep(1500)
      const chs: any[] = await ext.evaluate(async () => ((await chrome.storage.local.get('heatsync_multichat')).heatsync_multichat || {}).channels || [])
      const why: string[] = []
      if (!chs.some((c) => c.twitch === tw2)) why.push(`channels now ${JSON.stringify(chs.map((c) => c.twitch || c.kick || c.id))}`)
      if (!says(said, /tabs added: 1/)) why.push(`toasts [${said.join(' | ')}]`)
      return why
    })
    await step('/layout the same link again says it has them, adds nothing', async () => {
      const n = async () => ((await ext.evaluate(async () => ((await chrome.storage.local.get('heatsync_multichat')).heatsync_multichat || {}).channels || [])) as any[]).length
      const before = await n()
      const { said } = await cmd(p, `/layout t:${tw2}`)
      await sleep(1000)
      return says(said, /already have those tabs/) && (await n()) === before ? [] : [`toasts [${said.join(' | ')}], channels ${before} → ${await n()}`]
    })
    await step('/layout with junk gives the usage line', async () => {
      const { said } = await cmd(p, '/layout nonsense here')
      return says(said, /usage: \/layout/) ? [] : [`toasts [${said.join(' | ')}]`]
    })
    const tabNow = async () => (await panel(p)).activeTab
    // the page's own channel is a saved tab here (a fresh install saves the first stream it opens), and the live tab shows as that tab
    for (const [text, want] of [['/tab mentions', ['mentions']], ['/tab live', ['live', tw]], [`/tab ${tw2}`, null]] as const)
      await step(`${text}: the panel moves to that tab`, async () => {
        await cmd(p, text)
        await sleep(600)
        const now = await tabNow()
        return (want ? want.includes(now) : !!now && now !== 'live' && now !== 'mentions' && now !== tw) ? [] : [`panel is on ${now}`]
      })
    await step('/tab with a name that is no tab says so and stays put', async () => {
      await cmd(p, '/tab live')
      const before = await tabNow()
      const { said } = await cmd(p, '/tab nosuchtab')
      const why: string[] = []
      if (!says(said, /no tab: nosuchtab/)) why.push(`toasts [${said.join(' | ')}]`)
      if ((await tabNow()) !== before) why.push('the panel moved')
      return why
    })
    await step(`/status ${tw2}: opens that channel's status`, async () => {
      await cmd(p, '/tab live')
      const { left } = await cmd(p, `/status ${tw2}`)
      await sleep(2500)
      const now = await tabNow()
      const body = await p.evaluate(() => (document.getElementById('hs-mc-messages')?.textContent || '').trim().length)
      const why: string[] = []
      if (now === 'live' || !now) why.push(`panel stayed on ${now}`)
      if (!body) why.push('the status view is empty')
      if (left) why.push(`"${left}" left in the box`)
      return why
    })
    // the status view has no composer: back by the tab
    await p.click('.hs-mc-tab[data-tab="live"]').catch(() => {})
    await sleep(500)

    // ── 3 reset ──
    const defaultsOf = async (cat?: string) => {
      const s = await readAll()
      // not counted: chatFilterRules (its own check below) and the five content-warning switches, which live on the
      // account: signed out, a reset is sent, refused (401) and rolled back with a "sign in" toast (main-settings.js _cwPatch,
      // _cwRollback), the same thing s15 asserts for a click
      return DEFS.filter((d) => !d.noReset && d.key !== 'chatFilterRules' && d.apply !== 'cwServerPatch' && ['sync', 'local'].includes(d.scope || 'sync') && (!cat || d.category === cat))
        .filter((d) => !same(eff(d, s), d.default))
        .map((d) => d.key)
    }
    const NOT_SETTINGS = {
      muted_users: [{ username: 'e2emuted', expiresAt: Date.now() + 30 * 86400000 }],
      blocked_users: ['e2eblocked'],
      chat_filter_rules: JSON.stringify([{ id: 'e2e-hide', enabled: true, action: 'hide', color: '#ffff00', scope: 'all', match: { type: 'keyword', value: 'e2ewordnobodysays' } }]),
    }
    await writeLocal(NOT_SETTINGS)
    await sleep(1500)
    const channelsOf = async () =>
      ((await ext.evaluate(async () => ((await chrome.storage.local.get('heatsync_multichat')).heatsync_multichat || {}).channels || [])) as any[]).map((c) => `${c.id}|${c.twitch}|${c.kick}|${c.youtube}`)
    const chBefore = await channelsOf()
    // a state key a reset must leave (people, not a preference: registry noReset)
    await setUiSetting(env, 'hiddenPaintUsers', ['e2e-user'])
    await sleep(1500)
    // the mix, kept to put back for the export
    const mixStore = await readAll()
    const mixUi = mixStore.ui
    const mixLocal: Record<string, unknown> = {}
    for (const d of DEFS) if (d.scope === 'local' || d.scope === 'local-mirror') if (raw(d, mixStore) !== undefined) mixLocal[d.mirrorKey || d.key] = raw(d, mixStore)
    info(`mix before the resets: ${(await defaultsOf()).length} settings off their default`)

    const clickReset = async (sel: string) => {
      await closeSettings()
      await toCategory(sel.includes('pagedefaults') ? 'display' : 'system')
      await p.click(sel, { timeout: 5000 })
      await sleep(2200)
    }
    await step('reset this page (display): its settings are the defaults, other pages keep theirs', async () => {
      const keep = (await defaultsOf()).filter((k) => BY.get(k)?.category !== 'display')
      await clickReset('.hs-mc-pagedefaults-btn[data-set-cat="display"]')
      const left = await defaultsOf('display')
      const after = (await defaultsOf()).filter((k) => BY.get(k)?.category !== 'display')
      const why: string[] = []
      if (left.length) why.push(`display still off default: ${left.join(', ')}`)
      if (!same(keep.sort(), after.sort())) why.push(`other pages changed: ${keep.filter((k) => !after.includes(k)).join(', ')}`)
      if (!keep.length) why.push('nothing was set outside display to keep')
      return why
    })
    await step('reset all: every setting is its default, and the controls show it', async () => {
      await clickReset('.hs-mc-defaults-btn')
      const left = await defaultsOf()
      const why: string[] = []
      if (left.length) {
        const s = await readAll()
        why.push(`still off default: ${left.slice(0, 8).map((k) => `${k}=${JSON.stringify(eff(BY.get(k) as Def, s))}`).join(', ')}`)
      }
      // the controls on screen, after the page redraws them
      for (const cat of cats) {
        await toCategory(cat)
        for (const r of recs.filter((x) => x.d.category === cat && x.kind !== 'pill')) {
          const v: any = await (await find(cat, r.sel))?.evaluate((e: any) => ({ value: e.value, active: e.classList.contains('active') }))
          if (!v) continue
          const def = r.d.default
          const wantShown = r.kind === 'range' ? Math.round((def as number) * (r.d.displayScale || 1)) : def
          if (r.kind === 'select' && String(v.value) !== String(def)) why.push(`${r.d.key} shows ${v.value}`)
          else if (r.kind === 'range' && Number(v.value) !== wantShown) why.push(`${r.d.key} shows ${v.value}`)
          else if (r.kind === 'text' && v.value !== def) why.push(`${r.d.key} shows ${JSON.stringify(v.value)}`)
          else if (r.kind === 'btn' && v.active) why.push(`${r.d.key} still marked`)
        }
      }
      return why.slice(0, 8)
    })
    await step('reset all keeps the hidden paint users list (noReset)', async () => {
      const s = await readAll()
      return same(s.ui.hiddenPaintUsers, ['e2e-user']) ? [] : [`now ${JSON.stringify(s.ui.hiddenPaintUsers)}`]
    })
    await step('reset all keeps the saved tabs, mutes and blocks', async () => {
      const s = await readAll()
      const why: string[] = []
      if (!same(await channelsOf(), chBefore)) why.push(`saved tabs ${chBefore.length} → ${(await channelsOf()).length}`)
      if (!same(s.local.muted_users, NOT_SETTINGS.muted_users)) why.push('mutes changed')
      if (!same(s.local.blocked_users, NOT_SETTINGS.blocked_users)) why.push('blocks changed')
      return why
    })
    // chatFilterRules is a registry setting with no noReset: the code resets it. The hide rules are what
    // a person wrote, like the hidden-paint-users list that got noReset for exactly that reason.
    await step('reset all keeps the hide rules a person wrote', async () => {
      const s = await readAll()
      return same(s.local.chat_filter_rules, NOT_SETTINGS.chat_filter_rules) ? [] : [`chat_filter_rules is now ${JSON.stringify(s.local.chat_filter_rules)} (had 1 rule)`]
    })

    // ── 4 export → reset all → import ──
    // the mix put back (storage, the way another device would), with the rules, then exported by the real button
    await closeSettings()
    // @ts-ignore
    await ext.evaluate((ui: unknown) => chrome.storage.sync.set({ ui_settings: ui }), mixUi)
    await writeLocal({ ...mixLocal, ...NOT_SETTINGS })
    await sleep(2500)
    const A = await readAll()
    let file = ''
    await step('export: the button saves a file that holds the whole mix', async () => {
      await toCategory('system')
      const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 15_000 }), p.click('[data-action="export-settings"]', { timeout: 5000 })])
      file = readFileSync(await dl.path(), 'utf8')
      const b = JSON.parse(file)
      const why: string[] = []
      if (b.kind !== 'heatsync-settings' || b.version !== 1) why.push(`kind ${b.kind} version ${b.version}`)
      for (const [k, v] of Object.entries(A.ui)) if (!(`ui.${k}` in VOLATILE) && !same(b.sync?.ui_settings?.[k], v)) why.push(`ui_settings.${k} not in the file as stored`)
      for (const [k, v] of Object.entries(A.local)) if (inBackup(k) && !(`local.${k}` in VOLATILE) && !same(b.local?.[k], v)) why.push(`local.${k} not in the file as stored`)
      for (const k of Object.keys(b.local || {})) if (PRIVATE_RE.test(k)) why.push(`private key ${k} rode the export`)
      if (!says(await toastsNow(p), /settings exported/)) why.push('no "settings exported" toast')
      return why.slice(0, 8)
    })
    if (!file) return bad('no export file: the rest of the backup steps cannot run')
    const bundle = JSON.parse(file)

    const settle = async () => {
      await sleep(2000)
      const up = await waitPanel(p, 30_000)
      await sleep(2000)
      return up
    }
    const importFile = async (name: string, content: string) => {
      await toCategory('system')
      for (let i = 0; i < 30 && (await toastsNow(p)).length; i++) await sleep(300)
      const [fc] = await Promise.all([p.waitForEvent('filechooser', { timeout: 10_000 }), p.click('[data-action="import-settings"]', { timeout: 5000 })])
      await fc.setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(content) })
      // a good import reloads the page ~800ms later: read the toasts while it is still there
      return sampleToasts(p, 1500)
    }
    // the keys a backup carries, as the storage holds them, minus the named volatile ones
    const snap = async () => {
      const s = await readAll()
      const o: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(s.ui)) if (!(`ui.${k}` in VOLATILE)) o[`ui.${k}`] = v
      for (const [k, v] of Object.entries(s.local)) if (inBackup(k) && !(`local.${k}` in VOLATILE)) o[`local.${k}`] = v
      return o
    }
    await step('reset all, then import that file: every stored value is back exactly', async () => {
      await clickReset('.hs-mc-defaults-btn')
      const off = await defaultsOf()
      const why: string[] = []
      if (off.length) why.push(`reset left ${off.length} off default before the import`)
      const said = await importFile('heatsync-settings.json', file)
      if (!says(said, /settings imported/)) why.push(`toasts [${said.join(' | ')}]`)
      // the page reloads itself ~800ms after a good import
      if (!(await settle())) return [...why, 'panel never came back after the import reload']
      const B = await readAll()
      const gone: string[] = []
      for (const [k, v] of Object.entries(bundle.sync.ui_settings))
        if (!(`ui.${k}` in VOLATILE) && !same(B.ui[k], v)) gone.push(`ui_settings.${k}: ${JSON.stringify(B.ui[k])?.slice(0, 40)} not ${JSON.stringify(v)?.slice(0, 40)}`)
      for (const [k, v] of Object.entries(bundle.local)) if (!(`local.${k}` in VOLATILE) && !same(B.local[k], v)) gone.push(`local.${k} differs`)
      // and what the product shows: every registry setting as it was
      const shownDiff = DEFS.filter((d) => ['sync', 'local', 'local-mirror'].includes(d.scope || 'sync') && !(`ui.${d.key}` in VOLATILE)).filter((d) => !same(eff(d, B), eff(d, A)))
      if (gone.length) why.push(`not back: ${gone.slice(0, 6).join('; ')}`)
      if (shownDiff.length) why.push(`effective values differ: ${shownDiff.map((d) => d.key).slice(0, 8).join(', ')}`)
      return why
    })
    await step('after the import every control shows the mix again', async () => {
      await openSettings()
      const why: string[] = []
      for (const cat of cats) {
        await toCategory(cat)
        for (const r of recs.filter((x) => x.d.category === cat)) {
          const m = await shown(p, r)
          if (m) why.push(`${r.d.key}${r.sub ? `/${r.sub}` : ''}: ${m}`)
        }
      }
      await closeSettings()
      return why.slice(0, 6)
    })

    // ── kick and youtube: the cheap parts ──
    const lite = async (host: string, url: string) => {
      const pg = await env.ctx.newPage()
      listen(pg, host)
      try {
        await pg.goto(url, { waitUntil: 'domcontentloaded' })
        if (!(await waitPanel(pg, 40_000))) return bad(`${host}: panel never mounted`)
        await sleep(2500)
        await pg.bringToFront()
        // one control of each kind that is on this host's page
        const per = ['select', 'btn', 'range', 'text', 'pill'].map((k) => recs.find((r) => r.kind === k && !r.d.hosts?.length)).filter(Boolean) as Rec[]
        await step(`${host}: the controls show the stored mix`, async () => {
          const why: string[] = []
          for (const r of per) {
            await toCategory(r.d.category, pg)
            const m = await shown(pg, r)
            if (m) why.push(`${r.d.key}${r.sub ? `/${r.sub}` : ''}: ${m}`)
          }
          return why
        }, pg)
        for (const r of per.filter((x) => ['select', 'btn', 'range'].includes(x.kind)))
          await step(`${host}: ${r.d.key} changed here is stored`, async () => {
            await toCategory(r.d.category, pg)
            const prev = eff(r.d, await readDef(r.d))
            const opts = (Array.isArray(r.d.options) ? (r.d.options as { value: unknown }[]) : []).map((o) => o.value)
            const next = r.kind === 'range' ? 0.2 : opts.find((v) => !same(v, prev) && !(SKIP_VALUES[r.d.key] || []).includes(v))
            const el = await find(r.d.category, r.kind === 'btn' ? `button[data-set-key="${r.d.key}"][data-set-value="${String(next)}"]` : r.sel, pg)
            if (!el) return ['control not on the page']
            if (r.kind === 'select') await pg.selectOption(r.sel, String(next))
            else if (r.kind === 'range') await pg.fill(r.sel, String(Math.round(0.2 * (r.d.displayScale || 1))))
            else await el.click()
            await sleep(900)
            const got = eff(r.d, await readDef(r.d))
            // the mix put back, for the next host's check
            if (r.d.scope === 'local') await writeLocal({ [r.d.key]: prev })
            else await setUiSetting(env, r.d.key, prev)
            return same(got, next) ? [] : [`stored ${JSON.stringify(got)}, set ${JSON.stringify(next)}`]
          }, pg)
        await closeSettings(pg)
        await step(`${host}: /set from the composer`, async () => {
          const { said } = await cmd(pg, '/set mentionSoundVolume 0.35')
          const got = await val('mentionSoundVolume')
          await cmd(pg, '/set mentionSoundVolume 0.4')
          return got === 0.35 && says(said, /mentionSoundVolume = 0\.35/) ? [] : [`stored ${JSON.stringify(got)}, toasts [${said.join(' | ')}]`]
        }, pg)
      } finally {
        await pg.close().catch(() => {})
      }
    }
    await lite('kick', `https://kick.com/${kk}`)
    if (yt) await lite('youtube', `https://www.youtube.com/watch?v=${yt.id}`)

    // ── bad files ──
    const before = await snap()
    const badFiles: [string, string, string, RegExp][] = [
      ['not json at all', 'notes.json', 'this is not json {', /import failed/],
      ['json of the wrong shape', 'shape.json', JSON.stringify({ hello: 'world', sync: { ui_settings: { fontSize: 22 } } }), /not a heatsync settings file/],
      ['a list, not an object', 'list.json', '[1,2,3]', /not a heatsync settings file/],
      [
        'wrong types for real keys',
        'types.json',
        JSON.stringify({
          kind: 'heatsync-settings',
          version: 1,
          sync: { ui_settings: { fontSize: 'huge', timestampFormat: 5, hiddenTabs: 'nope', mentionSoundVolume: 'loud' } },
          local: { hs_mod_toolbar_buttons: 'not a list', hs_emote_size: { a: 1 } },
        }),
        /import failed|invalid|not a heatsync/,
      ],
    ]
    for (const [what, name, content, re] of badFiles)
      await step(`import ${what}: nothing stored changes, it says it failed`, async () => {
        const said = await importFile(name, content)
        // a "good" verdict reloads the page; wait it out so the compare below is of a settled page
        if (!(await settle())) return ['panel gone after the import']
        const after = await snap()
        const why: string[] = []
        const diff = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !same(before[k], after[k]))
        if (diff.length) why.push(`stored values changed: ${diff.slice(0, 6).map((k) => `${k} → ${JSON.stringify(after[k])?.slice(0, 40)}`).join('; ')}`)
        if (!says(said, re)) why.push(`toasts [${said.join(' | ')}]`)
        else if (says(said, /settings imported/)) why.push('it said "settings imported"')
        return why
      })

    // ── end ──
    info(`took ${Math.round((Date.now() - t0) / 1000)}s`)
    await p.bringToFront()
    const ring = await ringSince(p, t0)
    if (ring.bad.length) bad('the overlay watchdogs fired', ring.bad.slice(0, 6))
    else ok('the watchdog ring stayed quiet')
    if (errs.length) bad(`page errors over the run: ${errs.length}`, errs.slice(0, 4))
    else ok('no page error over the whole run')
  } finally {
    await env.close()
  }
}

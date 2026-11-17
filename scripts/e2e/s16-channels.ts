/**
 * s16 — channels added and removed the way a person does it: the + tab's form, typed and
 * submitted, and the tab's right-click menu → remove. Every other scenario saves channels by
 * writing storage; this one drives the panel's own add and remove paths (removeChannel parts
 * the platforms' chats in the page itself).
 *
 *   bun scripts/e2e/run.ts --only s16
 *
 * On a twitch stream and then a kick stream (a fresh install saves the first stream it opens:
 * that tab is there from the start):
 *   - the saved stream removed from its menu, then added back from the form: its tab opens and
 *     draws the stream's chat
 *   - the same channel again: refused with the form's own words, still one tab
 *   - removed from its menu, here and then from a page on the other site (the change reaches
 *     this page through storage): the tab and the saved entry are gone, the panel is back on the
 *     stream, the page still holds the stream's room, and its chat keeps coming, with no pause
 *     longer than STILL_MS
 *   - on twitch also a second channel saved with a kick leg (one merged tab): both platforms
 *     draw; its kick leg changed in the edit form by pasting a kick.com link (saved as the
 *     name, the new room joined, the old one left); then removed the same way, the stream's
 *     chat unbroken
 *   - nothing threw on the page, the console, or the add-on's error log; watchdogs quiet
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bad,
  dbg,
  extStorage,
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

const EN = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8'))
const REMOVE = EN.mc_ctx_remove.message as string
const EDIT = EN.mc_ctx_edit.message as string
const WATCH_MS = 40_000
const STILL_MS = 10_000

type Legs = { twitch?: string; kick?: string }

/** The newest row's key, sampled every 500ms for `ms`: the longest it sat still, and which platforms drew. */
async function watch(p: any, ms: number) {
  return p.evaluate(
    (ms: number) =>
      new Promise((done) => {
        const t0 = Date.now()
        let last = ''
        let changed = Date.now()
        let still = 0
        const plats = new Set<string>()
        const iv = setInterval(() => {
          const rows = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].slice(-60) as HTMLElement[]
          for (const r of rows) if (r.querySelector('.hs-mc-user')) plats.add(r.dataset.msgPlatform || 'twitch')
          const k = rows.at(-1)?.dataset.msgKey || ''
          if (k !== last) {
            last = k
            changed = Date.now()
          }
          still = Math.max(still, Date.now() - changed)
          if (Date.now() - t0 >= ms) {
            clearInterval(iv)
            done({ still, plats: [...plats], tab: document.querySelector('.hs-mc-tab.active')?.getAttribute('data-tab') })
          }
        }, 500)
      }),
    ms,
  ) as Promise<{ still: number; plats: string[]; tab: string | null }>
}

export async function s16Channels() {
  scenario('s16 channels added and removed from the panel')
  const [twA, twB] = await liveChannels('twitch', 2)
  const [kkA, kkB, kkC] = await liveChannels('kick', 3)
  const env = await launch()
  const errs: string[] = []
  const cons: string[] = []
  const saved = async () =>
    (await extStorage(
      env,
      // @ts-ignore — extension page
      async () => ((await chrome.storage.local.get('heatsync_multichat')).heatsync_multichat?.channels || []),
    )) as { id: string; twitch?: string; kick?: string }[]
  // @ts-ignore — extension page
  const hsErrors = async () => ((await extStorage(env, async () => (await chrome.storage.local.get('hs_errors')).hs_errors || [])) as unknown[]).length

  try {
    const p = await env.ctx.newPage()
    watchErrors(p, 'page', errs)
    p.on('console', (m: any) => {
      const text = String(m.text())
      if (m.type() === 'error' ? /heatsync|Error in event handler/i.test(text) : m.type() === 'warning' && /^\[heatsync\].*(fail|threw|error|exception)/i.test(text))
        cons.push(`${m.type()}: ${text.slice(0, 160)}`)
    })

    const tabs = () => p.$$eval('.hs-mc-tab[data-tab]', (t: Element[]) => t.map((x) => (x as HTMLElement).dataset.tab || ''))
    // the + tab's form, typed and submitted with its add button; answers the form's error line
    const add = async (legs: Legs) => {
      await p.click('.hs-mc-tab[data-tab="add"]', { timeout: 10_000 })
      await p.waitForSelector('#hs-mc-messages input.hs-mc-ch-input', { timeout: 5000 })
      for (const [plat, name] of Object.entries(legs)) if (name) await p.fill(`#hs-mc-messages input.hs-mc-ch-input[aria-label="${plat}"]`, name)
      await p.locator('#hs-mc-messages button', { hasText: /^add$/ }).click({ timeout: 5000 })
      await sleep(800)
      return p.evaluate(() => {
        const e = document.querySelector('#hs-mc-messages [role="alert"]') as HTMLElement | null
        return e && e.style.display !== 'none' ? e.textContent || '' : ''
      })
    }
    const remove = async (id: string, on = p) => {
      await on.click(`.hs-mc-tab[data-tab="${id}"]`, { button: 'right', timeout: 5000 })
      await on.locator('#hs-mc-ctx-menu [role="menuitem"]', { hasText: new RegExp(`^${REMOVE}$`) }).click({ timeout: 5000 })
      await sleep(500)
    }

    const round = async (host: string, url: string, elsewhere: string, mine: Legs, other?: Legs, swapKick?: string) => {
      const id = (mine.twitch || mine.kick) as string
      await p.goto(url, { waitUntil: 'domcontentloaded' })
      if (!(await waitPanel(p)) || !(await rowsFlow(p, 45_000))) return bad(`${host}: chat never flowed`, await panel(p))
      const t0 = Date.now()
      let errBase = await hsErrors()
      const step = async (what: string, fn: () => Promise<string[]>) => {
        const pe = errs.length
        const ce = cons.length
        const why = await fn().catch((e) => [`threw: ${String(e?.message || e).slice(0, 200)}`])
        const nowErr = await hsErrors()
        if (errs.length > pe) why.push(`page error: ${errs.at(-1)?.slice(0, 140)}`)
        if (cons.length > ce) why.push(`console: ${cons.slice(ce, ce + 2).join(' | ')}`)
        if (nowErr > errBase) why.push(`${nowErr - errBase} add-on error(s)`)
        errBase = nowErr
        if (why.length) {
          bad(`${host} ${what}: ${why.join('; ')}`, await panel(p))
          await shot(p, `s16-${host}-${what.replace(/\W+/g, '-')}`)
        } else ok(`${host} ${what}`)
      }

      const gone = async (what: string, on = p) =>
        step(what, async () => {
          const why: string[] = []
          const held = async () => {
            const d = await dbg(p)
            const r = (host === 'twitch' ? d.irc : d.kick)?.[id]
            return { rows: (await panel(p)).rows as number, buf: r ? r.count : -1 }
          }
          const was = await held()
          await remove(id, on)
          await sleep(1000)
          const now = await held()
          info(`${host}: removing ${id}: pane ${was.rows}→${now.rows} rows, room buffer ${was.buf}→${now.buf}`)
          // the page still holds its stream's room (a part empties the live tab until a rejoin)
          const d = await dbg(p)
          const rooms = host === 'twitch' ? d.irc : d.kick
          if (d.err || !rooms || typeof rooms !== 'object') info(`${host}: no room list from the probe (${d.err || typeof rooms})`)
          else if (!rooms[id]) why.push(`the page left the stream's own ${host} room`)
          if ((await tabs()).includes(id)) why.push('its tab is still there')
          if ((await saved()).some((c) => c.id === id)) why.push('still saved')
          const w = await watch(p, WATCH_MS)
          info(`${host}: after removing ${id}: on ${w.tab}, longest still ${Math.round(w.still / 1000)}s`)
          if (w.tab !== 'live') why.push(`the panel went to ${w.tab}, not the stream`)
          if (w.still > STILL_MS) why.push(`the stream's chat sat still ${Math.round(w.still / 1000)}s`)
          return why
        })
      if (!(await saved()).some((c) => c.id === id)) bad(`${host}: a fresh install did not save the first stream it opened`)
      else await gone(`the saved stream removed, its chat unbroken`)
      await step(`the stream's own channel added from the form`, async () => {
        const why: string[] = []
        const err = await add(mine)
        if (err) why.push(`refused: ${err}`)
        if (!(await tabs()).includes(id)) why.push('no tab for it')
        if (!(await saved()).some((c) => c.id === id)) why.push('not saved')
        if (!(await rowsFlow(p, 30_000))) why.push('its tab drew no chat')
        return why
      })
      await step('the same channel again is refused, one tab', async () => {
        const why: string[] = []
        const err = await add(mine)
        if (!err) why.push('no refusal shown')
        if ((await tabs()).filter((t) => t === id).length !== 1) why.push('a second tab')
        if ((await saved()).filter((c) => c.id === id).length !== 1) why.push('saved twice')
        // the form stays open on a refusal: back to the stream's tab
        await p.click(`.hs-mc-tab[data-tab="${id}"]`).catch(() => {})
        return why
      })
      // the same tab removed from a page on the other site: this page learns it through storage
      const p2 = await env.ctx.newPage()
      watchErrors(p2, 'other page', errs)
      await p2.goto(elsewhere, { waitUntil: 'domcontentloaded' })
      const there = (await waitPanel(p2)) && (await p2.waitForSelector(`.hs-mc-tab[data-tab="${id}"]`, { timeout: 30_000 }).then(() => true, () => false))
      if (!there) bad(`${host}: the page on the other site never showed the saved tab ${id}`, await panel(p2))
      else await gone(`the stream's own channel removed from a page on the other site, its chat unbroken`, p2)
      await p2.close().catch(() => {})
      await p.bringToFront()
      if (other) {
        const oid = (other.twitch || other.kick) as string
        await step('a channel on two platforms added (one merged tab)', async () => {
          const why: string[] = []
          const err = await add(other)
          if (err) why.push(`refused: ${err}`)
          const tab = await p.$eval('.hs-mc-tab.active', (t: Element) => (t as HTMLElement).dataset.tab).catch(() => null)
          if (tab !== oid) why.push(`opened ${tab}, not ${oid}`)
          const w = await watch(p, 60_000)
          info(`${host}: merged ${oid} (kick ${other.kick}): platforms ${w.plats.join('+') || 'none'}, longest still ${Math.round(w.still / 1000)}s`)
          for (const pl of Object.keys(other)) if (!w.plats.includes(pl)) why.push(`no ${pl} rows`)
          return why
        })
        if (swapKick) {
          await step('its kick leg changed in the edit form by pasting a link', async () => {
            const why: string[] = []
            await p.click(`.hs-mc-tab[data-tab="${oid}"]`, { button: 'right', timeout: 5000 })
            await p.locator('#hs-mc-ctx-menu [role="menuitem"]', { hasText: new RegExp(`^${EDIT}$`) }).click({ timeout: 5000 })
            await p.fill('#hs-mc-messages input.hs-mc-ch-input[aria-label="kick"]', `https://kick.com/${swapKick}`)
            await p.locator('#hs-mc-messages button', { hasText: /^save$/ }).click({ timeout: 5000 })
            await sleep(1500)
            const err = await p.evaluate(() => {
              const e = document.querySelector('#hs-mc-messages [role="alert"]') as HTMLElement | null
              return e && e.style.display !== 'none' ? e.textContent || '' : ''
            })
            if (err) why.push(`refused: ${err}`)
            const kept = (await saved()).find((c) => c.id === oid)
            if (kept?.kick !== swapKick) why.push(`saved kick ${JSON.stringify(kept?.kick)}, not ${swapKick}`)
            const d = await dbg(p)
            if (d.kick && typeof d.kick === 'object') {
              if (!d.kick[swapKick]) why.push(`never joined kick ${swapKick}`)
              if (other.kick && d.kick[other.kick]) why.push(`still in the old kick room ${other.kick}`)
            }
            const w = await watch(p, 45_000)
            if (!w.plats.includes('kick')) why.push('no kick rows after the change')
            return why
          })
        }
        await step(`the merged channel removed, the stream's chat unbroken`, async () => {
          const why: string[] = []
          await remove(oid)
          if ((await tabs()).includes(oid)) why.push('its tab is still there')
          if ((await saved()).some((c) => c.id === oid)) why.push('still saved')
          const w = await watch(p, WATCH_MS)
          info(`${host}: after removing ${oid}: on ${w.tab}, longest still ${Math.round(w.still / 1000)}s`)
          if (w.tab !== 'live') why.push(`the panel went to ${w.tab}, not the stream`)
          if (w.still > STILL_MS) why.push(`the stream's chat sat still ${Math.round(w.still / 1000)}s`)
          return why
        })
      }
      await step('a name half typed into the + form outlives what other tabs save', async () => {
        const why: string[] = []
        const before = await saved()
        // what another tab (or another device) writes: a filter rule, then a saved channel
        const write = (o: Record<string, unknown>) =>
          // @ts-ignore — extension page
          extStorage(env, async (v) => chrome.storage.local.set(v), o)
        const active = () => p.$eval('.hs-mc-tab.active', (t: Element) => (t as HTMLElement).dataset.tab).catch(() => null)
        const typed = () => p.$eval('#hs-mc-messages input.hs-mc-ch-input[aria-label="twitch"]', (i: Element) => (i as HTMLInputElement).value).catch(() => null)
        await p.click('.hs-mc-tab[data-tab="add"]', { timeout: 10_000 })
        await p.fill('#hs-mc-messages input.hs-mc-ch-input[aria-label="twitch"]', 'half_a_na')
        const rules = (await extStorage(
          env,
          // @ts-ignore — extension page
          async () => (await chrome.storage.local.get('chat_filter_rules')).chat_filter_rules ?? null,
        )) as string | null
        await write({ chat_filter_rules: '[]' === rules ? '[ ]' : '[]' })
        await sleep(2500)
        if ((await typed()) !== 'half_a_na') why.push(`a rule changed elsewhere emptied the form (it reads ${JSON.stringify(await typed())})`)
        await p.fill('#hs-mc-messages input.hs-mc-ch-input[aria-label="twitch"]', 'half_a_na').catch(() => {})
        await write({ heatsync_multichat: { channels: [...before, { id: twB, twitch: twB, kick: '', youtube: '' }] } })
        await sleep(3000)
        if ((await active()) !== 'add') why.push(`a channel saved elsewhere moved the panel to ${await active()}`)
        else if ((await typed()) !== 'half_a_na') why.push(`a channel saved elsewhere emptied the form (it reads ${JSON.stringify(await typed())})`)
        if (!(await tabs()).includes(twB)) why.push(`the channel saved elsewhere got no tab`)
        // and the settings pane stays put when that channel goes again
        await p.click('.hs-mc-tab[data-tab="settings"]', { timeout: 5000 })
        await sleep(800)
        await write({ heatsync_multichat: { channels: before } })
        await sleep(3000)
        if ((await active()) !== 'settings') why.push(`a channel removed elsewhere moved the panel off settings, to ${await active()}`)
        if (rules === null) await extStorage(env, async () => chrome.storage.local.remove('chat_filter_rules'))
        else await write({ chat_filter_rules: rules })
        return why
      })
      const ring = await ringSince(p, t0)
      if (ring.bad.length) bad(`${host}: overlay watchdogs fired`, ring.bad.slice(0, 6))
    }

    await round('twitch', `https://www.twitch.tv/${twA}`, `https://kick.com/${kkA}`, { twitch: twA }, { twitch: twB, kick: kkB }, kkC)
    await round('kick', `https://kick.com/${kkA}`, `https://www.twitch.tv/${twA}`, { kick: kkA })
  } finally {
    await env.close()
  }
}

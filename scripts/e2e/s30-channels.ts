/**
 * s30's s16 leg: channels added from the + tab's form and removed from a tab's right-click menu,
 * in firefox. The steps and checks are s16's.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bad, dbg, info, panel, ROOT, ringSince, rowsFlow, sleep } from './lib'
import { type Session, stepper, type Tab } from './s30-driver'

const EN = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8'))
const REMOVE = EN.mc_ctx_remove.message as string
const EDIT = EN.mc_ctx_edit.message as string
const WATCH_MS = 40_000
const STILL_MS = 10_000

type Legs = { twitch?: string; kick?: string }
type Saved = { id: string; twitch?: string; kick?: string }[]

/**
 * The newest row's key, sampled every 500ms for `ms`: the longest it sat still, and which
 * platforms drew. Started in the page and read back after, so no webdriver call waits `ms`.
 */
async function watch(t: Tab, ms: number) {
  await t.evaluate(() => {
    const w: any = ((window as any).__s30w = { still: 0, plats: new Set<string>(), last: '', changed: Date.now() })
    w.iv = setInterval(() => {
      const rows = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].slice(-60) as HTMLElement[]
      for (const r of rows) if (r.querySelector('.hs-mc-user')) w.plats.add(r.dataset.msgPlatform || 'twitch')
      const k = rows.at(-1)?.dataset.msgKey || ''
      if (k !== w.last) {
        w.last = k
        w.changed = Date.now()
      }
      w.still = Math.max(w.still, Date.now() - w.changed)
    }, 500)
  })
  await sleep(ms)
  return t.evaluate(() => {
    const w = (window as any).__s30w
    clearInterval(w.iv)
    return { still: w.still as number, plats: [...w.plats] as string[], tab: document.querySelector('.hs-mc-tab.active')?.getAttribute('data-tab') ?? null }
  })
}

const panelUp = async (t: Tab, ms = 30_000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await t.evaluate(() => !!document.getElementById('hs-mc-container'))) return true
    await sleep(500)
  }
  return false
}

export async function channelsLeg(s: Session, twA: string, twB: string, kk: [string, string, string]) {
  const p = s.main
  const tabs = () => p.evaluate(() => [...document.querySelectorAll('.hs-mc-tab[data-tab]')].map((x) => (x as HTMLElement).dataset.tab || ''))
  const saved = async () => (((await s.stored<{ channels?: Saved }>('heatsync_multichat')) || {}).channels || []) as Saved
  const formError = (t: Tab) =>
    t.evaluate(() => {
      const e = document.querySelector('#hs-mc-messages [role="alert"]') as HTMLElement | null
      return e && e.style.display !== 'none' ? e.textContent || '' : ''
    })
  const active = (t: Tab) => t.evaluate(() => document.querySelector('.hs-mc-tab.active')?.getAttribute('data-tab') ?? null)
  // the + tab's form, typed and submitted with its add button; answers the form's error line
  const add = async (legs: Legs) => {
    await p.click('.hs-mc-tab[data-tab="add"]')
    await p.el('#hs-mc-messages input.hs-mc-ch-input')
    for (const [plat, name] of Object.entries(legs)) if (name) await p.fill(`#hs-mc-messages input.hs-mc-ch-input[aria-label="${plat}"]`, name)
    await p.click('#hs-mc-messages button', { text: '^add$' })
    await sleep(800)
    return formError(p)
  }
  const menu = async (t: Tab, id: string, item: string) => {
    await t.click(`.hs-mc-tab[data-tab="${id}"]`, { right: true })
    await t.click('#hs-mc-ctx-menu [role="menuitem"]', { text: `^${item}$` })
  }
  const remove = async (id: string, on = p) => {
    await menu(on, id, REMOVE)
    await sleep(500)
  }

  const round = async (host: 'twitch' | 'kick', url: string, elsewhere: string, mine: Legs, other?: Legs, swapKick?: string) => {
    const id = (mine.twitch || mine.kick) as string
    const label = `firefox ${host}:`
    await p.goto(url)
    if (!(await panelUp(p)) || !(await rowsFlow(p, 45_000))) return bad(`${label} chat never flowed`, await panel(p))
    const t0 = Date.now()
    const step = stepper(s, label, async (what) => {
      await p.shot(`s30-s16-${host}-${what}`)
      return panel(p)
    })

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

    if (!(await saved()).some((c) => c.id === id)) bad(`${label} a fresh install did not save the first stream it opened`)
    else await gone('the saved stream is removed from its menu, its chat unbroken')
    await step("the stream's own channel is added from the form", async () => {
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
      if ((await tabs()).filter((x) => x === id).length !== 1) why.push('a second tab')
      if ((await saved()).filter((c) => c.id === id).length !== 1) why.push('saved twice')
      // the form stays open on a refusal: back to the stream's tab
      await p.click(`.hs-mc-tab[data-tab="${id}"]`).catch(() => {})
      return why
    })
    // the same tab removed from a page on the other site: this page learns it through storage
    const p2 = await s.newTab()
    await p2.goto(elsewhere)
    const there = (await panelUp(p2)) && (await p2.has(`.hs-mc-tab[data-tab="${id}"]`, 30_000))
    if (!there) bad(`${label} the page on the other site never showed the saved tab ${id}`, await panel(p2))
    else await gone("the stream's own channel is removed from a page on the other site, its chat unbroken", p2)
    await s.closeTab(p2)
    await p.front()
    if (other) {
      const oid = (other.twitch || other.kick) as string
      await step('a channel on two platforms is added (one merged tab)', async () => {
        const why: string[] = []
        const err = await add(other)
        if (err) why.push(`refused: ${err}`)
        const tab = await active(p)
        if (tab !== oid) why.push(`opened ${tab}, not ${oid}`)
        const w = await watch(p, 60_000)
        info(`${host}: merged ${oid} (kick ${other.kick}): platforms ${w.plats.join('+') || 'none'}, longest still ${Math.round(w.still / 1000)}s`)
        for (const pl of Object.keys(other)) if (!w.plats.includes(pl)) why.push(`no ${pl} rows`)
        return why
      })
      if (swapKick) {
        await step('its kick leg is changed in the edit form by pasting a link', async () => {
          const why: string[] = []
          await menu(p, oid, EDIT)
          await p.fill('#hs-mc-messages input.hs-mc-ch-input[aria-label="kick"]', `https://kick.com/${swapKick}`)
          await p.click('#hs-mc-messages button', { text: '^save$' })
          await sleep(1500)
          const err = await formError(p)
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
      await step("the merged channel is removed, the stream's chat unbroken", async () => {
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
      const typed = () => p.evaluate(() => (document.querySelector('#hs-mc-messages input.hs-mc-ch-input[aria-label="twitch"]') as HTMLInputElement | null)?.value ?? null)
      const field = '#hs-mc-messages input.hs-mc-ch-input[aria-label="twitch"]'
      await p.click('.hs-mc-tab[data-tab="add"]')
      await p.fill(field, 'half_a_na')
      // what another tab (or another device) writes: a filter rule, then a saved channel
      const rules = await s.stored<string | null>('chat_filter_rules')
      await s.store({ chat_filter_rules: rules === '[]' ? '[ ]' : '[]' })
      await sleep(2500)
      if ((await typed()) !== 'half_a_na') why.push(`a rule changed elsewhere emptied the form (it reads ${JSON.stringify(await typed())})`)
      await p.fill(field, 'half_a_na').catch(() => {})
      await s.store({ heatsync_multichat: { channels: [...before, { id: twB, twitch: twB, kick: '', youtube: '' }] } })
      await sleep(3000)
      if ((await active(p)) !== 'add') why.push(`a channel saved elsewhere moved the panel to ${await active(p)}`)
      else if ((await typed()) !== 'half_a_na') why.push(`a channel saved elsewhere emptied the form (it reads ${JSON.stringify(await typed())})`)
      if (!(await tabs()).includes(twB)) why.push('the channel saved elsewhere got no tab')
      // and the settings pane stays put when that channel goes again
      await p.click('.hs-mc-tab[data-tab="settings"]')
      await sleep(800)
      await s.store({ heatsync_multichat: { channels: before } })
      await sleep(3000)
      if ((await active(p)) !== 'settings') why.push(`a channel removed elsewhere moved the panel off settings, to ${await active(p)}`)
      // put the rule back as it was (an unset rule is written as the empty list, which reads the same)
      await s.store({ chat_filter_rules: rules ?? '[]' })
      return why
    })
    const ring = await ringSince(p, t0)
    if (ring.bad.length) bad(`${label} overlay watchdogs fired`, ring.bad.slice(0, 6))
  }

  await round('twitch', `https://www.twitch.tv/${twA}`, `https://kick.com/${kk[0]}`, { twitch: twA }, { twitch: twB, kick: kk[1] }, kk[2])
  await round('kick', `https://kick.com/${kk[0]}`, `https://www.twitch.tv/${twA}`, { kick: kk[0] })
}

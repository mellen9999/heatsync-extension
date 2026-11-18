/**
 * s30's s18 leg: the panel's input typed into in firefox — Tab-complete, the picker, the local
 * slash commands — with the stream open in a second tab. The steps and checks are s18's.
 * Nothing is sent: Enter is pressed only on /commands that stay in this browser.
 */
import { bad, info, panel, ringSince, rowsFlow, sleep, ok } from './lib'
import { emoteOnScreen, inputText, NAME, type Plat, SETTLE_MS, screen, twoLive, url } from './s18-composer'
import { type Session, KEY, stepper, type Tab } from './s30-driver'

const chips = (p: Tab) => p.evaluate(() => [...document.querySelectorAll('#hs-mc-input img')].map((x) => (x as HTMLImageElement).dataset.emoteName || (x as HTMLImageElement).alt))
const toasts = (p: Tab) => p.evaluate(() => [...document.querySelectorAll('[class*="toast"]')].map((x) => (x.textContent || '').trim()).filter(Boolean))
const panelUp = async (t: Tab) => {
  for (let i = 0; i < 60; i++) {
    if (await t.evaluate(() => !!document.getElementById('hs-mc-container'))) return true
    await sleep(500)
  }
  return false
}

async function openPicker(p: Tab) {
  await p.click('#hs-mc-input')
  await p.click('#hs-mc-emote-btn')
  if (!(await p.has('#hs-mc-emote-picker.visible', 10_000))) throw new Error('the picker never opened')
}
async function closePicker(p: Tab) {
  await p.click('#hs-mc-emote-btn').catch(() => {})
  await sleep(300)
}
/** A third-party emote this channel has: drawn in chat, else the first the picker lists. */
async function channelEmote(p: Tab) {
  const drawn = await emoteOnScreen(p)
  if (drawn) return drawn
  await openPicker(p)
  await sleep(SETTLE_MS)
  const listed = await p.evaluate(() => {
    const hit = [...document.querySelectorAll('#hs-mc-emote-picker img.hs-mc-picker-emote')].find((x) => {
      const e = x as HTMLImageElement
      return /^[A-Za-z0-9_]{4,20}$/.test(e.dataset.name || '') && ['7tv', 'bttv', 'ffz'].includes(e.dataset.source || '')
    }) as HTMLImageElement | undefined
    return hit?.dataset.name || null
  })
  await closePicker(p)
  return listed
}

export async function composerLeg(s: Session, plat: Plat) {
  const two = await twoLive(plat)
  if (!two) return info(`skipped: two live ${plat} streams not found`)
  const [ch, other] = two
  const label = `firefox ${plat}:`
  const p = s.main
  const p2 = await s.newTab()
  const t0 = Date.now()
  for (const pg of [p, p2]) await pg.goto(url(plat, ch))
  for (const [pg, n] of [[p, 1], [p2, 2]] as const)
    if (!(await panelUp(pg)) || !(await rowsFlow(pg, 45_000))) return bad(`${label} page ${n}: chat never flowed on ${ch}`, await panel(pg))
  await sleep(15_000)

  const step = stepper(s, label, async (what) => {
    await p.shot(`s30-s18-${plat}-${what}`)
    return panel(p)
  })
  const key = (t: Tab, k: string) => t.keys('#hs-mc-input', k)

  // ── Tab-complete ──
  const emote = await channelEmote(p)
  if (!emote) bad(`${label} ${ch}: no 7tv/bttv/ffz emote on screen or in the picker`)
  else
    await step(`"${emote}" typed and Tab becomes that emote`, async () => {
      await p.type(emote)
      await key(p, KEY.tab)
      await sleep(SETTLE_MS)
      const [txt, c] = [await inputText(p), await chips(p)]
      info(`input after Tab: "${txt}", chips [${c.join(', ')}]`)
      await p.clearInput()
      return txt.toLowerCase() === emote.toLowerCase() && c.length === 1 ? [] : [`input reads "${txt}", chips [${c.join(', ')}]`]
    })

  const { by } = await screen(p, plat)
  const chatter = Object.keys(by).find((u) => u.replace(/^@/, '').length >= 6 && NAME.test(u))
  if (!chatter) info(`${ch}: no chatter on screen with a 6+ letter name`)
  else
    await step(`"@${chatter.replace(/^@/, '').slice(0, 4)}" and Tab gives a chatter's full name`, async () => {
      await p.type(`@${chatter.replace(/^@/, '').slice(0, 4)}`)
      await key(p, KEY.tab)
      await sleep(SETTLE_MS)
      const txt = await inputText(p)
      await p.clearInput()
      const name = txt.replace(/^@/, '').trim().toLowerCase()
      info(`input after Tab: "${txt}"`)
      if (!name.startsWith(chatter.replace(/^@/, '').slice(0, 4)) || !/^@/.test(txt)) return [`input reads "${txt}"`]
      if (!by[name] && !by[`@${name}`]) info(`"${name}" is a chatter no longer on screen`)
      return []
    })

  await step('"/lcl" and Tab gives "/lclear"', async () => {
    await p.type('/lcl')
    await key(p, KEY.tab)
    await sleep(SETTLE_MS)
    const txt = await inputText(p)
    await p.clearInput()
    return /^\/lclear\b/.test(txt) ? [] : [`input reads "${txt}"`]
  })

  // ── /hide is this tab only ──
  const hideWho = Object.entries((await screen(p, plat)).by)
    .filter(([u]) => NAME.test(u))
    .sort((a, b) => b[1] - a[1])[0]?.[0]
  if (hideWho) {
    const count = async (pg: Tab) => (await screen(pg, plat)).by[hideWho] || 0
    const before2 = await count(p2)
    await step(`/hide ${hideWho} on page 1: their rows are gone there, still on page 2`, async () => {
      await p.type(`/hide ${hideWho}`)
      await key(p, KEY.enter)
      await sleep(SETTLE_MS * 2)
      const [a, b] = [await count(p), await count(p2)]
      info(`${hideWho}: page 1 ${a} rows, page 2 ${b} rows (had ${before2})`)
      return [...(a ? [`page 1 still shows ${a} of their rows`] : []), ...(before2 && !b ? ['page 2 lost them too'] : [])]
    })
    await step(`/unhide ${hideWho} on page 1: their rows are back`, async () => {
      await p.type(`/unhide ${hideWho}`)
      await key(p, KEY.enter)
      await sleep(SETTLE_MS * 2)
      const a = await count(p)
      info(`${hideWho}: page 1 ${a} rows`)
      return a ? [] : ['none of their rows came back on page 1']
    })
  }

  // ── the picker, and its recents in both tabs ──
  if (emote) {
    const recents = (pg: Tab) =>
      pg.evaluate(() => [...document.querySelectorAll('#hs-mc-emote-picker [data-section-key="recent"] .hs-mc-picker-emote-wrap')].map((x) => (x as HTMLElement).dataset.name || ''))
    await step(`"${emote}" picked from the picker's search on page 1 lands in the input`, async () => {
      await p.clearInput()
      await openPicker(p)
      await p.fill('#hs-mc-emote-search', emote)
      await sleep(SETTLE_MS)
      await p.click(`#hs-mc-emote-picker .hs-mc-picker-emote[data-name="${emote}"]`)
      await sleep(SETTLE_MS)
      const c = await chips(p)
      await closePicker(p)
      await p.clearInput()
      return c.includes(emote) ? [] : [`input chips [${c.join(', ')}]`]
    })
    for (const [pg, n] of [[p, 1], [p2, 2]] as const)
      await step(`page ${n}'s picker lists "${emote}" first in recents`, async () => {
        await openPicker(pg)
        await sleep(SETTLE_MS)
        const r = await recents(pg)
        await closePicker(pg)
        info(`page ${n} recents: [${r.slice(0, 5).join(', ')}]`)
        return r[0] === emote ? [] : [`recents start [${r.slice(0, 3).join(', ')}]`]
      })
  } else info(`${ch}: no emote on screen to pick`)

  // ── /lclear ──
  const lclear = async (pg: Tab, where: string, again?: Tab) => {
    await step(`/lclear on ${where}: its rows are gone and stay gone, chat keeps coming`, async () => {
      const why: string[] = []
      // a stream whose rows are all the history it loaded with cannot prove "chat keeps coming"
      const k0 = new Set((await screen(pg, plat)).keys)
      await sleep(12_000)
      const old = new Set((await screen(pg, plat)).keys)
      const flowing = [...old].some((k) => !k0.has(k))
      const otherBefore = again ? (await screen(again, plat)).keys.length : 0
      await pg.type('/lclear')
      await key(pg, KEY.enter)
      await sleep(SETTLE_MS)
      const left = await inputText(pg)
      if (left) {
        why.push(`Enter on the whole command left "${left}" in the input, not run`)
        await key(pg, KEY.enter) // the second Enter a person would try
        await sleep(SETTLE_MS)
      }
      const said = await toasts(pg)
      const right = (await screen(pg, plat)).keys.filter((k) => old.has(k)).length
      info(`${where}: ${old.size} rows before, ${right} of them right after; toast [${said.join(' | ')}]`)
      if (right) why.push(`${right} of ${old.size} rows still there right after`)
      await sleep(15_000)
      let later = (await screen(pg, plat)).keys
      const back = later.filter((k) => old.has(k)).length
      if (back && !right) why.push(`${back} cleared rows came back`)
      // a slow chat can go 15s with nothing to say
      for (let i = 0; i < 9 && !later.length; i++) {
        await sleep(5000)
        later = (await screen(pg, plat)).keys
      }
      if (!later.length && flowing) why.push('no new chat in 60s')
      else if (!later.length) info(`${where}: no row in the 12s before /lclear either, too quiet to judge "chat keeps coming"`)
      if (again) {
        const o = (await screen(again, plat)).keys.length
        info(`the other page: ${otherBefore} rows before, ${o} after`)
        if (o < otherBefore / 2) why.push(`the other page lost its rows too (${otherBefore}→${o})`)
      }
      return why
    })
  }
  await lclear(p, `${ch}'s ${(await panel(p)).activeTab === 'live' ? 'live' : 'saved'} tab (page 1)`, p2)
  await p2.goto(url(plat, other))
  if (!(await panelUp(p2)) || !(await rowsFlow(p2, 45_000))) bad(`${label} page 2: chat never flowed on ${other}`, await panel(p2))
  else {
    await sleep(10_000)
    info(`page 2 on ${other}: the panel is on ${(await panel(p2)).activeTab}`)
    await lclear(p2, `${other}'s live tab (page 2)`)
  }
  // /hide, /lclear and their undo drop and rebuild rows in bulk: where a row index would drift
  const ring = await ringSince(p, t0)
  if (ring.bad.length) bad(`${label} overlay watchdogs fired`, ring.bad.slice(0, 6))
  else ok(`${label} the watchdog ring stayed quiet`)
}

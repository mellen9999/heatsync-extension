/**
 * s18 — the panel's input, typed into the way a person does: Tab-complete, the emote picker and
 * the local slash commands, with the stream open in a second tab. Nothing is ever sent: Enter
 * is only pressed on a slash command that stays in this browser, and the profile is signed out.
 *
 *   bun scripts/e2e/run.ts --only s18          (s18-twitch, s18-kick, s18-youtube)
 *
 * Two pages on one busy stream (a fresh install saves the first twitch/kick stream it opens as
 * a tab; youtube stays on the live tab), then page 2 on a second stream (the live tab):
 *   - an emote on screen, its name typed and Tab: becomes that emote
 *   - "@" and the start of a chatter on screen, Tab: a chatter's full name with that start
 *   - "/lcl" and Tab: "/lclear"
 *   - /hide a chatter on page 1: their rows gone there, still on page 2; /unhide: back
 *   - an emote picked from the picker's search on page 1: in the input, and first in the
 *     picker's recents on page 1 and on page 2
 *   - /lclear on page 1's tab: its rows gone, none of them back, new chat keeps coming, page 2
 *     untouched; and on the live tab of page 2's second channel the same
 *   - nothing threw on the page, the console, or the add-on's error log
 */
import { bad, extStorage, info, launch, liveChannels, liveYtVideo, ok, panel, rowsFlow, scenario, shot, sleep, waitPanel, watchErrors } from './lib'

const SETTLE_MS = 800

type Plat = 'twitch' | 'kick' | 'youtube'
const url = (plat: Plat, ch: string) =>
  plat === 'kick' ? `https://kick.com/${ch}` : plat === 'youtube' ? `https://www.youtube.com/watch?v=${ch}` : `https://www.twitch.tv/${ch}`
// a row's data-platform; youtube rows say yt
const rowPlat = (plat: Plat) => (plat === 'youtube' ? 'yt' : plat)
// a name /hide and Tab can take: one word (youtube handles carry @ . -)
const NAME = /^@?[a-z0-9_.-]+$/

/** Two live streams on the platform: channel logins, or youtube video ids. */
async function twoLive(plat: Plat): Promise<string[] | null> {
  if (plat !== 'youtube') return liveChannels(plat, 2)
  const a = await liveYtVideo()
  if (!a) return null
  const b = await liveYtVideo(['chillhopmusic', 'SpaceVideosHD', 'LofiGirl', 'lofigirl'].filter((h) => h.toLowerCase() !== a.handle.toLowerCase()))
  return b && b.id !== a.id ? [a.id, b.id] : null
}

/** The input as a person reads it: text, and each emote chip by its name. */
function inputText(p: any): Promise<string> {
  return p.evaluate(() => {
    const el = document.getElementById('hs-mc-input')
    if (!el) return ''
    let s = ''
    const walk = (n: Node) => {
      for (const c of n.childNodes as any) {
        if (c.nodeType === 3) s += c.textContent
        else if (c.tagName === 'IMG') s += ` ${c.dataset.emoteName || c.alt} `
        else if (c.tagName === 'BR') s += ' '
        else walk(c)
      }
    }
    walk(el)
    return s.replace(/\s+/g, ' ').trim()
  })
}

const chips = (p: any): Promise<string[]> =>
  p.$$eval('#hs-mc-input img', (e: HTMLImageElement[]) => e.map((x) => x.dataset.emoteName || x.alt))

async function type(p: any, text: string) {
  await p.click('#hs-mc-input', { timeout: 5000 })
  await p.keyboard.press('Control+A')
  await p.keyboard.press('Backspace')
  await p.keyboard.type(text, { delay: 30 })
}

async function clear(p: any) {
  await p.click('#hs-mc-input', { timeout: 5000 })
  await p.keyboard.press('Control+A')
  await p.keyboard.press('Backspace')
  await sleep(200)
}

const toasts = (p: any): Promise<string[]> =>
  p.$$eval('[class*="toast"]', (e: Element[]) => e.map((x) => (x.textContent || '').trim()).filter(Boolean))

/** Row keys on screen, and the authors of plain rows. */
function screen(p: any, plat: Plat) {
  return p.evaluate((plat: string) => {
    const keys: string[] = []
    const by: Record<string, number> = {}
    for (const r of document.querySelectorAll('#hs-mc-messages .hs-mc-msg') as any) {
      if (r.dataset.msgKey) keys.push(r.dataset.msgKey)
      // a mod notice ("x timed out") carries x's name but is not x's row: a hide leaves it
      if (r.classList.contains('hs-mc-system')) continue
      const a = r.querySelector('.hs-mc-user:not(.hs-mc-reply-user)') as HTMLElement | null
      const u = (a?.dataset.username || '').toLowerCase()
      if (u && u !== 'anonymous' && a?.dataset.platform === plat) by[u] = (by[u] || 0) + 1
    }
    return { keys, by }
  }, rowPlat(plat)) as Promise<{ keys: string[]; by: Record<string, number> }>
}

/** A third-party emote drawn in chat right now, with a plain name. */
function emoteOnScreen(p: any): Promise<string | null> {
  return p.evaluate(() => {
    const seen = new Map<string, number>()
    for (const i of document.querySelectorAll('#hs-mc-messages img.hs-mc-emote') as any) {
      const n = i.dataset.emoteName || ''
      if (!/^[A-Za-z0-9_]{4,20}$/.test(n) || !['7tv', 'bttv', 'ffz'].includes(i.dataset.source)) continue
      seen.set(n, (seen.get(n) || 0) + 1)
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null
  })
}

async function openPicker(p: any) {
  await p.click('#hs-mc-input', { timeout: 5000 })
  await p.click('#hs-mc-emote-btn', { timeout: 5000 })
  await p.waitForSelector('#hs-mc-emote-picker.visible', { timeout: 10_000 })
}
async function closePicker(p: any) {
  await p.click('#hs-mc-emote-btn', { timeout: 5000 }).catch(() => {})
  await sleep(300)
}

/** A third-party emote this channel has: drawn in chat, else the first the picker lists. */
async function channelEmote(p: any): Promise<string | null> {
  const drawn = await emoteOnScreen(p)
  if (drawn) return drawn
  await openPicker(p)
  await sleep(SETTLE_MS)
  const listed = await p.$$eval('#hs-mc-emote-picker img.hs-mc-picker-emote', (e: HTMLImageElement[]) => {
    const ok = e.find((x) => /^[A-Za-z0-9_]{4,20}$/.test(x.dataset.name || '') && ['7tv', 'bttv', 'ffz'].includes(x.dataset.source || ''))
    return ok?.dataset.name || null
  })
  await closePicker(p)
  return listed
}

async function s18Composer(plat: Plat) {
  scenario(`s18 the composer on ${plat}: tab-complete, picker, local slash commands, two tabs`)
  const two = await twoLive(plat)
  if (!two) return info(`skipped: two live ${plat} streams not found`)
  const [ch, other] = two
  const env = await launch()
  const errs: string[] = []
  const cons: string[] = []
  // @ts-ignore — extension page
  const hsErrors = async () => ((await extStorage(env, async () => (await chrome.storage.local.get('hs_errors')).hs_errors || [])) as unknown[]).length
  const listen = (pg: any, label: string) => {
    watchErrors(pg, label, errs)
    pg.on('console', (m: any) => {
      const text = String(m.text())
      if (m.type() === 'error' && /heatsync|Error in event handler/i.test(text)) cons.push(`${label}: ${text.slice(0, 160)}`)
    })
  }

  try {
    const p = await env.ctx.newPage()
    const p2 = await env.ctx.newPage()
    listen(p, 'page 1')
    listen(p2, 'page 2')
    for (const pg of [p, p2]) await pg.goto(url(plat, ch), { waitUntil: 'domcontentloaded' })
    for (const [pg, n] of [[p, 1], [p2, 2]] as const)
      if (!(await waitPanel(pg)) || !(await rowsFlow(pg, 45_000))) return bad(`page ${n}: chat never flowed on ${ch}`, await panel(pg))
    await sleep(15_000)

    let errBase = await hsErrors()
    const step = async (what: string, fn: () => Promise<string[]>, pages = [p, p2]) => {
      const pe = errs.length
      const ce = cons.length
      const why = await fn().catch((e) => [`threw: ${String(e?.message || e).slice(0, 200)}`])
      const nowErr = await hsErrors()
      if (errs.length > pe) why.push(`page error: ${errs.at(-1)?.slice(0, 140)}`)
      if (cons.length > ce) why.push(`console: ${cons.slice(ce, ce + 2).join(' | ')}`)
      if (nowErr > errBase) why.push(`${nowErr - errBase} add-on error(s)`)
      errBase = nowErr
      if (why.length) {
        bad(`${what}: ${why.join('; ')}`, await panel(pages[0]))
        for (const [i, pg] of pages.entries()) await shot(pg, `s18-${plat}-${what.replace(/\W+/g, '-').slice(0, 60)}-p${i + 1}`)
      } else ok(what)
    }

    // ── Tab-complete ──
    const emote = await channelEmote(p)
    if (!emote) bad(`${ch}: no 7tv/bttv/ffz emote on screen or in the picker`)
    else
      await step(`"${emote}" typed and Tab: becomes that emote`, async () => {
        await type(p, emote)
        await p.keyboard.press('Tab')
        await sleep(SETTLE_MS)
        const [txt, c] = [await inputText(p), await chips(p)]
        info(`input after Tab: "${txt}", chips [${c.join(', ')}]`)
        await clear(p)
        return txt.toLowerCase() === emote.toLowerCase() && c.length === 1 ? [] : [`input reads "${txt}", chips [${c.join(', ')}]`]
      })

    const { by } = await screen(p, plat)
    const chatter = Object.keys(by).find((u) => u.replace(/^@/, '').length >= 6 && NAME.test(u))
    if (!chatter) info(`${ch}: no chatter on screen with a 6+ letter name`)
    else
      await step(`"@${chatter.replace(/^@/, '').slice(0, 4)}" and Tab: a chatter's full name`, async () => {
        await type(p, `@${chatter.replace(/^@/, '').slice(0, 4)}`)
        await p.keyboard.press('Tab')
        await sleep(SETTLE_MS)
        const txt = await inputText(p)
        await clear(p)
        const name = txt.replace(/^@/, '').trim().toLowerCase()
        info(`input after Tab: "${txt}"`)
        // any chatter the panel has heard counts, not only the rows still drawn
        if (!name.startsWith(chatter.replace(/^@/, '').slice(0, 4)) || !/^@/.test(txt)) return [`input reads "${txt}"`]
        if (!by[name] && !by[`@${name}`]) info(`"${name}" is a chatter no longer on screen`)
        return []
      })

    await step('"/lcl" and Tab: "/lclear"', async () => {
      await type(p, '/lcl')
      await p.keyboard.press('Tab')
      await sleep(SETTLE_MS)
      const txt = await inputText(p)
      await clear(p)
      return /^\/lclear\b/.test(txt) ? [] : [`input reads "${txt}"`]
    })

    // ── /hide is this tab only ──
    const hideWho = Object.entries((await screen(p, plat)).by)
      .filter(([u]) => NAME.test(u))
      .sort((a, b) => b[1] - a[1])[0]?.[0]
    if (hideWho) {
      const count = async (pg: any) => (await screen(pg, plat)).by[hideWho] || 0
      const before2 = await count(p2)
      await step(`/hide ${hideWho} on page 1: gone there, still on page 2`, async () => {
        await type(p, `/hide ${hideWho}`)
        await p.keyboard.press('Enter')
        await sleep(SETTLE_MS * 2)
        const [a, b] = [await count(p), await count(p2)]
        info(`${hideWho}: page 1 ${a} rows, page 2 ${b} rows (had ${before2})`)
        // the rows left, by what they carry: which path drew them
        const left = a
          ? await p.evaluate((who: string) =>
              [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')]
                .filter((r) => !r.classList.contains('hs-mc-system'))
                .filter((r) => (r.querySelector('.hs-mc-user:not(.hs-mc-reply-user)') as HTMLElement | null)?.dataset.username?.toLowerCase() === who)
                .map((r) => ({ ...(r as HTMLElement).dataset, cls: r.className.slice(0, 80), t: (r.textContent || '').slice(0, 40) })),
            hideWho)
          : []
        return [
          ...(a ? [`page 1 still shows ${a} of their rows: ${JSON.stringify(left).slice(0, 900)}`] : []),
          ...(before2 && !b ? ['page 2 lost them too'] : []),
        ]
      })
      await step(`/unhide ${hideWho} on page 1: back`, async () => {
        await type(p, `/unhide ${hideWho}`)
        await p.keyboard.press('Enter')
        await sleep(SETTLE_MS * 2)
        const a = await count(p)
        info(`${hideWho}: page 1 ${a} rows`)
        return a ? [] : ['none of their rows came back on page 1']
      })
    }

    // ── the picker, and its recents in both tabs ──
    const pickable = emote
    if (pickable) {
      const recents = (pg: any): Promise<string[]> =>
        pg.$$eval('#hs-mc-emote-picker [data-section-key="recent"] .hs-mc-picker-emote-wrap', (e: HTMLElement[]) =>
          e.map((x) => x.dataset.name || ''),
        )
      await step(`"${pickable}" picked from the picker's search on page 1: in the input`, async () => {
        await clear(p)
        await openPicker(p)
        await p.fill('#hs-mc-emote-search', pickable)
        await sleep(SETTLE_MS)
        await p.click(`#hs-mc-emote-picker .hs-mc-picker-emote[data-name="${pickable}"]`, { timeout: 5000 })
        await sleep(SETTLE_MS)
        const c = await chips(p)
        await closePicker(p)
        await clear(p)
        return c.includes(pickable) ? [] : [`input chips [${c.join(', ')}]`]
      })
      for (const [pg, n] of [[p, 1], [p2, 2]] as const)
        await step(`page ${n}'s picker lists "${pickable}" first in recents`, async () => {
          await openPicker(pg)
          await sleep(SETTLE_MS)
          const r = await recents(pg)
          await closePicker(pg)
          info(`page ${n} recents: [${r.slice(0, 5).join(', ')}]`)
          return r[0] === pickable ? [] : [`recents start [${r.slice(0, 3).join(', ')}]`]
        }, [pg])
    } else info(`${ch}: no emote on screen to pick`)

    // ── /lclear ──
    const lclear = async (pg: any, where: string, other?: any) => {
      await step(`/lclear on ${where}: its rows gone and they stay gone, chat keeps coming`, async () => {
        const why: string[] = []
        const old = new Set((await screen(pg, plat)).keys)
        const otherBefore = other ? (await screen(other, plat)).keys.length : 0
        await type(pg, '/lclear')
        await pg.keyboard.press('Enter')
        await sleep(SETTLE_MS)
        const left = await inputText(pg)
        if (left) {
          why.push(`Enter on the whole command left "${left}" in the input, not run`)
          await pg.keyboard.press('Enter') // the second Enter a person would try
          await sleep(SETTLE_MS)
        }
        const said = await toasts(pg)
        const right = (await screen(pg, plat)).keys.filter((k) => old.has(k)).length
        info(`${where}: ${old.size} rows before, ${right} of them right after; toast [${said.join(' | ')}]`)
        if (right) why.push(`${right} of ${old.size} rows still there right after`)
        await sleep(15_000)
        const later = (await screen(pg, plat)).keys
        const back = later.filter((k) => old.has(k)).length
        if (back && !right) why.push(`${back} cleared rows came back`)
        if (!later.length) why.push('no new chat in 15s')
        if (other) {
          const o = (await screen(other, plat)).keys.length
          info(`the other page: ${otherBefore} rows before, ${o} after`)
          if (o < otherBefore / 2) why.push(`the other page lost its rows too (${otherBefore}→${o})`)
        }
        return why
      }, other ? [pg, other] : [pg])
    }
    // a fresh install saves the first twitch/kick stream it opens (that tab); youtube stays on live
    await lclear(p, `${ch}'s ${(await panel(p)).activeTab === 'live' ? 'live' : 'saved'} tab (page 1)`, p2)
    await p2.goto(url(plat, other), { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(p2)) || !(await rowsFlow(p2, 45_000))) bad(`page 2: chat never flowed on ${other}`, await panel(p2))
    else {
      await sleep(10_000)
      const tab = (await panel(p2)).activeTab
      info(`page 2 on ${other}: the panel is on ${tab}`)
      await lclear(p2, `${other}'s live tab (page 2)`)
    }
  } finally {
    await env.close()
  }
}

export const s18Twitch = () => s18Composer('twitch')
export const s18Kick = () => s18Composer('kick')
export const s18Youtube = () => s18Composer('youtube')

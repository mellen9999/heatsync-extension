/**
 * s30 — the panel scenarios in real Firefox: s12 (pop-outs), s16 (channels added and removed
 * from the + tab and the right-click menu), s17 (mute and block, two tabs), s18 (the composer:
 * Tab-complete, the picker, local slash commands, two tabs). The same invariants as their
 * chromium twins; firefox is the engine that has shown bugs chromium never did.
 *
 * Their oracles are reused (rows, pickChatter from s17; inputText, screen from s18; panel,
 * rowsFlow, dbg, ringSince from lib), read through each tab's `evaluate`. What a person does is
 * sent as real mouse and key events through webdriver (s30-driver.ts). Storage is read and
 * written through the add-on's own page, like s14. Two tabs means one is hidden: every look at
 * a tab brings it to the front first and lets it catch up, the way a person switching tabs does.
 *
 *   bun run build.js firefox --no-test && bun scripts/e2e/run.ts --only s30
 *   E2E_S30_LEGS=s16,s17  narrow the legs (default s12,s16,s17,s18)
 *   E2E_S30_PLATS=twitch,kick,youtube  s18's platforms (default twitch,kick)
 *   E2E_FF_EXT=<dir>  a firefox build other than dist/firefox
 *
 * Nothing is ever sent: the profile is signed out and Enter is pressed only on /commands that
 * stay in the browser. A page's own uncaught errors cannot be caught from outside in firefox:
 * "nothing threw" means firefox's console has no new add-on error and hs_errors gained nothing.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bad, info, liveChannels, liveYtVideo, ok, panel, ROOT, ringSince, rowsFlow, scenario, sleep } from './lib'
import { channelsLeg } from './s30-channels'
import { composerLeg } from './s30-composer'
import { KEY, type Session, startSession, stepper, type Tab } from './s30-driver'
import { pickChatter, rows } from './s17-mute-block'

const FF_EXT = process.env.E2E_FF_EXT || join(ROOT, 'dist', 'firefox')
const EN = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8'))
const L = (k: string) => EN[k].message as string
const FOLLOW_MS = 4000
const W = 400
const H = 600

const panelUp = async (t: Tab, ms = 30_000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await t.evaluate(() => !!document.getElementById('hs-mc-container'))) return true
    await sleep(500)
  }
  return false
}

/** s12: each platform's pop-out url in a pop-out sized window. */
async function popoutLeg(s: Session) {
  scenario('s30 firefox chat pop-outs')
  const [tw] = await liveChannels('twitch', 1)
  const [kk] = await liveChannels('kick', 1)
  const yt = await liveYtVideo()
  // headless firefox may not honour the size: the checks compare with the window's own inner size
  await s.ff.wd('POST', '/window/rect', { width: W, height: H }).catch((e) => info(`could not size the window: ${e.message}`))
  const outs = [
    ['twitch', `https://www.twitch.tv/popout/${tw}/chat?popout=`],
    ['kick', `https://kick.com/popout/${kk}/chat`],
    ...(yt ? [['youtube', `https://www.youtube.com/live_chat?v=${yt.id}&is_popout=1`]] : []),
  ]
  for (const [name, url] of outs) {
    const t = await s.newTab()
    const e0 = await s.addonErrors()
    const t0 = Date.now()
    await t.goto(url)
    if (!(await panelUp(t))) {
      bad(`firefox ${name} pop-out: panel never mounted`)
      await s.closeTab(t)
      continue
    }
    const flowing = await rowsFlow(t, 45_000)
    // kick's hydration finishes after the first rows: give a late #418 time to land
    await sleep(10_000)
    const st: any = await panel(t)
    const look = await t.evaluate(() => {
      const input = document.getElementById('hs-mc-inputbar')?.getBoundingClientRect()
      const native = [...document.querySelectorAll('.chat-scrollable-area__message-container, #chatroom-messages, yt-live-chat-item-list-renderer')].some(
        (e) => (e as HTMLElement).getClientRects().length && e.getBoundingClientRect().width > 50,
      )
      return { input: input ? Math.round(input.bottom) : -1, inputH: input ? Math.round(input.height) : 0, native, inner: [innerWidth, innerHeight] }
    })
    const ring = await ringSince(t, t0)
    info(`${name}: ${JSON.stringify({ box: st.box, rows: st.rows, ...look, ring: ring.counts })}`)
    const [x, y, w, h] = st.box || [0, 0, 0, 0]
    const [iw, ih] = look.inner
    if (x > 1 || y > 1 || w < iw - 2 || h < ih - 2) bad(`firefox ${name} pop-out: the panel does not fill the window`, { box: st.box, inner: look.inner })
    else if (!flowing) bad(`firefox ${name} pop-out: chat did not flow within 45s`, st)
    else if (look.inputH < 20 || look.input > ih + 1) bad(`firefox ${name} pop-out: the input bar is not on screen`, look)
    else if (look.native) bad(`firefox ${name} pop-out: the native chat shows beside the panel`)
    else ok(`firefox ${name} pop-out: fills the window, chat flows, input on screen`)
    // a react hydration error (kick's #418) shows in firefox's console, not to a script outside
    const hydr = (await s.ff.consoleMessages('Minified React error')).concat(await s.ff.consoleMessages('Hydration failed'))
    if (hydr.length) bad(`firefox ${name} pop-out: react hydration errors in the console`, hydr.slice(0, 3).map((m) => m.slice(0, 160)))
    if ((await s.addonErrors()) > e0) bad(`firefox ${name} pop-out: the add-on logged errors`, (await s.ff.addonErrors()).slice(e0, e0 + 3))
    if (ring.bad.length) bad(`firefox ${name} pop-out: overlay watchdogs fired`, ring.bad.slice(0, 6))
    await s.closeTab(t)
    await s.main.front()
  }
}

/** s17: a chatter muted and blocked from their name's right-click menu, the stream open in two tabs. */
async function muteBlockLeg(s: Session) {
  scenario('s30 firefox mute and block from the right-click menu, two tabs')
  const [ch] = await liveChannels('twitch', 1)
  const t0 = Date.now()
  const p = s.main
  const p2 = await s.newTab()
  for (const pg of [p, p2]) await pg.goto(`https://www.twitch.tv/${ch}`)
  for (const [pg, n] of [[p, 1], [p2, 2]] as const)
    if (!(await panelUp(pg)) || !(await rowsFlow(pg, 45_000))) return bad(`firefox twitch: page ${n}: chat never flowed on ${ch}`, await panel(pg))
  await sleep(15_000) // a few rows from the same people on both pages
  const who = await pickChatter(p, p2)
  if (!who) return bad(`firefox twitch: no chatter on screen in both pages of ${ch}`)
  info(`${ch}: acting on ${who}`)

  const step = stepper(s, 'firefox twitch:', async (what) => {
    await p.shot(`s30-s17-${what}-p1`)
    await p2.shot(`s30-s17-${what}-p2`)
    return { p1: await panel(p), p2: await panel(p2) }
  })
  // their newest name on screen, right-clicked, then the menu's item by its label
  const menu = async (pg: Tab, label: string) => {
    // a busy chat moves the name between reading its spot and pressing it, and the press can land on
    // another chatter's name: the menu says whose it is ("filter to <name>"), so a wrong one is shut and redone
    for (let i = 0; ; i++) {
      await pg.click(`#hs-mc-messages .hs-mc-msg .hs-mc-user:not(.hs-mc-reply-user)[data-username="${who}"]`, { last: true, right: true })
      await sleep(150)
      const mine = await pg.evaluate((w: string) => [...document.querySelectorAll('[role="menuitem"] .hs-mc-em-label')].some((e) => (e.textContent || '').toLowerCase() === `filter to ${w}`), who)
      if (mine) break
      if (i >= 5) throw new Error('the right-click kept landing on another chatter')
      await pg.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    }
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    await pg.click('[role="menuitem"] .hs-mc-em-label', { text: `^${esc}$` })
    await sleep(FOLLOW_MS)
  }
  const saved = async (key: 'muted_users' | 'blocked_users') => {
    const v = ((await s.stored<unknown[]>(key)) || []) as any[]
    return v.some((e) => String(e?.username ?? e).toLowerCase().replace(/^twitch:/, '') === who)
  }
  const both = async (check: (r: Awaited<ReturnType<typeof rows>>, n: number) => string[]) => {
    const why: string[] = []
    for (const [pg, n] of [[p, 1], [p2, 2]] as const) {
      const r = await rows(pg, who)
      info(`page ${n}: ${who} has ${r.theirs} rows (${r.mutedTheirs} blanked), ${r.mutedOthers.length} others blanked, ${r.replies} replies on screen`)
      why.push(...check(r, n))
    }
    return why
  }

  await step(`${who} muted on page 1: blanked on both pages, no one else`, async () => {
    await menu(p, L('mc_input_mute_24h'))
    const why = await both((r, n) => [
      ...(r.theirs && r.mutedTheirs < r.theirs ? [`page ${n}: ${r.theirs - r.mutedTheirs} of their rows still readable`] : []),
      ...(r.mutedOthers.length ? [`page ${n}: others blanked: ${[...new Set(r.mutedOthers)].slice(0, 4).join(', ')}`] : []),
    ])
    if (!(await saved('muted_users'))) why.push('the mute was not saved')
    return why
  })
  await step(`${who} unmuted on page 2: readable on both pages`, async () => {
    await menu(p2, L('mc_settings_unmute'))
    const why = await both((r, n) => [
      ...(r.mutedTheirs ? [`page ${n}: ${r.mutedTheirs} of their rows still blank`] : []),
      ...(r.mutedOthers.length ? [`page ${n}: others blank: ${[...new Set(r.mutedOthers)].slice(0, 4).join(', ')}`] : []),
    ])
    if (await saved('muted_users')) why.push('the mute is still saved')
    return why
  })

  const before = { 1: (await rows(p, who)).theirs, 2: (await rows(p2, who)).theirs } as Record<number, number>
  // The row above their newest one. A busy chat pushes their rows out of the list while they are
  // blocked, and rows that are gone cannot come back: while this older neighbour is still drawn,
  // theirs would be too.
  const above = (pg: Tab) =>
    pg.evaluate((w: string) => {
      const mine = [...document.querySelectorAll(`#hs-mc-messages .hs-mc-msg .hs-mc-user:not(.hs-mc-reply-user)[data-username="${w}"]`)].at(-1)?.closest('.hs-mc-msg')
      let r = (mine?.previousElementSibling || null) as HTMLElement | null
      while (r && !r.dataset?.msgKey) r = r.previousElementSibling as HTMLElement | null
      return r?.dataset.msgKey || null
    }, who)
  const near = { 1: await above(p), 2: await above(p2) } as Record<number, string | null>
  const drawn = (pg: Tab, key: string | null) =>
    key ? pg.evaluate((k: string) => [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].some((r) => (r as HTMLElement).dataset.msgKey === k), key) : Promise.resolve(false)
  await step(`${who} blocked on page 1: gone from both pages`, async () => {
    await menu(p, L('content_card_block'))
    const why = await both((r, n) => (r.theirs ? [`page ${n}: ${r.theirs} of their rows still on screen`] : []))
    if (!(await saved('blocked_users'))) why.push('the block was not saved (a heatsync account block lives on the server: see the info lines)')
    return why
  })
  // the rows a reload draws come from saved history, built from nothing: the block has to be asked there too
  await step(`${who} blocked: a reload of page 2 does not bring their rows back`, async () => {
    await p2.goto(`https://www.twitch.tv/${ch}`)
    if (!(await panelUp(p2)) || !(await rowsFlow(p2, 45_000))) return ['chat never came back after the reload']
    await sleep(4000)
    const r = await rows(p2, who)
    return r.theirs ? [`${r.theirs} of their rows are back on screen`] : []
  })
  // their rows are gone, so there is no name left to right-click: /block toggles it back
  await step(`${who} unblocked on page 2 with /block: back on both pages`, async () => {
    await p2.keys('#hs-mc-input', `/block ${who}${KEY.enter}`)
    await sleep(FOLLOW_MS)
    const inList = { 1: await drawn(p, near[1]), 2: await drawn(p2, near[2]) } as Record<number, boolean>
    const why = await both((r, n) => {
      if (!before[n] || r.theirs) return []
      if (inList[n]) return [`page ${n}: none of their ${before[n]} rows came back`]
      info(`page ${n}: their ${before[n]} rows had left the list by the time the block was lifted: nothing to come back`)
      return []
    })
    if (await saved('blocked_users')) why.push('the block is still saved')
    return why
  })

  if (!(await rowsFlow(p, 20_000)) || !(await rowsFlow(p2, 20_000))) bad(`firefox twitch: ${ch}: chat stopped after the mute and block`)
  else ok(`firefox twitch: ${ch}: chat flows after the mute and block`)
  const ring = await ringSince(p, t0)
  if (ring.bad.length) bad(`firefox twitch: ${ch}: overlay watchdogs fired`, ring.bad.slice(0, 6))
  else ok(`firefox twitch: ${ch}: the watchdog ring stayed quiet`)
}

export async function s30FirefoxPanel() {
  if (!existsSync(join(FF_EXT, 'manifest.json'))) return bad(`no firefox build at ${FF_EXT}`)
  const legs = (process.env.E2E_S30_LEGS || 's12,s16,s17,s18').split(',').filter(Boolean)
  const plats = (process.env.E2E_S30_PLATS || 'twitch,kick').split(',').filter(Boolean) as ('twitch' | 'kick' | 'youtube')[]
  // each leg gets a fresh firefox and profile: a fresh install is what saves the first stream's tab
  const run = async (name: string, fn: (s: Session) => Promise<unknown>) => {
    if (!legs.includes(name)) return
    const s = await startSession(FF_EXT)
    try {
      info(`${name}: firefox ${s.ff.version}`)
      await fn(s)
    } finally {
      await s.close()
    }
  }
  await run('s12', popoutLeg)
  await run('s16', async (s) => {
    scenario('s30 firefox channels added and removed from the panel')
    const [twA, twB] = await liveChannels('twitch', 2)
    const kk = await liveChannels('kick', 3)
    await channelsLeg(s, twA, twB, kk as [string, string, string])
  })
  await run('s17', muteBlockLeg)
  for (const plat of plats) {
    await run('s18', async (s) => {
      scenario(`s30 firefox the composer on ${plat}: tab-complete, picker, local slash commands, two tabs`)
      await composerLeg(s, plat)
    })
  }
  if (legs.includes('s18') && !plats.includes('youtube')) info('s18 youtube not driven: opt in with E2E_S30_PLATS=twitch,kick,youtube (its chat is slow, the run long)')
}

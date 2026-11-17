/**
 * s17 — a chatter muted and blocked from their name's right-click menu, with the same stream
 * open in a second tab. Mute and block live in the background and reach the other tab as a
 * message, not a reload; both tabs have to follow at once.
 *
 *   bun scripts/e2e/run.ts --only s17
 *
 * Two pages on one busy twitch channel. A chatter on screen in both:
 *   - muted from page 1: every row of theirs blanked on both pages, no one else's row touched
 *     (a reply to them included), the mute saved
 *   - unmuted from page 2: their rows readable again on both pages, the mute gone
 *   - blocked from page 1: their rows gone from both pages, the block saved
 *   - unblocked from page 2 by typing /block (no row of theirs is left to right-click): back
 *     on both pages, the block gone
 *   - chat kept flowing; nothing threw on the page, the console, or the add-on's error log
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bad, extStorage, info, launch, liveChannels, ok, panel, ROOT, rowsFlow, scenario, shot, sleep, waitPanel, watchErrors } from './lib'

const EN = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8'))
const L = (k: string) => EN[k].message as string
const FOLLOW_MS = 4000

type Rows = { theirs: number; mutedTheirs: number; mutedOthers: string[]; replies: number }

/** The pane's rows, by author (never the reply bar's @name). */
function rows(p: any, who: string): Promise<Rows> {
  return p.evaluate((who: string) => {
    const out = { theirs: 0, mutedTheirs: 0, mutedOthers: [] as string[], replies: 0 }
    for (const r of document.querySelectorAll('#hs-mc-messages .hs-mc-msg')) {
      const a = r.querySelector('.hs-mc-user:not(.hs-mc-reply-user)') as HTMLElement | null
      if (!a) continue
      const u = (a.dataset.username || '').toLowerCase()
      const muted = r.classList.contains('hs-mc-muted')
      if (r.querySelector('.hs-mc-reply-user')) out.replies++
      if (u === who) {
        out.theirs++
        if (muted) out.mutedTheirs++
      } else if (muted) out.mutedOthers.push(u)
    }
    return out
  }, who)
}

/** An author with a few plain rows on screen in both pages, newest first. */
async function pickChatter(p: any, p2: any) {
  const counts = (pg: any) =>
    pg.evaluate(() => {
      const m: Record<string, number> = {}
      for (const r of document.querySelectorAll('#hs-mc-messages .hs-mc-msg:not(.hs-mc-muted)')) {
        const a = r.querySelector('.hs-mc-user:not(.hs-mc-reply-user)') as HTMLElement | null
        const u = (a?.dataset.username || '').toLowerCase()
        if (u && u !== 'anonymous' && a?.dataset.platform === 'twitch') m[u] = (m[u] || 0) + 1
      }
      return m
    }) as Promise<Record<string, number>>
  const [a, b] = [await counts(p), await counts(p2)]
  return Object.keys(a)
    .filter((u) => b[u])
    .sort((x, y) => a[y] + b[y] - (a[x] + b[x]))[0]
}

export async function s17MuteBlock() {
  scenario('s17 mute and block from the right-click menu, two tabs')
  const [ch] = await liveChannels('twitch', 1)
  const env = await launch()
  const errs: string[] = []
  const cons: string[] = []
  // @ts-ignore — extension page
  const stored = async () => (await extStorage(env, async () => chrome.storage.local.get(['muted_users', 'blocked_users', 'hs_errors']))) as any
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
    for (const pg of [p, p2]) await pg.goto(`https://www.twitch.tv/${ch}`, { waitUntil: 'domcontentloaded' })
    for (const [pg, n] of [[p, 1], [p2, 2]] as const)
      if (!(await waitPanel(pg)) || !(await rowsFlow(pg, 45_000))) return bad(`page ${n}: chat never flowed on ${ch}`, await panel(pg))
    await sleep(15_000) // a few rows from the same people on both pages

    const who = await pickChatter(p, p2)
    if (!who) return bad(`no chatter on screen in both pages of ${ch}`)
    info(`${ch}: acting on ${who}`)

    let errBase = ((await stored()).hs_errors || []).length
    const step = async (what: string, fn: () => Promise<string[]>) => {
      const pe = errs.length
      const ce = cons.length
      const why = await fn().catch((e) => [`threw: ${String(e?.message || e).slice(0, 200)}`])
      const nowErr = ((await stored()).hs_errors || []).length
      if (errs.length > pe) why.push(`page error: ${errs.at(-1)?.slice(0, 140)}`)
      if (cons.length > ce) why.push(`console: ${cons.slice(ce, ce + 2).join(' | ')}`)
      if (nowErr > errBase) why.push(`${nowErr - errBase} add-on error(s)`)
      errBase = nowErr
      if (why.length) {
        bad(`${what}: ${why.join('; ')}`, { p1: await panel(p), p2: await panel(p2) })
        await shot(p, `s17-${what.replace(/\W+/g, '-')}-p1`)
        await shot(p2, `s17-${what.replace(/\W+/g, '-')}-p2`)
      } else ok(what)
    }
    // their newest name on screen, right-clicked, then the menu's item by its label
    const menu = async (pg: any, label: string) => {
      const name = pg.locator(`#hs-mc-messages .hs-mc-msg .hs-mc-user:not(.hs-mc-reply-user)[data-username="${who}"]`).last()
      await name.scrollIntoViewIfNeeded({ timeout: 5000 })
      await name.click({ button: 'right', timeout: 5000 })
      const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      await pg.locator('[role="menuitem"] .hs-mc-em-label', { hasText: new RegExp(`^${esc}$`) }).first().click({ timeout: 5000 })
      await sleep(FOLLOW_MS)
    }
    const saved = async (key: 'muted_users' | 'blocked_users') => {
      const v = (await stored())[key] || []
      return (v as any[]).some((e) => String(e?.username ?? e).toLowerCase().replace(/^twitch:/, '') === who)
    }
    const both = async (check: (r: Rows, n: number) => string[]) => {
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
    await step(`${who} blocked on page 1: gone from both pages`, async () => {
      await menu(p, L('content_card_block'))
      const why = await both((r, n) => (r.theirs ? [`page ${n}: ${r.theirs} of their rows still on screen`] : []))
      if (!(await saved('blocked_users'))) why.push('the block was not saved (a heatsync account block lives on the server: see the info lines)')
      return why
    })
    // their rows are gone, so there is no name left to right-click: /block toggles it back
    await step(`${who} unblocked on page 2 with /block: back on both pages`, async () => {
      await p2.click('#hs-mc-input', { timeout: 5000 })
      await p2.keyboard.type(`/block ${who}`)
      await p2.keyboard.press('Enter')
      await sleep(FOLLOW_MS)
      const why = await both((r, n) => (before[n] && !r.theirs ? [`page ${n}: none of their ${before[n]} rows came back`] : []))
      if (await saved('blocked_users')) why.push('the block is still saved')
      return why
    })

    if (!(await rowsFlow(p, 20_000)) || !(await rowsFlow(p2, 20_000))) bad(`${ch}: chat stopped after the mute and block`)
    else ok(`${ch}: chat flows after the mute and block`)
  } finally {
    await env.close()
  }
}

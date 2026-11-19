/**
 * s23 — what a reader does to a chat row, on twitch, kick and youtube, signed out.
 *
 *   bun scripts/e2e/run.ts --only s23
 *
 * Nothing is ever sent and nothing is written to a server: only local items are used (copy,
 * hide in tab, hover). On a busy live channel of each site:
 *   - right-click a row and a name: the menu opens inside the window with the items the code
 *     offers that platform to a signed-out viewer (no mod items), Escape and a click outside
 *     close it, a second right-click replaces it (never two), a wheel over the chat leaves it
 *   - a name's left click takes the pane with the profile card (name, platform, no raw keys,
 *     no broken picture); open 9s once, closed by Escape and by the ← back tab, five times:
 *     rows are back at once, at the tail and following, composer and 2nd row back, nothing the
 *     buffer got meanwhile missing, the watchdog ring quiet
 *   - "chat logs" from the menu: rows (or the empty line) draw, older rows load or run out,
 *     Escape and ← back return to chat
 *   - a reply row's pill opens the thread stack with the parent, Escape closes it
 *   - hover: an emote, a badge, a link each show a tooltip inside the window and lose it again
 *   - hide in tab takes a chatter's rows out, /unhide puts them back; copy message and copy
 *     name reach the clipboard
 *   - nothing threw on the page, the console or the add-on's error log
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BAD_RING,
  bad,
  dbg,
  extStorage,
  info,
  launch,
  liveChannels,
  liveYtVideo,
  ok,
  panel,
  ringSince,
  ROOT,
  rowsFlow,
  scenario,
  shot,
  sleep,
  waitPanel,
  watchErrors, tailFollows,
} from './lib'

const EN = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8'))
const L = (k: string) => String(EN[k].message)
const RAW_KEY = /\b(?:mc|content|common|card)_[a-z0-9_]{3,}\b/
const EMPTY_WORD = /\b(?:undefined|null|NaN)\b/
const MENU_MS = 700
const CARD_HOLD_MS = 9000
const BACK_BUDGET_MS = 500

type Hit = { x: number; y: number; user: string; platform: string; key: string; text: string }
type Look = { count: number; header: string; items: string[]; rect: number[]; vw: number; vh: number }

// ── in the page ──────────────────────────────────────────────────────────────

/** Remember what every right and left click landed on, whatever moved under the pointer since. */
const recordClicks = (p: any) =>
  p.evaluate(() => {
    const w = window as any
    if (w.__s23) return
    w.__s23 = { ctx: null, click: null, trail: [] as string[] }
    // what the page saw around a menu: the inputs that could close one, and the menu coming and going
    const note = (what: string) => {
      const tr = w.__s23.trail as string[]
      tr.push(`${Math.round(performance.now())}ms ${what}`)
      if (tr.length > 14) tr.shift()
    }
    for (const type of ['mousedown', 'contextmenu', 'keydown']) {
      window.addEventListener(type, (e) => note(`${type}${(e as KeyboardEvent).key ? ` ${(e as KeyboardEvent).key}` : ''} on ${((e.target as HTMLElement)?.className || (e.target as HTMLElement)?.tagName || '').toString().slice(0, 30)}`), true)
    }
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) if ((n as HTMLElement).classList?.contains('hs-mc-ctx')) note('menu added')
        for (const n of m.removedNodes) if ((n as HTMLElement).classList?.contains('hs-mc-ctx')) note('menu removed')
      }
    }).observe(document.body, { childList: true })
    window.addEventListener(
      'click',
      (e) => {
        const u = (e.target as HTMLElement).closest?.('.hs-mc-user') as HTMLElement | null
        if (u) w.__s23.click = { user: (u.dataset.username || '').replace(/^@/, '').toLowerCase(), platform: u.dataset.platform || '' }
      },
      true,
    )
    window.addEventListener(
      'contextmenu',
      (e) => {
        const t = e.target as HTMLElement
        const said = (n: Node | null | undefined): string => {
          if (!n) return ''
          if (n.nodeType === 3) return n.textContent || ''
          if ((n as Element).tagName === 'IMG') return ` ${(n as HTMLImageElement).alt} `
          return [...n.childNodes].map(said).join('')
        }
        const u = t.closest?.('.hs-mc-user') as HTMLElement | null
        const row = t.closest?.('.hs-mc-msg') as HTMLElement | null
        const a = (u || row?.querySelector('.hs-mc-user:not(.hs-mc-reply-user)')) as HTMLElement | null
        w.__s23.ctx = {
          user: (a?.dataset.username || a?.textContent || '').replace(/^@/, '').trim().toLowerCase(),
          key: row?.dataset.msgKey || '',
          platform: row?.dataset.msgPlatform || '',
          // as a reader sees it: a picture reads as its name (a word can turn into its emote
          // between aiming at a plain row and the click landing, twitch 11-18)
          text: said(row?.querySelector('.hs-mc-text')).replace(/\s+/g, ' ').trim(),
        }
      },
      true,
    )
  })

type Kind = 'row' | 'name' | 'plain-row' | 'reply' | 'emote' | 'badge' | 'link' | 'chatter'
/** A spot worth clicking or hovering: fully inside the list, away from the newest rows, checked to hit what it claims. */
const aim = (p: any, kind: Kind, notUser = '', skip = 0): Promise<(Hit & { label: string }) | null> =>
  p.evaluate(
    ([kind, notUser, skip]: [Kind, string, number]) => {
      let toSkip = skip
      const list = document.getElementById('hs-mc-messages') as HTMLElement | null
      if (!list) return null
      const box = list.getBoundingClientRect()
      const rows = [...list.querySelectorAll('.hs-mc-msg[data-msg-key]')] as HTMLElement[]
      const inside = (r: DOMRect) => r.top > box.top + 24 && r.bottom < box.bottom - 24 && r.width > 4 && r.height > 4
      const cands = rows.slice(0, Math.max(0, rows.length - 3)).reverse()
      for (const row of cands) {
        if (row.classList.contains('hs-mc-muted') || row.dataset.msgSelf) continue
        const a = row.querySelector('.hs-mc-user:not(.hs-mc-reply-user)') as HTMLElement | null
        const user = (a?.dataset.username || '').replace(/^@/, '').toLowerCase()
        if (!a || !user || user === 'anonymous' || user === notUser) continue
        const rb = row.getBoundingClientRect()
        if (!inside(rb)) continue
        let el: HTMLElement | null = null
        let x = 0
        let y = 0
        let label = ''
        if (kind === 'row' || kind === 'plain-row') {
          if (kind === 'plain-row') {
            const tx = row.querySelector('.hs-mc-text') as HTMLElement | null
            if (!tx || tx.querySelector('img') || row.querySelector('.hs-mc-reply-ctx') || !tx.textContent?.trim()) continue
          }
          el = row
          // a bare spot of the row: no link, picture, name or button under it (the » thread button would start a quote)
          let found = false
          for (const f of [0.5, 0.7, 0.3, 0.85, 0.15]) {
            const px = rb.left + rb.width * f
            const py = rb.top + rb.height / 2
            const at = document.elementFromPoint(px, py)
            if (at && at.closest('.hs-mc-msg') === row && !at.closest('a, img, button, .hs-mc-user, .hs-mc-emote-wrapper, .hs-mc-emoji, .hs-mc-link, .hs-mc-reply-ctx')) {
              x = px
              y = py
              found = true
              break
            }
          }
          if (!found) continue
        } else if (kind === 'name' || kind === 'chatter') {
          el = a
        } else if (kind === 'reply') {
          const pill = row.querySelector('.hs-mc-reply-ctx[role="button"]') as HTMLElement | null
          if (!pill || !row.dataset.replyId) continue
          const sn = pill.querySelector('.hs-mc-reply-snippet') as HTMLElement | null
          el = sn || pill
          label = (pill.querySelector('a') as HTMLElement | null)?.dataset.username || ''
        } else if (kind === 'emote') {
          const im = row.querySelector('.hs-mc-emote-wrapper:not(.hs-mc-emote-cw) img.hs-mc-emote') as HTMLElement | null
          el = im
          label = im?.closest<HTMLElement>('.hs-mc-emote-wrapper')?.dataset.emoteName || ''
        } else if (kind === 'badge') {
          const im = row.querySelector('img.hs-mc-badge-img') as HTMLImageElement | null
          el = im
          label = im?.title || im?.alt || ''
        } else if (kind === 'link') {
          el = row.querySelector('a.hs-mc-link') as HTMLElement | null
          label = (el as HTMLAnchorElement | null)?.hostname || ''
        }
        if (!el) continue
        if (kind === 'reply' && toSkip-- > 0) continue
        if (kind !== 'row' && kind !== 'plain-row') {
          const r = el.getBoundingClientRect()
          if (!inside(r)) continue
          x = r.left + r.width / 2
          y = r.top + r.height / 2
        }
        const at = document.elementFromPoint(x, y)
        const hit =
          kind === 'row' || kind === 'plain-row'
            ? at?.closest('.hs-mc-msg') === row
            : !!at && (el.contains(at) || (kind === 'emote' && at.closest('.hs-mc-emote-wrapper') === el.closest('.hs-mc-emote-wrapper')))
        if (!hit) continue
        const text = (row.querySelector('.hs-mc-text')?.textContent || '').replace(/\s+/g, ' ').trim()
        return { x, y, user, platform: a.dataset.platform || '', key: row.dataset.msgKey || '', text, label }
      }
      return null
    },
    [kind, notUser, skip],
  )

/** A spot in the list that holds nothing: the pointer rests here and the feed is free to slide. */
async function rest(p: any) {
  const b = await p.evaluate(() => {
    const r = document.getElementById('hs-mc-messages')?.getBoundingClientRect()
    return r ? { x: r.right - 22, y: r.top + r.height / 2 } : null
  })
  if (b) await p.mouse.move(b.x, b.y)
}

/** The ring's findings minus a render_stall logged while the profile card held the pane: drawing waits on purpose then. */
const ringBad = (bad: any[]) => bad.filter((e) => !(e.e === 'render_stall' && e.card))

const menuLook = (p: any): Promise<Look> =>
  p.evaluate(() => {
    const ms = [...document.querySelectorAll('.hs-mc-ctx')] as HTMLElement[]
    const m = ms[0]
    const r = m?.getBoundingClientRect()
    return {
      count: ms.length,
      header: (m?.querySelector('.hs-mc-em-header')?.textContent || '').trim(),
      items: [...(m?.querySelectorAll('[role="menuitem"] .hs-mc-em-label') || [])].map((e) => (e.textContent || '').trim()),
      rect: r ? [r.left, r.top, r.right, r.bottom].map(Math.round) : [],
      vw: innerWidth,
      vh: innerHeight,
    }
  })

type Pane = {
  rows: number
  atTail: boolean
  pill: boolean
  pillText: string
  newestAgeS: number | null
  newestKey: string
  composer: boolean
  subCells: number
  fillOn: boolean
  fresh: number
}
/** `known`: the row keys seen earlier; `fresh` counts the rows whose key is not among them. */
const paneNow = (p: any, known: string[] = []): Promise<Pane> =>
  p.evaluate((known: string[]) => {
    const list = document.getElementById('hs-mc-messages') as HTMLElement
    const rows = [...list.querySelectorAll('.hs-mc-msg[data-msg-key]')] as HTMLElement[]
    const pill = document.getElementById('hs-mc-new-msgs') as HTMLElement | null
    const bar = document.getElementById('hs-mc-inputbar') as HTMLElement | null
    const sub = document.getElementById('hs-mc-subrow') as HTMLElement | null
    const seen = new Set(known)
    const last = rows.at(-1)
    const ts = rows.slice(-5).map((r) => Number(r.dataset.msgTime || 0)).filter(Boolean)
    const t = ts.length ? Math.max(...ts) : 0
    return {
      rows: list.offsetHeight ? rows.length : 0,
      atTail: list.scrollHeight - list.scrollTop - list.clientHeight <= 24, // a row or so: a fast chat adds one before the pin lands
      pill: !!pill && (() => {
        const cs = getComputedStyle(pill)
        const r = pill.getBoundingClientRect()
        return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && r.width > 0 && r.height > 0
      })(),
      pillText: (pill?.textContent || '').trim(),
      newestAgeS: t ? Math.round((Date.now() - t) / 1000) : null,
      newestKey: last?.dataset.msgKey || '',
      composer: !!bar && !bar.classList.contains('hs-hidden') && bar.offsetHeight > 0,
      subCells: sub && !sub.hidden ? sub.children.length : 0,
      fillOn: document.documentElement.classList.contains('hs-mc-fill-on'),
      fresh: known.length ? rows.filter((r) => !seen.has(r.dataset.msgKey || '')).length : 0,
    }
  }, known)

/** Count rows from the instant a close key or press lands: when the pane first shows enough rows, and when it is at the tail. */
const armClose = (p: any, thr: number) =>
  p.evaluate((thr: number) => {
    const st = { t0: 0, rowsAt: -1, tailAt: -1, at: {} as Record<number, number> }
    ;(window as any).__s23close = st
    const arm = () => {
      if (st.t0) return
      st.t0 = performance.now()
      const loop = () => {
        const list = document.getElementById('hs-mc-messages') as HTMLElement
        const n = list.offsetHeight ? list.querySelectorAll('.hs-mc-msg[data-msg-key]').length : 0
        const dt = performance.now() - st.t0
        if (st.rowsAt < 0 && n >= thr) st.rowsAt = Math.round(dt)
        if (st.tailAt < 0 && n >= thr && list.scrollHeight - list.scrollTop - list.clientHeight <= 3) st.tailAt = Math.round(dt)
        for (const s of [50, 150, 300, 500, 1000]) if (st.at[s] === undefined && dt >= s) st.at[s] = n
        if (dt < 3000) requestAnimationFrame(loop)
      }
      loop()
    }
    document.addEventListener('keydown', (e) => e.key === 'Escape' && arm(), { capture: true, once: true })
    document.addEventListener('pointerdown', arm, { capture: true, once: true })
  }, thr)
const readClose = (p: any): Promise<{ rowsAt: number; tailAt: number; at: Record<number, number> }> =>
  p.evaluate(() => (window as any).__s23close)

/** What the buffer holds for the page's own channel (twitch and kick only: youtube's are not in the probe; other tabs' buffers keep filling and must not count). */
async function bufferCount(p: any, channel: string) {
  const d = await dbg(p)
  return (d.irc?.[channel]?.count || 0) + (d.kick?.[channel]?.count || 0)
}

// ── one site ─────────────────────────────────────────────────────────────────

async function site(env: any, name: string, url: string, errs: string[], second?: string) {
  const cons: string[] = []
  const p = await env.ctx.newPage()
  watchErrors(p, name, errs)
  p.on('console', (m: any) => {
    const text = String(m.text())
    // youtube's own flood: it names whatever url a page loads, ours included (checked in lib.ts)
    if (m.type() === 'error' && !/^Unsafe attempt to load URL/.test(text) && /heatsync|Error in event handler/i.test(text)) cons.push(`${name}: ${text.slice(0, 160)}`)
  })
  const chan = name === 'youtube' ? '' : (url.split('/').pop() || '').toLowerCase()
  const t0 = Date.now()
  await p.goto(url, { waitUntil: 'domcontentloaded' })
  if (!(await waitPanel(p)) || !(await rowsFlow(p, 45_000))) {
    bad(`${name}: chat never flowed`, await panel(p))
    return p.close()
  }
  await sleep(12_000) // a screenful of rows to act on
  await recordClicks(p)
  // @ts-ignore — extension page
  const errLog = async () => ((await extStorage(env, async () => chrome.storage.local.get('hs_errors'))) as any).hs_errors || []
  let errBase = (await errLog()).length

  const step = async (what: string, fn: () => Promise<string[] | null>, detail?: () => Promise<unknown>) => {
    const pe = errs.length
    const ce = cons.length
    await p.bringToFront()
    const out = await fn().catch((e) => [`threw: ${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 500)}`])
    if (!out) return info(`${name}: ${what}: not covered here`)
    const why = out
    const now = (await errLog()).length
    if (errs.length > pe) why.push(`page error: ${errs.at(-1)?.slice(0, 160)}`)
    if (cons.length > ce) why.push(`console: ${cons.slice(ce, ce + 2).join(' | ')}`)
    if (now > errBase) why.push(`${now - errBase} add-on error(s)`)
    errBase = now
    if (why.length) {
      bad(`${name}: ${what}: ${why.join('; ')}`, detail ? await detail() : await panel(p))
      await shot(p, `s23-${name}-${what.replace(/\W+/g, '-').slice(0, 40)}`)
    } else ok(`${name}: ${what}`)
  }
  const gone = async (cond: () => Promise<boolean>, ms = 2000) => {
    for (let t = 0; t < ms; t += 100) {
      if (await cond()) return true
      await sleep(100)
    }
    return cond()
  }
  const rightClick = async (kind: Kind, notUser = '') => {
    const h = await aim(p, kind, notUser)
    if (!h) return null
    await p.mouse.move(h.x, h.y)
    await p.mouse.click(h.x, h.y, { button: 'right' })
    await sleep(MENU_MS)
    if (!(await p.evaluate(() => !!document.querySelector('.hs-mc-ctx')))) {
      // say what the pointer was over and what the page heard, so "no menu" can be told apart from "a menu that closed"
      const seen = await p.evaluate(
        ([x, y]: [number, number]) => {
          const at = document.elementFromPoint(x, y) as HTMLElement | null
          return `${at?.className || at?.tagName} in row ${(at?.closest('.hs-mc-msg') as HTMLElement | null)?.dataset.msgPlatform || '?'}; page saw: ${((window as any).__s23.trail as string[]).join(' | ')}`
        },
        [h.x, h.y],
      )
      info(`${name}: a right-click on ${kind} (${h.user}) opened no menu: pointer over ${seen}`)
    }
    return h
  }
  const clicked = (): Promise<{ user: string; key: string; text: string; platform: string }> => p.evaluate(() => (window as any).__s23.ctx)
  const toTail = async () => {
    await rest(p)
    if ((await paneNow(p)).pill) await p.click('#hs-mc-new-msgs', { timeout: 3000 }).catch(() => {})
    await gone(async () => {
      const v = await paneNow(p)
      return v.atTail && !v.pill
    }, 4000)
    await rest(p)
  }
  const menuItem = async (label: string) => {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const item = p.locator('.hs-mc-ctx [role="menuitem"] .hs-mc-em-label', { hasText: new RegExp(`^${esc}$`) }).first()
    await item.click({ timeout: 3000 }).catch(async () => {
      // something else sits over the item: say what, then press it the way a keyboard would
      const over = await p.evaluate(() => {
        const m = document.querySelector('.hs-mc-ctx') as HTMLElement | null
        if (!m) return 'nothing: the menu was gone'
        const r = m.getBoundingClientRect()
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height - 12)
        return m.contains(at) ? '' : `${at?.id || at?.className || at?.tagName}`.slice(0, 60)
      })
      const trail = await p.evaluate(() => ((window as any).__s23.trail as string[]).join(' | '))
      info(`${name}: "${label}" could not be clicked, covered by "${over}"; page saw: ${trail}`)
      await item.evaluate((el: HTMLElement) => el.click(), undefined, { timeout: 2000 })
    })
  }
  /** What covers the menu's items, if anything: the hover card of the name is the usual suspect. */
  const covered = () =>
    p.evaluate(() => {
      const m = document.querySelector('.hs-mc-ctx') as HTMLElement | null
      if (!m) return ''
      const r = m.getBoundingClientRect()
      for (const y of [r.top + 14, r.top + r.height / 2, r.bottom - 12]) {
        const at = document.elementFromPoint(r.left + r.width / 2, y)
        if (at && !m.contains(at)) return `${at.closest('[id]')?.id || at.className || at.tagName}`.slice(0, 60)
      }
      return ''
    })
  const closeBy = async (how: 'escape' | 'back') => {
    await p.bringToFront()
    if (how === 'escape') await p.keyboard.press('Escape')
    else {
      const b = await p.evaluate(() => {
        const r = (document.querySelector('.hs-mc-tab.active') as HTMLElement).getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })
      await p.mouse.click(b.x, b.y)
    }
  }

  // ── 1 right-click menus ──
  const WANT_ALWAYS = [
    [L('content_card_follow'), L('content_card_unfollow')],
    [L('content_card_block'), L('mc_input_unblock')],
    [L('mc_input_mute_24h'), L('mc_settings_unmute')],
    [L('mc_input_hide_in_tab'), L('mc_input_unhide_in_tab')],
    [L('content_card_copy_name')],
    [L('mc_input_copy_message')],
    [L('mc_input_copy_to_input')],
    [L('content_card_mention')],
    [L('mc_input_dm')],
    [L('content_card_view_profile')],
    [L('mc_input_add_note'), L('mc_input_edit_note')],
    [L('mc_input_chat_logs')],
  ]
  const NEVER = ['mc_input_delete_msg', 'mc_input_timeout', 'mc_input_timeout_10m', 'content_card_ban', 'content_card_unban', 'mc_input_warn'].map(L)
  const gift = L('mc_input_report_gift_sub')
  // `platform`: what the clicked row is. A twitch page's tab can hold a linked kick channel's rows, and a kick row has no gift-sub report.
  const menuFails = (m: Look, user: string, platform = '') => {
    const site = platform || name
    const f: string[] = []
    if (m.count !== 1) f.push(`${m.count} menus open`)
    if (m.header !== user) f.push(`header says "${m.header}", clicked on "${user}"`)
    const [l, t, r, b] = m.rect
    if (!(l >= 0 && t >= 0 && r <= m.vw && b <= m.vh)) f.push(`menu sticks out of the window: ${m.rect.join(',')} in ${m.vw}x${m.vh}`)
    const missing = WANT_ALWAYS.filter((alts) => !alts.some((a) => m.items.includes(a))).map((a) => a[0])
    if (!m.items.includes(`${L('mc_input_filter_to').replace('$USER$', '')}${user}`)) missing.push('filter to <name>')
    if (missing.length) f.push(`missing: ${missing.join(', ')}`)
    const mods = m.items.filter((i) => NEVER.includes(i))
    if (mods.length) f.push(`mod items for a signed-out viewer: ${mods.join(', ')}`)
    if (site === 'twitch' && !m.items.includes(gift)) f.push(`twitch menu lacks "${gift}"`)
    if (site !== 'twitch' && m.items.includes(gift)) f.push(`"${gift}" is a twitch item, shown on a ${site} row`)
    const junk = m.items.filter((i) => !i || RAW_KEY.test(i) || EMPTY_WORD.test(i))
    if (junk.length) f.push(`bad item text: ${junk.join(' | ')}`)
    return f
  }
  await step('right-click a row opens its menu with this site\'s items', async () => {
    const h = await rightClick('row')
    if (!h) return ['no row to click on']
    const c = await clicked()
    const m = await menuLook(p)
    const over = await covered()
    return [...menuFails(m, c.user, c.platform), ...(over ? [`"${over}" is drawn over the menu`] : [])]
  }, async () => menuLook(p))
  await step('Escape closes the menu', async () => {
    await p.keyboard.press('Escape')
    return (await gone(async () => (await menuLook(p)).count === 0, 1000)) ? [] : ['the menu stayed']
  })
  await step('right-click a name opens its menu, a click outside closes it', async () => {
    const h = await rightClick('name')
    if (!h) return ['no name to click on']
    const c = await clicked()
    const why = menuFails(await menuLook(p), c.user, c.platform)
    const over = await covered()
    if (over) why.push(`"${over}" is drawn over the menu`)
    // a bare spot of a row; in a chat of tall spam rows the menu covers every one of those, so
    // then any point of the list that is not the menu and not something a click acts on
    const out =
      (await aim(p, 'row')) ||
      (await p.evaluate(() => {
        const b = (document.getElementById('hs-mc-messages') as HTMLElement).getBoundingClientRect()
        for (let y = b.bottom - 12; y > b.top + 8; y -= 14)
          for (let x = b.left + 6; x < b.right - 6; x += 12) {
            const at = document.elementFromPoint(x, y) as HTMLElement | null
            if (!at || !at.closest('#hs-mc-messages') || at.closest('.hs-mc-ctx, a, img, button, .hs-mc-user, .hs-mc-emote-wrapper')) continue
            return { x, y }
          }
        return null
      }))
    if (!out) {
      // nothing to click: the step did not run. The menu must not outlive it and cover the next ones
      await p.keyboard.press('Escape')
      info(`${name}: the name menu covers every clickable spot of the list: click-outside not proven here`)
      return why
    }
    await p.mouse.click(out.x, out.y)
    if (!(await gone(async () => (await menuLook(p)).count === 0, 1000))) {
      why.push('a click outside left the menu open')
      await p.keyboard.press('Escape')
    }
    return why
  }, async () => menuLook(p))
  // A busy chat moves its rows between the aim and the press, and the press lands on an emote or
  // an emoji (their own menu) or opens nothing: the row's menu is the one with "copy message" in
  // it, and anything else is shut and aimed again.
  const rowMenu = async (kind: Kind, notUser = '') => {
    const want = L('mc_input_copy_message')
    for (let i = 0; i < 4; i++) {
      const h = await rightClick(kind, notUser)
      if (h && (await p.evaluate((w: string) => [...document.querySelectorAll('.hs-mc-ctx [role="menuitem"] .hs-mc-em-label')].some((e) => e.textContent === w), want))) return h
      await p.keyboard.press('Escape')
      await sleep(h ? 600 : 2000)
    }
    return null
  }
  await step('a second right-click replaces the menu, never two', async () => {
    const a = await rowMenu('row')
    if (!a) return ['no row to click on']
    await p.evaluate(() => ((window as any).__s23first = document.querySelector('.hs-mc-ctx')))
    // the first menu covers most names: the second right-click goes on a bare spot of another row beside it
    const b = await rightClick('row', a.user)
    if (!b) return ['no second row to click on']
    const c = await clicked()
    const m = await menuLook(p)
    const first = await p.evaluate(() => ((window as any).__s23first as HTMLElement).isConnected)
    return [...menuFails(m, c.user, c.platform), ...(first ? ['the first menu is still on the page'] : [])]
  }, async () => menuLook(p))
  await step('a wheel over the chat leaves the menu alone (the code has no wheel close for it)', async () => {
    const before = await menuLook(p)
    const b = await p.evaluate(() => {
      const r = (document.getElementById('hs-mc-messages') as HTMLElement).getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    await p.mouse.move(b.x, b.y)
    await p.mouse.wheel(0, -240)
    await sleep(600)
    const after = await menuLook(p)
    await p.keyboard.press('Escape')
    await p.mouse.wheel(0, 20_000)
    return [
      ...(before.count === 1 ? [] : ['no menu to scroll over']),
      ...(after.count === 1 ? [] : [`${after.count} menus after the wheel`]),
      ...(after.rect.join() === before.rect.join() ? [] : ['the menu moved']),
    ]
  }, async () => menuLook(p))
  await toTail()

  // ── 6 tooltips ──
  const tip = (sel: string) =>
    p.evaluate((sel: string) => {
      const t = document.querySelector(sel) as HTMLElement | null
      if (!t || !t.classList.contains('visible')) return null
      const r = t.getBoundingClientRect()
      return { text: (t.innerText || '').replace(/\s+/g, ' ').trim(), rect: [r.left, r.top, r.right, r.bottom].map(Math.round), vw: innerWidth, vh: innerHeight, imgs: [...t.querySelectorAll('img')].filter((i) => i.getAttribute('src') && !i.complete).length }
    }, sel)
  const tipFails = async (sel: string, label: string, within: RegExp | null, leaveMs: number) => {
    const f: string[] = []
    const seen = await (async () => {
      for (let i = 0; i < 20; i++) {
        const v = await tip(sel)
        if (v) return v
        await sleep(100)
      }
      return null
    })()
    if (!seen) return ['no tooltip appeared']
    const [l, t, r, b] = seen.rect
    if (!(l >= 0 && t >= 0 && r <= seen.vw && b <= seen.vh)) f.push(`tooltip outside the window: ${seen.rect.join(',')}`)
    if (!seen.text) f.push('tooltip has no text')
    if (RAW_KEY.test(seen.text) || EMPTY_WORD.test(seen.text)) f.push(`tooltip text looks broken: ${seen.text.slice(0, 80)}`)
    if (label && !seen.text.toLowerCase().includes(label.toLowerCase())) f.push(`tooltip "${seen.text.slice(0, 60)}" does not name "${label}"`)
    if (within && !within.test(seen.text)) f.push(`tooltip "${seen.text.slice(0, 60)}" shows no source`)
    await rest(p)
    if (!(await gone(async () => !(await tip(sel)), leaveMs))) f.push('tooltip stayed after the pointer left')
    return f
  }
  const hover = async (kind: Kind, waitS = 0) => {
    let h = await aim(p, kind)
    for (let i = 0; !h && i < waitS / 2; i++) {
      await sleep(2000)
      h = await aim(p, kind)
    }
    if (!h) return null
    await p.mouse.move(h.x - 30, h.y)
    await p.mouse.move(h.x, h.y, { steps: 3 })
    return h
  }
  // A row can slide off the pointer between aiming and landing, and on a chat of twenty lines a
  // second it does so every time: aim again a few times. A chat that fast with no tooltip in
  // five tries is not judged (the same hover is judged on the other sites); a slow one is.
  const hoverTip = async (kind: Kind, sel: string, waitS: number) => {
    let h = await hover(kind, waitS)
    if (!h) return null
    for (let i = 0; ; i++) {
      if (await gone(async () => !!(await tip(sel)), 1500)) return h
      if (i === 4) break
      h = await hover(kind, 4)
      if (!h) return null
    }
    const rate = await p.evaluate(
      () =>
        new Promise<number>((res) => {
          const l = document.getElementById('hs-mc-messages') as HTMLElement
          let n = 0
          const mo = new MutationObserver((recs) => {
            for (const r of recs) n += r.addedNodes.length
          })
          mo.observe(l, { childList: true })
          setTimeout(() => {
            mo.disconnect()
            res(n)
          }, 2000)
        }),
    )
    if (rate < 12) return 'none' as const
    info(`${name}: no ${kind} stayed under the pointer long enough for its tooltip in 5 tries (${rate / 2} rows a second): not judged here`)
    return null
  }
  await step('hovering an emote names it and its source, then lets go', async () => {
    const h = await hoverTip('emote', '#hs-emote-tooltip', 20)
    if (!h) return null
    if (h === 'none') return ['no tooltip appeared']
    return tipFails('#hs-emote-tooltip', '', /7tv|bttv|ffz|twitch|kick|heatsync|youtube|sub|blocked|hidden|in set/i, 1500)
  })
  await step('a wheel scroll takes the emote tooltip away', async () => {
    const h = await hoverTip('emote', '#hs-emote-tooltip', 20)
    if (!h) return null
    if (h === 'none') return ['no tooltip appeared']
    await p.mouse.wheel(0, 120)
    return (await gone(async () => !(await tip('#hs-emote-tooltip')), 1500)) ? [] : ['the tooltip stayed after a scroll']
  })
  await toTail()
  await step('hovering a badge names it, then lets go', async () => {
    const h = await hoverTip('badge', '#hs-badge-tooltip', 20)
    if (!h) return null
    if (h === 'none') return ['no tooltip appeared']
    return tipFails('#hs-badge-tooltip', '', null, 1500)
  })
  await step('hovering a link shows where it goes, then lets go', async () => {
    const h = await hoverTip('link', '#hs-link-tooltip', 24)
    if (!h) return null
    if (h === 'none') return ['no tooltip appeared']
    return tipFails('#hs-link-tooltip', h.label, null, 3500)
  })
  await toTail()

  // ── 7 local actions ──
  await step('copy message and copy name reach the clipboard', async () => {
    let h = await rowMenu('plain-row')
    for (let i = 0; !h && i < 3; i++) h = await rowMenu('plain-row')
    if (!h) return null
    const c = await clicked()
    await menuItem(L('mc_input_copy_message'))
    const read = (): Promise<string | null> => p.evaluate(() => navigator.clipboard.readText().catch(() => null))
    let got = await read()
    for (let i = 0; i < 10 && got === ''; i++) {
      await sleep(200)
      got = await read()
    }
    if (got === null) {
      info(`${name}: the clipboard cannot be read here: copy not proven`)
      return null
    }
    if (/»\s*$/.test(got)) return [`the copied message ends with the thread button's "»": "${got.slice(-30)}"`]
    const flat = got.replace(/\s+/g, ' ').trim()
    // where the two part ways: a long link reads the same for its first 60 characters
    let at = 0
    while (at < flat.length && at < c.text.length && flat[at] === c.text[at]) at++
    const f = !c.text || flat === c.text ? [] : [`copied (${flat.length}) and the row (${c.text.length}) part ways at ${at}: copied "…${flat.slice(Math.max(0, at - 20), at + 40)}", the row said "…${c.text.slice(Math.max(0, at - 20), at + 40)}"`]
    await rightClick('name')
    const c2 = await clicked()
    await menuItem(L('content_card_copy_name'))
    let name2 = await read()
    for (let i = 0; i < 10 && (name2 === '' || name2 === got); i++) {
      await sleep(200)
      name2 = await read()
    }
    if (name2 !== c2.user && name2?.toLowerCase().replace(/^@/, '') !== c2.user) f.push(`copy name gave "${name2}", the name was "${c2.user}"`)
    return f
  })
  await toTail()
  await step('hide in tab takes a chatter out, /unhide brings them back', async () => {
    const h = await rightClick('name')
    if (!h) return ['no name to hide']
    const c = await clicked()
    const count = (u: string) =>
      p.evaluate((u: string) => [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg .hs-mc-user:not(.hs-mc-reply-user)')].filter((a) => ((a as HTMLElement).dataset.username || '').replace(/^@/, '').toLowerCase() === u).length, u)
    const before = await count(c.user)
    if (!before) return [`no row of ${c.user} on screen to hide`]
    // how far from the bottom the chatter's newest row sits, and how fast the chat is moving: on a
    // chat doing many lines a second the row is gone from the (capped) list by the time /unhide runs
    const depth = await p.evaluate((u: string) => {
      const rows = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg[data-msg-key]')]
      let at = -1
      rows.forEach((r, i) => {
        const a = r.querySelector('.hs-mc-user:not(.hs-mc-reply-user)') as HTMLElement | null
        if (a && (a.dataset.username || '').replace(/^@/, '').toLowerCase() === u) at = i
      })
      return at < 0 ? -1 : rows.length - 1 - at
    }, c.user)
    const grew0 = await bufferCount(p, chan)
    const t0Hide = Date.now()
    await menuItem(L('mc_input_hide_in_tab'))
    await sleep(300)
    const seen = await p.evaluate(() => ({ menus: document.querySelectorAll('.hs-mc-ctx').length, toasts: [...document.querySelectorAll('[class*="toast"]')].map((t) => (t.textContent || '').slice(0, 40)).filter(Boolean) }))
    const f: string[] = []
    const tHide = Date.now()
    if (!(await gone(async () => (await count(c.user)) === 0, 10_000))) f.push(`${c.user}'s rows are still on screen 10s after hide (right after the click: ${seen.menus} menus, toasts ${JSON.stringify(seen.toasts)})`)
    else info(`${name}: hide took ${Date.now() - tHide}ms`)
    if ((await paneNow(p)).rows < 10) f.push('the hide emptied the pane')
    await sleep(2500)
    await p.click('#hs-mc-input', { timeout: 5000 })
    await p.keyboard.type(`/unhide ${c.user}`)
    await p.keyboard.press('Enter')
    if (!(await gone(async () => (await count(c.user)) > 0, 10_000))) {
      const listRows = (await paneNow(p)).rows
      const grew = (await bufferCount(p, chan)) - grew0
      // the chat added more lines than the row had room above it in the list: it is gone because it aged out, not because unhide failed
      if (depth >= 0 && grew > 0 && depth + grew >= listRows - 5) {
        info(`${name}: too fast a chat for this step: ${c.user}'s row was ${depth} from the bottom and ${grew} lines came in over ${Math.round((Date.now() - t0Hide) / 1000)}s (list of ${listRows}): /unhide not proven`)
        return f.length ? f : null
      }
      f.push(`${c.user} did not come back 10s after /unhide (had ${before} rows, ${depth} from the bottom, ${grew} lines came in, list of ${listRows})`)
    }
    return f
  }, async () => ({
    input: await p.evaluate(() => document.getElementById('hs-mc-input')?.textContent),
    focus: await p.evaluate(() => document.activeElement?.id || document.activeElement?.tagName),
    toasts: await p.evaluate(() => [...document.querySelectorAll('[class*="toast"]')].map((t) => (t.textContent || '').slice(0, 60))),
    dropdown: await p.evaluate(() => (document.querySelector('.hs-mc-slash-dropdown') as HTMLElement | null)?.offsetHeight),
    pane: await panel(p),
  }))
  await toTail()

  // ── 2 the profile card, five times ──
  const cycles: string[] = []
  let desync = 0
  for (let i = 1; i <= 5; i++) {
    const how = i % 2 ? 'escape' : 'back'
    await step(`profile card ${i} of 5, closed with ${how === 'escape' ? 'Escape' : 'the ← back tab'}`, async () => {
      await toTail()
      const before = await paneNow(p)
      // one look at a chat of twenty lines a second can find every name mid-move: look a few times
      let h0 = await aim(p, 'chatter')
      for (let n = 0; !h0 && n < 5; n++) {
        await sleep(300)
        h0 = await aim(p, 'chatter')
      }
      if (!h0) return ['no name to click on']
      const tOpen = Date.now()
      const knownKeys: string[] = await p.evaluate(() => [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg[data-msg-key]')].map((r) => (r as HTMLElement).dataset.msgKey || ''))
      const buf0 = await bufferCount(p, chan)
      let h = null
      let up = false
      for (let tries = 0; !up && tries < 2; tries++) {
        const at = tries ? await aim(p, 'chatter') : h0
        if (!at) break
        await p.mouse.move(at.x, at.y)
        await p.mouse.click(at.x, at.y)
        h = await p.evaluate(() => (window as any).__s23.click)
        up = !!h && (await gone(async () => p.evaluate(() => !!document.querySelector('#hs-mc-messages .hs-card')), tries ? 12_000 : 4000))
      }
      if (!h) return [`the click on ${h0.user} reached no name`]
      if (!up) return [`no card within 12s of clicking ${h.user}`]
      await sleep(i === 1 ? CARD_HOLD_MS : 3000)
      const f: string[] = []
      const card = await p.evaluate(() => {
        const c = document.querySelector('#hs-mc-messages .hs-card') as HTMLElement
        const sub = document.getElementById('hs-mc-subrow') as HTMLElement
        const imgs = [...c.querySelectorAll('img')] as HTMLImageElement[]
        return {
          text: `${c.innerText} ${sub?.innerText || ''}`.replace(/\s+/g, ' ').toLowerCase(),
          broken: imgs.filter((m) => m.complete && m.naturalWidth === 0 && m.getAttribute('src')).map((m) => (m.getAttribute('src') || '').slice(0, 40)),
          avatar: (() => {
            const a = c.querySelector('img.hs-card-avatar') as HTMLImageElement | null
            return a ? { src: a.currentSrc || a.src, ok: a.complete && a.naturalWidth > 0 } : null
          })(),
          loading: !!c.querySelector('.hs-pcard-loading'),
          error: c.classList.contains('hs-card-empty'),
          takeover: document.documentElement.classList.contains('hs-mc-fill-on'),
        }
      })
      if (card.loading) f.push('the card never got past loading')
      if (!card.text.includes(h.user)) f.push(`the card does not show "${h.user}": ${card.text.slice(0, 80)}`)
      const plat = h.platform === 'yt' ? 'youtube' : h.platform
      if (!card.error && plat && !card.text.includes(plat)) f.push(`the card shows no "${plat}"`)
      if (card.error) info(`${name}: card for ${h.user} is the no-profile one: platform not shown`)
      if (RAW_KEY.test(card.text)) f.push(`raw text key on the card: ${card.text.match(RAW_KEY)?.[0]}`)
      if (EMPTY_WORD.test(card.text)) f.push(`"${card.text.match(EMPTY_WORD)?.[0]}" on the card`)
      if (card.avatar && !card.avatar.src.startsWith('https://')) f.push(`the card's avatar is not an https picture: ${card.avatar.src.slice(0, 50)}`)
      else if (card.avatar && !card.avatar.ok) {
        // 3s in and not drawn: a slow picture, or one that cannot load. Asked for once more by itself.
        const loads = await p.evaluate(
          (src: string) =>
            new Promise<boolean>((res) => {
              const i = new Image()
              i.onload = () => res(i.naturalWidth > 0)
              i.onerror = () => res(false)
              setTimeout(() => res(false), 8000)
              i.src = src
            }),
          card.avatar.src,
        )
        if (loads) info(`${name}: card ${i}: the avatar was still loading 3s in, and loads: ${card.avatar.src.slice(0, 60)}`)
        else f.push(`the card's avatar does not load: ${card.avatar.src.slice(0, 80)}`)
      }
      if (card.broken.length) f.push(`broken picture(s): ${card.broken.join(', ')}`)
      if (!card.takeover) f.push('the active tab does not read ← back while the card is open')
      const mid = await paneNow(p)
      if (mid.rows) f.push(`${mid.rows} chat rows still show under the card`)
      const thr = Math.max(5, Math.min(20, Math.floor(before.rows / 2)))
      await armClose(p, thr)
      const bufOpen = (await bufferCount(p, chan)) - buf0
      await closeBy(how)
      await sleep(1500)
      const c = await readClose(p)
      const hist = Object.entries(c.at).map(([ms, n]) => `${ms}ms:${n}`).join(' ')
      cycles.push(`${i}:${c.rowsAt}ms`)
      info(`${name}: card ${i} closed by ${how}: rows back after ${c.rowsAt}ms, at the tail after ${c.tailAt}ms (rows ${hist}); buffer grew ${bufOpen} while open`)
      if (c.rowsAt < 0 || c.rowsAt > BACK_BUDGET_MS) f.push(`rows were back after ${c.rowsAt}ms (budget ${BACK_BUDGET_MS}ms): ${hist}`)
      // the pointer rests where the card's name was: if that is a name the feed holds still by design, so let it go first
      await rest(p)
      await sleep(600)
      await gone(async () => {
        const v = await paneNow(p)
        return v.atTail && !v.pill
      }, 6000)
      // On a chat of twenty lines a second a row is added every third frame and pinned in the
      // frame after: one look can land between the two (41px short, twitch 11-18). A list that
      // follows is at its tail in one of a few looks; one that stopped is in none of them.
      let a = await paneNow(p, knownKeys)
      let tf = null as Awaited<ReturnType<typeof tailFollows>> | null
      if (!a.atTail || a.pill) {
        tf = await tailFollows(p)
        a = { ...(await paneNow(p, knownKeys)), atTail: tf.ok }
      }
      if (!a.atTail || a.pill) {
        // say where the reader is and what sits over the list: a held feed, a paused one and a card that changed the height read alike from the outside
        const g = await p.evaluate(() => {
          const l = document.getElementById('hs-mc-messages') as HTMLElement
          const tour = document.getElementById('hs-mc-tour') as HTMLElement | null
          return { list: `${Math.round(l.scrollTop)}+${l.clientHeight}/${l.scrollHeight}`, tour: tour && !tour.hidden ? tour.offsetHeight : 0, hovered: (document.querySelector('#hs-mc-messages :hover:last-child') as HTMLElement | null)?.className || '' }
        })
        const rd = (await dbg(p)).reader
        f.push(`not at the tail and following: pill=${a.pill ? `"${a.pillText}"` : 'hidden'} list ${g.list} over 2.5s ${JSON.stringify(tf)} tour ${g.tour}px reader ${JSON.stringify(rd)} hover ${g.hovered || '-'}`)
      }
      if (!a.composer && before.composer) f.push('the composer bar did not come back')
      if (a.subCells < Math.min(before.subCells, 1)) f.push('the 2nd row has no cells')
      if (a.subCells !== before.subCells) f.push(`the 2nd row has ${a.subCells} cells, was ${before.subCells}`)
      if (a.fillOn) f.push('the pane still reads as taken over')
      if (name !== 'youtube' && (a.newestAgeS === null || a.newestAgeS > 15)) f.push(`newest row on screen is ${a.newestAgeS}s old`)
      // what the buffer took in while the card covered the pane has to be on screen
      const grew = (await bufferCount(p, chan)) - buf0
      info(`${name}: card ${i}: buffer grew ${grew}, ${a.fresh} rows on screen that were not there before`)
      if (grew > 5 && a.fresh < Math.floor(grew * 0.15) - 3) f.push(`buffer got ${grew} messages since the card opened, only ${a.fresh} new rows are on screen`)
      if (!grew && i === 1 && name !== 'youtube') f.push('the buffer took in nothing in 9s on a busy channel')
            const moves = await gone(async () => (await paneNow(p)).newestKey !== a.newestKey, 8000)
      if (!moves && (name !== 'youtube' || grew >= 5)) f.push('the newest row did not change for 8s after the close')
      const ring = await ringSince(p, tOpen - 1000)
      const dz = ring.recent.filter((e) => e.e === 'index_desync').length
      desync += dz
      if (dz) f.push(`index_desync logged ${dz}x around the card`)
      if (ringBad(ring.bad).length) f.push(`watchdog ring: ${ringBad(ring.bad).map((e) => e.e).join(', ')}`)
      return f
    }, async () => ({ pane: await paneNow(p), close: await readClose(p) }))
  }
  info(`${name}: rows back after each close: ${cycles.join(' ')}; index_desync events: ${desync}`)

  // ── 4 chat logs ──
  const logsRows = () => p.evaluate(() => document.querySelectorAll('#hs-mc-subpane .hs-cl-row').length)
  for (const how of ['escape', 'back'] as const) {
    await step(`chat logs from the menu, closed with ${how === 'escape' ? 'Escape' : 'the ← back tab'}`, async () => {
      await toTail()
      const before = await paneNow(p)
      const h = await rightClick('name')
      if (!h) return ['no name to click on']
      const c = await clicked()
      await menuItem(L('mc_input_chat_logs'))
      const up = await gone(async () => p.evaluate(() => !!document.querySelector('#hs-mc-subpane .hs-cl-wrap')), 8000)
      if (!up) return ['the logs view never opened']
      const f: string[] = []
      const settled = await gone(async () => p.evaluate(() => !!document.querySelector('#hs-mc-subpane .hs-cl-row, #hs-mc-subpane .hs-cl-empty')), 15_000)
      if (!settled) f.push('the logs showed neither rows nor an empty line in 15s')
      const view = await p.evaluate(() => {
        const w = document.querySelector('#hs-mc-subpane') as HTMLElement
        const imgs = [...w.querySelectorAll('img')] as HTMLImageElement[]
        return {
          text: (w.innerText || '').replace(/\s+/g, ' '),
          title: (w.querySelector('.hs-cl-title-name') as HTMLElement | null)?.innerText || '',
          empty: (w.querySelector('.hs-cl-empty') as HTMLElement | null)?.innerText || '',
          broken: imgs.filter((m) => m.complete && m.naturalWidth === 0 && m.getAttribute('src')).length,
        }
      })
      const n0 = await logsRows()
      if (view.title.toLowerCase() !== c.user) f.push(`the logs are titled "${view.title}", not "${c.user}"`)
      if (RAW_KEY.test(view.text)) f.push(`raw text key in the logs: ${view.text.match(RAW_KEY)?.[0]}`)
      if (EMPTY_WORD.test(view.text)) f.push(`"${view.text.match(EMPTY_WORD)?.[0]}" in the logs`)
      if (view.broken) f.push(`${view.broken} broken picture(s) in the logs`)
      if (n0 === 0) info(`${name}: ${c.user}'s logs say: "${view.empty.slice(0, 60)}"`)
      if (/couldn't|failed/i.test(view.empty)) f.push(`the logs failed to load: "${view.empty}"`)
      const loader = await p.evaluate(() => !!document.querySelector('#hs-mc-subpane .hs-cl-loader'))
      if (loader && n0 > 0) {
        const lb = await p.evaluate(() => {
          const r = (document.querySelector('#hs-mc-subpane .hs-cl-list') as HTMLElement | null)?.getBoundingClientRect()
          return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
        })
        if (!lb) return [...f, 'the logs list is gone']
        await p.mouse.move(lb.x, lb.y)
        await p.mouse.wheel(0, 4000)
        const top = () => p.evaluate(() => Math.round((document.querySelector('#hs-mc-subpane .hs-cl-list') as HTMLElement | null)?.scrollTop ?? -1))
        let peak = 0
        for (let i = 0; i < 20; i++) {
          peak = Math.max(peak, await top())
          if (peak > 200) break
          await sleep(100)
        }
        const more = await gone(async () => (await logsRows()) > n0 || !(await p.evaluate(() => !!document.querySelector('#hs-mc-subpane .hs-cl-loader'))), 12_000)
        const n1 = await logsRows()
        info(`${name}: older rows: ${n0} → ${n1}${n1 === n0 ? ' (ran out)' : ''}`)
        const after = await top()
        if (peak > 200 && n1 > n0 && after < 4) f.push(`the list jumped back to the top after older rows loaded (was at ${peak}px, ${n0} → ${n1} rows)`)
        if (!more) {
          const sc = await p.evaluate(() => {
            const l = document.querySelector('#hs-mc-subpane .hs-cl-list') as HTMLElement
            const ld = document.querySelector('#hs-mc-subpane .hs-cl-loader') as HTMLElement
            const r = l.getBoundingClientRect()
            const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
            return `pointer on ${at?.className || at?.tagName}, list ${Math.round(l.scrollTop)}+${l.clientHeight}/${l.scrollHeight}, loader ${ld ? `at ${Math.round(ld.getBoundingClientRect().top - r.top)} saying "${(ld.textContent || '').trim()}"${ld.classList.contains('hs-cl-retry') ? ' (retry)' : ''}` : 'gone'}`
          })
          f.push(`older rows never loaded and the loader stayed (${n0} rows; ${sc})`)
        }
      }
      const thr = Math.max(5, Math.min(20, Math.floor(before.rows / 2)))
      await armClose(p, thr)
      await closeBy(how)
      await sleep(1500)
      const cl = await readClose(p)
      info(`${name}: logs closed by ${how}: chat rows back after ${cl.rowsAt}ms`)
      if (cl.rowsAt < 0 || cl.rowsAt > BACK_BUDGET_MS) f.push(`chat rows were back after ${cl.rowsAt}ms (budget ${BACK_BUDGET_MS}ms)`)
      if (await p.evaluate(() => !!document.querySelector('#hs-mc-subpane .hs-cl-wrap'))) f.push('the logs view is still on the page')
      await toTail()
      let a = await paneNow(p)
      let tf = null as Awaited<ReturnType<typeof tailFollows>> | null
      if (!a.atTail || a.pill) {
        tf = await tailFollows(p)
        a = { ...(await paneNow(p)), atTail: tf.ok }
      }
      if (!a.atTail || a.pill) {
        // say where the reader is and what sits over the list: a held feed, a paused one and a card that changed the height read alike from the outside
        const g = await p.evaluate(() => {
          const l = document.getElementById('hs-mc-messages') as HTMLElement
          const tour = document.getElementById('hs-mc-tour') as HTMLElement | null
          return { list: `${Math.round(l.scrollTop)}+${l.clientHeight}/${l.scrollHeight}`, tour: tour && !tour.hidden ? tour.offsetHeight : 0, hovered: (document.querySelector('#hs-mc-messages :hover:last-child') as HTMLElement | null)?.className || '' }
        })
        const rd = (await dbg(p)).reader
        f.push(`not at the tail and following: pill=${a.pill ? `"${a.pillText}"` : 'hidden'} list ${g.list} over 2.5s ${JSON.stringify(tf)} tour ${g.tour}px reader ${JSON.stringify(rd)} hover ${g.hovered || '-'}`)
      }
      if (!a.composer && before.composer) f.push('the composer bar did not come back')
      return f
    })
  }

  // ── 5 a reply thread ──
  let reply = await aim(p, 'reply')
  for (let i = 0; !reply && i < (name === 'youtube' ? 5 : 20); i++) {
    await sleep(2000)
    reply = await aim(p, 'reply')
  }
  if (!reply && second) {
    info(`${name}: no reply row in 40s, trying ${second}`)
    await p.goto(second, { waitUntil: 'domcontentloaded' })
    if (await waitPanel(p)) await rowsFlow(p, 30_000)
    await recordClicks(p)
    for (let i = 0; !reply && i < 20; i++) {
      await sleep(2000)
      reply = await aim(p, 'reply')
    }
  }
  if (!reply) info(`${name}: no reply row showed up: reply threads not covered here`)
  else {
    await step('a reply pill opens the thread with the parent, Escape closes it', async () => {
      const shown = () =>
        p.evaluate(() => {
          const st = document.getElementById('hs-mc-reply-stack') as HTMLElement | null
          const r = st?.getBoundingClientRect()
          return { open: !!st && getComputedStyle(st).display !== 'none' && !!st.children.length, text: (st?.innerText || '').toLowerCase(), rect: r ? [r.left, r.top, r.right, r.bottom].map(Math.round) : [], vw: innerWidth, vh: innerHeight }
        })
      // a reply to a line older than the buffer has no parent to show: try the next reply row
      let h = null
      for (let skip = 0; skip < 3; skip++) {
        await toTail()
        // a wheel-up pauses the feed: on a fast chat the pill would slide away between aiming and the click
        const lb = await p.evaluate(() => {
          const r = (document.getElementById('hs-mc-messages') as HTMLElement).getBoundingClientRect()
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        })
        await p.mouse.move(lb.x, lb.y)
        await p.mouse.wheel(0, -60)
        await sleep(500)
        h = await aim(p, 'reply', '', skip)
        if (!h) break
        await p.mouse.move(h.x, h.y)
        await p.mouse.click(h.x, h.y)
        if (await gone(async () => (await shown()).open, 3000)) break
        info(`${name}: reply row ${skip + 1} opened no thread`)
        h = null
      }
      if (!h) {
        info(`${name}: reply rows were on screen but none opened a thread (parent not in the buffer?): not proven`)
        return null
      }
      const s = await shown()
      const f: string[] = []
      if (h.label && !s.text.includes(h.label.toLowerCase())) f.push(`the stack does not show the parent "${h.label}"`)
      const [l, t, r, b] = s.rect
      if (!(l >= 0 && t >= 0 && r <= s.vw && b <= s.vh)) f.push(`stack outside the window: ${s.rect.join(',')}`)
      if (RAW_KEY.test(s.text) || EMPTY_WORD.test(s.text)) f.push('the stack text looks broken')
      await p.keyboard.press('Escape')
      if (!(await gone(async () => !(await shown()).open, 1500))) f.push('Escape left the thread stack open')
      // reading a thread pauses the list on purpose; "N new" is the way back and it counts what kept arriving
      const k = (await paneNow(p)).newestKey
      const flowing = await gone(async () => (await paneNow(p)).newestKey !== k || (await paneNow(p)).pill, 10_000)
      if (!flowing) f.push('chat stopped flowing after the thread closed')
      return f
    })
    await toTail()
  }

  // ── 3 the ring, over everything above ──
  const ring = await ringSince(p, t0)
  if (ringBad(ring.bad).length) bad(`${name}: watchdogs fired during the whole run`, ringBad(ring.bad).slice(0, 6))
  else ok(`${name}: the watchdog ring stayed quiet (${(BAD_RING as readonly string[]).length} kinds watched)`)
  await p.close()
}

export async function s23RowMenu() {
  scenario('s23 row menu, name, card, logs, thread, tooltips, on every site')
  const [tw, tw2] = await liveChannels('twitch', 2)
  const [kk, kk2] = await liveChannels('kick', 2)
  const yt = await liveYtVideo()
  const env = await launch()
  const errs: string[] = []
  try {
    for (const origin of ['https://www.twitch.tv', 'https://kick.com', 'https://www.youtube.com'])
      await env.ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin }).catch(() => {})
    const only = (process.env.E2E_S23_SITES || 'twitch,kick,youtube').split(',')
    if (only.includes('twitch')) await site(env, 'twitch', `https://www.twitch.tv/${tw}`, errs, `https://www.twitch.tv/${tw2}`)
    if (only.includes('kick')) await site(env, 'kick', `https://kick.com/${kk}`, errs, `https://kick.com/${kk2}`)
    if (!only.includes('youtube')) return
    if (yt) await site(env, 'youtube', `https://www.youtube.com/watch?v=${yt.id}`, errs)
    else info('youtube leg not run: no live video')
    if (errs.length) bad('page errors', errs.slice(0, 5))
  } finally {
    await env.close()
  }
}

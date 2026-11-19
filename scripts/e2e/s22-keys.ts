/**
 * s22 — the keyboard, on twitch, kick and youtube with the panel up. Real key presses on a
 * focused page, signed out, nothing is ever sent (Enter is never pressed, every composer is
 * emptied with select-all + Backspace).
 *
 *   bun scripts/e2e/run.ts --only s22
 *
 *   - host hotkeys: k f t m space j l c 0-9 and the arrows typed in the panel's composer land in
 *     the composer and the player never hears them: not paused, not muted, not fullscreen, theatre
 *     unchanged, no seek, captions unchanged. Each key is first pressed with the page itself
 *     focused, so a binding that is dead on that page is named and not counted
 *   - type-to-focus (src/multichat/type-to-focus.js): no setting gates it, the pointer does:
 *     over the panel a letter lands in the composer and the host keeps its hands off; away from
 *     the panel the host gets the key and the composer stays empty; in a pop-out (the panel is
 *     the window) a letter always lands
 *   - alt+1..9 jump to the Nth tab, alt+[ and alt+] cycle with a wrap, rows of that channel draw
 *   - unread counts: three saved tabs, sit on the live tab: the other two count up, opening one
 *     clears its own count and leaves the other's
 *   - search: `/` focuses the tab's filter, a name narrows the list to its rows, n / N walk the
 *     matches, Escape in the filter puts the whole list back and the tail follows again
 *   - vi mode (setting viMode): Escape enters normal mode, 0 x i edit, <Space> ] and [ switch
 *     tabs, and in the settings pane j k G gg move the row; off again, j does nothing there
 *   - Escape in the composer never leaves theatre mode and never navigates
 *   - throughout: no page errors, no console errors from our code, an empty error log, a quiet
 *     watchdog ring
 *
 * Not covered: Escape out of real fullscreen (the browser owns that key, no page can see it).
 */
import { bad, extStorage, info, launch, liveChannels, liveYtVideo, ok, panel, ringSince, scenario, setUiSetting, sleep, tailFollows, saveChannels, shot, waitPanel, watchErrors } from './lib'

const SETTLE_MS = 12_000
const KEYS = ['k', 'f', 't', 'm', ' ', 'j', 'l', 'c', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
let step = ''
const press = (k: string) => (k === ' ' ? 'Space' : k)

type Snap = { has: boolean; paused: boolean | null; muted: boolean | null; vol: number | null; t: number; w: number; fs: boolean; theatre: boolean; cc: string | null; dialogs: number }

/** The player and the host's own modes, as the page shows them right now. */
const snap = (p: any): Promise<Snap> =>
  p.evaluate(() => {
    const vids = [...document.querySelectorAll('video')].filter((v) => v.getClientRects().length && !v.closest('#hs-mc-container'))
    vids.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)
    const v = vids[0]
    const host = location.hostname
    const theatre = host.includes('youtube')
      ? !!document.querySelector('ytd-watch-flexy[theater]')
      : host.includes('kick')
        ? !!document.querySelector('[data-theatre="true"]')
        : !!document.querySelector('.right-column--theatre, .video-player--theatre')
    return {
      has: !!v,
      paused: v ? v.paused : null,
      muted: v ? v.muted : null,
      vol: v ? Math.round(v.volume * 100) : null,
      t: v ? v.currentTime : 0,
      w: performance.now(),
      fs: !!document.fullscreenElement,
      theatre,
      cc: document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') ?? null,
      dialogs: document.querySelectorAll('dialog[open], [class*="z-dialog"][data-state="open"]').length,
    }
  })

/** What changed in the player between two snaps; a seek is a jump away from normal play (`rate` s per s). */
function diff(a: Snap, b: Snap, rate: number) {
  const out: string[] = []
  if (a.paused !== b.paused) out.push('paused')
  if (a.muted !== b.muted) out.push('muted')
  if (a.vol !== b.vol) out.push('volume')
  if (a.fs !== b.fs) out.push('fullscreen')
  if (a.theatre !== b.theatre) out.push('theatre')
  if (a.cc !== b.cc) out.push('captions')
  if (a.dialogs !== b.dialogs) out.push('dialog')
  // a pause or a resume inside the window changes how far time should have moved: not a seek
  const jump = b.t - a.t - (a.paused ? 0 : rate * ((b.w - a.w) / 1000))
  if (a.paused === b.paused && Math.abs(jump) > 3) out.push(`seek ${jump.toFixed(1)}s`)
  return out
}

const composerText = (p: any): Promise<string> =>
  p.evaluate(() => (document.getElementById('hs-mc-input')?.textContent || '').replace(/ /g, ' '))
const activeId = (p: any): Promise<string> => p.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || '')
const activeWho = (p: any): Promise<string> =>
  p.evaluate(() => {
    const a = document.activeElement as HTMLInputElement | null
    return a ? `${a.tagName}#${a.id}.${String(a.className).slice(0, 40)} ${a.placeholder || a.getAttribute('aria-label') || ''}`.slice(0, 120) : ''
  })
const tailGap = (p: any): Promise<number> =>
  p.evaluate(() => {
    const m = document.getElementById('hs-mc-messages') as HTMLElement
    return Math.round(m.scrollHeight - m.scrollTop - m.clientHeight)
  })

async function clearComposer(p: any) {
  await p.click('#hs-mc-input', { timeout: 5000 })
  await p.keyboard.press('Control+A')
  await p.keyboard.press('Backspace')
  await sleep(200)
}

/** Pointer well off the panel, nothing focused: the page itself has the keyboard. */
async function away(p: any) {
  await p.bringToFront()
  await p.mouse.move(20, 500)
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
  await sleep(200)
}

/**
 * Wait for the player to be playing again. kick's resume is not instant: `paused` stays true
 * while the stream rebuffers, and a key pressed in that window reads as "the host did not hear
 * it" (the player toggled, the flag did not move). Probed on real kick, 11-17.
 */
async function playing(p: any, ms = 10_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (!(await snap(p)).paused) return true
    await sleep(400)
  }
  return false
}

/** Pointer on the chat rows, nothing focused. */
async function overPanel(p: any) {
  await p.bringToFront()
  const r = await p.evaluate(() => {
    const b = document.getElementById('hs-mc-messages')?.getBoundingClientRect()
    return b ? [b.left + b.width / 2, b.top + b.height / 2] : null
  })
  if (r) await p.mouse.move(r[0], r[1])
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
  await sleep(200)
  return !!r
}

const tabIds = (p: any): Promise<string[]> =>
  p.$$eval('.hs-mc-tabs-scroll .hs-mc-tab[data-tab]', (t: HTMLElement[]) =>
    t.filter((x) => x.offsetParent !== null && x.dataset.tab !== 'add').map((x) => x.dataset.tab || ''),
  )
const tabCount = (p: any, id: string): Promise<number> =>
  p.evaluate((id: string) => {
    const t = [...document.querySelectorAll('.hs-mc-tab[data-tab]')].find((x) => (x as HTMLElement).dataset.tab === id)
    const n = t?.querySelector(':scope > .hs-mc-tab-count')
    return n ? Number.parseInt(n.textContent || '0', 10) || 0 : 0
  }, id)
const active = async (p: any) => (await panel(p)).activeTab as string | null

async function rowsOn(p: any, ms = 20_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if ((await panel(p)).rows > 0) return true
    await sleep(1000)
  }
  return false
}

async function site(env: any, name: string, url: string, popout: string, saved: { id: string; twitch?: string; kick?: string }[], errs: string[], cons: string[]) {
  const check = (what: string, fails: string[], detail?: unknown) =>
    fails.length ? bad(`${name}: ${what}: ${fails.join('; ')}`, detail) : ok(`${name}: ${what}`)

  await setUiSetting(env, 'tabCounter', 'unread')
  await setUiSetting(env, 'viMode', false)
  await saveChannels(env, saved)
  const p = await env.ctx.newPage()
  watchErrors(p, name, errs)
  p.on('console', (m: any) => {
    const text = String(m.text())
    if (m.type() === 'error' ? /heatsync|Error in event handler/i.test(text) && !/^Unsafe attempt to load URL/.test(text) : m.type() === 'warning' && /^\[heatsync\].*(fail|threw|error|exception)/i.test(text))
      cons.push(`${name} ${m.type()}: ${text.slice(0, 160)}`)
  })
  const t0 = Date.now()
  await p.goto(url, { waitUntil: 'domcontentloaded' })
  await p.bringToFront()
  if (!(await waitPanel(p))) return bad(`${name}: the panel never mounted`, await panel(p))
  await sleep(SETTLE_MS)
  const first = await snap(p)
  if (!first.has || !(await rowsOn(p))) {
    await shot(p, `s22-${name}`)
    bad(`${name}: no player or no chat rows on a live page`, { player: first.has, panel: await panel(p) })
    return p.close()
  }
  await sleep(1500)
  const second = await snap(p)
  const rate = second.paused ? 0 : Math.min(2, Math.max(0, (second.t - first.t) / ((second.w - first.w) / 1000)))
  const liveTab = await active(p)

  // ── 1 host hotkeys ──
  step = 'host hotkeys'
  const live: Record<string, boolean> = {}
  for (const k of [...KEYS, ...ARROWS]) {
    await away(p)
    await playing(p)
    const a = await snap(p)
    await p.keyboard.press(press(k))
    await sleep(500)
    const b = await snap(p)
    const d = diff(a, b, rate)
    live[k] = d.length > 0
    if (d.includes('dialog')) {
      await p.keyboard.press('Escape')
      await sleep(500)
    } else if (d.some((x) => ['paused', 'muted', 'fullscreen', 'theatre', 'captions'].includes(x))) {
      await p.keyboard.press(press(k))
      await sleep(500)
      if ((await snap(p)).fs) await p.evaluate(() => document.exitFullscreen().catch(() => {}))
    } else if (k === 'ArrowUp' || k === 'ArrowDown') {
      await p.keyboard.press(k === 'ArrowUp' ? 'ArrowDown' : 'ArrowUp')
      await sleep(300)
    }
  }
  const dead = [...KEYS, ...ARROWS].filter((k) => !live[k])
  info(`${name}: host keys live on this page: ${[...KEYS, ...ARROWS].filter((k) => live[k]).map((k) => (k === ' ' ? 'space' : k)).join(' ') || 'none'}`)
  if (dead.length) info(`${name}: no host binding even with the page focused (not counted as proof): ${dead.map((k) => (k === ' ' ? 'space' : k)).join(' ')}`)

  await clearComposer(p)
  let typed = ''
  const leaked: string[] = []
  const selfMoved: string[] = []
  const lost: string[] = []
  for (const k of KEYS) {
    const a = await snap(p)
    await p.keyboard.press(press(k))
    await sleep(350)
    const b = await snap(p)
    typed += k
    let d = diff(a, b, rate)
    // the player moves by itself (a rebuffer reads as paused, the resume as un-paused; on github's
    // runner j and l, which kick binds to nothing, each "paused" it, 11-18). a key the host really
    // hears is heard every time: one that only moved the play state is asked a second time
    if (d.length && d.every((x) => x === 'paused' || x.startsWith('seek'))) {
      await playing(p)
      const a2 = await snap(p)
      await p.keyboard.press(press(k))
      await sleep(350)
      const d2 = diff(a2, await snap(p), rate)
      typed += k
      if (!d2.length) selfMoved.push(`${k === ' ' ? 'space' : k}: ${d.join('/')}`)
      d = d2
    }
    if (d.length) leaked.push(`${k === ' ' ? 'space' : k}: ${d.join('/')}`)
    const got = await composerText(p)
    if (got !== typed) {
      lost.push(`${k === ' ' ? 'space' : k}: composer reads "${got}"`)
      typed = got
    }
  }
  const mid = await snap(p)
  const text = await composerText(p)
  for (const k of ARROWS) {
    const a = await snap(p)
    await p.keyboard.press(k)
    await sleep(350)
    const d = diff(a, await snap(p), rate)
    if (d.length) leaked.push(`${k}: ${d.join('/')}`)
  }
  if ((await composerText(p)) !== text) lost.push('an arrow key changed the composer text')
  if ((await activeId(p)) !== 'hs-mc-input') lost.push('the composer lost focus')
  if (selfMoved.length) info(`${name}: the player moved by itself while these were typed, and kept still when each was typed again: ${selfMoved.join('; ')}`)
  check('typing the player keys in the composer: the player never hears them', leaked, { mid })
  check('typing the player keys in the composer: every one lands in the composer', lost)
  await clearComposer(p)
  if (await composerText(p)) bad(`${name}: select-all + Backspace left text in the composer`)

  // ── 2 type-to-focus: the pointer decides ──
  step = 'type-to-focus'
  // kick's player moves by itself now and then (a rebuffer reads as paused, a late resume as
  // un-paused): a key the host really hears is heard every time, so one that moved the player
  // is asked a second time before it is a finding
  let hd: string[] = []
  const overFails: string[] = []
  const tries: unknown[] = []
  for (let attempt = 0; attempt < 2; attempt++) {
    overFails.length = 0
    const was = await playing(p)
    if (!(await overPanel(p))) bad(`${name}: no chat rows to hover`)
    const h0 = await snap(p)
    await p.keyboard.press('k')
    await sleep(500)
    const h1 = await snap(p)
    if ((await activeId(p)) !== 'hs-mc-input') overFails.push('the composer did not take focus')
    if ((await composerText(p)) !== 'k') overFails.push(`composer reads "${await composerText(p)}"`)
    hd = diff(h0, h1, rate)
    tries.push({ playingBefore: was, paused: [h0.paused, h1.paused], heard: hd })
    if (hd.length) overFails.push(`the player heard it: ${hd.join('/')}`)
    if (!hd.length || attempt) break
    info(`${name}: the player moved with the first letter (${hd.join('/')}), asking once more`)
    await clearComposer(p)
    await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
    await sleep(1500)
  }
  check('type-to-focus: a letter with the pointer over the chat lands in the composer, the player keeps still', overFails, { host: hd, composer: await composerText(p), tries })
  if (hd.includes('paused')) {
    await away(p)
    await p.keyboard.press('k')
    await sleep(500)
  }
  await clearComposer(p)

  await away(p)
  await playing(p)
  const w0 = await snap(p)
  await p.keyboard.press('k')
  await sleep(700)
  const w1 = await snap(p)
  const awayFails: string[] = []
  if (await composerText(p)) awayFails.push('the letter was typed into the composer')
  if (['hs-mc-input', 'hs-mc-search-input'].includes(await activeId(p))) awayFails.push('the composer took focus')
  const wd = diff(w0, w1, rate)
  if (live.k && !wd.includes('paused')) awayFails.push('the host lost its k key')
  check('type-to-focus: a letter with the pointer off the chat stays the host\'s', awayFails)
  if (wd.includes('paused')) {
    await p.keyboard.press('k')
    await sleep(500)
  }
  info(`${name}: type-to-focus has no setting: only the pointer decides (type-to-focus.js attentionIsOnPanel)`)

  // ── 3 tab keys ──
  step = 'tab keys'
  const ids = await tabIds(p)
  const tabFails: string[] = []
  const savedIds = saved.map((s) => s.id)
  for (const id of savedIds) if (!ids.includes(id)) tabFails.push(`saved tab ${id} is not in the tab bar`)
  await p.click('#hs-mc-input', { timeout: 15_000 })
  for (const id of savedIds) {
    const i = ids.indexOf(id)
    if (i < 0 || i > 8) continue
    await p.keyboard.press(`Alt+Digit${i + 1}`)
    await sleep(700)
    const got = await active(p)
    if (got !== id) tabFails.push(`alt+${i + 1} landed on ${got}, wanted ${id}`)
    else if (!(await rowsOn(p))) tabFails.push(`${id} drew no rows`)
  }
  if (ids.length < 9) {
    const before = await active(p)
    await p.keyboard.press('Alt+Digit9')
    await sleep(500)
    if ((await active(p)) !== before) tabFails.push('alt+9 moved the tab with fewer than 9 tabs')
  }
  const cur = await active(p)
  const ci = ids.indexOf(cur || '')
  if (ci >= 0) {
    await p.keyboard.press('Alt+BracketRight')
    await sleep(600)
    const want = ids[(ci + 1) % ids.length]
    if ((await active(p)) !== want) tabFails.push(`alt+] landed on ${await active(p)}, wanted ${want}`)
    await p.keyboard.press('Alt+BracketLeft')
    await sleep(600)
    if ((await active(p)) !== cur) tabFails.push(`alt+[ did not come back to ${cur}`)
  }
  await p.keyboard.press('Alt+Digit1')
  await sleep(500)
  await p.keyboard.press('Alt+BracketLeft')
  await sleep(500)
  if ((await active(p)) !== ids.at(-1)) tabFails.push(`alt+[ from the first tab did not wrap to ${ids.at(-1)}`)
  await clearComposer(p)
  check('tab keys: alt+1..9 jump, alt+[ and alt+] cycle and wrap, rows draw', tabFails, { ids })

  // ── 4 unread counts ──
  step = 'unread counts'
  const [, B, C] = [liveTab, savedIds[1], savedIds[2]]
  await away(p)
  const home = ids.indexOf(liveTab || '')
  await p.keyboard.press(`Alt+Digit${home + 1}`)
  await sleep(800)
  const t1 = Date.now()
  let b1 = 0
  let c1 = 0
  while (Date.now() - t1 < 40_000 && !(b1 > 0 && c1 > 0)) {
    await sleep(2000)
    b1 = await tabCount(p, B)
    c1 = await tabCount(p, C)
  }
  const unreadFails: string[] = []
  // a count of 0 is a finding only when lines did arrive: a channel that went quiet (or offline)
  // mid-run has nothing to count. Opened to look, it shows whether its newest row is from this window.
  const quiet: string[] = []
  for (const [id, n] of [[B, b1], [C, c1]] as [string, number][]) {
    if (n > 0) continue
    await p.keyboard.press(`Alt+Digit${ids.indexOf(id) + 1}`)
    await sleep(1500)
    const newest = await p.evaluate(() =>
      Math.max(0, ...([...document.querySelectorAll('#hs-mc-messages .hs-mc-msg[data-msg-key]')] as HTMLElement[]).slice(-20).map((r) => Number(r.dataset.msgTime || 0))),
    )
    if (newest < t1) quiet.push(id)
    await p.keyboard.press(`Alt+Digit${home + 1}`)
    await sleep(800)
  }
  if (quiet.length) info(`${name}: unread step skipped: no line arrived in ${quiet.join(', ')} for 40s`)
  else if (!(b1 > 0 && c1 > 0)) unreadFails.push(`no unread count after 40s though lines arrived (${B}=${b1}, ${C}=${c1})`)
  else {
    await sleep(10_000)
    const b2 = await tabCount(p, B)
    const c2 = await tabCount(p, C)
    if (!(b2 > b1)) unreadFails.push(`${B} did not grow (${b1} → ${b2})`)
    if (!(c2 > c1)) unreadFails.push(`${C} did not grow (${c1} → ${c2})`)
    await p.keyboard.press(`Alt+Digit${ids.indexOf(B) + 1}`)
    await sleep(1500)
    if ((await active(p)) !== B) unreadFails.push('the tab did not open')
    if ((await tabCount(p, B)) !== 0) unreadFails.push(`${B} still counts after opening it`)
    const c3 = await tabCount(p, C)
    if (c3 < c2) unreadFails.push(`opening ${B} cleared ${C}'s count (${c2} → ${c3})`)
    await sleep(4000)
    if ((await tabCount(p, B)) !== 0) unreadFails.push(`${B} counted again while open`)
    await p.keyboard.press(`Alt+Digit${home + 1}`)
    await sleep(800)
  }
  check('unread: counts grow on tabs not being read; opening a tab clears only its own', unreadFails)

  // ── 5 search ──
  step = 'search'
  const searchFails: string[] = []
  const searchSeen: Record<string, unknown> = {}
  await away(p)
  searchSeen.gapBefore = await tailGap(p)
  const rowsBefore = await p.evaluate(() => {
    const rows = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg[data-msg-key]')] as HTMLElement[]
    const by: Record<string, number> = {}
    for (const r of rows) {
      // youtube writes a handle as @name: the word itself is what a reader types into the filter
      const n = (r.querySelector('.hs-mc-user')?.textContent || '').trim().toLowerCase().replace(/^@/, '')
      if (/^[a-z0-9_]{3,}$/.test(n)) by[n] = (by[n] || 0) + 1
    }
    // not the loudest name: on a busy chat that is the spammer a mod clears mid-step, and their
    // rows leaving looked like "rows did not come back" (kick, 11-17). The quietest name with
    // a few rows gives n/N something to walk.
    const few = Object.entries(by)
      .filter((e) => e[1] >= 2)
      .sort((a, b) => a[1] - b[1])[0]
    const top = few || Object.entries(by).sort((a, b) => b[1] - a[1])[0]
    const last = rows.slice(-30)
    const who = (r: HTMLElement) => (r.querySelector('.hs-mc-user')?.textContent || '').trim().toLowerCase()
    // every row with what kind it is: when the list comes back shorter, which rows went says why
    const all = rows.map((r) => [r.dataset.msgKey || '', r.className.replace(/hs-mc-msg|hs-row-seen|hs-mc-zebra|hs-zebra/g, '').trim().split(/\s+/)[0] || 'chat'])
    return { n: rows.length, all, keys: last.map((r) => r.dataset.msgKey), by: last.map(who), q: top?.[0] || '', hits: top?.[1] || 0 }
  })
  // a stream nobody is chatting in has no name to look for: that is the stream, not the filter
  if (!rowsBefore.q && rowsBefore.n < 30) info(`${name}: search step skipped: ${rowsBefore.n} rows on screen, no name to look for`)
  else if (!rowsBefore.q) searchFails.push('no plain chatter name on screen to search for')
  else {
    // youtube binds / to its own search box and claims the key before any of our listeners see
    // it; ours stands down on a claimed key. Whether ours should win there is an owner call, so
    // on youtube the filter is focused directly and the rest of the step still runs.
    const toFilter = async () => {
      await p.keyboard.press('/')
      await sleep(400)
      if ((await activeId(p)) === 'hs-mc-search-input') return ''
      const who = await activeWho(p)
      if (name !== 'youtube' || !/ytSearchbox/i.test(who)) return who
      await p.keyboard.press('Escape')
      await p.evaluate(() => {
        const i = document.getElementById('hs-mc-search-input') as HTMLInputElement | null
        i?.focus()
        i?.select()
      })
      return 'youtube'
    }
    const slash = await toFilter()
    searchSeen.slash = slash
    if (slash === 'youtube') info(`${name}: / goes to youtube's own search box (youtube claims it first): the filter is focused directly`)
    else if (slash) searchFails.push(`/ did not focus the filter (focus: ${slash})`)
    await p.keyboard.type(rowsBefore.q, { delay: 40 })
    await sleep(1500)
    const f = await p.evaluate((q: string) => {
      const rows = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg[data-msg-key]')] as HTMLElement[]
      const stray = rows.filter((r) => !(r.textContent || '').toLowerCase().includes(q))
      return { n: rows.length, stray: stray.length, sample: stray.slice(0, 2).map((r) => `${r.className} | ${(r.textContent || '').trim().slice(0, 100)}`) }
    }, rowsBefore.q)
    searchSeen.stray = f.sample
    if (!f.n) searchFails.push(`the filter "${rowsBefore.q}" left no rows`)
    if (f.stray) searchFails.push(`${f.stray} of ${f.n} rows do not mention "${rowsBefore.q}"`)
    if (f.n >= rowsBefore.n) info(`${name}: the filter did not narrow the list (${rowsBefore.n} → ${f.n})`)
    await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
    // chat keeps arriving and the list re-draws under the keys, so the counter's total is only read for its shape and the position by where the mark sits in the rows now
    const cursor = () =>
      p.evaluate(() => {
        const rows = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg[data-msg-key]')]
        const mark = document.querySelector('.hs-mc-search-current')
        return { at: mark?.getAttribute('data-msg-key') || '', idx: mark ? rows.indexOf(mark) : -1, count: document.getElementById('hs-mc-search-count')?.textContent || '' }
      })
    // the first n lands on the oldest match, which a full buffer can push out a moment later and
    // take the mark with it: a press that left no mark is tried once more
    const walk = async (key: string) => {
      for (let i = 0; i < 2; i++) {
        await p.keyboard.press(key)
        await sleep(400)
        const c = await cursor()
        if (c.at) return c
      }
      return cursor()
    }
    const n1 = await walk('n')
    if (!n1.at) searchFails.push('n marked no row')
    if (!/^\d+\/\d+$/.test(n1.count)) searchFails.push(`the first n reads "${n1.count}", wanted 1/…`)
    if (f.n > 1) {
      const n2 = await walk('n')
      if (!n2.at || n2.idx === n1.idx || !/^\d+\/\d+$/.test(n2.count)) searchFails.push(`the second n did not move on: row ${n1.idx} → ${n2.idx}, reads "${n2.count}"`)
      // youtube's own shift+n is "next video": the press that steps a match back must not reach it
      const urlWas = p.url()
      const n3 = await walk('Shift+N')
      await sleep(1500)
      if (p.url() !== urlWas) searchFails.push(`N reached the host: the page went from ${urlWas} to ${p.url()}`)
      else if (!n3.at || n3.idx === n2.idx || (n2.idx > 0 && n3.idx > n2.idx)) searchFails.push(`N did not step back: row ${n2.idx} → ${n3.idx}, reads "${n3.count}"`)
    }
    await toFilter()
    await p.keyboard.press('Escape')
    await sleep(2000)
    const r = await p.evaluate((keys: string[]) => {
      const m = document.getElementById('hs-mc-messages') as HTMLElement
      const have = new Set([...m.querySelectorAll('.hs-mc-msg[data-msg-key]')].map((x) => (x as HTMLElement).dataset.msgKey))
      return {
        n: have.size,
        missing: keys.filter((k) => !have.has(k)).length,
        missingAt: keys.map((k, i) => (have.has(k) ? -1 : i)).filter((i) => i >= 0),
        input: (document.getElementById('hs-mc-search-input') as HTMLInputElement | null)?.value,
        mark: !!document.querySelector('.hs-mc-search-current'),
        gap: m.scrollHeight - m.scrollTop - m.clientHeight,
        focus: document.activeElement?.id || '',
      }
    }, rowsBefore.keys)
    if (r.input) searchFails.push(`Escape left "${r.input}" in the filter`)
    if (r.mark) searchFails.push('the current-match mark stayed after Escape')
    if (r.focus === 'hs-mc-search-input') searchFails.push('the filter kept focus after Escape')
    if (r.n < rowsBefore.n * 0.9) {
      const gone = await p.evaluate((all: string[][]) => {
        const have = new Set([...document.querySelectorAll('#hs-mc-messages .hs-mc-msg[data-msg-key]')].map((x) => (x as HTMLElement).dataset.msgKey))
        const at: number[] = []
        const kinds: Record<string, number> = {}
        all.forEach(([k, kind], i) => {
          if (have.has(k)) return
          at.push(i)
          kinds[kind] = (kinds[kind] || 0) + 1
        })
        return { n: at.length, first: at[0], last: at.at(-1), oldestKept: all.findIndex(([k]) => have.has(k)), kinds }
      }, rowsBefore.all)
      searchSeen.gone = gone
      // a list that came back empty is a page that changed under it (a tab emptied and read
      // "no channel" once, youtube 11-18): say where the page is and what the panel thinks
      searchSeen.page = await p.evaluate(() => ({
        url: location.href,
        composer: document.getElementById('hs-mc-input')?.getAttribute('data-placeholder'),
        tab: document.querySelector('.hs-mc-tab.active')?.textContent,
        video: [...document.querySelectorAll('video')].map((v) => `${Math.round(v.getBoundingClientRect().width)}x${Math.round(v.getBoundingClientRect().height)}${v.paused ? ' paused' : ''}`),
        title: document.title,
      }))
      // the oldest rows leaving is the list's cap at work; rows missing from the middle are lost rows
      searchFails.push(`the list came back shorter (${rowsBefore.n} → ${r.n}): ${gone.n} rows of before are gone, positions ${gone.first}..${gone.last} of ${rowsBefore.n}, the oldest one kept was at ${gone.oldestKept}`)
    }
    // one chatter's rows all gone is a mod clearing that chatter, not the filter losing rows
    const lostBy = [...new Set((r.missingAt as number[]).map((i) => rowsBefore.by[i]))]
    searchSeen.lostBy = lostBy
    if (r.missing && lostBy.length === 1 && lostBy[0]) info(`${name}: ${r.missing} rows of "${lostBy[0]}" left while the filter was up (cleared by a mod), not counted`)
    else if (r.missing) searchFails.push(`${r.missing} of the last 30 rows did not come back (from ${lostBy.length} chatters)`)
    searchSeen.gapAfter2s = r.gap
    await sleep(6000)
    // a row is appended in one frame and pinned in the next: one look can land between the two
    let gap = await tailGap(p)
    if (gap > 60) {
      const tf = await tailFollows(p)
      searchSeen.follows = tf
      if (tf.ok) gap = tf.min
    }
    searchSeen.gapAfter8s = gap
    if (gap > 60) searchFails.push(`the tail does not follow after Escape (${Math.round(gap)}px from the bottom)`)
  }
  check('search: / filters to a name, n and N walk the matches, Escape puts the list back and the tail follows', searchFails, searchSeen)

  // ── 6 vi mode ──
  step = 'vi mode'
  const viFails: string[] = []
  const v0 = await snap(p)
  await setUiSetting(env, 'viMode', true)
  await sleep(2500)
  await clearComposer(p)
  await p.keyboard.type('hello', { delay: 30 })
  await p.keyboard.press('Escape')
  await sleep(300)
  const normal = () => p.evaluate(() => document.getElementById('hs-mc-input')?.classList.contains('hs-vi-normal') || false)
  if (!(await normal())) viFails.push('Escape did not enter normal mode')
  await p.keyboard.press('0')
  await p.keyboard.press('x')
  await sleep(300)
  if ((await composerText(p)) !== 'ello') viFails.push(`0 x left "${await composerText(p)}", wanted "ello"`)
  await p.keyboard.press('i')
  await sleep(300)
  if (await normal()) viFails.push('i did not go back to insert mode')
  await p.keyboard.press('Escape')
  const at = await active(p)
  const ai = ids.indexOf(at || '')
  await p.keyboard.press('Space')
  await p.keyboard.press(']')
  await sleep(800)
  if ((await active(p)) !== ids[(ai + 1) % ids.length]) viFails.push(`<Space> ] landed on ${await active(p)}`)
  await p.keyboard.press('Space')
  await p.keyboard.press('[')
  await sleep(800)
  if ((await active(p)) !== at) viFails.push('<Space> [ did not come back')
  await p.keyboard.press('i')
  await clearComposer(p)
  await p.keyboard.press('Escape')
  await sleep(300)
  const vd = diff(v0, await snap(p), rate)
  if (vd.length) viFails.push(`the player heard the vi keys: ${vd.join('/')}`)
  // the settings pane: j k G gg move the row, only with vi on
  await p.click('#hs-mc-tabbar [data-tab="settings"]', { timeout: 5000 })
  await sleep(1500)
  const row = () => p.evaluate(() => {
    const rows = [...document.querySelectorAll('#hs-mc-messages [data-set-row]')]
    return { i: rows.findIndex((r) => r.classList.contains('hs-mc-set-row-focus')), n: rows.length }
  })
  await away(p)
  await p.keyboard.press('j')
  await p.keyboard.press('j')
  await sleep(200)
  const j2 = await row()
  if (j2.i !== 1) viFails.push(`settings: j j put the focus on row ${j2.i}, wanted 1`)
  await p.keyboard.press('k')
  await sleep(200)
  if ((await row()).i !== 0) viFails.push('settings: k did not step up')
  await p.keyboard.press('Shift+G')
  await sleep(200)
  const g = await row()
  if (g.i !== g.n - 1) viFails.push(`settings: G put the focus on row ${g.i}, wanted ${g.n - 1}`)
  await p.keyboard.press('g')
  await p.keyboard.press('g')
  await sleep(200)
  if ((await row()).i !== 0) viFails.push('settings: gg did not go to the first row')
  await setUiSetting(env, 'viMode', false)
  await sleep(2500)
  await away(p)
  await p.keyboard.press('j')
  await sleep(200)
  if ((await row()).i !== 0) viFails.push('settings: j still moves the row with vi mode off')
  await p.keyboard.press('ArrowDown')
  await sleep(200)
  if ((await row()).i !== 1) viFails.push('settings: ArrowDown does not move the row with vi mode off')
  await p.click(`.hs-mc-tab[data-tab="${at}"]:visible`, { timeout: 5000 }).catch(() => {})
  await sleep(800)
  check('vi mode: normal mode edits, <Space> switches tabs, the settings pane moves by j k G gg, off again', viFails)

  // ── 7 Escape ──
  step = 'escape'
  const escFails: string[] = []
  const u0 = p.url()
  await away(p)
  let inTheatre = false
  if (live.t) {
    await p.keyboard.press('t')
    await sleep(1500)
    inTheatre = (await snap(p)).theatre
    if (!inTheatre) info(`${name}: t no longer reaches theatre mode here, theatre leg not run`)
  } else info(`${name}: no theatre binding on this page, escape runs outside theatre`)
  await p.click('#hs-mc-input', { timeout: 5000 }).catch(() => escFails.push('the composer could not be clicked'))
  await p.keyboard.type('a', { delay: 30 })
  const e0 = await snap(p)
  await p.keyboard.press('Escape')
  await sleep(500)
  await p.keyboard.press('Escape')
  await sleep(1000)
  const e1 = await snap(p)
  if (inTheatre && !e1.theatre) escFails.push('Escape left theatre mode')
  if (e1.fs) escFails.push('Escape changed fullscreen')
  const ed = diff(e0, e1, rate).filter((x) => !x.startsWith('seek'))
  if (ed.length) escFails.push(`the player changed: ${ed.join('/')}`)
  if (p.url() !== u0) escFails.push('the page navigated')
  if (!(await waitPanel(p, 3000))) escFails.push('the panel is gone')
  check('Escape in the composer: no theatre exit, no navigation', escFails)
  if (await composerText(p)) await clearComposer(p)
  await away(p)
  if (inTheatre && (await snap(p)).theatre) {
    await p.keyboard.press('t')
    await sleep(1000)
  }

  // ── a pop-out is the whole window: a letter always lands ──
  step = 'pop-out'
  const pp = await env.ctx.newPage()
  watchErrors(pp, `${name}-popout`, errs)
  await pp.setViewportSize({ width: 400, height: 600 })
  await pp.goto(popout, { waitUntil: 'domcontentloaded' })
  await pp.bringToFront()
  await waitPanel(pp)
  await sleep(SETTLE_MS)
  await away(pp)
  await pp.keyboard.press('x')
  await sleep(500)
  const px = await composerText(pp)
  if (px === 'x') ok(`${name}: pop-out: a letter lands in the composer with nothing focused`)
  else bad(`${name}: pop-out: a letter did not land in the composer`, { text: px, focus: await activeId(pp) })
  await pp.close()

  // ── 8 the whole site ──
  await p.bringToFront()
  const ring = await ringSince(p, t0)
  if (ring.bad.length) bad(`${name}: watchdogs fired`, ring.bad.slice(0, 6))
  else ok(`${name}: the watchdog ring stayed quiet`)
  await p.close()
}

export async function s22Keys() {
  scenario('s22 the keyboard: the player never hears the composer, tabs, unread, search, vi, escape')
  const tw = await liveChannels('twitch', 4)
  const kk = await liveChannels('kick', 4)
  const yt = await liveYtVideo()
  const env = await launch()
  const errs: string[] = []
  const cons: string[] = []
  const twSaved = tw.slice(1).map((c) => ({ id: c, twitch: c }))
  try {
    const legs = [
      ['twitch', `https://www.twitch.tv/${tw[0]}`, `https://www.twitch.tv/popout/${tw[0]}/chat`, twSaved],
      ['kick', `https://kick.com/${kk[0]}`, `https://kick.com/popout/${kk[0]}/chat`, kk.slice(1).map((c) => ({ id: `k-${c}`, kick: c }))],
      ...(yt ? [['youtube', `https://www.youtube.com/watch?v=${yt.id}`, `https://www.youtube.com/live_chat?is_popout=1&v=${yt.id}`, twSaved]] : []),
    ] as [string, string, string, { id: string; twitch?: string; kick?: string }[]][]
    if (!yt) info('youtube leg not run: no live video')
    for (const [name, url, popout, saved] of legs) {
      try {
        await site(env, name, url, popout, saved, errs, cons)
      } catch (e) {
        bad(`${name}: crashed in "${step}"`, String((e as Error)?.message || e).replace(/\u001b\[\d+m/g, '').slice(0, 1500))
      }
    }
    const hs = await extStorage(env, async () => {
      // @ts-ignore — extension page
      return ((await chrome.storage.local.get('hs_errors')).hs_errors || []).map((e: any) => String(e?.msg || e?.message || JSON.stringify(e)).slice(0, 160))
    })
    if ((hs as string[]).length) bad(`the add-on's error log holds ${(hs as string[]).length}`, (hs as string[]).slice(-3))
    else ok("the add-on's error log is empty")
    // kick's own pop-out page now and then throws a react hydration mismatch (#418) from its own script
    const mine = errs.filter((e) => !/Minified React error #(418|423|425)/.test(e))
    if (mine.length < errs.length) info(`the host's own react hydration errors left out: ${errs.length - mine.length}`)
    if (mine.length) bad(`${mine.length} page error(s)`, mine.slice(0, 5))
    else ok('no page errors')
    if (cons.length) bad(`${cons.length} console error(s) from our code`, cons.slice(0, 5))
    else ok('no console errors from our code')
  } finally {
    await setUiSetting(env, 'viMode', false).catch(() => {})
    await env.close()
  }
}

/**
 * s21 — chat hidden and shown, per tab, on twitch, kick and youtube.
 *
 *   - `\` hides the panel in this tab: the player takes the room back, the edge pill shows,
 *     and on youtube its own chat comes back (ours is hidden, so it is the only one)
 *   - a reload keeps the tab hidden, with no black bar painted where the panel would be
 *   - `\` shows it again; a reload keeps it shown
 *   - "start hidden": a new tab opens hidden with no pill and no black bar, `\` shows it, a
 *     reload keeps it shown, the next new tab is hidden again, a pop-out is never hidden;
 *     switching the setting off in a hidden tab brings the edge pill back
 *
 * Found here (11-17): a `\` hide never survived a reload (settings load wrote the stored
 * position over the tab's own flag), the nav re-arm painted the black bar in hidden tabs,
 * and youtube's chat stayed hidden under a hidden panel until one toggle.
 */
import { bad, info, launch, liveChannels, liveYtVideo, minusHostOwn, ok, scenario, setUiSetting, sleep, watchErrors } from './lib'

type Look = {
  hidden: boolean
  panel: number[]
  pill: boolean
  video: number[] | null
  ytChat: number[] | null
  shownLocal: string | null
  hiddenLocal: string | null
}

const look = (p: any): Promise<Look> =>
  p.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null
      const cs = getComputedStyle(el as HTMLElement)
      if (cs.display === 'none' || cs.visibility === 'hidden') return [0, 0, 0, 0]
      const r = (el as HTMLElement).getBoundingClientRect()
      return [r.left, r.top, r.width, r.height].map(Math.round)
    }
    // the biggest one: while an ad plays twitch keeps the stream in a small second video beside
    // it, and the first video in the page was that one (it "shrank" under a hide, nightly 11-18)
    const area = (x: Element) => {
      const r = x.getBoundingClientRect()
      return r.width * r.height
    }
    const v = [...document.querySelectorAll('video')]
      .filter((x) => x.getClientRects().length && !x.closest('#hs-mc-container'))
      .sort((a, b) => area(b) - area(a))[0]
    return {
      hidden: document.body.classList.contains('hs-chat-hidden'),
      panel: box(document.getElementById('hs-mc-container')) || [0, 0, 0, 0],
      pill: !!document.getElementById('hs-chat-restore-pill'),
      video: box(v || null),
      ytChat: box(document.querySelector('ytd-live-chat-frame')),
      shownLocal: sessionStorage.getItem('hs-chat-shown-local'),
      hiddenLocal: sessionStorage.getItem('hs-chat-hidden-local'),
    }
  })

/** Frames on which the black prepaint bar was up, counted from the first script of the load. */
async function watchPrepaint(p: any) {
  await p.addInitScript(() => {
    const t0 = performance.now()
    let n = 0
    const tick = () => {
      if (document.documentElement?.classList.contains('hs-prepaint-active')) n++
      ;(window as any).__hsPrepaintFrames = n
      if (performance.now() - t0 < 10_000) requestAnimationFrame(tick)
    }
    tick()
  })
}
const prepaintFrames = (p: any): Promise<number> => p.evaluate(() => (window as any).__hsPrepaintFrames || 0)

/** `\` with the page itself focused, the way a viewer presses it. */
async function backslash(p: any) {
  await p.bringToFront()
  await p.mouse.click(5, 5).catch(() => {})
  await p.keyboard.press('Backslash')
  await sleep(3000)
}

const SETTLE_MS = 12_000
const shown = (l: Look) => !l.hidden && l.panel[2] > 100 && l.panel[3] > 100
const gone = (l: Look) => l.hidden && l.panel[2] === 0

async function site(env: any, name: string, url: string, popout: string, errs: string[]) {
  const isYt = name === 'youtube'
  const check = (what: string, fails: string[], detail?: unknown) =>
    fails.length ? bad(`${name}: ${what}: ${fails.join('; ')}`, detail) : ok(`${name}: ${what}`)

  // ── \ in a tab, start-hidden off ──
  await setUiSetting(env, 'startChatHidden', false)
  const p = await env.ctx.newPage()
  watchErrors(p, name, errs)
  await watchPrepaint(p)
  await p.goto(url, { waitUntil: 'domcontentloaded' })
  await sleep(SETTLE_MS)
  const base = await look(p)
  if (!shown(base)) {
    bad(`${name}: the panel is not up on a live page`, base)
    return p.close()
  }
  await backslash(p)
  const h = await look(p)
  check(
    '\\ hides the panel, the pill shows, the player takes the room back',
    [
      ...(gone(h) ? [] : ['the panel is still on screen']),
      ...(h.pill ? [] : ['no edge pill']),
      ...(!isYt && base.video && h.video && h.video[2] <= base.video[2] ? ['the player did not grow'] : []),
      ...(isYt && (!h.ytChat || h.ytChat[2] < 100) ? ["youtube's own chat did not come back"] : []),
    ],
    { base, hidden: h },
  )
  await p.reload({ waitUntil: 'domcontentloaded' })
  await sleep(SETTLE_MS)
  const hr = await look(p)
  const bar = await prepaintFrames(p)
  check(
    'a reload keeps the tab hidden, no black bar',
    [
      ...(gone(hr) ? [] : ['chat came back']),
      ...(bar ? [`the black bar was up for ${bar} frames`] : []),
      ...(isYt && (!hr.ytChat || hr.ytChat[2] < 100) ? ["youtube's own chat is hidden too: no chat at all"] : []),
    ],
    hr,
  )
  await backslash(p)
  const s = await look(p)
  await p.reload({ waitUntil: 'domcontentloaded' })
  await sleep(SETTLE_MS)
  const sr = await look(p)
  check('\\ shows it again and a reload keeps it shown', [
    ...(shown(s) ? [] : ['\\ did not bring the panel back']),
    ...(shown(sr) ? [] : ['the reload hid it']),
    ...(isYt && sr.ytChat && sr.ytChat[2] > 0 ? ["youtube's chat shows beside ours"] : []),
  ])
  await p.close()

  // ── start hidden ──
  await setUiSetting(env, 'startChatHidden', true)
  // the first load on a site mirrors the setting where the next load's first script can read it
  const warm = await env.ctx.newPage()
  await warm.goto(url, { waitUntil: 'domcontentloaded' })
  await sleep(SETTLE_MS)
  const w = await look(warm)
  await warm.close()
  const q = await env.ctx.newPage()
  watchErrors(q, `${name}-start-hidden`, errs)
  await watchPrepaint(q)
  await q.goto(url, { waitUntil: 'domcontentloaded' })
  await sleep(SETTLE_MS)
  const a = await look(q)
  const bar2 = await prepaintFrames(q)
  check(
    'start hidden: a new tab opens hidden, no pill, no black bar',
    [
      ...(gone(w) ? [] : ['the first tab after switching it on was not hidden']),
      ...(gone(a) ? [] : ['the tab was not hidden']),
      ...(a.pill ? ['the edge pill shows'] : []),
      ...(bar2 ? [`the black bar was up for ${bar2} frames`] : []),
      ...(isYt && (!a.ytChat || a.ytChat[2] < 100) ? ["youtube's own chat is hidden too: no chat at all"] : []),
    ],
    a,
  )
  await backslash(q)
  const b = await look(q)
  await q.reload({ waitUntil: 'domcontentloaded' })
  await sleep(SETTLE_MS)
  const c = await look(q)
  check('start hidden: \\ shows chat in this tab and a reload keeps it', [
    ...(shown(b) ? [] : ['\\ did not show the panel']),
    ...(shown(c) ? [] : ['the reload hid it again']),
  ])
  const n = await env.ctx.newPage()
  await n.goto(url, { waitUntil: 'domcontentloaded' })
  await sleep(SETTLE_MS)
  const d = await look(n)
  await n.close()
  check('start hidden: the next new tab is hidden again', gone(d) ? [] : ['it opened with chat showing'], d)

  const pp = await env.ctx.newPage()
  watchErrors(pp, `${name}-popout`, errs)
  await pp.setViewportSize({ width: 400, height: 600 })
  await pp.goto(popout, { waitUntil: 'domcontentloaded' })
  await sleep(SETTLE_MS)
  const po = await look(pp)
  await pp.close()
  check('start hidden: a pop-out is never hidden', shown(po) ? [] : ['the pop-out opened with no chat'], po)

  // hide the tab again, then switch the setting off: the pill is the way back once more
  await backslash(q)
  const e = await look(q)
  await setUiSetting(env, 'startChatHidden', false)
  await sleep(3000)
  const f = await look(q)
  check('start hidden off in a hidden tab: the edge pill is back', [
    ...(gone(e) && !e.pill ? [] : ['with it on, a hidden tab still had the pill or was not hidden']),
    ...(gone(f) && f.pill ? [] : ['no pill after switching it off']),
  ])
  await q.close()
}

export async function s21Hide() {
  scenario('s21 chat hidden and shown per tab, and start hidden')
  const [tw] = await liveChannels('twitch', 1)
  const [kk] = await liveChannels('kick', 1)
  const yt = await liveYtVideo()
  const env = await launch()
  const errs: string[] = []
  try {
    await site(env, 'twitch', `https://www.twitch.tv/${tw}`, `https://www.twitch.tv/popout/${tw}/chat`, errs)
    await site(env, 'kick', `https://kick.com/${kk}`, `https://kick.com/popout/${kk}/chat`, errs)
    if (yt)
      await site(
        env,
        'youtube',
        `https://www.youtube.com/watch?v=${yt.id}`,
        `https://www.youtube.com/live_chat?is_popout=1&v=${yt.id}`,
        errs,
      )
    else info('youtube leg not run: no live video')
    // kick's pop-out hydration error: ours only if a browser with no extension does not throw it too
    const ours = await minusHostOwn(errs, /Minified React error #418/, `https://kick.com/popout/${kk}/chat`, 'kick pop-out', { width: 400, height: 600 })
    if (ours.length) bad('page errors', ours.slice(0, 5))
  } finally {
    await setUiSetting(env, 'startChatHidden', false).catch(() => {})
    await env.close()
  }
}

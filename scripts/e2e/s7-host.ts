/**
 * s7 — the host page's own look: twitch's light and dark theme, youtube and kick following
 * the system scheme, small and large windows, and browser zoom (css px shrink, pixels grow).
 *
 * Bugs of this shape that shipped: the first-run tour inherited twitch's light-theme ink
 * and went dark grey on black (6d555b5b), a panel measured before its host laid out
 * mounted at zero height (35207ce1), the player squeezed under its minimum width.
 *
 * Invariants on every host/size/zoom:
 *   - the panel is on screen with a usable size, and does not sit over the video
 *   - every piece of text in the panel reads against what is behind it (contrast ≥ 2; 2-3 is
 *     reported, not failed: the palette's red on a zebra stripe sits there by design)
 */
import {
  bad,
  info,
  launch,
  liveChannels,
  liveYtVideo,
  ok,
  rowsFlow,
  scenario,
  shot,
  sleep,
  waitPanel,
  watchErrors,
} from './lib'

type Case = { label: string; width: number; height: number; zoom: number; dark: boolean }
const CASES: Case[] = [
  { label: '1280x720', width: 1280, height: 720, zoom: 1, dark: false },
  { label: '1920x1080', width: 1920, height: 1080, zoom: 1, dark: true },
  { label: '1600x900@80%', width: 1600, height: 900, zoom: 0.8, dark: false },
  { label: '1600x900@125%', width: 1600, height: 900, zoom: 1.25, dark: true },
]

/** Panel geometry against the video, and every text run's contrast against its backdrop. */
async function look(p: any) {
  return p.evaluate(() => {
    const ct = document.getElementById('hs-mc-container')
    if (!ct) return { mounted: false }
    const r = ct.getBoundingClientRect()
    const vid = [...document.querySelectorAll('video')]
      .map((v) => v.getBoundingClientRect())
      .filter((v) => v.width > 200 && v.height > 100)
      .sort((x, y) => y.width * y.height - x.width * x.height)[0]
    const overlap = vid
      ? Math.max(0, Math.min(r.right, vid.right) - Math.max(r.left, vid.left)) *
        Math.max(0, Math.min(r.bottom, vid.bottom) - Math.max(r.top, vid.top))
      : 0
    const rgb = (c: string) => (c.match(/[\d.]+/g) || []).map(Number)
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const backdrop = (el: Element | null): number[] => {
      for (let e = el; e; e = e.parentElement) {
        const c = rgb(getComputedStyle(e).backgroundColor)
        if (c.length >= 3 && (c.length < 4 || c[3] > 0.5)) return c
      }
      return [255, 255, 255] // nothing painted behind: the page canvas
    }
    const low: string[] = [] // unreadable: the ink-inheritance / same-colour class
    const dim: string[] = [] // readable but weak (a palette colour on a zebra stripe)
    let checked = 0
    const walker = document.createTreeWalker(ct, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n && checked < 600; n = walker.nextNode()) {
      const el = n.parentElement
      const text = (n.textContent || '').trim()
      if (!el || !text) continue
      const er = el.getBoundingClientRect()
      if (!er.width || !er.height || er.bottom < r.top || er.top > r.bottom) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.3) continue
      // a painted name draws its text with its own background (clipped to the glyphs): its
      // colours are a gradient this cannot measure, and it is not the ink-inheritance class
      let painted = false
      for (let e: Element | null = el; e && e !== ct; e = e.parentElement) {
        const c = getComputedStyle(e) as any
        if (c.backgroundClip === 'text' || c.webkitBackgroundClip === 'text') painted = true
      }
      if (painted) continue
      checked++
      const fill = rgb((cs as any).webkitTextFillColor || '')
      const fg = lum(fill.length >= 3 && (fill.length < 4 || fill[3] > 0) ? fill : rgb(cs.color))
      const bg = lum(backdrop(el))
      const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
      if (ratio < 3)
        (ratio < 2 ? low : dim).push(
          `${ratio.toFixed(1)} "${text.slice(0, 24)}" ${cs.color} on ${backdrop(el).join(',')} <${el.className}>`,
        )
    }
    return {
      mounted: true,
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      inView: r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight,
      overlap: Math.round(overlap),
      checked,
      low: low.slice(0, 8),
      lowN: low.length,
      dim: [...new Set(dim.map((d) => d.replace(/^[\d.]+ "[^"]*" /, '')))].slice(0, 4),
    }
  })
}

async function runCase(site: 'twitch' | 'youtube' | 'kick', url: string, c: Case) {
  // browser zoom = fewer css px across the same window, each drawn bigger
  const env = await launch({
    width: Math.round(c.width / c.zoom),
    height: Math.round(c.height / c.zoom),
    scale: c.zoom,
  })
  const errs: string[] = []
  const label = `${site} ${c.label} ${c.dark ? 'dark' : 'light'}`
  try {
    const p = await env.ctx.newPage()
    await p.emulateMedia({ colorScheme: c.dark ? 'dark' : 'light' })
    if (site === 'twitch')
      await p.addInitScript((dark: boolean) => {
        try {
          localStorage.setItem('twilight.theme', dark ? '1' : '0')
        } catch {}
      }, c.dark)
    watchErrors(p, label, errs)
    await p.goto(url, { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(p))) return bad(`${label}: panel never mounted`)
    await rowsFlow(p, 30_000)
    await sleep(3000)
    const l: any = await look(p)
    info(`${label}: ${JSON.stringify({ box: l.box, overlap: l.overlap, checked: l.checked, lowN: l.lowN })}`)
    const problems: string[] = []
    if (!l.mounted || !l.inView) problems.push('panel not on screen')
    else if (l.box[2] < 200 || l.box[3] < 150) problems.push(`panel too small to use (${l.box[2]}x${l.box[3]})`)
    if (l.overlap > 2000) problems.push(`panel covers ${l.overlap}px² of the video`)
    if (l.lowN) problems.push(`${l.lowN} text runs below contrast 2`)
    if (l.dim?.length) info(`${label}: weak contrast (2-3), by style: ${JSON.stringify(l.dim)}`)
    if (problems.length) {
      bad(`${label}: ${problems.join('; ')}`, l.low)
      await shot(p, `s7-${site}-${c.label}-${c.dark ? 'dark' : 'light'}`)
    } else ok(`${label}: panel on screen, clear of the video, every text run readable (${l.checked} checked)`)
    if (errs.length) bad(`${label}: page errors`, errs.slice(0, 5))
  } finally {
    await env.close()
  }
}

export async function s7Host() {
  scenario('s7 host themes, sizes and zoom')
  const [tw] = await liveChannels('twitch', 1)
  const [kk] = await liveChannels('kick', 1)
  const yt = await liveYtVideo()
  for (const c of CASES) {
    await runCase('twitch', `https://www.twitch.tv/${tw}`, c)
    await runCase('kick', `https://kick.com/${kk}`, c)
    if (yt) await runCase('youtube', `https://www.youtube.com/watch?v=${yt.id}`, c)
  }
}

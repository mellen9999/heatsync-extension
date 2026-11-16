/**
 * s6 — settings changed mid-session, on a live twitch stream, the way the settings page
 * writes them (chrome.storage.sync ui_settings from an extension page).
 *
 * Bugs of this shape that shipped: an applier that only styled rows drawn after the change
 * (old rows kept the old look), a flip back that left the panel somewhere new, a setting
 * that threw in the page and left the panel half-applied.
 *
 * Each live setting: flipped, the panel must follow without a reload; flipped back, it must
 * read exactly as before. The per-site off switch is decided at boot: after a reload the
 * page keeps its own chat and heatsync stays out; switched back on, the panel returns.
 */
import {
  bad,
  type Env,
  info,
  launch,
  liveChannels,
  ok,
  panel,
  ringSince,
  rowsFlow,
  scenario,
  setUiSetting,
  shot,
  sleep,
  waitPanel,
  watchErrors,
} from './lib'

/** What a share of the panel's rows carry: none, all, or a mix (a mix after settling = stale rows). */
function share(sel: string) {
  return `(() => {
    const rows = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].filter((r) => !r.matches('[class*="event"],[class*="notice"],[class*="system"]'))
    const n = rows.filter((r) => r.matches(${JSON.stringify(sel)}) || r.querySelector(${JSON.stringify(sel)})).length
    return !rows.length ? 'no rows' : n === 0 ? 'none' : n === rows.length ? 'all' : 'mixed ' + n + '/' + rows.length
  })()`
}
const rowStyle = (prop: string) => `(() => {
  const r = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')].at(-1)
  return r ? getComputedStyle(r)[${JSON.stringify(prop)}] : 'no rows'
})()`
const box = (sel: string) => `(() => {
  const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect()
  return r ? [r.left, r.top, r.width, r.height].map(Math.round).join(',') : 'absent'
})()`

type Case = { key: string; from: unknown; to: unknown; probe: string; what: string }
const CASES: Case[] = [
  { key: 'timestamps', from: false, to: true, probe: share('.hs-mc-ts'), what: 'rows with a timestamp' },
  {
    key: 'zebra',
    from: true,
    to: false,
    // every other row: 'striped' when roughly half carry the stripe
    probe: `(() => {
      const rows = document.querySelectorAll('#hs-mc-messages .hs-mc-msg')
      const n = document.querySelectorAll('#hs-mc-messages .hs-mc-msg.hs-mc-zebra').length
      return !rows.length ? 'no rows' : n === 0 ? 'none' : Math.abs(n / rows.length - 0.5) < 0.15 ? 'striped' : 'mixed ' + n + '/' + rows.length
    })()`,
    what: 'striped rows',
  },
  { key: 'avatars', from: false, to: true, probe: share('.hs-mc-avatar'), what: 'rows with an avatar' },
  {
    key: 'showPlatformBadges',
    from: true,
    to: false,
    probe: share('.hs-mc-platform-badge'),
    what: 'rows with a platform badge',
  },
  { key: 'messageDensity', from: 'compact', to: 'cozy', probe: rowStyle('paddingTop'), what: 'row padding' },
  { key: 'fontSize', from: 15, to: 18, probe: rowStyle('fontSize'), what: 'row font size' },
  { key: 'chatPosition', from: 'right', to: 'left', probe: box('#hs-mc-container'), what: 'panel box' },
  { key: 'tabPosition', from: 'top', to: 'left', probe: box('#hs-mc-tabbar'), what: 'tab strip box' },
  {
    key: 'hiddenTabs',
    from: ['pinned', 'modlog', 'discover'],
    to: [],
    probe: `[...document.querySelectorAll('.hs-mc-tab[data-tab]')].filter((t) => t.getClientRects().length).length`,
    what: 'tabs shown in the strip',
  },
]

async function read(p: any, probe: string) {
  return p.evaluate(probe).catch((e: unknown) => `threw: ${String(e).slice(0, 120)}`)
}

/** Read until two reads 1s apart agree (an applier may restyle over a frame or two). */
async function settled(p: any, probe: string) {
  let last = await read(p, probe)
  for (let i = 0; i < 8; i++) {
    await sleep(1000)
    const now = await read(p, probe)
    if (JSON.stringify(now) === JSON.stringify(last)) return now
    last = now
  }
  return last
}

async function nativeChat(p: any) {
  return p
    .evaluate(() => !!document.querySelector('[data-a-target="chat-scroller"], .chat-scrollable-area__message-container'))
    .catch(() => false)
}

async function siteSwitch(env: Env, p: any, url: string) {
  await setUiSetting(env, 'subsystems', { 'overlay-twitch': false, 'overlay-kick': true, 'overlay-youtube': true })
  await p.goto(url, { waitUntil: 'domcontentloaded' })
  await sleep(10_000)
  const mounted = await p.evaluate(() => !!document.getElementById('hs-mc-container')).catch(() => true)
  const own = await nativeChat(p)
  if (mounted) bad('heatsync switched off on twitch: after a reload the panel still mounts')
  else if (!own) {
    bad('heatsync switched off on twitch: the page shows no chat of its own')
    await shot(p, 's6-off-no-chat')
  } else ok('switched off on twitch: after a reload the page keeps its own chat and heatsync stays out')
  await setUiSetting(env, 'subsystems', { 'overlay-twitch': true, 'overlay-kick': true, 'overlay-youtube': true })
  await p.goto(url, { waitUntil: 'domcontentloaded' })
  if (!(await waitPanel(p)) || !(await rowsFlow(p, 30_000))) bad('switched back on: the panel did not return with chat flowing')
  else ok('switched back on: the panel returns with chat flowing')
}

export async function s6Settings() {
  scenario('s6 settings changed mid-session')
  const [chan] = await liveChannels('twitch', 1)
  const url = `https://www.twitch.tv/${chan}`
  const env = await launch()
  const errs: string[] = []
  try {
    const p = await env.ctx.newPage()
    watchErrors(p, `twitch ${chan}`, errs)
    await p.goto(url, { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(p))) return bad('panel never mounted')
    if (!(await rowsFlow(p, 45_000))) return bad('chat never started flowing', await panel(p))
    await sleep(5000)
    const t0 = Date.now()

    for (const c of CASES) {
      await setUiSetting(env, c.key, c.from)
      const before = await settled(p, c.probe)
      await setUiSetting(env, c.key, c.to)
      const flipped = await settled(p, c.probe)
      await setUiSetting(env, c.key, c.from)
      const back = await settled(p, c.probe)
      info(`${c.key} ${JSON.stringify(c.from)}→${JSON.stringify(c.to)}→back: ${c.what} ${before} → ${flipped} → ${back}`)
      const stale = [flipped, back].find((v) => String(v).startsWith('mixed') || String(v).startsWith('threw'))
      if (stale) {
        bad(`${c.key}: ${c.what} read "${stale}" after the panel settled`, { before, flipped, back })
        await shot(p, `s6-${c.key}`)
      } else if (JSON.stringify(flipped) === JSON.stringify(before))
        bad(`${c.key}: the panel did not follow the change without a reload (${c.what} stayed ${before})`)
      else if (JSON.stringify(back) !== JSON.stringify(before)) {
        bad(`${c.key}: flipped back, ${c.what} reads ${back}, was ${before}`)
        await shot(p, `s6-${c.key}-back`)
      } else ok(`${c.key}: follows live and flips back exactly`)
    }
    if (!(await rowsFlow(p, 30_000))) bad('after the settings churn, chat is still', await panel(p))
    const ring = await ringSince(p, t0)
    if (ring.bad.length) bad('overlay watchdogs fired during the settings churn', ring.bad.slice(0, 6))

    await siteSwitch(env, p, url)
    if (errs.length) bad('page errors', errs.slice(0, 5))
  } finally {
    await env.close()
  }
}

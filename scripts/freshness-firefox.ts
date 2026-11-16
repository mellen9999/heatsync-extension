/**
 * Does the twitch chat in the panel keep up with the stream, in real Firefox?
 *
 *   bun run test:freshness:firefox                    (builds dist/firefox first)
 *   CHAN=somechannel bun scripts/freshness-firefox.ts (dist/firefox already built)
 *   STEPS=base,hidden,offline,update,nav              (default: all of them)
 *   EXT_DIR=/path/to/another/dist/firefox             (A/B an older build)
 *
 * Opt-in, not part of `bun test`: it needs firefox, geckodriver, the network and
 * a busy live twitch channel. Logged out, so it drives the anonymous reader.
 *
 * Ground truth is an independent anonymous IRC socket in this process. For every
 * sample it asks: of the lines twitch sent 4 to 12 seconds ago, how many does
 * the panel show? A healthy panel shows ~99% (emote names read from each image's
 * alt; the rest is lines the panel hides on purpose). Each step then breaks
 * something the way real life does and measures the recovery:
 *
 *   base     nothing happens
 *   hidden   the tab sits in the background (HIDE_MS, default 2 min)
 *   offline  the network drops for 45s
 *   update   the add-on is reinstalled with the page open (an update)
 *   nav      twitch's own router leaves the channel and comes back
 *
 * Written after a viewer reported chat going stale and sends needing a refresh
 * (2026-11-11). It exits non-zero when a step shows under MIN_PCT (default 75).
 */
import { assertFirefoxBuilt, FF_EXT_DIR, launchFirefox } from './lib/firefox'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const steps = (process.env.STEPS || 'base,hidden,offline,update,nav').split(',')
const HIDE_MS = Number(process.env.HIDE_MS || 120_000)
const MIN_PCT = Number(process.env.MIN_PCT || 75)
// big channels, probed for the busiest when CHAN is not given
const CANDIDATES = (
  process.env.CHANS ||
  'kaicenat,xqc,jynxzi,caseoh_,zackrawrr,summit1g,hasanabi,ibai,auronplay,caedrel,stableronaldo,tarik,ohnepixel,shroud,lacy'
).split(',')

type Line = { at: number; key: string }
const truth: Line[] = []

function ircKey(name: string, text: string) {
  return `${name}: ${text}`.replace(/\s+/g, ' ').slice(0, 40).toLowerCase()
}

// lines per channel over `ms`, from one anonymous socket
async function busiest(chans: string[], ms: number): Promise<string> {
  const n = new Map<string, number>()
  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443')
  ws.onopen = () => {
    ws.send(`NICK justinfan${Math.floor(Math.random() * 90000 + 10000)}\r\n`)
    ws.send(`JOIN ${chans.map((c) => `#${c}`).join(',')}\r\n`)
  }
  ws.onmessage = (e) => {
    for (const l of String(e.data).split('\r\n')) {
      if (l.startsWith('PING')) ws.send('PONG :tmi.twitch.tv\r\n')
      const m = l.match(/PRIVMSG #(\w+) :/)
      if (m) n.set(m[1], (n.get(m[1]) || 0) + 1)
    }
  }
  await sleep(ms)
  ws.close()
  const [top] = [...n].sort((a, b) => b[1] - a[1])
  if (!top || top[1] < 10) throw new Error(`no busy channel among ${chans.join(',')} — pass CHAN=`)
  return top[0]
}

function truthSocket(chan: string) {
  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443')
  ws.onopen = () => {
    ws.send(`NICK justinfan${Math.floor(Math.random() * 90000 + 10000)}\r\n`)
    ws.send('CAP REQ :twitch.tv/tags\r\n')
    ws.send(`JOIN #${chan}\r\n`)
  }
  ws.onmessage = (e) => {
    for (const l of String(e.data).split('\r\n')) {
      if (l.startsWith('PING')) ws.send('PONG :tmi.twitch.tv\r\n')
      const m = l.match(/display-name=([^;]*);.* PRIVMSG #\w+ :(.*)$/)
      if (m) truth.push({ at: Date.now(), key: ircKey(m[1], m[2]) })
    }
  }
  ws.onclose = () => setTimeout(() => truthSocket(chan), 1000)
}

const EXT = process.env.EXT_DIR || FF_EXT_DIR
if (!process.env.EXT_DIR) assertFirefoxBuilt()
const chan = process.env.CHAN || (await busiest(CANDIDATES, 15_000))
truthSocket(chan)
const ff = await launchFirefox()
const t0 = Date.now()
const ts = () => `${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s`
const results: { label: string; pct: number }[] = []

async function fresh() {
  const now = Date.now()
  const want = truth.filter((l) => l.at > now - 12_000 && l.at < now - 4_000)
  const panel = await ff.page<string | null>(`
    const el = document.getElementById('hs-mc-messages')
    if (!el) return null
    // an emote draws as an image: read its name from alt, or every emote line reads as missing
    const text = (r) => {
      let t = ''
      const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (n.nodeType === 3) t += n.nodeValue
        else if (n.tagName === 'IMG' && n.alt) t += n.alt
      }
      return t
    }
    return [...el.children].slice(-250).map((r) => text(r).replace(/\\s+/g, ' ').toLowerCase()).join('\\n')`)
  if (panel === null) return { want: want.length, got: -1 }
  return { want: want.length, got: want.filter((l) => panel.includes(l.key)).length }
}

async function watch(label: string, ms: number, every = 4000) {
  const rows: string[] = []
  let want = 0
  let got = 0
  for (let t = 0; t < ms; t += every) {
    await sleep(every)
    const f = await fresh()
    rows.push(f.got < 0 ? 'NOPANEL' : `${f.got}/${f.want}`)
    if (f.got >= 0) {
      want += f.want
      got += f.got
    }
  }
  const pct = want ? Math.round((100 * got) / want) : 0
  console.log(`${ts()} ${label}: ${pct}% shown  [${rows.join(' ')}]`)
  results.push({ label, pct })
}

let code = 0
try {
  console.log(`firefox ${ff.version}, add-on ${await ff.install(EXT)}, #${chan}`)
  await ff.goto(`https://www.twitch.tv/${chan}`)
  for (let i = 0; i < 20 && (await fresh()).got < 0; i++) await sleep(1500)
  if (!(await ff.ensureVisible())) throw new Error('the twitch tab reads hidden: every number below would be about a hidden pane')
  await sleep(6000)

  if (steps.includes('base')) await watch('baseline (40s)', 40_000)

  if (steps.includes('hidden')) {
    console.log(`${ts()} twitch tab in the background for ${HIDE_MS / 1000}s`)
    await ff.cover(HIDE_MS)
    await watch('back from the background (first 40s)', 40_000)
  }

  if (steps.includes('offline')) {
    await ff.privileged('Services.io.offline = true; return 1')
    console.log(`${ts()} network off for 45s`)
    await sleep(45_000)
    await ff.privileged('Services.io.offline = false; return 1')
    await sleep(5000)
    await watch('after the network came back (60s)', 60_000)
  }

  if (steps.includes('update')) {
    console.log(`${ts()} add-on reinstalled with the page open`)
    await ff.install(EXT)
    await sleep(3000)
    const panels = await ff.page<number>(`return document.querySelectorAll('#hs-mc-container').length`)
    if (panels !== 1) console.log(`${ts()} ${panels} panels on the page after the update`)
    await watch('after an update (60s)', 60_000)
  }

  if (steps.includes('nav')) {
    const href = await ff.page<string>(`
      const a = [...document.querySelectorAll('a[href^="/"]')].find((x) => /^\\/[a-z0-9_]{3,25}$/i.test(x.getAttribute('href') || '') && x.getAttribute('href').toLowerCase() !== '/${chan}' && x.closest('nav, [class*="side-nav"], [data-a-target*="side-nav"]'))
      if (!a) return ''
      a.click()
      return a.getAttribute('href')`)
    console.log(`${ts()} left for ${href || '(no link found)'} and came back`)
    await sleep(6000)
    await ff.page('history.back(); return 1')
    await sleep(6000)
    await watch('after leaving and coming back (40s)', 40_000)
  }
} catch (e) {
  // the finally below exits: without this, a crash left no results and exited 0, a pass
  console.log(`${ts()} crashed: ${String((e as Error)?.stack || e).slice(0, 600)}`)
  code = 1
} finally {
  console.log(`\n${results.map((r) => `${r.pct >= MIN_PCT ? 'ok  ' : 'LOW '} ${r.pct}%  ${r.label}`).join('\n')}`)
  if (!results.length || results.some((r) => r.pct < MIN_PCT)) code = 1
  await ff.close()
  process.exit(code)
}

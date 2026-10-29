/**
 * What do the viewer's own hands cost in the overlay?
 *
 *   bun run build.js chrome --minify && CHROMIUM_BIN=/usr/bin/chromium bun scripts/interaction-ext.ts [cpu=1]
 *
 * render-extension.ts asserts geometry; heap-*.ts assert memory. Nothing measured
 * latency: how long a hover, an unhover, a tab click, a keystroke or a send keeps
 * the page's main thread busy. That is what "feels like a native app" is made of,
 * and the only way to find it is to trace it — guessing from the source ranked the
 * wrong things first more than once.
 *
 * Same fixture trick as render-extension: a twitch URL is fulfilled locally and the
 * extension injects for real; irc-ws.chat.twitch.tv is mapped to a local wss mock
 * that pushes a few hundred rows into three channels. Nothing leaves the machine
 * (heatsync.org is aborted). REAL input (playwright mouse/keyboard -> CDP
 * Input.dispatch*) with a devtools trace around each phase; per step it reports
 * the main-thread task time, style+layout, and paint.
 *
 * The renderer (buildMessageDiv / renderMessages), the hover handlers, the tab bar
 * and the composer are one code path for twitch, kick and youtube, so one platform
 * measures all three; only how rows ARRIVE differs.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertBuilt, launchWithExtension } from './lib/chromium'

assertBuilt()
const CPU = Number(process.argv[2] || 1)
const CHANNELS = ['probechan', 'probetwo', 'probethree']
const ROWS = 400

const pct = (v: number[], q: number) => {
  if (!v.length) return 0
  const s = [...v].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]
}
const f = (n: number) => n.toFixed(1).padStart(7)

function startMockIrc() {
  const certDir = mkdtempSync(join(tmpdir(), 'hs-ext-irc-cert-'))
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'), '-days', '1', '-nodes', '-subj', '/CN=irc-ws.chat.twitch.tv'],
    { stdio: 'ignore' },
  )
  const sockets = new Set<any>()
  const server = Bun.serve({
    port: 0,
    tls: { key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) },
    fetch(req: Request, srv: any) {
      if (srv.upgrade(req)) return undefined as any
      return new Response('no', { status: 400 })
    },
    websocket: {
      open(ws: any) { sockets.add(ws) },
      close(ws: any) { sockets.delete(ws) },
      message(ws: any, msg: any) {
        for (const line of String(msg).split('\r\n')) {
          if (line.startsWith('NICK')) ws.send(`:tmi.twitch.tv 001 ${line.slice(5).trim() || 'probeuser'} :Welcome, GLOBUSERSTATE\r\n`)
          else if (line.startsWith('JOIN')) {
            ws.send(`:probeuser!p@p.tmi.twitch.tv JOIN ${line.slice(5).trim()}\r\n`)
            // history for the channel just joined: a full pane the moment it opens
            const chan = line.slice(5).trim()
            for (let i = 0; i < ROWS; i++) ws.send(row(chan, i))
          } else if (line.startsWith('PRIVMSG')) {
            const m = line.match(/^PRIVMSG (#\S+) :(.*)$/)
            if (m) for (const c of sockets) c.send(`@display-name=probeuser;color=#FF8700;user-id=1;id=echo-${Date.now()} :probeuser!p@p.tmi.twitch.tv PRIVMSG ${m[1]} :${m[2]}\r\n`)
          }
        }
      },
    },
  })
  return { port: server.port, stop() { server.stop(true); rmSync(certDir, { recursive: true, force: true }) } }
}

const WORDS = ['hello', 'chat', 'this', 'is', 'fine', 'lol', 'nice', 'play', 'gg', 'pog', 'wow', 'true']
/** One PRIVMSG with a colour, a badge, a twitch-native emote on every third row and an @mention on every seventh. */
function row(chan: string, i: number) {
  const user = `viewer${i % 120}`
  const body = `${WORDS[i % 12]} ${WORDS[(i * 7) % 12]} Kappa ${i % 7 === 0 ? `@viewer${(i + 1) % 120} ` : ''}${WORDS[(i * 5) % 12]}`
  const emotes = i % 3 === 0 ? `emotes=25:${WORDS[i % 12].length + 1 + WORDS[(i * 7) % 12].length + 1}-${WORDS[i % 12].length + 1 + WORDS[(i * 7) % 12].length + 5};` : ''
  return `@badge-info=;badges=subscriber/12;${emotes}display-name=${user};color=#${((i * 2654435) & 0xffffff).toString(16).padStart(6, '0')};user-id=${1000 + (i % 120)};id=msg-${chan}-${i};tmi-sent-ts=${Date.now() - (ROWS - i) * 1000} :${user}!${user}@${user}.tmi.twitch.tv PRIVMSG ${chan} :${body}\r\n`
}

const irc = startMockIrc()
const prof = mkdtempSync(join(tmpdir(), 'hs-ext-interaction-'))
const ctx = await launchWithExtension(prof, [
  '--window-size=1500,900',
  `--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1:${irc.port}`,
  '--ignore-certificate-errors',
  '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
])
try {
  await ctx.route('https://heatsync.org/**', (r: any) => r.abort())
  await ctx.route('https://www.twitch.tv/**', (r: any) =>
    r.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>fixture</title></head><body style="margin:0"><div id="host-content" style="height:100vh">host page</div><div class="right-column right-column--beside" id="rcol"></div></body></html>',
    }),
  )
  await ctx.addCookies([
    { name: 'auth-token', value: 'harnesstoken0000', domain: '.twitch.tv', path: '/', secure: true },
    { name: 'login', value: 'probeuser', domain: '.twitch.tv', path: '/', secure: true },
  ])
  let sw = ctx.serviceWorkers()[0]
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20_000 })
  const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
  if (!id) throw new Error('no extension id')
  const seed = await ctx.newPage()
  await seed.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
  await seed.evaluate(async (chs: string[]) => {
    // @ts-ignore — extension page
    await chrome.storage.local.set({
      heatsync_multichat: { channels: chs.map((c) => ({ id: c, twitch: c, kick: '', youtube: '' })) },
      user_info: { username: 'probeuser' },
    })
  }, CHANNELS)
  await seed.close()

  const p = await ctx.newPage()
  // Layout shift while the overlay loads: what moved under the reader's eyes, and when.
  await p.addInitScript(() => {
    ;(window as any).__ls = []
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as any[]) {
        if (e.hadRecentInput) continue
        ;(window as any).__ls.push({ t: Math.round(e.startTime), v: +e.value.toFixed(4), src: (e.sources || []).slice(0, 3).map((s: any) => `${s.node?.nodeName?.toLowerCase()}.${String(s.node?.className || '').slice(0, 30)} ${Math.round(s.previousRect.y)}→${Math.round(s.currentRect.y)} h${Math.round(s.previousRect.height)}→${Math.round(s.currentRect.height)}`) })
      }
    }).observe({ type: 'layout-shift', buffered: true } as any)
  })
  await p.goto('https://www.twitch.tv/probechan', { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('#hs-mc-input', { timeout: 25_000 })
  await p.waitForFunction((n: number) => document.querySelectorAll('#hs-mc-messages .hs-mc-msg').length >= n, 150, { timeout: 30_000 })
  await p.waitForTimeout(3000)
  // Boot timeline, from the extension's own diag ring: which phase the first row waited on.
  const boot = await p.evaluate(() => {
    try {
      const ring = JSON.parse(localStorage.getItem('hs_diag_ring') || '[]')
      const t = ring.filter((x: any) => x.e === 'init-timing').slice(-1)[0]
      const nav = performance.getEntriesByType('navigation')[0] as any
      return { marks: t?.marks || t?.d?.marks || null, raw: t ? Object.keys(t) : [], domContentLoaded: Math.round(nav.domContentLoadedEventEnd) }
    } catch (e) { return { err: String(e) } }
  })
  console.log(`boot: ${JSON.stringify(boot)}`)
  const ls = await p.evaluate(() => (window as any).__ls as { t: number; v: number; src: string[] }[])
  console.log(`layout shift during load: ${ls.reduce((a, e) => a + e.v, 0).toFixed(4)} over ${ls.length} shifts`)
  for (const e of ls.slice(0, 12)) console.log(`  ${String(e.t).padStart(5)}ms ${e.v}  ${e.src.join(' | ')}`)
  const cdp = await ctx.newCDPSession(p)
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU })
  await p.evaluate(() => {
    ;(window as any).__eo = []
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as any[]) (window as any).__eo.push({ n: e.name, d: Math.round(e.duration) })
    }).observe({ type: 'event', durationThreshold: 16 } as any)
  })

  const geo = await p.evaluate(() => {
    const m = document.getElementById('hs-mc-messages')!
    const r = m.getBoundingClientRect()
    const rows = [...m.querySelectorAll('.hs-mc-msg')]
    const first = rows[rows.length - 5]
    return {
      pane: { x: r.x, y: r.y, w: r.width, h: r.height },
      rows: rows.length,
      dom: document.getElementsByTagName('*').length,
      kids: first ? [...first.children].map((c) => `${c.tagName.toLowerCase()}.${(c as HTMLElement).className}`.slice(0, 50)) : [],
      tabs: [...document.querySelectorAll('#hs-mc-tabbar .hs-mc-tab')].map((e) => {
        const b = e.getBoundingClientRect()
        return { t: (e.textContent || '').slice(0, 12), x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width }
      }).filter((t) => t.w > 0),
      // channel tabs only: feed / whispers / settings draw their own panes and are a different cost
      chanTabs: [...document.querySelectorAll('#hs-mc-tabbar .hs-mc-tab')].map((e) => {
        const b = e.getBoundingClientRect()
        return { t: (e.textContent || '').trim(), x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width }
      }).filter((t) => t.w > 0 && /probe/i.test(t.t)),
    }
  })
  console.log(`ext overlay · twitch fixture · cpu x${CPU} · pane ${Math.round(geo.pane.w)}x${Math.round(geo.pane.h)} · rows ${geo.rows} · dom ${geo.dom} · tabs ${geo.tabs.length}`)
  console.log(`row children: ${JSON.stringify(geo.kids)}`)

  const rowAt = async (frac: number) =>
    p.evaluate((fr: number) => {
      const m = document.getElementById('hs-mc-messages')!
      const rs = [...m.querySelectorAll('.hs-mc-msg')].filter((e) => { const r = e.getBoundingClientRect(); return r.bottom > m.getBoundingClientRect().top + 4 && r.top < m.getBoundingClientRect().bottom - 4 })
      const el = rs[Math.floor(rs.length * fr)]
      if (!el) return null
      const user = el.querySelector('a.hs-mc-user') as HTMLElement | null
      // an emote anywhere on screen: only some rows carry one
      const emote = (rs.map((r) => r.querySelector('img.hs-mc-emote, img[class*="emote"]')).find(Boolean) as HTMLElement | undefined) || null
      const R = (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } }
      return { row: R(el), user: user ? R(user) : null, emote: emote ? R(emote) : null }
    }, frac)

  // PROFILE=hover-emote,tab-click prints the top self-time functions of those
  // phases (build WITHOUT --minify to read the names).
  const profiled = new Set((process.env.PROFILE || '').split(',').filter(Boolean))
  async function phase(name: string, steps: number, run: (i: number) => Promise<void>) {
    const prof = profiled.has(name)
    if (prof) {
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.setSamplingInterval', { interval: 100 })
      await cdp.send('Profiler.start')
    }
    const events: any[] = []
    const onData = (m: any) => events.push(...m.value)
    cdp.on('Tracing.dataCollected', onData)
    const done = new Promise((res) => cdp.once('Tracing.tracingComplete', res))
    await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: ['devtools.timeline', 'toplevel', ...(process.env.INVAL ? ['disabled-by-default-devtools.timeline.invalidationTracking'] : [])] } })
    await p.evaluate(() => { ;(window as any).__eo.length = 0 })
    for (let i = 0; i < steps; i++) {
      await run(i)
      await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    }
    await p.waitForTimeout(300)
    await cdp.send('Tracing.end')
    await done
    cdp.off('Tracing.dataCollected', onData)
    if (prof) {
      const { profile } = await cdp.send('Profiler.stop')
      const self = new Map<number, number>()
      profile.samples.forEach((sid: number, i: number) => self.set(sid, (self.get(sid) || 0) + (profile.timeDeltas[i] || 0)))
      const byId = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]))
      const agg = new Map<string, number>()
      for (const [sid, us] of self) {
        const c = byId.get(sid).callFrame
        const k = `${c.functionName || '(anon)'} ${String(c.url).split('/').pop()}:${c.lineNumber + 1}`
        agg.set(k, (agg.get(k) || 0) + us)
      }
      // Inclusive time (a function plus everything it called): self time alone names the
      // leaf that burned the cycles; this names the caller that asked for them.
      const incl = new Map<number, number>()
      const parent = new Map<number, number>()
      for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id)
      for (const [sid, us] of self) {
        const seen = new Set<string>()
        for (let id: number | undefined = sid; id !== undefined; id = parent.get(id)) {
          const c = byId.get(id).callFrame
          const k = `${c.functionName || '(anon)'} ${String(c.url).split('/').pop()}:${c.lineNumber + 1}`
          if (seen.has(k)) continue
          seen.add(k)
          incl.set(k as any, (incl.get(k as any) || 0) + us)
        }
      }
      console.log(`  ${name} inclusive time, top 14 (ms over ${steps} steps):`)
      for (const [k, us] of [...incl].sort((a, b) => (b[1] as number) - (a[1] as number)).filter(([k]) => !String(k).startsWith('(')).slice(0, 14)) console.log(`${((us as number) / 1000).toFixed(1).padStart(9)}  ${k}`)
      // PROFILE_TREE=fn: where fn's own time goes, one level down (what it called, inclusive).
      if (process.env.PROFILE_TREE) {
        const sub = new Map<string, number>()
        const totalOf = (id: number): number => (self.get(id) || 0) + (byId.get(id).children || []).reduce((a: number, c: number) => a + totalOf(c), 0)
        for (const n of profile.nodes) {
          if (n.callFrame.functionName !== process.env.PROFILE_TREE) continue
          for (const c of n.children || []) {
            const cf = byId.get(c).callFrame
            const k = `${cf.functionName || '(anon)'} ${String(cf.url).split('/').pop()}:${cf.lineNumber + 1}`
            sub.set(k, (sub.get(k) || 0) + totalOf(c))
          }
          sub.set('(self)', (sub.get('(self)') || 0) + (self.get(n.id) || 0))
        }
        console.log(`  ${name}: ${process.env.PROFILE_TREE} callees (inclusive ms over ${steps} steps):`)
        for (const [k, us] of [...sub].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`${(us / 1000).toFixed(1).padStart(9)}  ${k}`)
      }
      console.log(`  ${name} self time, top 18 (ms over ${steps} steps):`)
      for (const [k, us] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(`${(us / 1000).toFixed(1).padStart(9)}  ${k}`)
    }
    const main = new Set(events.filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map((e) => `${e.pid}:${e.tid}`))
    const on = (e: any) => e.ph === 'X' && main.has(`${e.pid}:${e.tid}`)
    const sum = (...ns: string[]) => events.filter((e) => on(e) && ns.includes(e.name)).reduce((a, e) => a + e.dur, 0) / 1000
    const tasks = events.filter((e) => on(e) && e.name === 'ThreadControllerImpl::RunTask').map((e) => e.dur / 1000)
    if (process.env.INVAL && profiled.has(name)) {
      // Why was style recalculated? Count invalidations by reason + what changed + on which node.
      const why = new Map<string, number>()
      for (const e of events) {
        if (e.name !== 'StyleRecalcInvalidationTracking' && e.name !== 'StyleInvalidatorInvalidationTracking') continue
        const d = e.args?.data || {}
        const k = `${d.reason || '?'} | ${d.extraData || d.invalidationSet || ''} | ${String(d.nodeName || '').slice(0, 60)}`
        why.set(k, (why.get(k) || 0) + 1)
      }
      console.log(`  ${name} style invalidations, top 10 (count over ${steps} steps):`)
      for (const [k, n] of [...why].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`${String(n).padStart(8)}  ${k}`)
    }
    const eo: { n: string; d: number }[] = await p.evaluate(() => (window as any).__eo.slice())
    // Event Timing's duration is input -> next paint, the delay the eye sees. Entries below
    // 16ms are not reported at all, so the count is "steps a person could notice".
    const seen = (names: RegExp) => {
      const d = eo.filter((e) => names.test(e.n)).map((e) => e.d)
      return d.length ? ` · ${names.source.replace(/[\^$()]/g, '')} >=16ms: ${d.length}/${steps} (max ${Math.max(...d)}, p50 ${pct(d, 0.5)})` : ''
    }
    const felt = seen(/^click$/) + seen(/^keydown$/) + seen(/^mousedown$/)
    console.log(
      `${name.padEnd(12)} ${String(steps).padStart(3)} steps · per step: task${f(sum('ThreadControllerImpl::RunTask') / steps)}ms layout${f(sum('UpdateLayoutTree', 'Layout') / steps)}ms paint${f(sum('Paint', 'PrePaint', 'Layerize', 'Commit') / steps)}ms · worst task${f(Math.max(0, ...tasks))}ms p95${f(pct(tasks, 0.95))}ms · slow events ${eo.filter((e) => !/^(pointer|mouse)(over|out|enter|leave|move)$/.test(e.n)).length}${felt}`,
    )
  }

  // The floor: the same steps with no input at all. Everything the overlay does on
  // its own (timers, observers, a background tab's rows) lands in every phase below,
  // so each phase is read against this line, not against zero.
  await phase('idle', 30, async () => { await p.waitForTimeout(120) })
  const pos = await rowAt(0.5)
  const cx = geo.pane.x + geo.pane.w * 0.4
  if (pos?.user) {
    await phase('hover-user', 30, async (i) => {
      const t = await rowAt(0.15 + (i % 14) * 0.06)
      if (t?.user) await p.mouse.move(t.user.x, t.user.y, { steps: 2 })
      await p.waitForTimeout(120)
    })
  } else console.log('hover-user    skipped — no username element found')
  await phase('unhover', 20, async () => {
    const t = await rowAt(0.5)
    if (t?.user) await p.mouse.move(t.user.x, t.user.y)
    await p.waitForTimeout(80)
    await p.mouse.move(Math.max(2, geo.pane.x - 40), geo.pane.y + 40)
  })
  const em = await rowAt(0.5)
  if (em?.emote) {
    await phase('hover-emote', 20, async () => {
      const t = await rowAt(0.5)
      if (t?.emote) await p.mouse.move(t.emote.x, t.emote.y)
      await p.waitForTimeout(80)
      await p.mouse.move(Math.max(2, geo.pane.x - 40), geo.pane.y + 40)
    })
  } else console.log('hover-emote   skipped — no emote element on screen')
  await p.mouse.move(cx, geo.pane.y + geo.pane.h / 2)
  await phase('wheel', 40, async () => { await p.mouse.wheel(0, -240); await p.waitForTimeout(16) })
  if (geo.chanTabs.length > 1) {
    await phase('tab-click', geo.chanTabs.length * 8, async (i) => {
      const t = geo.chanTabs[i % geo.chanTabs.length]
      await p.mouse.click(t.x, t.y)
      // a person reads before the next click: let the deferred row mounts finish, or the
      // next click pays for the last one's leftovers and the number is the bench's, not theirs
      await p.waitForTimeout(700)
    })
  } else console.log('tab-click     skipped — one tab')
  await p.focus('#hs-mc-input')
  const text = 'hello chat Kappa this is a test message with some words in it'
  await phase('type', text.length, async (i) => { await p.keyboard.type(text[i]) })
  await phase('send', 1, async () => { await p.keyboard.press('Enter') })
} finally {
  await ctx.close().catch(() => {})
  irc.stop()
  rmSync(prof, { recursive: true, force: true })
}

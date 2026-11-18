/**
 * s29 — the network misbehaves: all of it goes dark and comes back, the page starts on a slow
 * line, and the worker's own heatsync socket drops. Signed out, read-only: nothing is ever
 * sent to any chat (the independent twitch feed below only reads; it sends NICK/JOIN/PONG).
 *
 *   bun scripts/e2e/run.ts --only s29
 *
 * What the code promises (read, not guessed):
 *   twitch chat arrives through the worker's own irc socket (background/09-irc.js). When it
 *   closes the worker retries at 2s·2^n capped at 15s plus up to 2s of jitter (bgIrcScheduleReconnect);
 *   a socket that looks open but is silent is torn down after 90s of silence, checked on a 20s
 *   beat (bgIrcStartHeartbeat). Every reconnect owes each joined channel one refill of its recent
 *   lines from heatsync.org/api/recent-messages (bgIrcFetchRobotty), at once or when the 30s
 *   cooldown ends, merged by message id: a gap is refilled only to what that server holds.
 *   So after the network returns, live chat is back within 17s + 10s connect on a socket that
 *   noticed, and within ~110s on one that did not (90s silence + the 20s beat): ceiling 120s.
 *   The refill of the outage window itself is reported, not asserted: it depends on what the
 *   server held. After the window of "20s past recovery" nothing may be missing.
 *
 * Legs
 *   1 twitch  whole network off 25s then on: panel up and drawn through it, chat back within the
 *             ceiling, no row twice, rows in order, quiet ring and no page error. Beside it an
 *             independent anonymous irc socket from this process collects every message id:
 *             from 20s after recovery to the last id both saw, no id the feed has is missing
 *             from the list, none drawn twice (a message the extension hides by design, or one a
 *             mod deleted, does not count: the hide settings are off by default)
 *   1 kick, youtube  the same outage, page-level checks only (no independent feed: kick's
 *             pusher and youtube's innertube have no anonymous read this process could hold)
 *   2 twitch  a fresh page on a slow line (400 kbps, 400ms): panel mounts within 150s, first rows
 *             arrive, and 10s after the line is lifted no emote or badge picture in the list
 *             is in the error state
 *   3 twitch  the worker's heatsync socket cut (new connections refused, the open one closed):
 *             it reconnects within 30s of the cut lifting and re-joins the channel's rooms;
 *             page chat never stops meanwhile. State comes from the worker's own globals
 *             (wsState, socket, reconnectAttempts) and the frames it sends.
 */
import {
  bad,
  type Env,
  info,
  launch,
  liveChannels,
  liveYtVideo,
  ok,
  panel,
  ringSince,
  rowsFlow,
  scenario,
  shot,
  sleep,
  swState,
  waitPanel,
  watchErrors,
} from './lib'

const OFFLINE_S = 25
const RECOVER_CEILING_S = 120 // see the header: 90s silence + the 20s beat, with room for a connect
const SLOW_MOUNT_CEILING_S = 150
const WORKER_RECONNECT_CEILING_S = 30 // 15s backoff cap + 1s jitter + 10s connect timeout

// ── the independent feed ──────────────────────────────────────────────────────
type Line = { id: string; ts: number; user: string }
/** An anonymous read-only irc socket on a channel. Never sends a chat line. */
function openFeed(channel: string) {
  const lines: Line[] = []
  const deletedIds = new Set<string>()
  const clearedUsers = new Set<string>() // user ids a timeout or ban hit
  const userOf = new Map<string, string>() // message id → user id
  let alive = false
  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443')
  ws.onopen = () => {
    ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands\r\n')
    ws.send(`NICK justinfan${Math.floor(10_000 + Math.random() * 89_999)}\r\n`)
    ws.send(`JOIN #${channel}\r\n`)
  }
  ws.onmessage = (e) => {
    for (const raw of String(e.data).split('\r\n')) {
      if (!raw) continue
      if (raw.startsWith('PING')) {
        ws.send(raw.replace('PING', 'PONG') + '\r\n')
        continue
      }
      if (!raw.startsWith('@')) continue
      const sp = raw.indexOf(' ')
      const tags: Record<string, string> = {}
      for (const kv of raw.slice(1, sp).split(';')) {
        const i = kv.indexOf('=')
        tags[kv.slice(0, i)] = kv.slice(i + 1)
      }
      const rest = raw.slice(sp + 1)
      const cmd = rest.split(' ')[rest.startsWith(':') ? 1 : 0]
      if (cmd === 'PRIVMSG' && tags.id) {
        alive = true
        lines.push({ id: tags.id, ts: Number(tags['tmi-sent-ts']) || Date.now(), user: tags['user-id'] || '' })
        userOf.set(tags.id, tags['user-id'] || '')
      } else if (cmd === 'CLEARMSG' && tags['target-msg-id']) deletedIds.add(tags['target-msg-id'])
      else if (cmd === 'CLEARCHAT' && tags['target-user-id']) clearedUsers.add(tags['target-user-id'])
    }
  }
  return {
    lines,
    deletedIds,
    clearedUsers,
    isAlive: () => alive,
    gone: (l: Line) => deletedIds.has(l.id) || (!!l.user && clearedUsers.has(l.user)),
    close: () => {
      try {
        ws.close()
      } catch {}
    },
  }
}

// ── reading the list ──────────────────────────────────────────────────────────
type Row = { key: string; id: string; time: number; ord: number }
async function rowsOf(p: any): Promise<Row[]> {
  return p
    .evaluate(() =>
      ([...document.querySelectorAll('#hs-mc-messages > .hs-mc-msg[data-msg-key]')] as HTMLElement[]).map((r) => ({
        key: r.dataset.msgKey || '',
        id: r.dataset.msgId || '',
        time: Number(r.dataset.msgTime || 0),
        ord: Number(r.dataset.hsOrd || r.dataset.msgTime || 0),
      })),
    )
    .catch(() => [] as Row[])
}
/** keys and ids that appear more than once */
function dupesOf(rows: Row[]) {
  const seenK = new Set<string>()
  const seenI = new Set<string>()
  const out: string[] = []
  for (const r of rows) {
    if (r.key && seenK.has(r.key)) out.push(`key ${r.key.slice(0, 40)}`)
    seenK.add(r.key)
    if (r.id) {
      if (seenI.has(r.id)) out.push(`id ${r.id.slice(0, 40)}`)
      seenI.add(r.id)
    }
  }
  return out
}
/** rows drawn under a row more than 5s newer than they are (the same rule as s20) */
function lateOf(rows: Row[]) {
  let max = 0
  const late: string[] = []
  rows.forEach((r, i) => {
    if (r.ord && max - r.ord > 5000) late.push(`${i}:${Math.round((max - r.ord) / 1000)}s`)
    if (r.ord > max) max = r.ord
  })
  return late
}
const statusText = (p: any) =>
  p
    .evaluate(() => (document.getElementById('hs-mc-statusbar')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80))
    .catch(() => '?')

/**
 * The worker's half of "the network is off". context.setOffline reaches the pages only: the
 * worker's open irc socket, its kick socket and its fetches carry on (proved by a run where rows
 * sent during the outage still arrived). So the worker is cut by hand: every new socket refused,
 * every fetch rejected, and the sockets it holds closed so the product sees a real drop.
 */
async function workerNet(env: Env, down: boolean) {
  await env.worker().evaluate((down: boolean) => {
    const g = globalThis as any
    g.__e2eNetDown = down
    if (!g.__e2eNetPatched) {
      g.__e2eNetPatched = true
      const WS0 = g.WebSocket
      g.WebSocket = class extends WS0 {
        constructor(u: any, pr?: any) {
          if (g.__e2eNetDown) throw new TypeError('e2e: network down')
          super(u, pr)
        }
      }
      const f0 = g.fetch
      g.fetch = function (...a: any[]) {
        if (g.__e2eNetDown) return Promise.reject(new TypeError('Failed to fetch'))
        return f0.apply(this, a)
      }
    }
    if (down) {
      const close = (w: any) => {
        try {
          w?.close()
        } catch {}
      }
      // @ts-ignore — worker globals
      if (typeof BG_IRC !== 'undefined') close(BG_IRC.ws)
      // @ts-ignore
      if (typeof socket !== 'undefined') close(socket)
      // @ts-ignore
      if (typeof _kpWs !== 'undefined') close(_kpWs)
    }
  }, down)
}

// ── 1 the whole network off, then on ──────────────────────────────────────────
async function outageLeg(
  env: Env,
  name: 'twitch' | 'kick' | 'youtube',
  url: string,
  channel: string,
  errs: string[],
  offlineS: number,
): Promise<'done' | 'quiet'> {
  const t0 = Date.now()
  const errs0 = errs.length
  const p = await env.ctx.newPage()
  watchErrors(p, name, errs)
  const feed = name === 'twitch' ? openFeed(channel) : null
  const check = (what: string, fails: string[], detail?: unknown) =>
    fails.length ? bad(`${name}: ${what}: ${fails.join('; ')}`, detail) : ok(`${name}: ${what}`)
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(p)) || !(await rowsFlow(p, 45_000))) {
      bad(`${name}: chat never flowed before the outage`, await panel(p))
      return 'done'
    }
    // 20s of watching: enough live rows to tell a stall from a quiet chat, and the feed time to join
    const k0 = new Set((await rowsOf(p)).map((r) => r.key))
    await sleep(20_000)
    const before = await rowsOf(p)
    const fresh = before.filter((r) => !k0.has(r.key)).length
    if (before.length < 30 || fresh < 3) {
      info(`${name} ${channel}: ${before.length} rows, ${fresh} new in 20s, too quiet to judge`)
      return 'quiet'
    }
    if (feed && !feed.isAlive()) info(`${name}: the independent feed has seen no line yet`)

    // ── network off ──
    const offAt = Date.now()
    info(`${name}: network off for ${offlineS}s`)
    await env.ctx.setOffline(true)
    await workerNet(env, true)
    const during: { rows: number; mounted: boolean; status: string }[] = []
    const samples: Row[][] = []
    for (let i = 0; i < offlineS / 5; i++) {
      await sleep(5000)
      const pn = await panel(p)
      during.push({ rows: pn.rows ?? 0, mounted: !!pn.mounted, status: await statusText(p) })
      samples.push(await rowsOf(p))
    }
    const last = during.at(-1)
    // proof the outage bit: rows sent during it, and the worker's irc socket state at its end
    const liveDuring = (samples.at(-1) || []).filter((r) => r.time > offAt + 2000).length
    const ircSock = await env.worker().evaluate(() => (typeof BG_IRC !== 'undefined' ? BG_IRC.ws?.readyState ?? null : 'n/a')).catch(() => 'err')
    info(`${name}: during the outage ${liveDuring} rows sent after it began reached the list; worker irc socket state ${ircSock} (1 = still open)`)
    check('the panel stays up and drawn while the network is off', [
      ...(during.every((d) => d.mounted) ? [] : ['the panel left the page']),
      ...(during.every((d) => d.rows > 0) ? [] : ['the list went empty']),
    ], during)
    info(`${name}: what the panel says while offline: "${last?.status}" (${last?.rows} rows)`)

    // ── network on ──
    await env.ctx.setOffline(false)
    await workerNet(env, false)
    const backAt = Date.now()
    let flowedAt = 0
    const seenSamples: Row[][] = []
    while (Date.now() - backAt < RECOVER_CEILING_S * 1000) {
      await sleep(1500)
      const rows = await rowsOf(p)
      seenSamples.push(rows)
      // a live row: sent after the network came back (the refill carries older lines)
      if (rows.some((r) => r.time >= backAt - 1500)) {
        flowedAt = Date.now()
        break
      }
    }
    if (flowedAt) ok(`${name}: chat is back ${Math.round((flowedAt - backAt) / 1000)}s after the network returned (ceiling ${RECOVER_CEILING_S}s)`)
    else bad(`${name}: no live row ${RECOVER_CEILING_S}s after the network returned`, await panel(p))
    if (name !== 'twitch' || !feed) {
      // the page-level legs: settle, then judge the whole list
      await sleep(20_000)
    } else {
      // wait out "20s past recovery" and 40s of window to compare in
      await sleep(Math.max(0, backAt + 80_000 - Date.now()))
    }
    // the promise: every reconnect owes the channel one refill of its recent lines, at once or when the
    // 30s cooldown ends (background/09-irc.js). Judged by the worker's last-fetch stamp passing the
    // moment the network returned; a drop in the first minute after the join is the case on purpose
    let refillS = -1
    if (name === 'twitch') {
      for (let t = Date.now(); Date.now() - t < 45_000; await sleep(1000)) {
        const at = await env.worker().evaluate((ch: string) => BG_IRC.lastRobottyAt.get(ch) || 0, channel).catch(() => 0)
        if (at > backAt) {
          refillS = Math.round((at - backAt) / 1000)
          break
        }
      }
      check('a history refill starts within 45s of the network returning', refillS >= 0 ? [] : ['the worker asked for no history after the reconnect'])
      if (refillS >= 0) info(`twitch: the refill started ${refillS}s after the network returned`)
    }
    const after = await rowsOf(p)
    const everyDupe = [...samples, ...seenSamples, after].flatMap(dupesOf)
    check('no row twice, at any moment through the outage and the recovery', [...new Set(everyDupe)].slice(0, 4))
    check('rows are in order after the outage', lateOf(after).length ? [`${lateOf(after).length} rows under a newer row (${lateOf(after).slice(0, 5).join(' ')})`] : [])

    // ── against the independent feed ──
    if (feed) {
      const byId = new Map(after.filter((r) => r.id).map((r) => [r.id, r]))
      const gap = feed.lines.filter((l) => l.ts >= offAt && l.ts <= backAt)
      const gapHave = gap.filter((l) => byId.has(l.id)).length
      info(`twitch: the outage window ${Math.round((backAt - offAt) / 1000)}s held ${gap.length} feed lines, the list has ${gapHave}`)
      // where did the gap lines go: the worker's buffer, the server's recent-messages, the list
      const ids = gap.map((l) => l.id)
      const inBuf = await env
        .worker()
        .evaluate(
          ([ch, ids]: [string, string[]]) => {
            // @ts-ignore — worker global
            const have = new Set((BG_IRC.channels.get(ch)?.getAll() || []).map((m: any) => m.id))
            // @ts-ignore
            return { n: ids.filter((i) => have.has(i)).length, robottyAgoS: Math.round((Date.now() - (BG_IRC.lastRobottyAt.get(ch) || 0)) / 1000) }
          },
          [channel, ids] as [string, string[]],
        )
        .catch(() => ({ n: -1, robottyAgoS: -1 }))
      const srv: any = await fetch(`https://heatsync.org/api/recent-messages/${channel}?limit=1000`).then((r) => r.json()).catch(() => null)
      const srvText = JSON.stringify(srv?.messages || [])
      info(`twitch: of the ${gap.length} gap lines the worker holds ${inBuf.n}, the server's recent-messages holds ${ids.filter((i) => srvText.includes(i)).length}; last history fetch ${inBuf.robottyAgoS}s ago`)
      const srvHeld = ids.filter((i) => srvText.includes(i))
      info(`twitch: of the gap lines the server held ${srvHeld.length}, the list has ${srvHeld.filter((i) => byId.has(i)).length} (reported, not asserted: it depends on what the server held)`)
      const winStart = backAt + 20_000
      // the newest feed line the list also holds ends the window
      const seenBoth = feed.lines.filter((l) => byId.has(l.id) && l.ts >= winStart)
      if (!seenBoth.length) bad('twitch: no line in the comparison window is on both sides', { feed: feed.lines.length, rows: after.length })
      else {
        const winEnd = Math.max(...seenBoth.map((l) => l.ts))
        // the list holds only so many rows: a window older than its oldest row cannot be judged
        const oldest = Math.min(...after.filter((r) => r.time).map((r) => r.time))
        const from = Math.max(winStart, oldest)
        const inWin = feed.lines.filter((l) => l.ts >= from && l.ts <= winEnd)
        const missing = inWin.filter((l) => !byId.has(l.id) && !feed.gone(l))
        const goneN = inWin.filter((l) => feed.gone(l)).length
        info(`twitch: window ${Math.round((winEnd - from) / 1000)}s, ${inWin.length} feed lines (${goneN} deleted), list rows ${after.length}`)
        check(
          'nothing the feed saw is missing from the list, from 20s after recovery',
          inWin.length < 3 ? ['the window held too few lines to judge'] : missing.length ? [`${missing.length} of ${inWin.length} missing (${missing.slice(0, 3).map((l) => l.id.slice(0, 8)).join(' ')})`] : [],
        )
      }
      check(
        'no message id drawn twice in the list',
        (() => {
          const seen = new Set<string>()
          const dup: string[] = []
          for (const r of after) if (r.id) (seen.has(r.id) ? dup.push(r.id.slice(0, 8)) : seen.add(r.id))
          return dup.slice(0, 4)
        })(),
      )
    }

    const ring = await ringSince(p, t0)
    check('no page error, a quiet watchdog ring', [
      ...errs.slice(errs0, errs0 + 2),
      ...ring.bad.slice(0, 3).map((e: any) => `${e.e} ${JSON.stringify(e).slice(0, 120)}`),
    ])
    return 'done'
  } finally {
    await env.ctx.setOffline(false).catch(() => {})
    await workerNet(env, false).catch(() => {})
    feed?.close()
    await shot(p, `s29-outage-${name}`)
    await p.close().catch(() => {})
  }
}

// ── 2 slow start ──────────────────────────────────────────────────────────────
async function slowLeg(env: Env, channel: string, errs: string[]): Promise<'done' | 'quiet'> {
  const t0 = Date.now()
  const errs0 = errs.length
  const p = await env.ctx.newPage()
  watchErrors(p, 'slow', errs)
  const cdp = await env.ctx.newCDPSession(p)
  const slow = { offline: false, latency: 400, downloadThroughput: (400 * 1000) / 8, uploadThroughput: (400 * 1000) / 8 }
  try {
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', slow)
    let bytes = 0
    cdp.on('Network.loadingFinished', (e: any) => {
      bytes += e.encodedDataLength || 0
    })
    const g0 = Date.now()
    await p.goto(`https://www.twitch.tv/${channel}`, { waitUntil: 'commit', timeout: 60_000 })
    const m0 = Date.now()
    const mounted = await waitPanel(p, SLOW_MOUNT_CEILING_S * 1000)
    if (!mounted) {
      bad(`slow: the panel did not mount within ${SLOW_MOUNT_CEILING_S}s on a 400kbps line`, await panel(p))
      return 'done'
    }
    ok(`slow: the panel mounted ${Math.round((Date.now() - m0) / 1000)}s after the page started (ceiling ${SLOW_MOUNT_CEILING_S}s)`)
    let rows = 0
    for (let i = 0; i < 60 && rows < 5; i++) {
      await sleep(1000)
      rows = (await panel(p)).rows ?? 0
    }
    if (rows < 5) bad('slow: the first rows never arrived on the slow line', await panel(p))
    else ok(`slow: first rows arrived (${rows}) while the line was still slow`)
    info(`slow: the page pulled ${Math.round(bytes / 1024)} KB in ${Math.round((Date.now() - g0) / 1000)}s (a 400kbps line moves about 50 KB/s)`)
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await sleep(10_000)
    const pics = await p.evaluate(() => {
      const imgs = [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg img')] as HTMLImageElement[]
      const broken = imgs.filter((i) => i.complete && i.naturalWidth === 0)
      return {
        n: imgs.length,
        broken: broken.length,
        sample: broken.slice(0, 3).map((i) => {
          try {
            return `${i.className.slice(0, 30)} ${new URL(i.src).hostname}`
          } catch {
            return i.className.slice(0, 30)
          }
        }),
      }
    })
    info(`slow: ${pics.n} pictures in the list 10s after the line was lifted`)
    if (pics.broken) bad(`slow: ${pics.broken} of ${pics.n} pictures are in the error state 10s after the line was lifted`, pics.sample)
    else ok('slow: no picture in the list is in the error state')
    if (!(await rowsFlow(p, 30_000))) bad('slow: chat never flowed once the line was lifted', await panel(p))
    const ring = await ringSince(p, t0)
    const fails = [...errs.slice(errs0, errs0 + 2), ...ring.bad.slice(0, 3).map((e: any) => `${e.e} ${JSON.stringify(e).slice(0, 120)}`)]
    if (fails.length) bad(`slow: no page error, a quiet watchdog ring: ${fails.join('; ')}`)
    else ok('slow: no page error, a quiet watchdog ring')
    return 'done'
  } finally {
    await shot(p, 's29-slow')
    await cdp.detach().catch(() => {})
    await p.close().catch(() => {})
  }
}

// ── 3 the worker's heatsync socket ────────────────────────────────────────────
const workerSocket = (env: Env) =>
  env
    .worker()
    .evaluate(() => {
      // classic-script globals of background/05-ws.js
      const g = globalThis as any
      return {
        wsState: typeof wsState !== 'undefined' ? wsState : null,
        open: typeof socket !== 'undefined' && socket ? socket.readyState : null,
        attempts: typeof reconnectAttempts !== 'undefined' ? reconnectAttempts : null,
        sent: (g.__e2eSent as string[] | undefined) ?? [],
        // @ts-ignore
        online: navigator.onLine,
      }
    })
    .catch((e: unknown) => ({ wsState: null, open: null, attempts: null, sent: [] as string[], online: null, err: String(e) }))

async function workerLeg(env: Env, channel: string, errs: string[]): Promise<'done' | 'quiet'> {
  const t0 = Date.now()
  const errs0 = errs.length
  const p = await env.ctx.newPage()
  watchErrors(p, 'worker', errs)
  try {
    await p.goto(`https://www.twitch.tv/${channel}`, { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(p)) || !(await rowsFlow(p, 45_000))) {
      bad('worker: chat never flowed before the cut', await panel(p))
      return 'done'
    }
    await sleep(8000)
    const s0 = await workerSocket(env)
    info(`worker: socket before: ${JSON.stringify({ wsState: s0.wsState, open: s0.open, attempts: s0.attempts })}`)
    if (s0.wsState == null) {
      info('worker: the worker exposes no socket state to read (wsState missing): leg not run')
      return 'done'
    }
    if (s0.open !== 1) {
      bad('worker: the heatsync socket is not open before the cut', s0)
      return 'done'
    }
    // refuse new heatsync sockets, record every frame the worker sends, then close the open one
    await env.worker().evaluate(() => {
      const g = globalThis as any
      g.__e2eSent = []
      g.__e2eWS ||= g.WebSocket
      const Orig = g.__e2eWS
      g.WebSocket = class extends Orig {
        constructor(u: any, pr?: any) {
          if (g.__e2eCut && /heatsync\.org\/ws/.test(String(u))) throw new TypeError('e2e: socket refused')
          super(u, pr)
          if (/heatsync\.org\/ws/.test(String(u))) {
            const send = this.send.bind(this)
            this.send = (d: any) => {
              try {
                g.__e2eSent.push(String(JSON.parse(d)?.type))
              } catch {}
              return send(d)
            }
          }
        }
      }
      g.__e2eCut = true
      // @ts-ignore — the live socket
      socket.close()
    })
    const cutAt = Date.now()
    info('worker: heatsync socket closed and new ones refused for 20s')
    let flows = true
    const k0 = (await rowsOf(p)).at(-1)?.key
    await sleep(20_000)
    const mid = await workerSocket(env)
    const kMid = (await rowsOf(p)).at(-1)?.key
    if (kMid === k0) flows = false
    if (flows) ok('worker: page chat kept flowing while the heatsync socket was cut')
    else bad('worker: page chat stopped while only the heatsync socket was cut', await panel(p))
    info(`worker: during the cut: ${JSON.stringify({ wsState: mid.wsState, open: mid.open, attempts: mid.attempts })}; page says "${await statusText(p)}"`)
    if (mid.open === 1) bad('worker: the socket reads open during the cut: the cut did not hold', mid)

    await env.worker().evaluate(() => {
      ;(globalThis as any).__e2eCut = false
    })
    const liftAt = Date.now()
    let back = false
    let s1: any
    while (Date.now() - liftAt < WORKER_RECONNECT_CEILING_S * 1000) {
      await sleep(1000)
      s1 = await workerSocket(env)
      if (s1.open === 1) {
        back = true
        break
      }
    }
    if (back) ok(`worker: the heatsync socket reconnected ${Math.round((Date.now() - liftAt) / 1000)}s after the cut lifted (ceiling ${WORKER_RECONNECT_CEILING_S}s)`)
    else bad(`worker: the heatsync socket did not reconnect within ${WORKER_RECONNECT_CEILING_S}s of the cut lifting`, s1)
    if (back) {
      // the connect burst is spaced 80ms apart: let it drain
      await sleep(5000)
      const s2 = await workerSocket(env)
      const types = new Set(s2.sent)
      info(`worker: frames sent after the cut: ${[...types].join(', ')}`)
      if (types.has('channel:join') || types.has('irc:join')) ok('worker: the rooms were re-joined on the new socket')
      else bad('worker: the new socket sent no join for the channel (no channel:join, no irc:join)', [...types])
      if (s2.attempts) bad(`worker: reconnect counter is not back to 0 (${s2.attempts})`, s2)
    }
    if (!(await rowsFlow(p, 30_000))) bad('worker: page chat never flowed after the socket came back', await panel(p))
    info(`worker: the cut lasted ${Math.round((liftAt - cutAt) / 1000)}s`)
    const ring = await ringSince(p, t0)
    const fails = [...errs.slice(errs0, errs0 + 2), ...ring.bad.slice(0, 3).map((e: any) => `${e.e} ${JSON.stringify(e).slice(0, 120)}`)]
    if (fails.length) bad(`worker: no page error, a quiet watchdog ring: ${fails.join('; ')}`)
    else ok('worker: no page error, a quiet watchdog ring')
    const sw = await swState(env)
    if ((sw as any).errs?.length) info(`worker: hs_errors holds ${(sw as any).errs.length}: ${(sw as any).errs.slice(0, 2).join(' | ')}`)
    return 'done'
  } finally {
    await env
      .worker()
      .evaluate(() => {
        const g = globalThis as any
        g.__e2eCut = false
        if (g.__e2eWS) g.WebSocket = g.__e2eWS
      })
      .catch(() => {})
    await shot(p, 's29-worker')
    await p.close().catch(() => {})
  }
}

export async function s29Network() {
  scenario('s29 network: all of it off then on, a slow start, the worker socket cut')
  const tw = await liveChannels('twitch', 4)
  const kk = await liveChannels('kick', 3)
  const yt = await liveYtVideo()
  const env = await launch()
  const errs: string[] = []
  const guard = async (name: string, f: () => Promise<'done' | 'quiet'>) => {
    try {
      return await f()
    } catch (e) {
      bad(`${name}: the leg crashed: ${String((e as Error)?.message || e).slice(0, 200)}`)
      return 'done' as const
    }
  }
  try {
    let used = 0
    // each leg takes the next busy channel if the one it got is too quiet to judge
    const run = async (name: 'twitch' | 'kick' | 'youtube', chans: string[], f: (c: string) => Promise<'done' | 'quiet'>) => {
      for (const [i, c] of chans.entries()) {
        if ((await guard(name, () => f(c))) === 'done') return c
        info(`${name}: ${i + 1 < chans.length ? 'trying the next channel' : 'no channel busy enough'}`)
      }
      bad(`${name}: no channel was busy enough to judge`)
      return chans[0]
    }
    const base = await run('twitch', tw, (c) => outageLeg(env, 'twitch', `https://www.twitch.tv/${c}`, c, errs, OFFLINE_S))
    used = tw.indexOf(base)
    const rest = [...tw.slice(used), ...tw.slice(0, used)]
    await run('twitch', rest, (c) => slowLeg(env, c, errs))
    await run('twitch', rest, (c) => workerLeg(env, c, errs))
    await run('kick', kk, (c) => outageLeg(env, 'kick', `https://kick.com/${c}`, c, errs, 20))
    if (yt) await guard('youtube', () => outageLeg(env, 'youtube', `https://www.youtube.com/watch?v=${yt.id}`, yt.id, errs, 20))
    else info('youtube leg not run: no live video')
  } finally {
    await env.close()
  }
}

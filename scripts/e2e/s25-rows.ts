/**
 * s25 — the row oracle: read every row the overlay actually drew, on a busy live channel on
 * each of twitch, kick and youtube (signed out, nothing is sent). One cheap oracle over three
 * parsers: whatever the site's chat says, the rows that come out must look the same.
 *
 *   bun scripts/e2e/run.ts --only s25
 *
 * Per site, once ≥150 rows are on screen, and again after 60s more of chat:
 *   1 text hygiene   no leaked placeholder, double-escaped entity, control char or raw tag
 *   2 pictures       every picture in the visible part of the list loaded and has a size
 *   3 identity       no key twice, a name on every chat row, only this site's platform mark
 *   4 links          http(s) only, rel noopener, new tab
 *   5 palette        plain rows never filled, filled rows from the fixed set, ≥13px, square
 *   6 filter rules   one hide + one highlight rule, written to storage the way settings hold them
 *   7 the watchdog ring stayed quiet and no page error came from our code
 *
 * Rules are applied the way the product applies a changed setting: chrome.storage.local
 * `chat_filter_rules` (a JSON string) fires onChanged in the pane (main-storage.js), which
 * recompiles and repaints — no reload. A hide rule acts at ingest (main.js / social.js), before
 * the buffer, so rows already on screen are not taken back: only rows that arrive after count.
 */
import { bad, extStorage, info, launch, liveChannels, liveYtVideo, ok, ringSince, scenario, shot, sleep, waitPanel, watchErrors } from './lib'

type Env = Awaited<ReturnType<typeof launch>>
type Plat = 'twitch' | 'kick' | 'youtube'

// the mark class each platform's rows wear (palette.js MARKS); [H] marks a row that is provably ours
const MARK: Record<Plat, string> = { twitch: 'twitch', kick: 'kick', youtube: 'yt' }
// pictures from these hosts are ours to keep working; any one broken is a finding
const FIRST_PARTY = /(^|\.)(heatsync\.org|static-cdn\.jtvnw\.net|kick\.com|yt3\.ggpht\.com)$/
const ROW_SEL = '#hs-mc-messages .hs-mc-msg, #hs-mc-messages .hs-mc-stream-event'

type Hit = { check: string; key: string; detail: unknown }

const readLocal = (env: Env, key: string) =>
  // @ts-ignore — extension page
  extStorage(env, async (k: string) => (await chrome.storage.local.get(k))[k] ?? null, key) as Promise<any>
const writeLocal = (env: Env, key: string, val: unknown) =>
  extStorage(
    env,
    async ([k, v]: [string, unknown]) => {
      // @ts-ignore — extension page
      if (v === null) await chrome.storage.local.remove(k)
      // @ts-ignore
      else await chrome.storage.local.set({ [k]: v })
    },
    [key, val],
  )

/** the whole read of rows on screen: text, identity, links, palette — everything but pictures */
const scanRows = (p: any, markCls: string): Promise<{ rows: number; keys: number; hits: Hit[] }> =>
  p.evaluate(
    ([sel, mark]: [string, string]) => {
      const hits: { check: string; key: string; detail: unknown }[] = []
      const hit = (check: string, key: string, detail: unknown) => hits.push({ check, key, detail })
      const hex = (c: string) => {
        const m = c.match(/rgba?\(([^)]+)\)/)
        if (!m) return c
        const [r, g, b, a] = m[1].split(',').map((x) => Number.parseFloat(x))
        if (a === 0) return 'transparent'
        return `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`
      }
      const PLAIN_OK = new Set(['transparent', '#000000', '#444444'])
      // the fixed fill set: olive purple navy teal red(+stripe) + the rule-colour twins (maroon, green)
      const FILL_OK = new Set(['#808000', '#800080', '#000080', '#008080', '#5f0000', '#870000', '#800000', '#008000'])
      const FILLED_CLS =
        /\b(hs-filled|hs-row-mention|hs-mc-rule-highlight|hs-mc-first-msg|hs-mc-user-intro|hs-mc-highlighted|hs-mc-redeemed|hs-mc-animated|hs-mc-automod|hs-mc-kicks|hs-mc-superchat|hs-mc-notice-[a-z-]+)\b/
      const SYSTEM_CLS = /\b(hs-mc-system|hs-mc-stream-event|hs-mc-automod|hs-mc-kicks|hs-mc-superchat|hs-mc-notice-[a-z-]+)\b/
      const rows = [...document.querySelectorAll(sel)] as HTMLElement[]
      const seen = new Map<string, number>()
      const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 120)
      for (const r of rows) {
        const key = r.dataset.msgKey || ''
        const text = r.textContent || ''
        const body = ((r.querySelector('.hs-mc-text') as HTMLElement | null)?.textContent || '').trim()
        const sample = clip(text)
        const id = key || sample
        const cls = r.className

        // 1 text hygiene
        if (/\[emote:/.test(text)) hit('text', id, { why: '[emote:', row: sample })
        if (/&(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);/i.test(text)) hit('text', id, { why: 'double-escaped entity', row: sample })
        if (/\u0001/.test(text)) hit('text', id, { why: 'control char \\u0001', row: sample })
        if (/^(?:\u0001|ACTION )/.test(body)) hit('text', id, { why: 'ACTION prefix in body', row: sample })
        if (/^(?:undefined|\[object Object\]|NaN)$/.test(body)) hit('text', id, { why: 'whole body is a placeholder', row: sample })
        if (/<(?:img|span)[\s>]/i.test(text)) hit('text', id, { why: 'raw tag as text', row: sample })

        // 3 identity (key uniqueness is counted after the loop)
        if (key) seen.set(key, (seen.get(key) || 0) + 1)
        const nameEl = r.querySelector('.hs-mc-user')
        const system = SYSTEM_CLS.test(cls)
        if (!system && !nameEl) hit('identity', id, { why: 'chat row with no name element', cls: cls.slice(0, 80), row: sample })
        if (nameEl && !(nameEl.textContent || '').trim()) hit('identity', id, { why: 'empty name', row: sample })
        for (const pb of r.querySelectorAll('.hs-mc-platform-badge')) {
          const m = [...pb.classList].find((c) => c.startsWith('hs-mc-pb-'))?.slice(9)
          if (m !== mark && m !== 'heatsync') hit('identity', id, { why: `mark [${pb.textContent}] (${m}) on a ${mark} pane`, row: sample })
        }

        // 4 links
        for (const a of r.querySelectorAll('a[href]') as NodeListOf<HTMLAnchorElement>) {
          const raw = a.getAttribute('href') || ''
          const proto = /^\s*([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase() || (new URL(a.href, location.href).protocol.slice(0, -1))
          const why: string[] = []
          if (proto !== 'http' && proto !== 'https') why.push(`protocol ${proto}`)
          if (!/\bnoopener\b/.test(a.rel)) why.push(`rel="${a.rel}"`)
          if (a.target !== '_blank') why.push(`target="${a.target}"`)
          if (why.length) hit('links', id, { why: why.join(', '), href: raw.slice(0, 80), cls: a.className.slice(0, 40), row: sample })
        }

        // 5 palette
        const bg = hex(getComputedStyle(r).backgroundColor)
        const filled = FILLED_CLS.test(cls)
        if (filled ? !FILL_OK.has(bg) && !PLAIN_OK.has(bg) : !PLAIN_OK.has(bg)) hit('palette', id, { why: `${filled ? 'filled' : 'plain'} row background ${bg}`, cls: cls.slice(0, 100), row: sample })
        for (const el of [r, ...(r.querySelectorAll('*') as NodeListOf<HTMLElement>)]) {
          const cs = getComputedStyle(el)
          if (el !== r && !(el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent || '').trim()))) {
            // only elements that own text are measured for size
          } else if (Number.parseFloat(cs.fontSize) < 13) hit('palette', id, { why: `font-size ${cs.fontSize}`, el: `${el.tagName.toLowerCase()}.${el.className.toString().slice(0, 40)}`, row: sample })
          const br = cs.borderTopLeftRadius
          if (br && br !== '0px' && el !== r) {
            const b = el.getBoundingClientRect()
            if (b.width > 10 || b.height > 10) hit('palette', id, { why: `border-radius ${br} on ${Math.round(b.width)}x${Math.round(b.height)}`, el: `${el.tagName.toLowerCase()}.${el.className.toString().slice(0, 40)}`, row: sample })
          }
        }
      }
      let dup = 0
      for (const [k, n] of seen) if (n > 1) { dup++; hit('identity', k, { why: `data-msg-key twice (${n})` }) }
      return { rows: rows.length, keys: seen.size - dup, hits }
    },
    [ROW_SEL, markCls],
  )

/** pictures in the visible part of the list: loaded, sized, with a real source */
const scanImgs = (p: any): Promise<{ total: number; broken: { src: string; host: string; row: string }[]; hits: Hit[] }> =>
  p.evaluate((sel: string) => {
    const pane = document.getElementById('hs-mc-messages') as HTMLElement
    const box = pane.getBoundingClientRect()
    const broken: { src: string; host: string; row: string }[] = []
    const hits: { check: string; key: string; detail: unknown }[] = []
    let total = 0
    for (const r of document.querySelectorAll(sel) as NodeListOf<HTMLElement>) {
      const rb = r.getBoundingClientRect()
      if (rb.bottom < box.top || rb.top > box.bottom) continue
      for (const im of r.querySelectorAll('img') as NodeListOf<HTMLImageElement>) {
        total++
        const src = im.getAttribute('src') || ''
        const row = (r.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)
        if (!src || src === 'undefined' || /\/undefined(?:[/?]|$)/.test(src)) hits.push({ check: 'pictures', key: r.dataset.msgKey || row, detail: { why: `empty or undefined src "${src.slice(0, 60)}"`, row } })
        if (!(im.complete && im.naturalWidth > 0)) {
          let host = ''
          try { host = new URL(im.currentSrc || src, location.href).hostname } catch {}
          broken.push({ src: (im.currentSrc || src).slice(0, 100), host, row })
        }
        const b = im.getBoundingClientRect()
        if ((b.width === 0 || b.height === 0) && getComputedStyle(im).display !== 'none')
          hits.push({ check: 'pictures', key: r.dataset.msgKey || row, detail: { why: `no size reserved (${Math.round(b.width)}x${Math.round(b.height)}, attr ${im.getAttribute('width')}x${im.getAttribute('height')})`, src: src.slice(0, 80), row } })
      }
    }
    return { total, broken, hits }
  }, ROW_SEL)

const rowCount = (p: any): Promise<number> =>
  p.evaluate(() => document.querySelectorAll('#hs-mc-messages .hs-mc-msg[data-msg-key]').length).catch(() => 0)

/** the chat rows (name + body) on screen: key, who, the body text, whether the rule highlight is on */
type CRow = { key: string; user: string; body: string; hl: boolean; bg: string; cls: string; data: string }
const chatRows = (p: any): Promise<CRow[]> =>
  p.evaluate(() =>
    [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg[data-msg-key]')]
      .filter((r) => r.querySelector('.hs-mc-user') && r.querySelector('.hs-mc-text') && !r.classList.contains('hs-mc-system'))
      .map((r) => {
        const el = r as HTMLElement
        return {
          key: el.dataset.msgKey || '',
          user: (r.querySelector('.hs-mc-user')?.textContent || '').trim().toLowerCase(),
          body: (r.querySelector('.hs-mc-text')?.textContent || '').trim(),
          hl: r.classList.contains('hs-mc-rule-highlight'),
          bg: getComputedStyle(el).backgroundColor,
          cls: el.className.slice(0, 90),
          data: [...el.attributes].map((a) => a.name).filter((n) => n.startsWith('data-') && n !== 'data-msg-key').join(','),
        }
      }),
  )

const wordRe = (w: string) => new RegExp(`(?:^|[\\s,!?.:;'"])${w}(?=$|[\\s,!?.:;'"])`, 'i')

/** the two commonest plain words in the rows on screen, never a chatter's name */
function pickWords(rows: { user: string; body: string }[], skip: Set<string>): { word: string; n: number }[] {
  const names = new Set([...rows.map((r) => r.user), ...skip])
  const count = new Map<string, number>()
  for (const r of rows) {
    const seen = new Set<string>()
    for (const w of r.body.split(/[\s,!?.:;'"]+/)) {
      const lw = w.toLowerCase()
      if (/^[a-z]{3,12}$/.test(lw) && !names.has(lw)) seen.add(lw)
    }
    for (const w of seen) count.set(w, (count.get(w) || 0) + 1)
  }
  return [...count].sort((a, b) => b[1] - a[1]).map(([word, n]) => ({ word, n }))
}

/** false = the chat was too quiet to judge (the caller may try another stream) */
async function site(env: Env, plat: Plat, url: string, errs: string[]): Promise<boolean> {
  const name = plat
  const check = (what: string, fails: string[], detail?: unknown) =>
    fails.length ? bad(`${name}: ${what}: ${fails.slice(0, 6).join(' | ')}${fails.length > 6 ? ` (+${fails.length - 6} more)` : ''}`, detail) : ok(`${name}: ${what}`)
  const t0 = Date.now()
  const p = await env.ctx.newPage()
  watchErrors(p, name, errs)
  const prior = await readLocal(env, 'chat_filter_rules')
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(p, 40_000))) {
      bad(`${name}: no panel mounted in 40s`)
      return true
    }
    // ≥150 rows on screen, up to 3 minutes
    let n = 0
    for (let i = 0; i < 90 && n < 150; i++) {
      await sleep(2000)
      n = await rowCount(p)
    }
    if (n < 150) {
      info(`${name}: too quiet — ${n} rows after 3 min, site not judged`)
      await shot(p, `s25-${name}-quiet`)
      return false
    }

    // ── 1-5 over every row, now and after 60s more of chat ──
    const byCheck: Record<string, Map<string, unknown>> = { text: new Map(), identity: new Map(), links: new Map(), palette: new Map(), pictures: new Map() }
    const keep = (hs: Hit[]) => {
      for (const h of hs) if (!byCheck[h.check].has(`${h.key}|${(h.detail as any)?.why}`)) byCheck[h.check].set(`${h.key}|${(h.detail as any)?.why}`, h.detail)
    }
    const total = { rows: 0, pics: 0, broken: [] as { src: string; host: string; row: string }[] }
    const seenBroken = new Set<string>()
    let badgeless = 0
    for (const pass of [1, 2]) {
      if (pass === 2) await sleep(60_000)
      const s = await scanRows(p, MARK[plat])
      keep(s.hits)
      total.rows = Math.max(total.rows, s.rows)
      await sleep(3000) // let pictures settle before they are judged
      const im = await scanImgs(p)
      keep(im.hits)
      total.pics = Math.max(total.pics, im.total)
      for (const b of im.broken) if (!seenBroken.has(b.src)) { seenBroken.add(b.src); total.broken.push(b) }
      if (pass === 2) badgeless = await p.evaluate((sel: string) => [...document.querySelectorAll(sel)].filter((r) => !r.querySelector('.hs-mc-platform-badge')).length, ROW_SEL)
      info(`${name}: pass ${pass}: ${s.rows} rows, ${im.total} pictures in view, ${im.broken.length} not loaded`)
    }
    const fails = (c: string) => [...byCheck[c].values()].map((d: any) => `${d.why} — ${JSON.stringify(d.row ?? d.href ?? d.el ?? '').slice(0, 90)}`)
    const detail = (c: string) => [...byCheck[c].values()].slice(0, 4)
    check('text hygiene', fails('text'), detail('text'))
    // pictures: a handful from one third-party host is their CDN; ours, or >5%, is a finding
    const ours = total.broken.filter((b) => FIRST_PARTY.test(b.host))
    const hosts = [...new Set(total.broken.map((b) => b.host || '(none)'))]
    const pct = total.pics ? (100 * total.broken.length) / total.pics : 0
    const picFails = [
      ...fails('pictures'),
      ...(ours.length ? [`${ours.length} broken from our own hosts: ${[...new Set(ours.map((b) => b.host))].join(',')}`] : []),
      ...(pct > 5 ? [`${total.broken.length}/${total.pics} broken (${pct.toFixed(1)}%) from ${hosts.join(',')}`] : []),
    ]
    check('pictures load, sized, real src', picFails, { broken: total.broken.slice(0, 4), hosts, ...detail('pictures') })
    if (total.broken.length && !picFails.length) info(`${name}: ${total.broken.length}/${total.pics} pictures not loaded, all third-party (${hosts.join(',')}): their CDN`)
    check('identity: unique keys, a name per chat row, only this site\'s mark', fails('identity'), detail('identity'))
    if (badgeless) info(`${name}: ${badgeless} rows carry no platform mark (the "platform badges" setting hides the page's own mark by design)`)
    check('links: http(s) only, noopener, new tab', fails('links'), detail('links'))
    check('palette: plain rows unfilled, fills from the set, ≥13px, square', fails('palette'), detail('palette'))

    // ── 6 filter rules: hide one common word, highlight another ──
    // Applied live: storage onChanged → recompile → renderMessages (main-storage.js). Rows are judged in
    // two groups: rows that arrived after the rule (ingest decides: hide drops, highlight paints) and
    // rows already drawn (a repaint may or may not restyle them — reported on its own).
    // an emote's name is not a word a chatter typed: kick keeps emotes as [emote:id:name] tokens in the text a rule reads
    const emoteNames = new Set<string>(
      await p.evaluate(() => [...document.querySelectorAll('#hs-mc-messages img')].map((i) => ((i as HTMLImageElement).alt || (i as HTMLImageElement).title || '').toLowerCase().replace(/^:|:$/g, ''))),
    )
    const words = pickWords(await chatRows(p), emoteNames)
    if (words.length < 2) {
      bad(`${name}: chat held no two plain words, filter rules not run`, words)
    } else {
      const [hideW, hlW] = [words[0], words[1]]
      const rule = (id: string, action: string, value: string) => ({ id, enabled: true, action, color: '#ffff00', scope: 'all', match: { type: 'keyword', value } })
      const hideRe = wordRe(hideW.word)
      const hlRe = wordRe(hlW.word)
      const say = (rs: CRow[]) => rs.filter((r) => hlRe.test(r.body) && !hideRe.test(r.body))
      info(`${name}: hide "${hideW.word}" (${hideW.n} rows), highlight "${hlW.word}" (${hlW.n} rows)`)
      const before = new Set((await chatRows(p)).map((r) => r.key))
      await writeLocal(env, 'chat_filter_rules', JSON.stringify([rule('e2e-hide', 'hide', hideW.word), rule('e2e-hl', 'highlight', hlW.word)]))
      try {
        await sleep(6000) // the repaint is given its time before anything is judged
        const repainted = say((await chatRows(p)).filter((r) => before.has(r.key)))
        if (repainted.length)
          check(
            `rules saved: rows already drawn that say "${hlW.word}" are repainted live, no reload`,
            repainted.every((r) => !r.hl) ? [`0/${repainted.length} of the rows already on screen took the highlight`] : [],
            repainted.slice(0, 2),
          )
        await sleep(30_000) // new chat under the rules
        const rs = await chatRows(p)
        const fresh = rs.filter((r) => !before.has(r.key))
        const hiddenNew = fresh.filter((r) => hideRe.test(r.body))
        const hiddenOld = rs.filter((r) => before.has(r.key) && hideRe.test(r.body))
        check(
          `hide rule "${hideW.word}": no row that arrived after it says it`,
          hiddenNew.length ? [`${hiddenNew.length}/${fresh.length} new rows say it: ${JSON.stringify(hiddenNew[0].body.slice(0, 80))}`] : [],
          hiddenNew.slice(0, 3),
        )
        if (hiddenNew.length) {
          const html = await p.evaluate((keys: string[]) => keys.map((k) => (document.querySelector(`#hs-mc-messages [data-msg-key="${k}"] .hs-mc-text`)?.innerHTML || '').slice(0, 260)), hiddenNew.slice(0, 3).map((r) => r.key))
          info(`${name}: leaked rows' body html: ${JSON.stringify(html)}`)
        }
        const rate = (hideW.n / Math.max(1, before.size)) * fresh.length
        info(`${name}: ${fresh.length} rows arrived under the rules; ~${rate.toFixed(1)} would have said "${hideW.word}" at the pre-rule rate, ${hiddenNew.length} did`)
        if (hiddenOld.length) info(`${name}: ${hiddenOld.length} rows drawn before the rule still say "${hideW.word}": hide acts at ingest, earlier rows stay (main.js:1114, social.js:1281)`)
        const hlNew = say(fresh)
        const unmarked = hlNew.filter((r) => !r.hl)
        const wrongBg = hlNew.filter((r) => r.hl && !/rgb\(128, 128, 0\)/.test(r.bg))
        if (!hlNew.length) info(`${name}: no new row says "${hlW.word}": highlight not observable on new rows`)
        else
          check(
            `highlight rule "${hlW.word}": the ${hlNew.length} new rows that say it carry the treatment, in olive`,
            [...(unmarked.length ? [`${unmarked.length}/${hlNew.length} unmarked: ${JSON.stringify(unmarked[0].body.slice(0, 80))}`] : []), ...(wrongBg.length ? [`${wrongBg.length} marked rows not olive: ${wrongBg[0].bg}`] : [])],
            { unmarked: unmarked.slice(0, 3), wrongBg: wrongBg.slice(0, 2) },
          )
      } finally {
        // an emptied list, the way the settings form saves it (main-storage.js only recompiles on a string)
        await writeLocal(env, 'chat_filter_rules', '[]')
      }
      // rules gone: rows drawn under them lose the treatment, and the word is let through again
      const drawnUnder = new Set((await chatRows(p)).filter((r) => r.hl).map((r) => r.key))
      await sleep(8000)
      let after = await chatRows(p)
      const stuck = after.filter((r) => r.hl && drawnUnder.has(r.key))
      const seenAgain = after.filter((r) => hideRe.test(r.body)).length
      check(
        'rules removed: rows drawn under the highlight lose it, rows saying the word are on screen',
        [...(stuck.length ? [`${stuck.length}/${drawnUnder.size} rows keep the rule highlight: ${JSON.stringify(stuck[0].body.slice(0, 80))}`] : []), ...(seenAgain ? [] : [`no row says "${hideW.word}"`])],
        { stuck: stuck.slice(0, 2), seenAgain },
      )
      // new rows after removal must not take the highlight
      await sleep(20_000)
      after = await chatRows(p)
      const late = after.filter((r) => r.hl && !drawnUnder.has(r.key) && !before.has(r.key))
      if (late.length) bad(`${name}: ${late.length} rows drawn after the rules were removed still take the highlight`, late.slice(0, 2))
    }

    // ── 7 the ring, the page errors ──
    const ring = await ringSince(p, t0)
    check('watchdog ring quiet', ring.bad.slice(0, 4).map((e: any) => `${e.e} ${JSON.stringify(e).slice(0, 100)}`), ring.counts)
    await shot(p, `s25-${name}`)
  } finally {
    await writeLocal(env, 'chat_filter_rules', prior).catch(() => {})
    await p.close().catch(() => {})
  }
}

/** busy youtube lives first (a 24/7 lofi stream is too quiet to read 150 rows from), the usual one last */
async function ytCandidates(): Promise<string[]> {
  const ids: string[] = []
  try {
    const r = await fetch('https://heatsync.org/api/live/top?limit=100')
    const j = (await r.json()) as { streams: { platform: string; videoId?: string; viewerCount?: number }[] }
    for (const x of j.streams.filter((x) => x.platform === 'youtube' && x.videoId && /^[\w-]{11}$/.test(x.videoId)).sort((a, b) => (b.viewerCount ?? 0) - (a.viewerCount ?? 0)).slice(0, 3)) ids.push(x.videoId as string)
  } catch {}
  const lofi = await liveYtVideo().catch(() => null)
  if (lofi) ids.push(lofi.id)
  return [...new Set(ids)]
}

export async function s25Rows() {
  scenario('s25 rows: every drawn row read on three sites')
  const [tw] = await liveChannels('twitch', 1)
  const [kk] = await liveChannels('kick', 1)
  const yts = await ytCandidates()
  const env = await launch()
  const errs: string[] = []
  try {
    await site(env, 'twitch', `https://www.twitch.tv/${tw}`, errs)
    await site(env, 'kick', `https://kick.com/${kk}`, errs)
    if (!yts.length) info('youtube leg not run: no live video')
    for (const id of yts) {
      info(`youtube: trying video ${id}`)
      if (await site(env, 'youtube', `https://www.youtube.com/watch?v=${id}`, errs)) break
    }
    if (errs.length) bad('page errors from our code', errs.slice(0, 5))
    else ok('no page errors')
  } finally {
    await env.close()
  }
}

/**
 * s24 — native mode: the extension's own chat panel switched off for a site, the site's own chat
 * is what the reader sees and the content scripts decorate it. Twitch, kick and youtube.
 *
 * The switch: `ui_settings.subsystems['overlay-twitch' | 'overlay-kick' | 'overlay-youtube'] = false`
 * in chrome.storage.sync (the popup's per-site switch, the settings page's "hs chat on <site>"; the
 * worker's `site_overlay_set` writes the same key). The product reads it once at load:
 * src/multichat/main-settings.js overlayEnabledHere() and src/content/native-filter-rules.js fold().
 * It is written here the way s19 writes it (an extension page, merged into ui_settings), and the
 * way back is the page's own "← back to heatsync chat" bar where it shows, else the same key + one reload.
 *
 *   1 overlay off: no #hs-mc-container, the site's own rows are on screen and keep coming
 *   2 third-party emotes draw in the site's own rows, none of ours is a broken image
 *   3 twitch/kick: no picker button (init() in heatsync-button.js mounts only the "back to heatsync chat"
 *     bar on a site where heatsync chat is off, by design); youtube: the heatsync button by its composer
 *   4 filter rules (twitch, kick): a highlight rule (with its colour, as the rules form always sets one) paints native rows; a hide rule is reported
 *     (native chat never hid by text, native-filter-rules.js header) — youtube has no native rules
 *   5 blocked emote names (twitch, kick): a real right-click on a native emote in tab A reaches tab B
 *     with no reload, and a second name blocked from B leaves both names in storage
 *   6 overlay back on: the panel returns, the watchdog ring holds nothing bad, no page errors
 *
 * Signed out, nothing is sent. Every key it touches is put back in a finally.
 */
import { bad, extStorage, info, launch, liveChannels, liveYtVideo, ok, ringSince, scenario, shot, sleep, waitPanel, watchErrors } from './lib'

type Env = Awaited<ReturnType<typeof launch>>
type Plat = 'twitch' | 'kick' | 'youtube'

const ROWS: Record<Plat, string> = {
  twitch: '.chat-line__message',
  kick: '#chatroom-messages [data-index]',
  youtube: 'yt-live-chat-text-message-renderer',
}
const OURS: Record<Plat, string> = {
  twitch: '.heatsync-emote-wrapper img',
  kick: '.heatsync-emote-wrapper img',
  youtube: 'img.heatsync-emote-yt',
}
// the site's own emote pictures (content.js NATIVE_EMOTE_IMG), outside ours
const NATIVE_IMG = 'img[src*="static-cdn.jtvnw.net/emoticons"], img[src*="files.kick.com/emotes/"]'
const TEXT_SEL = '.text-fragment, [data-a-target="chat-message-text"], span.font-normal'
const GATE: Record<Plat, string> = { twitch: 'overlay-twitch', kick: 'overlay-kick', youtube: 'overlay-youtube' }

/** where the site's chat lives: the page, or on youtube the live_chat frame */
async function chatRoot(p: any, plat: Plat, ms = 40_000) {
  if (plat !== 'youtube') return p
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const f = p.frames().find((x: any) => /\/live_chat/.test(x.url()) && !/replay/.test(x.url()))
    if (f && (await f.$('yt-live-chat-renderer').catch(() => null))) return f
    await sleep(1000)
  }
  return null
}

async function rowsLook(root: any, plat: Plat) {
  return root
    .evaluate((sel: string) => {
      const rows = [...document.querySelectorAll(sel)] as HTMLElement[]
      const shown = rows.filter((r) => {
        const b = r.getBoundingClientRect()
        return b.width > 40 && b.height > 4 && getComputedStyle(r).visibility !== 'hidden'
      })
      return { all: rows.length, shown: shown.length, last: (shown.at(-1)?.textContent || '').trim().slice(0, 80) }
    }, ROWS[plat])
    .catch(() => ({ all: 0, shown: 0, last: '' }))
}

async function oursLook(root: any, plat: Plat) {
  return root
    .evaluate((sel: string) => {
      const imgs = [...document.querySelectorAll(sel)] as HTMLImageElement[]
      const drawn = imgs.filter((i) => i.complete && i.naturalWidth > 0).length
      const broken = imgs.filter((i) => i.complete && i.naturalWidth === 0 && i.currentSrc).map((i) => (i.currentSrc || '').slice(-60))
      return { n: imgs.length, drawn, broken: broken.slice(0, 4), nBroken: broken.length }
    }, OURS[plat])
    .catch(() => ({ n: 0, drawn: 0, broken: [], nBroken: 0 }))
}

/** ui_settings.subsystems[gate] and the stored lists, written the way the product's own pages write them */
async function setGate(env: Env, gate: string, on: boolean) {
  await extStorage(
    env,
    async ([g, v]: [string, boolean]) => {
      // @ts-ignore — extension page
      const cur = (await chrome.storage.sync.get('ui_settings')).ui_settings || {}
      // @ts-ignore
      await chrome.storage.sync.set({ ui_settings: { ...cur, subsystems: { ...(cur.subsystems || {}), [g]: v } } })
    },
    [gate, on],
  )
}
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

/** most frequent plain words in the rows on screen (the engine's own word boundary) */
async function commonWords(p: any, plat: Plat): Promise<string[]> {
  return p.evaluate(
    ([rowSel, textSel]: [string, string]) => {
      const count = new Map<string, number>()
      for (const r of [...document.querySelectorAll(rowSel)].slice(-60)) {
        let text = ''
        for (const f of r.querySelectorAll(textSel)) if (f.textContent) text = text ? `${text} ${f.textContent}` : f.textContent
        const seen = new Set<string>()
        for (const w of text.split(/[\s,!?.:;'"]+/)) if (/^[a-z]{3,12}$/i.test(w)) seen.add(w.toLowerCase())
        for (const w of seen) count.set(w, (count.get(w) || 0) + 1)
      }
      return [...count].sort((a, b) => b[1] - a[1]).map(([w]) => w)
    },
    [ROWS[plat], TEXT_SEL],
  )
}

/** rows whose text carries `word` (the engine's boundary), with the marker and visibility each shows */
const rowsWith = (p: any, plat: Plat, word: string) =>
  p.evaluate(
    ([rowSel, textSel, w]: [string, string, string]) => {
      const re = new RegExp(`(?:^|[\\s,!?.:;'"])${w}(?=$|[\\s,!?.:;'"])`, 'i')
      const out: { marked: boolean; gone: boolean; text: string; why?: string }[] = []
      const all = [...document.querySelectorAll(rowSel)]
      for (const r of document.querySelectorAll(rowSel) as NodeListOf<HTMLElement>) {
        let text = ''
        for (const f of r.querySelectorAll(textSel)) if (f.textContent) text = text ? `${text} ${f.textContent}` : f.textContent
        if (!re.test(text)) continue
        const b = r.getBoundingClientRect()
        out.push({ marked: r.classList.contains('hs-keyword-match'), gone: getComputedStyle(r).display === 'none' || b.height === 0, text: text.slice(0, 300), why: r.classList.contains('hs-keyword-match') ? undefined : `row ${all.indexOf(r)}/${all.length} backfill=${r.hasAttribute('data-heatsync-backfill')} markedBackfill=${all.filter((x) => x.hasAttribute('data-heatsync-backfill') && x.classList.contains('hs-keyword-match')).length}/${all.filter((x) => x.hasAttribute('data-heatsync-backfill')).length} frags=${JSON.stringify([...r.querySelectorAll(textSel)].map((f) => f.textContent?.slice(0, 40)))} cls=${r.className.slice(0, 80)} data=${[...r.attributes].map((a) => a.name).filter((n) => n.startsWith('data-')).join(',')} frag=${r.querySelectorAll(textSel).length} html=${r.innerHTML.replace(/\s+/g, ' ').slice(0, 200)}` })
      }
      return out
    },
    [ROWS[plat], TEXT_SEL, word],
  )

/** the site's own emote pictures in rows: name and how many sit there, most first */
const nativeCounts = (p: any, plat: Plat): Promise<[string, number][]> =>
  p.evaluate(
    ([rowSel, sel]: [string, string]) => {
      const count = new Map<string, number>()
      for (const r of document.querySelectorAll(rowSel))
        for (const im of r.querySelectorAll(sel) as NodeListOf<HTMLImageElement>) {
          if (!im.alt || im.closest('.heatsync-emote-wrapper, .heatsync-emote-stack')) continue
          count.set(im.alt, (count.get(im.alt) || 0) + 1)
        }
      return [...count].sort((a, b) => b[1] - a[1])
    },
    [ROWS[plat], NATIVE_IMG],
  )

/** the real right-click: the handler in content.js listens for contextmenu on the document */
async function rightClickEmote(p: any, plat: Plat, name: string): Promise<string> {
  await p.bringToFront()
  for (let i = 0; i < 6; i++) {
    const found = await p.evaluate(
      ([rowSel, sel, n]: [string, string, string]) => {
        document.querySelectorAll('[data-e2e-rc]').forEach((e) => e.removeAttribute('data-e2e-rc'))
        const im = ([...document.querySelectorAll(`${rowSel} img`)] as HTMLImageElement[])
          .filter((x) => x.alt === n && x.matches(sel) && !x.closest('.heatsync-emote-wrapper, .heatsync-emote-stack'))
          .at(-1)
        if (!im) return false
        im.setAttribute('data-e2e-rc', '1')
        return true
      },
      [ROWS[plat], NATIVE_IMG, name],
    )
    if (!found) return 'no such emote in a row any more'
    try {
      await p.locator('[data-e2e-rc]').click({ button: 'right', timeout: 4000 })
      return 'clicked'
    } catch {
      await sleep(500)
    }
  }
  // rows scroll away under the pointer: the same event the browser raises, aimed at the picture
  await p.evaluate(() => document.querySelector('[data-e2e-rc]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
  return 'dispatched'
}

const blockedNow = (p: any, plat: Plat, name: string) =>
  p.evaluate(
    ([rowSel, sel, n]: [string, string, string]) => {
      const all = ([...document.querySelectorAll(`${rowSel} img`)] as HTMLImageElement[]).filter(
        (x) => x.alt === n && x.matches(sel) && !x.closest('.heatsync-emote-wrapper, .heatsync-emote-stack'),
      )
      return { n: all.length, blocked: all.filter((x) => x.hasAttribute('data-hs-name-blocked')).length }
    },
    [ROWS[plat], NATIVE_IMG, name],
  )

/** names of 7tv and bttv global emotes: words that, said in a row, must come out as pictures */
async function knownEmoteWords(): Promise<Set<string>> {
  const out = new Set<string>()
  const get = async (u: string) => {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(8000) })
      return r.ok ? await r.json() : null
    } catch {
      return null
    }
  }
  const [s7, bt] = await Promise.all([get('https://7tv.io/v3/emote-sets/global'), get('https://api.betterttv.net/3/cached/emotes/global')])
  for (const e of s7?.emotes ?? []) if (e?.name) out.add(String(e.name))
  for (const e of Array.isArray(bt) ? bt : []) if (e?.code) out.add(String(e.code))
  return out
}
/** how many words in the rows still sitting there as text are known emote names */
const knownWordsInRows = (root: any, plat: Plat, known: string[]): Promise<string[]> =>
  root
    .evaluate(
      ([sel, list]: [string, string[]]) => {
        const set = new Set(list)
        const hit = new Set<string>()
        for (const r of document.querySelectorAll(sel)) for (const w of (r.textContent || '').split(/\s+/)) if (set.has(w)) hit.add(w)
        return [...hit]
      },
      [ROWS[plat], known],
    )
    .catch(() => [])

/** how many of a name's native pictures show blocked; waits up to 10s for a tab that is catching up */
async function blockedOnScreen(p: any, plat: Plat, name: string) {
  let r = await blockedNow(p, plat, name)
  for (let i = 0; i < 5 && r.blocked < r.n; i++) {
    await sleep(2000)
    r = await blockedNow(p, plat, name)
  }
  return r
}

/** names both tabs hold, the one held in most rows (in the tab that holds fewer) first */
const shared = (a: [string, number][], b: [string, number][]) =>
  a
    .filter(([n]) => b.some(([m]) => m === n))
    .map(([n, c]) => [n, Math.min(c, b.find(([m]) => m === n)?.[1] ?? 0)] as [string, number])
    .sort((x, y) => y[1] - x[1])
    .map(([n]) => n)

async function site(env: Env, plat: Plat, url: string, errs: string[], known: Set<string>) {
  const name = plat
  const gate = GATE[plat]
  const check = (what: string, fails: string[], detail?: unknown) =>
    fails.length ? bad(`${name}: ${what}: ${fails.join('; ')}`, detail) : ok(`${name}: ${what}`)
  const t0 = Date.now()

  await setGate(env, gate, false)
  const p = await env.ctx.newPage()
  watchErrors(p, name, errs)
  let b: any = null
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded' })
    const root = await chatRoot(p, plat)
    await sleep(15_000)

    // ── 1 overlay off, the site's own chat flows ──
    const panelOn = await p.evaluate(() => !!document.getElementById('hs-mc-container'))
    const r1 = root ? await rowsLook(root, plat) : { all: 0, shown: 0, last: '' }
    let r2 = r1
    for (let i = 0; i < 15 && r1.shown > 0 && r2.last === r1.last && r2.all === r1.all; i++) {
      await sleep(2000)
      r2 = await rowsLook(root, plat)
    }
    check(
      'overlay off: no panel, the site chat shows and keeps flowing',
      [
        ...(panelOn ? ['our panel #hs-mc-container is mounted'] : []),
        ...(root ? [] : ['no chat frame']),
        ...(r1.shown === 0 ? ['no native row on screen'] : []),
        ...(r1.shown > 0 && r1.last === r2.last && r1.all === r2.all ? ['no new row in 30s'] : []),
      ],
      { panelOn, r1, r2 },
    )
    if (!root || r1.shown === 0) {
      await shot(p, `s24-${name}-nochat`)
      return
    }

    // ── 2 third-party emotes in the site's rows ──
    let o = await oursLook(root, plat)
    for (let i = 0; i < 28 && o.drawn === 0; i++) {
      await sleep(2000)
      o = await oursLook(root, plat)
    }
    if (o.drawn === 0) {
      const sample = await root.evaluate((sel: string) => [...document.querySelectorAll(sel)].slice(-6).map((r) => (r.textContent || '').trim().slice(0, 70)), ROWS[plat])
      const said = await knownWordsInRows(root, plat, [...known])
      if (said.length) bad(`${name}: known global emote names sit as plain text in the site's rows and none drew`, { said: said.slice(0, 6), lastRows: sample })
      else
        info(
          `${name}: no third-party emote drew in 60s but chat said no known global emote name either (rows: ${JSON.stringify(sample.slice(-3))}): cannot judge, a quiet channel for emotes`,
        )
    } else
      check('third-party emotes draw in the site rows, none broken', o.nBroken ? [`${o.nBroken} broken pictures`] : [], o)

    // ── 3 the button / the way back ──
    const btnProbe = async () => {
      const where: any[] = plat === 'youtube' ? p.frames() : [p]
      for (const f of where) {
        const r = await f
          .evaluate(() => {
            const btn = document.getElementById('heatsync-chat-button')
            const bb = btn?.getBoundingClientRect()
            const composer = document.querySelector(
              '[data-a-target="chat-input"], [class*="editor-input"], #message-input, yt-live-chat-text-input-field-renderer',
            )
            return { btn: !!btn, shown: !!bb && bb.width > 4 && bb.height > 4, composer: !!composer, back: !!document.getElementById('heatsync-native-back') }
          })
          .catch(() => null)
        if (r && (r.btn || r.composer || r.back)) return r
      }
      return { btn: false, shown: false, composer: false, back: false }
    }
    let bp = await btnProbe()
    const want = (x: typeof bp) => (plat === 'youtube' ? x.btn : x.back)
    for (let i = 0; i < 10 && !want(bp); i++) {
      await sleep(2000)
      bp = await btnProbe()
    }
    if (plat === 'youtube') {
      if (bp.btn) check('the heatsync button is mounted by the composer', bp.shown ? [] : ['it is mounted but has no size'], bp)
      else if (bp.composer) bad(`${name}: the site shows a composer but no #heatsync-chat-button was mounted in 20s`, bp)
      else info(`${name}: signed out the site shows no composer in the DOM: no button to mount`)
    } else
      check(
        'native page: the way-back bar is mounted and the picker button is not (by design)',
        [...(bp.back ? [] : ['no #heatsync-native-back']), ...(bp.btn ? ['#heatsync-chat-button is mounted beside the native composer'] : [])],
        bp,
      )
    if (plat !== 'youtube') info(`${name}: the site shows ${bp.composer ? 'a' : 'no'} composer to a signed-out visitor`)

    // ── 4 filter rules ──
    if (plat === 'youtube') info('youtube: native chat has no filter-rule engine (youtube-content.js never loads one): step 4 not applicable')
    else {
      const prior = await readLocal(env, 'chat_filter_rules')
      try {
        let words = await commonWords(p, plat)
        for (let i = 0; i < 15 && words.length < 2; i++) {
          await sleep(2000)
          words = await commonWords(p, plat)
        }
        if (words.length < 2) bad(`${name}: chat held no two plain words, cannot pick rule words`, words.slice(0, 5))
        else {
          const [hideWord, hlWord] = words
          const rule = (id: string, action: string, value: string) => ({ id, enabled: true, action, color: '#ffff00', scope: 'all', match: { type: 'keyword', value } })
          await writeLocal(env, 'chat_filter_rules', JSON.stringify([rule('e2e-hide', 'hide', hideWord), rule('e2e-hl', 'highlight', hlWord)]))
          // rows must carry the word: wait for it to be on screen after the rules landed
          let hl: { marked: boolean; gone: boolean; text: string; why?: string }[] = []
          let hd: { marked: boolean; gone: boolean; text: string; why?: string }[] = []
          for (let i = 0; i < 15; i++) {
            await sleep(2000)
            hl = await rowsWith(p, plat, hlWord)
            hd = await rowsWith(p, plat, hideWord)
            if (hl.length && hd.length && hl.every((x) => x.marked)) break
          }
          // a row that also says the hide word is hide's: the engine answers hide first and native chat never
          // hides, so it stays plain — the check is on rows that say the highlight word alone
          const hideRe = new RegExp(`(?:^|[\\s,!?.:;'"])${hideWord}(?=$|[\\s,!?.:;'"])`, 'i')
          const both = hl.filter((x) => hideRe.test(x.text))
          hl = hl.filter((x) => !hideRe.test(x.text))
          if (both.length) info(`${name}: ${both.length} rows say both "${hlWord}" and "${hideWord}": hide wins in the engine, left out of the highlight check`)
          // rows the extension itself filled in from history (twitch) are rows too
          const nudge = async () => {
            if (!hl.some((x) => !x.marked)) return null
            // the same rules written again with a disabled extra rule: storage fires onChanged, which repaints
            await writeLocal(env, 'chat_filter_rules', JSON.stringify([rule('e2e-hide', 'hide', hideWord), rule('e2e-hl', 'highlight', hlWord), { ...rule('e2e-off', 'highlight', 'zzzqq'), enabled: false }]))
            await sleep(3000)
            return (await rowsWith(p, plat, hlWord)).filter((x) => !x.marked).length
          }
          const stillUnmarked = hl.filter((x) => !x.marked).length
          const afterRepaint = await nudge()
          check(
            `a highlight rule ("${hlWord}") marks the native rows that say it`,
            [
              ...(hl.length ? [] : ['no row on screen says it']),
              ...(stillUnmarked ? [`${stillUnmarked}/${hl.length} rows unmarked (a forced repaint then left ${afterRepaint})`] : []),
            ],
            { unmarked: hl.filter((x) => !x.marked).slice(0, 2).map((x) => x.why), of: hl.length },
          )
          if (!hd.length) info(`${name}: no row on screen said "${hideWord}" at the check: hide rule not observable`)
          else if (hd.every((x) => x.gone)) ok(`${name}: a hide rule ("${hideWord}") hides the native rows that say it`)
          else
            info(
              `${name}: hide rule ("${hideWord}") left ${hd.filter((x) => !x.gone).length}/${hd.length} native rows showing — by design, native chat never hid by text (src/content/native-filter-rules.js:1-6): the overlay-only hide rule does nothing here`,
            )
        }
      } finally {
        await writeLocal(env, 'chat_filter_rules', prior)
        await sleep(2000)
      }

      // ── 5 blocked emote names stay in step between two tabs ──
      const priorNames = await readLocal(env, 'local_blocked_emote_names')
      try {
        b = await env.ctx.newPage()
        watchErrors(b, `${name}-b`, errs)
        await b.goto(url, { waitUntil: 'domcontentloaded' })
        await sleep(12_000)
        let na: [string, number][] = []
        let nb: [string, number][] = []
        for (let i = 0; i < 25; i++) {
          await p.bringToFront()
          await sleep(1500)
          na = (await nativeCounts(p, plat)).filter(([n]) => !(priorNames || []).includes(n))
          await b.bringToFront()
          await sleep(1500)
          nb = (await nativeCounts(b, plat)).filter(([n]) => !(priorNames || []).includes(n))
          if (shared(na, nb).length >= 2) break
          await sleep(2000)
        }
        // the name both tabs hold most of: a fast chat moves its rows on under a name said once
        const common = shared(na, nb)
        const X = common[0]
        const Y = common[1] ?? nb.map(([n]) => n).find((n) => n !== X)
        if (!X || !Y) bad(`${name}: the two tabs shared no native emote in 60s, cannot run the two-tab block`, { a: na.slice(0, 4).map(([n]) => n), b: nb.slice(0, 4).map(([n]) => n) })
        else {
          // snapshot which X pictures B already holds, so a later one is known as new
          await b.evaluate(
            ([sel, n]: [string, string]) => document.querySelectorAll(sel).forEach((i) => (i as HTMLImageElement).alt === n && i.setAttribute('data-e2e-old', '1')),
            [NATIVE_IMG, X],
          )
          const how = await rightClickEmote(p, plat, X)
          await sleep(3000)
          const stored1 = (await readLocal(env, 'local_blocked_emote_names')) || []
          const onA = await blockedOnScreen(p, plat, X)
          const onB = await blockedOnScreen(b, plat, X)
          check(
            `right-click blocks "${X}" in tab A and tab B follows with no reload`,
            [
              ...(stored1.includes(X) ? [] : [`storage holds ${JSON.stringify(stored1)}`]),
              ...(onA.n && onA.blocked === 0 ? ['tab A did not mark it'] : []),
              ...(onB.n && onB.blocked < onB.n ? [`tab B marks ${onB.blocked}/${onB.n} of its pictures`] : []),
              ...(onB.n === 0 ? [`tab B had no "${X}" on screen to look at`] : []),
            ],
            { how, onA, onB, stored1 },
          )
          // rows that arrive in B after the block
          let fresh = { n: 0, bad: 0 }
          for (let i = 0; i < 10 && fresh.n === 0; i++) {
            fresh = await b.evaluate(
              ([sel, n]: [string, string]) => {
                const f = ([...document.querySelectorAll(sel)] as HTMLImageElement[]).filter((x) => x.alt === n && !x.closest('.heatsync-emote-wrapper') && !x.hasAttribute('data-e2e-old'))
                return { n: f.length, bad: f.filter((x) => !x.hasAttribute('data-hs-name-blocked')).length }
              },
              [NATIVE_IMG, X],
            )
            if (fresh.n === 0) await sleep(2500)
          }
          if (fresh.n === 0) info(`${name}: no new "${X}" row reached tab B in 25s: new-row draw not observed`)
          else check(`new rows in tab B draw "${X}" blocked`, fresh.bad ? [`${fresh.bad}/${fresh.n} new pictures not blocked`] : [], fresh)

          // the second name, from the other tab: both must be in storage, both tabs must show both
          await b.bringToFront()
          let Y2 = Y
          let how2 = await rightClickEmote(b, plat, Y2)
          // a busy chat moves its rows on: aim at another name the tab still shows
          for (const alt of (await nativeCounts(b, plat)).map(([n]) => n).filter((n) => n !== X && n !== Y)) {
            if (how2 !== 'no such emote in a row any more') break
            Y2 = alt
            how2 = await rightClickEmote(b, plat, Y2)
          }
          await sleep(3000)
          const stored2 = (await readLocal(env, 'local_blocked_emote_names')) || []
          await p.bringToFront()
          const aY = await blockedOnScreen(p, plat, Y2)
          const aX = await blockedOnScreen(p, plat, X)
          const bX = await blockedOnScreen(b, plat, X)
          check(
            `"${Y2}" blocked from tab B leaves both names in storage and both tabs`,
            [
              ...(stored2.includes(X) && stored2.includes(Y2) ? [] : [`storage holds ${JSON.stringify(stored2)}`]),
              ...(aY.n && aY.blocked < aY.n ? [`tab A shows ${aY.blocked}/${aY.n} "${Y2}" blocked`] : []),
              ...(aX.n && aX.blocked < aX.n ? [`tab A lost "${X}": ${aX.blocked}/${aX.n}`] : []),
              ...(bX.n && bX.blocked < bX.n ? [`tab B lost "${X}": ${bX.blocked}/${bX.n}`] : []),
            ],
            { how2, stored2, aY, aX, bX },
          )
        }
      } finally {
        await writeLocal(env, 'local_blocked_emote_names', priorNames)
        await b?.close().catch(() => {})
        b = null
      }
    }

    // ── 6 overlay back on ──
    await p.bringToFront()
    const bar = plat === 'youtube' ? false : await p.evaluate(() => !!document.getElementById('heatsync-native-back'))
    info(`${name}: the page's "back to heatsync chat" bar is ${bar ? 'mounted' : 'not mounted'}`)
    if (bar) {
      await p.evaluate(() => (document.getElementById('heatsync-native-back') as HTMLElement).click())
      await p.waitForLoadState('domcontentloaded').catch(() => {})
      await sleep(3000)
    } else {
      await setGate(env, gate, true)
      await sleep(4000)
      const live = await p.evaluate(() => !!document.getElementById('hs-mc-container'))
      info(`${name}: with the key flipped and no reload the panel is ${live ? 'up' : 'not up (decided at load)'}`)
      if (!live) await p.reload({ waitUntil: 'domcontentloaded' })
    }
    const up = await waitPanel(p, 40_000)
    await sleep(15_000)
    const pb = await p.evaluate(() => {
      const c = document.getElementById('hs-mc-container')
      const r = c?.getBoundingClientRect()
      return { w: Math.round(r?.width || 0), h: Math.round(r?.height || 0) }
    })
    const ring = await ringSince(p, t0)
    check(
      'overlay back on: the panel returns, the watchdogs are quiet',
      [...(up && pb.w > 100 && pb.h > 100 ? [] : [`panel ${up ? 'tiny' : 'absent'}`]), ...(ring.bad.length ? [`ring: ${ring.bad.slice(0, 3).map((e: any) => e.e).join(',')}`] : [])],
      { pb, ring: ring.bad.slice(0, 4) },
    )
  } finally {
    await b?.close().catch(() => {})
    await p.close().catch(() => {})
    await setGate(env, gate, true).catch(() => {})
  }
}

export async function s24Native() {
  scenario('s24 native mode: overlay off, the site chat decorated, on three sites')
  const [tw] = await liveChannels('twitch', 1)
  const [kk] = await liveChannels('kick', 1)
  const yt = await liveYtVideo()
  const known = await knownEmoteWords()
  const env = await launch()
  const errs: string[] = []
  try {
    await site(env, 'twitch', `https://www.twitch.tv/${tw}`, errs, known)
    await site(env, 'kick', `https://kick.com/${kk}`, errs, known)
    if (yt) await site(env, 'youtube', `https://www.youtube.com/watch?v=${yt.id}`, errs, known)
    else info('youtube leg not run: no live video')
    if (errs.length) bad('page errors', errs.slice(0, 5))
    else ok('no page errors')
  } finally {
    await env.close()
  }
}

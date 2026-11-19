/**
 * s26 — an old release upgraded in place keeps everything. Data lost on an update is the worst
 * kind of bug and nothing else here drives one: this runs a released build on a fresh profile,
 * saves real state, closes the browser, swaps the current build into the SAME extension dir,
 * reopens the SAME profile and checks that every saved thing is still there. Signed out; nothing
 * is ever sent to chat.
 *
 *   E2E_OLD_EXT=<dir of the 1.7.126 build>,<dir of the 1.7.136 build> bun scripts/e2e/run.ts --only s26
 *
 * Each old build is its own leg (old → current). Per leg:
 *   old build   saved channels (one twitch+kick), settings of three kinds, a muted and a blocked
 *               chatter, a hide rule, recent emotes, a note; ~45s on a live stream; dump all of
 *               chrome.storage (local + sync) = snapshot A
 *   swap        the current build copied over the old one in the same dir (an unpacked
 *               extension's id comes from its path: another path would orphan the profile)
 *   current     same profile, same stream: same extension id, no uncaught error, the watchdog ring
 *               quiet, snapshot B ~30s in: every key of A is back with the same value
 *               (the list of keys allowed to differ is VOLATILE below, each with its reason);
 *               the panel, the saved tabs in order, the settings, the mute / block / hide rule
 *               and chat rows all working; no reload loop, no "context invalidated"
 *   current     closed and reopened once more: snapshot C equals B (a migration runs once)
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bad, EXT, extStorage, info, launch, liveChannels, ok, panel, ringSince, rowsFlow, saveChannels, scenario, shot, sleep, swState, waitPanel, watchErrors } from './lib'

type Env = Awaited<ReturnType<typeof launch>>
type Snap = { local: Record<string, unknown>; sync: Record<string, unknown> }

/**
 * Keys that may differ between two snapshots, each with the reason read from src/. Never a
 * pattern: a pattern could hide real loss. A key not listed here that changed or went missing
 * is a finding.
 */
const VOLATILE: Record<string, string> = {
  'local.bttv_room_ids': 'cache of channel → bttv room; gains an entry per channel visited, evicts with the emote cache (background/04-emotes.js:322-334)',
  'local.global_emotes': 'cache of the global emote list, written again in the order each fetch returns (background/05-ws.js:562, 04-emotes.js:701)',
  'local.channel_emotes_map': 'MIGRATION: the old whole-map key moves into IndexedDB then is removed, once (background/08-diag-push.js:86-102)',
  'local.channel_emotes_fetched_at': 'MIGRATION: goes with channel_emotes_map above (background/08-diag-push.js:100-102)',
  'local.hs_badge_art_v1': 'cache of badge art titles, re-stamped `at` on every refetch (multichat/twitch-api.js:2438)',
  'local.hs_cosmetics_7tv_v1': 'cache of 7tv cosmetics, re-stamped `at` on every refetch (multichat/cosmetics.js:28)',
  'local.hs_cosmetics_v1': 'cache of heatsync cosmetics, re-stamped `at` on every refetch (multichat/paints.js:588)',
  'local.hs_emote_boxw_v1': 'cache of measured emote widths, re-stamped `at` on every write (multichat/emotes.js:4113)',
  'local.hs_diag_page': 'the page\'s own health note, rewritten with a timestamp on every page (background/08-diag-push.js:439)',
  'local.hs_health_at': 'timestamp of the last health write (background/01-core.js:1103)',
  'local.hs_tab_seen_v1': 'last-seen time per tab, a timestamp that moves every visit (multichat/main-state.js:1262-1271)',
  'local.hs_user_color_cache': 'name → colour cache that gains a chatter per row (multichat/input.js:5524-5543)',
  'local.hs_ws_debug': 'ring of the last socket connect lines (background/05-ws.js:682)',
  'local.joined_extra_channels': 'the worker\'s list of rooms it joined this session, rebuilt from the tabs (background/08-diag-push.js:37,53)',
  'local.seventv_emote_set_ids': 'cache of channel → 7tv emote set, gains an entry per channel (background/08-diag-push.js:105)',
  'local.twitch_id_cache': 'cache of name → twitch id (background/08-diag-push.js:141)',
  'local.user_cosmetics_cache': 'cache of per-user cosmetics (background/08-diag-push.js:293)',
}
/** per-channel chat history caches the worker keeps (background/09-irc.js, 10-kick-yt.js): named, not matched */
function addHistoryKeys(chs: { tw: string[]; kk: string[] }) {
  for (const t of chs.tw) VOLATILE[`local.hs_irc_${t}`] = 'cache of the channel\'s recent chat lines (background/09-irc.js:22)'
  for (const k of chs.kk) VOLATILE[`local.hs_kick_${k}`] = 'cache of the channel\'s recent chat lines (background/10-kick-yt.js:34)'
}

/**
 * Keys the product rewrites on purpose and that keep their user data: the check is "everything
 * the user had is still there", not "nothing moved".
 */
const KEEPS: Record<string, (before: any, after: any) => boolean> = {
  // the mod log takes every mod action the open channels see, newest MOD_LOG_PER_CHANNEL (500)
  // per channel, oldest dropped first (multichat/mod-log.js:17-18): it grows while the test
  // watches a busy channel. What was logged stays, unless its channel filled up since.
  'local.hs_modlog_v1': (a, b) => {
    const now: any[] = b?.entries || []
    const ids = new Set(now.map((e) => e.id))
    const perCh: Record<string, number> = {}
    for (const e of now) perCh[e.channel] = (perCh[e.channel] || 0) + 1
    return (a?.entries || []).every((e: any) => ids.has(e.id) || perCh[e.channel] >= 500)
  },
  // a visit backfills a platform a saved channel left empty (multichat/main-live.js:1371-1383):
  // same channels, same order, no filled field changed, only empty ones may fill, new top-level defaults allowed
  'local.heatsync_multichat': (a, b) => {
    const x = a?.channels || []
    const y = b?.channels || []
    return (
      x.length === y.length &&
      x.every((c: any, i: number) => Object.entries(c).every(([k, v]) => !v || y[i]?.[k] === v)) &&
      // the current build also writes its `enabled` default next to the list; what was there stays equal
      Object.entries(a || {}).every(([k, v]) => k === 'channels' || stable(v) === stable(b?.[k]))
    )
  },
}

const MASK = /token|secret|auth/i
/** a value for a finding: a list says how many it holds and its last item, so a diff of two long lists reads */
const show = (key: string, v: unknown) => {
  if (MASK.test(key)) return '[masked]'
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v as object).find(Array.isArray) : null
  const tail = list?.length ? ` · ${list.length} items, last ${JSON.stringify(list.at(-1)).slice(0, 160)}` : ''
  return (JSON.stringify(v) ?? 'undefined').slice(0, 200) + tail
}
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  )

const readStorage = (env: Env): Promise<Snap> =>
  // @ts-ignore — extension page
  extStorage(env, async () => ({ local: await chrome.storage.local.get(null), sync: await chrome.storage.sync.get(null) })) as Promise<Snap>
const writeLocal = (env: Env, obj: Record<string, unknown>) =>
  // @ts-ignore — extension page
  extStorage(env, async (o: Record<string, unknown>) => chrome.storage.local.set(o), obj)
const writeSync = (env: Env, obj: Record<string, unknown>) =>
  // @ts-ignore — extension page
  extStorage(env, async (o: Record<string, unknown>) => chrome.storage.sync.set(o), obj)

/** keys of `a` that are gone from `b` or hold another value, minus the volatile ones */
function lost(a: Snap, b: Snap) {
  const out: { key: string; before: string; after: string }[] = []
  for (const area of ['local', 'sync'] as const)
    for (const [k, v] of Object.entries(a[area])) {
      // the add-on's error log is asserted on its own (it may only grow, and growth is a finding)
      if (`${area}.${k}` in VOLATILE || `${area}.${k}` === 'local.hs_errors') continue
      if (area === 'local' && KEEPS[`local.${k}`]?.(v, b[area][k])) continue
      if (!(k in b[area])) out.push({ key: `${area}.${k}`, before: show(k, v), after: '(gone)' })
      else if (stable(v) !== stable(b[area][k])) out.push({ key: `${area}.${k}`, before: show(k, v), after: show(k, b[area][k]) })
    }
  return out
}
const keysOf = (s: Snap) => [...Object.keys(s.local).map((k) => `local.${k}`), ...Object.keys(s.sync).map((k) => `sync.${k}`)]

/** the chat rows on screen: who, platform, text, blanked or not */
const readRows = (p: any) =>
  p.evaluate(() => {
    const out: { who: string; muted: boolean; body: string; ts: boolean; old: boolean }[] = []
    for (const r of document.querySelectorAll('#hs-mc-messages .hs-mc-msg')) {
      const a = r.querySelector('.hs-mc-user:not(.hs-mc-reply-user)') as HTMLElement | null
      if (!a || a.dataset.platform !== 'twitch') continue
      out.push({
        who: (a.dataset.username || '').toLowerCase(),
        muted: r.classList.contains('hs-mc-muted'),
        body: ((r.querySelector('.hs-mc-text') as HTMLElement | null)?.textContent || '').toLowerCase(),
        ts: !!r.querySelector('.hs-mc-ts'),
        old: (r as HTMLElement).dataset.e2eOld === '1',
      })
    }
    return out
  }) as Promise<{ who: string; muted: boolean; body: string; ts: boolean; old: boolean }[]>

const STOP = new Set(['that', 'this', 'with', 'have', 'what', 'from', 'your', 'they', 'just', 'like', 'will', 'there', 'about', 'when', 'then', 'them', 'been', 'were', 'would', 'could', 'should'])
/** two chatters with a few rows each, and a plain word several rows say */
function pick(rows: Awaited<ReturnType<typeof readRows>>) {
  const by: Record<string, number> = {}
  for (const r of rows) if (r.who && r.who !== 'anonymous') by[r.who] = (by[r.who] || 0) + 1
  const names = Object.keys(by).sort((x, y) => by[y] - by[x])
  const words: Record<string, number> = {}
  for (const r of rows) for (const w of new Set(r.body.match(/\b[a-z]{4,12}\b/g) || [])) if (!STOP.has(w)) words[w] = (words[w] || 0) + 1
  const word = Object.keys(words).sort((x, y) => words[y] - words[x])[0]
  return { muted: names[0], blocked: names[1], word, wordRows: word ? words[word] : 0 }
}

export async function s26Upgrade() {
  scenario('s26 an old release upgraded in place keeps everything')
  const olds = (process.env.E2E_OLD_EXT || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!olds.length)
    return bad(
      'E2E_OLD_EXT is not set: build the old releases first — git worktree add --detach <dir> v1.7.136, then bun run build.js chrome --no-test there, copy dist/chrome somewhere, and pass the dirs comma separated',
    )
  const tw = await liveChannels('twitch', 3)
  const kk = await liveChannels('kick', 2)
  addHistoryKeys({ tw, kk })
  for (const old of olds) await leg(old, tw, kk)
}

async function leg(oldDir: string, tw: string[], kk: string[]) {
  const ver = (d: string) => {
    try {
      return JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8')).version as string
    } catch {
      return '?'
    }
  }
  const name = `${ver(oldDir)} → ${ver(EXT)}`
  info(`leg ${name}`)
  const tmp = mkdtempSync(join(tmpdir(), 'hs-e2e-upg-'))
  const profile = join(tmp, 'profile')
  const extDir = join(tmp, 'ext')
  mkdirSync(profile)
  cpSync(oldDir, extDir, { recursive: true })
  let env: Env | null = null
  try {
    // ── the old build: save real state ──
    env = await launch({ profile, ext: extDir })
    const extId = env.extId
    const p = await env.ctx.newPage()
    const stream = `https://www.twitch.tv/${tw[0]}`
    await p.goto(stream, { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(p)) || !(await rowsFlow(p, 45_000))) return bad(`${name}: the old build's chat never flowed on ${tw[0]}`, await panel(p))
    const channels = [
      { id: `mix-${tw[0]}`, twitch: tw[0], kick: kk[0] },
      { id: tw[1], twitch: tw[1] },
      { id: `k-${kk[1]}`, kick: kk[1] },
    ]
    await saveChannels(env, channels)
    await sleep(8000) // rows from a few chatters
    const who = pick(await readRows(p))
    if (!who.muted || !who.blocked || !who.word) return bad(`${name}: too little chat on ${tw[0]} to pick a chatter and a word`, who)
    info(`saving: mute one chatter, block another, hide the word "${who.word}" (${who.wordRows} rows said it)`)
    const now = Date.now()
    // a saved rule lives in two places (setting 'chatFilterRules' is local-mirror): the synced
    // settings record and its local copy. Writing only one is not a state a user can reach.
    const rules = JSON.stringify([{ id: 'e2e-hide', enabled: true, action: 'hide', color: '#ffff00', scope: 'all', match: { type: 'keyword', value: who.word } }])
    await writeLocal(env, {
      muted_users: [{ username: who.muted, expiresAt: now + 30 * 86400000 }],
      blocked_users: [who.blocked],
      chat_filter_rules: rules,
      recent_emotes: [
        { key: 'Kappa', name: 'Kappa', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0', provider: 'twitch' },
        { key: 'LUL', name: 'LUL', url: 'https://static-cdn.jtvnw.net/emoticons/v2/425618/default/dark/2.0', provider: 'twitch' },
      ],
      hs_user_notes_v1: { notes: { 'twitch:e2e_note_target': { text: 'written by the upgrade scenario', updatedAt: now } }, index: {} },
    })
    // a bool, a range and a text setting, all off their defaults
    await writeSync(env, {
      ui_settings: { ...((await readStorage(env)).sync.ui_settings as object | undefined), chatFilterRules: rules, timestamps: true, mentionSoundVolume: 0.65, mentionSoundName: 'e2e ping' },
    })
    await sleep(45_000) // a while on the stream, the old build writing whatever it writes
    const tabsBefore = ((await panel(p)).tabs || []) as string[]
    const A = await readStorage(env)
    await env.close()
    env = null
    // what was saved must be in the snapshot, or the scenario never saved it
    const pre: string[] = []
    if (!Array.isArray(A.local.muted_users) || !A.local.muted_users.length) pre.push('muted_users')
    if (!Array.isArray(A.local.blocked_users) || !A.local.blocked_users.length) pre.push('blocked_users')
    if (!String(A.local.chat_filter_rules || '').includes(who.word)) pre.push('chat_filter_rules')
    if (!Array.isArray(A.local.recent_emotes) || !A.local.recent_emotes.length) pre.push('recent_emotes')
    if (!A.local.hs_user_notes_v1) pre.push('hs_user_notes_v1')
    const ui: any = A.sync.ui_settings || {}
    if (ui.timestamps !== true || ui.mentionSoundVolume !== 0.65 || ui.mentionSoundName !== 'e2e ping') pre.push('ui_settings')
    if (((A.local.heatsync_multichat as any)?.channels || []).length !== channels.length) pre.push('heatsync_multichat')
    if (pre.length) return bad(`${name}: the old build did not hold what the scenario saved (${pre.join(', ')}) — scenario problem, not an upgrade result`)
    ok(`${name}: old build holds the saved state (${keysOf(A).length} keys in snapshot A)`)
    const savedIds = channels.map((c) => c.id)
    const order = (tabs: string[]) => tabs.map((t) => t.split('=')[0]).filter((id) => savedIds.includes(id))
    if (stable(order(tabsBefore)) !== stable(savedIds)) info(`old build's tabs: ${stable(order(tabsBefore))} (saved order ${stable(savedIds)})`)

    // ── the swap: the current build over the old one, in the same dir ──
    rmSync(extDir, { recursive: true, force: true })
    mkdirSync(extDir)
    cpSync(EXT, extDir, { recursive: true })
    // An unpacked extension swapped on disk keeps its old worker: chrome holds a worker's script
    // in the profile and went on running the OLD build's worker against the new build's pages
    // (both legs, 11-18), which then wrote the old build's keys. A store update never does that:
    // it installs the new version and registers its worker again. Dropping the profile's worker
    // cache is the same thing for an unpacked one; storage lives elsewhere and is not touched.
    // (chrome.runtime.reload() is not a way out: launched like this, the extension does not come back.)
    rmSync(join(profile, 'Default', 'Service Worker'), { recursive: true, force: true })

    // ── the current build, same profile ──
    const t0 = Date.now()
    env = await launch({ profile, ext: extDir })
    if (env.extId !== extId) return bad(`${name}: the extension id changed across the swap (${extId} → ${env.extId}): the profile's storage is orphaned`)
    ok(`${name}: same extension id after the swap, the worker started`)
    // is the worker running the file that is on disk now? chrome keeps a worker's script in the
    // profile, and a worker of the OLD build left running would write the old build's keys
    const readStale = () =>
      env
        .worker()
        .evaluate(async () => {
          // @ts-ignore — service worker globals
          const disk = await (await fetch(chrome.runtime.getURL('background.js'))).text()
          // @ts-ignore
          const fns = Object.keys(self).filter((k) => /^bg[A-Z]/.test(k) && typeof self[k] === 'function')
          // @ts-ignore
          return { n: fns.length, stale: fns.filter((k) => !disk.includes(self[k].toString())).slice(0, 8) }
        })
        .catch((e: any) => ({ n: -1, stale: [String(e?.message || e).slice(0, 80)] }))
    let staleFns = await readStale()
    // the worker may still be starting: one that is not there yet is not a stale one
    for (let i = 0; i < 10 && staleFns.n <= 0; i++) {
      await sleep(1000)
      staleFns = await readStale()
    }
    if (staleFns.stale.length) bad(`${name}: the worker is not running the build on disk (${staleFns.stale.length}+ of ${staleFns.n} functions differ)`, staleFns.stale)
    else info(`${name}: the worker runs the build on disk (${staleFns.n} functions compared)`)
    const errs: string[] = []
    const cons: string[] = []
    let loads = 0
    // the keyboard-layout read twitch itself does from a cross-origin frame (lib HOST_OWN): not ours
    env.ctx.on('weberror', (e: any) => {
      const m = String(e?.error?.() ?? e)
      if (!/getLayoutMap\(\) must be called from a top-level browsing context/.test(m)) errs.push(`worker/page uncaught: ${m.slice(0, 200)}`)
    })
    try {
      env.worker().on?.('console', (m: any) => m.type() === 'error' && cons.push(`worker: ${String(m.text()).slice(0, 160)}`))
    } catch {}
    const q = await env.ctx.newPage()
    watchErrors(q, 'page', errs)
    q.on('console', (m: any) => {
      const t = String(m.text())
      if (/context invalidated/i.test(t) || (m.type() === 'error' && /heatsync|Error in event handler/i.test(t))) cons.push(`page: ${t.slice(0, 160)}`)
    })
    q.on('load', () => loads++)
    await q.goto(stream, { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(q))) {
      // what the failure looks like: the worker's state, the page's own errors, and whether a reload brings the panel
      const sw = await swState(env)
      const page = await q.evaluate(() => ({ title: document.title.slice(0, 40), ready: document.readyState, hs: [...document.documentElement.attributes].map((a) => a.name).filter((n) => /hs|heat/i.test(n)), scripts: document.querySelectorAll('script[src*="chrome-extension"]').length, body: document.body?.children.length })).catch((e: unknown) => String(e))
      info(`${name}: panel missing; worker boot=${(sw as any).boot} err=${JSON.stringify((sw as any).errs || (sw as any).err).slice(0, 200)}; page=${JSON.stringify(page)}; errors=${JSON.stringify([...errs, ...cons]).slice(0, 300)}`)
      await q.reload({ waitUntil: 'domcontentloaded' })
      info(`${name}: after one reload the panel ${(await waitPanel(q, 30_000)) ? 'mounted' : 'is still missing'}`)
      return bad(`${name}: after the upgrade the panel never mounted`, await panel(q))
    }
    // rows on screen now came from saved history or the first seconds; later rows are live
    await q.evaluate(() => document.querySelectorAll('#hs-mc-messages .hs-mc-msg').forEach((r) => ((r as HTMLElement).dataset.e2eOld = '1')))
    if (!(await rowsFlow(q, 45_000))) bad(`${name}: after the upgrade chat rows never flowed`, await panel(q))
    else ok(`${name}: the panel mounted and chat rows flow on the new build`)
    // a mark on the page's own window: it is gone only if the page was loaded again. (The count of
    // load events is not that: twitch's first load event can land after the rows already flow.)
    await q.evaluate(() => ((window as any).__e2eSame = 1))
    await sleep(30_000)
    const same = await q.evaluate(() => (window as any).__e2eSame === 1).catch(() => false)
    if (!same) bad(`${name}: the page reloaded itself within 30s of the upgrade (${loads} load events)`)
    else ok(`${name}: the page did not reload itself (${loads} load event(s) over the wait)`)
    const B = await readStorage(env)

    // 1 nothing threw
    const ring = await ringSince(q, t0)
    if (errs.length || cons.length) bad(`${name}: errors after the upgrade`, [...errs, ...cons].slice(0, 6))
    else ok(`${name}: no uncaught error in the worker or the page, nothing about a dead context`)
    if (ring.bad.length) bad(`${name}: overlay watchdogs fired`, ring.bad.slice(0, 6))
    else ok(`${name}: the watchdog ring stayed quiet`)
    const errA = ((A.local.hs_errors as unknown[]) || []).length
    const errB = ((B.local.hs_errors as unknown[]) || []).length
    if (errB > errA) bad(`${name}: the add-on's own error log grew by ${errB - errA}`, ((B.local.hs_errors as unknown[]) || []).slice(errA, errA + 3))

    // 2 every key of A is back
    const gone = lost(A, B)
    if (gone.some((g) => g.key === 'local.heatsync_multichat')) {
      const [x, y] = [A.local.heatsync_multichat as any, B.local.heatsync_multichat as any]
      info(`multichat before: fields ${Object.keys(x)} ids ${(x.channels || []).map((c: any) => c.id)}; after: fields ${Object.keys(y || {})} ids ${(y?.channels || []).map((c: any) => `${c.id}[${Object.keys(c)}]`)}`)
    }
    for (const g of gone) info(`A→B ${g.key}: ${g.before.slice(-260)} ⇒ ${g.after.slice(-260)}`)
    if (gone.length) bad(`${name}: ${gone.length} saved key(s) lost or changed by the upgrade`, gone.slice(0, 12))
    else ok(`${name}: all ${keysOf(A).length} keys of snapshot A came back with the same values`)

    // 3 user-visible
    const tabsAfter = ((await panel(q)).tabs || []) as string[]
    if (stable(order(tabsAfter)) !== stable(savedIds)) bad(`${name}: saved channel tabs differ after the upgrade`, { saved: savedIds, now: tabsAfter })
    else ok(`${name}: the saved channel tabs are there in the same order`)
    const rows = await readRows(q)
    const mutedRows = rows.filter((r) => r.who === who.muted)
    const readable = mutedRows.filter((r) => !r.muted)
    if (readable.length) bad(`${name}: the muted chatter has ${readable.length} readable rows`, readable.slice(0, 2))
    else ok(`${name}: the muted chatter's rows are blanked (${mutedRows.length} on screen)`)
    const blockedRows = rows.filter((r) => r.who === who.blocked)
    if (blockedRows.length) bad(`${name}: the blocked chatter has ${blockedRows.length} rows on screen`)
    else ok(`${name}: the blocked chatter has no rows on screen`)
    // a whole word the way the rule engine reads one: letters and digits of any script on either
    // side make it another word (filter-rules.js _FR_WORD); \b knows only latin and called a row
    // where the word ran on into cyrillic a leak
    const re = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${who.word}(?![\\p{L}\\p{M}\\p{N}_])`, 'u')
    const said = rows.filter((r) => re.test(r.body))
    const hidden = said.filter((r) => !r.old)
    // rows redrawn from saved history at load are not what a hide rule was saved for here: counted, not judged
    if (said.length > hidden.length) info(`${name}: ${said.length - hidden.length} rows saying "${who.word}" were redrawn from history at load (not judged)`)
    if (hidden.length) bad(`${name}: the hide rule for "${who.word}" lets ${hidden.length} live rows through`, hidden.slice(0, 2).map((r) => { const at = r.body.search(re); return `…${r.body.slice(Math.max(0, at - 30), at + 40)}… (${r.body.length} long, word at ${at})` }))
    else ok(`${name}: the hide rule still hides "${who.word}" on live rows (${rows.filter((r) => !r.old).length} live of ${rows.length} on screen)`)
    if (!rows.length || !rows.some((r) => r.ts)) bad(`${name}: the timestamps setting did not take (${rows.filter((r) => r.ts).length}/${rows.length} rows show one)`)
    else ok(`${name}: the settings read back (timestamps on, ${rows.filter((r) => r.ts).length}/${rows.length} rows)`)
    if (!mutedRows.length) info('the muted chatter was not on screen after the upgrade: the mute is proved by storage only')
    await shot(q, 's26-after-upgrade')
    await env.close()
    env = null

    // ── once more: a migration must run once ──
    env = await launch({ profile, ext: extDir })
    const r = await env.ctx.newPage()
    watchErrors(r, 'page 3', errs)
    await r.goto(stream, { waitUntil: 'domcontentloaded' })
    if (!(await waitPanel(r)) || !(await rowsFlow(r, 45_000))) bad(`${name}: the third start never showed chat`, await panel(r))
    await sleep(30_000)
    const C = await readStorage(env)
    const drift = lost(B, C)
    for (const g of drift) info(`B→C ${g.key}: ${g.before.slice(0, 100)} ⇒ ${g.after.slice(0, 100)}`)
    if (drift.length) bad(`${name}: ${drift.length} key(s) changed between the second and third start`, drift.slice(0, 12))
    else ok(`${name}: the third start left every key as the second found it`)
    if (errs.length) bad(`${name}: errors by the third start`, errs.slice(0, 4))
  } finally {
    if (env) await env.close()
    rmSync(tmp, { recursive: true, force: true })
  }
}

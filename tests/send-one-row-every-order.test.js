/**
 * One send is ONE row marked [H], whatever order its events arrive in.
 *
 * A send to several platforms comes back as one echo per leg (twitch irc, kick
 * feed, youtube feed), one `chat:origin` per leg (server, to the whole room),
 * a per-room seed (GET /api/chat/origins) and, to the sender's OTHER devices,
 * an own-send notice (`chat_origin_broadcast`). This runs every arrival order
 * of those events, for 2-leg and 3-leg sends, on the three kinds of screen:
 *
 *   sender   the device that sent it (a local tracked entry, host page = a leg)
 *   other    another device of the sender (gets the notice, no local entry)
 *   viewer   somebody else (nothing but echoes, origins and the seed)
 *
 * and asserts, after the last event: one row, marked [H], that is one of the
 * legs. "After the last event" is strict on purpose: only the renders the code
 * itself asks for run (a quiet chat gives the 1s reconcile timer nothing to
 * wait for a late origin). A second check re-renders once more — what the very
 * next chat line would do — and the duplicate must be gone there too.
 *
 * What runs is the real code, nothing re-implemented: input.js's echo dedup and
 * retro-fold (carved), main.js's and social.js's own-echo blocks (carved),
 * hs-origins.js and merged-tab.js (imported). The pane is the model: a fake row
 * list, the buffers every leg lands in BEFORE the handler may drop it, and a
 * render that folds the buffers the way renderMessages does.
 *
 * Then the negatives: the same words from somebody else, and a send with no
 * send id, never fold into your line.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { platformMark } from '../src/lib/palette.js'
import { mainSource } from './main-src.js'

const MC = join(import.meta.dir, '..', 'src', 'multichat')
const read = (f) => readFileSync(join(MC, f), 'utf8')
const INPUT = read('input.js')
const IRC = read('irc.js')
const SOCIAL = read('social.js')
const MAIN = mainSource()

function between(src, a, b) {
  const s = src.indexOf(a)
  if (s === -1) throw new Error(`carve start not found: ${a}`)
  const e = src.indexOf(b, s + a.length)
  if (e === -1) throw new Error(`carve end not found: ${b}`)
  return src.slice(s, e)
}
const fn = (src, name) => {
  const start = src.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`"${name}" not found`)
  return src.slice(start, src.indexOf('\n}\n', start) + 2)
}

// ── the real code, carved ───────────────────────────────────────────────────
const ECHO_DEDUP = between(INPUT, '// Echo dedup — suppress own message echoes', '// Own-reply echo bar.')
const STRIP_DUP = `const DUP_BYPASS_CHAR = '\\u{E0000}'\n${fn(IRC, 'stripDupBypass')}`
// each handler's own-echo block: drop the dual-send copy, mark the line ours, record it
const TWITCH_OWN = between(
  MAIN,
  "// Suppress echo of own sent messages (dedup dual-send). Pass 'twitch'",
  '// Filter rules: drop',
)
const KICK_OWN = between(
  MAIN,
  '// kick is sent browser → kick, never seen by the server: record our own echo.',
  'const _frOwnKi',
)
const YT_OWN = between(SOCIAL, '// Recorded before the dual-send drop', '// Same pipeline as Twitch/Kick handlers')

let origins
let merged
let cur = null // the device under test: the bundle's globals read it
const saved = {}
const GLOBALS = [
  'platformMark',
  'safeSendMessage',
  'document',
  'isSelf',
  'scheduleMergedRender',
  'hsOriginStamp',
  '_unkickEmotes',
  'stripDupBypass',
]

beforeAll(async () => {
  for (const k of GLOBALS) saved[k] = globalThis[k]
  globalThis.platformMark = platformMark
  globalThis.safeSendMessage = (m) => Promise.resolve(cur?.api(m) ?? { ok: true })
  globalThis.document = { getElementById: (id) => (id === 'hs-mc-messages' ? cur?.pane : null) }
  globalThis.isSelf = (m, p) => cur.isSelf(m, p)
  globalThis.scheduleMergedRender = () => {
    cur.renderAsked = true
  }
  const { _unkickEmotes, stripDupBypass } = new Function(
    `${STRIP_DUP}\nconst _unkickEmotes = (s) => String(s ?? '').replace(/\\[emote:\\d+:([^\\]]+)\\]/g, '$1')\nreturn { stripDupBypass, _unkickEmotes }`,
  )()
  globalThis._unkickEmotes = _unkickEmotes
  globalThis.stripDupBypass = stripDupBypass
  origins = await import('../src/multichat/hs-origins.js')
  globalThis.hsOriginStamp = origins.hsOriginStamp
  merged = await import('../src/multichat/merged-tab.js')
  // the first row of a channel asks for its seed; ask now, with nothing to say, so no run is that one
  cur = { api: () => ({ data: { origins: [] } }), pane: { children: [] } }
  for (const p of ['twitch', 'kick', 'youtube'])
    origins.hsOriginStamp({ id: 'warm', platform: p, channel: 'room', originKey: 'room' })
  await new Promise((r) => setImmediate(r))
})
afterAll(() => {
  for (const k of GLOBALS) {
    if (saved[k] === undefined) delete globalThis[k]
    else globalThis[k] = saved[k]
  }
})

// ── the pane model ──────────────────────────────────────────────────────────
const SELF = { twitch: ['mellen'], kick: ['mellen_k'], youtube: ['@mellen_yt'] }
const WHO = { twitch: 'mellen', kick: 'mellen_k', youtube: '@mellen_yt' }
const WHO_ELSE = { twitch: 'rando_t', kick: 'rando_k', youtube: '@rando_y' }
const OFFSET = { twitch: 0, kick: 150, youtube: 800 }
const TEXT = 'gm chat'
let runNo = 0

const makeInput = new Function(
  'scope',
  `with (scope) {
    const _onceGuardsInput = {}
    ${STRIP_DUP}
    ${ECHO_DEDUP}
    return { trackSentMessage, isSentEcho, retroFoldOwnEchoes, claimHydratedEcho, peekSentHost, peekSentId, peekOwnSentHost, entries: () => _recentSentMessages }
  }`,
)

function device({ kind, host }) {
  const self = kind !== 'viewer'
  const d = {
    kind,
    pane: { children: [] },
    bufs: { twitch: [], kick: [], youtube: [] },
    renderAsked: false,
    witnessed: [], // [platform, messageId, sendId] posted to the server
    legs: {},
    isSelf: (m, p) => {
      const plat = p || m.badgePlatform || m.platform || 'twitch'
      return self && (SELF[plat === 'yt' ? 'youtube' : plat] || []).includes(String(m.user || '').toLowerCase())
    },
    api: (m) => {
      if (m.type === 'api_fetch' && m.method === 'POST') {
        d.witnessed.push([m.body.platform, m.body.message_id, m.body.send_id])
        return { ok: true }
      }
      if (m.type === 'api_fetch') {
        const plat = new URL(`http://x${m.path}`).searchParams.get('platform')
        return { data: { origins: d.serverOrigins.filter((o) => o.platform === plat) } }
      }
      return { ok: true }
    },
    serverOrigins: [],
  }
  d.inp = makeInput({
    chrome: { storage: { local: { set() {}, get: () => Promise.resolve({}) }, onChanged: {} } },
    cleanup: { addListener() {} },
    document: globalThis.document,
    hostPlatform: host || 'twitch',
    hsMarkBadgeHeatsync: origins.hsMarkBadgeHeatsync,
    _unindexMessageDiv() {},
    selfNamesFor: (p) => (self ? SELF[p] || [] : []),
    platformMark,
  })
  return d
}

function buildRow(d, m) {
  const badge = { className: '', style: {}, textContent: '' }
  const mk = platformMark(origins.hsOriginStamp(m) ? 'heatsync' : m.platform || 'twitch')
  badge.textContent = mk.label
  const row = {
    _hsMsg: m,
    badge,
    querySelector: (sel) => (sel === '.hs-mc-platform-badge' ? badge : null),
    remove() {
      const i = d.pane.children.indexOf(row)
      if (i >= 0) d.pane.children.splice(i, 1)
    },
  }
  return row
}

// renderMessages for a merged tab: every buffer, what is not hidden, folded, diffed into the pane
function render(d) {
  const all = [...d.bufs.twitch, ...d.bufs.kick, ...d.bufs.youtube].sort((a, b) => a.time - b.time)
  const toRender = merged.foldSimulcastLegs(all.filter((m) => !m.hidden))
  const keep = new Set(toRender)
  d.pane.children = d.pane.children.filter((r) => keep.has(r._hsMsg))
  for (const m of toRender) if (!d.pane.children.some((r) => r._hsMsg === m)) d.pane.children.push(buildRow(d, m))
}
// appendMessage for a merged tab: a line that may be another leg of one on screen waits for the render
function append(d, m) {
  if (merged.mayBeSimulcastLeg(m, d.pane.children)) d.renderAsked = true
  else d.pane.children.push(buildRow(d, m))
}
async function settle(d, seeded) {
  if (seeded) await new Promise((r) => setImmediate(r)) // a seed answers through a promise chain: let it finish
  for (let n = 0; d.renderAsked && n < 5; n++) {
    d.renderAsked = false
    render(d)
  }
}

const HANDLERS = {
  twitch: new Function('scope', `with (scope) { return (msg) => { ${TWITCH_OWN}\n return true } }`),
  kick: new Function('scope', `with (scope) { return (msg) => { ${KICK_OWN}\n return true } }`),
  youtube: new Function('scope', `with (scope) { return (ytMsg) => { ${YT_OWN}\n return true } }`),
}

function wire(d) {
  const i = d.inp
  const scope = {
    isSentEcho: i.isSentEcho,
    peekOwnSentHost: i.peekOwnSentHost,
    peekSentHost: i.peekSentHost,
    peekSentId: i.peekSentId,
    isSelf: d.isSelf,
    hsWitnessOwnEcho: origins.hsWitnessOwnEcho,
    restoreOwnReplyBar() {},
    claimYtSendingRow() {},
    authState: { nick: d.kind === 'viewer' ? '' : SELF.twitch[0] },
    currentUsername: d.kind === 'viewer' ? '' : SELF.twitch[0],
  }
  d.ingest = {
    twitch: HANDLERS.twitch(scope),
    kick: HANDLERS.kick(scope),
    youtube: HANDLERS.youtube(scope),
  }
}

function msgFor(plat, id, user, text, dt, base) {
  const m = { id, user, text, time: base + dt, channel: 'room' }
  if (plat !== 'twitch') m.platform = plat
  if (plat === 'youtube') m.originKey = 'room'
  return m
}

/**
 * One scenario: `plats` are the legs of the send, `events` an order. Event
 * forms: 'echo:<plat>', 'origin:<plat>', 'seed', 'notice', 'other:<plat>'
 * (somebody else's echo of the same words).
 */
async function run({ kind, host, plats, events, sendId = 'S', noSendId = false, strangers = [] }) {
  const n = ++runNo
  const d = device({ kind, host })
  cur = d
  wire(d)
  const base = Date.now()
  const sid = noSendId ? '' : `${sendId}-${n}`
  for (const p of plats) d.legs[p] = msgFor(p, `${p}-${n}`, WHO[p], TEXT, OFFSET[p], base)
  for (const p of strangers) d.legs[`other:${p}`] = msgFor(p, `x${p}-${n}`, WHO_ELSE[p], TEXT, OFFSET[p] + 40, base)
  d.serverOrigins = plats.map((p) => ({ platform: p, message_id: d.legs[p].id, origin: 'heatsync', send_id: sid }))
  if (kind === 'sender') d.inp.trackSentMessage(TEXT, host, 'synth', plats.length, false, sid)
  for (const ev of events) {
    const [what, p] = ev.split(':')
    if (what === 'echo' || what === 'other') {
      const m = d.legs[what === 'echo' ? p : `other:${p}`]
      const buf = d.bufs[p]
      buf.push(m)
      buf.sort((a, b) => a.time - b.time)
      if (d.ingest[p](m)) append(d, m)
    } else if (what === 'origin') {
      origins.hsOriginLive({ platform: p, channel: 'room', id: d.legs[p].id, sendId: sid })
    } else if (what === 'seed') {
      origins.hsOriginsReseed()
    } else if (what === 'notice') {
      d.inp.trackSentMessage(TEXT, 'heatsync')
      d.inp.retroFoldOwnEchoes()
    }
    await settle(d, what === 'seed')
  }
  const strict = d.pane.children.map((r) => r._hsMsg)
  const marks = d.pane.children.map((r) => r.badge.textContent)
  render(d)
  const healed = d.pane.children.map((r) => r._hsMsg)
  return { d, strict, marks, healed }
}

function* permutations(items) {
  if (items.length <= 1) {
    yield items
    return
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)]
    for (const p of permutations(rest)) yield [items[i], ...p]
  }
}

const label = (events) => events.join(' > ')
const report = (bad, count) => `${bad.length} of ${count} orders break:\n${bad.slice(0, 10).join('\n')}`

async function sweep({ kind, host, plats, withNotice }) {
  const events = [...plats.map((p) => `echo:${p}`), ...plats.map((p) => `origin:${p}`), 'seed']
  if (withNotice) events.push('notice')
  const bad = []
  let count = 0
  for (const order of permutations(events)) {
    count++
    const { d, strict, marks, healed } = await run({ kind, host, plats, events: order })
    const ids = plats.map((p) => d.legs[p].id)
    const problems = []
    if (strict.length !== 1) problems.push(`${strict.length} rows after the last event`)
    else if (!ids.includes(strict[0].id)) problems.push('the row is not one of the legs')
    else if (marks[0] !== '[H]') problems.push(`row marked ${marks[0]}`)
    if (healed.length !== 1) problems.push(`${healed.length} rows after one more render`)
    if (kind === 'sender') {
      // kick and youtube never pass through the server: the sender records each leg's own echo,
      // whether or not the dual-send dedup drops that echo from the pane
      for (const p of plats.filter((x) => x !== 'twitch'))
        if (!d.witnessed.some((w) => w[0] === p && w[1] === d.legs[p].id && w[2]))
          problems.push(`${p} leg never recorded with its send id`)
    }
    if (problems.length) bad.push(`${label(order)} => ${problems.join('; ')}`)
  }
  return { bad, count }
}

const LONG = 120_000
const sweeps = (plats, counts) => {
  const names = plats.join('+')
  test(
    `${names}: a viewer`,
    async () => {
      const { bad, count } = await sweep({ kind: 'viewer', plats })
      expect(count).toBe(counts.viewer)
      expect(report(bad, count)).toBe(`0 of ${count} orders break:\n`)
    },
    LONG,
  )
  test(
    `${names}: the sender's other device, told by the notice`,
    async () => {
      const { bad, count } = await sweep({ kind: 'other', plats, withNotice: true })
      expect(count).toBe(counts.other)
      expect(report(bad, count)).toBe(`0 of ${count} orders break:\n`)
    },
    LONG,
  )
  for (const host of plats) {
    test(
      `${names}: the sender, sending from ${host}`,
      async () => {
        const { bad, count } = await sweep({ kind: 'sender', host, plats })
        expect(count).toBe(counts.viewer)
        expect(report(bad, count)).toBe(`0 of ${count} orders break:\n`)
      },
      LONG,
    )
  }
  test(
    `${names}: the sender, also told by the notice`,
    async () => {
      const { bad, count } = await sweep({ kind: 'sender', host: plats[0], plats, withNotice: true })
      expect(count).toBe(counts.other)
      expect(report(bad, count)).toBe(`0 of ${count} orders break:\n`)
    },
    LONG,
  )
}

describe('2 legs, every arrival order', () => {
  sweeps(['twitch', 'kick'], { viewer: 120, other: 720 })
})
describe('2 legs, the other pairs', () => {
  sweeps(['twitch', 'youtube'], { viewer: 120, other: 720 })
  sweeps(['kick', 'youtube'], { viewer: 120, other: 720 })
})
describe('3 legs, every arrival order', () => {
  sweeps(['twitch', 'kick', 'youtube'], { viewer: 5040, other: 40320 })
})

// ── the same words from somebody else, and a send with no send id ───────────
// Somebody else's identical line is a row of its own in every order and on every screen; yours is
// still one [H] row. With no send id nothing can be proven, so a viewer folds nothing (two
// legs sent under two names stay two rows) and nobody's line is folded into someone else's.
async function sweepStrangers({ kind, host, plats, strangerOn, extra = [] }) {
  const events = [...plats.map((p) => `echo:${p}`), ...plats.map((p) => `origin:${p}`), `other:${strangerOn}`, ...extra]
  const bad = []
  let count = 0
  for (const order of permutations(events)) {
    count++
    const r = await run({ kind, host, plats, events: order, strangers: [strangerOn] })
    const ids = plats.map((p) => r.d.legs[p].id)
    const mine = r.strict.filter((m) => ids.includes(m.id))
    const theirs = r.strict.filter((m) => m.id === r.d.legs[`other:${strangerOn}`].id)
    const problems = []
    if (r.strict.length !== 2) problems.push(`${r.strict.length} rows after the last event`)
    if (mine.length !== 1) problems.push(`${mine.length} rows of yours`)
    if (theirs.length !== 1) problems.push('their line is gone')
    else if (theirs[0].hsOrigin || theirs[0].platform === 'heatsync') problems.push('their line wears [H]')
    if (r.healed.length !== 2) problems.push(`${r.healed.length} rows after one more render`)
    if (problems.length) bad.push(`${label(order)} => ${problems.join('; ')}`)
  }
  return { bad, count }
}

describe('somebody else saying the same words never folds into your send', () => {
  for (const kind of ['viewer', 'other', 'sender']) {
    for (const strangerOn of ['twitch', 'kick']) {
      test(
        `${kind}: 2 legs, a stranger on ${strangerOn}`,
        async () => {
          const { bad, count } = await sweepStrangers({
            kind,
            host: 'twitch',
            plats: ['twitch', 'kick'],
            strangerOn,
            extra: kind === 'viewer' ? ['seed'] : ['seed', 'notice'],
          })
          expect(count).toBe(kind === 'viewer' ? 720 : 5040)
          expect(report(bad, count)).toBe(`0 of ${count} orders break:\n`)
        },
        LONG,
      )
    }
  }
  test(
    'sender: 3 legs, a stranger on kick',
    async () => {
      const { bad, count } = await sweepStrangers({
        kind: 'sender',
        host: 'twitch',
        plats: ['twitch', 'kick', 'youtube'],
        strangerOn: 'kick',
      })
      expect(count).toBe(5040)
      expect(report(bad, count)).toBe(`0 of ${count} orders break:\n`)
    },
    LONG,
  )
  test(
    'viewer: 3 legs, a stranger on twitch',
    async () => {
      const { bad, count } = await sweepStrangers({
        kind: 'viewer',
        plats: ['twitch', 'kick', 'youtube'],
        strangerOn: 'twitch',
      })
      expect(count).toBe(5040)
      expect(report(bad, count)).toBe(`0 of ${count} orders break:\n`)
    },
    LONG,
  )
})

describe('a send with no send id', () => {
  test('a viewer folds nothing it cannot prove: two names, two rows, never folded into a stranger', async () => {
    const events = ['echo:twitch', 'echo:kick', 'other:kick', 'origin:twitch', 'origin:kick', 'seed']
    const bad = []
    let count = 0
    for (const order of permutations(events)) {
      count++
      const r = await run({
        kind: 'viewer',
        plats: ['twitch', 'kick'],
        events: order,
        strangers: ['kick'],
        noSendId: true,
      })
      const who = r.strict.map((m) => m.user).sort()
      if (who.join() !== ['mellen', 'mellen_k', 'rando_k'].sort().join())
        bad.push(`${label(order)} => rows ${who.join(', ')}`)
      if (r.healed.length !== 3) bad.push(`${label(order)} => ${r.healed.length} rows after one more render`)
    }
    expect(count).toBe(720)
    expect(report(bad, count)).toBe(`0 of ${count} orders break:\n`)
  })
  test("the sender's other device still folds its own legs by name, and keeps a stranger's line", async () => {
    const events = ['echo:twitch', 'echo:kick', 'other:twitch', 'origin:twitch', 'origin:kick', 'notice']
    const bad = []
    for (const order of permutations(events)) {
      const r = await run({
        kind: 'other',
        plats: ['twitch', 'kick'],
        events: order,
        strangers: ['twitch'],
        noSendId: true,
      })
      const who = r.healed.map((m) => m.user).sort()
      if (who.length !== 2 || !who.includes('rando_t')) bad.push(`${label(order)} => rows ${who.join(', ')}`)
    }
    expect(report(bad, 720)).toBe('0 of 720 orders break:\n')
  })
})

// ── the paths the sweeps found, one trace each ──────────────────────────────
describe('the duplicate paths, named', () => {
  const rows = (r) => r.strict.map((m) => `${m.user}:${r.marks[r.strict.indexOf(m)]}`)

  test('late origins: both legs already on screen, the origins fold them without another chat line', async () => {
    const r = await run({
      kind: 'viewer',
      plats: ['twitch', 'kick'],
      events: ['echo:twitch', 'echo:kick', 'origin:twitch', 'origin:kick'],
    })
    expect(rows(r)).toEqual(['mellen:[H]'])
  })

  test('the notice after the twitch echo: the row it marks [H] keeps its twitch identity, so its origin finds it', async () => {
    const r = await run({
      kind: 'other',
      plats: ['twitch', 'kick'],
      events: ['echo:twitch', 'notice', 'origin:twitch', 'origin:kick', 'echo:kick'],
    })
    expect(r.d.legs.twitch.hsSendId).toBe(r.d.legs.kick.hsSendId)
    expect(r.d.legs.twitch.hsSendId).toBeTruthy()
    expect(r.healed).toHaveLength(1)
  })

  test('a kick echo the dual-send dedup drops is still recorded with the send id', async () => {
    const r = await run({
      kind: 'sender',
      host: 'twitch',
      plats: ['twitch', 'kick'],
      events: ['echo:twitch', 'echo:kick'],
    })
    expect(r.d.witnessed).toEqual([['kick', r.d.legs.kick.id, expect.stringMatching(/^S-/)]])
  })

  test('same for youtube, and a youtube echo that beats the twitch one is still the youtube leg', async () => {
    const a = await run({
      kind: 'sender',
      host: 'twitch',
      plats: ['twitch', 'youtube'],
      events: ['echo:twitch', 'echo:youtube'],
    })
    expect(a.d.witnessed.map((w) => w[0])).toEqual(['youtube'])
    const b = await run({
      kind: 'sender',
      host: 'twitch',
      plats: ['twitch', 'youtube'],
      events: ['echo:youtube', 'echo:twitch', 'origin:twitch', 'origin:youtube'],
    })
    expect(rows(b)).toEqual(['@mellen_yt:[H]'])
    expect(b.healed).toHaveLength(1)
  })

  test("a stranger's identical line is not eaten by the dedup that belongs to your own echo", async () => {
    const r = await run({
      kind: 'sender',
      host: 'twitch',
      plats: ['twitch'],
      events: ['echo:twitch', 'other:kick'],
      strangers: ['kick'],
    })
    expect(r.strict.map((m) => m.user).sort()).toEqual(['mellen', 'rando_k'])
  })

  test("the notice does not hide a stranger's identical line", async () => {
    const r = await run({
      kind: 'other',
      plats: ['twitch'],
      events: ['other:kick', 'echo:twitch', 'notice'],
      strangers: ['kick'],
    })
    expect(r.healed.map((m) => m.user).sort()).toEqual(['mellen', 'rando_k'])
  })

  test('a line typed natively after the dedup window does not inherit the old send id', async () => {
    const d = device({ kind: 'sender', host: 'twitch' })
    cur = d
    wire(d)
    d.inp.trackSentMessage(TEXT, 'twitch', 'synth', 1, false, 'old-send')
    d.inp.entries()[0].time -= 60_000
    const m = msgFor('kick', 'k-native', WHO.kick, TEXT, 0, Date.now())
    d.ingest.kick(m)
    expect(d.witnessed).toEqual([])
    d.inp.entries()[0].time += 55_000
    d.ingest.kick(msgFor('kick', 'k-echo', WHO.kick, TEXT, 0, Date.now()))
    expect(d.witnessed).toEqual([['kick', 'k-echo', 'old-send']])
  })

  test('an [H] row that learned no send id takes it when it arrives, and keeps it', () => {
    // the desktop client's bug: marked [H] early, then skipped when the id came
    origins.hsOriginNote('kick', 'late-1', '')
    const row = { platform: 'kick', id: 'late-1', channel: 'room', text: 'hi' }
    expect(origins.hsOriginStamp(row)).toBe(true)
    expect(row.hsSendId).toBeUndefined()
    origins.hsOriginNote('kick', 'late-1', 'send-late')
    origins.hsOriginStamp(row)
    expect(row.hsSendId).toBe('send-late')
    origins.hsOriginNote('kick', 'late-1', '')
    const again = { platform: 'kick', id: 'late-1', channel: 'room', text: 'hi' }
    origins.hsOriginStamp(again)
    expect(again.hsSendId).toBe('send-late')
  })
})

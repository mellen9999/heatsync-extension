/**
 * Merged tabs (twitch + kick + youtube in one pane) append plain live lines
 * and let the real render do the fair trim, instead of repainting the pane
 * every frame. The claim worth proving:
 *
 *   between renders, the pane holds EVERY row a full render would keep, plus
 *   at most MT_OVERSHOOT older ones; at every render it is exactly what a
 *   full render keeps.
 *
 * Both halves run the REAL code: fairMerge (and fairCoLive) sliced out of
 * main.js the way message-ordering.test.js does it, and the gate rules from
 * src/multichat/merged-tab.js imported as they are. Only the pane is a model
 * (a set of row keys): a render replaces it with fairMerge's answer, an
 * append adds one key. Random interleaved streams: a firehose, a trickle, a
 * source that wakes after a quiet spell, one that starts from nothing, lag
 * (a row stamped behind the ones before it), ties, bursts, long gaps.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ordOf, sortedInsert } from '../src/lib/utils.js'
import { mainSource } from './main-src.js'

const ROOT = join(import.meta.dir, '..')
const MAIN_SRC = mainSource()
const MT_SRC = readFileSync(join(ROOT, 'src', 'multichat', 'merged-tab.js'), 'utf8')

function sliceBetween(src, a, b) {
  const s = src.indexOf(a)
  const e = src.indexOf(b, s)
  if (s === -1 || e === -1) throw new Error(`marker not found: ${s === -1 ? a : b}`)
  return src.slice(s, e)
}

const mergeSrc = sliceBetween(MAIN_SRC, 'function mergeSortedRuns(runs) {', '\nfunction msgKeyOf(m) {')
function loadMerge(cap) {
  return new Function(
    'ordOf',
    'MC_DEBUG',
    'log',
    'DOM_RENDER_CAP',
    '__HS_DEV_BUILD__',
    `${mergeSrc}\nreturn { fairMerge, fairCoLive, stableMsgId }`,
  )(ordOf, false, () => {}, cap, true)
}

let mt // merged-tab.js, imported once the globals it reads exist
beforeAll(async () => {
  const { fairCoLive } = loadMerge(500)
  globalThis.ordOf = ordOf
  globalThis.fairCoLive = fairCoLive
  mt = await import('../src/multichat/merged-tab.js')
})

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MIN = 60 * 1000

/**
 * Run one random stream through the append rule. `gate` is the rule under
 * test; the control run swaps in a wrong one. Returns what was observed.
 */
function simulate({ seed, cap, steps, scenario, gate, timer = true }) {
  const { fairMerge, stableMsgId } = loadMerge(cap)
  const rand = rng(seed)
  const realNow = Date.now
  let clock = 1_800_000_000_000
  Date.now = () => clock
  try {
    const src = [[], [], []]
    let n = 0
    const mk = (si, ord) => ({ id: `s${si}-${n++}`, user: `u${n % 50}`, text: 't', time: ord, ord })
    // history already on screen: old rows, no ord (history is chronological)
    const hist = scenario === 'cold-yt' ? [90, 50, 0] : [90, 50, 30]
    for (let si = 0; si < 3; si++)
      for (let i = hist[si]; i > 0; i--)
        src[si].push({ id: `h${si}-${n++}`, user: 'h', text: 'h', time: clock - i * 400 })
    const keysOf = (arr) => new Set(arr.map(stableMsgId))
    const oracle = () => keysOf(fairMerge(src.map((s) => s.slice(-1500))))

    let pane = new Set()
    let state = null
    const render = () => {
      const srcs = src.map((s) => s.slice(-1500))
      pane = keysOf(fairMerge(srcs))
      state = { tab: 't', regime: mt.mtRegime(srcs), at: clock, n: 0, timer: 0 }
    }
    render()

    const seen = { appended: 0, rendered: 0, timerRenders: 0, worstExtra: 0, missing: 0, notExactAtRender: 0 }
    const check = (rendered) => {
      const o = oracle()
      let missing = 0
      for (const k of o) if (!pane.has(k)) missing++
      let extra = 0 // rows on screen beyond what a render keeps
      for (const k of pane) if (!o.has(k)) extra++
      seen.missing += missing
      seen.worstExtra = Math.max(seen.worstExtra, extra)
      if (rendered && (missing || extra)) seen.notExactAtRender++
    }

    for (let step = 0; step < steps; step++) {
      // the gap before the next line: bursts, steady chat, the odd long silence
      const r = rand()
      let gap = r < 0.35 ? 8 : r < 0.9 ? 30 + rand() * 120 : r < 0.985 ? 400 + rand() * 900 : 2000 + rand() * 90_000
      if (scenario === 'wake' && step === Math.floor(steps / 2)) gap = 11 * MIN + rand() * 20 * MIN
      if (scenario === 'drift' && step === Math.floor(steps / 2)) gap = 61 * MIN
      const due = clock + gap
      // the trailing render that fires when no more chat comes
      if (timer && state.n > 0 && state.at + mt.MT_RECONCILE_MS <= due) {
        clock = state.at + mt.MT_RECONCILE_MS
        render()
        seen.timerRenders++
        check(true)
      }
      clock = due

      // which platform speaks
      // (in 'wake' kick stays silent until the middle, then joins in)
      const w = rand()
      let si
      if (scenario === 'wake') si = step < steps / 2 ? (w < 0.88 ? 0 : 2) : w < 0.55 ? 0 : w < 0.8 ? 1 : 2
      else if (scenario === 'cold-yt') si = w < 0.8 ? 0 : w < 0.97 ? 1 : 2
      else si = w < 0.7 ? 0 : w < 0.9 ? 1 : 2
      // lag: kick and youtube lines often carry a stamp a little behind their arrival
      const lag = si === 0 ? 0 : rand() < 0.5 ? Math.floor(rand() * 1500) : 0
      const ord = rand() < 0.1 ? Math.max(1, Math.floor((clock - lag) / 100) * 100) : clock - lag // some exact ties
      const msg = mk(si, ord)
      sortedInsert(src[si], msg)

      const ok = gate(state, 't', msg, mt.mtRegime(src.map((s) => s.slice(-1))), clock)
      if (ok) {
        pane.add(stableMsgId(msg))
        state.n++
        seen.appended++
        check(false)
      } else {
        render()
        seen.rendered++
        check(true)
      }
    }
    return seen
  } finally {
    Date.now = realNow
  }
}

const realGate = (state, tab, msg, regime, now) => mt.mtAppendOk(state, tab, msg, regime, now)

// the simulations are seconds of CPU on a quiet box; leave room for a busy one
const SIM_TIMEOUT = 30_000

describe('merged tab: append, then the real render trims', () => {
  for (const scenario of ['steady', 'wake', 'cold-yt', 'drift']) {
    for (const cap of [60, 500]) {
      test(
        `${scenario}, cap ${cap}: never short a row the render keeps, never more than the overshoot, exact at each render`,
        () => {
          const cases = cap === 60 ? 24 : 4
          let appended = 0
          let rendered = 0
          let timer = 0
          for (let seed = 1; seed <= cases; seed++) {
            const seen = simulate({
              seed: seed * 7919 + cap,
              cap,
              steps: cap === 60 ? 500 : 1200,
              scenario,
              gate: realGate,
            })
            expect(seen.missing).toBe(0)
            expect(seen.worstExtra).toBeLessThanOrEqual(mt.MT_OVERSHOOT)
            expect(seen.notExactAtRender).toBe(0)
            appended += seen.appended
            rendered += seen.rendered
            timer += seen.timerRenders
          }
          // not vacuous: the fast path did the work, and the renders still happened
          expect(appended).toBeGreaterThan(rendered)
          expect(rendered + timer).toBeGreaterThan(0)
        },
        SIM_TIMEOUT,
      )
    }
  }

  test(
    'control: without the regime check a source waking after a quiet spell leaves rows missing',
    () => {
      // the rule is only safe because it hands the render every change of regime;
      // this proves the simulation can see the failure when it is taken away
      const noRegime = (state, tab, msg, _regime, now) => mt.mtAppendOk(state, tab, msg, state?.regime, now)
      let missing = 0
      for (let seed = 1; seed <= 40; seed++)
        missing += simulate({ seed: seed * 104729, cap: 60, steps: 600, scenario: 'wake', gate: noRegime }).missing
      expect(missing).toBeGreaterThan(0)
    },
    SIM_TIMEOUT,
  )

  test(
    'control: with no bound on the count, the time, or the trailing render, the pane grows past the cap',
    () => {
      const unbounded = (state, tab, msg, regime, now) =>
        mt.mtAppendOk({ ...state, n: 0, at: now }, tab, msg, regime, now)
      let worst = 0
      for (let seed = 1; seed <= 10; seed++)
        worst = Math.max(
          worst,
          simulate({ seed: seed * 31, cap: 60, steps: 600, scenario: 'steady', gate: unbounded, timer: false })
            .worstExtra,
        )
      expect(worst).toBeGreaterThan(mt.MT_OVERSHOOT)
    },
    SIM_TIMEOUT,
  )
})

describe('mtAppendOk: what rides the fast path', () => {
  const fresh = { tab: 'live', regime: 7, at: 1000, n: 0 }
  const line = { ord: 1500, user: 'a', text: 'hi' }
  test('a plain live line in an unchanged regime, soon after a render', () => {
    expect(mt.mtAppendOk(fresh, 'live', line, 7, 1500)).toBe(true)
  })
  test('anything that is not a plain live line goes to the render', () => {
    for (const msg of [
      { ...line, type: 'stream-event' },
      { ...line, type: 'notice' },
      { ...line, type: 'cmd-receipt' },
      { user: 'a', text: 'history row' }, // no ord: history weaves into place, it does not append
    ])
      expect(mt.mtAppendOk(fresh, 'live', msg, 7, 1500)).toBe(false)
  })
  test('a different tab, no render yet, or a changed regime go to the render', () => {
    expect(mt.mtAppendOk(fresh, 'other', line, 7, 1500)).toBe(false)
    expect(mt.mtAppendOk(null, 'live', line, 7, 1500)).toBe(false)
    expect(mt.mtAppendOk(fresh, 'live', line, 5, 1500)).toBe(false)
  })
  test('the render is never more than a second behind, nor more than the overshoot rows', () => {
    expect(mt.mtAppendOk(fresh, 'live', line, 7, 1000 + mt.MT_RECONCILE_MS)).toBe(true)
    expect(mt.mtAppendOk(fresh, 'live', line, 7, 1001 + mt.MT_RECONCILE_MS)).toBe(false)
    expect(mt.mtAppendOk({ ...fresh, n: mt.MT_OVERSHOOT - 1 }, 'live', line, 7, 1500)).toBe(true)
    expect(mt.mtAppendOk({ ...fresh, n: mt.MT_OVERSHOOT }, 'live', line, 7, 1500)).toBe(false)
  })
})

describe('mtRegime: what the fairness policy keys its choice on', () => {
  const t = Date.now()
  const rows = (...ords) => ords.map((ord) => ({ ord, time: ord }))
  test('which sources have rows, and whether they are co-live', () => {
    const live = mt.mtRegime([rows(t), rows(t - 1000), []])
    expect(live).toBe(3 * 2 + 1) // twitch + kick, co-live
    expect(mt.mtRegime([rows(t), rows(t - 20 * MIN), []])).toBe(3 * 2 + 0) // same sources, kick gone stale
    expect(mt.mtRegime([rows(t), rows(t - 1000), rows(t - 500)])).toBe(7 * 2 + 1)
    expect(mt.mtRegime([[], [], []])).toBe(0)
  })
  test('a single source is never co-live (nothing to be drowned)', () => {
    expect(mt.mtRegime([rows(t), [], []])).toBe(1 * 2 + 0)
  })
  test('a newly active source changes the regime', () => {
    expect(mt.mtRegime([rows(t), rows(t), []])).not.toBe(mt.mtRegime([rows(t), rows(t), rows(t)]))
  })
})

describe('mergedTabSources: one resolver for the render and the gate', () => {
  const names = [
    'getLiveChannel',
    'getLivePlatformNames',
    'getCurrentChannel',
    'getChannelById',
    'hostPlatform',
    'irc',
    'kickChat',
    'config',
    'channelYtMessages',
  ]
  const saved = {}
  const ring = (rows) => ({ getTail: (_ch, n) => rows.slice(-n), channels: new Map(), join() {} })
  function world(over = {}) {
    const w = {
      getLiveChannel: () => 'streamer',
      getLivePlatformNames: () => ({ twitch: 'streamer', kick: 'streamer', youtube: '' }),
      getCurrentChannel: () => 'streamer',
      getChannelById: (id) => w.config.channels.find((c) => c.id === id),
      hostPlatform: 'twitch',
      irc: ring(['t1', 't2', 't3']),
      kickChat: ring(['k1', 'k2']),
      config: { channels: [] },
      channelYtMessages: new Map(),
      ...over,
    }
    for (const n of names) globalThis[n] = w[n]
    return w
  }
  beforeAll(() => {
    for (const n of names) saved[n] = globalThis[n]
  })
  afterAll(() => {
    for (const n of names) globalThis[n] = saved[n]
  })

  test('live tab: the newest `take` rows of each leg, in fairMerge order [twitch, kick, youtube]', () => {
    const yt = [1, 2, 3]
    world({ channelYtMessages: new Map([['__live_yt_auto__', yt]]) })
    expect(mt.mergedTabSources('live', 2)).toEqual([['t2', 't3'], ['k1', 'k2'], yt])
    expect(mt.mergedTabSources('live', 1)[0]).toEqual(['t3'])
  })
  test('live tab: a kick leg missing under the same name comes from the config link', () => {
    world({
      kickChat: { getTail: (ch, n) => (ch === 'linkedkick' ? ['lk1', 'lk2'].slice(-n) : []), channels: new Map() },
      config: { channels: [{ id: 'c1', twitch: 'streamer', kick: 'linkedkick' }] },
    })
    expect(mt.mergedTabSources('live', 5)[1]).toEqual(['lk1', 'lk2'])
  })
  test('live tab: youtube falls back to the config-linked channel when the auto bucket is empty', () => {
    const linked = [{ id: 'y1' }]
    world({
      config: { channels: [{ id: 'c1', twitch: 'streamer', youtube: 'https://youtu.be/x' }] },
      channelYtMessages: new Map([['c1', linked]]),
    })
    expect(mt.mergedTabSources('live', 5)[2]).toBe(linked)
  })
  test('live tab: on a youtube page there is no same-name guess for twitch or kick', () => {
    world({ hostPlatform: 'yt', getLivePlatformNames: () => ({ twitch: '', kick: '', youtube: '' }) })
    expect(mt.mergedTabSources('live', 5).slice(0, 2)).toEqual([[], []])
  })
  test('only the render joins channels it reads', () => {
    const joined = []
    const r = { ...ring(['a']), channels: new Map(), join: (c) => joined.push(`t:${c}`) }
    const k = { ...ring(['b']), channels: new Map(), join: (c) => joined.push(`k:${c}`) }
    world({ irc: r, kickChat: k })
    mt.mergedTabSources('live', 1)
    expect(joined).toEqual([])
    mt.mergedTabSources('live', 1, true)
    expect(joined).toEqual(['t:streamer', 'k:streamer'])
  })
  test("channel tab: its own twitch, kick and youtube legs, and never the live tab's auto bucket", () => {
    const own = [{ id: 'o' }]
    world({
      config: { channels: [{ id: 'tab1', twitch: 'streamer', kick: 'streamer', youtube: 'yt' }] },
      channelYtMessages: new Map([
        ['tab1', own],
        ['__live_yt_auto__', [{ id: 'bleed' }]],
      ]),
    })
    const [t, k, y] = mt.mergedTabSources('tab1', 2)
    expect(t).toEqual(['t2', 't3'])
    expect(k).toEqual(['k1', 'k2'])
    expect(y).toBe(own)
  })
  test('an unknown tab id has no sources rather than throwing', () => {
    world()
    expect(mt.mergedTabSources('nope', 3)).toEqual([[], [], []])
  })
})

describe('wiring in main.js', () => {
  const append = sliceBetween(MAIN_SRC, 'function appendMessage(msg, tabId) {', '// Render epoch')
  test('a merged tab asks the gate before appending, and the render otherwise', () => {
    expect(append).toMatch(/const merged = isMultiPlatformTab\(tabId\)/)
    expect(append).toMatch(
      /merged &&\s*\(!mtCanAppend\(msg, tabId, _ff\.dups\) \|\|\s*mayBeSimulcastLeg\([^)]*\)[^)]*\)\)\s*\) \{\s*scheduleMergedRender\(\)/,
    )
  })
  test('the append never trims a merged tab (the platform-blind slice is single-platform only)', () => {
    expect(append).toMatch(
      /if \(merged\) mtNoteAppend\(\)\s*else if \(msgsEl\.childElementCount > DOM_RENDER_CAP \+ 50\)/,
    )
  })
  test('every merged render says what it left, and any render forgets the last', () => {
    expect(MAIN_SRC).toMatch(/mtNoteRender\(id, null\)/)
    expect(MAIN_SRC.match(/mtNoteRender\(id, mtSrcs\)/g)?.length).toBe(2) // the diff path and the cache-restore path
    expect(MAIN_SRC).toMatch(/mtSrcs = mergedTabSources\(id, SCROLLBACK_MAX, true\)/)
  })
  test('the render and the gate read their sources from the same resolver', () => {
    expect(MT_SRC).toMatch(/function mergedTabSources\(id, take, ensureJoined\)/)
    expect(MAIN_SRC).not.toMatch(/__live_yt_auto__'\) \|\| \[\]\n\s+if \(!ytMsgs\.length && curCh\)/)
  })
})

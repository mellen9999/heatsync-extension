/**
 * Cross-platform message ordering — the invariant every per-platform chat
 * buffer stays sorted non-decreasing by `ordOf` (src/lib/utils.js), so the
 * k-way merge in main.js (mergeSortedRuns/fairMerge) is correct and linear
 * without a per-frame full sort.
 *
 * Layers under test, each against the REAL source (no reimplementation):
 *  - ordOf / findOrdInsertIndex / sortedInsert  — src/lib/utils.js, real import.
 *  - CircularBuffer.tail() / insertOrdered()     — src/multichat/irc.js, real
 *    import (it already has a test-only `export` — see tests/irc-parser.test.js).
 *    insertOrdered calls the bare globals `ordOf`/`findOrdInsertIndex` (same
 *    bundle-scope convention irc.js already relies on for `sanitizeColor`/`t`
 *    in irc-parser.test.js) — stubbed on globalThis with the REAL utils.js
 *    implementations, not fakes.
 *  - mergeSortedRuns / fairMerge / byTimeStable — src/multichat/main.js is a
 *    single top-level IIFE with no exports (see tests/sanitize-color.test.js
 *    for the established pattern this follows), so the functions are sliced
 *    out of the real source text and rebuilt with `new Function`.
 *  - ingestReplayYtMsg / commitPacedYtMsg        — src/multichat/social.js,
 *    same source-slice approach; verifies the `time` vs `ord` split (change
 *    #1 in the mapping pass this suite backs) and that both writers keep the
 *    shared `channelYtMessages` buffer sorted (change #2).
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  _resetVisualNow,
  findOrdInsertIndex,
  LIVE_WEAVE_SKEW_MS,
  liveOrd,
  ordOf,
  sortedInsert,
  visualNowOrd,
} from '../src/lib/utils.js'
import { CircularBuffer } from '../src/multichat/irc.js'

const MAIN_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
const SOCIAL_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'social.js'), 'utf8')

function sliceBetween(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker)
  if (s === -1) throw new Error(`sliceBetween: start marker not found: ${startMarker}`)
  const e = src.indexOf(endMarker, s)
  if (e === -1) throw new Error(`sliceBetween: end marker not found: ${endMarker}`)
  return src.slice(s, e)
}

// ── mergeSortedRuns / fairMerge / byTimeStable / stableMsgId (main.js) ──────

const mergeSrc = sliceBetween(MAIN_SRC, 'function mergeSortedRuns(runs) {', '\n  function msgKeyOf(m) {')

function loadMerge({ domRenderCap = 500, devBuild = true } = {}) {
  const build = new Function(
    'ordOf',
    'MC_DEBUG',
    'log',
    'DOM_RENDER_CAP',
    '__HS_DEV_BUILD__',
    `
    ${mergeSrc}
    return { mergeSortedRuns, fairMerge, byTimeStable, stableMsgId, _assertSortedByOrd }
    `,
  )
  return build(ordOf, false, () => {}, domRenderCap, devBuild)
}

function msg(overrides) {
  return { user: 'u', text: 't', ...overrides }
}

function isSortedByOrd(arr) {
  for (let i = 1; i < arr.length; i++) if (ordOf(arr[i]) < ordOf(arr[i - 1])) return false
  return true
}

describe('mergeSortedRuns (main.js, real source)', () => {
  test('single source: returns it unchanged (copy)', () => {
    const { mergeSortedRuns } = loadMerge()
    const src = [msg({ id: 'a', time: 1 }), msg({ id: 'b', time: 2 })]
    const out = mergeSortedRuns([src])
    expect(out).toEqual(src)
    expect(out).not.toBe(src) // copy, not the same array reference
  })

  test('two sources: merges into non-decreasing order', () => {
    const { mergeSortedRuns } = loadMerge()
    const a = [msg({ id: 'a1', time: 1 }), msg({ id: 'a2', time: 3 }), msg({ id: 'a3', time: 5 })]
    const b = [msg({ id: 'b1', time: 2 }), msg({ id: 'b2', time: 4 })]
    const out = mergeSortedRuns([a, b])
    expect(out.map((m) => m.id)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3'])
    expect(isSortedByOrd(out)).toBe(true)
  })

  test('three sources: merges into non-decreasing order', () => {
    const { mergeSortedRuns } = loadMerge()
    const t = [msg({ id: 't1', time: 1 }), msg({ id: 't2', time: 4 })]
    const k = [msg({ id: 'k1', time: 2 })]
    const y = [msg({ id: 'y1', time: 3 }), msg({ id: 'y2', time: 5 })]
    const out = mergeSortedRuns([t, k, y])
    expect(out.map((m) => m.id)).toEqual(['t1', 'k1', 'y1', 't2', 'y2'])
    expect(isSortedByOrd(out)).toBe(true)
  })

  test('equal ord + different ids: stableMsgId (id string) breaks the tie, deterministic', () => {
    const { mergeSortedRuns } = loadMerge()
    const a = [msg({ id: 'a1', time: 5 })]
    const b = [msg({ id: 'b1', time: 5 })]
    const first = mergeSortedRuns([a, b]).map((m) => m.id)
    const second = mergeSortedRuns([a, b]).map((m) => m.id)
    const third = mergeSortedRuns([b, a]).map((m) => m.id)
    expect(first).toEqual(['a1', 'b1']) // 'a1' < 'b1' lexically
    expect(second).toEqual(first) // no flip-flop across repeated merges
    expect(third).toEqual(['a1', 'b1']) // id order wins regardless of run order
  })

  test('equal ord + equal stableMsgId (true duplicate): lower run-index wins, deterministic', () => {
    const { mergeSortedRuns } = loadMerge()
    const a = [msg({ id: 'dup', time: 5, tag: 'from-a' })]
    const b = [msg({ id: 'dup', time: 5, tag: 'from-b' })]
    const first = mergeSortedRuns([a, b]).map((m) => m.tag)
    const second = mergeSortedRuns([a, b]).map((m) => m.tag)
    const third = mergeSortedRuns([b, a]).map((m) => m.tag)
    expect(first).toEqual(['from-a', 'from-b'])
    expect(second).toEqual(first)
    expect(third).toEqual(['from-b', 'from-a']) // earlier run index still wins
  })

  test('respects `ord` over `time` when both are present', () => {
    const { mergeSortedRuns } = loadMerge()
    // A live-paced YT msg: true send time is OLD, but ord (paced-commit clock)
    // is the freshest — it must sort by ord, landing at the end.
    const ytLive = msg({ id: 'yt', time: 1000, ord: 9000 })
    const twitch = [msg({ id: 't1', time: 5000 })]
    const out = mergeSortedRuns([twitch, [ytLive]])
    expect(out.map((m) => m.id)).toEqual(['t1', 'yt'])
  })
})

describe('fairMerge (main.js, real source)', () => {
  test('non-co-live: old + far-apart sources stay chronological, no amputation', () => {
    const { fairMerge } = loadMerge({ domRenderCap: 500 })
    const hourAgo = Date.now() - 2 * 60 * 60 * 1000
    const twitch = [msg({ id: 't1', time: hourAgo }), msg({ id: 't2', time: hourAgo + 1000 })]
    const kick = [msg({ id: 'k1', time: hourAgo + 500 })]
    const out = fairMerge([twitch, kick, []])
    expect(out.map((m) => m.id)).toEqual(['t1', 'k1', 't2'])
    expect(isSortedByOrd(out)).toBe(true)
  })

  test('co-live: every source recent and close together — output stays sorted', () => {
    const { fairMerge } = loadMerge({ domRenderCap: 500 })
    const now = Date.now()
    const twitch = Array.from({ length: 100 }, (_, i) => msg({ id: `t${i}`, time: now - (100 - i) * 100 }))
    const kick = Array.from({ length: 5 }, (_, i) => msg({ id: `k${i}`, time: now - (5 - i) * 1000 }))
    const yt = Array.from({ length: 3 }, (_, i) => msg({ id: `y${i}`, time: now - (3 - i) * 1500 }))
    const out = fairMerge([twitch, kick, yt])
    expect(isSortedByOrd(out)).toBe(true)
    // Anti-drown: the quiet kick/yt sources must not be fully buried by the
    // twitch firehose — every kick/yt id present in the pool should survive.
    for (const id of ['k0', 'k1', 'k2', 'k3', 'k4']) expect(out.some((m) => m.id === id)).toBe(true)
    for (const id of ['y0', 'y1', 'y2']) expect(out.some((m) => m.id === id)).toBe(true)
  })

  test('co-live pool is deterministic across repeated calls (no flip-flop)', () => {
    const { fairMerge } = loadMerge({ domRenderCap: 500 })
    const now = Date.now()
    const twitch = Array.from({ length: 20 }, (_, i) => msg({ id: `t${i}`, time: now - (20 - i) * 100 }))
    const kick = Array.from({ length: 20 }, (_, i) => msg({ id: `k${i}`, time: now - (20 - i) * 100 }))
    const first = fairMerge([twitch, kick]).map((m) => m.id)
    const second = fairMerge([twitch, kick]).map((m) => m.id)
    expect(second).toEqual(first)
  })

  test('DEV assertion fires (console.error) when an input run is NOT actually sorted', () => {
    const { fairMerge } = loadMerge({ domRenderCap: 500, devBuild: true })
    const errors = []
    const origError = console.error
    console.error = (...args) => errors.push(args)
    try {
      const now = Date.now()
      // Deliberately unsorted — simulates a caller bypassing sortedInsert.
      const twitch = [msg({ id: 't2', time: now }), msg({ id: 't1', time: now - 5000 })]
      const kick = [msg({ id: 'k1', time: now - 2000 })]
      fairMerge([twitch, kick])
      expect(errors.length).toBeGreaterThan(0)
    } finally {
      console.error = origError
    }
  })

  test('DEV assertion silent on well-formed (sorted) input', () => {
    const { fairMerge } = loadMerge({ domRenderCap: 500, devBuild: true })
    const errors = []
    const origError = console.error
    console.error = (...args) => errors.push(args)
    try {
      const now = Date.now()
      const twitch = [msg({ id: 't1', time: now - 5000 }), msg({ id: 't2', time: now })]
      const kick = [msg({ id: 'k1', time: now - 2000 })]
      fairMerge([twitch, kick])
      expect(errors.length).toBe(0)
    } finally {
      console.error = origError
    }
  })
})

describe('byTimeStable (main.js, real source)', () => {
  test('orders by ordOf, falling back to time when ord is absent', () => {
    const { byTimeStable } = loadMerge()
    expect(byTimeStable(msg({ time: 1 }), msg({ time: 2 }))).toBeLessThan(0)
    expect(byTimeStable(msg({ time: 2, ord: 1 }), msg({ time: 1, ord: 2 }))).toBeLessThan(0)
  })

  test('equal ord: stable tiebreak via id, deterministic', () => {
    const { byTimeStable } = loadMerge()
    const a = msg({ id: 'a', time: 5 })
    const b = msg({ id: 'b', time: 5 })
    const r1 = byTimeStable(a, b)
    const r2 = byTimeStable(a, b)
    expect(r1).toBe(r2)
    expect(Math.sign(r1)).toBe(-Math.sign(byTimeStable(b, a)))
  })
})

// ── ordOf / findOrdInsertIndex / sortedInsert (src/lib/utils.js) ────────────

describe('ordOf / sortedInsert (src/lib/utils.js, real import)', () => {
  test('ordOf prefers ord, falls back to time, then 0', () => {
    expect(ordOf({ ord: 5, time: 1 })).toBe(5)
    expect(ordOf({ time: 7 })).toBe(7)
    expect(ordOf({})).toBe(0)
    expect(ordOf(null)).toBe(0)
  })

  test('sortedInsert: fast-path append when new item is newest', () => {
    const arr = [{ time: 1 }, { time: 2 }]
    sortedInsert(arr, { time: 3 })
    expect(arr.map((m) => m.time)).toEqual([1, 2, 3])
  })

  test('sortedInsert: out-of-order arrival lands at the correct position, not the tail', () => {
    const arr = [
      { id: 'a', time: 1 },
      { id: 'b', time: 5 },
      { id: 'c', time: 10 },
    ]
    sortedInsert(arr, { id: 'x', time: 4 })
    expect(arr.map((m) => m.id)).toEqual(['a', 'x', 'b', 'c'])
  })

  test('sortedInsert: ties land after existing equal-ord entries (stable)', () => {
    const arr = [{ id: 'a', time: 5 }]
    sortedInsert(arr, { id: 'b', time: 5 })
    expect(arr.map((m) => m.id)).toEqual(['a', 'b'])
  })

  test('findOrdInsertIndex on an empty array is 0', () => {
    expect(findOrdInsertIndex([], 5)).toBe(0)
  })

  test('property: buffer stays sorted after a randomized shuffled-arrival sequence', () => {
    for (let seed = 0; seed < 20; seed++) {
      const values = Array.from({ length: 60 }, (_, i) => i)
      // deterministic shuffle
      let s = seed + 1
      const rand = () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff
        return s / 0x7fffffff
      }
      for (let i = values.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1))
        ;[values[i], values[j]] = [values[j], values[i]]
      }
      const arr = []
      for (const v of values) sortedInsert(arr, { time: v })
      expect(arr.map((m) => m.time)).toEqual(Array.from({ length: 60 }, (_, i) => i))
    }
  })
})

// ── CircularBuffer.tail() / insertOrdered() (src/multichat/irc.js, real import) ──

describe('CircularBuffer ordering (src/multichat/irc.js, real import)', () => {
  beforeEach(() => {
    globalThis.ordOf = ordOf
    globalThis.findOrdInsertIndex = findOrdInsertIndex
  })

  test('tail(n) returns the newest n items, oldest-first order preserved', () => {
    const buf = new CircularBuffer(10)
    for (let i = 0; i < 5; i++) buf.push({ time: i })
    expect(buf.tail(3).map((m) => m.time)).toEqual([2, 3, 4])
    expect(buf.tail(100).map((m) => m.time)).toEqual([0, 1, 2, 3, 4])
    expect(buf.tail(0)).toEqual([])
  })

  test('tail(n) matches getAll().slice(-n) after wraparound', () => {
    const buf = new CircularBuffer(4)
    for (let i = 0; i < 10; i++) buf.push({ time: i })
    expect(buf.tail(2)).toEqual(buf.getAll().slice(-2))
  })

  test('insertOrdered: fast path (newest-or-tied) behaves exactly like push', () => {
    const buf = new CircularBuffer(10)
    buf.insertOrdered({ id: 'a', time: 1 })
    buf.insertOrdered({ id: 'b', time: 2 })
    buf.insertOrdered({ id: 'c', time: 2 }) // tie — appends after
    expect(buf.getAll().map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  test('insertOrdered: out-of-order arrival lands in the correct position', () => {
    const buf = new CircularBuffer(10)
    for (const m of [
      { id: 'a', time: 1 },
      { id: 'b', time: 5 },
      { id: 'c', time: 10 },
    ])
      buf.insertOrdered(m)
    buf.insertOrdered({ id: 'x', time: 4 })
    expect(buf.getAll().map((m) => m.id)).toEqual(['a', 'x', 'b', 'c'])
  })

  test('insertOrdered keeps ring semantics at capacity: newest N survive, oldest evicted', () => {
    const buf = new CircularBuffer(3)
    for (const m of [
      { id: 'a', time: 1 },
      { id: 'b', time: 2 },
      { id: 'c', time: 3 },
    ])
      buf.insertOrdered(m)
    // buffer full at [a,b,c]; a newer msg evicts the oldest (a)
    buf.insertOrdered({ id: 'd', time: 4 })
    expect(buf.getAll().map((m) => m.id)).toEqual(['b', 'c', 'd'])
    expect(buf.size).toBe(3)
  })

  test('insertOrdered: an out-of-order msg older than everything, at capacity, is dropped (not evicting a newer one)', () => {
    const buf = new CircularBuffer(3)
    for (const m of [
      { id: 'a', time: 10 },
      { id: 'b', time: 20 },
      { id: 'c', time: 30 },
    ])
      buf.insertOrdered(m)
    buf.insertOrdered({ id: 'ancient', time: 1 }) // older than the oldest kept slot
    expect(buf.getAll().map((m) => m.id)).toEqual(['a', 'b', 'c'])
    expect(buf.size).toBe(3)
  })

  test('insertOrdered: mid-buffer out-of-order insert at capacity evicts the true oldest, keeps size', () => {
    const buf = new CircularBuffer(3)
    for (const m of [
      { id: 'a', time: 10 },
      { id: 'b', time: 20 },
      { id: 'c', time: 30 },
    ])
      buf.insertOrdered(m)
    buf.insertOrdered({ id: 'mid', time: 15 }) // belongs between a and b
    // 'a' (the true oldest) is evicted to respect capacity; 'mid' takes its
    // sorted position ahead of 'b' — result stays non-decreasing by time.
    expect(buf.getAll().map((m) => m.id)).toEqual(['mid', 'b', 'c'])
    expect(buf.size).toBe(3)
  })

  test('property: buffer stays sorted after a randomized shuffled-arrival sequence, capacity respected', () => {
    for (let seed = 0; seed < 10; seed++) {
      const buf = new CircularBuffer(20)
      const values = Array.from({ length: 50 }, (_, i) => i)
      let s = seed + 7
      const rand = () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff
        return s / 0x7fffffff
      }
      for (let i = values.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1))
        ;[values[i], values[j]] = [values[j], values[i]]
      }
      for (const v of values) buf.insertOrdered({ time: v })
      const all = buf.getAll()
      expect(buf.size).toBe(20)
      for (let i = 1; i < all.length; i++) expect(all[i].time).toBeGreaterThanOrEqual(all[i - 1].time)
      // capacity keeps the newest 20 values: 30..49
      expect(all.map((m) => m.time)).toEqual(Array.from({ length: 20 }, (_, i) => i + 30))
    }
  })
})

// ── ingestReplayYtMsg / commitPacedYtMsg (src/multichat/social.js, real source) ──

const ytSliceSrc = sliceBetween(SOCIAL_SRC, 'const _replayRenderPending = new Set()', '\n// Compute the visual delay')

function loadYtBuffer() {
  const persisted = []
  const rendered = []
  const build = new Function(
    'channelYtMessages',
    '_ytPaceLastEmit',
    'MAX_BUFFER',
    'addUsername',
    'persistYt',
    'currentTab',
    'updateTabIndicator',
    'bumpTabActivity',
    'refreshTabCounter',
    'renderMessages',
    'appendMessage',
    'sortedInsert',
    'visualNowOrd',
    `
    ${ytSliceSrc}
    return { ingestReplayYtMsg, commitPacedYtMsg }
    `,
  )
  const channelYtMessages = new Map()
  const api = build(
    channelYtMessages,
    new Map(),
    500,
    () => {},
    (id) => persisted.push(id),
    '__none__', // currentTab — not the tab under test, so append/render paths no-op
    () => {}, // updateTabIndicator
    () => {}, // bumpTabActivity — tab-counter.js, out of scope for ordering
    () => {}, // refreshTabCounter
    (id) => rendered.push(id),
    () => false,
    sortedInsert,
    visualNowOrd,
  )
  return { ...api, channelYtMessages, persisted, rendered }
}

describe('YouTube ord/time split (src/multichat/social.js, real source)', () => {
  test('commitPacedYtMsg (live) sets ord but never overwrites the real send time', () => {
    const { commitPacedYtMsg, channelYtMessages } = loadYtBuffer()
    const realSendTime = Date.now() - 60000 // YT's own timestamp, a minute old
    const ytMsg = { id: 'yt1', user: 'u', text: 'hi', time: realSendTime }
    commitPacedYtMsg('ch1', ytMsg)
    expect(ytMsg.time).toBe(realSendTime) // untouched
    expect(ytMsg.ord).toBeGreaterThan(realSendTime) // display order is "now"
    expect(channelYtMessages.get('ch1')[0]).toBe(ytMsg)
  })

  test('commitPacedYtMsg: msgs draining in the same ms get distinct, increasing ord', () => {
    // Two YT rows committed inside one millisecond must not collide: identical
    // ord + same user + same text-prefix produces one stableMsgId, and the
    // render diff treats that as a single key and drops the second display.
    // The guard is now unconditional in visualNowOrd (a global monotonic
    // clock) rather than something the caller has to maintain per channel via
    // _ytPaceLastEmit, so a bare loop engages it — that is the point.
    _resetVisualNow()
    const { commitPacedYtMsg } = loadYtBuffer()
    const rows = []
    for (let i = 0; i < 50; i++) {
      const m = { id: `m${i}`, user: 'u', text: 't', time: 1000 }
      commitPacedYtMsg('ch1', m)
      rows.push(m)
    }
    for (let i = 1; i < rows.length; i++) expect(rows[i].ord).toBeGreaterThan(rows[i - 1].ord)
  })

  test('commitPacedYtMsg: the clock is shared across channels, so two tabs cannot collide', () => {
    // YT used to keep a private per-channel commit clock; every platform now
    // draws from one monotonic space. Two channels draining in the same ms
    // previously could hand out the same ord.
    _resetVisualNow()
    const { commitPacedYtMsg } = loadYtBuffer()
    const a = { id: 'a', user: 'u', text: 't', time: 1000 }
    const b = { id: 'b', user: 'u', text: 't', time: 1000 }
    commitPacedYtMsg('ch1', a)
    commitPacedYtMsg('ch2', b)
    expect(b.ord).toBeGreaterThan(a.ord)
  })

  test('ingestReplayYtMsg (backfill) never touches time; ord is absent (falls back to time)', () => {
    const { ingestReplayYtMsg } = loadYtBuffer()
    const realSendTime = Date.now() - 3600000
    const ytMsg = { id: 'replay1', user: 'u', text: 'old msg', time: realSendTime }
    ingestReplayYtMsg('ch1', ytMsg)
    expect(ytMsg.time).toBe(realSendTime)
    expect(ytMsg.ord).toBeUndefined()
    expect(ordOf(ytMsg)).toBe(realSendTime)
  })

  test('replay rows interleave correctly with live rows in the same buffer, sorted by ord/time', () => {
    const { ingestReplayYtMsg, commitPacedYtMsg, channelYtMessages } = loadYtBuffer()
    const base = 1_700_000_000_000
    // Live msg commits first (gets a fresh ord near "now" via Date.now()).
    const live = { id: 'live1', user: 'u', text: 'live', time: base + 100 }
    commitPacedYtMsg('ch1', live)
    // Backfill then delivers an older real-time replay row — must NOT land
    // after `live` just because it arrived later; ordOf(replay) === its real
    // time (base + 50), which is older than live's real time AND (by
    // construction) far older than live's ord (Date.now()-scale).
    const replay = { id: 'replay1', user: 'u', text: 'replay', time: base + 50 }
    ingestReplayYtMsg('ch1', replay)
    const buf = channelYtMessages.get('ch1')
    expect(buf.map((m) => m.id)).toEqual(['replay1', 'live1'])
    for (let i = 1; i < buf.length; i++) expect(ordOf(buf[i])).toBeGreaterThanOrEqual(ordOf(buf[i - 1]))
  })

  test('buffer stays sorted (by ord) after a mixed randomized replay+live arrival sequence', () => {
    const { ingestReplayYtMsg, commitPacedYtMsg, channelYtMessages } = loadYtBuffer()
    let s = 42
    const rand = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      return s / 0x7fffffff
    }
    for (let i = 0; i < 40; i++) {
      const t = Math.floor(rand() * 1_000_000)
      const m = { id: `m${i}`, user: 'u', text: `t${i}`, time: t }
      if (rand() < 0.5) ingestReplayYtMsg('chX', m)
      else commitPacedYtMsg('chX', m)
    }
    const buf = channelYtMessages.get('chX')
    for (let i = 1; i < buf.length; i++) expect(ordOf(buf[i])).toBeGreaterThanOrEqual(ordOf(buf[i - 1]))
  })
})

// ── liveOrd: where a late message goes (src/lib/utils.js, real import) ──────
/**
 * The parity rule, shared with the site (LIVE_WEAVE_SKEW_MS in
 * client/managers/channel-buffer-manager.js): a live message's display
 * position is decided ONCE, at insert. Fresh enough to still be part of the
 * conversation → its own send time, so the platforms interleave truthfully.
 * Staler than the window → the visual now, so it lands at the bottom instead
 * of materializing in the middle of scrollback the reader already passed.
 *
 * Before this, the overlay ordered purely on send time, so a kick relay
 * running a minute behind spliced its backlog in a minute back — off-screen
 * for a reader sitting at the bottom, i.e. indistinguishable from dropped.
 */
describe('liveOrd (src/lib/utils.js, real import)', () => {
  beforeEach(() => _resetVisualNow())

  test('a fresh message keeps its real send time, so platforms interleave truthfully', () => {
    const t0 = 1_700_000_000_000
    // twitch IRC lands in ~0ms, the kick relay in ~120ms — the kick line was
    // SENT first and must render above the twitch line it preceded.
    const tw = liveOrd(t0)
    const kick = liveOrd(t0 - 120)
    expect(tw).toBe(t0)
    expect(kick).toBe(t0 - 120)
    expect(kick).toBeLessThan(tw)
  })

  test('the whole skew window weaves; one millisecond past it does not', () => {
    const t0 = 1_700_000_000_000
    liveOrd(t0)
    expect(liveOrd(t0 - LIVE_WEAVE_SKEW_MS)).toBe(t0 - LIVE_WEAVE_SKEW_MS)
    expect(liveOrd(t0 - LIVE_WEAVE_SKEW_MS - 1)).toBeGreaterThanOrEqual(t0)
  })

  test('a message that arrives long after it was sent takes the tail, not its timestamp', () => {
    const t0 = Date.now()
    liveOrd(t0 - 2000)
    liveOrd(t0 - 1000)
    liveOrd(t0) // visual now is here
    const late = liveOrd(t0 - 60_000) // kick relay a minute behind
    expect(late).toBeGreaterThanOrEqual(t0)
    expect(late).not.toBe(t0 - 60_000)
  })

  test('a backlog of stale rows keeps arrival order — no two share an ord', () => {
    const t0 = Date.now()
    liveOrd(t0)
    // A throttled relay dumps its backlog: sent oldest-first, every row well
    // past the window, so every one of them takes the tail.
    const ords = []
    for (let i = 30; i >= 3; i--) ords.push(liveOrd(t0 - i * 1000))
    expect(new Set(ords).size).toBe(ords.length)
    for (let i = 1; i < ords.length; i++) expect(ords[i]).toBeGreaterThan(ords[i - 1])
  })

  test('no ord ever lands more than the skew window below the newest one', () => {
    // The bound that makes an insert-above safe: weaving is allowed (that is
    // how a kick reply reaches the line it answers) but it can only ever reach
    // back one window, never into old scrollback. Deliberately hostile
    // arrival — fresh, far stale, fresh again, garbage.
    const t0 = Date.now()
    let newest = -Infinity
    for (const t of [t0, t0 - 90_000, t0 + 5, t0 - 1000, Number.NaN, t0 + 10, undefined, 0, t0 - 3000]) {
      const o = liveOrd(/** @type {number} */ (t))
      expect(newest - o).toBeLessThanOrEqual(LIVE_WEAVE_SKEW_MS)
      if (o > newest) newest = o
    }
  })

  test('a clock running an hour fast cannot kill the interleave for that user', () => {
    // visualNowOrd must never re-read the wall clock: one stale row would drag
    // the visual now past every real server timestamp, so every later message
    // would read as stale and clamp — the platforms would stop interleaving
    // entirely, for the whole session, on that machine only.
    const serverNow = Date.now() - 3_600_000 // local clock is an hour ahead of the platforms
    liveOrd(serverNow)
    liveOrd(serverNow - 60_000) // a stale row: takes the tail
    // The next genuinely fresh pair must still weave on their own send times.
    const tw = liveOrd(serverNow + 1000)
    const kick = liveOrd(serverNow + 880)
    expect(tw).toBe(serverNow + 1000)
    expect(kick).toBe(serverNow + 880)
    expect(kick).toBeLessThan(tw)
  })

  test('staleness is measured against message time, not the local clock', () => {
    // The whole reason liveOrd tracks a visual now instead of reading
    // Date.now(): twitch and kick stamp `time` from THEIR servers. On a
    // machine an hour behind, every live message would look an hour early
    // and — if we compared against the local clock — clamp, destroying the
    // interleave for that user. Simulate by feeding times far from now.
    const skewed = Date.now() + 3_600_000
    expect(liveOrd(skewed)).toBe(skewed)
    expect(liveOrd(skewed - 500)).toBe(skewed - 500) // still weaves
    expect(liveOrd(skewed - 60_000)).toBeGreaterThanOrEqual(skewed) // still clamps
  })
})

describe('late arrival, end to end through the render merge', () => {
  beforeEach(() => _resetVisualNow())

  test('a minute-late kick row renders at the bottom, where ordering by send time buried it', () => {
    const { mergeSortedRuns } = loadMerge()
    const t0 = Date.now()
    const twitch = [t0 - 2000, t0 - 1000, t0].map((time, i) =>
      msg({ id: `tw${i}`, platform: 'twitch', time, ord: liveOrd(time) }),
    )
    const lateTime = t0 - 60_000
    const kick = [msg({ id: 'kick-late', platform: 'kick', time: lateTime, ord: liveOrd(lateTime) })]

    const merged = mergeSortedRuns([twitch, kick])
    expect(merged[merged.length - 1].id).toBe('kick-late')

    // The bug this replaces: ordering on send time put that row THIRD FROM
    // THE TOP — a minute back in scrollback, unseen by a reader at the bottom.
    const bySendTime = mergeSortedRuns([
      twitch.map((m) => ({ ...m, ord: undefined })),
      kick.map((m) => ({ ...m, ord: undefined })),
    ])
    expect(bySendTime[0].id).toBe('kick-late')
  })

  test('a kick row inside the skew window still renders above the twitch line it preceded', () => {
    const { mergeSortedRuns } = loadMerge()
    const t0 = Date.now()
    // Arrival order is twitch-then-kick; send order is the reverse.
    const twOrd = liveOrd(t0)
    const kickOrd = liveOrd(t0 - 120)
    const merged = mergeSortedRuns([
      [msg({ id: 'tw', platform: 'twitch', time: t0, ord: twOrd })],
      [msg({ id: 'kick', platform: 'kick', time: t0 - 120, ord: kickOrd })],
    ])
    expect(merged.map((m) => m.id)).toEqual(['kick', 'tw'])
  })

  test('history is left chronological — a backfill row is not dragged to the bottom', () => {
    const { mergeSortedRuns } = loadMerge()
    const t0 = Date.now()
    const live = [msg({ id: 'live', platform: 'twitch', time: t0, ord: liveOrd(t0) })]
    // A history row carries no ord ON PURPOSE (irc.js hydrates history with
    // push(), never through the live stamp), so ordOf falls back to `time`.
    const history = [msg({ id: 'hist', platform: 'twitch', time: t0 - 600_000 })]
    const merged = mergeSortedRuns([history, live])
    expect(merged.map((m) => m.id)).toEqual(['hist', 'live'])
  })
})

// ── the live call sites actually stamp (source assertion) ───────────────────
/**
 * IRC/KickChat are stateful and chrome.runtime-driven — irc-parser.test.js
 * documents why there is no harness for them. The stamp is two lines, and the
 * failure mode if either is dropped is silent (ordering quietly reverts to
 * send time), so assert on the real source rather than leave it unguarded.
 */
describe('live insert sites stamp an ord (src/multichat/irc.js, real source)', () => {
  const IRC_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'irc.js'), 'utf8')

  test('twitch stamps live PRIVMSGs only — not notices, history or synthetics', () => {
    expect(IRC_SRC).toContain('if (!msg.type && !msg.isHistory && !msg.isSynthetic) msg.ord = liveOrd(msg.time)')
  })

  test('kick stamps every live transport (relay, pusher tap, native tap)', () => {
    const ingest = sliceBetween(IRC_SRC, 'ingestChatPayload(d, opts', '\n  ingestModeration(')
    expect(ingest).toContain('msg.ord = liveOrd(msg.time)')
  })

  test('history hydration never stamps — it stays chronological', () => {
    // Every isHistory path uses push(), which cannot reach a liveOrd call.
    const historyBlocks = IRC_SRC.split('\n').filter((l) => l.includes('isHistory = true'))
    expect(historyBlocks.length).toBeGreaterThan(0)
    expect(IRC_SRC).not.toMatch(/isHistory\s*=\s*true[\s\S]{0,400}?liveOrd\(/)
  })
})

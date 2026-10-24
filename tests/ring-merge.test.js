/**
 * Channel rings must stay sorted by ord. History hydration and the BG re-pulls
 * used to push() straight onto the ring: history newer than a live message
 * landed before it, every later arrival binary-searched a lying array and sat
 * above a stale tail, and chat looked frozen for ~2 minutes.
 */

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'irc.js'), 'utf8')

function slice(re) {
  const s = SRC.search(re)
  if (s === -1) throw new Error(`not found: ${re}`)
  return SRC.slice(s, SRC.indexOf('\n}\n', s) + 3)
}

class Ring {
  constructor() {
    this.items = []
  }
  getAll() {
    return this.items.slice()
  }
  clear() {
    this.items = []
  }
  push(m) {
    this.items.push(m)
  }
}

const ordOf = (m) => m?.ord ?? m?.time ?? 0
const mergeIntoRing = new Function('ordOf', `${slice(/function mergeIntoRing\(/)}; return mergeIntoRing`)(ordOf)

const row = (id, time, extra = {}) => ({ id, time, ...extra })
const hist = (id, time) => row(id, time, { isHistory: true })

test('history newer than a live row lands after it in time order, not before', () => {
  const buf = new Ring()
  buf.push(row('live1', 100, { ord: 100 }))
  buf.push(row('live2', 110, { ord: 110 }))
  mergeIntoRing(buf, [hist('h1', 90), hist('h2', 105), hist('h3', 120)])
  expect(buf.items.map((m) => m.id)).toEqual(['h1', 'live1', 'h2', 'live2', 'h3'])
})

test('the ring is non-decreasing by ord after any merge', () => {
  const buf = new Ring()
  for (let i = 0; i < 20; i++) buf.push(row(`l${i}`, 1000 + i * 7, { ord: 1000 + i * 7 }))
  mergeIntoRing(
    buf,
    Array.from({ length: 30 }, (_, i) => hist(`h${i}`, 990 + i * 5)),
  )
  const ords = buf.items.map(ordOf)
  expect(ords).toEqual([...ords].sort((a, b) => a - b))
})

test('a live copy beats the history copy of the same message', () => {
  const buf = new Ring()
  buf.push(row('same', 100, { ord: 100, replyTo: 'x' }))
  mergeIntoRing(buf, [hist('same', 100), hist('other', 95)])
  expect(buf.items.map((m) => m.id)).toEqual(['other', 'same'])
  expect(buf.items[1].replyTo).toBe('x')
})

test('a re-pull replaces old history and keeps live rows', () => {
  const buf = new Ring()
  buf.push(hist('old', 50))
  buf.push(row('live', 100, { ord: 100 }))
  mergeIntoRing(buf, [hist('new', 60)], true)
  expect(buf.items.map((m) => m.id)).toEqual(['new', 'live'])
})

test('no history push straight onto a ring remains', () => {
  expect(SRC).not.toMatch(/for \(const m of staged\) buf\.push\(m\)/)
  expect(SRC).not.toMatch(/\n\s+buf\.push\(m\)\n\s+\}\n\s+log\('(Kick )?BG history hydrated/)
  expect((SRC.match(/mergeIntoRing\(/g) || []).length).toBeGreaterThanOrEqual(6)
})

test('the render merge re-sorts any run that arrives out of order', () => {
  const main = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
  expect(main).toMatch(/function fairMerge\(sources\) \{\s*sources = sources\.map\(_ordSortedRun\)/)
  const s = main.indexOf('function _ordSortedRun(')
  const sortRun = new Function('ordOf', `${main.slice(s, main.indexOf('\n  }\n', s) + 4)}; return _ordSortedRun`)(ordOf)
  const ok = [{ time: 1 }, { time: 2 }]
  expect(sortRun(ok)).toBe(ok)
  const bad = [{ time: 5 }, { time: 9 }, { time: 7 }, { time: 8 }]
  expect(sortRun(bad).map((m) => m.time)).toEqual([5, 7, 8, 9])
  expect(bad.map((m) => m.time)).toEqual([5, 9, 7, 8])
})

test('a render watchdog logs why chat stopped painting and repaints when nothing blocks it', () => {
  const main = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
  expect(main).toMatch(/function renderStallCheck\(\)/)
  expect(main).toMatch(/__hsDiag\?\.\('render_stall'/)
  expect(main).toMatch(/cleanup\.setInterval\(renderStallCheck, 2500\)/)
})

test('an ingest gap on a busy channel re-registers interest and re-pulls the BG ring', () => {
  const main = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
  expect(main).toMatch(/function ingestGapCheck\(\)/)
  expect(main).toMatch(/__hsDiag\?\.\('ingest_gap'/)
  expect(main).toMatch(/irc\._refreshFromBg\?\.\(ch\)/)
  expect(main).toMatch(/cleanup\.setInterval\(ingestGapCheck, 3000\)/)
})

test('stall check heals the key index from the DOM and logs index_desync', () => {
  const main = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
  expect(main).toMatch(/function _reconcileMsgKeyIndex\(/)
  expect(main).toMatch(/_reconcileMsgKeyIndex\(msgsEl\)/)
  expect(main).toMatch(/'index_desync'/)
})

test('thrash detector logs dom_thrash and rebuilds the pane', () => {
  const main = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
  expect(main).toMatch(/function domThrashCheck\(/)
  expect(main).toMatch(/cleanup\.setInterval\(domThrashCheck, 2000\)/)
  expect(main).toMatch(/'dom_thrash'/)
})

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ordOf } from '../src/lib/utils.js'
import { mainSource } from './main-src.js'

/**
 * Scrolling to the top of a chat tab asks for older rows: the row cap grows by a step and the
 * tab is rendered again. The merge that feeds the render kept its own fixed cap (the live
 * tail's 500), so the render never saw a row past it: nothing loaded, on any site, with 1700+
 * rows sitting in the buffer (e2e s20, real twitch + kick, 11-17). The merge now takes the cap
 * the render uses. fairMerge runs for real.
 */
const MAIN = mainSource()
const s = MAIN.indexOf('function mergeSortedRuns(runs) {')
const mergeSrc = MAIN.slice(s, MAIN.indexOf('\nfunction msgKeyOf(m) {', s))
const { fairMerge } = new Function(
  'ordOf',
  'MC_DEBUG',
  'log',
  'DOM_RENDER_CAP',
  '__HS_DEV_BUILD__',
  `${mergeSrc}\nreturn { fairMerge }`,
)(ordOf, false, () => {}, 500, true)

const NOW = Date.now()
// n rows, one a second, the newest `endAgo` seconds ago
const run = (tag, n, endAgo = 0) =>
  Array.from({ length: n }, (_, i) => {
    const at = NOW - (endAgo + n - 1 - i) * 1000
    return { id: `${tag}${i}`, user: 'u', text: 't', time: at, ord: at }
  })

test('with no scrollback asked for, the pane holds the live tail only', () => {
  expect(fairMerge([run('a', 1700)]).length).toBe(500)
  expect(fairMerge([run('a', 1700), run('b', 900)]).length).toBe(500)
})

test('a bigger cap brings the older rows in, newest still last: one source', () => {
  const src = run('a', 1700)
  const out = fairMerge([src], 750)
  expect(out.length).toBe(750)
  expect(out.at(-1)).toBe(src.at(-1))
  expect(out[0]).toBe(src[1700 - 750])
  expect(fairMerge([src], 1500).length).toBe(1500)
})

test('two platforms live together: the cap is the total, and the tail is unchanged', () => {
  const a = run('a', 1500)
  const b = run('b', 1200)
  const tail = fairMerge([a, b])
  const deep = fairMerge([a, b], 1000)
  expect(deep.length).toBe(1000)
  // the rows already on screen stay, in the same order, at the bottom
  expect(deep.slice(-400).map((m) => m.id)).toEqual(tail.slice(-400).map((m) => m.id))
  const ords = deep.map((m) => m.ord)
  expect(ords).toEqual([...ords].sort((x, y) => x - y))
})

test('one platform long quiet (not live together): the cap still grows the pane', () => {
  const a = run('a', 1500)
  const b = run('b', 300, 2 * 3600) // ended two hours ago
  expect(fairMerge([a, b]).length).toBe(500)
  expect(fairMerge([a, b], 1250).length).toBe(1250)
})

test('the render hands the merge the same cap it trims to', () => {
  const live = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main-live.js'), 'utf8')
  expect(live).toContain('msgs = fairMerge(mtSrcs, renderRowCap())')
  expect(live).toContain('let _cap = renderRowCap()')
  expect(MAIN).toContain('const renderRowCap = () => Math.min(DOM_RENDER_CAP + _scrollbackWindow, SCROLLBACK_MAX)')
})

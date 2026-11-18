/**
 * The `/` filter only looked through the newest screenful: the merge kept the row cap (500)
 * and the matcher ran on what was left. On a fast chat that is a few seconds of lines, so a
 * search for a name that spoke ten seconds ago found nothing while 3000 lines were held
 * (real twitch and kick, e2e s22, 11-17: "the filter left no rows").
 *
 * Runs the real renderWindow.
 */
import { expect, test } from 'bun:test'
import { mainSource } from './main-src.js'

const SRC = mainSource()
const cut = (src, from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`carve: ${from}`)
  return src.slice(a, b)
}

test('a filter reads every line held; a plain tail reads only what it will draw', () => {
  const STATE = cut(SRC, 'function renderWindow(asOf, searching) {', 'function newestOrdOnScreen(msgsEl) {')
  const renderWindow = new Function('SCROLLBACK_MAX', 'renderRowCap', `${STATE}\n return renderWindow`)(1500, () => 500)
  expect(renderWindow(null, false)).toEqual({ take: 1500, keep: 500 })
  expect(renderWindow(null, true)).toEqual({ take: Infinity, keep: Infinity })
  expect(renderWindow(42, false)).toEqual({ take: Infinity, keep: 500 })
  expect(SRC).toMatch(/const win = renderWindow\(asOf, !!liveSearchQuery\(id\)\)/)
  expect(SRC).toMatch(/msgs = fairMerge\(mtSrcs, win\.keep\)/)
})

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The chat logs list redraws whole on every change, and a redraw starts at the top. Scroll to
 * the bottom, the next (older) page arrives, and the reader was back at the newest line: every
 * page (kick, e2e s23, 11-17). The place is now read before the redraw and put back after: the
 * first row in view stays where it was. clReadPlace / clRestorePlace run for real over a list
 * with real geometry (20px rows in a 100px window).
 */
const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'chat-logs.js'), 'utf8')
const fn = (name) => {
  const s = SRC.indexOf(`function ${name}(`)
  if (s < 0) throw new Error(`carve: ${name}`)
  return SRC.slice(s, SRC.indexOf('\n}\n', s) + 3)
}
const { clReadPlace, clRestorePlace } = new Function(
  `${fn('clReadPlace')}\n${fn('clRestorePlace')}\nreturn { clReadPlace, clRestorePlace }`,
)()

const ROW = 20
// a list laid out the way the browser would: rows stacked from the top, the window 100px tall
function list(rows, { loader = false, header = 0 } = {}) {
  const l = { scrollTop: 0, children: [] }
  const rect = (i) => ({ top: header + i * ROW - l.scrollTop, bottom: header + (i + 1) * ROW - l.scrollTop })
  l.getBoundingClientRect = () => ({ top: header, bottom: header + 100 })
  for (const [i, r] of rows.entries()) l.children.push({ _hsRow: r, getBoundingClientRect: () => rect(i) })
  if (loader) l.children.push({ getBoundingClientRect: () => rect(rows.length) })
  return l
}
const lines = (n, tag = 'r') => Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}` }))
const firstInView = (l) => clReadPlace(l)

test('an older page arriving under the reader leaves the same row at the same spot', () => {
  const page1 = lines(50)
  const before = list(page1, { loader: true })
  before.scrollTop = 50 * ROW + ROW - 100 // at the very bottom, the loader in view
  const place = clReadPlace(before)
  expect(place.row).toBe(page1[46])
  // the redraw: same rows, 50 older ones under them, scrolled to the top like every new element
  const after = list([...page1, ...lines(50, 'older')], { loader: true })
  expect(after.scrollTop).toBe(0)
  clRestorePlace(after, place)
  expect(after.scrollTop).toBe(before.scrollTop)
  expect(firstInView(after)).toEqual(place)
})

test('a row half scrolled off keeps its exact offset', () => {
  const rows = lines(40)
  const before = list(rows)
  before.scrollTop = 7 * ROW + 13
  const place = clReadPlace(before)
  expect(place).toEqual({ row: rows[7], dy: -13 })
  const after = list(rows)
  clRestorePlace(after, place)
  expect(after.scrollTop).toBe(7 * ROW + 13)
})

test('the newest rows cut off the top of a long list: the reader still does not move', () => {
  const rows = lines(500)
  const before = list(rows)
  before.scrollTop = 480 * ROW
  const place = clReadPlace(before)
  // 100 older rows came in, the 100 newest went (the 500-row cap)
  const after = list([...rows.slice(100), ...lines(100, 'older')])
  clRestorePlace(after, place)
  expect(firstInView(after)).toEqual(place)
  expect(after.scrollTop).toBe(380 * ROW)
})

test('another search or channel (the row is gone) starts at the top', () => {
  const before = list(lines(60))
  before.scrollTop = 600
  const place = clReadPlace(before)
  const after = list(lines(60, 'other'))
  clRestorePlace(after, place)
  expect(after.scrollTop).toBe(0)
})

test('no list yet, an empty list, a reader at the top: nothing moves', () => {
  expect(clReadPlace(null)).toBe(null)
  const empty = list([], { loader: true })
  expect(clReadPlace(empty)).toBe(null)
  const fresh = list(lines(30))
  clRestorePlace(fresh, null)
  expect(fresh.scrollTop).toBe(0)
  const top = list(lines(30))
  const again = list(lines(0))
  clRestorePlace(again, clReadPlace(top))
  expect(again.scrollTop).toBe(0)
})

test('the view reads the place before it empties the pane and restores it after the list is in', () => {
  const view = fn('renderChatLogsView')
  const read = view.indexOf("clReadPlace(msgsEl.querySelector('.hs-cl-list'))")
  const wipe = view.indexOf("msgsEl.textContent = ''")
  const mount = view.indexOf('msgsEl.appendChild(wrap)')
  const restore = view.indexOf('clRestorePlace(list, place)')
  expect(read).toBeGreaterThan(-1)
  expect(read).toBeLessThan(wipe)
  expect(mount).toBeGreaterThan(wipe)
  expect(restore).toBeGreaterThan(mount)
  // every row the list shows is tagged, the ones added live too
  expect(view).toContain('list.appendChild(clRow(r))')
  expect(SRC).toContain('const row = clRow(r)')
})

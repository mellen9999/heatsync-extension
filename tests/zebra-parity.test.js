/**
 * Zebra stripes must not flip ~1s after launch. Live appends and the
 * epoch rebuild (badge bulk-load) both recompute stripes from the previous
 * sibling — if they disagree on the first row, every row flips.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAIN_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')

function sliceFn(name) {
  const s = MAIN_SRC.indexOf(`function ${name}(`)
  if (s === -1) throw new Error(`function not found: ${name}`)
  return MAIN_SRC.slice(s, MAIN_SRC.indexOf('\n  }\n', s) + 4)
}

const NO_ZEBRA = new Set(['stream-event', 'feed-post', 'inline-dm', 'moment', 'cmd-receipt', 'automod-hold'])
const zebraOfInsert = new Function(
  'zebraEnabled',
  '_NO_ZEBRA_TYPES',
  `${sliceFn('zebraOfInsert')}; return zebraOfInsert`,
)(true, NO_ZEBRA)
const zebraRepaint = new Function('zebraEnabled', `${sliceFn('zebraRepaint')}; return zebraRepaint`)(true)

// minimal linked-list DOM: rows with classList + sibling pointers
function fakeList(types) {
  const els = types.map((t, i) => {
    const z = new Set()
    return {
      id: '',
      dataset: NO_ZEBRA.has(t) ? { hsNz: '1' } : {},
      classList: {
        contains: (c) => z.has(c),
        toggle: (c, on) => (on ? z.add(c) : z.delete(c)),
      },
      i,
    }
  })
  els.forEach((e, i) => {
    e.previousElementSibling = els[i - 1] || null
    e.nextElementSibling = els[i + 1] || null
  })
  return { first: els[0], els, msgsEl: { firstElementChild: els[0] } }
}

const row = (zebra) => ({ classList: { contains: (c) => c === 'hs-mc-zebra' && zebra } })

function stripe(n) {
  const rows = []
  for (let i = 0; i < n; i++) rows.push(zebraOfInsert({ type: 'chat' }, i ? row(rows[i - 1]) : null))
  return rows
}

describe('zebra parity', () => {
  test('every zebra assignment goes through zebraOfInsert', () => {
    expect(MAIN_SRC).not.toMatch(/classList\.add\('hs-mc-zebra'\)/)
    expect((MAIN_SRC.match(/stampZebra\(\w+, /g) || []).length).toBeGreaterThanOrEqual(4)
  })

  test('live append routes through zebraOfInsert', () => {
    expect(MAIN_SRC).toContain('stampZebra(div, msg, msgsEl.lastElementChild)')
  })

  test('first row is plain, then strict alternation', () => {
    expect(stripe(4)).toEqual([false, true, false, true])
  })

  test('rebuild over the same rows reproduces the same stripes', () => {
    const live = stripe(6)
    const rebuilt = live.map((_, i) => zebraOfInsert({ type: 'chat' }, i ? row(live[i - 1]) : null))
    expect(rebuilt).toEqual(live)
  })

  test('repaint fixes rows left out of phase by a mid-list insert', () => {
    const { els, msgsEl } = fakeList(['chat', 'chat', 'chat', 'chat', 'chat'])
    // out of phase: rows 2 and 3 both striped, row 4 plain after plain
    for (const i of [1, 2, 3]) els[i].classList.toggle('hs-mc-zebra', true)
    zebraRepaint(msgsEl, els[2])
    expect(els.map((e) => e.classList.contains('hs-mc-zebra'))).toEqual([false, true, false, true, false])
  })

  test('repaint keeps event rows plain and stripes the row after them', () => {
    const { els, msgsEl } = fakeList(['chat', 'stream-event', 'chat', 'chat'])
    zebraRepaint(msgsEl, null)
    expect(els.map((e) => e.classList.contains('hs-mc-zebra'))).toEqual([false, false, true, false])
  })
})

/**
 * Zebra stripes must not flip ~1s after launch. Live appends and the
 * epoch rebuild (badge bulk-load) both recompute stripes from the previous
 * sibling — if they disagree on the first row, every row flips.
 */

import { describe, expect, test } from 'bun:test'
import { mainSource } from './main-src.js'

const MAIN_SRC = mainSource()

function sliceFn(name) {
  const s = MAIN_SRC.indexOf(`function ${name}(`)
  if (s === -1) throw new Error(`function not found: ${name}`)
  return MAIN_SRC.slice(s, MAIN_SRC.indexOf('\n}\n', s) + 3)
}

const NO_ZEBRA = new Set(['stream-event', 'feed-post', 'inline-dm', 'moment', 'cmd-receipt', 'automod-hold'])
const zebraOfInsert = new Function(
  'zebraEnabled',
  '_NO_ZEBRA_TYPES',
  `${sliceFn('zebraOfInsert')}; return zebraOfInsert`,
)(true, NO_ZEBRA)
const zebraRepaint = new Function('zebraEnabled', `${sliceFn('zebraRepaint')}; return zebraRepaint`)(true)
const zebraRepaintUp = new Function(
  'zebraEnabled',
  `${sliceFn('zebraRepaint')}; ${sliceFn('zebraRepaintUp')}; return zebraRepaintUp`,
)(true)

// minimal linked-list DOM: rows with classList + sibling pointers
function fakeList(types) {
  const els = types.map((t, i) => {
    const z = new Set(t === 'first' || t === 'mention' ? ['hs-filled'] : [])
    return {
      id: '',
      dataset: { ...(NO_ZEBRA.has(t) ? { hsNz: '1' } : {}), ...(t === 'stream-event' ? { hsNotice: '1' } : {}) },
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
  return { first: els[0], els, msgsEl: { firstElementChild: els[0], lastElementChild: els[els.length - 1] } }
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

  test('repaint keeps notice rows plain and does not count them: the next row alternates against the last counted one', () => {
    const { els, msgsEl } = fakeList(['chat', 'stream-event', 'chat', 'chat'])
    zebraRepaint(msgsEl, null)
    expect(els.map((e) => e.classList.contains('hs-mc-zebra'))).toEqual([false, false, true, false])
  })

  test('a notice row between two rows leaves the alternation as if it were not there', () => {
    const { els, msgsEl } = fakeList(['chat', 'chat', 'stream-event', 'chat', 'chat'])
    zebraRepaint(msgsEl, null)
    // chat rows alternate 0,1,0,1 whatever sits between them
    expect(els.map((e) => e.classList.contains('hs-mc-zebra'))).toEqual([false, true, false, false, true])
  })

  test('a live insert after a notice stripes off the last counted row', () => {
    const rowOf = (z) => ({
      id: '',
      dataset: {},
      classList: { contains: (c) => c === 'hs-mc-zebra' && z },
      previousElementSibling: null,
    })
    const counted = rowOf(true)
    const notice = {
      id: '',
      dataset: { hsNz: '1', hsNotice: '1' },
      classList: { contains: () => false },
      previousElementSibling: counted,
    }
    expect(zebraOfInsert({ type: 'chat' }, notice)).toBe(false) // after a striped row: plain
    counted.classList = { contains: () => false }
    expect(zebraOfInsert({ type: 'chat' }, notice)).toBe(true)
  })

  test('filled rows (first message, notices) never take part: normal rows alternate among themselves', () => {
    const { els, msgsEl } = fakeList(['chat', 'first', 'chat', 'stream-event', 'chat', 'first', 'chat'])
    zebraRepaint(msgsEl, null)
    // chat rows (0,2,4,6) alternate plain/stripe/plain/stripe; filled rows stay plain
    expect(els.map((e) => e.classList.contains('hs-mc-zebra'))).toEqual([false, false, true, false, false, false, true])
  })

  test('mention / reply-to-me rows are filled rows too: they never take part in striping', () => {
    const { els, msgsEl } = fakeList(['chat', 'mention', 'chat', 'mention', 'chat', 'chat'])
    zebraRepaint(msgsEl, null)
    expect(els.map((e) => e.classList.contains('hs-mc-zebra'))).toEqual([false, false, true, false, false, true])
  })

  test('a live insert after a filled row stripes off the last normal row', () => {
    const counted = {
      id: '',
      dataset: {},
      classList: { contains: (c) => c === 'hs-mc-zebra' },
      previousElementSibling: null,
    }
    const filled = {
      id: '',
      dataset: {},
      classList: { contains: (c) => c === 'hs-filled' },
      previousElementSibling: counted,
    }
    expect(zebraOfInsert({ type: 'chat' }, filled)).toBe(false)
    expect(zebraOfInsert({ type: 'chat', isFirstMsg: true }, counted)).toBe(false)
  })

  test('the top row keeps its stripe when the window has slid', () => {
    const { els, msgsEl } = fakeList(['chat', 'chat', 'chat', 'chat'])
    // window slid: top row is striped, rows below are out of phase with it
    els[0].classList.toggle('hs-mc-zebra', true)
    els[1].classList.toggle('hs-mc-zebra', true)
    zebraRepaint(msgsEl, els[0])
    expect(els.map((e) => e.classList.contains('hs-mc-zebra'))).toEqual([true, false, true, false])
  })

  // what a removal leaves: the list with row `gone` cut out, stripes untouched
  function withRowRemoved(types, gone) {
    const { els } = fakeList(types)
    for (let i = 0; i < els.length; i++) els[i].classList.toggle('hs-mc-zebra', i % 2 === 1)
    const kept = els.filter((_, i) => i !== gone)
    kept.forEach((e, i) => {
      e.previousElementSibling = kept[i - 1] || null
      e.nextElementSibling = kept[i + 1] || null
    })
    return { kept, msgsEl: { firstElementChild: kept[0], lastElementChild: kept[kept.length - 1] }, below: kept[gone] }
  }
  const stripes = (els) => els.map((e) => e.classList.contains('hs-mc-zebra'))

  test('a row removed mid-list: the rows above realign, the newest rows keep their stripes', () => {
    const { kept, msgsEl, below } = withRowRemoved(['chat', 'chat', 'chat', 'chat', 'chat', 'chat'], 2)
    const bottomBefore = stripes(kept.slice(2))
    zebraRepaintUp(msgsEl, below)
    expect(stripes(kept.slice(2))).toEqual(bottomBefore)
    const s = stripes(kept)
    for (let i = 1; i < s.length; i++) expect(s[i]).toBe(!s[i - 1])
  })

  test('the upward pass skips notices and filled rows like the downward one', () => {
    const { kept, msgsEl, below } = withRowRemoved(
      ['chat', 'stream-event', 'chat', 'mention', 'chat', 'chat', 'chat'],
      4,
    )
    zebraRepaintUp(msgsEl, below)
    const counted = kept.filter((e) => !e.dataset.hsNotice && !e.classList.contains('hs-filled'))
    const s = stripes(counted)
    for (let i = 1; i < s.length; i++) expect(s[i]).toBe(!s[i - 1])
    expect(stripes(kept.filter((e) => !counted.includes(e)))).toEqual([false, false])
  })

  test('a removal at the very bottom anchors on the last row', () => {
    const { kept, msgsEl } = withRowRemoved(['chat', 'chat', 'chat', 'chat'], 3)
    const last = kept[kept.length - 1].classList.contains('hs-mc-zebra')
    zebraRepaintUp(msgsEl, null)
    expect(kept[kept.length - 1].classList.contains('hs-mc-zebra')).toBe(last)
    const s = stripes(kept)
    for (let i = 1; i < s.length; i++) expect(s[i]).toBe(!s[i - 1])
  })

  test('render restripes after a mid-list removal and after an in-place rebuild', () => {
    expect(MAIN_SRC).toContain('if (zebraGap) zebraRepaintUp(msgsEl,')
    expect(MAIN_SRC).toContain('if (zebraRebuilt) zebraRepaintUp(msgsEl, null)')
  })
})

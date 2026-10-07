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

const zebraOfInsert = new Function('zebraEnabled', `${sliceFn('zebraOfInsert')}; return zebraOfInsert`)(true)

const row = (zebra) => ({ classList: { contains: (c) => c === 'hs-mc-zebra' && zebra } })

function stripe(n) {
  const rows = []
  for (let i = 0; i < n; i++) rows.push(zebraOfInsert({ type: 'chat' }, i ? row(rows[i - 1]) : null))
  return rows
}

describe('zebra parity', () => {
  test('every zebra assignment goes through zebraOfInsert', () => {
    const adds = MAIN_SRC.match(/classList\.add\('hs-mc-zebra'\)/g) || []
    const viaRule = MAIN_SRC.match(/if \(zebraOfInsert\([^)]*\)\) \w+\.classList\.add\('hs-mc-zebra'\)/g) || []
    expect(adds.length).toBeGreaterThan(0)
    expect(viaRule.length).toBe(adds.length)
  })

  test('live append routes through zebraOfInsert', () => {
    expect(MAIN_SRC).toContain("if (zebraOfInsert(msg, msgsEl.lastElementChild)) div.classList.add('hs-mc-zebra')")
  })

  test('first row is plain, then strict alternation', () => {
    expect(stripe(4)).toEqual([false, true, false, true])
  })

  test('rebuild over the same rows reproduces the same stripes', () => {
    const live = stripe(6)
    const rebuilt = live.map((_, i) => zebraOfInsert({ type: 'chat' }, i ? row(live[i - 1]) : null))
    expect(rebuilt).toEqual(live)
  })
})

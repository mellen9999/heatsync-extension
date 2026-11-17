import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainSource } from './main-src.js'

/**
 * /lclear looked its tab up as a room name: on the live tab (and a merged tab's
 * other legs, and youtube) it said "nothing to clear here", and where it did
 * clear, it emptied the room's buffer under every other tab showing that room.
 * It now marks the tab: what it showed up to the clear stays hidden there only.
 */
const SRC = mainSource()
const s = SRC.indexOf('const _lclearCut = new Map()')
const BLOCK = SRC.slice(s, SRC.indexOf('\nfunction buildMessageDiv', s))

function harness(sources, live = { ch: 'xqc' }) {
  return new Function(
    'mergedTabSources',
    'getLiveChannel',
    'SCROLLBACK_MAX',
    `${BLOCK}\nreturn { lclearTab, lclearCutFor }`,
  )(
    (id) => sources[id] || [[], [], []],
    () => live.ch,
    1500,
  )
}

describe('/lclear marks the tab, not the room', () => {
  test('the live tab clears up to the newest row any platform showed', () => {
    const l = harness({ live: [[{ time: 100 }], [{ time: 250 }], [{ time: 180 }]] })
    expect(l.lclearTab('live')).toBe(true)
    expect(l.lclearCutFor('live')).toBe(250)
  })

  test('other tabs keep everything', () => {
    const l = harness({ live: [[{ time: 100 }], [], []] })
    l.lclearTab('live')
    expect(l.lclearCutFor('xqc')).toBe(0)
  })

  test("the live tab's mark stays with its stream", () => {
    const live = { ch: 'xqc' }
    const l = harness({ live: [[{ time: 100 }], [], []] }, live)
    l.lclearTab('live')
    live.ch = 'lirik'
    expect(l.lclearCutFor('live')).toBe(0)
    live.ch = 'xqc'
    expect(l.lclearCutFor('live')).toBe(100)
  })

  test('an empty tab has nothing to clear', () => {
    expect(harness({}).lclearTab('lirik')).toBe(false)
  })
})

test('the render pass, the live append and the command all use the mark', () => {
  expect(SRC).toContain('!isMsgUserDropped(m, id) && !(_cut && m.time <= _cut))')
  expect(SRC).toMatch(/const _cut = lclearCutFor\(tabId\)\n\s+if \(_cut && msg\.time <= _cut\) return true/)
  const input = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
  const cmd = input.slice(input.indexOf("if (cmd === 'lclear')"), input.indexOf("if (cmd === 'help')"))
  expect(cmd).toContain('lclearTab(currentTab)')
  expect(cmd).not.toContain('.clear?.()')
})

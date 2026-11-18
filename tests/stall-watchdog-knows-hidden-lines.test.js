// The stall watchdog asks "is the newest line the buffer holds on screen?" and, when it has not
// been for 4s, reports a stall and redraws. It never asked whether that line is MEANT to be on
// screen. On a slow chat with a hide rule, the hidden line stays the newest for a while: a false
// render_stall in the diag ring and a full redraw every 2.5s until someone else speaks (real
// kick, e2e s25, 11-18). The same for a muted chatter, a filter, /lclear, a repeat, a search.
import { describe, expect, test } from 'bun:test'
import { mainSource } from './main-src.js'

const SRC = mainSource()
const fn = (name) => {
  const a = SRC.indexOf(`function ${name}(`)
  const b = SRC.indexOf('\n}\n', a)
  if (a < 0 || b < 0) throw new Error(`carve: ${name}`)
  return SRC.slice(a, b + 3)
}

const NOW = 1_794_000_100_000
function watchdog(over = {}) {
  const world = {
    newest: { id: 'n1', user: 'sam', text: 'hello', time: NOW - 6000, platform: 'kick' },
    drawn: new Set(),
    rows: [{ _hsMsg: { text: 'earlier' } }],
    flags: { bots: false, cmds: false, dups: false },
    ruleHides: () => false,
    dropped: () => false,
    cut: 0,
    search: '',
    scrolledUp: false,
    ...over,
  }
  const out = { diag: [], renders: 0 }
  const msgsEl = {
    get children() {
      return world.rows
    },
    get lastElementChild() {
      const rows = world.rows
      const last = rows.at(-1)
      if (last) last.previousElementSibling = rows.at(-2) || null
      return last || null
    },
  }
  const check = new Function(
    'document',
    'window',
    'Date',
    'currentTab',
    'getChannelById',
    '_reconcileMsgKeyIndex',
    '_tabNewestBuffered',
    '_msgKeyIndex',
    'msgKeyOf',
    'editingChannel',
    'hsPanePanelOpen',
    'isScrolledUp',
    '_noHeal',
    'scheduleRenderMessages',
    '_filterFlags',
    'isMsgFiltered',
    'ruleHides',
    'isMsgUserDropped',
    'lclearCutFor',
    'liveSearchQuery',
    `let _stallLoggedAt = 0\n${fn('lastDrawnText')}\n${fn('lineNeverDraws')}\n${fn('renderStallCheck')}\nreturn renderStallCheck`,
  )(
    { hidden: false, getElementById: () => msgsEl },
    { __hsDiag: (e, d) => out.diag.push([e, d]) },
    { now: () => NOW },
    'live',
    () => null,
    () => {},
    () => world.newest,
    { has: (k) => world.drawn.has(k) },
    (m) => m.id,
    null,
    () => false,
    world.scrolledUp,
    () => false,
    () => out.renders++,
    () => world.flags,
    (m, f) => !!(f.cmds && m.text.startsWith('!')),
    (m) => world.ruleHides(m),
    (m) => world.dropped(m),
    () => world.cut,
    () => world.search,
  )
  check()
  return out
}

describe('the stall watchdog', () => {
  test('a line that should be on screen and is not: reported and redrawn', () => {
    const r = watchdog()
    expect(r.diag.map((d) => d[0])).toEqual(['render_stall'])
    expect(r.renders).toBe(1)
  })

  test('the newest line is on screen: nothing', () => {
    const r = watchdog({ drawn: new Set(['n1']) })
    expect([r.diag.length, r.renders]).toEqual([0, 0])
  })

  const quiet = {
    'a hide rule takes it out': { ruleHides: () => true },
    'its chatter is muted or blocked': { dropped: () => true },
    'a filter takes it out (commands)': {
      flags: { cmds: true },
      newest: { id: 'n1', text: '!song', time: NOW - 6000 },
    },
    'it is behind /lclear': { cut: NOW - 1000 },
    'it repeats the last row with hide repeats on': {
      flags: { dups: true },
      rows: [{ _hsMsg: { text: 'earlier' } }, { _hsMsg: { text: 'hello' } }],
    },
    'the line is marked hidden': { newest: { id: 'n1', text: 'x', time: NOW - 6000, hidden: true } },
    'a search is up': { search: 'someone' },
  }
  for (const [why, over] of Object.entries(quiet)) {
    test(`not on screen because ${why}: no stall, no redraw`, () => {
      const r = watchdog(over)
      expect([why, r.diag.length, r.renders]).toEqual([why, 0, 0])
    })
  }

  test('hide repeats on, but the newest line says something new: still a stall', () => {
    const r = watchdog({ flags: { dups: true } })
    expect(r.diag.length).toBe(1)
  })

  test('a reader who scrolled up: recorded with the reason, never fought', () => {
    const r = watchdog({ scrolledUp: true })
    expect(r.diag[0][1].scrolledUp).toBe(true)
    expect(r.renders).toBe(0)
  })
})

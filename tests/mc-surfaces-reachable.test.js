/**
 * Every full surface in the multichat is a pane with an address.
 *
 * mellen's ruling: channel tabs and live show no sub-strip. Summary, logs,
 * status and platforms stay addressable cells (switchTab(tab, sub)) that mount
 * as panes; /status is the hub that links to the rest. Slash commands, hotkeys
 * and right-click items route there, never mount a surface themselves. This
 * gate keeps that true:
 *   1. SURFACES is the closed list of full surfaces; each maps to an MC_TABS cell.
 *   2. Every opener routes through switchTab(tab, sub) / mcOpenChannelCell.
 *   3. Every cell that is not a tab's home has a pane to land on.
 *   4. Only feed draws the shared row; the status pane carries the hub links.
 * Adding a surface means adding it here AND to tab-registry.js; the test fails
 * until both agree. Source-text checks, same as the other gates (the bundle
 * shares one scope, so there is nothing to import).
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MC = join(import.meta.dir, '..', 'src', 'multichat')
const read = (f) => readFileSync(join(MC, f), 'utf8')
const files = readdirSync(MC).filter((f) => f.endsWith('.js'))
const REG = read('tab-registry.js')
const api = new Function(`${REG}\nreturn { MC_TABS, mcSubCells, mcCellAddress, mcShowsRow }`)()

// id → [tab, cell] (cell omitted for a tab with no 2nd row). A channel tab
// stands in as 'live' — they share one set of cells.
const SURFACES = {
  feed: ['feed', 'feed'],
  discover: ['feed', 'discover'],
  whispers: ['whispers'],
  mentions: ['mentions'],
  pinned: ['pinned'],
  modlog: ['modlog'],
  live: ['live', 'chat'],
  'stream summary': ['live', 'summary'],
  'chat logs': ['live', 'logs'],
  'chat status': ['live', 'status'],
  'add channel': ['add'],
  settings: ['settings', 'display'],
  help: ['settings', 'help'],
  'edit live platforms': ['live', 'platforms'],
}

describe('every full surface is an addressable cell', () => {
  for (const [name, [tab, cell]] of Object.entries(SURFACES)) {
    test(name, () => {
      expect(
        api.MC_TABS.some((t) => t.id === tab),
        `no MC_TABS entry for ${tab}`,
      ).toBe(true)
      if (cell) expect(api.mcSubCells(tab).map((c) => c.id)).toContain(cell)
    })
  }

  test('every tab that has a 2nd row lists only surfaces this gate knows', () => {
    const known = new Set(Object.values(SURFACES).map(([, cell]) => cell))
    for (const id of ['feed', 'live']) {
      for (const c of api.mcSubCells(id)) expect(known.has(c.id), `${id} › ${c.id} is not in SURFACES`).toBe(true)
    }
  })
})

describe('openers are shortcuts to a cell, never the door', () => {
  const INPUT = read('input.js')

  test('/status and /modes switch to the status cell', () => {
    expect(INPUT).toMatch(/mcOpenChannelCell\('status'/)
    expect(INPUT).not.toMatch(/showChatStatusPanel|hs-mc-status-overlay/)
  })

  test('/help and /? open settings › help, no slash overlay', () => {
    expect(INPUT).toMatch(/cmd === 'help'\) \{\s*switchTab\('settings', 'help'\)/)
    expect(INPUT).not.toMatch(/showSlashHelp|hs-mc-slash-help/)
  })

  test('the message right-click "chat logs" is a shortcut to the logs cell', () => {
    expect(INPUT).toMatch(/label: 'chat logs',\s*fn: \(\) => mcOpenChannelCell\('logs'/)
  })

  test('/tab resolves through the cell address, so /tab discover lands on feed › discover', () => {
    expect(INPUT).toMatch(/mcCellAddress\(target\)\s*switchTab\(addr\.tab, addr\.sub\)/)
    expect(api.mcCellAddress('discover')).toEqual({ tab: 'feed', sub: 'discover' })
  })

  test('edit live platforms is a shortcut to live › platforms (dropdown + right-click call it)', () => {
    expect(read('channel-mgmt.js')).toMatch(
      /function showEditLivePlatforms\(\) \{[^}]*switchTab\('live', 'platforms'\)/,
    )
    expect(read('main.js').match(/showEditLivePlatforms\(\)/g).length).toBeGreaterThanOrEqual(2)
  })

  test('the empty-feed button switches to the discover cell', () => {
    expect(read('social.js')).toMatch(/switchTab\('feed', 'discover'\)/)
  })

  test('no opener mounts a surface directly — only the pane table in main.js does', () => {
    for (const [fn, def] of [
      ['openChatLogsView', 'chat-logs.js'],
      ['buildChatStatusPanel', 'twitch-api.js'],
      ['mountLiveStreamSummary', 'stream-stats.js'],
    ]) {
      for (const f of files) {
        if (f === def || f === 'main.js') continue
        expect(read(f), `${f} calls ${fn} itself`).not.toMatch(new RegExp(`(?<!function )\\b${fn}\\(`))
      }
    }
  })

  test('the stream summary has one door: no pinned card, no links item', () => {
    for (const f of files) expect(read(f), f).not.toMatch(/renderStreamSummary/)
    expect(read('twitch-api.js')).not.toMatch(/action: 'summary'/)
  })

  test('every cell an opener names exists in the registry', () => {
    const cellsOf = (tab) => new Set(api.mcSubCells(tab).map((c) => c.id))
    const channel = cellsOf('live') // live's cells are a superset of a channel tab's
    for (const f of files) {
      const src = read(f)
      for (const m of src.matchAll(/mcOpenChannelCell\('(\w+)'/g)) {
        expect(channel.has(m[1]), `${f}: mcOpenChannelCell('${m[1]}') is not a channel cell`).toBe(true)
      }
      for (const m of src.matchAll(/switchTab\('(\w+)',\s*'(\w+)'/g)) {
        const known = m[1] === 'feed' || m[1] === 'settings' || m[1] === 'live' ? cellsOf(m[1]) : channel
        expect(known.has(m[2]), `${f}: switchTab('${m[1]}', '${m[2]}') names no cell`).toBe(true)
      }
    }
  })
})

describe('switching cell inside a tab', () => {
  test('a settings cell change is detected before switchTab records it (else the pane never repaints)', () => {
    const m = read('main.js')
    const fast = m.indexOf('applySub(id, nextSub, subOpts)\n      return')
    const rec = m.indexOf("if (id === 'settings' && nextSub) _setSettingsSubtab(nextSub)")
    expect(fast).toBeGreaterThan(0)
    expect(rec).toBeGreaterThan(fast)
  })
})

describe('every cell has somewhere to land', () => {
  const MAIN = read('main.js')
  const panes = MAIN.match(/const MC_SUB_PANES = \{([\s\S]*?)\n {2}\}\n/)?.[1] || ''

  test('each non-home channel cell has a pane renderer', () => {
    expect(panes.length).toBeGreaterThan(0)
    for (const c of api.mcSubCells('live').slice(1)) {
      expect(panes, `no pane for the ${c.id} cell`).toMatch(new RegExp(`\\b${c.id}:`))
    }
  })

  test('opening a pane never tears down the chat underneath it', () => {
    expect(MAIN).toMatch(/pane\.id = 'hs-mc-subpane'/)
    expect(read('chat-logs.js')).toMatch(/getElementById\('hs-mc-subpane'\)/)
  })
})

describe('no sub-strip on channel tabs, /status is the hub', () => {
  test('mcShowsRow: feed yes, live and channel tabs no', () => {
    expect(api.mcShowsRow('feed')).toBe(true)
    expect(api.mcShowsRow('discover')).toBe(true)
    expect(api.mcShowsRow('live')).toBe(false)
    expect(api.mcShowsRow('xqc')).toBe(false)
  })

  test('renderSubRow hides the row when the tab does not show it', () => {
    expect(read('main.js')).toMatch(/!mcShowsRow\(currentTab\)/)
  })

  test('the status pane has a x and links to summary, my logs and platforms', () => {
    const m = read('main.js')
    const hub = m.match(/function _paneHub\(ctx\) \{([\s\S]*?)\n {2}\}\n/)?.[1] || ''
    expect(hub).toMatch(/hsXButton\([^)]*mcLeaveSubPane\)/)
    expect(hub).toMatch(/link\('summary', ctx\.tab, 'summary'\)/)
    expect(hub).toMatch(/link\('my logs', ctx\.tab, 'logs'\)/)
    expect(hub).toMatch(/ctx\.tab === 'live'\) link\('platforms', 'live', 'platforms'\)/)
    const status = m.match(/status: async \(pane, ctx\) => \{([\s\S]*?)\n {4}\},/)?.[1] || ''
    expect(status).toMatch(/_paneHub\(ctx\)/)
    expect(status).toMatch(/pane\.prepend\(hub\)/) // the error state keeps the hub
    expect(status).toMatch(/replaceChildren\(hub, panel\)/)
  })
})

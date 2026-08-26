/**
 * Per-tab message counter — the number on the right of a channel name.
 *
 * tab-counter.js is a plain source file concatenated into the content bundle,
 * so it's loaded here the same way message-ordering.test.js loads social.js:
 * `new Function` with its call-time dependencies injected. `Date` is injected
 * too, so the heat window can be tested without sleeping through it.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = (...p) => join(import.meta.dir, '..', ...p)
const SRC = readFileSync(dir('src', 'multichat', 'tab-counter.js'), 'utf8')
const SCHEMA = readFileSync(dir('src', 'lib', 'settings-schema.js'), 'utf8')
const MAIN = readFileSync(dir('src', 'multichat', 'main.js'), 'utf8')
const SOCIAL = readFileSync(dir('src', 'multichat', 'social.js'), 'utf8')
const CHANNEL_MGMT = readFileSync(dir('src', 'multichat', 'channel-mgmt.js'), 'utf8')
const EN = JSON.parse(readFileSync(dir('src', '_locales', 'en', 'messages.json'), 'utf8'))

function load({ mode = 'unread', currentTab = 'other', now = 1_000_000 } = {}) {
  const clock = { now }
  const build = new Function(
    'getSetting',
    'tabBarElement',
    'currentTab',
    'cleanup',
    'Date',
    `${SRC}
    return { bumpTabActivity, clearTabUnread, markTabRead, dropTabActivity,
             tabUnreadCount, tabHeatCount, tabCounterMode, _tabCountText }`,
  )
  const api = build(
    () => mode,
    null, // no tab bar in these tests — the paint paths bail, the maths doesn't
    currentTab,
    { setIntervalIfVisible: () => 1, clearInterval: () => {} },
    { now: () => clock.now * 1000 },
  )
  return { ...api, advance: (secs) => (clock.now += secs) }
}

describe('unread', () => {
  let t
  beforeEach(() => {
    t = load()
  })

  test('counts messages for a backgrounded tab', () => {
    for (let i = 0; i < 3; i++) t.bumpTabActivity('a', false)
    expect(t.tabUnreadCount('a')).toBe(3)
  })

  test('never counts the tab you are looking at', () => {
    for (let i = 0; i < 5; i++) t.bumpTabActivity('a', true)
    expect(t.tabUnreadCount('a')).toBe(0)
  })

  test('reading a tab drops it to zero', () => {
    t.bumpTabActivity('a', false)
    t.bumpTabActivity('a', false)
    t.clearTabUnread('a')
    expect(t.tabUnreadCount('a')).toBe(0)
  })

  test('reading one tab leaves the others alone', () => {
    t.bumpTabActivity('a', false)
    t.bumpTabActivity('b', false)
    t.clearTabUnread('a')
    expect(t.tabUnreadCount('b')).toBe(1)
  })

  test('is zero for a tab that never saw a message', () => {
    expect(t.tabUnreadCount('nope')).toBe(0)
  })
})

describe('heat', () => {
  let t
  beforeEach(() => {
    t = load({ mode: 'heat' })
  })

  test('counts the tab you are looking at — that is the whole point', () => {
    for (let i = 0; i < 4; i++) t.bumpTabActivity('a', true)
    expect(t.tabHeatCount('a')).toBe(4)
    expect(t.tabUnreadCount('a')).toBe(0)
  })

  test('reading a tab does not clear it — heat is not about you', () => {
    t.bumpTabActivity('a', false)
    t.clearTabUnread('a')
    expect(t.tabHeatCount('a')).toBe(1)
  })

  test('messages age out of the 60s window', () => {
    t.bumpTabActivity('a', false)
    expect(t.tabHeatCount('a')).toBe(1)
    t.advance(59)
    expect(t.tabHeatCount('a')).toBe(1)
    t.advance(2)
    expect(t.tabHeatCount('a')).toBe(0)
  })

  test('a gap longer than the ring clears it outright, without 90 shifts', () => {
    t.bumpTabActivity('a', false)
    t.advance(10_000)
    expect(t.tabHeatCount('a')).toBe(0)
    // still usable afterwards
    t.bumpTabActivity('a', false)
    expect(t.tabHeatCount('a')).toBe(1)
  })

  test('advances on read, so a tab that missed its ticks is still correct', () => {
    // This is the reason the ring is elapsed-driven: the repaint ticker runs
    // via setIntervalIfVisible and simply does not fire while hidden.
    t.bumpTabActivity('a', false)
    t.advance(70)
    expect(t.tabHeatCount('a')).toBe(0)
  })

  test('keeps a rolling sum across seconds', () => {
    t.bumpTabActivity('a', false)
    t.advance(30)
    t.bumpTabActivity('a', false)
    expect(t.tabHeatCount('a')).toBe(2)
    t.advance(31) // first one is now 61s old
    expect(t.tabHeatCount('a')).toBe(1)
  })
})

describe('rendered text', () => {
  test('off renders nothing whatever the counts are', () => {
    const t = load({ mode: 'off' })
    t.bumpTabActivity('a', false)
    expect(t._tabCountText('a', 'off', false)).toBe('')
  })

  test('zero renders nothing rather than a 0', () => {
    const t = load()
    expect(t._tabCountText('a', 'unread', false)).toBe('')
  })

  test('caps at 999+ so a busy tab stops widening', () => {
    const t = load()
    for (let i = 0; i < 999; i++) t.bumpTabActivity('a', false)
    expect(t._tabCountText('a', 'unread', false)).toBe('999')
    t.bumpTabActivity('a', false)
    expect(t._tabCountText('a', 'unread', false)).toBe('999+')
  })

  test('the active tab shows heat but never unread', () => {
    const t = load()
    for (let i = 0; i < 3; i++) t.bumpTabActivity('a', true)
    expect(t._tabCountText('a', 'unread', true)).toBe('')
    expect(t._tabCountText('a', 'heat', true)).toBe('3')
  })

  test('mode defaults to unread when the setting is unset', () => {
    const build = new Function('getSetting', 'tabBarElement', 'currentTab', 'cleanup', `${SRC}\nreturn tabCounterMode`)
    expect(build(() => undefined, null, 'x', {})()).toBe('unread')
  })
})

describe('lifecycle', () => {
  test('removing a channel forgets its counts, so a re-add starts clean', () => {
    const t = load()
    t.bumpTabActivity('a', false)
    t.dropTabActivity('a')
    expect(t.tabUnreadCount('a')).toBe(0)
    expect(t.tabHeatCount('a')).toBe(0)
  })
})

describe('wiring', () => {
  test('all four message-arrival sites count, not just the background ones', () => {
    // updateTabIndicator hard-returns for the active tab, so counting inside it
    // would make heat blind to the tab you are reading.
    expect(MAIN.split('bumpTabActivity(tabId, currentTab === tabId)').length - 1).toBe(2)
    expect(SOCIAL.split('bumpTabActivity(tabId, currentTab === tabId)').length - 1).toBe(2)
  })

  test('the tab bar repaints counters after it rebuilds itself', () => {
    // updateTabBar writes labels with textContent, which drops the chip.
    const i = MAIN.indexOf('function updateTabBar()')
    const body = MAIN.slice(i, MAIN.indexOf('\n  }', MAIN.indexOf('applyHiddenTabs()', i)))
    expect(body).toContain('refreshTabCounters()')
  })

  test('every has-new removal also clears the unread count', () => {
    const removals = MAIN.split('\n').filter(
      (l) => l.includes("remove('has-new") || l.includes("remove('has-mentions', 'has-new"),
    )
    expect(removals.length).toBeGreaterThan(0)
    const clears = (MAIN.match(/clearTabUnread\(|markTabRead\(/g) || []).length
    expect(clears).toBeGreaterThanOrEqual(removals.length)
  })

  test('removing a channel drops its activity', () => {
    expect(CHANNEL_MGMT).toContain('dropTabActivity(tabId)')
  })

  test('the setting is declared with all three modes and a real label', () => {
    const i = SCHEMA.indexOf("key: 'tabCounter'")
    expect(i).toBeGreaterThan(-1)
    const entry = SCHEMA.slice(i, SCHEMA.indexOf('\n  },', i))
    for (const v of ['off', 'unread', 'heat']) expect(entry).toContain(`value: '${v}'`)
    expect(entry).toContain("default: 'unread'")
    expect(EN.mc_settings_tab_counter?.message).toBeTruthy()
    expect(EN.mc_settings_tab_counter_desc?.message).toBeTruthy()
  })

  test('the heat ticker is visibility-gated and mode-gated, not always-on', () => {
    expect(SRC).toContain('cleanup.setIntervalIfVisible')
    expect(SRC).toContain("const want = mode === 'heat'")
    expect(SRC).toContain('cleanup.clearInterval(_tabCounterTimer)')
  })
})

/**
 * The SW lets go of a twitch channel once no tab wants it (chrome/background.js).
 *
 * Regression anchor (2026-10-13): dropping a tab's interest left the channel's
 * 3000-msg ring in RAM, still JOINed, persisting every 1.5s and re-JOINed on
 * every reconnect; every SW wake restored every ring <24h old. And because
 * "open streams" was every channel ANY tab had joined, each tab's auto-tab
 * kept a closed stream open — measured: 4 tabs → close 3 → the SW still held
 * and fed all 4 (7k → 9.4k msgs), the survivor showed 3 dead auto-tabs.
 * scripts/heap-tabs.ts drives the real thing; this pins the logic.
 *
 * Functions are carved out of the real file (never copied) and run against
 * stubbed BG_IRC / browser / timers, like background-helpers.test.js.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const BG_SRC = readFileSync(join(ROOT, 'chrome', 'background.js'), 'utf8')
const MAIN_SRC = readFileSync(join(ROOT, 'src', 'multichat', 'main.js'), 'utf8')

function extractFn(name, src = BG_SRC) {
  const start = src.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`"${name}" not found — source drifted, update this test`)
  const end = src.indexOf('\n}', start)
  return src.slice(start, end + 2)
}

const FNS = [
  'bgIrcSafeChannel',
  'bgIrcScheduleRelease',
  'bgIrcCancelRelease',
  'bgIrcReleaseChannel',
  'bgIrcRegisterTabInterest',
  'bgIrcUnregisterTabInterest',
]

function harness() {
  const timers = new Map()
  let nextId = 1
  const sent = { irc: [], ws: [], stored: {} }
  const BG_IRC = {
    ws: { readyState: 1, send: (l) => sent.irc.push(l) },
    channels: new Map(),
    tabInterest: new Map(),
    channelTabs: new Map(),
    chanLastSeen: new Map(),
    chanRejoinAttempts: new Map(),
    roomstates: new Map(),
    persistTimers: new Map(),
    releaseTimers: new Map(),
  }
  const ring = (n) => ({ getAll: () => Array.from({ length: n }, (_, i) => ({ id: String(i) })) })
  const api = new Function(
    'BG_IRC',
    'browser',
    'wsSend',
    'setTimeout',
    'clearTimeout',
    'WebSocket',
    'log',
    'bgBroadcastOpenChannels',
    `const BG_IRC_RELEASE_GRACE_MS = 60000\n${FNS.map((f) => extractFn(f)).join('\n')}\nreturn { ${FNS.join(', ')} }`,
  )(
    BG_IRC,
    { storage: { local: { set: async (o) => Object.assign(sent.stored, o) } } },
    (m) => sent.ws.push(m),
    (fn) => {
      const id = nextId++
      timers.set(id, fn)
      return id
    },
    (id) => timers.delete(id),
    { OPEN: 1 },
    () => {},
    () => {},
  )
  const fireTimers = () => {
    for (const [id, fn] of [...timers]) {
      timers.delete(id)
      fn()
    }
  }
  return { api, BG_IRC, sent, ring, fireTimers, timers }
}

describe('a channel no tab wants is released after the grace', () => {
  test('last tab parts → PART, server irc:part, ring flushed to disk and gone from RAM', () => {
    const { api, BG_IRC, sent, ring, fireTimers } = harness()
    BG_IRC.channels.set('foo', ring(5))
    api.bgIrcRegisterTabInterest(1, 'foo')
    api.bgIrcUnregisterTabInterest(1, 'foo')
    expect(BG_IRC.channels.has('foo')).toBe(true) // not before the grace
    fireTimers()
    expect(BG_IRC.channels.has('foo')).toBe(false)
    expect(sent.irc).toContain('PART #foo\r\n')
    expect(sent.ws).toContainEqual({ type: 'irc:part', channel: 'foo' })
    expect(sent.stored.hs_irc_foo.msgs).toHaveLength(5)
  })

  test('a re-join inside the grace (reload, channel hop) keeps the channel', () => {
    const { api, BG_IRC, sent, ring, fireTimers, timers } = harness()
    BG_IRC.channels.set('foo', ring(5))
    api.bgIrcRegisterTabInterest(1, 'foo')
    api.bgIrcUnregisterTabInterest(1, 'foo')
    api.bgIrcRegisterTabInterest(2, 'foo')
    expect(timers.size).toBe(0)
    fireTimers()
    expect(BG_IRC.channels.has('foo')).toBe(true)
    expect(sent.irc).toHaveLength(0)
  })

  test('another tab still holding it keeps it', () => {
    const { api, BG_IRC, sent, ring, fireTimers } = harness()
    BG_IRC.channels.set('foo', ring(5))
    api.bgIrcRegisterTabInterest(1, 'foo')
    api.bgIrcRegisterTabInterest(2, 'foo')
    api.bgIrcUnregisterTabInterest(1, 'foo')
    fireTimers()
    expect(BG_IRC.channels.has('foo')).toBe(true)
    expect(sent.irc).toHaveLength(0)
  })

  test('release re-checks interest when it fires', () => {
    const { api, BG_IRC, ring } = harness()
    BG_IRC.channels.set('foo', ring(5))
    BG_IRC.channelTabs.set('foo', new Set([3]))
    api.bgIrcReleaseChannel('foo')
    expect(BG_IRC.channels.has('foo')).toBe(true)
  })

  test('tab close arms the release too', () => {
    const start = BG_SRC.indexOf('// Tab cleanup — drop interest when a tab closes')
    expect(start).toBeGreaterThan(-1)
    const body = BG_SRC.slice(start, BG_SRC.indexOf('\n})', start))
    expect(body).toContain('bgIrcScheduleRelease(ch)')
  })
})

describe('rings are read per join, not all at SW wake', () => {
  const restore = extractFn('bgIrcRestoreFromStorage')

  test('restore never puts a ring in BG_IRC.channels', () => {
    expect(restore).not.toContain('BG_IRC.channels.set')
  })

  test('the join handler reads the one channel it joins', () => {
    const at = BG_SRC.indexOf("message.type === 'bg_irc_join'")
    const handler = BG_SRC.slice(at, BG_SRC.indexOf("message.type === 'bg_irc_part'", at))
    expect(handler).toContain('bgIrcReadPersisted(ch)')
    expect(handler).toContain('bgIrcEnsureChannel(ch, restored)')
  })

  test('a woken SW asks open tabs to re-join, and the tab answers', () => {
    expect(BG_SRC).toContain("{ type: 'bg_irc_rejoin' }")
    const irc = readFileSync(join(ROOT, 'src', 'multichat', 'irc.js'), 'utf8')
    expect(irc).toContain("message.type === 'bg_irc_rejoin'")
    const at = irc.indexOf('  _rejoinBg() {')
    expect(at).toBeGreaterThan(-1)
    expect(irc.slice(at, irc.indexOf('\n  }', at))).toContain("type: 'bg_irc_join'")
  })

  test('late server backlog does not resurrect a released channel', () => {
    const merge = extractFn('bgIrcMergeServerBacklog')
    expect(merge).not.toContain('BG_IRC.channels.set')
  })
})

describe('open streams come from tab URLs, not interest', () => {
  const { bgIrcPageChannel } = new Function(
    `${extractFn('bgIrcSafeChannel')}\n${extractFn('bgIrcPageChannel')}\nreturn { bgIrcPageChannel }`,
  )()

  test.each([
    ['https://www.twitch.tv/Foo_Bar', 'foo_bar'],
    ['https://twitch.tv/foo?x=1', 'foo'],
    ['https://www.twitch.tv/popout/foo/chat', 'foo'],
    ['https://www.twitch.tv/embed/foo/chat?parent=x', 'foo'],
    ['https://dashboard.twitch.tv/u/foo', null],
    ['https://m.twitch.tv/foo', null],
    ['https://www.twitch.tv/', null],
    ['https://kick.com/foo', null],
    ['not a url', null],
  ])('%s → %s', (url, want) => {
    expect(bgIrcPageChannel(url)).toBe(want)
  })

  test('neither the broadcast nor the boot pull reads channelTabs', () => {
    const at = BG_SRC.indexOf('function bgBroadcastOpenChannels()')
    const bcast = BG_SRC.slice(at, BG_SRC.indexOf('\n}', at))
    expect(bcast).toContain('bgIrcOpenChannels()')
    expect(bcast).not.toContain('channelTabs')
    const pull = BG_SRC.slice(BG_SRC.indexOf("message.type === 'bg_get_open_channels'"))
    expect(pull.slice(0, 300)).toContain('bgIrcOpenChannels()')
  })
})

describe('a dropped auto-tab parts its chat (content side)', () => {
  test('reconcileAutoTabs parts + drops caches like removeChannel', () => {
    const at = MAIN_SRC.indexOf('function reconcileAutoTabs(')
    expect(at).toBeGreaterThan(-1)
    const dropLoop = MAIN_SRC.slice(at, MAIN_SRC.indexOf('const MAX_EPHEMERAL_TABS', at))
    expect(dropLoop).toContain('irc?.part?.(ch)')
    expect(dropLoop).toContain('_dropTabCache(c.id)')
    expect(dropLoop).toContain('dropTabActivity(c.id)')
  })
})

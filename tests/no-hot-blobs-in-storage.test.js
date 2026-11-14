// the rule: no large or hot blob goes through chrome.storage.local.
//
// every storage.local.set fires storage.onChanged in EVERY extension context with a listener (each
// twitch/kick/youtube tab's content scripts, ~36 listeners) carrying a structured clone of the old AND new
// value, and Firefox keeps those clones outside the GC: a user measured 16-18GB from the twitch ring alone
// (~8MB written every 1.5s). The rings, the kick/yt rings, the channel emote sets and the saved mentions
// now live in the background's IndexedDB; tabs get them by message. This file pins that.

import { afterEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { bootSw, disposeAll, tabSender } from './harness/sw.js'

afterEach(disposeAll)

const SRC_DIR = join(import.meta.dir, '..', 'src')
function walk(dir) {
  const out = []
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.js')) out.push(p)
  }
  return out
}
const FILES = walk(SRC_DIR).map((p) => [p.slice(SRC_DIR.length + 1), readFileSync(p, 'utf8')])

// keys (or key families) that must never be written to storage.local again
const MOVED = [
  /\bhs_irc_(?!sync_|parser_version)/,
  /\bhs_kick_(?!sync_|followed_synced|idb_v1)/,
  /\bhs_yt_(?!sync_|mod_status|idb_v1)/,
  /\bchannel_emotes_map\b/,
  /\bchannel_emotes_fetched_at\b/,
  /\bhs_mentions_v2\b/,
]

/** the argument text of every `storage.local.set(...)` call in `src` (balanced parens) */
function setCalls(src) {
  const out = []
  const re = /storage\.local\.set\(/g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1
    let i = re.lastIndex
    while (i < src.length && depth > 0) {
      const c = src[i++]
      if (c === '(') depth++
      else if (c === ')') depth--
    }
    out.push(src.slice(re.lastIndex, i - 1))
  }
  return out
}

describe('the moved keys are never written to storage.local', () => {
  test('the scan sees the real call sites', () => {
    const n = FILES.reduce((a, [, s]) => a + setCalls(s).length, 0)
    expect(n).toBeGreaterThan(60)
  })

  for (const re of MOVED) {
    test(`${re.source}`, () => {
      const hits = []
      for (const [f, s] of FILES)
        for (const call of setCalls(s)) if (re.test(call)) hits.push(`${f}: ${call.slice(0, 80)}`)
      expect(hits).toEqual([])
    })
  }

  test('...nor through a computed key that carries one of the families', () => {
    const hits = []
    for (const [f, s] of FILES) {
      for (const m of s.matchAll(/\[`(hs_(?:irc|kick|yt)_)\$\{[^}]+\}`\]\s*:/g)) hits.push(`${f}: ${m[0]}`)
    }
    expect(hits).toEqual([])
  })
})

describe('content gets that data by message, not from storage', () => {
  const src = (f) => FILES.find(([n]) => n === f)[1]

  test('kick history comes from the background; no tab keeps or reads a kick ring in storage', () => {
    const irc = src('multichat/irc.js')
    expect(irc).toContain("type: 'bg_kick_history'")
    expect(irc).not.toMatch(/hs_kick_/)
    expect(irc).not.toContain('persistBuffer')
    expect(irc).not.toContain('loadHistory(ch)')
  })

  test('every emote cold start asks the background for the channel sets', () => {
    for (const f of ['content/content.js', 'content/youtube-content.js', 'multichat/emotes.js']) {
      expect(src(f)).toContain("type: 'get_channel_emotes_map'")
    }
    for (const [f, s] of FILES) {
      if (f.startsWith('background/')) continue
      expect(`${f}: ${/storage\.local\.get\([^)]*channel_emotes_map/.test(s)}`).toBe(`${f}: false`)
      expect(`${f}: ${/changes\.channel_emotes_map/.test(s)}`).toBe(`${f}: false`)
    }
  })

  test('the saved mentions list is handed to the background and read back from it', () => {
    const st = src('multichat/main-state.js')
    expect(st).toContain("type: 'bg_mentions_put'")
    expect(st).toContain("type: 'bg_mentions_get'")
  })
})

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0)
const TAB = 'https://www.twitch.tv/kripp'
const sender = tabSender(7, TAB)
const CONFIG = { heatsync_multichat: { channels: [{ id: 'c1', kick: 'abc' }] } }
const boot = (over = {}) => bootSw({ tabs: [{ id: 7, url: TAB }], sockets: 'open', ...over })
const kickMsg = (n) => ({ channel: 'abc', id: `m${n}`, username: 'u', content: `hello ${n}`, timestamp: NOW + n })

describe('kick rings: the background is the one owner, in IndexedDB', () => {
  test('a message lands in the ring, not in storage.local; a tab reads it by message', async () => {
    const sw = await boot({ storage: { local: CONFIG } })
    sw.eval(`bgKickIngest(${JSON.stringify(kickMsg(1))})`)
    await sw.advance(2000)
    expect(sw.idb.snapshot('kick').abc.msgs.map((m) => m.text)).toEqual(['hello 1'])
    expect(Object.keys(sw.storage.local.snapshot()).filter((k) => k.startsWith('hs_kick_abc'))).toEqual([])
    const got = await sw.send({ type: 'bg_kick_history', channel: 'abc' }, sender)
    expect(got.msgs.map((m) => m.text)).toEqual(['hello 1'])
  })

  test('puts are throttled to one per channel per 30s, and the last state still lands', async () => {
    const sw = await boot({ storage: { local: CONFIG } })
    sw.eval(`bgKickIngest(${JSON.stringify(kickMsg(1))})`)
    await sw.advance(2000) // first put
    sw.eval(`bgKickIngest(${JSON.stringify(kickMsg(2))})`)
    await sw.advance(10_000)
    expect(sw.idb.snapshot('kick').abc.msgs).toHaveLength(1) // held back
    sw.eval(`bgKickIngest(${JSON.stringify(kickMsg(3))})`)
    await sw.advance(25_000)
    expect(sw.idb.snapshot('kick').abc.msgs.map((m) => m.text)).toEqual(['hello 1', 'hello 2', 'hello 3'])
  })

  test('a woken worker paints a reopened channel from its ring at once', async () => {
    const sw = await boot({ storage: { local: CONFIG } })
    sw.eval(`bgKickIngest(${JSON.stringify(kickMsg(1))})`)
    await sw.advance(2000)
    const woken = await sw.restart()
    const got = await woken.send({ type: 'bg_kick_history', channel: 'abc' }, sender)
    expect(got.msgs.map((m) => m.text)).toContain('hello 1')
  })

  test('rings an older build left in storage.local move once; the follow ledger is left alone', async () => {
    const ring = {
      msgs: [{ id: 'o1', user: 'u', text: 'old one', time: NOW, platform: 'kick', channel: 'abc' }],
      ts: NOW,
    }
    const sw = await boot({
      storage: { local: { ...CONFIG, hs_kick_abc: ring, hs_kick_followed_synced: ['x'] } },
    })
    const got = await sw.send({ type: 'bg_kick_history', channel: 'abc' }, sender)
    expect(got.msgs.map((m) => m.text)).toContain('old one')
    const stored = sw.storage.local.snapshot()
    expect(stored.hs_kick_abc).toBeUndefined()
    expect(stored.hs_kick_followed_synced).toEqual(['x'])
  })
})

describe('kick rows only a tab sees (sub notices, native tap) go to the background ring', () => {
  const notice = (over = {}) => ({
    user: 'system',
    text: '',
    systemMsg: 'bob subscribed',
    type: 'usernotice',
    time: NOW + 5,
    ...over,
  })

  test('a content-only row survives the reload path: append -> persist -> restart -> bg_kick_history', async () => {
    const sw = await boot({ storage: { local: CONFIG } })
    sw.eval(`bgKickIngest(${JSON.stringify(kickMsg(1))})`)
    sw.eval(`bgKickIngest(${JSON.stringify(kickMsg(9))})`)
    const r = await sw.send({ type: 'bg_kick_append', channel: 'ABC', msgs: [notice()] }, sender)
    expect(r.added).toBe(1)
    await sw.advance(2000)
    expect(Object.keys(sw.storage.local.snapshot()).filter((k) => k.startsWith('hs_kick_abc'))).toEqual([])
    const woken = await sw.restart()
    const got = await woken.send({ type: 'bg_kick_history', channel: 'abc' }, sender)
    // ring order is by time: between hello 1 and hello 9
    expect(got.msgs.map((m) => m.systemMsg || m.text)).toEqual(['hello 1', 'bob subscribed', 'hello 9'])
  })

  test('deduped by id, and an id-less row by its content', async () => {
    const sw = await boot({ storage: { local: CONFIG } })
    const row = { id: 'n1', user: 'x', text: 'hi', time: NOW }
    expect((await sw.send({ type: 'bg_kick_append', channel: 'abc', msgs: [row] }, sender)).added).toBe(1)
    expect((await sw.send({ type: 'bg_kick_append', channel: 'abc', msgs: [row] }, sender)).added).toBe(0)
    expect((await sw.send({ type: 'bg_kick_append', channel: 'abc', msgs: [notice(), notice()] }, sender)).added).toBe(
      1,
    )
    expect((await sw.send({ type: 'bg_kick_append', channel: 'abc', msgs: [notice()] }, sender)).added).toBe(0)
  })

  test('the same 30s throttle as every ring', async () => {
    const sw = await boot({ storage: { local: CONFIG } })
    await sw.send({ type: 'bg_kick_append', channel: 'abc', msgs: [notice({ time: NOW })] }, sender)
    await sw.advance(2000)
    await sw.send(
      { type: 'bg_kick_append', channel: 'abc', msgs: [notice({ systemMsg: 'two', time: NOW + 1 })] },
      sender,
    )
    await sw.advance(10_000)
    expect(sw.idb.snapshot('kick').abc.msgs).toHaveLength(1)
    await sw.advance(25_000)
    expect(sw.idb.snapshot('kick').abc.msgs).toHaveLength(2)
  })

  test('untrusted input: sender checked, channel sanitized, rows and fields capped, unknown fields dropped', async () => {
    const sw = await boot({ storage: { local: CONFIG } })
    const evil = tabSender(9, 'https://evil.example/')
    expect(await sw.send({ type: 'bg_kick_append', channel: 'abc', msgs: [notice()] }, evil)).toEqual({
      ok: false,
      error: 'unauthorized sender',
    })
    for (const channel of ['../x', 'a b', '', 'x'.repeat(41), 7, null]) {
      expect((await sw.send({ type: 'bg_kick_append', channel, msgs: [notice()] }, sender)).added).toBe(0)
    }
    expect((await sw.send({ type: 'bg_kick_append', channel: 'abc', msgs: 'nope' }, sender)).added).toBe(0)
    const many = Array.from({ length: 60 }, (_, i) => notice({ systemMsg: `n${i}`, time: NOW + i }))
    expect((await sw.send({ type: 'bg_kick_append', channel: 'abc', msgs: many }, sender)).added).toBe(20)
    const big = notice({ systemMsg: 'y'.repeat(5000), time: NOW + 999, evil: 'x', replyTo: { a: 'z'.repeat(5000) } })
    await sw.send({ type: 'bg_kick_append', channel: 'abc', msgs: [big, null, 5, { text: '' }] }, sender)
    const row = (await sw.send({ type: 'bg_kick_history', channel: 'abc' }, sender)).msgs.at(-1)
    expect(row.systemMsg).toHaveLength(600)
    expect(row.evil).toBeUndefined()
    expect(row.replyTo).toBeUndefined()
  })

  test('the tab forwards its own rows by message', () => {
    const irc = FILES.find(([n]) => n === 'multichat/irc.js')[1]
    expect(irc).toContain("type: 'bg_kick_append'")
    expect((irc.match(/this\._appendToBg\(msg\)/g) || []).length).toBeGreaterThanOrEqual(5)
  })
})

describe('kick mod marks survive a reload (a deleted or banned message must not come back)', () => {
  const setup = async () => {
    const sw = await boot({ storage: { local: CONFIG } })
    sw.eval(`_kpChannels.set('abc', 5)`)
    for (const n of [1, 2, 3]) {
      sw.eval(`bgKickIngest(${JSON.stringify({ ...kickMsg(n), username: n === 3 ? 'other' : 'bad' })})`)
    }
    return sw
  }
  const tap = (sw, kind, data) =>
    sw.eval(`_kpHandleModEvent(${JSON.stringify({ channel: 'chatrooms.5.v2', data })}, '${kind}')`)
  const reload = async (sw) => {
    await sw.advance(35_000) // the throttled persist lands
    const woken = await sw.restart()
    return (await woken.send({ type: 'bg_kick_history', channel: 'abc' }, sender)).msgs
  }
  const by = (msgs, id) => msgs.find((m) => m.id === id)
  const mark = (sw, over, s = sender) => sw.send({ type: 'bg_kick_mark', channel: 'abc', ...over }, s)

  test('delete: the row comes back cleared "deleted", the others untouched', async () => {
    const sw = await setup()
    tap(sw, 'delete', { message: { id: 'm2' } })
    const msgs = await reload(sw)
    expect(by(msgs, 'm2')).toMatchObject({ cleared: true, clearedReason: 'deleted' })
    expect(by(msgs, 'm1').cleared).toBeUndefined()
  })

  test("ban: that user's rows come back cleared with the label, others not", async () => {
    const sw = await setup()
    tap(sw, 'ban', { user: { username: 'Bad' } })
    const msgs = await reload(sw)
    expect(by(msgs, 'm1').cleared).toBe(true)
    expect(by(msgs, 'm2').cleared).toBe(true)
    expect(by(msgs, 'm1').clearedReason).toBeTruthy()
    expect(by(msgs, 'm3').cleared).toBeUndefined()
  })

  test('unban lifts a ban but never a delete, across the reload', async () => {
    const sw = await setup()
    tap(sw, 'delete', { message: { id: 'm2' } })
    tap(sw, 'ban', { user: { username: 'bad' } })
    tap(sw, 'unban', { user: { username: 'bad' } })
    const msgs = await reload(sw)
    expect(by(msgs, 'm1').cleared).toBeFalsy()
    expect(by(msgs, 'm2')).toMatchObject({ cleared: true, clearedReason: 'deleted' })
  })

  test('a mod event only the tab saw (native tap) is forwarded, validated, and idempotent with the bg one', async () => {
    const sw = await setup()
    expect((await mark(sw, { action: 'delete', targetMsgId: 'm1' })).changed).toBe(1)
    expect((await mark(sw, { action: 'delete', targetMsgId: 'm1' })).changed).toBe(0)
    tap(sw, 'delete', { message: { id: 'm1' } }) // the same event from the bg tap: no double mark
    for (const bad of [
      { channel: '../x', action: 'ban', targetUser: 'bad' },
      { action: 'nuke', targetUser: 'bad' },
      { channel: 7, action: 'ban', targetUser: 'bad' },
    ]) {
      expect((await mark(sw, bad)).changed).toBe(0)
    }
    const evil = tabSender(9, 'https://evil.example/')
    expect(await mark(sw, { action: 'ban', targetUser: 'bad' }, evil)).toEqual({
      ok: false,
      error: 'unauthorized sender',
    })
    await mark(sw, { action: 'timeout', targetUser: 'BAD', banDuration: 60 })
    const msgs = await reload(sw)
    expect(by(msgs, 'm1')).toMatchObject({ cleared: true, clearedReason: 'deleted' })
    expect(by(msgs, 'm2').cleared).toBe(true)
    expect(by(msgs, 'm3').cleared).toBeUndefined()
  })

  test('the native tap hands its mod events to the background', () => {
    const irc = FILES.find(([n]) => n === 'multichat/irc.js')[1]
    expect(irc).toContain("type: 'bg_kick_mark'")
    expect(FILES.find(([n]) => n === 'multichat/kick-native-tap.js')[1]).toContain('{ fromNativeTap: true }')
  })
})

describe('twitch rings: at most one put per channel per 30s, plus the one on release', () => {
  test('a busy channel is not written every 1.5s', async () => {
    const sw = await boot()
    sw.eval(`BG_IRC.channels.set('foo', new BGCircularBuffer(3000))`)
    const push = (n) => {
      sw.eval(`BG_IRC.channels.get('foo').push({ id: 'i${n}', user: 'u', text: 't${n}' })`)
      sw.eval(`bgIrcPersistChannel('foo')`)
    }
    push(1)
    await sw.advance(2000)
    expect(sw.idb.snapshot('rings').foo.msgs).toHaveLength(1)
    for (let n = 2; n < 12; n++) {
      push(n)
      await sw.advance(2000)
    }
    expect(sw.idb.snapshot('rings').foo.msgs).toHaveLength(1) // 20s of traffic, still the first put
    await sw.advance(12_000)
    expect(sw.idb.snapshot('rings').foo.msgs).toHaveLength(11) // the trailing write
  })
})

describe('the saved mentions list', () => {
  test('a tab hands it over and reads it back; storage.local never holds it', async () => {
    const sw = await boot()
    const msgs = [{ id: 'a', user: 'u', text: '@kripp hi', time: NOW }]
    await sw.send({ type: 'bg_mentions_put', msgs, owner: 'kripp' }, sender)
    const got = await sw.send({ type: 'bg_mentions_get' }, tabSender(8, 'https://kick.com/abc'))
    expect(got.owner).toBe('kripp')
    expect(got.msgs.map((m) => m.id)).toEqual(['a'])
    expect(sw.storage.local.snapshot().hs_mentions_v2).toBeUndefined()
  })

  test('the list an older build kept in storage.local is adopted once and dropped', async () => {
    const legacy = { msgs: [{ id: 'z', user: 'u', text: 'old' }], ts: NOW, owner: 'kripp' }
    const sw = await boot({ storage: { local: { hs_mentions_v2: legacy } } })
    const got = await sw.send({ type: 'bg_mentions_get' }, sender)
    expect(got.msgs.map((m) => m.id)).toEqual(['z'])
    expect(sw.storage.local.snapshot().hs_mentions_v2).toBeUndefined()
    expect((await sw.send({ type: 'bg_mentions_get' }, sender)).msgs).toHaveLength(1) // now from IndexedDB
  })
})

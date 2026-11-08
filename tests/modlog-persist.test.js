import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createModLogStore,
  formatDuration,
  MOD_LOG_KEY,
  MOD_LOG_PER_CHANNEL,
  mergeModLogs,
  modLogBy,
  modLogEntryFromNotice,
  modLogLine,
  pushModLogEntry,
  sanitizeStoredModLog,
} from '../src/multichat/mod-log.js'
import { t } from './en-t.js'

/**
 * The mod log used to be an in-memory array: a reload emptied it, and a hard-coded
 * english line said what each row meant. It now survives a reload (chrome.storage.local,
 * newest 500 per channel), records the acting mod when the page knows, and every string
 * it says is in the catalog. The store runs for real against a fake storage area and
 * fake timers; nothing here reads source text to prove behaviour.
 */
const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')

const notice = (o = {}) => ({
  type: 'notice',
  noticeType: 'ban_success',
  targetUser: 'Bob',
  channel: 'chanA',
  banDuration: 0,
  systemMsg: 'x',
  time: 1000,
  id: 'n1',
  platform: 'twitch',
  ...o,
})

/** a chrome.storage.local that remembers, and can be told to fail */
function fakeStorage(initial = {}) {
  const data = { ...initial }
  const area = {
    data,
    fail: false,
    writes: 0,
    async get(key) {
      if (area.fail) throw new Error('storage gone')
      return key in data ? { [key]: structuredClone(data[key]) } : {}
    },
    async set(obj) {
      if (area.fail) throw new Error('storage gone')
      area.writes++
      for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v)
    },
  }
  return area
}

/** timers you advance by hand */
function fakeTimers() {
  const pending = new Map()
  let n = 0
  return {
    setTimer: (fn) => {
      pending.set(++n, fn)
      return n
    },
    clearTimer: (id) => pending.delete(id),
    fireAll: () => {
      for (const [id, fn] of [...pending]) {
        pending.delete(id)
        fn()
      }
    },
    count: () => pending.size,
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

function makeStore(area, log = [], opts = {}) {
  const timers = fakeTimers()
  const store = createModLogStore({ log, storage: () => area, ...timers, ...opts })
  return { store, log, timers }
}

describe('the acting mod is recorded when the page knows', () => {
  test('a notice with an actor keeps it, lowercased', () => {
    expect(modLogEntryFromNotice(notice({ actor: 'ModAlice' })).actor).toBe('modalice')
  })

  test('twitch and kick echoes never say who — the entry says so honestly, not with a guess', () => {
    expect(modLogEntryFromNotice(notice()).actor).toBe('')
  })

  test('the row line names the actor, and is empty when unknown', () => {
    expect(modLogBy({ actor: 'modalice' }, t)).toBe('by modalice')
    expect(modLogBy({ actor: '' }, t)).toBe('')
    expect(modLogBy(null, t)).toBe('')
  })

  test('mod-toolbar stamps the actor on both synthetic notices', () => {
    const src = read('src', 'multichat', 'mod-toolbar.js')
    expect(src.match(/actor: _modActor\(\),/g)?.length).toBe(2)
  })
})

describe('capped per channel, oldest first out', () => {
  test('one busy channel never pushes another channel out', () => {
    const log = []
    for (let i = 0; i < 8; i++) pushModLogEntry(log, modLogEntryFromNotice(notice({ id: `a${i}`, time: i })), 5)
    pushModLogEntry(log, modLogEntryFromNotice(notice({ id: 'b0', channel: 'chanB', time: 100 })), 5)
    for (let i = 8; i < 14; i++) pushModLogEntry(log, modLogEntryFromNotice(notice({ id: `a${i}`, time: i })), 5)
    const a = log.filter((e) => e.channel === 'chana').map((e) => e.id)
    expect(a).toEqual(['a9', 'a10', 'a11', 'a12', 'a13'])
    expect(log.filter((e) => e.channel === 'chanb').map((e) => e.id)).toEqual(['b0'])
  })

  test('the same login on twitch and on kick is two channels', () => {
    const log = []
    for (let i = 0; i < 4; i++) pushModLogEntry(log, modLogEntryFromNotice(notice({ id: `t${i}`, time: i })), 3)
    for (let i = 0; i < 4; i++) {
      pushModLogEntry(log, modLogEntryFromNotice(notice({ id: `k${i}`, time: i, platform: 'kick' })), 3)
    }
    expect(log.filter((e) => e.platform === 'twitch').length).toBe(3)
    expect(log.filter((e) => e.platform === 'kick').length).toBe(3)
  })

  test('the default cap is 500', () => {
    expect(MOD_LOG_PER_CHANNEL).toBe(500)
    const log = []
    for (let i = 0; i < 520; i++) pushModLogEntry(log, modLogEntryFromNotice(notice({ id: `e${i}`, time: i })))
    expect(log.length).toBe(500)
    expect(log[0].id).toBe('e20')
    expect(log[499].id).toBe('e519')
  })

  test('mergeModLogs: union by id, oldest first, capped per channel', () => {
    const e = (id, time, channel = 'chana') => modLogEntryFromNotice(notice({ id, time, channel }))
    const out = mergeModLogs([e('a', 1), e('b', 2)], [e('b', 2), e('c', 3), e('x', 4, 'chanx')], 2)
    expect(out.map((x) => x.id)).toEqual(['b', 'c', 'x'])
  })
})

describe('what storage hands back is never trusted', () => {
  test('junk entries are dropped, good ones come back clean', () => {
    const good = { id: 'g', action: 'ban', target: 'bob', channel: 'c', platform: 'kick', time: 5, durationSec: 0 }
    const out = sanitizeStoredModLog({
      entries: [good, null, 7, 'x', {}, { id: '', action: 'ban' }, { id: 'z', action: 'explode' }, { id: 'n' }],
    })
    expect(out.length).toBe(1)
    expect(out[0]).toMatchObject({ id: 'g', action: 'ban', target: 'bob', platform: 'kick', actor: '' })
  })

  test('not an object, not a list, undefined: an empty log, never a throw', () => {
    for (const raw of [undefined, null, 'x', 5, {}, { entries: 'no' }, { entries: {} }]) {
      expect(sanitizeStoredModLog(raw)).toEqual([])
    }
  })

  test('absurd field values are clamped', () => {
    const [e] = sanitizeStoredModLog({
      entries: [{ id: 'g', action: 'timeout', target: 'x'.repeat(500), durationSec: -4, time: 'soon' }],
    })
    expect(e.target.length).toBe(64)
    expect(e.durationSec).toBe(0)
    expect(e.time).toBe(0)
  })
})

describe('the store', () => {
  test('a mod notice is kept in memory at once and written once the debounce fires', async () => {
    const area = fakeStorage()
    const { store, log, timers } = makeStore(area)
    expect(store.record(notice({ id: 'a', actor: 'mod1' }))).not.toBeNull()
    expect(log.length).toBe(1)
    expect(area.writes).toBe(0)
    timers.fireAll()
    await settle()
    expect(area.writes).toBe(1)
    expect(area.data[MOD_LOG_KEY].entries[0]).toMatchObject({ id: 'a', actor: 'mod1', target: 'bob' })
  })

  test('a burst is ONE write, not one per entry', async () => {
    const area = fakeStorage()
    const { store, timers } = makeStore(area)
    for (let i = 0; i < 20; i++) store.record(notice({ id: `e${i}`, time: i }))
    expect(timers.count()).toBe(1)
    timers.fireAll()
    await settle()
    expect(area.writes).toBe(1)
    expect(area.data[MOD_LOG_KEY].entries.length).toBe(20)
  })

  test('a notice that is not a mod action, or one already logged, writes nothing', async () => {
    const area = fakeStorage()
    const { store, timers } = makeStore(area)
    expect(store.record(notice({ noticeType: 'sub' }))).toBeNull()
    expect(store.record({ type: 'privmsg' })).toBeNull()
    expect(timers.count()).toBe(0)
    store.record(notice({ id: 'a' }))
    timers.fireAll()
    await settle()
    expect(store.record(notice({ id: 'a' }))).toBeNull()
    expect(timers.count()).toBe(0)
  })

  test('a reload: what the last session kept comes back, and merges with what is already here', async () => {
    const area = fakeStorage({
      [MOD_LOG_KEY]: { entries: [{ id: 'old1', action: 'ban', target: 'a', channel: 'c', time: 1 }], ts: 1 },
    })
    const { store, log } = makeStore(area)
    store.record(notice({ id: 'fresh', time: 9, channel: 'c' })) // landed before the load finished
    await store.load()
    expect(log.map((e) => e.id)).toEqual(['old1', 'fresh'])
  })

  test('two tabs: each write carries the other tab’s entries along, none is lost', async () => {
    const area = fakeStorage()
    const tabA = makeStore(area)
    const tabB = makeStore(area)
    tabA.store.record(notice({ id: 'fromA', time: 1, channel: 'chana' }))
    tabB.store.record(notice({ id: 'fromB', time: 2, channel: 'chanb' }))
    tabA.timers.fireAll()
    await settle()
    tabB.timers.fireAll()
    await settle()
    expect(area.data[MOD_LOG_KEY].entries.map((e) => e.id).sort()).toEqual(['fromA', 'fromB'])
    // and the second writer now holds both in memory too
    expect(tabB.log.map((e) => e.id).sort()).toEqual(['fromA', 'fromB'])
  })

  test('absorb merges what another tab just wrote, so tab-close writes both sides', async () => {
    const area = fakeStorage()
    const { store, log } = makeStore(area)
    store.record(notice({ id: 'mine', time: 1 }))
    store.absorb({ entries: [{ id: 'theirs', action: 'ban', target: 'z', channel: 'c', time: 2 }] })
    expect(log.map((e) => e.id)).toEqual(['mine', 'theirs'])
    store.absorb('garbage')
    expect(log.length).toBe(2)
  })

  test('the stored copy is capped per channel too', async () => {
    const area = fakeStorage()
    const { store, log, timers } = makeStore(area, [], { max: 3 })
    for (let i = 0; i < 6; i++) store.record(notice({ id: `e${i}`, time: i }))
    timers.fireAll()
    await settle()
    expect(area.data[MOD_LOG_KEY].entries.map((e) => e.id)).toEqual(['e3', 'e4', 'e5'])
    expect(log.length).toBe(3)
  })

  test('pagehide: flush writes now and cancels the pending timer', async () => {
    const area = fakeStorage()
    const { store, timers } = makeStore(area)
    store.record(notice({ id: 'a' }))
    store.flush()
    await settle()
    expect(area.writes).toBe(1)
    expect(timers.count()).toBe(0)
  })

  test('storage gone (context invalidated, quota): nothing throws, the log stays in memory', async () => {
    const area = fakeStorage()
    area.fail = true
    const { store, log, timers } = makeStore(area)
    expect(() => store.record(notice({ id: 'a' }))).not.toThrow()
    timers.fireAll()
    await settle()
    await store.load()
    expect(log.length).toBe(1)
    const none = makeStore(null)
    none.store.record(notice({ id: 'b' }))
    none.timers.fireAll()
    await settle()
    await none.store.load()
    expect(none.log.length).toBe(1)
  })

  test('a failed write does not wedge the queue: the next one goes through', async () => {
    const area = fakeStorage()
    const { store, timers } = makeStore(area)
    area.fail = true
    store.record(notice({ id: 'a', time: 1 }))
    timers.fireAll()
    await settle()
    area.fail = false
    store.record(notice({ id: 'b', time: 2 }))
    timers.fireAll()
    await settle()
    expect(area.data[MOD_LOG_KEY].entries.map((e) => e.id)).toEqual(['a', 'b'])
  })
})

describe('private to this device', () => {
  test('the settings export and import skip it', () => {
    const src = read('src', 'multichat', 'settings-ui.js')
    const re = new RegExp(/var _SETTINGS_PRIVATE_KEY_RE = \/(.+)\/$/m.exec(src)[1])
    expect(re.test(MOD_LOG_KEY)).toBe(true)
  })

  test('it is a local key, never the synced one', () => {
    const src = read('src', 'multichat', 'main-state.js')
    expect(src).toContain('chrome.storage.local')
    expect(read('src', 'multichat', 'mod-log.js')).not.toContain('storage.sync')
  })
})

describe('every string the log says is in the catalog', () => {
  // a translator that returns the KEY: whatever comes out is made of keys, so any
  // english still hard-coded in mod-log.js would show up as a word that is not one
  const key = (k, subs = []) => `<${k}${subs.length ? `:${subs.join(',')}` : ''}>`

  test('every line, and every duration unit, is built from keys alone', () => {
    const lines = [
      { action: 'ban', target: 'bob' },
      { action: 'timeout', target: 'bob', durationSec: 30 },
      { action: 'timeout', target: 'bob', durationSec: 600 },
      { action: 'timeout', target: 'bob', durationSec: 7200 },
      { action: 'timeout', target: 'bob', durationSec: 172800 },
      { action: 'timeout', target: 'bob' },
      { action: 'unban', target: 'bob' },
      { action: 'untimeout', target: 'bob' },
      { action: 'delete', target: 'bob' },
      { action: 'delete', target: '' },
      { action: 'ban', target: '' },
    ]
    // a duration nests one key inside another's args, so peel keys innermost-first
    const peel = (s) => {
      for (let prev = ''; prev !== s; ) {
        prev = s
        s = s.replace(/<[a-z_]+(?::[^<>]*)?>/g, '')
      }
      return s
    }
    for (const e of lines) {
      const out = modLogLine(e, key)
      expect(peel(out).replace(/[ ()]/g, ''), JSON.stringify(e)).toBe('')
    }
    expect(formatDuration(30, key)).toBe('<mc_modlog_dur_s:30>')
    expect(formatDuration(600, key)).toBe('<mc_modlog_dur_m:10>')
    expect(formatDuration(7200, key)).toBe('<mc_modlog_dur_h:2>')
    expect(formatDuration(172800, key)).toBe('<mc_modlog_dur_d:2>')
    expect(modLogBy({ actor: 'm' }, key)).toBe('<mc_modlog_by:m>')
  })

  test('every key it uses exists in all 34 catalogs', () => {
    const used = [...new Set(read('src', 'multichat', 'mod-log.js').match(/mc_modlog_[a-z_]+/g))]
    expect(used.length).toBeGreaterThan(10)
    const dirs = readdirSync(join(ROOT, 'src', '_locales'))
    expect(dirs.length).toBe(34)
    for (const d of dirs) {
      const cat = JSON.parse(read('src', '_locales', d, 'messages.json'))
      for (const k of used) expect(cat[k]?.message, `${d}.${k}`).toBeTruthy()
    }
  })

  test('the ban confirmation dialog asks in the catalog’s words, with the catalog’s button', async () => {
    const src = read('src', 'multichat', 'mod-toolbar.js')
    const start = src.indexOf('async function dispatchModAction(')
    // brace-match the function out of the shared-scope source
    let depth = 0
    let end = -1
    for (let i = src.indexOf('{', src.indexOf(') {', start)); i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) {
        end = i + 1
        break
      }
    }
    const fn = src.slice(start, end)
    const asked = []
    const run = new Function('t', 'hsConfirm', 'modConfirmBan', 'modBanReasons', `${fn}; return dispatchModAction`)(
      t,
      async (...a) => {
        asked.push(a)
        return { ok: false, reason: '' }
      },
      true,
      'spam\nraid',
    )
    const res = await run({ channel: '#chanA', platform: 'twitch', action: 'ban', target: '@Bob' })
    expect(res.cancelled).toBe(true)
    expect(asked).toEqual([['ban Bob in #chanA?', 'ban', ['spam', 'raid']]])
    // and it does so through the catalog: no english sentence left in the call
    expect(fn).not.toMatch(/hsConfirm\(\s*`ban /)
    expect(fn).toContain("t('mc_modtoolbar_ban_confirm'")
  })
})

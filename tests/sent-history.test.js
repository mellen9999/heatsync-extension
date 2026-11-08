/**
 * Up/Down recall of sent messages survives a reload (sent-history.js).
 *
 * The module is the real file, imported fresh per "tab" against a fake
 * chrome.storage that behaves like the browser's: async get/set/remove, and an
 * onChanged that fires in every tab that is listening. Two imports of the same
 * file are two tabs sharing one disk, which is exactly the cross-tab case.
 *
 * What is pinned: it persists, it comes back after a reload, it never blocks
 * boot, it never overwrites the stored list with a shorter one, "off" really
 * means off (nothing written, stale copy wiped), and nothing ever touches the
 * synced area, the one place another device could read what you typed.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS } from '../src/lib/settings-schema.js'

const ROOT = join(import.meta.dir, '..')
const MODULE = join(ROOT, 'src', 'multichat', 'sent-history.js')
const KEY = 'hs_sent_history'
const REMEMBER = 'hs_remember_sent'

let disk
let listeners
let syncTouched
let deferGet // when set, get() resolves only when released
let releaseGet
let n = 0

const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

function installBrowser() {
  disk = {}
  listeners = []
  syncTouched = false
  deferGet = false
  releaseGet = null
  const fire = (changes) => {
    for (const fn of listeners) fn(changes, 'local')
  }
  const area = {
    async get(keys) {
      if (deferGet) await new Promise((r) => (releaseGet = r))
      const list = Array.isArray(keys) ? keys : [keys]
      const out = {}
      for (const k of list) if (k in disk) out[k] = structuredClone(disk[k])
      return out
    },
    async set(obj) {
      const changes = {}
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: disk[k], newValue: structuredClone(v) }
        disk[k] = structuredClone(v)
      }
      fire(changes)
    },
    async remove(key) {
      if (!(key in disk)) return
      const oldValue = disk[key]
      delete disk[key]
      fire({ [key]: { oldValue } })
    },
  }
  const sync = new Proxy(
    {},
    {
      get() {
        syncTouched = true
        throw new Error('sent history must never touch chrome.storage.sync')
      },
    },
  )
  globalThis.browser = { storage: { local: area, sync } }
  globalThis.chrome = {
    storage: {
      local: area,
      sync,
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
  }
  globalThis.cleanup = { addListener: (target, fn) => target.addListener(fn) }
}

/** A fresh tab: the real module, evaluated again against the shared disk. */
async function openTab() {
  const mod = await import(`${MODULE}?tab${++n}`)
  await mod.mcSentHistoryReady
  return mod
}

/** Press Up/Down the way the composer does, return what the box would show. */
const up = (mod, current = '') => mod.hsSentHistoryStep(1, current)
const down = (mod, current = '') => mod.hsSentHistoryStep(-1, current)

beforeEach(installBrowser)

describe('recall within a session (unchanged behaviour)', () => {
  test('Up walks back newest first, Down walks forward and ends on the draft', async () => {
    const tab = await openTab()
    for (const m of ['one', 'two', 'three']) tab.hsSentHistoryRecord(m)
    expect(up(tab)).toBe('three')
    expect(up(tab, 'three')).toBe('two')
    expect(up(tab, 'two')).toBe('one')
    expect(up(tab, 'one')).toBe('one') // top of the list stays put
    expect(down(tab, 'one')).toBe('two')
    expect(down(tab, 'two')).toBe('three')
    expect(down(tab, 'three')).toBe('') // back to the (empty) draft
  })

  test('a half-typed draft comes back after walking the list', async () => {
    const tab = await openTab()
    tab.hsSentHistoryRecord('old line')
    // Up on a non-empty composer that is not a sent line is a caret key, not recall
    expect(up(tab, 'half typed')).toBeNull()
    expect(up(tab, '')).toBe('old line')
    expect(down(tab, 'old line')).toBe('')
  })

  test('the same line twice in a row is one entry', async () => {
    const tab = await openTab()
    tab.hsSentHistoryRecord('gg')
    tab.hsSentHistoryRecord('gg')
    tab.hsSentHistoryRecord('wp')
    tab.hsSentHistoryRecord('gg')
    expect([...tab.mcMessageHistory]).toEqual(['gg', 'wp', 'gg'])
  })

  test('capped at 50, newest kept', async () => {
    const tab = await openTab()
    for (let i = 0; i < 60; i++) tab.hsSentHistoryRecord(`m${i}`)
    expect(tab.mcMessageHistory.length).toBe(50)
    expect(tab.mcMessageHistory[0]).toBe('m59')
    expect(tab.mcMessageHistory[49]).toBe('m10')
  })

  test('nothing sent yet: the keys are not ours', async () => {
    const tab = await openTab()
    expect(up(tab)).toBeNull()
    expect(down(tab)).toBeNull()
  })
})

describe('survives a reload', () => {
  test('what one page sent, the next page recalls', async () => {
    const first = await openTab()
    first.hsSentHistoryRecord('see you tomorrow')
    first.hsSentHistoryRecord('gn chat')
    await tick()
    expect(disk[KEY]).toEqual(['gn chat', 'see you tomorrow'])

    const reloaded = await openTab()
    expect(up(reloaded)).toBe('gn chat')
    expect(up(reloaded, 'gn chat')).toBe('see you tomorrow')
  })

  test('boot never waits on storage: the module is usable while the read is in flight', async () => {
    disk[KEY] = ['stored']
    deferGet = true
    const mod = await import(`${MODULE}?tab${++n}`) // returns without the read landing
    expect(up(mod)).toBeNull() // nothing yet, and nothing threw
    mod.hsSentHistoryRecord('typed during boot')
    releaseGet()
    await mod.mcSentHistoryReady
    // merged AHEAD of the stored ones, not clobbering them
    expect([...mod.mcMessageHistory]).toEqual(['typed during boot', 'stored'])
  })

  test('a send during the read never overwrites the stored list with a shorter one', async () => {
    disk[KEY] = ['a', 'b', 'c']
    deferGet = true
    const mod = await import(`${MODULE}?tab${++n}`)
    mod.hsSentHistoryRecord('fresh')
    await tick()
    expect(disk[KEY]).toEqual(['a', 'b', 'c']) // the save is parked behind the merge
    releaseGet()
    await mod.mcSentHistoryReady
    await tick()
    expect(disk[KEY]).toEqual(['fresh', 'a', 'b', 'c'])
  })

  test('junk in storage is dropped, not recalled', async () => {
    disk[KEY] = ['ok', 7, null, '', { x: 1 }, 'ok', 'ok2', 'x'.repeat(900)]
    const tab = await openTab()
    expect(tab.mcMessageHistory.length).toBe(3)
    expect(tab.mcMessageHistory.slice(0, 2)).toEqual(['ok', 'ok2'])
    expect(tab.mcMessageHistory[2].length).toBe(500)
  })

  test('a non-array in storage is ignored', async () => {
    disk[KEY] = 'not a list'
    const tab = await openTab()
    expect(tab.mcMessageHistory.length).toBe(0)
  })
})

describe('remember sent messages', () => {
  test('off at boot: nothing restored, the stale copy is wiped', async () => {
    disk[KEY] = ['secret']
    disk[REMEMBER] = false
    const tab = await openTab()
    await tick()
    expect(tab.mcMessageHistory.length).toBe(0)
    expect(KEY in disk).toBe(false)
  })

  test('off: this session still recalls, but nothing reaches the disk', async () => {
    disk[REMEMBER] = false
    const tab = await openTab()
    tab.hsSentHistoryRecord('private')
    await tick()
    expect(KEY in disk).toBe(false)
    expect(up(tab)).toBe('private')
  })

  test('switching it off wipes what was stored, and stops saving', async () => {
    const tab = await openTab()
    tab.hsSentHistoryRecord('kept for now')
    await tick()
    expect(disk[KEY]).toEqual(['kept for now'])

    await browser.storage.local.set({ [REMEMBER]: false }) // the settings pill
    await tick()
    expect(KEY in disk).toBe(false)

    tab.hsSentHistoryRecord('after off')
    await tick()
    expect(KEY in disk).toBe(false)
  })

  test('switching it back on starts a fresh list: the disk only holds lines sent while on', async () => {
    const tab = await openTab()
    tab.hsSentHistoryRecord('while on')
    await browser.storage.local.set({ [REMEMBER]: false })
    tab.hsSentHistoryRecord('while off')
    await browser.storage.local.set({ [REMEMBER]: true })
    await tick()
    expect(tab.mcMessageHistory.length).toBe(0)

    tab.hsSentHistoryRecord('on again')
    await tick()
    expect(disk[KEY]).toEqual(['on again'])
  })

  test('the registry row exists, is on by default, and is per-device', () => {
    const def = SETTINGS.find((d) => d.key === REMEMBER)
    expect(def).toBeTruthy()
    expect(def.type).toBe('bool')
    expect(def.default).toBe(true)
    expect(def.scope).toBe('local')
    expect(def.category).toBe('chat')
  })
})

describe('clear sent history', () => {
  test('gone from memory and from disk, and Up has nothing to recall', async () => {
    const tab = await openTab()
    tab.hsSentHistoryRecord('one')
    tab.hsSentHistoryRecord('two')
    await tick()
    expect(disk[KEY]).toEqual(['two', 'one'])

    await tab.hsSentHistoryClear()
    await tick()
    expect(KEY in disk).toBe(false)
    expect(tab.mcMessageHistory.length).toBe(0)
    expect(up(tab)).toBeNull()
  })

  test('works with remembering off too', async () => {
    disk[REMEMBER] = false
    const tab = await openTab()
    tab.hsSentHistoryRecord('local only')
    await tab.hsSentHistoryClear()
    expect(tab.mcMessageHistory.length).toBe(0)
  })

  test('a clear in one tab empties the others', async () => {
    const a = await openTab()
    const b = await openTab()
    a.hsSentHistoryRecord('shared')
    await tick()
    expect([...b.mcMessageHistory]).toEqual(['shared'])
    await a.hsSentHistoryClear()
    await tick()
    expect(b.mcMessageHistory.length).toBe(0)
  })
})

describe('two tabs on one device', () => {
  test('a send in one is recallable in the other', async () => {
    const a = await openTab()
    const b = await openTab()
    a.hsSentHistoryRecord('from a')
    await tick()
    b.hsSentHistoryRecord('from b')
    await tick()
    expect(disk[KEY]).toEqual(['from b', 'from a'])
    expect([...a.mcMessageHistory]).toEqual(['from b', 'from a'])
  })

  test('a tab mid-recall is not shuffled underneath the person pressing Up', async () => {
    const a = await openTab()
    const b = await openTab()
    a.hsSentHistoryRecord('x1')
    a.hsSentHistoryRecord('x2')
    await tick()
    expect(up(a)).toBe('x2') // a is now mid-recall
    b.hsSentHistoryRecord('from b')
    await tick()
    expect(up(a, 'x2')).toBe('x1') // still walking the list it started with
  })
})

describe('local only', () => {
  test('nothing in the whole lifecycle touches chrome.storage.sync', async () => {
    const tab = await openTab()
    tab.hsSentHistoryRecord('hello')
    await browser.storage.local.set({ [REMEMBER]: false })
    await browser.storage.local.set({ [REMEMBER]: true })
    await tab.hsSentHistoryClear()
    await tick()
    expect(syncTouched).toBe(false)
  })

  test('the settings export and import skip it', () => {
    const src = readFileSync(join(ROOT, 'src', 'multichat', 'settings-ui.js'), 'utf8')
    const line = src.match(/var _SETTINGS_PRIVATE_KEY_RE = (\/.+\/)$/m)
    expect(line, 'settings-ui no longer declares _SETTINGS_PRIVATE_KEY_RE').toBeTruthy()
    const re = new Function(`return ${line[1]}`)()
    expect(re.test(KEY)).toBe(true) // what you typed never rides an export
    expect(re.test(REMEMBER)).toBe(false) // the preference itself may
  })
})

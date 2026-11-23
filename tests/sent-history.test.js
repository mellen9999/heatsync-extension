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
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS } from '../src/lib/settings-schema.js'

// installBrowser() puts a chrome, a browser and a cleanup on globalThis for every test. Whatever was
// there before this file goes back when it is done: bun runs every file in one process, and a stub left
// behind reaches the next file's modules at load.
const _before = { chrome: globalThis.chrome, browser: globalThis.browser, cleanup: globalThis.cleanup }
afterAll(() => {
  for (const [k, v] of Object.entries(_before)) {
    if (v === undefined) delete globalThis[k]
    else globalThis[k] = v
  }
})

const ROOT = join(import.meta.dir, '..')
const MODULE = join(ROOT, 'src', 'multichat', 'sent-history.js')
const KEY = 'hs_sent_history'
const PICKS = 'hs_sent_history_picks'
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
      // like the browser: onChanged names only the keys whose value really changed
      const changes = {}
      for (const [k, v] of Object.entries(obj)) {
        if (JSON.stringify(disk[k]) !== JSON.stringify(v))
          changes[k] = { oldValue: disk[k], newValue: structuredClone(v) }
        disk[k] = structuredClone(v)
      }
      if (Object.keys(changes).length) fire(changes)
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

describe('a line comes back with the copies chosen in it', () => {
  const ref = (name, id) => ({ name, url: `https://cdn.7tv.app/emote/${id}/2x.webp`, provider: '7tv', id })
  // lawShip's `chosen`: [name, ref] rows, a catalog pick and a pin alike
  const chosen = (...rows) => rows

  test('a pick comes back with its line, after a reload too, as a draft of its own', async () => {
    const a = await openTab()
    const mine = ref('KEKW', 'MINE')
    a.hsSentHistoryRecord('KEKW hi', chosen(['KEKW', mine]))
    await tick()
    for (const tab of [a, await openTab()]) {
      const back = tab.hsSentHistoryPicks('KEKW hi')
      expect([...back.picked]).toEqual([['KEKW', mine]])
      expect(back.remote.size + back.away.size).toBe(0)
      // each recall is a fresh draft: editing one never changes what the next recall brings
      back.picked.clear()
      expect(tab.hsSentHistoryPicks('KEKW hi').picked.size).toBe(1)
    }
  })

  test('a catalog pick (in no set of yours) comes back too; a line with no pick has none', async () => {
    const a = await openTab()
    const far = ref('LICK', 'FAR')
    a.hsSentHistoryRecord('LICK', chosen(['LICK', far]))
    a.hsSentHistoryRecord('plain words')
    a.hsSentHistoryRecord('nothing chosen', chosen())
    await tick()
    const b = await openTab()
    expect([...b.hsSentHistoryPicks('LICK').picked]).toEqual([['LICK', far]])
    expect(b.hsSentHistoryPicks('plain words')).toBeNull()
    expect(b.hsSentHistoryPicks('nothing chosen')).toBeNull()
    expect(b.hsSentHistoryPicks('never sent')).toBeNull()
  })

  test('the newest send of a line is the one that comes back: sent again by hand, it has no pick', async () => {
    const a = await openTab()
    a.hsSentHistoryRecord('KEKW', chosen(['KEKW', ref('KEKW', 'MINE')]))
    a.hsSentHistoryRecord('between')
    a.hsSentHistoryRecord('KEKW', chosen(['KEKW', ref('KEKW', 'OTHER')]))
    expect(a.hsSentHistoryPicks('KEKW').picked.get('KEKW').id).toBe('OTHER')
    a.hsSentHistoryRecord('between 2')
    a.hsSentHistoryRecord('KEKW')
    expect(a.hsSentHistoryPicks('KEKW')).toBeNull()
    await tick()
    expect((await openTab()).hsSentHistoryPicks('KEKW')).toBeNull()
  })

  // the browser's change event names only the keys that changed. A send with no pick leaves the
  // stored picks as they were, so the event carries the list alone: read as "the picks are gone",
  // every earlier line lost its pick on the next send (found by the real-browser run)
  test('a later send with no pick of its own leaves an earlier line its pick', async () => {
    const a = await openTab()
    const b = await openTab()
    a.hsSentHistoryRecord('KEKW', chosen(['KEKW', ref('KEKW', 'MINE')]))
    await tick()
    a.hsSentHistoryRecord('plain words')
    await tick()
    for (const tab of [a, b]) expect(tab.hsSentHistoryPicks('KEKW').picked.get('KEKW').id).toBe('MINE')
    // the same last line sent again with another copy: the list is unchanged, the picks alone move
    a.hsSentHistoryRecord('plain words', chosen(['plain', ref('plain', 'P')]))
    await tick()
    for (const tab of [a, b]) expect(tab.hsSentHistoryPicks('plain words').picked.has('plain')).toBe(true)
  })

  test('a line that falls off the list takes its picks with it', async () => {
    const a = await openTab()
    a.hsSentHistoryRecord('KEKW old', chosen(['KEKW', ref('KEKW', 'MINE')]))
    for (let i = 0; i < 50; i++) a.hsSentHistoryRecord(`m${i}`)
    expect(a.mcMessageHistory).not.toContain('KEKW old')
    expect(a.hsSentHistoryPicks('KEKW old')).toBeNull()
    await tick()
    expect(disk[PICKS]).toEqual([])
  })

  test('a line sent while the stored list was still being read keeps its own answer', async () => {
    const a = await openTab()
    a.hsSentHistoryRecord('KEKW', chosen(['KEKW', ref('KEKW', 'OLD')]))
    a.hsSentHistoryRecord('LUL', chosen(['LUL', ref('LUL', 'L')]))
    await tick()
    deferGet = true
    const mod = await import(`${MODULE}?tab${++n}`)
    mod.hsSentHistoryRecord('KEKW') // by hand, before the read lands: no pick
    deferGet = false
    releaseGet()
    await mod.mcSentHistoryReady
    expect(mod.hsSentHistoryPicks('KEKW')).toBeNull()
    expect(mod.hsSentHistoryPicks('LUL').picked.has('LUL')).toBe(true)
  })

  test('"remember sent" off: this page only, nothing on disk; clear wipes both', async () => {
    const a = await openTab()
    a.hsSentHistoryRecord('KEKW', chosen(['KEKW', ref('KEKW', 'MINE')]))
    await tick()
    expect(disk[PICKS].length).toBe(1)
    await browser.storage.local.set({ [REMEMBER]: false })
    await tick()
    expect(PICKS in disk).toBe(false)
    a.hsSentHistoryRecord('KEKW now', chosen(['KEKW', ref('KEKW', 'MINE')]))
    await tick()
    expect(a.hsSentHistoryPicks('KEKW now').picked.size).toBe(1)
    expect(PICKS in disk).toBe(false)
    await browser.storage.local.set({ [REMEMBER]: true })
    await tick()
    expect(a.hsSentHistoryPicks('KEKW now')).toBeNull()
    a.hsSentHistoryRecord('KEKW', chosen(['KEKW', ref('KEKW', 'MINE')]))
    await tick()
    await a.hsSentHistoryClear()
    expect(a.hsSentHistoryPicks('KEKW')).toBeNull()
    expect(PICKS in disk).toBe(false)
  })

  test('a send in one tab is recalled with its pick in the other; a clear empties both', async () => {
    const a = await openTab()
    const b = await openTab()
    a.hsSentHistoryRecord('KEKW', chosen(['KEKW', ref('KEKW', 'MINE')]))
    await tick()
    expect(b.hsSentHistoryPicks('KEKW').picked.get('KEKW').id).toBe('MINE')
    await a.hsSentHistoryClear()
    await tick()
    expect(b.hsSentHistoryPicks('KEKW')).toBeNull()
  })

  test('whatever storage hands back is made safe', async () => {
    const ok = ref('KEKW', 'MINE')
    disk[KEY] = ['KEKW a b c', 'junk']
    disk[PICKS] = [
      [
        'KEKW a b c',
        [
          ['KEKW', ok],
          ['a', { name: 'a', url: 'javascript:alert(1)' }],
          ['b', { name: 'other', url: ok.url }],
          ['c'],
          5,
          null,
        ],
        'nope',
      ],
      ['junk', [['x', { name: 'x', url: 'http://plain.example/x.png' }]]],
      ['not on the list', [['KEKW', ok]]],
      'text',
      null,
      [5, [['KEKW', ok]]],
    ]
    const a = await openTab()
    expect([...a.hsSentHistoryPicks('KEKW a b c').picked]).toEqual([['KEKW', ok]])
    expect(a.hsSentHistoryPicks('junk')).toBeNull()
    expect(a.hsSentHistoryPicks('not on the list')).toBeNull()
    for (const bad of ['{not json', {}, 7, null]) {
      disk[PICKS] = bad
      expect((await openTab()).hsSentHistoryPicks('KEKW a b c')).toBeNull()
    }
  })

  test("the box takes the line's picks before the line is drawn, and a send hands them over", () => {
    const input = readFileSync(join(ROOT, 'src', 'multichat', 'input.js'), 'utf8')
    expect(input).toMatch(
      /endComposerPicks\(input\)\n\s*resumeDraftPicks\(hsSentHistoryPicks\(text\), input\)\n\s*if \(wysiwygEnabled\) restoreWysiwygText\(input, text\)/,
    )
    expect(input).toContain('hsSentHistoryRecord(text, shipped.chosen)')
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
    expect(re.test(PICKS)).toBe(true) // nor the emotes you picked in it
    expect(re.test(REMEMBER)).toBe(false) // the preference itself may
  })
})

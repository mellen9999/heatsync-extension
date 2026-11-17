/**
 * Cross-tab channel reconciliation in saveConfig — extracted by marker slice
 * from src/multichat/main.js so the test fails loudly if the logic moves.
 */
import { describe, expect, test } from 'bun:test'
import { mcMergeLegs } from '../src/multichat/seed-legs.js'
import { mainSource } from './main-src.js'

const SRC = mainSource()

function slice(startMarker, endMarker) {
  const s = SRC.indexOf(startMarker)
  if (s === -1) throw new Error(`start marker not found: ${startMarker}`)
  const e = SRC.indexOf(endMarker, s)
  if (e === -1) throw new Error(`end marker not found: ${endMarker}`)
  return SRC.slice(s, e)
}

// The union block, lifted verbatim and wrapped in a harness.
const UNION = slice('const stored = (await browser.storage.local.get(STORAGE_KEY))', '\n    } catch {}')

function run({ mine, theirs, lastPersisted }) {
  const persistable = { channels: [...mine] }
  const browser = { storage: { local: { get: async () => ({ cfg: { channels: theirs } }) } } }
  const fn = new Function(
    'persistable',
    'browser',
    'STORAGE_KEY',
    '_lastPersistedChannelKeys',
    '_lastPersistedLegs',
    'mcMergeLegs',
    '_cfgChannelKey',
    `return (async () => { ${UNION} ; return persistable.channels })()`,
  )
  return fn(persistable, browser, 'cfg', lastPersisted, null, mcMergeLegs, key)
}

// the real key, lifted the same way
const key = new Function(`${slice('const _cfgChannelKey =', '\nfunction _rememberPersisted')}\nreturn _cfgChannelKey`)()

describe('saveConfig cross-tab channel union', () => {
  test('adopts a channel another tab added (the lost-update this fixes)', async () => {
    const out = await run({
      mine: [{ id: 'xqc', platform: 'twitch' }],
      theirs: [
        { id: 'xqc', platform: 'twitch' },
        { id: 'lirik', platform: 'twitch' },
      ],
      lastPersisted: new Set(['twitch:xqc']),
    })
    expect(out.map(key).sort()).toEqual(['twitch:lirik', 'twitch:xqc'])
  })

  test('a channel WE removed stays removed (no zombie resurrection)', async () => {
    const out = await run({
      mine: [{ id: 'xqc', platform: 'twitch' }],
      theirs: [
        { id: 'xqc', platform: 'twitch' },
        { id: 'lirik', platform: 'twitch' },
      ],
      lastPersisted: new Set(['twitch:xqc', 'twitch:lirik']), // we had lirik, then deleted it
    })
    expect(out.map(key)).toEqual(['twitch:xqc'])
  })

  test('same channel on two platforms is not collapsed', async () => {
    const out = await run({
      mine: [{ id: 'xqc', platform: 'twitch' }],
      theirs: [{ id: 'xqc', platform: 'kick' }],
      lastPersisted: new Set(['twitch:xqc']),
    })
    expect(out.map(key).sort()).toEqual(['kick:xqc', 'twitch:xqc'])
  })

  test('no duplicates when both tabs hold the same list', async () => {
    const same = [
      { id: 'xqc', platform: 'twitch' },
      { id: 'lirik', platform: 'twitch' },
    ]
    const out = await run({ mine: same, theirs: same, lastPersisted: new Set(same.map(key)) })
    expect(out).toHaveLength(2)
  })

  test('empty storage leaves our list untouched (first-ever write)', async () => {
    const out = await run({ mine: [{ id: 'xqc', platform: 'twitch' }], theirs: [], lastPersisted: null })
    expect(out.map(key)).toEqual(['twitch:xqc'])
  })

  test('null snapshot (first save this session) still adopts their additions', async () => {
    const out = await run({
      mine: [{ id: 'xqc', platform: 'twitch' }],
      theirs: [{ id: 'lirik', platform: 'twitch' }],
      lastPersisted: null,
    })
    expect(out.map(key).sort()).toEqual(['twitch:lirik', 'twitch:xqc'])
  })
})

describe('what the tab knew before its first write', () => {
  // _rememberPersisted lifted with its key: the snapshot loadConfig / onChanged take
  const remember = new Function(
    `let _lastPersistedLegs = null, _lastPersistedChannelKeys = null
     ${slice('const _cfgChannelKey =', '\nasync function _saveConfigNow')}
     return (list) => { _rememberPersisted(list); return _lastPersistedChannelKeys }`,
  )()
  const both = [
    { id: 'xqc', twitch: 'xqc' },
    { id: 'lirik', twitch: 'lirik' },
  ]

  test('a tab that never saved removes a channel: it stays removed', async () => {
    const known = remember(both) // loaded at boot
    const out = await run({ mine: [both[0]], theirs: both, lastPersisted: known })
    expect(out.map(key)).toEqual(['twitch:xqc'])
  })

  test("another tab's add it heard about, then removed here: stays removed", async () => {
    remember([both[0]]) // loaded with xqc
    const known = remember(both) // heard lirik arrive from another tab
    const out = await run({ mine: [both[0]], theirs: both, lastPersisted: known })
    expect(out.map(key)).toEqual(['twitch:xqc'])
  })

  test('an add it never heard about is still adopted', async () => {
    const known = remember([both[0]])
    const out = await run({ mine: [both[0]], theirs: both, lastPersisted: known })
    expect(out.map(key).sort()).toEqual(['twitch:lirik', 'twitch:xqc'])
  })

  test('loadConfig and the cross-tab handler both take the snapshot', () => {
    const load = slice('async function loadConfig()', 'config = {')
    expect(load).toContain('_rememberPersisted(_raw?.channels)')
    expect(slice('config.channels = newChannels', 'updateTabBar()')).toContain('_rememberPersisted(newChannels)')
  })
})

describe('our own write coming back is told apart by content', () => {
  const echo = new Function(
    `${slice('let _lastWrittenConfig', '\nlet _lastPersistedChannelKeys')}
     return { wrote: (v) => { _lastWrittenConfig = JSON.stringify(v) }, is: _isOwnConfigEcho }`,
  )()
  const a = { enabled: true, channels: [{ id: 'xqc', twitch: 'xqc' }] }
  const b = { enabled: true, channels: [] }

  test('our write is our echo; another tab’s is not', () => {
    echo.wrote(a)
    expect(echo.is(structuredClone(a))).toBe(true)
    expect(echo.is(b)).toBe(false)
    expect(echo.is(undefined)).toBe(false)
  })

  test('a save that changed nothing does not swallow the next real change', () => {
    echo.wrote(a)
    echo.wrote(a) // no-op save: chrome fires no onChanged for it
    expect(echo.is(b)).toBe(false) // the other tab's removal still applies
  })

  test('no skip-next flag is left in the handler', () => {
    expect(SRC).not.toContain('_skipNextConfigSync')
    expect(SRC).toContain('if (!_isOwnConfigEcho(changes.heatsync_multichat.newValue))')
  })
})

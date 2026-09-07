/**
 * Cross-tab channel reconciliation in saveConfig — extracted by marker slice
 * from src/multichat/main.js so the test fails loudly if the logic moves.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../src/multichat/main.js', import.meta.url), 'utf8')

function slice(startMarker, endMarker) {
  const s = SRC.indexOf(startMarker)
  if (s === -1) throw new Error(`start marker not found: ${startMarker}`)
  const e = SRC.indexOf(endMarker, s)
  if (e === -1) throw new Error(`end marker not found: ${endMarker}`)
  return SRC.slice(s, e)
}

// The union block, lifted verbatim and wrapped in a harness.
const UNION = slice('const stored = (await browser.storage.local.get(STORAGE_KEY))', '      } catch {}')

function run({ mine, theirs, lastPersisted }) {
  const persistable = { channels: [...mine] }
  const browser = { storage: { local: { get: async () => ({ cfg: { channels: theirs } }) } } }
  const fn = new Function(
    'persistable',
    'browser',
    'STORAGE_KEY',
    '_lastPersistedChannelKeys',
    `return (async () => { ${UNION} ; return persistable.channels })()`,
  )
  return fn(persistable, browser, 'cfg', lastPersisted)
}

const key = (c) => `${c.platform || 'twitch'}:${(c.id || c.twitch || c.name || '').toLowerCase()}`

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

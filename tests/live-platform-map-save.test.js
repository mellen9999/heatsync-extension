/**
 * The live tab's platforms (hs_live_platform_map) are saved one channel at a
 * time into what storage holds now. The whole in-memory copy used to be written,
 * so a second open tab erased what the first saved since it loaded (11-17).
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/multichat/main-live.js', import.meta.url), 'utf8')
const from = src.indexOf('let _liveMapChain')
const code = src.slice(from, src.indexOf('\nasync function loadLivePlatformMap', from))

function tab(store, mine) {
  const env = { map: { ...mine } }
  const browser = {
    storage: {
      local: {
        get: async () => ({ hs_live_platform_map: store.v && structuredClone(store.v) }),
        set: async (o) => {
          await Promise.resolve()
          store.v = structuredClone(o.hs_live_platform_map)
        },
      },
    },
  }
  const save = new Function(
    'browser',
    'env',
    'reportStorageWriteFailure',
    `let livePlatformMap = env.map
     ${code}
     return { save: saveLivePlatformMap, set: (k, v) => { if (v) livePlatformMap[k] = v; else delete livePlatformMap[k] }, map: () => livePlatformMap }`,
  )(browser, env, (_w, e) => {
    throw e
  })
  return save
}

test("two tabs' saves both survive", async () => {
  const store = { v: {} }
  const a = tab(store, {})
  const b = tab(store, {}) // loaded before a saved anything
  a.set('xqc', { twitch: 'xqc', kick: 'xqc', youtube: '' })
  await a.save('xqc')
  b.set('kripp', { twitch: 'nl_kripp', kick: '', youtube: '' })
  await b.save('kripp')
  expect(Object.keys(store.v).sort()).toEqual(['kripp', 'xqc'])
  expect(Object.keys(b.map()).sort()).toEqual(['kripp', 'xqc'])
})

test('a reset removes only its own channel', async () => {
  const store = { v: { xqc: { twitch: 'xqc' }, kripp: { twitch: 'nl_kripp' } } }
  const a = tab(store, { xqc: { twitch: 'xqc' } })
  a.set('xqc', null)
  await a.save('xqc')
  expect(store.v).toEqual({ kripp: { twitch: 'nl_kripp' } })
})

test('two saves in one tab do not interleave', async () => {
  const store = { v: {} }
  const a = tab(store, {})
  a.set('x', { twitch: 'x' })
  const p1 = a.save('x')
  a.set('y', { twitch: 'y' })
  const p2 = a.save('y')
  await Promise.all([p1, p2])
  expect(Object.keys(store.v).sort()).toEqual(['x', 'y'])
})

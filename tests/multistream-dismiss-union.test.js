// A dismissed "also live on" banner stays dismissed with two tabs open: each
// dismissal is added into what storage holds, not written over it (11-17).
import { expect, test } from 'bun:test'
import { mainSource } from './main-src.js'

const src = mainSource()
const from = src.indexOf('let _multistreamDismissed = null')
const code = src.slice(from, src.indexOf('\nfunction hideMultistreamBanner', from))

function tab(store) {
  const browser = {
    storage: {
      local: {
        get: async () => ({ hs_multistream_dismissed: store.v && [...store.v] }),
        set: async (o) => {
          store.v = [...o.hs_multistream_dismissed]
        },
      },
    },
  }
  return new Function(
    'browser',
    `${code}\nreturn { load: loadMultistreamDismissed, dismiss: async (k) => { (await loadMultistreamDismissed()).add(k); await persistMultistreamDismissed() } }`,
  )(browser)
}

test("two tabs' dismissals both stay", async () => {
  const store = { v: [] }
  const a = tab(store)
  const b = tab(store)
  await a.load()
  await b.load() // both loaded before either dismissed
  await a.dismiss('xqc')
  await b.dismiss('kripp')
  expect([...store.v].sort()).toEqual(['kripp', 'xqc'])
})

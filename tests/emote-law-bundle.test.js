import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { emoteLawSource, LAW_GLOBAL, lawIsUsed } from '../scripts/lib/emote-law-bundle.mjs'

const ROOT = join(import.meta.dir, '..')

// the law lands in the bundle as one name, so none of its helpers can collide with the shared scope
test('the law bundles to a single global holding the whole api', () => {
  const src = emoteLawSource(ROOT)
  const law = new Function(`${src}\nreturn ${LAW_GLOBAL}`)()
  for (const fn of ['readWord', 'readLine', 'sendWord', 'sendLine', 'editLine', 'offer', 'extendOffer', 'browse'])
    expect(typeof law[fn], fn).toBe('function')
  expect(law.LAW_VERSION).toBe(1)
})

test('the bundled source declares no top-level name but its own global', () => {
  const src = emoteLawSource(ROOT)
  const tops = [...src.matchAll(/^(?:var|let|const|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
  expect(tops).toEqual([LAW_GLOBAL])
})

test('lawIsUsed reads the multichat sources', () => {
  expect(typeof lawIsUsed(ROOT)).toBe('boolean')
})

test('a checkout without the law copy fails the build, it never ships a bundle that names a law it does not carry', () => {
  // every chat row calls hsEmoteLaw: a bundle built from '' throws ReferenceError on the first line drawn
  expect(() => emoteLawSource(join(ROOT, 'tests', 'no-such-root'))).toThrow(/emote-law\.ts/)
})

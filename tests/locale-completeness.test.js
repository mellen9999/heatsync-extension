// every locale carries every en key, with the same placeholders. chrome falls
// back to en silently, so a key that lands in en alone ships english to 33
// languages and nothing goes red (590 did, after the 07-27 rewrite).
// Add a key to en -> add it to every src/_locales/*/messages.json.
// Fix a missing list with: bun scripts/i18n-missing.mjs
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', 'src', '_locales')
const load = (c) => JSON.parse(readFileSync(join(ROOT, c, 'messages.json'), 'utf8'))
const en = load('en')
const codes = readdirSync(ROOT).filter((c) => c !== 'en')
const tokens = (m) => [...m.matchAll(/\$[A-Za-z0-9_@]+\$|\$\d/g)].map((x) => x[0].toUpperCase()).sort()
const holders = (e) => JSON.stringify(Object.entries(e.placeholders || {}).sort())

test('34 locales ship', () => {
  expect(codes.length).toBe(33)
})

describe.each(codes)('locale %s', (code) => {
  const loc = load(code)
  test('has every en key', () => {
    expect(Object.keys(en).filter((k) => !(k in loc))).toEqual([])
  })
  test('has no key en lacks', () => {
    expect(Object.keys(loc).filter((k) => !(k in en))).toEqual([])
  })
  test('no empty message', () => {
    expect(Object.keys(loc).filter((k) => !loc[k].message?.trim())).toEqual([])
  })
  test('placeholders match en', () => {
    const bad = Object.keys(loc).filter(
      (k) =>
        k in en &&
        (holders(loc[k]) !== holders(en[k]) || tokens(loc[k].message).join() !== tokens(en[k].message).join()),
    )
    expect(bad).toEqual([])
  })
})

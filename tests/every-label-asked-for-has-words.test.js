// A label the code asks for by name must have words. t('key') on a key no locale file holds
// draws the raw key: the favorites menu shipped as "mc_fav_add", its section as
// "mc_picker_favorites", in every language, and no test read the two lists against each other.
// Every literal key in src must exist in english, and every key added since must exist in all 34.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '..', 'src')
const LOCALES = join(SRC, '_locales')
const words = (loc) => JSON.parse(readFileSync(join(LOCALES, loc, 'messages.json'), 'utf8'))

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) {
      if (f !== '_locales') walk(p, out)
    } else if (f.endsWith('.js')) out.push(p)
  }
  return out
}

/** every key asked for by a literal: t('key'…) and i18n.getMessage('key'…) */
function asked() {
  const out = new Map()
  for (const p of walk(SRC)) {
    const text = readFileSync(p, 'utf8')
    for (const m of text.matchAll(/(?:\bt|\.getMessage)\(\s*'([a-z0-9_]+)'/g))
      if (!out.has(m[1])) out.set(m[1], p.slice(SRC.length + 1))
  }
  return out
}

describe('every label the code asks for has words', () => {
  const keys = asked()
  const en = words('en')

  test('the scan sees the call sites (it is not reading an empty list)', () => {
    expect(keys.size).toBeGreaterThan(500)
    expect(keys.has('mc_fav_add')).toBe(true)
  })

  test('in english', () => {
    const missing = [...keys].filter(([k]) => !en[k]?.message).map(([k, f]) => `${k} (${f})`)
    expect(missing).toEqual([])
  })

  test('the favorites labels, in all 34 languages', () => {
    const locs = readdirSync(LOCALES)
    expect(locs).toHaveLength(34)
    const missing = []
    for (const loc of locs) {
      const d = words(loc)
      for (const k of ['mc_picker_favorites', 'mc_fav_add', 'mc_fav_remove', 'mc_fav_full'])
        if (!d[k]?.message) missing.push(`${loc}: ${k}`)
    }
    expect(missing).toEqual([])
  })
})

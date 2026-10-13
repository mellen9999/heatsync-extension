/**
 * BadgeIndex (src/lib/badge-index.js) — the ffz/chatterino badge maps as a
 * sorted id column + a badge column. The per-user Map it replaced cost ~8MB
 * in every tab (heap-snapshot diff on twitch.tv/directory, 2026-10-13: 83k
 * per-user copies of one badge url, 97k username/id strings).
 */
import { describe, expect, test } from 'bun:test'
import { BadgeIndex } from '../src/lib/badge-index.js'

const A = { title: 'Supporter', color: '#ff0000', url: 'https://cdn.frankerfacez.com/badge/3/2' }
const B = { title: 'Bot', color: null, url: 'https://cdn.frankerfacez.com/badge/2/2' }

describe('BadgeIndex', () => {
  const idx = new BadgeIndex([
    { ...A, ids: [30, 10, '20'] },
    { ...B, ids: [20, 4294967295] },
  ])

  test('get returns every badge a user has, in badge-list order', () => {
    expect(idx.get('20')).toEqual([A, B])
    expect(idx.get(10)).toEqual([A])
    expect(idx.get('4294967295')).toEqual([B])
  })

  test('badges are shared, not copied per user', () => {
    expect(idx.get(10)[0]).toBe(idx.get(30)[0])
  })

  test('has / size count users, not rows', () => {
    expect(idx.has('30')).toBe(true)
    expect(idx.has('31')).toBe(false)
    expect(idx.size).toBe(4)
  })

  test('misses and junk ids are undefined, never throw', () => {
    for (const uid of ['0', '', 'abc', undefined, null, -5, '1.5', 5]) expect(idx.get(uid)).toBeUndefined()
  })

  test('garbage input is an empty index', () => {
    for (const bad of [undefined, null, {}, 'x', [null, 1, { ids: 'nope' }]]) {
      const e = new BadgeIndex(bad)
      expect(e.size).toBe(0)
      expect(e.get('1')).toBeUndefined()
    }
  })

  test('ids out of u32 range or non-integer are dropped, the rest kept', () => {
    const e = new BadgeIndex([{ ...A, ids: [4294967296, 1.5, -1, 'x', 7] }])
    expect(e.size).toBe(1)
    expect(e.get(7)).toEqual([A])
  })

  test('83k users stay compact and fast', () => {
    const ids = Array.from({ length: 83_000 }, (_, i) => 100_000_000 + i * 13)
    const big = new BadgeIndex([
      { ...A, ids },
      { ...B, ids: ids.filter((_, i) => i % 7 === 0) },
    ])
    expect(big.size).toBe(83_000)
    expect(big.ids.byteLength + big.badgeOf.byteLength).toBeLessThan(600_000)
    expect(big.get(ids[0])).toEqual([A, B])
    expect(big.get(ids[1])).toEqual([A])
  })
})

/**
 * Unit tests for addUsername's incremental maintenance of _ucDisplay
 * (src/multichat/main.js).
 *
 * findEmoteMatches (src/multichat/input.js) used to rebuild a bareLowerName →
 * cased-name display map by iterating the entire usernameCache (up to 5000
 * entries) on every autocomplete keystroke. addUsername — the sole writer of
 * usernameCache — now maintains that map incrementally instead, including on
 * LRU eviction. Carved out of main.js (same "don't depend on bundled output"
 * rationale as tab-complete-order.test.js's compareAcMatches).
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainSource } from './main-src.js'

const MAIN_SRC = mainSource()
const start = MAIN_SRC.indexOf('const usernameCache = new Set()')
const end = MAIN_SRC.indexOf('// Username → color map for @mention coloring')
if (start === -1 || end === -1 || end <= start) throw new Error('addUsername carve markers not found')

function makeCache() {
  const _ucDisplay = new Map()
  const factory = new Function(
    '_ucDisplay',
    `${MAIN_SRC.slice(start, end)}; return { usernameCache, addUsername, USERNAME_CACHE_MAX }`,
  )
  const { usernameCache, addUsername, USERNAME_CACHE_MAX } = factory(_ucDisplay)
  return { usernameCache, addUsername, USERNAME_CACHE_MAX, _ucDisplay }
}

describe('addUsername — incremental _ucDisplay maintenance', () => {
  test('adding a username populates the bare-lowercase display map', () => {
    const { addUsername, _ucDisplay } = makeCache()
    addUsername('SomeUser')
    expect(_ucDisplay.get('someuser')).toBe('SomeUser')
  })

  test('a YouTube "@handle" strips the leading @ for the display key', () => {
    const { addUsername, _ucDisplay } = makeCache()
    addUsername('@SomeHandle')
    expect(_ucDisplay.get('somehandle')).toBe('@SomeHandle')
  })

  test('re-adding the same name is a no-op that leaves the display entry correct', () => {
    const { addUsername, usernameCache, _ucDisplay } = makeCache()
    addUsername('Foo')
    addUsername('Foo')
    expect(usernameCache.size).toBe(1)
    expect(_ucDisplay.get('foo')).toBe('Foo')
  })

  test('a later add with different casing wins the shared bare key (last-write-wins, matches the old full-rescan)', () => {
    const { addUsername, _ucDisplay } = makeCache()
    addUsername('foo')
    addUsername('Foo')
    expect(_ucDisplay.get('foo')).toBe('Foo')
  })

  test('LRU eviction removes the display entry for an evicted name', () => {
    const { addUsername, usernameCache, _ucDisplay, USERNAME_CACHE_MAX } = makeCache()
    for (let i = 0; i < USERNAME_CACHE_MAX; i++) addUsername(`user${i}`)
    expect(usernameCache.has('user0')).toBe(true)
    expect(_ucDisplay.get('user0')).toBe('user0')

    addUsername('overflow') // pushes size past MAX, evicts the 500 oldest
    expect(usernameCache.has('user0')).toBe(false)
    expect(_ucDisplay.has('user0')).toBe(false)
  })

  test('eviction never clears a display entry a newer, still-live name owns', () => {
    const { addUsername, usernameCache, _ucDisplay, USERNAME_CACHE_MAX } = makeCache()
    addUsername('dup') // oldest — first in line to be evicted
    for (let i = 0; i < USERNAME_CACHE_MAX - 1; i++) addUsername(`filler${i}`)
    addUsername('Dup') // newer, different-cased name sharing the same bare key;
    // its add is what pushes the cache past MAX and triggers eviction

    expect(usernameCache.has('dup')).toBe(false) // the original entry got evicted
    expect(usernameCache.has('Dup')).toBe(true) // the survivor is untouched
    expect(_ucDisplay.get('dup')).toBe('Dup') // display map still points at the survivor
  })

  test('cache never exceeds USERNAME_CACHE_MAX', () => {
    const { addUsername, usernameCache, USERNAME_CACHE_MAX } = makeCache()
    for (let i = 0; i < USERNAME_CACHE_MAX + 50; i++) addUsername(`user${i}`)
    expect(usernameCache.size).toBeLessThanOrEqual(USERNAME_CACHE_MAX)
  })
})

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The picker is built once and reused while its cache key holds. The recents row
 * was not in the key: an emote picked in one twitch tab never showed in another
 * twitch tab's recents (same localStorage) until something else rebuilt it. The
 * key now carries the list.
 */
const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8')
const s = SRC.indexOf('function pickerCacheKey()')
const KEY = SRC.slice(s, SRC.indexOf('\nfunction markPickerDirty', s))

test('another tab picking an emote changes the key', () => {
  const store = new Map()
  const key = new Function(
    'localStorage',
    'currentTab',
    'getCurrentChannel',
    'activeTabEmotePools',
    'emoteSize',
    'emoteCache',
    '_blockedRev',
    'RECENT_KEY',
    `${KEY}\nreturn pickerCacheKey`,
  )(
    { getItem: (k) => store.get(k) ?? null },
    'xqc',
    () => '',
    () => [],
    28,
    new Map(),
    0,
    'hs-mc-recent-emotes',
  )
  const before = key()
  store.set('hs-mc-recent-emotes', JSON.stringify(['Clap']))
  expect(key()).not.toBe(before)
})

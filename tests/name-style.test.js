import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isPaintLookupSafeId } from '../src/lib/paint-spec.js'
import { escapeHtml } from '../src/lib/utils.js'
import { hsUsernameColor } from '../src/multichat/paints.js'

// name-style.js leans on bundle globals (build.js concatenates the modules);
// give it the real ones it can have standalone and a stand-in for the rest.
const G = {
  isPaintLookupSafeId,
  escapeHtml,
  hsUsernameColor,
  sanitizeColor: (c) => (/^#[0-9a-f]{3,6}$/i.test(c) ? c : '#fff'),
  getHsPickedColor: (uid) => picked.get(uid) ?? null,
}
const picked = new Map()
const saved = {}
let ns
beforeAll(async () => {
  for (const [k, v] of Object.entries(G)) {
    saved[k] = globalThis[k]
    globalThis[k] = v
  }
  ns = await import('../src/multichat/name-style.js')
})
afterAll(() => {
  for (const k of Object.keys(G)) globalThis[k] = saved[k]
})

describe('hsNameUid — the paint id for a (user_id, platform) pair', () => {
  test('twitch and heatsync ids are themselves; kick and youtube are namespaced', () => {
    expect(ns.hsNameUid('123', 'twitch')).toBe('123')
    expect(ns.hsNameUid('123', 'heatsync')).toBe('123')
    expect(ns.hsNameUid('77', 'kick')).toBe('kick_77')
    expect(ns.hsNameUid('UCabcdefghijklmnopqrstuv', 'youtube')).toBe('yt_UCabcdefghijklmnopqrstuv')
  })
  test('an id that is already namespaced is kept, never double-prefixed', () => {
    expect(ns.hsNameUid('kick_77', 'kick')).toBe('kick_77')
    expect(ns.hsNameUid('yt_UCabcdefghijklmnopqrstuv', 'youtube')).toBe('yt_UCabcdefghijklmnopqrstuv')
  })
  test('no id, an unknown platform or a malformed youtube id is no lookup key', () => {
    expect(ns.hsNameUid('', 'twitch')).toBe('')
    expect(ns.hsNameUid(null, 'twitch')).toBe('')
    expect(ns.hsNameUid('123', 'mastodon')).toBe('')
    expect(ns.hsNameUid('123', '')).toBe('')
    expect(ns.hsNameUid('nope', 'youtube')).toBe('')
  })
})

describe('hsNameColour', () => {
  test('an explicit colour wins; null means none → the shared palette', () => {
    expect(ns.hsNameColour({ colour: '#00ff00', name: 'a' })).toBe('#00ff00')
    expect(ns.hsNameColour({ colour: null, name: 'Mellen', login: 'mellen' })).toBe(hsUsernameColor('mellen'))
  })
  test('a twitch id never takes the heatsync-picked colour; kick and youtube do', () => {
    picked.set('123', '#ff00ff')
    picked.set('kick_9', '#00ffff')
    expect(ns.hsNameColour({ uid: '123', name: 'a', login: 'a', platform: 'twitch' })).toBe(hsUsernameColor('a'))
    expect(ns.hsNameColour({ uid: 'kick_9', name: 'a', login: 'a', platform: 'kick' })).toBe('#00ffff')
  })
  test('the display text never colours the name — the login does', () => {
    expect(ns.hsNameColour({ name: '@mellen', login: 'mellen' })).toBe(hsUsernameColor('mellen'))
  })
})

describe('wiring — every name surface goes through the one helper', () => {
  const dir = join(import.meta.dir, '..', 'src', 'multichat')
  const src = (f) => readFileSync(join(dir, f), 'utf8')
  const uses = {
    'social.js': [
      'feedAuthorLink',
      'hs-mention',
      'hs-discover-post-user',
      'hs-discover-profile-name',
      'hs-pinned-user',
    ],
    'main.js': ['hs-mc-search-user', 'hs-evt-user', 'hs-dm-name'],
    'whispers.js': ['hsNameParts('],
    'chat-logs.js': ['hsNameApply('],
    'feed-embed.js': ['hs-log-embed-user'],
    'input.js': ['hsNameApply(nameSpan'],
    'tooltips.js': ['hsNameCardsIn(tooltip)'],
    'profile-card.js': ['hsNameCardsIn(card)'],
  }
  for (const [f, needles] of Object.entries(uses)) {
    test(`${f} paints names through name-style.js`, () => {
      const s = src(f)
      for (const n of needles) expect(s, `${f}: ${n}`).toContain(n)
      expect(s).toMatch(/hsName(Parts|Apply|CardsIn)\(/)
    })
  }
  test('late cosmetics answers repaint registered names', () => {
    const s = src('cosmetics.js')
    for (const fn of ['updateHsPaintsInPlace', 'updateHsColorsInPlace', 'updateCosmeticsInPlace']) {
      const at = s.indexOf(`function ${fn}(`)
      expect(s.slice(at, at + 120), fn).toContain('hsNameSweep(userIds)')
    }
  })
  test('a native heatsync DM carries its sender id into the inline row', () => {
    expect(src('whispers.js')).toContain('userId: data.from_user_id')
  })
})

import { expect, test } from 'bun:test'
import { userKey, userSetMatches } from '../src/lib/user-key.js'

test('userKey: platform-scoped, lowercased, @-stripped', () => {
  expect(userKey('Alice', 'twitch')).toBe('twitch:alice')
  expect(userKey('@Bob', 'youtube')).toBe('youtube:bob')
  expect(userKey('CarolCat', 'kick')).toBe('kick:carolcat')
})

test('userKey: null/empty platform → bare (legacy-global) key', () => {
  expect(userKey('alice', null)).toBe('alice')
  expect(userKey('alice', undefined)).toBe('alice')
  expect(userKey('alice', '')).toBe('alice')
})

test('userKey: empty/nullish username → empty string', () => {
  expect(userKey('', 'twitch')).toBe('')
  expect(userKey(null, 'twitch')).toBe('')
  expect(userKey(undefined, 'twitch')).toBe('')
})

test('no cross-platform collision: blocking twitch alice does NOT match kick alice', () => {
  const set = new Set([userKey('alice', 'twitch')])
  expect(userSetMatches(set, 'alice', 'twitch')).toBe(true)
  expect(userSetMatches(set, 'alice', 'kick')).toBe(false) // the bug this fixes
  expect(userSetMatches(set, 'alice', 'youtube')).toBe(false)
})

test('legacy bare entry matches on every platform (backward compat, no migration)', () => {
  const set = new Set(['alice']) // pre-namespace stored value
  expect(userSetMatches(set, 'alice', 'twitch')).toBe(true)
  expect(userSetMatches(set, 'alice', 'kick')).toBe(true)
  expect(userSetMatches(set, 'alice', null)).toBe(true)
})

test('linked cross-platform identity matches via aliasKeys', () => {
  // kick "alice" is 7TV-linked to twitch "alicetw"; blocking her fanned out to
  // both namespaced keys. A check on the kick side supplies the twitch alias key.
  const set = new Set([userKey('alicetw', 'twitch')])
  expect(userSetMatches(set, 'alice', 'kick', [userKey('alicetw', 'twitch')])).toBe(true)
  // unrelated kick user with no linked identity is unaffected
  expect(userSetMatches(set, 'alice', 'kick', [userKey('alice', 'kick')])).toBe(false)
})

test('empty set / empty username → no match (hot-path short-circuit safe)', () => {
  expect(userSetMatches(new Set(), 'alice', 'twitch')).toBe(false)
  expect(userSetMatches(null, 'alice', 'twitch')).toBe(false)
  expect(userSetMatches(new Set(['twitch:alice']), '', 'twitch')).toBe(false)
})

test('@-prefixed lookup normalizes to stored key (youtube handles)', () => {
  const set = new Set([userKey('bob', 'youtube')])
  expect(userSetMatches(set, '@bob', 'youtube')).toBe(true)
  expect(userSetMatches(set, 'bob', 'youtube')).toBe(true)
})

// Block-specific scenarios (overlay → content.js propagation)

test('block scenario: overlay block (twitch:alice) hides message on twitch content.js', () => {
  // Overlay sends block_user with namespaced key; content.js stores it and checks
  // via userSetMatches with the page platform.
  const blockedUsers = new Set([userKey('alice', 'twitch')]) // stored by content.js receiver
  const lowerUser = 'alice'
  const pagePlatform = 'twitch'
  expect(userSetMatches(blockedUsers, lowerUser, pagePlatform, [])).toBe(true)
})

test('block scenario: twitch block does NOT hide unrelated kick user of same name', () => {
  const blockedUsers = new Set([userKey('alice', 'twitch')])
  expect(userSetMatches(blockedUsers, 'alice', 'kick', [])).toBe(false)
})

test('block scenario: legacy bare block still hides on all platforms (global-match)', () => {
  const blockedUsers = new Set(['alice']) // pre-namespace entry from old storage
  expect(userSetMatches(blockedUsers, 'alice', 'twitch', [])).toBe(true)
  expect(userSetMatches(blockedUsers, 'alice', 'kick', [])).toBe(true)
})

test('mute scenario: overlay mute key (kick:bob) reaches kick native chat', () => {
  const mutedUsers = new Set([userKey('bob', 'kick')])
  expect(userSetMatches(mutedUsers, 'bob', 'kick', [])).toBe(true)
  expect(userSetMatches(mutedUsers, 'bob', 'twitch', [])).toBe(false)
})

test('unblock scenario: deleting namespaced key removes block', () => {
  const blockedUsers = new Set([userKey('alice', 'twitch')])
  blockedUsers.delete(userKey('alice', 'twitch'))
  expect(userSetMatches(blockedUsers, 'alice', 'twitch', [])).toBe(false)
})

test('legacy unblock: deleting both namespaced + bare clears pre-namespace entry', () => {
  const blockedUsers = new Set(['alice']) // legacy bare
  const key = userKey('alice', 'twitch')
  blockedUsers.delete(key) // namespaced delete → no-op on legacy
  blockedUsers.delete('alice') // bare delete → clears it
  expect(userSetMatches(blockedUsers, 'alice', 'twitch', [])).toBe(false)
})

// Cosmetics-identity scenarios (main.js knownUserIds: Map<key, resolvedTwitchId>,
// backing 7TV paint/badge lookup for @mentions/replies/archive rows/tooltips).
// Unlike the block/mute Sets above, this is a persisted-per-session VALUE map
// (username → twitch id), not a membership check — no legacy bare data exists
// (pure in-memory, rebuilt each session) so it namespaces cleanly with no
// bare-key compat layer needed. These tests model that Map directly since
// main.js isn't import-able (bundled global-scope script, not an ES module).

test("cosmetics: bare-keyed map lets a kick chatter steal a twitch chatter's paint (the bug)", () => {
  const knownUserIds = new Map() // bare username → twitch id, pre-fix shape
  knownUserIds.set('alice', '111') // real twitch alice's linked 7TV/twitch id
  knownUserIds.set('alice', '222') // unrelated kick alice's 7TV-linked twitch id overwrites the same bare slot
  // Both platforms now resolve to kick-alice's id — twitch alice's paint is gone.
  expect(knownUserIds.get('alice')).toBe('222')
})

test('cosmetics: platform-scoped keys keep twitch alice and kick alice independent', () => {
  const knownUserIds = new Map()
  knownUserIds.set(userKey('alice', 'twitch'), '111')
  knownUserIds.set(userKey('alice', 'kick'), '222')
  expect(knownUserIds.get(userKey('alice', 'twitch'))).toBe('111')
  expect(knownUserIds.get(userKey('alice', 'kick'))).toBe('222')
})

test('cosmetics: mention/reply paint lookup resolves to the mentioning platform, not a same-name stranger', () => {
  // Mirrors main.js highlightMentionsInHtml / replyUid: resolve a bare @name
  // against the CURRENT message's platform, never a bare cross-platform key.
  const knownUserIds = new Map([
    [userKey('alice', 'twitch'), '111'],
    [userKey('alice', 'kick'), '222'],
  ])
  const resolveMentionUid = (lower, platform) => knownUserIds.get(userKey(lower, platform)) || ''
  expect(resolveMentionUid('alice', 'twitch')).toBe('111')
  expect(resolveMentionUid('alice', 'kick')).toBe('222')
  expect(resolveMentionUid('alice', 'youtube')).toBe('') // no yt-linked entry — correctly empty, not a stolen id
})

test("cosmetics: unknown platform for a known name never falls back to a stranger's id", () => {
  const knownUserIds = new Map([[userKey('bob', 'kick'), '333']])
  expect(knownUserIds.get(userKey('bob', 'twitch'))).toBeUndefined()
})

test('yt/youtube canonicalization: both forms produce the same key', () => {
  expect(userKey('alice', 'yt')).toBe('youtube:alice')
  expect(userKey('alice', 'youtube')).toBe('youtube:alice')
})

test('mute written from a yt row (short form) is enforced against youtube messages', () => {
  // row anchors stamp data-platform="yt"; the message model carries 'youtube'.
  const set = new Set([userKey('alice', 'yt')])
  expect(userSetMatches(set, 'alice', 'youtube')).toBe(true)
  expect(userSetMatches(set, 'alice', 'yt')).toBe(true)
  expect(userSetMatches(set, 'alice', 'twitch')).toBe(false)
})

test("legacy stored 'yt:' keys (pre-canonicalization) still match youtube rows", () => {
  const set = new Set(['yt:alice'])
  expect(userSetMatches(set, 'alice', 'youtube')).toBe(true)
  expect(userSetMatches(set, 'alice', 'yt')).toBe(true)
  expect(userSetMatches(set, 'alice', 'kick')).toBe(false)
})

test('canonPlatform: row short form becomes the wire name', async () => {
  const { canonPlatform } = await import('../src/lib/user-key.js')
  expect(canonPlatform('yt')).toBe('youtube')
  expect(canonPlatform('kick')).toBe('kick')
})

test('card fetch sends the canonical platform', async () => {
  const src = await Bun.file(new URL('../src/multichat/tooltips.js', import.meta.url)).text()
  expect(src).toContain("platform: canonPlatform(platform || 'twitch')")
})

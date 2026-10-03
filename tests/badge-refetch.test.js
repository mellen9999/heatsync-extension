/**
 * An unknown twitch badge set/version: renders nothing (never version 1's art),
 * queues one debounced refetch per channel, is asked about at most once per
 * 10 min per (channel, key) whether or not the refetch finds it, and the merge
 * brings url + title in for the in-place repaint. Source-sliced like
 * badge-refresh-race.test.js — the files share one concatenated scope.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'twitch-api.js'), 'utf8')
const slice = (from, to) => {
  const s = SRC.indexOf(from)
  const e = SRC.indexOf(to, s)
  if (s < 0 || e < 0) throw new Error(`slice ${from}`)
  return SRC.slice(s, e)
}
const src = [
  slice('const BADGE_ASK_WINDOW_MS', 'async function refetchBadgeSet'),
  slice('async function refetchBadgeSet', 'const badgeRefetcher'),
  slice('function findNearestChannelBadgeVersion', 'let globalBadgesFetched'),
  slice('function resolveBadgeImageUrl', 'function renderBadges'),
  slice('function noteBadgeMiss', 'function renderBadges'),
].join('\n')

function make(gql = async () => ({ data: {} })) {
  const twitchBadgeUrls = new Map()
  const twitchBadgeTitles = new Map()
  const channelBadgeVersions = new Map()
  const kickBadgeUrls = new Map()
  const patched = []
  const f = new Function(
    'twitchBadgeUrls',
    'twitchBadgeTitles',
    'channelBadgeVersions',
    'kickBadgeUrls',
    'findNearestKickBadgeVersion',
    'twitchGql',
    'updateNativeBadgesInPlace',
    'globalBadgesFetched',
    'badgesFetchedChannels',
    `${src}
     let _now = 0
     const calls = []
     const r = createBadgeRefetcher({ refetch: c => { calls.push(c) }, now: () => _now })
     const badgeRefetcher = r
     return { r, calls, tick: ms => { _now += ms }, resolveBadgeImageUrl, resolveBadgeTitle, noteBadgeMiss, refetchBadgeSet }`,
  )(
    twitchBadgeUrls,
    twitchBadgeTitles,
    channelBadgeVersions,
    kickBadgeUrls,
    () => null,
    gql,
    (c) => patched.push(c),
    true,
    new Set(['chan']),
  )
  return { f, twitchBadgeUrls, twitchBadgeTitles, patched }
}

describe('unknown badge version', () => {
  test('no version-1 fallback: subscriber/3000 missing renders nothing even with subscriber/1 known', () => {
    const { f, twitchBadgeUrls } = make()
    twitchBadgeUrls.set('subscriber/1', 'star.png')
    expect(f.resolveBadgeImageUrl(false, null, 'subscriber', '3000')).toBeNull()
    expect(f.resolveBadgeImageUrl(false, 'chan', 'subscriber', '3000')).toBeNull()
  })

  test('a miss queues one debounced refetch per channel, however many rows', async () => {
    const { f } = make()
    for (let i = 0; i < 20; i++) f.noteBadgeMiss('chan', 'subscriber', '3000')
    f.noteBadgeMiss('chan', 'bits', '999')
    expect(f.calls.length).toBe(0)
    await new Promise((r) => setTimeout(r, 1700))
    expect(f.calls).toEqual(['chan'])
  })

  test('negative: same key is not asked again inside 10 min, is after', async () => {
    const { f } = make()
    expect(f.r.note('chan', 'a/1')).toBe(true)
    f.tick(9 * 60 * 1000)
    expect(f.r.note('chan', 'a/1')).toBe(false)
    expect(f.r.note('chan', 'b/1')).toBe(true)
    f.tick(61 * 1000)
    expect(f.r.note('chan', 'a/1')).toBe(true)
    expect(f.r.note('other', 'a/1')).toBe(true)
  })

  test('no ask before the sets have landed', () => {
    const { f } = make()
    f.noteBadgeMiss('unfetched', 'subscriber', '3000')
    f.noteBadgeMiss('', 'subscriber', '3000')
    expect(f.r.note('unfetched', 'x')).toBe(true) // never marked by the gated path
  })

  test('refetch merges channel + global rows with titles and repaints that channel', async () => {
    const gql = async (q) =>
      q.includes('broadcastBadges')
        ? {
            data: {
              user: {
                broadcastBadges: [{ setID: 'subscriber', version: '3000', imageURL: 't3.png', title: 'tier 3 sub' }],
              },
            },
          }
        : { data: { badges: [{ setID: 'ev', version: '1', imageURL: 'ev.png', title: 'event' }] } }
    const { f, twitchBadgeUrls, twitchBadgeTitles, patched } = make(gql)
    await f.refetchBadgeSet('chan')
    expect(f.resolveBadgeImageUrl(false, 'chan', 'subscriber', '3000')).toBe('t3.png')
    expect(f.resolveBadgeImageUrl(false, 'chan', 'ev', '1')).toBe('ev.png')
    expect(f.resolveBadgeTitle('chan', 'subscriber', '3000')).toBe('tier 3 sub')
    expect(twitchBadgeTitles.get('ev/1')).toBe('event')
    expect(twitchBadgeUrls.get('chan:subscriber/3000')).toBe('t3.png')
    expect(patched).toEqual(['chan'])
  })

  test('refetch that finds nothing new repaints nothing; gql failure is swallowed', async () => {
    const { f, patched } = make(async () => {
      throw new Error('429')
    })
    await f.refetchBadgeSet('chan')
    expect(patched).toEqual([])
  })
})

describe('title on the img', () => {
  test('renderBadges + the in-place patch carry the helix title in title and alt', () => {
    expect(SRC).toContain('alt="${escapeHtml(label)}" title="${escapeHtml(label)}"')
    expect(SRC).toContain('resolveBadgeTitle(channel, name, version)')
    const cos = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'cosmetics.js'), 'utf8')
    expect(cos).toContain('img.alt = label')
    expect(cos).toContain('resolveBadgeTitle(ch, name, version)')
  })
})

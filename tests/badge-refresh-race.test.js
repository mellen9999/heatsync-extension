/**
 * Regression tests for "backfilled/history rows' mod/sub badges stay as the
 * TEXT-fallback chip forever; only newly-arriving messages get the styled
 * image badge" (multichat overlay).
 *
 * Root cause (confirmed by reading, not guessed): a channel's history/backfill
 * renders as soon as join()'s BG history round-trip resolves (src/multichat/
 * irc.js ~626-695) — that's served from the background service worker's
 * in-memory cache, so it's reliably fast (tens of ms). The badge maps it
 * needs are populated by real network fetches that are reliably SLOWER:
 *   - fetchGlobalBadges()       (twitch-api.js) — mod/vip/broadcaster/etc.
 *   - fetchChannelBadges(ch)    (twitch-api.js) — per-channel sub tiers + FFZ
 *   - fetchKickChannelBadges(s) (twitch-api.js) — per-channel Kick sub tiers
 * So the very first render of backfilled rows reliably loses this race and
 * falls back to the TEXT chip (or, for a badge name outside BADGE_STYLES,
 * nothing at all). The two Twitch fetchers already called
 * updateNativeBadgesInPlace() on resolve to patch already-rendered rows —
 * fetchKickChannelBadges did NOT (confirmed: its old comment literally said
 * "No render-side effects... calling renderMessages from here risked
 * init-timing crashes" — it relied entirely on "natural re-render on next
 * msg", meaning backfilled Kick sub-badge rows NEVER got upgraded). Fixed by
 * adding the same updateNativeBadgesInPlace(slug) call the Twitch fetchers
 * already make.
 *
 * A second, independent gap: updateNativeBadgesInPlace only ever queried the
 * live #hs-mc-messages DOM. main.js's tab-switch snapshotting
 * (snapshotTabState/restoreTabState) detaches an inactive tab's rows into an
 * offscreen DocumentFragment in _tabCache — invisible to that query. Any tab
 * snapshotted at the exact moment a badge fetch resolved kept its stale text
 * badges until the old code's blunt fallback (_dropAllTabCaches(), forcing a
 * full rebuild-with-flash on next visit) kicked in. Fixed by extracting the
 * per-row patch into _patchBadgesInRoot and running it against the live DOM
 * AND every cached tab's fragment directly (DocumentFragment supports the
 * same querySelectorAll surface as a live Element) — cheaper and no
 * unnecessary rebuild.
 *
 * This file unit-tests the one purely extractable piece: resolveBadgeImageUrl,
 * the shared badge→URL priority-chain resolver (channel-specific exact →
 * channel-specific nearest tier → global exact → global "/1" fallback, with a
 * separate simpler Kick chain) that both renderBadges (initial render) and
 * _patchBadgesInRoot (the late in-place patch) now call — refactored out of
 * two near-identical inline copies specifically so they can never drift
 * apart on which URL a given badge/version resolves to. The "loaded" vs
 * "unloaded" states below are exactly the before/after of the race: nothing
 * in the maps yet (initial backfill render) vs. populated (post-fetch state
 * the in-place patch needs to reach).
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'twitch-api.js'), 'utf8')

function sliceFn(name, nextFnMarker) {
  const s = SRC.indexOf(`function ${name}(`)
  if (s === -1) throw new Error(`sliceFn: ${name} not found`)
  const e = SRC.indexOf(nextFnMarker, s)
  if (e === -1) throw new Error(`sliceFn: end marker not found for ${name}`)
  return SRC.slice(s, e)
}

// Extract the three pure/near-pure functions together (resolveBadgeImageUrl
// calls the other two) and evaluate them in one shared scope so they can call
// each other exactly as they do in the real bundle.
const combinedSrc = [
  sliceFn('findNearestChannelBadgeVersion', 'let globalBadgesFetched'),
  sliceFn('findNearestKickBadgeVersion', 'async function fetchKickChannelBadges'),
  sliceFn('resolveBadgeImageUrl', 'function renderBadges'),
].join('\n')

// Each test gets its own fresh set of Maps (via makeResolver below) so no
// state leaks between tests.
function makeResolver() {
  const channelBadgeVersions = new Map()
  const kickChannelBadgeVersions = new Map()
  const twitchBadgeUrls = new Map()
  const kickBadgeUrls = new Map()
  const { resolveBadgeImageUrl } = new Function(
    'channelBadgeVersions',
    'kickChannelBadgeVersions',
    'twitchBadgeUrls',
    'kickBadgeUrls',
    `${combinedSrc}\nreturn { findNearestChannelBadgeVersion, findNearestKickBadgeVersion, resolveBadgeImageUrl }`,
  )(channelBadgeVersions, kickChannelBadgeVersions, twitchBadgeUrls, kickBadgeUrls)
  return { resolveBadgeImageUrl, channelBadgeVersions, kickChannelBadgeVersions, twitchBadgeUrls, kickBadgeUrls }
}

describe('resolveBadgeImageUrl — badge fallback selection, loaded vs unloaded state', () => {
  test('unloaded state (the initial backfill race): no maps populated yet → null (renderer falls back to TEXT chip)', () => {
    const { resolveBadgeImageUrl } = makeResolver()
    expect(resolveBadgeImageUrl(false, 'shroud', 'moderator', '1')).toBeNull()
  })

  test('loaded state, global-only: no channel-specific override yet, global "/1" star resolves', () => {
    const { resolveBadgeImageUrl, twitchBadgeUrls } = makeResolver()
    twitchBadgeUrls.set('moderator/1', 'https://cdn.twitch/mod.png')
    expect(resolveBadgeImageUrl(false, 'shroud', 'moderator', '1')).toBe('https://cdn.twitch/mod.png')
  })

  test('loaded state, channel-specific exact match wins over the global fallback', () => {
    const { resolveBadgeImageUrl, twitchBadgeUrls } = makeResolver()
    twitchBadgeUrls.set('moderator/1', 'https://cdn.twitch/mod-global.png')
    twitchBadgeUrls.set('shroud:moderator/1', 'https://cdn.twitch/mod-ffz-override.png')
    expect(resolveBadgeImageUrl(false, 'shroud', 'moderator', '1')).toBe('https://cdn.twitch/mod-ffz-override.png')
  })

  test('channel-specific nearest-tier sub badge: exact 5mo missing, channel only defines 0/3/6 → picks 3', () => {
    const { resolveBadgeImageUrl, twitchBadgeUrls, channelBadgeVersions } = makeResolver()
    channelBadgeVersions.set('shroud:subscriber', [0, 3, 6])
    twitchBadgeUrls.set('shroud:subscriber/0', 'https://cdn.twitch/sub0.png')
    twitchBadgeUrls.set('shroud:subscriber/3', 'https://cdn.twitch/sub3.png')
    twitchBadgeUrls.set('shroud:subscriber/6', 'https://cdn.twitch/sub6.png')
    expect(resolveBadgeImageUrl(false, 'shroud', 'subscriber', '5')).toBe('https://cdn.twitch/sub3.png')
  })

  test('nearest-tier never crosses a sub tier boundary (2xxx vs 3xxx)', () => {
    const { resolveBadgeImageUrl, twitchBadgeUrls, channelBadgeVersions } = makeResolver()
    channelBadgeVersions.set('shroud:subscriber', [1999, 3000])
    twitchBadgeUrls.set('shroud:subscriber/1999', 'https://cdn.twitch/t1.png')
    twitchBadgeUrls.set('shroud:subscriber/3000', 'https://cdn.twitch/t2.png')
    // version 3005 (tier 2) must not fall back to the tier-1 1999 entry
    expect(resolveBadgeImageUrl(false, 'shroud', 'subscriber', '3005')).toBe('https://cdn.twitch/t2.png')
  })

  test('global exact match used when there is no channel entry at all', () => {
    const { resolveBadgeImageUrl, twitchBadgeUrls } = makeResolver()
    twitchBadgeUrls.set('vip/1', 'https://cdn.twitch/vip.png')
    expect(resolveBadgeImageUrl(false, 'someRandomChannel', 'vip', '1')).toBe('https://cdn.twitch/vip.png')
  })

  test('Kick: unloaded → null (never falls through to a Twitch URL, even if one exists for the same name/version)', () => {
    const { resolveBadgeImageUrl, twitchBadgeUrls } = makeResolver()
    twitchBadgeUrls.set('subscriber/1', 'https://cdn.twitch/would-be-wrong-tier.png')
    expect(resolveBadgeImageUrl(true, 'xqc', 'subscriber', '1')).toBeNull()
  })

  test('Kick: loaded, exact month match', () => {
    const { resolveBadgeImageUrl, kickBadgeUrls } = makeResolver()
    kickBadgeUrls.set('xqc:subscriber/3', 'https://cdn.kick/sub3.png')
    expect(resolveBadgeImageUrl(true, 'xqc', 'subscriber', '3')).toBe('https://cdn.kick/sub3.png')
  })

  test('Kick: loaded, nearest-lower month when the exact month is missing', () => {
    const { resolveBadgeImageUrl, kickBadgeUrls, kickChannelBadgeVersions } = makeResolver()
    kickChannelBadgeVersions.set('xqc:subscriber', [1, 3, 6, 12])
    kickBadgeUrls.set('xqc:subscriber/1', 'https://cdn.kick/sub1.png')
    kickBadgeUrls.set('xqc:subscriber/3', 'https://cdn.kick/sub3.png')
    expect(resolveBadgeImageUrl(true, 'xqc', 'subscriber', '5')).toBe('https://cdn.kick/sub3.png')
  })

  test('Kick: no channel given → null (never a bare-global Kick lookup)', () => {
    const { resolveBadgeImageUrl } = makeResolver()
    expect(resolveBadgeImageUrl(true, null, 'subscriber', '1')).toBeNull()
  })
})

// ── source-level regression guards ──────────────────────────────────────────
// Pin the actual wiring, not just the primitives above — this is what
// actually prevents the bug in production.
describe('badge refresh mechanism — structural invariants', () => {
  test('fetchKickChannelBadges patches already-rendered rows on resolve (the exact gap that caused the bug)', () => {
    const fnStart = SRC.indexOf('async function fetchKickChannelBadges(')
    expect(fnStart).toBeGreaterThan(-1)
    const fnEnd = SRC.indexOf('\nfunction resolveBadgeImageUrl', fnStart)
    const body = SRC.slice(fnStart, fnEnd)
    expect(body).toContain('updateNativeBadgesInPlace(slug)')
  })

  test('renderBadges and the shared resolver stay in sync: renderBadges delegates to resolveBadgeImageUrl rather than re-implementing the priority chain', () => {
    const fnStart = SRC.indexOf('function renderBadges(')
    expect(fnStart).toBeGreaterThan(-1)
    // Slice to the next top-level function, not a fixed character budget — a
    // fixed window measures comment length, so adding a comment inside
    // renderBadges used to "break" an invariant about its code.
    const fnEnd = SRC.indexOf('\nfunction renderThirdPartyBadges', fnStart)
    expect(fnEnd).toBeGreaterThan(fnStart)
    const body = SRC.slice(fnStart, fnEnd)
    expect(body).toContain('resolveBadgeImageUrl(isKick, channel, name, version)')
  })
})

describe('badge refresh mechanism — cosmetics.js in-place patch covers cached (inactive) tabs too', () => {
  // updateNativeBadgesInPlace / _patchBadgesInRoot moved to cosmetics.js (split out of main.js)
  const COSMETICS_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'cosmetics.js'), 'utf8')

  test('updateNativeBadgesInPlace patches the live DOM AND every _tabCache fragment, not just the active tab', () => {
    const fnStart = COSMETICS_SRC.indexOf('function updateNativeBadgesInPlace(')
    expect(fnStart).toBeGreaterThan(-1)
    const fnEnd = COSMETICS_SRC.indexOf('\n  }', fnStart)
    const body = COSMETICS_SRC.slice(fnStart, fnEnd)
    expect(body).toContain('_patchBadgesInRoot(msgsEl, channelLogin)')
    expect(body).toContain('_tabCache.values()')
    expect(body).toContain('_patchBadgesInRoot(cache.frag, channelLogin)')
  })

  test('_patchBadgesInRoot and cosmetics.js also delegate to the shared resolveBadgeImageUrl (no duplicated priority chain left behind)', () => {
    const fnStart = COSMETICS_SRC.indexOf('function _patchBadgesInRoot(')
    expect(fnStart).toBeGreaterThan(-1)
    const fnEnd = COSMETICS_SRC.indexOf('\n  }', fnStart)
    const body = COSMETICS_SRC.slice(fnStart, fnEnd)
    expect(body).toContain('resolveBadgeImageUrl(isKick, ch, name, version)')
  })
})

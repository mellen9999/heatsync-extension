/**
 * One "went live" per streamer, not per platform (chrome/background.js).
 *
 * The server merges a simulcast into one /api/live/following card and names its
 * primary by the biggest audience on every request, and it pushes twitch and
 * kick go-lives separately. Keyed per platform, that meant a desktop
 * notification each time audiences crossed and two for every twitch+kick
 * go-live. Same extractFn harness as background-helpers.test.js: the real
 * source, evaluated in isolation, failing loudly if a marker drifts.
 */

import { describe, expect, test } from 'bun:test'
import { bgSource } from './bg-src.js'

const BG_SRC = bgSource()

function extractFn(name) {
  const start = BG_SRC.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`extractFn: "${name}" not found in chrome/background.js`)
  const end = BG_SRC.indexOf('\n}', start)
  if (end === -1) throw new Error(`extractFn: "${name}" has no closing brace`)
  return BG_SRC.slice(start, end + 2)
}

function extractConstLine(name) {
  const m = BG_SRC.match(new RegExp(`^const ${name}\\s*=.*$`, 'm'))
  if (!m) throw new Error(`extractConstLine: "${name}" not found in chrome/background.js`)
  return m[0]
}

const { liveLegKeys, samePersonKeys, liveTransitions, pushedGoLive, LIVE_NOTIFY_THROTTLE_MS } = new Function(
  [
    extractConstLine('LIVE_NOTIFY_THROTTLE_MS'),
    extractConstLine('LIVE_PLATFORMS'),
    ...['liveLegKeys', 'samePersonKeys', 'liveTransitions', 'pushedGoLive'].map(extractFn),
    'return { liveLegKeys, samePersonKeys, liveTransitions, pushedGoLive, LIVE_NOTIFY_THROTTLE_MS }',
  ].join('\n'),
)()

const fresh = () => ({ lastSeenLive: {}, lastNotifiedAt: {}, peers: {} })
const card = (platform, username, viewerCount, platformUsernames, extra = {}) => ({
  platform,
  username,
  viewerCount,
  platformUsernames,
  ...extra,
})
const names = (r) => r.transitions.map((t) => `${t.platform}:${t.username}`)

describe('liveLegKeys', () => {
  test('primary first, then the other platforms and second accounts', () => {
    const c = card(
      'twitch',
      'ZackRawrr',
      9,
      { twitch: 'zackrawrr', kick: 'Asmongold' },
      {
        secondaryLegs: [{ platform: 'twitch', username: 'asmongold' }],
      },
    )
    expect(liveLegKeys(c)).toEqual(['twitch:zackrawrr', 'kick:asmongold', 'twitch:asmongold'])
  })

  test('hostile shapes are dropped, never thrown on', () => {
    expect(liveLegKeys(null)).toEqual([])
    expect(liveLegKeys(card('myspace', 'x', 1))).toEqual([])
    const bad = card('kick', 'k', 1, { youtube: 9, twitch: 'x'.repeat(101), kick: '' }, { secondaryLegs: 'no' })
    expect(liveLegKeys(bad)).toEqual(['kick:k'])
    const many = Array.from({ length: 50 }, (_, i) => ({ platform: 'kick', username: `k${i}` }))
    expect(liveLegKeys(card('twitch', 't', 1, {}, { secondaryLegs: many })).length).toBe(8)
  })
})

describe('liveTransitions (the poll)', () => {
  test('the first poll is the baseline', () => {
    const st = fresh()
    expect(names(liveTransitions([card('twitch', 'a', 5)], st, 1e9, true))).toEqual([])
    expect(st.lastSeenLive['twitch:a']).toBe(true)
  })

  test('a new card on two platforms is one go-live, on its primary', () => {
    const st = fresh()
    liveTransitions([], st, 1e9, true)
    const r = liveTransitions([card('kick', 'xqc', 50, { twitch: 'xqc', kick: 'xqc' })], st, 1e9, false)
    expect(names(r)).toEqual(['kick:xqc'])
    expect(st.lastNotifiedAt['twitch:xqc']).toBe(1e9)
  })

  test('the primary changing hands as audiences cross is no news', () => {
    const st = fresh()
    liveTransitions([card('twitch', 'tbp', 900, { twitch: 'tbp', kick: 'tbp' })], st, 1e9, true)
    const r = liveTransitions([card('kick', 'tbp', 950, { kick: 'tbp', twitch: 'tbp' })], st, 1e9 + 120e3, false)
    expect(names(r)).toEqual([])
  })

  test('a youtube simulcast joining a live twitch card is no news', () => {
    const st = fresh()
    liveTransitions([card('twitch', 'esfandtv', 9000)], st, 1e9, true)
    const r = liveTransitions([card('twitch', 'esfandtv', 9500, { youtube: 'EsfandTV' })], st, 1e9 + 120e3, false)
    expect(names(r)).toEqual([])
    expect(st.peers['youtube:esfandtv']).toEqual(['twitch:esfandtv', 'youtube:esfandtv'])
  })

  test('off, then live again after the throttle, is news; inside it is not', () => {
    const st = fresh()
    const t0 = 1e9
    liveTransitions([], st, t0, true)
    liveTransitions([card('twitch', 'a', 5)], st, t0, false)
    const gone = liveTransitions([], st, t0 + 60e3, false)
    for (const k of Object.keys(st.lastSeenLive)) if (!gone.seen.has(k)) delete st.lastSeenLive[k]
    expect(names(liveTransitions([card('kick', 'a', 5)], st, t0 + 120e3, false))).toEqual([])
    delete st.lastSeenLive['kick:a']
    const later = t0 + LIVE_NOTIFY_THROTTLE_MS + 1
    expect(names(liveTransitions([card('twitch', 'a', 5)], st, later, false))).toEqual(['twitch:a'])
  })
})

describe('pushedGoLive (the socket)', () => {
  test('a kick push for someone the twitch push already announced: no second notification', () => {
    const st = fresh()
    const first = pushedGoLive('twitch:tbp', st, 1e9)
    expect(first).toMatchObject({ peerLive: false, notify: true })
    st.lastSeenLive['twitch:tbp'] = true
    for (const k of first.person) st.lastNotifiedAt[k] = 1e9
    expect(pushedGoLive('kick:tbp', st, 1e9 + 5e3)).toMatchObject({ peerLive: true, notify: false })
  })

  test("divergent handles are one person through the last poll's card", () => {
    const st = fresh()
    liveTransitions([card('twitch', 'zackrawrr', 9, { kick: 'asmongold' })], st, 1e9, true)
    expect(pushedGoLive('kick:asmongold', st, 1e9 + 5e3)).toMatchObject({ peerLive: true, notify: false })
    expect(samePersonKeys('kick:asmongold', st.peers)).toContain('twitch:zackrawrr')
  })

  test('an unrelated channel still notifies', () => {
    const st = fresh()
    st.lastSeenLive['twitch:other'] = true
    expect(pushedGoLive('kick:someone', st, 1e9)).toMatchObject({ peerLive: false, notify: true })
  })
})

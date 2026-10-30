import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// The live-dot helpers sit inside main.js's closure — slice their source and run it for real.
const MAIN = readFileSync(new URL('../src/multichat/main.js', import.meta.url), 'utf8')
const a = MAIN.indexOf('const _LIVE_PLATS')
const b = MAIN.indexOf("// Channels we've already surfaced")
if (a < 0 || b < a) throw new Error('live helper markers moved')

function make(sw, polled) {
  return new Function(
    '_swLiveSet',
    'liveChannelSet',
    `${MAIN.slice(a, b)}; return { liveKey, liveSetHas, liveNames, isChannelLive, tabIsLiveFromSets }`,
  )(sw, polled)
}

test('a live twitch name does not light the same-named kick channel', () => {
  const h = make(null, new Set(['twitch:xqc']))
  expect(h.isChannelLive('xqc', 'twitch')).toBe(true)
  expect(h.isChannelLive('xqc', 'kick')).toBe(false)
  expect(h.tabIsLiveFromSets({ id: 'k', kick: 'xqc' })).toBe(false)
})

test('a youtube-only tab lights from the followed-live snapshot', () => {
  const h = make(new Set(['youtube:drdisrespect']), new Set())
  expect(h.tabIsLiveFromSets({ id: 'dr', youtube: 'https://www.youtube.com/@DrDisrespect/live' })).toBe(true)
  expect(h.tabIsLiveFromSets({ id: 'dr', youtube: 'https://www.youtube.com/@someoneelse/live' })).toBe(false)
})

test('liveNames returns one platform bare', () => {
  const h = make(null, new Set(['twitch:a', 'kick:b']))
  expect([...h.liveNames(new Set(['twitch:a', 'kick:b']), 'kick')]).toEqual(['b'])
})

test('the poll never sends a youtube page channel as a twitch name', () => {
  expect(MAIN).toContain("} else if (hostPlatform === 'twitch' && !twitchAll.some")
})

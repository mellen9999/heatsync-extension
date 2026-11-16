/**
 * The page's channel emote sets: past 20, only a set nothing on the page shows may go.
 *
 * Found on live twitch (s4 e2e, 11-15): 25 saved channels, each twitch one with its kick
 * leg, so ~47 sets arrive at boot. The page dropped the oldest set past 20, the watched
 * stream's among them, and its rows drew 7tv names as text until the set came round again.
 * Runs the real eviction from src/multichat/emote-cache-evict.js.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emote-cache-evict.js'), 'utf8')

function page({ channels, current = '', live = '' }) {
  const channelEmoteCaches = {}
  const { evictChannelEmoteCaches } = new Function(
    'config',
    'channelEmoteCaches',
    'getCurrentChannel',
    'getLiveChannel',
    'getLivePlatformNames',
    `${SRC}\nreturn { evictChannelEmoteCaches }`,
  )(
    { channels },
    channelEmoteCaches,
    () => current,
    () => live,
    () => ({ twitch: live, kick: live, youtube: '' }),
  )
  /** a set landing, the way _buildChannelEmoteCache stores it then evicts */
  const land = (ch) => {
    channelEmoteCaches[ch] = new Map([['x', {}]])
    evictChannelEmoteCaches(ch)
  }
  return { caches: channelEmoteCaches, land }
}

describe('page emote sets past 20', () => {
  test('the stream on screen keeps its set however many others arrive after it', () => {
    const saved = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, twitch: `c${i}`, kick: `c${i}` }))
    const p = page({ channels: [{ id: 'jynxzi', twitch: 'jynxzi', kick: '' }, ...saved], current: 'jynxzi' })
    p.land('jynxzi')
    for (const c of saved) p.land(c.twitch)
    for (let i = 0; i < 30; i++) p.land(`picker-lookup-${i}`)
    expect(p.caches.jynxzi).toBeInstanceOf(Map)
    for (const c of saved) expect(p.caches[c.twitch]).toBeInstanceOf(Map)
  })

  test('sets nothing shows go oldest first, down to 20', () => {
    const p = page({ channels: [{ id: 'a', twitch: 'a' }], current: 'a' })
    p.land('a')
    for (let i = 0; i < 25; i++) p.land(`x${i}`)
    const keys = Object.keys(p.caches)
    expect(keys).toHaveLength(20)
    expect(keys).toContain('a')
    expect(keys).toContain('x24')
    expect(keys).not.toContain('x0')
  })

  test('the set being built is never the one dropped', () => {
    const p = page({ channels: [] })
    for (let i = 0; i < 21; i++) p.land(`x${i}`)
    p.land('x0') // rebuilt in place: still the oldest key
    expect(p.caches.x0).toBeInstanceOf(Map)
    expect(Object.keys(p.caches)).toHaveLength(20)
  })
})

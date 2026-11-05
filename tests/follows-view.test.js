import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const rd = (f) => readFileSync(new URL(`../src/multichat/${f}`, import.meta.url), 'utf8')
const F = new Function(
  `${rd('follows-view.js')}\nreturn { followsAbbrev, followsUptime, followsNormalize, followsWatchUrl }`,
)()

describe('follows view', () => {
  test('viewer counts abbreviate', () => {
    expect(F.followsAbbrev(950)).toBe('950')
    expect(F.followsAbbrev(1500)).toBe('1.5k')
    expect(F.followsAbbrev(12000)).toBe('12k')
    expect(F.followsAbbrev(2_300_000)).toBe('2.3m')
  })
  test('uptime is blank under a minute or unknown, else h/m', () => {
    const now = Date.parse('2026-11-05T12:00:00Z')
    expect(F.followsUptime('', now)).toBe('')
    expect(F.followsUptime('2026-11-05T11:59:30Z', now)).toBe('')
    expect(F.followsUptime('2026-11-05T11:15:00Z', now)).toBe('45m')
    expect(F.followsUptime('2026-11-05T09:46:00Z', now)).toBe('2h14m')
  })
  test('snapshot → rows: most viewers first, junk dropped, bounded', () => {
    const rows = F.followsNormalize([
      { platform: 'twitch', username: 'Small', viewers: 5 },
      { platform: 'kick', username: 'big', viewers: 900, displayName: 'Big', stream: { category: 'Chess' } },
      { platform: 'mixer', username: 'x', viewers: 99 },
      { platform: 'twitch', username: '' },
    ])
    expect(rows.map((r) => r.username)).toEqual(['big', 'small'])
    expect(rows[0].game).toBe('Chess')
    expect(F.followsNormalize(null)).toEqual([])
    const many = Array.from({ length: 800 }, (_, i) => ({ platform: 'twitch', username: `u${i}`, viewers: i }))
    expect(F.followsNormalize(many).length).toBe(500)
  })
  test('watch urls escape the name', () => {
    expect(F.followsWatchUrl({ platform: 'twitch', username: 'a/b' })).toBe('https://www.twitch.tv/a%2Fb')
    expect(F.followsWatchUrl({ platform: 'kick', username: 'x' })).toBe('https://kick.com/x')
  })
  test('wired: snapshot feeds it, a key opens it', () => {
    const main = rd('main.js')
    expect(main).toContain('followsSet(snapshot)')
    expect(main).toContain("registerOverlayKey('f', () => openFollowsView())")
    expect(main).toContain('followsKeyHandler')
  })
})

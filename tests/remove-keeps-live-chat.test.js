/**
 * Removing (or re-pointing) a saved tab never leaves the chat the page's own stream reads.
 * A fresh install saves the first stream it opens; removing that tab parted the stream's
 * twitch/kick room, so the live tab under it sat empty until a rejoin (kick: none, twitch:
 * the 15s tick), 11-17. Found by e2e s16.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mcKickStillShown, mcTwitchStillShown } from '../src/multichat/rejoin.js'

const src = (f) => readFileSync(new URL(`../src/multichat/${f}`, import.meta.url), 'utf8')
const mgmt = src('channel-mgmt.js')
const from = mgmt.indexOf('function mcLeaveUnshown(')
const carved = mgmt.slice(from, mgmt.indexOf('\n}\n', from) + 3)

function page(host, live, names) {
  const parted = []
  const left = []
  const fn = new Function(
    'irc',
    'kickChat',
    'leaveExtraChannel',
    'getLivePlatformNames',
    'getLiveChannel',
    'hostPlatform',
    'mcTwitchStillShown',
    'mcKickStillShown',
    `${carved}\nreturn mcLeaveUnshown`,
  )(
    { part: (n) => parted.push(`twitch:${n}`) },
    { part: (n) => parted.push(`kick:${n}`) },
    (p, n) => left.push(`${p}:${n}`),
    () => names,
    () => live,
    host,
    mcTwitchStillShown,
    mcKickStillShown,
  )
  return { fn, parted, left }
}

test("the kick stream's own saved tab removed: its room stays", () => {
  const p = page('kick', 'maherco', { twitch: 'maherco', kick: 'maherco', youtube: '' })
  p.fn('kick', 'maherco', [])
  expect(p.parted).toEqual([])
})

test("the twitch stream's own saved tab removed: its room stays", () => {
  const p = page('twitch', 'xqc', { twitch: 'xqc', kick: 'xqc', youtube: '' })
  p.fn('twitch', 'xqc', [])
  p.fn('kick', 'xqc', [])
  expect(p.parted).toEqual([])
  expect(p.left).toEqual([])
})

test('a linked leg the live tab reads stays (identity, not the same name)', () => {
  const p = page('twitch', 'nl_kripp', { twitch: 'nl_kripp', kick: 'kripp', youtube: '' })
  p.fn('kick', 'kripp', [])
  expect(p.parted).toEqual([])
})

test('a channel nothing else shows is left', () => {
  const p = page('twitch', 'xqc', { twitch: 'xqc', kick: 'xqc', youtube: '' })
  p.fn('twitch', 'tfue', [{ id: 'a', twitch: 'shroud' }])
  p.fn('kick', 'sasatikk', [])
  expect(p.parted).toEqual(['twitch:tfue', 'kick:sasatikk'])
  expect(p.left).toEqual(['twitch:tfue'])
})

test('another tab still naming it keeps it', () => {
  const p = page('kick', 'other', { twitch: 'other', kick: 'other', youtube: '' })
  p.fn('kick', 'westcol', [{ id: 'w', kick: 'WestCol' }])
  expect(p.parted).toEqual([])
})

test('every part path goes through it: remove, edit, another tab removing', () => {
  const rm = mgmt.slice(mgmt.indexOf('function removeChannel('), mgmt.indexOf('function applyLivePlatformOverrides('))
  expect(rm).toContain("mcLeaveUnshown('twitch', twitchName, config.channels)")
  expect(rm).toContain("mcLeaveUnshown('kick', kickName, config.channels)")
  expect(rm).not.toContain('.part(')
  expect(mgmt).toContain("mcLeaveUnshown('kick', oldKick, others)")
  const storage = src('main-storage.js')
  expect(storage).toContain("mcLeaveUnshown('kick', ch.kick, newChannels)")
  // only the helper (and the clients' own teardown) part a room
  expect(mgmt.match(/\b(irc|kickChat)\?\.part\(/g)?.length).toBe(2)
  expect(storage).not.toMatch(/\b(irc|kickChat)\?\.part\(/)
})

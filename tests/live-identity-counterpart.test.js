/**
 * A simulcaster whose handles diverge (twitch zackrawrr / kick asmongold) is
 * invisible to the same-name guess the live tab joins by default. The
 * counterpart helper is what turns heatsync's verified identity into the
 * handle the tab should join instead — and refuses everything else.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { liveIdentityCounterpart } from '../src/lib/utils.js'

const ok = (twitch, kick) => ({ ok: true, identity: { twitch, kick, youtube: null } })

describe('liveIdentityCounterpart', () => {
  test('twitch page → the verified kick handle when it differs', () => {
    expect(liveIdentityCounterpart('twitch', 'zackrawrr', ok('zackrawrr', 'asmongold'))).toEqual({
      twitch: '',
      kick: 'asmongold',
    })
  })
  test('kick page → the verified twitch handle when it differs', () => {
    expect(liveIdentityCounterpart('kick', 'asmongold', ok('zackrawrr', 'asmongold'))).toEqual({
      twitch: 'zackrawrr',
      kick: '',
    })
  })
  test('same-name identity adds nothing — the guess already stands', () => {
    expect(liveIdentityCounterpart('twitch', 'xqc', ok('xqc', 'xqc'))).toEqual({ twitch: '', kick: '' })
    expect(liveIdentityCounterpart('twitch', 'XQC', ok('xqc', 'XQC'))).toEqual({ twitch: '', kick: '' })
  })
  test('never touches the host platform, never a youtube host', () => {
    expect(liveIdentityCounterpart('twitch', 'a', ok('b', 'c')).twitch).toBe('')
    expect(liveIdentityCounterpart('kick', 'a', ok('b', 'c')).kick).toBe('')
    expect(liveIdentityCounterpart('yt', 'a', ok('b', 'c'))).toEqual({ twitch: '', kick: '' })
  })
  test('a failed or empty lookup is nothing', () => {
    expect(liveIdentityCounterpart('twitch', 'a', { ok: false })).toEqual({ twitch: '', kick: '' })
    expect(liveIdentityCounterpart('twitch', 'a', null)).toEqual({ twitch: '', kick: '' })
    expect(liveIdentityCounterpart('twitch', '', ok('b', 'c'))).toEqual({ twitch: '', kick: '' })
  })
})

describe('live tab wiring', () => {
  const main = readFileSync(join(import.meta.dir, '../src/multichat/main.js'), 'utf8')
  const social = readFileSync(join(import.meta.dir, '../src/multichat/social.js'), 'utf8')
  const mgmt = readFileSync(join(import.meta.dir, '../src/multichat/channel-mgmt.js'), 'utf8')

  test('the live names read override → verified identity → same-name, in that order', () => {
    expect(main).toContain("twitch: overrides?.twitch ?? (identity?.twitch || (sameNameOk ? urlCh : ''))")
    expect(main).toContain("kick: overrides?.kick ?? (identity?.kick || (sameNameOk ? urlCh : ''))")
  })
  test('identity resolution runs on boot, on override apply and on soft nav — not only when youtube is unset', () => {
    expect(main).toContain("if (hostPlatform !== 'yt') autoResolveLiveIdentity()")
    expect(mgmt).toMatch(/\n {2}autoResolveLiveIdentity\(\)/)
    expect(social).toMatch(
      /const names = getLivePlatformNames\(\)\n {2}autoResolveLiveIdentity\(\)\n {2}if \(!names\.youtube\) return/,
    )
  })
  test('an explicit override beats the verified counterpart when re-joining', () => {
    const fn = social.slice(
      social.indexOf('function applyLiveIdentityCounterpart'),
      social.indexOf('async function autoResolveLiveIdentity'),
    )
    expect(fn).toContain('if (!overrides.kick && (next.kick || prev.kick))')
    expect(fn).toContain('if (!overrides.twitch && (next.twitch || prev.twitch))')
  })
  test('the url name is re-joined on the host platform only', () => {
    expect(main).toContain("if (gTwitch && hostPlatform === 'twitch' && urlChFallback && twitchCh !== urlChFallback)")
    expect(main).toContain("if (gKick && hostPlatform === 'kick' && urlChFallback && kickCh !== urlChFallback)")
  })
})

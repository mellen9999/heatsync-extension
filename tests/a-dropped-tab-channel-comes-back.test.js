/**
 * A tab whose twitch channel the page dropped comes back without a refresh.
 *
 * A viewer's nl_kripp tab stopped on its 03:36 line for hours while every other
 * tab kept flowing; a refresh showed the 03:36→06:34 lines it never got
 * (2026-11-14). A tab's feed lives as long as the page's irc holds the channel,
 * and nothing ever joined a dropped channel again. Now:
 * - main.js rejoins any channel a saved tab (or the page) still shows, every 15s;
 * - a config change does not part a name another tab or the page still shows;
 * - the join-failed toast says it once, not every rejoin round.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mcDroppedTwitch, mcTwitchStillShown } from '../src/multichat/rejoin.js'

const src = (f) => readFileSync(new URL(`../src/multichat/${f}`, import.meta.url), 'utf8')

describe('which channels are missing', () => {
  const tabs = [
    { id: 'a', twitch: 'NL_Kripp' },
    { id: 'b', twitch: 'elquaria', kick: 'elquaria' },
    { id: 'c', kick: 'x' },
  ]

  test('a saved tab the page no longer holds', () => {
    expect(mcDroppedTwitch(tabs, new Set(['elquaria']))).toEqual(['nl_kripp'])
  })

  test('nothing when everything is held', () => {
    expect(mcDroppedTwitch(tabs, new Set(['nl_kripp', 'elquaria']))).toEqual([])
  })

  test('the page channel counts, once, and blanks are ignored', () => {
    expect(mcDroppedTwitch(tabs, new Set(['nl_kripp']), ['xrohat', 'elquaria', null, ''])).toEqual([
      'elquaria',
      'xrohat',
    ])
  })

  test('kick-only and malformed entries are skipped', () => {
    expect(mcDroppedTwitch([{ kick: 'x' }, null, { twitch: 5 }, { twitch: '  ' }], new Set())).toEqual([])
    expect(mcDroppedTwitch(undefined, new Set())).toEqual([])
  })
})

describe('a name still shown elsewhere', () => {
  test('another tab with the same twitch name', () => {
    expect(mcTwitchStillShown('NL_Kripp', [{ id: 'tab-1', twitch: 'nl_kripp' }])).toBe(true)
  })

  test('the page channel', () => {
    expect(mcTwitchStillShown('ohnepixel', [], ['OhnePixel'])).toBe(true)
  })

  test('nobody else', () => {
    expect(mcTwitchStillShown('nl_kripp', [{ twitch: 'elquaria' }], ['xrohat', null])).toBe(false)
    expect(mcTwitchStillShown('', [{ twitch: '' }])).toBe(false)
  })
})

describe('wired in', () => {
  test('main.js rejoins dropped channels on a 15s tick behind the twitch switch', () => {
    const main = src('main.js')
    const at = main.indexOf('mcDroppedTwitch(config.channels, irc.channels')
    expect(at).toBeGreaterThan(-1)
    const tick = main.slice(main.lastIndexOf('cleanup.setInterval', at), main.indexOf('15000)', at) + 6)
    expect(tick).toContain("isEnabled('irc-twitch')")
    expect(tick).toContain('irc.join(tw)')
  })

  test('the config-change part checks the name is not still shown', () => {
    const storage = src('main-storage.js')
    expect(storage).toContain('!mcTwitchStillShown(twitchName, newChannels, page)) irc?.part(twitchName)')
    expect(storage).not.toMatch(/if \(twitchName\) irc\?\.part\(twitchName\)/)
  })

  test('the join-failed toast is said once per channel until a join lands', () => {
    const irc = src('irc.js')
    expect(irc).toContain('this._joinFailSaid = new Set()')
    expect(irc).toContain('if (!this._joinFailSaid.has(ch))')
    expect(irc).toContain('this._joinFailSaid.delete(ch)')
  })

  test('rejoin.js ships in the multichat bundle', () => {
    expect(readFileSync(new URL('../build.js', import.meta.url), 'utf8')).toContain("'rejoin.js',")
  })
})

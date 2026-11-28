// A chatter with no colour of their own draws the heatsync name-palette colour, hashed from the
// login: the same colour on heatsync.org, the desktop app and here (site e34f16469, desktop irc.rs).
// 46% of twitch lines have no colour tag; they were flat white, and kick's were kick green.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseIrcLine } from '../src/multichat/irc.js'
import { hsRowNameColour, hsUsernameColor } from '../src/multichat/paints.js'
import { bgSource } from './bg-src.js'
import { SITE_MISSING, siteDir, siteRequired } from './site-dir.js'

const SITE = siteDir('client/utils/color-utils.js')

describe('the palette and the hash are the site byte for byte', () => {
  test.skipIf(!SITE && !siteRequired())('every name hashes to the colour the site gives it', () => {
    if (!SITE) throw new Error(SITE_MISSING)
    const src = readFileSync(join(SITE, 'client/utils/color-utils.js'), 'utf8')
    const palette = src.match(/const _USERNAME_PALETTE = (\[[^\]]+\])/)?.[1]
    const fn = src.match(/export function usernameColor\(username\) \{[\s\S]*?\n\}/)?.[0]
    expect(palette && fn).toBeTruthy()
    const siteColor = new Function(
      `const _USERNAME_PALETTE = ${palette}; ${fn.replace('export ', '')}; return usernameColor`,
    )()
    const names = [
      'mellen',
      'Mellen',
      'a_b',
      'xqc',
      '',
      'ünïcode',
      ...Array.from({ length: 400 }, (_, i) => `chatter_${i * 7919}`),
    ]
    for (const n of names) expect(hsUsernameColor(n)).toBe(siteColor(n))
  })
})

describe('hsRowNameColour: the last rung of the ladder', () => {
  test('a twitch or kick name with no colour gets its palette colour, not white or kick green', () => {
    for (const plat of ['twitch', 'kick']) {
      expect(hsRowNameColour(plat, '', 'someone')).toBe(hsUsernameColor('someone'))
      expect(hsRowNameColour(plat, undefined, 'someone')).toBe(hsUsernameColor('someone'))
    }
  })
  test('a colour they set, even pure white, is honoured', () => {
    expect(hsRowNameColour('twitch', '#ffffff', 'someone')).toBe('#ffffff')
    expect(hsRowNameColour('twitch', '#ff0000', 'someone')).toBe('#ff0000')
    expect(hsRowNameColour('kick', '#53fc18', 'someone')).toBe('#53fc18')
  })
  test('the hash is case-blind, so one login is one colour', () => {
    expect(hsRowNameColour('twitch', '', 'MeLLen')).toBe(hsRowNameColour('twitch', '', 'mellen'))
  })
  test('other platforms are left alone', () => {
    expect(hsRowNameColour('yt', '', 'x')).toBe('')
  })
})

describe('producers pass "no colour" on as no colour', () => {
  beforeEach(() => {
    globalThis.sanitizeColor = (c) => c || '#fff'
    globalThis.t = (k) => k
  })
  afterEach(() => {
    globalThis.sanitizeColor = undefined
    globalThis.t = undefined
  })
  const line = (tags) => `@${tags} :alice!alice@alice.tmi.twitch.tv PRIVMSG #room :hi`
  test('the page irc parser: no color tag → empty, a set one kept', () => {
    expect(parseIrcLine(line('display-name=Alice;id=1'), 'room').color).toBe('')
    expect(parseIrcLine(line('color=;display-name=Alice;id=1'), 'room').color).toBe('')
    expect(parseIrcLine(line('color=#FF0000;display-name=Alice;id=1'), 'room').color).toBe('#FF0000')
    expect(parseIrcLine(line('color=#FFFFFF;display-name=Alice;id=1'), 'room').color).toBe('#FFFFFF')
  })
  test('the background irc parser: same', () => {
    const src = bgSource()
    const start = src.indexOf('const BG_IRC_COLOR_RE')
    expect(start).toBeGreaterThan(-1)
    const re = src.slice(start, src.indexOf('\n', start))
    const fnStart = src.indexOf('function bgIrcNameColor(')
    const fn = src.slice(fnStart, src.indexOf('\n}', fnStart) + 2)
    const name = new Function(`${re}\n${fn}\nreturn bgIrcNameColor`)()
    expect(name(undefined)).toBe('')
    expect(name('')).toBe('')
    expect(name('red; x')).toBe('')
    expect(name('#ffffff')).toBe('#ffffff')
  })
  test('no producer substitutes white or kick green for an absent chat colour', () => {
    const files = ['05-ws.js', '09-irc.js', '10-kick-yt.js']
    const bg = files.map((f) => readFileSync(join(import.meta.dir, '..', 'src/background', f), 'utf8')).join('\n')
    expect(bg).not.toMatch(/color: [^\n]*\|\| '#53fc18'/)
    expect(bg).not.toMatch(/color: bgIrc[^\n]*'#fff'/)
    const irc = readFileSync(join(import.meta.dir, '..', 'src/multichat/irc.js'), 'utf8')
    expect(irc).not.toMatch(/color: sanitizeColor\(tags\.color \|\| '#fff'\)/)
    expect(irc).not.toMatch(/color: d\.color \|\| '#53fc18'/)
  })
})

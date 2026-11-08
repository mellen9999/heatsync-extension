import { describe, expect, test } from 'bun:test'
import { mcLayoutBuild, mcLayoutLink, mcLayoutParse, mcLayoutYtUrl } from '../src/multichat/layout-link.js'

const UC = 'UC1234567890abcdefghijAB'
const t = (o) => ({ twitch: '', kick: '', youtube: '', ...o })

describe('mcLayoutParse', () => {
  test('tabs, simulcast groups, platforms', () => {
    expect(mcLayoutParse('t:xqc,k:xqc+t:asmongold+k:trainwreckstv')).toEqual([
      t({ twitch: 'xqc', kick: 'xqc' }),
      t({ twitch: 'asmongold' }),
      t({ kick: 'trainwreckstv' }),
    ])
  })
  test('accepts full link, path, query and hash', () => {
    expect(mcLayoutParse('https://heatsync.org/m/t:xqc?x=1#a')).toEqual([t({ twitch: 'xqc' })])
    expect(mcLayoutParse('/m/t:xqc')).toEqual([t({ twitch: 'xqc' })])
  })
  test('lowercases names, keeps UC id case, strips @', () => {
    expect(mcLayoutParse(`T:XQC,y:@LofiGirl+y:${UC}`)).toEqual([
      t({ twitch: 'xqc', youtube: 'lofigirl' }),
      t({ youtube: UC }),
    ])
  })
  test('junk dropped, never throws', () => {
    expect(mcLayoutParse('t:bad name+x:foo+nocolon+t:ok')).toEqual([t({ twitch: 'ok' })])
    expect(mcLayoutParse(`t:${'a'.repeat(31)}`)).toEqual([])
    expect(mcLayoutParse(null)).toEqual([])
    expect(mcLayoutParse('%E0%A4%A')).toEqual([])
  })
  test('dedupes identical tabs', () => {
    expect(mcLayoutParse('t:a+t:a+t:b')).toHaveLength(2)
  })
  test('ninth tab dropped', () => {
    const l = Array.from({ length: 9 }, (_, i) => `t:c${i}`).join('+')
    const tabs = mcLayoutParse(l)
    expect(tabs).toHaveLength(8)
    expect(tabs[7].twitch).toBe('c7')
  })
  test('over 400 chars parses to nothing', () => {
    expect(mcLayoutParse('t:a+'.repeat(101))).toEqual([])
  })
})

describe('mcLayoutBuild', () => {
  const yt = (h) => `https://www.youtube.com/@${h}/live`
  test('round trip', () => {
    const chans = [
      { twitch: 'xqc', kick: 'xqc', youtube: '' },
      { twitch: 'a', kick: '', youtube: yt('lofigirl') },
      { twitch: '', kick: '', youtube: mcLayoutYtUrl(UC) },
    ]
    const layout = mcLayoutBuild(chans)
    expect(layout).toBe(`t:xqc,k:xqc+t:a,y:lofigirl+y:${UC}`)
    expect(mcLayoutParse(layout).map((x) => x.twitch || x.kick || x.youtube)).toEqual(['xqc', 'a', UC])
  })
  test('invalid legs and empty tabs skipped', () => {
    expect(mcLayoutBuild([{ twitch: 'Bad Name' }, { twitch: 'ok' }, {}, null])).toBe('t:ok')
    expect(mcLayoutBuild([])).toBe('')
    expect(mcLayoutLink([])).toBe('')
  })
  test('capped at 8 tabs', () => {
    const chans = Array.from({ length: 12 }, (_, i) => ({ twitch: `c${i}` }))
    expect(mcLayoutBuild(chans).split('+')).toHaveLength(8)
  })
  test('tail tabs drop to fit 400', () => {
    const long = (c) => ({ twitch: c.repeat(30), kick: c.repeat(30) })
    const out = mcLayoutBuild([long('a'), long('b'), long('c'), long('d'), long('e'), long('f'), long('g'), long('h')])
    expect(out.length).toBeLessThanOrEqual(400)
    expect(out.startsWith('t:aaaa')).toBe(true)
    expect(mcLayoutParse(out).length).toBeGreaterThan(0)
  })
  test('link has base', () => {
    expect(mcLayoutLink([{ twitch: 'xqc' }])).toBe('https://heatsync.org/m/t:xqc')
  })
})

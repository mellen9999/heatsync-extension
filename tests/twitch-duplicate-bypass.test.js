/**
 * Twitch refuses an identical repeat within 30s (msg_duplicate). The wire gets
 * an invisible U+E0000 suffix on a repeat (toggles), stripped on the way back
 * in. Functions are carved from the real source files.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const IRC = readFileSync(join(ROOT, 'src', 'multichat', 'irc.js'), 'utf8')
const AUTH = readFileSync(join(ROOT, 'src', 'multichat', 'auth-irc.js'), 'utf8')
const INPUT = readFileSync(join(ROOT, 'src', 'multichat', 'input.js'), 'utf8')

function fn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`"${name}" not found`)
  return src.slice(start, src.indexOf('\n}', start) + 2)
}

const T = '\u{E0000}'
const lib = new Function(
  `const DUP_BYPASS_CHAR = '\\u{E0000}'
const DUP_BYPASS_SUFFIX = \` \${DUP_BYPASS_CHAR}\`
${fn(IRC, 'dupBypassWire')}
${fn(IRC, 'stripDupBypass')}
const lastWireByChannel = new Map()
${fn(AUTH, 'twitchWireText')}
const _unkickEmotes = (s) => String(s ?? '')
${fn(INPUT, '_echoTextMatches')}
return { dupBypassWire, stripDupBypass, lastWireByChannel, twitchWireText, _echoTextMatches }`,
)()

// mimic the send path: compute wire, then record it
const send = (ch, text) => {
  const w = lib.twitchWireText(ch, text)
  lib.lastWireByChannel.set(ch, w)
  return w
}

describe('dupBypassWire', () => {
  test('toggles on identical repeats', () => {
    expect(lib.dupBypassWire(undefined, 'hi')).toBe('hi')
    expect(lib.dupBypassWire('hi', 'hi')).toBe(`hi ${T}`)
    expect(lib.dupBypassWire(`hi ${T}`, 'hi')).toBe('hi')
  })
  test('different text is untouched', () => {
    expect(lib.dupBypassWire('hi', 'yo')).toBe('yo')
  })
})

describe('per-channel wire memory', () => {
  test('repeat suffixes, third goes plain, other channel unaffected', () => {
    lib.lastWireByChannel.clear()
    expect(send('a', 'gm')).toBe('gm')
    expect(send('b', 'gm')).toBe('gm')
    expect(send('a', 'gm')).toBe(`gm ${T}`)
    expect(send('a', 'gm')).toBe('gm')
    expect(send('b', 'gm')).toBe(`gm ${T}`)
  })
  test('newlines flattened before comparing', () => {
    lib.lastWireByChannel.clear()
    expect(send('a', 'x\ny')).toBe('x y')
    expect(send('a', 'x\ny')).toBe(`x y ${T}`)
  })
})

describe('stripDupBypass', () => {
  test('strips spaced and bare trailing tag char, only once, only trailing', () => {
    expect(lib.stripDupBypass(`hi ${T}`)).toBe('hi')
    expect(lib.stripDupBypass(`hi${T}`)).toBe('hi')
    expect(lib.stripDupBypass('hi')).toBe('hi')
    expect(lib.stripDupBypass(`${T}hi`)).toBe(`${T}hi`)
    expect(lib.stripDupBypass(`a  ${T}`)).toBe('a ')
  })
})

describe('own echo of a suffixed send still folds', () => {
  test('entry text matches suffixed and stripped echo', () => {
    const entry = { text: 'gm', reply: false }
    expect(lib._echoTextMatches(entry, `gm ${T}`)).toBe(true)
    expect(lib._echoTextMatches(entry, 'gm')).toBe(true)
    expect(lib._echoTextMatches(entry, 'other')).toBe(false)
  })
})

describe('wiring', () => {
  test('parseIrcLine strips before render; both PRIVMSG sends use the helper', () => {
    expect(IRC).toContain('flatStr(stripDupBypass(privmsg[2]))')
    expect(AUTH.match(/twitchWireText\(channel, text\)/g).length).toBe(3)
    expect(AUTH).toContain("'mc_irc_notice_duplicate'")
  })
})

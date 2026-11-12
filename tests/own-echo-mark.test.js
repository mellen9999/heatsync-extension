/**
 * A line is marked as your heatsync send only when it IS yours. peekSentHost
 * matches by text for 24h, so a stranger who types the same words ("gm", "LUL")
 * used to be re-marked to your send host: a kick chatter's line showing [T].
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const INPUT = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
function fn(name) {
  const start = INPUT.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`"${name}" not found`)
  return INPUT.slice(start, INPUT.indexOf('\n}\n', start) + 2)
}

const SELF = { twitch: ['mellen'], kick: ['mellen_k'], youtube: [] }
const make = (names) =>
  new Function(
    'sent',
    'selfNamesFor',
    `const SENT_HOST_WINDOW = 1e12
const _recentSentMessages = sent
const _echoTextMatches = (e, t) => e.text === t
${fn('_notOurLine')}
${fn('_peekSent')}
${fn('peekSentHost')}
${fn('peekOwnSentHost')}
return peekOwnSentHost`,
  )([{ text: 'gm', host: 'twitch', time: Date.now() }], (p) => names[p] || [])
const peek = make(SELF)

test('your own echo keeps the send host', () => {
  expect(peek({ user: 'mellen_k', text: 'gm' }, 'kick')).toBe('twitch')
  expect(peek({ user: 'Mellen', text: 'gm' }, 'twitch')).toBe('twitch')
})

test('a stranger typing the same words is not you', () => {
  expect(peek({ user: 'someoneelse', text: 'gm' }, 'kick')).toBe(null)
  expect(peek({ user: 'someoneelse', text: 'gm' }, 'twitch')).toBe(null)
})

test('no known self name (cross-origin popout) keeps the text-match proof', () => {
  expect(make({})({ user: 'x', text: 'gm' }, 'kick')).toBe('twitch')
})

test('every retag site asks the owned question', () => {
  const sites = ['irc.js', 'main.js'].map((f) =>
    readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8'),
  )
  for (const s of sites)
    expect(
      /\bpeekSentHost\(m(sg)?\.text\)/.test(s.replace(/\/\/.*$/gm, '').replace(/&& !!peekSentHost\(msg\.text\)/g, '')),
    ).toBe(false)
})

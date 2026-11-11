/**
 * Legs that share a send id are one send, at any distance; legs with different
 * send ids never fold; legs with no send id keep the by-name rule.
 */
import { afterAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MC = join(import.meta.dir, '..', 'src', 'multichat')
const IRC = readFileSync(join(MC, 'irc.js'), 'utf8')
const fn = (src, name) => {
  const start = src.indexOf(`function ${name}(`)
  return src.slice(start, src.indexOf('\n}\n', start) + 2)
}
const SELF = { twitch: ['mellen'], kick: ['mellen_k'], youtube: [] }
globalThis.stripDupBypass = new Function(`const DUP_BYPASS_CHAR = '\\u{E0000}'
${fn(IRC, 'stripDupBypass')}
return stripDupBypass`)()
globalThis._unkickEmotes = (s) => String(s ?? '').replace(/\[emote:\d+:([^\]]+)\]/g, '$1')
globalThis.isSelf = (m, p) => (SELF[p] || []).includes(String(m.user || '').toLowerCase())
globalThis.platformMark = (await import('../src/lib/palette.js')).platformMark
globalThis.safeSendMessage = () => Promise.resolve({ origins: [] })
const origins = await import('../src/multichat/hs-origins.js')
globalThis.hsOriginStamp = origins.hsOriginStamp
const lib = await import('../src/multichat/merged-tab.js')
afterAll(() => {
  for (const k of ['stripDupBypass', '_unkickEmotes', 'isSelf', 'platformMark', 'safeSendMessage', 'hsOriginStamp'])
    delete globalThis[k]
})

const T0 = 1_700_000_000_000
let n = 0
const row = (platform, user, text, dt, sendId) => {
  const id = `sid-${++n}`
  if (sendId) origins.hsOriginNote(platform, id, sendId)
  return { platform, user, text, time: T0 + dt, id, channel: 'room' }
}
const shown = (msgs) => lib.foldSimulcastLegs(msgs).map((m) => `${m.platform}:${m.text}`)

test('the same send id folds at any distance, whatever the names and words', () => {
  expect(
    shown([row('twitch', 'a', 'one', 0, 'send_1'), row('kick', 'b', 'one (kick form)', 90_000, 'send_1')]),
  ).toEqual(['twitch:one'])
})

test('different send ids never fold, even same words, same name, same second', () => {
  expect(shown([row('twitch', 'mellen', 'gg', 0, 'send_2'), row('kick', 'mellen_k', 'gg', 100, 'send_3')])).toEqual([
    'twitch:gg',
    'kick:gg',
  ])
})

test('rows with no send id keep the by-name rule', () => {
  expect(shown([row('twitch', 'mellen', 'yo', 0), row('kick', 'mellen_k', 'yo', 500)])).toEqual(['twitch:yo'])
  expect(shown([row('twitch', 'mellen', 'yo', 0), row('kick', 'stranger', 'yo', 500)])).toEqual([
    'twitch:yo',
    'kick:yo',
  ])
})

test('one send id on three platforms is one row', () => {
  expect(
    shown([
      row('kick', 'x', 'hey', 0, 'send_4'),
      row('twitch', 'y', 'hey', 30_000, 'send_4'),
      row('youtube', 'z', 'hey', 70_000, 'send_4'),
    ]),
  ).toEqual(['kick:hey'])
})

test('a row with an id and one without fall back to the by-name rule', () => {
  expect(shown([row('twitch', 'mellen', 'mix', 0, 'send_5'), row('kick', 'mellen_k', 'mix', 400)])).toEqual([
    'twitch:mix',
  ])
})

/**
 * One line sent to twitch and kick at once shows once in a merged pane.
 *
 * The desktop app (and the site) send one line to every platform a tab
 * carries. The pane used to fold those legs only when the send was announced
 * to it live (chat:origin_broadcast → isSentEcho); a pane opened after the
 * send, or filled from history, never heard of it and showed the line twice,
 * [T] and [K] (reported 2026-11-11). The fold is now the site's rule, by
 * content: same sender, same words, a platform the row does not stand for
 * yet, within LEG_WINDOW_MS.
 */
import { afterAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MC = join(import.meta.dir, '..', 'src', 'multichat')
const IRC = readFileSync(join(MC, 'irc.js'), 'utf8')

function fn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`"${name}" not found`)
  return src.slice(start, src.indexOf('\n}\n', start) + 2)
}

// merged-tab.js reads these as bundle globals; the real module is imported
// below so the fold runs as shipped (and counts toward coverage)
const SELF = { twitch: ['mellen'], kick: ['mellen_k'], youtube: [] }
globalThis.stripDupBypass = new Function(`const DUP_BYPASS_CHAR = '\\u{E0000}'
${fn(IRC, 'stripDupBypass')}
return stripDupBypass`)()
globalThis._unkickEmotes = (s) => String(s ?? '').replace(/\[emote:\d+:([^\]]+)\]/g, '$1')
globalThis.isSelf = (m, p) => (SELF[p] || []).includes(String(m.user || '').toLowerCase())
const lib = await import('../src/multichat/merged-tab.js')
afterAll(() => {
  for (const k of ['stripDupBypass', '_unkickEmotes', 'isSelf']) delete globalThis[k]
})

const T0 = 1_700_000_000_000
const line = (platform, user, text, dt = 0, extra = {}) => ({ platform, user, text, time: T0 + dt, ...extra })
const shown = (msgs) => lib.foldSimulcastLegs(msgs).map((m) => `${m.platform}:${m.text}`)

test('your line on twitch and kick is one row, whichever names the platforms know you by', () => {
  expect(shown([line('twitch', 'mellen', 'gm chat'), line('kick', 'mellen_k', 'gm chat', 900)])).toEqual([
    'twitch:gm chat',
  ])
})

test('the fold needs no announcement: legs replayed from history fold the same', () => {
  const history = [
    line('twitch', 'mellen', 'one', 0),
    line('kick', 'mellen_k', 'one', 1200),
    line('twitch', 'someone', 'hi', 1500),
    line('twitch', 'mellen', 'two', 60_000),
    line('kick', 'mellen_k', 'two', 60_700),
  ]
  expect(shown(history)).toEqual(['twitch:one', 'twitch:hi', 'twitch:two'])
})

test('three platforms, one row', () => {
  expect(
    shown([line('kick', 'mellen_k', 'yo'), line('twitch', 'mellen', 'yo', 300), line('youtube', 'mellen', 'yo', 2000)]),
  ).toEqual(['kick:yo'])
})

test('what one platform adds to the words does not split the legs', () => {
  const dupMark = 'same again \u{E0000}'
  expect(shown([line('twitch', 'mellen', dupMark), line('kick', 'mellen_k', 'same again', 400)])).toEqual([
    `twitch:${dupMark}`,
  ])
  expect(
    shown([line('kick', 'mellen_k', 'nice [emote:39251:KEKW]'), line('twitch', 'mellen', 'nice KEKW', 400)]),
  ).toEqual(['kick:nice [emote:39251:KEKW]'])
  expect(
    shown([
      line('twitch', 'mellen', '@pal agreed', 0, { replyTo: { user: 'pal' } }),
      line('kick', 'mellen_k', 'agreed', 500, { replyTo: { user: 'pal' } }),
    ]),
  ).toEqual(['twitch:@pal agreed'])
})

test('saying it again on the same platform is a second row', () => {
  expect(shown([line('twitch', 'mellen', 'gg'), line('twitch', 'mellen', 'gg', 1000)])).toEqual([
    'twitch:gg',
    'twitch:gg',
  ])
})

test('a repeat on a platform the row already stands for is a real repeat', () => {
  expect(
    shown([line('twitch', 'mellen', 'gg'), line('kick', 'mellen_k', 'gg', 500), line('kick', 'mellen_k', 'gg', 1500)]),
  ).toEqual(['twitch:gg', 'kick:gg'])
})

test('the same words from someone else, or well apart, stay their own rows', () => {
  expect(shown([line('twitch', 'mellen', 'lol'), line('kick', 'stranger', 'lol', 500)])).toEqual([
    'twitch:lol',
    'kick:lol',
  ])
  expect(shown([line('twitch', 'mellen', 'lol'), line('kick', 'mellen_k', 'lol', lib.LEG_WINDOW_MS + 1)])).toEqual([
    'twitch:lol',
    'kick:lol',
  ])
})

test("a viewer's own simulcast folds too: same name, same words, another platform", () => {
  expect(shown([line('twitch', 'xqc', 'W'), line('kick', 'xqc', 'W', 800)])).toEqual(['twitch:W'])
})

test('the buffers keep every leg: the fold never touches the messages', () => {
  const a = line('twitch', 'mellen', 'keep')
  const b = line('kick', 'mellen_k', 'keep', 300)
  lib.foldSimulcastLegs([a, b])
  expect(b.hidden).toBeUndefined()
  expect(Object.keys(b)).toEqual(['platform', 'user', 'text', 'time'])
})

test('the append path hands a likely leg to the render', () => {
  const rows = [{ _hsMsg: line('twitch', 'mellen', 'gm') }]
  expect(lib.mayBeSimulcastLeg(line('kick', 'mellen_k', 'gm', 700), rows)).toBe(true)
  expect(lib.mayBeSimulcastLeg(line('kick', 'mellen_k', 'other', 700), rows)).toBe(false)
  expect(lib.mayBeSimulcastLeg(line('twitch', 'mellen', 'gm', 700), rows)).toBe(false)
})

/**
 * A send made from the extension is recorded server-side, so every viewer sees [H]
 * and the send counts: ONE send id per user send; twitch is tagged with
 * chat:origin_tag after the socket write succeeded; kick and youtube go browser →
 * platform (not through the server), so their own echo is witnessed with its real
 * message id (POST /api/chat/origins) — only when the echo is provably ours.
 */
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { platformMark } from '../src/lib/palette.js'

const sent = []
globalThis.platformMark = platformMark
globalThis.safeSendMessage = (m) => {
  sent.push(m)
  return Promise.resolve({ ok: true })
}
const lib = await import('../src/multichat/hs-origins.js')
afterAll(() => {
  for (const k of ['platformMark', 'safeSendMessage']) delete globalThis[k]
})
beforeEach(() => {
  sent.length = 0
})

const SEND_ID_RE = /^[A-Za-z0-9-]{1,64}$/ // the server's, record-chat-origin.ts

test('a send id is one fresh token the server accepts', () => {
  const a = lib.hsNewSendId()
  expect(SEND_ID_RE.test(a)).toBe(true)
  expect(lib.hsNewSendId()).not.toBe(a)
})

test('twitch origin_tag: the words, the lowercase login, the send id, through ws_send', () => {
  lib.hsTagTwitchSend('gm chat', 'SomeStreamer', 'abc-123')
  expect(sent).toEqual([
    { type: 'ws_send', data: { type: 'chat:origin_tag', text: 'gm chat', channel: 'somestreamer', sendId: 'abc-123' } },
  ])
})

test('no text or no channel: nothing is sent', () => {
  lib.hsTagTwitchSend('', 'x', 'a')
  lib.hsTagTwitchSend('hi', '', 'a')
  expect(sent).toEqual([])
})

test('witnessing an own kick/youtube echo posts the origin once, with the send id', () => {
  lib.hsWitnessOwnEcho('kick', 'Room', 'k-uuid-1', 'send-1')
  lib.hsWitnessOwnEcho('kick', 'Room', 'k-uuid-1', 'send-1')
  lib.hsWitnessOwnEcho('youtube', 'streamer', 'yt-id-1', 'send-1')
  expect(sent).toEqual([
    {
      type: 'api_fetch',
      path: '/api/chat/origins',
      method: 'POST',
      auth: true,
      body: { platform: 'kick', channel: 'room', message_id: 'k-uuid-1', origin: 'heatsync', send_id: 'send-1' },
    },
    {
      type: 'api_fetch',
      path: '/api/chat/origins',
      method: 'POST',
      auth: true,
      body: { platform: 'youtube', channel: 'streamer', message_id: 'yt-id-1', origin: 'heatsync', send_id: 'send-1' },
    },
  ])
})

test('no message id, no key, or no send id of ours: nothing is posted', () => {
  lib.hsWitnessOwnEcho('kick', 'room', '', 's')
  lib.hsWitnessOwnEcho('youtube', undefined, 'y', 's') // a youtube row with no origins key
  lib.hsWitnessOwnEcho('kick', 'room', 'k2', '') // an echo we did not send
  expect(sent).toEqual([])
})

const read = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')
const INPUT = read('input.js')

test('the composer mints one send id and every leg shares it', () => {
  expect((INPUT.match(/hsNewSendId\(\)/g) || []).length).toBe(1)
  expect(INPUT).toContain(
    'trackSentMessage(restText, _echoHost, _synthId, _echoCount || 1, !!replyState?.msgId, _sendId)',
  )
})

test('twitch is tagged only where the socket write succeeded', () => {
  const tags = [...INPUT.matchAll(/hsTagTwitchSend\(([^)]*)\)/g)].map((m) => m[1])
  expect(tags).toEqual(['restText, twitchName, _sendId', 'restText, targetChannel, _sendId'])
  // dual path: inside `if (twitchSent)`; twitch-only path: inside `if (result === true)`
  expect(INPUT).toMatch(/if \(twitchSent\) hsTagTwitchSend\(restText, twitchName, _sendId\)/)
  const only = INPUT.indexOf('hsTagTwitchSend(restText, targetChannel, _sendId)')
  expect(INPUT.slice(only - 200, only)).toContain('if (result === true) {')
})

test('kick and youtube echoes are witnessed only when provably ours', () => {
  expect(read('main.js')).toMatch(/isSelf\(msg, 'kick'\)[\s\S]{0,200}hsWitnessOwnEcho\('kick'/)
  expect(read('social.js')).toMatch(
    /isSelf\(ytMsg, 'youtube'\)[\s\S]{0,200}hsWitnessOwnEcho\('youtube', ytMsg\.originKey/,
  )
})

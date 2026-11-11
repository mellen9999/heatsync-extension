/**
 * [H] for everyone, live: a line is heatsync-sent when its message id is in the
 * origin set (server seed + live chat:origin). Born [H] when the id is known
 * first, flipped in place when it arrives after the row, never by text, never
 * back to a platform mark.
 */
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { platformMark } from '../src/lib/palette.js'

const asked = []
let reply = { ok: true, origins: [] }
globalThis.platformMark = platformMark
globalThis.safeSendMessage = (m) => {
  asked.push(m)
  return Promise.resolve(reply)
}
const win = new Window()
globalThis.document = win.document
const lib = await import('../src/multichat/hs-origins.js')
const { platformMarkHtml } = await import('../src/lib/palette.js')
afterAll(() => {
  for (const k of ['platformMark', 'safeSendMessage', 'document']) delete globalThis[k]
})

beforeEach(() => {
  asked.length = 0
})

test('an id known before its row arrives: the row is born [H]', () => {
  lib.hsOriginNote('kick', 'k-1', 'send_a')
  const m = { platform: 'kick', id: 'k-1', channel: 'room1', text: 'hi' }
  expect(lib.hsOriginStamp(m)).toBe(true)
  expect(m.hsSendId).toBe('send_a')
})

test('twitch rows carry no platform and still match; yt aliases fold', () => {
  lib.hsOriginNote('twitch', 't-1', '')
  expect(lib.hsOriginStamp({ id: 't-1', channel: 'room2' })).toBe(true)
  lib.hsOriginNote('yt', 'y-1', '')
  expect(lib.hsOriginStamp({ platform: 'youtube', id: 'y-1', channel: 'room3' })).toBe(true)
})

test('never by text, never across platforms', () => {
  lib.hsOriginNote('twitch', 't-2', 's')
  expect(lib.hsOriginStamp({ platform: 'twitch', text: 'same words', channel: 'room4' })).toBe(false)
  expect(lib.hsOriginStamp({ platform: 'kick', id: 't-2', channel: 'room4' })).toBe(false)
  expect(lib.hsOriginStamp({ platform: 'twitch', id: 'other', text: 'same words', channel: 'room4' })).toBe(false)
})

test('an own echo retagged to a host platform still matches by its transport id', () => {
  lib.hsOriginNote('twitch', 't-3', '')
  expect(lib.hsOriginStamp({ platform: 'kick', badgePlatform: 'twitch', id: 't-3', channel: 'room5' })).toBe(true)
})

test('the first row of a channel asks for its seed once; the answer stamps later rows and repaints', async () => {
  reply = {
    ok: true,
    data: {
      origins: [
        { message_id: 'seed-1', origin: 'heatsync', send_id: 'send_s' },
        { message_id: 'seed-2', origin: 'other' },
      ],
    },
  }
  const host = document.createElement('div')
  host.id = 'hs-mc-messages'
  document.body.append(host)
  const row = document.createElement('div')
  row._hsMsg = { platform: 'kick', id: 'seed-1', channel: 'seedroom' }
  row.innerHTML = platformMarkHtml('kick')
  host.append(row)
  lib.hsOriginStamp(row._hsMsg) // first row of seedroom: asks
  lib.hsOriginStamp({ platform: 'kick', id: 'x', channel: 'seedroom' }) // same channel: does not ask again
  await new Promise((r) => setTimeout(r, 0))
  expect(asked).toEqual([{ type: 'api_fetch', path: '/api/chat/origins?platform=kick&channel=seedroom&limit=500' }])
  await new Promise((r) => setTimeout(r, 0))
  expect(row._hsMsg.hsOrigin).toBe(true)
  expect(row.querySelector('.hs-mc-platform-badge').textContent).toBe('[H]')
  expect(lib.hsOriginStamp({ platform: 'kick', id: 'seed-2', channel: 'seedroom' })).toBe(false)
  host.remove()
})

test('a failed seed is retried on a later row, not hammered', async () => {
  reply = { ok: false, error: 'offline' }
  lib.hsOriginStamp({ platform: 'kick', id: 'a', channel: 'flaky' })
  await new Promise((r) => setTimeout(r, 0))
  lib.hsOriginStamp({ platform: 'kick', id: 'b', channel: 'flaky' })
  await new Promise((r) => setTimeout(r, 0))
  expect(asked).toHaveLength(1)
})

test('a live origin flips the row on screen in place, and no other row', () => {
  const host = document.createElement('div')
  host.id = 'hs-mc-messages'
  document.body.append(host)
  const mk = (id, plat) => {
    const d = document.createElement('div')
    d._hsMsg = { platform: plat, id, channel: 'liveroom' }
    d.innerHTML = platformMarkHtml(plat)
    host.append(d)
    return d
  }
  const a = mk('live-1', 'twitch')
  const b = mk('live-2', 'twitch')
  lib.hsOriginLive({ platform: 'twitch', id: 'live-1', sendId: 'send_l' })
  const pb = a.querySelector('.hs-mc-platform-badge')
  expect(pb.textContent).toBe('[H]')
  expect(pb.className).toContain('hs-mc-pb-heatsync')
  expect(a._hsMsg.hsSendId).toBe('send_l')
  expect(b.querySelector('.hs-mc-platform-badge').textContent).toBe('[T]')
  host.remove()
})

test('the set is bounded', () => {
  for (let i = 0; i < 20_050; i++) lib.hsOriginNote('twitch', `cap-${i}`, '')
  expect(lib.hsOriginStamp({ id: 'cap-0', channel: 'caproom' })).toBe(false)
  expect(lib.hsOriginStamp({ id: 'cap-20049', channel: 'caproom' })).toBe(true)
})

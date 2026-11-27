// a login cookie that cannot be a session token must not reach heatsync.org as `authenticate`.
// the server refuses a token that is not 20..2000 chars (and every real one is a jwt: three base64url
// parts), answers authentication_failed, and logs a warn. 548 of those landed on prod in five days; every
// one was headless chrome running this extension under a test harness whose fake `auth` cookie
// ("harnessauth0000") the worker sent as-is. the socket joins as a viewer instead, like it does with no cookie.

import { afterEach, describe, expect, test } from 'bun:test'
import { bootSw, disposeAll, tabSender } from './harness/sw.js'

afterEach(disposeAll)

const TAB_URL = 'https://www.twitch.tv/kripp'
const twitchTab = tabSender(7, TAB_URL)
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjEyMyJ9.c2lnbmF0dXJlLWJ5dGVzLWhlcmU'
const sent = (ws, type) => ws.frames.filter((f) => f.type === type)

async function connectWith(value) {
  const cookies = value === undefined ? [] : [{ name: 'auth', value, domain: 'heatsync.org' }]
  const sw = await bootSw({ cookies, tabs: [{ id: 7, url: TAB_URL }] })
  await sw.advance(5_001)
  const ws = await sw.connect()
  await sw.advance(500)
  return { sw, ws }
}

describe('a cookie that is not a session token', () => {
  const NOT_TOKENS = {
    'the harness placeholder': 'harnessauth0000',
    'a short value': 'tok-1',
    'the string "undefined"': 'undefined',
    'the string "null"': 'null',
    'a doubled Bearer prefix': `Bearer Bearer ${JWT}`,
    'a whole cookie header': `auth=${JWT}; theme=dark`,
    'a jwt with a part missing': 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjEyMyJ9',
    'a jwt over 2000 chars': `${JWT}${'a'.repeat(2000)}`,
  }

  for (const [name, value] of Object.entries(NOT_TOKENS)) {
    test(`${name} is never sent as authenticate`, async () => {
      const { ws } = await connectWith(value)
      expect(sent(ws, 'authenticate')).toEqual([])
    })
  }

  test('the socket still works as a viewer: rooms are joined and a queued frame goes out', async () => {
    const { sw, ws } = await connectWith('harnessauth0000')
    await sw.send({ type: 'join_channel', platform: 'twitch', channel: 'kripp', channelId: '1' }, twitchTab)
    await sw.advance(500)
    expect(sent(ws, 'authenticate')).toEqual([])
    expect(sent(ws, 'channel:join')).toEqual([{ type: 'channel:join', platform: 'twitch', channel: 'kripp' }])
    expect(sent(ws, 'feed:join').length).toBeGreaterThan(0)
  })
})

describe('a session token', () => {
  test('is sent as authenticate, right after the heartbeat', async () => {
    const { ws } = await connectWith(JWT)
    expect(ws.frames.slice(0, 2)).toEqual([{ type: 'presence:heartbeat' }, { type: 'authenticate', token: JWT }])
  })

  test('is still sent at the server bounds: 20 and 2000 chars yes, 19 chars no', async () => {
    const big = `${JWT}${'a'.repeat(2000 - JWT.length)}`
    const small = 'aaaaaa.bbbbbb.cccccc'
    expect(big).toHaveLength(2000)
    expect(small).toHaveLength(20)
    expect(sent((await connectWith(big)).ws, 'authenticate')).toEqual([{ type: 'authenticate', token: big }])
    disposeAll()
    expect(sent((await connectWith(small)).ws, 'authenticate')).toEqual([{ type: 'authenticate', token: small }])
    disposeAll()
    expect(sent((await connectWith('aaaaaa.bbbbbb.ccccc')).ws, 'authenticate')).toEqual([])
  })
})

test('with no cookie there is no authenticate (unchanged)', async () => {
  const { ws } = await connectWith(undefined)
  expect(sent(ws, 'authenticate')).toEqual([])
})

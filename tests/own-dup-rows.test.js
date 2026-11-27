/**
 * One send to twitch + kick is ONE row, whatever order the legs land in. The kick leg
 * stamps whole seconds and a lagging relay parks it at the visual "now" (liveOrd), so it can
 * sit far below its twitch copy in the merged list. The fold must find it by time, not by
 * how many rows happen to lie between them.
 */
import { afterAll, expect, test } from 'bun:test'

globalThis.stripDupBypass = (s) => s
globalThis._unkickEmotes = (s) => s
globalThis.isSelf = (m) => String(m.user).toLowerCase() === 'mellen'
globalThis.platformMark = (await import('../src/lib/palette.js')).platformMark
globalThis.safeSendMessage = () => Promise.resolve({ origins: [] })
const origins = await import('../src/multichat/hs-origins.js')
globalThis.hsOriginStamp = origins.hsOriginStamp
const lib = await import('../src/multichat/merged-tab.js')
afterAll(() => {
  for (const k of ['stripDupBypass', '_unkickEmotes', 'isSelf', 'platformMark', 'safeSendMessage', 'hsOriginStamp'])
    delete globalThis[k]
})

const T = 1_795_794_078_000
const kick = {
  platform: 'kick',
  user: 'mellen',
  text: 'dongblob how you doin',
  time: T,
  id: 'k-a9495cd8',
  channel: 'nl_kripp',
}
const twitch = { user: 'mellen', text: 'dongblob how you doin', time: T + 391, id: 't-bf2e207f', channel: 'nl_kripp' }
const chatter = (i) => ({ user: `u${i}`, text: `msg ${i}`, time: T + 100 + i, id: `c-${i}`, channel: 'nl_kripp' })
const crowd = (n) => Array.from({ length: n }, (_, i) => chatter(i))
const count = (rows) => rows.filter((m) => m.text === 'dongblob how you doin').length

test('kick leg parked far below the twitch leg still folds (no send id known yet)', () => {
  expect(count(lib.foldSimulcastLegs([twitch, ...crowd(150), kick]))).toBe(1)
})

test('same, twitch leg parked far below the kick leg', () => {
  expect(count(lib.foldSimulcastLegs([kick, ...crowd(150), twitch]))).toBe(1)
})

test('a stranger typing the same words still shows', () => {
  const stranger = { ...kick, user: 'someone', id: 'k-s' }
  expect(count(lib.foldSimulcastLegs([twitch, ...crowd(150), stranger]))).toBe(2)
})

test('the same words long after are a new line', () => {
  const later = { ...kick, time: T + 60_000, id: 'k-later' }
  expect(count(lib.foldSimulcastLegs([twitch, ...crowd(150), later]))).toBe(2)
})

test('the append gate sees a leg far up the pane', () => {
  const els = [twitch, ...crowd(150)].map((m) => ({ _hsMsg: m }))
  expect(lib.mayBeSimulcastLeg(kick, els)).toBe(true)
})

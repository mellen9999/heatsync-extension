import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { userKey } from '../src/lib/user-key.js'

const MAIN = readFileSync(new URL('../src/multichat/main.js', import.meta.url), 'utf8')
const a = MAIN.indexOf('function setKnownColor(')
const b = MAIN.indexOf('// Live username-color sync')
if (a < 0 || b < a) throw new Error('setKnownColor markers moved')

function make() {
  const knownUserIds = new Map()
  const fn = new Function(
    'knownUserIds',
    'knownColors',
    '_nativeTwitchColor',
    '_isUnsetWhite',
    'currentUsername',
    'userKey',
    'recolorOwnLines',
    'persistOwnColor',
    `${MAIN.slice(a, b)}; return setKnownColor`,
  )(
    knownUserIds,
    new Map(),
    new Set(),
    () => false,
    'me',
    userKey,
    () => {},
    () => {},
  )
  return { fn, knownUserIds }
}

test('a kick line never files its numeric kick id as a twitch id', () => {
  const { fn, knownUserIds } = make()
  fn('alice', '#fff', '987654', 'kick')
  expect(knownUserIds.has('kick:alice')).toBe(false)
})

test('a twitch line still records its twitch id', () => {
  const { fn, knownUserIds } = make()
  fn('alice', '#ff0000', '123', 'twitch')
  expect(knownUserIds.get('twitch:alice')).toBe('123')
})

test('kick and yt name lookups file the RESOLVED twitch id', () => {
  const cos = readFileSync(new URL('../src/multichat/cosmetics.js', import.meta.url), 'utf8')
  expect(cos).toContain("knownUserIds.set(userKey(key, 'kick'), tid)")
  expect(cos).toContain("knownUserIds.set(userKey(key, 'youtube'), tidStr)")
})

test('7tv cosmetics: profile twitch_id read from data.profile; kick-only links keep their paint', () => {
  const cos = readFileSync(new URL('../src/multichat/cosmetics.js', import.meta.url), 'utf8')
  expect(cos).toContain('resp?.data?.profile')
  expect(cos).toContain('setMcCosmetic(paintUid, { paint: c.paint || null, badge: c.badge || null })')
  expect(cos).toContain("uid.startsWith('yt_') || uid.startsWith('kick_')")
  expect(MAIN).toContain('getMcPaintStyle(uidTwitch || m.hsPaintUid)')
})

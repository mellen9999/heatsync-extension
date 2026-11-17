import { describe, expect, test } from 'bun:test'
import { userSetMatches } from '../src/lib/user-key.js'
import { mainSource } from './main-src.js'

/**
 * A block (or a per-tab /hide) never hid a twitch chatter: the keys are
 * twitch:<name> and twitch chat messages carry no platform, so the lookup asked
 * for the bare name. And it only ever stopped rows not yet drawn: the render pass
 * reuses a row already on screen, so buildMessageDiv's null never reached it. The
 * render filter now drops them with the same predicate, platform defaulted. Proven live by
 * scripts/e2e/s17-mute-block.ts (red on the build before, green after).
 */
const SRC = mainSource()
const s = SRC.indexOf('function isMsgUserDropped(')
const PRED = SRC.slice(s, SRC.indexOf('\nfunction buildMessageDiv', s))

function dropped(blocked, hidden) {
  const b = new Set(blocked)
  const h = new Map(Object.entries(hidden).map(([tab, us]) => [tab, new Set(us)]))
  return new Function('isUserBlocked', 'isUserHiddenInTab', `${PRED}\nreturn isMsgUserDropped`)(
    (u, p) => userSetMatches(b, u, p),
    (u, p, tab) => !!h.get(tab) && userSetMatches(h.get(tab), u, p),
  )
}

describe('who the render pass drops', () => {
  const drop = dropped(['twitch:bob'], { xqc: ['twitch:carol'] })
  test('a blocked author, everywhere', () => {
    expect(drop({ user: 'Bob', platform: 'twitch' }, 'xqc')).toBe(true)
    expect(drop({ user: 'bob', platform: 'twitch' }, 'lirik')).toBe(true)
  })
  test('twitch chat, which carries no platform field, against a twitch:<name> block', () => {
    expect(drop({ user: 'Bob' }, 'xqc')).toBe(true)
    expect(drop({ user: 'carol' }, 'xqc')).toBe(true)
    expect(drop({ user: 'dave' }, 'xqc')).toBe(false)
  })
  test('a blocked actor (a redeem, an emote-set banner)', () => {
    expect(drop({ type: 'stream-event', actor: 'bob', platform: 'twitch' }, 'xqc')).toBe(true)
  })
  test('hidden only in the tab it was hidden in', () => {
    expect(drop({ user: 'carol', platform: 'twitch' }, 'xqc')).toBe(true)
    expect(drop({ user: 'carol', platform: 'twitch' }, 'lirik')).toBe(false)
  })
  test('same name on another platform, and everyone else, stay', () => {
    expect(drop({ user: 'bob', platform: 'kick' }, 'xqc')).toBe(false)
    expect(drop({ user: 'dave', platform: 'twitch' }, 'xqc')).toBe(false)
  })
})

test('the render filter and the row builder use the one predicate', () => {
  expect(SRC).toContain('toRender.filter((m) => !isMsgFiltered(m, _ff) && !isMsgUserDropped(m, id))')
  expect(SRC.slice(SRC.indexOf('function buildMessageDiv('))).toMatch(
    /^function buildMessageDiv\(m, tabId\) \{\n {2}if \(isMsgUserDropped\(m, tabId\)\) return null/,
  )
})

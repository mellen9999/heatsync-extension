/**
 * One line sent from the site to twitch and kick shows as one row, the earliest leg standing for
 * the rest. Kick's copy relays through this extension and usually lands first, so the row was
 * kick's: no twitch mod or sub badge on your own twitch line (mellen, 11-20). The site's fold
 * takes the absorbed leg's badges when the kept row has none; the pane now does the same, and
 * keeps the platform they belong to (a twitch badge resolved as kick's is the wrong picture).
 * View-level like the fold itself: a kick-only view draws kick's own copy with kick's own badges.
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

const SELF = { twitch: ['mellen'], kick: ['mellen'], youtube: [] }
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
const line = (platform, badges, dt = 0) => ({
  platform,
  user: 'mellen',
  channel: 'mellen',
  text: 'gm chat',
  time: T0 + dt,
  badges,
})

test('the kick leg stands; the twitch leg folded into it lends its badges, with their platform', () => {
  const kick = line('kick', '')
  const twitch = line('twitch', 'moderator/1,subscriber/12', 400)
  expect(lib.foldSimulcastLegs([kick, twitch])).toEqual([kick])
  expect(lib.legBadgesOf(kick)).toEqual({ badges: 'moderator/1,subscriber/12', channel: 'mellen', platform: 'twitch' })
  // the buffer's copy is not touched: another view draws kick's line as kick sent it
  expect(kick.badges).toBe('')
})

test('a row with badges of its own keeps them', () => {
  const kick = line('kick', 'og/1')
  lib.foldSimulcastLegs([kick, line('twitch', 'moderator/1', 400)])
  expect(lib.legBadgesOf(kick)).toBeNull()
})

test('a borrow asks for one redraw of the row already drawn, then not again', () => {
  const kick = line('kick', '')
  const twitch = line('twitch', 'moderator/1', 400)
  lib.foldSimulcastLegs([kick])
  expect(lib.legBadgesChanged(kick)).toBe(false)
  lib.foldSimulcastLegs([kick, twitch])
  expect(lib.legBadgesChanged(kick)).toBe(true)
  lib.foldSimulcastLegs([kick, twitch])
  expect(lib.legBadgesChanged(kick)).toBe(false)
})

test('a render with no fold lends nothing', () => {
  const kick = line('kick', '')
  lib.foldSimulcastLegs([kick, line('twitch', 'moderator/1', 400)])
  lib.clearLegBadges()
  expect(lib.legBadgesOf(kick)).toBeNull()
})

test('the row draws the lent badges in their own platform, and the render clears them off a plain view', () => {
  const MSG = readFileSync(join(MC, 'main-messages.js'), 'utf8')
  expect(MSG).toMatch(/const lent = typeof legBadgesOf === 'function' \? legBadgesOf\(m\) : null/)
  expect(MSG).toMatch(/renderBadges\(lent\.badges, lent\.channel, lent\.platform\)/)
  const LIVE = readFileSync(join(MC, 'main-live.js'), 'utf8')
  expect(LIVE).toMatch(
    /if \(mtSrcs\) toRender = foldSimulcastLegs\(toRender\)\n\s*else if \(typeof clearLegBadges === 'function'\) clearLegBadges\(\)/,
  )
  expect(LIVE).toMatch(/legBadgesChanged\(_rm\)/)
  // a copy dropped as a dual-send duplicate is still in the buffer: a render folds it in
  const MAIN = readFileSync(join(MC, 'main.js'), 'utf8')
  expect(MAIN).toContain("if (isSentEcho(msg.text, 'twitch', msg)) return scheduleMergedRender()")
  expect(MAIN).toContain("if (isSentEcho(msg.text, 'kick', msg)) return scheduleMergedRender()")
})

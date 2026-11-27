/**
 * One line sent from the site to twitch and kick shows as one row, the earliest leg standing for
 * the rest. Kick's copy relays through this extension and usually lands first, so the row was
 * kick's: no twitch mod or sub badge on your own twitch line (mellen, 11-20). The site's fold
 * takes the absorbed leg's badges when the kept row has none; the pane now does the same, and
 * keeps the platform they belong to (a twitch badge resolved as kick's is the wrong picture). The
 * same borrow carries the twitch leg's room (folded-send-reads-the-twitch-room.test.js).
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
  expect(lib.legBadgesOf(kick)).toEqual({
    badges: 'moderator/1,subscriber/12',
    room: { channel: 'mellen', platform: 'twitch' },
    channel: 'mellen',
    platform: 'twitch',
  })
  // the buffer's copy is not touched: another view draws kick's line as kick sent it
  expect(kick.badges).toBe('')
})

test("origin-badges: a kick row that stands for your twitch send draws twitch's name colour too", () => {
  const kick = { ...line('kick', ''), color: '#00ff00' }
  const twitch = { ...line('twitch', 'moderator/1,subscriber/12', 400), color: '#ff8700' }
  lib.foldSimulcastLegs([kick, twitch])
  expect(lib.legBadgesOf(kick)).toEqual({
    badges: 'moderator/1,subscriber/12',
    color: '#ff8700',
    room: { channel: 'mellen', platform: 'twitch' },
    channel: 'mellen',
    platform: 'twitch',
  })
  expect(kick.color).toBe('#00ff00')
  // a kick row with badges of its own is offered the twitch ones too: its own may draw nothing
  // (mellen 11-25: data-msg-platform=kick, self, flame only), and the draw uses them only then
  const kick2 = { ...line('kick', 'og/1', 1000), color: '#00ff00' }
  const tw2 = { ...line('twitch', 'moderator/1', 1400), color: '#ff8700' }
  lib.foldSimulcastLegs([kick2, tw2])
  expect(lib.legBadgesOf(kick2)).toEqual({
    badges: 'moderator/1',
    color: '#ff8700',
    room: { channel: 'mellen', platform: 'twitch' },
    channel: 'mellen',
    platform: 'twitch',
  })
  const MSG = readFileSync(join(MC, 'main-messages.js'), 'utf8')
  expect(MSG).toContain('if (lent?.color) hsNameColor = lent.color')
})

test('a twitch row with badges of its own lends nothing to itself; a kick row with its own is offered them', () => {
  const tw = line('twitch', 'moderator/1')
  lib.foldSimulcastLegs([tw, line('kick', 'og/1', 400)])
  expect(lib.legBadgesOf(tw)).toBeNull()
  const kick = line('kick', 'og/1')
  lib.foldSimulcastLegs([kick, line('twitch', 'moderator/1', 400)])
  expect(lib.legBadgesOf(kick)?.badges).toBe('moderator/1')
  const MSG = readFileSync(join(MC, 'main-messages.js'), 'utf8')
  expect(MSG).toContain('if (lent?.badges && !badges)')
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
    /if \(mtSrcs\) toRender = foldSimulcastLegs\(toRender, droppedLegs\)\n\s*else if \(typeof clearLegBadges === 'function'\) clearLegBadges\(\)/,
  )
  expect(LIVE).toMatch(/legBadgesChanged\(_rm\)/)
  // a copy dropped as a dual-send duplicate is still in the buffer: a render folds it in
  const MAIN = readFileSync(join(MC, 'main.js'), 'utf8')
  expect(MAIN).toContain("if (isSentEcho(msg.text, 'twitch', msg)) return scheduleMergedRender()")
  expect(MAIN).toContain("if (isSentEcho(msg.text, 'kick', msg)) return scheduleMergedRender()")
})

// the real case (mellen 11-25, ext 1.7.142): the twitch copy was DROPPED as the dual-send duplicate
// (m.hidden: the retro-fold when kick painted first, or the history replay), and the render folded only
// what was left, so the standing kick row never saw the mod+sub badges to borrow
test('origin-badges: a hidden twitch copy still lends badges + colour to the row that stands', () => {
  const kick = { ...line('kick', ''), color: '#00ff00' }
  const twitch = { ...line('twitch', 'moderator/1,subscriber/12', 1500), color: '#ff8700', hidden: true }
  expect(lib.foldSimulcastLegs([kick], [twitch])).toEqual([kick])
  expect(lib.legBadgesOf(kick)).toEqual({
    badges: 'moderator/1,subscriber/12',
    color: '#ff8700',
    room: { channel: 'mellen', platform: 'twitch' },
    channel: 'mellen',
    platform: 'twitch',
  })
  expect(lib.legBadgesChanged(kick)).toBe(true) // an already-drawn row is asked to repaint
})

test('origin-badges: twitch first then kick, and a twitch copy 3s late, both land on the one row', () => {
  const tw = { ...line('twitch', 'moderator/1,subscriber/12'), color: '#ff8700' }
  const kick = { ...line('kick', '', 200), color: '#00ff00' }
  // twitch earliest: it stands with its own badges, nothing lent
  expect(lib.foldSimulcastLegs([tw, kick])).toEqual([tw])
  expect(lib.legBadgesOf(tw)).toBeNull()
  const k2 = { ...line('kick', '', 10_000), color: '#00ff00' }
  const t2 = { ...line('twitch', 'moderator/1,subscriber/12', 13_000), color: '#ff8700' }
  expect(lib.foldSimulcastLegs([k2, t2])).toEqual([k2])
  expect(lib.legBadgesOf(k2)?.badges).toBe('moderator/1,subscriber/12')
})

test('origin-badges: a hidden copy of somebody else, or of another send, lends nothing', () => {
  const kick = { ...line('kick', ''), color: '#00ff00' }
  const other = { ...line('twitch', 'moderator/1', 400), user: 'stranger', hidden: true }
  const sendA = { ...line('twitch', 'moderator/1', 400), hidden: true, hsSendId: 'a' }
  kick.hsSendId = 'b'
  lib.foldSimulcastLegs([kick], [other, sendA])
  expect(lib.legBadgesOf(kick)).toBeNull()
})

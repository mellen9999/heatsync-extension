/**
 * One send to twitch and kick shows as one row, and the row stands for both legs. The kept leg is
 * the earliest, and kick's copy (it relays through this extension) usually is. The fold already lends
 * that row the twitch leg's badges and name colour; it lends the twitch leg's ROOM too, so the row's
 * words read there: kick's room has no 7tv set (nl_kripp, 11-27), and a typed MANOFSTEEL (a 7tv emote
 * of the twitch room) drew as plain text on the kept kick copy.
 *
 * The one place a row's room is not its own leg's (shared/emote-law.ts, "a line's room"). Anyone's
 * folded send, not only yours. Per render, never on the buffer's object: a kick-only view draws
 * kick's copy as kick sent it, in kick's room.
 *
 * Runs the real fold (merged-tab.js), the real row text (computeMessageText) and the real emote pass
 * (emotes.js).
 */
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as mods from '../src/lib/modifiers.js'
import { EMOTE_TIER_ORDER, escapeHtml, resolveEmoteProviderWinner, unescapeHtml } from '../src/lib/utils.js'
import './emote-rungs-globals.js'
import { mainSource } from './main-src.js'

const MC = join(import.meta.dir, '..', 'src', 'multichat')
const IRC = readFileSync(join(MC, 'irc.js'), 'utf8')
function fn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`"${name}" not found`)
  return src.slice(start, src.indexOf('\n}\n', start) + 2)
}

const SELF = { twitch: ['mellen'], kick: ['mellen'], youtube: [] }
const own = { stripDupBypass: null, _unkickEmotes: null, isSelf: null }
own.stripDupBypass = new Function(`const DUP_BYPASS_CHAR = '\\u{E0000}'
${fn(IRC, 'stripDupBypass')}
return stripDupBypass`)()
own._unkickEmotes = (s) => String(s ?? '').replace(/\[emote:\d+:([^\]]+)\]/g, '$1')
own.isSelf = (m, p) => (SELF[p || m?.platform || 'twitch'] || []).includes(String(m.user || '').toLowerCase())
Object.assign(globalThis, own, {
  escapeHtml,
  unescapeHtml,
  evictChannelEmoteCaches: () => {},
  cleanup: { setIntervalIfVisible: () => {}, persistInterval: () => {} },
  HS_MOD_TOKENS: mods.HS_MOD_TOKENS,
  hsModClassify: mods.hsModClassify,
  hsModBuildStyleAttr: mods.hsModBuildStyleAttr,
  hsModInjectWrapperStyle: mods.hsModInjectWrapperStyle,
  hsModComposeFilter: mods.hsModComposeFilter,
  hsModHexToHue: mods.hsModHexToHue,
  hsModPeelChain: mods.hsModPeelChain,
  HS_MOD_C_HEX_RE: /^c!#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/,
  currentTab: 'chan',
  getCurrentChannel: () => 'chan',
  getLiveChannel: () => 'chan',
  linksEnabled: false,
  getSetting: () => undefined,
  resolveEmoteProviderWinner,
  EMOTE_TIER_ORDER,
})

const lib = await import('../src/multichat/merged-tab.js')
const {
  _buildChannelEmoteCache: build,
  channelEmoteCaches,
  emoteCache,
  inventoryEmotes,
  processEmotes,
  viewerPersonalEmotes,
} = await import('../src/multichat/emotes.js')

// the real computeMessageText, over the deps it reads: the emote pass is the real one
const identity = (h) => h
const computeMessageText = new Function(
  'isSelf',
  'viewerBadgesPerChannel',
  'lookupEmote',
  'escapeHtml',
  'resolveSenderEmoteKey',
  'hsSenderKeys',
  'getSenderEmotes',
  'queueSenderEmoteFetch',
  'warnIdentityMismatch',
  'viewerPersonalEmotes',
  'ytEmoteUrls',
  'hsBigLine',
  'processEmotes',
  'processYtEmotes',
  'highlightMentionsInHtml',
  'highlightHashtagsInHtml',
  'highlightThreadRefsInHtml',
  'linksEnabled',
  'linkifyPartialLinks',
  'renderCheermotesInText',
  'legBadgesOf',
  `${fn(mainSource(), 'computeMessageText')}\nreturn computeMessageText`,
)(
  own.isSelf,
  new Map(),
  () => null,
  escapeHtml,
  () => null,
  null,
  () => null,
  () => {},
  () => {},
  viewerPersonalEmotes,
  () => null,
  () => false,
  processEmotes,
  identity,
  identity,
  identity,
  identity,
  false,
  identity,
  identity,
  lib.legBadgesOf,
)

afterAll(() => {
  for (const k of Object.keys(own)) delete globalThis[k]
})

const TW_ID = '01TWITCHNLKRIPP00000000000'
const stv = (name, id) => ({ name, url: `https://cdn.7tv.app/emote/${id}/2x.webp`, source: '7tv', hash: id })
const T0 = 1_700_000_000_000
const line = (platform, over = {}) => ({
  platform,
  user: 'mellen',
  channel: 'nl_kripp',
  text: 'MANOFSTEEL',
  time: T0,
  badges: platform === 'twitch' ? 'moderator/1' : '',
  ...over,
})
const kickFirst = (over = {}, twOver = {}) => {
  const kick = line('kick', { id: 'k1', hsSendId: 'send-1', ...over })
  const tw = line('twitch', { id: 't1', hsSendId: 'send-1', time: T0 + 400, ...twOver })
  return { kick, tw }
}
const draws = (html) => html.includes(TW_ID)

beforeEach(() => {
  for (const k of Object.keys(channelEmoteCaches)) delete channelEmoteCaches[k]
  inventoryEmotes.clear()
  viewerPersonalEmotes.clear()
  emoteCache.clear()
  lib.clearLegBadges()
  // the twitch room has the 7tv set; kick's channel has none
  build('nl_kripp', [stv('MANOFSTEEL', TW_ID)], 'twitch')
  build('nl_kripp', [], 'kick')
})

test('the kick copy stands, the twitch copy folds in: the row reads its word in the twitch room', () => {
  const { kick, tw } = kickFirst()
  expect(lib.foldSimulcastLegs([kick, tw])).toEqual([kick])
  expect(draws(computeMessageText(kick))).toBe(true)
})

test("anyone's folded send, not only yours", () => {
  const { kick, tw } = kickFirst({ user: 'stranger' }, { user: 'stranger' })
  lib.foldSimulcastLegs([kick, tw])
  expect(draws(computeMessageText(kick))).toBe(true)
})

test('a twitch copy with no badges and no colour still lends its room', () => {
  const { kick, tw } = kickFirst({}, { badges: '' })
  lib.foldSimulcastLegs([kick, tw])
  expect(lib.legBadgesOf(kick)?.room).toEqual({ channel: 'nl_kripp', platform: 'twitch' })
  expect(draws(computeMessageText(kick))).toBe(true)
})

test("the twitch copy's own channel is the room, whatever the kick copy's channel is called", () => {
  const { kick, tw } = kickFirst({ channel: 'nl-kripp' })
  lib.foldSimulcastLegs([kick, tw])
  expect(draws(computeMessageText(kick))).toBe(true)
})

test('a twitch copy dropped as a dual-send duplicate still lends its room to the row that stands', () => {
  const { kick, tw } = kickFirst({}, { hidden: true })
  expect(lib.foldSimulcastLegs([kick], [tw])).toEqual([kick])
  expect(draws(computeMessageText(kick))).toBe(true)
})

test('the first render that lends the room asks for one redraw of the row already drawn', () => {
  const { kick, tw } = kickFirst()
  lib.foldSimulcastLegs([kick])
  expect(lib.legBadgesChanged(kick)).toBe(false)
  lib.foldSimulcastLegs([kick, tw])
  expect(lib.legBadgesChanged(kick)).toBe(true)
  lib.foldSimulcastLegs([kick, tw])
  expect(lib.legBadgesChanged(kick)).toBe(false)
})

test("a kick-only view draws kick's copy in kick's room, before or after a folded view drew it", () => {
  const { kick, tw } = kickFirst()
  // kick-only first: its text is memoised on the buffer's object
  lib.clearLegBadges()
  expect(draws(computeMessageText(kick))).toBe(false)
  // the folded view reads the twitch room, and does not hand the kick view that html back
  lib.foldSimulcastLegs([kick, tw])
  expect(draws(computeMessageText(kick))).toBe(true)
  lib.clearLegBadges()
  expect(draws(computeMessageText(kick))).toBe(false)
  expect(kick.text).toBe('MANOFSTEEL')
  expect(kick.channel).toBe('nl_kripp')
  expect(kick.platform).toBe('kick')
})

test('a twitch row that stands reads its own room: nothing is lent, and a kick leg lends no room', () => {
  const tw = line('twitch', { id: 't1', hsSendId: 'send-1' })
  const kick = line('kick', { id: 'k1', hsSendId: 'send-1', time: T0 + 400 })
  expect(lib.foldSimulcastLegs([tw, kick])).toEqual([tw])
  expect(lib.legBadgesOf(tw)).toBeNull()
  expect(draws(computeMessageText(tw))).toBe(true)
})

test('a line with no twitch leg reads its own room, folded or not', () => {
  const kick = line('kick', { id: 'k1' })
  lib.foldSimulcastLegs([kick])
  expect(lib.legBadgesOf(kick)).toBeNull()
  expect(draws(computeMessageText(kick))).toBe(false)
})

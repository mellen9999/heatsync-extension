/**
 * FEATURES.md ext column: drives the real module behind each "?" cell. Bundle-scope files are sliced
 * out of src/ and run as written (the bundle has no exports), so a rename or a removal fails here.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BADGES, badgeById } from '../src/lib/badge-catalogue.js'
import { userKey, userSetMatches } from '../src/lib/user-key.js'
import { escapeHtml } from '../src/lib/utils.js'
import { renderHsBadgeToken } from '../src/multichat/badges.js'
import { slashHelpText } from '../src/multichat/slash-registry.js'

const rd = (f) => readFileSync(join(import.meta.dir, '..', 'src', f), 'utf8')
// one top-level function, as written, plus any prelude the bundle would have defined around it
const slice = (file, name) => {
  const src = rd(file)
  const at = src.search(new RegExp(`^(async )?function ${name}\\(`, 'm'))
  expect(at).toBeGreaterThan(-1)
  return src.slice(at, src.indexOf('\n}\n', at) + 3)
}
const load = (file, name, prelude = '') => new Function(`${prelude}\n${slice(file, name)}\nreturn ${name}`)()
const el = (...cls) => ({ classList: { contains: (c) => cls.includes(c) } })

describe('ext column drive', () => {
  test('R14 badge token renders a catalogue mark, nothing for an unknown id', () => {
    const keys = ['t', 'badgeById', 'escapeHtml']
    const saved = Object.fromEntries(keys.map((k) => [k, globalThis[k]]))
    Object.assign(globalThis, { t: (k) => k, badgeById, escapeHtml })
    try {
      expect(renderHsBadgeToken('nope-not-a-badge')).toBe('')
      expect(renderHsBadgeToken(BADGES[0].id)).toContain(`data-badge="${BADGES[0].id}"`)
    } finally {
      for (const k of keys) saved[k] === undefined ? delete globalThis[k] : (globalThis[k] = saved[k])
    }
  })

  test('R28 a mention row wears the red fill', () => {
    const rowFill = load('multichat/fill-family.js', 'rowFill', 'const NAVY_NOTICES=/x^/;')
    expect(rowFill(el('hs-row-mention'))).toBe('red')
    expect(rowFill(el('hs-mc-msg'))).toBe('')
  })

  test('R48 linked accounts read as one: a mute on one alias key matches the other leg', () => {
    expect(rd('multichat/cosmetics.js')).toContain('function getKickLinkedTwitch(')
    const aliases = [userKey('alice', 'twitch'), userKey('alice_k', 'kick')]
    expect(userSetMatches(new Set([aliases[1]]), 'alice', 'twitch', aliases)).toBe(true)
    expect(userSetMatches(new Set([aliases[1]]), 'bob', 'twitch', [userKey('bob', 'twitch')])).toBe(false)
  })

  test('E14 / E33 picker tiles carry the law mark (data-mark from lawTileSays)', () => {
    expect(rd('multichat/emote-law-send.js')).toContain('const lawTileSays =')
    expect(slice('multichat/emotes.js', 'emoteImgHtml')).toContain('data-mark=')
  })

  test('E29 a channel list put reaches the live set in place', () => {
    const src = rd('multichat/emote-rooms.js')
    const channelLegPut = new Function(`${src}\nreturn channelLegPut`)()
    const set = new Map()
    channelLegPut(set, 'twitch', new Map([['Kappa', { id: 1 }]]))
    expect(set.get('Kappa')).toEqual({ id: 1 })
    channelLegPut(set, 'twitch', new Map())
    expect(set.size).toBe(0)
  })

  test('C11 a tab switch re-reads the draft against the new room', () => {
    expect(slice('multichat/main-tabs.js', 'switchTab')).toContain('rereadInputChips()')
    expect(rd('multichat/emote-law-send.js')).toContain('function rereadInputChips(')
  })

  test('F18 post markup: ** and __ bold, * and _ italic (not underline)', () => {
    const formatText = load('multichat/social.js', 'formatText')
    expect(formatText('**hi**')).toContain('<strong>hi</strong>')
    expect(formatText('__hi__')).toContain('<strong>hi</strong>')
    expect(formatText('*hi*')).toContain('<em>hi</em>')
  })

  test('S06 log permalink carries ?m= and the day', () => {
    const src = rd('multichat/chat-logs.js')
    const origin = /const HS_CL_PUBLIC_ORIGIN\s*=.*/.exec(src)[0]
    const plats = /const HS_LOG_PLATFORMS\s*=.*/.exec(rd('multichat/feed-embed.js'))[0]
    const f = load('multichat/chat-logs.js', 'buildLogPermalink', `${origin}\n${plats}`)
    const u = f({ platform: 'twitch', channel: '#xqc', messageId: 'abc', time: Date.UTC(2026, 10, 2, 12) })
    expect(u).toMatch(/\/search\/logs\/twitch\/xqc\/2026-11-02\?m=abc$/)
    expect(f({ platform: 'nope', channel: 'x', time: 1 })).toBeNull()
  })

  test('S07 log viewer has search + load older', () => {
    const s = rd('multichat/chat-logs.js')
    expect(s).toContain('function renderChatLogsView(')
    expect(s).toMatch(/older/i)
  })

  test('O06 twitch send rejects are named (reading needs no login, sending says why not)', () => {
    const src = rd('multichat/auth-irc.js')
    const end = src.indexOf('\n])', src.indexOf('TWITCH_SEND_REJECT_NOTICES = new Map')) + 3
    const m = new Function(
      `${src.slice(src.indexOf('const TWITCH_SEND_REJECT_NOTICES'), end)}\nreturn TWITCH_SEND_REJECT_NOTICES`,
    )()
    expect(m.get('msg_slowmode')).toBeTruthy()
  })

  test('O08 /help text lists commands', () => {
    expect(slashHelpText('chat')).toMatch(/help/)
  })

  test('FI03 mute writes 24h and covers linked identities', () => {
    const f = slice('multichat/input.js', '_toggleMcMute')
    expect(f).toContain('expandUserAliasKeys(')
    expect(f).toContain('86400000')
    expect(rd('background/05-ws.js')).toContain('async function syncMuteToServer(')
  })

  test('FI07 filter-to sets the search bar to @name (clear = empty it)', () => {
    expect(rd('multichat/input.js')).toContain('input.value = `@${String(username).toLowerCase()}`')
  })

  test('MO11 card clip posts /api/twitch/clip', () => {
    expect(slice('multichat/profile-card.js', 'pcDoClip')).toContain('/api/twitch/clip')
  })

  test('O12 send checklist covers twitch / kick / youtube', () => {
    const s = rd('multichat/send-status.js')
    for (const id of ['twitch', 'kick', 'youtube']) expect(s).toContain(`id: '${id}'`)
    expect(s).toContain('function sendStatusGroupHtml(')
  })

  test('R42 prediction view renders the picker renderers', () => {
    expect(rd('multichat/pred-view.js')).toContain('async function openPredView(')
  })

  test('N10 mention rules editor reads the server limit + hits', () => {
    const s = rd('multichat/mention-rules.js')
    expect(s).toContain('function mrFormHtml(')
    expect(s).toContain('mrState.limit')
  })

  test('T02 remove tab saves config', () => {
    expect(slice('multichat/channel-mgmt.js', 'removeChannel')).toContain('saveConfig()')
  })
})

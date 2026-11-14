/**
 * An own echo keeps the chat it CAME FROM in m.platform; the host the user typed
 * on rides in m.sentHost and picks only the visible [T]/[K]/[Y]/[H] tag. Before,
 * the echo's platform was overwritten with the host, so the row's fire mark, profile
 * link, uid, paint and mod target all flipped with where the user happened to type.
 *
 * Real code, carved: the identity block of buildMessageDiv (main-messages.js), the
 * own-echo blocks of main.js, retroFoldOwnEchoes (input.js), and the hs-origins
 * helpers (imported). Free identifiers resolve through a recording scope.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { platformMark } from '../src/lib/palette.js'
import { normalizeLegacyRetag, stampSentHost } from '../src/multichat/hs-origins.js'
import { mainSource } from './main-src.js'

const MC = join(import.meta.dir, '..', 'src', 'multichat')
const read = (f) => readFileSync(join(MC, f), 'utf8')
const MSG = read('main-messages.js')
const INPUT = read('input.js')
const MAIN = mainSource()

function carve(src, a, b) {
  const s = src.indexOf(a)
  if (s === -1) throw new Error(`carve start not found: ${a}`)
  const e = src.indexOf(b, s)
  if (e === -1) throw new Error(`carve end not found: ${b}`)
  return src.slice(s, e)
}

// the identity decisions of one row render: kick id resolution -> uid -> marks -> tag -> link
const ID_BLOCK = [
  carve(MSG, "if (m.platform === 'kick' && m.user && !m._uidTwitch) {", '  const safeScColor'),
  carve(MSG, '  const hsPaint =\n', '  // 7TV paint: twitch-space').replace('  const hsPaint =\n', '  hsPaint =\n'),
  carve(MSG, '  const paintStyle =', '  // Plus tenure').replace('  const paintStyle =', '  paintStyle ='),
  carve(MSG, '  let userHref', '  // When painted, drop'),
].join('\n')

function identity(m) {
  const calls = { kickLookup: [], marks: [], thirdParty: [], paint: [], cosmetics: [] }
  const real = {
    kickNameResolved: new Map(),
    knownUserIds: new Map(),
    kickNamePaintUid: new Map(),
    _hsUserIdCache: new Map(),
    userKey: (n, p) => `${p}:${n}`,
    platformMark,
    platformMarkHtml: (p) => `[${p}]`,
    hsOriginStamp: (r) => !!r.hsOrigin,
    queueKickNameToCosmetics: (...a) => calls.kickLookup.push(a),
    renderThirdPartyBadges: (uid) => {
      calls.thirdParty.push(uid)
      return ''
    },
    hsMarksRowHtml: (_m, uid) => {
      calls.marks.push(uid)
      return '🔥'
    },
    hsPaintRender: (uid) => {
      calls.paint.push(uid)
      return null
    },
    getMcPaintStyle: (uid) => {
      calls.cosmetics.push(uid)
      return ''
    },
    mcCosmeticsNeedLookup: () => false,
    escapeHtml: (s) => String(s),
    sanitizeColor: (c) => c,
  }
  const scope = new Proxy(real, {
    has: (t, k) =>
      typeof k === 'string' && (k in t || !(k in globalThis)) && !['m', 'badges', 'hsPaint', 'paintStyle'].includes(k),
    get: (t, k) => (k in t ? t[k] : () => ''),
  })
  const body = `with (scope) { let badges = ''; let hsPaint, paintStyle; const isSuperChat = false
${ID_BLOCK}
return { uidTwitch, marksHtml, markPlat, platformBadge, userHref, plat } }`
  const out = new Function('m', 'scope', body)(m, scope)
  return { ...out, calls }
}

const SELF_ID = '4242'
const KICK_ID = '99'

describe('own echo identity vs visible tag', () => {
  test('(a) own twitch echo typed on kick: [K] tag, twitch identity, flame kept', () => {
    const m = { user: 'me', userId: SELF_ID, text: 'gm' }
    stampSentHost(m, 'kick')
    const r = identity(m)
    expect(r.platformBadge).toBe('[kick]')
    expect(r.marksHtml).toBe('🔥')
    expect(r.calls.marks).toEqual([SELF_ID])
    expect(r.userHref).toBe('https://twitch.tv/me')
    expect(r.plat).toBe('twitch')
    expect(r.uidTwitch).toBe(SELF_ID)
    expect(r.calls.thirdParty).toEqual([SELF_ID])
    expect(r.calls.kickLookup).toEqual([]) // a twitch id is never fed to the kick resolver
  })

  test('(b) own kick echo typed on twitch: raw kick id never reaches twitch-keyed maps', () => {
    const m = { user: 'me', userId: KICK_ID, platform: 'kick', text: 'gm' }
    stampSentHost(m, 'twitch')
    const r = identity(m)
    expect(r.platformBadge).toBe('[twitch]')
    expect(r.marksHtml).toBe('') // kick row: no twitch marks
    expect(r.uidTwitch).toBe('')
    expect(r.calls.marks).toEqual([])
    expect(r.calls.thirdParty).toEqual([])
    expect(r.calls.paint).toEqual([])
    expect(r.calls.cosmetics).toEqual([])
    expect(r.userHref).toBe('https://kick.com/me')
    expect(r.calls.kickLookup).toEqual([['me', KICK_ID]]) // the kick id goes to the KICK resolver
  })

  test('heatsync-origin rows still wear [H] (hsOrigin beats sentHost)', () => {
    const m = { user: 'me', userId: SELF_ID, hsOrigin: true }
    stampSentHost(m, 'kick')
    expect(identity(m).platformBadge).toBe('[heatsync]')
  })

  test('rows without sentHost are untouched', () => {
    expect(identity({ user: 'x', userId: '1' }).platformBadge).toBe('[twitch]')
    expect(identity({ user: 'x', userId: '1', platform: 'kick' }).platformBadge).toBe('[kick]')
  })
})

describe('retro-fold survivor keeps its chat identity, wears [H]', () => {
  test('(c) fold sets sentHost, never platform', () => {
    const fold = carve(INPUT, 'function retroFoldOwnEchoes()', '\n}\n')
    expect(fold).not.toMatch(/\.platform\s*=\s*'heatsync'/)
    expect(fold).not.toContain('badgePlatform')
    expect(fold).toContain("m.sentHost = 'heatsync'")
    const m = { user: 'me', userId: SELF_ID, platform: 'twitch', sentHost: 'heatsync' }
    const r = identity(m)
    expect(r.platformBadge).toBe('[heatsync]')
    expect(r.userHref).toBe('https://twitch.tv/me')
    expect(r.calls.marks).toEqual([SELF_ID])
  })
})

describe('(d) rows saved by older builds normalize on load', () => {
  test('platform=host + badgePlatform=origin -> origin platform, host in sentHost', () => {
    const m = normalizeLegacyRetag({ platform: 'kick', badgePlatform: 'twitch', user: 'me' })
    expect(m).toEqual({ platform: 'twitch', sentHost: 'kick', user: 'me' })
    expect(normalizeLegacyRetag({ platform: 'heatsync', badgePlatform: 'kick' })).toEqual({
      platform: 'kick',
      sentHost: 'heatsync',
    })
  })
  test('a twitch row retagged to youtube', () => {
    expect(normalizeLegacyRetag({ platform: 'youtube', badgePlatform: 'twitch' })).toEqual({
      platform: 'twitch',
      sentHost: 'youtube',
    })
  })
  test('idempotent; same-platform and plain rows are left alone; whispers keep heatsync', () => {
    expect(normalizeLegacyRetag({ platform: 'kick', badgePlatform: 'kick' })).toEqual({ platform: 'kick' })
    const b = { platform: 'twitch', sentHost: 'kick' }
    expect(normalizeLegacyRetag(normalizeLegacyRetag(b))).toEqual({ platform: 'twitch', sentHost: 'kick' })
    expect(normalizeLegacyRetag({ platform: 'heatsync', user: 'w' })).toEqual({ platform: 'heatsync', user: 'w' })
  })
  test('stampSentHost maps yt -> youtube', () => {
    const m = {}
    stampSentHost(m, 'yt')
    expect(m.sentHost).toBe('youtube')
  })
  test('persisted loads normalize; no site writes badgePlatform or overwrites platform with the host', () => {
    expect(read('irc.js')).toContain('normalizeLegacyRetag(msg)')
    expect(read('main-state.js')).toContain('normalizeLegacyRetag(m)')
    for (const f of ['irc.js', 'social.js', 'input.js']) expect(read(f)).not.toMatch(/\.badgePlatform\s*=\s*['m]/)
    expect(MAIN).not.toMatch(/\.platform = sentHost/)
  })
})

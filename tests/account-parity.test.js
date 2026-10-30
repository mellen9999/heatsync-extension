// Accounts without twitch (youtube-only / kick-only): the places that quietly
// assumed a twitch login. Multichat modules concatenate into one scope and can't
// be imported, so pure ones load via new Function and the send/UI wiring is
// guarded at the source level.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SLASH_REGISTRY, slashAvailableOn } from '../src/multichat/slash-registry.js'

const root = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(root, ...p), 'utf8')
const mc = (f) => read('src', 'multichat', f)

function loadSelf(globals = {}) {
  const names = Object.keys(globals)
  const fn = new Function(
    ...names,
    `${mc('self-identity.js')}; return { isSelf, selfNamesFor, setSelfKickName, setSelfHsNames }`,
  )
  return fn(...names.map((n) => globals[n]))
}

describe('isSelf is keyed by platform', () => {
  test('twitch row matches the twitch login, not a same-named kick row', () => {
    const s = loadSelf({ currentUsername: 'Mellen', authState: undefined })
    expect(s.isSelf({ user: 'mellen' })).toBe(true)
    expect(s.isSelf({ user: 'mellen', platform: 'kick' })).toBe(false)
  })
  test('kick row matches the kick session name with no twitch login at all', () => {
    const s = loadSelf({ currentUsername: null, authState: undefined })
    s.setSelfKickName('KickGuy')
    expect(s.isSelf({ user: 'kickguy', platform: 'kick' })).toBe(true)
    expect(s.isSelf({ user: 'kickguy' })).toBe(false)
  })
  test('a retagged own echo keeps its transport via badgePlatform', () => {
    const s = loadSelf({ currentUsername: 'me', authState: undefined })
    expect(s.isSelf({ user: 'me', platform: 'kick', badgePlatform: 'twitch' })).toBe(true)
  })
  test('heatsync account names count per platform; nothing known means nobody is me', () => {
    const s = loadSelf({ currentUsername: null, authState: undefined })
    expect(s.isSelf({ user: undefined })).toBe(false)
    expect(s.isSelf({ user: 'x', platform: 'youtube' })).toBe(false)
    s.setSelfHsNames({ youtube_username: 'YtGuy' })
    expect(s.isSelf({ user: 'ytguy', platform: 'yt' })).toBe(true)
  })
  test('no handler decides self from the bare twitch string any more', () => {
    for (const f of ['main.js', 'social.js', 'mod-toolbar.js', 'pin-bar.js']) {
      expect(mc(f)).not.toMatch(/user\??\.toLowerCase\(\) === currentUsername\??\.toLowerCase\(\)/)
    }
    expect(mc('main.js')).toContain("isSelf(msg, 'kick')")
    expect(mc('social.js')).toContain("isSelf(ytMsg, 'youtube')")
  })
})

describe('sign-in goes to the chooser', () => {
  test('no surface links the twitch-only oauth route for a plain sign-in', () => {
    for (const f of ['notifs.js', 'whispers.js']) expect(mc(f)).not.toMatch(/api\/auth\/login(?!\?scopes)/)
    expect(mc('bootstrap.js')).toContain("const HS_LOGIN_URL = 'https://heatsync.org/login'")
    expect(read('chrome', 'welcome.html')).toContain('href="https://heatsync.org/login"')
    expect(read('chrome', 'heatsync-button.js')).not.toContain('api/auth/login')
  })
})

describe('youtube send legs', () => {
  const input = mc('input.js')
  test('youtube-only with no resolved stream bails before anything is registered', () => {
    const bail = input.indexOf('if (ytWanted && !sendToYoutube && !sendToKick && !sendToTwitch)')
    expect(bail).toBeGreaterThan(0)
    expect(input.slice(bail, bail + 200)).toContain("t('mc_yt_send_open_stream')")
    expect(input.indexOf('const _synthId = registerPendingSend({', bail)).toBeGreaterThan(bail)
  })
  test('twitch+youtube with no twitch session: a delivered youtube leg is success', () => {
    const at = input.indexOf('if (ytLeg && (await ytLeg) === true)')
    expect(at).toBeGreaterThan(0)
    const body = input.slice(at, input.indexOf('return', at))
    expect(body).toContain("confirmPending(_synthId, 'twitch')")
    expect(body).not.toContain('markPendingFailed')
    expect(at).toBeLessThan(input.indexOf("markPendingFailed(_synthId, 'auth_failed')", at))
  })
  test('youtube host never asks for a heatsync login', () => {
    expect(input).toMatch(/hostPlatform === 'yt'\s*\? true/)
  })
})

describe('slash commands honour the tab', () => {
  const byCmd = (c) => SLASH_REGISTRY.find((x) => x.cmd === c)
  test('youtube-only tab (empty set) loses twitch/kick-bound commands, keeps heatsync + local', () => {
    const none = new Set()
    expect(slashAvailableOn(byCmd('ban'), none)).toBe(false)
    expect(slashAvailableOn(byCmd('w'), none)).toBe(false)
    expect(slashAvailableOn(byCmd('dm'), none)).toBe(true)
    expect(slashAvailableOn(byCmd('mute'), none)).toBe(true)
  })
  test('kick tab keeps the kick-capable mod commands but not twitch-only ones', () => {
    const kick = new Set(['kick'])
    expect(slashAvailableOn(byCmd('ban'), kick)).toBe(true)
    expect(slashAvailableOn(byCmd('shield'), kick)).toBe(false)
  })
  test('a tab with no single destination is not judged', () => {
    expect(slashAvailableOn(byCmd('ban'), null)).toBe(true)
  })
})

describe('login prompts and relinks', () => {
  test('kick and youtube login failures get an open button', () => {
    const n = mc('notifs.js')
    expect(n).toContain("kick_not_logged_in: { label: 'open kick'")
    expect(n).toContain("chat_disabled: { label: 'open youtube'")
  })
  test('kick pins relink through the kick route', () => {
    expect(mc('pin-bar.js')).toContain('/api/auth/kick/login?scopes=mod')
  })
})

describe('cross-follow and discover', () => {
  test('a leg without a session is skipped, not queued', () => {
    const cf = mc('cross-follow.js')
    expect(cf).toContain("{ skipped: 'no twitch session' }")
    expect(cf).toContain("{ skipped: 'no kick session' }")
  })
  test('discover counts youtube live and viewers', () => {
    const social = mc('social.js')
    expect(social).toContain('p.youtube_is_live')
    expect(social).toContain('p.youtube_viewer_count || 0')
    expect(social).toContain('hs-plat hs-plat-yt')
  })
})

describe('background', () => {
  const bg = read('chrome', 'background.js')
  test('went-live click lands a youtube channel on /live and reads avatarUrl', () => {
    const fn = new Function(
      `${bg.slice(bg.indexOf('function channelPageUrl'), bg.indexOf('// Which channel a page belongs to'))}; return channelPageUrl`,
    )
    const url = fn()
    expect(url('youtube', 'someone', true)).toBe('https://www.youtube.com/@someone/live')
    expect(url('youtube', 'UCabc', true)).toBe('https://www.youtube.com/channel/UCabc/live')
    expect(url('youtube', 'someone')).toBe('https://www.youtube.com/@someone')
    expect(bg).toContain('stream.avatarUrl ||')
  })
  test('kick_session_status also answers the username', () => {
    expect(bg).toContain('sendResponse({ loggedIn: true, username })')
  })
})

describe('whispers hint', () => {
  test('no twitch identity leads with heatsync dms', () => {
    const src = mc('whispers.js')
    const fn = new Function(
      'currentUsername',
      'authState',
      't',
      `${src.slice(src.indexOf('function whisperHint'), src.indexOf('// Resolve own color'))}; return whisperHint()`,
    )
    const t = (k) => k
    expect(fn(null, undefined, t)).toBe('mc_whisper_hint_dm')
    expect(fn('me', undefined, t)).toBe('mc_whisper_hint')
  })
})

// Kick keys a channel `a-b` where a chatter is typed `a_b`; asking v2/channels for the name as typed
// is a 404 (a fifth of kick names). Dashed slug first, typed name second, same as the desktop app
// (heatsync-chat 12b2c79). v1/users is keyed by the name as typed, so it is left alone.
import { describe, expect, test } from 'bun:test'
import { bgSource } from './bg-src.js'

const src = bgSource()
const cut = (from, to) => {
  const a = src.indexOf(from)
  if (a < 0) throw new Error(`marker gone: ${from}`)
  return src.slice(a, src.indexOf(to, a))
}

function world(routes) {
  const calls = []
  const fetchWithTimeout = async (url) => {
    calls.push(url)
    const hit = routes[url.split('/channels/')[1]]
    const status = hit ? 200 : 404
    return { ok: status === 200, status, body: { cancel() {} }, json: async () => hit }
  }
  const body = `${cut('const avatarCache = new Map()', '// chrome.notifications renders')}\nreturn { kickChannelSlugs, fetchKickChannel, resolveAvatarUrl }`
  return { calls, ...new Function('fetchWithTimeout', body)(fetchWithTimeout) }
}

describe('kick avatar slug', () => {
  test('an underscore name asks the dashed slug first, then the name as typed', () => {
    const w = world({})
    expect(w.kickChannelSlugs('a_b')).toEqual(['a-b', 'a_b'])
    expect(w.kickChannelSlugs('re_da_cted')).toEqual(['re-da-cted', 're_da_cted'])
    expect(w.kickChannelSlugs('plain1')).toEqual(['plain1'])
  })
  test('a_b gets its picture from the a-b channel in one ask', async () => {
    const w = world({ 'a-b': { user: { profile_pic: 'https://files.kick.com/images/x.webp' } } })
    expect(await w.resolveAvatarUrl('a_b', 'kick')).toBe('https://files.kick.com/images/x.webp')
    expect(w.calls).toEqual(['https://kick.com/api/v2/channels/a-b'])
  })
  test('an old channel that kept its underscore is the fallback', async () => {
    const w = world({ a_b: { user: { profile_pic: 'https://files.kick.com/images/old.webp' } } })
    expect(await w.resolveAvatarUrl('a_b', 'kick')).toBe('https://files.kick.com/images/old.webp')
    expect(w.calls).toEqual(['https://kick.com/api/v2/channels/a-b', 'https://kick.com/api/v2/channels/a_b'])
  })
  test('neither exists: nothing, after two asks; a plain name is one ask', async () => {
    const w = world({})
    expect(await w.resolveAvatarUrl('a_b', 'kick')).toBe('')
    expect(w.calls.length).toBe(2)
    const p = world({})
    await p.resolveAvatarUrl('plain', 'kick')
    expect(p.calls.length).toBe(1)
  })
  test('the profile banner lookup reads the same helper', () => {
    expect(src).toContain('fetchKickChannel(username,')
    expect(src).not.toMatch(
      /fetchWithTimeout\(\s*`https:\/\/kick\.com\/api\/v2\/channels\/\$\{encodeURIComponent\(username\)\}`/,
    )
  })
})

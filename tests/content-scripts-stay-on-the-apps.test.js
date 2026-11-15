/**
 * The content scripts load on the platforms' own apps (www.twitch.tv, the creator dashboard, kick.com,
 * www.youtube.com) and nowhere else on their domains.
 *
 * Twitch's entries used to match *.twitch.tv, so twitch's sign-in and "authorize this app" pages
 * (id.twitch.tv), the help centre and the developer docs all got the whole chat engine, its page-world
 * fetch hooks, and once a channel was saved a full chat panel docked over the page. Kick's *.kick.com
 * did the same to its docs, help and dashboard sites, minus the panel. The manifests now list the app
 * hosts; the one exception is the player-volume script, which runs in every frame of the three
 * platforms on purpose so embedded players keep their volume.
 *
 * Chrome and firefox apply the same match-pattern rules; this evaluates them for real.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

// A match pattern (scheme://host/path) as a regexp over a url without its #fragment.
function patternRe(pattern) {
  const [, scheme, host, path] = pattern.match(/^(\*|https?):\/\/([^/]+)(\/.*)$/)
  const h = host === '*' ? '[^/]+' : host.startsWith('*.') ? `(?:[^/]+\\.)?${esc(host.slice(2))}` : esc(host)
  const p = path.split('*').map(esc).join('.*')
  return new RegExp(`^${scheme === '*' ? 'https?' : scheme}://${h}${p}$`)
}

const hits = (patterns, url) => (patterns || []).some((pt) => patternRe(pt).test(url))

// Every script the manifest injects into a top-level page at `url`.
function scriptsAt(manifest, url) {
  const out = new Set()
  for (const cs of manifest.content_scripts) {
    if (hits(cs.matches, url) && !hits(cs.exclude_matches, url)) for (const f of cs.js) out.add(f)
  }
  return out
}

const OFF_APP = [
  'https://id.twitch.tv/oauth2/authorize?client_id=x&redirect_uri=https%3A%2F%2Fheatsync.org&response_type=code',
  'https://help.twitch.tv/s/',
  'https://dev.twitch.tv/docs/',
  'https://blog.twitch.tv/en/',
  'https://safety.twitch.tv/',
  'https://m.twitch.tv/xqc',
  'https://id.kick.com/',
  'https://kick.com/oauth/authorize?client_id=x',
  'https://kick.com/oauth2/authorize?client_id=x',
  'https://help.kick.com/en/',
  'https://docs.kick.com/',
  'https://dashboard.kick.com/stream',
  'https://files.kick.com/images/user/1/profile_image/a.webp',
]

const ON_APP = [
  'https://www.twitch.tv/xqc',
  'https://www.twitch.tv/directory',
  'https://www.twitch.tv/popout/xqc/chat',
  'https://dashboard.twitch.tv/u/xqc/stream-manager',
  'https://kick.com/xqc',
  'https://kick.com/browse',
  'https://www.youtube.com/watch?v=jNQXAC9IVRw',
]

describe('the match-pattern evaluator', () => {
  test('reads wildcard hosts, exact hosts and path globs the way browsers do', () => {
    expect(hits(['https://*.twitch.tv/*'], 'https://twitch.tv/')).toBe(true)
    expect(hits(['https://*.twitch.tv/*'], 'https://id.twitch.tv/oauth2/authorize')).toBe(true)
    expect(hits(['https://*.twitch.tv/*'], 'https://twitch.tv.evil.com/')).toBe(false)
    expect(hits(['https://www.twitch.tv/*'], 'https://id.twitch.tv/')).toBe(false)
    expect(hits(['https://kick.com/oauth/*'], 'https://kick.com/oauth/authorize?x=1')).toBe(true)
    expect(hits(['https://kick.com/oauth/*'], 'https://kick.com/oauthfan')).toBe(false)
    expect(hits(['https://www.youtube.com/live_chat*'], 'https://www.youtube.com/live_chat?v=1')).toBe(true)
  })
})

for (const browser of ['chrome', 'firefox']) {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', 'src', 'manifests', `${browser}.json`), 'utf8'))

  describe(`${browser}: content scripts stay on the apps`, () => {
    test("sign-in, help, docs and other sites on the platforms' domains get nothing but the player-volume script", () => {
      for (const url of OFF_APP) {
        const got = [...scriptsAt(manifest, url)].filter((f) => f !== 'player-volume.js')
        expect(got, url).toEqual([])
      }
    })

    test('every app page still gets the chat engine', () => {
      for (const url of ON_APP) expect(scriptsAt(manifest, url).has('multichat-core.js'), url).toBe(true)
    })

    test('embedded players still get the player-volume script', () => {
      for (const url of ['https://player.twitch.tv/?channel=xqc&parent=heatsync.org', 'https://player.kick.com/xqc']) {
        expect(scriptsAt(manifest, url).has('player-volume.js'), url).toBe(true)
      }
    })
  })
}

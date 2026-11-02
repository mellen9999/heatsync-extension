/**
 * kick's "authorize heatsync" consent screen (kick.com/oauth/authorize, and
 * id.kick.com) grew the multichat overlay: the old kick branch body-mounted on
 * every route that wasn't a single reserved-looking segment, and two-segment
 * /oauth/authorize fell straight through to it. The overlay now mounts only on
 * an allowlisted channel/chatroom/popout route, and the manifests keep the
 * content scripts off the sign-in pages entirely.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isKickChannelRoute } from '../src/lib/reserved-paths.js'

const read = (p) => readFileSync(join(import.meta.dir, '..', p), 'utf8')

describe('isKickChannelRoute', () => {
  test('sign-in routes never mount', () => {
    for (const p of ['/oauth/authorize', '/oauth2/authorize', '/oauth', '/oauth/authorize/', '/login', '/signup']) {
      expect(isKickChannelRoute(p)).toBe(false)
    }
  })

  test('channel, chatroom and popout routes mount', () => {
    for (const p of ['/xqc', '/xqc/', '/Some_Streamer-1', '/xqc/chatroom', '/popout/xqc/chat', '/embed/xqc/chat']) {
      expect(isKickChannelRoute(p)).toBe(true)
    }
  })

  test('other non-channel routes never mount', () => {
    for (const p of ['/', '', '/browse', '/categories/slots', '/search', '/settings', '/following', '/video/abc']) {
      expect(isKickChannelRoute(p)).toBe(false)
    }
    // nested channel sub-pages and reserved popout slugs are not chat surfaces
    expect(isKickChannelRoute('/xqc/videos/123')).toBe(false)
    expect(isKickChannelRoute('/popout/oauth/chat')).toBe(false)
  })
})

describe('kick content scripts skip the sign-in pages', () => {
  for (const file of ['src/manifests/chrome.json', 'src/manifests/firefox.json']) {
    test(`${file}: every kick entry excludes id.kick.com and /oauth*`, () => {
      const kick = JSON.parse(read(file)).content_scripts.filter((c) => c.matches.some((m) => m.includes('kick.com')))
      expect(kick.length).toBeGreaterThan(0)
      for (const c of kick) {
        for (const ex of ['https://id.kick.com/*', 'https://kick.com/oauth/*', 'https://kick.com/oauth2/*']) {
          expect(c.exclude_matches).toContain(ex)
        }
      }
    })
  }

  test('multichat main.js gates the kick mount on the shared route check', () => {
    expect(read('src/multichat/main.js')).toMatch(/if \(!isKickChannelRoute\(location\.pathname\)\)/)
  })
})

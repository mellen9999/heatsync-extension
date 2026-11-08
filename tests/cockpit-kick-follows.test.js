import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { bgSource } from './bg-src.js'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('the service worker answers get_kick_followed_channels from the kick session', () => {
  const bg = bgSource()
  const at = bg.indexOf("message.type === 'get_kick_followed_channels'")
  expect(at).toBeGreaterThan(-1)
  const branch = bg.slice(at, bg.indexOf("message.type === 'fetch_live_status'"))
  expect(branch).toContain("name: 'session_token'")
  expect(branch).toContain('kickFollowedSlugs(token)')
})

test('"fill my cockpit" lists kick follows beside twitch ones, keyed per platform', () => {
  const src = read('src/multichat/channel-mgmt.js')
  expect(src).toContain("type: 'get_kick_followed_channels'")
  expect(src).toContain("kickChannels: follows.filter((f) => f.plat === 'kick')")
  expect(src).toContain('({ [b.dataset.plat]: b.dataset.login })')
})

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const IN =
  readFileSync(new URL('../src/multichat/input.js', import.meta.url), 'utf8') +
  readFileSync(new URL('../src/multichat/hover-reply.js', import.meta.url), 'utf8')

test('reply buttons and the ctx menu record the platform of the row they came from', () => {
  // one helper (rowReplyState) feeds both the menu and the hover button
  expect(IN.match(/platform: d\.msgPlatform \|\| ''/g)?.length).toBe(1)
  expect(IN).toContain('rowReplyState(msg, username)')
})

test('a reply parent id only reaches the platform that owns it', () => {
  expect(IN).toContain("const twitchReplyId = replyParentId && (!_replyPlat || _replyPlat === 'twitch')")
  expect(IN).toContain("const kickReplyId = replyParentId && (!_replyPlat || _replyPlat === 'kick')")
  expect(IN).not.toMatch(/sendIrcMessage\([^)]*replyParentId/)
})

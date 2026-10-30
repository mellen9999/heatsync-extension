import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const rd = (f) => readFileSync(new URL(`../src/multichat/${f}`, import.meta.url), 'utf8')

test('youtube chatters get a chat-logs entry and an @handle still joins its live room', () => {
  expect(rd('input.js')).toContain("logPlatform === 'youtube'")
  const cl = rd('chat-logs.js')
  expect(cl).toContain('CL_ULOG_NAME_RE.test(clRoomName(st.username))')
  expect(cl).toContain('`ulog:${st.platform}:${clRoomName(st.username)}`')
})

test('"my logs" never borrows the twitch login on a kick/yt tab', () => {
  const m = rd('main.js')
  const at = m.indexOf('logs: (pane, ctx) => {')
  const body = m.slice(at, m.indexOf('\n    },', at))
  expect(body).toContain("platform === 'twitch' ? currentUsername : ''")
})

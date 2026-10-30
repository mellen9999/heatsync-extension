import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const MAIN = readFileSync(new URL('../src/multichat/main.js', import.meta.url), 'utf8')
const API = readFileSync(new URL('../src/multichat/twitch-api.js', import.meta.url), 'utf8')

test('/status routes a kick slug to kick, never to a twitch lookup', () => {
  const at = MAIN.indexOf('status: async (pane, ctx) => {')
  const body = MAIN.slice(at, MAIN.indexOf('platforms:', at))
  expect(body).toContain("plat === 'kick' ? await buildKickStatusPanel(ch) : await buildChatStatusPanel(ch)")
  expect(body).toContain("if (plat === 'yt')")
})

test('kick status panel reads kick.com, not twitch gql', () => {
  const at = API.indexOf('async function buildKickStatusPanel')
  const body = API.slice(at, API.indexOf('// Best-effort own twitch login'))
  expect(body).toContain('https://kick.com/api/v2/channels/')
  expect(body).not.toContain('twitchGql')
})

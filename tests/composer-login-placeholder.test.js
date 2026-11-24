import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { composerNeedsLogin } from '../src/lib/utils.js'

// logged-out first run: composer placeholder says to log in (input stays enabled)
test('composerNeedsLogin: known anonymous session with no host session asks for login', () => {
  expect(composerNeedsLogin({ hsAuth: false, hostSession: false })).toBe(true)
  expect(composerNeedsLogin({ hsAuth: false, hostSession: null })).toBe(true)
  expect(composerNeedsLogin({ hsAuth: false })).toBe(true)
})

test('composerNeedsLogin: unresolved or logged-in keeps the send placeholder', () => {
  expect(composerNeedsLogin({ hsAuth: null, hostSession: false })).toBe(false)
  expect(composerNeedsLogin({ hsAuth: true, hostSession: false })).toBe(false)
})

test('composerNeedsLogin: a host page that can send on its own keeps the placeholder', () => {
  // twitch cookie / kick session present
  expect(composerNeedsLogin({ hsAuth: false, hostSession: true })).toBe(false)
})

test('input.js derives hostSession per platform; kick asks background', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
  expect(src).toContain("type: 'kick_session_status'")
  expect(src).toMatch(/hostPlatform === 'twitch'\s*\?\s*!!getTwitchAuthToken\(\)/)
  expect(src).toMatch(/hostPlatform === 'yt'\s*\?\s*true/)
})

test('input.js wires the hint into live + channel placeholders', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
  expect(src.match(/placeholder = _composerLoginHint\(\) \|\| placeholder/g)?.length).toBe(2)
  // twitch and kick name their own login; elsewhere only heatsync.org can send
  expect(src).toMatch(
    /hostPlatform === 'twitch' \|\| hostPlatform === 'kick'\s*\?\s*t\('mc_input_login_to_chat', \[hostPlatform\]\)\s*:\s*t\('mc_social_login_first'\)/,
  )
  const en = JSON.parse(readFileSync(join(import.meta.dir, '..', 'src', '_locales', 'en', 'messages.json'), 'utf8'))
  expect(en.mc_input_login_to_chat.message).toBe('log in to $PLATFORM$ or heatsync')
  expect(en.mc_social_login_first.message).toBe('log in at heatsync.org first')
})

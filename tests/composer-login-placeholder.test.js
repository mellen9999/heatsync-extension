import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { composerNeedsLogin } from '../src/lib/utils.js'

// logged-out first run: composer placeholder says to log in (input stays enabled)
test('composerNeedsLogin: known anonymous session asks for login', () => {
  expect(composerNeedsLogin({ hsAuth: false, hostPlatform: 'kick', twitchCookie: null })).toBe(true)
  expect(composerNeedsLogin({ hsAuth: false, hostPlatform: 'twitch', twitchCookie: null })).toBe(true)
})

test('composerNeedsLogin: unresolved or logged-in keeps the send placeholder', () => {
  expect(composerNeedsLogin({ hsAuth: null, hostPlatform: 'twitch', twitchCookie: null })).toBe(false)
  expect(composerNeedsLogin({ hsAuth: true, hostPlatform: 'kick', twitchCookie: null })).toBe(false)
})

test('composerNeedsLogin: twitch page with a twitch session can still send', () => {
  expect(composerNeedsLogin({ hsAuth: false, hostPlatform: 'twitch', twitchCookie: 'tok' })).toBe(false)
})

test('input.js wires the hint into live + channel placeholders with the existing key', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
  expect(src.match(/_composerNeedsLogin\(\)\) placeholder = t\('mc_social_login_first'\)/g)?.length).toBe(2)
  const en = JSON.parse(readFileSync(join(import.meta.dir, '..', 'src', '_locales', 'en', 'messages.json'), 'utf8'))
  expect(en.mc_social_login_first.message).toBe('log in at heatsync.org first')
})

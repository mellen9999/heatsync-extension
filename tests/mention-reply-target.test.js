// A native reply to YOU is a mention, on every platform.
//
// isMention() only ever scanned msg.text. Twitch and Kick carry reply linkage
// in tags (reply-parent-display-name → msg.replyTo.user) and leave the text
// alone, so "yeah agreed" in reply to your message scored false: no sound, no
// notification, no mentions-tab entry, no tab badge — while the row visibly
// rendered "↳ replying to you". Only YouTube worked, and only by accident (it
// has no reply API, so the @name is prepended into the text by hand).
//
// isMention and its target helpers are non-module content-script globals in one
// bundled scope, so these run the real source through new Function() rather
// than importing it — same approach as highlight-idempotent.test.js.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const MENTIONS = readFileSync(join(ROOT, 'src', 'multichat', 'mentions.js'), 'utf8')

// Everything from escapeRegex through the end of isMention — the matcher and
// the two helpers it leans on, verbatim from source.
const MATCHER_SRC = MENTIONS.slice(
  MENTIONS.indexOf('function escapeRegex('),
  MENTIONS.indexOf('// Browser notifications'),
)

/**
 * @param {object} opts
 * @param {string} opts.username   - currentUsername (twitch nick)
 * @param {string[]} [opts.aliases] - linked kick/youtube handles
 * @param {string[]} [opts.blocked] - usernames that must never ping you
 * @param {boolean} [opts.enabled]  - the 'mentions' subsystem gate
 */
function makeMatcher({ username, aliases = [], blocked = [], enabled = true }) {
  // `mentionAliases` is declared by the extracted source itself, so it is
  // seeded after that source rather than passed in as a parameter.
  return new Function(
    'currentUsername',
    '_aliases',
    'isEnabled',
    'isUserBlocked',
    'authState',
    'selfKickName',
    `${MATCHER_SRC}
     mentionAliases = new Set(_aliases)
     return isMention`,
  )(
    username,
    aliases,
    () => enabled,
    (name) => blocked.includes((name || '').toLowerCase()),
    { nick: null },
    '',
  )
}

const isMention = makeMatcher({ username: 'mellen', aliases: ['mellenkick'] })

describe('isMention — reply targeting', () => {
  test('a twitch reply to you counts even with no @ in the text', () => {
    expect(isMention({ user: 'someone', text: 'yeah agreed', replyTo: { user: 'mellen' } })).toBe(true)
  })

  test('a reply to a linked platform handle counts', () => {
    expect(isMention({ user: 'someone', text: 'nice', replyTo: { user: 'MellenKick' } })).toBe(true)
  })

  test('reply-target matching is case-insensitive', () => {
    expect(isMention({ user: 'someone', text: 'ok', replyTo: { user: 'MELLEN' } })).toBe(true)
  })

  test('a reply to somebody else is not a mention', () => {
    expect(isMention({ user: 'someone', text: 'yeah agreed', replyTo: { user: 'thirdparty' } })).toBe(false)
  })

  test('your own reply to yourself never pings you', () => {
    expect(isMention({ user: 'mellen', text: 'adding to this', replyTo: { user: 'mellen' } })).toBe(false)
  })

  test('a blocked user replying to you still cannot ping you', () => {
    const m = makeMatcher({ username: 'mellen', blocked: ['troll'] })
    expect(m({ user: 'troll', text: 'hi', platform: 'twitch', replyTo: { user: 'mellen' } })).toBe(false)
  })

  test('the subsystem toggle still kills reply mentions', () => {
    const m = makeMatcher({ username: 'mellen', enabled: false })
    expect(m({ user: 'someone', text: 'hi', replyTo: { user: 'mellen' } })).toBe(false)
  })

  test('a message with no replyTo is unaffected', () => {
    expect(isMention({ user: 'someone', text: 'unrelated chatter', replyTo: null })).toBe(false)
    expect(isMention({ user: 'someone', text: 'hey @mellen', replyTo: null })).toBe(true)
  })

  test('a malformed replyTo does not throw', () => {
    expect(isMention({ user: 'someone', text: 'hi', replyTo: {} })).toBe(false)
    expect(isMention({ user: 'someone', text: 'hi', replyTo: { user: null } })).toBe(false)
  })
})

describe('isMention — text matching still holds', () => {
  test('@mention matches', () => {
    expect(isMention({ user: 'someone', text: 'yo @mellen' })).toBe(true)
  })

  test('bare standalone name matches', () => {
    expect(isMention({ user: 'someone', text: 'mellen you there' })).toBe(true)
  })

  test('name inside a longer word does not match', () => {
    expect(isMention({ user: 'someone', text: 'mellenium falcon' })).toBe(false)
  })
})

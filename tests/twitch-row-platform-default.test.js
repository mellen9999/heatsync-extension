// A twitch message carries no `platform`; ids and block keys are filed under `twitch:<name>`.
// Every lookup that takes the platform from a message has to read "none" as twitch.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { userKey } from '../src/lib/user-key.js'

const read = (...p) => readFileSync(join(import.meta.dir, '..', 'src', ...p), 'utf8')

function carve(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`no ${name}`)
  return src.slice(start, src.indexOf('\n}\n', start) + 2)
}

describe('a row with no platform is a twitch row', () => {
  const paint = new Function(
    'knownUserIds',
    'userKey',
    'mcCosmeticsNeedLookup',
    'queueMcCosmeticsLookup',
    'getMcPaintStyle',
    `${carve(read('multichat', 'cosmetics.js'), 'userPaintStyle')}; return userPaintStyle`,
  )(
    new Map([['twitch:alice', '111']]),
    userKey,
    () => false,
    () => {},
    (uid) => `paint-of-${uid}`,
  )

  test('a reply name with no parent id finds its paint by twitch name', () => {
    expect(paint('', 'alice', undefined)).toBe('paint-of-111')
    expect(paint('', 'alice', 'twitch')).toBe('paint-of-111')
  })

  test('a kick chatter with the same name does not take it', () => {
    expect(paint('', 'alice', 'kick')).toBe('')
  })

  test('the reply bar asks with the same default', () => {
    expect(read('multichat', 'main-messages.js')).toContain("userKey(replyLower, m.platform || 'twitch')")
  })
})

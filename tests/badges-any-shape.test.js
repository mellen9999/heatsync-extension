/**
 * renderBadges takes every badges shape a row can carry.
 *
 * A row whose `badges` was an array / Set / object list instead of the
 * "name/version,name/version" string made renderBadges throw
 * ".split is not a function" out of renderMessages, aborting the panel mount:
 * on a Twitch popout the whole extension stayed hidden (opacity 0). The
 * normaliser is carved out of the non-module bundle source and run standalone.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'twitch-api.js'), 'utf8')
const start = SRC.indexOf('function badgesToString')
const end = SRC.indexOf('function renderBadges')
if (start < 0 || end <= start) throw new Error('badgesToString carve markers not found')
const badgesToString = new Function(`${SRC.slice(start, end)}; return badgesToString`)()

describe('badgesToString', () => {
  test('a string passes through untouched', () => {
    expect(badgesToString('moderator/1,subscriber/12')).toBe('moderator/1,subscriber/12')
  })

  test('arrays of strings and of {setID, version} objects', () => {
    expect(badgesToString(['moderator/1', 'vip/1'])).toBe('moderator/1,vip/1')
    expect(badgesToString([{ setID: 'subscriber', version: '12' }, { name: 'vip' }])).toBe('subscriber/12,vip/1')
  })

  test('a Set of badge names (the userstate shape)', () => {
    expect(badgesToString(new Set(['moderator', 'vip']))).toBe('moderator,vip')
  })

  test('anything unreadable draws no badges, it does not throw', () => {
    for (const v of [null, undefined, 0, 7, {}, { a: 1 }, true, [null, 5, {}]]) expect(badgesToString(v)).toBe('')
  })

  test('renderBadges normalises its input before splitting', () => {
    const body = SRC.slice(end, end + 200)
    expect(body.indexOf('badgesToString(badgesStr)')).toBeGreaterThan(-1)
    expect(body.indexOf('badgesToString(badgesStr)')).toBeLessThan(body.indexOf('.split'))
  })
})

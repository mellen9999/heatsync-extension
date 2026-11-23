// The login is held under either of two storage keys: the sealed token, or the clear-text one an
// older build left. The background seals a clear-text token in two writes (set sealed, remove
// clear), and a storage change names only the keys that changed. The overlay read "signed in"
// off each change record alone, so the second write (clear-text removed, sealed not named) read
// as a logout: no composer, no favorites row in the emote menu, until the page was reloaded.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (f) => readFileSync(join(import.meta.dir, '../src/multichat', f), 'utf8')
const src = read('social.js')
const fresh = () => new Function(`${read('auth-state.js')}\nreturn hsAuthAfter`)()

describe('the overlay follows the login across both keys', () => {
  test('the watcher and the first read both go through the kept state', () => {
    expect(src).toContain('hsAuthToken = hsAuthAfter(changes)')
    expect(src).toContain('hsAuthToken = hsAuthRead(data)')
    expect(src).not.toContain('changes.auth_token?.newValue')
  })

  test('sealing a clear-text token (set sealed, then remove clear) stays signed in', () => {
    const after = fresh()
    expect(after({ auth_token_encrypted: { newValue: undefined }, auth_token: { newValue: 'clear' } })).toBe(true)
    expect(after({ auth_token_encrypted: { newValue: 'sealed' } })).toBe(true)
    expect(after({ auth_token: { oldValue: 'clear' } })).toBe(true)
  })

  test('a logout removes the sealed token: signed out', () => {
    const after = fresh()
    expect(after({ auth_token_encrypted: { newValue: 'sealed' }, auth_token: { newValue: undefined } })).toBe(true)
    expect(after({ auth_token_encrypted: { oldValue: 'sealed' } })).toBe(false)
  })

  test('a login from signed out: signed in; a change that names neither key changes nothing', () => {
    const after = fresh()
    expect(after({ auth_token_encrypted: { newValue: undefined }, auth_token: { newValue: undefined } })).toBe(false)
    expect(after({ user_info: { newValue: { id: 7 } } })).toBe(false)
    expect(after({ auth_token_encrypted: { newValue: 'sealed' } })).toBe(true)
    expect(after({ user_info: { newValue: { id: 8 } } })).toBe(true)
  })
})

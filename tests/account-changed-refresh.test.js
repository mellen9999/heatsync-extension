/**
 * Linking twitch on heatsync.org must reach the ext without a restart: the
 * cached user_info decides your sender_keys, and a stale one made a linked
 * user see "your emotes won't render for others here". The server pushes
 * `account:changed` after a link/unlink; a frame sent while the socket was
 * down is lost, so every reconnect re-reads the account too.
 *
 * background.js cannot be imported (top-level chrome.* listeners), so these
 * are source-text invariants, per house pattern.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const BG = readFileSync(new URL('../chrome/background.js', import.meta.url), 'utf8')
const handler = BG.slice(
  BG.indexOf('function handleWSMessage('),
  BG.indexOf('\n}', BG.indexOf('function handleWSMessage(')),
)
const caseBody = (type) => {
  const at = handler.indexOf(`case '${type}':`)
  return at === -1 ? '' : handler.slice(at, handler.indexOf('break', at))
}

describe('account refresh', () => {
  test('account:changed re-reads the account', () => {
    expect(caseBody('account:changed')).toContain('fetchUserInfo()')
  })
  test('a reconnect re-reads the account, the first auth of a worker does not', () => {
    const auth = caseBody('authenticated')
    expect(auth).toMatch(/if \(wsAuthedOnce\) fetchUserInfo\(\)/)
    expect(auth).toContain('wsAuthedOnce = true')
  })
})

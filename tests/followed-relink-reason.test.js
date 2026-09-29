/**
 * /api/twitch/followed-channels answers `relink_required` for two unrelated
 * situations: the twitch token is dead (`reason: 'expired'`), or the token is
 * fine and the grant simply never included user:read:follows
 * (`reason: 'scope'`). The cockpit used to say "your twitch link expired" for
 * both, sending someone whose link works hunting for a break that isn't there.
 *
 * background.js and multichat-core are non-ESM scripts that register
 * listeners at import time, so this asserts on the SOURCE the way
 * automod-401-split.test.js does: the followed-channels handler must forward
 * `reason`, and the cockpit must pick a different sentence for 'scope'.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const BG = readFileSync(join(ROOT, 'chrome', 'background.js'), 'utf8')
const MGMT = readFileSync(join(ROOT, 'src', 'multichat', 'channel-mgmt.js'), 'utf8')
const EN = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8'))

/** The followed-channels handler, from its message match to the next one. */
function followedHandler() {
  const start = BG.indexOf("message.type === 'get_twitch_followed_channels'")
  expect(start).toBeGreaterThan(-1)
  const end = BG.indexOf('message.type ===', start + 1)
  return BG.slice(start, end)
}

test('background forwards the server reason on a followed-channels failure', () => {
  const h = followedHandler()
  expect(h).toMatch(/reason: data\?\.reason/)
  // and only on the failure path — a success answer is the server body as-is
  expect(h).toMatch(/sendResponse\(data\)/)
})

test('cockpit says a different sentence for a narrowed grant than for a dead token', () => {
  const branch = MGMT.slice(MGMT.indexOf("err === 'relink_required'"), MGMT.indexOf("err === 'relink_required'") + 400)
  expect(branch).toMatch(/resp\?\.reason === 'scope' \? 'mc_fill_cockpit_relink_scope' : 'mc_fill_cockpit_relink'/)
})

test('the narrowed-grant sentence never claims the link expired', () => {
  const dead = EN.mc_fill_cockpit_relink.message
  const scope = EN.mc_fill_cockpit_relink_scope.message
  expect(dead).toMatch(/expired/)
  expect(scope).not.toMatch(/expired/)
  expect(scope).toMatch(/follows/)
  expect(scope).not.toBe(dead)
})

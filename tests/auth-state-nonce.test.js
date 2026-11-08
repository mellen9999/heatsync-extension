// Regression guard for the set_auth_token identity-fixation defense in
// chrome/background.js. background.js is copied verbatim (COPY_FILES) and
// registers chrome.runtime.onMessage at top level, so it can't be imported
// (same constraint as background-helpers.test.js) — assert on source instead.
//
// The bug this guards against: a login-state nonce that is only enforced when
// present. `if (message.state && message.state !== storedState)` lets an
// attacker omit ext_state entirely (crafted heatsync.org/?auth_token= link)
// and slip past the check while a login is pending. The fix requires a bare
// mismatch check so a MISSING state is also rejected.

import { describe, expect, test } from 'bun:test'
import { bgSource } from './bg-src.js'

const BG = bgSource()

describe('set_auth_token state-nonce enforcement', () => {
  const idx = BG.indexOf("message.type === 'set_auth_token'")
  test('the set_auth_token handler exists', () => {
    expect(idx).toBeGreaterThan(-1)
  })
  const region = BG.slice(idx, idx + 1500)

  test('it consumes and compares the stored login nonce', () => {
    expect(region).toMatch(/hs_login_state/)
    expect(region).toMatch(/storedState/)
  })

  test('rejects a MISSING or mismatched state (no message.state-present short-circuit)', () => {
    expect(region).toMatch(/if\s*\(message\.state !== storedState\)/)
    // the old permissive form must be gone
    expect(region).not.toMatch(/message\.state && message\.state !== storedState/)
  })
})

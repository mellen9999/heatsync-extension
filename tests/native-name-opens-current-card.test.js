/**
 * "one profile card everywhere" — part 3. b6ea234d unified every OVERLAY
 * name (`.hs-mc-user`) onto the current btop-style card; dbda609d then made
 * a native name route through it too, but only WHEN the overlay was mounted
 * — otherwise it fell back to content.js's own legacy `.hs-pc-panel` card
 * with its `/ban`-typed-into-chat-input mod path and drag-to-reposition.
 *
 * This round deletes that legacy card entirely. content.js is now a thin,
 * unconditional router: ANY native name click dispatches the same
 * `hs-pcard-open` bridge event pcard-early.js uses for overlay names — no
 * more `#hs-mc-container` branch, no more `showCard` fallback. profile-
 * card.js's renderProfileCardView owns BOTH outcomes now: embedded in the
 * overlay's message pane when it's mounted (unchanged), or a floating mount
 * at the clicked name (`pcResolveMount`/`pcPositionFloating`/`pcFollowAnchor`)
 * when it isn't — the exact case the old card used to own. Mod actions on
 * the floating card go through the SAME GQL dispatch the embedded card uses
 * (dispatchModAction/modTwitchUser/vipTwitchUser), not the old text-
 * injection path.
 *
 * content.js/profile-card.js have top-level side effects and cannot be
 * imported (house pattern — see reply-name-opens-card.test.js), so this is
 * pinned as a source-text invariant.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')

const CONTENT = read('chrome', 'content.js')
const CARD = read('src', 'multichat', 'profile-card.js')

/** The first `n` chars of a function body, brace-matched from its signature. */
function body(src, signature, n = 1200) {
  const at = src.indexOf(signature)
  expect(at, `signature moved: ${signature}`).toBeGreaterThan(-1)
  return src.slice(at, at + n)
}

describe('content.js: every native chat name click dispatches hs-pcard-open, unconditionally', () => {
  test('the click handler no longer branches on #hs-mc-container', () => {
    const setup = body(CONTENT, 'function setupProfileCard() {', 4000)
    expect(setup).not.toContain('hs-mc-container')
  })

  test('dispatches hs-pcard-open with username, platform, and the clicked element as anchorEl', () => {
    const setup = body(CONTENT, 'function setupProfileCard() {', 4000)
    expect(setup).toContain("new CustomEvent('hs-pcard-open'")
    expect(setup).toContain('detail: { username, platform: getPlatform(), anchorEl: src }')
  })

  test('the legacy card is gone — no buildCardDOM, showCard, handleAction, or /ban text injection', () => {
    for (const dead of [
      'function buildCardDOM(',
      'async function showCard(',
      'function handleAction(',
      'function injectChatCommand(',
      'function buildModSection(',
      'function buildNotesSection(',
      'function buildHistorySection(',
      'function buildPanelFooter(',
      "'hs-profile-card'",
      "'hs-pc-panel'",
    ]) {
      expect(CONTENT).not.toContain(dead)
    }
  })
})

// ── gate off = hands off completely ──────────────────────────────────────
//
// A native name click used to ignore the profile-cards gate outright before
// dbda609d (the old card had no gateOn()/gateAtBoot() check anywhere) — gate
// off still opened the takeover panel. Still true post-deletion: gate off
// must mean no heatsync card at all, so twitch/kick's own native viewer card
// can open as if the extension weren't here — no stopPropagation/
// preventDefault either.

describe('content.js: the profile-cards gate is checked before ANY interception', () => {
  test('gateOn() runs before stopPropagation/preventDefault/dispatch', () => {
    const setup = body(CONTENT, 'function setupProfileCard() {', 4000)
    const gateCheckAt = setup.indexOf('if (!gateOn()) return')
    const stopPropAt = setup.indexOf('e.stopPropagation()')
    const preventDefAt = setup.indexOf('e.preventDefault()')
    const dispatchAt = setup.indexOf("new CustomEvent('hs-pcard-open'")
    expect(gateCheckAt).toBeGreaterThan(-1)
    expect(gateCheckAt).toBeLessThan(stopPropAt)
    expect(gateCheckAt).toBeLessThan(preventDefAt)
    expect(gateCheckAt).toBeLessThan(dispatchAt)
  })

  test('gateOn() mirrors pcard-early.js: same localStorage key, same "missing = on" default', () => {
    const fn = body(CONTENT, 'function gateOn() {', 250)
    expect(fn).toContain("localStorage.getItem('hs_gate_profile-cards') !== '0'")
  })
})

// Real execution of gateOn() against a hand-built localStorage (house pattern
// for self-contained leaf functions — see pcard-early.js's loadPcardEarly()
// in reply-name-opens-card.test.js). Pins the actual on/off contract, not
// just that the string is present.
describe('content.js: gateOn() behavior', () => {
  function loadGateOn(storedValue) {
    const store = {}
    if (storedValue !== undefined) store['hs_gate_profile-cards'] = storedValue
    const fakeLocalStorage = { getItem: (k) => (k in store ? store[k] : null) }
    const src = body(CONTENT, 'function gateOn() {', 250)
    const runner = new Function('localStorage', `${src}\nreturn gateOn()`)
    return runner(fakeLocalStorage)
  }

  test('unset (default / first-ever load) → on', () => {
    expect(loadGateOn(undefined)).toBe(true)
  })

  test('explicitly "0" (mirrored off) → off', () => {
    expect(loadGateOn('0')).toBe(false)
  })

  test('any other stored value → on', () => {
    expect(loadGateOn('1')).toBe(true)
  })
})

describe('profile-card.js: mod/unmod/vip/unvip ride along with the migration (parity with the old card)', () => {
  // The shared card model (card-model.js) is now the ONE mod-actions builder,
  // so this split into two functions: pcBuildModGroups (pure data — which
  // channels/role-grants apply, twitch-only gate) and pcHandleModAction (the
  // delegated click handler that actually calls modTwitchUser/vipTwitchUser),
  // wired via card-render.js's data-hs-card-mod-* attributes.
  test('role grants (mod/vip) are twitch-only', () => {
    const fn = body(CARD, 'function pcBuildModGroups(username) {', 4000)
    expect(fn).toContain("platform === 'twitch'")
    expect(fn).toContain("{ kind: 'mod'")
    expect(fn).toContain("{ kind: 'vip'")
  })
  test('the delegated handler actually grants/revokes moderator and VIP', () => {
    const fn = body(CARD, 'async function pcHandleModAction(btn) {', 3000)
    expect(fn).toContain('modTwitchUser(channelId, login, add)')
    expect(fn).toContain('vipTwitchUser(channelId, login, add)')
  })
})

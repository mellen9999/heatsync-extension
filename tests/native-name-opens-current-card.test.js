/**
 * "one profile card everywhere" — part 2. b6ea234d unified every OVERLAY
 * name (`.hs-mc-user`) onto the current btop-style card. Native Twitch/Kick
 * chat names (`.chat-author__display-name` etc, content.js's own
 * `usernameSelectors`) still opened content.js's OLD `.hs-pc-panel` card,
 * with different UI/orange/behavior — the two cards disagreed on what a
 * name click looked like depending on which DOM rendered the name.
 *
 * Fix: when the multichat overlay is mounted (#hs-mc-container exists —
 * true essentially always once multichat-core.js finds a chat root; it
 * self-heals via startLayoutWatcher's reinject poll), a native name click
 * now dispatches the same `hs-pcard-open` bridge event pcard-early.js uses
 * for overlay names, instead of calling content.js's own `showCard`. The
 * old card is NOT deleted: it's the only thing that CAN render when the
 * overlay isn't mounted (multichat failed to find a chat root, or a
 * transient window during SPA nav before it re-injects) — profile-card.js's
 * renderProfileCardView() hard-requires `#hs-mc-messages`, which only
 * exists inside the overlay, so there's nothing for it to mount into there.
 *
 * profile-card.js has top-level side effects and cannot be imported (house
 * pattern — see reply-name-opens-card.test.js), so this is pinned as a
 * source-text invariant.
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

describe('content.js: a native chat name routes through the overlay when it exists', () => {
  test('the username-click branch checks for #hs-mc-container before deciding which card opens', () => {
    const handler = body(CONTENT, 'const target = e.target.closest(usernameSelectors)', 1800)
    expect(handler).toContain("document.getElementById('hs-mc-container')")
  })

  test('overlay present → dispatches hs-pcard-open (the ONE profile card), not showCard', () => {
    const handler = body(CONTENT, 'const target = e.target.closest(usernameSelectors)', 1800)
    const gateAt = handler.indexOf("document.getElementById('hs-mc-container')")
    const dispatchAt = handler.indexOf("new CustomEvent('hs-pcard-open'")
    const showCardAt = handler.indexOf('showCard(src, e)')
    expect(gateAt).toBeGreaterThan(-1)
    expect(dispatchAt).toBeGreaterThan(gateAt)
    // showCard must still be reachable — it's the no-overlay fallback, not deleted.
    expect(showCardAt).toBeGreaterThan(dispatchAt)
  })

  test('the dispatched event carries username + platform, same detail shape pcard-early.js sends', () => {
    const handler = body(CONTENT, 'const target = e.target.closest(usernameSelectors)', 1800)
    expect(handler).toContain('detail: { username, platform: getPlatform() }')
  })

  test('the old card is not deleted — it is still the fallback for no-overlay pages', () => {
    expect(CONTENT).toContain('async function showCard(target, e) {')
    expect(CONTENT).toContain("cardEl.className = usePanelMode ? 'hs-pc-panel' : 'hs-profile-card'")
  })
})

// ── gate off = hands off completely, on every branch ────────────────────────
//
// A native name click used to ignore the profile-cards gate outright (old
// card had no gateOn()/gateAtBoot() check anywhere) — gate off still opened
// the takeover panel. Fixed alongside the routing migration: gate off must
// mean no heatsync card at all, so twitch/kick's own native viewer card can
// open as if the extension weren't here. That means NOT calling
// stopPropagation/preventDefault either — those are what block the native
// card from opening underneath.

describe('content.js: the profile-cards gate is checked before ANY interception', () => {
  test('gateOn() runs before stopPropagation/preventDefault and before either card path', () => {
    const handler = body(CONTENT, 'const target = e.target.closest(usernameSelectors)', 1800)
    const gateCheckAt = handler.indexOf('if (!gateOn()) return')
    const stopPropAt = handler.indexOf('e.stopPropagation()')
    const preventDefAt = handler.indexOf('e.preventDefault()')
    const containerCheckAt = handler.indexOf("document.getElementById('hs-mc-container')")
    const showCardAt = handler.indexOf('showCard(src, e)')
    expect(gateCheckAt).toBeGreaterThan(-1)
    expect(gateCheckAt).toBeLessThan(stopPropAt)
    expect(gateCheckAt).toBeLessThan(preventDefAt)
    expect(gateCheckAt).toBeLessThan(containerCheckAt)
    expect(gateCheckAt).toBeLessThan(showCardAt)
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

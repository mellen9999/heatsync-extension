import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * The dead-man switch that restores native Twitch chat.
 *
 * heatsync hides Twitch's own chat and puts its panel in that space. This
 * watchdog un-hides it when the panel looks dead — the heartbeat native-tap.js
 * writes has gone stale (>45s) or no mount pass ever confirmed. Failing open is
 * right: the worst outcome is a user with no chat at all.
 *
 * Two things it got wrong, both provable without reproducing a fire:
 *
 * 1. THE REMEDY LATCHED. _updateNativeSuppress (native-tap.js) only suppresses
 *    while native chat is invisible — that check exists to notice the USER
 *    revealing it. The watchdog's own setNativeChatHidden(false) is
 *    indistinguishable from that, so suppression could never resume: one 45s
 *    timing blip during a slow cold boot cost the takeover for the rest of the
 *    page load, with reload the only way back.
 *
 * 2. THE LOG NAMED BOTH CONDITIONS AND COMMITTED TO NEITHER ("suppression stale
 *    or overlay render not confirmed"), so a CORRECT fire — boot still in
 *    progress, tap not started, working as designed — read identically to a
 *    spurious one on a healthy overlay. This is not reproducible on demand, so
 *    a single occurrence has to carry enough to tell them apart.
 */

const MAIN = readFileSync(new URL('../src/multichat/main.js', import.meta.url), 'utf8')
const TAP = readFileSync(new URL('../src/multichat/native-tap.js', import.meta.url), 'utf8')

const watchdog = (() => {
  const i = MAIN.indexOf('function startNativeHiddenWatchdog()')
  expect(i).toBeGreaterThan(-1)
  return MAIN.slice(i, i + 2000)
})()

describe('native-hidden watchdog', () => {
  test('the guard it trips is still the one this reasoning depends on', () => {
    // If suppression stops depending on native chat being invisible, the latch
    // described above no longer exists and the re-arm below is dead weight.
    expect(TAP).toContain('!_nsNativeChatVisible()')
  })

  test('a forced reveal is marked as ours, not the user’s', () => {
    expect(watchdog).toContain('_watchdogForcedNative = true')
  })

  test('a later healthy mount pass re-arms the takeover', () => {
    const i = MAIN.indexOf('function _markOverlayRenderOk(')
    expect(i).toBeGreaterThan(-1)
    const block = MAIN.slice(i, i + 900)
    expect(block).toMatch(/if \(ok && _watchdogForcedNative\)/)
    expect(block).toContain('setNativeChatHidden(true)')
    // Cleared before re-hiding, so a repeated failure can't loop.
    expect(block.indexOf('_watchdogForcedNative = false')).toBeLessThan(block.indexOf('setNativeChatHidden(true)'))
  })

  test('the re-arm only ever follows a CONFIRMED pass', () => {
    // _markOverlayRenderOk(false) must not re-hide — that would hide native
    // chat exactly when the overlay is known broken, leaving no chat at all.
    const i = MAIN.indexOf('function _markOverlayRenderOk(')
    const block = MAIN.slice(i, i + 900)
    expect(block).toMatch(/if \(ok && /)
  })

  test('the warning says which condition tripped, and by how much', () => {
    expect(watchdog).toMatch(/beat=\$\{age\}/)
    expect(watchdog).toMatch(/stale=\$\{stale\}/)
    expect(watchdog).toMatch(/renderOk=\$\{_hsOverlayRenderOk\}/)
    // Row count separates "panel was empty" from "panel was fine" — the exact
    // thing that could not be answered about the one observed fire.
    expect(watchdog).toMatch(/overlayRows=/)
    expect(watchdog).not.toContain('suppression stale or overlay render not confirmed')
  })
})

/**
 * F-ext-4 — the injected profile-card/context-menu carried no self-authored
 * ARIA: no role="dialog", no role="menu"/menuitem, no focus management.
 * Escape-closes already existed for both (content.js's card, placeAndWireMenu's
 * onKey for the menu) — this pinned the rest: dialog/menu roles, and focus
 * moving in on open and back to the opener on close.
 *
 * The card itself later moved (phase 2 of the shared-card migration):
 * content.js no longer builds a card at all — it's a thin router that
 * dispatches hs-pcard-open, and src/multichat/profile-card.js's
 * renderProfileCardView/closeProfileCard own the dialog semantics for both
 * the embedded overlay panel and the floating (no-overlay, native page)
 * mount. Same assertions, new home. The context-menu half is untouched
 * (still content.js) and unaffected.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(new URL('..', import.meta.url).pathname, 'chrome', 'content.js'), 'utf8')
const CARD = readFileSync(join(new URL('..', import.meta.url).pathname, 'src', 'multichat', 'profile-card.js'), 'utf8')

describe('profile card — role=dialog + focus management', () => {
  const renderStart = CARD.indexOf('function renderProfileCardView() {')
  const closeStart = CARD.indexOf('function closeProfileCard() {')
  const renderBody = CARD.slice(renderStart, renderStart + 6000)
  const closeBody = CARD.slice(closeStart, closeStart + 800)

  test('sanity: found both functions', () => {
    expect(renderStart).toBeGreaterThan(-1)
    expect(closeStart).toBeGreaterThan(-1)
  })

  test('the card declares role="dialog" with an aria-label', () => {
    expect(renderBody).toContain(`card.setAttribute('role', 'dialog')`)
    expect(renderBody).toContain(`card.setAttribute('aria-label',`)
  })

  test('opening the card captures the previously-focused element', () => {
    expect(CARD).toContain('openerEl: document.activeElement')
  })

  test('opening the card moves focus into it, once real content exists', () => {
    expect(renderBody).toMatch(/card\.focus\(\{\s*preventScroll:\s*true\s*\}\)/)
  })

  test('closing the card restores focus to the opener', () => {
    expect(closeBody).toContain('openerEl?.isConnected')
    expect(closeBody).toMatch(/openerEl\.focus\(/)
  })

  test('Escape already closes the card (pre-existing, not re-broken)', () => {
    expect(CARD).toMatch(/if \(!activeProfileCard\) return[\s\S]{0,400}e\.key === 'Escape'/)
  })
})

describe('message context menu — role=menu/menuitem + focus management', () => {
  const menuFnStart = SRC.indexOf('function placeAndWireMenu(')
  const menuFnBody = SRC.slice(menuFnStart, menuFnStart + 1200)
  const closeFnStart = SRC.indexOf('function closeEmoteMenu() {')
  const closeFnBody = SRC.slice(closeFnStart, closeFnStart + 700)
  const addItemStart = SRC.indexOf('const addItem = (label, fn,')
  const addItemBody = SRC.slice(addItemStart, addItemStart + 500)

  test('sanity: found the shared menu helpers', () => {
    expect(menuFnStart).toBeGreaterThan(-1)
    expect(closeFnStart).toBeGreaterThan(-1)
    expect(addItemStart).toBeGreaterThan(-1)
  })

  test('the menu container declares role="menu"', () => {
    expect(menuFnBody).toContain(`el.setAttribute('role', 'menu')`)
  })

  test('each menu row declares role="menuitem"', () => {
    expect(addItemBody).toContain(`it.setAttribute('role', 'menuitem')`)
  })

  test('opening the menu captures the previously-focused element', () => {
    expect(menuFnBody).toContain('_emoteMenuOpenerEl = document.activeElement')
  })

  test('opening the menu moves focus into it (pre-existing, not re-broken)', () => {
    expect(menuFnBody).toMatch(/el\.focus\(\{\s*preventScroll:\s*true\s*\}\)/)
  })

  test('closing the menu restores focus to the opener', () => {
    expect(closeFnBody).toContain('_emoteMenuOpenerEl?.isConnected')
    expect(closeFnBody).toMatch(/_emoteMenuOpenerEl\.focus\(/)
  })

  test('Escape already closes the menu (pre-existing, not re-broken)', () => {
    expect(SRC).toMatch(/ev\.key === 'Escape'[\s\S]{0,60}closeEmoteMenu\(\)/)
  })
})

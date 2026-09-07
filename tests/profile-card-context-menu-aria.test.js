/**
 * F-ext-4 — the injected profile-card/context-menu carried no self-authored
 * ARIA: no role="dialog", no role="menu"/menuitem, no focus management.
 * Escape-closes already existed for both (content.js:9509 for the card,
 * placeAndWireMenu's onKey for the menu) — this pins the rest: dialog/menu
 * roles, and focus moving in on open and back to the opener on close.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(new URL('..', import.meta.url).pathname, 'chrome', 'content.js'), 'utf8')

describe('profile card — role=dialog + focus management', () => {
  const showCardStart = SRC.indexOf('async function showCard(target, e) {')
  const closeCardStart = SRC.indexOf('function closeCard() {')
  const showCardBody = SRC.slice(showCardStart, showCardStart + 6000)
  const closeCardBody = SRC.slice(closeCardStart, closeCardStart + 600)

  test('sanity: found both functions', () => {
    expect(showCardStart).toBeGreaterThan(-1)
    expect(closeCardStart).toBeGreaterThan(-1)
  })

  test('the card declares role="dialog" with an aria-label', () => {
    expect(showCardBody).toContain(`cardEl.setAttribute('role', 'dialog')`)
    expect(showCardBody).toContain(`cardEl.setAttribute('aria-label',`)
  })

  test('opening the card captures the previously-focused element', () => {
    expect(showCardBody).toContain('cardOpenerEl = document.activeElement')
  })

  test('opening the card moves focus into it', () => {
    expect(showCardBody).toMatch(/cardEl\.focus\(\{\s*preventScroll:\s*true\s*\}\)/)
  })

  test('closing the card restores focus to the opener', () => {
    expect(closeCardBody).toContain('cardOpenerEl?.isConnected')
    expect(closeCardBody).toMatch(/cardOpenerEl\.focus\(/)
  })

  test('Escape already closes the card (pre-existing, not re-broken)', () => {
    expect(SRC).toMatch(/e\.key === 'Escape' && cardEl/)
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

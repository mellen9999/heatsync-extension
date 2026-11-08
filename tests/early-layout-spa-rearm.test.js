/**
 * early-layout.js re-arms its prepaint on SPA navigation.
 *
 * document_start fires once per real page load, so a session that boots on a
 * NON-chat page (refresh on /directory, then click a stream) never prepaints
 * the channel it navigates into — and the <style> is gone by then, removed by
 * the self-destruct. Nothing holds the chat column, so the player lays out
 * full-width and visibly snaps when the overlay finally mounts seconds later.
 *
 * The listener must arm when the column is empty, and must NOT arm when a real
 * panel is already on screen (that would black out chat the user is reading).
 * Runs the REAL file in a minimal DOM so the guards are tested as shipped.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../src/content/early-layout.js', import.meta.url), 'utf8')

/** Minimal DOM + window good enough for early-layout's document_start work. */
function makeEnv({ path = '/xqc', panelWidth = null } = {}) {
  const listeners = []
  const classes = new Set()
  const styles = new Map()

  const el = (id) => ({
    id,
    style: {},
    textContent: '',
    classList: { add() {}, remove() {}, contains: () => false },
    appendChild() {},
    getBoundingClientRect: () => ({ width: panelWidth ?? 0, height: 0 }),
  })

  const documentElement = {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    appendChild: (node) => styles.set(node.id, node),
    attributes: [],
    dataset: {},
  }

  const document = {
    documentElement,
    head: { appendChild: (node) => styles.set(node.id, node) },
    body: { classList: { add() {} } },
    createElement: (tag) => el(tag),
    getElementById: (id) => {
      if (id === 'hs-mc-container') return panelWidth === null ? null : el(id)
      return styles.get(id) || null
    },
    querySelector: () => null,
    addEventListener() {},
  }

  const win = {
    location: {
      hostname: 'www.twitch.tv',
      pathname: path,
      href: `https://www.twitch.tv${path}`,
      origin: 'https://www.twitch.tv',
      hash: '',
    },
    localStorage: { getItem: () => null, setItem() {} },
    addEventListener: (type, fn) => listeners.push([type, fn]),
    document,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout: () => 0,
    clearTimeout() {},
  }

  // run the real file with our fakes as its globals
  const fn = new Function(
    'window',
    'document',
    'location',
    'localStorage',
    'setTimeout',
    'clearTimeout',
    'MutationObserver',
    SRC,
  )
  fn(win, document, win.location, win.localStorage, win.setTimeout, win.clearTimeout, win.MutationObserver)

  const fire = (data, origin = 'https://www.twitch.tv') => {
    for (const [type, cb] of listeners) if (type === 'message') cb({ origin, data })
  }
  return { fire, classes, styles, document }
}

describe('early-layout SPA re-arm', () => {
  test('never arms on a non-chat page — no black bar while browsing', () => {
    const env = makeEnv({ path: '/directory', panelWidth: null })
    env.document.documentElement.classList.remove('hs-prepaint-active')
    env.styles.delete('hs-early-layout')

    env.fire({ type: 'heatsync-nav', url: 'https://www.twitch.tv/directory' })

    expect(env.classes.has('hs-prepaint-active')).toBe(false)
    expect(env.styles.has('hs-early-layout')).toBe(false)
  })

  test('arms on a chat page when nothing holds the column', () => {
    const env = makeEnv({ path: '/xqc', panelWidth: null })
    env.document.documentElement.classList.remove('hs-prepaint-active')
    env.styles.delete('hs-early-layout')

    env.fire({ type: 'heatsync-nav', url: 'https://www.twitch.tv/xqc' })

    expect(env.classes.has('hs-prepaint-active')).toBe(true)
    expect(env.styles.has('hs-early-layout')).toBe(true)
  })

  test('does NOT arm when a real panel is already on screen', () => {
    const env = makeEnv({ path: '/xqc', panelWidth: 375 })
    env.document.documentElement.classList.remove('hs-prepaint-active')
    env.styles.delete('hs-early-layout')

    env.fire({ type: 'heatsync-nav', url: 'https://www.twitch.tv/xqc' })

    expect(env.classes.has('hs-prepaint-active')).toBe(false)
    expect(env.styles.has('hs-early-layout')).toBe(false)
  })

  test('ignores messages from another origin', () => {
    const env = makeEnv({ path: '/xqc', panelWidth: null })
    env.document.documentElement.classList.remove('hs-prepaint-active')
    env.styles.delete('hs-early-layout')

    env.fire({ type: 'heatsync-nav' }, 'https://evil.example')

    expect(env.classes.has('hs-prepaint-active')).toBe(false)
  })

  test('ignores unrelated message types', () => {
    const env = makeEnv({ path: '/xqc', panelWidth: null })
    env.document.documentElement.classList.remove('hs-prepaint-active')
    env.styles.delete('hs-early-layout')

    env.fire({ type: 'something-else' })

    expect(env.classes.has('hs-prepaint-active')).toBe(false)
  })
})

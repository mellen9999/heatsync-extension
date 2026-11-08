/**
 * The page side of the tab bridge (see tab-bridge.test.js for the background
 * side). Background opens a hidden tab at `<page>#hs-bridge` to ride a send on:
 *
 *   - the kick content script must answer `kick_bridge_ping` once its relays are
 *     listening (that is the ready signal background waits for);
 *   - nothing else may wake up there — no prepaint black bar (early-layout), no
 *     multichat boot (main.js), because nobody is meant to see that tab and a
 *     booted overlay rebinds the real tab's live feed.
 *
 * early-layout.js runs as shipped in a minimal DOM; content.js is carved.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainSource } from './main-src.js'

const ROOT = join(import.meta.dir, '..')
const EARLY = readFileSync(join(ROOT, 'chrome', 'early-layout.js'), 'utf8')
const CONTENT = readFileSync(join(ROOT, 'chrome', 'content.js'), 'utf8')

/** early-layout.js against a fake document; true when it painted the prepaint bar */
function paints({ hostname, pathname, hash = '' }) {
  const classes = new Set()
  const el = () => ({ id: '', style: {}, textContent: '', appendChild() {}, classList: { add() {}, remove() {} } })
  const document = {
    documentElement: {
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
      appendChild() {},
      attributes: [],
      dataset: {},
    },
    head: { appendChild() {} },
    body: { classList: { add() {} } },
    createElement: el,
    getElementById: () => null,
    querySelector: () => null,
    addEventListener() {},
  }
  const location = { hostname, pathname, hash, href: `https://${hostname}${pathname}${hash}` }
  const win = {
    location,
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null },
    addEventListener() {},
    document,
  }
  new Function(
    'window',
    'document',
    'location',
    'localStorage',
    'sessionStorage',
    'setTimeout',
    'clearTimeout',
    'MutationObserver',
    EARLY,
  )(
    win,
    document,
    location,
    win.localStorage,
    win.sessionStorage,
    () => 0,
    () => {},
    class {
      observe() {}
      disconnect() {}
    },
  )
  return classes.has('hs-prepaint-active')
}

describe('early-layout on a bridge tab', () => {
  test('kick: the privacy page paints a bar for a normal visit, nothing for the bridge', () => {
    // the control — without it the bridge case could pass for the wrong reason
    expect(paints({ hostname: 'kick.com', pathname: '/privacy-policy' })).toBe(true)
    expect(paints({ hostname: 'kick.com', pathname: '/privacy-policy', hash: '#hs-bridge' })).toBe(false)
  })

  test('youtube: the live_chat bridge paints nothing, the real popout still does', () => {
    expect(paints({ hostname: 'www.youtube.com', pathname: '/live_chat', hash: '' })).toBe(true)
    expect(paints({ hostname: 'www.youtube.com', pathname: '/live_chat', hash: '#hs-bridge' })).toBe(false)
  })

  test('twitch channel pages are untouched by the guard', () => {
    expect(paints({ hostname: 'www.twitch.tv', pathname: '/xqc' })).toBe(true)
  })
})

describe('kick content script ping', () => {
  function extractFn(src, name) {
    const start = src.indexOf(`function ${name}(`)
    if (start === -1) throw new Error(`extractFn: "${name}" not found — source drifted`)
    return src.slice(start, src.indexOf('\n  }', start) + 4)
  }
  const block = CONTENT.slice(
    CONTENT.indexOf('function _onMessageKickPing('),
    CONTENT.indexOf('// Debounce reprocessing so rapid emote updates'),
  )
  const mount = (hostname) => {
    const listeners = []
    const chrome = {
      runtime: {
        onMessage: {
          addListener: (fn) => listeners.push(fn),
          removeListener: (fn) => listeners.splice(listeners.indexOf(fn) >>> 0, 1),
        },
      },
    }
    new Function('chrome', 'window', block)(chrome, { location: { hostname } })
    return listeners
  }
  const ask = (listeners, message) => {
    const out = []
    for (const fn of listeners) fn(message, {}, (r) => out.push(r))
    return out
  }

  test('answers the ready ping on kick, and only that message', () => {
    const l = mount('kick.com')
    expect(l.length).toBe(1)
    expect(ask(l, { type: 'kick_bridge_ping' })).toEqual([{ ok: true }])
    expect(ask(l, { type: 'kick_send_relay' })).toEqual([])
  })

  test('a non-kick page never listens', () => {
    expect(mount('www.twitch.tv').length).toBe(0)
  })

  test('registered after every relay it vouches for', () => {
    const at = (name) => CONTENT.indexOf(`chrome.runtime.onMessage.addListener(${name})`)
    const ping = at('_onMessageKickPing')
    expect(ping).toBeGreaterThan(0)
    for (const relay of ['_onMessageKickRelay', '_onMessageKickChatMode', '_onMessageKickModRelay']) {
      expect(at(relay)).toBeGreaterThan(0)
      expect(at(relay)).toBeLessThan(ping)
    }
    expect(extractFn(CONTENT, '_onMessageKickPing')).toContain("'kick_bridge_ping'")
  })
})

describe('multichat boot on a bridge tab', () => {
  test('init() returns on #hs-bridge before it does anything, on every platform', () => {
    const MAIN = mainSource()
    const init = MAIN.slice(MAIN.indexOf('async function init()'))
    const guard = init.indexOf("location.hash.includes('hs-bridge')")
    expect(guard).toBeGreaterThan(0)
    expect(init.slice(guard, guard + 80)).toContain('return')
    // nothing else runs first: the guard is the first statement of the body
    const firstStatement = init.slice(init.indexOf('{') + 1).replace(/\s*\/\/[^\n]*/g, '').trimStart()
    expect(firstStatement.startsWith("if (location.hash.includes('hs-bridge')) return")).toBe(true)
  })
})

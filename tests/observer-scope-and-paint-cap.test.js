/**
 * F11-1 — several one-shot "wait for element" MutationObservers attached to
 * document.documentElement/body with subtree:true instead of a narrower
 * stable ancestor, processing every mutation on an already-churny page
 * (video player, native chat) during their wait window. Fixed to scope onto
 * the platform's own app root (#root twitch, #__next kick), falling back to
 * documentElement/body only when that root isn't present.
 *
 * F11-2 — chrome/youtube-content.js: ytHsPaintCache (uid -> spec) is
 * FIFO-capped, but the accumulated distinct-hash sheet rules (ytHsPaintHashes)
 * were never pruned when their owning cache entries got evicted. Fixed with
 * a cap + rebuild-from-surviving-entries.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const TWITCH_HOST = readFileSync(join(ROOT, 'src', 'multichat', 'twitch-host.js'), 'utf8')
const KICK_HOST = readFileSync(join(ROOT, 'src', 'multichat', 'kick-host.js'), 'utf8')
const MAIN = readFileSync(join(ROOT, 'src', 'multichat', 'main.js'), 'utf8')
const YT_CONTENT = readFileSync(join(ROOT, 'chrome', 'youtube-content.js'), 'utf8')

describe('F11-1: one-shot wait-for-element observers scope off document root, not documentElement/body', () => {
  test('twitch-host.js armBodyWatch observes #root, not body', () => {
    expect(TWITCH_HOST).toContain(`_ttvPpObserver.observe(document.getElementById('root') || document.documentElement`)
  })

  test('twitch-host.js chat-shell reparent wait observes #root, not documentElement', () => {
    expect(TWITCH_HOST).toContain(`obs.observe(document.getElementById('root') || document.documentElement`)
  })

  test('kick-host.js channel-chatroom reparent wait observes #__next, not documentElement', () => {
    expect(KICK_HOST).toContain(`obs.observe(document.getElementById('__next') || document.body`)
  })

  test('main.js generic waitForMount() prefers a platform app root over documentElement', () => {
    expect(MAIN).toContain(
      `const mountRoot = document.getElementById('root') || document.getElementById('__next') || document.body`,
    )
    expect(MAIN).toContain('obs.observe(mountRoot,')
  })

  test('main.js callout-queue fallback observes #root, not bare body', () => {
    expect(MAIN).toContain(
      `_hsCalloutCloseObs.observe(document.getElementById('root') || document.body, { childList: true, subtree: true })`,
    )
  })

  test('no remaining raw documentElement-scoped observe() calls in the fixed files', () => {
    for (const [name, src] of [
      ['twitch-host.js', TWITCH_HOST],
      ['kick-host.js', KICK_HOST],
    ]) {
      const bareDocElObserve = /\.observe\(document\.documentElement,/g
      const hits = [...src.matchAll(bareDocElObserve)]
      expect(hits, `${name} still has a bare documentElement observe()`).toHaveLength(0)
    }
  })
})

describe('F11-2: youtube-content.js paint hash cache is capped and rebuilds', () => {
  test('YT_HSPAINT_HASH_MAX cap constant exists', () => {
    expect(YT_CONTENT).toMatch(/const YT_HSPAINT_HASH_MAX = \d+/)
  })

  test('ytHsPaintHashes is a Map (hash -> css), not an unbounded Set', () => {
    expect(YT_CONTENT).toContain('const ytHsPaintHashes = new Map()')
  })

  test('rebuildYtHsPaintSheetIfOverCap exists and is called after every flush', () => {
    expect(YT_CONTENT).toContain('function rebuildYtHsPaintSheetIfOverCap()')
    expect(YT_CONTENT).toContain('rebuildYtHsPaintSheetIfOverCap()')
  })

  test('the rebuild keeps only hashes still referenced by a surviving cache entry', () => {
    const start = YT_CONTENT.indexOf('function rebuildYtHsPaintSheetIfOverCap()')
    const body = YT_CONTENT.slice(start, start + 900)
    expect(body).toContain('ytHsPaintCache.values()')
    expect(body).toContain('entry.hash')
    expect(body).toContain('ytHsPaintHashes.clear()')
  })

  test('the base sheet CSS (kill-switch + hover-freeze) is a shared constant, not duplicated', () => {
    const occurrences = YT_CONTENT.split('YT_HSPAINT_SHEET_BASE').length - 1
    // declaration + ensureYtHsPaintSheet() use + rebuild() use = 3
    expect(occurrences).toBeGreaterThanOrEqual(3)
  })
})

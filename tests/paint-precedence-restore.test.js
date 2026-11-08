/**
 * Source-level regression guards for two secondary paint bugs found while
 * chasing the "painted username renders blank" investigation
 * (tests/mention-paint-double-anchor.test.js has the primary root cause).
 *
 * Both fixes live in src/multichat/main.js, a single non-module content
 * script — same rationale as tests/background-helpers.test.js and the
 * existing "structural invariant" tests in tests/paints.test.js for pinning
 * behavior in non-importable bundle scripts: assert directly against the
 * source text so a silent revert fails the suite instead of only showing up
 * as a live-DOM bug report again.
 *
 * BUG #2 — resolveMentionColor precedence stomp:
 *   resolveMentionColor resolves an unknown mentioned user's color async and
 *   repaints every visible `a.hs-mc-mention[data-username]` for them. Before
 *   the fix it only skipped elements with a 7TV paint (getMcPaintStyle(uid)),
 *   NOT a HeatSync paint. applyHsPaintToElement clears an element's inline
 *   `style` attribute when it applies a paint (so the class-based paint CSS
 *   isn't out-specificity'd by a leftover inline color) — if this async color
 *   resolve landed afterward, it silently re-added `a.style.color`, which
 *   DOES outrank the class again, stomping the paint back to a flat color.
 *
 * Item 3 — restored/cached rows never get a HeatSync paint:
 *   The "cache-restored fast path" (tab-switch-back / reload) mounts a
 *   previously-built DocumentFragment as-is, bypassing buildMessageDiv
 *   entirely — so paints that resolve AFTER a row was first built, or rows
 *   restored from a session where the paint was already cached, never get
 *   applyHsPaintToElement called on them. The existing code already
 *   re-applies 7TV cosmetics here (updateCosmeticsInPlace) but had no
 *   equivalent HeatSync-paint pass, since hsPaintCache is a separate cache
 *   from mcUserCosmetics.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainSource } from './main-src.js'

const MAIN_SRC = mainSource()

describe('BUG #2 — resolveMentionColor must yield to a resolved HeatSync paint, not just a 7TV one', () => {
  test('the mention-repaint guard checks hasResolvedHsPaint(uid) in addition to getMcPaintStyle(uid)', () => {
    const fnStart = MAIN_SRC.indexOf('function resolveMentionColor(lower) {')
    expect(fnStart).toBeGreaterThan(-1)
    const fnBody = MAIN_SRC.slice(fnStart, fnStart + 1400)
    // Must not stomp on EITHER paint system.
    expect(fnBody).toMatch(/if \(uid && \(getMcPaintStyle\(uid\) \|\| hasResolvedHsPaint\(uid\)\)\) return/)
  })
})

describe('Item 3 — cache-restored rows must re-apply an already-resolved HeatSync paint', () => {
  test('the justRestored fast path calls updateHsPaintsInPlace for uids with hasResolvedHsPaint', () => {
    const marker = '// CACHE-RESTORED FAST PATH'
    const start = MAIN_SRC.indexOf(marker)
    expect(start).toBeGreaterThan(-1)
    // Bounded to this block (ends where PASS A begins).
    const end = MAIN_SRC.indexOf('// PASS A: index existing DOM by msgKey', start)
    expect(end).toBeGreaterThan(start)
    const block = MAIN_SRC.slice(start, end)
    expect(block).toContain('hasResolvedHsPaint(m.userId)')
    expect(block).toContain('updateHsPaintsInPlace(')
  })
})

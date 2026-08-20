import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The overlay's ResizeObserver must be re-pointed whenever the tab bar or input
 * bar is replaced.
 *
 * The bug this pins: the tab bar is `flex-wrap: wrap` with a max-height, so at
 * boot it measures ~307px while still wrapped to five rows and settles to 55px
 * a moment later. _updateMcLayout writes the overlay's top/bottom insets from
 * that measurement, and a ResizeObserver is what catches the shrink and
 * rewrites them.
 *
 * That observer was created once, behind `!resizeObserver`. But
 * ensureUIElements reassigns tabBarElement/inputBarElement on any pass where
 * the platform's re-render took them out of the document — so after a rebuild
 * the observer was watching DETACHED nodes, the shrink never fired, and the
 * overlay kept its boot-time inset for the rest of the session: ~510px of chat
 * instead of ~828px, with 318px of dead space beneath it. The most visible
 * possible first-run defect, and it survived because nothing in the suite can
 * see geometry.
 *
 * This is a source-contract tripwire, not a behavioural test — it stops the
 * one-time guard from coming back. The real proof is the geometry assertion in
 * the browser harness; until that lands, this is the guard that exists.
 */

const MAIN = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')

/** Slice from an anchor to its matching closing brace. */
function spanFrom(src, anchor) {
  const start = src.indexOf(anchor)
  if (start === -1) throw new Error(`anchor not found: ${anchor}`)
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces from: ${anchor}`)
}

/**
 * The wiring block, found from the observer construction rather than from the
 * `if (...)` condition — the condition is exactly what these tests police, so
 * anchoring on it would make a regression explode at import time instead of
 * failing as a named test.
 */
function wiringBlock() {
  const at = MAIN.indexOf('new ResizeObserver(_updateMcLayout)')
  expect(at).toBeGreaterThan(-1)
  const open = MAIN.lastIndexOf('if (tabBarElement && overlayElement', at)
  expect(open).toBeGreaterThan(-1)
  return spanFrom(MAIN.slice(open), '{')
}

describe('overlay layout observer', () => {
  test('is not created once behind a truthiness guard', () => {
    // `!resizeObserver` as the gate on CREATING the observer is the exact bug.
    // It may still appear inside the staleness check, which is a different use.
    expect(MAIN).not.toContain('if (tabBarElement && overlayElement && !resizeObserver)')
  })

  test('reconciles the observed nodes against the current elements', () => {
    const block = wiringBlock()
    expect(block).toContain('_roWatched')
    expect(block).toContain('watch.some(')
    // Both bars must be candidates — the input bar is rebuilt independently of
    // the tab bar and drives the overlay's bottom inset.
    expect(block).toContain('tabBarElement')
    expect(block).toContain('inputBarElement')
  })

  test('drops the previous observer before wiring a new one', () => {
    const block = wiringBlock()
    // Otherwise every rebuild leaves another live observer on a detached node.
    expect(block).toMatch(/untrackObserver\(resizeObserver\)|resizeObserver\.disconnect\(\)/)
  })

  test('recomputes layout on every pass, not only when it rewires', () => {
    const block = wiringBlock()
    // A rebuild hands _updateMcLayout a fresh closure with an empty signature
    // and fresh nodes carrying none of the old inline insets, so the recompute
    // must sit outside the `stale` branch.
    const staleBranch = spanFrom(block.slice(block.indexOf('if (stale)')), '{')
    expect(staleBranch).not.toContain('_updateMcLayout()')
    expect(block).toContain('_updateMcLayout()')
  })

  test('the watch list is cleared wherever the observer is dropped', () => {
    // reinject() nulls the element refs and the observer; leaving _roWatched
    // populated would make the next pass believe it is still correctly wired.
    // Assignments only — the `let resizeObserver = null` declaration is not a drop.
    const drops = [...MAIN.matchAll(/(?<!let )resizeObserver = null/g)]
    expect(drops.length).toBeGreaterThan(0)
    for (const m of drops) {
      expect(MAIN.slice(m.index, m.index + 60)).toContain('_roWatched = []')
    }
  })
})

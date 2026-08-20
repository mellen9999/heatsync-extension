import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The picker's lazy chunk-fill needs ONE observer PER SCROLL ROOT.
 *
 * An IntersectionObserver bakes its `root` in at construction, and a target
 * that is not a descendant of that root is never reported as intersecting —
 * it does not throw, it simply never fires.
 *
 * ensureChunkObserver took a scrollRoot argument and then returned a single
 * cached observer for ANY root. attachChunkObserver is called with the search
 * `grid` at two sites and with the whole `picker` at a third, so whichever ran
 * first won the cache: with the grid first, every picker-level chunk got an
 * observer rooted inside the grid and could never lazy-fill. It was masked by
 * renderVisibleChunks eagerly filling the first 16 chunks, so the picker looked
 * fine until you scrolled.
 *
 * Same shape as the boot-latch ResizeObserver: something cached once, keyed to
 * a node, handed back for a different node.
 */

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8')

describe('chunk observer is keyed by scroll root', () => {
  test('observers are stored per root, not in one global', () => {
    expect(SRC).toContain('_chunkObservers')
    // a bare `let _chunkObserver = null` global is the bug
    expect(SRC).not.toMatch(/let\s+_chunkObserver\s*=/)
  })

  test('ensureChunkObserver looks the root up before creating one', () => {
    const at = SRC.indexOf('function ensureChunkObserver(')
    expect(at).toBeGreaterThan(-1)
    const body = SRC.slice(at, at + 900)
    expect(body).toMatch(/_chunkObservers\.get\(\s*scrollRoot\s*\)/)
    expect(body).toMatch(/_chunkObservers\.set\(\s*scrollRoot/)
    // and must not short-circuit on "any observer exists"
    expect(body).not.toMatch(/if\s*\(\s*_chunkObserver\s*\)\s*return/)
  })

  test('the observer unobserves through ITSELF, not an outer binding', () => {
    const at = SRC.indexOf('function ensureChunkObserver(')
    const body = SRC.slice(at, at + 900)
    expect(body).toMatch(/\(entries,\s*self\)/)
    expect(body).toContain('self.unobserve(')
  })

  test('teardown disconnects every root, not just one', () => {
    const at = SRC.indexOf('function clearChunkStore(')
    const body = SRC.slice(at, at + 400)
    expect(body).toMatch(/for\s*\(\s*const\s+\w+\s+of\s+_chunkObservers\.values\(\)\s*\)/)
    expect(body).toContain('_chunkObservers.clear()')
  })
})

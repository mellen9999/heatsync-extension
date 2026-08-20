/**
 * Live paint updates in the multichat overlay.
 *
 * The server broadcasts `cosmetic:changed` when a user saves or clears a paint;
 * background.js forwards it as `cosmetic_changed` and paints.js re-resolves.
 * Two things here are easy to get wrong and silent when wrong:
 *
 *   - re-resolving ids this pane never displayed. The push is a broadcast to
 *     every connected client, so that turns one save into a fetch in every open
 *     chat, for someone most of them have never seen.
 *   - treating "no paint" as nothing to do. That is also what a CLEARED paint
 *     looks like, and it left the old paint on screen until the row scrolled
 *     off — setting a paint updated live, removing one did not.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { compilePaintCss, hashPaintSpec, paintNeedsSpans } from '../src/lib/paint-spec.js'
import {
  clearHsPaintFromElement,
  getHsPaintSpec,
  invalidateHsCosmetics,
  isHsCosmeticFreshForTests,
  markAllHsCosmeticsStale,
  setHsColorEntry,
  setHsPaintEntry,
} from '../src/multichat/paints.js'

const SPEC = {
  v: 1,
  type: 'linear',
  stops: [
    { color: '#ff8700', at: 0 },
    { color: '#fff', at: 100 },
  ],
}

/** Minimal element stand-in — classList + dataset + style, nothing else. */
function fakeEl({ classes = [], text = 'melon', split = false } = {}) {
  const set = new Set(classes)
  const props = new Map()
  return {
    textContent: text,
    dataset: split ? { hsPaintSplit: '1' } : {},
    classList: {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      [Symbol.iterator]: () => set[Symbol.iterator](),
    },
    style: {
      removeProperty: (k) => props.delete(k),
      setProperty: (k, v) => props.set(k, v),
      getPropertyValue: (k) => props.get(k) ?? '',
    },
    _classes: set,
    _props: props,
  }
}

beforeEach(() => {
  // paints.js resolves these from the bundle scope; stub for standalone import.
  globalThis.cleanup = { setTimeout: () => 0 }
  // The real compiler/hash, not fakes — a stubbed hash would let a spec-change
  // bug through. Same pattern as tests/paints.test.js's escapeHtml stand-in.
  globalThis.hashPaintSpec = hashPaintSpec
  globalThis.compilePaintCss = compilePaintCss
  globalThis.paintNeedsSpans = paintNeedsSpans
  globalThis.document = {
    getElementById: () => null,
    querySelectorAll: () => [],
    // `dataset` and `parentNode` are load-bearing: each paint owns a <style>
    // node tagged with its hash so the LRU can drop exactly that one rule.
    createElement: () => ({
      setAttribute() {},
      appendChild() {},
      sheet: null,
      textContent: '',
      dataset: {},
      parentNode: null,
    }),
    head: {
      appendChild(node) {
        node.parentNode = this
        return node
      },
      removeChild(node) {
        node.parentNode = null
      },
    },
  }
})
afterEach(() => {
  globalThis.cleanup = undefined
  globalThis.hashPaintSpec = undefined
  globalThis.compilePaintCss = undefined
  globalThis.paintNeedsSpans = undefined
  globalThis.document = undefined
})

describe('clearHsPaintFromElement', () => {
  test('removes our paint class and collapses per-letter markup', () => {
    const el = fakeEl({ classes: ['hs-mc-user', 'hsp-abc123'], split: true })
    el._props.set('--hsp-t', '1234')
    clearHsPaintFromElement(el)
    expect([...el._classes]).toEqual(['hs-mc-user'])
    expect(el.dataset.hsPaintSplit).toBeUndefined()
    expect(el.textContent).toBe('melon')
    expect(el._props.has('--hsp-t')).toBe(false)
  })

  test('leaves an element we never painted untouched', () => {
    const el = fakeEl({ classes: ['hs-mc-user'] })
    el.dataset.stvPaint = '1'
    clearHsPaintFromElement(el)
    // No hsp- class means not ours — a 7TV paint owns its own styling and
    // stripping it here would blank a cosmetic we do not control.
    expect([...el._classes]).toEqual(['hs-mc-user'])
    expect(el.dataset.stvPaint).toBe('1')
  })

  test('survives a null element', () => {
    expect(() => clearHsPaintFromElement(null)).not.toThrow()
  })
})

describe('invalidateHsCosmetics', () => {
  test('re-resolves a uid this pane has already displayed', () => {
    setHsPaintEntry('live-1', SPEC)
    expect(invalidateHsCosmetics(['live-1'])).toEqual(['live-1'])
    // The old value is deliberately KEPT until the new answer lands: dropping
    // it would flash the name unpainted for a batch interval, and the flush
    // needs the previous hash to tell whether anything actually changed.
    expect(getHsPaintSpec('live-1')).toEqual(SPEC)
  })

  test('ignores uids this pane has never seen', () => {
    expect(invalidateHsCosmetics(['never-rendered-uid'])).toEqual([])
  })

  test('a cached negative counts as seen — this is how a FIRST paint lands', () => {
    setHsPaintEntry('live-2', null)
    expect(invalidateHsCosmetics(['live-2'])).toEqual(['live-2'])
  })

  test('a uid known only by picked colour still re-resolves', () => {
    setHsColorEntry('kick_777', '#ff8700')
    expect(invalidateHsCosmetics(['kick_777'])).toEqual(['kick_777'])
  })

  test('re-resolves only the known subset of a mixed batch', () => {
    setHsPaintEntry('live-3', SPEC)
    expect(invalidateHsCosmetics(['live-3', 'stranger'])).toEqual(['live-3'])
  })

  test('survives junk payloads', () => {
    expect(invalidateHsCosmetics([])).toEqual([])
    expect(invalidateHsCosmetics(null)).toEqual([])
    expect(invalidateHsCosmetics([null, ''])).toEqual([])
  })
})

// The case with no write to announce: a paint renders only while its owner is
// Plus, and nothing is written when a subscription simply expires. The pane
// cache used to be permanent, so the overlay kept painting a lapsed member —
// on their new messages too — for the life of the tab.
describe('cached cosmetics expire', () => {
  test('a freshly resolved uid is trusted, a stale one is not', () => {
    setHsPaintEntry('ttl-1', SPEC)
    markAllHsCosmeticsStale()
    // Nothing resolved it since, so it must not be trusted.
    expect(isHsCosmeticFreshForTests('ttl-1')).toBe(false)
  })

  test('an unknown uid is never fresh', () => {
    expect(isHsCosmeticFreshForTests('never-seen')).toBe(false)
  })

  test('markAllHsCosmeticsStale keeps the values, only the trust', () => {
    setHsPaintEntry('ttl-2', SPEC)
    markAllHsCosmeticsStale()
    // Values survive so names do not flash unpainted while re-resolving.
    expect(getHsPaintSpec('ttl-2')).toEqual(SPEC)
  })
})

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  compilePaintCss,
  hashPaintSpec,
  paintMarkupMode,
  paintNameHtmlFor,
  paintNeedsSpans,
} from '../src/lib/paint-spec.js'
import {
  getHsPaintClass,
  getHsPaintSpec,
  hsPaintUidOfMsg,
  isHsPaintHiddenForUser,
  setHsPaintEntry,
  toggleHsPaintHidden,
} from '../src/multichat/paints.js'

/**
 * Per-user paint hide: the list lives in the synced `hiddenPaintUsers`
 * setting (same key + shape as heatsync.org), is read inside the two cache
 * getters every renderer uses, and a hidden user's paint stays cached so
 * "show" is instant.
 */
const SPEC = { base: { type: 'solid', angle: 0, stops: [{ color: '#ff8700', pos: 0 }] }, effects: [] }
let store
let repaints

beforeEach(() => {
  store = { hiddenPaintUsers: [], showNamePaints: true }
  repaints = []
  globalThis.getSetting = (k) => store[k]
  globalThis.setSetting = (k, v) => {
    store[k] = v
    return true
  }
  globalThis.updateHsPaintsInPlace = (ids) => repaints.push(...ids)
  globalThis.compilePaintCss = compilePaintCss
  globalThis.hashPaintSpec = hashPaintSpec
  globalThis.paintNeedsSpans = paintNeedsSpans
  globalThis.paintMarkupMode = paintMarkupMode
  globalThis.paintNameHtmlFor = paintNameHtmlFor
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ dataset: {}, parentNode: null }),
    head: { appendChild: () => {}, removeChild: () => {} },
  }
})
afterEach(() => {
  for (const k of [
    'getSetting',
    'setSetting',
    'updateHsPaintsInPlace',
    'compilePaintCss',
    'hashPaintSpec',
    'paintNeedsSpans',
    'paintMarkupMode',
    'paintNameHtmlFor',
    'document',
  ])
    globalThis[k] = undefined
})

describe('hide a user’s paint', () => {
  test('toggle flips the synced list, reports the new state, repaints rows', () => {
    expect(toggleHsPaintHidden('u1')).toBe(true)
    expect(store.hiddenPaintUsers).toEqual(['u1'])
    expect(toggleHsPaintHidden('u1')).toBe(false)
    expect(store.hiddenPaintUsers).toEqual([])
    expect(repaints).toEqual(['u1', 'u1'])
  })

  test('hidden → no class and no spec (plain colour fallback); show restores it', () => {
    setHsPaintEntry('u2', SPEC)
    expect(getHsPaintClass('u2')).toMatch(/^hsp-/)
    toggleHsPaintHidden('u2')
    expect(isHsPaintHiddenForUser('u2')).toBe(true)
    expect(getHsPaintClass('u2')).toBe('')
    expect(getHsPaintSpec('u2')).toBeNull()
    toggleHsPaintHidden('u2')
    expect(getHsPaintClass('u2')).toMatch(/^hsp-/)
  })

  test('only the hidden user is affected', () => {
    setHsPaintEntry('a', SPEC)
    setHsPaintEntry('b', SPEC)
    toggleHsPaintHidden('a')
    expect(getHsPaintClass('a')).toBe('')
    expect(getHsPaintClass('b')).toMatch(/^hsp-/)
  })

  test('a bad stored value or no uid never throws and never hides', () => {
    store.hiddenPaintUsers = 'nope'
    expect(isHsPaintHiddenForUser('x')).toBe(false)
    expect(toggleHsPaintHidden('')).toBe(false)
    expect(toggleHsPaintHidden('x')).toBe(true)
    expect(store.hiddenPaintUsers).toEqual(['x'])
  })

  test('the menu uid is the one the name is painted with (twitch first, namespaced fallback)', () => {
    setHsPaintEntry('tw1', SPEC)
    setHsPaintEntry('kick_9', SPEC)
    expect(hsPaintUidOfMsg({ platform: 'twitch', userId: 'tw1', hsPaintUid: 'kick_9' })).toBe('tw1')
    expect(hsPaintUidOfMsg({ platform: 'kick', userId: '123', _uidTwitch: '', hsPaintUid: 'kick_9' })).toBe('kick_9')
    expect(hsPaintUidOfMsg({ platform: 'twitch', userId: 'nopaint' })).toBeNull()
    expect(hsPaintUidOfMsg(null)).toBeNull()
  })

  test('the setting is registered synced under the site’s key', async () => {
    const { SETTINGS } = await import('../src/lib/settings-schema.js')
    const def = SETTINGS.find((d) => d.key === 'hiddenPaintUsers')
    expect(def).toMatchObject({ scope: 'sync', type: 'json', default: [] })
  })
})

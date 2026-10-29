/**
 * Name paints, picked colours and Plus tenure survive a refresh.
 *
 * A refresh used to draw every name plain and paint them as the first batch
 * answered. The answers are saved and put back before the first row renders —
 * but never marked fresh, so each uid still re-resolves and a paint that went
 * away comes off. These pin both halves.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { compilePaintCss, hashPaintSpec, paintNeedsSpans } from '../src/lib/paint-spec.js'
import {
  getHsPaintSpec,
  getHsPickedColor,
  getHsPlusTenureSince,
  hydrateHsCosmetics,
  isHsCosmeticFreshForTests,
} from '../src/multichat/paints.js'

const SPEC = {
  v: 1,
  type: 'linear',
  stops: [
    { color: '#ff8700', at: 0 },
    { color: '#fff', at: 100 },
  ],
}
let blob

beforeEach(() => {
  blob = undefined
  globalThis.cleanup = { setTimeout: () => 0 }
  globalThis.hashPaintSpec = hashPaintSpec
  globalThis.compilePaintCss = compilePaintCss
  globalThis.paintNeedsSpans = paintNeedsSpans
  globalThis.getSetting = () => undefined
  globalThis.browser = { storage: { local: { get: async (k) => ({ [k]: blob }), set: async () => {} } } }
  globalThis.document = {
    getElementById: () => null,
    querySelectorAll: () => [],
    createElement: () => ({
      setAttribute() {},
      appendChild() {},
      sheet: null,
      textContent: '',
      dataset: {},
      parentNode: null,
    }),
    head: { appendChild: (n) => n, removeChild() {} },
  }
})

describe('hydrateHsCosmetics', () => {
  test('puts saved paints, colours and tenure back, and leaves them unconfirmed', async () => {
    blob = {
      at: Date.now(),
      paints: [['persist-a', SPEC]],
      colors: [['yt_persist-a', '#00ff00']],
      plus: [['persist-a', '2024-01-01T00:00:00Z']],
    }
    await hydrateHsCosmetics()
    expect(getHsPaintSpec('persist-a')).toBeTruthy()
    expect(getHsPickedColor('yt_persist-a')).toBe('#00ff00')
    expect(getHsPlusTenureSince('persist-a')).toBe('2024-01-01T00:00:00Z')
    // not fresh: the next sighting of the uid still asks the server
    expect(isHsCosmeticFreshForTests('persist-a')).toBe(false)
  })

  test('ignores a save older than a week, and malformed entries', async () => {
    blob = { at: Date.now() - 8 * 86400000, paints: [['persist-old', SPEC]], colors: [], plus: [] }
    await hydrateHsCosmetics()
    expect(getHsPaintSpec('persist-old')).toBeNull()
    blob = {
      at: Date.now(),
      paints: [
        ['persist-bad', 'nope'],
        ['persist-null', null],
      ],
      colors: [['yt_x', 'red']],
      plus: [],
    }
    await hydrateHsCosmetics()
    expect(getHsPaintSpec('persist-bad')).toBeNull()
    expect(getHsPickedColor('yt_x')).toBeNull()
  })

  test('survives storage that throws', async () => {
    globalThis.browser = {
      storage: {
        local: {
          get: async () => {
            throw new Error('gone')
          },
        },
      },
    }
    await hydrateHsCosmetics()
  })
})

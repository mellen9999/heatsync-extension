import { describe, expect, it } from 'bun:test'
import {
  ALL_SIZES,
  FONT_GRID,
  isBitmapFamily,
  nativeSize,
  sizesFor,
  snapSize,
  VECTOR_SIZES,
} from '../src/lib/font-grid.js'
import { coerceSettingValue, resolveOptions, SETTINGS } from '../src/lib/settings-schema.js'

/**
 * No bitmap face ships any more (system monospace everywhere), so the grid is
 * empty and every family is a vector face that holds any offered size. The
 * module stays because the size control and the site contract are built on it.
 */
describe('font grid', () => {
  it('declares no bitmap face', () => {
    expect(FONT_GRID).toEqual({})
    for (const family of ['monospace', 'twitch', 'custom', '', undefined]) {
      expect(isBitmapFamily(family)).toBe(false)
    }
  })

  it('every family gets the full vector size list', () => {
    for (const family of ['monospace', 'twitch', 'custom', '', undefined]) {
      expect(sizesFor(family)).toEqual(VECTOR_SIZES)
    }
    expect(VECTOR_SIZES).toContain(15)
    expect(VECTOR_SIZES).toContain(13)
  })

  it('snaps an off-list size to the nearest, ties DOWN, and leaves a legal size alone', () => {
    expect(snapSize('monospace', 15)).toBe(15)
    expect(snapSize('monospace', 17)).toBe(16)
    expect(snapSize('monospace', 39)).toBe(22)
    expect(snapSize('monospace', 9)).toBe(10)
  })

  it('survives junk without inventing a size', () => {
    for (const junk of [null, '', 'abc', NaN, {}]) {
      expect(VECTOR_SIZES).toContain(snapSize('monospace', junk))
    }
  })

  it('starts a freshly picked family on a listed size', () => {
    expect(VECTOR_SIZES).toContain(nativeSize('monospace'))
  })
})

describe('fontSize schema entry agrees with the grid', () => {
  const def = SETTINGS.find((d) => d.key === 'fontSize')

  it('is an enum of sizes, not a continuous range', () => {
    expect(def).toBeTruthy()
    expect(def.type).toBe('enum')
    expect(def.control).toBe('sizebtns')
  })

  it('defaults to 15px on the system monospace', () => {
    const famDef = SETTINGS.find((d) => d.key === 'fontFamily')
    expect(famDef.default).toBe('monospace')
    expect(def.default).toBe(15)
    expect(sizesFor(famDef.default)).toContain(def.default)
  })

  it('static options are the union — validate/coerce read them with no family in hand', () => {
    expect(def.options.map((o) => o.value)).toEqual(ALL_SIZES)
  })

  it('every narrowed option is also a valid stored value', () => {
    for (const family of ['monospace', 'twitch', 'custom']) {
      for (const o of def.optionsFor(() => family)) {
        expect(ALL_SIZES, `${family} ${o.value}`).toContain(o.value)
      }
    }
  })
})

describe('fontFamily schema entry', () => {
  const def = SETTINGS.find((d) => d.key === 'fontFamily')

  it('offers no bitmap face', () => {
    expect(def.options.map((o) => o.value)).toEqual(['monospace', 'twitch', 'custom'])
  })

  it('a stored retired bitmap face falls back to the system monospace', () => {
    for (const old of ['CozetteVector', 'GohuFont', 'DepartureMono']) {
      expect(coerceSettingValue(def, old), old).toBe('monospace')
    }
  })
})

describe('resolveOptions — what the settings row actually renders', () => {
  const def = SETTINGS.find((d) => d.key === 'fontSize')
  const withFamily = (fam) => (key) => (key === 'fontFamily' ? fam : undefined)

  it('renders the vector list for every family, set or unset', () => {
    for (const fam of ['monospace', 'twitch', undefined]) {
      expect(resolveOptions(def, withFamily(fam)).map((o) => o.value)).toEqual(VECTOR_SIZES)
    }
  })

  it('falls back to the union rather than blanking the control if a narrower throws', () => {
    // A control with zero options is worse than one showing too many: the user
    // would have no way to set the value at all.
    const broken = {
      options: def.options,
      optionsFor: () => {
        throw new Error('boom')
      },
    }
    expect(resolveOptions(broken, withFamily('monospace'))).toEqual(def.options)
  })

  it('leaves a def without a narrower completely alone', () => {
    const plain = SETTINGS.find((d) => d.type === 'enum' && !d.optionsFor)
    expect(resolveOptions(plain, () => undefined)).toEqual(plain.options)
  })
})

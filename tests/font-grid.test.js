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
import { SETTINGS } from '../src/lib/settings-schema.js'

/**
 * A bitmap face off its cell size is resampled, not smaller. These tests exist
 * so the table cannot be quietly widened to fit a size someone liked, and so
 * the settings schema cannot drift away from it.
 */
describe('font grid', () => {
  it('CozetteVector offers only integer multiples of its 13px cell', () => {
    expect(FONT_GRID.CozetteVector).toEqual([13, 26, 39])
    for (const px of FONT_GRID.CozetteVector) expect(px % 13).toBe(0)
  })

  it('never offers a size CozetteVector does not have', () => {
    // The old control was a continuous range 10-26: one legal size, fifteen smears.
    for (const bad of [10, 11, 12, 14, 15, 16, 18, 20, 22, 24, 25]) {
      expect(sizesFor('CozetteVector')).not.toContain(bad)
    }
  })

  it('snaps off-grid onto the grid and leaves a legal size alone', () => {
    expect(snapSize('CozetteVector', 16)).toBe(13)
    expect(snapSize('CozetteVector', 24)).toBe(26)
    expect(snapSize('CozetteVector', 13)).toBe(13)
    expect(snapSize('CozetteVector', 26)).toBe(26)
  })

  it('resolves a tie downward rather than doubling a chat unasked', () => {
    expect(snapSize('CozetteVector', 19)).toBe(13)
  })

  it('treats an empty family as CozetteVector, matching resolveFontStack', () => {
    // resolveFontStack falls through to the Cozette stack for empty/unknown,
    // so the size policy has to agree or the default install gets the vector list.
    expect(sizesFor('')).toEqual(FONT_GRID.CozetteVector)
    expect(sizesFor(undefined)).toEqual(FONT_GRID.CozetteVector)
    expect(snapSize('', 16)).toBe(13)
  })

  it('a vector face can express every size a bitmap face can', () => {
    // Otherwise switching family destroys a size the new family could hold.
    for (const [family, sizes] of Object.entries(FONT_GRID)) {
      for (const px of sizes) expect(VECTOR_SIZES, `${family} ${px}px`).toContain(px)
    }
  })

  it('vector faces keep the in-between sizes — the grid is opt-in', () => {
    expect(sizesFor('monospace')).toContain(16)
    expect(isBitmapFamily('monospace')).toBe(false)
    expect(isBitmapFamily('twitch')).toBe(false) // Inter is vector, not a bitmap face
    expect(isBitmapFamily('CozetteVector')).toBe(true)
  })

  it('survives junk without inventing a size', () => {
    for (const junk of [null, '', 'abc', NaN, {}]) {
      expect(FONT_GRID.CozetteVector).toContain(snapSize('CozetteVector', junk))
    }
  })

  it('starts a freshly picked family on its native size', () => {
    expect(nativeSize('CozetteVector')).toBe(13)
  })
})

describe('fontSize schema entry agrees with the grid', () => {
  const def = SETTINGS.find((d) => d.key === 'fontSize')

  it('is an enum of sizes, not a continuous range', () => {
    expect(def).toBeTruthy()
    expect(def.type).toBe('enum')
    expect(def.control).toBe('sizebtns')
  })

  it('its default is a size the default family actually has', () => {
    // The registry defaults family to CozetteVector; a default of 14 or 16
    // would make the schema's own defaults a blurry pair.
    const famDef = SETTINGS.find((d) => d.key === 'fontFamily')
    expect(sizesFor(famDef.default)).toContain(def.default)
  })

  it('static options are the union — validate/coerce read them with no family in hand', () => {
    expect(def.options.map((o) => o.value)).toEqual(ALL_SIZES)
  })

  it('optionsFor narrows to exactly the selected family', () => {
    const forCozette = def.optionsFor(() => 'CozetteVector').map((o) => o.value)
    expect(forCozette).toEqual(FONT_GRID.CozetteVector)
    const forVector = def.optionsFor(() => 'monospace').map((o) => o.value)
    expect(forVector).toEqual(VECTOR_SIZES)
    expect(forVector.length).toBeGreaterThan(forCozette.length)
  })

  it('every narrowed option is also a valid stored value', () => {
    // The UI narrows; validation uses the union. A size offered by the UI that
    // the validator would reject is a setting the user cannot actually keep.
    for (const family of ['CozetteVector', 'monospace', 'twitch', 'custom']) {
      for (const o of def.optionsFor(() => family)) {
        expect(ALL_SIZES, `${family} ${o.value}`).toContain(o.value)
      }
    }
  })
})

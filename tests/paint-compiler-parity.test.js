/**
 * The paint compiler is the SITE's code, byte for byte.
 *
 * src/lib/{paint-core,scene-spec,paint-spec,animation-phase,plus-tenure}.js must equal the
 * site repo's files exactly, or a paint renders differently in the
 * extension than on heatsync.org — which is what happened when the copies
 * were mirrored by hand: 1,300 lines of drift in three weeks, an entire
 * scene catalog and a compiler fix that never reached a single extension
 * viewer. scripts/sync-paint-compiler.sh is the only way these files change.
 *
 * animation-phase.js is here because the compiler alone does not make two
 * copies of a paint agree: its `animation-delay` phase-locks only an animation
 * that has never been paused, and both sides pause offscreen names for CPU.
 *
 * Runs against the sibling site checkout when one exists (HS_SITE_DIR, or
 * ../heatsync); the site carries the mirror of this test, so a change to the
 * compiler on either side goes red until the other is synced.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HERE = resolve(import.meta.dir, '..')
const SITE =
  process.env.HS_SITE_DIR ||
  [resolve(HERE, '..', 'heatsync'), resolve(HERE, '..', '..', 'heatsync'), '/home/mellen/projects/heatsync'].find((p) =>
    existsSync(join(p, 'client', 'utils', 'paint-spec.js')),
  )

// Site-relative paths, not bare names — animation-phase.js is the paint
// RUNTIME and lives in client/cosmetics, not beside the compiler.
const FILES = [
  'client/utils/paint-core.js',
  'client/utils/scene-spec.js',
  'client/utils/paint-spec.js',
  // Joined 2026-09-23, when the site split the save-time half of paint-spec.js
  // out of its render path. Nothing here validates a paint, so this copy is
  // inert — mirrored anyway because the two halves are one module's worth of
  // rules, and a validator that drifts is how the two come to disagree about
  // which specs exist.
  'client/utils/paint-authoring.js',
  'client/cosmetics/animation-phase.js',
  // Joined 2026-09-23, alongside the `fill` block's composited-fill runtime.
  // Both are dependency-free leaves (glyph-mask.js takes its logger by
  // injection — setLogger — never by import), which is what lets the
  // extension take them verbatim instead of porting them.
  'client/cosmetics/fill-layers.js',
  'client/cosmetics/glyph-mask.js',
  // Joined 2026-09-16. It had called itself a "SYNCED COPY … keep byte-close"
  // for months with no script and no gate, and had drifted — only by a line
  // wrap biome introduced, but nothing would have said so if it had been more.
  'client/utils/plus-tenure.js',
]

describe('paint compiler parity with the site', () => {
  if (!SITE) {
    // A green run that checked nothing is how 1,300 lines drifted in three
    // weeks. Skipping is allowed only where the sibling cannot exist.
    if (process.env.HS_PARITY_SKIP_OK !== '1') {
      throw new Error(
        'site repo not found beside this checkout — parity cannot be checked. clone heatsync as a sibling, or set HS_PARITY_SKIP_OK=1 where that is impossible (ci, until the site repo is public)',
      )
    }
    test.skip('site repo not present — HS_PARITY_SKIP_OK=1', () => {})
    return
  }
  for (const rel of FILES) {
    const f = rel.slice(rel.lastIndexOf('/') + 1)
    test(`src/lib/${f} is byte-identical to the site's ${rel}`, () => {
      const ours = readFileSync(join(HERE, 'src', 'lib', f), 'utf8')
      const theirs = readFileSync(join(SITE, rel), 'utf8')
      expect(ours === theirs, `run scripts/sync-paint-compiler.sh — ${f} drifted from ${SITE}`).toBe(true)
    })
  }
})

/**
 * FONT-GRID IS A SHARED CONTRACT, NOT A SHARED FILE.
 *
 * Byte parity is the WRONG gate here: the extension exports ALL_SIZES for its
 * settings schema and carries a wider VECTOR_ONLY list (10-22) than the site
 * (14-20), neither of which the site needs. Neither side ships a bitmap face
 * any more, so FONT_GRID is empty on both.
 *
 * What must never drift is what the file's own header always claimed: THE TABLE
 * ROWS THEY SHARE, and the snap semantics. If a face's sizes differ, or
 * snapSize resolves differently, the same account gets a different font size in
 * the extension than on heatsync.org — which is the whole reason the module was
 * copied across in the first place.
 */
const ours = await import(join(HERE, 'src', 'lib', 'font-grid.js'))
const theirs = SITE ? await import(join(SITE, 'client', 'utils', 'font-grid.js')) : null

describe('font-grid contract parity with the site', () => {
  if (!SITE) {
    // A green run that checked nothing is how 1,300 lines drifted in three
    // weeks. Skipping is allowed only where the sibling cannot exist.
    if (process.env.HS_PARITY_SKIP_OK !== '1') {
      throw new Error(
        'site repo not found beside this checkout — parity cannot be checked. clone heatsync as a sibling, or set HS_PARITY_SKIP_OK=1 where that is impossible (ci, until the site repo is public)',
      )
    }
    test.skip('site repo not present — HS_PARITY_SKIP_OK=1', () => {})
    return
  }

  test('every face BOTH ship declares the same sizes', () => {
    // both empty today (no bitmap face ships); a face on one side only is a drift
    expect(Object.keys(ours.FONT_GRID).sort(), 'the two tables list different faces').toEqual(
      Object.keys(theirs.FONT_GRID).sort(),
    )
    for (const family of Object.keys(ours.FONT_GRID)) {
      expect(ours.FONT_GRID[family], `${family} has different sizes in the extension`).toEqual(theirs.FONT_GRID[family])
    }
  })

  test('snapSize agrees for every shared face, across the whole range', () => {
    const shared = Object.keys(ours.FONT_GRID).filter((f) => f in theirs.FONT_GRID)
    for (const family of shared) {
      for (let px = 8; px <= 48; px++) {
        expect(ours.snapSize(family, px), `${family} @ ${px}px snaps differently`).toBe(theirs.snapSize(family, px))
      }
      expect(ours.nativeSize(family)).toBe(theirs.nativeSize(family))
      expect(ours.isBitmapFamily(family)).toBe(theirs.isBitmapFamily(family))
    }
  })

  test('VECTOR_SIZES stays DERIVED on both sides, never hand-listed', () => {
    // A hand-listed vector list stopped at 20 once, so CozetteVector@26 was
    // vector-illegal: switching to a vector font and back silently destroyed
    // the 2x choice, because the intermediate family could not hold it. A
    // vector face renders anything and must never offer FEWER sizes than a
    // bitmap one.
    for (const [side, mod] of [
      ['extension', ours],
      ['site', theirs],
    ]) {
      const bitmap = Object.values(mod.FONT_GRID).flat()
      for (const px of bitmap) {
        expect(mod.VECTOR_SIZES.includes(px), `${side}: VECTOR_SIZES is missing the bitmap size ${px}`).toBe(true)
      }
      expect(mod.VECTOR_SIZES, `${side}: VECTOR_SIZES must be sorted ascending`).toEqual(
        [...mod.VECTOR_SIZES].sort((a, b) => a - b),
      )
    }
  })
})

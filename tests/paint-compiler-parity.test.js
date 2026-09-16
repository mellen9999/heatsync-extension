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
  'client/cosmetics/animation-phase.js',
  // Joined 2026-09-16. It had called itself a "SYNCED COPY … keep byte-close"
  // for months with no script and no gate, and had drifted — only by a line
  // wrap biome introduced, but nothing would have said so if it had been more.
  'client/utils/plus-tenure.js',
]

describe('paint compiler parity with the site', () => {
  if (!SITE) {
    test.skip('site repo not present — parity cannot be checked here', () => {})
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
 * Byte parity is the WRONG gate here, and enforcing it would break both sides:
 * the site ships CozetteVector and DepartureMono, the extension ships only
 * CozetteVector (chrome/fonts/ has one woff2), so their tables cannot match and
 * the extension must not offer a face it does not carry. The extension also
 * exports ALL_SIZES for its settings schema and treats an empty family as
 * CozetteVector, neither of which the site needs.
 *
 * What must never drift is what the file's own header always claimed: THE TABLE
 * ROWS THEY SHARE, and the snap semantics. If CozetteVector's sizes differ, or
 * snapSize resolves differently, the same account gets a different font size in
 * the extension than on heatsync.org — which is the whole reason the module was
 * copied across in the first place.
 */
const ours = await import(join(HERE, 'src', 'lib', 'font-grid.js'))
const theirs = SITE ? await import(join(SITE, 'client', 'utils', 'font-grid.js')) : null

describe('font-grid contract parity with the site', () => {
  if (!SITE) {
    test.skip('site repo not present — parity cannot be checked here', () => {})
    return
  }

  test('every face BOTH ship declares the same sizes', () => {
    const shared = Object.keys(ours.FONT_GRID).filter((f) => f in theirs.FONT_GRID)
    expect(shared.length, 'the two tables share no face at all — one of them is wrong').toBeGreaterThan(0)
    for (const family of shared) {
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

  test('the face inventory is allowed to differ, and the extension carries every face it lists', () => {
    // Named so the next reader does not "fix" the difference by syncing the
    // file: this asymmetry is correct, and the gate above is scoped around it.
    const fonts = readFileSync(join(HERE, 'build.js'), 'utf8')
    for (const family of Object.keys(ours.FONT_GRID)) {
      const shipped = existsSync(join(HERE, 'chrome', 'fonts', `${family}.woff2`))
      expect(shipped || fonts.includes(family), `the extension lists ${family} but ships no face for it`).toBe(true)
    }
  })
})

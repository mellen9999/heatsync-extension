/**
 * The paint compiler is the SITE's code, byte for byte.
 *
 * src/lib/{paint-core,scene-spec,paint-spec,animation-phase}.js must equal the
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

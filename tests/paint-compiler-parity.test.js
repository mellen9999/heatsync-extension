/**
 * The paint compiler is the SITE's code, byte for byte.
 *
 * src/lib/{paint-core,scene-spec,paint-spec}.js must equal the site repo's
 * client/utils files exactly, or a paint renders differently in the
 * extension than on heatsync.org — which is what happened when the copies
 * were mirrored by hand: 1,300 lines of drift in three weeks, an entire
 * scene catalog and a compiler fix that never reached a single extension
 * viewer. scripts/sync-paint-compiler.sh is the only way these files change.
 *
 * Runs against the sibling site checkout when one exists (HS_SITE_DIR, or
 * ../heatsync); the site carries the mirror of this test, so a change to the
 * compiler on either side goes red until the other is synced.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HERE = resolve(import.meta.dir, '..')
const SITE = process.env.HS_SITE_DIR
  || [resolve(HERE, '..', 'heatsync'), resolve(HERE, '..', '..', 'heatsync'), '/home/mellen/projects/heatsync']
    .find((p) => existsSync(join(p, 'client', 'utils', 'paint-spec.js')))

const FILES = ['paint-core.js', 'scene-spec.js', 'paint-spec.js']

describe('paint compiler parity with the site', () => {
  if (!SITE) {
    test.skip('site repo not present — parity cannot be checked here', () => {})
    return
  }
  for (const f of FILES) {
    test(`src/lib/${f} is byte-identical to the site's client/utils/${f}`, () => {
      const ours = readFileSync(join(HERE, 'src', 'lib', f), 'utf8')
      const theirs = readFileSync(join(SITE, 'client', 'utils', f), 'utf8')
      expect(ours === theirs, `run scripts/sync-paint-compiler.sh — ${f} drifted from ${SITE}`).toBe(true)
    })
  }
})

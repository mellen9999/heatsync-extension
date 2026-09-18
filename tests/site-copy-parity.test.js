/**
 * Some of src/lib is the SITE's code, byte for byte.
 *
 * Sibling of paint-compiler-parity.test.js, which guards the name-paint
 * compiler the same way and for the same reason: the two copies of that file
 * were mirrored by hand and drifted 1,300 lines in three weeks.
 *
 * gif-search-remote.js is heatsync.org's gifs-tab fetch layer — the record
 * shape /api/gifs answers with, the search cache, and the grid's keyboard
 * model. The extension paints the same corpus in the same grid, so a second
 * hand-written copy would be two answers to "what is a gif record", and one of
 * them would go stale the first time the payload gained a field. The only seam
 * is `base`: '' on the site, https://heatsync.org here, because a root-relative
 * /api/gifs/... inside a twitch.tv page asks TWITCH for our gifs.
 *
 * scripts/sync-site-copies.sh is the only way these files change, and
 * biome.json leaves them unformatted so a formatter pass cannot break parity.
 *
 * Runs against the sibling site checkout when one exists (HS_SITE_DIR, or
 * ../heatsync); the site carries the mirror of this test, so a change on
 * either side goes red until the other is synced.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HERE = resolve(import.meta.dir, '..')
const SITE =
  process.env.HS_SITE_DIR ||
  [resolve(HERE, '..', 'heatsync'), resolve(HERE, '..', '..', 'heatsync'), '/home/mellen/projects/heatsync'].find((p) =>
    existsSync(join(p, 'client', 'utils', 'gif-search-remote.js')),
  )

const FILES = ['client/utils/gif-search-remote.js']

describe('site-copy parity', () => {
  if (!SITE) {
    test.skip('site repo not present — parity cannot be checked here', () => {})
    return
  }
  for (const rel of FILES) {
    const f = rel.slice(rel.lastIndexOf('/') + 1)
    test(`src/lib/${f} is byte-identical to the site's ${rel}`, () => {
      const ours = readFileSync(join(HERE, 'src', 'lib', f), 'utf8')
      const theirs = readFileSync(join(SITE, rel), 'utf8')
      expect(ours === theirs, `run scripts/sync-site-copies.sh — ${f} drifted from ${SITE}`).toBe(true)
    })
  }

  test('the copy is only reachable with an explicit origin', () => {
    const src = readFileSync(join(HERE, 'src', 'lib', 'gif-search-remote.js'), 'utf8')
    // If the site ever drops the `base` seam, every request the extension makes
    // goes to the host page instead of to us — and a 404 from twitch is not a
    // shape this code can tell from an empty library.
    expect(src).toContain("base = ''")
    expect(readFileSync(join(HERE, 'src', 'multichat', 'gifs.js'), 'utf8')).toContain(
      'createGifSearch({ base: HS_GIF_ORIGIN })',
    )
  })
})

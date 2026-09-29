/**
 * The build stamp: a digest of everything the bundle is built FROM.
 *
 * It used to be `<short sha>[+]-<minute>`. A committed bundle can never carry
 * its own commit's sha, so tests/build.test.js's freshness check could not
 * pass on a checkout — it only ever ran against a bundle build.js had just
 * written, which proves nothing. A digest of src/ + build.js is the same
 * value on every machine for the same inputs: the tracked chrome/ bundle
 * carries it, ci rebuilds and diffs, and a boot event in the diag ring still
 * names the exact code it ran (that was the stamp's original job).
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export function computeBuildStamp(root) {
  const h = createHash('sha256')
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else {
        h.update(relative(root, p))
        h.update('\0')
        h.update(readFileSync(p))
        h.update('\0')
      }
    }
  }
  walk(join(root, 'src'))
  h.update(readFileSync(join(root, 'build.js')))
  return h.digest('hex').slice(0, 12)
}

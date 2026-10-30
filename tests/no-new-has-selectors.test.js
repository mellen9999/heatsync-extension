/**
 * A `:has()` rule is not free: when anything inside its subject's subtree
 * changes, the browser re-checks the rule, and on a busy twitch page (11k nodes,
 * 500 chat rows) two of them cost ~170ms of restyle on EVERY DOM insertion —
 * the "first letter takes a sec" and "everything is laggy" report. Replacing
 * them with a plain class set from JS took that to ~4ms.
 *
 * This is a ratchet, not a ban: the count can only go down. Adding a :has()?
 * Set a class from JS instead, or measure first (getComputedStyle after
 * appending a hidden node to body, on a live chat) and lower this number
 * when you remove one.
 */
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(import.meta.dir, '..', 'src', 'multichat', 'styles')
const MAX = 99

test(':has() rules in the extension styles only go down', () => {
  let n = 0
  for (const f of readdirSync(DIR).filter((x) => x.endsWith('.css'))) {
    n += (readFileSync(join(DIR, f), 'utf8').match(/:has\(/g) || []).length
  }
  expect(n, 'a new :has() rule — see this file header').toBeLessThanOrEqual(MAX)
})

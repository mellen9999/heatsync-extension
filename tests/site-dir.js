// Where the site repo (mellen9999/heatsync) is, for the tests that compare this repo against it
// (ws-contract, paint-compiler-parity, site-copy-parity).
//
//   HS_SITE_DIR=/path/to/heatsync   names it outright (ci's checkout step sets this)
//   otherwise                       a `heatsync` directory beside this checkout, found from a normal
//                                   clone or from `.worktrees/<name>/` (the projects dir is further up
//                                   than it looks from a worktree)
//
// Two rules keep a contract test from proving nothing:
//   - naming a directory that is not the site is an error, never a quiet skip
//   - where the site is required (ci, or HS_REQUIRE_SITE=1), not finding it fails the run; a standalone
//     clone with no sibling still skips. HS_PARITY_SKIP_OK=1 is the one explicit excuse (the release
//     workflow, which builds a commit ci already checked).

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HERE = resolve(import.meta.dir, '..')

/**
 * @param {string} probe a path that exists only in the site repo, relative to its root
 * @returns {string | null} the site checkout, or null when there is none to find
 */
export function siteDir(probe) {
  const named = process.env.HS_SITE_DIR
  if (named) {
    if (!existsSync(join(named, probe))) {
      throw new Error(`HS_SITE_DIR=${named} has no ${probe}: that is not the heatsync site repo`)
    }
    return named
  }
  const candidates = [
    ...['..', '../..', '../../..', '../../../..'].map((up) => resolve(HERE, up, 'heatsync')),
    '/home/mellen/projects/heatsync',
  ]
  return candidates.find((p) => existsSync(join(p, probe))) ?? null
}

/** true where a missing site is a failure, not a skip */
export function siteRequired(env = process.env) {
  return (env.CI === 'true' || env.HS_REQUIRE_SITE === '1') && env.HS_PARITY_SKIP_OK !== '1'
}

/** the message a required-but-missing site fails with */
export const SITE_MISSING =
  'the site repo (mellen9999/heatsync) was not found beside this checkout, and this run requires it: a contract test that skips proves nothing. ' +
  'clone it next to this repo or set HS_SITE_DIR. in ci that is the site checkout step (needs the SITE_DEPLOY_KEY secret).'

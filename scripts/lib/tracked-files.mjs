// The files this repo is made of: what git tracks plus new files it does not
// ignore. In a tree with no git — the AMO source zip, which holds exactly that
// set — it is every file on disk, less the install and build output.
//
// One answer for the source zip (build.js) and for the tests that scan "the
// code" (doctrine ratchets, loc ceilings), so a reviewer's unpacked zip runs
// the same checks over the same files as a checkout does.
//
// `.git` is looked for at `root` itself (a worktree's `.git` is a file, which
// counts): git run from an unpacked zip that happens to sit inside some other
// repo would answer for that repo.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const NOT_SOURCE = new Set(['.git', '.worktrees', 'node_modules', 'dist', 'coverage'])

export const inGit = (root) => existsSync(join(root, '.git'))

/**
 * @param {string} root the repo root
 * @param {...string} paths limit to these paths (files or directories, relative to root); none = all
 * @returns {string[]} root-relative paths with `/` separators, sorted
 */
export function trackedFiles(root, ...paths) {
  if (inGit(root)) {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths], {
      cwd: root,
      maxBuffer: 1 << 26,
    })
    return [...new Set(out.toString().split('\0'))].filter((f) => f && existsSync(join(root, f))).sort()
  }
  const found = []
  const walk = (rel) => {
    const abs = join(root, rel)
    if (!existsSync(abs)) return
    if (!statSync(abs).isDirectory()) return void found.push(rel)
    for (const name of readdirSync(abs)) {
      if (NOT_SOURCE.has(name) || name.endsWith('.staging')) continue
      walk(rel ? `${rel}/${name}` : name)
    }
  }
  for (const p of paths.length ? paths : ['']) walk(p.replace(/\/+$/, ''))
  return found.sort()
}

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every version that reached users has a CHANGELOG.md entry — its own
 * `## [X.Y.Z]` heading, or a `## [A – B]` range that holds it. 34 tagged
 * versions had none on 2026-11-08: the store pages and the github release
 * notes pointed at a changelog that skipped them.
 *
 * The package.json version is always checked (a release is cut from it). The
 * tag sweep runs wherever tags exist; a clone without tags checks the version.
 */
const ROOT = join(import.meta.dir, '..')
const log = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

const single = new Set([...log.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]))
const ranges = [...log.matchAll(/^## \[(\d+\.\d+\.\d+) – (\d+\.\d+\.\d+)\]/gm)].map((m) => [m[1], m[2]])
const covered = (v) => single.has(v) || ranges.some(([a, b]) => cmp(a, v) <= 0 && cmp(v, b) <= 0)

function tags() {
  try {
    return execFileSync('git', ['tag', '-l', 'v*'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .map((t) => t.trim().replace(/^v/, ''))
      .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
  } catch {
    return []
  }
}

describe('changelog', () => {
  test('the version being released has an entry', () => {
    const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(covered(version), `CHANGELOG.md has no "## [${version}]" heading`).toBe(true)
  })

  test('every tagged version has an entry', () => {
    const missing = tags().filter((v) => !covered(v))
    expect(missing, `tagged with no changelog entry: ${missing.join(' ')}`).toEqual([])
  })

  test('the range parser holds a version inside, not outside', () => {
    expect(cmp('1.7.52', '1.7.55') <= 0 && cmp('1.7.55', '1.7.59') <= 0).toBe(true)
    expect(cmp('1.7.9', '1.7.10')).toBeLessThan(0)
  })
})

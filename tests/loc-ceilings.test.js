import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// god-files only grow. the 6 biggest source files each have a ceiling in
// tests/loc-ceilings.txt (line = "<max> <path>  # why"). lines = newline count.
const ROOT = join(import.meta.dir, '..')
const LIST = 'tests/loc-ceilings.txt'
const SRC = /\.(ts|tsx|js|jsx|mjs|cjs)$/
const SKIP =
  /(^|\/)(dist|chrome|node_modules|locales|fixtures|vendor|generated|tests|store-assets|types|docs|\.worktrees)\/|\.min\.|\.d\.ts$/

const count = (p) => {
  const b = readFileSync(join(ROOT, p))
  let n = 0
  for (let i = b.indexOf(10); i !== -1; i = b.indexOf(10, i + 1)) n++
  return n
}

const ceilings = new Map()
for (const l of readFileSync(join(ROOT, LIST), 'utf8').split('\n')) {
  const m = l.match(/^(\d+)\s+(\S+)/)
  if (m) ceilings.set(m[2], Number(m[1]))
}
const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 1 << 26 })
  .toString()
  .split('\0')
  .filter((p) => SRC.test(p) && !SKIP.test(p))
const lines = new Map(files.map((p) => [p, count(p)]))

describe('loc ceilings', () => {
  test('lists 6 files that exist', () => {
    expect(ceilings.size).toBe(6)
    const gone = [...ceilings.keys()].filter((p) => !lines.has(p))
    expect(gone, `${LIST}: gone or not source; remove or replace`).toEqual([])
  })

  test('no listed file is past its ceiling', () => {
    const over = [...ceilings]
      .filter(([p, max]) => (lines.get(p) ?? 0) > max)
      .map(([p, max]) => `${p}: ${lines.get(p)} lines > ceiling ${max}`)
    expect(
      over,
      `split the file, or raise its number in ${LIST} in the same commit with a one-line "# reason" next to it`,
    ).toEqual([])
  })

  test('no unlisted file is past the smallest ceiling', () => {
    const floor = Math.min(...ceilings.values())
    const extra = [...lines]
      .filter(([p, n]) => !ceilings.has(p) && n > floor)
      .map(([p, n]) => `${p}: ${n} lines > ${floor}`)
    expect(
      extra,
      `a new god-file: split it, or add "<${floor + 1}+ lines> <path>  # reason" to ${LIST} (and drop the smallest entry)`,
    ).toEqual([])
  })

  test('hints when a ceiling can drop', () => {
    for (const [p, max] of ceilings) {
      const n = lines.get(p) ?? 0
      if (n < max * 0.9) console.log(`hint: ${p} is ${n} lines, ceiling ${max} — lower it in ${LIST}`)
    }
  })
})

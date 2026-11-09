import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'cov-floor-'))
const run = (body) => {
  const f = join(dir, `${Math.random()}.info`)
  writeFileSync(f, body)
  return Bun.spawnSync(['bun', 'scripts/coverage-floor.ts', f]).exitCode
}
const lcov = (lh, fnh) => `SF:a.js\nFNF:100\nFNH:${fnh}\nLF:100\nLH:${lh}\nend_of_record\n`

test('coverage at the floor passes', () => {
  expect(run(lcov(90, 90))).toBe(0)
})

test('lines or functions under the floor fail', () => {
  expect(run(lcov(10, 90))).toBe(1)
  expect(run(lcov(90, 10))).toBe(1)
})

test('a report with no records fails instead of passing empty', () => {
  expect(run('')).toBe(1)
})

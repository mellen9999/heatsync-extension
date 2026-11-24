/**
 * The AMO source zip (build.js buildSourceZip) is every file scripts/lib/tracked-files.mjs
 * names. It once held a hand-kept list with no scripts/ or shared/, and build.js died on its
 * first import inside the zip. The full proof — unpack, install, build, same bytes — is run by
 * hand (docs/RELEASING.md); this holds the parts that broke.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, normalize, relative } from 'node:path'
import { inGit, trackedFiles } from '../scripts/lib/tracked-files.mjs'

const ROOT = join(import.meta.dir, '..')
const files = new Set(trackedFiles(ROOT))

/** build.js's relative imports, followed through the modules they import */
function buildImports() {
  const seen = new Set()
  const visit = (rel) => {
    if (seen.has(rel)) return
    seen.add(rel)
    const src = readFileSync(join(ROOT, rel), 'utf8')
    for (const m of src.matchAll(/^import [^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      visit(
        relative(ROOT, normalize(join(ROOT, dirname(rel), m[1])))
          .split('\\')
          .join('/'),
      )
    }
  }
  visit('build.js')
  return [...seen]
}

describe('source zip', () => {
  test('build.js zips this list, not a hand-kept one', () => {
    const body =
      readFileSync(join(ROOT, 'build.js'), 'utf8').match(/function buildSourceZip\(\) \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(body).toContain('trackedFiles(__dirname)')
    expect(body).not.toMatch(/const include = \[/)
  })

  test('holds every file build.js imports', () => {
    const imports = buildImports()
    expect(imports.length).toBeGreaterThan(4)
    expect(imports.filter((f) => !files.has(f))).toEqual([])
  })

  test('holds what the build reads and the tests it runs first', () => {
    for (const f of ['package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json', '.gitignore', 'shared/emote-law.ts']) {
      expect(files.has(f)).toBe(true)
    }
    expect([...files].some((f) => f.startsWith('tests/') && f.endsWith('.test.js'))).toBe(true)
  })

  test('never holds install or build output', () => {
    expect([...files].filter((f) => /^(node_modules|dist|coverage)\//.test(f))).toEqual([])
  })

  test('with no git, the file list is the tree less install and build output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hs-tracked-'))
    try {
      for (const f of ['b/c.js', 'a.js', 'node_modules/x/i.js', 'dist/chrome/m.js', 'dist/chrome.staging/s.js']) {
        mkdirSync(join(dir, dirname(f)), { recursive: true })
        writeFileSync(join(dir, f), '')
      }
      expect(inGit(dir)).toBe(false)
      expect(trackedFiles(dir)).toEqual(['a.js', 'b/c.js'])
      expect(trackedFiles(dir, 'b')).toEqual(['b/c.js'])
      expect(trackedFiles(dir, 'missing.js')).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

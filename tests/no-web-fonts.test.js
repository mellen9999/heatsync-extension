import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Zero web fonts. Mirrors heatsync.org's tests/unit/no-web-fonts.test.ts.
 *
 * Every font is the system `monospace` (or the user's own pick in settings),
 * so nothing ships a face, nothing is declared with @font-face and nothing is
 * preloaded. This keeps the retired bitmap faces (CozetteVector, DepartureMono)
 * out for good.
 */

const ROOT = join(import.meta.dir, '..')
const FONT_FILE = /\.(woff2?|ttf|otf|eot)$/i

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git' || name === '.worktrees') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const TRACKED = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'chrome')), join(ROOT, 'build.js')]

/** Strip comments — history in a comment is fine, a live reference is not. */
function code(text, rel) {
  let t = text.replace(/\/\*[\s\S]*?\*\//g, '')
  if (!rel.endsWith('.css')) t = t.replace(/(^|[^:'"`(\\])\/\/[^\n]*/g, '$1')
  return t
}

// the only live mentions allowed: migrating a stored retired choice to monospace
const MIGRATION = new Set(['src/lib/settings-schema.js', 'src/multichat/main.js'])
const SOURCE = TRACKED.filter((p) => /\.(js|css|html|json)$/.test(p)).filter(
  (p) => !/_locales|multichat-core|multichat-twitch|emoji-data|chrome\/manifest\.json/.test(p),
)

describe('no web fonts', () => {
  test('no font files ship', () => {
    expect(TRACKED.filter((p) => FONT_FILE.test(p)).map((p) => relative(ROOT, p))).toEqual([])
    expect(existsSync(join(ROOT, 'chrome', 'fonts'))).toBe(false)
    expect(existsSync(join(ROOT, 'LICENSE-Cozette'))).toBe(false)
  })

  test('no @font-face and no font url() anywhere in source', () => {
    const bad = []
    for (const p of SOURCE) {
      const rel = relative(ROOT, p)
      const t = code(readFileSync(p, 'utf8'), rel)
      if (/@font-face/.test(t)) bad.push(`${rel}: @font-face`)
      if (/url\([^)]*\.(woff2?|ttf|otf|eot)/i.test(t)) bad.push(`${rel}: font url()`)
      if (/rel=["']preload["'][^>]*as=["']font/i.test(t)) bad.push(`${rel}: font preload`)
    }
    expect(bad).toEqual([])
  })

  test('manifests expose no font as a web accessible resource', () => {
    for (const f of ['chrome.json', 'firefox.json']) {
      expect(readFileSync(join(ROOT, 'src', 'manifests', f), 'utf8')).not.toMatch(/fonts\//)
    }
  })

  test('no bitmap face is referenced outside the retired-choice migration', () => {
    const bad = []
    for (const p of SOURCE) {
      const rel = relative(ROOT, p)
      if (MIGRATION.has(rel)) continue
      if (/Cozette|DepartureMono|__HS_FONT_|hs-font-bitmap/i.test(code(readFileSync(p, 'utf8'), rel))) bad.push(rel)
    }
    expect(bad).toEqual([])
  })
})

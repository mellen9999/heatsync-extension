/**
 * D1: ONE reserved-path list. Before this file, nine-plus files each kept
 * their own hand-drifted copy of "these URL slugs are never a channel" —
 * divergence let real garbage (kick.com/video/<id>, 'moderator', 'videos')
 * get treated as a channel name and persisted into joined_extra_channels.
 * src/lib/reserved-paths.js is now the only place the list is declared;
 * everywhere else either imports it (bundled content scripts, via build.js's
 * LIB_ORDER/LIB_EXTRAS) or hand-duplicates the literal under a build-time
 * parity check (background.js/popup.js/early-layout.js — separate JS
 * contexts that can't import it; see build.js checkReservedPathsParity).
 *
 * This is the tripwire: it fails if a divergent literal list grows back in
 * any of the files that should only ever reference the shared constant.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RESERVED_PATHS } from '../src/lib/reserved-paths.js'

const read = (p) => readFileSync(join(import.meta.dir, '..', p), 'utf8')

describe('RESERVED_PATHS', () => {
  test('required additions are present (the union was missing these)', () => {
    for (const slug of ['video', 'following', 'u', 'moderator', 'videos', 'login', 'p', 'search']) {
      expect(RESERVED_PATHS.has(slug)).toBe(true)
    }
  })
  test('is a Set of lowercase, non-empty strings', () => {
    expect(RESERVED_PATHS.size).toBeGreaterThan(50)
    for (const slug of RESERVED_PATHS) {
      expect(typeof slug).toBe('string')
      expect(slug.length).toBeGreaterThan(0)
      expect(slug).toBe(slug.toLowerCase())
    }
  })
})

// Extract a `new Set([...])` literal body the same way build.js's
// checkReservedPathsParity does, sorted so declaration order doesn't matter.
function extractSetLiteral(src, name) {
  const m = src.match(new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`))
  if (!m) return null
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
    .sort()
}

describe('hand-duplicated copies stay in lockstep (build.js enforces this at build time too)', () => {
  const canonical = [...RESERVED_PATHS].sort()

  for (const file of ['chrome/background.js', 'chrome/popup.js', 'chrome/early-layout.js']) {
    test(`${file} declares a RESERVED_PATHS literal matching src/lib/reserved-paths.js`, () => {
      const copy = extractSetLiteral(read(file), 'RESERVED_PATHS')
      expect(copy).not.toBeNull()
      expect(copy).toEqual(canonical)
    })
  }
})

describe('no divergent reserved-path list grew back', () => {
  // Signature slug combos from the nine-plus original copies. If any of
  // these files declares its own array/Set containing these together again
  // (instead of reading RESERVED_PATHS), the split has regressed.
  const SIGNATURE = /\[\s*['"](?:directory|categories|browse|moderator)['"],?\s*['"](?:following|settings|category)['"]/

  for (const file of [
    'src/multichat/main.js',
    'chrome/content.js',
    'chrome/heatsync-button.js',
    'chrome/background.js',
    'chrome/early-layout.js',
    'chrome/popup.js',
  ]) {
    test(`${file} has no inline reserved-path array literal`, () => {
      const src = read(file)
      // Strip out the one sanctioned literal declarations (named RESERVED_PATHS)
      // before scanning for a rogue duplicate.
      const stripped = src.replace(/(?:const|let|var)\s+RESERVED_PATHS\s*=\s*new Set\(\[[\s\S]*?\]\)/g, '')
      expect(SIGNATURE.test(stripped)).toBe(false)
    })
  }

  test('src/multichat/main.js aliases NON_CHANNEL_PATHS / KICK_RESERVED_PATHS to the shared constant', () => {
    const src = read('src/multichat/main.js')
    expect(src).toContain('const NON_CHANNEL_PATHS = RESERVED_PATHS')
    expect(src).toContain('const KICK_RESERVED_PATHS = RESERVED_PATHS')
  })

  test('chrome/content.js aliases TWITCH_EXCLUDED_PATHS to the shared constant', () => {
    expect(read('chrome/content.js')).toContain('const TWITCH_EXCLUDED_PATHS = RESERVED_PATHS')
  })

  test('build.js embeds reserved-paths.js into the content scripts that reference it', () => {
    const build = read('build.js')
    expect(build).toMatch(/LIB_ORDER = \[[\s\S]*?'reserved-paths\.js'[\s\S]*?\]/)
    expect(build).toContain("'content.js': ['config.js', 'user-key.js', 'modifiers.js', 'reserved-paths.js']")
    expect(build).toContain("'heatsync-button.js': ['reserved-paths.js']")
  })
})

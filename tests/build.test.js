import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const DIST_CHROME = join(ROOT, 'dist', 'chrome')
const DIST_FIREFOX = join(ROOT, 'dist', 'firefox')

// This suite validates BUILD OUTPUT (dist/). It runs ONLY when explicitly
// gated by build.js's post-build step (HS_VERIFY_DIST=1), against freshly
// built output. Skipped during plain `bun test` and build.js's pre-build test
// gate — so it never spawns a build (no recursion) and never asserts on stale
// dist after a version bump.
const t = process.env.HS_VERIFY_DIST === '1' ? test : test.skip

// ── output files ─────────────────────────────────────────────────────────────

const coreFiles = [
  'manifest.json',
  'background.js',
  'content.js',
  'multichat-core.js',
  'heatsync-button.js',
  'shared-utils.js',
  'popup.html',
  'popup.js',
  'injected-message.css',
]

for (const file of coreFiles) {
  t(`chrome dist has ${file}`, () => {
    expect(existsSync(join(DIST_CHROME, file))).toBe(true)
  })

  t(`firefox dist has ${file}`, () => {
    expect(existsSync(join(DIST_FIREFOX, file))).toBe(true)
  })
}

// ── manifest parsing ──────────────────────────────────────────────────────────

function readManifest(distDir) {
  return JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8'))
}

t('chrome manifest is valid json with required fields', () => {
  const m = readManifest(DIST_CHROME)
  expect(m.manifest_version).toBe(3)
  expect(typeof m.name).toBe('string')
  expect(typeof m.version).toBe('string')
  expect(typeof m.description).toBe('string')
  expect(Array.isArray(m.content_scripts)).toBe(true)
  expect(m.background?.service_worker).toBeTruthy()
})

t('firefox manifest is valid json with required fields', () => {
  const m = readManifest(DIST_FIREFOX)
  expect(m.manifest_version).toBe(2)
  expect(typeof m.name).toBe('string')
  expect(typeof m.version).toBe('string')
  expect(typeof m.description).toBe('string')
  expect(Array.isArray(m.content_scripts)).toBe(true)
  expect(Array.isArray(m.background?.scripts)).toBe(true)
})

// ── version sync ──────────────────────────────────────────────────────────────

t('versions match across package.json and both manifests', async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const chrome = readManifest(DIST_CHROME)
  const firefox = readManifest(DIST_FIREFOX)
  expect(chrome.version).toBe(pkg.version)
  expect(firefox.version).toBe(pkg.version)
})

// ── CSP ───────────────────────────────────────────────────────────────────────

t('chrome manifest has CSP', () => {
  const m = readManifest(DIST_CHROME)
  expect(m.content_security_policy).toBeTruthy()
})

t('firefox manifest has CSP', () => {
  const m = readManifest(DIST_FIREFOX)
  expect(typeof m.content_security_policy).toBe('string')
  expect(m.content_security_policy.length).toBeGreaterThan(0)
})

// ── content script files exist in dist ───────────────────────────────────────

function collectScripts(manifest) {
  const scripts = new Set()
  for (const entry of manifest.content_scripts ?? []) {
    for (const file of entry.js ?? []) scripts.add(file)
  }
  return scripts
}

t('all chrome content script files exist in dist', () => {
  const m = readManifest(DIST_CHROME)
  for (const file of collectScripts(m)) {
    expect(existsSync(join(DIST_CHROME, file))).toBe(true)
  }
})

t('all firefox content script files exist in dist', () => {
  const m = readManifest(DIST_FIREFOX)
  for (const file of collectScripts(m)) {
    expect(existsSync(join(DIST_FIREFOX, file))).toBe(true)
  }
})

// ── bare `cleanup` resolves in every bundle ──────────────────────────────────
// cleanup.js is the one lib file whose state hides behind an IIFE (window-keyed
// cross-bundle dedupe), so bundles need its explicit `const cleanup =
// window.heatsyncCleanup` re-export. When that binding was missing, any bundle
// using bare `cleanup.` threw ReferenceError at first use — silently (DEBUG-
// gated catches): yt native chat was dead 04-27→07-05, heatsync-button lost
// its SPA-nav/retry timers.

// Minification-tolerant: release CI verifies MINIFIED dist, where the local
// binding may be renamed — but the window.heatsyncCleanup property access
// always survives, and every cleanup consumer is lib-bundled (COPY_FILES
// scripts use no cleanup), so its presence proves the lib (and with it the
// scope binding) is in the bundle.
for (const dir of [DIST_CHROME, DIST_FIREFOX]) {
  t(`every ${dir === DIST_CHROME ? 'chrome' : 'firefox'} bundle using cleanup carries the lib`, () => {
    const m = readManifest(dir)
    for (const file of collectScripts(m)) {
      const src = readFileSync(join(dir, file), 'utf8')
      if (/\bcleanup\./.test(src)) {
        expect(/window\.heatsyncCleanup/.test(src)).toBe(true)
      }
    }
  })
}

// Source-level: the binding line itself must stay in cleanup.js — without it,
// bare `cleanup` is a ReferenceError in every bundle that doesn't declare its
// own (the 04-27→07-05 dead-yt-surface bug). Not gated on HS_VERIFY_DIST:
// this reads source, not build output.
test('src/lib/cleanup.js re-exports the bundle-scope cleanup binding', () => {
  const src = readFileSync(join(ROOT, 'src', 'lib', 'cleanup.js'), 'utf8')
  expect(/\nconst cleanup = window\.heatsyncCleanup\s*$/m.test(src)).toBe(true)
})

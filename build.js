#!/usr/bin/env bun
/**
 * Heatsync Extension Build Script
 *
 * Builds Chrome and Firefox versions from unified source.
 * - Bundles lib/ modules into content scripts
 * - Handles manifest differences (MV2 vs MV3)
 * - Copies assets
 *
 * Usage:
 *   bun run extension/build.js                    # Build both
 *   bun run extension/build.js chrome             # Chrome only
 *   bun run extension/build.js --package          # Build + zip
 *   bun run extension/build.js --deploy           # Build + zip + rsync to server
 */

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SRC_DIR = join(__dirname, 'src')
const CHROME_OUT = join(__dirname, 'dist', 'chrome')
const FIREFOX_OUT = join(__dirname, 'dist', 'firefox')

// Files that need lib bundled in (content scripts)
const CONTENT_SCRIPTS = [
  'content.js',
  'multichat.js',
  'heatsync-button.js',
  'autocomplete-hook.js',
  'chat-injector.js',
]

// Files to copy as-is (no lib bundling needed)
const COPY_FILES = [
  'background.js',
  'popup.js',
  'popup.html',
  'early-inject-main.js',
  'platform-detector.js',
  'shared-utils.js',
  'polyfill.js',
  'welcome.html',
  'injected-message.css',
  'youtube-content.js',
  'options.html',
  'options.js',
]

// Assets (images, etc)
const ASSETS = [
  'icon-16.png',
  'icon-48.png',
  'icon-96.png',
  'icon-128.png',
  'COGGERS-1x.webp',
]

// Read lib files
function readLib() {
  const libDir = join(SRC_DIR, 'lib')
  const files = ['config.js', 'utils.js', 'cleanup.js', 'browser-api.js']
  let combined = '// === HEATSYNC LIB (auto-bundled) ===\n'

  for (const file of files) {
    const content = readFileSync(join(libDir, file), 'utf8')
    // Remove ES module exports (we're bundling into IIFE)
    const stripped = content
      // Remove "export default foo" entirely
      .replace(/^export\s+default\s+\w+\s*;?\s*$/gm, '')
      // Remove "export { foo, bar }" entirely
      .replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '')
      // Convert "export const/let/var/function/class" to just the declaration
      .replace(/^export\s+(const|let|var|function|class)\s+/gm, '$1 ')
    combined += `\n// --- ${file} ---\n${stripped}\n`
  }

  combined += '// === END HEATSYNC LIB ===\n\n'
  return combined
}

// Inject lib at top of content script
// Lib goes at IIFE scope, original content gets a nested block scope
// so const/let declarations (DEBUG, cleanup, etc.) don't conflict
function bundleContentScript(srcPath, lib) {
  let content = readFileSync(srcPath, 'utf8')

  // Check if already has lib bundled (from previous build of src file)
  if (content.includes('=== HEATSYNC LIB')) {
    // Already bundled, this is a built file being used as src - strip it
    content = content.replace(/\/\/ === HEATSYNC LIB[\s\S]*?\/\/ === END HEATSYNC LIB ===\n\n/, '')
  }

  // Strip existing IIFE wrapper so we can rebuild cleanly
  let body = content
  if (content.trim().startsWith('(function()') || content.trim().startsWith('(() =>')) {
    // Remove opening: (function() { 'use strict';
    body = content.replace(/^\s*\((?:function\s*\(\)|(?:\(\)\s*=>))\s*\{[\s\n]*(?:'use strict';?\s*)?/, '')
    // Remove closing: })();
    body = body.replace(/\}\s*\)\s*\(\s*\)\s*;?\s*$/, '')
  }

  // Build: IIFE > lib at outer scope > content in block scope
  // Block scope prevents const/let collisions (DEBUG, cleanup, etc.)
  return `(function() {\n'use strict';\n\n${lib}\n{\n${body}\n}\n})();`
}

// Build for a specific browser
function build(browser) {
  const outDir = browser === 'chrome' ? CHROME_OUT : FIREFOX_OUT
  const manifestSrc = join(SRC_DIR, 'manifests', `${browser}.json`)

  // Clean and create output dir
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true })
  }
  mkdirSync(outDir, { recursive: true })

  // Use Chrome source as base (it has the latest fixes)
  const chromeDir = join(__dirname, 'chrome')

  // Read lib
  const lib = readLib()

  // Bundle content scripts
  for (const file of CONTENT_SCRIPTS) {
    const srcPath = join(chromeDir, file)
    if (!existsSync(srcPath)) {
      console.log(`  Skip ${file} (not found)`)
      continue
    }
    const bundled = bundleContentScript(srcPath, lib)
    writeFileSync(join(outDir, file), bundled)
    console.log(`  Bundled ${file}`)
  }

  // Copy other files
  for (const file of COPY_FILES) {
    const srcPath = join(chromeDir, file)
    if (!existsSync(srcPath)) continue
    cpSync(srcPath, join(outDir, file))
  }
  console.log(`  Copied ${COPY_FILES.filter(f => existsSync(join(chromeDir, f))).length} files`)

  // Copy assets
  for (const file of ASSETS) {
    const srcPath = join(chromeDir, file)
    if (!existsSync(srcPath)) continue
    cpSync(srcPath, join(outDir, file))
  }
  console.log(`  Copied ${ASSETS.length} assets`)

  // Copy manifest
  cpSync(manifestSrc, join(outDir, 'manifest.json'))
  console.log(`  Copied manifest (${browser})`)

  // Firefox-specific adjustments
  if (browser === 'firefox') {
    // Firefox MV2 doesn't need offscreen
    const offscreenPath = join(outDir, 'offscreen.js')
    const offscreenHtmlPath = join(outDir, 'offscreen.html')
    if (existsSync(offscreenPath)) rmSync(offscreenPath)
    if (existsSync(offscreenHtmlPath)) rmSync(offscreenHtmlPath)
  }

  console.log(`✓ Built ${browser} → ${outDir}`)
}

// Read version from chrome manifest (single source of truth)
function getVersion() {
  const manifest = JSON.parse(readFileSync(join(SRC_DIR, 'manifests', 'chrome.json'), 'utf8'))
  return manifest.version
}

// Zip a built extension directory
function packageBrowser(browser) {
  const version = getVersion()
  const outDir = browser === 'chrome' ? CHROME_OUT : FIREFOX_OUT
  const zipName = `heatsync-${browser}-${version}.zip`
  const zipPath = join(__dirname, 'dist', zipName)

  if (!existsSync(outDir)) {
    console.error(`  ✗ ${outDir} not found — build first`)
    process.exit(1)
  }

  // Remove old zip if exists
  if (existsSync(zipPath)) rmSync(zipPath)

  // Zip from inside the build dir so paths are relative
  execSync(`cd "${outDir}" && zip -r "${zipPath}" .`, { stdio: 'pipe' })
  console.log(`  ${zipName}`)
  return zipPath
}

// Deploy zips to production server
function deploy() {
  const distDir = join(__dirname, 'dist')
  console.log('\nDeploying to server...')
  execSync(
    `rsync -avz --chmod=F644,D755 ${distDir}/heatsync-*.zip heatsync:/opt/heatsync/dist/downloads/`,
    { stdio: 'inherit' }
  )
  console.log('✓ Deployed')
}

// Main
const args = process.argv.slice(2)
const flags = new Set(args.filter(a => a.startsWith('--')))
const targets = args.filter(a => !a.startsWith('--'))
const target = targets[0] || null
const shouldPackage = flags.has('--package') || flags.has('--deploy')
const shouldDeploy = flags.has('--deploy')

console.log('Building heatsync extension...\n')

if (!target || target === 'chrome') {
  console.log('Chrome:')
  build('chrome')
}

if (!target || target === 'firefox') {
  console.log('\nFirefox:')
  build('firefox')
}

if (shouldPackage) {
  console.log('\nPackaging:')
  if (!target || target === 'chrome') packageBrowser('chrome')
  if (!target || target === 'firefox') packageBrowser('firefox')
}

if (shouldDeploy) deploy()

console.log('\nDone!')

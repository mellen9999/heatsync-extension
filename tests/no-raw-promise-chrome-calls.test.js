/**
 * F-ext-1 tripwire — Firefox's chrome.* namespace is callback-only (no
 * promises). `await chrome.storage.local.get(...)` silently resolves
 * undefined there, and `chrome.storage.local.set(...).catch(...)` throws
 * (calling .catch on undefined). Every promise-style call must go through
 * the `browser` alias (`globalThis.browser || chrome`) instead — see
 * background.js / src/lib/browser-api.js. Callback-style `chrome.x(cb)`
 * calls are fine and excluded.
 *
 * Scans hand-written source, NOT build output (chrome/multichat-core.js and
 * the retired per-platform bundles are generated from src/ and would just
 * re-report the same source-level bug at a different line).
 */
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname

const BUILD_OUTPUT = new Set(['multichat-core.js', 'multichat.js', 'multichat-twitch.js', 'multichat-kick.js', 'multichat-youtube.js'])

function jsFiles(dir) {
  return readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith('.js') && !BUILD_OUTPUT.has(f))
    .map((f) => join(dir, f))
}

const FILES = [...jsFiles('chrome'), ...jsFiles('src/lib'), ...jsFiles('src/multichat')]

// await chrome.X(...) / chrome.X(...).then( / chrome.X(...).catch( / chrome.X(...).finally(
const PROMISE_STYLE_RE = /await\s+chrome\.|chrome\.[a-zA-Z.]+\([^()]*(\([^()]*\)[^()]*)?\)\s*\.\s*(then|catch|finally)\(/

test('no hand-written file awaits/chains a promise directly off chrome.*', () => {
  const offenders = []
  for (const rel of FILES) {
    const src = readFileSync(join(ROOT, rel), 'utf8')
    const lines = src.split('\n')
    lines.forEach((line, i) => {
      if (PROMISE_STYLE_RE.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
    })
  }
  expect(offenders).toEqual([])
})

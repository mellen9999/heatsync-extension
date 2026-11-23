/**
 * The release multichat bundle carries none of its debug log: bootstrap.js's `log` is
 * `if (MC_DEBUG) console.log(...)` with MC_DEBUG a const false, so every call was dead weight (~7KB
 * of strings and call sites). Only that log goes; warnings, errors and the runtime-toggled utils.js
 * log other bundles use are untouched.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { transformSync } from 'esbuild'
import { rebindBgDebugLog, rebindDebugLog, unbindBgDebugLog, unbindDebugLog } from '../scripts/lib/debug-log.mjs'
import { bgSource } from './bg-src.js'

const ROOT = join(import.meta.dir, '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

// the same two steps minifyDistFile takes, on a bundle-shaped file
function ship(body) {
  const staged = `"use strict";\n${unbindDebugLog(body)}`
  const { code } = transformSync(staged, {
    loader: 'js',
    minify: true,
    format: 'iife',
    treeShaking: true,
    pure: ['log'],
  })
  return rebindDebugLog(`"use strict";${code.replace(/^"use strict";/, '')}`)
}

const BODY = `
const DEBUG = false
function log(...args) {
  if (DEBUG) {
    console.log('[heatsync]', ...args)
  }
}
const MC_DEBUG = false
function log(...args) {
  if (MC_DEBUG) console.log('[hs]', ...args)
}
function warn() { console.warn('a warning that ships') }
function boot(p) {
  log('a debug string nobody reads', p)
  p.catch((e) => log('caught and said nothing', e))
  if (typeof log === 'function') window.__debugRegistered = true
  console.error('an error that ships')
  warn()
}
window.boot = boot
`

test('debug calls and their strings are gone, warnings and errors stay', () => {
  const out = ship(BODY)
  expect(out).not.toContain('a debug string nobody reads')
  expect(out).toContain('caught and said nothing') // a call whose result is used stays, as a no-op
  expect(out).toContain('an error that ships')
  expect(out).toContain('a warning that ships')
})

test('the name still means a function, so a kept call or a typeof check behaves as it did', () => {
  const out = ship(BODY)
  const win = { __debugRegistered: false }
  new Function('window', 'console', out)(win, { error() {}, warn() {}, log() {} })
  expect(typeof win.boot).toBe('function')
  win.boot(Promise.reject(new Error('x')))
  expect(win.__debugRegistered).toBe(true)
})

test('the real sources have exactly the two definitions the build renames', () => {
  const both = `${read('src/lib/utils.js')}\n${read('src/multichat/bootstrap.js')}`
  expect(() => unbindDebugLog(both)).not.toThrow()
  expect(MC_DEBUG_IS_CONST_FALSE(read('src/multichat/bootstrap.js'))).toBe(true)
})

test('a bundle without them is refused, not shipped half-treated', () => {
  expect(() => unbindDebugLog('function log() {}')).toThrow(/found 0/)
})

function MC_DEBUG_IS_CONST_FALSE(src) {
  return /^const MC_DEBUG = false$/m.test(src)
}

// ── the background: the same dead weight, a plain script instead of a wrapped bundle ───────────────
const BG_DEF = "const DEBUG = false\nconst log = DEBUG ? console.log.bind(console, '[heatsync]') : () => {}\n"
const BG_BODY = `${BG_DEF}
function warn() { console.warn('a warning that ships') }
function boot(p) {
  log('a debug string nobody reads', p)
  log(\`a template \${p} nobody reads\`)
  p.catch((e) => log('caught and said nothing', e))
  const said = log('a result that is used')
  if (DEBUG) console.log('guarded by the flag')
  console.error('an error that ships')
  warn()
  return said
}
self.boot = boot
`

// the same steps minifyDistFile takes for background.js
function shipBg(body) {
  const quiet = unbindBgDebugLog(body)
  const { code } = transformSync(quiet, { loader: 'js', minify: true, keepNames: true, pure: ['log'] })
  return rebindBgDebugLog(code)
}

test('background: debug calls and their strings are gone, warnings and errors stay', () => {
  const out = shipBg(BG_BODY)
  expect(out).not.toContain('a debug string nobody reads')
  expect(out).not.toContain('nobody reads')
  expect(out).not.toContain('console.log.bind')
  expect(out).toContain('an error that ships')
  expect(out).toContain('a warning that ships')
})

test('background: the name still means a function that does nothing', () => {
  const out = shipBg(BG_BODY)
  const self = {}
  const said = []
  new Function('self', 'console', out)(self, { error() {}, warn() {}, log: (...a) => said.push(a) })
  expect(self.boot(Promise.reject(new Error('x')))).toBeUndefined()
  expect(said).toEqual([])
})

test('background: the real source has exactly the one definition the build takes out, DEBUG a const false', () => {
  const src = bgSource()
  const quiet = unbindBgDebugLog(src)
  expect(quiet).not.toBeNull()
  expect(quiet).not.toContain('console.log.bind')
  expect(src.length - quiet.length).toBe(BG_DEF.length - 'const DEBUG = false\n'.length)
})

test('background: a source with the flag switched on is left whole, and one with no definition is refused', () => {
  expect(unbindBgDebugLog(BG_BODY.replace('const DEBUG = false', 'const DEBUG = true'))).toBeNull()
  expect(() => unbindBgDebugLog('const DEBUG = false\n')).toThrow(/found 0/)
})

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainSource } from './main-src.js'

// The multichat body calls these site-copied helpers but never defines them;
// a lib module in build.js's LIB_ORDER must, or the bundle throws on every
// stream event (1.7.x shipped exactly that: streamEventBody was on build.js's
// lint list and nowhere in the bundle). Read at the source: the helper is
// defined in a file the build concatenates, not merely somewhere under src/.
const ROOT = join(import.meta.dir, '..')
const build = readFileSync(join(ROOT, 'build.js'), 'utf8')
// What the bundle embeds from src/lib: LIB_ORDER (every content script) plus
// the multichat-only modules readMultichatModules() reads by an explicit
// join(SRC_DIR, 'lib', …). A name on a lint list is not an embed.
const libOrder = [...build.match(/const LIB_ORDER = \[([\s\S]*?)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
const explicit = [...build.matchAll(/join\(SRC_DIR, 'lib', '([^']+\.js)'\)/g)].map((m) => m[1])
const lib = [...new Set([...libOrder, ...explicit])]
  .map((f) => readFileSync(join(ROOT, 'src', 'lib', f), 'utf8'))
  .join('\n')

describe('a bundled lib module defines the helpers the multichat body calls', () => {
  test('streamEventBody', () => {
    expect(mainSource()).toMatch(/\bstreamEventBody\(/)
    expect(lib).toMatch(/function streamEventBody\b/)
  })
  test('REPLAY_WINDOW_MS', () => {
    expect(mainSource()).toMatch(/\bREPLAY_WINDOW_MS\b/)
    expect(lib).toMatch(/\bREPLAY_WINDOW_MS\s*=/)
  })
})

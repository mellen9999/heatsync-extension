/**
 * Firefox runs every content script of the add-on in one scope per page, and shared-utils.js sits
 * in two manifest entries that both match twitch and kick, so it loads twice into that scope. A
 * top-level const threw "redeclaration of const browser" on the second load (firefox 160, s9
 * 11-16). Runs the real file twice in one context, as firefox does.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'content', 'shared-utils.js'), 'utf8')

test('a second load into the same scope stops at the double-load guard instead of throwing', () => {
  const ctx = { chrome: {} }
  ctx.window = ctx
  ctx.globalThis = ctx
  // the first load already ran: both of the file's blocks are guarded
  ctx.window.HS = { loaded: 1 }
  ctx.window.__hsEmoteFallbackInstalled = true
  vm.createContext(ctx)
  vm.runInContext(SRC, ctx, { filename: 'shared-utils.js (entry 1)' })
  expect(() => vm.runInContext(SRC, ctx, { filename: 'shared-utils.js (entry 2)' })).not.toThrow()
  expect(ctx.window.HS).toEqual({ loaded: 1 })
})

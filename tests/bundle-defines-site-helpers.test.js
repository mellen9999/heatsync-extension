import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// main.js calls these site-copied helpers but never defines them; the bundle
// must. Once streamEventBody was only on build.js's lint list, so the shipped
// bundle threw on every stream event (no "went live", no game switches).
const bundle = readFileSync(join(import.meta.dir, '..', 'chrome', 'multichat-core.js'), 'utf8')

describe('multichat bundle defines the helpers main.js calls', () => {
  test('streamEventBody', () => {
    expect(bundle).toMatch(/function streamEventBody\b/)
  })
  test('REPLAY_WINDOW_MS', () => {
    expect(bundle).toMatch(/\bREPLAY_WINDOW_MS\s*=/)
  })
})

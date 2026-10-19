import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The 💬N reply count is a readout; >>id is the only way into a thread. */
const ROOT = join(import.meta.dir, '..', 'src', 'multichat')
const social = readFileSync(join(ROOT, 'social.js'), 'utf8')
const css = readFileSync(join(ROOT, 'styles', '16-social-feed.css'), 'utf8')

describe('reply count badge', () => {
  test('has no click handler', () => {
    expect(social).not.toMatch(/querySelector\('\.hs-feed-replies'\)/)
  })
  test('does not look clickable', () => {
    expect(css).not.toMatch(/\.hs-feed-replies[^{]*\{[^}]*cursor:\s*pointer/)
    expect(css).not.toMatch(/\.hs-feed-replies:hover/)
  })
})

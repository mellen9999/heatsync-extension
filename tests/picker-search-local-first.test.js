/**
 * The picker's local matches paint on the next frame; only the provider
 * requests wait out the debounce. The 200ms wait used to sit in front of the
 * local grid too, so every keystroke showed the previous query's tiles first.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8').replace(/\r\n/g, '\n')
const at = SRC.indexOf("searchInput?.addEventListener('input'")
const HANDLER = at < 0 ? '' : SRC.slice(at, SRC.indexOf('\n  })\n', at))

describe('picker search: local first, providers debounced', () => {
  test('the input handler is where we expect it', () => {
    expect(at).toBeGreaterThan(-1)
  })

  test('the local grid renders on the next frame, outside the debounce', () => {
    const raf = HANDLER.indexOf('requestAnimationFrame(')
    const timer = HANDLER.indexOf('cleanup.setTimeout(')
    expect(raf).toBeGreaterThan(-1)
    expect(timer).toBeGreaterThan(raf)
    expect(HANDLER.slice(raf, timer)).toContain('rerenderSearch(mcCurrentQuery)')
    expect(HANDLER.slice(timer)).not.toContain('rerenderSearch(')
  })

  test('the query moves with the keystroke; provider requests stay debounced', () => {
    expect(HANDLER.indexOf('mcCurrentQuery = query')).toBeLessThan(HANDLER.indexOf('requestAnimationFrame('))
    expect(HANDLER.slice(HANDLER.indexOf('cleanup.setTimeout('))).toContain('mcTriggerProviderSearches(')
    expect(HANDLER).toMatch(/\}, 200\)/)
  })
})

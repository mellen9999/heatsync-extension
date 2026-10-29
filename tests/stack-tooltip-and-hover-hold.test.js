import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (f) => readFileSync(new URL(`../src/multichat/${f}`, import.meta.url), 'utf8')

describe('emote stack tooltip', () => {
  const src = read('tooltips.js')
  const fn = src.slice(src.indexOf('function buildStackPreview'), src.indexOf('// ─── Composition line'))

  test('an overlay is pinned to its in-chat size only once that image has loaded', () => {
    expect(fn).toContain('live?.naturalWidth ? live.offsetWidth : 0')
    expect(fn).toContain('const hi = pinned ? getHighResUrl(orig) : null')
  })
})

describe('hover hold and the "N new" button', () => {
  const src = read('main.js')

  test('a render while the pointer holds the feed does not count or show new messages', () => {
    const at = src.indexOf('if (isScrolledUp && !opts?.bypassScrollPause)')
    expect(at).toBeGreaterThan(0)
    const block = src.slice(at, src.indexOf('newMessageCount++', at))
    expect(block).toContain('if (hoverHeld) return')
  })

  test('the hold flag is shared, not private to the scroll wiring', () => {
    expect(src).toMatch(/\n {2}let hoverHeld = false/)
    expect(src).not.toMatch(/\n {6}let hoverHeld = false/)
  })
})

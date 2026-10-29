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
    expect(block).toContain('if (hoverHeld) {')
    expect(block).toContain('_holdMissedRender = true')
  })

  test('releasing the hold repaints only if a render was asked for while it held', () => {
    const at = src.indexOf('const releaseHold = () =>')
    const block = src.slice(at, src.indexOf('msgsEl.addEventListener', at))
    expect(block).toContain('const missed = _holdMissedRender')
    expect(block).toContain('if (!missed) return')
    expect(block.indexOf('if (!missed) return')).toBeLessThan(block.indexOf('renderMessages(currentTab)'))
  })

  test('the hold flag is shared, not private to the scroll wiring', () => {
    expect(src).toMatch(/\n {2}let hoverHeld = false/)
    expect(src).not.toMatch(/\n {6}let hoverHeld = false/)
  })
})

describe('emote cross-highlight cost', () => {
  const src = read('tooltips.js')

  test('only on-screen copies get the plate, and the colour never rides on body', () => {
    expect(src).toContain('hsOnScreen(queryEmoteWrappers(emoteName)).forEach((w) => hsSetEmoteHighlight(w, true))')
    expect(src).not.toContain("document.body.style.setProperty('--hs-highlight-color'")
  })

  test('leaving an emote clears every highlight, not just the on-screen ones', () => {
    expect(src).toContain('if (emoteName) hsClearEmoteHighlights()')
    const fn = src.slice(src.indexOf('function hsClearEmoteHighlights'), src.indexOf('function hideUserTooltip'))
    expect(fn).toContain("removeProperty('--hs-highlight-color')")
  })
})

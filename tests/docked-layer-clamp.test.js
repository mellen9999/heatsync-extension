/**
 * A docked notification must never be silently invisible.
 *
 * The chat-docked layers mirror the chat overlay's rect. That rect is not
 * guaranteed to be on screen — at narrow widths the chat column can sit fully
 * past the right edge, and the layer followed it: measured live on twitch at
 * `left: 1053px; right: -11px` in a 1048px viewport, leaving a 6px sliver. The
 * resub-share prompt was present and correct inside it and completely
 * unreadable, which reads to a user as the feature not working at all.
 *
 * clampDockedBox is the fix: dock when the target is usable, clamp on screen
 * when it is not. These pin the arithmetic directly — the function is pure, so
 * unlike the main.js handlers it does not need the source-slicing harness.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../src/multichat/notifs.js', import.meta.url), 'utf8')

/** Lift the pure helper out of the module (which registers layers on import). */
const clampDockedBox = (() => {
  const start = SRC.indexOf('function clampDockedBox')
  expect(start, 'clampDockedBox missing').toBeGreaterThan(-1)
  const body = SRC.slice(start, SRC.indexOf('\n}', start) + 2)
  return new Function('window', `${body}; return clampDockedBox`)({ innerWidth: 0 })
})()

/** Re-bind against a given viewport width. */
function withViewport(vw) {
  const start = SRC.indexOf('function clampDockedBox')
  const body = SRC.slice(start, SRC.indexOf('\n}', start) + 2)
  return new Function('window', `${body}; return clampDockedBox`)({ innerWidth: vw })
}

describe('clampDockedBox', () => {
  test('leaves an on-screen dock target exactly where it is', () => {
    const clamp = withViewport(1920)
    expect(clamp(1200, 340)).toEqual({ left: 1200, right: 380 })
  })

  test('pulls a fully off-screen column back on screen (the reported case)', () => {
    // viewport 1048, chat column at 1049..1389 — what was measured live.
    const clamp = withViewport(1048)
    const box = clamp(1049, 340)
    expect(box.left).toBe(708) // 1048 - 340
    expect(box.right).toBe(0)
    expect(1048 - box.left - box.right).toBe(340) // full width, on screen
  })

  test('never yields less than the minimum usable width', () => {
    const clamp = withViewport(1048)
    const box = clamp(1040, 8) // an 8px sliver of a dock target
    expect(1048 - box.left - box.right).toBeGreaterThanOrEqual(180)
  })

  test('degrades to the whole viewport rather than overflowing it', () => {
    const clamp = withViewport(120) // narrower than the 180px minimum
    const box = clamp(0, 340)
    expect(box.left).toBe(0)
    expect(box.right).toBe(0)
  })

  test('a negative left (scrolled/overflowed target) is pinned to 0', () => {
    const clamp = withViewport(1048)
    expect(clamp(-200, 340).left).toBe(0)
  })
})

describe('both docked layers actually use it', () => {
  test('chat-docked-bottom and chat-docked-top clamp their box', () => {
    const uses = [...SRC.matchAll(/clampDockedBox\(/g)]
    // one definition + one call per docked layer
    expect(uses.length).toBeGreaterThanOrEqual(3)
    for (const layer of ['chat-docked-bottom', 'chat-docked-top']) {
      const i = SRC.indexOf(`registerLayer('${layer}'`)
      expect(i, `${layer} missing`).toBeGreaterThan(-1)
      const block = SRC.slice(i, SRC.indexOf('registerLayer(', i + 10))
      expect(block).toContain('clampDockedBox')
    }
  })
})

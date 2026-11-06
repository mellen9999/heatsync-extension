import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// page zoom shrinks the css viewport (1280px at 300% = 426px). the twitch chat
// cap held a 600px player floor, which left the chat 10px wide, and the clamp
// overwrote the width so it never came back on zoom-out.
const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'resize.js'), 'utf8')
const slice = (from, to) => SRC.slice(SRC.indexOf(from), SRC.indexOf(to))
const BODY = `${slice('function getTwitchMaxChatWidth()', '/**\n * Setup resize handle')}`

function make(vw, extra = {}) {
  return new Function(
    'vw',
    `var hostPlatform = 'twitch', chatPosition = 'right', tabPosition = 'bottom', _twitchSideNavW = 50
     var MIN_CHAT_WIDTH = 10, MAX_CHAT_WIDTH = 800, TWITCH_MIN_MAIN_WIDTH = 600, TWITCH_SIDE_NAV_WIDTH = 50
     var window = { innerWidth: vw }, document = { documentElement: { clientWidth: vw } }
     var chatWidth = ${extra.chatWidth ?? 340}
     ${BODY}
     return { max: getTwitchMaxChatWidth, fit: fitChatWidth, get w() { return chatWidth }, set w(v) { chatWidth = v } }`,
  )(vw)
}

describe('twitch chat width under page zoom', () => {
  test('100% on a wide screen keeps the 600px player floor', () => {
    expect(make(1920).max()).toBe(800)
    expect(make(1280).max()).toBe(630)
  })
  test('zoomed-in viewports never collapse the chat to the grab strip', () => {
    for (const vw of [853, 640, 533, 426, 320]) {
      const max = make(vw).max()
      expect(max).toBeGreaterThanOrEqual(Math.floor((vw - 50) / 2) - 1)
      expect(max).toBeGreaterThan(100)
    }
  })
  test('a squeezed width is given back when the viewport widens', () => {
    const c = make(426)
    c.fit(c.max())
    expect(c.w).toBeLessThan(340)
    c.fit(make(1920).max())
    expect(c.w).toBe(340)
  })
  test('a drag after the squeeze wins over the remembered width', () => {
    const c = make(426)
    c.fit(c.max())
    c.w = 150
    c.fit(800)
    expect(c.w).toBe(150)
  })
})

describe('wiring', () => {
  test('both clamps go through fitChatWidth, and twitch re-fits on resize', () => {
    expect(SRC).not.toMatch(/if \(chatWidth > tMax\) chatWidth = tMax/)
    expect(SRC).toContain('fitChatWidth(tMax)')
    expect(SRC).toContain('fitChatWidth(ytMax)')
    const pos = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'chat-position.js'), 'utf8')
    expect(pos).toContain('scheduleTwitchChatRefit()')
  })
})

describe('hover card under page zoom', () => {
  test('the narrow-viewport peek hide is only for touch: a zoomed mouse keeps its hover card', () => {
    const css = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'styles', '09-tooltips-menus.css'), 'utf8')
    expect(css).toMatch(/@media \(max-width: 768px\) and \(not \(pointer: coarse\)\) \{\s*\.hs-card\.hs-card-peek \{ display: flex; \}/)
  })
})

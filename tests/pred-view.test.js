import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Predictions & polls as a full chat-area surface.
 *
 * The UI used to exist only inside the emote picker's twitch sub-tab, and the
 * chat banner that announced a live prediction clicked through to the `live`
 * TAB — which switched channels and left the prediction UI exactly where it
 * was. This pins the wiring that makes the banner open the real thing, plus the
 * three traps that make a takeover view silently break.
 */

const SRC = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')
const STYLES = join(import.meta.dir, '..', 'src', 'multichat', 'styles')

describe('pred view wiring', () => {
  test('the banner opens the view instead of clicking the live tab', () => {
    const api = SRC('twitch-api.js')
    expect(api).toContain('openPredView(')
    // The old handler switched channels and looked like it did nothing.
    expect(api).not.toContain('goToTwitch')
  })

  test('incoming chat cannot repaint over the open view', () => {
    // Both guards are needed: renderMessages repaints the whole area on tab
    // work, appendMessage appends a single row on every arriving message.
    const main = SRC('main.js')
    expect(main).toContain('renderPredView()')
    expect(main.match(/predViewOpen\(\)/g)?.length).toBeGreaterThanOrEqual(2)
  })

  test('the close button survives a repaint', () => {
    // The view re-renders whenever fresh prediction data lands, replacing its
    // ✕ node. A direct click listener then resolves against a DETACHED button
    // and silently does nothing — chat-logs.js documents this exact failure.
    // The delegated pointerdown handler is what actually closes it.
    const logs = SRC('chat-logs.js')
    expect(logs).toContain('hs-pv-close')
    expect(logs).toContain('closePredView()')
  })

  test('escape closes it, like every other takeover view', () => {
    expect(SRC('chat-logs.js')).toMatch(/predViewOpen\(\)[\s\S]{0,120}closePredView\(\)/)
  })

  test('it reuses the picker’s renderers rather than growing a second UI', () => {
    const view = SRC('pred-view.js')
    for (const fn of ['renderPrediction(', 'renderPoll(', 'renderNoPrediction(', 'renderNoPoll(']) {
      expect(view).toContain(fn)
    }
    // Handlers are attached separately from rendering — the buttons inside a
    // rendered prediction are dead without these.
    expect(view).toContain('attachPredictionHandlers()')
    expect(view).toContain('attachPollHandlers()')
  })

  test('the composer is hidden with the flag, not just the class', () => {
    // A class-only hide leaves inputBarVisible=true, which makes showInputBar()
    // early-return forever and strands the composer unreachable.
    const view = SRC('pred-view.js')
    expect(view).toContain("classList.add('hs-hidden')")
    expect(view).toContain('inputBarVisible = false')
    expect(view).toContain('showInputBar()')
  })
})

/**
 * Repo-wide: the style modules are concatenated into a JS string literal, so a
 * backslash used to be a JS escape BEFORE it was ever CSS — a LONE backslash
 * was fatal (`content: '\25B8'` stopped the bundle parsing), so authors were
 * told to hand-double it (`'\\2303'`) to survive the raw paste into the
 * template literal.
 *
 * That convention is now backwards. build.js's escapeCssForTemplateLiteral()
 * escapes every backslash automatically at embed time (fixed 2026-09-24, see
 * build.js), so a plain single backslash — normal CSS — now round-trips
 * correctly on its own. A file still following the old hand-doubled
 * convention gets double-escaped: `'\\2303'` in source became `'\\\\2303'`
 * embedded, which the JS engine collapses back to two literal backslashes at
 * runtime — CSS then reads that as an escaped backslash char + literal
 * "2303" text, not the U+2303 glyph. So the rule flipped: CSS files must use
 * a SINGLE backslash for a real escape now; a doubled one is the bug.
 */
describe('style modules survive being inlined into JS', () => {
  test('no doubled backslash escapes — build.js escapes automatically, write CSS plain', () => {
    const offenders = []
    for (const file of readdirSync(STYLES).filter((f) => f.endsWith('.css'))) {
      const css = readFileSync(join(STYLES, file), 'utf8')
      css.split('\n').forEach((line, i) => {
        if (/\\\\[0-9a-fA-F]{2,6}/.test(line)) {
          offenders.push(`${file}:${i + 1} ${line.trim().slice(0, 60)}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})

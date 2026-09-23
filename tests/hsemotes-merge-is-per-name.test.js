/**
 * hsEmotes is a MAP of name→ref, and both places that merged a server copy
 * into an already-buffered row used a whole-object fill:
 *
 *     if (!m.hsEmotes) m.hsEmotes = src.hsEmotes
 *
 * That is only ever correct when the thing being filled is a SCALAR. One name
 * already on the row discarded every name on the source. The server builds its
 * set per-message from the sender's inventory and the native tap does not, so
 * a two-emote message that had picked up one ref from anywhere else kept that
 * one and put the other on screen as a word.
 *
 * The panel site was worse: the re-render lived INSIDE the same gate, so a row
 * that already had one name never repainted either — the ref sat on the row
 * and the emote stayed text until something else forced a rebuild.
 *
 * Same bug the site repo fixed at five leg-merge sites (79e944503) and again a
 * tier deeper on 2026-09-22. Eighth occurrence of the class.
 *
 * These carve the REAL loops out of the sources and run them, so they cannot
 * pass against a reimplementation that happens to be correct.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BG = readFileSync(join(import.meta.dir, '..', 'chrome', 'background.js'), 'utf8')
const MAIN = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')

/** // comments stripped: the fix QUOTES the old expression to explain it, and
 *  prose about a bug must not be able to satisfy a check for the bug. */
const strip = (src) => src.replace(/^\s*\/\/.*$/gm, '')
const BG_CODE = strip(BG)
const MAIN_CODE = strip(MAIN)

/** Pull the merge body out of a source between two anchors. */
function carve(src, startAnchor, endAnchor) {
  const a = src.indexOf(startAnchor)
  if (a === -1) return null
  const b = src.indexOf(endAnchor, a)
  if (b === -1) return null
  return src.slice(a, b)
}

const BG_MERGE = carve(BG, 'if (!m.hsEmotes) m.hsEmotes = {}', 'break')
const MAIN_MERGE = carve(MAIN, 'if (!m.hsEmotes) m.hsEmotes = {}', 'break')

describe('the whole-object fill is gone from both sites', () => {
  test('carve markers found — otherwise these assertions prove nothing', () => {
    expect(BG_MERGE, 'background.js merge block not found').toBeTruthy()
    expect(MAIN_MERGE, 'main.js merge block not found').toBeTruthy()
  })

  test('neither source still assigns the whole map', () => {
    // Booleans, not the sources — a failed toMatch on a 13k-line file prints
    // the whole file into the runner's output.
    expect(
      /if \(!m\.hsEmotes\) m\.hsEmotes = ext\.hsEmotes/.test(BG_CODE),
      'background.js still fills hsEmotes whole',
    ).toBe(false)
    expect(/m\.hsEmotes = msg\.hsEmotes/.test(MAIN_CODE), 'main.js still fills hsEmotes whole').toBe(false)
  })
})

describe('background.js — the buffered history row', () => {
  // Run the carved loop for real.
  const merge = (row, incoming) => {
    const m = row
    const ext = { hsEmotes: incoming }
    new Function('m', 'ext', BG_MERGE)(m, ext)
    return m.hsEmotes
  }

  test('a row with one name gains the rest', () => {
    const out = merge({ hsEmotes: { A: { url: 'a' } } }, { A: { url: 'WRONG' }, B: { url: 'b' } })
    expect(Object.keys(out).sort()).toEqual(['A', 'B'])
  })

  test('never overwrites a name the row already has', () => {
    const out = merge({ hsEmotes: { A: { url: 'kept' } } }, { A: { url: 'clobber' } })
    expect(out.A.url).toBe('kept')
  })

  test('fills an empty row', () => {
    const out = merge({}, { A: { url: 'a' }, B: { url: 'b' } })
    expect(Object.keys(out).sort()).toEqual(['A', 'B'])
  })

  test('skips falsy refs rather than storing holes', () => {
    const out = merge({}, { A: null, B: { url: 'b' } })
    expect(Object.keys(out)).toEqual(['B'])
  })
})

describe('main.js — the live row repaints when it gains', () => {
  const merge = (row, incoming) => {
    const m = row
    const msg = { hsEmotes: incoming }
    let reprocessed = 0
    const queueImmediateReprocess = () => {
      reprocessed++
    }
    new Function('m', 'msg', 'queueImmediateReprocess', MAIN_MERGE)(m, msg, queueImmediateReprocess)
    return { hsEmotes: m.hsEmotes, renderedHtml: m._renderedHtml, reprocessed }
  }

  test('a row with one name gains the rest AND repaints', () => {
    // The old gate skipped both the merge and the repaint for this row.
    const r = merge(
      { hsEmotes: { A: { url: 'a' } }, _renderedHtml: '<cached>' },
      { A: { url: 'WRONG' }, B: { url: 'b' } },
    )
    expect(Object.keys(r.hsEmotes).sort()).toEqual(['A', 'B'])
    expect(r.renderedHtml, 'the cached html must be dropped or the emote stays a word').toBeNull()
    expect(r.reprocessed).toBe(1)
  })

  test('does not repaint when it gained nothing — this runs per enrich frame', () => {
    const r = merge({ hsEmotes: { A: { url: 'a' } }, _renderedHtml: '<cached>' }, { A: { url: 'same' } })
    expect(r.renderedHtml).toBe('<cached>')
    expect(r.reprocessed).toBe(0)
  })

  test('fills an empty row and repaints', () => {
    const r = merge({ _renderedHtml: '<cached>' }, { A: { url: 'a' } })
    expect(Object.keys(r.hsEmotes)).toEqual(['A'])
    expect(r.reprocessed).toBe(1)
  })
})

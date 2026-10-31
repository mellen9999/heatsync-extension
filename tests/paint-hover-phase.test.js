/**
 * Hovering a painted name draws a white/black chip with overrides alone: the
 * paint's animations keep running underneath, so nothing has to be resumed,
 * recreated or re-seeked on the way out.
 *
 * The old freeze paused every visible copy of the name, deleted its scene
 * plates (content:none) and hid its fill boxes (display:none); the release
 * rebuilt and re-seeked all of it in the mouseout task — ~1s main-thread stall
 * with a dozen copies of a scene paint on screen (traced 2026-10-31).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'paints.js'), 'utf8')
const hoverRules = SRC.split('\n').filter((l) => l.includes(':hover') && l.trim().startsWith("'"))

describe('paint hover chip', () => {
  test('the hover rules exist', () => {
    expect(hoverRules.length).toBeGreaterThan(2)
    expect(hoverRules.join('')).toContain('background:#fff !important')
  })

  test('hover never pauses, removes or hides-by-display anything', () => {
    for (const r of hoverRules) {
      expect(r).not.toContain('animation-play-state')
      expect(r).not.toContain('content:none')
      expect(r).not.toContain('display:none')
    }
  })

  test('plates and fill boxes are hidden, not removed', () => {
    expect(hoverRules.join('')).toMatch(/:hover::before[^{]*\{visibility:hidden !important;\}/)
  })

  test('no js runs on hover or unhover', () => {
    expect(SRC).not.toContain('hsp-hover')
    expect(SRC).not.toContain('installHsPaintHoverSync')
    expect(SRC).not.toContain('resyncAnimationPhases(')
  })

  test('real pointers only', () => {
    expect(hoverRules[0]).toContain('@media (hover: hover){')
  })
})

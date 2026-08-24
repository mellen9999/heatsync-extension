/**
 * The overlay's bottom inset (space reserved for the composer) must only ever
 * be written from a MEASURED inputbar box (_updateMcLayout, keyboard/
 * visualViewport paths) — never a constant. The reported bug: switchTab wiped
 * the inline inset to '' so the stylesheet's 52px fallback applied, but the
 * real composer measured 36px, leaving a 16px dead band between the last
 * message and the input box; the follow-up _updateMcLayout call skipped the
 * repair because its size signature was unchanged by a tab switch. Constant
 * writes ('', '0') reintroduce that drift the moment CSS and reality disagree.
 * Source-level guard: these paths live in the non-module content bundle.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAIN = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')

describe('overlay bottom inset is measured, never a constant', () => {
  test('every overlay style.bottom write interpolates a measured value', () => {
    const writes = MAIN.split('\n').filter((l) => /overlay\w*\.style\.bottom\s*=/.test(l))
    expect(writes.length).toBeGreaterThan(0)
    for (const l of writes) {
      // allowed: overlay.style.bottom = `${measured}px`
      // forbidden: = '' / '0' / any string constant
      expect(l).toContain('${')
    }
  })
})

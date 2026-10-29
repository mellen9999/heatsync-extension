import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/multichat/tooltips.js', import.meta.url), 'utf8')

describe('emote stack tooltip placement', () => {
  test('re-places the tooltip whenever the preview box resizes as images load', () => {
    expect(src).toContain('function buildStackPreview(box, stackEmotes, onResize)')
    expect(src).toContain('onResize?.()')
    expect(src).toContain('buildStackPreview(stackBox, stackEmotes, () => {')
    expect(src).toContain(
      "if (tooltip.classList.contains('visible')) positionTooltipAtElement(tooltip, hoveredImg || e.target)",
    )
  })
})

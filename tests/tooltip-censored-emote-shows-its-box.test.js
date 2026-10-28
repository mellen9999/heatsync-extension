/**
 * Hovering a censored emote previews the category box the chat line shows —
 * it has no image, so the tooltip used to point its <img> at an undefined url
 * and paint a broken-image icon.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'tooltips.js'), 'utf8')

describe('censored emote tooltip', () => {
  test('has its own branch that builds the cw box and never touches the img src', () => {
    const at = SRC.indexOf("} else if (state === 'cw') {")
    expect(at).toBeGreaterThan(-1)
    const branch = SRC.slice(at, SRC.indexOf('} else {', at))
    expect(branch).toContain("box.className = 'hs-mc-emote-wrapper hs-mc-emote-cw'")
    expect(branch).toContain('box.dataset.cw = cwCat')
    expect(branch).toContain("img.style.display = 'none'")
    expect(branch).not.toContain('img.src')
  })

  test('the state chip names the category', () => {
    expect(SRC).toContain("} else if (state === 'cw') {\n    label =")
  })
})

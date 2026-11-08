// `.hs-mc-emoji` is the chat emoji span — every row, the composer chip, the
// input stack. On 2026-11-08 the picker's emoji tab gave its 36px tiles the
// same class, and the tile rule (22px glyph, 36×36 box, black fill, white on
// hover) won the cascade over the chat rule: every emoji in every row sat in
// the top 20px of a 36px box, above the text it belonged to. A class with two
// meanings in one stylesheet has no safe rule; the tile is `.hs-mc-emoji-tile`.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const STYLES = join(import.meta.dir, '../src/multichat/styles')
// the only files allowed to style the chat emoji span: the emote layer (rows)
// and the composer (chips, stacks), plus the cleared-row dim in message-rows.
const OWNERS = new Set(['08-message-rows.css', '10-emotes.css', '11-input-composer.css'])
const CHAT_EMOJI = /\.hs-mc-emoji(?![\w-])/

const selectorsOf = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim())

describe('the chat emoji class is styled in one place', () => {
  test('no stylesheet outside the emote and composer layers selects .hs-mc-emoji', () => {
    const offenders = []
    for (const f of readdirSync(STYLES)
      .filter((n) => n.endsWith('.css'))
      .sort()) {
      if (OWNERS.has(f)) continue
      for (const sel of selectorsOf(readFileSync(join(STYLES, f), 'utf8'))) {
        if (CHAT_EMOJI.test(sel)) offenders.push(`${f}: ${sel}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('the picker emoji tab builds tiles, never chat emoji spans', () => {
    const tab = readFileSync(join(import.meta.dir, '../src/multichat/emoji-tab.js'), 'utf8')
    expect(tab).not.toMatch(/['"]\.?hs-mc-emoji['"]/)
    expect(tab).toMatch(/className = 'hs-mc-emoji-tile'/)
    const picker = readFileSync(join(STYLES, '13-platform-filter-picker.css'), 'utf8')
    expect(picker).toMatch(/\.hs-mc-emoji-tile \{ font-size: 22px; width: 36px; height: 36px; \}/)
  })
})

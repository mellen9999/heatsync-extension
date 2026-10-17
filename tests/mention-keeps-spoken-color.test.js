// A mentioned chatter we have heard speak keeps their real platform color; the
// heatsync-picked color from the profile lookup must not repaint them (a twitch
// line keeps twitch's color — mirrors the site's resolveNameColor).
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')

test('the profile lookup never overwrites a known (spoken) color', () => {
  expect(src('input.js')).toMatch(/if \(c && !knownColors\.has\(lower\)\) \{\s*try \{\s*setKnownColor\(lower, c\)/)
})

test('a resolved mention repaints with the known color first', () => {
  const m = src('main.js')
  expect(m).toContain('sanitizeColor(knownColors.get(lower) || c)')
  expect(m).toContain("setKnownColor(lower, knownColors.get(lower) || c || '#fff', resolvedUid, 'twitch')")
})

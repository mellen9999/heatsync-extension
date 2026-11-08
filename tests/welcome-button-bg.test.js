/**
 * chrome/welcome.html — the close button is a real <button>, so a rule that
 * paints white text on it must also paint its background: the browser's default
 * button face is light, and white-on-ButtonFace is invisible. The <a> siblings
 * never showed it because links have no default background.
 */

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const html = readFileSync(join(import.meta.dir, '..', 'chrome', 'welcome.html'), 'utf8')
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
// every rule whose selector list names the class
const rulesFor = (cls) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].split(',').some((sel) => sel.trim() === cls))
    .map((m) => m[2])

test('.cta-close sets its own background (it styles a <button>)', () => {
  const rules = rulesFor('.cta-close')
  expect(rules.length).toBeGreaterThan(0)
  expect(rules.some((r) => /background:\s*#000/.test(r))).toBe(true)
})

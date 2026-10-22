/**
 * chrome/welcome.html — the close button is a real <button>, so a rule that
 * paints white text on it must also paint its background: the browser's default
 * button face is light, and white-on-ButtonFace is invisible. The <a> sibling
 * never showed it because links have no default background.
 */

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const html = readFileSync(join(import.meta.dir, '..', 'chrome', 'welcome.html'), 'utf8')

test('.cta-close sets its own background (it styles a <button>)', () => {
  const rule = /\.cta-close\s*\{([^}]*)\}/.exec(html)
  expect(rule).not.toBeNull()
  expect(rule[1]).toMatch(/background:\s*#000/)
})

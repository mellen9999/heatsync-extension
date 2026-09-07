/**
 * F-ext-3 — the hover profile card (chrome/content.js buildCardDOM and its
 * helpers: buildModSection, buildNotesSection, buildHistorySection,
 * populateHistory, buildPanelFooter) hardcoded english button/label copy
 * next to correctly-t()-routed toasts. Pins that the known offenders route
 * through t() and stay out of the raw-string textContent form that leaked
 * before.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SRC = readFileSync(join(ROOT, 'chrome', 'content.js'), 'utf8')

// The profile-card region: buildCardDOM through the end of buildPanelFooter.
const START = SRC.indexOf('function buildCardDOM(profile, username) {')
const FOOTER_START = SRC.indexOf('function buildPanelFooter(username, profile) {')
const END = SRC.indexOf('\n      return footer\n    }\n', FOOTER_START) + '\n      return footer\n    }\n'.length
const REGION = SRC.slice(START, END)

test('sanity: the region actually contains the profile-card functions', () => {
  expect(START).toBeGreaterThan(-1)
  expect(FOOTER_START).toBeGreaterThan(START)
  expect(END).toBeGreaterThan(FOOTER_START)
})

const RAW_LABELS = [
  "'mutual'",
  "'mutual sub'",
  "'note'",
  "'message history'",
  "'view profile'",
  "'clip'",
  "'clipping…'",
  "'copy name'",
  "'mention'",
  "'block'",
  "'ban'",
  "'unban'",
  "'mod'",
  "'unmod'",
  "'vip'",
  "'unvip'",
  "'follow'",
  "'unfollow'",
  "'twitch profile'",
  "'mod tools'",
  "'loading…'",
  "'private note",
]

describe('profile card copy routes through t(), not raw strings', () => {
  for (const raw of RAW_LABELS) {
    test(`${raw} is not a raw textContent/label literal`, () => {
      expect(REGION).not.toContain(`textContent = ${raw}`)
      expect(REGION).not.toContain(`label: ${raw}`)
    })
  }

  test('buildNotesSection debounce timer no longer shadows the t() function', () => {
    expect(REGION).not.toMatch(/let t = null/)
  })
})

// Contract guard for rule R2 of the ecosystem posture (heatsync repo,
// docs/ecosystem-posture.md): heatsync cosmetics never render inside a
// platform's NATIVE chat DOM. They belong to our own surfaces — the multichat
// overlay, profile cards, logs, the site.
//
// Why a test and not a comment: it is the structural reason our $5/mo paid tier
// doesn't strictly dominate a ~$4 7TV sub. Our paint builder is more expressive
// than their curated paint catalog, so if our paints also rendered in twitch's
// own chat there would be no reason left to pay 7TV — we'd be taking their
// revenue on their own surface. The boundary is the deal, not an unfinished
// feature, and painting a native row is a two-line change for anyone who hasn't
// read the doc.
//
// Source-level assertion on purpose: these scripts run in the host page at
// document_start/document_end and can't be imported.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

// Every script that touches native twitch/kick/youtube chat rows.
const NATIVE_CHAT_SCRIPTS = [
  'src/content/content.js',
  'src/content/youtube-content.js',
  'src/content/chat-injector.js',
  'src/content/twitch-chat-intercept.js',
  'src/content/kick-chat-intercept.js',
  'src/content/early-inject-main.js',
]

// Heatsync-paint APPLICATION symbols. Reading the `hsp-` class is allowed and
// expected — the native 7TV path checks for it so a saved heatsync paint isn't
// stomped (see applyPaintToElement) — so the class prefix itself isn't banned.
const HS_PAINT_APPLICATION = [
  'applyHsPaintToElement',
  'updateHsPaintsInPlace',
  'getHsPaintClass',
  'hsPaintRender',
  'compileHsPaintCss',
]

describe('R2 — heatsync cosmetics stay off native chat', () => {
  for (const file of NATIVE_CHAT_SCRIPTS) {
    test(`${file} applies no heatsync paint`, () => {
      const src = readFileSync(join(ROOT, file), 'utf8')
      for (const symbol of HS_PAINT_APPLICATION) {
        expect(src).not.toContain(symbol)
      }
    })
  }

  test('the overlay is where paints actually get applied (guard is meaningful)', () => {
    const overlay = readFileSync(join(ROOT, 'src/multichat/cosmetics.js'), 'utf8')
    expect(overlay).toContain('applyHsPaintToElement')
  })
})

describe('R4 — a 7TV paint stands down for a saved heatsync paint, not the reverse', () => {
  for (const file of ['src/content/content.js', 'src/content/youtube-content.js']) {
    test(`${file} checks for an hsp- class before applying a 7TV paint`, () => {
      const src = readFileSync(join(ROOT, file), 'utf8')
      const fn = src.slice(src.indexOf('function applyPaintToElement'))
      expect(fn.slice(0, 900)).toContain("startsWith('hsp-')")
    })
  }
})

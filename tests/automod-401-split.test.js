/**
 * A 401 from /api/mod/automod-* means one of two unrelated things, and the
 * extension must not conflate them:
 *
 *   { error: 'relink_required' }  the twitch grant is missing the automod
 *                                 scope — relinking twitch fixes it
 *   a bare 401                    authRequired rejected OUR bearer token, i.e.
 *                                 the heatsync session expired — relinking
 *                                 twitch cannot fix it
 *
 * Both used to answer `relink_required`, so an expired session told the user
 * to relink twitch, forever, for a problem relinking could never close. The
 * user-visible toast was already gated on the server's own flag; it was the
 * sendResponse beneath it that was hardcoded, which is why it survived review.
 *
 * background.js is a single non-ESM service-worker script that registers
 * listeners at import time and cannot be safely imported here (see the note
 * atop tests/background-helpers.test.js). So this asserts on the SOURCE, the
 * same marker-slicing approach that file and build.js's error-reporter parity
 * check already use: find each 401 branch in the automod paths and require it
 * to answer both ways. It fails loudly if the branches are ever collapsed back
 * into one, or if the markers move.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'chrome', 'background.js'), 'utf8')

/** Every `res.status === 401` branch plus the lines that answer it. */
function fourOhOneBlocks() {
  const lines = SRC.split('\n')
  const blocks = []
  lines.forEach((line, i) => {
    if (!/status === 401/.test(line)) return
    blocks.push({ line: i + 1, text: lines.slice(i, i + 16).join('\n') })
  })
  return blocks
}

test('background.js still has automod 401 branches to check', () => {
  // Guards the guard: if the markers vanish, this suite must fail rather than
  // vacuously pass over zero blocks.
  const automod = fourOhOneBlocks().filter((b) => /relink_required/.test(b.text))
  expect(automod.length).toBeGreaterThanOrEqual(2)
})

test('a bare 401 answers auth_required, never relink_required', () => {
  for (const b of fourOhOneBlocks()) {
    if (!/relink_required/.test(b.text)) continue
    // The twitch-grant answer must be conditional on the server saying so...
    expect(b.text).toMatch(/data\?\.error === 'relink_required'/)
    // ...and the other side of that branch must exist.
    expect(b.text).toContain('auth_required')
  }
})

test('the relink toast only fires on a server-declared relink_required', () => {
  for (const b of fourOhOneBlocks()) {
    if (!/notifyAutomodRelinkOnce/.test(b.text)) continue
    const beforeToast = b.text.slice(0, b.text.indexOf('notifyAutomodRelinkOnce'))
    expect(beforeToast).toMatch(/data\?\.error === 'relink_required'/)
  }
})

/**
 * The 401 branches were only half the story: both automod handlers also
 * pre-flight the heatsync cookie BEFORE they ever call the server, and the
 * action handler answered that missing cookie with 'relink_required' — the
 * same wrong sentence, from a path no `status === 401` scan could see. A
 * signed-out mod clicking allow was told to re-link twitch, forever.
 */
function cookieGuardBlocks() {
  const lines = SRC.split('\n')
  const blocks = []
  lines.forEach((line, i) => {
    if (!/const authToken = await getAuthCookie\(\)/.test(line)) return
    const text = lines.slice(i, i + 8).join('\n')
    // Only the automod handlers — other features have their own conventions.
    const context = lines.slice(Math.max(0, i - 40), i).join('\n')
    if (!/automod_watch|automod_action/.test(context)) return
    blocks.push({ line: i + 1, text })
  })
  return blocks
}

test('both automod handlers still pre-flight the heatsync cookie', () => {
  expect(cookieGuardBlocks().length).toBe(2)
})

test('a missing heatsync cookie never answers relink_required', () => {
  for (const b of cookieGuardBlocks()) {
    expect(b.text).not.toMatch(/error: 'relink_required'/)
  }
})

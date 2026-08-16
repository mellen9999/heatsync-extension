// A stream-event row that ANNOUNCES something is not a shortcut to anywhere.
//
// The row-level click in main.js opts the row into `data-hs-clickable`, which
// the universal rule in styles/17-platform-position.css turns into the white-bg
// /black-text plate on hover. That is correct for an event whose subject is the
// channel (online / offline / raid / hype / game-switch): the row really is a
// shortcut to that stream.
//
// It is wrong for the rows that carry an ACTOR. `ch` prefers `m.actor`, which is
// set on exactly the events where the name is not a channel — a channel-point
// redeem carries the redeemer, a 7TV emote-change banner carries the editor.
// Those rows were opening twitch.tv/<some viewer> and wearing the white plate
// the whole time, advertising a destination on a line that is a notice.
//
// buildMessageDiv cannot be imported (it closes over the whole multichat module
// and needs a full window/DOM/IRC harness — the same constraint documented in
// main-world-proxy-guards.test.js and background-helpers.test.js). The real
// regression risk here is "someone drops the guard" or "someone stops setting
// actor", and either end breaking silently restores the bug — so both ends are
// fenced structurally, against the real committed source.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAIN = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
const HOVER_CSS = readFileSync(
  join(import.meta.dir, '..', 'src', 'multichat', 'styles', '17-platform-position.css'),
  'utf8',
)

describe('stream-event rows: only a channel-subject row is a shortcut', () => {
  test('the row-level click opt-in is gated on the row having no actor', () => {
    // The block that sets dataset.hsClickable / cursor / the twitch.tv click.
    const gate = MAIN.match(/if \(!isYtEvent && ch && !m\.actor\) \{\s*\n\s*div\.dataset\.hsClickable = ''/)
    expect(gate).not.toBeNull()
  })

  test('nothing else in the stream-event branch opts a row in', () => {
    // Scoped to the stream-event branch — the inline DM row and the moment row
    // opt in too, and both are genuinely clickable, so a repo-wide count would
    // only measure them. What matters is that within THIS branch the single
    // opt-in is the gated one; a second, ungated one would restore the bug.
    const branch = MAIN.slice(
      MAIN.indexOf("if (m.type === 'stream-event') {"),
      MAIN.indexOf("if (m.type === 'feed-post') {"),
    )
    expect(branch.length).toBeGreaterThan(0)
    const optIns = branch.match(/div\.dataset\.hsClickable = ''/g) || []
    expect(optIns.length).toBe(1)
    expect(branch).toContain('!isYtEvent && ch && !m.actor')
  })

  test('ch still prefers the actor, which is what makes the gate necessary', () => {
    expect(MAIN).toContain("const ch = m.actor || m.channel || ''")
  })
})

describe('the producers still mark actor-subject events', () => {
  test('a stream:redeem carries the redeemer as actor', () => {
    expect(MAIN).toMatch(/const actor = msg\.eventType === 'stream:redeem' \? msg\.user : null/)
  })

  test('a hermes redeem carries the redeemer as actor', () => {
    expect(MAIN).toMatch(/const actor = eventType === 'redeem' \? data\.user : null/)
  })

  test('a 7TV emote-change banner carries its editor as actor', () => {
    expect(MAIN).toMatch(/eventClass: 'event-emote'[^\n]*actor: actor \|\| null/)
  })
})

describe('the white plate is still opt-in, so omission is enough to stay inert', () => {
  // The fix relies on the universal hover being an ALLOWLIST: a row that never
  // gets data-hs-clickable is inert with no extra CSS, which is how every other
  // notice row in the panel (system, automod, kicks) already stays inert. If
  // this rule ever grew a blanket row selector, "just don't opt in" would stop
  // working and the redeem row would silently go white again.
  test('the hover rule matches on the opt-in attribute, not on a row class', () => {
    expect(HOVER_CSS).toContain('[data-hs-clickable]')
    expect(HOVER_CSS).not.toMatch(/#hs-mc-container\s+\.hs-mc-stream-event[^{]*:hover/)
  })
})

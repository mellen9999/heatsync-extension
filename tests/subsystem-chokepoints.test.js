import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where a subsystem switch has to live.
 *
 * A sweep of all 16 switches found the same defect five times over, and it was
 * never a missing gate — it was a gate in the wrong PLACE:
 *
 *   irc-twitch     gated `irc.connect()`, which is a no-op (the BG owns the
 *                  socket). Measured in a real chromium: with the switch off, a
 *                  bg_irc_msg broadcast still rendered a twitch chat row.
 *   chat-kick      gated the render side only; 13 of 17 join call sites had no
 *                  gate, so the BG still joined and buffered.
 *   chat-youtube   gated 3 of 8 youtube_ws_subscribe emitters.
 *   cosmetics      gated the boot PULL (loadBulkBadges) and neither the BG push
 *                  nor the per-message lookup every rendered row goes through.
 *   whispers       gated 1 of the 3 transports that reach the whisper timeline.
 *   profile-cards  gated the click handlers; the context menu called the opener
 *                  directly.
 *
 * The lesson is mechanical: put the gate where the behaviour is unavoidable,
 * not where a caller happens to start it. A switch that depends on every call
 * site remembering it is not a switch. This file pins the chokepoints.
 */

const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')

const IRC = read('src', 'multichat', 'irc.js')
const MAIN = read('src', 'multichat', 'main.js')
const SOCIAL = read('src', 'multichat', 'social.js')
const COSMETICS = read('src', 'multichat', 'cosmetics.js')
const WHISPERS = read('src', 'multichat', 'whispers.js')
const CARD = read('src', 'multichat', 'profile-card.js')
const INPUT = read('src', 'multichat', 'input.js')

/** The first `n` chars of a function body, brace-matched from its signature. */
function body(src, signature, n = 1200) {
  const at = src.indexOf(signature)
  expect(at, `signature moved: ${signature}`).toBeGreaterThan(-1)
  return src.slice(at, at + n)
}

describe('subsystem chokepoints', () => {
  test('twitch: the listener that IS the feed is gated, not the no-op connect', () => {
    // The bg_irc_msg listener is registered in the IRC constructor. That
    // registration — not connect() — is what makes twitch chat appear.
    const ctor = body(IRC, '  ingestChatPayload', 0) // ensure file shape sanity
    expect(typeof ctor).toBe('string')
    const at = IRC.indexOf("if (gateAtBoot('irc-twitch'))")
    expect(at, 'the irc-twitch gate around listener registration is gone').toBeGreaterThan(-1)
    const region = IRC.slice(at, at + 500)
    expect(region).toContain("message.type === 'bg_irc_msg'")
    expect(region).toContain('cleanup.addListener(chrome.runtime?.onMessage, this._listener)')
  })

  test('twitch: connect() is still a no-op, so gating it would prove nothing', () => {
    // If this ever becomes real, the gate above is no longer the only one that
    // matters and this file should be revisited.
    expect(IRC).toContain('  connect() {\n    /* BG owns the WebSocket */\n  }')
  })

  test('twitch + kick: join is gated inside the class, not at the call sites', () => {
    expect(body(IRC, '  async join(ch) {')).toContain("if (!gateAtBoot('irc-twitch')) return")
    expect(body(IRC, '  async join(kickUsername) {')).toContain("if (!gateAtBoot('chat-kick')) return")
  })

  test('twitch + kick: the gate precedes the re-entry guard, or it never runs', () => {
    // `if (this.channels.has(ch)) return` short-circuits a repeat join. A gate
    // placed after it would still let the FIRST join through.
    for (const [sig, guard] of [
      ['  async join(ch) {', 'this.channels.has(ch)'],
      ['  async join(kickUsername) {', 'this.channels.has(kickUsername)'],
    ]) {
      const b = body(IRC, sig)
      expect(b).toContain('gateAtBoot(')
      expect(b).toContain(guard)
      expect(b.indexOf('gateAtBoot(')).toBeLessThan(b.indexOf(guard))
    }
  })

  test('youtube: exactly one thing emits a subscribe, and it checks the switch', () => {
    const files = { SOCIAL, MAIN, CARD, INPUT, COSMETICS, WHISPERS, IRC }
    let emitters = 0
    for (const src of Object.values(files)) {
      emitters += [...src.matchAll(/type:\s*'youtube_ws_subscribe'/g)].length
    }
    expect(emitters, 'more than one youtube_ws_subscribe emitter — the gate can be bypassed again').toBe(1)
    const fn = body(SOCIAL, 'function ytSubscribe(', 700)
    expect(fn).toContain("gateAtBoot('chat-youtube') === false")
    expect(fn).toContain('sendMessage')
    expect(fn.indexOf('gateAtBoot')).toBeLessThan(fn.indexOf('sendMessage'))
  })

  test('youtube: the emote join rides the same gate', () => {
    // Fetching a channel's youtube emote set with youtube chat off is work for
    // rows that can never render. It is the same call, so it is the same gate.
    const fn = body(SOCIAL, 'function ytSubscribe(', 700)
    expect(fn).toContain("platform: 'youtube'")
    expect(fn).toContain('gateAtBoot')
    expect(fn.indexOf('gateAtBoot')).toBeLessThan(fn.indexOf("platform: 'youtube'"))
  })

  test('whispers: gated at the timeline, where all three transports meet', () => {
    const fn = body(WHISPERS, 'function handleIncomingWhisper(msg) {', 1400)
    expect(fn).toContain("if (gateAtBoot('whispers') === false) return")
    // Before the dedup mark — a gated-off whisper must not consume the dedup
    // credit its later re-delivery would need.
    expect(fn).toContain('_whisperMarkSeen')
    expect(fn.indexOf("gateAtBoot('whispers')")).toBeLessThan(fn.indexOf('_whisperMarkSeen'))
  })

  test('whispers: all three producers really do funnel through it', () => {
    for (const [file, src] of [
      ['auth-irc.js', read('src', 'multichat', 'auth-irc.js')],
      ['eventsub-whispers.js', read('src', 'multichat', 'eventsub-whispers.js')],
      ['social.js', SOCIAL],
    ]) {
      expect(src, `${file} no longer routes through the chokepoint`).toContain('handleIncomingWhisper(')
    }
  })

  test('cosmetics: gated at the per-message lookup, not just the boot pull', () => {
    const fn = body(COSMETICS, 'function queueMcCosmeticsLookup(userId) {', 1600)
    expect(fn).toContain("if (gateAtBoot('cosmetics') === false) return")
  })

  test('cosmetics: heatsync paints stay OUTSIDE that gate', () => {
    // The switch is named "third-party cosmetics". Over-gating here would take
    // our own paints down with 7TV's — the exact mistake that made the feed
    // switch kill youtube chat.
    const fn = body(COSMETICS, 'function queueMcCosmeticsLookup(userId) {', 1600)
    // Assert presence FIRST. `indexOf` returns -1 for a call that is gone, and
    // -1 is less than any real index — so the ordering check alone passes when
    // the paint lookup has been deleted outright. (Caught by mutating it away.)
    expect(fn).toContain('queuePaintLookup(userId)')
    expect(fn).toContain("gateAtBoot('cosmetics')")
    expect(fn.indexOf('queuePaintLookup(userId)')).toBeLessThan(fn.indexOf("gateAtBoot('cosmetics')"))
  })

  test('cosmetics: the background PUSH is gated too', () => {
    expect(MAIN).toContain("if (msg.type === 'cosmetics_update' && gateAtBoot('cosmetics') === false) return")
    expect(MAIN).toContain("msg.type === 'cosmetics_invalidated' && msg.twitchId && gateAtBoot('cosmetics') !== false")
  })

  test('profile cards: gated at the opener, not only at the click handlers', () => {
    expect(body(CARD, 'async function openProfileCard(username, platform) {', 400)).toContain(
      "if (gateAtBoot('profile-cards') === false) return",
    )
  })

  test('a switched-off feature is not re-offered by the context menu', () => {
    // A menu row that turns a disabled feature back on is the same lie in UI form.
    expect(INPUT).toContain("if (gateAtBoot('whispers') !== false) {")
    expect(INPUT).toContain("if (gateAtBoot('profile-cards') !== false) {")
    expect(INPUT).toContain("if (msg && gateAtBoot('feed') !== false) {")
    // …and the rows no switch owns keep showing.
    expect(INPUT).toContain("{ label: 'dm', fn: () => _openDmFor(username, platform) }")
    expect(INPUT).toContain("{ label: 'mention', fn: () => _mentionInMcInput(username) }")
  })
})

describe('the gate helper itself', () => {
  test('gateAtBoot never invents a yes', () => {
    // It used to `return _gatesAtBoot?.[id] !== false`, which answers "enabled"
    // for every caller that runs before the snapshot. loadConfig() was one such
    // caller, 131 lines early, which is how chat-youtube:false still subscribed
    // every saved channel.
    const fn = body(MAIN, '  function gateAtBoot(id) {', 700)
    expect(fn).toContain('if (_gatesAtBoot == null) return isEnabled(id)')
    expect(fn).not.toMatch(/return\s+_gatesAtBoot\?\.\[id\]/)
  })

  test('the snapshot is taken before the first consumer', () => {
    const initAt = MAIN.indexOf('await snapshotGates()')
    const loadAt = MAIN.indexOf('await loadConfig()')
    expect(initAt, 'snapshotGates is no longer awaited in init').toBeGreaterThan(-1)
    expect(loadAt).toBeGreaterThan(-1)
    expect(initAt, 'loadConfig consults gates — it must not run before the snapshot').toBeLessThan(loadAt)
  })

  test('the snapshot does not read the un-hydrated settings registry', () => {
    // getSetting() falls back to the schema default — all true — this early,
    // which would be the same silent yes by another route.
    const fn = body(MAIN, '  async function snapshotGates() {', 700)
    expect(fn).toContain('cachedUiSettings()')
    expect(fn).not.toContain("getSetting('subsystems')")
  })
})

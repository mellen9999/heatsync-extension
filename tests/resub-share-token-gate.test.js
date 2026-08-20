/**
 * We may only take over twitch's share button when we can actually finish the
 * job.
 *
 * The resub flow ends in the Chat_ShareResub_UseResubToken mutation, which
 * needs a token twitch issued. That token is not a prop under any name: twitch
 * carries it as the react KEY of the element it renders the callout from, two
 * fibers under the queue container (measured live on a 107-month callout). The
 * scan used to read props only, always came back empty, and the flow fell
 * through to twitch's own button — which hands the celebration to twitch's
 * composer, the one heatsync replaces, so nothing was ever sent and the callout
 * returned on the next reload.
 *
 * The token is base64 of "<userId>:<channelId>:<count>:<kind>", so decoding it
 * IS the validation — nothing else on the page decodes to that shape. Guessing
 * one is never allowed: a wrong token fails the mutation, and the failure path
 * posts the typed text as an ordinary chat message, which looks like success
 * while twitch never marks the resub shared.
 *
 * Source-text invariants (house pattern — main.js has top-level side effects
 * and cannot be imported).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const MAIN_SRC = readFileSync(new URL('../src/multichat/main.js', import.meta.url), 'utf8')
const NOTIFS_SRC = readFileSync(new URL('../src/multichat/notifs.js', import.meta.url), 'utf8')

describe('the resub click is only intercepted with a real token', () => {
  test('no reconstructed token exists anywhere in the flow', () => {
    // The strongest form of the old ordering guarantee: there is nothing to
    // order, because nothing builds a token out of ids and a month count.
    expect(MAIN_SRC).not.toContain('fallbackToken')
    expect(MAIN_SRC).not.toMatch(/btoa\(`\$\{[^`]*\}:\$\{[^`]*\}:/)
  })

  test('the token must belong to THIS callout', () => {
    const i = MAIN_SRC.indexOf('const resubToken =')
    expect(i).toBeGreaterThan(-1)
    const block = MAIN_SRC.slice(i, i + 200)
    // A sub-anniversary token, for the month count the callout announces.
    expect(block).toContain("scan.kind === 'cumulative'")
    expect(block).toContain('scan.months === months')
  })

  test('the share button hook is gated on it', () => {
    expect(MAIN_SRC).toMatch(/if \(hasRealToken && shareBtn/)
  })

  test('a guessed token is never handed to the notification', () => {
    const i = MAIN_SRC.indexOf("HsNotifs.emit('twitch-resub-share'")
    expect(i).toBeGreaterThan(-1)
    const block = MAIN_SRC.slice(i, i + 700)
    expect(block).toMatch(/_resubToken: resubToken,/)
  })
})

describe('without a token the prompt defers to twitch', () => {
  const handler = (() => {
    const i = NOTIFS_SRC.indexOf("registerType('twitch-resub-share'")
    expect(i).toBeGreaterThan(-1)
    return NOTIFS_SRC.slice(i, NOTIFS_SRC.indexOf('registerType(', i + 10))
  })()

  test('enters our share mode only when a token is present', () => {
    // Shape changed 2026-08-16: the click now RE-SCANS before giving up, so the
    // gate reads `if (token)` where token is the emitted one or a fresh scan.
    // The invariant is unchanged — share mode is entered only with a real
    // token — and the rescan can only return what the fiber scan found.
    expect(handler).toMatch(/const token =\s*\n?\s*data\._resubToken \|\|/)
    expect(handler).toMatch(/rescanToken/)
    expect(handler).toMatch(/if \(token\) \{/)
  })

  test('the click-time rescan reads the fiber scan and nothing else', () => {
    const i = MAIN_SRC.indexOf('rescanToken: (rootEl) =>')
    expect(i).toBeGreaterThan(-1)
    const block = MAIN_SRC.slice(i, MAIN_SRC.indexOf('_allowNativeShare', i))
    expect(block).toContain('fiberTokenScan')
    expect(block).not.toContain('btoa')
    // The live container first — twitch re-renders the queue, so the element
    // captured at detection time can already be detached, and a detached fiber
    // still hands back the stale key.
    expect(block).toContain('document.querySelector(CALLOUT_QUEUE_SEL)')
  })

  test('otherwise clicks twitch own button', () => {
    expect(handler).toMatch(/clickNative/)
  })

  test('clickNative actually exists in main.js', () => {
    // The near-miss this pins is the same one the reply-ctx suite pins: a
    // handler calling a name nobody defined, silently doing nothing forever.
    expect(MAIN_SRC).toMatch(/clickNative:\s*\(btn\)\s*=>/)
  })

  test('clickNative stands the interceptor down and restores it', () => {
    const i = MAIN_SRC.indexOf('clickNative:')
    const block = MAIN_SRC.slice(i, i + 800)
    expect(block).toMatch(/_allowNativeShare = true/)
    expect(block).toMatch(/finally/)
    expect(block).toMatch(/_allowNativeShare = false/)
  })
})

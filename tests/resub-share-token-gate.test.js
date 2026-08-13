/**
 * We may only take over twitch's share button when we can actually finish the
 * job.
 *
 * The resub flow ends in the Chat_ShareResub_UseResubToken mutation, which
 * needs a token twitch issued. surface() scans react fibers for one and, when
 * that finds nothing, RECONSTRUCTS a guess (base64
 * "<uid>:<cid>:<months>:cumulative") inferred from an older build. Twitch's
 * current build exposes no token prop anywhere near the callout — verified live
 * by walking 400 fibers off the share button — so the guess was always what got
 * sent, the mutation always failed, and the failure path posts the typed text as
 * an ordinary chat message.
 *
 * That is the worst possible shape: it looks like it worked, while twitch never
 * marks the resub shared, so the callout comes back on the next refresh.
 * Reported as "appears like it works but it keeps coming back like every
 * refresh".
 *
 * Source-text invariants (house pattern — main.js has top-level side effects
 * and cannot be imported).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const MAIN_SRC = readFileSync(new URL('../src/multichat/main.js', import.meta.url), 'utf8')
const NOTIFS_SRC = readFileSync(new URL('../src/multichat/notifs.js', import.meta.url), 'utf8')

describe('the resub click is only intercepted with a real token', () => {
  test('hasRealToken is captured BEFORE the fallback overwrites it', () => {
    const i = MAIN_SRC.indexOf('const hasRealToken')
    const j = MAIN_SRC.indexOf('resubToken = fallbackToken(months)')
    expect(i, 'hasRealToken missing').toBeGreaterThan(-1)
    expect(j, 'fallback missing').toBeGreaterThan(-1)
    // Order is the whole point: read the genuine value first, then guess.
    expect(i).toBeLessThan(j)
  })

  test('the share button hook is gated on it', () => {
    expect(MAIN_SRC).toMatch(/if \(hasRealToken && shareBtn/)
  })

  test('a guessed token is never handed to the notification', () => {
    const i = MAIN_SRC.indexOf("HsNotifs.emit('twitch-resub-share'")
    expect(i).toBeGreaterThan(-1)
    const block = MAIN_SRC.slice(i, i + 700)
    expect(block).toMatch(/_resubToken: hasRealToken \? resubToken : null/)
  })
})

describe('without a token the prompt defers to twitch', () => {
  const handler = (() => {
    const i = NOTIFS_SRC.indexOf("registerType('twitch-resub-share'")
    expect(i).toBeGreaterThan(-1)
    return NOTIFS_SRC.slice(i, NOTIFS_SRC.indexOf('registerType(', i + 10))
  })()

  test('enters our share mode only when a token is present', () => {
    expect(handler).toMatch(/if \(data\._resubToken\)/)
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

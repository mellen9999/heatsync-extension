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
    // A sub-anniversary token, for the month count the callout announces —
    // asked through the one predicate, never by hand. Hand-rolled gates are how
    // `scan.count` came to be read off a scan that only set `scan.months`.
    // Behaviour is covered for real in tests/callout-token-scan.
    expect(block).toContain('calloutTokenMatches(scan, ')
    expect(block).toContain("kind: 'cumulative'")
    expect(block).toContain('count: months')
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
    const i = MAIN_SRC.indexOf('rescanToken: (rootEl, expect)')
    expect(i).toBeGreaterThan(-1)
    const block = MAIN_SRC.slice(i, MAIN_SRC.indexOf('_allowNativeShare', i))
    expect(block).toContain('fiberTokenScan')
    expect(block).not.toContain('btoa')
  })

  test('the rescan scans the callout it was handed, not the first one on screen', () => {
    // querySelector(CALLOUT_QUEUE_SEL) returns whichever callout is first in
    // the DOM, which is the WRONG one whenever a sub anniversary and a watch
    // streak are queued together — the same cross-callout mixup fiberTokenScan
    // refuses to make by not following the root's siblings.
    const i = MAIN_SRC.indexOf('rescanToken: (rootEl, expect)')
    const block = MAIN_SRC.slice(i, MAIN_SRC.indexOf('_allowNativeShare', i))
    expect(block).toContain('rootEl?.isConnected')
    // The all-callouts sweep is the DETACHED fallback only, and every candidate
    // has to satisfy `expect` before it is returned.
    expect(block).toContain('querySelectorAll(CALLOUT_QUEUE_SEL)')
    expect(block).toMatch(
      /for \(const el of document\.querySelectorAll[\s\S]{0,200}calloutTokenMatches\(scan, expect\)/,
    )
  })

  test('both prompts tell the rescan which callout is theirs', () => {
    const resub = NOTIFS_SRC.slice(NOTIFS_SRC.indexOf("registerType('twitch-resub-share'"))
    expect(resub.slice(0, resub.indexOf('registerType(', 10))).toMatch(
      /rescanToken\?\.\([\s\S]{0,120}count: data\.months/,
    )
    const ws = NOTIFS_SRC.slice(NOTIFS_SRC.indexOf("registerType('twitch-watchstreak-share'"))
    expect(ws.slice(0, ws.indexOf('registerType(', 10))).toMatch(
      /rescanToken\?\.\([\s\S]{0,120}count: data\.streakCount/,
    )
  })

  test('otherwise clicks twitch own button', () => {
    expect(handler).toMatch(/clickNative/)
  })

  test('and says so — the no-token path never fails silently', () => {
    // Clicking twitch's button only puts TWITCH's composer into share-mode, and
    // heatsync replaces that composer, so the user is left with a closed prompt
    // and nothing sent. Silence here is what hid the broken share for months.
    const i = handler.indexOf('clickNative')
    const block = handler.slice(i, i + 300)
    expect(block).toContain("emit('toast'")
    expect(block).toContain('mc_notifs_share_token_missing')
    expect(block).toContain("level: 'error'")
  })

  test('the toast copy is real, not a raw key', () => {
    const EN = JSON.parse(readFileSync(new URL('../src/_locales/en/messages.json', import.meta.url), 'utf8'))
    expect(EN.mc_notifs_share_token_missing?.message).toBeTruthy()
    // t() falls back to the key itself, which would render as literal
    // "mc_notifs_share_token_missing" on the user's statusbar.
    expect(EN.mc_notifs_share_token_missing.message).not.toContain('mc_notifs')
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

describe('the watch-streak callout shares the same way', () => {
  const MAIN = MAIN_SRC
  const consume = MAIN.slice(
    MAIN.indexOf('window.__hsWatchstreakShare = {'),
    MAIN.indexOf('function setupHsCalloutCloseButton'),
  )

  test('one mutation serves both callouts', () => {
    // The resolver is useChatNotificationToken and the token says which callout
    // is being consumed, so a second copy of this call would only be a second
    // place to get the error handling wrong.
    expect(MAIN.match(/gqlProxy\('Chat_ShareResub_UseResubToken'/g)).toHaveLength(1)
    expect(MAIN).toContain('async function _consumeCalloutToken(channel, token, text)')
  })

  test('a rejected token is never mistaken for a share', () => {
    const i = MAIN.indexOf('async function _consumeCalloutToken')
    const block = MAIN.slice(i, i + 900)
    // HTTP 200 + errors[] + a null field is what rejection looks like.
    expect(block).toContain('useChatNotificationToken === null')
    expect(block).toMatch(/if \(errs\) throw/)
  })

  test('with a token the typed text is the body, not a second message', () => {
    const i = consume.indexOf('if (claim.streakToken)')
    expect(i).toBeGreaterThan(-1)
    const block = consume.slice(i, consume.indexOf('broadcastShare()', i))
    expect(block).toContain('_consumeCalloutToken(claim.channel, claim.streakToken, text)')
    // true = sendMessage stops here. Returning false would post the celebration
    // body a second time as ordinary chat.
    expect(block).toMatch(/return true/)
  })

  test('a failed share rescues the words the user typed', () => {
    const i = consume.indexOf('if (claim.streakToken)')
    const block = consume.slice(i, consume.indexOf('broadcastShare()', i))
    expect(block).toContain('_resubShareTextRescue(claim.channel, text)')
  })

  test('without a token nothing changes', () => {
    // The native click stays exactly where it was, so the no-token case is the
    // behaviour that shipped before, not a new failure mode.
    expect(consume).toContain('broadcastShare()')
    expect(consume).toMatch(/return false\n\s*\},/)
  })

  test('the token must match the streak the callout announces', () => {
    const i = MAIN_SRC.indexOf('const streakToken =')
    expect(i).toBeGreaterThan(-1)
    expect(MAIN_SRC.slice(i, i + 160)).toContain('calloutTokenMatches(scan, { count: streakCount })')
  })
})

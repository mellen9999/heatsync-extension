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

const MAIN_SRC = ['main.js', 'share-callouts.js']
  .map((f) => readFileSync(new URL(`../src/multichat/${f}`, import.meta.url), 'utf8'))
  .join('\n')
const NOTIFS_SRC = readFileSync(new URL('../src/multichat/notifs.js', import.meta.url), 'utf8')

describe('the resub click is only intercepted with a real token', () => {
  test('a token is only ever built in deriveResubToken, from verified ids', () => {
    // 2026-08-20 removed the guessed `fallbackToken`: a wrong one failed the
    // mutation and the failure read as success. Rebuilt 2026-10-16 as
    // deriveResubToken, and only because the failure can no longer hide — the
    // mutation's real result field is read (a null field throws) and a failed
    // share toasts and rescues the typed text. Nothing else may build one.
    expect(MAIN_SRC).not.toContain('fallbackToken')
    const a = MAIN_SRC.indexOf('async function deriveResubToken')
    expect(a).toBeGreaterThan(-1)
    const rest = MAIN_SRC.slice(0, a) + MAIN_SRC.slice(MAIN_SRC.indexOf('\nwindow.__hsResubShare', a))
    expect(rest).not.toMatch(/btoa\(`\$\{[^`]*\}:\$\{[^`]*\}:/)
    expect(MAIN_SRC).toContain('data?.data && data.data.useChatNotificationToken === null')
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
    expect(NOTIFS_SRC).toMatch(/function nativeFallback[\s\S]{0,700}clickNative/)
  })

  test('and says so — the no-token path never fails silently', () => {
    // Clicking twitch's button only puts TWITCH's composer into share-mode, and
    // heatsync replaces that composer, so the user is left with a closed prompt
    // and nothing sent. Silence here is what hid the broken share for months.
    const i = NOTIFS_SRC.indexOf('clickNative', NOTIFS_SRC.indexOf('function nativeFallback'))
    const block = NOTIFS_SRC.slice(i, i + 300)
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

describe('an unreadable twitch key builds the token from ids we hold', () => {
  const SHARE_SRC = readFileSync(new URL('../src/multichat/share-callouts.js', import.meta.url), 'utf8')
  const derive = SHARE_SRC.slice(SHARE_SRC.indexOf('async function deriveResubToken'))

  test('the token is the exact shape twitch issues, and decodes back through the validator', () => {
    expect(derive.slice(0, 1400)).toContain('btoa(`${selfId}:${channelId}:${months}:cumulative`)')
    const m = /^(\d+):(\d+):(\d+):([a-z_]+)$/i.exec(atob(btoa('123:456:109:cumulative')))
    expect(m?.slice(1)).toEqual(['123', '456', '109', 'cumulative'])
  })

  test('a missing id is a null, never a default', () => {
    expect(derive.slice(0, 1400)).toContain('channel id unknown')
    expect(derive.slice(0, 1400)).toContain('no channel/months')
  })

  test('the click asks the page world, then derives, then falls back to twitch own button', () => {
    const resub = NOTIFS_SRC.slice(NOTIFS_SRC.indexOf("registerType('twitch-resub-share'"))
    const h = resub.slice(0, resub.indexOf('registerType(', 10))
    expect(h.indexOf('findToken')).toBeGreaterThan(h.indexOf('rescanToken'))
    expect(h.indexOf('deriveToken')).toBeGreaterThan(h.indexOf('findToken'))
    expect(h).toMatch(/\.findToken\(\{ kind: 'cumulative', count: data\.months \}\)/)
    expect(NOTIFS_SRC).toContain('function nativeFallback(data)')
  })
})

describe('the page-world token reader (chrome/twitch-callout-token.js)', () => {
  const SRC = readFileSync(new URL('../chrome/twitch-callout-token.js', import.meta.url), 'utf8')
  const tok = (u, c, n, k) => btoa(`${u}:${c}:${n}:${k}`)

  // a window/document just big enough to run the script for real
  function boot(callouts) {
    const ls = {}
    const win = {
      addEventListener: (t, f) => {
        ;(ls[t] ||= []).push(f)
      },
      removeEventListener: () => {},
      dispatchEvent: (e) => {
        for (const f of ls[e.type] || []) f(e)
      },
    }
    const replies = []
    ls['hs-callout-token-res'] = [(e) => replies.push(JSON.parse(e.detail))]
    const doc = { querySelectorAll: () => callouts }
    class CE {
      constructor(type, init) {
        this.type = type
        this.detail = init?.detail
      }
    }
    new Function('window', 'document', 'CustomEvent', 'atob', SRC)(win, doc, CE, atob)
    const ask = (id) => win.dispatchEvent(new CE('hs-callout-token-req', { detail: JSON.stringify({ id }) }))
    return { ask, replies, win }
  }
  // twitch's shape: the token is the key of a fiber two levels under the container
  const el = (key) => ({ __reactFiber$x: { key: null, child: { key: null, child: { key, child: null } } } })

  test('reads the token from the key two fibers down and answers the asker by id', () => {
    const t = tok('1', '2', 109, 'cumulative')
    const { ask, replies } = boot([el(t)])
    ask('abc')
    expect(replies).toEqual([{ id: 'abc', tokens: [{ raw: t, channelId: '2', count: 109, kind: 'cumulative' }] }])
  })

  test('lists every callout in the queue, so the overlay can pick its own', () => {
    const a = tok('1', '2', 109, 'cumulative')
    const b = tok('1', '2', 4, 'watch_streak')
    const { ask, replies } = boot([el(a), el(b)])
    ask('q')
    expect(replies[0].tokens.map((t) => t.kind)).toEqual(['cumulative', 'watch_streak'])
  })

  test('answers with nothing for a callout without a readable key, and ignores malformed requests', () => {
    const { ask, replies, win } = boot([el('chat-line-1'), {}])
    ask('z')
    expect(replies).toEqual([{ id: 'z', tokens: [] }])
    win.dispatchEvent({ type: 'hs-callout-token-req', detail: 'not json' })
    expect(replies.length).toBe(1)
  })

  test('the isolated side asks for it and matches on kind and count', () => {
    const SHARE_SRC = readFileSync(new URL('../src/multichat/share-callouts.js', import.meta.url), 'utf8')
    expect(SHARE_SRC).toContain("new CustomEvent('hs-callout-token-req'")
    expect(SHARE_SRC).toContain('findToken: findCalloutToken')
    expect(SHARE_SRC).toContain('expect.notKind')
  })

  test('both manifests load it in the page world beside the chat intercept', () => {
    for (const f of ['chrome', 'firefox']) {
      const m = JSON.parse(readFileSync(new URL(`../src/manifests/${f}.json`, import.meta.url), 'utf8'))
      const entry = m.content_scripts.find((c) => c.js.includes('twitch-callout-token.js'))
      expect(entry?.world).toBe('MAIN')
    }
  })
})

describe('a share clears the prompt in the other open windows', () => {
  const SHARE_SRC = readFileSync(new URL('../src/multichat/share-callouts.js', import.meta.url), 'utf8')

  test('announced only after the mutation landed, for both callout kinds', () => {
    const resub = SHARE_SRC.indexOf("log('resub-share: GQL fired ok')")
    expect(SHARE_SRC.slice(resub, resub + 160)).toContain("_announceCalloutShared({ kind: 'resub'")
    const streak = SHARE_SRC.indexOf("log('watchstreak-share: GQL fired ok')")
    expect(SHARE_SRC.slice(streak, streak + 160)).toContain("_announceCalloutShared({ kind: 'streak'")
  })

  test('the listener dismisses the exact key the banner was emitted under', () => {
    expect(SHARE_SRC).toContain("dismissByKey?.('twitch-resub-share', `resub:${d.channel}:${d.months}`)")
    expect(SHARE_SRC).toContain("dismissByKey?.('twitch-watchstreak-share', `watchstreak:${d.channel}:${d.count}`)")
    // the keys are the notif types' own dedupeKey shapes
    const NOTIFS_SRC = readFileSync(new URL('../src/multichat/notifs.js', import.meta.url), 'utf8')
    expect(NOTIFS_SRC).toContain('`resub:${channel}:${months}`')
    expect(NOTIFS_SRC).toContain('`watchstreak:${channel}:${streakCount}`')
  })
})

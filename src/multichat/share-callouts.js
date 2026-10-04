// resub / watch-streak share-mode + callout-token scan + callout close button —
// split out of main.js (2026-10-04). pure move; shares main.js's closure scope
// via the build's flat concat (loaded before main.js).

// Twitch resub-share / sub-anniversary callout: hide the native Pin toggle
// (it pins to the hidden native chat → looks broken), inject our own X
// button that just hides the callout. Idempotent + survives re-mounts via
// dataset guard. Also hooks the Share button so we can guarantee a local
// celebration line even if Twitch suppresses the self-echo USERNOTICE.
//
// Share-dedupe contract (bulletproof against duplicates):
//   Phase 1 [0–2000ms after click]: wait for Twitch's real USERNOTICE.
//     - If it arrives matching channel+user+msg-id → cancel synthetic.
//   Phase 2 [+0–30s after synthetic injection]: keep watching.
//     - If real arrives late → hide synthetic from buffer + remove its
//       DOM row → real takes its place. Single celebration always.
let _hsCalloutCloseObs = null
let _pendingShareClaim = null
let _resubShareModeTimer = null
let _resubShareCtx = null
let _watchstreakShareModeTimer = null
let _watchstreakShareCtx = null
let _lastSurfacedShareBtn = null
let _lastSurfacedCallout = null
const CALLOUT_QUEUE_SEL = '[data-test-selector="chat-private-callout-queue__callout-container"]'

// Twitch's callout tokens are base64 of "<userId>:<channelId>:<count>:<kind>"
// (kind = "cumulative" for a sub anniversary). Decoding is the validation:
// nothing else on the page base64-decodes to that exact shape, so a match is
// the token by construction — no prop name to guess and nothing to re-learn
// when twitch renames its components.
const CALLOUT_TOKEN_SHAPE = /^(\d+):(\d+):(\d+):([a-z_]+)$/i
function decodeCalloutToken(raw) {
  if (typeof raw !== 'string' || raw.length < 16 || raw.length > 200) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null
  let plain
  try {
    plain = atob(raw)
  } catch {
    return null
  }
  const m = CALLOUT_TOKEN_SHAPE.exec(plain)
  if (!m) return null
  return { raw, userId: m[1], channelId: m[2], count: Number(m[3]), kind: m[4].toLowerCase() }
}

// Once-per-day rate-limit on the watch-streak share UI. Twitch sometimes
// re-shows the callout if you reload the tab mid-stream; cap our surfacing
// at one per channel per local-day so it never feels spammy.
function _watchstreakDayKey(channel) {
  const d = new Date()
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `hs-watchstreak-shared:${channel}:${ymd}`
}
function _watchstreakAlreadySharedToday(channel) {
  try {
    return !!localStorage.getItem(_watchstreakDayKey(channel))
  } catch (_) {
    return false
  }
}
function _markWatchstreakSharedToday(channel) {
  try {
    localStorage.setItem(_watchstreakDayKey(channel), '1')
  } catch (_) {}
}
function _injectShareSynthetic(claim, user, months, customText) {
  const synthId = `hs-synth-share-${claim.channel}-${months}-${Date.now()}`
  claim.synthId = synthId
  claim.customText = customText || ''
  const synth = {
    type: 'usernotice',
    msgId: 'resub',
    user,
    text: customText || '',
    systemMsg: `${user} is celebrating ${months} months as a subscriber!`,
    color: '#fff',
    badges: ownBadgesFor(claim.channel) || '',
    channel: claim.channel,
    time: Date.now(),
    subTier: '1',
    subMonths: months,
    giftCount: 0,
    recipient: '',
    raidViewers: 0,
    raidFrom: '',
    announceColor: '',
    bitsTier: 0,
    id: synthId,
    isSynthetic: true,
    userOverride: !!customText,
  }
  try {
    irc?._handleMsg?.(synth)
  } catch (_) {}
  claim.postTimer = cleanup.setTimeout(() => {
    if (_pendingShareClaim === claim) _pendingShareClaim = null
  }, 30000)
}
function _enterResubShareMode(claim, user, months) {
  // Mutually exclusive with watchstreak-share — exit that first if active,
  // silently (keep its banner up so user can come back to it).
  if (_watchstreakShareCtx) _exitWatchstreakShareMode(_watchstreakShareCtx.claim, false, true)
  _resubShareCtx = { claim, user, months }
  const input = document.getElementById('hs-mc-input')
  const inputBar = document.getElementById('hs-mc-inputbar')
  if (!input) return
  inputBar?.classList.add('hs-mc-resub-share')
  input.classList.add('hs-mc-resub-share')
  if (input.dataset.hsOrigPlaceholder === undefined) {
    input.dataset.hsOrigPlaceholder = input.getAttribute('placeholder') || ''
  }
  if (input.dataset.hsOrigDataPlaceholder === undefined) {
    input.dataset.hsOrigDataPlaceholder = input.getAttribute('data-placeholder') || ''
  }
  const placeholder = `resub message (${months}mo) — enter to share`
  input.setAttribute('placeholder', placeholder)
  input.setAttribute('data-placeholder', placeholder)
  try {
    input.focus()
  } catch (_) {}
  if (_resubShareModeTimer) cleanup.clearTimeout(_resubShareModeTimer)
  _resubShareModeTimer = cleanup.setTimeout(() => _exitResubShareMode(claim, true), 30000)
}
function _exitResubShareMode(claim, fireFallback, silent) {
  if (claim && _resubShareCtx?.claim !== claim) return
  const wasCtx = _resubShareCtx
  _resubShareCtx = null
  if (_resubShareModeTimer) {
    cleanup.clearTimeout(_resubShareModeTimer)
    _resubShareModeTimer = null
  }
  // Dismiss the HsNotifs banner only on VOLUNTARY exit (consume, timeout,
  // dismiss-click). On a forced exit (another share-mode took the input),
  // silent=true keeps the banner visible so the user can come back to it.
  if (wasCtx && !silent) {
    try {
      window.HsNotifs?.dismissByKey?.('twitch-resub-share', `resub:${wasCtx.claim.channel}:${wasCtx.months}`)
    } catch (_) {}
  }
  const input = document.getElementById('hs-mc-input')
  const inputBar = document.getElementById('hs-mc-inputbar')
  inputBar?.classList.remove('hs-mc-resub-share')
  input?.classList.remove('hs-mc-resub-share')
  if (input?.dataset.hsOrigPlaceholder !== undefined) {
    input.setAttribute('placeholder', input.dataset.hsOrigPlaceholder)
    delete input.dataset.hsOrigPlaceholder
  }
  if (input?.dataset.hsOrigDataPlaceholder !== undefined) {
    if (input.dataset.hsOrigDataPlaceholder) {
      input.setAttribute('data-placeholder', input.dataset.hsOrigDataPlaceholder)
    } else {
      input.removeAttribute('data-placeholder')
    }
    delete input.dataset.hsOrigDataPlaceholder
  }
  // 30s timeout with no user text → fall back to the empty-body synthetic so
  // the celebration banner still shows locally.
  if (fireFallback && wasCtx && !wasCtx.claim.synthId) {
    _injectShareSynthetic(wasCtx.claim, wasCtx.user, wasCtx.months, '')
  }
}
// Celebration failed AFTER the text was consumed — never let the user's
// message vanish: surface the failure and send the text as plain chat.
async function _resubShareTextRescue(channel, text) {
  showToast(t('mc_main_celebration_share_failed'), 'error')
  if (!text) return
  try {
    const token = getTwitchAuthToken()
    if (token) {
      const res = await sendIrcMessage(channel, text, token)
      if (res === true || res === 'queued') return
    }
  } catch (_) {}
  showToast(t('mc_main_message_not_sent'), 'error')
}

// Programmatic-click escape hatch so consume() can fire the native Twitch
// Share button without our own surface() hook re-entering share-mode.
let _allowNativeShare = false
// Exposed for input.js sendMessage: consume typed text as resub-share body.
// .enter() is called directly by the HsNotifs Share button — bypasses the
// native Twitch click which would insta-send a default celebration message.
// Resub/watchstreak token scan. Module scope, NOT inside surface(): the notif
// click path re-runs it when the token it was emitted with is missing. The
// callout is emitted the moment it is detected, and the event payload lives in
// contextMenu.props.children.props.event — a subtree React may not have mounted
// yet. Measured on a live 107mo callout: the payload was absent from the notif
// but sitting at BFS step 46 minutes later, so the extension fell through to
// twitch's own button every time, which posts twitch's default celebration and
// drops the custom message. Re-scanning at click time is correct whether the
// cause was that race or a root that never reached the payload.
/**
 * Does this scan hold the token for the callout we think it does?
 *
 * The count is months for a sub anniversary and streams for a watch streak,
 * which is why the scan reports a generic `count` — an `out.months` read as
 * `scan.count` is undefined, silently false, and disables the whole path.
 * That shipped once. Every gate goes through here now.
 */
function calloutTokenMatches(scan, expect) {
  if (!scan?.token) return false
  if (!expect) return true
  if (expect.kind !== undefined && scan.kind !== expect.kind) return false
  if (expect.count !== undefined && scan.count !== expect.count) return false
  return true
}

function fiberTokenScan(rootEl) {
  if (typeof getFiber !== 'function' || !rootEl) return null
  const out = { token: null, channelId: null, count: 0, kind: null }
  const root = getFiber(rootEl)
  if (!root) return out
  // Breadth-first over the callout's own subtree. Twitch carries the token as
  // the React *key* of the element it renders the callout from — measured
  // live on a 107-month callout, two fibers below the queue container. It is
  // not a prop under any name, which is why every earlier scan came back
  // empty and the whole share flow fell through to twitch's own button. That
  // button hands the celebration to twitch's composer, which heatsync has
  // replaced, so the share never completed and the callout came back on the
  // next reload.
  // Children + siblings only: from the container there is nothing above worth
  // walking, and climbing turns a two-step lookup into a walk of the whole
  // chat tree.
  //
  // The ROOT's siblings are the exception — they are the other callouts in
  // the queue (a sub anniversary and a watch streak mount side by side), each
  // carrying its own token. Following them would hand back a neighbour's
  // token, which the caller cannot tell apart from its own.
  const queue = [root]
  const seen = new WeakSet()
  let steps = 0
  while (queue.length && steps < 400 && !out.token) {
    const f = queue.shift()
    if (!f || seen.has(f)) continue
    seen.add(f)
    steps++
    const tok = decodeCalloutToken(f.key)
    if (tok) {
      out.token = tok.raw
      out.channelId = tok.channelId
      out.count = tok.count
      out.kind = tok.kind
      break
    }
    if (f.child) queue.push(f.child)
    if (f !== root && f.sibling) queue.push(f.sibling)
  }
  return out
}

/**
 * Hand a callout token back to twitch with the user's own words as the
 * celebration body. This is the whole point of taking the click: twitch's own
 * Share button only puts twitch's composer into share-mode, and heatsync has
 * replaced that composer, so the native path can never finish the job.
 *
 * One mutation serves every callout kind — the resolver is
 * `useChatNotificationToken`, and the token says which callout is being
 * consumed. Throws on rejection so both callers can rescue the typed text
 * into plain chat; a rejected token comes back HTTP 200 with an errors[]
 * entry and a null field, so "no exception" is not "it worked".
 */
async function _consumeCalloutToken(channel, token, text) {
  const data = await gqlProxy('Chat_ShareResub_UseResubToken', {
    input: { message: text || '', channelLogin: channel, includeStreak: false, tokenID: token },
  })
  const errs =
    (Array.isArray(data?.errors) && data.errors.length ? data.errors : null) ||
    (data?.data && data.data.useChatNotificationToken === null ? [{ message: 'token rejected' }] : null)
  if (errs) throw new Error(JSON.stringify(errs).slice(0, 200))
}

window.__hsResubShare = {
  active: () => !!_resubShareCtx,
  // Returns false so input.js sendMessage CONTINUES into the regular IRC
  // send path — the typed text needs to actually go to Twitch chat so other
  // viewers see it and it persists across refresh. We also inject a local
  // synthetic usernotice for instant visual feedback, AND fire the native
  // Twitch share button for the global celebration broadcast.
  consume: (text) => {
    if (!_resubShareCtx) return false
    const { claim, user, months } = _resubShareCtx
    // 1. Local synthetic — instant styled celebration in OUR view with the
    //    user's custom text. Doesn't go anywhere else; viewer-only.
    try {
      _injectShareSynthetic(claim, user, months, text || '')
    } catch (_) {}
    // 2. GQL broadcast — call Chat_ShareResub_UseResubToken directly with the
    //    typed body. Sidesteps Twitch's hidden composer UI entirely; reaches
    //    the same backend mutation their native "Send" button fires after the
    //    composer opens. The token is the resub claim Twitch hands us in the
    //    callout's React props (or reconstructed from <userId>:<channelId>:
    //    <months>:cumulative when the prop wasn't found).
    const nativeClickFallback = () => {
      // No token — last-resort: programmatic-click the hidden native button.
      // Fires Twitch's default empty-body celebration; the typed text still
      // goes out as a plain follow-up message via the IRC send path below.
      const liveBtn = document.querySelector(
        `${CALLOUT_QUEUE_SEL} [data-a-target="chat-private-callout__primary-button"]`,
      )
      const btn = liveBtn || claim._nativeShareBtn
      if (!btn || typeof getFiber !== 'function') return false
      try {
        let f = getFiber(btn)
        for (let i = 0; f && i < 10; i++, f = f.return) {
          const oc = f?.memoizedProps?.onClick
          if (typeof oc === 'function') {
            oc({
              preventDefault() {},
              stopPropagation() {},
              persist() {},
              currentTarget: btn,
              target: btn,
              nativeEvent: { isTrusted: true },
              type: 'click',
              button: 0,
              buttons: 0,
            })
            return true
          }
        }
      } catch (_) {}
      return false
    }
    // No token → the native click can only post Twitch's DEFAULT
    // celebration (no body). Return false so sendMessage continues and
    // the typed text still lands as a normal chat message — celebration
    // + message, nothing swallowed. (This was the documented contract;
    // an unconditional `return true` here used to eat the text.)
    if (!claim.resubToken) {
      console.warn('[heatsync-ext] resub-share: no token — native btn fallback')
      _exitResubShareMode(claim, false)
      let clicked = false
      try {
        clicked = nativeClickFallback()
      } catch (_) {}
      showToast(clicked ? t('mc_main_no_share_token') : t('mc_main_share_unavailable'), 'error')
      return false
    }

    // Token path: instant exit, GQL in the background. Any failure rescues
    // the typed text into plain chat — the user's words must never silently
    // vanish. The optimistic synthetic is NOT re-injected here: step 1 above
    // already ran unconditionally, and _injectShareSynthetic stamps a fresh
    // Date.now() id and pushes a new row every call, so doing it twice put
    // two identical celebrations in the sharer's own view.
    _exitResubShareMode(claim, false)
    ;(async () => {
      try {
        await _consumeCalloutToken(claim.channel, claim.resubToken, text)
        log('resub-share: GQL fired ok')
      } catch (e) {
        console.warn('[heatsync-ext] resub-share GQL failed:', e?.message || e)
        await _resubShareTextRescue(claim.channel, text)
      }
    })()
    // true = sendMessage stops here; the typed text is the celebration
    // body (or gets rescued above on failure).
    return true
  },
  enter: (months, user, channel, resubToken) => {
    try {
      if (_pendingShareClaim) {
        cleanup.clearTimeout(_pendingShareClaim.postTimer)
      }
      const claim = {
        channel,
        userLc: (user || '').toLowerCase(),
        months,
        synthId: null,
        postTimer: null,
        customText: '',
        _nativeShareBtn: _lastSurfacedShareBtn,
        resubToken: resubToken || null,
      }
      _pendingShareClaim = claim
      _enterResubShareMode(claim, user, months)
    } catch (_) {}
  },
  /**
   * Re-scan for the resub token at CLICK time. The notif carries whatever the
   * scan found when the callout was first detected, and that can be nothing —
   * the payload lives in a React subtree that may not be mounted yet. By the
   * time a human clicks share, it always is. Returns the base64 tokenID
   * (<userId>:<channelId>:<months>:cumulative) or null.
   */
  rescanToken: (rootEl, expect) => {
    try {
      // Scan the callout we were HANDED. Reaching for
      // querySelector(CALLOUT_QUEUE_SEL) takes the first container in the
      // DOM, which is a different callout whenever a sub anniversary and a
      // watch streak are queued together — the same cross-callout mixup the
      // scan itself refuses to make by not following the root's siblings.
      if (rootEl?.isConnected) {
        const scan = fiberTokenScan(rootEl)
        if (calloutTokenMatches(scan, expect)) return scan.token
        return null
      }
      // Detached: twitch re-rendered the queue under us and a detached fiber
      // still hands back its stale key. Re-find the live callout by asking
      // each one whether it is ours — that is what `expect` is for.
      for (const el of document.querySelectorAll(CALLOUT_QUEUE_SEL)) {
        const scan = fiberTokenScan(el)
        if (calloutTokenMatches(scan, expect)) return scan.token
      }
      return null
    } catch (_) {
      return null
    }
  },
  // Internal: surface()'s native-button hook reads this to know whether to
  // block the click (user-initiated) or pass through (programmatic from us).
  _allowNativeShare: () => _allowNativeShare,
  /**
   * Fire twitch's own share button, with our interceptor standing down for
   * the duration. Used when we have no genuine resub token: twitch's flow is
   * then the only one that can actually consume it, so ours gets out of the
   * way rather than half-completing. Mirrors tryDomClick's sequence — a bare
   * .click() alone does not always satisfy their handler.
   */
  clickNative: (btn) => {
    if (!btn) return false
    try {
      _allowNativeShare = true
      try {
        const opts = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 }
        btn.dispatchEvent(new MouseEvent('mousedown', opts))
        btn.dispatchEvent(new MouseEvent('mouseup', opts))
        btn.dispatchEvent(new MouseEvent('click', opts))
        btn.click()
      } finally {
        _allowNativeShare = false
      }
      return true
    } catch (_) {
      return false
    }
  },
}

// ── Watch-streak share: mirror of resub-share for Twitch's daily ───────
// "you're on an N stream watch streak!" callout. Same dedupe contract,
// same native-button forwarding, separate placeholder/mode CSS so the
// user can tell which celebration they're composing. Once-per-day per
// channel via localStorage.
function _injectWatchstreakSynthetic(claim, user, streakCount, customText) {
  const synthId = `hs-synth-wstreak-${claim.channel}-${streakCount}-${Date.now()}`
  claim.synthId = synthId
  claim.customText = customText || ''
  const synth = {
    type: 'usernotice',
    msgId: 'watchstreak',
    user,
    text: customText || '',
    systemMsg: `${user} watched ${streakCount} streams in a row — watch streak`,
    color: '#fff',
    badges: ownBadgesFor(claim.channel) || '',
    channel: claim.channel,
    time: Date.now(),
    subTier: '',
    subMonths: 0,
    giftCount: 0,
    recipient: '',
    raidViewers: 0,
    raidFrom: '',
    announceColor: '',
    bitsTier: 0,
    streakCount,
    id: synthId,
    isSynthetic: true,
    userOverride: !!customText,
  }
  try {
    irc?._handleMsg?.(synth)
  } catch (_) {}
  claim.postTimer = cleanup.setTimeout(() => {
    if (_pendingShareClaim === claim) _pendingShareClaim = null
  }, 30000)
}
function _enterWatchstreakShareMode(claim, user, streakCount) {
  // Mutually exclusive with resub-share — exit that first if active, silently
  // (keep its banner up so user can come back to it).
  if (_resubShareCtx) _exitResubShareMode(_resubShareCtx.claim, false, true)
  _watchstreakShareCtx = { claim, user, streakCount }
  const input = document.getElementById('hs-mc-input')
  const inputBar = document.getElementById('hs-mc-inputbar')
  if (!input) return
  inputBar?.classList.add('hs-mc-watchstreak-share')
  input.classList.add('hs-mc-watchstreak-share')
  if (input.dataset.hsOrigPlaceholder === undefined) {
    input.dataset.hsOrigPlaceholder = input.getAttribute('placeholder') || ''
  }
  if (input.dataset.hsOrigDataPlaceholder === undefined) {
    input.dataset.hsOrigDataPlaceholder = input.getAttribute('data-placeholder') || ''
  }
  const placeholder = `watch streak (${streakCount}) — enter to share`
  input.setAttribute('placeholder', placeholder)
  input.setAttribute('data-placeholder', placeholder)
  try {
    input.focus()
  } catch (_) {}
  if (_watchstreakShareModeTimer) cleanup.clearTimeout(_watchstreakShareModeTimer)
  _watchstreakShareModeTimer = cleanup.setTimeout(() => _exitWatchstreakShareMode(claim, true), 30000)
}
function _exitWatchstreakShareMode(claim, fireFallback, silent) {
  if (claim && _watchstreakShareCtx?.claim !== claim) return
  const wasCtx = _watchstreakShareCtx
  _watchstreakShareCtx = null
  if (_watchstreakShareModeTimer) {
    cleanup.clearTimeout(_watchstreakShareModeTimer)
    _watchstreakShareModeTimer = null
  }
  if (wasCtx && !silent) {
    try {
      window.HsNotifs?.dismissByKey?.(
        'twitch-watchstreak-share',
        `watchstreak:${wasCtx.claim.channel}:${wasCtx.streakCount}`,
      )
    } catch (_) {}
  }
  const input = document.getElementById('hs-mc-input')
  const inputBar = document.getElementById('hs-mc-inputbar')
  inputBar?.classList.remove('hs-mc-watchstreak-share')
  input?.classList.remove('hs-mc-watchstreak-share')
  if (input?.dataset.hsOrigPlaceholder !== undefined) {
    input.setAttribute('placeholder', input.dataset.hsOrigPlaceholder)
    delete input.dataset.hsOrigPlaceholder
  }
  if (input?.dataset.hsOrigDataPlaceholder !== undefined) {
    if (input.dataset.hsOrigDataPlaceholder) {
      input.setAttribute('data-placeholder', input.dataset.hsOrigDataPlaceholder)
    } else {
      input.removeAttribute('data-placeholder')
    }
    delete input.dataset.hsOrigDataPlaceholder
  }
  if (fireFallback && wasCtx && !wasCtx.claim.synthId) {
    _injectWatchstreakSynthetic(wasCtx.claim, wasCtx.user, wasCtx.streakCount, '')
  }
}
window.__hsWatchstreakShare = {
  active: () => !!_watchstreakShareCtx,
  consume: (text) => {
    if (!_watchstreakShareCtx) return false
    const { claim, user, streakCount } = _watchstreakShareCtx
    try {
      _injectWatchstreakSynthetic(claim, user, streakCount, text || '')
    } catch (_) {}
    const broadcastShare = () => {
      const liveBtn = document.querySelector(
        `${CALLOUT_QUEUE_SEL} [data-a-target="chat-private-callout__primary-button"]`,
      )
      const candidates = [liveBtn, claim._nativeShareBtn].filter(Boolean)
      const seen = new Set()
      const tryFiberOnClick = (btn) => {
        try {
          if (typeof getFiber !== 'function') return false
          let f = getFiber(btn)
          for (let i = 0; f && i < 10; i++, f = f.return) {
            const oc = f?.memoizedProps?.onClick
            if (typeof oc === 'function') {
              const fakeEvt = {
                preventDefault() {},
                stopPropagation() {},
                persist() {},
                currentTarget: btn,
                target: btn,
                nativeEvent: { isTrusted: true },
                type: 'click',
                button: 0,
                buttons: 0,
              }
              oc(fakeEvt)
              log('watchstreak-share: fired via fiber onClick')
              return true
            }
          }
        } catch (e) {
          console.warn('[heatsync-ext] watchstreak-share fiber onClick threw:', e)
        }
        return false
      }
      const tryDomClick = (btn) => {
        try {
          _allowNativeShare = true
          try {
            const opts = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 }
            btn.dispatchEvent(new MouseEvent('mousedown', opts))
            btn.dispatchEvent(new MouseEvent('mouseup', opts))
            btn.dispatchEvent(new MouseEvent('click', opts))
            btn.click()
          } finally {
            _allowNativeShare = false
          }
          log('watchstreak-share: fired via DOM click sequence')
          return true
        } catch (e) {
          console.warn('[heatsync-ext] watchstreak-share DOM click threw:', e)
          return false
        }
      }
      for (const btn of candidates) {
        if (!btn || seen.has(btn)) continue
        seen.add(btn)
        if (tryFiberOnClick(btn)) return true
      }
      for (const btn of candidates) {
        if (!btn) continue
        if (tryDomClick(btn)) return true
      }
      console.warn('[heatsync-ext] watchstreak-share: NO broadcast — native callout btn missing')
      return false
    }
    // With a token we can finish the share ourselves, body and all — same
    // path the sub anniversary takes. Without one, fall back to clicking
    // twitch's button and letting the typed text go out as ordinary chat,
    // which is all this flow could ever do before.
    if (claim.streakToken) {
      _exitWatchstreakShareMode(claim, false)
      ;(async () => {
        try {
          await _consumeCalloutToken(claim.channel, claim.streakToken, text)
          // Marked only once it landed. A failed share leaves the day
          // unspent so a reload can offer it again — twitch never consumed
          // the token, so the callout is still there to offer.
          _markWatchstreakSharedToday(claim.channel)
          log('watchstreak-share: GQL fired ok')
        } catch (e) {
          console.warn('[heatsync-ext] watchstreak-share GQL failed:', e?.message || e)
          await _resubShareTextRescue(claim.channel, text)
        }
      })()
      // true = the typed text IS the celebration body, so sendMessage stops
      // here rather than posting it a second time as a plain message.
      return true
    }
    try {
      broadcastShare()
    } catch (e) {
      console.warn('[heatsync-ext] watchstreak-share broadcast outer threw:', e)
    }
    _markWatchstreakSharedToday(claim.channel)
    _exitWatchstreakShareMode(claim, false)
    return false
  },
  enter: (streakCount, user, channel, streakToken) => {
    try {
      if (_pendingShareClaim) {
        cleanup.clearTimeout(_pendingShareClaim.postTimer)
      }
      const claim = {
        kind: 'watchstreak',
        channel,
        userLc: (user || '').toLowerCase(),
        streakCount,
        synthId: null,
        postTimer: null,
        customText: '',
        _nativeShareBtn: _lastSurfacedShareBtn,
        streakToken: streakToken || null,
      }
      _pendingShareClaim = claim
      _enterWatchstreakShareMode(claim, user, streakCount)
    } catch (_) {}
  },
}

function setupHsCalloutCloseButton() {
  if (_hsCalloutCloseObs) return
  // Native callout is hidden by CSS (.hs-notif-twitch-resub-share rule).
  // We extract data from the native DOM, hook its Share button so the
  // existing _enterResubShareMode flow runs when user clicks our forwarded
  // Share, and emit our own HsNotifs notif to render the controlled UI.
  const surface = (calloutEl) => {
    if (!calloutEl || calloutEl.dataset.hsSurfaced === '1') return
    const txt = calloutEl.textContent || ''
    const ch = (getLiveChannel?.() || getCurrentChannel?.() || '').toLowerCase()
    const user = currentUsername || ''
    if (!ch || !user) return
    const shareBtn = calloutEl.querySelector('[data-a-target="chat-private-callout__primary-button"]')

    // Capture twitch's callout token from the callout subtree. It is what
    // Chat_ShareResub_UseResubToken takes as input.tokenID, and it decodes to
    // "<userId>:<channelId>:<count>:<kind>". Scan the container, never the
    // button: the token sits two fibers under the container, while from the
    // button the same breadth-first walk fans out across the chat tree
    // without ever reaching it.
    const scan = fiberTokenScan(calloutEl) || {}

    // Watch-streak first (text mentions "watch streak"); resub fallback (only
    // "N month" — without "watch streak"). Order matters: a watch-streak
    // callout never mentions months, but a sub-anniversary may incidentally
    // contain "stream", so explicit watchstreak check wins.
    const isWatchstreak = /watch[\s-]*streak/i.test(txt)
    const streakMatch = isWatchstreak ? txt.match(/(\d+)\s*stream/i) : null
    const streakCount = streakMatch ? parseInt(streakMatch[1], 10) : 0
    const monthMatch = !isWatchstreak ? txt.match(/(\d+)\s*month/i) : null
    const months = monthMatch ? parseInt(monthMatch[1], 10) : 0

    if (isWatchstreak && streakCount) {
      if (_watchstreakAlreadySharedToday(ch)) {
        calloutEl.dataset.hsSurfaced = '1'
        return
      }
      calloutEl.dataset.hsSurfaced = '1'
      // A watch-streak token counts streams where a resub token counts
      // months; the kind string differs and we never assume it. If the count
      // does not match the callout, we hold no token and the flow stays on
      // twitch's own button exactly as before.
      const streakToken = calloutTokenMatches(scan, { count: streakCount }) ? scan.token : null
      if (shareBtn && shareBtn.dataset.hsShareHooked !== '1') {
        shareBtn.dataset.hsShareHooked = '1'
        shareBtn.addEventListener(
          'click',
          (e) => {
            if (_allowNativeShare) return
            e.stopImmediatePropagation()
            e.preventDefault()
            try {
              if (_pendingShareClaim) {
                cleanup.clearTimeout(_pendingShareClaim.postTimer)
              }
              const claim = {
                kind: 'watchstreak',
                channel: ch,
                userLc: user.toLowerCase(),
                streakCount,
                synthId: null,
                postTimer: null,
                customText: '',
                _nativeShareBtn: shareBtn,
                streakToken,
              }
              _pendingShareClaim = claim
              _enterWatchstreakShareMode(claim, user, streakCount)
            } catch (_) {}
          },
          { capture: true },
        )
      }
      _lastSurfacedShareBtn = shareBtn || null
      _lastSurfacedCallout = calloutEl
      try {
        HsNotifs.emit('twitch-watchstreak-share', {
          streakCount,
          user,
          channel: ch,
          _nativeShareBtn: shareBtn,
          _nativeCallout: calloutEl,
          _streakToken: streakToken,
        })
      } catch (_) {}
      try {
        _updateMcLayout?.()
      } catch (_) {}
      return
    }

    if (!months) return
    calloutEl.dataset.hsSurfaced = '1'
    // Only take the click when the token we hold is genuinely this callout's:
    // the months it encodes must match the months the callout announces. A
    // token is never guessed or reconstructed — a wrong one fails the
    // mutation, and the failure path posts the typed text as ordinary chat,
    // which reads as success while twitch never marks the resub shared, so
    // the callout returns on every reload. Without a token we do not
    // intervene at all; a silent half-success is worse than not helping.
    const resubToken = calloutTokenMatches(scan, { kind: 'cumulative', count: months }) ? scan.token : null
    const hasRealToken = !!resubToken
    if (hasRealToken && shareBtn && shareBtn.dataset.hsShareHooked !== '1') {
      shareBtn.dataset.hsShareHooked = '1'
      shareBtn.addEventListener(
        'click',
        (e) => {
          if (window.__hsResubShare?._allowNativeShare?.()) return
          e.stopImmediatePropagation()
          e.preventDefault()
          try {
            if (_pendingShareClaim) {
              cleanup.clearTimeout(_pendingShareClaim.postTimer)
            }
            const claim = {
              kind: 'resub',
              channel: ch,
              userLc: user.toLowerCase(),
              months,
              synthId: null,
              postTimer: null,
              customText: '',
              _nativeShareBtn: shareBtn,
              resubToken,
            }
            _pendingShareClaim = claim
            _enterResubShareMode(claim, user, months)
          } catch (_) {}
        },
        { capture: true },
      )
    }
    _lastSurfacedShareBtn = shareBtn || null
    _lastSurfacedCallout = calloutEl
    try {
      HsNotifs.emit('twitch-resub-share', {
        months,
        user,
        channel: ch,
        _nativeShareBtn: shareBtn,
        _nativeCallout: calloutEl,
        // Only ever a token twitch handed us. Downstream reads its absence
        // as "we cannot finish this" and routes the click to twitch's own
        // button instead of half-completing.
        _resubToken: resubToken,
      })
    } catch (_) {}
    try {
      _updateMcLayout?.()
    } catch (_) {}
  }
  // Twitch removed `.pinned-callout` in a recent refactor — the callout body
  // now lives directly under the queue container. Surface every container;
  // surface() reads text + Share button via descendant selectors and self-
  // gates with dataset.hsSurfaced='1'. Multiple callouts (e.g. resub +
  // watch-streak) can fire as siblings inside the queue parent — we must
  // observe each on first touch and the parent of any we see so subsequent
  // siblings are caught.
  document.querySelectorAll(CALLOUT_QUEUE_SEL).forEach((c) => {
    if (c.querySelector('*')) surface(c)
  })
  let _narrowedTo = null
  const _narrowIfPossible = (calloutEl) => {
    const parent = calloutEl?.parentElement
    if (!parent || _narrowedTo === parent) return
    _narrowedTo = parent
    try {
      _hsCalloutCloseObs.disconnect()
    } catch (_) {}
    // Observe the queue PARENT (not the callout itself) — sibling callouts
    // added later land as direct children and fire childList mutations here.
    _hsCalloutCloseObs.observe(parent, { childList: true, subtree: true })
  }
  _hsCalloutCloseObs = new MutationObserver((muts) => {
    // While un-narrowed this observes document.body — our own overlay appends
    // (every chat row) land here too. Callouts are twitch DOM and can never
    // appear inside the overlay, so batches entirely within it are noise.
    const _ov = document.getElementById('hs-mc-overlay')
    if (_ov) {
      let outside = false
      for (const m of muts) {
        if (!_ov.contains(m.target)) {
          outside = true
          break
        }
      }
      if (!outside) return
    }
    // Callouts touched by this batch: a container inserted empty gets its
    // children as later mutations whose target IS the container (or a
    // descendant) — closest() catches those without the document-wide
    // querySelectorAll this used to run on every twitch react tick.
    // New containers arriving are covered by the addedNodes walk below,
    // pre-existing ones by the initial scan; surface() self-gates via
    // dataset.hsSurfaced so overlap is idempotent.
    for (const m of muts) {
      const c = m.target instanceof Element ? m.target.closest(CALLOUT_QUEUE_SEL) : null
      if (c && c.querySelector('*')) surface(c)
    }
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue
        if (node.matches?.(CALLOUT_QUEUE_SEL)) {
          if (node.querySelector('*')) surface(node)
          _narrowIfPossible(node)
        } else if (node.querySelector) {
          node.querySelectorAll(CALLOUT_QUEUE_SEL).forEach((c) => {
            if (c.querySelector('*')) surface(c)
            _narrowIfPossible(c)
          })
        }
      }
    }
  })
  const initialCallouts = document.querySelectorAll(CALLOUT_QUEUE_SEL)
  if (initialCallouts.length > 0) {
    _narrowIfPossible(initialCallouts[0])
  } else {
    // No callout exists yet to narrow onto — #root (Twitch's app root) is
    // the nearest stable ancestor that's already mounted at this point,
    // and narrower than body (never fires on <head> mutations).
    _hsCalloutCloseObs.observe(document.getElementById('root') || document.body, { childList: true, subtree: true })
  }
  cleanup.trackObserver(_hsCalloutCloseObs)
}

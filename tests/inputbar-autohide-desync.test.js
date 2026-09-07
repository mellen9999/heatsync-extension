/**
 * Composer visibility policy: which tabs may have a composer at all
 * (tabAcceptsInput / tabSendsToChat), and the show/hide bookkeeping around it
 * (src/multichat/main.js).
 *
 * Regression anchor: "I'm on no tab and can type and get the input box to show
 * up but messages don't send." Every surface kept its OWN list of tabs that
 * may have a composer — switchTab, the type-to-reveal handler, the paste
 * handler, the profile-card and chat-log restores — and they disagreed. A tab
 * missing from one list (modlog was missing from three) got a composer that
 * resolved its send target to the TAB ID and posted into the void. One
 * predicate answers it now, and sendMessage refuses out loud if anything
 * still slips through.
 *
 * Regression anchor: "why is the input box not auto-hiding" — an empty
 * composer bar stranded on screen with auto-hide switched on.
 *
 * inputBarVisible is a CACHE of the hs-hidden class, and several paths write
 * the class directly: the log + profile-card views, the autoHide toggle, and
 * the container rebuild that mints a brand-new bar (twitch swaps the chat
 * container on navigation). A rebuild that happened while the flag was false —
 * i.e. right after an auto-hide — produced a fresh bar with NO hs-hidden class
 * and a flag still reading false, and that combination is terminal:
 * hideInputBar() bailed on `if (!inputBarVisible) return` every time, so the
 * empty bar stayed up until something typed into it. The mirror-image drift
 * (flag true, class present) killed the type-to-reveal handler instead.
 *
 * Both directions are now resolved from the DOM before any decision.
 *
 * Carved out of the non-module content-script bundle (same rationale as
 * tab-complete-stale.test.js).
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
const start = SRC.indexOf('  function syncInputBarVisible(')
const end = SRC.indexOf('  function createOverlay(')
if (start === -1 || end === -1 || end <= start) throw new Error('carve markers not found')
const CARVE = SRC.slice(start, end)

const predSrc = SRC.slice(SRC.indexOf('  function tabSendsToChat('), SRC.indexOf('  // The DOM class is the truth'))
const makePredicates = (liveChannel, channelIds) =>
  new Function('getLiveChannel', 'getChannelById', `${predSrc}; return { tabSendsToChat, tabAcceptsInput }`)(
    () => liveChannel,
    (id) => (channelIds.includes(id) ? { id } : undefined),
  )

// Minimal element stand-in: the class set is the only state these functions read.
const fakeEl = () => {
  const classes = new Set()
  return {
    classes,
    style: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
  }
}

let bar
let overlay
let now
let opts

function build({ autoHide = true, visibleFlag = true, hidden = false, keepUntil = 0, canInput = true } = {}) {
  bar = fakeEl()
  overlay = fakeEl()
  if (hidden) bar.classList.add('hs-hidden')
  now = 1000
  opts = { autoHide, canInput }
  const document = {
    getElementById: (id) => {
      if (id === 'hs-mc-inputbar') return bar
      if (id === 'hs-mc-overlay') return overlay
      if (id === 'hs-mc-input') return null // empty composer
      if (id === 'hs-mc-emote-picker') return null
      return null
    },
  }
  const timers = []
  const api = new Function(
    'document',
    'window',
    'performance',
    'cleanup',
    'autoHideEligible',
    'tabAcceptsInput',
    'currentTab',
    'adjustOverlayForPicker',
    '_updateMcLayout',
    'initialVisible',
    'initialKeepUntil',
    'timers',
    `let inputBarVisible = initialVisible
     let _keepComposerOpenUntil = initialKeepUntil
     let _composerStickyUntil = 0
     const replyState = null
     const quoteState = null
     ${CARVE}
     return {
       showInputBar,
       hideInputBar,
       syncInputBarVisible,
       get flag() { return inputBarVisible },
     }`,
  )(
    document,
    {},
    { now: () => now },
    { setTimeout: (fn, ms) => timers.push({ fn, at: now + ms }) },
    () => opts.autoHide,
    () => opts.canInput,
    'somechannel',
    () => {},
    () => {},
    visibleFlag,
    keepUntil,
    timers,
  )
  return { api, timers }
}

beforeEach(() => {
  now = 1000
})

describe('tabAcceptsInput', () => {
  const onChannelPage = makePredicates('xqc', ['nl_kripp'])
  const onDirectory = makePredicates(null, ['nl_kripp'])

  test('channel tabs and the live tab on a stream page can send', () => {
    expect(onChannelPage.tabAcceptsInput('nl_kripp')).toBe(true)
    expect(onChannelPage.tabAcceptsInput('live')).toBe(true)
    expect(onChannelPage.tabSendsToChat('live')).toBe(true)
  })

  test('the live tab off a stream page has no target', () => {
    expect(onDirectory.tabAcceptsInput('live')).toBe(false)
  })

  test('social tabs take input but are not chat destinations', () => {
    for (const id of ['feed', 'whispers', 'mentions']) {
      expect(onChannelPage.tabAcceptsInput(id)).toBe(true)
      expect(onChannelPage.tabSendsToChat(id)).toBe(false)
    }
  })

  test('view-only tabs and stale ids send nowhere', () => {
    // "modlog" used to resolve as the target CHANNEL NAME and post into the void
    for (const id of ['add', 'settings', 'discover', 'pinned', 'modlog', 'deleted_channel', '', null]) {
      expect(onChannelPage.tabAcceptsInput(id)).toBe(false)
    }
  })
})

describe('hideInputBar', () => {
  test('hides a visible bar whose cached flag went stale (the stranded-bar bug)', () => {
    // Rebuild left the bar on screen with the flag still reading "hidden".
    const { api } = build({ visibleFlag: false, hidden: false })
    api.hideInputBar()
    expect(bar.classList.contains('hs-hidden')).toBe(true)
    expect(api.flag).toBe(false)
  })

  test('is a no-op when the bar is genuinely hidden already', () => {
    const { api } = build({ visibleFlag: true, hidden: true })
    api.hideInputBar()
    expect(bar.classList.contains('hs-hidden')).toBe(true)
  })

  test('never touches the bar when auto-hide is off', () => {
    const { api } = build({ autoHide: false, visibleFlag: false, hidden: false })
    api.hideInputBar()
    expect(bar.classList.contains('hs-hidden')).toBe(false)
  })

  test('retries instead of swallowing the hide inside the rapid-fire window', () => {
    const { api, timers } = build({ keepUntil: 1500 })
    api.hideInputBar()
    expect(bar.classList.contains('hs-hidden')).toBe(false)
    expect(timers.length).toBe(1)
    now = 1600
    timers[0].fn()
    expect(bar.classList.contains('hs-hidden')).toBe(true)
  })
})

describe('showInputBar', () => {
  test('reveals a hidden bar whose cached flag went stale (no way to type)', () => {
    const { api } = build({ visibleFlag: true, hidden: true })
    api.showInputBar()
    expect(bar.classList.contains('hs-hidden')).toBe(false)
    expect(api.flag).toBe(true)
  })

  test('refuses to reveal on a tab that cannot send', () => {
    const { api } = build({ visibleFlag: false, hidden: true, canInput: false })
    api.showInputBar()
    expect(bar.classList.contains('hs-hidden')).toBe(true)
  })
})

/**
 * The send path must settle the composer itself — and for auto-hide users the
 * settle must be an INSTANT hide.
 *
 * Regression anchors:
 * - 2026-07-30 (vi mode): "the input bar is still not auto hiding when the
 *   input box is empty" — the send tail cleared input.value directly and never
 *   armed a hide, so the empty bar sat until an explicit Escape.
 * - 2026-08-02: routing the post-send hide through the sticky window deferred
 *   it ~1s behind the retry timer — a visible lag on every Enter. Auto-hide
 *   sends now zero the windows and hide synchronously; type-to-reveal covers
 *   the next keystroke, so rapid-fire survives.
 */
import { readFileSync as _readFileSync } from 'node:fs'
import { join as _join } from 'node:path'

describe('send path settles the composer', () => {
  const SRC = _readFileSync(_join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
  const sendStart = SRC.indexOf('async function sendMessage()')
  const sendTail = SRC.slice(sendStart, SRC.indexOf('--- Kick send path', sendStart))
  const settle = SRC.slice(
    SRC.indexOf('function settleComposerAfterSend('),
    SRC.indexOf('async function sendMessage()'),
  )

  test('sendMessage settles the composer after clearing it', () => {
    expect(sendStart).toBeGreaterThan(-1)
    const clearAt = sendTail.indexOf('pendingMessage = ')
    const settleAt = sendTail.indexOf('settleComposerAfterSend(input)')
    expect(clearAt).toBeGreaterThan(-1)
    expect(settleAt).toBeGreaterThan(clearAt)
  })

  test('auto-hide settle is instant: windows zeroed, hideInputBar synchronous', () => {
    // The old shape — arm sticky, queue the hide — parked the hide behind the
    // ~1s keep-open retry timer. The settle must zero both windows FIRST so
    // hideInputBar cannot defer, then hide with no setTimeout in between.
    expect(settle).toContain('_keepComposerOpenUntil = 0')
    expect(settle).toContain('_composerStickyUntil = 0')
    const zeroAt = settle.indexOf('_keepComposerOpenUntil = 0')
    const hideAt = settle.indexOf('hideInputBar()')
    expect(zeroAt).toBeGreaterThan(-1)
    expect(hideAt).toBeGreaterThan(zeroAt)
    expect(settle).not.toContain('setTimeout')
  })

  test('non-auto-hide (or guard-kept bar) still gets the sticky-focus window', () => {
    // When the bar stays visible — auto-hide off, picker open, unconfirmed
    // send left text in place — the cursor must not drop mid-rapid-fire.
    expect(settle).toContain('armComposerStickyFocus(input)')
    // The instant-hide branch returns only when the bar actually hid; a
    // guard-blocked hide falls through to sticky focus.
    expect(settle).toContain('if (!syncInputBarVisible()) return')
  })

  test('sendMessage no longer arms sticky focus directly (settle owns it)', () => {
    expect(sendTail).not.toContain('armComposerStickyFocus(input)')
  })

  test('clearInput still queues its own hide for every non-send path', () => {
    const ci = SRC.slice(SRC.indexOf('function clearInput('), SRC.indexOf('function matchSlashCommands('))
    expect(ci).toContain('setTimeout(() => hideInputBar(), 0)')
  })
})

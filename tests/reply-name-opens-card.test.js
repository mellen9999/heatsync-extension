/**
 * Every clickable name in the overlay chat — including the collapsed reply
 * pill's `@name` — must open the current profile card, on every platform,
 * bulletproof.
 *
 * Before this fix the reply-target name was carved out at three independent
 * chokepoints (pcard-early.js's early interceptor, profile-card.js's own
 * click + mousedown handlers) so it fell through to whatever the platform did
 * with a plain `<a target="_blank">`: the OLD `.hs-pc-panel` card on
 * twitch/kick (content.js still matched `.hs-mc-user` there), a new tab on
 * youtube (no native card to fall through to). Right-click had the same gap
 * one level deeper: the context menu's selector excluded the reply name too,
 * so a right-click on it silently menu'd the MESSAGE SENDER instead.
 *
 * Two more chokepoint gaps this pins:
 *  - pcard-early.js swallowed every name click unconditionally, so turning
 *    the `profile-cards` subsystem off did not restore native click behavior
 *    — it just made clicks do nothing.
 *  - openProfileCard() never dismissed the reply-thread stack overlay (fixed,
 *    max z-index, rendered above everything) — a card opened while a stack
 *    was showing would be invisible/unclickable behind it.
 *
 * pcard-early.js is small, dependency-free and self-contained (only touches
 * window/document/localStorage/CustomEvent) — it is executed here for real,
 * against a hand-built DOM (house pattern for leaf files with no
 * jsdom/happy-dom in this repo — see paint-fill-layers-mount.test.js and
 * paints.test.js). main.js, profile-card.js and input.js have top-level side
 * effects and cannot be imported, so those are pinned as source-text
 * invariants (house pattern — see reply-ctx-late-repair.test.js and
 * subsystem-chokepoints.test.js).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')

const PCARD_EARLY_SRC = read('chrome', 'pcard-early.js')
const MAIN = read('src', 'multichat', 'main.js')
const CARD = read('src', 'multichat', 'profile-card.js')
const INPUT = read('src', 'multichat', 'input.js')
const EMOTES = read('src', 'multichat', 'emotes.js')
const SOCIAL = read('src', 'multichat', 'social.js')
const CONTENT = read('chrome', 'content.js')

/** The first `n` chars of a function body, brace-matched from its signature. */
function body(src, signature, n = 1200) {
  const at = src.indexOf(signature)
  expect(at, `signature moved: ${signature}`).toBeGreaterThan(-1)
  return src.slice(at, at + n)
}

// ── pcard-early.js: real execution against a hand-built DOM ────────────────

function fakeEl({ classes = [], dataset = {}, closestMap = {}, textContent = '' } = {}) {
  const el = {
    classList: { contains: (c) => classes.includes(c) },
    dataset,
    textContent,
    closest(sel) {
      if (sel === '.hs-mc-user' && classes.includes('hs-mc-user')) return el
      return closestMap[sel] ?? null
    },
  }
  return el
}

function loadPcardEarly(storedGate) {
  const listeners = {}
  const dispatched = []
  const store = {}
  if (storedGate !== undefined) store['hs_gate_profile-cards'] = storedGate
  const fakeWindow = {}
  const fakeDocument = {
    addEventListener(type, fn) {
      if (!listeners[type]) listeners[type] = []
      listeners[type].push(fn)
    },
    dispatchEvent(evt) {
      dispatched.push(evt)
    },
  }
  const fakeLocalStorage = {
    getItem: (k) => (k in store ? store[k] : null),
  }
  class FakeCustomEvent {
    constructor(type, opts) {
      this.type = type
      this.detail = opts?.detail
    }
  }
  const runner = new Function('window', 'document', 'localStorage', 'CustomEvent', PCARD_EARLY_SRC)
  runner(fakeWindow, fakeDocument, fakeLocalStorage, FakeCustomEvent)
  const click = (e) =>
    listeners.click[0]({ preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...e })
  return { listeners, dispatched, click }
}

describe('pcard-early.js: reply-target name opens the card', () => {
  test('a reply-pill @name (hs-mc-reply-user) is no longer excluded', () => {
    expect(PCARD_EARLY_SRC).not.toContain("classList.contains('hs-mc-reply-user')")
  })

  test('clicking one dispatches hs-pcard-open with its username + platform', () => {
    const { dispatched, click } = loadPcardEarly()
    const userEl = fakeEl({
      classes: ['hs-mc-user', 'hs-mc-reply-user'],
      dataset: { username: 'someviewer', platform: 'kick' },
    })
    click({ button: 0, target: userEl })
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].type).toBe('hs-pcard-open')
    expect(dispatched[0].detail).toEqual({ username: 'someviewer', platform: 'kick' })
  })

  test('an ordinary sender name still opens too (no regression)', () => {
    const { dispatched, click } = loadPcardEarly()
    const userEl = fakeEl({ classes: ['hs-mc-user'], dataset: { username: 'streamer', platform: 'twitch' } })
    click({ button: 0, target: userEl })
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].detail.username).toBe('streamer')
  })
})

describe('pcard-early.js: the profile-cards gate is respected, not just checked elsewhere', () => {
  test('gate on (default / unset) still intercepts', () => {
    const { dispatched, click } = loadPcardEarly(undefined)
    click({ button: 0, target: fakeEl({ classes: ['hs-mc-user'], dataset: { username: 'x' } }) })
    expect(dispatched).toHaveLength(1)
  })

  test('gate explicitly off (mirrored "0") does not swallow the click', () => {
    const { dispatched, click } = loadPcardEarly('0')
    const called = { preventDefault: false }
    const userEl = fakeEl({ classes: ['hs-mc-user'], dataset: { username: 'x' } })
    click({
      button: 0,
      target: userEl,
      preventDefault() {
        called.preventDefault = true
      },
    })
    expect(dispatched).toHaveLength(0)
    expect(called.preventDefault).toBe(false)
  })

  test('main.js mirrors the gate to the exact key pcard-early.js reads', () => {
    expect(PCARD_EARLY_SRC).toContain("localStorage.getItem('hs_gate_profile-cards')")
    const snap = body(MAIN, 'function snapshotGates() {', 900)
    expect(snap).toContain("localStorage.setItem('hs_gate_profile-cards'")
  })
})

// ── profile-card.js: reply-user no longer excluded, stack gets dismissed ───

describe('profile-card.js click/mousedown handlers no longer carve out the reply name', () => {
  test('neither capture-phase handler excludes hs-mc-reply-user', () => {
    expect(CARD).not.toContain("classList.contains('hs-mc-reply-user')")
  })
})

describe('opening a card dismisses the fixed, max-z reply-thread stack', () => {
  test('openProfileCard dispatches the close-overlays bridge event', () => {
    const fn = body(CARD, 'async function openProfileCard(username, platform) {', 900)
    expect(fn).toContain("document.dispatchEvent(new CustomEvent('hs-mc-close-overlays'))")
    // Must come after both early-return gates, or a no-op open (gate off, no
    // username) would still visibly dismiss an open stack.
    expect(fn.indexOf("gateAtBoot('profile-cards')")).toBeLessThan(fn.indexOf('hs-mc-close-overlays'))
    expect(fn.indexOf('if (!username) return')).toBeLessThan(fn.indexOf('hs-mc-close-overlays'))
  })

  test('main.js listens for it and actually calls dismissStack', () => {
    const at = MAIN.indexOf("'hs-mc-close-overlays'")
    expect(at, 'listener missing').toBeGreaterThan(-1)
    const region = MAIN.slice(at, at + 200)
    expect(region).toContain('dismissStack()')
  })
})

// ── right-click menu works on the reply name too ────────────────────────────

describe('the unified context menu targets the name actually clicked', () => {
  test('the reply-target name is no longer excluded from the primary match', () => {
    // Before: `.hs-mc-user:not(.hs-mc-reply-user)` came up empty for a reply
    // name, falling through to `msg.querySelector('.hs-mc-user:not(.hs-mc-reply-user)')`
    // — the SENDER'S link — so right-clicking the reply target menu'd the
    // wrong person. The sender-scoped fallback (for right-clicking blank
    // message space) is correct and must stay excluded.
    const handler = body(INPUT, '// Universal right-click → user/post action menu.', 3200)
    expect(handler).toContain("const userEl = e.target.closest('.hs-mc-user')")
    expect(handler).not.toContain("const userEl = e.target.closest('.hs-mc-user:not(.hs-mc-reply-user)')")
    // fallback branches (sender-of-the-row) still scoped away from the reply link
    expect(handler).toContain("msg.querySelector('.hs-mc-user:not(.hs-mc-reply-user)')")
  })
})

// ── data-platform: a mention/name must never open the card platform-null ───

describe('every name-rendering site sets data-platform', () => {
  test('the reply pill carries the message platform (twitch-implicit default)', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal source text, not writing a real template string
    expect(MAIN).toContain('data-platform="${escapeHtml(m.platform || \'twitch\')}"${replyUidAttr}')
  })

  test('mentions inside processEmotes (predictions/outcomes) carry twitch', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal source text, not writing a real template string
    expect(EMOTES).toContain('data-username="${name}" data-platform="twitch"')
  })

  test('feed post authors carry the post platform', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal source text, not writing a real template string
    expect(SOCIAL).toContain('data-platform="${escapeHtml(m.platform || \'\')}"')
  })

  test('the inline feed-quote username anchor carries a platform', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal source text, not writing a real template string
    expect(MAIN).toContain('data-platform="twitch"${uidAttr}${splitAttr}')
  })

  test('the primary @mention highlighter still carries its resolved platform', () => {
    // Pre-existing — pinned so a future refactor of highlightMentionsInHtml
    // cannot silently drop it the way the other four sites had.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal source text, not writing a real template string
    expect(MAIN).toContain('data-platform="${escapeHtml(platform)}"${uidAttr}${splitAttr}')
  })
})

// ── the old .hs-pc-panel card is retired for overlay names ──────────────────

describe('the old content.js card no longer competes for overlay names', () => {
  test('.hs-mc-user is gone from its username selector list', () => {
    const sel = body(CONTENT, 'const usernameSelectors = [', 400)
    expect(sel).not.toContain('.hs-mc-user')
  })

  test('native twitch/kick selectors are untouched — the old card still serves them', () => {
    const sel = body(CONTENT, 'const usernameSelectors = [', 400)
    expect(sel).toContain('.chat-author__display-name')
    expect(sel).toContain('[data-a-target="chat-message-username"]')
  })
})

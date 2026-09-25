/**
 * The floating mount (profile-card.js's `.hs-card-full` path) is the third
 * card surface — used whenever `#hs-mc-messages` doesn't exist (a native
 * twitch.tv/kick.com page with no multichat overlay mounted, or the overlay
 * mid-teardown during SPA nav). It never got a live no-overlay page to
 * verify against in a real browser (multichat's own self-heal reinject
 * watcher tears down every mcSignal-scoped listener the instant the overlay
 * container is removed, which makes forcing "no overlay" in Playwright
 * unreliable — see the phase-2 report). These are behavior tests instead,
 * same idea as the site's tests/client/card/pinned-card-behavior.test.js for
 * its own anchor-follow/focus-return/close contract on the analogous
 * feature.
 *
 * Scope: only the floating-mount PLUMBING — pcResolveMount, pcPositionFloating,
 * pcFollowAnchor/pcStopFollowingAnchor, pcOutsideClickHandler, and
 * closeProfileCard's floating branch — driven against a real (but hand-built,
 * house pattern, no jsdom/happy-dom here) DOM, using a stand-in `.hs-card-full`
 * div in place of a real hsCardModel/hsCardHtml render (that render is
 * covered separately by tests/card-panel.test.js; this file's job is proving
 * the mount/position/follow/close machinery around it, which doesn't care
 * what's inside the card). ESC is not re-tested here — profile-card.js's
 * keydown handler's Escape branch is a direct, unconditional call to
 * closeProfileCard() (see setupProfileCardHandlers), so the closeProfileCard
 * tests below already cover what ESC does.
 *
 * The one non-behavioral check (mod action dispatch reaching the same GQL
 * path) is at the bottom — pcHandleModAction is the SAME delegated handler
 * for both the panel and the floating card (setupProfileCardHandlers doesn't
 * branch on activeProfileCard.floating), so proving it calls dispatchModAction/
 * modTwitchUser/vipTwitchUser with the right args is variant-agnostic by
 * construction.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const CARD = readFileSync(join(ROOT, 'src', 'multichat', 'profile-card.js'), 'utf8')
const TIPS = readFileSync(join(ROOT, 'src', 'multichat', 'tooltips.js'), 'utf8')

function slice(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker)
  if (start === -1) throw new Error(`marker not found: ${startMarker}`)
  const end = src.indexOf(endMarker, start)
  if (end === -1) throw new Error(`end marker not found: ${endMarker}`)
  return src.slice(start, end)
}

// ── minimal hand-built DOM — a real (if tiny) event bus + tree, just enough
// for the floating-mount contract: getBoundingClientRect, style, remove(),
// contains(), a class-only querySelector, and real addEventListener/
// dispatchEvent on document/window (so pcFollowAnchor's own scroll/resize
// listeners, wired for real, are what's under test — not a stand-in). ──

function makeEventTarget() {
  const listeners = new Map() // type -> Set<fn>
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
    dispatchEvent(evt) {
      for (const fn of listeners.get(evt.type) || []) fn(evt)
    },
  }
}

function makeEl(tag, { rect = { top: 100, bottom: 120, left: 100, right: 200, width: 100, height: 20 } } = {}) {
  const bus = makeEventTarget()
  const el = {
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    dataset: {},
    style: {},
    children: [],
    parentNode: null,
    _removed: false,
    _rect: rect,
    get isConnected() {
      let n = el
      while (n) {
        if (n === fakeDocument.body) return true
        n = n.parentNode
      }
      return false
    },
    getBoundingClientRect: () => el._rect,
    focus: () => {
      fakeDocument.activeElement = el
    },
    appendChild(child) {
      child.parentNode = el
      el.children.push(child)
      return child
    },
    remove() {
      el._removed = true
      if (el.parentNode) el.parentNode.children = el.parentNode.children.filter((c) => c !== el)
      el.parentNode = null
    },
    contains(other) {
      if (other === el) return true
      return el.children.some((c) => c.contains(other))
    },
    querySelector(sel) {
      // Only `.class-name` is needed here (pcPositionFloating's own
      // `mountEl.querySelector('.hs-card-full')`).
      const cls = sel.startsWith('.') ? sel.slice(1) : null
      if (!cls) throw new Error(`unsupported selector in test stub: ${sel}`)
      const stack = [...el.children]
      while (stack.length) {
        const node = stack.shift()
        if ((node.className || '').split(' ').includes(cls)) return node
        stack.push(...node.children)
      }
      return null
    },
    addEventListener: bus.addEventListener,
    removeEventListener: bus.removeEventListener,
    dispatchEvent: bus.dispatchEvent,
  }
  return el
}

let fakeDocument
let fakeWindow
let rafQueue

function resetFakeGlobals() {
  const bus = makeEventTarget()
  fakeDocument = {
    activeElement: null,
    body: makeEl('body'),
    getElementById(id) {
      const stack = [fakeDocument.body]
      while (stack.length) {
        const node = stack.shift()
        if (node.id === id) return node
        stack.push(...node.children)
      }
      return null
    },
    createElement: (tag) => makeEl(tag),
    addEventListener: bus.addEventListener,
    removeEventListener: bus.removeEventListener,
    dispatchEvent: bus.dispatchEvent,
  }
  const winBus = makeEventTarget()
  fakeWindow = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: winBus.addEventListener,
    removeEventListener: winBus.removeEventListener,
    dispatchEvent: winBus.dispatchEvent,
  }
  rafQueue = []
}

function flushRAF() {
  const q = rafQueue
  rafQueue = []
  for (const fn of q) fn()
}

// ── extract the real functions under test from profile-card.js + tooltips.js,
// sharing ONE closure (activeProfileCard, _pcAnchorFollowCleanup,
// _onceGuardsProfileCard) exactly as they do in the real bundle scope. ──

const positionSrc = slice(
  TIPS,
  'function positionTooltipAtElement(tooltip, targetEl) {',
  '\n\nfunction hideUserTooltip()',
)
const resolveMountSrc = slice(CARD, 'function pcResolveMount() {', '\nfunction renderProfileCardView() {')
const closeSrc = slice(CARD, 'function closeProfileCard() {', '\nfunction getRecentMessagesFromUser(username) {')
const followSrc = slice(CARD, 'let _pcAnchorFollowCleanup = null', '\n// Outside-click dismiss')
const outsideAndPositionSrc = slice(CARD, 'function pcOutsideClickHandler(e) {', '\n// Async pronoun application')

function makeHarness() {
  resetFakeGlobals()
  return new Function(
    'document',
    'window',
    'requestAnimationFrame',
    'cleanup',
    'mcSignal',
    'showInputBar',
    'renderMessages',
    'currentTab',
    `
    let activeProfileCard = null
    let _onceGuardsProfileCard = {}
    ${positionSrc}
    ${resolveMountSrc}
    ${followSrc}
    ${outsideAndPositionSrc}
    ${closeSrc}
    return {
      pcResolveMount, pcPositionFloating, pcOutsideClickHandler, closeProfileCard,
      pcStopFollowingAnchor,
      getActiveProfileCard: () => activeProfileCard,
      setActiveProfileCard: (v) => { activeProfileCard = v },
    }
    `,
  )(
    fakeDocument,
    fakeWindow,
    (fn) => rafQueue.push(fn),
    { addEventListener: (target, type, fn, opts) => target.addEventListener(type, fn, opts) },
    undefined,
    () => {},
    () => {},
    null,
  )
}

// Opens a floating card the way openProfileCard→renderProfileCardView would:
// resolves the mount, drops in a stand-in `.hs-card-full` node, positions it.
function openFloating(h, anchorEl, openerEl = null) {
  h.setActiveProfileCard({
    username: 'someone',
    floating: true,
    anchorEl,
    openerEl,
    focusMoved: false,
  })
  const mount = h.pcResolveMount()
  const card = makeEl('div', { rect: { top: 0, bottom: 40, left: 0, right: 120, width: 120, height: 40 } })
  card.className = 'hs-card hs-card-full'
  mount.el.appendChild(card)
  h.pcPositionFloating(mount.el)
  return { mount: mount.el, card }
}

describe('pcResolveMount — floats only when there is nowhere embedded to render', () => {
  test('no #hs-mc-messages + an anchorEl → creates #hs-pcard-floating on body, floating:true', () => {
    const h = makeHarness()
    const anchor = makeEl('span')
    fakeDocument.body.appendChild(anchor)
    h.setActiveProfileCard({ anchorEl: anchor })
    const mount = h.pcResolveMount()
    expect(mount.floating).toBe(true)
    expect(mount.el.id).toBe('hs-pcard-floating')
    expect(fakeDocument.getElementById('hs-pcard-floating')).toBe(mount.el)
  })

  test('no #hs-mc-messages and no anchorEl → nowhere to render, returns null', () => {
    const h = makeHarness()
    h.setActiveProfileCard({ anchorEl: null })
    expect(h.pcResolveMount()).toBeNull()
  })

  test('#hs-mc-messages present → embedded (panel), never floats regardless of anchorEl', () => {
    const h = makeHarness()
    const msgs = makeEl('div')
    msgs.id = 'hs-mc-messages'
    fakeDocument.body.appendChild(msgs)
    const anchor = makeEl('span')
    fakeDocument.body.appendChild(anchor)
    h.setActiveProfileCard({ anchorEl: anchor })
    const mount = h.pcResolveMount()
    expect(mount.floating).toBe(false)
    expect(mount.el).toBe(msgs)
  })

  test('re-opening replaces a stale #hs-pcard-floating instead of stacking a second one', () => {
    const h = makeHarness()
    const anchor = makeEl('span')
    fakeDocument.body.appendChild(anchor)
    h.setActiveProfileCard({ anchorEl: anchor })
    const first = h.pcResolveMount()
    const second = h.pcResolveMount()
    expect(second.el).not.toBe(first.el)
    expect(fakeDocument.body.children.filter((c) => c.id === 'hs-pcard-floating').length).toBe(1)
  })
})

describe('pcPositionFloating — mounts `.hs-card-full` at the anchor, flips/clamps at viewport edges', () => {
  test('anchor near the top edge → card flips below it instead of the usual above', () => {
    const h = makeHarness()
    const anchor = makeEl('span', { rect: { top: 2, bottom: 20, left: 500, right: 560, width: 60, height: 18 } })
    fakeDocument.body.appendChild(anchor)
    const { card } = openFloating(h, anchor)
    // Not enough room above (top=2) for a 40px-tall card + 6px gap — bottom instead.
    expect(card.style.top).toBe('26px') // anchor.bottom(20) + gap(6)
  })

  test('anchor near the right edge → card is clamped inside the viewport, not pushed off it', () => {
    const h = makeHarness()
    fakeWindow.innerWidth = 400
    const anchor = makeEl('span', { rect: { top: 300, bottom: 320, left: 380, right: 398, width: 18, height: 20 } })
    fakeDocument.body.appendChild(anchor)
    const { card } = openFloating(h, anchor) // card is 120 wide
    const left = Number.parseInt(card.style.left, 10)
    expect(left).toBeLessThanOrEqual(400 - 120 - 5) // margin
    expect(left).toBeGreaterThanOrEqual(0)
  })

  test('anchor with plenty of room → card sits centered above it (the common case)', () => {
    const h = makeHarness()
    const anchor = makeEl('span', { rect: { top: 300, bottom: 320, left: 500, right: 560, width: 60, height: 20 } })
    fakeDocument.body.appendChild(anchor)
    const { card } = openFloating(h, anchor)
    expect(card.style.top).toBe('254px') // anchor.top(300) - card.height(40) - gap(6)
    expect(card.style.left).toBe('470px') // anchor.left(500) + anchor.width/2(30) - card.width/2(60)
  })
})

describe('the floating card follows its anchor and detaches cleanly', () => {
  test("repositions on scroll to track the anchor's new rect", () => {
    const h = makeHarness()
    const anchor = makeEl('span', { rect: { top: 300, bottom: 320, left: 500, right: 560, width: 60, height: 20 } })
    fakeDocument.body.appendChild(anchor)
    const { card } = openFloating(h, anchor)
    const before = card.style.top

    anchor._rect = { top: 600, bottom: 620, left: 200, right: 260, width: 60, height: 20 }
    fakeDocument.dispatchEvent({ type: 'scroll' })
    flushRAF()

    expect(card.style.top).not.toBe(before)
    expect(card.style.top).toBe('554px') // new anchor.top(600) - card.height(40) - gap(6)
  })

  test('repositions on window resize too', () => {
    const h = makeHarness()
    const anchor = makeEl('span', { rect: { top: 300, bottom: 320, left: 500, right: 560, width: 60, height: 20 } })
    fakeDocument.body.appendChild(anchor)
    const { card } = openFloating(h, anchor)
    anchor._rect = { top: 100, bottom: 120, left: 500, right: 560, width: 60, height: 20 }
    fakeWindow.dispatchEvent({ type: 'resize' })
    flushRAF()
    expect(card.style.top).toBe('54px')
  })

  test('closes outright (not left floating over nothing) when the anchor leaves the DOM', () => {
    const h = makeHarness()
    const anchor = makeEl('span', { rect: { top: 300, bottom: 320, left: 500, right: 560, width: 60, height: 20 } })
    fakeDocument.body.appendChild(anchor)
    openFloating(h, anchor)
    expect(h.getActiveProfileCard()).toBeTruthy()

    anchor.remove()
    fakeDocument.dispatchEvent({ type: 'scroll' })
    flushRAF()

    expect(h.getActiveProfileCard()).toBeNull()
    expect(fakeDocument.getElementById('hs-pcard-floating')).toBeNull()
  })

  test('stops following once closed some other way — a later scroll does not resurrect or throw', () => {
    const h = makeHarness()
    const anchor = makeEl('span', { rect: { top: 300, bottom: 320, left: 500, right: 560, width: 60, height: 20 } })
    fakeDocument.body.appendChild(anchor)
    openFloating(h, anchor)
    h.closeProfileCard()

    expect(() => {
      fakeDocument.dispatchEvent({ type: 'scroll' })
      flushRAF()
    }).not.toThrow()
    expect(fakeDocument.getElementById('hs-pcard-floating')).toBeNull()
  })
})

describe('closeProfileCard — the floating branch', () => {
  test('removes #hs-pcard-floating and stops following', () => {
    const h = makeHarness()
    const anchor = makeEl('span')
    fakeDocument.body.appendChild(anchor)
    openFloating(h, anchor)
    expect(fakeDocument.getElementById('hs-pcard-floating')).toBeTruthy()

    h.closeProfileCard()

    expect(fakeDocument.getElementById('hs-pcard-floating')).toBeNull()
    expect(h.getActiveProfileCard()).toBeNull()
  })

  test('focus returns to openerEl (the name that opened the card), same contract as the panel', () => {
    const h = makeHarness()
    const anchor = makeEl('span')
    const opener = makeEl('span')
    fakeDocument.body.appendChild(anchor)
    fakeDocument.body.appendChild(opener)
    openFloating(h, anchor, opener)

    h.closeProfileCard()

    expect(fakeDocument.activeElement).toBe(opener)
  })

  test('a detached openerEl is skipped, not thrown on', () => {
    const h = makeHarness()
    const anchor = makeEl('span')
    const opener = makeEl('span') // never appended — isConnected: false
    fakeDocument.body.appendChild(anchor)
    openFloating(h, anchor, opener)

    expect(() => h.closeProfileCard()).not.toThrow()
  })
})

describe('outside click closes the floating card, an inside click does not', () => {
  test('mousedown outside #hs-pcard-floating closes it', () => {
    const h = makeHarness()
    const anchor = makeEl('span')
    fakeDocument.body.appendChild(anchor)
    openFloating(h, anchor)
    const elsewhere = makeEl('div')
    fakeDocument.body.appendChild(elsewhere)

    fakeDocument.dispatchEvent({ type: 'mousedown', target: elsewhere })

    expect(h.getActiveProfileCard()).toBeNull()
    expect(fakeDocument.getElementById('hs-pcard-floating')).toBeNull()
  })

  test('mousedown inside the card leaves it open', () => {
    const h = makeHarness()
    const anchor = makeEl('span')
    fakeDocument.body.appendChild(anchor)
    const { card } = openFloating(h, anchor)

    fakeDocument.dispatchEvent({ type: 'mousedown', target: card })

    expect(h.getActiveProfileCard()).toBeTruthy()
    expect(fakeDocument.getElementById('hs-pcard-floating')).toBeTruthy()
  })

  test('outside-click is a no-op for the embedded (non-floating) panel — nothing to dismiss to', () => {
    const h = makeHarness()
    h.setActiveProfileCard({ username: 'x', floating: false })
    const elsewhere = makeEl('div')
    fakeDocument.body.appendChild(elsewhere)
    expect(() => h.pcOutsideClickHandler({ target: elsewhere })).not.toThrow()
    expect(h.getActiveProfileCard()).toBeTruthy() // untouched — the panel has its own close (✕/tab-away)
  })
})

// ── mod action dispatch — the floating card and the panel share this
// delegated handler verbatim (see file header); proving it reaches
// dispatchModAction/modTwitchUser/vipTwitchUser is proving both variants do. ──

const modActionSrc = slice(CARD, 'async function pcHandleModAction(btn) {', '\n// Session stats')

function makeModBtn(dataset) {
  return {
    dataset,
    disabled: false,
    textContent: '',
    closest: () => null, // no reason input wired in these tests — reason stays ''
  }
}

describe('pcHandleModAction reaches the same GQL dispatch the rest of the extension uses', () => {
  test("ban/timeout/delete actions call dispatchModAction with the button's data-hs-card-mod-* attributes", async () => {
    const calls = []
    const pcHandleModAction = new Function(
      't',
      'dispatchModAction',
      'showModResultToast',
      `${modActionSrc}\nreturn pcHandleModAction`,
    )(
      (k) => k,
      async (args) => {
        calls.push(args)
        return { anyOk: true }
      },
      () => {},
    )

    const btn = makeModBtn({
      hsCardModChannel: 'forsen',
      hsCardModPlatform: 'twitch',
      hsCardModLogin: 'someone',
      hsCardModMsgId: 'msg123',
      hsCardModAction: 'timeout',
      hsCardModDuration: '600',
    })
    await pcHandleModAction(btn)

    expect(calls).toEqual([
      {
        channel: 'forsen',
        platform: 'twitch',
        action: 'timeout',
        target: 'someone',
        durationSec: 600,
        msgId: 'msg123',
        reason: '',
      },
    ])
  })

  test('a role button (mod/vip grant) resolves the channel id and calls modTwitchUser/vipTwitchUser, not dispatchModAction', async () => {
    const dispatchCalls = []
    const modCalls = []
    const vipCalls = []
    const pcHandleModAction = new Function(
      't',
      'dispatchModAction',
      'getTwitchAuthToken',
      'resolveTwitchChannelIdEx',
      'modTwitchUser',
      'vipTwitchUser',
      'showToast',
      `${modActionSrc}\nreturn pcHandleModAction`,
    )(
      (k) => k,
      async (args) => {
        dispatchCalls.push(args)
        return { anyOk: true }
      },
      () => 'sometoken',
      async () => ({ id: 'chan123' }),
      async (channelId, login, add) => {
        modCalls.push({ channelId, login, add })
        return { ok: true }
      },
      async (channelId, login, add) => {
        vipCalls.push({ channelId, login, add })
        return { ok: true }
      },
      () => {},
    )

    const btn = makeModBtn({
      hsCardModChannel: 'forsen',
      hsCardModPlatform: 'twitch',
      hsCardModLogin: 'someone',
      hsCardModRole: 'vip',
      hsCardModAdd: '1',
    })
    await pcHandleModAction(btn)

    expect(dispatchCalls).toEqual([])
    expect(modCalls).toEqual([])
    expect(vipCalls).toEqual([{ channelId: 'chan123', login: 'someone', add: true }])
  })
})

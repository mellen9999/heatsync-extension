/**
 * D3: YouTube defaults big streams to 'Top chat' (server-side filtered), so
 * the relay reads a filtered stream instead of everything. ensureLiveChatMode
 * (chrome/youtube-content.js) switches the view-selector dropdown to 'Live
 * chat' on attach. DOM shape below is copied from a live capture (lofi girl's
 * 24/7 stream, 2026-09-06): yt-live-chat-header-renderer > #view-selector >
 * yt-sort-filter-sub-menu-renderer#live-chat-view-selector-sub-menu >
 * yt-dropdown-menu > tp-yt-paper-menu-button#menu-button, holding a #trigger
 * div and two <a class="yt-simple-endpoint"> items (Top chat, Live chat) —
 * the <a> (not the nested tp-yt-paper-item) carries aria-selected. Clicking
 * the Live chat <a> directly (no need to open the trigger first) flips
 * aria-selected on both items — confirmed live.
 *
 * This repo has no jsdom/happy-dom dependency (see tests/paints.test.js's
 * header) — document is hand-stubbed with just the surface this function
 * touches, same pattern as tests/cosmetic-live-update.test.js.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const YTC = readFileSync(join(import.meta.dir, '..', 'chrome', 'youtube-content.js'), 'utf8')

function extractFn(name) {
  const marker = `function ${name}(`
  const start = YTC.indexOf(marker)
  if (start === -1) throw new Error(`extractFn: "${name}" not found — source drifted`)
  const end = YTC.indexOf('\n  }', start)
  if (end === -1) throw new Error(`extractFn: "${name}" has no 2-space-indented closing brace`)
  return YTC.slice(start, end + 4)
}

const SELECTOR = 'yt-live-chat-header-renderer yt-sort-filter-sub-menu-renderer tp-yt-paper-menu-button'

// live: true|false controls the <a>'s aria-selected. click() flips both.
function makeItem(label, live) {
  const item = {
    label,
    selected: live,
    clicks: 0,
    getAttribute(name) {
      if (name === 'aria-selected') return String(item.selected)
      if (name === 'aria-label') return null // real capture: label lives in textContent, not aria-label
      return null
    },
    get textContent() {
      return item.label
    },
    click() {
      item.clicks++
      item.onClick?.(item)
    },
  }
  return item
}

function makeMenuButton({ selected = 'Top chat', throwOnClick = false } = {}) {
  const topChat = makeItem('Top chat', selected === 'Top chat')
  const liveChat = makeItem('Live chat', selected === 'Live chat')
  const select = (target) => {
    topChat.selected = target === topChat
    liveChat.selected = target === liveChat
  }
  topChat.onClick = throwOnClick
    ? () => {
        throw new Error('click failed')
      }
    : select
  liveChat.onClick = throwOnClick
    ? () => {
        throw new Error('click failed')
      }
    : select
  let triggerClicks = 0
  return {
    items: [topChat, liveChat],
    get triggerClicks() {
      return triggerClicks
    },
    querySelectorAll(sel) {
      if (sel === 'a.yt-simple-endpoint') return [topChat, liveChat]
      return []
    },
    querySelector(sel) {
      if (sel === '#trigger') {
        return {
          click() {
            triggerClicks++
          },
        }
      }
      return null
    },
  }
}

function makeHarness({ menuButton = null, toasts = [] } = {}) {
  const timers = []
  const cleanup = { setTimeout: (fn, ms) => timers.push({ fn, ms }) }
  const signal = { aborted: false }
  const showYtToast = (text) => toasts.push(text)
  const documentStub = {
    querySelector: (sel) => (sel === SELECTOR ? menuButton : null),
  }
  const { ensureLiveChatMode } = new Function(
    'document',
    'cleanup',
    'signal',
    'showYtToast',
    `${extractFn('ensureLiveChatMode')}\nreturn { ensureLiveChatMode }`,
  )(documentStub, cleanup, signal, showYtToast)
  return { ensureLiveChatMode, timers, toasts, signal }
}

describe('ensureLiveChatMode', () => {
  test('Top chat selected → clicks the Live chat item', () => {
    const mb = makeMenuButton({ selected: 'Top chat' })
    const h = makeHarness({ menuButton: mb })
    h.ensureLiveChatMode()
    const liveChat = mb.items.find((i) => i.label === 'Live chat')
    expect(liveChat.clicks).toBe(1)
    expect(liveChat.selected).toBe(true)
    expect(mb.items.find((i) => i.label === 'Top chat').selected).toBe(false)
  })

  test('already on Live chat → no click, idempotent', () => {
    const mb = makeMenuButton({ selected: 'Live chat' })
    const h = makeHarness({ menuButton: mb })
    h.ensureLiveChatMode()
    expect(mb.items.every((i) => i.clicks === 0)).toBe(true)
  })

  test('calling it twice in a row (mirrors the reattach after the mode-switch causes its own container swap) never toggles back', () => {
    const mb = makeMenuButton({ selected: 'Top chat' })
    const h = makeHarness({ menuButton: mb })
    h.ensureLiveChatMode()
    h.ensureLiveChatMode()
    expect(mb.items.find((i) => i.label === 'Live chat').selected).toBe(true)
  })

  test('menu not hydrated yet → retries via cleanup.setTimeout, never toasts', () => {
    const h = makeHarness({ menuButton: null })
    h.ensureLiveChatMode()
    expect(h.timers).toHaveLength(1)
    expect(h.toasts).toHaveLength(0)
  })

  test('retries are bounded — gives up silently past the attempt cap (VOD/replay has no selector at all, not a failure)', () => {
    const h = makeHarness({ menuButton: null })
    h.ensureLiveChatMode(10)
    expect(h.timers).toHaveLength(0)
    expect(h.toasts).toHaveLength(0)
  })

  test('aborted mid-retry never fires a fresh timer or a click', () => {
    const h = makeHarness({ menuButton: null })
    h.signal.aborted = true
    h.ensureLiveChatMode()
    expect(h.timers).toHaveLength(0)
  })

  test('a throwing click degrades to the toast, never an uncaught throw', () => {
    const mb = makeMenuButton({ selected: 'Top chat', throwOnClick: true })
    const h = makeHarness({ menuButton: mb })
    expect(() => h.ensureLiveChatMode()).not.toThrow()
    expect(h.toasts).toEqual(['top chat mode — switch youtube to live chat'])
  })

  test('opens the trigger before clicking the item (belt-and-suspenders for a future build that needs it open)', () => {
    const mb = makeMenuButton({ selected: 'Top chat' })
    const h = makeHarness({ menuButton: mb })
    h.ensureLiveChatMode()
    expect(mb.triggerClicks).toBe(1)
  })
})

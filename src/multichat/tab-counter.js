// Per-tab message counter for the tab bar — the number on the right of a
// channel name.
//
// Two numbers, one setting (`tabCounter`):
//   unread — messages since you last had the tab open. Zero on the tab you are
//            reading, by definition.
//   heat   — messages in the last 60 seconds. Says how busy a channel IS, so it
//            still means something on the tab in front of you.
//
// Neither existed here before: the tab bar only ever carried the boolean
// `has-new` highlight.
//
// Heat is a 90-slot ring of per-second counts, advanced by ELAPSED TIME rather
// than by tick count. A ticker that rolls the ring one slot per fire is only
// correct while it actually fires — and this one runs via setIntervalIfVisible,
// so a backgrounded tab would come back showing a minute-old number and take a
// further minute to drain. Advancing on read means a missed tick costs nothing
// and the ticker's only job is repainting.
//
// Counting happens at the four message-arrival sites (twitch + kick in main.js,
// the two youtube paths in social.js) rather than inside updateTabIndicator,
// which by construction never fires for the tab you're looking at.

const TAB_HEAT_BUCKETS = 90
const TAB_HEAT_WINDOW = 60
/** Cap the rendered number so a busy channel can't keep widening its tab. */
const TAB_COUNT_MAX = 999

/** tabId → {unread, buckets, sec} */
const _tabActivity = new Map()
let _tabCounterTimer = null

function _nowSec() {
  return Math.floor(Date.now() / 1000)
}

function _tabEntry(tabId) {
  let e = _tabActivity.get(tabId)
  if (!e) {
    e = { unread: 0, buckets: new Array(TAB_HEAT_BUCKETS).fill(0), sec: _nowSec() }
    _tabActivity.set(tabId, e)
  }
  return e
}

/** Bring a ring up to now. A gap longer than the ring just clears it. */
function _advance(e) {
  const now = _nowSec()
  let delta = now - e.sec
  if (delta <= 0) return
  e.sec = now
  if (delta >= TAB_HEAT_BUCKETS) {
    e.buckets.fill(0)
    return
  }
  for (; delta > 0; delta--) {
    e.buckets.shift()
    e.buckets.push(0)
  }
}

/**
 * One message arrived for a tab. Call this at the arrival site, before the
 * active/background branch — heat has to count the tab you're reading too.
 * @param {string} tabId
 * @param {boolean} isActive whether this tab is the one on screen
 */
function bumpTabActivity(tabId, isActive) {
  if (!tabId) return
  const e = _tabEntry(tabId)
  _advance(e)
  e.buckets[e.buckets.length - 1]++
  if (!isActive) e.unread++
}

/** Tab was read — drop its unread. Heat is untouched: it isn't about you. */
function clearTabUnread(tabId) {
  const e = _tabActivity.get(tabId)
  if (e) e.unread = 0
}

/**
 * A tab was acknowledged as read. Paired with each `has-new` removal rather
 * than folded into one helper: those sites differ in which classes they drop
 * and why, and rewriting them to share a signature would be a bigger change
 * than the counter warrants.
 * @param {string} tabId
 */
function markTabRead(tabId) {
  clearTabUnread(tabId)
  refreshTabCounter(tabId)
}

/** Forget a tab entirely (channel removed). */
function dropTabActivity(tabId) {
  _tabActivity.delete(tabId)
}

function tabUnreadCount(tabId) {
  return _tabActivity.get(tabId)?.unread || 0
}

function tabHeatCount(tabId) {
  const e = _tabActivity.get(tabId)
  if (!e) return 0
  _advance(e)
  const b = e.buckets
  let n = 0
  for (let i = Math.max(0, b.length - TAB_HEAT_WINDOW); i < b.length; i++) n += b[i] || 0
  return n
}

/** The active `tabCounter` mode, defaulting the way the schema does. */
function tabCounterMode() {
  return (typeof getSetting === 'function' && getSetting('tabCounter')) || 'unread'
}

function _tabCountText(tabId, mode, isActive) {
  const n =
    mode === 'heat' ? tabHeatCount(tabId) : mode === 'off' ? 0 : isActive ? 0 : tabUnreadCount(tabId)
  if (n <= 0) return ''
  return n > TAB_COUNT_MAX ? `${TAB_COUNT_MAX}+` : String(n)
}

/**
 * Write the counter chip onto one tab. Mutates in place and only touches the
 * DOM when the text actually changes, so the heat ticker doesn't force a layout
 * pass a second for every tab.
 */
function paintTabCounter(tabEl, mode, isActive) {
  const tabId = tabEl?.dataset?.tab
  if (!tabId) return
  const want = _tabCountText(tabId, mode, isActive)
  let el = tabEl.querySelector(':scope > .hs-mc-tab-count')
  if (!want) {
    el?.remove()
    return
  }
  if (!el) {
    el = document.createElement('span')
    el.className = 'hs-mc-tab-count'
    tabEl.appendChild(el)
  }
  if (el.textContent !== want) el.textContent = want
}

/** Repaint one tab — the per-message path, so it stays a single lookup. */
function refreshTabCounter(tabId) {
  if (typeof tabBarElement === 'undefined' || !tabBarElement || !tabId) return
  const tabEl = tabBarElement.querySelector(`.hs-mc-tab[data-tab="${CSS.escape(tabId)}"]`)
  if (tabEl) paintTabCounter(tabEl, tabCounterMode(), tabId === currentTab)
}

/**
 * Repaint every tab. Called after the tab bar is rebuilt (updateTabBar sets
 * textContent, which drops the chip), on tab switch, and once a second while
 * heat mode is on.
 */
function refreshTabCounters() {
  if (typeof tabBarElement === 'undefined' || !tabBarElement) return
  const mode = tabCounterMode()
  for (const tabEl of tabBarElement.querySelectorAll('.hs-mc-tab[data-tab]')) {
    paintTabCounter(tabEl, mode, tabEl.dataset.tab === currentTab)
  }
  _syncTabCounterTicker(mode)
}

/**
 * Heat decays on a clock, so it needs a repaint ticker; unread doesn't move on
 * its own, so it gets none. Started and stopped by mode rather than left
 * running — an idle interval is not something to spend on a machine already
 * running a chat client.
 */
function _syncTabCounterTicker(mode) {
  const want = mode === 'heat'
  if (want && !_tabCounterTimer) {
    _tabCounterTimer = cleanup.setIntervalIfVisible(() => {
      const m = tabCounterMode()
      if (m !== 'heat') {
        _syncTabCounterTicker(m)
        return
      }
      if (typeof tabBarElement === 'undefined' || !tabBarElement) return
      for (const tabEl of tabBarElement.querySelectorAll('.hs-mc-tab[data-tab]')) {
        paintTabCounter(tabEl, 'heat', tabEl.dataset.tab === currentTab)
      }
    }, 1000)
  } else if (!want && _tabCounterTimer) {
    cleanup.clearInterval(_tabCounterTimer)
    _tabCounterTimer = null
  }
}

// Tab mode — a rover cursor over the chat tab strip. The extension half of the
// site's client/vim/tab-mode.js; same keys, same rules, so muscle memory
// carries between heatsync.org, this overlay and the terminal client.
//
//   j/k        move the cursor (counts work: 3j)
//   g/G        first / last
//   enter, l   open the tab under the cursor, then leave
//   J/K        move the tab itself down / up
//   d, x       close the tab under the cursor
//   a, o       add a channel
//   esc, q, t  leave without switching
//
// Motion and commit are separate — j/k never switch a tab. That separation is
// the only reason `d` (close) is safe to put on a single key at all.
//
// Two things differ from the site, both because this runs inside somebody
// else's page:
//
//   1. It opens on `<Space>t` from vi normal mode (see overlay-keys.js), not on
//      a bare `t`. The site owns its keyboard; here a bare letter belongs to
//      twitch.tv — and, more to the point, to whatever message the user is in
//      the middle of typing. Once the mode is ON it is modal and does own the
//      keyboard, which is what a mode means.
//   2. The status line rides the overlay's own statusbar rather than a floating
//      corner element, which would sit on top of the host page's UI.

const TAB_CURSOR_CLASS = 'hs-mc-tab-cursor'

const _tabMode = { active: false, cursor: 0, count: '' }

/**
 * Tabs the rover walks, in strip order: the surfaces plus every channel.
 * Excludes `+` (that's what `a` is for) and the util cluster (settings,
 * collapse, popout, subscribe — actions, not places), and anything
 * applyHiddenTabs has display:none'd.
 * @returns {HTMLElement[]}
 */
function tabModeTabs() {
  if (!tabBarElement) return []
  // Chat hidden (the `\` toggle) → no visible strip to put a cursor on, so the
  // mode refuses to open and `t` falls through to the host page untouched.
  if (!tabBarElement.offsetParent && getComputedStyle(tabBarElement).position !== 'fixed') return []
  const scroll = tabBarElement.querySelector('.hs-mc-tabs-scroll')
  if (!scroll) return []
  return Array.from(scroll.querySelectorAll('.hs-mc-tab[data-tab]')).filter(
    (t) => t.dataset.tab !== 'add' && t.style.display !== 'none',
  )
}

/** Only real channels can be reordered or closed; surfaces are fixtures. */
function isChannelTab(tabId) {
  return !!tabId && typeof getChannelById === 'function' && !!getChannelById(tabId)
}

function _tabModeStatus(text) {
  try {
    HsNotifs.emit('tab-mode', { text })
  } catch (_) {}
}

function _tabModeClearStatus() {
  try {
    HsNotifs.dismissByKey('tab-mode', 'tab-mode')
  } catch (_) {}
}

function _tabModeTakeCount() {
  const n = _tabMode.count ? Number.parseInt(_tabMode.count, 10) : 1
  _tabMode.count = ''
  return Math.max(1, Math.min(n, 999))
}

function _tabModeRender() {
  const tabs = tabModeTabs()
  for (const t of tabs) t.classList.remove(TAB_CURSOR_CLASS)
  if (!tabs.length) {
    exitTabMode()
    return
  }
  // The strip can shrink under the cursor (a tab closed, a rebuild) — clamp
  // here rather than in every key path, so none of them can land on undefined
  // and silently drop out of the mode.
  _tabMode.cursor = Math.max(0, Math.min(_tabMode.cursor, tabs.length - 1))
  const cur = tabs[_tabMode.cursor]
  cur.classList.add(TAB_CURSOR_CLASS)
  cur.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  const label = (cur.textContent || '').trim()
  _tabModeStatus(
    `${_tabMode.cursor + 1}/${tabs.length} ${label} · jk move · enter open · JK reorder · d close · a add · esc`,
  )
}

/** @returns {boolean} whether the mode actually opened */
function enterTabMode() {
  const tabs = tabModeTabs()
  if (!tabs.length) return false
  _tabMode.active = true
  _tabMode.count = ''
  // Start on the open tab, not the top of the strip — the thing you're looking
  // at is the thing you most likely want to act on.
  const activeIdx = tabs.findIndex((t) => t.dataset.tab === currentTab)
  _tabMode.cursor = activeIdx >= 0 ? activeIdx : 0
  _tabModeRender()
  return true
}

function exitTabMode() {
  if (!_tabMode.active) return
  _tabMode.active = false
  _tabMode.count = ''
  for (const t of tabModeTabs()) t.classList.remove(TAB_CURSOR_CLASS)
  _tabModeClearStatus()
}

function tabModeActive() {
  return _tabMode.active
}

/**
 * @param {KeyboardEvent} e
 * @returns {boolean} consumed — the caller preventDefaults on true
 */
function handleTabModeKey(e) {
  if (!_tabMode.active) return false
  const k = e.key
  const tabs = tabModeTabs()
  if (!tabs.length) {
    exitTabMode()
    return true
  }
  const last = tabs.length - 1
  _tabMode.cursor = Math.max(0, Math.min(_tabMode.cursor, last))

  if (k === 'Escape' || k === 'q' || k === 't') {
    exitTabMode()
    return true
  }

  if ((k >= '1' && k <= '9') || (k === '0' && _tabMode.count)) {
    _tabMode.count += k
    return true
  }

  if (k === 'j' || k === 'ArrowDown') {
    _tabMode.cursor = Math.min(last, _tabMode.cursor + _tabModeTakeCount())
    _tabModeRender()
    return true
  }
  if (k === 'k' || k === 'ArrowUp') {
    _tabMode.cursor = Math.max(0, _tabMode.cursor - _tabModeTakeCount())
    _tabModeRender()
    return true
  }
  if (k === 'g' || k === 'Home') {
    _tabMode.cursor = 0
    _tabMode.count = ''
    _tabModeRender()
    return true
  }
  if (k === 'G' || k === 'End') {
    _tabMode.cursor = last
    _tabMode.count = ''
    _tabModeRender()
    return true
  }

  if (k === 'Enter' || k === 'l' || k === 'ArrowRight') {
    const id = tabs[_tabMode.cursor]?.dataset.tab
    exitTabMode()
    if (id) switchTab(id)
    return true
  }

  if (k === 'J' || k === 'K') {
    const id = tabs[_tabMode.cursor]?.dataset.tab
    if (!isChannelTab(id)) {
      _tabModeStatus('that tab is fixed')
      return true
    }
    const delta = k === 'J' ? 1 : -1
    if (moveChannelOrder(id, delta)) {
      // Follow the tab, not the slot — the point of J/K is carrying one channel
      // through the list.
      _tabMode.cursor = Math.max(0, Math.min(last, _tabMode.cursor + delta))
    }
    _tabModeRender()
    return true
  }

  if (k === 'd' || k === 'x') {
    const id = tabs[_tabMode.cursor]?.dataset.tab
    if (!isChannelTab(id)) {
      _tabModeStatus("that tab can't be closed")
      return true
    }
    removeChannel(id)
    // One fewer tab: land the cursor on whatever slid into the gap.
    _tabMode.cursor = Math.max(0, Math.min(_tabMode.cursor, last - 1))
    _tabModeRender()
    return true
  }

  if (k === 'a' || k === 'o') {
    exitTabMode()
    switchTab('add')
    return true
  }

  return true // swallow stray keys; stay in tab mode
}

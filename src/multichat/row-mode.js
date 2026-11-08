// Row mode — a cursor over the chat rows, so every message is reachable without
// a mouse. Reply, mute, mod and profile used to live behind a right-click and
// nowhere else.
//
//   <Space> r (vi) or alt+r     enter from the composer, or from anywhere
//   j k  ↓ ↑                    move the cursor one row
//   g G  home end               first / last row
//   enter                       that row's action menu (the right-click menu)
//   r                           reply to that row
//   esc, alt+r                  leave
//
// Same shape as tab mode (tab-mode.js) and the same rules. It is MODAL: a layer
// the person enters on purpose, so inside it a bare j/k/r belongs to the layer.
// Outside it nothing here listens for a bare key — the composer owns every
// printable key, and the only way in is a leader or an alt combo. Two
// guarantees keep "typing always types":
//
//   - focus landing in an editable (clicked the composer, Tab) ends the mode
//   - focus wandering anywhere else (a tab button, a link) ends it too, so the
//     mode can never sit invisibly swallowing letters
//
// THE CURSOR IS REAL FOCUS. The row under the cursor gets tabindex=-1 and DOM
// focus, which is how a screen reader hears it: moving the cursor reads the
// row aloud, no live-region trickery. The reverse-video box is for the eyes.
//
// ROWS NEVER MOVE: chat only ever appends, so the cursor stays on its row as
// new messages arrive. The mode holds the row's element and its key; if a
// re-render swaps the element (same slot, same key) a childList observer — alive
// only while the mode is — puts the cursor back on the new one. Trimmed off the
// top, it lands on the oldest row that is left.
//
// Enter does not build a menu of its own. It fires the row's own contextmenu
// event, flagged as coming from the keyboard, so the keyboard and the mouse
// open the same menu from the same code (input.js, openUserCtxMenu).

const ROW_CURSOR_CLASS = 'hs-mc-row-cursor'

const _rowMode = { active: false, row: null, key: '', index: 0, tab: '', opener: null, observer: null }

function _rowModeMsgsEl() {
  return document.getElementById('hs-mc-messages')
}

function _rowModeEditable(el) {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

/**
 * Rows the cursor can stand on, in order: chat lines and feed posts, nothing
 * the render pass put there that is not a row (placeholder, embedded player).
 * @returns {HTMLElement[]}
 */
function rowModeRows() {
  const msgsEl = _rowModeMsgsEl()
  if (!msgsEl) return []
  const out = []
  for (const c of msgsEl.children) {
    if (!c.classList.contains('hs-mc-msg') && !c.classList.contains('hs-feed-msg')) continue
    if (c.hidden || c.style.display === 'none') continue
    out.push(c)
  }
  return out
}

function _rowModeKeyOf(row) {
  return row?.dataset?.msgKey || row?.dataset?.msgId || ''
}

function _rowModeStatus(text) {
  try {
    HsNotifs.emit('row-mode', { text })
  } catch (_) {}
}

function _rowModeClearStatus() {
  try {
    HsNotifs.dismissByKey('row-mode', 'row-mode')
  } catch (_) {}
}

function _rowModeRelease(row) {
  if (!row) return
  row.classList.remove(ROW_CURSOR_CLASS)
  row.removeAttribute('tabindex')
  if (document.activeElement === row) row.blur?.()
}

// Put the cursor on `row`: class for the eyes, focus for the screen reader.
function _rowModeLand(row, rows, { focus = true } = {}) {
  if (_rowMode.row && _rowMode.row !== row) _rowModeRelease(_rowMode.row)
  _rowMode.row = row
  _rowMode.key = _rowModeKeyOf(row)
  const i = rows ? rows.indexOf(row) : -1
  if (i >= 0) _rowMode.index = i
  row.classList.add(ROW_CURSOR_CLASS)
  row.setAttribute('tabindex', '-1')
  if (focus) {
    try {
      row.focus({ preventScroll: true })
    } catch (_) {}
  }
  row.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
  _rowModeStatus(t('mc_rowmode_status', [String(_rowMode.index + 1), String(rows ? rows.length : 1)]))
}

// The list was re-rendered or trimmed under the cursor: find the row again.
// @returns {boolean} whether the mode is still on
function _rowModeSync() {
  if (!_rowMode.active) return false
  const msgsEl = _rowModeMsgsEl()
  if (!msgsEl || currentTab !== _rowMode.tab) {
    exitRowMode()
    return false
  }
  if (_rowMode.row?.isConnected && msgsEl.contains(_rowMode.row)) {
    // a rebuilt row keeps its element but can lose the class; harmless to re-assert
    if (!_rowMode.row.classList.contains(ROW_CURSOR_CLASS)) _rowMode.row.classList.add(ROW_CURSOR_CLASS)
    return true
  }
  const rows = rowModeRows()
  if (!rows.length) {
    exitRowMode()
    return false
  }
  const same = _rowMode.key ? rows.find((r) => _rowModeKeyOf(r) === _rowMode.key) : null
  _rowModeLand(same || rows[Math.min(_rowMode.index, rows.length - 1)], rows)
  return true
}

/**
 * Start on the newest row you can see: the last row whose top is inside the
 * list's box, which is simply the last row while the chat is following new
 * messages and the lowest visible one when you have scrolled up.
 */
function _rowModeStartRow(rows, msgsEl) {
  const bottom = msgsEl.getBoundingClientRect?.().bottom
  if (bottom) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].getBoundingClientRect().top < bottom) return rows[i]
    }
  }
  return rows[rows.length - 1]
}

/** @returns {boolean} whether the mode opened (false: nothing to put a cursor on) */
function enterRowMode() {
  if (_rowMode.active) return true
  const msgsEl = _rowModeMsgsEl()
  // chat hidden (the `\` toggle) or not laid out: no rows to look at, and the
  // key must fall through to whatever else wanted it
  if (!msgsEl?.getClientRects?.().length) return false
  const rows = rowModeRows()
  if (!rows.length) return false
  const composer = document.getElementById('hs-mc-input')
  const fromComposer = !!composer && document.activeElement === composer
  // Modal, so the composer lets go NOW. vi's own focusout detach is 150ms
  // behind, and the first j would land inside that gap and be eaten.
  if (fromComposer) {
    try {
      composer.blur()
      window.__hsViDetachNow?.(composer)
    } catch (_) {}
  }
  _rowMode.active = true
  _rowMode.opener = fromComposer ? composer : null
  _rowMode.tab = currentTab
  _rowMode.row = null
  _rowMode.index = 0
  try {
    _rowMode.observer = new MutationObserver(() => _rowModeSync())
    _rowMode.observer.observe(msgsEl, { childList: true })
  } catch (_) {}
  _rowModeLand(_rowModeStartRow(rows, msgsEl), rows)
  return true
}

/** @param {boolean} [restoreFocus] give focus back to the composer, if the mode was entered from it */
function exitRowMode(restoreFocus = false) {
  if (!_rowMode.active) return
  _rowMode.active = false
  _rowMode.observer?.disconnect()
  _rowMode.observer = null
  _rowModeRelease(_rowMode.row)
  for (const r of document.querySelectorAll(`.${ROW_CURSOR_CLASS}`)) _rowModeRelease(r)
  _rowMode.row = null
  _rowModeClearStatus()
  const opener = _rowMode.opener
  _rowMode.opener = null
  if (restoreFocus && opener?.isConnected) {
    try {
      if (typeof showInputBar === 'function') showInputBar()
      opener.focus()
    } catch (_) {}
  }
}

function rowModeActive() {
  return _rowMode.active
}

/** alt+r: in if out, out if in. */
function toggleRowMode() {
  if (_rowMode.active) {
    exitRowMode(true)
    return true
  }
  return enterRowMode()
}

// Enter: the row's right-click menu, opened from the keyboard.
function _rowModeOpenMenu(row) {
  const rect = row.getBoundingClientRect()
  const ev = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: Math.round(rect.left) + 8,
    clientY: Math.round(rect.bottom),
  })
  ev.hsKeyboard = true
  // dispatchEvent is false when the handler called preventDefault — i.e. a menu opened
  if (row.dispatchEvent(ev)) _rowModeStatus(t('mc_rowmode_no_actions'))
}

function _rowModeReply(row) {
  const state = typeof rowReplyState === 'function' ? rowReplyState(row) : null
  if (!state) {
    _rowModeStatus(t('mc_rowmode_no_reply'))
    return
  }
  exitRowMode()
  setReplyState(state) // puts focus in the composer
}

/**
 * @param {KeyboardEvent} e
 * @returns {boolean} consumed — the caller preventDefaults on true
 */
function handleRowModeKey(e) {
  if (!_rowMode.active) return false
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false
  // the action menu has its own keys; it hands focus back to the row when it closes
  if (document.getElementById('hs-mc-msg-ctx')) return false
  const k = e.key
  // Tab belongs to the page: it jumps to the composer (type-reveal handler), so
  // leave the mode and let that happen
  if (k === 'Tab') {
    exitRowMode()
    return false
  }
  if (!_rowModeSync()) return false
  const rows = rowModeRows()
  const last = rows.length - 1
  const at = Math.max(0, rows.indexOf(_rowMode.row))
  const go = (i) => _rowModeLand(rows[Math.max(0, Math.min(last, i))], rows)

  if (k === 'Escape') {
    exitRowMode(true)
    return true
  }
  if (k === 'j' || k === 'ArrowDown') {
    go(at + 1)
    return true
  }
  if (k === 'k' || k === 'ArrowUp') {
    go(at - 1)
    return true
  }
  if (k === 'g' || k === 'Home') {
    go(0)
    return true
  }
  if (k === 'G' || k === 'End') {
    go(last)
    return true
  }
  if (k === 'Enter') {
    _rowModeOpenMenu(_rowMode.row)
    return true
  }
  if (k === 'r') {
    _rowModeReply(_rowMode.row)
    return true
  }
  // Modal: a stray letter is swallowed rather than leaking to the host page.
  // Anything that is not a printable key (function keys, the context-menu key,
  // shift alone) is not ours.
  return k.length === 1
}

/** Wire the mode into the page. Once per overlay; everything unhooks with `signal`. */
function initRowMode(signal) {
  registerOverlayKey('r', () => enterRowMode())
  document.addEventListener(
    'keydown',
    (e) => {
      if (!_rowMode.active) return
      // the action menu is open: its keys, not ours, and the focus is inside it
      if (document.getElementById('hs-mc-msg-ctx')) return
      const ae = document.activeElement
      if (_rowModeEditable(ae)) return
      // focus went somewhere that is not a row: the mode is stale — end it without eating the key
      if (ae && ae !== document.body && !ae.classList?.contains(ROW_CURSOR_CLASS)) {
        exitRowMode()
        return
      }
      try {
        if (handleRowModeKey(e)) {
          e.preventDefault()
          e.stopImmediatePropagation()
        }
      } catch (_) {}
    },
    { capture: true, signal },
  )
  // clicking or tabbing into the composer means "I'm typing now"
  document.addEventListener(
    'focusin',
    (e) => {
      if (_rowMode.active && _rowModeEditable(e.target)) exitRowMode()
    },
    { capture: true, signal },
  )
}

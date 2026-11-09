/**
 * overlay-keys — the overlay's bare-key commands, in ONE table.
 *
 * WHY THIS EXISTS
 *
 * Every one of these commands used to be its own document-level keydown
 * listener that fired only while the composer was NOT focused. That made the
 * blurred state a second, invisible keyboard mode: the same letter meant
 * "type this" with the composer focused and "run this" without, and the only
 * way to reach a command was to click off the input onto the background.
 * Worse, a hovered chat row turned x/t/b into delete/timeout/ban, so the first
 * letter of a message could moderate someone (that pair is now gone entirely —
 * see mod-toolbar.js).
 *
 * The replacement is a leader key. In vi normal mode, <Space> arms the leader
 * and the next key runs the command below — the composer keeps focus the whole
 * time, and there is exactly one place that says what a bare key does.
 * <Space> is free in normal mode (vim's own space is a redundant `l`) and is
 * what every vim user already reaches for, so nothing conflicts and nothing
 * has to be relearned.
 *
 * The old blurred-composer listeners stay for the non-destructive commands
 * (vi mode is off by default; without it there'd be no keyboard surface at
 * all), but they are now thin wrappers over the same functions registered
 * here — one implementation, two entry points.
 */

// key (single char, case-sensitive — 'n' and 'N' differ) -> () => boolean.
// A command returns false when it decided not to act (wrong tab, nothing to
// search), so the leader can stay silent instead of claiming the key.
const _overlayKeyBinds = new Map()

function registerOverlayKey(key, fn) {
  _overlayKeyBinds.set(key, fn)
}

function runOverlayKey(key) {
  const fn = _overlayKeyBinds.get(key)
  if (!fn) return false
  try {
    return fn() !== false
  } catch (_) {
    return false
  }
}

// vi-mode.js is a separate content script in the same ISOLATED world, so it
// reaches us through window — the same channel as __hsViChanging/__hsEscOwned.
function initOverlayKeys(signal) {
  const hook = (key) => runOverlayKey(key)
  window.__hsOverlayCommand = hook
  try {
    signal?.addEventListener(
      'abort',
      () => {
        if (window.__hsOverlayCommand === hook) window.__hsOverlayCommand = undefined
      },
      { once: true },
    )
  } catch (_) {}
}

// A key heatsync consumed on keydown owns its keyup too. Eating the keydown is
// not enough on youtube: its player acts on some keys at KEYUP — Space toggles
// play there (hold-space-for-2x moved the toggle off keydown), and its global
// hotkey listener (document, bubble) skips only an event that is
// defaultPrevented. So Space in row mode, tab mode or a row's menu paused the
// video. Every modal key consumer calls ownKeyup(e) beside its preventDefault.
const _ownedKeyups = new Set()
function ownKeyup(e) {
  const k = e.code || e.key
  if (k) _ownedKeyups.add(k)
}
function initOwnedKeyups(signal) {
  document.addEventListener(
    'keyup',
    (e) => {
      if (!_ownedKeyups.delete(e.code || e.key)) return
      e.preventDefault()
      e.stopImmediatePropagation()
    },
    { capture: true, signal },
  )
  // a keyup that never arrives (focus left the window mid-press) must not eat a later one
  window.addEventListener('blur', () => _ownedKeyups.clear(), { signal })
}

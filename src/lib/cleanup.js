// @ts-check
/**
 * Cleanup/lifecycle module — memory leak prevention for long streaming sessions.
 * Tracks intervals, timeouts, MutationObservers, and event listeners for bulk teardown.
 *
 * Usage:
 *   cleanup.setInterval(fn, ms)         → tracked interval id
 *   cleanup.clearInterval(id)           → clear + untrack
 *   cleanup.setTimeout(fn, ms)          → tracked timeout id (auto-untracked on fire)
 *   cleanup.clearTimeout(id)            → clear + untrack
 *   cleanup.trackObserver(obs)          → obs (disconnect on destroyAll)
 *   cleanup.untrackObserver(obs)        → disconnect + untrack
 *   cleanup.trackListener(t, ev, fn, opts?) → untrack on destroyAll
 *   cleanup.untrackListener(t, ev, fn) → removeEventListener + untrack
 *   cleanup.destroyAll()                → tear everything down (safe to call repeatedly)
 */

;(() => {
  if (window.heatsyncCleanup) return

  // --- internal state ---
  const _intervals = new Set()
  const _timeouts = new Set()
  const _observers = new Set()
  // listeners: Array<{ target, event, handler, options }>
  const _listeners = []

  // --- intervals ---

  // Optional perf tracer. Set window.__hsPerfTrace = true at runtime to
  // start logging callbacks that exceed 50ms of main-thread work into
  // window.__hsPerfLog (capped at 200 entries). Source location captured
  // at registration time so each interval has a stable identifier even
  // for anonymous arrow fns.
  function _wrap(fn, ms, kind) {
    let src = ''
    // Stack capture is only ever read when tracing is armed (see wrapper below).
    // Skipping it when tracing is off avoids ~40 `new Error().stack` builds at
    // boot. Arm __hsPerfTrace BEFORE the timers you want to attribute register;
    // the call-time gate still times pre-existing timers (just without src).
    if (window.__hsPerfTrace) {
      try {
        const stack = new Error().stack || ''
        const lines = stack.split('\n')
        // Skip frames inside this module
        for (const line of lines) {
          if (!line) continue
          if (line.includes('cleanup.js') || line.includes('multichat.js')) {
            if (line.includes('multichat.js')) {
              src = line.trim().slice(0, 120)
              break
            }
            continue
          }
          if (line.includes('content.js') || line.includes('background.js') || line.includes('youtube-content.js')) {
            src = line.trim().slice(0, 120)
            break
          }
        }
        if (!src) src = (lines[3] || lines[2] || '').trim().slice(0, 120)
      } catch {}
    }
    return function (...args) {
      if (!window.__hsPerfTrace) return fn.apply(this, args)
      const t = performance.now()
      try {
        return fn.apply(this, args)
      } finally {
        const d = performance.now() - t
        if (d > 50) {
          window.__hsPerfLog ||= []
          window.__hsPerfLog.push({ kind, ms, dur: Math.round(d), at: Math.round(t), src })
          if (window.__hsPerfLog.length > 200) window.__hsPerfLog.shift()
        }
      }
    }
  }

  function _setInterval(fn, ms) {
    const id = setInterval(_wrap(fn, ms, 'interval'), ms)
    _intervals.add(id)
    return id
  }

  function _setIntervalIfVisible(fn, ms) {
    const wrapped = _wrap(fn, ms, 'intervalIfVisible')
    const id = setInterval(() => {
      if (!document.hidden) wrapped()
    }, ms)
    _intervals.add(id)
    return id
  }

  function _clearInterval(id) {
    clearInterval(id)
    _intervals.delete(id)
  }

  // --- timeouts ---

  function _setTimeout(fn, ms) {
    let id
    const wrapped = _wrap(fn, ms, 'timeout')
    id = setTimeout(() => {
      _timeouts.delete(id)
      wrapped()
    }, ms)
    _timeouts.add(id)
    return id
  }

  function _clearTimeout(id) {
    clearTimeout(id)
    _timeouts.delete(id)
  }

  // --- observers ---

  function _trackObserver(observer) {
    _observers.add(observer)
    return observer
  }

  function _untrackObserver(observer) {
    if (!observer) return
    try {
      observer.disconnect()
    } catch (_) {}
    _observers.delete(observer)
  }

  // --- listeners ---

  /**
   * @param {EventTarget} target
   * @param {string} event
   * @param {EventListenerOrEventListenerObject} handler
   * @param {AddEventListenerOptions|boolean|string} [a] options, or a diagnostic
   *   label (see below) — the two are sorted by type, not by position
   * @param {AddEventListenerOptions|boolean|string} [b] whichever of the two `a`
   *   was not
   *
   * A STRING here is a label, not options. Twenty-two call sites passed one —
   * 'mc-picker-close', 'emote-click', 'input-modifier-backspace' — copying the
   * habit from cleanup.setTimeout, which really does take a label. Web IDL
   * resolves a string against `boolean | AddEventListenerOptions`: not an
   * object, so it converts to boolean, and a non-empty string is true. Every
   * one of those listeners silently ran in the CAPTURE phase, ahead of the
   * page's own handlers, which nobody who wrote them intended. The five that
   * genuinely need capture — the four that stopPropagation to preempt Twitch,
   * and the `error` listener, since error does not bubble at all — now say so
   * with an explicit { capture: true }.
   */
  function _trackListener(target, event, handler, a, b) {
    if (!target || !event || !handler) return
    // The label and the options may arrive in either order, because call sites
    // wrote both: `(t, e, h, 'label')`, `(t, e, h, 'label', true)` and
    // `(t, e, h, { capture: true }, 'label')` all exist. Sorting them by type
    // is the only reading that does not silently drop one of them — dropping
    // the options is how two capture-phase delegates in content.js became
    // bubble-phase without a single line changing at their call sites.
    const aIsLabel = typeof a === 'string'
    const options = aIsLabel ? (typeof b === 'string' ? undefined : b) : a
    const label = aIsLabel ? a : typeof b === 'string' ? b : undefined
    target.addEventListener(event, handler, options)
    _listeners.push({ target, event, handler, options, label })
  }

  function _untrackListener(target, event, handler) {
    if (!target || !event || !handler) return
    for (let i = _listeners.length - 1; i >= 0; i--) {
      const l = _listeners[i]
      if (l.target === target && l.event === event && l.handler === handler) {
        target.removeEventListener(event, handler, l.options)
        _listeners.splice(i, 1)
      }
    }
  }

  // --- requestAnimationFrame ---

  const _rafs = new Set()

  function _raf(fn) {
    const id = requestAnimationFrame(() => {
      _rafs.delete(id)
      fn()
    })
    _rafs.add(id)
    return id
  }

  function _cancelRaf(id) {
    cancelAnimationFrame(id)
    _rafs.delete(id)
  }

  // --- nuclear ---

  function _destroyAll() {
    _intervals.forEach((id) => {
      clearInterval(id)
    })
    _intervals.clear()

    _timeouts.forEach((id) => {
      clearTimeout(id)
    })
    _timeouts.clear()

    _observers.forEach((obs) => {
      try {
        obs.disconnect()
      } catch (_) {}
    })
    _observers.clear()

    _rafs.forEach((id) => {
      cancelAnimationFrame(id)
    })
    _rafs.clear()

    for (let i = _listeners.length - 1; i >= 0; i--) {
      const l = _listeners[i]
      try {
        l.target.removeEventListener(l.event, l.handler, l.options)
      } catch (_) {}
    }
    _listeners.length = 0
  }

  window.heatsyncCleanup = {
    setInterval: _setInterval,
    setIntervalIfVisible: _setIntervalIfVisible,
    clearInterval: _clearInterval,
    setTimeout: _setTimeout,
    clearTimeout: _clearTimeout,
    trackObserver: _trackObserver,
    untrackObserver: _untrackObserver,
    trackListener: _trackListener,
    untrackListener: _untrackListener,
    addEventListener: _trackListener,
    removeEventListener: _untrackListener,
    raf: _raf,
    cancelRaf: _cancelRaf,
    destroyAll: _destroyAll,
  }
})()

// Bundle-scope binding. Every other lib file exposes flat top-level
// declarations, but cleanup.js hides its state behind an IIFE (window-keyed
// so bundles sharing a world reuse one instance) — without this re-export,
// bare `cleanup` is a ReferenceError in any bundle that doesn't declare its
// own. youtube-content + heatsync-button shipped that way (04-27→07-05): yt
// native chat died at init, the button lost its SPA-nav/retry timers, all
// silent behind DEBUG-gated catches. Nested bundles (content.js, multichat
// bootstrap) legally shadow this with their own `const cleanup`.
const cleanup = window.heatsyncCleanup

// MAIN-world script. Loaded only on youtube.com at document_start.
// Wraps every key handler (added via addEventListener) so that key events
// targeted at our multichat input become a no-op for page-script listeners.
//
// Why this is needed: YT's hotkey handler runs in capture phase on document /
// window, before our input's keydown reaches our own bubble-phase listener.
// stopPropagation in capture would kill the input's default action (typing
// nothing inserted) and our own handler (Enter-to-send broken). The only
// surgical fix is to make YT's handler return early — which we do by wrapping
// every keydown/keypress/keyup listener at registration time.
//
// Safety: the wrap only short-circuits when the event's target is inside
// `#hs-mc-input`. All other key events flow normally — clicking the player
// then pressing space still pauses, custom hotkeys elsewhere still fire.
// removeEventListener is mirrored so YT can still detach its own listeners.
;(() => {
  if (window._hsMcKbdGuardPatched) return
  window._hsMcKbdGuardPatched = true

  const KEY_EVENTS = new Set(['keydown', 'keypress', 'keyup'])

  const inOurInput = (t) => {
    if (!t || t.nodeType !== 1) return false
    if (t.id === 'hs-mc-input') return true
    return !!(t.closest && t.closest('#hs-mc-input'))
  }

  const wrapMap = new WeakMap()
  const wrap = (fn) => {
    if (typeof fn !== 'function') return fn
    let w = wrapMap.get(fn)
    if (w) return w
    w = function (e) {
      if (e && KEY_EVENTS.has(e.type) && inOurInput(e.target)) return
      // biome-ignore lint/complexity/noArguments: transparent monkeypatch forward. `arguments` passes through every argument the host actually called with, including any we don't model, and keeps the wrapper's arity — rest params would change fn.length, which host code can branch on.
      return fn.apply(this, arguments)
    }
    wrapMap.set(fn, w)
    return w
  }

  const origAdd = EventTarget.prototype.addEventListener
  const origRemove = EventTarget.prototype.removeEventListener

  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (KEY_EVENTS.has(type) && typeof fn === 'function') {
      return origAdd.call(this, type, wrap(fn), opts)
    }
    // biome-ignore lint/complexity/noArguments: transparent monkeypatch forward. `arguments` passes through every argument the host actually called with, including any we don't model, and keeps the wrapper's arity — rest params would change fn.length, which host code can branch on.
    return origAdd.apply(this, arguments)
  }

  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    if (KEY_EVENTS.has(type) && typeof fn === 'function') {
      const w = wrapMap.get(fn)
      if (w) return origRemove.call(this, type, w, opts)
    }
    // biome-ignore lint/complexity/noArguments: transparent monkeypatch forward. `arguments` passes through every argument the host actually called with, including any we don't model, and keeps the wrapper's arity — rest params would change fn.length, which host code can branch on.
    return origRemove.apply(this, arguments)
  }

  // Belt-and-braces: patch <video>.pause() too, in case a code path calls it
  // outside a key event (e.g. YT's internal state machine triggered via a
  // toggle that bypasses the listener system). Only blocks while our input
  // has focus — user-initiated pauses via clicks still work because focus
  // moves to the player.
  const patchVideo = (v) => {
    if (!v || v._hsMcPausePatched) return
    v._hsMcPausePatched = true
    const origPause = v.pause
    v.pause = function () {
      const ae = document.activeElement
      if (ae && (ae.id === 'hs-mc-input' || (ae.closest && ae.closest('#hs-mc-input')))) return
      // biome-ignore lint/complexity/noArguments: transparent monkeypatch forward. `arguments` passes through every argument the host actually called with, including any we don't model, and keeps the wrapper's arity — rest params would change fn.length, which host code can branch on.
      return origPause.apply(this, arguments)
    }
  }
  const scan = () => {
    const vids = document.querySelectorAll('video')
    for (let i = 0; i < vids.length; i++) patchVideo(vids[i])
  }
  if (document.documentElement) scan()
  new MutationObserver(scan).observe(document.documentElement || document, {
    childList: true,
    subtree: true,
  })
})()

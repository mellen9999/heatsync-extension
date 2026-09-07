// Shared utilities for Heatsync browser extension
// Loaded FIRST via manifest content_scripts — exposes window.HS
// Chrome compatibility - Firefox uses 'browser', Chrome uses 'chrome'
const browser = globalThis.browser || chrome
;(() => {
  // Guard against double-load
  if (window.HS) return

  /**
   * Create a lifecycle controller — abort() tears down ALL listeners, timers, observers.
   * Each consumer file gets its own isolated lifecycle.
   *
   * @param {Object} opts
   * @param {Function} opts.onAbort - extra cleanup to run on abort
   * @returns {{ signal, cleanup, abort }}
   */
  function createLifecycle(opts = {}) {
    const controller = new AbortController()
    const signal = controller.signal
    const _timers = { intervals: new Set(), timeouts: new Set(), observers: [] }
    const _pendingRafs = new Set()

    signal.addEventListener('abort', () => {
      _timers.intervals.forEach(clearInterval)
      _timers.timeouts.forEach(clearTimeout)
      _timers.observers.forEach((o) => {
        o.disconnect()
      })
      _pendingRafs.forEach(cancelAnimationFrame)
      _pendingRafs.clear()
      if (opts.onAbort) opts.onAbort()
    })

    window.addEventListener('pagehide', () => controller.abort(), { once: true })

    const cleanup = {
      setInterval(fn, ms) {
        const id = setInterval(fn, ms)
        _timers.intervals.add(id)
        return id
      },
      setTimeout(fn, ms) {
        const id = setTimeout(fn, ms)
        _timers.timeouts.add(id)
        return id
      },
      addEventListener(target, event, handler, extra) {
        target.addEventListener(event, handler, { signal, ...extra })
      },
      trackObserver(obs) {
        _timers.observers.push(obs)
        return obs
      },
      raf(fn) {
        let id
        id = requestAnimationFrame(() => {
          _pendingRafs.delete(id)
          fn()
        })
        _pendingRafs.add(id)
        return id
      },
      cancelRaf(id) {
        cancelAnimationFrame(id)
        _pendingRafs.delete(id)
      },
    }

    return { signal, cleanup, abort: () => controller.abort() }
  }

  /**
   * React fiber walking (FFZ-style).
   * Access React's internal component tree via special keys on DOM elements.
   */
  function getFiber(el) {
    if (!el) return null
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'))
    return key ? el[key] : null
  }

  /**
   * Walk up the React fiber tree from a DOM element to find a component matching a predicate.
   *
   * @param {Element} startEl - DOM element to start from
   * @param {Function} predicate - (instance, fiber) => boolean
   * @param {number} maxDepth - max fiber hops (default 50)
   * @returns {{ instance, fiber } | null}
   */
  function findComponent(startEl, predicate, maxDepth = 50) {
    let fiber = getFiber(startEl)
    let depth = 0
    while (fiber && depth < maxDepth) {
      try {
        const inst = fiber.stateNode
        if (inst && predicate(inst, fiber)) {
          return { instance: inst, fiber }
        }
      } catch (e) {}
      fiber = fiber.return
      depth++
    }
    return null
  }

  /**
   * Safe wrapper for chrome.runtime.sendMessage.
   * Handles "Extension context invalidated" errors gracefully,
   * and retries up to 5 times with exponential backoff on connection errors.
   *
   * @param {Object} message
   * @param {Object} opts
   * @param {Function} opts.onInvalidated - callback when context is dead
   * @returns {Promise<any>}
   */
  let _contextValid = true
  async function safeSend(message, opts = {}) {
    if (!_contextValid) {
      return { success: false, error: 'Extension context invalidated' }
    }
    const MAX_RETRIES = 5
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await browser.runtime.sendMessage(message)
      } catch (err) {
        if (err.message?.includes('Extension context invalidated') || err.message?.includes('context invalidated')) {
          _contextValid = false
          if (opts.onInvalidated) opts.onInvalidated()
          throw err
        }
        const isConnErr =
          err.message?.includes('Receiving end does not exist') ||
          err.message?.includes('Could not establish connection')
        if (isConnErr && attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 200 * 2 ** attempt))
          continue
        }
        throw err
      }
    }
  }

  function showToast(message, type = 'info') {
    // Prefer the overlay statusbar slot (the `>` line) when the multichat
    // overlay is mounted — one toast surface, deduped (×N) instead of a fresh
    // floating box per attempt. Float bottom-center only when no overlay exists.
    try {
      if (window.HsNotifs && document.getElementById('hs-notif-layer-statusbar')) {
        window.HsNotifs.emit('toast', { text: message, level: type })
        return
      }
    } catch (_) {}

    const existing = document.getElementById('heatsync-toast')
    if (existing) existing.remove()

    const borders = { success: '#0f0', error: '#f00', info: '#fff', warning: '#ff0' }
    const toast = document.createElement('div')
    toast.id = 'heatsync-toast'
    toast.textContent = message
    toast.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#000;color:#fff;border:1px solid ${borders[type] || borders.info};padding:6px 14px;border-radius:0;font:bold 12px monospace;z-index:10001;animation:heatsync-toast-in .2s ease-out;max-width:300px;text-align:center;`

    if (!document.getElementById('heatsync-toast-styles')) {
      const style = document.createElement('style')
      style.id = 'heatsync-toast-styles'
      style.textContent = `@keyframes heatsync-toast-in{from{opacity:0}to{opacity:1}}@keyframes heatsync-toast-out{from{opacity:1}to{opacity:0}}`
      document.head.appendChild(style)
    }

    document.body.appendChild(toast)
    setTimeout(
      () => {
        toast.style.animation = 'heatsync-toast-out .2s ease-in forwards'
        setTimeout(() => toast.remove(), 200)
      },
      type === 'error' ? 3000 : 2000,
    )
  }

  /**
   * Proxy API fetch through the background script (bypasses CORS).
   * All content script calls to heatsync.org API should use this.
   *
   * @param {string} path - API path (e.g. '/api/profile/username')
   * @param {Object} opts
   * @param {string} opts.method - HTTP method (default 'GET')
   * @param {Object} opts.body - JSON body (auto-stringified by background)
   * @param {boolean} opts.auth - include stored auth token (default false)
   * @returns {Promise<any>} parsed JSON response
   */
  async function apiFetch(path, opts = {}) {
    const resp = await safeSend({
      type: 'api_fetch',
      path,
      method: opts.method,
      body: opts.body,
      auth: opts.auth,
    })
    if (!resp?.ok) {
      const err = new Error(resp?.error || `API error ${resp?.status}`)
      err.status = resp?.status
      throw err
    }
    return resp.data
  }

  // ── MAIN-world nonce ──────────────────────────────────────────────
  // Generates a random per-session nonce and sends it to early-inject-main.js
  // (MAIN world) so that subsequent GQL/Helix/Apollo messages can be verified.
  // content.js MUST call HS.initMainWorldNonce() once after the page loads.
  //
  // Note: postMessage is visible to page JS — this is defence-in-depth, not
  // a cryptographic barrier. It prevents static/replay attacks and raises the
  // bar for any adversarial code that hasn't already hooked addEventListener.
  function generateNonce() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }

  let _mainWorldNonce = null

  function initMainWorldNonce() {
    if (_mainWorldNonce) return _mainWorldNonce
    _mainWorldNonce = generateNonce()
    window.postMessage({ type: 'heatsync-init-nonce', nonce: _mainWorldNonce }, location.origin)
    return _mainWorldNonce
  }

  // Returns current nonce (call initMainWorldNonce first)
  function getMainWorldNonce() {
    return _mainWorldNonce
  }

  window.HS = {
    createLifecycle,
    getFiber,
    findComponent,
    safeSend,
    apiFetch,
    showToast,
    initMainWorldNonce,
    getMainWorldNonce,
  }
})()

// Emote continuity fallback — one delegated capture-phase error listener: any
// <img> from a third-party emote CDN that fails to load retries ONCE through
// heatsync's continuity byte cache. Covers every ext render surface (multichat
// rows, native-chat injection, tooltips, picker) without touching creation
// sites. Zero cost on the happy path; only fires when the provider CDN fails.
// Guarded: shared-utils loads with both content-script groups on twitch.
;(() => {
  if (window.__hsEmoteFallbackInstalled) return
  window.__hsEmoteFallbackInstalled = true
  // Mirrors EMOTE_FALLBACK_HOSTS server-side (services/emote-cache.ts).
  const HS_EC_HOSTS = new Set([
    'cdn.7tv.app',
    'cdn.betterttv.net',
    'cdn.frankerfacez.com',
    'files.kick.com',
    'static-cdn.jtvnw.net',
  ])
  document.addEventListener(
    'error',
    (e) => {
      const img = e.target
      if (!img || img.tagName !== 'IMG' || img.dataset.hsEcFb) return
      const src = img.currentSrc || img.src || ''
      let host
      try {
        host = new URL(src).hostname
      } catch (_) {
        return
      }
      if (!HS_EC_HOSTS.has(host)) return
      img.dataset.hsEcFb = '1'
      img.removeAttribute('srcset')
      img.src = 'https://heatsync.org/api/emotes/cdn?u=' + encodeURIComponent(src)
    },
    true,
  )
})()

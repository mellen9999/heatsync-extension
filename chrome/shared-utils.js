// Shared utilities for Heatsync browser extension
// Loaded FIRST via manifest content_scripts — exposes window.HS
;(function() {
  'use strict'

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

    signal.addEventListener('abort', () => {
      _timers.intervals.forEach(clearInterval)
      _timers.timeouts.forEach(clearTimeout)
      _timers.observers.forEach(o => o.disconnect())
      if (opts.onAbort) opts.onAbort()
    })

    window.addEventListener('pagehide', () => controller.abort())

    const cleanup = {
      setInterval(fn, ms) { const id = setInterval(fn, ms); _timers.intervals.add(id); return id },
      setTimeout(fn, ms) { const id = setTimeout(fn, ms); _timers.timeouts.add(id); return id },
      addEventListener(target, event, handler, extra) {
        target.addEventListener(event, handler, { signal, ...extra })
      },
      trackObserver(obs) { _timers.observers.push(obs); return obs },
      raf(fn) { return requestAnimationFrame(fn) },
    }

    return { signal, cleanup, abort: () => controller.abort() }
  }

  /**
   * React fiber walking (FFZ-style).
   * Access React's internal component tree via special keys on DOM elements.
   */
  function getFiber(el) {
    if (!el) return null
    const key = Object.keys(el).find(k =>
      k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    )
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
   * Handles "Extension context invalidated" errors gracefully.
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
    try {
      return await chrome.runtime.sendMessage(message)
    } catch (err) {
      if (err.message?.includes('Extension context invalidated') ||
          err.message?.includes('context invalidated')) {
        _contextValid = false
        if (opts.onInvalidated) opts.onInvalidated()
      }
      throw err
    }
  }

  function showToast(message, type = 'info') {
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
      style.textContent = `@keyframes heatsync-toast-in{from{opacity:0;transform:translateX(-50%) translateY(10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}@keyframes heatsync-toast-out{from{opacity:1;transform:translateX(-50%) translateY(0)}to{opacity:0;transform:translateX(-50%) translateY(-10px)}}`
      document.head.appendChild(style)
    }

    document.body.appendChild(toast)
    setTimeout(() => {
      toast.style.animation = 'heatsync-toast-out .2s ease-in forwards'
      setTimeout(() => toast.remove(), 200)
    }, type === 'error' ? 3000 : 2000)
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
    if (!resp || !resp.ok) {
      const err = new Error(resp?.error || `API error ${resp?.status}`)
      err.status = resp?.status
      throw err
    }
    return resp.data
  }

  window.HS = {
    createLifecycle,
    getFiber,
    findComponent,
    safeSend,
    apiFetch,
    showToast,
  }
})()

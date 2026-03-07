/**
 * Shared utilities for heatsync extension.
 * XSS prevention, DOM helpers, debouncing, etc.
 */

// ============================================
// XSS PREVENTION (CRITICAL)
// ============================================

/**
 * Escape HTML entities to prevent XSS
 * @param {string} str - Untrusted string
 * @returns {string} Escaped string safe for innerHTML
 */
function escapeHtml(str) {
  if (str == null) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

/**
 * Escape string for use in HTML attribute
 * @param {string} str
 * @returns {string}
 */
function escapeAttr(str) {
  if (str == null) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

/**
 * Sanitize URL - only allow http/https/data URIs
 * @param {string} url
 * @returns {string} Safe URL or empty string
 */
function sanitizeUrl(url) {
  if (!url) return ''
  const str = String(url).trim()
  // Allow http, https, data (for images), and relative URLs
  if (str.startsWith('http://') ||
      str.startsWith('https://') ||
      str.startsWith('data:image/') ||
      str.startsWith('/') ||
      str.startsWith('./')) {
    return str
  }
  return ''
}

/**
 * Create element with safe text content (no innerHTML)
 * @param {string} tag
 * @param {string} text
 * @param {string} [className]
 * @returns {HTMLElement}
 */
function createElement(tag, text, className) {
  const el = document.createElement(tag)
  if (text) el.textContent = text
  if (className) el.className = className
  return el
}

/**
 * Set innerHTML safely with escaped content
 * @param {HTMLElement} el
 * @param {string} html - Already sanitized HTML (use escapeHtml for user content)
 */
function setInnerHTML(el, html) {
  el.innerHTML = html
}

// ============================================
// DEBOUNCE / THROTTLE
// ============================================

/**
 * Debounce function - delays execution until no calls for `wait` ms
 * @param {Function} fn
 * @param {number} wait - Milliseconds
 * @returns {Function}
 */
function debounce(fn, wait) {
  let timeoutId = null
  return function(...args) {
    clearTimeout(timeoutId)
    timeoutId = setTimeout(() => fn.apply(this, args), wait)
  }
}

/**
 * Throttle function - executes at most once per `wait` ms
 * @param {Function} fn
 * @param {number} wait - Milliseconds
 * @returns {Function}
 */
function throttle(fn, wait) {
  let lastCall = 0
  let timeoutId = null
  return function(...args) {
    const now = Date.now()
    const remaining = wait - (now - lastCall)

    if (remaining <= 0) {
      clearTimeout(timeoutId)
      lastCall = now
      fn.apply(this, args)
    } else if (!timeoutId) {
      timeoutId = setTimeout(() => {
        lastCall = Date.now()
        timeoutId = null
        fn.apply(this, args)
      }, remaining)
    }
  }
}

/**
 * Throttle using requestAnimationFrame (for visual updates)
 * @param {Function} fn
 * @returns {Function}
 */
function rafThrottle(fn) {
  let rafId = null
  return function(...args) {
    if (rafId) return
    rafId = requestAnimationFrame(() => {
      rafId = null
      fn.apply(this, args)
    })
  }
}

// ============================================
// DOM HELPERS
// ============================================

/**
 * Query selector with caching
 * @param {string} selector
 * @param {Element} [parent=document]
 * @returns {Element|null}
 */
function $(selector, parent = document) {
  return parent.querySelector(selector)
}

/**
 * Query selector all
 * @param {string} selector
 * @param {Element} [parent=document]
 * @returns {NodeListOf<Element>}
 */
function $$(selector, parent = document) {
  return parent.querySelectorAll(selector)
}

/**
 * Wait for element to appear in DOM
 * @param {string} selector
 * @param {number} [timeout=5000]
 * @param {Element} [parent=document]
 * @returns {Promise<Element>}
 */
function waitForElement(selector, timeout = 5000, parent = document) {
  return new Promise((resolve, reject) => {
    const el = parent.querySelector(selector)
    if (el) {
      resolve(el)
      return
    }

    const observer = new MutationObserver((mutations, obs) => {
      const el = parent.querySelector(selector)
      if (el) {
        obs.disconnect()
        resolve(el)
      }
    })

    observer.observe(parent === document ? document.body : parent, {
      childList: true,
      subtree: true
    })

    setTimeout(() => {
      observer.disconnect()
      reject(new Error(`Timeout waiting for ${selector}`))
    }, timeout)
  })
}

/**
 * Check if element is in viewport
 * @param {Element} el
 * @returns {boolean}
 */
function isInViewport(el) {
  const rect = el.getBoundingClientRect()
  return (
    rect.top < window.innerHeight &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.right > 0
  )
}

// ============================================
// REACT FIBER HELPERS (FFZ-style)
// ============================================

/**
 * Get React fiber from DOM element
 * @param {Element} el
 * @returns {object|null}
 */
function getFiber(el) {
  if (!el) return null
  const key = Object.keys(el).find(k =>
    k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
  )
  return key ? el[key] : null
}

/**
 * Find React component by walking fiber tree
 * @param {Element} startEl
 * @param {Function} predicate - (instance, fiber) => boolean
 * @param {number} [maxDepth=50]
 * @returns {{ instance: object, fiber: object } | null}
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
 * Get React props from element
 * @param {Element} el
 * @returns {object|null}
 */
function getReactProps(el) {
  if (!el) return null
  const key = Object.keys(el).find(k => k.startsWith('__reactProps$'))
  return key ? el[key] : null
}

// ============================================
// LOGGING
// ============================================

const DEBUG = typeof window !== 'undefined' &&
  (window.HEATSYNC_DEBUG || localStorage.getItem('heatsync_debug') === 'true')

/**
 * Debug log (only when HEATSYNC_DEBUG is true)
 */
function log(...args) {
  if (DEBUG) {
    console.log('[heatsync]', ...args)
  }
}

/**
 * Warning log (always shown)
 */
function warn(...args) {
  console.warn('[heatsync]', ...args)
}

/**
 * Error log (always shown)
 */
function error(...args) {
  console.error('[heatsync]', ...args)
}

// ============================================
// MISC
// ============================================

/**
 * Sleep for ms
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Generate unique ID
 * @param {string} [prefix='hs']
 * @returns {string}
 */
function uid(prefix = 'hs') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * Parse JSON safely
 * @param {string} str
 * @param {*} fallback
 * @returns {*}
 */
function parseJson(str, fallback = null) {
  try {
    return JSON.parse(str)
  } catch (e) {
    return fallback
  }
}

// ============================================
// TRUSTED ORIGINS
// ============================================

const TRUSTED_ORIGINS = [
  'https://www.twitch.tv',
  'https://twitch.tv',
  'https://kick.com',
  'https://www.kick.com',
  'https://heatsync.org',
  'https://www.heatsync.org'
]

/**
 * Check if origin is trusted
 * @param {string} origin
 * @returns {boolean}
 */
function isTrustedOrigin(origin) {
  return TRUSTED_ORIGINS.includes(origin) || origin === window.location.origin
}

// Export
const utils = {
  // XSS
  escapeHtml,
  escapeAttr,
  sanitizeUrl,
  createElement,
  setInnerHTML,

  // Timing
  debounce,
  throttle,
  rafThrottle,
  sleep,

  // DOM
  $,
  $$,
  waitForElement,
  isInViewport,

  // React
  getFiber,
  findComponent,
  getReactProps,

  // Logging
  log,
  warn,
  error,
  DEBUG,

  // Misc
  uid,
  parseJson,
  isTrustedOrigin,
  TRUSTED_ORIGINS
}

// Global export
if (typeof window !== 'undefined') {
  window.heatsyncUtils = utils
}

export {
  escapeHtml,
  escapeAttr,
  sanitizeUrl,
  createElement,
  setInnerHTML,
  debounce,
  throttle,
  rafThrottle,
  sleep,
  $,
  $$,
  waitForElement,
  isInViewport,
  getFiber,
  findComponent,
  getReactProps,
  log,
  warn,
  error,
  uid,
  parseJson,
  isTrustedOrigin,
  TRUSTED_ORIGINS
}
export default utils

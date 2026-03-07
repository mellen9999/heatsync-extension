/**
 * Centralized cleanup system for intervals, timeouts, observers, and event listeners.
 * Prevents memory leaks during 8hr+ streaming sessions.
 *
 * Usage:
 *   import { cleanup } from './lib/cleanup.js'
 *
 *   // Track interval
 *   cleanup.setInterval(() => { ... }, 1000, 'emote-scanner')
 *
 *   // Track observer
 *   cleanup.observe(observer, element, options, 'chat-watcher')
 *
 *   // Track event listener
 *   cleanup.addEventListener(element, 'click', handler, 'panel-click')
 *
 *   // Clear specific
 *   cleanup.clear('emote-scanner')
 *
 *   // Clear all (called automatically on unload)
 *   cleanup.clearAll()
 */

const registry = {
  intervals: new Map(),    // name -> intervalId
  timeouts: new Map(),     // name -> timeoutId
  observers: new Map(),    // name -> MutationObserver
  listeners: new Map(),    // name -> { element, event, handler, options }
  animationFrames: new Map() // name -> rafId
}

// Stats for debugging
let stats = {
  intervalsCreated: 0,
  intervalsCleaned: 0,
  observersCreated: 0,
  observersCleaned: 0,
  listenersCreated: 0,
  listenersCleaned: 0
}

/**
 * Create a tracked setInterval
 * @param {Function} callback
 * @param {number} delay
 * @param {string} name - Unique identifier for this interval
 * @returns {number} intervalId
 */
function trackedSetInterval(callback, delay, name) {
  // Clear existing if same name
  if (registry.intervals.has(name)) {
    clearInterval(registry.intervals.get(name))
    stats.intervalsCleaned++
  }

  const id = setInterval(callback, delay)
  registry.intervals.set(name, id)
  stats.intervalsCreated++
  return id
}

/**
 * Create a tracked setTimeout
 * @param {Function} callback
 * @param {number} delay
 * @param {string} name - Unique identifier for this timeout
 * @returns {number} timeoutId
 */
function trackedSetTimeout(callback, delay, name) {
  // Clear existing if same name
  if (registry.timeouts.has(name)) {
    clearTimeout(registry.timeouts.get(name))
  }

  const id = setTimeout(() => {
    registry.timeouts.delete(name)
    callback()
  }, delay)
  registry.timeouts.set(name, id)
  return id
}

/**
 * Track and start a MutationObserver
 * @param {MutationObserver} observer
 * @param {Element} target
 * @param {MutationObserverInit} options
 * @param {string} name - Unique identifier
 * @returns {MutationObserver}
 */
function trackedObserve(observer, target, options, name) {
  // Disconnect existing if same name
  if (registry.observers.has(name)) {
    try {
      registry.observers.get(name).disconnect()
      stats.observersCleaned++
    } catch (e) {}
  }

  observer.observe(target, options)
  registry.observers.set(name, observer)
  stats.observersCreated++
  return observer
}

/**
 * Create a tracked MutationObserver (convenience wrapper)
 * @param {MutationCallback} callback
 * @param {Element} target
 * @param {MutationObserverInit} options
 * @param {string} name
 * @returns {MutationObserver}
 */
function createTrackedObserver(callback, target, options, name) {
  const observer = new MutationObserver(callback)
  return trackedObserve(observer, target, options, name)
}

/**
 * Track an existing observer (call .observe() yourself)
 * Drop-in replacement for old trackObserver() pattern
 * @param {MutationObserver} observer
 * @param {string} name
 * @returns {MutationObserver}
 */
function trackObserver(observer, name) {
  // Disconnect existing if same name
  if (registry.observers.has(name)) {
    try {
      registry.observers.get(name).disconnect()
      stats.observersCleaned++
    } catch (e) {}
  }
  registry.observers.set(name, observer)
  stats.observersCreated++
  return observer
}

/**
 * Track an event listener
 * @param {EventTarget} element
 * @param {string} event
 * @param {Function} handler
 * @param {string} name - Unique identifier
 * @param {AddEventListenerOptions} [options]
 * @returns {Function} handler (for chaining)
 */
function trackedAddEventListener(element, event, handler, name, options) {
  // Remove existing if same name
  if (registry.listeners.has(name)) {
    const existing = registry.listeners.get(name)
    try {
      existing.element.removeEventListener(existing.event, existing.handler, existing.options)
      stats.listenersCleaned++
    } catch (e) {}
  }

  element.addEventListener(event, handler, options)
  registry.listeners.set(name, { element, event, handler, options })
  stats.listenersCreated++
  return handler
}

/**
 * Track a requestAnimationFrame
 * @param {Function} callback
 * @param {string} name
 * @returns {number} rafId
 */
function trackedRAF(callback, name) {
  if (registry.animationFrames.has(name)) {
    cancelAnimationFrame(registry.animationFrames.get(name))
  }

  const id = requestAnimationFrame(() => {
    registry.animationFrames.delete(name)
    callback()
  })
  registry.animationFrames.set(name, id)
  return id
}

/**
 * Clear a specific tracked item by name
 * @param {string} name
 */
function clear(name) {
  if (registry.intervals.has(name)) {
    clearInterval(registry.intervals.get(name))
    registry.intervals.delete(name)
    stats.intervalsCleaned++
  }
  if (registry.timeouts.has(name)) {
    clearTimeout(registry.timeouts.get(name))
    registry.timeouts.delete(name)
  }
  if (registry.observers.has(name)) {
    try {
      registry.observers.get(name).disconnect()
    } catch (e) {}
    registry.observers.delete(name)
    stats.observersCleaned++
  }
  if (registry.listeners.has(name)) {
    const l = registry.listeners.get(name)
    try {
      l.element.removeEventListener(l.event, l.handler, l.options)
    } catch (e) {}
    registry.listeners.delete(name)
    stats.listenersCleaned++
  }
  if (registry.animationFrames.has(name)) {
    cancelAnimationFrame(registry.animationFrames.get(name))
    registry.animationFrames.delete(name)
  }
}

/**
 * Clear all tracked items (called on page unload)
 */
function clearAll() {
  // Clear intervals
  for (const [name, id] of registry.intervals) {
    clearInterval(id)
    stats.intervalsCleaned++
  }
  registry.intervals.clear()

  // Clear timeouts
  for (const [name, id] of registry.timeouts) {
    clearTimeout(id)
  }
  registry.timeouts.clear()

  // Disconnect observers
  for (const [name, obs] of registry.observers) {
    try { obs.disconnect() } catch (e) {}
    stats.observersCleaned++
  }
  registry.observers.clear()

  // Remove listeners
  for (const [name, l] of registry.listeners) {
    try {
      l.element.removeEventListener(l.event, l.handler, l.options)
    } catch (e) {}
    stats.listenersCleaned++
  }
  registry.listeners.clear()

  // Cancel animation frames
  for (const [name, id] of registry.animationFrames) {
    cancelAnimationFrame(id)
  }
  registry.animationFrames.clear()
}

/**
 * Get debug stats
 */
function getStats() {
  return {
    ...stats,
    active: {
      intervals: registry.intervals.size,
      timeouts: registry.timeouts.size,
      observers: registry.observers.size,
      listeners: registry.listeners.size,
      animationFrames: registry.animationFrames.size
    }
  }
}

/**
 * List all active tracked items (for debugging)
 */
function listActive() {
  return {
    intervals: [...registry.intervals.keys()],
    timeouts: [...registry.timeouts.keys()],
    observers: [...registry.observers.keys()],
    listeners: [...registry.listeners.keys()],
    animationFrames: [...registry.animationFrames.keys()]
  }
}

// Auto-cleanup on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', clearAll)

  // Also cleanup on SPA navigation (Twitch/Kick are SPAs)
  let lastUrl = location.href
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href
      // Don't clear everything on SPA nav, just notify
      // Individual modules should handle their own cleanup
      window.dispatchEvent(new CustomEvent('heatsync:navigation'))
    }
  })
  urlObserver.observe(document.body, { childList: true, subtree: true })
}

// Export as both module and global
const cleanup = {
  setInterval: trackedSetInterval,
  setTimeout: trackedSetTimeout,
  observe: trackedObserve,
  createObserver: createTrackedObserver,
  trackObserver: trackObserver,
  addEventListener: trackedAddEventListener,
  raf: trackedRAF,
  clear,
  clearAll,
  getStats,
  listActive
}

// Global export for non-module scripts
if (typeof window !== 'undefined') {
  window.heatsyncCleanup = cleanup

  // Console debug helper
  window.hsDebug = () => {
    const s = cleanup.getStats()
    const a = cleanup.listActive()
    console.log('%c[heatsync] Cleanup Stats', 'color: #9147ff; font-weight: bold')
    console.log(`  Created: ${s.intervalsCreated} intervals, ${s.observersCreated} observers, ${s.listenersCreated} listeners`)
    console.log(`  Cleaned: ${s.intervalsCleaned} intervals, ${s.observersCleaned} observers, ${s.listenersCleaned} listeners`)
    console.log(`  Active: ${s.active.intervals} intervals, ${s.active.observers} observers, ${s.active.listeners} listeners`)
    console.table(a)
    return s
  }
}

export { cleanup }
export default cleanup

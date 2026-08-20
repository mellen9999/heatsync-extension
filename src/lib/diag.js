// @ts-check
// Runtime diagnostics — turn silent decay into a signal.
//
// Two blind spots this closes:
//
// 1. SELECTOR ROT. We query someone else's DOM ~500 times. When Twitch renames
//    `.chat-shell`, the query returns null, the caller takes a falsy branch or
//    hits a `catch {}`, and the feature just stops. Nothing logs, nothing counts.
//    The user says "it broke"; we start from zero. hsQuery/hsQueryAll name each
//    query site and report a selector that USED TO MATCH ON THIS PAGE and then
//    stopped.
//
// 2. SWALLOWED ERRORS. ~350 `catch (_) {}` blocks. Most are legitimately
//    defensive (DOM ops on removed nodes, chrome.* on an orphaned context), but
//    the code cannot tell those apart from "a feature just died" — both are
//    spelled the same. src/lib/cleanup.js:226 records the cost: youtube native
//    chat and the button's SPA-nav timers were dead for ~10 weeks behind
//    debug-gated catches. swallow() gives a catch a name and a count.
//
// Both feed the ring buffer that already exists (src/lib/error-reporter.js),
// which the popup already exposes via "copy errors". No new transport, no
// network, no background beacon — the user hands us the report, as today.

// Consecutive misses before a previously-matching selector is considered rotted.
const MISS_STREAK = 10
// ...and it must have been missing this long. Both gates must pass: a burst of
// 10 queries inside one animation frame during a re-render is not rot.
const MISS_MS = 30000

/** @type {Map<string, {hits:number, misses:number, streak:number, lastHitAt:number, path:string, reported:boolean}>} */
const _watch = new Map()
/** @type {Map<string, number>} */
const _swallowed = new Map()

/** Page identity for a watcher. A selector that vanishes because the user
 * navigated has not rotted — it is simply not on this page. Comparing the path
 * at hit-time against the path at miss-time is what keeps SPA navigation from
 * generating false reports. */
function _path() {
  try {
    return location.pathname || ''
  } catch (_) {
    return ''
  }
}

function _report(msg, tag) {
  try {
    const r = typeof window !== 'undefined' && window.__hsErrorReporter
    if (!r || typeof r.capture !== 'function') return
    r.capture({
      ts: Date.now(),
      type: 'diag',
      plat: r.plat,
      ver: r.ver,
      url: (() => {
        try {
          return location.href.slice(0, 200)
        } catch (_) {
          return ''
        }
      })(),
      msg,
      stack: tag || '',
    })
  } catch (_) {}
}

function _state(name) {
  let s = _watch.get(name)
  if (!s) {
    s = { hits: 0, misses: 0, streak: 0, lastHitAt: 0, path: '', reported: false }
    _watch.set(name, s)
  }
  return s
}

function _hit(name) {
  const s = _state(name)
  s.hits++
  s.streak = 0
  s.lastHitAt = Date.now()
  s.path = _path()
}

function _miss(name, selectors) {
  const s = _state(name)
  s.misses++
  // Never matched here yet — nothing to conclude. A twitch selector on a kick
  // page misses forever and that is correct, not a defect.
  if (!s.lastHitAt) return
  // Navigated since the last hit: reset rather than accumulate. The selector
  // isn't gone, the page is.
  if (s.path !== _path()) {
    s.streak = 0
    s.lastHitAt = 0
    return
  }
  s.streak++
  if (s.reported) return
  if (s.streak < MISS_STREAK) return
  if (Date.now() - s.lastHitAt < MISS_MS) return
  s.reported = true
  const sel = Array.isArray(selectors) ? selectors.join(' | ') : String(selectors)
  _report(
    `[heatsync] selector stopped matching: ${name} (${s.streak} misses over ${Math.round((Date.now() - s.lastHitAt) / 1000)}s) — ${sel.slice(0, 300)}`,
    `selector-rot:${name}`,
  )
}

/**
 * querySelector with a name, so a selector that rots reports itself.
 * Accepts a single selector or an ordered fallback array (same contract as
 * qsArray in src/lib/utils.js — first match wins).
 * @param {string} name stable identifier for this query site, e.g. 'TWITCH_CHAT_SHELL'
 * @param {string|string[]} selectors
 * @param {ParentNode} [root]
 * @returns {Element|null}
 */
function hsQuery(name, selectors, root) {
  const scope = root || (typeof document !== 'undefined' ? document : null)
  if (!scope) return null
  let el = null
  try {
    if (typeof selectors === 'string') {
      el = scope.querySelector(selectors)
    } else if (Array.isArray(selectors)) {
      for (const sel of selectors) {
        el = scope.querySelector(sel)
        if (el) break
      }
    }
  } catch (_) {
    return null
  }
  try {
    if (el) _hit(name)
    else _miss(name, selectors)
  } catch (_) {}
  return el
}

/**
 * querySelectorAll counterpart. Returns the results of the FIRST selector that
 * matches anything — fallbacks describe whole markup revisions, they are not
 * merged (same contract as qsaArray in src/lib/utils.js).
 * @param {string} name
 * @param {string|string[]} selectors
 * @param {ParentNode} [root]
 * @returns {NodeListOf<Element>|Element[]}
 */
function hsQueryAll(name, selectors, root) {
  const scope = root || (typeof document !== 'undefined' ? document : null)
  if (!scope) return []
  let out = null
  try {
    if (typeof selectors === 'string') {
      const r = scope.querySelectorAll(selectors)
      out = r.length ? r : null
    } else if (Array.isArray(selectors)) {
      for (const sel of selectors) {
        const r = scope.querySelectorAll(sel)
        if (r.length) {
          out = r
          break
        }
      }
    }
  } catch (_) {
    return []
  }
  try {
    if (out) _hit(name)
    else _miss(name, selectors)
  } catch (_) {}
  return out || []
}

/**
 * Give a swallowed error a name. Counts always (in memory, free); writes to the
 * error buffer only when verbose diagnostics are armed, so the 50-entry ring
 * stays focused on real failures during normal use.
 *
 * Replaces `catch (_) {}` at sites where a throw means a feature stopped —
 * init, transport, selector resolution — not at sites where a throw is expected
 * (DOM ops on a node that may have been removed).
 *
 * @param {unknown} err
 * @param {string} tag stable identifier, e.g. 'yt-native-chat-init'
 */
function swallow(err, tag) {
  try {
    _swallowed.set(tag, (_swallowed.get(tag) || 0) + 1)
    if (typeof window === 'undefined' || window.__hsDiagVerbose !== true) return
    let msg = ''
    try {
      msg = String((err && /** @type {any} */ (err).message) || err || '')
    } catch (_) {
      msg = '(unreadable)'
    }
    _report(`[heatsync] swallowed at ${tag}: ${msg.slice(0, 300)}`, `swallow:${tag}`)
  } catch (_) {}
}

/** Snapshot for the debug probe / console. Read-only. */
function diagSnapshot() {
  /** @type {Record<string, unknown>} */
  const selectors = {}
  for (const [name, s] of _watch) {
    // Only the interesting ones: something that has ever missed after matching.
    if (!s.misses) continue
    selectors[name] = {
      hits: s.hits,
      misses: s.misses,
      streak: s.streak,
      reported: s.reported,
      lastHitAt: s.lastHitAt,
    }
  }
  /** @type {Record<string, number>} */
  const swallowed = {}
  for (const [tag, n] of _swallowed) swallowed[tag] = n
  return { selectors, swallowed }
}

// Console handle: __hsDiag.snapshot() to read counters, __hsDiag.verbose(true)
// to start writing swallowed-error tags into the error buffer.
try {
  if (typeof window !== 'undefined') {
    window.__hsDiag = {
      snapshot: diagSnapshot,
      verbose: (/** @type {boolean} */ on) => {
        window.__hsDiagVerbose = on !== false
        return window.__hsDiagVerbose
      },
    }
  }
} catch (_) {}

export { diagSnapshot, hsQuery, hsQueryAll, MISS_MS, MISS_STREAK, swallow }

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

// ── host-page CSP ───────────────────────────────────────────────────────────
//
// We inject images, styles and elements into twitch, kick and youtube — three
// documents whose Content-Security-Policy we do not control and cannot see
// coming. If any of them tightens img-src, whatever we injected that trips it
// simply stops rendering. No error, no exception, no console line we own.
//
// Reading the policy is not enough to predict this: a header can look
// permissive and still kill inline handlers, because a nonce or 'strict-dynamic'
// makes the browser ignore an 'unsafe-inline' that is right there in the policy.
// The securitypolicyviolation event is the only thing that reports what the
// browser ACTUALLY refused.
//
// This project has already lost a day to a CSP that silently froze the data
// layer — see the manifest rule in heatsync_csp_default_src_blocks_everything.
// That was our own policy. This is the half we don't own.

// Host pages generate their own violations constantly (youtube especially), so
// only violations traceable to something WE put on the page are reported.
const CSP_OURS_RE = /(heatsync\.org|7tv\.app|betterttv\.net|frankerfacez\.com|jtvnw\.net|files\.kick\.com)/i
// Hard ceiling on top of per-key dedupe: one broken CDN across a busy page can
// trip the same directive from many elements, and the ring buffer only holds 50.
const CSP_MAX_REPORTS = 8
const _cspSeen = new Set()

/**
 * Is this violation caused by something we injected, rather than the host
 * page's own business? Pure, so the classification is testable.
 * @param {{blockedURI?: string, sourceFile?: string}} ev
 * @returns {boolean}
 */
function isOurCspViolation(ev) {
  if (!ev) return false
  const src = typeof ev.sourceFile === 'string' ? ev.sourceFile : ''
  if (src.includes('chrome-extension://') || src.includes('moz-extension://')) return true
  const blocked = typeof ev.blockedURI === 'string' ? ev.blockedURI : ''
  // 'inline' / 'eval' / 'data' carry no host — without an extension sourceFile
  // there is nothing tying them to us, and claiming them would drown the buffer
  // in the host page's own violations.
  if (!blocked?.includes('://')) return false
  return CSP_OURS_RE.test(blocked)
}

/** Stable dedupe key: one report per directive per blocked origin. */
function _cspKey(ev) {
  const directive = ev?.effectiveDirective || ev?.violatedDirective || '?'
  let origin = ''
  try {
    origin = new URL(ev.blockedURI).origin
  } catch (_) {
    origin = String(ev?.blockedURI || '?')
  }
  return `${directive}|${origin}`
}

function _onCspViolation(ev) {
  try {
    if (!isOurCspViolation(ev)) return
    if (_cspSeen.size >= CSP_MAX_REPORTS) return
    const key = _cspKey(ev)
    if (_cspSeen.has(key)) return
    _cspSeen.add(key)
    _report(
      `[heatsync] host page CSP blocked one of ours: ${key} (${String(ev.blockedURI).slice(0, 200)})`,
      `csp:${key}`,
    )
  } catch (_) {}
}

// Installed only where a report can actually be written — the MAIN-world copy of
// this bundle sees the same violations but has no chrome.storage, so letting it
// listen would double-count into a sink it cannot reach.
try {
  if (
    typeof document !== 'undefined' &&
    typeof window !== 'undefined' &&
    !window.__hsCspWatch &&
    typeof chrome !== 'undefined' &&
    typeof chrome?.storage?.local?.set === 'function'
  ) {
    window.__hsCspWatch = true
    document.addEventListener('securitypolicyviolation', _onCspViolation)
  }
} catch (_) {}

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
  return { selectors, swallowed, csp: [..._cspSeen] }
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

export { CSP_MAX_REPORTS, diagSnapshot, hsQuery, hsQueryAll, isOurCspViolation, MISS_MS, MISS_STREAK, swallow }

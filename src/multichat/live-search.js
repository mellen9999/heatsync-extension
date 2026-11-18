// Live chat search — builds a per-query matcher compiled ONCE, not per message.
// Three modes: /regex/[i] | @username prefix | bare substring. ReDoS-guarded.

// Private copies of the ReDoS heuristics (mirrors automod.js — kept local so
// this file is importable by tests without dragging in the whole bundle).
function _lsIsDangerous(p) {
  if (p.length > 512) return true
  // quantified group whose body also has a quantifier → exponential blowup
  if (/\([^)]*[+*][^)]*\)\s*[*+{]/.test(p)) return true
  // unbounded repeat of an alternation → (a|a)+/{n} style blowup
  if (/\([^)]*\|[^)]*\)\s*[*+{]/.test(p)) return true
  // bounded repetition ≥ 10 reps (2-digit brace) is exponential with nested quantifiers
  if (/\{\s*\d{2,}/.test(p)) return true
  return false
}

// Empirical backstop: run the compiled regex against pathological probes under a
// tight time budget. Catches catastrophic-backtracking shapes the static heuristic
// didn't anticipate (e.g. /a{100}b/). Kept local for test isolation (mirrors automod).
const _LS_REDOS_PROBES = ['a'.repeat(28), '0'.repeat(28), 'ab'.repeat(14), 'a1'.repeat(14), ' '.repeat(28)].map(
  (s) => `${s} !`,
)
function _lsTripsCatastrophicBacktracking(re) {
  try {
    const start = performance.now()
    for (const probe of _LS_REDOS_PROBES) {
      re.test(probe)
      if (performance.now() - start > 20) return true
    }
  } catch {
    return true
  }
  return false
}

function _lsEscapeLiteral(p) {
  return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Build a matcher for rawQuery (trimmed, case preserved).
// Returns { test(m) } where m has .user / .display_name / .text fields.
function buildLiveSearchMatcher(rawQuery) {
  if (!rawQuery) return { test: () => true }

  // ── Regex mode: /pattern/ or /pattern/i ─────────────────────────────────────
  // The trailing delimiter must follow the closing slash with no intervening
  // non-flag characters, so `/foo/i` is regex but `/foo/bar` is literal text.
  const reSlash = /^\/(.+)\/(i?)$/.exec(rawQuery)
  if (reSlash) {
    const src = reSlash[1]
    const flags = reSlash[2]
    // ReDoS guard — dangerous pattern degrades to literal substring so it can
    // never trigger catastrophic backtracking regardless of message content.
    const safeSrc = _lsIsDangerous(src) ? _lsEscapeLiteral(src) : src
    let re
    try {
      re = new RegExp(safeSrc, flags)
      // Empirical backstop: catches blowup shapes the static heuristic missed.
      // Runs once at compile time (not per message), so probing cost is bounded.
      if (_lsTripsCatastrophicBacktracking(re)) {
        re = new RegExp(_lsEscapeLiteral(src), flags)
      }
    } catch {
      // Invalid regex (e.g. `/[/` mid-typing) — fall back to literal.
      try {
        re = new RegExp(_lsEscapeLiteral(src), flags)
      } catch {
        // Pathological: literal form still invalid (shouldn't happen). Fall
        // through to bare-substring on the full rawQuery.
        re = null
      }
    }
    if (re) {
      return {
        test(m) {
          return re.test(String(m.user || m.display_name || '')) || re.test(String(m.text || ''))
        },
      }
    }
  }

  // ── @name prefix — scopes to one sender ─────────────────────────────────────
  const q = rawQuery.toLowerCase()
  if (q[0] === '@') {
    const prefix = q.slice(1)
    return {
      test(m) {
        return String(m.user || m.display_name || '')
          .toLowerCase()
          .startsWith(prefix)
      },
    }
  }

  // ── Bare substring — matches username OR message body ────────────────────────
  return {
    test(m) {
      const user = String(m.user || m.display_name || '').toLowerCase()
      return (
        user.includes(q) ||
        String(m.text || '')
          .toLowerCase()
          .includes(q)
      )
    },
  }
}

// The matcher for the query on screen, compiled once: the append path asks per arriving line.
let _lsMemoQuery = null
let _lsMemo = null
function liveSearchMatcherFor(rawQuery) {
  if (rawQuery !== _lsMemoQuery) {
    _lsMemo = buildLiveSearchMatcher(rawQuery)
    _lsMemoQuery = rawQuery
  }
  return _lsMemo
}

export { buildLiveSearchMatcher, liveSearchMatcherFor }

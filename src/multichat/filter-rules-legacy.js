// The four old text filters, folded into chatFilterRules once — by the overlay
// (retireSettings, main-settings.js) and by native chat on a site where the
// overlay is off (content.js), through foldLegacyFilters below. Each becomes ordinary rules the unchanged engine
// (filter-rules.js) already runs — nothing here evaluates a message.
//   automodRegex      one hide rule per line, the line as a case-insensitive pattern
//   automodAllCaps    one hide rule: no lower case, 8+ capitals, 11+ chars
//   hs_mute_keywords  one hide rule per line, matched literally anywhere
//   keywordHighlights one highlight rule per line or comma (the site documented commas), whole word, in the mention colour
// Self-contained — no imports, so tests load it without the bundle scope.

// Unambiguous on purpose: each run between capitals excludes capitals, so a
// near-miss fails in one pass instead of backtracking through every split.
// The all-caps automod also counted a mostly-caps message; a pattern can only
// say "no lower case at all", which is the stricter half of the same idea.
const LEGACY_CAPS_PATTERN = `^(?=.{9}..)[^a-zA-Z]*[A-Z]${'[^a-zA-Z]*[A-Z]'.repeat(7)}[^a-z]*$`
const LEGACY_HIGHLIGHT_COLOR = '#ffff00'
// The engine turns a longer pattern into a literal, which would escape these twice.
const LEGACY_MAX_TERM = 512

function _legacyEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Newlines only by default: a pattern may hold a comma.
function _legacyLines(text, sep = /\r?\n/) {
  if (typeof text !== 'string') return []
  return text
    .split(sep)
    .map((s) => s.trim())
    .filter((s) => s && s.length <= LEGACY_MAX_TERM)
}

/**
 * Rules for whatever old filters hold a value.
 * @param {{automodRegex?: string, automodAllCaps?: boolean, muteKeywords?: string, keywordHighlights?: string}} old
 * @returns {object[]} chatFilterRules entries
 */
function legacyFilterRules(old) {
  const stamp = Date.now().toString(36)
  const out = []
  const add = (action, type, value, caseSensitive, color) => {
    const r = {
      id: `lg${stamp}${out.length}`,
      enabled: true,
      action,
      scope: 'all',
      match: { type, value, caseSensitive },
    }
    if (color) r.color = color
    out.push(r)
  }
  for (const p of _legacyLines(old?.automodRegex)) add('hide', 'regex', p, false)
  if (old?.automodAllCaps === true) add('hide', 'regex', LEGACY_CAPS_PATTERN, true)
  for (const w of _legacyLines(old?.muteKeywords)) add('hide', 'regex', _legacyEscape(w), false)
  for (const w of _legacyLines(old?.keywordHighlights, /[,\n]/)) {
    add('highlight', 'regex', `\\b${_legacyEscape(w)}\\b`, false, LEGACY_HIGHLIGHT_COLOR)
  }
  return out
}

/**
 * `existing` plus each added rule that does not already match on the same
 * thing with the same action — a second run (another tab, a retried boot)
 * adds nothing.
 * @param {object[]} existing
 * @param {object[]} added
 * @returns {object[]}
 */
function mergeFilterRules(existing, added) {
  const sig = (r) => `${r?.action}|${r?.match?.type}|${!!r?.match?.caseSensitive}|${r?.match?.value}`
  const have = new Set(existing.map(sig))
  return existing.concat(added.filter((r) => !have.has(sig(r))))
}

// Where the old filters lived: device-local keys, and ui_settings keys (also
// RETIRED_UI_KEYS). The fold lets go of both once their rules are written.
const LEGACY_LOCAL_KEYS = ['hs_mute_keywords', 'keyword_highlights']
const LEGACY_UI_KEYS = ['automodRegex', 'automodAllCaps', 'keywordHighlights']

/**
 * The stored half of the fold, one copy for every caller: what chat_filter_rules
 * becomes once the old filters are in it.
 * @param {object} ui     the ui_settings sync blob
 * @param {object} local  storage.local holding chat_filter_rules + LEGACY_LOCAL_KEYS
 * @returns {string|null|false} the new chat_filter_rules JSON; null = nothing to add;
 *   false = the stored rules are unreadable, so touch nothing (old values stay put)
 */
function foldLegacyFilters(ui, local) {
  const added = legacyFilterRules({
    automodRegex: ui?.automodRegex,
    automodAllCaps: ui?.automodAllCaps,
    muteKeywords: local?.hs_mute_keywords,
    // pre-overflow installs still hold highlight words in the sync blob
    keywordHighlights: typeof local?.keyword_highlights === 'string' ? local.keyword_highlights : ui?.keywordHighlights,
  })
  if (!added.length) return null
  let cur
  try {
    cur = JSON.parse(local?.chat_filter_rules || '[]')
  } catch {}
  if (!Array.isArray(cur)) return false
  const next = mergeFilterRules(cur, added)
  return next.length !== cur.length ? JSON.stringify(next) : null
}

export { foldLegacyFilters, LEGACY_LOCAL_KEYS, LEGACY_UI_KEYS, legacyFilterRules, mergeFilterRules }

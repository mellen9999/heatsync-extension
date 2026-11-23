// sent-history.js — Up/Down in the composer walks back through what you sent.
//
// The list lived in memory, so a reload or a fresh tab started with nothing to
// recall. It now rides chrome.storage.local, newest first, capped at 50.
//
// LOCAL ONLY, ON PURPOSE. This is the one store that holds what a person
// typed. It never uses chrome.storage.sync (so no other device sees it), it
// never goes to the server, and settings-ui keeps it out of the settings
// export. "remember sent messages" off means memory-only again, as before,
// and wipes the stored copy; "clear sent history" does the same on demand.
//
// Restore never blocks boot: the read is fired at load and awaited by nobody.
// A message sent before it lands is kept and merged ahead of the stored ones,
// and a save always waits for that merge so a fast sender cannot overwrite
// the stored list with a shorter one.
//
// A line comes back with the copies you chose: a pick that changed what its
// word sends (lawShip's `chosen`) is kept beside the list, by the line's text,
// and returns with it. A pick is that line's, never the name's (emote law):
// only a recall brings it back. Same store rules: local only, off or "clear"
// wipes it, and its key sits under the history's so the export skips it too.

const SENT_HISTORY_KEY = 'hs_sent_history'
const SENT_PICKS_KEY = 'hs_sent_history_picks'
// The registry key for the "remember sent messages" setting (settings-schema.js).
const SENT_REMEMBER_KEY = 'hs_remember_sent'
const MC_HISTORY_MAX = 50
// No platform takes more than 500 characters, so a longer line was never sent.
const MC_HISTORY_LINE_MAX = 500

const mcMessageHistory = [] // newest first
let mcHistoryIndex = -1
let mcHistoryDraft = ''
let mcSentRemember = true
// line -> the copies chosen in it, as [name, ref] rows (a Map does not survive storage)
const mcSentPicks = new Map()

/** Whatever storage handed back, made safe: strings only, no repeats in a row, capped. */
function hsSentHistoryClean(list) {
  const out = []
  if (!Array.isArray(list)) return out
  for (const s of list) {
    if (typeof s !== 'string' || !s) continue
    const line = s.length > MC_HISTORY_LINE_MAX ? s.slice(0, MC_HISTORY_LINE_MAX) : s
    if (out[out.length - 1] !== line) out.push(line)
    if (out.length >= MC_HISTORY_MAX) break
  }
  return out
}

// a stored pick is only ever drawn and re-sent (the server checks what ships): a name and an https picture
function hsSentPickRows(list) {
  if (!Array.isArray(list)) return []
  return list
    .filter((e) => Array.isArray(e) && e[0] && e[1]?.name === e[0] && /^https:\/\//.test(e[1].url))
    .slice(0, 20)
}

/** a line that fell off the list (or, with `keep`, any line not in it) takes its picks along */
function hsSentPicksPrune(keep = mcMessageHistory) {
  for (const k of [...mcSentPicks.keys()]) if (!keep.includes(k)) mcSentPicks.delete(k)
}

/** Stored rows ([line, picks]) into memory: only for a line still on the list, and never over `keep`. */
function hsSentPicksAdopt(rows, keep) {
  hsSentPicksPrune(keep || [])
  if (!Array.isArray(rows)) return
  for (const row of rows) {
    const line = Array.isArray(row) ? row[0] : null
    if (typeof line !== 'string' || keep?.includes(line) || !mcMessageHistory.includes(line)) continue
    const picks = hsSentPickRows(row[1])
    if (picks.length) mcSentPicks.set(line, picks)
  }
}

function hsSentHistoryLoad() {
  try {
    return browser.storage.local
      .get([SENT_HISTORY_KEY, SENT_PICKS_KEY, SENT_REMEMBER_KEY])
      .then((data) => {
        mcSentRemember = data?.[SENT_REMEMBER_KEY] !== false
        if (!mcSentRemember) {
          // a stale copy must never outlive an "off"
          hsSentHistoryWipe()
          return
        }
        const sentBeforeLoad = mcMessageHistory.splice(0)
        mcMessageHistory.push(
          ...hsSentHistoryClean([...sentBeforeLoad, ...hsSentHistoryClean(data?.[SENT_HISTORY_KEY])]),
        )
        // a line sent before the read landed is the newest send of it: its picks (or none) stand
        hsSentPicksAdopt(data?.[SENT_PICKS_KEY], sentBeforeLoad)
      })
      .catch(() => {})
  } catch (_) {
    return Promise.resolve()
  }
}
const mcSentHistoryReady = hsSentHistoryLoad()

/** the stored copy, both keys, gone from disk */
function hsSentHistoryWipe() {
  try {
    return Promise.all([SENT_HISTORY_KEY, SENT_PICKS_KEY].map((k) => browser.storage.local.remove(k))).catch(() => {})
  } catch (_) {
    return Promise.resolve()
  }
}

function hsSentHistorySave() {
  mcSentHistoryReady.then(() => {
    if (!mcSentRemember) return
    try {
      browser.storage.local
        .set({
          [SENT_HISTORY_KEY]: mcMessageHistory.slice(),
          [SENT_PICKS_KEY]: [...mcSentPicks],
        })
        .catch(() => {})
    } catch (_) {}
  })
}

/**
 * A message went out: it becomes the newest entry (not twice in a row), with the copies chosen in it.
 * @param {string} text
 * @param {Array<[string, object]>} [chosen] lawShip's `chosen`: [name, ref] rows
 */
function hsSentHistoryRecord(text, chosen) {
  const line = text.length > MC_HISTORY_LINE_MAX ? text.slice(0, MC_HISTORY_LINE_MAX) : text
  if (mcMessageHistory[0] !== line) {
    mcMessageHistory.unshift(line)
    if (mcMessageHistory.length > MC_HISTORY_MAX) mcMessageHistory.length = MC_HISTORY_MAX
  }
  // the newest send of a line is the one that comes back: sent again with no pick, it has none
  if (chosen?.length) mcSentPicks.set(line, chosen)
  else mcSentPicks.delete(line)
  hsSentPicksPrune()
  mcHistoryIndex = -1
  hsSentHistorySave()
}

/**
 * The copies a remembered line was sent with, as a draft its box can take
 * (resumeDraftPicks): a fresh one each recall. null when it had none.
 */
function hsSentHistoryPicks(line) {
  const p = mcSentPicks.get(line)
  return p ? { picked: new Map(p), remote: new Map(), away: new Map() } : null
}

/**
 * One Up (dir 1) or Down (dir -1) press. Returns the text the composer should
 * show, or null when the key is not ours (Up starts recall only on an empty
 * composer or one that already holds a sent line; mid-recall both keys walk).
 */
function hsSentHistoryStep(dir, currentText) {
  if (!mcMessageHistory.length) return null
  const up = dir > 0
  if (!(mcHistoryIndex >= 0 || (up && (currentText.length === 0 || mcMessageHistory.includes(currentText))))) {
    return null
  }
  if (up) {
    if (mcHistoryIndex < 0) mcHistoryDraft = currentText
    mcHistoryIndex = Math.min(mcHistoryIndex + 1, mcMessageHistory.length - 1)
  } else {
    mcHistoryIndex--
  }
  return mcHistoryIndex < 0 ? mcHistoryDraft : mcMessageHistory[mcHistoryIndex]
}

/** "clear sent history": gone from memory and from disk, whatever the setting says. */
function hsSentHistoryClear() {
  mcMessageHistory.length = 0
  mcHistoryIndex = -1
  mcHistoryDraft = ''
  mcSentPicks.clear()
  return hsSentHistoryWipe()
}

/**
 * The "remember sent messages" switch moved. Off wipes the stored copy; on
 * starts a fresh list, so the disk only ever holds lines sent while it was on.
 */
function hsSentHistoryRemember(on) {
  const next = on !== false
  if (next === mcSentRemember) return
  mcSentRemember = next
  if (next) {
    mcMessageHistory.length = 0
    mcHistoryIndex = -1
    mcSentPicks.clear()
  } else hsSentHistoryWipe()
}

/**
 * Another tab saved (or cleared) the list: follow it, unless this one is mid-recall. `next` and
 * `picks` are the change records of the two keys, and the browser names only a key whose value
 * changed: picks not named are still the ones held here, less the lines gone from the list.
 */
function hsSentHistoryAdopt(next, picks) {
  if (!mcSentRemember || mcHistoryIndex >= 0) return
  if (next) mcMessageHistory.splice(0, mcMessageHistory.length, ...hsSentHistoryClean(next.newValue))
  if (picks) hsSentPicksAdopt(picks.newValue)
  else hsSentPicksPrune()
}

// onChanged covers every writer — this tab's settings toggle, another tab's
// send, a clear — so there is one path and no registry applier to keep in step.
try {
  cleanup.addListener(chrome.storage.onChanged, (changes, area) => {
    if (area !== 'local') return
    if (changes[SENT_REMEMBER_KEY]) hsSentHistoryRemember(changes[SENT_REMEMBER_KEY].newValue)
    // one save writes the list and its picks together: one event, with whichever of the two changed
    if (changes[SENT_HISTORY_KEY] || changes[SENT_PICKS_KEY]) {
      hsSentHistoryAdopt(changes[SENT_HISTORY_KEY], changes[SENT_PICKS_KEY])
    }
  })
} catch (_) {}

// Exported for the tests, stripped by the bundler — every module here lands in
// one shared scope, so nothing imports this at runtime.
export {
  hsSentHistoryClear,
  hsSentHistoryPicks,
  hsSentHistoryRecord,
  hsSentHistoryStep,
  mcMessageHistory,
  mcSentHistoryReady,
  SENT_HISTORY_KEY,
  SENT_PICKS_KEY,
  SENT_REMEMBER_KEY,
}

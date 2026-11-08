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

const SENT_HISTORY_KEY = 'hs_sent_history'
// The registry key for the "remember sent messages" setting (settings-schema.js).
const SENT_REMEMBER_KEY = 'hs_remember_sent'
const MC_HISTORY_MAX = 50
// No platform takes more than 500 characters, so a longer line was never sent.
const MC_HISTORY_LINE_MAX = 500

const mcMessageHistory = [] // newest first
let mcHistoryIndex = -1
let mcHistoryDraft = ''
let mcSentRemember = true

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

function hsSentHistoryLoad() {
  try {
    return browser.storage.local
      .get([SENT_HISTORY_KEY, SENT_REMEMBER_KEY])
      .then((data) => {
        mcSentRemember = data?.[SENT_REMEMBER_KEY] !== false
        if (!mcSentRemember) {
          // a stale copy must never outlive an "off"
          browser.storage.local.remove(SENT_HISTORY_KEY).catch(() => {})
          return
        }
        const sentBeforeLoad = mcMessageHistory.splice(0)
        mcMessageHistory.push(
          ...hsSentHistoryClean([...sentBeforeLoad, ...hsSentHistoryClean(data?.[SENT_HISTORY_KEY])]),
        )
      })
      .catch(() => {})
  } catch (_) {
    return Promise.resolve()
  }
}
const mcSentHistoryReady = hsSentHistoryLoad()

function hsSentHistorySave() {
  mcSentHistoryReady.then(() => {
    if (!mcSentRemember) return
    try {
      browser.storage.local.set({ [SENT_HISTORY_KEY]: mcMessageHistory.slice() }).catch(() => {})
    } catch (_) {}
  })
}

/** A message went out: it becomes the newest entry (not twice in a row). */
function hsSentHistoryRecord(text) {
  const line = text.length > MC_HISTORY_LINE_MAX ? text.slice(0, MC_HISTORY_LINE_MAX) : text
  if (mcMessageHistory[0] !== line) {
    mcMessageHistory.unshift(line)
    if (mcMessageHistory.length > MC_HISTORY_MAX) mcMessageHistory.length = MC_HISTORY_MAX
  }
  mcHistoryIndex = -1
  hsSentHistorySave()
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
  try {
    return browser.storage.local.remove(SENT_HISTORY_KEY).catch(() => {})
  } catch (_) {
    return Promise.resolve()
  }
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
  } else {
    try {
      browser.storage.local.remove(SENT_HISTORY_KEY).catch(() => {})
    } catch (_) {}
  }
}

/** Another tab saved (or cleared) the list: follow it, unless this one is mid-recall. */
function hsSentHistoryAdopt(next) {
  if (!mcSentRemember || mcHistoryIndex >= 0) return
  mcMessageHistory.splice(0, mcMessageHistory.length, ...hsSentHistoryClean(next))
}

// onChanged covers every writer — this tab's settings toggle, another tab's
// send, a clear — so there is one path and no registry applier to keep in step.
try {
  cleanup.addListener(chrome.storage.onChanged, (changes, area) => {
    if (area !== 'local') return
    if (changes[SENT_REMEMBER_KEY]) hsSentHistoryRemember(changes[SENT_REMEMBER_KEY].newValue)
    if (changes[SENT_HISTORY_KEY]) hsSentHistoryAdopt(changes[SENT_HISTORY_KEY].newValue)
  })
} catch (_) {}

// Exported for the tests, stripped by the bundler — every module here lands in
// one shared scope, so nothing imports this at runtime.
export {
  hsSentHistoryClear,
  hsSentHistoryRecord,
  hsSentHistoryStep,
  mcMessageHistory,
  mcSentHistoryReady,
  SENT_HISTORY_KEY,
  SENT_REMEMBER_KEY,
}
